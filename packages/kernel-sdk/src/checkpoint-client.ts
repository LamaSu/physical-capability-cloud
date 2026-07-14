/**
 * Checkpoint client (§8.5 step 6, §4.5) — the device-side HTTP client for the three
 * async evidence endpoints. It opens the session window (`begin`), submits signed
 * checkpoints one at a time and verifies each returned GatewayReceipt (`submitCheckpoint`),
 * and assembles the claim-free package (`finalize`). It holds the device's local view of
 * the accepted chain (`seq`, `lastAcceptedHash`) and the payloads it must reveal at finalize.
 *
 * CROSS-WAVE CONTRACT (must be byte-identical to the gateway/Wave-3 side, or every
 * checkpoint 403s / the receipt fails to verify):
 *   - Canonical checkpoint CONTENT signed by the session key (sans signature):
 *       { sessionId, seq, createdAt, prevCheckpointHash, eventsRoot, checkpointType }
 *     EXACTLY these six keys; `prevCheckpointHash` is an explicit JSON `null` at genesis
 *     (never omitted). Serialized with `@pcc/spec` `canonicalize` — the SAME serializer the
 *     gateway uses (sorts keys at all depths, includes null, omits undefined), so key order
 *     here is irrelevant but the field must never be `undefined`.
 *   - eventsRoot = "sha256:" + sha256hex(utf8(canonicalize(events))). Computed here via
 *     `@pcc/spec` `sha256(canonicalize(events))`, which is BYTE-IDENTICAL to the gateway's
 *     synchronous `node:crypto` `createHash("sha256").update(canonicalize(events))` — same
 *     utf8(canonicalize)→SHA-256→"sha256:"+hex. (Kept on @pcc/spec, the SDK's existing
 *     hashing path, so the published SDK stays free of a node:crypto/@types/node build dep;
 *     the tests independently recompute with node:crypto to prove the equality.)
 *   - The session signature is Ed25519 over utf8(canonicalize(content)) with the session
 *     PRIVATE key (tweetnacl `nacl.sign.detached`).
 *   - The GatewayReceipt is Ed25519-signed by the gateway over canonicalize(receipt sans
 *     signature); we VERIFY it against the `gatewayReceiptPublicKey` `begin` returned. A
 *     receipt that fails verification is NOT proof — we surface it and do NOT advance the
 *     chain on it. (tweetnacl verifies the gateway's node:crypto raw Ed25519 signature —
 *     RFC 8032, the same cross-library compatibility `signing-proof.test.ts` already proves.)
 *
 * EMITTER DISCIPLINE (§4.5): STRICTLY SERIAL — one in-flight submission, the rest queued.
 * WHY: `prevCheckpointHash` must equal the last ACCEPTED hash (§8.4-A-5); parallel submits
 * make rejection cascades ambiguous. Resume on blip: a `409 checkpoint_rejected` with reason
 * `seq_gap_or_replay` after a network hiccup → re-`begin` (idempotent) → resync
 * `nextSeq`/`lastAcceptedHash` → resubmit from there ONCE. An `idempotent` 200 → treat as
 * accepted (receipt already minted), advance. Any other rejection (equivocation, a second
 * failure on the same seq, 4xx) → STOP emitting and surface the reason: two failures on one
 * seq means the local chain state is wrong, not something to blind-retry.
 */

import nacl from "tweetnacl";
import { canonicalize, sha256 } from "@pcc/spec";
import type { SessionKeyAuthorization } from "@pcc/spec";
import { toHex, fromHex } from "./job-handler.js";

// ── The wire shapes this client speaks (§2.1/§2.2/§2.3) ──────────────────────────

/**
 * The §8.3 GatewayReceipt the gateway returns for an accepted checkpoint. Structural
 * mirror of the gateway's interface — the SDK CANNOT import from `@pcc/gateway` (a heavy,
 * private workspace package; depending on it would make the SDK unpublishable), so the
 * client defines the wire shape it expects and verifies the signature cryptographically.
 * The 10 fields (incl. `signature`) are exactly what the gateway signs + returns.
 */
export interface GatewayReceipt {
  receiptId: string;
  gatewayKeyId: string;
  jobId: string;
  sessionId: string;
  seq: number;
  checkpointHash: string;
  previousAcceptedHash: string | null;
  sessionStateVersion: number;
  acceptedAt: number;
  signature: string;
}

/** Response of `POST /api/jobs/:jobId/evidence/begin` (§2.1). */
export interface BeginEvidenceResponse {
  sessionId: string;
  window: { notBefore: number; expiresAt: number; evidenceSubmissionDeadline: number };
  maxSignatures: number;
  nextSeq: number;
  lastAcceptedHash: string | null;
  gatewayReceiptPublicKey: string;
  checkpointPath: string;
  finalizePath: string;
  idempotent?: boolean;
}

/** Response of `POST /api/jobs/:jobId/evidence/finalize` (§2.3). */
export interface FinalizeMilestoneResponse {
  package: unknown;
  packageReceipt: unknown;
  evidenceRoot: string;
  packageHash: string;
  idempotent?: boolean;
}

/** A payload revelation for finalize — each `events` value must hash to its receipted eventsRoot. */
export interface RevealedPayload {
  seq: number;
  events: unknown;
}

export interface CheckpointClientOptions {
  /** Gateway base URL (e.g. "https://capability.network"). */
  gatewayUrl: string;
  /** PCC API key — sent as `Authorization: Bearer <key>` (transport-level only). */
  apiKey: string;
  jobId: string;
  /** Default 0 (single-milestone flow today). */
  milestoneIndex?: number;
  /** The delegation opened at `begin` and stored for idempotent re-begin on resync. */
  sessionKeyAuthorization: SessionKeyAuthorization;
  /** The session PRIVATE key (64-byte tweetnacl secret key) that signs each checkpoint. */
  sessionPrivateKey: Uint8Array;
  /** Injectable fetch (tests / Node < 18). Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (default 15000). */
  timeoutMs?: number;
}

/** Thrown when a checkpoint/begin/finalize call fails in a non-recoverable way. */
export class CheckpointSubmissionError extends Error {
  constructor(
    public readonly reason: string,
    public readonly statusCode: number,
    public readonly body?: unknown,
  ) {
    super(`checkpoint client: ${reason} (status ${statusCode})`);
    this.name = "CheckpointSubmissionError";
  }
}

function stripHexPrefix(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/** The device's own clock at submission, Unix SECONDS (advisory `createdAt`, skew-flag only). */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export class CheckpointClient {
  private readonly gatewayUrl: string;
  private readonly apiKey: string;
  private readonly jobId: string;
  private readonly milestoneIndex: number;
  private readonly auth: SessionKeyAuthorization;
  private readonly sessionPrivateKey: Uint8Array;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;

  // ── Local chain state (populated / resynced by begin) ──────────────────────────
  /** The gateway-confirmed session id — set by begin; used in every checkpoint's content. */
  sessionId: string | null = null;
  /** Raw 32-byte hex of the gateway receipt-signing key — set by begin; verifies receipts. */
  gatewayReceiptPublicKey: string | null = null;
  /** Next seq to submit (first accepted checkpoint is seq 1). */
  seq = 1;
  /** Chain tip = last ACCEPTED checkpoint hash; `null` at genesis (→ prevCheckpointHash). */
  lastAcceptedHash: string | null = null;

  /** Kept payloads keyed by seq, for revelation at finalize (§8.1-#1). */
  private readonly payloadsBySeq = new Map<number, unknown>();

  /**
   * The EXACT bytes of the in-flight checkpoint for the current seq (S6-4). Retained across
   * retries so an uncertain-commit retry reuses the SAME createdAt/hash (never a fork), and
   * cleared once a verified receipt advances the chain.
   */
  private pending: {
    seq: number;
    content: {
      sessionId: string;
      seq: number;
      createdAt: number;
      prevCheckpointHash: string | null;
      eventsRoot: string;
      checkpointType: string;
    };
    signature: string;
    checkpointHash: string;
    events: unknown;
  } | null = null;

  /** Serial-emitter mutex: one in-flight submission; the rest queue behind this. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Set once a non-recoverable failure occurs — further submits fail fast (stop emitting). */
  private broken: { reason: string; statusCode: number; body?: unknown } | null = null;

  constructor(opts: CheckpointClientOptions) {
    if (opts.sessionPrivateKey.length !== 64) {
      throw new Error(
        `CheckpointClient: sessionPrivateKey must be 64 bytes (tweetnacl secretKey), got ${opts.sessionPrivateKey.length}`,
      );
    }
    const f = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
    if (!f) {
      throw new Error("CheckpointClient: fetch is not available — pass opts.fetchImpl (Node < 18)");
    }
    this.gatewayUrl = opts.gatewayUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.jobId = opts.jobId;
    this.milestoneIndex = opts.milestoneIndex ?? 0;
    this.auth = opts.sessionKeyAuthorization;
    this.sessionPrivateKey = opts.sessionPrivateKey;
    this.f = f;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /**
   * Open (or idempotently re-open) the execution-authority window. Sets the local chain
   * state from the gateway's response (`nextSeq`, `lastAcceptedHash`) and the receipt
   * verification key. Idempotent by design (§2.1-4) — safe to call again during resync.
   */
  async begin(): Promise<BeginEvidenceResponse> {
    const { status, body } = await this.post(`/api/jobs/${this.jobId}/evidence/begin`, {
      sessionKeyAuthorization: this.auth,
      milestoneIndex: this.milestoneIndex,
    });
    if (status !== 201 && status !== 200) {
      const b = body as { error?: string; reason?: string } | undefined;
      throw new CheckpointSubmissionError(b?.reason ?? b?.error ?? `begin_failed`, status, body);
    }
    const res = body as BeginEvidenceResponse;
    if (
      !res ||
      typeof res.sessionId !== "string" ||
      typeof res.gatewayReceiptPublicKey !== "string" ||
      !Number.isInteger(res.nextSeq)
    ) {
      throw new CheckpointSubmissionError("begin_response_malformed", status, body);
    }
    this.sessionId = res.sessionId;
    this.gatewayReceiptPublicKey = res.gatewayReceiptPublicKey;
    this.seq = res.nextSeq;
    this.lastAcceptedHash = res.lastAcceptedHash ?? null;
    return res;
  }

  /**
   * Submit one checkpoint. STRICTLY SERIAL — queued behind any in-flight submission so
   * `prevCheckpointHash` always equals the last accepted hash (§4.5). Resolves with the
   * verified GatewayReceipt, or rejects with a `CheckpointSubmissionError`.
   */
  submitCheckpoint(cp: { type: string; events: Record<string, unknown> }): Promise<GatewayReceipt> {
    // Chain on the queue's SETTLEMENT (success OR failure) so a prior rejection does not
    // break the chain, but each caller still observes its own result via `run`.
    const run = this.queue.then(
      () => this.submitOne(cp, true),
      () => this.submitOne(cp, true),
    );
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async submitOne(
    cp: { type: string; events: Record<string, unknown> },
    allowResync: boolean,
  ): Promise<GatewayReceipt> {
    if (this.broken) {
      throw new CheckpointSubmissionError(this.broken.reason, this.broken.statusCode, this.broken.body);
    }
    if (!this.sessionId) {
      throw new CheckpointSubmissionError("begin_not_called", 0);
    }
    // Build the pending checkpoint ONCE per seq position, then reuse it verbatim on any retry
    // (S6-4: never regenerate createdAt — the EXACT bytes must be reproducible so an
    // uncertain-commit retry recovers the committed receipt instead of forking the hash).
    if (!this.pending || this.pending.seq !== this.seq) {
      const eventsRoot = await sha256(canonicalize(cp.events));
      const content = {
        sessionId: this.sessionId,
        seq: this.seq,
        createdAt: nowSeconds(),
        prevCheckpointHash: this.lastAcceptedHash, // explicit null at genesis
        eventsRoot,
        checkpointType: cp.type,
      };
      const canonical = canonicalize(content);
      const signature = toHex(nacl.sign.detached(new TextEncoder().encode(canonical), this.sessionPrivateKey));
      const checkpointHash = await sha256(canonical);
      this.pending = { seq: this.seq, content, signature, checkpointHash, events: cp.events };
    }
    return this.sendPending(cp, allowResync);
  }

  /**
   * POST the retained pending checkpoint. On a network/timeout error the outcome is UNCERTAIN
   * (the server may or may not have committed) → recover deterministically (§4.5, S6-4).
   */
  private async sendPending(
    cp: { type: string; events: Record<string, unknown> },
    allowResync: boolean,
  ): Promise<GatewayReceipt> {
    const pending = this.pending!;
    const canonical = canonicalize(pending.content);
    let status: number;
    let body: unknown;
    try {
      ({ status, body } = await this.post(`/api/jobs/${this.jobId}/evidence/checkpoints`, {
        ...pending.content,
        signature: pending.signature,
      }));
    } catch (err) {
      return this.recoverUncertain(cp, allowResync, err);
    }
    const b = body as { receipt?: GatewayReceipt; idempotent?: boolean; error?: string; reason?: string } | undefined;

    // 201 accepted / 200 idempotent — both carry a receipt; verify then advance.
    const receipt = b?.receipt;
    if (receipt && (status === 201 || (status === 200 && b?.idempotent))) {
      return this.acceptReceipt(receipt, canonical, pending.seq, pending.events, status, body);
    }

    // A plain sequence reject after a blip → resync from begin, then recover-or-resubmit ONCE.
    if (
      status === 409 &&
      b?.error === "checkpoint_rejected" &&
      b?.reason === "seq_gap_or_replay" &&
      allowResync
    ) {
      return this.resyncAndRetry(cp);
    }

    // Non-recoverable: equivocation, a second seq failure, or any 4xx — stop emitting.
    const reason = b?.reason ?? b?.error ?? `http_${status}`;
    this.broken = { reason, statusCode: status, body };
    throw new CheckpointSubmissionError(reason, status, body);
  }

  /**
   * Uncertain outcome (network/timeout): re-read the durable tip and either recover the
   * already-committed receipt (tip == our checkpoint) or resubmit the EXACT same bytes once
   * (tip still at our prev). Never regenerates the checkpoint (that would fork the hash).
   */
  private async recoverUncertain(
    cp: { type: string; events: Record<string, unknown> },
    allowResync: boolean,
    err: unknown,
  ): Promise<GatewayReceipt> {
    const pending = this.pending!;
    // S6-4b: retrieving an ALREADY-COMMITTED receipt must NOT require live execution authority.
    // begin() now rejects a delegation past expiresAt (S6-3), and the long-job boundary is
    // EXACTLY where the final checkpoint can commit just before expiry and its response be lost —
    // so try the READ-ONLY receipt lookup FIRST. A committed receipt is proof regardless of
    // whether the delegation is still live; only SUBMITTING new work needs live authority.
    const recovered = await this.tryFetchReceipt(pending.seq);
    if (recovered) {
      // acceptReceipt re-verifies the signature AND that it attests OUR exact checkpoint — a
      // receipt for a different checkpoint at our seq → broken (genuine fork), never a false accept.
      return this.acceptReceipt(
        recovered,
        canonicalize(pending.content),
        pending.seq,
        pending.events,
        200,
        { recovered: true },
      );
    }
    // No committed receipt at our seq → our checkpoint was NOT accepted. RESUBMITTING requires
    // live authority: begin() re-reads the tip and legitimately 422s if the delegation has expired
    // (authoring NEW work under dead authority is forbidden — distinct from retrieving old proof).
    if (!allowResync) {
      // Already recovered once — surface the uncertain outcome rather than loop.
      this.broken = { reason: "uncertain_commit", statusCode: 0 };
      throw new CheckpointSubmissionError(
        "uncertain_commit",
        0,
        err instanceof Error ? err.message : String(err),
      );
    }
    await this.begin(); // idempotent — re-reads the durable tip (lastAcceptedHash / nextSeq)
    if (this.lastAcceptedHash === pending.checkpointHash) {
      // Committed after all (raced our GET) — recover its receipt; never re-submit.
      const receipt = await this.fetchReceipt(pending.seq);
      return this.acceptReceipt(
        receipt,
        canonicalize(pending.content),
        pending.seq,
        pending.events,
        200,
        { recovered: true },
      );
    }
    if (this.seq === pending.seq) {
      // NOT committed (tip is still our prev) — resubmit the EXACT same bytes, once.
      return this.sendPending(cp, false);
    }
    // The chain moved unexpectedly (tip is neither our checkpoint nor our prev) — ambiguous.
    this.broken = { reason: "uncertain_commit_chain_moved", statusCode: 0 };
    throw new CheckpointSubmissionError("uncertain_commit_chain_moved", 0);
  }

  /**
   * Resync after a 409 seq reject: if our pending checkpoint turns out to BE the tip (a replay
   * of one that was actually accepted), recover its receipt; else rebuild for the resynced
   * position and submit once.
   */
  private async resyncAndRetry(
    cp: { type: string; events: Record<string, unknown> },
  ): Promise<GatewayReceipt> {
    await this.begin(); // idempotent — re-reads nextSeq / lastAcceptedHash
    if (this.pending && this.lastAcceptedHash === this.pending.checkpointHash) {
      const receipt = await this.fetchReceipt(this.pending.seq);
      return this.acceptReceipt(
        receipt,
        canonicalize(this.pending.content),
        this.pending.seq,
        this.pending.events,
        200,
        { recovered: true },
      );
    }
    this.pending = null; // stale position — rebuild for the resynced seq
    return this.submitOne(cp, false);
  }

  /** GET a committed receipt for a seq (S6-4 recovery). Throws if the gateway has none. */
  private async fetchReceipt(seq: number): Promise<GatewayReceipt> {
    const { status, body } = await this.get(
      `/api/jobs/${this.jobId}/evidence/sessions/${this.sessionId}/receipts/${seq}`,
    );
    const b = body as { receipt?: GatewayReceipt } | undefined;
    if (status !== 200 || !b?.receipt) {
      throw new CheckpointSubmissionError("receipt_recovery_failed", status, body);
    }
    return b.receipt;
  }

  /**
   * Read-only receipt lookup for the S6-4b uncertain-recovery path. Returns null when the gateway
   * has NO committed receipt at `seq` (a clean absent → our checkpoint was not accepted) instead
   * of throwing, so recovery can distinguish "committed, retrieve it" from "not committed,
   * resubmit". A transient error also returns null → the caller falls through to begin()/resubmit,
   * which surfaces the uncertainty honestly. Crucially this needs NO live authority, so it works
   * after the delegation has expired — the exact long-job boundary the async split exists for.
   *
   * NOTE (memory-only pending): the exact pending bytes live in `this.pending` (process memory).
   * A device-process restart between commit and recovery loses automatic receipt-recovery here.
   * Persisting `pending` to durable device storage is a follow-up; finalization no longer depends
   * on it (payloads are revealed independently — round-5 payloads-out).
   */
  private async tryFetchReceipt(seq: number): Promise<GatewayReceipt | null> {
    try {
      const { status, body } = await this.get(
        `/api/jobs/${this.jobId}/evidence/sessions/${this.sessionId}/receipts/${seq}`,
      );
      const b = body as { receipt?: GatewayReceipt } | undefined;
      if (status === 200 && b?.receipt) return b.receipt;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Verify a returned receipt and, only if it is genuine proof, advance the local chain.
   * A receipt whose signature does NOT verify — or that attests a different checkpoint than
   * we submitted — is NOT proof: we mark the client broken and surface it, never advancing.
   */
  private async acceptReceipt(
    receipt: GatewayReceipt,
    submittedCanonical: string,
    submittedSeq: number,
    events: unknown,
    status: number,
    body: unknown,
  ): Promise<GatewayReceipt> {
    if (!this.verifyReceiptSignature(receipt)) {
      this.broken = { reason: "receipt_signature_invalid", statusCode: status, body };
      throw new CheckpointSubmissionError("receipt_signature_invalid", status, body);
    }
    // Defensive: the (signed, authentic) receipt must attest OUR checkpoint. checkpointHash
    // is recomputed the SAME way the gateway computes it — "sha256:"+sha256hex(canonical) —
    // which also re-proves our canonicalize(content) matches the gateway's byte-for-byte.
    const expectedHash = await sha256(submittedCanonical);
    if (
      receipt.sessionId !== this.sessionId ||
      receipt.seq !== submittedSeq ||
      receipt.checkpointHash !== expectedHash
    ) {
      this.broken = { reason: "receipt_mismatch", statusCode: status, body };
      throw new CheckpointSubmissionError("receipt_mismatch", status, body);
    }
    // Genuine proof — keep the payload for finalize revelation and advance the chain.
    this.payloadsBySeq.set(receipt.seq, events);
    this.lastAcceptedHash = receipt.checkpointHash;
    this.seq = receipt.seq + 1;
    this.pending = null; // S6-4: the pending checkpoint is now durably receipted — release it.
    return receipt;
  }

  /** Ed25519-verify the receipt over canonicalize(receipt sans signature), vs the gateway key. */
  private verifyReceiptSignature(receipt: GatewayReceipt): boolean {
    if (!receipt || typeof receipt.signature !== "string" || !this.gatewayReceiptPublicKey) {
      return false;
    }
    const { signature, ...content } = receipt;
    let sig: Uint8Array;
    let pub: Uint8Array;
    try {
      sig = fromHex(stripHexPrefix(signature));
      pub = fromHex(stripHexPrefix(this.gatewayReceiptPublicKey));
    } catch {
      return false;
    }
    if (sig.length !== 64 || pub.length !== 32) return false;
    try {
      const bytes = new TextEncoder().encode(canonicalize(content));
      return nacl.sign.detached.verify(bytes, sig, pub);
    } catch {
      return false;
    }
  }

  /**
   * Close the window and assemble the claim-free package (§2.3). With no `payloads` arg,
   * reveals every kept payload (seq order). Permissionless-in-principle — the gateway
   * recomputes everything from its own store, so this needs no session signature.
   */
  async finalize(payloads?: RevealedPayload[]): Promise<FinalizeMilestoneResponse> {
    if (!this.sessionId) throw new CheckpointSubmissionError("begin_not_called", 0);
    // S6-5: revelation is a SEPARATE, verified step from finalization. Reveal every kept
    // payload (the gateway checks each against its receipted eventsRoot), THEN finalize with
    // NO payloads — the gateway includes all durably-revealed payloads itself, so a
    // permissionless keeper cannot exclude ours. Reveal is idempotent, so a retried finalize
    // re-reveals harmlessly.
    const revealed =
      payloads ??
      [...this.payloadsBySeq.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([seq, events]) => ({ seq, events }));
    for (const p of revealed) {
      const { status, body } = await this.post(
        `/api/jobs/${this.jobId}/evidence/checkpoints/${p.seq}/reveal`,
        { sessionId: this.sessionId, events: p.events },
      );
      if (status !== 200) {
        const b = body as { error?: string } | undefined;
        throw new CheckpointSubmissionError(b?.error ?? "reveal_failed", status, body);
      }
    }
    const { status, body } = await this.post(`/api/jobs/${this.jobId}/evidence/finalize`, {
      milestoneIndex: this.milestoneIndex,
    });
    if (status !== 201 && status !== 200) {
      const b = body as { error?: string } | undefined;
      throw new CheckpointSubmissionError(b?.error ?? `finalize_failed`, status, body);
    }
    return body as FinalizeMilestoneResponse;
  }

  /** POST a JSON body with a per-request timeout; parse the JSON response (or undefined). */
  private async post(path: string, jsonBody: unknown): Promise<{ status: number; body: unknown }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.f(`${this.gatewayUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(jsonBody),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = undefined;
    }
    return { status: res.status, body: parsed };
  }

  /** GET with a per-request timeout; parse the JSON response (or undefined). (S6-4 recovery.) */
  private async get(path: string): Promise<{ status: number; body: unknown }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.f(`${this.gatewayUrl}${path}`, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${this.apiKey}` },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = undefined;
    }
    return { status: res.status, body: parsed };
  }
}
