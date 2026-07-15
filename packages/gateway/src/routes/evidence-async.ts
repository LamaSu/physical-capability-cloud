/**
 * Async evidence-signing endpoints (§8.5 step 6) — the three phase-scoped gateway
 * routes that replace the inline synchronous execute-and-return evidence flow:
 *
 *   POST /api/jobs/:jobId/evidence/begin       — open the execution-authority window (§2.1)
 *   POST /api/jobs/:jobId/evidence/checkpoints — submit one checkpoint, get a signed receipt (§2.2)
 *   POST /api/jobs/:jobId/evidence/finalize    — assemble the claim-free package (§2.3)
 *
 * This route is HTTP MAPPING ONLY. It composes the three services that own the
 * money-path invariants — `EvidenceSessionStore` (window-from-terms + one-open-session),
 * `GatewayReceiptStore.record` (transactional per-checkpoint receipt, §8.3), and
 * `MilestonePackageStore.finalize` (§8.4-B claim-free package) — and the verifier
 * composition proven in `device-evidence-settlement.ts` (`verifyDeviceSignedEvidence`).
 * It never inserts into a store table directly (except the checkpoint_bodies sidecar,
 * which is pure data written AFTER the receipt commits, §2.2 step 7) and never
 * re-implements idempotency, sequencing, or signing — the services do.
 *
 * AUTH (state it so nobody later "strengthens" it into a bug): the standard gateway
 * `Authorization: Bearer` is TRANSPORT-LEVEL ONLY. Checkpoint AUTHENTICITY is the
 * session-key Ed25519 signature verified against the kernel's REGISTERED signer — the
 * delegation chain, not the API key, is the identity (§8.3). Do NOT bind checkpoints
 * to API keys. And `finalize` requires NO session signature and NO live key (§8.1-#1):
 * the package proves nothing by itself — the gateway recomputes everything from its OWN
 * durable store — so ANY authenticated caller (incl. a settlement keeper) may trigger it.
 * Adding a signature requirement to finalize would reintroduce the long-job TTL bug one
 * level up; that is the exact failure §8.1-#1 exists to prevent.
 *
 * SEQUENCING INVARIANTS upheld (the §5 through-line): every store touch goes through the
 * service (`record` / `finalize`), never a raw receipt insert; `effectiveEvidenceTime`
 * is the gateway `receivedAt` fixed at handler entry (§7.1, never wall-clock-later, never
 * the device `createdAt`); windows come from stored mutual terms, never the device's
 * request (§7.3-2); fail closed everywhere with a stable reason code.
 *
 * MULTI-INSTANCE BOUNDARY (Gate-5, unchanged, §1 rule 5): the accepted-chain acceptance
 * store is a single-connection better-sqlite3 DB + a process-wide in-memory sequence
 * store; a second gateway instance is out of scope. The deterministic receipt PK makes a
 * cross-instance violation DETECTABLE (`errored`), not silently divergent. Durable
 * multi-instance acceptance is the owner-gated later step (frozen §8.6).
 *
 * CROSS-WAVE CANONICAL CHECKPOINT CONTENT (Wave 4 signs the byte-identical object):
 *   content = { sessionId, seq, createdAt, prevCheckpointHash, eventsRoot, checkpointType }
 *   `canonicalize` (@pcc/spec) sorts keys lexicographically at all depths and INCLUDES
 *   `null` / OMITS `undefined`, so key order here is irrelevant but `prevCheckpointHash`
 *   MUST be an explicit `null` at genesis (never omitted).
 *   checkpointHash = "sha256:" + sha256hex(utf8(canonicalize(content))) — computed
 *   SERVER-SIDE with SYNCHRONOUS node:crypto (never trusted from the client), so the
 *   receipt attests exactly what was verified. The session signature is verified over
 *   the SAME canonical bytes.
 *
 * ADDITIVE + NON-BREAKING: a new route mounted beside `paidJobFlowRoutes`; settlement
 * (oracle→EAS→escrow) stays behind the existing `PUT /api/jobs/:jobId/complete` and is
 * NOT run here (§2.4). All domain times are Unix SECONDS.
 */

import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { canonicalize, normalizeRegisteredSigner } from "@pcc/spec";
import type { SessionKey, SessionSignedEvent } from "@pcc/spec";
import { SessionKeyService } from "@pcc/verifier";
import { schema, eq, and, sql } from "@pcc/store";
import { getStore } from "../db.js";
import {
  EvidenceSessionStore,
  computeWindow,
} from "../services/evidence-session-store.js";
import { GatewayReceiptStore } from "../services/gateway-receipt-store.js";
import { MilestonePackageStore } from "../services/milestone-package-store.js";
import {
  registeredSignerInputFromColumns,
  DEFAULT_PERMITTED_SKEW_SECONDS,
} from "../services/device-evidence-settlement.js";
import {
  sessionRevocationStore,
  type SessionRevocationRecord,
} from "../services/session-revocation-store.js";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Job statuses at which evidence can no longer be collected — terminal states plus
 * the in-flight `completing` (mirrors the paid-job-flow `/complete` NOT-IN guard,
 * paid-job-flow.ts L938) plus this route's own terminal `evidence_finalized`. A job
 * whose status is NOT in this set is evidence-collectable.
 */
const EVIDENCE_UNCOLLECTABLE_STATUSES: ReadonlySet<string> = new Set([
  "completing",
  "evidence_submitted",
  "settled",
  "completed",
  "cancelled",
  "failed",
  "evidence_finalized",
  "settlement_hold", // R-09: a job parked in a settlement hold is not re-collectable
]);

/**
 * Terminal-outcome checkpoint actions. A begin delegation must permit at least one (S6-3b) so
 * the session can reach a finalizable terminal checkpoint — otherwise it occupies the unique
 * (job, milestone) slot with no way to complete (step 6 has no renewal/chaining; that is step 9).
 * Vocabulary single-sourced with milestone-package-store.ts (TERMINAL_COMPLETION_TYPES ∪
 * {TERMINAL_FAULT_TYPE}); step 6 carries it as scope.allowedActions:string[], not the enum.
 */
const TERMINAL_ACTIONS: ReadonlySet<string> = new Set(["execution_completed", "fault_report"]);

/** §8.4-A skew bound (FLAG only, never a gate in this cut — §8.6 owner toggle). */
const PERMITTED_SKEW_SECONDS = DEFAULT_PERMITTED_SKEW_SECONDS;

// ── Small helpers ──────────────────────────────────────────────────────────────

/** The gateway's own clock at receipt, Unix SECONDS (§7.1 online point). */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function stripHexPrefix(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/**
 * The canonical checkpoint CONTENT the device signs (sans signature) — the cross-wave
 * contract. EXACTLY these six keys; `prevCheckpointHash` is an explicit `null` at
 * genesis (canonicalize INCLUDES null, OMITS undefined, and SORTS keys — so declaration
 * order does not affect the bytes, but the field must never be undefined).
 */
function checkpointContent(input: {
  sessionId: string;
  seq: number;
  createdAt: number;
  prevCheckpointHash: string | null;
  eventsRoot: string;
  checkpointType: string;
}): Record<string, unknown> {
  return {
    sessionId: input.sessionId,
    seq: input.seq,
    createdAt: input.createdAt,
    prevCheckpointHash: input.prevCheckpointHash,
    eventsRoot: input.eventsRoot,
    checkpointType: input.checkpointType,
  };
}

/** The wire shape of a §8.3 PhaseDelegation / SessionKeyAuthorization (hex fields). */
interface WireSessionKeyAuthorization {
  sessionId: string;
  parentAgentId: string;
  publicKey: string;
  issuedAt: number;
  expiresAt: number;
  scope: {
    allowedActions: string[];
    contractIds: string[];
    maxSignatures: number;
    /**
     * OPTIONAL milestone binding (S6-3, additive). NOT part of the parent-signed
     * canonical session key (canonicalSessionKeyBytes covers only allowedActions /
     * contractIds / maxSignatures), so it never affects parent-signature verification;
     * begin enforces it against the requested milestoneIndex WHEN PRESENT, and imposes
     * no constraint when absent (step-6 default).
     */
    milestoneIndex?: number;
  };
  parentSignature: string;
  derivationPath?: string;
}

/**
 * Structurally validate an untrusted delegation from a request body (or a persisted
 * session row), or null (fail closed). Shape-only — the raw-byte-length checks in
 * {@link sessionKeyFromAuthorization} are the security backstop.
 */
function coerceAuthorization(input: unknown): WireSessionKeyAuthorization | null {
  if (!input || typeof input !== "object") return null;
  const a = input as Record<string, unknown>;
  const scope = a.scope as Record<string, unknown> | undefined;
  if (
    typeof a.sessionId !== "string" ||
    typeof a.parentAgentId !== "string" ||
    typeof a.publicKey !== "string" ||
    typeof a.issuedAt !== "number" ||
    typeof a.expiresAt !== "number" ||
    !scope ||
    !Array.isArray(scope.allowedActions) ||
    !scope.allowedActions.every((v) => typeof v === "string") ||
    !Array.isArray(scope.contractIds) ||
    !scope.contractIds.every((v) => typeof v === "string") ||
    typeof scope.maxSignatures !== "number" ||
    typeof a.parentSignature !== "string"
  ) {
    return null;
  }
  // Optional milestone binding (S6-3, additive): if PRESENT it must be a number — a
  // non-number present value is malformed → fail closed. Absent is fine (no constraint).
  if (scope.milestoneIndex !== undefined && typeof scope.milestoneIndex !== "number") {
    return null;
  }
  return {
    sessionId: a.sessionId,
    parentAgentId: a.parentAgentId,
    publicKey: a.publicKey,
    issuedAt: a.issuedAt,
    expiresAt: a.expiresAt,
    scope: {
      allowedActions: scope.allowedActions as string[],
      contractIds: scope.contractIds as string[],
      maxSignatures: scope.maxSignatures,
      ...(typeof scope.milestoneIndex === "number"
        ? { milestoneIndex: scope.milestoneIndex }
        : {}),
    },
    parentSignature: a.parentSignature,
    ...(typeof a.derivationPath === "string" ? { derivationPath: a.derivationPath } : {}),
  };
}

/**
 * Build a verifier `SessionKey` (Uint8Array fields) from the wire authorization, or
 * null on malformed hex / wrong key lengths (fail closed). MIRRORS
 * device-evidence-settlement.ts L406-422.
 */
function sessionKeyFromAuthorization(auth: WireSessionKeyAuthorization): SessionKey | null {
  try {
    const publicKey = Uint8Array.from(Buffer.from(stripHexPrefix(auth.publicKey), "hex"));
    const parentSignature = Uint8Array.from(
      Buffer.from(stripHexPrefix(auth.parentSignature), "hex"),
    );
    if (publicKey.length !== 32 || parentSignature.length !== 64) return null;
    return {
      sessionId: auth.sessionId,
      parentAgentId: auth.parentAgentId as SessionKey["parentAgentId"],
      publicKey,
      issuedAt: auth.issuedAt,
      expiresAt: auth.expiresAt,
      scope: {
        allowedActions: auth.scope.allowedActions as SessionKey["scope"]["allowedActions"],
        contractIds: auth.scope.contractIds,
        maxSignatures: auth.scope.maxSignatures,
      },
      parentSignature,
      ...(auth.derivationPath ? { derivationPath: auth.derivationPath } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The kernel's REGISTERED Ed25519 signer public key as raw 32 bytes, or null when the
 * kernel has no proven ed25519 signer (fail closed). Composes
 * `registeredSignerInputFromColumns` → `normalizeRegisteredSigner` (the device/evidence
 * plane, D-KEY-3), the same leg `verifyDeviceSignedEvidence` runs.
 */
function registeredParentPublicKeyBytes(
  kernelRow:
    | {
        signingKeyAlgorithm?: string | null;
        signingKeyPublicKey?: string | null;
        signingAddress?: string | null;
      }
    | null
    | undefined,
): Uint8Array | null {
  const signer = normalizeRegisteredSigner(registeredSignerInputFromColumns(kernelRow ?? null));
  if (!signer || signer.algorithm !== "ed25519") return null;
  try {
    const bytes = Uint8Array.from(Buffer.from(stripHexPrefix(signer.publicKey), "hex"));
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Verify ONLY the delegation authenticity for `begin`: that the kernel's REGISTERED
 * signer (parent) signed this session key (§8.4-A-2 / D-KEY-3), plus the job scope. This
 * is `verifyDeviceSignedEvidence`'s delegated leg MINUS a bundle signature (§2.1-2) —
 * begin carries no session-signed event, so there is nothing for check-1 to verify.
 *
 * Composition, NOT duplication: `SessionKeyService.verifySessionSignedEvent` is the only
 * home of the canonical-session-key parent-signature check (its private
 * `canonicalSessionKeyBytes`); re-deriving those bytes here would risk a silent
 * divergence (a settlement fork). Its DOCUMENTED contract is that it collects ALL
 * failures without short-circuit, so we call it with a placeholder (unsigned) event and
 * read exactly the `parent_signature_invalid` verdict. check-1 (session_signature_invalid)
 * is EXPECTED here (no real event) and ignored; the AUTHORITATIVE per-checkpoint
 * verification at /checkpoints runs the full composition INCLUDING check-1. Fail closed:
 * a parent signature not made by the registered signer → `parent_signature_invalid`.
 */
function verifyBeginDelegation(args: {
  sessionKey: SessionKey;
  parentPublicKey: Uint8Array;
  jobId: string;
  now: number;
}): { ok: boolean; reason: string } {
  if (!args.sessionKey.scope.contractIds.includes(args.jobId)) {
    return { ok: false, reason: "contract_not_allowed" };
  }
  const event: SessionSignedEvent = {
    eventData: new TextEncoder().encode(args.sessionKey.sessionId),
    // Placeholder: begin has no session-signed event. check-1 fails on this and is
    // deliberately ignored below — only the parent-signature (delegation) verdict is read.
    sessionSignature: new Uint8Array(64),
    proof: {
      sessionKey: args.sessionKey,
      parentPublicKey: args.parentPublicKey,
      ...(args.sessionKey.derivationPath ? { derivationPath: args.sessionKey.derivationPath } : {}),
    },
  };
  const result = new SessionKeyService().verifySessionSignedEvent({
    event,
    action: args.sessionKey.scope.allowedActions[0] ?? "",
    currentTimestamp: args.now,
  });
  if (result.failures.includes("parent_signature_invalid")) {
    return { ok: false, reason: "parent_signature_invalid" };
  }
  return { ok: true, reason: "ok" };
}

/**
 * Full §8.4-A-1/2/3/6 checkpoint verification — MIRRORS `verifyDeviceSignedEvidence`'s
 * delegated branch (device-evidence-settlement.ts L403-462): session signature over the
 * canonical checkpoint bytes + parent (registered-signer) delegation + expiry + job
 * scope + revocation, all judged at the ONE authoritative `effectiveEvidenceTime` (§7.1).
 * The `action` is the `checkpointType`, so verifySessionSignedEvent's check-4 enforces
 * `checkpointType ∈ scope.allowedActions` (the step-6 "action permitted in phase", §2.2-1).
 * Revocations are pre-filtered `revokedAt < effectiveEvidenceTime` (strict `<`, §7.3-4).
 * Window 2 (`acceptedAt ≤ delegation.expiresAt`) holds by construction: acceptance time
 * IS `effectiveEvidenceTime`, and the expiry check requires `effectiveEvidenceTime ≤
 * expiresAt`. Fail closed → the verifier's first failure reason.
 */
function verifyCheckpoint(args: {
  sessionKey: SessionKey;
  parentPublicKey: Uint8Array;
  jobId: string;
  canonicalBytes: Uint8Array;
  signatureHex: string;
  checkpointType: string;
  effectiveEvidenceTime: number;
  revocations: SessionRevocationRecord[];
}): { ok: boolean; reason: string } {
  if (!args.sessionKey.scope.contractIds.includes(args.jobId)) {
    return { ok: false, reason: "contract_not_allowed" };
  }
  let sessionSignature: Uint8Array;
  try {
    sessionSignature = Uint8Array.from(Buffer.from(stripHexPrefix(args.signatureHex), "hex"));
  } catch {
    return { ok: false, reason: "malformed-signature" };
  }
  if (sessionSignature.length !== 64) return { ok: false, reason: "malformed-signature" };

  const event: SessionSignedEvent = {
    eventData: args.canonicalBytes,
    sessionSignature,
    proof: {
      sessionKey: args.sessionKey,
      parentPublicKey: args.parentPublicKey,
      ...(args.sessionKey.derivationPath ? { derivationPath: args.sessionKey.derivationPath } : {}),
    },
  };
  const revokedSessionIds =
    args.revocations.length > 0
      ? new Set(
          args.revocations
            .filter((r) => r.revokedAt < args.effectiveEvidenceTime)
            .map((r) => r.sessionId),
        )
      : undefined;
  const result = new SessionKeyService().verifySessionSignedEvent({
    event,
    action: args.checkpointType,
    currentTimestamp: args.effectiveEvidenceTime,
    ...(revokedSessionIds ? { revokedSessionIds } : {}),
  });
  if (!result.valid) {
    return { ok: false, reason: result.failures[0] ?? "delegation-invalid" };
  }
  return { ok: true, reason: "ok" };
}

// ── The plugin ───────────────────────────────────────────────────────────────

export async function evidenceAsyncRoutes(app: FastifyInstance): Promise<void> {
  // ─── 2.1  POST /api/jobs/:jobId/evidence/begin ───────────────────────────────
  app.post<{
    Params: { jobId: string };
    Body: { sessionKeyAuthorization?: unknown; milestoneIndex?: number };
  }>("/api/jobs/:jobId/evidence/begin", async (req, reply) => {
    const { jobId } = req.params;
    const body = req.body ?? {};
    const milestoneIndex = Number.isInteger(body.milestoneIndex)
      ? (body.milestoneIndex as number)
      : 0;
    // Milestone binding (round-5): step 6 is single-milestone. `milestoneIndex` is NOT part of
    // the parent-signed session key, so an unbound value is untrusted — and finalizing an
    // arbitrary milestone flips the WHOLE job to `evidence_finalized`, after which `/complete`
    // (which looks for milestone 0) falls through to the legacy path. Until multi-milestone binds
    // the index into the signed delegation + the accepted envelope, only milestone 0 is valid.
    if (milestoneIndex !== 0) {
      return reply.status(422).send({ error: "unsupported_milestone_index", milestoneIndex });
    }
    const now = nowSeconds();
    const { db, repos } = getStore();

    // (a) job exists + is evidence-collectable (not terminal / not `completing`).
    const job = repos.jobs.findById(jobId);
    if (!job) return reply.status(404).send({ error: "job_not_found" });
    if (EVIDENCE_UNCOLLECTABLE_STATUSES.has(job.status)) {
      return reply
        .status(409)
        .send({ error: "job_not_evidence_collectable", status: job.status });
    }

    // Delegation shape (untrusted request body → fail closed on anything malformed).
    const auth = coerceAuthorization(body.sessionKeyAuthorization);
    const sessionKey = auth ? sessionKeyFromAuthorization(auth) : null;
    if (!auth || !sessionKey) {
      return reply
        .status(403)
        .send({ error: "delegation_invalid", reason: "malformed-session-authorization" });
    }

    // (b) delegation verifies against the kernel's REGISTERED signer (D-KEY-3).
    const parentPublicKey = registeredParentPublicKeyBytes(repos.kernels.findById(job.kernelId));
    if (!parentPublicKey) {
      return reply
        .status(403)
        .send({ error: "delegation_invalid", reason: "unregistered-signer" });
    }
    const del = verifyBeginDelegation({ sessionKey, parentPublicKey, jobId, now });
    if (!del.ok) {
      return reply.status(403).send({ error: "delegation_invalid", reason: del.reason });
    }

    // (c) window-from-terms (the 3600-clamp replacement) + delegation ⊆ window.
    const termsRow = db
      .select()
      .from(schema.negotiationSessions)
      .where(eq(schema.negotiationSessions.jobId, jobId))
      .get();
    const window = computeWindow(termsRow?.contractTerms ?? null, now);

    // §2.1-3 EXPLICIT delegation validity + authority-limit checks (S6-3). Authenticity was
    // already proven at 403 by verifyBeginDelegation above; these are POLICY/window failures →
    // 422, each with a STABLE distinct reason so the client sees which check failed. We
    // validate explicitly rather than inferring validity by filtering the verifier to one
    // reason. `window.notBefore === now` by computeWindow. ORDER: the structural
    // (well-formed window) check runs FIRST so `delegation_malformed_window` is reachable and
    // not masked by `delegation_expired`/`delegation_not_yet_valid`; then temporal (not
    // future / not expired), then the terms-window bound, then authority limits.
    const { issuedAt, expiresAt } = sessionKey;
    const { maxSignatures, allowedActions } = sessionKey.scope;
    // 1. Structural: the delegation's own window must be well-formed (expiresAt >= issuedAt).
    if (!(issuedAt <= expiresAt)) {
      return reply.status(422).send({
        error: "delegation_malformed_window",
        delegation: { issuedAt, expiresAt },
      });
    }
    // 2. Not future-dated: authority must already be active at begin (issuedAt <= now).
    if (!(issuedAt <= now)) {
      return reply.status(422).send({
        error: "delegation_not_yet_valid",
        now,
        delegation: { issuedAt, expiresAt },
      });
    }
    // 3. Not expired AT BEGIN — THE DoS fix: an expired-but-parent-signed delegation must not
    //    occupy the single (job, milestone) session slot with dead authority (now <= expiresAt).
    if (!(now <= expiresAt)) {
      return reply.status(422).send({
        error: "delegation_expired",
        now,
        delegation: { issuedAt, expiresAt },
      });
    }
    // 4. Delegation authority must not extend past the terms-derived window close (§2.1-3).
    if (!(expiresAt <= window.expiresAt)) {
      return reply.status(422).send({
        error: "delegation_outside_window",
        window,
        delegation: { issuedAt, expiresAt },
      });
    }
    // 5. maxSignatures must be a usable positive, SAFE-integer ceiling — catches 0, negative,
    //    fractional, and huge/unsafe values that would defeat the compromise-blast-radius bound.
    if (!(Number.isSafeInteger(maxSignatures) && maxSignatures > 0)) {
      return reply.status(422).send({ error: "invalid_max_signatures", maxSignatures });
    }
    // 6. A delegation that permits no actions can sign nothing — reject it up front.
    if (!(allowedActions.length > 0)) {
      return reply.status(422).send({ error: "empty_allowed_actions" });
    }
    // 6b. S6-3b: a delegation that permits no TERMINAL outcome can never produce the
    //     execution_completed / fault_report checkpoint that finalize requires — it would hold
    //     the unique (job, milestone) slot forever with no way to complete (no renewal until
    //     step 9). Require at least one terminal action so the session is finalizable. (Better:
    //     derive the required terminal set from the accepted envelope — deferred w/ multi-milestone.)
    if (!allowedActions.some((a) => TERMINAL_ACTIONS.has(a))) {
      return reply.status(422).send({ error: "no_terminal_action_allowed", allowedActions });
    }
    // 7. Milestone scope binding WHEN PRESENT (additive; absent = step-6 default, no constraint).
    //    Read from the wire auth (the verifier SessionKey deliberately omits milestoneIndex).
    if (
      auth.scope.milestoneIndex !== undefined &&
      auth.scope.milestoneIndex !== milestoneIndex
    ) {
      return reply.status(422).send({
        error: "milestone_scope_mismatch",
        delegationMilestoneIndex: auth.scope.milestoneIndex,
        milestoneIndex,
      });
    }

    // (d) open (or idempotently return) the one session for this (job, milestone).
    const sessions = new EvidenceSessionStore({ repo: repos.evidenceSessions });
    const opened = sessions.open({
      jobId,
      milestoneIndex,
      sessionKeyAuthorization: auth,
      window,
      now,
    });
    if (opened.status === "conflict") {
      return reply.status(409).send({ error: opened.reason });
    }
    const sessionRow = opened.session;
    const sessionId = sessionRow.sessionId;

    // Device resume support: nextSeq / lastAcceptedHash from the DURABLE accepted chain.
    const receipts = new GatewayReceiptStore({
      db,
      repo: repos.gatewayReceipts,
      checkpointBodies: repos.checkpointBodies,
    });
    const tip = repos.gatewayReceipts.lastAcceptedForSession(sessionId);
    // Respond with the PERSISTED session window (on idempotent re-begin, the original).
    const storedWindow = {
      notBefore: sessionRow.notBefore,
      expiresAt: sessionRow.expiresAt,
      evidenceSubmissionDeadline: sessionRow.evidenceSubmissionDeadline,
    };
    return reply.status(opened.status === "idempotent" ? 200 : 201).send({
      sessionId,
      window: storedWindow,
      maxSignatures: sessionKey.scope.maxSignatures,
      nextSeq: (tip?.lastSeq ?? 0) + 1,
      lastAcceptedHash: tip?.lastHash ?? null,
      gatewayReceiptPublicKey: receipts.publicKeyHex,
      checkpointPath: `/api/jobs/${jobId}/evidence/checkpoints`,
      finalizePath: `/api/jobs/${jobId}/evidence/finalize`,
      ...(opened.status === "idempotent" ? { idempotent: true } : {}),
    });
  });

  // ─── 2.2  POST /api/jobs/:jobId/evidence/checkpoints ─────────────────────────
  app.post<{
    Params: { jobId: string };
    Body: {
      sessionId?: unknown;
      seq?: unknown;
      createdAt?: unknown;
      prevCheckpointHash?: unknown;
      eventsRoot?: unknown;
      checkpointType?: unknown;
      signature?: unknown;
    };
  }>("/api/jobs/:jobId/evidence/checkpoints", async (req, reply) => {
    const { jobId } = req.params;
    const body = req.body ?? {};
    // (b) FIX effectiveEvidenceTime = receivedAt = now() at handler entry (§7.1) — never
    // wall-clock-later, never the device's advisory createdAt.
    const effectiveEvidenceTime = nowSeconds();
    const { db, repos } = getStore();

    if (
      typeof body.sessionId !== "string" ||
      !Number.isInteger(body.seq) ||
      typeof body.createdAt !== "number" ||
      typeof body.eventsRoot !== "string" ||
      typeof body.checkpointType !== "string" ||
      typeof body.signature !== "string" ||
      (body.prevCheckpointHash !== null &&
        body.prevCheckpointHash !== undefined &&
        typeof body.prevCheckpointHash !== "string")
    ) {
      return reply.status(400).send({ error: "checkpoint_invalid", reason: "malformed-request" });
    }
    const sessionId = body.sessionId;
    const seq = body.seq as number;
    const createdAt = body.createdAt;
    const eventsRoot = body.eventsRoot;
    const checkpointType = body.checkpointType;
    const signatureHex = body.signature;
    const prevCheckpointHash = (body.prevCheckpointHash ?? null) as string | null;

    // (a) resolve the session for (sessionId, jobId).
    const session = repos.evidenceSessions.findById(sessionId);
    if (!session || session.jobId !== jobId) {
      return reply.status(404).send({ error: "session_not_found" });
    }
    const job = repos.jobs.findById(jobId);

    // (a′) A1 (round-6): resolve any COMMITTED receipt at (sessionId, seq) BEFORE the session and
    // job lifecycle gates. An exact retransmission of an already-committed checkpoint (a lost-response
    // retry) is effectively a read/re-issue: it must reach record()'s DB-authoritative idempotency
    // path — 200 idempotent for the exact replay, 409 equivocation for different content at that
    // committed seq — EVEN AFTER the terminal checkpoint flipped the session to terminal_* (or the
    // job advanced out-of-band). Only a GENUINELY NEW acceptance (no committed row at this seq) is
    // lifecycle-gated. record() never mutates lifecycle on its idempotent/conflict paths, so a replay
    // cannot re-transition anything, and the submitted checkpoint is still FULLY verified below — a
    // forged "replay" fails signature/delegation verification, not this gate.
    const committedReceipt = repos.gatewayReceipts.findById(`grcpt-${sessionId}-${seq}`);
    if (!committedReceipt) {
      // NEW acceptance → enforce the session gate (reject a new checkpoint once the run ended)…
      if (session.status !== "open") {
        return reply.status(409).send({ error: "session_not_open", status: session.status });
      }
      // …and the job-lifecycle gate (round-6 P1-2a): a settled / completed / held / cancelled /
      // failed / completing job (or one already `evidence_finalized`) must NOT accept a NEW
      // checkpoint, even if its session is somehow still `open` — a job advanced out-of-band.
      if (job && EVIDENCE_UNCOLLECTABLE_STATUSES.has(job.status)) {
        return reply
          .status(409)
          .send({ error: "job_not_evidence_collectable", status: job.status });
      }
    }

    // Registered signer (parent pubkey) — the delegation authenticity anchor.
    const parentPublicKey = registeredParentPublicKeyBytes(
      job ? repos.kernels.findById(job.kernelId) : null,
    );
    if (!parentPublicKey) {
      return reply
        .status(403)
        .send({ error: "checkpoint_verification_failed", reason: "unregistered-signer" });
    }

    // The delegation stored at begin (the identity the signature is checked against).
    const auth = coerceAuthorization(session.sessionKeyAuthorization);
    const sessionKey = auth ? sessionKeyFromAuthorization(auth) : null;
    if (!auth || !sessionKey) {
      return reply.status(403).send({
        error: "checkpoint_verification_failed",
        reason: "malformed-session-authorization",
      });
    }

    // (c) server-compute checkpointHash + verify the session signature + delegation.
    const canonical = canonicalize(
      checkpointContent({ sessionId, seq, createdAt, prevCheckpointHash, eventsRoot, checkpointType }),
    );
    const checkpointHash = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
    const verify = verifyCheckpoint({
      sessionKey,
      parentPublicKey,
      jobId,
      canonicalBytes: new TextEncoder().encode(canonical),
      signatureHex,
      checkpointType,
      effectiveEvidenceTime,
      revocations: sessionRevocationStore.list(),
    });
    if (!verify.ok) {
      return reply
        .status(403)
        .send({ error: "checkpoint_verification_failed", reason: verify.reason });
    }

    // (d) skew FLAG — surfaced on the response, NEVER a gate (§8.4-A / §8.6).
    const skewSeconds = Math.abs(createdAt - effectiveEvidenceTime);
    const skewWithinPolicy = skewSeconds <= PERMITTED_SKEW_SECONDS;

    // (e) the transactional receipt (§8.3 verify→persist→advance; rehydration §1). The
    // receipt row AND the checkpoint_bodies sibling row insert ATOMICALLY inside
    // record() now (§8.1-#3 split-brain fix) — the route no longer writes the body
    // separately, so a crash can no longer leave a committed receipt with no body.
    const receipts = new GatewayReceiptStore({
      db,
      repo: repos.gatewayReceipts,
      checkpointBodies: repos.checkpointBodies,
      evidenceSessions: repos.evidenceSessions, // round-6 P1-2: atomic terminal-state transition on accept
    });
    const result = receipts.record({
      jobId,
      sessionId,
      seq,
      checkpointHash,
      prevCheckpointHash,
      maxSignatures: sessionKey.scope.maxSignatures,
      effectiveEvidenceTime,
      eventsRoot,
      checkpointType,
      deviceCreatedAt: createdAt,
      signature: signatureHex,
    });

    // (f) map the store result. record() OWNS the checkpoint_bodies insert now:
    //   accepted   ⟹ receipt + body committed atomically (§2.2 step 7 folded into step 5);
    //   idempotent ⟹ receipt + body already present and integrity-checked (H1);
    //   errored    ⟹ a rolled-back txn or a receipt/body split detected — fail closed.
    switch (result.status) {
      case "accepted":
        return reply.status(201).send({ receipt: result.receipt, skewSeconds, skewWithinPolicy });
      case "idempotent":
        return reply.status(200).send({ receipt: result.receipt, idempotent: true });
      case "conflict":
        return reply.status(409).send({ error: "equivocation", reason: result.reason });
      case "rejected":
        return reply.status(409).send({ error: "checkpoint_rejected", reason: result.reason });
      case "errored":
        return reply.status(400).send({ error: "checkpoint_invalid", reason: result.error.message });
    }
  });

  // ─── 2.2b  POST /api/jobs/:jobId/evidence/checkpoints/:seq/reveal ─────────────
  // S6-5: revelation is a SEPARATE, verified step from finalization. The device reveals a
  // checkpoint's payload (the events behind its already-receipted eventsRoot commitment)
  // here; finalize later includes ALL revealed payloads deterministically. This closes the
  // griefing vector where a permissionless keeper could finalize with an empty payload set
  // and permanently exclude the device's measurements. The eventsRoot commitment — NOT the
  // caller identity — is the security boundary: any authenticated caller may reveal, but the
  // events MUST hash to the receipted eventsRoot, so a wrong reveal is rejected and
  // re-revealing the same events is idempotent.
  app.post<{
    Params: { jobId: string; seq: string };
    Body: { sessionId?: unknown; events?: unknown };
  }>("/api/jobs/:jobId/evidence/checkpoints/:seq/reveal", async (req, reply) => {
    const { jobId } = req.params;
    const seq = Number(req.params.seq);
    const body = req.body ?? {};
    if (
      !Number.isInteger(seq) ||
      seq < 1 ||
      typeof body.sessionId !== "string" ||
      !Array.isArray(body.events)
    ) {
      return reply.status(400).send({ error: "reveal_invalid", reason: "malformed-request" });
    }
    const sessionId = body.sessionId;
    const events = body.events as unknown[];
    const { repos } = getStore();

    // Session must belong to this job (fail closed).
    const session = repos.evidenceSessions.findById(sessionId);
    if (!session || session.jobId !== jobId) {
      return reply.status(404).send({ error: "session_not_found" });
    }
    // A checkpoint must have been receipted at this seq (its body carries the commitment).
    const cbody = repos.checkpointBodies.findBySessionSeq(sessionId, seq);
    if (!cbody) {
      return reply.status(404).send({ error: "checkpoint_not_found" });
    }
    // The revealed events MUST hash to the RECEIPTED eventsRoot (§8.1-#1: new data is allowed
    // iff it matches a receipted commitment) — the whole security of a permissionless reveal.
    // Same canonicalSha256 idiom as the checkpoint route + finalize.
    const eventsHash = `sha256:${createHash("sha256").update(canonicalize(events)).digest("hex")}`;
    if (eventsHash !== cbody.eventsRoot) {
      return reply.status(422).send({ error: "payload_commitment_mismatch" });
    }
    // Persist idempotently (re-reveal of the same events → identical stored payload).
    repos.checkpointBodies.setPayload(sessionId, seq, events);
    return reply.status(200).send({ revealed: true, sessionId, seq });
  });

  // ─── 2.2c  GET /api/jobs/:jobId/evidence/sessions/:sessionId/receipts/:seq ────
  // S6-4: receipt recovery for the device client's uncertain-commit path. After a lost
  // response (the gateway committed the receipt but the client never saw it), the client
  // re-reads the tip via begin and, if the tip is its pending checkpoint, fetches the
  // committed receipt HERE to advance WITHOUT re-submitting (a re-submit with a fresh
  // createdAt would fork the hash → equivocation). Read-only + idempotent; 404 if none.
  app.get<{ Params: { jobId: string; sessionId: string; seq: string } }>(
    "/api/jobs/:jobId/evidence/sessions/:sessionId/receipts/:seq",
    async (req, reply) => {
      const { jobId, sessionId } = req.params;
      const seq = Number(req.params.seq);
      if (!Number.isInteger(seq) || seq < 1) {
        return reply.status(400).send({ error: "receipt_query_invalid" });
      }
      const { repos } = getStore();
      const session = repos.evidenceSessions.findById(sessionId);
      if (!session || session.jobId !== jobId) {
        return reply.status(404).send({ error: "session_not_found" });
      }
      const row = repos.gatewayReceipts.findById(`grcpt-${sessionId}-${seq}`);
      if (!row) {
        return reply.status(404).send({ error: "receipt_not_found" });
      }
      return reply.status(200).send({ receipt: row.body });
    },
  );

  // ─── 2.3  POST /api/jobs/:jobId/evidence/finalize ────────────────────────────
  app.post<{
    Params: { jobId: string };
    Body: { milestoneIndex?: number };
  }>("/api/jobs/:jobId/evidence/finalize", async (req, reply) => {
    const { jobId } = req.params;
    const body = req.body ?? {};
    const milestoneIndex = Number.isInteger(body.milestoneIndex)
      ? (body.milestoneIndex as number)
      : 0;
    // Milestone binding (round-5, belt to the begin guard): finalizing a non-zero / arbitrary
    // milestone would flip the WHOLE job to `evidence_finalized` while `/complete` looks for
    // milestone 0 → legacy fallback. Step 6 is single-milestone; only 0 is valid.
    if (milestoneIndex !== 0) {
      return reply.status(422).send({ error: "unsupported_milestone_index", milestoneIndex });
    }
    const now = nowSeconds();
    const { db, repos } = getStore();

    // Lifecycle (round-6 P1-2a): a settled / completed / held / cancelled / failed job must not run
    // a NEW finalization. Idempotency is preserved — if a package already exists the store returns it
    // below; this ONLY blocks a FRESH finalize on a job whose lifecycle is already terminal.
    const finalizeJob = repos.jobs.findById(jobId);
    if (
      finalizeJob &&
      EVIDENCE_UNCOLLECTABLE_STATUSES.has(finalizeJob.status) &&
      !repos.milestonePackages.findByJobMilestone(jobId, milestoneIndex)
    ) {
      return reply
        .status(409)
        .send({ error: "job_not_evidence_collectable", status: finalizeJob.status });
    }

    const packages = new MilestonePackageStore({
      db,
      evidenceSessions: repos.evidenceSessions,
      gatewayReceipts: repos.gatewayReceipts,
      checkpointBodies: repos.checkpointBodies,
      milestonePackages: repos.milestonePackages,
    });
    const result = packages.finalize({
      jobId,
      milestoneIndex,
      now,
    });

    switch (result.status) {
      case "finalized":
        // The route owns job-status vocabulary (the store's boundary reserves it — job-status
        // is deliberately NOT in the store's finalize txn); the store already flipped the
        // SESSION to finalized. A later checkpoint on this session → 409 (no longer `open`).
        // MONOTONIC (round-6 P0): reconcile to evidence_finalized ONLY from a pre-settlement state —
        // an atomic status-guarded update (mirrors the /complete claim), never a blind overwrite.
        db
          .update(schema.jobs)
          .set({ status: "evidence_finalized" })
          .where(
            and(
              eq(schema.jobs.id, jobId),
              sql`${schema.jobs.status} NOT IN ('completing','evidence_submitted','settled','completed','cancelled','failed','settlement_hold')`,
            ),
          )
          .run();
        return reply.status(201).send({
          package: result.package,
          packageReceipt: result.packageReceipt,
          evidenceRoot: result.evidenceRoot,
          packageHash: result.packageHash,
        });
      case "idempotent":
        // S6-7 crash-boundary reconcile: the store commits package + session-finalize atomically,
        // but the job-status flip lives HERE (the route), AFTER that txn. A crash between the two
        // leaves a finalized package/session with an un-flipped job — reconcile it here.
        // MONOTONIC (round-6 P0 fix): the reconcile is status-GUARDED. A finalized package does NOT
        // license "force evidence_finalized" — a settled / held / completing / evidence_submitted job
        // that gets a repeat idempotent finalize must NOT be rolled back to evidence_finalized (that
        // would reopen /complete and RERUN settlement). Only a pre-settlement job is reconciled.
        db
          .update(schema.jobs)
          .set({ status: "evidence_finalized" })
          .where(
            and(
              eq(schema.jobs.id, jobId),
              sql`${schema.jobs.status} NOT IN ('completing','evidence_submitted','settled','completed','cancelled','failed','settlement_hold')`,
            ),
          )
          .run();
        return reply.status(200).send({
          package: result.package,
          packageReceipt: result.packageReceipt,
          evidenceRoot: result.evidenceRoot,
          packageHash: result.packageHash,
          idempotent: true,
        });
      case "rejected":
        return reply
          .status(result.reason === "session_not_found" ? 404 : 422)
          .send({ error: result.reason });
      case "errored":
        return reply.status(500).send({ error: "finalize_errored", reason: result.error.message });
    }
  });
}
