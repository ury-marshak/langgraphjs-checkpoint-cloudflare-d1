# How LangGraph Calls the Checkpointer API During Graph Execution

This document explains the sequence and context of checkpointer API calls during LangGraph graph execution. Understanding this flow is essential for implementing and debugging custom checkpointers.

## Overview

LangGraph uses checkpointers to persist graph state, enabling:
- **Resumption**: Continue execution from where it left off
- **Human-in-the-loop**: Pause for user input, then resume
- **Fault tolerance**: Recover from crashes without losing progress
- **Time travel**: Replay or fork from any previous state

## Checkpointer API Methods

| Method | Purpose |
|--------|---------|
| `getTuple(config)` | Load a checkpoint with metadata and pending writes |
| `put(config, checkpoint, metadata, newVersions)` | Save a new checkpoint |
| `putWrites(config, writes, taskId)` | Store intermediate task writes |
| `list(config, options)` | Iterate over checkpoint history |
| `deleteThread(threadId)` | Delete all checkpoints for a thread |

---

## Execution Flow: Step by Step

### 1. Graph Initialization (`invoke` or `stream` called)

When a user calls `graph.invoke(input, config)` or `graph.stream(input, config)`, the first thing LangGraph does is initialize the execution loop.

**API Call: `getTuple(config)`**

```
Location: libs/langgraph-core/src/pregel/loop.ts (PregelLoop.initialize)
```

```typescript
const saved: CheckpointTuple = (await params.checkpointer?.getTuple(
  checkpointConfig
)) ?? {
  config,
  checkpoint: emptyCheckpoint(),
  metadata: { source: "input", step: -2, parents: {} },
  pendingWrites: [],
};
```

**What happens:**
- LangGraph attempts to load an existing checkpoint for the given `thread_id`
- If `checkpoint_id` is provided in config, that specific checkpoint is loaded
- If no `checkpoint_id`, the **latest** checkpoint for the thread is loaded
- If no checkpoint exists, an empty checkpoint is used (new conversation)

**Data passed:**
```typescript
{
  configurable: {
    thread_id: "user-123",           // Required: identifies the conversation
    checkpoint_ns: "",               // Optional: namespace for subgraphs
    checkpoint_id: "abc-123"         // Optional: specific checkpoint to load
  }
}
```

**Data returned (CheckpointTuple):**
```typescript
{
  config: { configurable: { thread_id, checkpoint_ns, checkpoint_id } },
  checkpoint: {
    v: 4,                           // Checkpoint format version
    id: "1ef...",                   // UUID of this checkpoint
    ts: "2024-...",                 // Timestamp
    channel_values: { ... },        // Current state values
    channel_versions: { ... },      // Version tracking per channel
    versions_seen: { ... }          // What each node has seen
  },
  metadata: {
    source: "loop",                 // "input" | "loop" | "update" | "fork"
    step: 5,                        // Execution step number
    parents: {}                     // Parent checkpoint references
  },
  parentConfig: { ... },            // Reference to previous checkpoint
  pendingWrites: [                  // Incomplete writes from previous run
    ["task-id", "channel", value],
    ...
  ]
}
```

**Why this matters:**
- `pendingWrites` tells LangGraph which tasks already completed (for resumption)
- `checkpoint.channel_versions` determines which nodes need to run
- `metadata.step` is used to continue step numbering

---

### 2. Input Processing (First Tick)

After loading the checkpoint, LangGraph processes the input and saves an "input checkpoint."

**API Call: `put(config, checkpoint, metadata, newVersions)`**

```
Location: libs/langgraph-core/src/pregel/loop.ts (_first method → _putCheckpoint)
```

```typescript
await this._putCheckpoint({ source: "input" });
```

**What happens:**
- Input is mapped to channel writes (e.g., `__start__` channel)
- A new checkpoint is created with the input state
- This checkpoint has `metadata.source = "input"` and `metadata.step = -1`

**Data passed:**
```typescript
put(
  { configurable: { thread_id, checkpoint_ns } },
  {
    v: 4,
    id: "new-uuid",
    ts: "2024-...",
    channel_values: { __start__: userInput },
    channel_versions: { __start__: 1 },
    versions_seen: {}
  },
  { source: "input", step: -1, parents: {} },
  { __start__: 1 }  // newVersions: channels that changed
)
```

**Why this matters:**
- Creates a restore point before any nodes execute
- Enables "replay from beginning" functionality

---

### 3. Task Execution (Each Node)

When a node executes and produces output, LangGraph saves the writes immediately (unless using `durability: "exit"`).

**API Call: `putWrites(config, writes, taskId)`**

```
Location: libs/langgraph-core/src/pregel/loop.ts (putWrites method)
         libs/langgraph-core/src/pregel/runner.ts (_commit method)
```

```typescript
// After node completes successfully
this.loop.putWrites(task.id, task.writes);

// Or on interrupt
this.loop.putWrites(task.id, [[INTERRUPT, interruptValue]]);

// Or on error
this.loop.putWrites(task.id, [[ERROR, { message, name }]]);
```

**What happens:**
- Node output is serialized and stored linked to current checkpoint
- Special channels use negative indices via `WRITES_IDX_MAP`:
  - `__error__` → idx: -1
  - `__scheduled__` → idx: -2
  - `__interrupt__` → idx: -3
  - `__resume__` → idx: -4

**Data passed:**
```typescript
putWrites(
  {
    configurable: {
      thread_id: "user-123",
      checkpoint_ns: "",
      checkpoint_id: "current-checkpoint-id"  // Links writes to this checkpoint
    }
  },
  [
    ["messages", newMessage],        // Regular channel write
    ["my_state_key", updatedValue]   // Another channel write
  ],
  "task-abc-123"                     // Unique task identifier
)
```

**Why this matters:**
- Enables **immediate recovery**: if the process crashes after this call, the completed task's output is preserved
- When resuming, `pendingWrites` from `getTuple` tells LangGraph this task is done

---

### 4. Step Completion (After All Nodes in a Superstep)

After all tasks in a step complete, LangGraph saves a "loop checkpoint."

**API Call: `put(config, checkpoint, metadata, newVersions)`**

```
Location: libs/langgraph-core/src/pregel/loop.ts (tick method → _putCheckpoint)
```

```typescript
// All tasks have finished, apply writes and save checkpoint
this.updatedChannels = _applyWrites(...);
await this._putCheckpoint({ source: "loop" });
```

**What happens:**
- All task writes are applied to channels
- New checkpoint is created with updated state
- `pending_writes` are cleared (they're now in the checkpoint)
- Step number is incremented

**Data passed:**
```typescript
put(
  { configurable: { thread_id, checkpoint_ns } },
  {
    v: 4,
    id: "new-uuid",
    ts: "2024-...",
    channel_values: {
      messages: [...allMessages],
      my_state: latestValue
    },
    channel_versions: { messages: 5, my_state: 3 },
    versions_seen: { node_a: { messages: 4 }, node_b: { my_state: 2 } }
  },
  { source: "loop", step: 1, parents: {} },
  { messages: 5 }  // Only channels that changed this step
)
```

**Why this matters:**
- Creates a complete snapshot of state after each step
- Enables "time travel" to any step in execution history

---

### 5. Interrupt Handling

When a node calls `interrupt()` (human-in-the-loop), special handling occurs.

**API Call: `putWrites(config, writes, taskId)` with INTERRUPT channel**

```
Location: libs/langgraph-core/src/pregel/runner.ts (_commit method)
```

```typescript
if (isGraphInterrupt(error)) {
  const interrupts: PendingWrite<string>[] = error.interrupts.map(
    (interrupt) => [INTERRUPT, interrupt]
  );
  this.loop.putWrites(task.id, interrupts);
}
```

**What happens:**
- Interrupt value is saved as a write to the `__interrupt__` channel
- Graph execution pauses
- User can inspect state and provide input
- When resumed, the interrupt write is found in `pendingWrites`

**Data flow for interrupt/resume:**
```
1. Node calls interrupt("Please confirm")
2. putWrites(config, [["__interrupt__", "Please confirm"]], taskId)
3. Graph pauses, returns to user
4. User calls graph.invoke(Command({ resume: "Yes" }), config)
5. getTuple loads checkpoint with pendingWrites containing the interrupt
6. putWrites(config, [["__resume__", "Yes"]], taskId)
7. Node receives resume value and continues
```

---

### 6. Error Handling

When a node throws an error, it's captured and stored.

**API Call: `putWrites(config, writes, taskId)` with ERROR channel**

```
Location: libs/langgraph-core/src/pregel/runner.ts (_commit method)
```

```typescript
this.loop.putWrites(task.id, [
  [ERROR, { message: error.message, name: error.name }],
]);
```

**What happens:**
- Error details are serialized and stored
- Graph can be configured to retry or halt
- Error is preserved for debugging

---

### 7. Durability Modes

LangGraph supports different durability modes that affect when checkpointer calls are made:

| Mode | `put` timing | `putWrites` timing |
|------|--------------|-------------------|
| `"async"` (default) | After each step, non-blocking | After each task, non-blocking |
| `"sync"` | After each step, awaited | After each task, awaited |
| `"exit"` | Only at graph exit | Only at graph exit (or error/interrupt) |

**With `durability: "exit"`:**
```typescript
// putWrites is skipped during execution
if (this.durability !== "exit" && this.checkpointer != null) {
  this.checkpointerPromises.push(
    this.checkpointer.putWrites(config, writesCopy, taskId)
  );
}

// But flushed at the end via _flushPendingWrites()
```

---

### 8. State Management API (User-Initiated)

These calls are made when users interact with graph state outside of execution.

#### `getState(config)`

**API Call: `getTuple(config)`**

```
Location: libs/langgraph-core/src/pregel/index.ts (getState method)
```

```typescript
const saved = await checkpointer.getTuple(config);
```

Used to inspect current state without executing the graph.

#### `getStateHistory(config, options)`

**API Call: `list(config, options)`**

```
Location: libs/langgraph-core/src/pregel/index.ts (getStateHistory method)
```

```typescript
for await (const checkpointTuple of checkpointer.list(mergedConfig, options)) {
  yield { ... };
}
```

Used to iterate through all checkpoints for a thread.

#### `updateState(config, values)`

**API Calls: `getTuple`, `put`, `putWrites`**

```
Location: libs/langgraph-core/src/pregel/index.ts (updateState method)
```

```typescript
// 1. Load current state
const saved = await checkpointer.getTuple(config);

// 2. Save new checkpoint with updates
const nextConfig = await checkpointer.put(
  config,
  newCheckpoint,
  { source: "update", step, parents }
);

// 3. Store the update writes
await checkpointer.putWrites(nextConfig, writes, NULL_TASK_ID);
```

Used to manually modify state (e.g., from a UI).

---

## Complete Execution Timeline

```
User calls: graph.invoke("Hello", { configurable: { thread_id: "123" } })

┌─────────────────────────────────────────────────────────────────────┐
│ 1. INITIALIZATION                                                    │
│    getTuple({ thread_id: "123" })                                   │
│    → Returns empty checkpoint (new thread)                          │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. INPUT PROCESSING                                                  │
│    put(checkpoint_with_input, { source: "input", step: -1 })        │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. STEP 0: Execute "agent" node                                      │
│    - Node runs, produces output                                      │
│    putWrites([["messages", agentMessage]], "task-001")              │
│    - All tasks done                                                  │
│    put(checkpoint_step_0, { source: "loop", step: 0 })              │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 4. STEP 1: Execute "tools" node                                      │
│    - Node runs, calls tools                                          │
│    putWrites([["messages", toolResults]], "task-002")               │
│    - All tasks done                                                  │
│    put(checkpoint_step_1, { source: "loop", step: 1 })              │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 5. STEP 2: Execute "agent" node again                                │
│    - Node determines conversation is complete                        │
│    putWrites([["messages", finalMessage]], "task-003")              │
│    - All tasks done                                                  │
│    put(checkpoint_step_2, { source: "loop", step: 2 })              │
│    - No more tasks to run                                            │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                            Graph returns result
```

---

## Key Implementation Notes for Checkpointer Authors

1. **`getTuple` must return `pendingWrites`**: These are critical for resumption
2. **`put` receives `newVersions`**: Currently unused by all implementations, but required by interface
3. **`putWrites` uses `WRITES_IDX_MAP`**: Special channels get negative indices to avoid conflicts
4. **Calls may be concurrent**: With `durability: "async"`, multiple `putWrites` can be in flight
5. **Order matters for `put`**: Checkpoints must be saved in order (LangGraph handles this with promise chaining)
6. **`thread_id` is always required**: The primary key for all operations
7. **`checkpoint_id` links writes**: `putWrites` uses the checkpoint_id from config to link writes

---

## References

- Source: [libs/langgraph-core/src/pregel/loop.ts](reference-codebase/langgraphjs/libs/langgraph-core/src/pregel/loop.ts)
- Source: [libs/langgraph-core/src/pregel/runner.ts](reference-codebase/langgraphjs/libs/langgraph-core/src/pregel/runner.ts)
- Source: [libs/langgraph-core/src/pregel/index.ts](reference-codebase/langgraphjs/libs/langgraph-core/src/pregel/index.ts)
- Source: [libs/checkpoint/src/base.ts](reference-codebase/langgraphjs/libs/checkpoint/src/base.ts)
