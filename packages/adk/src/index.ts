/**
 * @pcc/adk — the PCC Agent Development Kit (working name; ledger R4).
 *
 * One public package for building, publishing and running capabilities on
 * PCC. It depends only on the public @pcc/spec and @pcc/kernel-sdk, and it
 * installs in a project outside this workspace (scripts/clean-install-check.mjs).
 *
 * Public surface today:
 *   - everything @pcc/kernel-sdk exports (the digital-kernel backend, R2);
 *   - the pinned agent package: AGENT_PACKAGE_PIN, AGENT_TOOLS,
 *     resolveToolRequest (tool call -> gateway request, pure),
 *     checkAgentPackage (live package vs the pin).
 *
 * Coming, per the reconciliation note (returns/pcc-adk.md, D1-D6): the
 * provenance planner re-export (D2), the CapabilityProject driver (D4) and
 * economics helpers (D6).
 */

export * from "@pcc/kernel-sdk";

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

// Digital-kernel scaffold (D3, ledger R4): generates a project outside the
// monorepo that depends only on the public @pcc/kernel-sdk + @pcc/spec.
export { ScaffoldRefused, scaffoldDigitalKernel } from "./scaffold/digital-kernel.js";
export type { DigitalKernelScaffoldOptions, RecordedSearch } from "./scaffold/digital-kernel.js";
