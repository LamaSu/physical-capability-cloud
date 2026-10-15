import type { Hex } from "viem";
import type { Role } from "./keystore.js";
import { WalletError } from "./errors.js";

type JsonObject = Record<string, unknown>;

export function validateTransportUrl(value: string, kind: "gateway" | "rpc" = "gateway"): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new WalletError(`invalid_${kind}_origin`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || url.search || url.hash || (kind === "gateway" && url.pathname !== "/")) {
    throw new WalletError(`invalid_${kind}_origin`);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol === "http:" && !loopback) throw new WalletError(`insecure_${kind}_origin`);
  return url;
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Request bodies are built from public fields at each call site. This guard is
// also local: the client's protection must not depend on the server's schema.
function checkBody(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(checkBody);
  } else if (object(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (/^(private_?key|secret|mnemonic|seed(_?phrase)?)$/i.test(key)) {
        throw new WalletError("key_material_refused");
      }
      checkBody(child);
    }
  }
}

async function send(
  origin: string,
  path: string,
  method: "GET" | "POST",
  body?: JsonObject,
  apiKey?: string,
  timeoutMs = 15_000,
): Promise<Response> {
  validateTransportUrl(origin);
  if (body) checkBody(body);
  try {
    return await fetch(`${origin}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new WalletError("gateway_unavailable");
  }
}

async function json(response: Response, retryBodyNetworkErrors = false): Promise<unknown> {
  const limit = 64 * 1024;
  const reader = response.body?.getReader();
  if (!reader) throw new WalletError("invalid_gateway_response");
  let reading = true;
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        void reader.cancel().catch(() => { /* refusal already reported */ });
        throw new WalletError("gateway_response_too_large");
      }
      chunks.push(value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    reading = false;
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  }
  catch (error) {
    if (retryBodyNetworkErrors && reading && error instanceof TypeError) throw error;
    if (error instanceof WalletError) throw error;
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) throw new WalletError("gateway_unavailable");
    throw new WalletError("invalid_gateway_response");
  } finally { reader.releaseLock(); }
}

function gatewayError(data: unknown, status: number): never {
  // A gateway can supply a code, never arbitrary diagnostic text.
  const code = object(data) ? data.error : undefined;
  if (typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(code)
    && !/private_?key|secret|seed|mnemonic/i.test(code)) {
    throw new WalletError(code, 1, status);
  }
  throw new WalletError("invalid_gateway_response", 1, status);
}

export async function walletRequest(
  origin: string,
  path: string,
  method: "GET" | "POST",
  body?: JsonObject,
  apiKey?: string,
  timeoutMs = 15_000,
): Promise<JsonObject> {
  const response = await send(origin, path, method, body, apiKey, timeoutMs);
  const data = await json(response);
  if (!response.ok) gatewayError(data, response.status);
  if (!object(data)) throw new WalletError("invalid_gateway_response");
  return data;
}

export interface FundingClaim {
  token: "eth" | "usdc";
  amount: "0.0001" | "1";
  status: "succeeded" | "failed" | "pending";
  txHash?: Hex;
}
export interface FundingResult {
  status: "funded" | "partial" | "pending" | "unavailable";
  claims: FundingClaim[];
}

function invalidFundingResponse(): never { throw new WalletError("invalid_gateway_response"); }

function exactKeys(value: JsonObject, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => allowed.has(key));
}

function parseFunding(data: unknown, role: Role): FundingResult {
  if (!object(data) || !exactKeys(data, ["status", "claims"])
    || (data.status !== "funded" && data.status !== "partial" && data.status !== "pending")
    || !Array.isArray(data.claims) || data.claims.length !== (role === "agent" ? 6 : 5)) invalidFundingResponse();
  const hashes = new Set<string>();
  const claims = data.claims.map((value: unknown, index: number): FundingClaim => {
    if (!object(value) || !exactKeys(value, ["token", "amount", "status"], ["txHash"])
      || (value.token !== "eth" && value.token !== "usdc")
      || value.token !== (index < 5 ? "eth" : "usdc")
      || value.amount !== (value.token === "eth" ? "0.0001" : "1")
      || (value.status !== "succeeded" && value.status !== "failed" && value.status !== "pending")
      || (Object.hasOwn(value, "txHash") && (typeof value.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value.txHash)))
      || (value.status === "succeeded" && typeof value.txHash !== "string")
      || (value.status !== "succeeded" && Object.hasOwn(value, "txHash"))
      || (typeof value.txHash === "string" && hashes.has(value.txHash.toLowerCase()))) invalidFundingResponse();
    if (typeof value.txHash === "string") hashes.add(value.txHash.toLowerCase());
    return {
      token: value.token,
      amount: value.amount as FundingClaim["amount"],
      status: value.status,
      ...(typeof value.txHash === "string" ? { txHash: value.txHash as Hex } : {}),
    };
  });
  const expectedStatus = claims.every(claim => claim.status === "succeeded" && claim.txHash) ? "funded"
    : claims.some(claim => claim.status === "pending") ? "pending"
    : claims.some(claim => claim.status === "succeeded") ? "partial" : undefined;
  if (data.status !== expectedStatus) invalidFundingResponse();
  return { status: data.status as FundingResult["status"], claims };
}

/** Request-ID capability: no owner credential or owner funding route is used. */
export async function requestFunding(
  origin: string,
  requestId: string,
  role: Role = "agent",
): Promise<FundingResult> {
  const response = await send(origin, `/api/wallets/link-requests/${encodeURIComponent(requestId)}/fund`, "POST", {});
  const data = await json(response);
  if (response.status === 404 && object(data) && exactKeys(data, ["error"]) && data.error === "not_found") {
    return { status: "unavailable", claims: [] };
  }
  if (!response.ok) {
    if (response.status === 502 && object(data) && data.error === "faucet_error") {
      const allowed = ["faucet_limit_exceeded", "rate_limit_exceeded", "unauthorized", "forbidden",
        "bad_gateway", "internal_server_error", "network_timeout", "network_connection_failed",
        "timeout", "invalid_tx_hash", "unknown"];
      const errorClass = typeof data.errorClass === "string" && allowed.includes(data.errorClass) ? data.errorClass : "unknown";
      throw new WalletError("faucet_error", 1, response.status, errorClass);
    }
    if (response.status === 409 && object(data) && data.error === "cap_reached") {
      if (data.cap !== "address" && data.cap !== "account" && data.cap !== "global") invalidFundingResponse();
      throw new WalletError("cap_reached", 1, response.status, undefined, data.cap);
    }
    if (response.status === 403 && object(data) && data.error === "capability_expired") {
      throw new WalletError("capability_expired: ask the account owner to fund the link using POST /api/wallets/:linkId/fund", 1, response.status);
    }
    gatewayError(data, response.status);
  }
  if (response.status !== 200) invalidFundingResponse();
  return parseFunding(data, role);
}

/** Receipt checks use public RPC requests and never access wallet key material. */
export async function waitForFundingReceipt(
  hash: Hex,
  rpcUrl: string,
  timeoutMs = 60_000,
): Promise<{ status: "success" | "reverted" }> {
  const url = validateTransportUrl(rpcUrl, "rpc").toString();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 2 || timeoutMs > 60_000) {
    throw new WalletError("invalid_receipt_timeout");
  }
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  // The same timer bounds fetch, response-body reads and every retry.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (;;) {
      if (controller.signal.aborted || Date.now() >= deadline) throw new WalletError("funding_receipt_timeout");
      try {
        const response = await fetch(url, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] }),
          redirect: "error", signal: controller.signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status !== 408 && response.status !== 429 && (response.status < 500 || response.status > 599)) {
            throw new WalletError("funding_rpc_unavailable");
          }
        } else {
          const data = await json(response, true);
          if (!object(data)) throw new WalletError("funding_rpc_unavailable");
          if (Object.hasOwn(data, "error") && data.error !== null) {
            // Limit-exceeded and internal errors are transient; share the same
            // polling interval and deadline as HTTP 408, 429 and 5xx failures.
            if (!object(data.error) || (data.error.code !== -32005 && data.error.code !== -32603)) {
              throw new WalletError("funding_rpc_unavailable");
            }
          } else if (!Object.hasOwn(data, "result")) {
            throw new WalletError("funding_rpc_unavailable");
          } else if (data.result !== null) {
            const receipt = data.result;
            if (!object(receipt)) throw new WalletError("funding_receipt_invalid");
            if (typeof receipt.transactionHash !== "string" || receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
              throw new WalletError("funding_receipt_mismatch");
            }
            if (receipt.status !== "0x1" && receipt.status !== "0x0") throw new WalletError("funding_receipt_invalid");
            return { status: receipt.status === "0x1" ? "success" : "reverted" };
          }
        }
      } catch (error) {
        if (controller.signal.aborted || Date.now() >= deadline) throw new WalletError("funding_receipt_timeout");
        if (error instanceof WalletError) {
          if (["invalid_gateway_response", "gateway_response_too_large", "gateway_unavailable"].includes(error.code)) {
            throw new WalletError("funding_rpc_unavailable");
          }
          throw error;
        }
        if (!(error instanceof TypeError)) throw new WalletError("funding_rpc_unavailable");
        // fetch reports transient network failures as TypeError. Retry within
        // the same deadline; redirects remain refused by fetch itself.
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new WalletError("funding_receipt_timeout");
      await new Promise<void>(done => setTimeout(done, Math.min(2_000, remaining)));
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
