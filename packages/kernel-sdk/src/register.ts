/**
 * Client helper for registering a third-party kernel with a PCC gateway.
 *
 * `registerKernel(gatewayUrl, manifest, opts?)` POSTs the manifest to
 * `/api/kernels/register` and returns the gateway's response.
 *
 * The function is a thin fetch wrapper — no retries, no fancy auth. Third-
 * party builders that need auth should pass the `apiKey` option; the SDK
 * will add `Authorization: Bearer <key>`.
 */

import type { DigitalKernelManifest } from "@pcc/spec";

export interface RegisterKernelOptions {
  /** Optional PCC API key (sent as Authorization: Bearer <key>) */
  apiKey?: string;
  /** Optional fetch implementation (for tests / Node < 18) */
  fetchImpl?: typeof fetch;
  /** Override request timeout in ms (default: 10000) */
  timeoutMs?: number;
}

export interface RegisterKernelResponse {
  kernelId: string;
  status: "pending" | "verified" | "suspended";
  nextStep?: string;
  message?: string;
}

export class KernelRegistrationError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `Registration failed with status ${statusCode}`);
    this.name = "KernelRegistrationError";
  }
}

/**
 * Register a kernel manifest with a PCC gateway.
 *
 * @param gatewayUrl Base URL of the gateway (e.g., "https://capability.network")
 * @param manifest   The manifest to register
 * @param opts       Optional auth + fetch config
 * @returns          The gateway's registration response
 * @throws KernelRegistrationError on non-2xx responses
 */
export async function registerKernel(
  gatewayUrl: string,
  manifest: DigitalKernelManifest,
  opts: RegisterKernelOptions = {},
): Promise<RegisterKernelResponse> {
  const f = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  if (!f) {
    throw new Error(
      "registerKernel: fetch is not available — pass opts.fetchImpl (Node < 18)",
    );
  }

  const base = gatewayUrl.replace(/\/+$/, "");
  const url = `${base}/api/kernels/register`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (opts.apiKey) {
    headers["Authorization"] = `Bearer ${opts.apiKey}`;
  }

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);

  let res: Response;
  try {
    res = await f(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ manifest }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }

  if (!res.ok) {
    throw new KernelRegistrationError(res.status, body);
  }

  const b = body as Partial<RegisterKernelResponse> | undefined;
  if (!b?.kernelId || !b?.status) {
    throw new KernelRegistrationError(res.status, body, "Malformed gateway response");
  }

  return {
    kernelId: b.kernelId,
    status: b.status,
    nextStep: b.nextStep,
    message: b.message,
  };
}
