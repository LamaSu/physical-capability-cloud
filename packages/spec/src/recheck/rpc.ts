import { KIT_VERSION } from "./descriptor.js";

export interface RecheckRpc {
  request(method: string, params: readonly unknown[]): Promise<unknown>;
}

/** Carries JSON-RPC / HTTP codes without treating node refusals as transport failures. */
export class RecheckRpcError extends Error {
  constructor(message: string, public readonly code: number, public readonly data?: unknown) {
    super(message);
    this.name = "RecheckRpcError";
  }
}

export function httpRpc(url: string, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): RecheckRpc {
  const endpoint = new URL(url);
  if (!/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error("RPC must be an HTTP(S) URL without credentials");
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("invalid RPC timeout");
  let id = 0;
  return { async request(method, params) {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params });
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetcher(endpoint.href, {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { "Content-Type": "application/json", "User-Agent": `pcc-settlement-recheck/${KIT_VERSION}` }, body,
        });
        if (!response.ok) throw new RecheckRpcError("RPC HTTP request refused", response.status);
        const reply = await response.json() as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
        if (reply.error) throw new RecheckRpcError(reply.error.message, reply.error.code, reply.error.data);
        if (!("result" in reply)) throw new RecheckRpcError("invalid JSON-RPC response", -32603);
        return reply.result;
      } catch (e) {
        if (e instanceof RecheckRpcError || attempt === 1) throw e;
      } finally { clearTimeout(timer); }
    }
  } };
}
