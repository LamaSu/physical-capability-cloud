// @pcc/workflow — durable execution primitives for PCC.
// Re-exports public API. Implementation lives in subdirectories:
//   - ./activity       — idempotent activity wrapper
//   - ./workflow       — event-sourced workflow base
//   - ./data-port      — federated I/O abstraction (CID handoff)
//   - ./cwl            — CWL YAML export
//   - ./store          — pluggable persistence (sqlite default, swap for postgres etc.)
//   - ./version        — getVersion() helper for long-running workflow code evolution

export {}; // placeholder until primitives land
