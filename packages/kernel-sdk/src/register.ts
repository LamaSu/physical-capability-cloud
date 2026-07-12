/**
 * Client helper for registering a third-party kernel with a PCC gateway.
 *
 * `registerKernel(gatewayUrl, manifest, opts?)` POSTs the manifest to
 * `/api/kernels/register` and returns the gateway's response.
 *
 * When `opts.signingKey` is provided, registerKernel FIRST proves possession of
 * the kernel's settlement signing key via `POST /api/kernels` (the Ed25519 lane,
 * #235), THEN posts the marketplace manifest exactly as before. Without it, the
 * behavior is byte-for-byte unchanged (backward compatible).
 *
 * The function is a thin fetch wrapper — no retries, no fancy auth. Third-
 * party builders that need auth should pass the `apiKey` option; the SDK
 * will add `Authorization: Bearer <key>`.
 */

import type { DigitalKernelManifest } from "@pcc/spec";
import { buildEd25519RegistrationProof } from "./signing-proof.js";

/** A signer the gateway has on record for a kernel (tagged by algorithm). */
export type RegisteredSigner =
  | { algorithm: "ed25519"; publicKey: string }
  | { algorithm: "secp256k1"; address: string };

/** Outcome of the `POST /api/kernels` signing-key proof (only when requested). */
export interface SigningRegistrationResult {
  /**
   * True iff the gateway bound OUR proven Ed25519 key as the kernel's
   * settlement signer. False means the gateway did NOT adopt our key — most
   * commonly because the kernel's signer is already set (set-once) to a
   * different key. Callers should treat `false` as "my evidence bundles will
   * NOT settle under this kernel" and reconcile before running jobs.
   */
  signerBound: boolean;
  /**
   * The signer the gateway now has on record for this kernel, or `null` if none
   * was bound. When `signerBound` is false but this is non-null, it reveals the
   * mismatching signer already in place.
   */
  registeredSigner: RegisteredSigner | null;
  /** The public key we proved (raw 32-byte Ed25519, hex, no 0x prefix). */
  provenPublicKey: string;
}

export interface RegisterKernelOptions {
  /** Optional PCC API key (sent as Authorization: Bearer <key>) */
  apiKey?: string;
  /** Optional fetch implementation (for tests / Node < 18) */
  fetchImpl?: typeof fetch;
  /** Override request timeout in ms (default: 10000) */
  timeoutMs?: number;
  /**
   * When provided, registerKernel proves possession of the kernel's settlement
   * signing key via `POST /api/kernels` (Ed25519 lane, #235) BEFORE posting the
   * marketplace manifest.
   *
   * `principalPrivateKey` MUST be the SAME key the adapter wires into
   * `createKernelHandler` to sign evidence bundles — the gateway matches
   * evidence signatures against this registered signer at settlement. Accepts a
   * 64-byte tweetnacl `secretKey` or a 32-byte seed.
   */
  signingKey?: {
    principalPrivateKey: Uint8Array;
  };
}

export interface RegisterKernelResponse {
  kernelId: string;
  status: "pending" | "verified" | "suspended";
  nextStep?: string;
  message?: string;
  /**
   * Present only when `opts.signingKey` was provided. Reports whether the
   * gateway bound our proven Ed25519 key as the kernel's settlement signer.
   */
  signing?: SigningRegistrationResult;
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

/** Strip a leading 0x/0X and lowercase — for comparing hex keys framing-agnostically. */
function normalizeHex(input: string): string {
  const clean = input.startsWith("0x") || input.startsWith("0X") ? input.slice(2) : input;
  return clean.toLowerCase();
}

/** POST a JSON body with a per-request timeout. Shared by both registration legs. */
async function postJson(
  f: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<{ res: Response; body: unknown }> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await f(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = undefined;
  }
  return { res, body: parsed };
}

/**
 * Register a kernel manifest with a PCC gateway.
 *
 * @param gatewayUrl Base URL of the gateway (e.g., "https://capability.network")
 * @param manifest   The manifest to register
 * @param opts       Optional auth + fetch config (+ signingKey for #235)
 * @returns          The gateway's registration response (+ `signing` when a
 *                   signing key was supplied)
 * @throws KernelRegistrationError on non-2xx responses from either POST
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
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (opts.apiKey) {
    headers["Authorization"] = `Bearer ${opts.apiKey}`;
  }

  // ── #235: prove the settlement signing key FIRST (only when requested) ─────
  // The proof is verified + persisted by POST /api/kernels — NOT by the
  // marketplace endpoint below, which ignores signing fields. We check the
  // response for the bound signer so callers can detect a set-once mismatch,
  // but a merely-unbound signer does NOT abort the marketplace registration.
  let signing: SigningRegistrationResult | undefined;
  if (opts.signingKey) {
    const proof = buildEd25519RegistrationProof(
      manifest.kernelId,
      opts.signingKey.principalPrivateKey,
    );
    const { res: signRes, body: signBody } = await postJson(
      f,
      `${base}/api/kernels`,
      headers,
      {
        id: manifest.kernelId,
        name: manifest.name,
        maxAssuranceTier: manifest.maxAssuranceTier,
        ...proof,
      },
      timeoutMs,
    );
    if (!signRes.ok) {
      throw new KernelRegistrationError(
        signRes.status,
        signBody,
        "Signing-key registration (POST /api/kernels) failed",
      );
    }
    const kernel = (signBody as { kernel?: { signingKey?: RegisteredSigner | null } } | undefined)
      ?.kernel;
    const registeredSigner = kernel?.signingKey ?? null;
    const signerBound =
      registeredSigner?.algorithm === "ed25519" &&
      typeof registeredSigner.publicKey === "string" &&
      normalizeHex(registeredSigner.publicKey) === normalizeHex(proof.signingPublicKey);
    signing = {
      signerBound,
      registeredSigner,
      provenPublicKey: proof.signingPublicKey,
    };
  }

  // ── Marketplace registration (wire unchanged from pre-#235) ────────────────
  const { res, body } = await postJson(
    f,
    `${base}/api/kernels/register`,
    headers,
    { manifest },
    timeoutMs,
  );

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
    ...(signing ? { signing } : {}),
  };
}
