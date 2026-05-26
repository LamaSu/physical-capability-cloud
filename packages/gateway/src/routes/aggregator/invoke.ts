/**
 * POST /api/aggregator/invoke/:toolId — proxy an indexed-tool call + sign a receipt.
 *
 * The load-bearing route. Flow:
 *   1. Look up IndexedTool by id (404 if missing / quarantined).
 *   2. Resolve the effective DCC class via min-of-three downgrade
 *      (requested vs trust-tier ceiling vs tool assurance ceiling).
 *   3. **x402 payment gate**: if tool has `pricing.perCallUsdc > 0` AND
 *      gate is enabled, require a verified PAYMENT-SIGNATURE header.
 *      Returns 402 with PAYMENT-REQUIRED if absent / invalid.
 *   4. Forward args to the upstream tool (the adapter type drives the
 *      transport — MCP uses tools/call JSON-RPC, OpenAPI uses HTTP).
 *   5. **Settle the payment** AFTER upstream returns 2xx (scope §3.3
 *      option B). Settle failure → 502, response dropped.
 *   6. Hash request + response, build an InvocationReceipt body (with
 *      `pricePaidUsdc` + `paymentTxHash` populated), sign via the
 *      receipt-signer, evaluate via @pcc/verifier evaluateReceipt.
 *   7. Persist via invocationReceipts repository.
 *   8. Return { result, receiptCID, dccClass, evaluation, payment? }.
 *
 * Phase 1 supports DCC0 / DCC1 fully. DCC2+ paths emit the receipt but
 * the upstream signature / Sigstore / TEE / zk artifacts must be supplied
 * by the caller in the request body (advanced; will be auto-fetched in
 * Phase 2). If the caller requests DCC2+ without the required artifact,
 * the effective class auto-downgrades to DCC1.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  type IndexedTool,
  type InvocationReceipt,
  type X402PaymentRequired,
  type X402PaymentPayload,
  DigitalCaptureClass,
  DCC_TIER,
  TIER_TO_DCC,
  TRUST_TIER_DCC_CEILING,
  TrustTier,
  applyDccDowngrade,
} from "@pcc/spec";
import {
  signReceipt,
  requirePayment,
  recordSettlement,
  type GateVerdict,
} from "@pcc/aggregator";
import { evaluateReceipt } from "@pcc/verifier";
import { getAggregatorRegistry, getX402GateConfig } from "./index.js";
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

/** Payment summary returned to the caller on a paid invocation. */
interface InvokePayment {
  txHash: string;
  network: string;
  pricePaidUsdc: string;
  payer: string;
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
  /** Present when the call was x402-billed. */
  payment?: InvokePayment;
}

function hashJson(value: unknown): `sha256:${string}` {
  const json = JSON.stringify(value ?? null);
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(json)))}`;
}

function extractPaymentSignatureHeader(req: FastifyRequest): string | undefined {
  // Header lookup is case-insensitive in Fastify, but x402 v2 specifies
  // PAYMENT-SIGNATURE exactly. Accept either casing.
  const h = req.headers["payment-signature"];
  if (typeof h === "string" && h.length > 0) return h;
  if (Array.isArray(h) && h[0]) return h[0];
  return undefined;
}

export async function invokeRoutes(app: FastifyInstance): Promise<void> {
  app.post<{
    Params: { toolId: string };
    Body: InvokeBody;
    Reply: InvokeResponse | { error: string; message?: string } | X402PaymentRequired;
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

    // ---- x402 payment gate ------------------------------------------------
    let gateVerdict: GateVerdict = { kind: "free" };
    const gateConfig = getX402GateConfig();
    if (gateConfig) {
      gateVerdict = await requirePayment(
        tool,
        {
          paymentSignatureHeader: extractPaymentSignatureHeader(req),
          resourceUrl: req.url,
        },
        gateConfig,
      );
    }
    if (gateVerdict.kind === "challenge") {
      for (const [k, v] of Object.entries(gateVerdict.headers)) {
        reply.header(k, v);
      }
      return reply.status(gateVerdict.status).send(gateVerdict.body);
    }
    if (gateVerdict.kind === "facilitator_unavailable") {
      return reply.status(gateVerdict.status).send({
        error: "facilitator_unavailable",
        message: gateVerdict.reason,
      });
    }
    // gateVerdict.kind is "free" or "verified" from here on.

    // ---- Replay short-circuit --------------------------------------------
    if (gateVerdict.kind === "verified" && gateVerdict.replayedCID) {
      // Caller submitted a previously-settled PAYMENT-SIGNATURE. Return the
      // prior receipt without re-calling upstream or facilitator.
      const replayedCid = gateVerdict.replayedCID;
      try {
        const repos = getRepos();
        const row = repos.invocationReceipts.findByCid(replayedCid);
        if (row) {
          const prior = row.body as unknown as InvocationReceipt;
          return reply.send({
            receiptCID: prior.receiptCID,
            receiptId: prior.receiptId,
            effectiveDccClass: prior.effectiveDccClass,
            requestedDccClass: prior.requestedDccClass,
            downgraded: prior.effectiveDccClass !== prior.requestedDccClass,
            downgradeReason: prior.downgradeReason ?? undefined,
            result: null,
            evaluation: {
              finalScore: 0,
              verdict: "valid",
              confidence: 1,
            },
            payment: prior.paymentTxHash
              ? {
                  txHash: prior.paymentTxHash,
                  network: gateConfig?.network ?? "",
                  pricePaidUsdc: prior.pricePaidUsdc ?? "0",
                  payer: gateVerdict.paymentPayload.payload.authorization.from,
                }
              : undefined,
          });
        }
      } catch {
        // Fall through — if we can't find the prior receipt, proceed as
        // a fresh call (the nonce cache and on-chain nonce will keep us
        // from double-settling).
      }
    }

    // ---- Forward to upstream ---------------------------------------------
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

    // Upstream returned 5xx: do NOT settle (we don't broadcast the
    // EIP-3009 authorization for a failed upstream call). Bubble the
    // failure to the caller; their signed payload is unused.
    if (status >= 500 && gateVerdict.kind === "verified") {
      return reply.status(502).send({
        error: "upstream_error",
        message: `upstream returned ${status}; payment NOT settled`,
      });
    }

    // ---- Settle the payment (only after upstream success) ----------------
    let paymentSummary: InvokePayment | undefined;
    let priceForReceipt: string | undefined;
    let txHashForReceipt: string | undefined;
    let paymentPayloadForCache: X402PaymentPayload | undefined;
    if (gateVerdict.kind === "verified") {
      paymentPayloadForCache = gateVerdict.paymentPayload;
      const settleResult = await gateVerdict.settle();
      if (!settleResult.ok) {
        // Discard the upstream response and surface the settle failure.
        return reply.status(settleResult.status).send({
          error:
            settleResult.status === 502
              ? "settlement_failed"
              : "facilitator_unavailable",
          message: settleResult.reason,
        });
      }
      paymentSummary = {
        txHash: settleResult.txHash,
        network: settleResult.network,
        pricePaidUsdc: settleResult.pricePaidUsdc,
        payer: settleResult.payer,
      };
      priceForReceipt = settleResult.pricePaidUsdc;
      txHashForReceipt = settleResult.txHash;
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
        headersHash: hashJson(
          paymentPayloadForCache ? { "payment-signature": "[redacted]" } : {},
        ),
        bodyHash: hashJson(args),
        middlewareRedactions: paymentPayloadForCache
          ? ["authorization", "payment-signature"]
          : ["authorization"],
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
      pricePaidUsdc: priceForReceipt,
      paymentTxHash: txHashForReceipt,
      pccFeeBps: 100,
    };

    const signed = signReceipt(receiptBody);
    const evaluation = evaluateReceipt(signed, tool);

    // Record settlement for idempotent replay BEFORE persistence — if the
    // DB write fails, the cache entry still protects against duplicate
    // settle on retry.
    if (paymentPayloadForCache && gateConfig) {
      recordSettlement(paymentPayloadForCache, signed.receiptCID, gateConfig);
    }

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
      ...(paymentSummary ? { payment: paymentSummary } : {}),
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
