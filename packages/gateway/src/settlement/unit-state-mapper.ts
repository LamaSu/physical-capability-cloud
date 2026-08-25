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

/**
 * Terminal / allocated state membership.
 *
 * DELIBERATELY NOT EXPORTED AS SETS. `ReadonlySet` is a compile-time fiction —
 * it is erased at runtime, so any code sharing the process (a test helper, a
 * polyfill, a transitive dep) could `.add()` a non-terminal state and turn
 * "has this money moved?" into a lie with every test still green. Found by
 * sol's cross-family review; escrow #1246 pushed to make the fix structural
 * rather than a typing tweak. `Object.freeze` does not protect a Set, so the
 * sets are module-local and reachable only through the predicates below.
 */
const TERMINAL = new Set<number>([8, 9]);
const ALLOCATED = new Set<number>([6, 7]);

/** rule 12 keys `finalState` off EXACTLY this predicate. */
export function isTerminalState(state: UnitState): boolean {
  return TERMINAL.has(state);
}

/**
 * Outcome decided but money NOT fully moved. NOT terminal.
 * escrow #620: an executor treats 6/7 as APPLIED, but the READ surface must
 * render them "incomplete" — a claim can still be outstanding.
 */
export function isAllocatedState(state: UnitState): boolean {
  return ALLOCATED.has(state);
}

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

// ── rules 21 + 25: per-field provenance envelope ──────────────────

export type FieldSource = "staticcall" | "log" | "registry";

/** Head a read may be pinned to. rule 22: money display reads `finalized`. */
export type Finality = "finalized" | "safe" | "unsafe";

/**
 * Whether the indexer backing a LOG-derived field is complete through the
 * pinned block, on the matching canonical chain.
 *
 * rule 23 — ABSENCE IS NOT EVIDENCE. A log-derived field is trustworthy only if
 * the indexer is COMPLETE THROUGH the pinned block with a matching canonical
 * hash. If it is lagging, "no log found" must render UNKNOWN, never an
 * absence-based inference. The sharpest instances are `refundReason` by
 * elimination (DEADLINE_RECLAIM) and "no refund cause therefore released" —
 * both become UNKNOWN when the indexer is behind.
 */
export type Completeness = "complete" | "incomplete" | "unknown";

/**
 * rule 25 — the enriched source envelope. A bare {value, source} could not say
 * WHICH chain/registry, at WHICH block, at WHAT finality, or whether the backing
 * index was complete. A chain block cannot snapshot an off-chain registry, so
 * registry-derived fields pin separately and say so here.
 */
export interface Sourced<T> {
  value: T;
  source: FieldSource;
  /** CAIP-2-ish chain id for on-chain sources; omitted for pure registry reads. */
  chain?: string;
  /** Contract address or registry identifier the value came from. */
  contractOrRegistryId?: string;
  blockNumber?: bigint;
  blockHash?: string;
  finality?: Finality;
  /** Only meaningful for `source: "log"`. */
  completeness?: Completeness;
}

export interface SourceContext {
  chain?: string;
  contractOrRegistryId?: string;
  blockNumber?: bigint;
  blockHash?: string;
  finality?: Finality;
}

export const staticcall = <T>(value: T, ctx: SourceContext = {}): Sourced<T> => ({
  value,
  source: "staticcall",
  ...ctx,
});

export const fromLog = <T>(
  value: T,
  ctx: SourceContext = {},
  completeness: Completeness = "unknown",
): Sourced<T> => ({ value, source: "log", ...ctx, completeness });

export const fromRegistry = <T>(value: T, ctx: SourceContext = {}): Sourced<T> => ({
  value,
  source: "registry",
  ...ctx,
});

/**
 * Raised when a decoded unit state is not a usable enum member.
 *
 * WHY THIS EXISTS (sol cross-family review, reproduced): the previous code did
 * `state in PHASE_BY_STATE`, and object keys are STRINGS — so a decoder handing
 * back `"8"` passed the membership test and got `phase: "settled"`, while
 * `TERMINAL.has("8")` failed strict identity and produced `finalState: null`.
 * ONE response claiming settled in one field and not-terminal in another, from
 * an ordinary JSON-RPC/ABI representation difference. Every rule-12 test still
 * passed because they only ever fed clean numeric enums.
 */
export class InvalidUnitStateError extends Error {
  constructor(raw: unknown) {
    super(
      `unit state ${typeof raw === "string" ? JSON.stringify(raw) : String(raw)} ` +
        `(${typeof raw}) is not a valid UnitState. Refusing to interpret a money ` +
        `state from an unrecognised representation.`,
    );
    this.name = "InvalidUnitStateError";
  }
}

/**
 * Raised when two reads that must describe ONE block contradict each other.
 * Fail closed: a contradictory snapshot means the READ is wrong, and a money
 * answer derived from it would be a guess wearing a number.
 */
export class InconsistentAnchorsError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "InconsistentAnchorsError";
  }
}

/**
 * Normalise a decoded state to a real enum member, or throw.
 *
 * Accepts `number` and `bigint` (both are legitimate ABI decodings of a uint8)
 * and a purely-numeric `string`. Rejects everything else — notably prototype
 * keys like "toString", which previously slipped through `in` and yielded a
 * DTO with no `phase` at all.
 */
export function normalizeUnitState(raw: unknown): UnitState {
  let n: number;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw)) throw new InvalidUnitStateError(raw);
    n = raw;
  } else if (typeof raw === "bigint") {
    if (raw < 0n || raw > 9n) throw new InvalidUnitStateError(raw);
    n = Number(raw);
  } else if (typeof raw === "string" && /^[0-9]+$/.test(raw)) {
    n = Number(raw);
  } else {
    throw new InvalidUnitStateError(raw);
  }
  if (n < 1 || n > 9) {
    // 0 is UNREACHABLE (F-5) and anything outside 1..9 is not a state at all.
    if (n === 0) throw new UnreachableUnitStateError(0);
    throw new InvalidUnitStateError(raw);
  }
  return n as UnitState;
}

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
  /**
   * Which lane produced the accepted assertion. THE discriminator between
   * states 2 and 5 (escrow #667) — they share one window rule, so this is the
   * only thing that tells them apart. `null` when the reader did not supply it.
   */
  backupLane: boolean | null;
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

/**
 * Map on-chain anchors to the lifecycle view.
 *
 * ── THE CROSS-CHECK, AND WHY IT IS ONLY SAFE FROM ONE PINNED BLOCK ───
 * `state` comes from `settlement(unitId)` and `remainingClaimCount` from
 * `unitCounters(unitId)` — TWO SEPARATE CALLS. escrow #1246 caught that a naive
 * cross-check MANUFACTURES the very contradiction it is meant to detect: a
 * discharge landing between the two calls yields the OLD state with the NEW
 * count (or the reverse), so a HEALTHY unit fails closed — and the opposite
 * ordering lets a genuinely-incomplete unit read clean. That is the same torn
 * view `unitCounters` was collapsed to fix, per its own docstring; collapsing
 * closed it WITHIN that getter, not ACROSS the two.
 *
 * So this cross-check is only sound when BOTH reads come from the SAME pinned
 * block. The reader port enforces that (every read takes the snapshot); this
 * function therefore treats a contradiction as a REAL chain/read fault and
 * fails closed rather than guessing which half is stale.
 */
export function toLifecycleView(
  anchors: SettlementAnchors,
  windows: WindowConstants,
): LifecycleView {
  // Normalise at the boundary — never trust the decoded representation.
  const state = normalizeUnitState(anchors.state as unknown);

  const isTerminal = isTerminalState(state);
  const isAllocated = isAllocatedState(state);

  // Counter/state consistency (only meaningful because both are same-block).
  const remaining = anchors.remainingClaimCount;
  if (remaining !== undefined) {
    if (isTerminal && remaining > 0n) {
      throw new InconsistentAnchorsError(
        `unitState ${state} is terminal but remainingClaimCount=${remaining} — ` +
          `money cannot be fully moved with claims outstanding. Refusing to render settled.`,
      );
    }
    if (isAllocated && remaining === 0n) {
      throw new InconsistentAnchorsError(
        `unitState ${state} is ALLOCATED but remainingClaimCount=0 — the zeroing ` +
          `discharge must have advanced it to 8/9. Read is stale or torn.`,
      );
    }
  }

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
    isAllocated,
    // escrow #667 requires 2-vs-5 be discriminated by backupLane, NEVER by window
    // arithmetic. Previously this field was accepted and DROPPED — the code
    // implemented the prohibition and not the requirement, while a comment
    // claimed the discriminator "lives in the lifecycle view". It now does.
    backupLane: anchors.backupLane ?? null,
    windowEndsAt: windowEndsAt({ ...anchors, state }, windows),
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
    const role = w.escalationResolved.role;
    // Previously ANY role that was not exactly "APPEAL" fell through to
    // EMERGENCY_OVERTURN — so a corrupt or unrecognised role was reported as a
    // DEFINITE, SPECIFIC refund cause. An unknown role is unwitnessed, and
    // unwitnessed means null (the caller renders UNKNOWN), never a guess.
    if (role === "APPEAL") return fromLog("APPEAL_OVERTURN");
    if (role === "EMERGENCY") return fromLog("EMERGENCY_OVERTURN");
    return null;
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
