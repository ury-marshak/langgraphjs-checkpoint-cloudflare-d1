# langgraph-checkpoint-cloudflare-d1

Implementation of a [LangGraph.js](https://github.com/langchain-ai/langgraphjs) CheckpointSaver that uses a Cloudflare D1 database.

Based on the original SQLite implementation.

## Conformity
Running the test provided by LangGraph.js gives 4 errors. One of them is not implemented even in their original checkpointers yet. The other 3 are related to migrations from the old format - since this is a new implementation and we don't have any old data, I didn't bother implementing them.
At the time of this writing the published version of `@langchain/langgraph-checkpoint-validation` is too old. To run the validation test get the source code and link it locally in the test/ directory (see test/package.json).

## Building
```
npx yarn install
npx yarn build
```

## Usage

```ts
import { CloudflareD1Saver } from "@langchain/langgraph-checkpoint-cloudflare-d1";

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

const checkpointer = SqliteSaver.fromConnString(":memory:");
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

// store checkpoint
await checkpointer.put(writeConfig, checkpoint, {}, {})

// load checkpoint
await checkpointer.get(readConfig)

// list checkpoints
for await (const checkpoint of checkpointer.list(readConfig)) {
  console.log(checkpoint);
}
```
