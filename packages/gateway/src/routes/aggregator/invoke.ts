/**
 * POST /api/aggregator/invoke/:toolId — proxy an indexed-tool call + sign a receipt.
 *
 * The load-bearing route. Flow:
 *   1. Look up IndexedTool by id (404 if missing / quarantined).
 *   2. Resolve the effective DCC class via min-of-three downgrade
 *      (requested vs trust-tier ceiling vs tool assurance ceiling).
 *   3. Forward args to the upstream tool (the adapter type drives the
 *      transport — MCP uses tools/call JSON-RPC, OpenAPI uses HTTP).
 *   4. Hash request + response, build an InvocationReceipt body, sign
 *      via the receipt-signer, evaluate via @pcc/verifier evaluateReceipt.
 *   5. Persist via invocationReceipts repository.
 *   6. Return { result, receiptCID, dccClass, evaluation } to the caller.
 *
 * Phase 1 supports DCC0 / DCC1 fully. DCC2+ paths emit the receipt but
 * the upstream signature / Sigstore / TEE / zk artifacts must be supplied
 * by the caller in the request body (advanced; will be auto-fetched in
 * Phase 2). If the caller requests DCC2+ without the required artifact,
 * the effective class auto-downgrades to DCC1.
 */

import type { FastifyInstance } from "fastify";
import {
  type IndexedTool,
  type InvocationReceipt,
  DigitalCaptureClass,
  DCC_TIER,
  TIER_TO_DCC,
  TRUST_TIER_DCC_CEILING,
  TrustTier,
  applyDccDowngrade,
} from "@pcc/spec";
import { signReceipt } from "@pcc/aggregator";
import { evaluateReceipt } from "@pcc/verifier";
import { getAggregatorRegistry } from "./index.js";
import { getRepos } from "../../db.js";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

interface InvokeBody {
  /** Args forwarded to the upstream tool. Forwarded as-is. */
  args?: Record<string, unknown>;
  /** DCC class requested by the caller. Defaults to DCC1. */
  requestedDccClass?: DigitalCaptureClass;
  /** Optional caller identity hint (overridden by auth if present). */
  callerAgentId?: string;
  /** Optional session id (defaults to a synthetic one). */
  callerSessionId?: string;
  /**
   * Optional pre-computed upstream attestation artifacts. Only needed
   * for DCC2+ — Phase 1 expects the caller to supply these; Phase 2
   * fetches them automatically.
   */
  upstreamSignature?: string;
  upstreamKeyId?: string;
  sigstoreBundleRef?: string;
  teeQuote?: string;
  zkProof?: string;
}

interface InvokeResponse {
  receiptCID: InvocationReceipt["receiptCID"];
  receiptId: string;
  effectiveDccClass: DigitalCaptureClass;
  requestedDccClass: DigitalCaptureClass;
  downgraded: boolean;
  downgradeReason?: string;
  result: unknown;
  /** Verdict from evaluateReceipt(). */
  evaluation: {
    finalScore: number;
    verdict: "valid" | "invalid" | "inconclusive";
    confidence: number;
  };
}

function hashJson(value: unknown): `sha256:${string}` {
  const json = JSON.stringify(value ?? null);
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(json)))}`;
}

export async function invokeRoutes(app: FastifyInstance): Promise<void> {
  app.post<{
    Params: { toolId: string };
    Body: InvokeBody;
    Reply: InvokeResponse | { error: string; message?: string };
  }>("/api/aggregator/invoke/:toolId", async (req, reply) => {
    const registry = getAggregatorRegistry();
    const tool: IndexedTool | undefined = registry.get(req.params.toolId);
    if (!tool) {
      return reply.status(404).send({ error: "tool_not_found" });
    }
    if (tool.trustTier === TrustTier.QUARANTINED) {
      return reply.status(403).send({
        error: "tool_quarantined",
        message: `Tool ${tool.id} is QUARANTINED and cannot be invoked.`,
      });
    }

    const body = req.body ?? {};
    const requested = body.requestedDccClass ?? DigitalCaptureClass.DCC1;
    const tierCeiling = TRUST_TIER_DCC_CEILING[tool.trustTier];
    const toolCeiling = tool.assuranceCeiling;
    const downgrade = applyDccDowngrade(requested, tierCeiling, toolCeiling);
    let effective = downgrade.effective;
    let downgradeReason = downgrade.reason;

    // Phase 1 self-downgrade for DCC2+ if required artifacts missing.
    effective = autoDowngradeForMissingArtifacts(effective, body);
    if (DCC_TIER[effective] < DCC_TIER[requested] && !downgradeReason) {
      downgradeReason = `requested ${requested} downgraded to ${effective} (missing attestation artifact)`;
    } else if (
      DCC_TIER[effective] < DCC_TIER[downgrade.effective] &&
      !downgradeReason
    ) {
      downgradeReason = `requested ${requested} downgraded to ${effective} (missing attestation artifact)`;
    }

    // Phase 1: forward request via simple fetch (HTTP MCP / OpenAPI shape).
    const callerAgentId =
      ((req as unknown as { operatorId?: string }).operatorId ??
        body.callerAgentId ??
        "anonymous") as string;
    const callerSessionId = body.callerSessionId ?? `sess-${Date.now()}`;
    const args = body.args ?? {};
    const reqTimestamp = new Date().toISOString();

    let upstreamResult: unknown = null;
    let status = 0;
    try {
      const response = await fetch(tool.upstreamUrl, {
        method: tool.actionClass === "read" ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        body:
          tool.actionClass === "read" ? undefined : JSON.stringify(args),
      });
      status = response.status;
      try {
        upstreamResult = await response.json();
      } catch {
        upstreamResult = await response.text();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({
        error: "upstream_unreachable",
        message: msg,
      });
    }

    const respTimestamp = new Date().toISOString();
    const receiptBody: Omit<
      InvocationReceipt,
      "pccSignature" | "receiptCID" | "pccKeyId"
    > = {
      receiptId: `rcpt-${callerSessionId}-${Date.now()}`,
      schemaVersion: "1.0",
      indexedToolId: tool.id,
      toolCID: tool.cid,
      toolSchemaHashAtCall:
        tool.schemaHashHistory[tool.schemaHashHistory.length - 1] ?? tool.cid,
      requestProjection: {
        method: tool.actionClass === "read" ? "GET" : "POST",
        url: tool.upstreamUrl,
        headersHash: hashJson({}),
        bodyHash: hashJson(args),
        middlewareRedactions: ["authorization"],
        timestamp: reqTimestamp,
      },
      responseProjection: {
        status,
        headersHash: hashJson({}),
        bodyHash: hashJson(upstreamResult),
        middlewareRedactions: [],
        timestamp: respTimestamp,
      },
      requestedDccClass: requested,
      effectiveDccClass: effective,
      downgradeReason,
      upstreamSignature: body.upstreamSignature,
      upstreamKeyId: body.upstreamKeyId,
      sigstoreBundleRef: body.sigstoreBundleRef,
      teeQuote: body.teeQuote,
      zkProof: body.zkProof,
      callerAgentId,
      callerSessionId,
      pccFeeBps: 100,
    };

    const signed = signReceipt(receiptBody);
    const evaluation = evaluateReceipt(signed, tool);

    // Persist the receipt (best-effort; failures do NOT block the caller).
    try {
      const repos = getRepos();
      repos.invocationReceipts.insert({
        id: signed.receiptId,
        receiptCid: signed.receiptCID,
        schemaVersion: signed.schemaVersion,
        indexedToolId: signed.indexedToolId,
        toolCid: signed.toolCID,
        toolSchemaHashAtCall: signed.toolSchemaHashAtCall,
        requestedDccClass: signed.requestedDccClass,
        effectiveDccClass: signed.effectiveDccClass,
        downgradeReason: signed.downgradeReason ?? null,
        pccSignature: signed.pccSignature,
        pccKeyId: signed.pccKeyId,
        upstreamSignature: signed.upstreamSignature ?? null,
        upstreamKeyId: signed.upstreamKeyId ?? null,
        sigstoreBundleRef: signed.sigstoreBundleRef ?? null,
        teeQuote: signed.teeQuote ?? null,
        zkProof: signed.zkProof ?? null,
        callerAgentId: signed.callerAgentId,
        callerSessionId: signed.callerSessionId,
        pricePaidUsdc: signed.pricePaidUsdc ?? null,
        paymentTxHash: signed.paymentTxHash ?? null,
        pccFeeBps: signed.pccFeeBps,
        body: signed as unknown as Record<string, unknown>,
        createdAt: respTimestamp,
      });
      // Update IndexedTool liveness counters.
      tool.invocationCount = (tool.invocationCount ?? 0) + 1;
      tool.lastInvokedAt = respTimestamp;
      registry.upsert(tool);
    } catch (err) {
      // Don't fail the call just because persistence isn't available
      // (e.g. tests without a DB initialised). Log via Fastify.
      req.log?.warn?.(
        { err: err instanceof Error ? err.message : String(err) },
        "invocation_receipt_persist_failed",
      );
    }

    return reply.send({
      receiptCID: signed.receiptCID,
      receiptId: signed.receiptId,
      effectiveDccClass: effective,
      requestedDccClass: requested,
      downgraded: effective !== requested,
      downgradeReason: downgradeReason ?? undefined,
      result: upstreamResult,
      evaluation: {
        finalScore: evaluation.finalScore,
        verdict: evaluation.verdict,
        confidence: evaluation.confidence,
      },
    });
  });
}

/**
 * If the caller requested DCC2+ but didn't supply the required attestation
 * artifact (upstream signature for DCC2, Sigstore for DCC3, TEE quote for
 * DCC4, zk proof for DCC5), auto-downgrade to the highest class their
 * payload supports. Returns DCC1 if none.
 */
function autoDowngradeForMissingArtifacts(
  effective: DigitalCaptureClass,
  body: InvokeBody,
): DigitalCaptureClass {
  switch (effective) {
    case DigitalCaptureClass.DCC0:
    case DigitalCaptureClass.DCC1:
      return effective;
    case DigitalCaptureClass.DCC2:
      if (body.upstreamSignature && body.upstreamKeyId) return effective;
      return DigitalCaptureClass.DCC1;
    case DigitalCaptureClass.DCC3:
      if (body.sigstoreBundleRef && body.upstreamSignature) return effective;
      return body.upstreamSignature
        ? DigitalCaptureClass.DCC2
        : DigitalCaptureClass.DCC1;
    case DigitalCaptureClass.DCC4:
      if (body.teeQuote) return effective;
      return DigitalCaptureClass.DCC1;
    case DigitalCaptureClass.DCC5:
      if (body.zkProof) return effective;
      return DigitalCaptureClass.DCC1;
    default:
      return DigitalCaptureClass.DCC0;
  }
}

// Re-export the helper for invokeRoutes consumers if needed.
export { TIER_TO_DCC };
