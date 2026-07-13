/**
 * Job handler for third-party digital kernels.
 *
 * `createKernelHandler` wraps a builder-supplied `execute` function with:
 *   - Ed25519 session signature verification on the inbound request
 *   - Scope + expiry check against the manifest's sessionKeyPolicy
 *   - Evidence bundle assembly (events for step traces + lifecycle)
 *   - Session-key signature plus principal-authorised delegation proof
 *
 * The handler is Fastify-compatible (accepts `{body}`, returns a JSON-
 * serialisable object) but has no hard Fastify dependency — it's a plain
 * async function so builders can wire it into Express, Hono, or any other
 * server.
 */

import nacl from "tweetnacl";
import type {
  DigitalKernelManifest,
  EvidenceBundle,
  EvidenceEvent,
  EvidenceSource,
  PrincipalKey,
  SessionAction,
  SessionKey,
  SHA256,
} from "@pcc/spec";
import { canonicalize, ids, sha256 } from "@pcc/spec";

// ---------------------------------------------------------------------------
// Hex helpers (serialising bytes over JSON)
// ---------------------------------------------------------------------------

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Inbound request shape
// ---------------------------------------------------------------------------

/**
 * JSON shape of an inbound job request the gateway (or any caller) makes to
 * a kernel's endpointURL.
 *
 * The client-sessionKey is the key the *caller* holds — the kernel verifies
 * it to prove the caller is authorized to start a job. The kernel does NOT
 * use this key for evidence signing; it mints its own for that.
 */
export interface KernelJobRequest {
  /** Unique job id chosen by the caller (gateway) */
  jobId: string;
  /** Payload forwarded to the builder's execute() */
  input: Record<string, unknown>;
  /** Optional client-side session-signed event authorising the call */
  auth?: {
    /** Hex-encoded canonical event body the caller signed */
    eventData: string;
    /** Hex-encoded Ed25519 signature (64 bytes) */
    sessionSignature: string;
    /** Hex-encoded session key public key (32 bytes) */
    sessionPublicKey: string;
    /** One of the actions in manifest.sessionKeyPolicy.allowedActions */
    action: string;
    /** Unix seconds — session must not be expired */
    expiresAt: number;
  };
}

/** Response returned by `createKernelHandler` for a successful execution. */
export interface KernelJobResponse {
  /** Signed + hashed evidence bundle */
  evidenceBundle: EvidenceBundle;
  /** Output payload returned by the builder's execute() */
  output: Record<string, unknown>;
  /** Session key used by the kernel to sign evidence (hex pubkey) */
  kernelSessionPublicKey: string;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export interface CreateKernelHandlerOptions {
  manifest: DigitalKernelManifest;
  /**
   * The kernel's principal (persistent) public key. Used to derive a session
   * key on each call so evidence is signed by the kernel identity.
   */
  principalKey: PrincipalKey;
  /**
   * The kernel's principal private key (64 bytes tweetnacl format).
   * Used to sign the session key struct and the evidence bundle hash.
   */
  principalPrivateKey: Uint8Array;
  /** Builder-supplied execution function. Must return a JSON-serialisable value. */
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/** Returned when inbound auth fails a check. */
export class KernelAuthError extends Error {
  constructor(
    public readonly reason: string,
    public readonly statusCode = 401,
  ) {
    super(reason);
    this.name = "KernelAuthError";
  }
}

/**
 * Build a kernel handler function.
 *
 * Usage:
 *   const handler = createKernelHandler({manifest, principalKey, principalPrivateKey, execute});
 *   fastify.post('/run', async (req) => handler(req.body));
 */
export function createKernelHandler(opts: CreateKernelHandlerOptions) {
  const { manifest, principalKey, principalPrivateKey, execute } = opts;

  if (principalPrivateKey.length !== 64) {
    throw new Error(
      `createKernelHandler: principalPrivateKey must be 64 bytes (tweetnacl format), got ${principalPrivateKey.length}`,
    );
  }

  return async function handleJob(
    request: KernelJobRequest,
  ): Promise<KernelJobResponse> {
    if (!request?.jobId) {
      throw new KernelAuthError("jobId is required", 400);
    }
    if (!request.input || typeof request.input !== "object") {
      throw new KernelAuthError("input must be an object", 400);
    }

    // ── Optional inbound auth check ─────────────────────────────────────
    // Kernels may be advertised as open (no auth required) or locked to
    // sessionKey-authenticated callers. If `auth` is provided, we verify:
    //   1. the signature matches the caller's session public key
    //   2. the action is in manifest.sessionKeyPolicy.allowedActions
    //   3. the session has not expired

    if (request.auth) {
      const now = Math.floor(Date.now() / 1000);
      if (request.auth.expiresAt < now) {
        throw new KernelAuthError("session_expired");
      }
      if (!manifest.sessionKeyPolicy.allowedActions.includes(request.auth.action)) {
        throw new KernelAuthError(
          `action '${request.auth.action}' not allowed by kernel policy`,
        );
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

    // ── Mint a session key for this job ─────────────────────────────────
    // The kernel signs the bundle with a fresh Ed25519 keypair; the session
    // key struct is authorised by the kernel's principal private key. This
    // mirrors the @pcc/verifier SessionKeyService pattern.

    const sessionKeypair = nacl.sign.keyPair();
    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.min(manifest.sessionKeyPolicy.maxTTLSeconds, 3600);

    const sessionKeyBody = {
      sessionId: ids.evidence(),
      parentAgentId: principalKey.agentId,
      publicKey: sessionKeypair.publicKey,
      issuedAt: now,
      expiresAt: now + ttl,
      scope: {
        allowedActions: [
          "evidence_submit",
          "workflow_step_complete",
        ] as SessionAction[],
        contractIds: [request.jobId],
        maxSignatures: 100,
      },
    };

    const sessionCanonical = new TextEncoder().encode(
      JSON.stringify({
        sessionId: sessionKeyBody.sessionId,
        parentAgentId: sessionKeyBody.parentAgentId,
        publicKey: toHex(sessionKeyBody.publicKey),
        issuedAt: sessionKeyBody.issuedAt,
        expiresAt: sessionKeyBody.expiresAt,
        scope: {
          allowedActions: [...sessionKeyBody.scope.allowedActions].sort(),
          contractIds: [...sessionKeyBody.scope.contractIds].sort(),
          maxSignatures: sessionKeyBody.scope.maxSignatures,
        },
      }),
    );
    const parentSig = nacl.sign.detached(sessionCanonical, principalPrivateKey);
    const sessionKey: SessionKey = {
      ...sessionKeyBody,
      parentSignature: parentSig,
    };

    // ── Execute the builder's code ──────────────────────────────────────
    const executionStart = new Date().toISOString();
    const output = await execute(request.input);
    const executionEnd = new Date().toISOString();

    // ── Assemble evidence events ────────────────────────────────────────
    const source: EvidenceSource = {
      deviceId: manifest.kernelId,
      deviceType: "digital_agent",
      kernelId: manifest.kernelId,
    };

    const events: EvidenceEvent[] = [];

    // Input commitment
    const inputHash = await sha256(canonicalize(request.input));
    const inputEvent: EvidenceEvent = {
      id: ids.evidence(),
      type: "gcode_hash_verified",
      timestamp: executionStart,
      source,
      payload: {
        description: "Input data committed",
        inputHash,
        kernelId: manifest.kernelId,
        capabilityType: manifest.capabilityType,
      },
      hash: "" as SHA256,
    };
    inputEvent.hash = await sha256(
      canonicalize({
        type: inputEvent.type,
        timestamp: inputEvent.timestamp,
        source: inputEvent.source,
        payload: inputEvent.payload,
      }),
    );
    events.push(inputEvent);

    // Execution started
    const startEvent: EvidenceEvent = {
      id: ids.evidence(),
      type: "execution_started",
      timestamp: executionStart,
      source,
      payload: {
        jobId: request.jobId,
        kernelId: manifest.kernelId,
        stepCount: manifest.workflowSteps.length,
      },
      hash: "" as SHA256,
    };
    startEvent.hash = await sha256(
      canonicalize({
        type: startEvent.type,
        timestamp: startEvent.timestamp,
        source: startEvent.source,
        payload: startEvent.payload,
      }),
    );
    events.push(startEvent);

    // Per-step completion events (declarative — one per manifest step)
    for (const step of manifest.workflowSteps) {
      const stepEvent: EvidenceEvent = {
        id: ids.evidence(),
        type: "workflow_step_completed",
        timestamp: new Date().toISOString(),
        source,
        payload: {
          stepId: step.stepId,
          stepType: step.stepType,
          description: step.description,
        },
        hash: "" as SHA256,
      };
      stepEvent.hash = await sha256(
        canonicalize({
          type: stepEvent.type,
          timestamp: stepEvent.timestamp,
          source: stepEvent.source,
          payload: stepEvent.payload,
        }),
      );
      events.push(stepEvent);
    }

    // Output commitment
    const outputHash = await sha256(canonicalize(output));

    // Execution completed
    const completedEvent: EvidenceEvent = {
      id: ids.evidence(),
      type: "execution_completed",
      timestamp: executionEnd,
      source,
      payload: {
        jobId: request.jobId,
        kernelId: manifest.kernelId,
        outputHash,
      },
      hash: "" as SHA256,
    };
    completedEvent.hash = await sha256(
      canonicalize({
        type: completedEvent.type,
        timestamp: completedEvent.timestamp,
        source: completedEvent.source,
        payload: completedEvent.payload,
      }),
    );
    events.push(completedEvent);

    // ── Finalise bundle (hash + sign with sessionKey) ───────────────────
    const sortedHashes = events.map((e) => e.hash).sort();
    const bundleHash = await sha256(canonicalize(sortedHashes));
    const bundleHashBytes = new TextEncoder().encode(bundleHash);
    const bundleSig = nacl.sign.detached(bundleHashBytes, sessionKeypair.secretKey);

    const evidenceBundle: EvidenceBundle = {
      id: ids.bundle(),
      jobId: request.jobId,
      stepId: manifest.kernelId,
      kernelId: manifest.kernelId,
      assuranceTier: 0,
      events,
      bundleHash,
      kernelSignature: {
        signer: `0x${toHex(sessionKey.publicKey).slice(0, 40)}` as `0x${string}`,
        algorithm: "ed25519",
        value: toHex(bundleSig),
      },
      sessionKeyAuthorization: {
        sessionId: sessionKey.sessionId,
        parentAgentId: sessionKey.parentAgentId,
        publicKey: toHex(sessionKey.publicKey),
        issuedAt: sessionKey.issuedAt,
        expiresAt: sessionKey.expiresAt,
        scope: sessionKey.scope,
        parentSignature: toHex(sessionKey.parentSignature),
      },
      createdAt: new Date().toISOString(),
    };

    return {
      evidenceBundle,
      output,
      kernelSessionPublicKey: toHex(sessionKey.publicKey),
    };
  };
}

/** Verify an EvidenceBundle signature against a known session public key. */
export function verifyBundleSignature(
  bundle: EvidenceBundle,
  sessionPublicKey: Uint8Array,
): boolean {
  try {
    const bundleHashBytes = new TextEncoder().encode(bundle.bundleHash);
    const sig = fromHex(bundle.kernelSignature.value);
    return nacl.sign.detached.verify(bundleHashBytes, sig, sessionPublicKey);
  } catch {
    return false;
  }
}

export { toHex, fromHex };
