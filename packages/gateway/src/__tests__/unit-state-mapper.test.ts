/**
 * Money-semantics tests for the V-next settlement unit-state mapper.
 *
 * These assertions are the money-critical ones: a wrong value here is a money
 * bug wearing a UI costume, not a rendering nit. Authority is escrow's DTO
 * mapping (coord #667, verified vs VNextSettlementEscrow.sol @ 7f2c6ff5) and
 * gen-UI read-surface contract v1.4 (#666).
 *
 * The tests deliberately pin the counter-intuitive rules, because those are the
 * ones a future refactor will "fix" into being wrong:
 *   - finalState is NULL for 6/7 (allocated ≠ settled)
 *   - states 2 and 5 share ONE window rule; backupLane is the discriminator
 *   - state 0 THROWS rather than rendering "awaiting funding"
 *   - finalizedBlock never comes from a Finalized event
 */

import { describe, it, expect } from "vitest";
import {
  UnitState,
  TERMINAL_STATES,
  ALLOCATED_STATES,
  toLifecycleView,
  windowEndsAt,
  deriveRefundReason,
  deriveFinalizedBlock,
  UnreachableUnitStateError,
  type SettlementAnchors,
  type WindowConstants,
} from "../settlement/unit-state-mapper.js";

const WINDOWS: WindowConstants = { challengeWindow: 3600n, appealWindow: 7200n };
const view = (a: SettlementAnchors) => toLifecycleView(a, WINDOWS);

describe("unit-state mapper — phase mapping (#667 table)", () => {
  const cases: Array<[UnitState, string]> = [
    [UnitState.FUNDED_ACTIVE, "active"],
    [UnitState.PRIMARY_ASSERTED, "contest"],
    [UnitState.CHALLENGED, "contest"],
    [UnitState.BACKUP_PENDING, "escalation"],
    [UnitState.BACKUP_ASSERTED, "escalation"],
    [UnitState.RELEASE_ALLOCATED, "allocated"],
    [UnitState.REFUND_ALLOCATED, "allocated"],
    [UnitState.SETTLED_RELEASED, "settled"],
    [UnitState.SETTLED_REFUNDED, "settled"],
  ];
  it.each(cases)("state %i maps to phase %s", (state, phase) => {
    expect(view({ state }).phase).toBe(phase);
  });
});

describe("rule 12 — finalState keys off the TERMINAL SET, never receipt-presence", () => {
  it("is SETTLED_RELEASED only at state 8", () => {
    expect(view({ state: UnitState.SETTLED_RELEASED }).finalState).toBe("SETTLED_RELEASED");
  });

  it("is SETTLED_REFUNDED only at state 9", () => {
    expect(view({ state: UnitState.SETTLED_REFUNDED }).finalState).toBe("SETTLED_REFUNDED");
  });

  it("is NULL for RELEASE_ALLOCATED (6) — outcome decided, money NOT fully moved", () => {
    const v = view({ state: UnitState.RELEASE_ALLOCATED });
    expect(v.finalState).toBeNull();
    expect(v.isTerminal).toBe(false);
    expect(v.isAllocated).toBe(true); // renders "payment incomplete"
  });

  it("is NULL for REFUND_ALLOCATED (7) — the same trap on the refund side", () => {
    const v = view({ state: UnitState.REFUND_ALLOCATED });
    expect(v.finalState).toBeNull();
    expect(v.isTerminal).toBe(false);
    expect(v.isAllocated).toBe(true);
  });

  it("is NULL for every in-flight state", () => {
    for (const state of [
      UnitState.FUNDED_ACTIVE,
      UnitState.PRIMARY_ASSERTED,
      UnitState.CHALLENGED,
      UnitState.BACKUP_PENDING,
      UnitState.BACKUP_ASSERTED,
    ]) {
      expect(view({ state }).finalState).toBeNull();
      expect(view({ state }).isTerminal).toBe(false);
    }
  });

  it("terminal set is exactly {8,9} — allocated states are NOT in it", () => {
    expect([...TERMINAL_STATES].sort()).toEqual([8, 9]);
    expect([...ALLOCATED_STATES].sort()).toEqual([6, 7]);
    for (const s of ALLOCATED_STATES) expect(TERMINAL_STATES.has(s)).toBe(false);
  });
});

describe("F-5 — state 0 is UNREACHABLE and must fail closed, not render", () => {
  it("THROWS rather than reporting 'awaiting funding'", () => {
    // A non-existent unit REVERTS UnitNotFound() (route maps that to 404).
    // Observing 0 means the READ is wrong — bad decode / wrong ABI / wrong
    // address. Rendering "awaiting funding" would be a plausible lie.
    expect(() => view({ state: UnitState.AWAITING_FUNDING })).toThrow(UnreachableUnitStateError);
  });

  it("THROWS on an out-of-range state rather than guessing", () => {
    expect(() => view({ state: 42 as UnitState })).toThrow(UnreachableUnitStateError);
  });
});

describe("windows — #667 trap: 2 and 5 share ONE rule, backupLane discriminates", () => {
  it("PRIMARY_ASSERTED uses assertedAt + CHALLENGE_WINDOW", () => {
    expect(windowEndsAt({ state: UnitState.PRIMARY_ASSERTED, assertedAt: 1000n }, WINDOWS)).toBe(
      4600n,
    );
  });

  it("BACKUP_ASSERTED uses the SAME rule — identical inputs give identical windows", () => {
    const primary = windowEndsAt(
      { state: UnitState.PRIMARY_ASSERTED, assertedAt: 1000n },
      WINDOWS,
    );
    const backup = windowEndsAt(
      { state: UnitState.BACKUP_ASSERTED, assertedAt: 1000n, backupLane: true },
      WINDOWS,
    );
    // If these ever diverge, someone has tried to discriminate the lanes by
    // window arithmetic — which #667 states explicitly is wrong.
    expect(backup).toBe(primary);
  });

  it("CHALLENGED uses challengedAt + APPEAL_WINDOW (a different anchor AND window)", () => {
    expect(windowEndsAt({ state: UnitState.CHALLENGED, challengedAt: 2000n }, WINDOWS)).toBe(9200n);
  });

  it("BACKUP_PENDING uses the assertion cutoff verbatim", () => {
    expect(
      windowEndsAt({ state: UnitState.BACKUP_PENDING, assertionCutoff: 5555n }, WINDOWS),
    ).toBe(5555n);
  });

  it("states without a window return null, not 0", () => {
    for (const state of [
      UnitState.FUNDED_ACTIVE,
      UnitState.RELEASE_ALLOCATED,
      UnitState.SETTLED_RELEASED,
      UnitState.SETTLED_REFUNDED,
    ]) {
      expect(windowEndsAt({ state }, WINDOWS)).toBeNull();
    }
  });

  it("returns null when the anchor is missing rather than computing from undefined", () => {
    expect(windowEndsAt({ state: UnitState.PRIMARY_ASSERTED }, WINDOWS)).toBeNull();
    expect(windowEndsAt({ state: UnitState.CHALLENGED }, WINDOWS)).toBeNull();
  });
});

describe("refundReason — five witnessed causes, all LOG-derived (rule 21)", () => {
  it("APPEAL_OVERTURN from EscalationResolved(role=APPEAL, upheld=false)", () => {
    const r = deriveRefundReason({ escalationResolved: { role: "APPEAL", upheld: false } });
    expect(r).toEqual({ value: "APPEAL_OVERTURN", source: "log" });
  });

  it("EMERGENCY_OVERTURN from EscalationResolved(role=EMERGENCY, upheld=false)", () => {
    const r = deriveRefundReason({ escalationResolved: { role: "EMERGENCY", upheld: false } });
    expect(r).toEqual({ value: "EMERGENCY_OVERTURN", source: "log" });
  });

  it("EMERGENCY_SILENCE from Finalized(false, 3)", () => {
    expect(deriveRefundReason({ finalized: { released: false, code: 3 } })?.value).toBe(
      "EMERGENCY_SILENCE",
    );
  });

  it("BACKUP_NO_RELEASE from Finalized(false, 2)", () => {
    expect(deriveRefundReason({ finalized: { released: false, code: 2 } })?.value).toBe(
      "BACKUP_NO_RELEASE",
    );
  });

  it("DEADLINE_RECLAIM from a bare RefundAllocated (by elimination only)", () => {
    expect(deriveRefundReason({ bareRefundAllocated: true })?.value).toBe("DEADLINE_RECLAIM");
  });

  it("returns NULL when nothing witnesses a cause — never a default", () => {
    // An unwitnessed cause rendered as a specific one is a money-display lie.
    expect(deriveRefundReason({})).toBeNull();
  });

  it("does NOT fire on an UPHELD escalation (upheld=true is not an overturn)", () => {
    expect(deriveRefundReason({ escalationResolved: { role: "APPEAL", upheld: true } })).toBeNull();
  });

  it("does NOT fire on Finalized(released=true) — a release is not a refund cause", () => {
    expect(deriveRefundReason({ finalized: { released: true, code: 2 } })).toBeNull();
  });

  it("every derived cause is marked source:'log' so it is never mistaken for staticcall", () => {
    const all = [
      deriveRefundReason({ escalationResolved: { role: "APPEAL", upheld: false } }),
      deriveRefundReason({ escalationResolved: { role: "EMERGENCY", upheld: false } }),
      deriveRefundReason({ finalized: { released: false, code: 3 } }),
      deriveRefundReason({ finalized: { released: false, code: 2 } }),
      deriveRefundReason({ bareRefundAllocated: true }),
    ];
    expect(all).toHaveLength(5);
    for (const r of all) expect(r?.source).toBe("log");
  });
});

describe("finalizedBlock — from the zeroing dischargeClaim, NEVER from Finalized (#666 F-2)", () => {
  it("uses the block of the discharge that zeroed remainingClaimCount", () => {
    expect(deriveFinalizedBlock(12345n)).toEqual({ value: 12345n, source: "log" });
  });

  it("is NULL while allocated (6/7) — no discharge has zeroed the count yet", () => {
    expect(deriveFinalizedBlock(undefined)).toBeNull();
  });

  it("is marked source:'log' — it is reorg-exposed, unlike finalState", () => {
    // rule 21: finalState is staticcall-authoritative; finalizedBlock is not.
    // They must never be rendered with equal confidence.
    expect(deriveFinalizedBlock(1n)?.source).toBe("log");
    expect(view({ state: UnitState.SETTLED_RELEASED }).finalState).toBe("SETTLED_RELEASED");
  });
});
