/**
 * Per-tool x402 payment gate for `POST /api/aggregator/invoke/:toolId`.
 *
 * The route handler calls `requirePayment(tool, ctx)` BEFORE forwarding to
 * upstream. The result is one of three things:
 *
 *   1. `{ kind: "free" }` — tool has no `pricing.perCallUsdc > 0`. Skip the
 *      gate entirely; route does its existing free-path logic.
 *
 *   2. `{ kind: "challenge", status: 402, body, headers }` — caller did not
 *      provide PAYMENT-SIGNATURE (or the one they provided is malformed /
 *      tampered / unverifiable). Route returns the 402 response as-is.
 *
 *   3. `{ kind: "verified", paymentPayload, paymentRequirements, settle, replayedCID? }`
 *      — caller's payment verified at the facilitator. Route forwards to
 *      upstream, then calls `settle()` AFTER a 2xx response. `settle()`
 *      itself returns either `{ ok: true, txHash, pricePaidUsdc }` or
 *      `{ ok: false, reason }`. Receipt fields are populated from the
 *      settle result.
 *
 *      If `replayedCID` is present, this is an idempotent replay of a
 *      previously-settled invocation — caller should look up that CID and
 *      return it without re-calling upstream or settle.
 *
 * Settle timing is "after upstream success" per scope §3.3 option B: the
 * caller authorized a 300s window, gateway holds the signed payload between
 * verify and settle, and if upstream returns 5xx the gateway simply doesn't
 * settle (no refund flow needed).
 *
 * Side effects: only the nonce cache write on successful settle. Errors are
 * surfaced as typed verdicts to the route handler — no logging here.
 */

import { z } from "zod";
import type {
  IndexedTool,
  X402PaymentRequired,
  X402PaymentRequirements,
  X402PaymentPayload,
  X402SettlementResponse,
  Address,
} from "@pcc/spec";
import {
  isPaidPrice,
  toAtomicUsdc,
  decimalUsdc,
  priceTagHmac,
  verifyPriceTag,
  type PriceTagFields,
} from "./pricing.js";
import {
  verifyWithFacilitator,
  settleWithFacilitator,
  FacilitatorNetworkError,
  type X402FacilitatorConfig,
} from "./x402-facilitator.js";
import { NonceCache } from "./x402-nonce-cache.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Long-lived configuration constructed once at gateway boot. */
export interface X402GateConfig {
  /** Whether the gate is wired in at all (`PCC_X402_ENABLED`). Default false. */
  enabled: boolean;
  /** CAIP-2 network we settle on, e.g. "eip155:84532" (Base Sepolia). */
  network: string;
  /** USDC contract address on `network`. */
  usdcAddress: Address;
  /** PCC treasury address that receives all per-call fees. */
  payTo: Address;
  /** Default `maxTimeoutSeconds` in 402 responses (and price-tag validUntil). */
  maxTimeoutSeconds: number;
  /** Per-environment facilitator. */
  facilitator: X402FacilitatorConfig;
  /** Hex secret used for price-tag HMAC (`PCC_X402_HMAC_KEY` or `PCC_AGGREGATOR_HMAC_KEY`). */
  hmacSecretHex: string;
  /** In-process nonce-replay cache. */
  nonceCache?: NonceCache;
  /** Optional clock for tests (defaults to Date.now). */
  now?: () => number;
}

/** Caller view of one invocation attempt. */
export interface GateRequestContext {
  /** Raw PAYMENT-SIGNATURE header value (base64 JSON), if present. */
  paymentSignatureHeader?: string;
  /** Request URL/path, used for resource.url in the 402 body. */
  resourceUrl: string;
}

/** Result of `requirePayment`. */
export type GateVerdict =
  | { kind: "free" }
  | {
      kind: "challenge";
      status: 402;
      body: X402PaymentRequired;
      /** Headers the route should set on the 402 response. */
      headers: Record<string, string>;
    }
  | {
      kind: "verified";
      paymentPayload: X402PaymentPayload;
      paymentRequirements: X402PaymentRequirements;
      /**
       * Settle this invocation AFTER the upstream call returns 2xx.
       * MUST be awaited; settle failure means the route should return
       * 502 and discard the upstream response.
       */
      settle: () => Promise<SettleOutcome>;
      /**
       * If set, this is an idempotent replay of a previously-settled
       * invocation. Route should look up the CID and return it without
       * re-calling upstream or settle.
       */
      replayedCID?: string;
    }
  | {
      kind: "facilitator_unavailable";
      status: 503;
      reason: string;
    };

/** Result of calling the verified verdict's `settle()`. */
export type SettleOutcome =
  | {
      ok: true;
      /** `paymentTxHash` for the InvocationReceipt. */
      txHash: string;
      /** `pricePaidUsdc` for the InvocationReceipt (decimal string). */
      pricePaidUsdc: string;
      /** The on-chain network the tx was broadcast on. */
      network: string;
      /** Payer address (caller wallet). */
      payer: Address;
      /** Settle response for downstream PAYMENT-RESPONSE header if desired. */
      response: X402SettlementResponse;
    }
  | {
      ok: false;
      /** Either a typed facilitator errorReason or "facilitator_unavailable". */
      reason: string;
      /** "settle_failed" → return 502; "facilitator_unavailable" → 503. */
      status: 502 | 503;
    };

// ---------------------------------------------------------------------------
// Zod schemas (kept narrow — protocol shape only, not amount semantics)
// ---------------------------------------------------------------------------

const X402AuthorizationSchema = z.object({
  from: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  to: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  value: z.string().regex(/^\d+$/),
  validAfter: z.string().regex(/^\d+$/),
  validBefore: z.string().regex(/^\d+$/),
  nonce: z.string().regex(/^0x[a-fA-F0-9]+$/),
});

const X402PaymentRequirementsSchema = z.object({
  scheme: z.string().min(1),
  network: z.string().min(1),
  amount: z.string().regex(/^\d+$/),
  asset: z.string().min(1),
  payTo: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

const X402PaymentPayloadSchema = z.object({
  x402Version: z.literal(2),
  resource: z
    .object({ url: z.string(), description: z.string().optional() })
    .optional(),
  accepted: X402PaymentRequirementsSchema,
  payload: z.object({
    signature: z.string().min(1),
    authorization: X402AuthorizationSchema,
  }),
  extensions: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The single entry point a route handler calls. Returns a GateVerdict that
 * the handler interprets:
 *   - "free": skip the gate.
 *   - "challenge": return 402.
 *   - "verified": call upstream, then call `settle()`.
 *   - "facilitator_unavailable": return 503.
 */
export async function requirePayment(
  tool: IndexedTool,
  ctx: GateRequestContext,
  config: X402GateConfig,
): Promise<GateVerdict> {
  // Skip gate entirely if disabled or tool isn't priced.
  if (!config.enabled) return { kind: "free" };
  const priceDecimal = tool.pricing?.perCallUsdc;
  if (!isPaidPrice(priceDecimal)) return { kind: "free" };

  const amountAtomic = toAtomicUsdc(priceDecimal);
  if (amountAtomic === "0") return { kind: "free" }; // Defensive: isPaidPrice should have caught this.

  // No PAYMENT-SIGNATURE → return 402 with price-tag.
  if (!ctx.paymentSignatureHeader) {
    return buildChallenge(tool, ctx, config, amountAtomic);
  }

  // Decode + shape-validate the PAYMENT-SIGNATURE.
  let payload: X402PaymentPayload;
  try {
    const decoded = Buffer.from(
      ctx.paymentSignatureHeader,
      "base64",
    ).toString("utf-8");
    const parsed = JSON.parse(decoded) as unknown;
    payload = X402PaymentPayloadSchema.parse(parsed) as X402PaymentPayload;
  } catch (err) {
    return buildChallenge(tool, ctx, config, amountAtomic, {
      error: `malformed PAYMENT-SIGNATURE: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Shape-only checks scope §6.1.
  const verdict = checkShape(payload, config, amountAtomic, tool, ctx);
  if (verdict !== null) return verdict;

  // Idempotency: have we already settled this exact (nonce, from) pair?
  const cache = config.nonceCache;
  const replayed = cache?.get(
    payload.payload.authorization.nonce,
    payload.payload.authorization.from,
  );
  if (replayed) {
    // Re-use the prior receipt CID — caller pays nothing extra, gateway calls
    // neither upstream nor facilitator.
    return {
      kind: "verified",
      paymentPayload: payload,
      paymentRequirements: payload.accepted,
      settle: async () => ({
        ok: true,
        txHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
        pricePaidUsdc: decimalUsdc(payload.accepted.amount),
        network: payload.accepted.network,
        payer: payload.payload.authorization.from,
        response: {
          success: true,
          transaction:
            "0x0000000000000000000000000000000000000000000000000000000000000000",
          network: payload.accepted.network,
          payer: payload.payload.authorization.from,
        },
      }),
      replayedCID: replayed.receiptCID,
    };
  }

  // Facilitator /verify.
  let verifyResult;
  try {
    verifyResult = await verifyWithFacilitator(
      config.facilitator,
      payload,
      payload.accepted,
    );
  } catch (err) {
    if (err instanceof FacilitatorNetworkError) {
      return {
        kind: "facilitator_unavailable",
        status: 503,
        reason: `facilitator /verify ${err.kind}: ${err.message}`,
      };
    }
    return {
      kind: "facilitator_unavailable",
      status: 503,
      reason: `facilitator /verify unknown error`,
    };
  }
  if (!verifyResult.isValid) {
    return buildChallenge(tool, ctx, config, amountAtomic, {
      error: `payment_invalid: ${verifyResult.invalidReason ?? "unknown"}`,
    });
  }
  // Payer match: facilitator MAY return `payer`; if it does, must equal authorization.from.
  if (
    verifyResult.payer &&
    verifyResult.payer.toLowerCase() !==
      payload.payload.authorization.from.toLowerCase()
  ) {
    return buildChallenge(tool, ctx, config, amountAtomic, {
      error: `payer_mismatch: facilitator says ${verifyResult.payer}, signed by ${payload.payload.authorization.from}`,
    });
  }

  // verify OK → hand back a settle thunk the route invokes after upstream success.
  return {
    kind: "verified",
    paymentPayload: payload,
    paymentRequirements: payload.accepted,
    settle: async (): Promise<SettleOutcome> => {
      let settle: X402SettlementResponse;
      try {
        settle = await settleWithFacilitator(
          config.facilitator,
          payload,
          payload.accepted,
        );
      } catch (err) {
        if (err instanceof FacilitatorNetworkError) {
          return {
            ok: false,
            reason: `facilitator /settle ${err.kind}: ${err.message}`,
            status: 503,
          };
        }
        return {
          ok: false,
          reason: `facilitator /settle unknown error`,
          status: 503,
        };
      }
      if (!settle.success) {
        return {
          ok: false,
          reason: `settle_failed: ${settle.errorReason ?? "unknown"}`,
          status: 502,
        };
      }
      const txHash = settle.transaction;
      const pricePaidUsdc = decimalUsdc(payload.accepted.amount);
      // Record nonce so a retry of the same payload returns the same CID
      // without re-broadcasting. The cache stores receiptCID, which the
      // route fills in via a follow-up call to recordSettlement.
      // The cache write here uses a placeholder; the route adds the real
      // CID via `recordSettlement` after sign+evaluate.
      // We intentionally don't store the CID here (we don't have it yet) —
      // see recordSettlement for the second-pass cache update.
      return {
        ok: true,
        txHash,
        pricePaidUsdc,
        network: settle.network,
        payer: (settle.payer ??
          payload.payload.authorization.from) as Address,
        response: settle,
      };
    },
  };
}

/**
 * After a verified+settled invocation produces an InvocationReceipt, the
 * route handler calls this to record (nonce, from, receiptCID) in the cache.
 *
 * Two-step so the cache only stores entries for which we have a real CID
 * (we don't write speculative entries from inside `requirePayment`).
 */
export function recordSettlement(
  payload: X402PaymentPayload,
  receiptCID: string,
  config: X402GateConfig,
): void {
  config.nonceCache?.set(
    payload.payload.authorization.nonce,
    payload.payload.authorization.from,
    receiptCID,
  );
}

/** Default headers we set on a 402 challenge response. */
function challengeHeaders(payload: X402PaymentRequired): Record<string, string> {
  return {
    "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(payload)).toString("base64"),
    "x-x402-version": "2",
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function buildChallenge(
  tool: IndexedTool,
  ctx: GateRequestContext,
  config: X402GateConfig,
  amountAtomic: string,
  options?: { error?: string },
): GateVerdict {
  const validUntil = Math.floor(
    (config.now ? config.now() : Date.now()) / 1000,
  ) + config.maxTimeoutSeconds;
  const priceTagFields: PriceTagFields = {
    toolId: tool.id,
    amount: amountAtomic,
    network: config.network,
    payTo: config.payTo,
    validUntil: validUntil.toString(),
  };
  const tag = priceTagHmac(priceTagFields, config.hmacSecretHex);
  const requirements: X402PaymentRequirements = {
    scheme: "exact",
    network: config.network,
    amount: amountAtomic,
    asset: config.usdcAddress,
    payTo: config.payTo,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    extra: {
      priceTag: tag,
      validUntil: validUntil.toString(),
      toolId: tool.id,
    },
  };
  const body: X402PaymentRequired = {
    x402Version: 2,
    resource: { url: ctx.resourceUrl, description: tool.description },
    accepts: [requirements],
    ...(options?.error ? { error: options.error } : {}),
  };
  return {
    kind: "challenge",
    status: 402,
    body,
    headers: challengeHeaders(body),
  };
}

/**
 * Stateless shape checks against the (decoded) payload. Returns a verdict
 * (challenge) if any check fails, or `null` to continue to facilitator verify.
 */
function checkShape(
  payload: X402PaymentPayload,
  config: X402GateConfig,
  expectedAmountAtomic: string,
  tool: IndexedTool,
  ctx: GateRequestContext,
): GateVerdict | null {
  const reqs = payload.accepted;
  // Scheme + network + payTo + amount must match what the gateway would have offered.
  if (reqs.scheme !== "exact") {
    return buildChallenge(tool, ctx, config, expectedAmountAtomic, {
      error: `scheme_mismatch: expected "exact", got "${reqs.scheme}"`,
    });
  }
  if (reqs.network !== config.network) {
    return buildChallenge(tool, ctx, config, expectedAmountAtomic, {
      error: `network_mismatch: expected ${config.network}, got ${reqs.network}`,
    });
  }
  if (reqs.payTo.toLowerCase() !== config.payTo.toLowerCase()) {
    return buildChallenge(tool, ctx, config, expectedAmountAtomic, {
      error: `payTo_mismatch: expected ${config.payTo}, got ${reqs.payTo}`,
    });
  }
  if (reqs.amount !== expectedAmountAtomic) {
    return buildChallenge(tool, ctx, config, expectedAmountAtomic, {
      error: `amount_mismatch: expected ${expectedAmountAtomic} atomic units, got ${reqs.amount}`,
    });
  }
  // Authorization consistency: to === payTo, value === amount.
  const auth = payload.payload.authorization;
  if (auth.to.toLowerCase() !== reqs.payTo.toLowerCase()) {
    return buildChallenge(tool, ctx, config, expectedAmountAtomic, {
      error: `authorization.to mismatch: expected ${reqs.payTo}, got ${auth.to}`,
    });
  }
  if (auth.value !== reqs.amount) {
    return buildChallenge(tool, ctx, config, expectedAmountAtomic, {
      error: `authorization.value mismatch: expected ${reqs.amount}, got ${auth.value}`,
    });
  }
  // Window check.
  const nowSec = Math.floor((config.now ? config.now() : Date.now()) / 1000);
  if (nowSec < Number(auth.validAfter) || nowSec > Number(auth.validBefore)) {
    return buildChallenge(tool, ctx, config, expectedAmountAtomic, {
      error: `authorization expired or not yet valid (now=${nowSec}, validAfter=${auth.validAfter}, validBefore=${auth.validBefore})`,
    });
  }
  // Price-tag check, if present (gateway-issued challenges always carry one).
  const tagFromCaller = (reqs.extra ?? {})["priceTag"];
  const validUntilFromCaller = (reqs.extra ?? {})["validUntil"];
  if (typeof tagFromCaller === "string" && typeof validUntilFromCaller === "string") {
    const priceTagFields: PriceTagFields = {
      toolId: tool.id,
      amount: expectedAmountAtomic,
      network: config.network,
      payTo: config.payTo,
      validUntil: validUntilFromCaller,
    };
    const ok = verifyPriceTag(
      tagFromCaller,
      priceTagFields,
      config.hmacSecretHex,
      nowSec,
    );
    if (!ok) {
      return buildChallenge(tool, ctx, config, expectedAmountAtomic, {
        error:
          "priceTag_mismatch: amount/payTo/network/toolId or validUntil tampered, or tag expired",
      });
    }
  }
  return null;
}
