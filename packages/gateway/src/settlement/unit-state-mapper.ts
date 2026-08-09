/**
 * V-next settlement unit-state mapping — the money-semantics core of the three
 * read routes (`/receipt`, `/lifecycle`, `/provenance`).
 *
 * Pure functions only: no I/O, no chain client, no Fastify. Everything here is
 * a total function of values the caller already read, so the money-critical
 * mapping can be tested exhaustively without a chain.
 *
 * AUTHORITY: escrow's DTO mapping (coord #667, verified against
 * VNextSettlementEscrow.sol @ 7f2c6ff5) and gen-UI read-surface contract v1.4
 * (coord #666). Where this file and a reader's intuition disagree, #667 wins —
 * several of the rules below exist precisely because the intuitive version is
 * wrong.
 *
 * The four rules that are load-bearing for MONEY, not for rendering:
 *
 *   rule 12  `finalState` is keyed off the TERMINAL SET {SETTLED_RELEASED,
 *            SETTLED_REFUNDED} — i.e. unitState 8/9 — and NEVER off the
 *            presence of a receipt. A receipt is written at ALLOCATION; a
 *            collateralized-claim fallback leaves it present while the unit is
 *            still non-terminal. Everything else renders IN-PROGRESS.
 *
 *   rule 21  The route is HYBRID. `finalState` / `phase` / windows / economics
 *            are STATICCALL-authoritative. `refundReason` and `finalizedBlock`
 *            are LOG-derived and therefore reorg-exposed. Every log-derived
 *            field carries its own {value, source} marker so a reorgable value
 *            is never rendered identically to a staticcall-confirmed one.
 *
 *   rule 2   The read asserts NOTHING sound. No `verified`, no `paid`, no
 *            `settled: boolean`. It returns the record plus the material to
 *            verify it. (Forbidden-asserter doctrine, all lanes.)
 *
 *   F-5      unitState 0 (AWAITING_FUNDING) is UNREACHABLE. `unitExists` is
 *            `_unitIndexPlusOne[unitId] != 0`, pushed only inside `fund()`
 *            five lines AFTER the state is already FUNDED_ACTIVE, and
 *            `unitState()` is `onlyExisting` so it REVERTS `UnitNotFound()`
 *            beforehand. There is no reachable moment where it returns 0.
 *            The occurring case is a REVERT → 404, NOT a state-0 branch.
 *            A route that treated a decode failure as "state 0" would render
 *            "awaiting funding" for a unit that does not exist.
 */

// ── Enums (mirror the on-chain UnitState, escrow #606) ────────────────

export enum UnitState {
  AWAITING_FUNDING = 0, // UNREACHABLE — see F-5. Present only to keep the enum faithful.
  FUNDED_ACTIVE = 1,
  PRIMARY_ASSERTED = 2,
  CHALLENGED = 3,
  BACKUP_PENDING = 4,
  BACKUP_ASSERTED = 5,
  RELEASE_ALLOCATED = 6,
  REFUND_ALLOCATED = 7,
  SETTLED_RELEASED = 8,
  SETTLED_REFUNDED = 9,
}

/** Terminal set. rule 12 keys `finalState` off EXACTLY this. */
export const TERMINAL_STATES: ReadonlySet<UnitState> = new Set([
  UnitState.SETTLED_RELEASED,
  UnitState.SETTLED_REFUNDED,
]);

/**
 * Outcome decided but money not fully moved. NOT terminal, NOT payable-complete.
 * escrow #620: APPLIED (what an executor treats as success) is 6/7, but for the
 * READ surface these must render "incomplete" — a claim can still be outstanding.
 */
export const ALLOCATED_STATES: ReadonlySet<UnitState> = new Set([
  UnitState.RELEASE_ALLOCATED,
  UnitState.REFUND_ALLOCATED,
]);

export type Phase = "active" | "contest" | "escalation" | "allocated" | "settled";

export type FinalState = "SETTLED_RELEASED" | "SETTLED_REFUNDED";

/**
 * The five refund causes the contract can actually WITNESS (#667, v1.4 F-1).
 * `BACKUP_NO_RELEASE` collapses what v1.3 called BACKUP_TIMEOUT + BACKUP_REJECT:
 * a backup cohort that DOES assert goes to state 5 and releases, so
 * "backup-reject" is not a distinctly-witnessable path and must not be offered.
 * ALL FIVE are LOG-derived; none is staticcall-derivable.
 */
export type RefundReason =
  | "APPEAL_OVERTURN"
  | "EMERGENCY_OVERTURN"
  | "EMERGENCY_SILENCE"
  | "BACKUP_NO_RELEASE"
  | "DEADLINE_RECLAIM";

// ── rule 21: per-field provenance marker ──────────────────────────────

export type FieldSource = "staticcall" | "log";

/**
 * A value plus how it was obtained. `source: "log"` means reorg-exposed —
 * consumers must not render it identically to a staticcall-confirmed value.
 */
export interface Sourced<T> {
  value: T;
  source: FieldSource;
}

export const staticcall = <T>(value: T): Sourced<T> => ({ value, source: "staticcall" });
export const fromLog = <T>(value: T): Sourced<T> => ({ value, source: "log" });

// ── Inputs ────────────────────────────────────────────────────────────

/** Anchors from `settlement(bytes32)` (:1103-1119) + `unitCounters` (:1148-1155). */
export interface SettlementAnchors {
  state: UnitState;
  /** Set when an assertion was accepted; anchors the challenge window for BOTH 2 and 5. */
  assertedAt?: bigint;
  /** Set when a bonded challenge opened; anchors the appeal window for state 3. */
  challengedAt?: bigint;
  /** Backup-lane assertion cutoff; anchors the window for state 4. */
  assertionCutoff?: bigint;
  /**
   * Whether the accepted assertion came from the BACKUP lane.
   * #667: states 2 and 5 are distinguished by THIS, never by window arithmetic —
   * both use the SAME `assertedAt + CHALLENGE_WINDOW`.
   */
  backupLane?: boolean;
  /** Outstanding claims; 0 is what flips 6→8 / 7→9 via dischargeClaim. */
  remainingClaimCount?: bigint;
}

/** Compile-time window constants from VNextSettlementLib. */
export interface WindowConstants {
  challengeWindow: bigint;
  appealWindow: bigint;
}

export interface LifecycleView {
  unitState: UnitState;
  phase: Phase;
  /** rule 12: present ONLY for the terminal set. `null` everywhere else. */
  finalState: FinalState | null;
  /** True only for 8/9. Never inferred from receipt presence. */
  isTerminal: boolean;
  /** 6/7 — outcome decided, money not fully moved. Renders "incomplete". */
  isAllocated: boolean;
  /** Unix seconds the current window closes, when the state has one. */
  windowEndsAt: bigint | null;
}

// ── Errors ────────────────────────────────────────────────────────────

/**
 * Thrown when a state-0 is somehow observed. Per F-5 this is unreachable on a
 * correct chain read, so seeing it means the READ is wrong (bad decode, wrong
 * ABI, wrong address) — not that the unit is awaiting funding. Fail closed and
 * loudly rather than rendering a plausible lie.
 */
export class UnreachableUnitStateError extends Error {
  constructor(state: number) {
    super(
      `unitState ${state} is unreachable (F-5): AWAITING_FUNDING is the enum zero ` +
        `value, not a queryable state. A non-existent unit REVERTS UnitNotFound(). ` +
        `Observing 0 means the read is wrong, not that funding is pending.`,
    );
    this.name = "UnreachableUnitStateError";
  }
}

// ── The mapping (#667, authoritative) ─────────────────────────────────

const PHASE_BY_STATE: Readonly<Record<Exclude<UnitState, UnitState.AWAITING_FUNDING>, Phase>> = {
  [UnitState.FUNDED_ACTIVE]: "active",
  [UnitState.PRIMARY_ASSERTED]: "contest",
  [UnitState.CHALLENGED]: "contest",
  [UnitState.BACKUP_PENDING]: "escalation",
  [UnitState.BACKUP_ASSERTED]: "escalation",
  [UnitState.RELEASE_ALLOCATED]: "allocated",
  [UnitState.REFUND_ALLOCATED]: "allocated",
  [UnitState.SETTLED_RELEASED]: "settled",
  [UnitState.SETTLED_REFUNDED]: "settled",
};

/**
 * Window close time for the states that have one.
 *
 * #667 trap: states 2 and 5 use the SAME rule (`assertedAt + CHALLENGE_WINDOW`).
 * A mapper that tries to tell them apart by window arithmetic is wrong — the
 * discriminator is `backupLane`, which lives in the lifecycle view, not here.
 */
export function windowEndsAt(
  anchors: SettlementAnchors,
  windows: WindowConstants,
): bigint | null {
  switch (anchors.state) {
    case UnitState.PRIMARY_ASSERTED:
    case UnitState.BACKUP_ASSERTED:
      return anchors.assertedAt === undefined
        ? null
        : anchors.assertedAt + windows.challengeWindow;
    case UnitState.CHALLENGED:
      return anchors.challengedAt === undefined
        ? null
        : anchors.challengedAt + windows.appealWindow;
    case UnitState.BACKUP_PENDING:
      return anchors.assertionCutoff ?? null;
    default:
      return null;
  }
}

/** Map on-chain anchors to the lifecycle view. Total over reachable states. */
export function toLifecycleView(
  anchors: SettlementAnchors,
  windows: WindowConstants,
): LifecycleView {
  const state = anchors.state;

  if (state === UnitState.AWAITING_FUNDING) throw new UnreachableUnitStateError(state);
  if (!(state in PHASE_BY_STATE)) throw new UnreachableUnitStateError(state);

  const isTerminal = TERMINAL_STATES.has(state);

  return {
    unitState: state,
    phase: PHASE_BY_STATE[state as Exclude<UnitState, UnitState.AWAITING_FUNDING>],
    // rule 12 — terminal set ONLY. Never receipt-presence.
    finalState: isTerminal
      ? state === UnitState.SETTLED_RELEASED
        ? "SETTLED_RELEASED"
        : "SETTLED_REFUNDED"
      : null,
    isTerminal,
    isAllocated: ALLOCATED_STATES.has(state),
    windowEndsAt: windowEndsAt(anchors, windows),
  };
}

// ── refundReason (LOG-derived, rule 21) ───────────────────────────────

/** Witness events, per #667's mapping table. */
export interface RefundWitness {
  /** EscalationResolved(unitId, adjudicationId, role, upheld) — :1839 */
  escalationResolved?: { role: "APPEAL" | "EMERGENCY"; upheld: boolean };
  /** Finalized(unitId, released, code) — :1675 (code 3) / :1732 (code 2) */
  finalized?: { released: boolean; code: number };
  /** reclaimAfterDeadline (:2027) emits a BARE RefundAllocated with no companion. */
  bareRefundAllocated?: boolean;
}

/**
 * Derive the refund cause from its witnessing log.
 *
 * Returns `null` when no witness identifies a cause — which is a legitimate
 * answer, not a failure. Do NOT substitute a default: an unwitnessed cause
 * rendered as a specific one is a money-display lie.
 *
 * KNOWN FRAGILITY (gen-UI #666 residual ask to escrow): DEADLINE_RECLAIM emits
 * no discriminator, so it is derivable only BY ELIMINATION. Any future bare
 * `RefundAllocated` path silently breaks this. Escrow was asked for an explicit
 * discriminator; until it lands, treat DEADLINE_RECLAIM as the weakest inference
 * here and never harden anything on it.
 */
export function deriveRefundReason(w: RefundWitness): Sourced<RefundReason> | null {
  if (w.escalationResolved && w.escalationResolved.upheld === false) {
    return fromLog(
      w.escalationResolved.role === "APPEAL" ? "APPEAL_OVERTURN" : "EMERGENCY_OVERTURN",
    );
  }
  if (w.finalized && w.finalized.released === false) {
    if (w.finalized.code === 3) return fromLog("EMERGENCY_SILENCE");
    if (w.finalized.code === 2) return fromLog("BACKUP_NO_RELEASE");
  }
  // By elimination only — see KNOWN FRAGILITY above.
  if (w.bareRefundAllocated) return fromLog("DEADLINE_RECLAIM");
  return null;
}

/**
 * `finalizedBlock` — the block of the `dischargeClaim` that zeroed
 * `remainingClaimCount` (:1360-1362).
 *
 * ANTI-TRAP (#666 F-2): do NOT derive this from a `Finalized` event. All four
 * `Finalized` sites (:1675/:1700/:1726/:1732) fire at ALLOCATION, and
 * `dischargeClaim` does the real 6→8 / 7→9 flip while emitting only
 * `ClaimDischarged` (:1347) — no `Finalized`. Using `Finalized` would stamp a
 * settlement with the block at which the money had NOT yet moved.
 *
 * Null for 6/7 (allocated but not settled) is correct and expected.
 */
export function deriveFinalizedBlock(
  zeroingDischargeBlock: bigint | undefined,
): Sourced<bigint> | null {
  return zeroingDischargeBlock === undefined ? null : fromLog(zeroingDischargeBlock);
}
