import { Miniflare } from "miniflare";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Checkpoint,
  CheckpointTuple,
  emptyCheckpoint,
  uuid6,
} from "@langchain/langgraph-checkpoint";
import { CloudflareD1Saver } from "../index.js";

// Helper function to create checkpointer with Miniflare
async function createTestCheckpointer(): Promise<{ saver: CloudflareD1Saver; mf: Miniflare }> {
  const mf = new Miniflare({
    modules: true,
    script: `
    export default {
      async fetch(request, env, ctx) {
        return new Response("Hello Miniflare!");
      }
    }`,
    d1Databases: {
      DB: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    },
  });

  const db = await mf.getD1Database("DB");
  const saver = new CloudflareD1Saver(db);
  return { saver, mf };
}

const checkpoint1: Checkpoint = {
  v: 4,
  id: uuid6(-1),
  ts: "2024-04-19T17:19:07.952Z",
  channel_values: {
    someKey1: "someValue1",
  },
  channel_versions: {
    someKey2: 1,
  },
  versions_seen: {
    someKey3: {
      someKey4: 1,
    },
  },
};
const checkpoint2: Checkpoint = {
  v: 4,
  id: uuid6(1),
  ts: "2024-04-20T17:19:07.952Z",
  channel_values: {
    someKey1: "someValue2",
  },
  channel_versions: {
    someKey2: 2,
  },
  versions_seen: {
    someKey3: {
      someKey4: 2,
    },
  },
};

describe("CloudflareD1Saver", () => {
  let cloudflareD1Saver: CloudflareD1Saver;
  let mf: Miniflare;

  beforeEach(async () => {
    const result = await createTestCheckpointer();
    cloudflareD1Saver = result.saver;
    mf = result.mf;
  });

  afterEach(async () => {
    await mf.dispose();
  });

  it("should save and retrieve checkpoints correctly", async () => {
    // get undefined checkpoint
    const undefinedCheckpoint = await cloudflareD1Saver.getTuple({
      configurable: { thread_id: "1" },
    });
    expect(undefinedCheckpoint).toBeUndefined();

    // save first checkpoint
    const runnableConfig = await cloudflareD1Saver.put(
      { configurable: { thread_id: "1" } },
      checkpoint1,
      { source: "update", step: -1, parents: {} },
      {}
    );
    expect(runnableConfig).toEqual({
      configurable: {
        thread_id: "1",
        checkpoint_ns: "",
        checkpoint_id: checkpoint1.id,
      },
    });

    // add some writes
    await cloudflareD1Saver.putWrites(
      {
        configurable: {
          checkpoint_id: checkpoint1.id,
          checkpoint_ns: "",
          thread_id: "1",
        },
      },
      [["bar", "baz"]],
      "foo"
    );

    // get first checkpoint tuple
    const firstCheckpointTuple = await cloudflareD1Saver.getTuple({
      configurable: { thread_id: "1" },
    });
    expect(firstCheckpointTuple?.config).toEqual({
      configurable: {
        thread_id: "1",
        checkpoint_ns: "",
        checkpoint_id: checkpoint1.id,
      },
    });
    expect(firstCheckpointTuple?.checkpoint).toEqual(checkpoint1);
    expect(firstCheckpointTuple?.parentConfig).toBeUndefined();
    expect(firstCheckpointTuple?.pendingWrites).toEqual([
      ["foo", "bar", "baz"],
    ]);

    // save second checkpoint
    await cloudflareD1Saver.put(
      {
        configurable: {
          thread_id: "1",
          checkpoint_id: "2024-04-18T17:19:07.952Z",
        },
      },
      checkpoint2,
      {
        source: "update",
        step: -1,
        parents: { "": checkpoint1.id },
      },
      {}
    );

    // verify that parentTs is set and retrieved correctly for second checkpoint
    const secondCheckpointTuple = await cloudflareD1Saver.getTuple({
      configurable: { thread_id: "1" },
    });
    expect(secondCheckpointTuple?.parentConfig).toEqual({
      configurable: {
        thread_id: "1",
        checkpoint_ns: "",
        checkpoint_id: "2024-04-18T17:19:07.952Z",
      },
    });

    // list checkpoints
    const checkpointTupleGenerator = await cloudflareD1Saver.list(
      {
        configurable: { thread_id: "1" },
      },
      {
        filter: {
          source: "update",
          step: -1,
          parents: { "": checkpoint1.id },
        },
      }
    );
    const checkpointTuples: CheckpointTuple[] = [];
    for await (const checkpoint of checkpointTupleGenerator) {
      checkpointTuples.push(checkpoint);
    }
    expect(checkpointTuples.length).toBe(1);

    const checkpointTuple1 = checkpointTuples[0];
    expect(checkpointTuple1.checkpoint.ts).toBe("2024-04-20T17:19:07.952Z");
  });

  it("should delete thread", async () => {
    await cloudflareD1Saver.put(
      { configurable: { thread_id: "1" } },
      emptyCheckpoint(),
      { source: "update", step: -1, parents: {} },
      {}
    );

    await cloudflareD1Saver.put(
      { configurable: { thread_id: "2" } },
      emptyCheckpoint(),
      { source: "update", step: -1, parents: {} },
      {}
    );

    await cloudflareD1Saver.deleteThread("1");

    expect(
      await cloudflareD1Saver.getTuple({ configurable: { thread_id: "1" } })
    ).toBeUndefined();

    expect(
      await cloudflareD1Saver.getTuple({ configurable: { thread_id: "2" } })
    ).toBeDefined();
  });
});
