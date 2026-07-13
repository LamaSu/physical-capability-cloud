/**
 * Evidence session store — the open execution-authority window for one
 * (job, milestone) under the §8.5 step-6 async evidence split (spec §2.1, §3).
 *
 * Composes `repos.evidenceSessions` (pure data access). Owns two things a repo
 * cannot: the window-from-terms computation (§2.1-3, the 3600-clamp replacement)
 * and the one-open-session-per-(job, milestone) policy (§2.1-4).
 *
 * SEQUENCING INVARIANTS (the §5 through-line this file participates in):
 *  - Windows come from stored MUTUAL TERMS (interim) / the signed envelope
 *    (step 7), NEVER from the device's request (§7.3-2 / §5-5). `computeWindow`
 *    takes `terms` (the caller passes `negotiationSessions.contractTerms`); step 7
 *    swaps the SOURCE without touching the checks.
 *  - Fail closed: the DB `UNIQUE(job_id, milestone_index)` is the backstop for the
 *    one-open-session rule — a raced second `open` resolves to a `conflict`
 *    variant, never an uncaught throw (§5-6).
 *
 * BOUNDARY: this is a SERVICE, not a route. `open` returns a discriminated union
 * with stable reason codes; the Wave-3 route maps each variant to an HTTP status.
 * No Fastify / HTTP status codes here. Delegation-signature verification is the
 * checkpoint/begin ROUTE's job (§2.1-2) — this store trusts its typed inputs and
 * only enforces the session-lifecycle policy.
 *
 * DESIGN NOTE (flagged in the build report, within §2.1-4 latitude): `sessionId`
 * is DERIVED deterministically as `evs-<jobId>-<milestoneIndex>` (step 6 has one
 * session per (job, milestone); renewal/chaining is step 9). `BeginEvidenceRequest`
 * (§2.1) carries no client `sessionId`, so deriving one is not a deviation. The
 * spec's "same sessionId → idempotent / different → conflict" (§2.1-4) is realized
 * as: an OPEN session re-opened with the SAME delegation is idempotent; a DIFFERENT
 * delegation while one is open is `session_already_open`.
 *
 * All domain times are Unix SECONDS (matches acceptedAt/effectiveEvidenceTime,
 * gateway-receipt-store.ts L73). `openedAt` is ISO 8601 row metadata derived from
 * the same `now`, so it is deterministic (testable) and tied to the window clock.
 *
 * ADDITIVE + NON-BREAKING: backs the step-6 async endpoints only; no existing
 * route reads or writes `evidence_sessions`.
 */

import { canonicalize } from "@pcc/spec";
import type {
  IEvidenceSessionRepository,
  EvidenceSessionInsert,
  EvidenceSessionRow,
} from "@pcc/store";

/** The terms-derived authority window (§8.4 windows 1-3), all Unix SECONDS. */
export interface EvidenceWindow {
  /** Window 1 open bound — authority invalid before this. */
  notBefore: number;
  /** Window 2 close bound — checkpoints accepted only at/before this. */
  expiresAt: number;
  /** Window 3 close bound — finalize allowed only at/before this. */
  evidenceSubmissionDeadline: number;
}

/** Env var names for owner-policy default durations (§2.1-3 fallback tier). */
const ENV_EXECUTION_WINDOW = "PCC_EXECUTION_WINDOW_DEFAULT_SECONDS";
const ENV_EVIDENCE_DEADLINE = "PCC_EVIDENCE_DEADLINE_DEFAULT_SECONDS";

/** Hard defaults when neither terms nor env supply a duration (§2.1-3). */
const HARD_DEFAULT_EXECUTION_WINDOW_SECONDS = 3600; // 1h
const HARD_DEFAULT_EVIDENCE_DEADLINE_SECONDS = 86400; // 24h

/** Optional term-duration fields this store reads from `contractTerms` (§2.1-3). */
interface WindowTerms {
  executionWindowSeconds?: unknown;
  evidenceDeadlineSeconds?: unknown;
}

/** A finite, strictly-positive number, or undefined (fail-through to next source). */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/** A finite, strictly-positive env-var duration (parsed), or undefined. */
function positiveEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  return positiveNumber(Number(raw));
}

/**
 * Compute the terms-derived authority window (§2.1-3) — PURE: no DB, no side
 * effects, deterministic given (terms, env, now). Env is read at CALL time (not
 * module load) so owner policy can change per process and tests can exercise it.
 *
 * Duration resolution, per §2.1-3, independently for each duration:
 *   terms.<field>  →  env default  →  hard default
 * Non-numeric / non-positive values at any tier fall through to the next.
 *
 * Result:
 *   notBefore                  = now
 *   expiresAt                  = now + executionWindowSeconds
 *   evidenceSubmissionDeadline = now + evidenceDeadlineSeconds
 *
 * INVARIANT (§2.1 "evidenceDeadlineSeconds >= executionWindowSeconds"): the
 * evidence-submission deadline can never precede the execution-window close — one
 * cannot require evidence before execution can even finish. If the resolved
 * evidence-deadline is shorter than the execution window, it is CLAMPED UP to the
 * execution window (fail closed), so `evidenceSubmissionDeadline >= expiresAt`
 * always holds.
 */
export function computeWindow(terms: unknown, now: number): EvidenceWindow {
  const t: WindowTerms =
    terms !== null && typeof terms === "object" ? (terms as WindowTerms) : {};

  const executionWindowSeconds =
    positiveNumber(t.executionWindowSeconds) ??
    positiveEnv(ENV_EXECUTION_WINDOW) ??
    HARD_DEFAULT_EXECUTION_WINDOW_SECONDS;

  let evidenceDeadlineSeconds =
    positiveNumber(t.evidenceDeadlineSeconds) ??
    positiveEnv(ENV_EVIDENCE_DEADLINE) ??
    HARD_DEFAULT_EVIDENCE_DEADLINE_SECONDS;

  // Clamp up — the deadline is never before the execution window closes.
  if (evidenceDeadlineSeconds < executionWindowSeconds) {
    evidenceDeadlineSeconds = executionWindowSeconds;
  }

  return {
    notBefore: now,
    expiresAt: now + executionWindowSeconds,
    evidenceSubmissionDeadline: now + evidenceDeadlineSeconds,
  };
}

/** The deterministic session id for a (job, milestone) in step 6. */
export function evidenceSessionId(jobId: string, milestoneIndex: number): string {
  return `evs-${jobId}-${milestoneIndex}`;
}

/** Input for {@link EvidenceSessionStore.open}. `window` is precomputed by the caller. */
export interface OpenSessionInput {
  jobId: string;
  milestoneIndex: number;
  /** The verified §8.3 PhaseDelegation / SessionKeyAuthorization (route-verified). */
  sessionKeyAuthorization: unknown;
  /** The terms-derived window (from {@link computeWindow}). */
  window: EvidenceWindow;
  /** Unix seconds; `notBefore` and the ISO `openedAt` derive from this. */
  now: number;
}

/**
 * Discriminated outcome of {@link EvidenceSessionStore.open} (§2.1-4).
 *  - `opened`     — a new session row was created.
 *  - `idempotent` — an OPEN session with the SAME delegation already exists.
 *  - `conflict`   — a session exists that blocks opening: a DIFFERENT delegation
 *                   is open (`session_already_open`), or the session is already
 *                   `finalized` (`session_finalized`).
 */
export type OpenSessionResult =
  | { status: "opened"; session: EvidenceSessionRow }
  | { status: "idempotent"; session: EvidenceSessionRow }
  | { status: "conflict"; reason: "session_already_open" | "session_finalized" };

export interface EvidenceSessionStoreDeps {
  /** Evidence-session persistence (from `createStore().repos.evidenceSessions`). */
  repo: IEvidenceSessionRepository;
}

export class EvidenceSessionStore {
  private readonly repo: IEvidenceSessionRepository;

  constructor(deps: EvidenceSessionStoreDeps) {
    this.repo = deps.repo;
  }

  /**
   * Open (or idempotently return) the one evidence session for a (job, milestone).
   *
   * The whole body is synchronous (better-sqlite3 reads/writes are sync) — a
   * concurrent `open` cannot interleave within one process. If a row nonetheless
   * appears between the pre-check and the insert (defensive), the UNIQUE
   * (job_id, milestone_index) constraint throws and we re-classify the now-present
   * row — the one-open-session rule fails closed, never as an uncaught error.
   */
  open(input: OpenSessionInput): OpenSessionResult {
    const existing = this.repo.findByJobMilestone(input.jobId, input.milestoneIndex);
    if (existing) {
      return classifyExisting(existing, input.sessionKeyAuthorization);
    }

    const sessionId = evidenceSessionId(input.jobId, input.milestoneIndex);
    const record: EvidenceSessionInsert = {
      sessionId,
      jobId: input.jobId,
      milestoneIndex: input.milestoneIndex,
      sessionKeyAuthorization:
        input.sessionKeyAuthorization as EvidenceSessionInsert["sessionKeyAuthorization"],
      notBefore: input.window.notBefore,
      expiresAt: input.window.expiresAt,
      evidenceSubmissionDeadline: input.window.evidenceSubmissionDeadline,
      status: "open",
      openedAt: new Date(input.now * 1000).toISOString(),
    };

    try {
      const session = this.repo.insert(record);
      if (!session) {
        // Defensive: no row returned. Re-find; classify if a row is now present.
        const raced = this.repo.findByJobMilestone(input.jobId, input.milestoneIndex);
        if (raced) return classifyExisting(raced, input.sessionKeyAuthorization);
        throw new Error(`evidence session insert returned no row for ${sessionId}`);
      }
      return { status: "opened", session };
    } catch (err) {
      // UNIQUE backstop: a concurrent begin committed the row first. Classify it
      // (idempotent iff same delegation, else conflict) instead of surfacing a throw.
      const raced = this.repo.findByJobMilestone(input.jobId, input.milestoneIndex);
      if (raced) return classifyExisting(raced, input.sessionKeyAuthorization);
      throw err;
    }
  }

  /** Passthrough: the session by its (derived) sessionId, or undefined. */
  get(sessionId: string): EvidenceSessionRow | undefined {
    return this.repo.findById(sessionId);
  }

  /** Passthrough: the single session for a (job, milestone), any status. */
  getByJobMilestone(
    jobId: string,
    milestoneIndex: number,
  ): EvidenceSessionRow | undefined {
    return this.repo.findByJobMilestone(jobId, milestoneIndex);
  }
}

/**
 * Classify an already-present session against an incoming delegation (§2.1-4).
 * `finalized` → conflict `session_finalized`. `open` → idempotent iff the stored
 * delegation is byte-identical (canonical JSON) to the incoming one, else conflict
 * `session_already_open`. Any other persisted status is treated as
 * `session_already_open` (fail closed — a row exists; never open a second).
 */
function classifyExisting(
  row: EvidenceSessionRow,
  delegation: unknown,
): OpenSessionResult {
  if (row.status === "finalized") {
    return { status: "conflict", reason: "session_finalized" };
  }
  if (row.status === "open") {
    const sameDelegation =
      canonicalize(row.sessionKeyAuthorization) === canonicalize(delegation);
    return sameDelegation
      ? { status: "idempotent", session: row }
      : { status: "conflict", reason: "session_already_open" };
  }
  return { status: "conflict", reason: "session_already_open" };
}
