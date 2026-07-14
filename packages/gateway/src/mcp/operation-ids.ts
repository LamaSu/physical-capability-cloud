/**
 * Canonical registered typed-operation ids (R4 PR2) — a DEPENDENCY-FREE module.
 *
 * The MCP-App view boot script injects this list onto the window as the
 * client-side allowlist (window.__PCC_HOST_OPERATIONS__). Keeping it here, with
 * ZERO imports, lets the browser-view module (mcp-app-view.ts) reference it
 * WITHOUT pulling the heavy operation-policy → facade → kernel-adapter graph into
 * the view code (which also breaks jsdom view tests).
 *
 * operation-policy.ts imports this list and registers EXACTLY these ids; a
 * load-time guard there throws on any drift, so this stays the single source of
 * truth and the live registry can never disagree with the injected allowlist.
 */
export const REGISTERED_OPERATION_IDS = [
  "capability.request_quote",
  "job.cancel",
] as const;

export type RegisteredOperationId = (typeof REGISTERED_OPERATION_IDS)[number];
