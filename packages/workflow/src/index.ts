// @pcc/workflow — durable execution primitives for PCC.
// Public API re-exports. Implementation lives in subdirectories:
//   - ./shared        — types, canonical-JSON, hashing primitives
//   - ./store         — pluggable persistence (sqlite default)
//   - ./activity      — idempotent activity wrapper
//   - ./workflow      — event-sourced workflow base
//   - ./data-port     — federated I/O abstraction (CID handoff)
//   - ./cwl           — CWL YAML export
//   - ./version       — getVersion() helper for long-running workflow code evolution

// Shared types + utils
export * from './shared/index.js';

// Store
export * from './store/index.js';

// Activity
export * from './activity/index.js';

