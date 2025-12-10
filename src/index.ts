/* eslint-disable import/extensions */
/* eslint-disable @typescript-eslint/no-unused-vars */
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointTuple,
  type SerializerProtocol,
  type PendingWrite,
  type CheckpointMetadata,
  type ChannelVersions,
  TASKS,
  copyCheckpoint,
  WRITES_IDX_MAP,
} from "@langchain/langgraph-checkpoint";

import { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

import { normalizeSQL, toUint8Array } from './utils'
import { printTypeOfArray } from "./debug";

type Statement = D1PreparedStatement;

interface CheckpointRow {
  checkpoint: string;
  metadata: string;
  parent_checkpoint_id?: string;
  thread_id: string;
  checkpoint_id: string;
  checkpoint_ns?: string;
  type?: string;
  pending_writes: string;
}

interface PendingWriteColumn {
  task_id: string;
  channel: string;
  type: string;
  value: string;
}

interface PendingSendColumn {
  type: string;
  value: string;
}

// Retention configuration (in days) for cleanup; adjust as needed or make configurable externally
const CHECKPOINT_RETENTION_DAYS = 30; // default retention window

interface D1RunResultMeta { changes?: number }
interface D1RunResult { meta?: D1RunResultMeta }


// In the `CloudflareD1Saver.list` method, we need to sanitize the `options.filter` argument to ensure it only contains keys
// that are part of the `CheckpointMetadata` type. The lines below ensure that we get compile-time errors if the list
// of keys that we use is out of sync with the `CheckpointMetadata` type.
const checkpointMetadataKeys = ["source", "step", "parents"] as const;

type CheckKeys<T, K extends readonly (keyof T)[]> = [K[number]] extends [
  keyof T
]
  ? [keyof T] extends [K[number]]
  ? K
  : never
  : never;

function validateKeys<T, K extends readonly (keyof T)[]>(
  keys: CheckKeys<T, K>
): K {
  return keys;
}

// If this line fails to compile, the list of keys that we use in the `CloudflareD1Saver.list` method is out of sync with the
// `CheckpointMetadata` type. In that case, just update `checkpointMetadataKeys` to contain all the keys in
// `CheckpointMetadata`
const validCheckpointMetadataKeys = validateKeys<
  CheckpointMetadata,
  typeof checkpointMetadataKeys
>(checkpointMetadataKeys);

function prepareSql(db: D1Database, checkpointId: boolean) {
  const sql = normalizeSQL(`
  SELECT
    thread_id,
    checkpoint_ns,
    checkpoint_id,
    parent_checkpoint_id,
    type,
    checkpoint,
    metadata,
    (
      SELECT
        json_group_array(
          json_object(
            'task_id', pw.task_id,
            'channel', pw.channel,
            'type', pw.type,
            'value', CAST(pw.value AS TEXT)
          )
        )
      FROM writes as pw
      WHERE pw.thread_id = checkpoints.thread_id
        AND pw.checkpoint_ns = checkpoints.checkpoint_ns
        AND pw.checkpoint_id = checkpoints.checkpoint_id
    ) as pending_writes,
    (
      SELECT
        json_group_array(
          json_object(
            'type', ps.type,
            'value', CAST(ps.value AS TEXT)
          )
        )
      FROM writes as ps
      WHERE ps.thread_id = checkpoints.thread_id
        AND ps.checkpoint_ns = checkpoints.checkpoint_ns
        AND ps.checkpoint_id = checkpoints.parent_checkpoint_id
        AND ps.channel = '${TASKS}'
      ORDER BY ps.idx
    ) as pending_sends
  FROM checkpoints
  WHERE thread_id = ? AND checkpoint_ns = ? ${checkpointId
      ? "AND checkpoint_id = ?"
      : "ORDER BY checkpoint_id DESC LIMIT 1"
    }`);

  return db.prepare(sql);
}

type CheckpointLoaded = {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id?: string;
  type: string;
  checkpoint: Uint8Array;
  metadata: Uint8Array;
  pending_writes: string; // Array<PendingWriteColumn>;
  pending_sends: string; // Array<PendingSendColumn>;
};

export class CloudflareD1Saver extends BaseCheckpointSaver {
  db: D1Database;

  protected isSetup: boolean;

  protected withoutCheckpoint: Statement;

  protected withCheckpoint: Statement;

  constructor(db: D1Database, serde?: SerializerProtocol) {
    super(serde);
    this.db = db;
    this.isSetup = false;
  }

  protected async setup(): Promise<void> {
    if (this.isSetup) {
      return;
    }

    // this.db.pragma("journal_mode=WAL");
    await this.db.exec(normalizeSQL(`
CREATE TABLE IF NOT EXISTS checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  type TEXT,
  checkpoint BLOB,
  metadata BLOB,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);`));
    await this.db.exec(normalizeSQL(`
CREATE TABLE IF NOT EXISTS writes (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  channel TEXT NOT NULL,
  type TEXT,
  value BLOB,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);`));

    // Attempt lightweight migrations for existing tables missing created_at
    // (Cloudflare D1 / SQLite: adding the column if it does not exist)
    try { await this.db.exec("ALTER TABLE checkpoints ADD COLUMN created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))"); } catch { /* ignore if exists */ }
    try { await this.db.exec("ALTER TABLE writes ADD COLUMN created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))"); } catch { /* ignore if exists */ }

    this.withoutCheckpoint = prepareSql(this.db, false);
    this.withCheckpoint = prepareSql(this.db, true);

    this.isSetup = true;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    await this.setup();
    const {
      thread_id,
      checkpoint_ns = "",
      checkpoint_id,
    } = config.configurable ?? {};

    const args = [thread_id, checkpoint_ns];
    if (!thread_id) {
      return undefined;
    }
    if (checkpoint_id) args.push(checkpoint_id);

    const stm = checkpoint_id ? this.withCheckpoint : this.withoutCheckpoint;
    const row = (await stm.bind(...args).first<CheckpointLoaded>()) as
      | CheckpointLoaded
      | null;
    if (row === null) return undefined;


    let finalConfig = config;

    if (!checkpoint_id) {
      finalConfig = {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns,
          checkpoint_id: row.checkpoint_id,
        },
      };
    }

    if (
      finalConfig.configurable?.thread_id === undefined ||
      finalConfig.configurable?.checkpoint_id === undefined
    ) {
      throw new Error("Missing thread_id or checkpoint_id");
    }

    const pendingWrites = await Promise.all(
      (JSON.parse(row.pending_writes) as PendingWriteColumn[]).map(
        async (write) => {
          return [
            write.task_id,
            write.channel,
            await this.serde.loadsTyped(
              write.type ?? "json",
              write.value ?? ""
            ),
          ] as [string, string, unknown];
        }
      )
    );

    // printTypeOfArray(row.checkpoint); // debug

    const rawCheckpoint = toUint8Array(row.checkpoint);
    const rawMetadata = toUint8Array(row.metadata);
    const checkpoint = await this.serde.loadsTyped(row.type ?? "json", rawCheckpoint) as Checkpoint;
    const metadata = await this.serde.loadsTyped(row.type ?? "json", rawMetadata) as CheckpointMetadata;

    return {
      checkpoint,
      config: finalConfig,
      metadata,
      parentConfig: row.parent_checkpoint_id
        ? {
          configurable: {
            thread_id: row.thread_id,
            checkpoint_ns,
            checkpoint_id: row.parent_checkpoint_id,
          },
        }
        : undefined,
      pendingWrites,
    };
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    const { limit, before, filter } = options ?? {};
    await this.setup();
    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns;
    let sql = `
      SELECT
        thread_id,
        checkpoint_ns,
        checkpoint_id,
        parent_checkpoint_id,
        type,
        checkpoint,
        metadata,
        (
          SELECT
            json_group_array(
              json_object(
                'task_id', pw.task_id,
                'channel', pw.channel,
                'type', pw.type,
                'value', CAST(pw.value AS TEXT)
              )
            )
          FROM writes as pw
          WHERE pw.thread_id = checkpoints.thread_id
            AND pw.checkpoint_ns = checkpoints.checkpoint_ns
            AND pw.checkpoint_id = checkpoints.checkpoint_id
        ) as pending_writes,
        (
          SELECT
            json_group_array(
              json_object(
                'type', ps.type,
                'value', CAST(ps.value AS TEXT)
              )
            )
          FROM writes as ps
          WHERE ps.thread_id = checkpoints.thread_id
            AND ps.checkpoint_ns = checkpoints.checkpoint_ns
            AND ps.checkpoint_id = checkpoints.parent_checkpoint_id
            AND ps.channel = '${TASKS}'
          ORDER BY ps.idx
        ) as pending_sends
      FROM checkpoints\n`;

    const whereClause: string[] = [];

    if (thread_id) {
      whereClause.push("thread_id = ?");
    }

    if (checkpoint_ns !== undefined && checkpoint_ns !== null) {
      whereClause.push("checkpoint_ns = ?");
    }

    if (before?.configurable?.checkpoint_id !== undefined) {
      whereClause.push("checkpoint_id < ?");
    }

    const sanitizedFilter = Object.fromEntries(
      Object.entries(filter ?? {}).filter(
        ([key, value]) =>
          value !== undefined &&
          validCheckpointMetadataKeys.includes(key as keyof CheckpointMetadata)
      )
    );

    whereClause.push(
      ...Object.entries(sanitizedFilter).map(
        ([key]) => `json(CAST(metadata AS TEXT))->'$.${key}' = ?`
      )
    );

    if (whereClause.length > 0) {
      sql += `WHERE\n  ${whereClause.join(" AND\n  ")}\n`;
    }

    sql += "\nORDER BY checkpoint_id DESC";

    if (limit) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sql += ` LIMIT ${parseInt(limit as any, 10)}`; // parseInt here (with cast to make TS happy) to sanitize input, as limit may be user-provided
    }

    const args = [
      thread_id,
      checkpoint_ns,
      before?.configurable?.checkpoint_id,
      ...Object.values(sanitizedFilter).map((value) => JSON.stringify(value)),
    ].filter((value) => value !== undefined && value !== null);

    const result = await this.db
      .prepare(sql)
      .bind(...args)
      .all<CheckpointRow>();
    const rows: CheckpointRow[] = (result.results ?? []) as CheckpointRow[];

    if (rows) {
      for (const row of rows) {
        const pendingWrites = await Promise.all(
          (JSON.parse(row.pending_writes) as PendingWriteColumn[]).map(
            async (write) => {
              return [
                write.task_id,
                write.channel,
                await this.serde.loadsTyped(
                  write.type ?? "json",
                  write.value ?? ""
                ),
              ] as [string, string, unknown];
            }
          )
        );

        const rawCheckpoint = toUint8Array(row.checkpoint);
        const rawMetadata = toUint8Array(row.metadata);
        const checkpoint = await this.serde.loadsTyped(row.type ?? "json", rawCheckpoint) as Checkpoint;
        const metadata = await this.serde.loadsTyped(row.type ?? "json", rawMetadata) as CheckpointMetadata;

        yield {
          config: {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns: row.checkpoint_ns,
              checkpoint_id: row.checkpoint_id,
            },
          },
          checkpoint,
          metadata,
          parentConfig: row.parent_checkpoint_id
            ? {
              configurable: {
                thread_id: row.thread_id,
                checkpoint_ns: row.checkpoint_ns,
                checkpoint_id: row.parent_checkpoint_id,
              },
            }
            : undefined,
          pendingWrites,
        };
      }
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions
  ): Promise<RunnableConfig> {
    await this.setup();

    if (!config.configurable) {
      throw new Error("Empty configuration supplied.");
    }

    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? "";
    const parent_checkpoint_id = config.configurable?.checkpoint_id;

    if (!thread_id) {
      throw new Error(
        `Missing "thread_id" field in passed "config.configurable".`
      );
    }

    const preparedCheckpoint: Partial<Checkpoint> = copyCheckpoint(checkpoint);

    const [[type1, serializedCheckpoint], [type2, serializedMetadata]] =
      await Promise.all([
        this.serde.dumpsTyped(preparedCheckpoint),
        this.serde.dumpsTyped(metadata),
      ]);

    if (type1 !== type2) {
      throw new Error(
        "Failed to serialized checkpoint and metadata to the same type."
      );
    }

    const row = [
      thread_id,
      checkpoint_ns,
      checkpoint.id,
      parent_checkpoint_id || null,
      type1,
      serializedCheckpoint,
      serializedMetadata,
    ];

    await this.db
      .prepare(
  `INSERT OR REPLACE INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(...row)
      .run();

    return {
      configurable: {
        thread_id,
        checkpoint_ns,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    await this.setup();

    if (!config.configurable) {
      throw new Error("Empty configuration supplied.");
    }

    if (!config.configurable?.thread_id) {
      throw new Error("Missing thread_id field in config.configurable.");
    }

    if (!config.configurable?.checkpoint_id) {
      throw new Error("Missing checkpoint_id field in config.configurable.");
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO writes
      (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);


    const rows = await Promise.all(
      writes.map(async (write, idx) => {
        const [type, serializedWrite] = await this.serde.dumpsTyped(write[1]);
        const channel = write[0];
        // Use WRITES_IDX_MAP for special channels, otherwise use sequential index
        const writeIdx = WRITES_IDX_MAP[channel] ?? idx;
        return [
          config.configurable?.thread_id,
          config.configurable?.checkpoint_ns,
          config.configurable?.checkpoint_id,
          taskId,
          writeIdx,
          channel,
          type,
          serializedWrite,
        ];
      })
    );

    const statements = rows.map((r) => stmt.bind(
      r[0],
      r[1],
      r[2],
      r[3],
      r[4],
      r[5],
      r[6],
      r[7]
    ));
    await this.db.batch(statements);
  }

  async deleteThread(threadId: string) {
    await this.db.batch([
      this.db.prepare(`DELETE FROM checkpoints WHERE thread_id = ?`).bind(
        threadId
      ),
      this.db.prepare(`DELETE FROM writes WHERE thread_id = ?`).bind(threadId),
    ]);
  }

  /**
   * Deletes checkpoints and writes older than CHECKPOINT_RETENTION_DAYS
   */
  async cleanup(): Promise<{ deletedCheckpoints: number; deletedWrites: number }> {
    await this.setup();

    const cutoffTime = Math.floor(Date.now() / 1000) - (CHECKPOINT_RETENTION_DAYS * 24 * 60 * 60);

    try {
      const writesResult = await this.db.prepare(normalizeSQL(`
        DELETE FROM writes
        WHERE created_at < ?1
      `)).bind(cutoffTime).run();

      const checkpointsResult = await this.db.prepare(normalizeSQL(`
        DELETE FROM checkpoints
        WHERE created_at < ?1
      `)).bind(cutoffTime).run();

  const deletedCheckpoints = (checkpointsResult as D1RunResult).meta?.changes ?? 0;
  const deletedWrites = (writesResult as D1RunResult).meta?.changes ?? 0;

      if (deletedCheckpoints > 0 || deletedWrites > 0) {
        console.log(`Cleanup completed: deleted ${deletedCheckpoints} checkpoints and ${deletedWrites} writes older than ${CHECKPOINT_RETENTION_DAYS} days`);
      }

      return { deletedCheckpoints, deletedWrites };
    } catch (error) {
      console.log('Failed to cleanup old records:', error);
      const msg = (error && typeof error === 'object' && 'message' in error)
        ? String((error as { message?: unknown }).message)
        : String(error);
      throw new Error(`Cleanup failed: ${msg}`);
    }
  }

  // protected async migratePendingSends(
  //   checkpoint: Checkpoint,
  //   threadId: string,
  //   parentCheckpointId: string
  // ) {
  //   const { pending_sends } = this.db
  //     .prepare(
  //       `
  //         SELECT
  //           checkpoint_id,
  //           json_group_array(
  //             json_object(
  //               'type', ps.type,
  //               'value', CAST(ps.value AS TEXT)
  //             )
  //           ) as pending_sends
  //         FROM writes as ps
  //         WHERE ps.thread_id = ?
  //           AND ps.checkpoint_id = ?
  //           AND ps.channel = '${TASKS}'
  //         ORDER BY ps.idx
  //       `
  //     )
  //     .get(threadId, parentCheckpointId) as { pending_sends: string };

  //   const mutableCheckpoint = checkpoint;

  //   // add pending sends to checkpoint
  //   mutableCheckpoint.channel_values ??= {};
  //   mutableCheckpoint.channel_values[TASKS] = await Promise.all(
  //     JSON.parse(pending_sends).map(({ type, value }: PendingSendColumn) =>
  //       this.serde.loadsTyped(type, value)
  //     )
  //   );

  //   // add to versions
  //   mutableCheckpoint.channel_versions[TASKS] =
  //     Object.keys(checkpoint.channel_versions).length > 0
  //       ? maxChannelVersion(...Object.values(checkpoint.channel_versions))
  //       : this.getNextVersion(undefined);
  // }
}
