/**
 * Async job handler (§8.5 step 6, §4) — the replacement for the inline synchronous
 * execute-and-return evidence flow of `createKernelHandler`.
 *
 * `createAsyncKernelHandler(opts)` returns a `handleJob(request)` that:
 *   1. validates the request + optional inbound auth (same logic as the legacy handler),
 *   2. mints ONE session key per job, with `expiresAt` sourced from the job's authorized
 *      window (falling back to the operator's `policy.maxTTLSeconds` ceiling) — the
 *      3600s clamp is gone; the gateway authoritatively rejects a delegation outside the
 *      terms-derived window at `begin`,
 *   3. calls the gateway `begin` endpoint and RETURNS IMMEDIATELY with an ack — the HTTP
 *      response no longer carries evidence (that is the entire point: a job longer than
 *      the session window can no longer hold HTTP open),
 *   4. runs `execute(input, { checkpoint })` in a TRACKED background promise. `checkpoint`
 *      submits a signed checkpoint and resolves with the verified GatewayReceipt. A rejected
 *      execute emits a `fault_report` checkpoint — never an unhandled rejection,
 *   5. on completion, emits the terminal `execution_completed` checkpoint carrying
 *      `outputHash` (the completion CLAIM under live authority, §8.1-#1), then calls
 *      `finalize` (a convenience — anyone could). On failure, emits `fault_report` and does
 *      NOT finalize (the buyer's `reclaimAfterDeadline` covers abandonment).
 *
 * DEVICE-RESTART BOUNDARY (§4-7, honest + fail-closed): the session key lives in process
 * memory. A crash mid-session orphans the session — the job never finalizes, its deadline
 * passes, and the buyer reclaims / the job goes on HOLD. A NEW session for the same job
 * (renewal / chaining via parentSessionId) is step 9, out of scope here.
 *
 * SCOPE / CHECKPOINT ACTIONS: the gateway verifies every checkpoint's `checkpointType`
 * against the session's `scope.allowedActions` (SessionKeyService check 4). So the minted
 * session authorizes exactly the checkpoint lifecycle types this handler emits
 * (`execution_completed`, `fault_report`, plus the common `execution_started` /
 * `workflow_step_completed` a builder emits through `checkpoint()`). A builder that needs
 * additional checkpoint types passes them via `opts.checkpointActions`.
 *
 * The session-key minting below is byte-identical to the legacy handler's (job-handler.ts
 * L182-220) and to the gateway's `canonicalSessionKeyBytes` (verifier), so the principal
 * (registered-signer) delegation verifies unchanged.
 */

import nacl from "tweetnacl";
import type { DigitalKernelManifest, PrincipalKey, SessionKeyAuthorization } from "@pcc/spec";
import { canonicalize, ids, sha256 } from "@pcc/spec";
import { KernelAuthError, toHex } from "./job-handler.js";
import type { KernelJobRequest } from "./job-handler.js";
import {
  CheckpointClient,
  type GatewayReceipt,
} from "./checkpoint-client.js";

// ---------------------------------------------------------------------------
// Hex helper (byte-for-byte the legacy handler's fromHex; toHex is imported)
// ---------------------------------------------------------------------------

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * The checkpoint emitter passed to the builder's `execute`. Submits one signed checkpoint
 * and resolves with the verified GatewayReceipt (or rejects with a CheckpointSubmissionError).
 * `cp.type` must be one of the session's authorized checkpoint actions (§ scope.allowedActions).
 */
export type CheckpointFn = (cp: {
  type: string;
  payload: Record<string, unknown>;
}) => Promise<GatewayReceipt>;

export interface CreateAsyncKernelHandlerOptions {
  manifest: DigitalKernelManifest;
  /** The kernel's principal (persistent) public key. */
  principalKey: PrincipalKey;
  /** The kernel's principal private key (64 bytes tweetnacl format) — signs the session key. */
  principalPrivateKey: Uint8Array;
  /**
   * Builder-supplied execution. The optional second parameter carries the `checkpoint`
   * emitter — additive, so existing single-arg `execute` implementations keep working.
   */
  execute: (
    input: Record<string, unknown>,
    ctx: { checkpoint: CheckpointFn },
  ) => Promise<Record<string, unknown>>;
  /** Gateway base URL (e.g. "https://capability.network"). */
  gatewayUrl: string;
  /** PCC API key for the gateway (transport-level Bearer auth). */
  apiKey: string;
  /** Injectable fetch (tests / Node < 18). */
  fetchImpl?: typeof fetch;
  /**
   * The checkpoint actions the minted session authorizes (scope.allowedActions). Must
   * include every `checkpointType` the builder + this handler emit. Defaults to the async
   * lifecycle set (started / step-completed / completed / fault).
   */
  checkpointActions?: string[];
  /** maxSignatures ceiling on the session (default 100). Caps the number of checkpoints. */
  maxSignatures?: number;
  /**
   * Observability hook fired when the background execute settles — lets a caller/test await
   * the async tail. Non-fatal; a throwing hook is swallowed.
   */
  onSettled?: (result: { status: "completed" | "faulted"; error?: Error }) => void;
}

/** The immediate ack returned by the async handler — evidence is delivered out-of-band. */
export interface AsyncKernelJobResponse {
  accepted: true;
  jobId: string;
  sessionId: string;
  mode: "async";
}

/** The default checkpoint lifecycle actions the async handler authorizes + emits. */
export const DEFAULT_CHECKPOINT_ACTIONS: readonly string[] = [
  "execution_started",
  "workflow_step_completed",
  "execution_completed",
  "fault_report",
];

/**
 * Build an async kernel handler.
 *
 * Usage:
 *   const handler = createAsyncKernelHandler({ manifest, principalKey, principalPrivateKey,
 *     execute, gatewayUrl, apiKey });
 *   fastify.post('/run', async (req) => handler(req.body));
 */
export function createAsyncKernelHandler(opts: CreateAsyncKernelHandlerOptions) {
  const { manifest, principalKey, principalPrivateKey, execute, gatewayUrl, apiKey } = opts;

  if (principalPrivateKey.length !== 64) {
    throw new Error(
      `createAsyncKernelHandler: principalPrivateKey must be 64 bytes (tweetnacl format), got ${principalPrivateKey.length}`,
    );
  }

  const checkpointActions = [...(opts.checkpointActions ?? DEFAULT_CHECKPOINT_ACTIONS)];
  const maxSignatures = opts.maxSignatures ?? 100;

  return async function handleJob(request: KernelJobRequest): Promise<AsyncKernelJobResponse> {
    if (!request?.jobId) {
      throw new KernelAuthError("jobId is required", 400);
    }
    if (!request.input || typeof request.input !== "object") {
      throw new KernelAuthError("input must be an object", 400);
    }

    // ── Optional inbound auth check (mirrors the legacy handler verbatim) ────────
    if (request.auth) {
      const authNow = Math.floor(Date.now() / 1000);
      if (request.auth.expiresAt < authNow) {
        throw new KernelAuthError("session_expired");
      }
      if (!manifest.sessionKeyPolicy.allowedActions.includes(request.auth.action)) {
        throw new KernelAuthError(`action '${request.auth.action}' not allowed by kernel policy`);
      }
      try {
        const data = fromHex(request.auth.eventData);
        const sig = fromHex(request.auth.sessionSignature);
        const pubkey = fromHex(request.auth.sessionPublicKey);
        const ok = nacl.sign.detached.verify(data, sig, pubkey);
        if (!ok) {
          throw new KernelAuthError("invalid_session_signature");
        }
      } catch (err) {
        if (err instanceof KernelAuthError) throw err;
        throw new KernelAuthError("malformed_auth_payload", 400);
      }
    }

    // ── Mint the session key ONCE (window from terms, not the 3600 clamp) ────────
    // expiresAt = min(authorizedWindow.expiresAt ?? ceiling, ceiling) where
    // ceiling = now + policy.maxTTLSeconds (the operator's own ceiling). The device
    // never unilaterally extends — the gateway's `begin` rejects a delegation outside
    // the terms-derived window (§2.1-3); both halves enforce, gateway authoritatively.
    const sessionKeypair = nacl.sign.keyPair();
    const now = Math.floor(Date.now() / 1000);
    const ceiling = now + manifest.sessionKeyPolicy.maxTTLSeconds;
    const requestedExpiry = request.authorizedWindow?.expiresAt ?? ceiling;
    const expiresAt = Math.min(requestedExpiry, ceiling);

    const sessionId = ids.evidence();
    const scope = {
      allowedActions: checkpointActions,
      contractIds: [request.jobId],
      maxSignatures,
    };

    // Canonical session-key bytes — explicit key order + sorted scope arrays, BYTE-IDENTICAL
    // to the gateway's `canonicalSessionKeyBytes` (verifier) and the legacy mint, so the
    // principal (registered-signer) delegation verifies unchanged. NOT `canonicalize`.
    const sessionCanonical = new TextEncoder().encode(
      JSON.stringify({
        sessionId,
        parentAgentId: principalKey.agentId,
        publicKey: toHex(sessionKeypair.publicKey),
        issuedAt: now,
        expiresAt,
        scope: {
          allowedActions: [...scope.allowedActions].sort(),
          contractIds: [...scope.contractIds].sort(),
          maxSignatures: scope.maxSignatures,
        },
      }),
    );
    const parentSignature = nacl.sign.detached(sessionCanonical, principalPrivateKey);

    const sessionKeyAuthorization: SessionKeyAuthorization = {
      sessionId,
      parentAgentId: principalKey.agentId,
      publicKey: toHex(sessionKeypair.publicKey),
      issuedAt: now,
      expiresAt,
      scope,
      parentSignature: toHex(parentSignature),
    };

    // ── Open the window at the gateway, then return the ack immediately ──────────
    const client = new CheckpointClient({
      gatewayUrl,
      apiKey,
      jobId: request.jobId,
      milestoneIndex: 0,
      sessionKeyAuthorization,
      sessionPrivateKey: sessionKeypair.secretKey,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    const begun = await client.begin();

    // ── Background execute — tracked promise; a rejection becomes a fault_report ──
    void (async () => {
      const checkpoint: CheckpointFn = (cp) =>
        client.submitCheckpoint({ type: cp.type, events: cp.payload });
      try {
        const output = await execute(request.input, { checkpoint });
        // Terminal completion CLAIM under live authority (§8.1-#1), then finalize.
        const outputHash = await sha256(canonicalize(output));
        await checkpoint({
          type: "execution_completed",
          payload: { jobId: request.jobId, kernelId: manifest.kernelId, outputHash },
        });
        await client.finalize();
        safeSettled(opts.onSettled, { status: "completed" });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        // Emit a fault_report under live authority; do NOT finalize on failure. Best-effort:
        // a failed fault emission must never surface as an unhandled rejection.
        try {
          await checkpoint({
            type: "fault_report",
            payload: { jobId: request.jobId, kernelId: manifest.kernelId, error: error.message },
          });
        } catch {
          /* fault emission is best-effort; the deadline/reclaim path covers abandonment */
        }
        safeSettled(opts.onSettled, { status: "faulted", error });
      }
    })();

    return {
      accepted: true,
      jobId: request.jobId,
      sessionId: begun.sessionId,
      mode: "async",
    };
  };
}

/** Invoke the optional settled hook without letting it throw into the background tail. */
function safeSettled(
  hook: CreateAsyncKernelHandlerOptions["onSettled"],
  result: { status: "completed" | "faulted"; error?: Error },
): void {
  if (!hook) return;
  try {
    hook(result);
  } catch {
    /* observability hook is non-fatal */
  }
}
