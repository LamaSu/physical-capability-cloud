/**
 * @pcc/adk — the PCC Agent Development Kit (working name; ledger R4).
 *
 * One public package for building, publishing and running capabilities on
 * PCC. It depends only on the public @pcc/spec and @pcc/kernel-sdk, and it
 * installs in a project outside this workspace (scripts/clean-install-check.mjs).
 *
 * Public surface today, as an explicit list (verdict 101): a new export is a
 * reviewed change, and src/__tests__/verdict-101.test.ts pins the list.
 *   - buildManifest from @pcc/kernel-sdk (a pure manifest builder);
 *   - the pinned agent package: AGENT_PACKAGE_PIN, AGENT_TOOLS,
 *     resolveToolRequest (tool call -> gateway request, pure),
 *     checkAgentPackage (live package vs the pin).
 *
 * Not re-exported: @pcc/kernel-sdk's registration client and job handler.
 * The kit offers neither until it has versions bound to a trusted gateway
 * origin and to an authority-issued, job-bound delegation.
 *
 * Coming, per the reconciliation note (returns/pcc-adk.md, D1-D6): the
 * provenance planner re-export (D2), the CapabilityProject driver (D4) and
 * economics helpers (D6).
 */

export { buildManifest } from "@pcc/kernel-sdk";
export type { ManifestBuilderInput } from "@pcc/kernel-sdk";

export {
  AGENT_PACKAGE_PIN,
  AGENT_TOOLS,
  AdkToolError,
  checkAgentPackage,
  resolveToolRequest,
} from "./agent-package.js";
export type {
  AdkToolErrorCode,
  AgentPackageCheck,
  AgentToolEndpoint,
  AgentToolName,
  ToolRequest,
} from "./agent-package.js";
