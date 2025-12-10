# @langchain/langgraph-checkpoint-sqlite

## 0.2.0

### Breaking Changes
- Updated peer dependencies to require `@langchain/langgraph-checkpoint` v1.0.0+ and `@langchain/core` v1.1.4+
- `put()` method signature now accepts a fourth parameter `newVersions: ChannelVersions`

### Added
- Support for `WRITES_IDX_MAP` for handling special write channels (ERROR, INTERRUPT, SCHEDULED, RESUME)

### Fixed
- Compatible with LangGraph.js v0.4.x breaking changes

## 0.2.0

### Minor Changes

- ccbcbc1: Add delete thread method to checkpointers
- Updated dependencies [773ec0d]
  - @langchain/langgraph-checkpoint@0.1.0

### Patch Changes

- Updated dependencies [ccbcbc1]
- Updated dependencies [10f292a]
- Updated dependencies [3fd7f73]
