# langgraph-checkpoint-cloudflare-d1

Implementation of a [LangGraph.js](https://github.com/langchain-ai/langgraphjs) CheckpointSaver that uses a Cloudflare D1 database.

Based on the original SQLite implementation.

## Compatibility

- Version 0.2.x: Compatible with `@langchain/langgraph-checkpoint` v1.0.0+ and `@langchain/core` v1.1.4+
- Version 0.1.x: Compatible with `@langchain/langgraph-checkpoint` v0.1.x and `@langchain/core` v0.3.x

## Conformity

Running the LangGraph.js validation test suite gives 4 expected failures:

1. **Channel delta storage** (1 test): The `newVersions` parameter in `put()` is not used to filter `channel_values`. This is an optimization that stores only changed channels rather than all channel values. None of the official LangGraph checkpointers (MemorySaver, SqliteSaver, MongoDBSaver) implement this yet either - see [issue #593](https://github.com/langchain-ai/langgraphjs/issues/593).

2. **Pending sends migration** (3 tests): Migration of `pending_sends` from v1-v3 checkpoint format to v4 is not implemented. Since this is primarily a new implementation without legacy data, this migration was intentionally deferred.

To run the validation tests, link the `@langchain/langgraph-checkpoint-validation` package locally in the test/ directory (see test/package.json).

## Building
```
npx yarn install
npx yarn build
```

## Usage

```ts
import { CloudflareD1Saver } from "langgraph-checkpoint-cloudflare-d1";

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

// Create a checkpointer with your D1 database binding
const checkpointer = new CloudflareD1Saver(env.DB);

const checkpoint = {
  v: 4,
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
}

// store checkpoint
await checkpointer.put(writeConfig, checkpoint, { source: "update", step: -1, parents: {} }, {})

// load checkpoint
await checkpointer.get(readConfig)

// list checkpoints
for await (const checkpoint of checkpointer.list(readConfig)) {
  console.log(checkpoint);
}
```
