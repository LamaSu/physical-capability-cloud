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

async function json(response: Response): Promise<unknown> {
  const limit = 64 * 1024;
  const reader = response.body?.getReader();
  if (!reader) throw new WalletError("invalid_gateway_response");
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
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  }
  catch (error) {
    if (error instanceof WalletError) throw error;
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) throw new WalletError("gateway_unavailable");
    throw new WalletError("invalid_gateway_response");
  } finally { reader.releaseLock(); }
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
  if (!response.ok) {
    // Never echo arbitrary gateway text, values or diagnostic objects.
    const code = object(data) ? data.error : undefined;
    if (typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(code)
      && !/private_?key|secret|seed|mnemonic/i.test(code)) {
      throw new WalletError(code, 1, response.status);
    }
    throw new WalletError("invalid_gateway_response", 1, response.status);
  }
  if (!object(data)) throw new WalletError("invalid_gateway_response");
  return data;
}

/** W2 integration point: change the funding endpoint/response here only. */
export async function requestFunding(origin: string, linkId: string): Promise<{
  funded: boolean;
  txHashes: string[];
}> {
  const response = await send(origin, `/api/wallets/${encodeURIComponent(linkId)}/fund`, "POST", {});
  const data = await json(response);
  if (response.status === 404) return { funded: false, txHashes: [] };
  if (!response.ok) throw new WalletError(String(response.status));
  if (response.status === 204) return { funded: true, txHashes: [] };
  const hashes = new Set<string>();
  function collect(value: unknown): void {
    if (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)) hashes.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (object(value)) Object.values(value).forEach(collect);
  }
  collect(data);
  return { funded: true, txHashes: [...hashes] };
}
