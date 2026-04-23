/**
 * Capture Verification Protocol (CVP) — MCP tool definitions.
 *
 * Wave 6 Scope B. Seven tools expose the `/api/capture/*` surface of the
 * PCC gateway so any MCP-compatible client (Claude Code, Cursor, Goose,
 * ChatGPT Apps) can drive the full CC0..CC5 capture lifecycle:
 *
 *   1. pcc_capture_challenge        — POST /api/capture/challenge
 *   2. pcc_capture_upload           — POST /api/capture/upload
 *   3. pcc_capture_anchor           — POST /api/capture/anchor
 *   4. pcc_capture_status           — GET  /api/capture/status/:verdictId
 *   5. pcc_list_verdicts            — GET  /api/capture/verdicts
 *   6. pcc_capture_class_registry   — GET  /api/capture/registry/:captureHash
 *   7. pcc_verifier_health          — GET  /api/capture/verifier-health
 *
 * Each tool is registered on the shared `McpServer` via `registerCaptureTools`.
 * We deliberately avoid re-implementing `server.tool()` — index.ts keeps that
 * pattern for every other tool group and we stay consistent. The exported
 * `CAPTURE_TOOL_NAMES` array is the stable public contract used by the
 * capture-tools.test.ts registry snapshot.
 *
 * Inputs are validated twice:
 *   - Zod shape declared here so the SDK generates JSON Schema for clients.
 *   - Gateway re-validates server-side (CaptureManifestSchema, etc.) — this
 *     tool layer is thin and never trusts the client.
 *
 * Source: ai/supervisor/wave6-scope-b.md §Part 2.
 *
 * Author: mcp-oscar (Wave 6 Scope B)
 */

import { z } from "zod";
import { CaptureManifestSchema } from "@pcc/spec";
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

export const CAPTURE_TOOL_NAMES = [
  "pcc_capture_challenge",
  "pcc_capture_upload",
  "pcc_capture_anchor",
  "pcc_capture_status",
  "pcc_list_verdicts",
  "pcc_capture_class_registry",
  "pcc_verifier_health",
] as const;

export type CaptureToolName = (typeof CAPTURE_TOOL_NAMES)[number];

// ---------------------------------------------------------------------------
// Per-tool endpoint metadata (exported for tests — one place to verify URL
// mapping without importing every tool handler).
// ---------------------------------------------------------------------------

export interface CaptureToolEndpoint {
  readonly name: CaptureToolName;
  readonly method: "GET" | "POST";
  readonly pathTemplate: string;
}

export const CAPTURE_TOOL_ENDPOINTS: readonly CaptureToolEndpoint[] = [
  { name: "pcc_capture_challenge", method: "POST", pathTemplate: "/api/capture/challenge" },
  { name: "pcc_capture_upload", method: "POST", pathTemplate: "/api/capture/upload" },
  { name: "pcc_capture_anchor", method: "POST", pathTemplate: "/api/capture/anchor" },
  { name: "pcc_capture_status", method: "GET", pathTemplate: "/api/capture/status/:verdictId" },
  { name: "pcc_list_verdicts", method: "GET", pathTemplate: "/api/capture/verdicts" },
  {
    name: "pcc_capture_class_registry",
    method: "GET",
    pathTemplate: "/api/capture/registry/:captureHash",
  },
  { name: "pcc_verifier_health", method: "GET", pathTemplate: "/api/capture/verifier-health" },
] as const;

// ---------------------------------------------------------------------------
// Reusable Zod primitives
// ---------------------------------------------------------------------------

const DeclaredClassEnum = z.enum(["CC0", "CC1", "CC2", "CC3", "CC4", "CC5"]);
const VerdictIdSchema = z.string().uuid().describe("Capture verdict UUID");

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Wire all seven capture tools onto the shared MCP server instance. Called
 * once from packages/mcp-server/src/index.ts after the other tool groups are
 * registered. Kept isolated so a future `captureTools` split-out is a rename,
 * not a rewrite.
 */
export function registerCaptureTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // 1. pcc_capture_challenge — issue a block-anchored nonce
  // -------------------------------------------------------------------------

  server.tool(
    "pcc_capture_challenge",
    "Issue a fresh block-anchored CaptureNonceChallenge for a job. The operator's device must render this nonce into the captured media (QR code, audio tone, etc.) before calling pcc_capture_upload. The nonce is derived from (challengeId, latest blockHash, workOutputRoot) so captures cannot be pre-computed. Returns challengeId, 64-char hex nonce, blockNumber, maxAgeSeconds (clamped to 120).",
    {
      jobId: z.string().min(1).describe("PCC job ID the capture belongs to"),
      declaredClass: DeclaredClassEnum.describe(
        "Capture class the operator plans to claim (CC0..CC5). Determines which gates the verifier will run.",
      ),
      requestedTtlSeconds: z
        .number()
        .int()
        .positive()
        .max(120)
        .optional()
        .describe("Requested challenge lifetime. Clamped to 120 server-side."),
    },
    async ({
      jobId,
      declaredClass,
      requestedTtlSeconds,
    }: {
      jobId: string;
      declaredClass: z.infer<typeof DeclaredClassEnum>;
      requestedTtlSeconds?: number;
    }) => {
      const data = await pccFetch("/api/capture/challenge", {
        method: "POST",
        body: { jobId, declaredClass, requestedTtlSeconds },
      });
      return toolResult(data);
    },
  );

  // -------------------------------------------------------------------------
  // 2. pcc_capture_upload — submit manifest + capture bytes for verification
  // -------------------------------------------------------------------------

  server.tool(
    "pcc_capture_upload",
    "Upload a capture (photo / video / audio / sensor clip) with its CaptureManifest for G1..G6 verification. Bytes are base64-encoded inline; optional base64 C2PA manifest bytes can be supplied for CC3+ claims. The server runs the 6-gate CaptureVerifier and persists a PASS/PARTIAL/FAIL verdict. Returns {verdictId, verdict, verifiedClass, gatesPassed, gatesFailed, warnings, anchorCandidate}.",
    {
      manifest: CaptureManifestSchema.describe(
        "CaptureManifest — ALCOA+-ready metadata including class, declaredAt, deviceFingerprint, mediaHash, optional challengeId.",
      ),
      captureBytesBase64: z
        .string()
        .min(1)
        .describe("Base64-encoded capture bytes (image / video / audio / sensor clip)."),
      c2paManifestBytes: z
        .string()
        .optional()
        .describe(
          "Optional base64-encoded C2PA manifest JUMBF bytes. Required for CC3+ if manifest.class >= CC3.",
        ),
      jobId: z
        .string()
        .optional()
        .describe("Job ID for telemetry binding. Falls back to manifest.jobId if omitted."),
      operatorId: z
        .string()
        .optional()
        .describe("Explicit operator ID. Falls back to authenticated session userId."),
      challengeId: z
        .string()
        .uuid()
        .optional()
        .describe("Challenge UUID to re-bind from the in-memory challenge cache."),
    },
    async (args: {
      manifest: z.infer<typeof CaptureManifestSchema>;
      captureBytesBase64: string;
      c2paManifestBytes?: string;
      jobId?: string;
      operatorId?: string;
      challengeId?: string;
    }) => {
      const data = await pccFetch("/api/capture/upload", {
        method: "POST",
        body: args,
      });
      return toolResult(data);
    },
  );

  // -------------------------------------------------------------------------
  // 3. pcc_capture_anchor — submit PASS verdict on-chain
  // -------------------------------------------------------------------------

  server.tool(
    "pcc_capture_anchor",
    "Anchor a PASS + anchor-candidate capture verdict to CaptureClassRegistry on-chain (Base Sepolia by default). Rejects FAIL/PARTIAL verdicts. Idempotent — re-submitting the same verdictId returns the existing anchor row. Returns 202 {status:'deferred'} if CaptureClassRegistry is not yet deployed (CAPTURE_REGISTRY_ADDRESS unset).",
    {
      verdictId: VerdictIdSchema.describe(
        "The verdictId returned by pcc_capture_upload. Must be PASS + anchorCandidate=true.",
      ),
    },
    async ({ verdictId }: { verdictId: string }) => {
      const data = await pccFetch("/api/capture/anchor", {
        method: "POST",
        body: { verdictId },
      });
      return toolResult(data);
    },
  );

  // -------------------------------------------------------------------------
  // 4. pcc_capture_status — verdict + on-chain anchor combined view
  // -------------------------------------------------------------------------

  server.tool(
    "pcc_capture_status",
    "Fetch the combined verdict + on-chain anchor view for a single capture. Mirrors the underlying DB shape returned by the verifier plus the anchor tx metadata (txHash, blockNumber, gasUsed, explorerUrl). Anchor is null if the verdict was never anchored.",
    {
      verdictId: VerdictIdSchema,
    },
    async ({ verdictId }: { verdictId: string }) => {
      const data = await pccFetch(
        `/api/capture/status/${encodeURIComponent(verdictId)}`,
      );
      return toolResult(data);
    },
  );

  // -------------------------------------------------------------------------
  // 5. pcc_list_verdicts — paginated recent verdicts
  // -------------------------------------------------------------------------

  server.tool(
    "pcc_list_verdicts",
    "List recent capture verdicts, newest first. Optionally filter by jobId. Default limit is 50, capped at 200 server-side. Returns {verdicts, count, limit, jobId}.",
    {
      jobId: z
        .string()
        .optional()
        .describe("Filter by job ID. Omit for all verdicts across jobs."),
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .describe("Maximum rows returned (default 50, hard cap 200)."),
    },
    async ({ jobId, limit }: { jobId?: string; limit?: number }) => {
      const data = await pccFetch("/api/capture/verdicts", {
        query: {
          jobId,
          limit: limit === undefined ? undefined : String(limit),
        },
      });
      return toolResult(data);
    },
  );

  // -------------------------------------------------------------------------
  // 6. pcc_capture_class_registry — on-chain anchor lookup by captureHash
  // -------------------------------------------------------------------------

  server.tool(
    "pcc_capture_class_registry",
    "Look up a capture's on-chain anchor record in CaptureClassRegistry by its 32-byte captureHash. Returns the registry address, captureHash, and the decoded anchor tuple (declaredClass, verifiedClass, manifestHash, submittedBy, jobId, challengeId, blockAnchor, capturedAt, attestationsRoot, attesterCount). onchain is null if the capture was never anchored. Returns 202 deferred when CaptureClassRegistry is not yet deployed.",
    {
      captureHash: z
        .string()
        .min(1)
        .describe(
          "Capture hash (32-byte). Accepts 0x-prefixed or unprefixed hex, or sha256:... format. Padded server-side to bytes32.",
        ),
    },
    async ({ captureHash }: { captureHash: string }) => {
      const data = await pccFetch(
        `/api/capture/registry/${encodeURIComponent(captureHash)}`,
      );
      return toolResult(data);
    },
  );

  // -------------------------------------------------------------------------
  // 7. pcc_verifier_health — adapter load + staleness
  // -------------------------------------------------------------------------

  server.tool(
    "pcc_verifier_health",
    "Report CaptureVerifier health: which adapters are loaded (c2pa, webauthn, appattest, playintegrity), their staleness status, in-memory challenge cache size, whether CaptureClassRegistry is deployed, and the active PCC_NETWORK. Use this to diagnose why a capture class is being rejected or degraded.",
    {},
    async () => {
      const data = await pccFetch("/api/capture/verifier-health");
      return toolResult(data);
    },
  );
}
