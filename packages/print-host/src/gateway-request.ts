/** Internal transport only: responses and headers never become public results. */
export type ObjectBody = Record<string, unknown>;
export type RequestReply = {
  status: number;
  body: ObjectBody | null;
  headers: Headers;
};
export type RequestFailure = {
  ok: false;
  code: "network" | "timeout" | "malformed_response";
  status: number | null;
};

/** Callers can request the configured wallet only; arbitrary headers are closed. */
export type RequestOptions = { readonly wallet?: true };

export function isRequestFailure(reply: RequestReply | RequestFailure): reply is RequestFailure {
  return Object.hasOwn(reply, "ok");
}

export function object(value: unknown): value is ObjectBody {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function own(value: ObjectBody, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

export function validId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200
    || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
  try { encodeURIComponent(value); return true; } catch { return false; }
}

const aborted = Symbol("gateway timeout");
const tooLarge = Symbol("gateway response limit");

/** Fetch implementations and streams need not implement abort themselves. */
function withinDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(aborted);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) onAbort();
  });
}

async function boundedBody(response: Response, signal: AbortSignal, limit: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await withinDeadline(reader.read(), signal);
      if (signal.aborted) throw aborted;
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) { cancel(); throw tooLarge; }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, size).toString("utf8");
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** Callers validate configuration and choose their own status/error semantics. */
export function createGatewayRequest(cfg: {
  apiKey: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  maxResponseBytes: number;
  wallet?: string;
}) {
  const { apiKey, fetchImpl, timeoutMs, maxResponseBytes, wallet } = cfg;
  return async (url: string, body?: string, options?: RequestOptions): Promise<RequestReply | RequestFailure> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status: number | null = null;
    try {
      const response = await withinDeadline(fetchImpl(url, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(options?.wallet === true && wallet !== undefined ? { "X-PCC-Wallet": wallet } : {}),
        },
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      }), controller.signal);
      status = response.status;
      const text = await boundedBody(response, controller.signal, maxResponseBytes);
      if (controller.signal.aborted) throw aborted;
      const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      const isJson = contentType === "application/json" || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(contentType ?? "");
      let parsed: unknown;
      if (isJson) {
        try { parsed = JSON.parse(text); } catch { /* never retain parse exceptions */ }
      }
      return { status, body: object(parsed) ? parsed : null, headers: response.headers };
    } catch (error) {
      if (error === tooLarge) return { ok: false, code: "malformed_response", status };
      const timedOut = controller.signal.aborted || error === aborted;
      return { ok: false, code: timedOut ? "timeout" : status === null ? "network" : "malformed_response", status };
    } finally {
      clearTimeout(timer);
    }
  };
}
