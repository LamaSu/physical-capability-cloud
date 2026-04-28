// @pcc/agent-onboarder — public API.
//
// See README.md for usage; see docs/agent-onboarder/NAVI-V2-MIGRATION-PLAN.md
// for the larger migration context.

export { OnboarderAgent, type OnboarderAgentOptions, type OnboarderChatResult } from "./onboarder-agent.js";
export { ONBOARDER_SYSTEM_PROMPT, getOnboarderSystemPrompt } from "./system-prompt.js";

export {
  startSession,
  getSession,
  advanceSession,
  type OnboardSession,
  type OnboardState,
  type Capability,
} from "./state-machine.js";

export {
  extractStructured,
  camoufoxFetch,
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

export { emit, tail, snapshot, tracked, type AppEvent } from "./lib/event-bus.js";
