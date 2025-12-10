# LangGraph Checkpointer Upgrade to v1.0+ Implementation Plan

## Overview

This plan outlines the upgrade of the `langgraph-checkpoint-cloudflare-d1` package from compatibility with LangGraph v0.3 (August 2024) to the latest LangGraph.js v1.1+ (December 2025). The package provides a checkpointer implementation that works with Cloudflare D1 database in Cloudflare Workers environments.

## Current State Analysis

### Current Dependencies
- `@langchain/langgraph-checkpoint`: `^0.1.0` (peer dependency)
- `@langchain/core`: `>=0.3.0 <0.4.0` (peer dependency)
- Package version: `0.1.0`

### Target Dependencies
- `@langchain/langgraph-checkpoint`: `^1.0.0`
- `@langchain/core`: `^1.0.1`

### Key Discoveries

1. **Put method signature change** ([src/index.ts#L345](src/index.ts#L345)):
   - Current: `put(config, checkpoint, metadata): Promise<RunnableConfig>`
   - Required: `put(config, checkpoint, metadata, newVersions: ChannelVersions): Promise<RunnableConfig>`
   - Note: The `newVersions` parameter is required by the abstract interface but appears unused in all reference implementations (SqliteSaver, MemorySaver, PostgresSaver)

2. **WRITES_IDX_MAP for special writes** ([reference: libs/checkpoint/src/base.ts#L198](reference-codebase/langgraphjs/libs/checkpoint/src/base.ts#L198)):
   - New constant maps special write channels (ERROR, INTERRUPT, SCHEDULED, RESUME) to negative indices
   - Must be used in `putWrites` to handle special writes correctly
   - Prevents conflicts between special writes and regular writes

3. **Pending sends migration** ([src/index.ts](src/index.ts)):
   - Migration logic exists but is commented out
   - Reference implementations (SqliteSaver) have active migration for v < 4 checkpoints
   - **DEFERRED**: Keeping commented out for now - can be enabled later if needed for legacy checkpoint compatibility

4. **Missing `fromConnString` static method** ([src/tests/checkpoints.test.ts#L47](src/tests/checkpoints.test.ts#L47)):
   - Tests reference `CloudflareD1Saver.fromConnString(":memory:")` but method doesn't exist
   - Used in SqliteSaver for convenience testing
   - For D1, this needs different handling (Miniflare)

5. **Checkpoint version handling**:
   - Current tests create checkpoints with `v: 1`
   - Latest version uses `v: 4`
   - Migration logic handles this transition

6. **Serialization is already async**:
   - Current implementation already uses `await this.serde.dumpsTyped()` and `await this.serde.loadsTyped()`
   - No changes needed for async serialization

7. **`deleteThread` method already implemented** ([src/index.ts#L421](src/index.ts#L421)):
   - Already exists and properly deletes from both tables

## Desired End State

After completion:
1. Package works with `@langchain/langgraph-checkpoint` v1.0.0 and `@langchain/core` v1.0.1+
2. All checkpointer interface methods have correct signatures
3. Special writes (ERROR, INTERRUPT, etc.) are handled with negative indices
4. All unit tests pass with updated test fixtures
5. Validation tests pass via `@langchain/langgraph-checkpoint-validation`

**Note**: Pending sends migration for v < 4 checkpoints is kept commented out (deferred).

### Verification

```bash
# Build the package
yarn build

# Run unit tests
yarn test

# Run validation tests (requires langgraphjs checkout)
cd test && ./test-checkpointer.sh
```

## What We're NOT Doing

- **Not changing the database schema** - Current schema is compatible with the new version
- **Not implementing Store interface** - Only upgrading checkpointer, store is separate
- **Not adding new optional features** - Focus on compatibility upgrade only
- **Not changing the cleanup() method** - Custom feature not in base interface
- **Not implementing `fromConnString` for D1** - D1 doesn't have connection strings; keep existing constructor pattern

## Implementation Approach

The upgrade follows a bottom-up approach:
1. Update dependencies first
2. Update type signatures to match new interface
3. Add WRITES_IDX_MAP handling for special writes
4. ~~Implement pending sends migration~~ (SKIPPED - keeping commented out)
5. Update tests to use v4 checkpoint format
6. Verify with validation suite

---

## Phase 1: Update Dependencies and Type Signatures

### Overview
Update package.json dependencies and fix the `put` method signature to accept the required `newVersions` parameter.

### Changes Required

#### 1. Update package.json
**File**: [package.json](package.json)
**Changes**: Update peer dependencies and dev dependencies to latest versions

```json
// peerDependencies
"@langchain/core": "^1.0.1",
"@langchain/langgraph-checkpoint": "^1.0.0"

// devDependencies
"@langchain/core": "^1.0.1",
"@langchain/langgraph-checkpoint": "^1.0.0",
```

#### 2. Update `put` Method Signature
**File**: [src/index.ts](src/index.ts)
**Changes**: Add `newVersions` parameter to method signature

```typescript
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointTuple,
  type SerializerProtocol,
  type PendingWrite,
  type CheckpointMetadata,
  type ChannelVersions,  // Add this import
  TASKS,
  copyCheckpoint,
} from "@langchain/langgraph-checkpoint";

// ... later in the class

async put(
  config: RunnableConfig,
  checkpoint: Checkpoint,
  metadata: CheckpointMetadata,
  newVersions: ChannelVersions  // Add this parameter
): Promise<RunnableConfig> {
  // Implementation remains unchanged - newVersions is not used
  // (matching behavior of SqliteSaver, MemorySaver, PostgresSaver)
```

### Success Criteria

#### Automated Verification:
- [x] `yarn install` completes without peer dependency warnings
- [x] `yarn build` completes without TypeScript errors
- [x] Type checking passes: `npx tsc --noEmit`

**Implementation Note**: After completing this phase and all automated verification passes, proceed to the next phase.

---

## Phase 2: Implement WRITES_IDX_MAP for Special Writes

### Overview
Update `putWrites` to use `WRITES_IDX_MAP` for special write channels (ERROR, INTERRUPT, SCHEDULED, RESUME) to assign negative indices, preventing conflicts with regular writes.

### Changes Required

#### 1. Import WRITES_IDX_MAP
**File**: [src/index.ts](src/index.ts)
**Changes**: Add import for WRITES_IDX_MAP

```typescript
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
  WRITES_IDX_MAP,  // Add this import
} from "@langchain/langgraph-checkpoint";
```

#### 2. Update putWrites Method
**File**: [src/index.ts](src/index.ts)
**Changes**: Use WRITES_IDX_MAP for determining write index

```typescript
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
        writeIdx,  // Changed from idx to writeIdx
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
```

### Success Criteria

#### Automated Verification:
- [x] Build passes: `yarn build`
- [x] Unit tests pass: `npx vitest run`

**Implementation Note**: After completing this phase and all automated verification passes, proceed to the next phase.

---

## Phase 3: ~~Implement Pending Sends Migration~~ (SKIPPED)

### Overview
**This phase is intentionally skipped.** The `migratePendingSends` method remains commented out.

### Rationale
- The migration handles backward compatibility for v < 4 checkpoints
- Our production database likely only has checkpoints created with recent versions
- Can be enabled later if legacy checkpoint compatibility becomes necessary
- The commented code in [src/index.ts](src/index.ts#L446-L475) serves as documentation for future implementation

### Future Implementation
If needed later, uncomment the `migratePendingSends` method and add calls in `getTuple()` and `list()` methods. See the reference implementation in SqliteSaver.

---

## Phase 4: Update Tests for v4 Checkpoint Format

### Overview
Update test fixtures and test file to use the v4 checkpoint format and ensure compatibility with the new interface.

### Changes Required

#### 1. Update Test Checkpoints to v4
**File**: [src/tests/checkpoints.test.ts](src/tests/checkpoints.test.ts)
**Changes**: Change checkpoint version from v: 1 to v: 4

```typescript
const checkpoint1: Checkpoint = {
  v: 4,  // Changed from 1 to 4
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
  v: 4,  // Changed from 1 to 4
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
```

#### 2. Update put() Calls with newVersions Parameter
**File**: [src/tests/checkpoints.test.ts](src/tests/checkpoints.test.ts)
**Changes**: Add empty object for newVersions parameter in all put() calls

```typescript
// Example - update all put() calls:
const runnableConfig = await cloudflareD1Saver.put(
  { configurable: { thread_id: "1" } },
  checkpoint1,
  { source: "update", step: -1, parents: {} },
  {}  // Add newVersions parameter
);
```

#### 3. Remove fromConnString References
**File**: [src/tests/checkpoints.test.ts](src/tests/checkpoints.test.ts)
**Changes**: Replace `fromConnString` with Miniflare-based setup

```typescript
import { Miniflare } from "miniflare";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Add helper function to create checkpointer
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

// Update tests to use the helper
describe("CloudflareD1Saver", () => {
  let saver: CloudflareD1Saver;
  let mf: Miniflare;

  beforeEach(async () => {
    const result = await createTestCheckpointer();
    saver = result.saver;
    mf = result.mf;
  });

  afterEach(async () => {
    await mf.dispose();
  });

  it("should save and retrieve checkpoints correctly", async () => {
    // Use saver instead of CloudflareD1Saver.fromConnString(":memory:")
    // ...
  });
});
```

#### 4. Update Integration Test File
**File**: [test/test_d1.ts](test/test_d1.ts)
**Changes**: Update checkpoint version and put() call

```typescript
const checkpoint = {
  v: 4,  // Changed from 1 to 4
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
  // Remove pending_sends - no longer in checkpoint structure
}

// Update put call
await checkpointer.put(writeConfig, checkpoint, { source: "update", step: -1, parents: {} }, {})
```

### Success Criteria

#### Automated Verification:
- [x] Build passes: `yarn build`
- [x] All unit tests pass: `npx vitest run`
- [x] Integration test passes: `cd test && npx tsx test_d1.ts`
- [x] TypeScript compiles without errors: `npx tsc --noEmit`

**Implementation Note**: After completing this phase and all automated verification passes, proceed to the next phase.

---

## Phase 5: Update Validation Test Setup

### Overview
Update the validation test initializer and ensure compatibility with the official LangGraph checkpoint validation suite.

### Changes Required

#### 1. Update Test Package Dependencies
**File**: [test/package.json](test/package.json)
**Changes**: Update to use npm package instead of local file reference

```json
{
  "name": "test",
  "version": "1.0.0",
  "main": "index.js",
  "type": "module",
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "author": "",
  "license": "ISC",
  "description": "",
  "devDependencies": {
    "@langchain/langgraph-checkpoint-validation": "^1.0.0"
  }
}
```

#### 2. Update Initializer Import
**File**: [test/cfd1_initializer.ts](test/cfd1_initializer.ts)
**Changes**: Update type import name if changed in new version

```typescript
/* eslint-disable import/no-extraneous-dependencies */
import { Miniflare } from "miniflare";
import { CloudflareD1Saver } from "../src/index.js";

// Note: Type name may have changed - verify against actual package
import type { CheckpointerTestInitializer } from "@langchain/langgraph-checkpoint-validation";

const dbName = "test_db";

export const initializer: CheckpointerTestInitializer<CloudflareD1Saver> = {
  checkpointerName: "langgraph-checkpoint-cloudflare-d1",

  async beforeAll() {
  },

  beforeAllTimeout: 300_000,

  async afterAll() {
  },

  async createCheckpointer() {
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

    const checkpointer: CloudflareD1Saver = new CloudflareD1Saver(db);
    // Store miniflare reference for cleanup
    (checkpointer as any)._mf = mf;
    return checkpointer;
  },

  async destroyCheckpointer(checkpointer: CloudflareD1Saver) {
    // Clean up miniflare instance
    const mf = (checkpointer as any)._mf;
    if (mf) {
      await mf.dispose();
    }
  },
};

export default initializer;
```

### Success Criteria

#### Automated Verification:
- [x] `cd test && npm install` completes successfully
- [x] Validation tests pass: `cd test && ./test-checkpointer.sh`

**Implementation Note**: After completing this phase and all automated verification passes, proceed to final testing.

---

## Phase 6: Bump Package Version and Final Cleanup

### Overview
Update package version to indicate the breaking change upgrade and ensure all documentation is accurate.

### Changes Required

#### 1. Update Package Version
**File**: [package.json](package.json)
**Changes**: Bump version to 0.2.0 to indicate breaking changes

```json
{
  "name": "langgraph-checkpoint-cloudflare-d1",
  "version": "0.2.0",
  // ...
}
```

#### 2. Update README if Needed
**File**: [README.md](README.md)
**Changes**: Document compatibility with LangGraph v1.0+

Add a note about version compatibility:
```markdown
## Compatibility

- Version 0.2.x: Compatible with `@langchain/langgraph-checkpoint` v1.0.0+ and `@langchain/core` v1.0.1+
- Version 0.1.x: Compatible with `@langchain/langgraph-checkpoint` v0.1.x and `@langchain/core` v0.3.x
```

#### 3. Update CHANGELOG
**File**: [CHANGELOG.md](CHANGELOG.md)
**Changes**: Document the upgrade

```markdown
## [0.2.0] - 2025-12-XX

### Breaking Changes
- Updated peer dependencies to require `@langchain/langgraph-checkpoint` v1.0.0+ and `@langchain/core` v1.0.1+
- `put()` method signature now accepts a fourth parameter `newVersions: ChannelVersions`

### Added
- Support for `WRITES_IDX_MAP` for handling special write channels (ERROR, INTERRUPT, SCHEDULED, RESUME)

### Fixed
- Compatible with LangGraph.js v0.4.x breaking changes
```

### Success Criteria

#### Automated Verification:
- [x] Full build passes: `yarn build`
- [x] All unit tests pass: `npx vitest run`
- [x] Integration test passes: `cd test && npx tsx test_d1.ts`
- [x] Validation tests pass: `cd test && ./test-checkpointer.sh`
- [x] No TypeScript errors: `npx tsc --noEmit`
- [ ] Linting passes: `yarn lint` (if configured)

---

## Testing Strategy

### Unit Tests
Located in [src/tests/checkpoints.test.ts](src/tests/checkpoints.test.ts):
- Basic CRUD operations (save/retrieve checkpoints)
- Thread deletion
- Pending writes storage and retrieval
- List with filtering

**Note**: Pending sends migration test should be skipped or removed since the feature is deferred.

### Integration Tests
Located in [test/test_d1.ts](test/test_d1.ts):
- End-to-end flow with Miniflare simulating D1
- Put/Get/List operations

### Validation Tests
Via `@langchain/langgraph-checkpoint-validation`:
- Standard checkpointer interface compliance
- All abstract methods work correctly
- Edge cases handled properly

### Manual Testing Steps
After all automated tests pass:
1. Deploy to a staging Cloudflare Worker environment
2. Test with a real LangGraph agent
3. Verify checkpoint persistence and retrieval works in production-like environment
4. Test upgrade path: load old v1 checkpoints, verify migration works

---

## Performance Considerations

- **WRITES_IDX_MAP lookup**: O(1) hash lookup, negligible performance impact
- **Pending sends migration**: Currently disabled (commented out) - no performance impact
- **Batch operations**: Continue using D1's batch API for efficient multi-row inserts

---

## Migration Notes

### For Users Upgrading from v0.1.x

1. Update peer dependencies in your project:
   ```bash
   npm install @langchain/core@^1.0.1 @langchain/langgraph-checkpoint@^1.0.0
   ```

2. Update the checkpointer package:
   ```bash
   npm install langgraph-checkpoint-cloudflare-d1@^0.2.0
   ```

3. No code changes required if using the checkpointer through LangGraph's standard interface

4. If calling `put()` directly, add an empty object as the fourth parameter:
   ```typescript
   // Before
   await checkpointer.put(config, checkpoint, metadata);

   // After
   await checkpointer.put(config, checkpoint, metadata, {});
   ```

### Database Migration
- No schema changes required
- **Note**: Pending sends migration is disabled, so v < 4 checkpoints won't have their pending sends automatically migrated. This is acceptable if no legacy checkpoints exist or pending sends are not needed.

---

## References

- Preliminary research: [test/UPGRADE-PRELIMINARY-INFO.md](test/UPGRADE-PRELIMINARY-INFO.md)
- Reference implementation: [reference-codebase/langgraphjs/libs/checkpoint-sqlite/src/index.ts](reference-codebase/langgraphjs/libs/checkpoint-sqlite/src/index.ts)
- LangGraph versions: [reference-codebase/langgraphjs/docs/docs/versions/index.md](reference-codebase/langgraphjs/docs/docs/versions/index.md)
- BaseCheckpointSaver interface: [reference-codebase/langgraphjs/libs/checkpoint/src/base.ts](reference-codebase/langgraphjs/libs/checkpoint/src/base.ts)
