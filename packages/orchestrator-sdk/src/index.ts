// @pcc/orchestrator-sdk — horizontal core for building business-process
// orchestrators on PCC. Templates ship as @pcc/template-* and import from here.
//
// Public surface stays small on purpose. New shared utilities go inside
// `core/` or `tools/`; new vertical knowledge belongs in a template package.

// --- Core ---
export {
  startSession,
  getSession,
  advanceSession,
  withIdempotency,
  idempotencyKey,
  setSessionStore,
  getSessionStore,
  restoreSessionsFrom,
  InMemorySessionStore,
  _resetStoreForTests,
  _resetStoreInstanceForTests,
  _clearIdempotencyForTests,
  type OnboardSession,
  type OnboardState,
  type Capability,
  type SessionStore,
} from "./core/state-machine.js";

export {
  emit,
  tail,
  snapshot,
  tracked,
  type AppEvent,
} from "./core/event-bus.js";

export {
  takeSnapshot,
  serialize,
  deserialize,
  type OrchestratorSnapshot,
  type TakeSnapshotOptions,
} from "./core/snapshot.js";

export {
  assertProductionReady,
  findEnabledMocks,
  type BootCheckResult,
} from "./core/boot-check.js";

// --- Tools ---
export {
  extractStructured,
  camoufoxFetch,
  detectAuthWall,
  AuthWallError,
  type ExtractOptions,
} from "./tools/web-extract.js";

export {
  publishOperator,
  searchCapabilities,
  type DiscoveryProfile,
  type PublishResult,
  type SearchOptions,
} from "./tools/pcc-discovery.js";

export {
  writeOperatorMirror,
  writeOperatorDirectory,
  renderOperatorHtml,
  renderDirectoryHtml,
  slugify,
  type MirrorWriteResult,
  type DirectoryEntry,
  type RenderOptions,
} from "./tools/static-mirror.js";

export { createAgentWallet } from "./tools/wallet.js";

export { zodToJsonSchema } from "./tools/zod-json-schema.js";

// --- Templates ---
export {
  defineTemplate,
  TemplateRegistry,
  templates,
  type TemplateManifest,
  type TemplateAdapter,
  type TemplateAdapters,
  type TemplateProduces,
  type CapabilityClass,
} from "./templates/registry.js";
