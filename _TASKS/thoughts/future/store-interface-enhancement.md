# Future Enhancement: CloudflareD1Store Implementation

**Status:** Proposed for v0.3.0+
**Priority:** Medium
**Prerequisite:** Complete checkpointer upgrade to v0.2.0 first

## Overview

LangGraph v0.4+ introduced a **Store interface** (`BaseStore`) that provides persistent key-value storage separate from checkpoints. This enables cross-thread memory, user preferences, and long-term storage that persists independently of conversation state.

This document outlines the potential implementation of `CloudflareD1Store` as a companion to `CloudflareD1Saver`.

---

## What is the Store Interface?

The Store is a **separate persistence layer** from the checkpointer:

| Aspect | Checkpointer | Store |
|--------|--------------|-------|
| **Purpose** | Conversation state & history | Long-term memory & shared data |
| **Scope** | Per-thread (conversation) | Cross-thread (user/app level) |
| **Lifecycle** | Tied to graph execution | Independent of execution |
| **Data model** | Checkpoint snapshots | Key-value with namespaces |

### Store API Methods

```typescript
abstract class BaseStore {
  // Core operations
  abstract batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>>;

  // Convenience methods (built on batch)
  async get(namespace: string[], key: string): Promise<Item | null>;
  async put(namespace: string[], key: string, value: Record<string, any>, index?: false | string[]): Promise<void>;
  async delete(namespace: string[], key: string): Promise<void>;
  async search(namespacePrefix: string[], options?: SearchOptions): Promise<SearchItem[]>;
  async listNamespaces(options?: ListOptions): Promise<string[][]>;

  // Lifecycle
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}
```

### Data Types

```typescript
interface Item {
  value: Record<string, any>;    // The stored data
  key: string;                   // Unique ID within namespace
  namespace: string[];           // Hierarchical path, e.g., ["users", "user-123"]
  createdAt: Date;
  updatedAt: Date;
}

interface SearchItem extends Item {
  score?: number;                // Relevance score (for semantic search)
}
```

---

## Use Cases

### 1. User Preferences
```typescript
// Store user preferences that persist across all conversations
await store.put(["users", "user-123", "preferences"], "settings", {
  language: "en",
  timezone: "America/New_York",
  theme: "dark"
});

// Retrieve in any conversation
const prefs = await store.get(["users", "user-123", "preferences"], "settings");
```

### 2. Long-Term Memory
```typescript
// Remember facts about a user
await store.put(["users", "user-123", "facts"], "personal", {
  name: "Alice",
  interests: ["hiking", "photography"],
  lastMentioned: { topic: "vacation plans", date: "2024-12-01" }
});
```

### 3. Cross-Thread Shared State
```typescript
// Store data accessible by multiple agents/graphs
await store.put(["shared", "knowledge-base"], "faq", {
  questions: [...],
  lastUpdated: new Date()
});
```

### 4. Session/Temporary Data with TTL
```typescript
// Store with automatic expiration (if TTL implemented)
await store.put(["sessions", sessionId], "data", {
  cart: [...],
  expiresAt: Date.now() + 3600000  // 1 hour
});
```

---

## Proposed Implementation

### Database Schema

```sql
CREATE TABLE IF NOT EXISTS store (
  namespace TEXT NOT NULL,           -- Dot-joined namespace path
  key TEXT NOT NULL,
  value TEXT NOT NULL,               -- JSON-encoded value
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (namespace, key)
);

-- Index for namespace prefix searches
CREATE INDEX IF NOT EXISTS idx_store_namespace ON store(namespace);

-- Optional: Index for TTL cleanup
CREATE INDEX IF NOT EXISTS idx_store_updated ON store(updated_at);
```

### Class Structure

```typescript
import { BaseStore, Item, SearchItem, Operation, OperationResults } from "@langchain/langgraph-checkpoint";
import { D1Database } from '@cloudflare/workers-types';

export class CloudflareD1Store extends BaseStore {
  private db: D1Database;
  private isSetup: boolean = false;

  constructor(db: D1Database) {
    super();
    this.db = db;
  }

  async setup(): Promise<void> {
    if (this.isSetup) return;
    // Create table and indexes
    this.isSetup = true;
  }

  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    await this.setup();
    // Process operations in a batch using D1's batch API
  }

  // Namespace helpers
  private namespaceToString(namespace: string[]): string {
    return namespace.join(".");
  }

  private stringToNamespace(str: string): string[] {
    return str.split(".");
  }
}
```

### Key Implementation Details

1. **Namespace Storage**: Join array with `.` separator (e.g., `["users", "123"]` → `"users.123"`)

2. **Prefix Search**: Use SQL `LIKE` for namespace prefix matching:
   ```sql
   SELECT * FROM store WHERE namespace LIKE ? || '%'
   ```

3. **Batch Operations**: Use D1's batch API for efficient multi-operation execution

4. **JSON Value Storage**: Store `value` as JSON text, parse on retrieval

5. **Filter Implementation**: Parse JSON and apply filters in SQL where possible, or in JS for complex cases

---

## Features NOT Included

### Vector Similarity Search
- D1 doesn't support vector operations natively
- Would require integration with Cloudflare Vectorize or external service
- Significant complexity increase
- **Recommendation**: Skip for initial implementation

### Advanced Filter Operators
- Full operator support (`$gt`, `$lt`, `$in`, etc.) requires JSON parsing
- D1's JSON support is limited compared to PostgreSQL
- **Recommendation**: Start with exact match only, add operators incrementally

---

## Optional: TTL Support

Similar to the existing `cleanup()` method in CloudflareD1Saver:

```typescript
interface TTLConfig {
  defaultTtlMinutes?: number;      // Default TTL for new items
  refreshOnRead?: boolean;         // Update TTL on get()
  sweepIntervalSeconds?: number;   // Cleanup frequency
}

class CloudflareD1Store extends BaseStore {
  async cleanup(): Promise<{ deleted: number }> {
    const cutoffTime = Math.floor(Date.now() / 1000) - (this.ttlMinutes * 60);
    const result = await this.db.prepare(
      "DELETE FROM store WHERE updated_at < ?"
    ).bind(cutoffTime).run();
    return { deleted: result.meta?.changes ?? 0 };
  }
}
```

---

## Estimated Implementation Effort

| Component | Effort | Notes |
|-----------|--------|-------|
| Basic CRUD | 2-3 hours | get, put, delete |
| Batch operations | 2-3 hours | Efficient multi-op |
| Search with filters | 3-4 hours | Namespace prefix + basic filters |
| listNamespaces | 1-2 hours | Namespace enumeration |
| TTL/cleanup | 1 hour | Similar to existing cleanup() |
| Tests | 3-4 hours | Unit + integration |
| **Total** | **12-17 hours** | |

---

## Integration with LangGraph

Once implemented, users can use the store with their graphs:

```typescript
import { CloudflareD1Saver, CloudflareD1Store } from "langgraph-checkpoint-cloudflare-d1";

// In Cloudflare Worker
export default {
  async fetch(request: Request, env: Env) {
    const checkpointer = new CloudflareD1Saver(env.DB);
    const store = new CloudflareD1Store(env.DB);  // Can share same D1 database

    const graph = createReactAgent({
      // ... agent config
    }).compile({
      checkpointer,
      store,  // Enable long-term memory
    });

    // Store automatically available in graph nodes via context
  }
};
```

---

## Decision Criteria for Implementation

Implement if:
- ✅ Users request cross-conversation memory features
- ✅ LangGraph's memory patterns become more Store-centric
- ✅ Cloudflare Workers apps need persistent user data

Defer if:
- ❌ Basic checkpointing meets all current needs
- ❌ Users can use Cloudflare KV for simple key-value needs
- ❌ Limited development resources

---

## References

- Store interface: [libs/checkpoint/src/store/base.ts](../../reference-codebase/langgraphjs/libs/checkpoint/src/store/base.ts)
- PostgresStore implementation: [libs/checkpoint-postgres/src/store/](../../reference-codebase/langgraphjs/libs/checkpoint-postgres/src/store/)
- InMemoryStore: [libs/checkpoint/src/store/memory.ts](../../reference-codebase/langgraphjs/libs/checkpoint/src/store/memory.ts)
- LangGraph memory docs: https://langchain-ai.github.io/langgraphjs/how-tos/memory/
