import { Miniflare } from "miniflare";
import { CloudflareD1Saver } from "../src/index.js";
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointTuple,
  type SerializerProtocol,
  type PendingWrite,
  type CheckpointMetadata,
  TASKS,
  copyCheckpoint,
} from "@langchain/langgraph-checkpoint";


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

const checkpointer: BaseCheckpointSaver = new CloudflareD1Saver(db);

const writeConfig = {
    configurable: {
        thread_id: "1",
        checkpoint_ns: ""
    }
};
const readConfig = {
    configurable: {
        thread_id: "1"
    }
};

const checkpoint = {
    v: 1,
    ts: "2024-07-31T20:14:19.804150+00:00",
    id: "1ef4f797-8335-6428-8001-8a1503f9b875",
    channel_values: {
        my_key: "meow",
        node: "node"
    },
    channel_versions: {
        __start__: 2,
        my_key: 3,
        "start:node": 3,
        node: 3
    },
    versions_seen: {
        __input__: {},
        __start__: {
            __start__: 1
        },
        node: {
            "start:node": 2
        }
    },
    pending_sends: [],
}

console.log("Storing checkpoint");
// store checkpoint
await checkpointer.put(writeConfig, checkpoint, { source: "update", step: -1, parents: {} }, {})

console.log("Loading checkpoint");
// load checkpoint
await checkpointer.get(readConfig)

console.log("Listing checkpoints");
// list checkpoints
for await (const checkpoint of checkpointer.list(readConfig)) {
    console.log(checkpoint);
}


await mf.dispose();
