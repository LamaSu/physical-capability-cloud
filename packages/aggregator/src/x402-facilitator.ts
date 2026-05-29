/**
 * x402 facilitator HTTP client.
 *
 * Wraps the two endpoints we need on a Coinbase CDP facilitator (production)
 * or x402.org facilitator (testnet):
 *
 *   POST {facilitatorUrl}/verify   — cryptographic + balance check (no broadcast)
 *   POST {facilitatorUrl}/settle   — broadcast the EIP-3009 transferWithAuthorization
 *
 * Both calls share the same request shape:
 *   { paymentPayload: X402PaymentPayload, paymentRequirements: X402PaymentRequirements }
 *
 * Responses are well-shaped per the x402 v2 protocol; we map facilitator
 * errors to typed verdicts the gate can act on (verify-fail → 402, settle-fail
 * → 502, network-down → 503).
 *
 * Timeouts and error mapping match scope §8.3 (5s verify / 30s settle, no
 * silent retries — settle is broadcast-once, the gateway returns 502/503 and
 * the caller can retry the whole invoke with a fresh nonce).
 *
 * No retries inside this module. Idempotency is enforced one level up by the
 * gate using the nonce-cache.
 */

import type {
  X402PaymentPayload,
  X402PaymentRequirements,
  X402SettlementResponse,
  X402VerifyResponse,
} from "@pcc/spec";

/** Facilitator configuration (per-environment). */
export interface X402FacilitatorConfig {
  /** Base URL of the facilitator. No trailing slash. */
  url: string;
  /** Optional Coinbase CDP API key id (production only). */
  cdpApiKeyId?: string;
  /** Optional Coinbase CDP API key secret (production only). */
  cdpApiKeySecret?: string;
  /** Override default 5s verify timeout (ms). */
  verifyTimeoutMs?: number;
  /** Override default 30s settle timeout (ms). */
  settleTimeoutMs?: number;
  /**
   * Optional fetch implementation override (tests inject a mock here so
   * we don't have to mutate `globalThis.fetch`). Defaults to the global
   * fetch when undefined.
   */
  fetchImpl?: typeof fetch;
}

const DEFAULT_VERIFY_TIMEOUT_MS = 5_000;
const DEFAULT_SETTLE_TIMEOUT_MS = 30_000;

/**
 * Result of a facilitator call. We don't throw on protocol-level failures
 * (verify=false, settle.success=false) — the gate converts those to HTTP
 * responses for the caller. We DO throw on network-level failures (timeout,
 * non-2xx HTTP not carrying a typed body) so the gate can surface 503.
 */
export class FacilitatorNetworkError extends Error {
  readonly kind: "timeout" | "http" | "parse" | "unknown";
  readonly statusCode?: number;
  constructor(
    kind: FacilitatorNetworkError["kind"],
    message: string,
    statusCode?: number,
  ) {
    super(message);
    this.kind = kind;
    this.statusCode = statusCode;
    this.name = "FacilitatorNetworkError";
  }
}

interface FacilitatorRequestBody {
  paymentPayload: X402PaymentPayload;
  paymentRequirements: X402PaymentRequirements;
}

/**
 * Call POST {facilitatorUrl}/verify with the (payload, requirements) pair.
 *
 * Returns the parsed X402VerifyResponse. Does NOT call upstream — the gate
 * decides whether to proceed based on `isValid`.
 *
 * Throws FacilitatorNetworkError if the facilitator is unreachable or
 * returns an unexpected response shape (so the gate can return 503).
 */
export async function verifyWithFacilitator(
  config: X402FacilitatorConfig,
  paymentPayload: X402PaymentPayload,
  paymentRequirements: X402PaymentRequirements,
): Promise<X402VerifyResponse> {
  const body: FacilitatorRequestBody = { paymentPayload, paymentRequirements };
  const timeoutMs = config.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const result = await postJsonWithTimeout(
    config,
    "/verify",
    body,
    timeoutMs,
  );
  // The /verify endpoint may return 200 (isValid: true) OR 412 (isValid: false
  // with invalidReason). Both shapes use the same X402VerifyResponse type.
  if (result.statusCode === 200 || result.statusCode === 412) {
    const parsed = parseVerifyResponse(result.bodyText);
    if (!parsed) {
      throw new FacilitatorNetworkError(
        "parse",
        `facilitator /verify returned unparseable body: ${result.bodyText.slice(0, 200)}`,
        result.statusCode,
      );
    }
    return parsed;
  }
  throw new FacilitatorNetworkError(
    "http",
    `facilitator /verify HTTP ${result.statusCode}: ${result.bodyText.slice(0, 200)}`,
    result.statusCode,
  );
}

/**
 * Call POST {facilitatorUrl}/settle with the (payload, requirements) pair.
 *
 * Returns the parsed X402SettlementResponse. If `success: false`, the
 * facilitator did NOT broadcast — caller (gate) returns 502 and the receipt
 * is NOT written.
 *
 * Throws FacilitatorNetworkError if the facilitator is unreachable / parse
 * fails / 5xx HTTP — gate returns 503.
 */
export async function settleWithFacilitator(
  config: X402FacilitatorConfig,
  paymentPayload: X402PaymentPayload,
  paymentRequirements: X402PaymentRequirements,
): Promise<X402SettlementResponse> {
  const body: FacilitatorRequestBody = { paymentPayload, paymentRequirements };
  const timeoutMs = config.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
  const result = await postJsonWithTimeout(
    config,
    "/settle",
    body,
    timeoutMs,
  );
  if (result.statusCode === 200) {
    const parsed = parseSettlementResponse(result.bodyText);
    if (!parsed) {
      throw new FacilitatorNetworkError(
        "parse",
        `facilitator /settle returned unparseable body: ${result.bodyText.slice(0, 200)}`,
        result.statusCode,
      );
    }
    return parsed;
  }
  // 4xx with success:false body is also valid — bubble up as a typed verdict
  // so the gate can decide. Only treat 5xx / parse-fail as network error.
  if (result.statusCode >= 400 && result.statusCode < 500) {
    const parsed = parseSettlementResponse(result.bodyText);
    if (parsed) return parsed;
  }
  throw new FacilitatorNetworkError(
    "http",
    `facilitator /settle HTTP ${result.statusCode}: ${result.bodyText.slice(0, 200)}`,
    result.statusCode,
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface RawResult {
  statusCode: number;
  bodyText: string;
}

async function postJsonWithTimeout(
  config: X402FacilitatorConfig,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<RawResult> {
  const url = `${config.url.replace(/\/+$/, "")}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (config.cdpApiKeyId && config.cdpApiKeySecret) {
      // CDP uses HTTP basic-like auth; if a future scheme changes, this is
      // the single touchpoint.
      headers["x-cdp-api-key-id"] = config.cdpApiKeyId;
      headers["x-cdp-api-key-secret"] = config.cdpApiKeySecret;
    }
    const f = config.fetchImpl ?? globalThis.fetch;
    if (!f) {
      throw new FacilitatorNetworkError(
        "unknown",
        "no fetch implementation available (set X402FacilitatorConfig.fetchImpl)",
      );
    }
    const response = await f(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    return { statusCode: response.status, bodyText };
  } catch (err) {
    if (err instanceof FacilitatorNetworkError) throw err;
    if (
      err instanceof Error &&
      (err.name === "AbortError" || /aborted|timeout/i.test(err.message))
    ) {
      throw new FacilitatorNetworkError(
        "timeout",
        `facilitator ${path} timed out after ${timeoutMs}ms`,
      );
    }
    throw new FacilitatorNetworkError(
      "unknown",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clearTimeout(timer);
  }
}

function parseVerifyResponse(text: string): X402VerifyResponse | null {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    if (typeof obj.isValid !== "boolean") return null;
    const out: X402VerifyResponse = { isValid: obj.isValid };
    if (typeof obj.invalidReason === "string") {
      out.invalidReason = obj.invalidReason;
    }
    if (typeof obj.payer === "string") {
      out.payer = obj.payer as X402VerifyResponse["payer"];
    }
    return out;
  } catch {
    return null;
  }
}

function parseSettlementResponse(text: string): X402SettlementResponse | null {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    if (typeof obj.success !== "boolean") return null;
    if (typeof obj.transaction !== "string") return null;
    if (typeof obj.network !== "string") return null;
    const out: X402SettlementResponse = {
      success: obj.success,
      transaction: obj.transaction,
      network: obj.network,
    };
    if (typeof obj.errorReason === "string") out.errorReason = obj.errorReason;
    if (typeof obj.payer === "string") {
      out.payer = obj.payer as X402SettlementResponse["payer"];
    }
    return out;
  } catch {
    return null;
  }
}
