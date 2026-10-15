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
  try { return await response.json(); }
  catch (error) {
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) throw new WalletError("gateway_unavailable");
    throw new WalletError("invalid_gateway_response");
  }
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
      throw new WalletError(code);
    }
    throw new WalletError("invalid_gateway_response");
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
  if (response.status === 404) return { funded: false, txHashes: [] };
  if (!response.ok) throw new WalletError(String(response.status));
  if (response.status === 204) return { funded: true, txHashes: [] };
  const data = await json(response);
  const hashes = new Set<string>();
  function collect(value: unknown): void {
    if (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)) hashes.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (object(value)) Object.values(value).forEach(collect);
  }
  collect(data);
  return { funded: true, txHashes: [...hashes] };
}
