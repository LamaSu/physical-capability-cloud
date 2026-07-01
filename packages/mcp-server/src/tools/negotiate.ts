/**
 * Negotiation Session — MCP tool definitions.
 *
 * Exposes the gateway's structured pre-commit negotiation protocol so any
 * MCP-compatible client (Claude Desktop, Claude Code, Cursor, Goose, ChatGPT
 * Apps) can drive a capability deal end-to-end without touching raw HTTP.
 *
 * State machine (the gateway enforces it; these tools are a thin transport):
 *
 *   CREATED ──select──▶ CONFIGURING ──quote──▶ QUOTED ──review──▶ REVIEWING ──commit──▶ COMMITTED
 *      │                                                                                    │
 *      └────────────────────────────── cancel (any non-committed) ─────────────────────────┘
 *
 *   1. pcc_negotiate_create  — POST   /api/negotiate/session
 *   2. pcc_negotiate_get     — GET    /api/negotiate/session/:id
 *   3. pcc_negotiate_select  — PATCH  /api/negotiate/session/:id/select
 *   4. pcc_negotiate_quote   — POST   /api/negotiate/session/:id/quote
 *   5. pcc_negotiate_review  — POST   /api/negotiate/session/:id/review
 *   6. pcc_negotiate_commit  — POST   /api/negotiate/session/:id/commit
 *   7. pcc_negotiate_cancel  — DELETE /api/negotiate/session/:id
 *
 * Registered out-of-line (like tools/capture.ts) to keep index.ts slim. The
 * exported NEGOTIATE_TOOL_NAMES / NEGOTIATE_TOOL_ENDPOINTS are the stable
 * public contract used by negotiate-tools.test.ts.
 *
 * Inputs are validated twice — Zod here (so the SDK emits JSON Schema for
 * clients) and again server-side by the gateway. This layer never trusts the
 * client and holds no session state.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pccFetch } from "../api.js";

// ---------------------------------------------------------------------------
// Shared result helper
// ---------------------------------------------------------------------------

function toolResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// Stable tool-name list (consumed by tests + any static introspection)
// ---------------------------------------------------------------------------

export const NEGOTIATE_TOOL_NAMES = [
  "pcc_negotiate_create",
  "pcc_negotiate_get",
  "pcc_negotiate_select",
  "pcc_negotiate_quote",
  "pcc_negotiate_review",
  "pcc_negotiate_commit",
  "pcc_negotiate_cancel",
] as const;

export type NegotiateToolName = (typeof NEGOTIATE_TOOL_NAMES)[number];

// ---------------------------------------------------------------------------
// Per-tool endpoint metadata (exported for tests — one place to verify the
// URL + method mapping without importing every handler).
// ---------------------------------------------------------------------------

export interface NegotiateToolEndpoint {
  readonly name: NegotiateToolName;
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly pathTemplate: string;
}

export const NEGOTIATE_TOOL_ENDPOINTS: readonly NegotiateToolEndpoint[] = [
  { name: "pcc_negotiate_create", method: "POST", pathTemplate: "/api/negotiate/session" },
  { name: "pcc_negotiate_get", method: "GET", pathTemplate: "/api/negotiate/session/:id" },
  { name: "pcc_negotiate_select", method: "PATCH", pathTemplate: "/api/negotiate/session/:id/select" },
  { name: "pcc_negotiate_quote", method: "POST", pathTemplate: "/api/negotiate/session/:id/quote" },
  { name: "pcc_negotiate_review", method: "POST", pathTemplate: "/api/negotiate/session/:id/review" },
  { name: "pcc_negotiate_commit", method: "POST", pathTemplate: "/api/negotiate/session/:id/commit" },
  { name: "pcc_negotiate_cancel", method: "DELETE", pathTemplate: "/api/negotiate/session/:id" },
] as const;

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Wire all seven negotiation tools onto the shared MCP server instance. Called
 * once from packages/mcp-server/src/index.ts after the other tool groups are
 * registered.
 */
export function registerNegotiateTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // 1. pcc_negotiate_create — open a session
  // -------------------------------------------------------------------------

  server.tool(
    "pcc_negotiate_create",
    "Open a negotiation session between a user agent and an operator's Shop Kernel for one capability type. Snapshots the operator's constraints, issues a replay-resistant workflow challenge, and returns the session (status='created'), resolved parameter options, and a template summary. This is step 1 of the create → select → quote → review → commit lifecycle. Requires PCC_API_KEY for authenticated kernels.",
    {
      userAgentId: z.string().describe("The buyer/user agent identifier opening the session"),
      kernelId: z.string().describe("Target Shop Kernel ID (the operator/site)"),
      capabilityType: z
        .string()
        .describe("Capability type to negotiate (e.g. 'fdm-printer', 'cnc-3axis', 'hplc')"),
      capabilityId: z
        .string()
        .optional()
        .describe("Optional specific capability instance ID to bind the session to"),
      network: z
        .string()
        .optional()
        .describe("Optional settlement network override (e.g. 'base-sepolia')"),
      initialSelections: z
        .record(z.unknown())
        .optional()
        .describe("Optional initial parameter selections (e.g. {material:'PLA', quantity:1})"),
    },
    async ({
      userAgentId,
      kernelId,
      capabilityType,
      capabilityId,
      network,
      initialSelections,
    }: {
      userAgentId: string;
      kernelId: string;
      capabilityType: string;
      capabilityId?: string;
      network?: string;
      initialSelections?: Record<string, unknown>;
    }) => {
      const data = await pccFetch("/api/negotiate/session", {
        method: "POST",
        body: { userAgentId, kernelId, capabilityType, capabilityId, network, initialSelections },
      });
      return toolResult(data);
    },
  );

  // -------------------------------------------------------------------------
  // 2. pcc_negotiate_get — read session state
  // -------------------------------------------------------------------------

  server.tool(
    "pcc_negotiate_get",
    "Get the current state of a negotiation session: status, parameter selections, operator constraint snapshot, quote (if computed), contract terms (if reviewed), transition history, and freshly resolved options. Returns 404 if unknown, 410 if expired (sessions auto-expire after 30 minutes).",
    {
      sessionId: z.string().describe("The session ID returned by pcc_negotiate_create (sess-...)"),
    },
    async ({ sessionId }: { sessionId: string }) => {
      const data = await pccFetch(`/api/negotiate/session/${encodeURIComponent(sessionId)}`);
      return toolResult(data);
    },
  );

  // -------------------------------------------------------------------------
  // 3. pcc_negotiate_select — set parameter selections
  // -------------------------------------------------------------------------

  server.tool(
    "pcc_negotiate_select",
    "Set or update parameter selections for a session (merged into existing selections, free-text sanitized server-side). Moves the session to 'configuring' and returns the merged selections plus newly resolved options. Rejected (409) once committed, (410) once expired/cancelled. Step 2 of the lifecycle.",
    {
      sessionId: z.string().describe("The session ID (sess-...)"),
      selections: z
        .record(z.unknown())
        .describe("Parameter selections to merge, e.g. {material:'PLA', infill:20, quantity:2}"),
    },
    async ({ sessionId, selections }: { sessionId: string; selections: Record<string, unknown> }) => {
      const data = await pccFetch(
        `/api/negotiate/session/${encodeURIComponent(sessionId)}/select`,
        { method: "PATCH", body: { selections } },
      );
      return toolResult(data);
    },
  );

  // -------------------------------------------------------------------------
  // 4. pcc_negotiate_quote — lock params, compute price
  // -------------------------------------------------------------------------

  server.tool(
    "pcc_negotiate_quote",
    "Compute a binding quote for the session's current selections: base price, operator pricing-rule adjustments, total price, currency, bond amount, challenge-window seconds, and validity window. Moves the session to 'quoted'. Step 3 of the lifecycle.",
    {
      sessionId: z.string().describe("The session ID (sess-...)"),
    },
    async ({ sessionId }: { sessionId: string }) => {
      const data = await pccFetch(
        `/api/negotiate/session/${encodeURIComponent(sessionId)}/quote`,
        { method: "POST", body: {} },
      );
      return toolResult(data);
    },
  );

  // -------------------------------------------------------------------------
  // 5. pcc_negotiate_review — generate contract terms
  // -------------------------------------------------------------------------

  server.tool(
    "pcc_negotiate_review",
    "Generate the on-chain-ready contract terms from the computed quote: milestones (amount, bond, challenge window), deadline, assurance tier, payer/operator/token addresses. Moves the session to 'reviewing'. Requires a quote first (400 otherwise). Step 4 of the lifecycle — review these terms before committing.",
    {
      sessionId: z.string().describe("The session ID (sess-...)"),
    },
    async ({ sessionId }: { sessionId: string }) => {
      const data = await pccFetch(
        `/api/negotiate/session/${encodeURIComponent(sessionId)}/review`,
        { method: "POST", body: {} },
      );
      return toolResult(data);
    },
  );

  // -------------------------------------------------------------------------
  // 6. pcc_negotiate_commit — lock in, create job + escrow
  // -------------------------------------------------------------------------

  server.tool(
    "pcc_negotiate_commit",
    "Commit the session: freeze it as immutable and create the downstream job, execution scope, and milestone escrow. Returns the committed session plus jobId, cwmId, scopeId, escrowId, escrowAddress, and escrowStatus. Requires reviewed contract terms first (400 otherwise); rejected (409) if already committed. Step 5 (final) of the lifecycle.",
    {
      sessionId: z.string().describe("The session ID (sess-...)"),
    },
    async ({ sessionId }: { sessionId: string }) => {
      const data = await pccFetch(
        `/api/negotiate/session/${encodeURIComponent(sessionId)}/commit`,
        { method: "POST", body: {} },
      );
      return toolResult(data);
    },
  );

  // -------------------------------------------------------------------------
  // 7. pcc_negotiate_cancel — abandon a session
  // -------------------------------------------------------------------------

  server.tool(
    "pcc_negotiate_cancel",
    "Cancel a negotiation session before commit. Records a 'cancelled' transition and returns {cancelled:true, sessionId}. Rejected (409) once the session is committed — committed sessions are immutable.",
    {
      sessionId: z.string().describe("The session ID (sess-...)"),
    },
    async ({ sessionId }: { sessionId: string }) => {
      const data = await pccFetch(`/api/negotiate/session/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
      return toolResult(data);
    },
  );
}
