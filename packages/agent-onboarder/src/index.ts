// @pcc/template-physical-operator — onboards machine shops, fleets, labs, and
// warehouses to PCC. Built on @pcc/orchestrator-sdk.
//
// (Package directory is still named `agent-onboarder` for git-history minimal
// diff; the npm name is the canonical identifier.)
//
// See README.md for usage; see docs/agent-onboarder/NAVI-V2.5-SDK-REFRAME.md
// for the SDK extraction context.

export { OnboarderAgent, type OnboarderAgentOptions, type OnboarderChatResult } from "./onboarder-agent.js";
export { ONBOARDER_SYSTEM_PROMPT, getOnboarderSystemPrompt } from "./system-prompt.js";
export { default as manifest } from "./manifest.js";

// Re-export SDK surface for any downstream that was previously importing it
// from @pcc/agent-onboarder. Keeps the rename non-breaking. New callers should
// import directly from @pcc/orchestrator-sdk.
export {
  startSession,
  getSession,
  advanceSession,
  type OnboardSession,
  type OnboardState,
  type Capability,
  extractStructured,
  publishOperator,
  searchCapabilities,
  writeOperatorMirror,
  createAgentWallet,
  zodToJsonSchema,
  emit,
  tail,
  snapshot,
  tracked,
  type AppEvent,
  type DiscoveryProfile,
  type PublishResult,
  type SearchOptions,
} from "@pcc/orchestrator-sdk";
