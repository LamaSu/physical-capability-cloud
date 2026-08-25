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
  isTerminalState,
  isAllocatedState,
  normalizeUnitState,
  InvalidUnitStateError,
  InconsistentAnchorsError,
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
    // The sets are no longer EXPORTED — a ReadonlySet is erased at runtime, so
    // exporting it let any in-process code .add() a non-terminal state and turn
    // "has the money moved?" into a lie with tests still green (sol finding 7;
    // escrow #1246 pushed for non-exposure over a typing tweak). Membership is
    // now reachable only through predicates, which is what we assert.
    for (const st of [8, 9] as UnitState[]) expect(isTerminalState(st)).toBe(true);
    for (const st of [1, 2, 3, 4, 5, 6, 7] as UnitState[]) expect(isTerminalState(st)).toBe(false);
    for (const st of [6, 7] as UnitState[]) expect(isAllocatedState(st)).toBe(true);
    for (const st of [1, 2, 3, 4, 5, 8, 9] as UnitState[]) expect(isAllocatedState(st)).toBe(false);
    // Terminal and allocated are DISJOINT — 6/7 must never be both.
    for (const st of [6, 7] as UnitState[]) expect(isTerminalState(st)).toBe(false);
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

  it("BACKUP_ASSERTED uses the SAME rule — asserted against a LITERAL, not against primary", () => {
    // THEATRE FIX (sol finding 6): this previously compared the two outputs TO
    // EACH OTHER, so it passed if BOTH branches were deleted and returned null.
    // Comparing to a computed literal means deleting either branch fails.
    expect(
      windowEndsAt({ state: UnitState.BACKUP_ASSERTED, assertedAt: 1000n, backupLane: true }, WINDOWS),
    ).toBe(4600n); // 1000 + 3600, computed by hand, not by the code under test

    // AND the equality with primary still holds — but now both sides are pinned
    // to the same literal, so the equality cannot be satisfied by mutual absence.
    expect(windowEndsAt({ state: UnitState.PRIMARY_ASSERTED, assertedAt: 1000n }, WINDOWS)).toBe(4600n);
  });

  it("backupLane is the 2-vs-5 discriminator and REACHES the view (escrow #667)", () => {
    // The prohibition (no window arithmetic) was implemented; the requirement
    // (use backupLane) was not — the field was accepted and DROPPED while a
    // comment claimed it "lives in the lifecycle view". Now it does, and this
    // fails if it is dropped again.
    expect(view({ state: UnitState.BACKUP_ASSERTED, backupLane: true }).backupLane).toBe(true);
    expect(view({ state: UnitState.PRIMARY_ASSERTED, backupLane: false }).backupLane).toBe(false);
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

  it("DEADLINE_RECLAIM is the ONLY cause a bare RefundAllocated may yield", () => {
    // THEATRE NOTE (sol finding 6): this input is the RESULT of elimination
    // supplied as a boolean, so it cannot prove the upstream scan ran. What it
    // CAN pin is that the branch maps to exactly this cause and nothing else —
    // so a future edit that widens it to another cause fails here.
    expect(deriveRefundReason({ bareRefundAllocated: true })).toEqual({
      value: "DEADLINE_RECLAIM",
      source: "log",
      completeness: "unknown",
    });
    // The caller (route) is what turns absence into UNKNOWN when the index is
    // incomplete; that behaviour is asserted in settlement-read-routes.test.ts,
    // NOT here, because this function cannot see index completeness.
  });

  it("returns NULL when nothing witnesses a cause — and null is NOT a cause", () => {
    const r = deriveRefundReason({});
    expect(r).toBeNull();
    // Pin that null is distinguishable from every real cause, so a future
    // "default to something sensible" edit cannot pass this.
    expect(r).not.toEqual(expect.objectContaining({ value: expect.anything() }));
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

  it("finalizedBlock and finalState carry DIFFERENT confidence (rule 21)", () => {
    // THEATRE FIX (sol finding 6): asserting only source==="log" would still
    // pass if the value came from the FORBIDDEN `Finalized` event — that is a
    // log too. What this pins instead is the ASYMMETRY the rule exists for:
    // finalState is staticcall-authoritative and carries NO source envelope,
    // while finalizedBlock is reorg-exposed and MUST carry one. If either side
    // drifts toward the other's confidence level, this fails.
    const fb = deriveFinalizedBlock(1n);
    expect(fb).toEqual({ value: 1n, source: "log", completeness: "unknown" });

    const settled = view({ state: UnitState.SETTLED_RELEASED });
    expect(settled.finalState).toBe("SETTLED_RELEASED");
    // finalState is a bare value, NOT a Sourced<T> — it is authoritative.
    expect(typeof settled.finalState).toBe("string");
    expect(settled.finalState).not.toHaveProperty("source");
  });

  it("CANNOT be satisfied by a Finalized-event block — the provenance is the caller's contract", () => {
    // HONEST LIMIT, stated rather than papered over: deriveFinalizedBlock takes
    // a bare block number and has NO way to verify the caller passed the block
    // of the ZEROING dischargeClaim rather than an allocation-time `Finalized`
    // block (sol finding 4). This test documents that the guarantee lives in
    // the reader port, not here — so nobody reads the suite as proving it.
    const allocationTimeBlock = 999n; // pretend this came from `Finalized`
    const r = deriveFinalizedBlock(allocationTimeBlock);
    expect(r?.value).toBe(999n); // it is accepted — that is the gap
    expect(r?.source).toBe("log"); // and correctly marked reorg-exposed
    // The port is what must only ever pass a zeroing-discharge block.
  });
});

describe("boundary normalisation — the defect sol found, and its fix", () => {
  it("a STRING state no longer yields settled-AND-not-terminal", () => {
    // THE BUG: `state in PHASE_BY_STATE` accepted "8" (object keys are strings)
    // giving phase:"settled", while TERMINAL.has("8") failed strict identity
    // giving finalState:null — ONE response asserting both, from an ordinary
    // JSON-RPC representation. Every rule-12 test passed because they only ever
    // fed clean numeric enums.
    const v = view({ state: "8" as unknown as UnitState });
    expect(v.phase).toBe("settled");
    expect(v.finalState).toBe("SETTLED_RELEASED"); // <- was null
    expect(v.isTerminal).toBe(true); // <- was false
  });

  it("bigint and number decodings agree", () => {
    expect(view({ state: 8n as unknown as UnitState }).finalState).toBe("SETTLED_RELEASED");
    expect(view({ state: 8 as UnitState }).finalState).toBe("SETTLED_RELEASED");
  });

  it("REJECTS a prototype key rather than producing a DTO with no phase", () => {
    // "toString" previously passed `in` via the prototype chain and yielded a
    // view whose `phase` was undefined.
    expect(() => normalizeUnitState("toString")).toThrow(InvalidUnitStateError);
  });

  it("REJECTS non-integer, out-of-range and non-numeric input", () => {
    for (const bad of [1.5, -1, 10, 99, "", "8x", null, undefined, {}, []]) {
      expect(() => normalizeUnitState(bad)).toThrow();
    }
  });
});

describe("counter/state consistency — fails CLOSED both directions", () => {
  it("REFUSES to render settled while claims are outstanding", () => {
    // Money cannot be fully moved with a claim outstanding. Rendering settled
    // here would be a money lie, so it throws rather than guessing.
    expect(() => view({ state: UnitState.SETTLED_RELEASED, remainingClaimCount: 1n }))
      .toThrow(InconsistentAnchorsError);
  });

  it("REFUSES to render allocated when the count already reached zero", () => {
    // The zeroing discharge must have advanced it to 8/9; seeing 6 with zero
    // claims means the read is stale or torn.
    expect(() => view({ state: UnitState.RELEASE_ALLOCATED, remainingClaimCount: 0n }))
      .toThrow(InconsistentAnchorsError);
  });

  it("ACCEPTS the two consistent combinations", () => {
    expect(view({ state: UnitState.SETTLED_RELEASED, remainingClaimCount: 0n }).finalState)
      .toBe("SETTLED_RELEASED");
    expect(view({ state: UnitState.RELEASE_ALLOCATED, remainingClaimCount: 2n }).isAllocated)
      .toBe(true);
  });

  it("is a no-op when the counter was not supplied (cross-check is opt-in)", () => {
    expect(view({ state: UnitState.SETTLED_RELEASED }).finalState).toBe("SETTLED_RELEASED");
  });
});

describe("unknown escalation roles are UNWITNESSED, not EMERGENCY", () => {
  it("returns null for a role that is neither APPEAL nor EMERGENCY", () => {
    // Previously ANY non-"APPEAL" role fell through to EMERGENCY_OVERTURN, so a
    // corrupt role was reported as a definite, specific refund cause.
    expect(deriveRefundReason({ escalationResolved: { role: "CORRUPT" as never, upheld: false } }))
      .toBeNull();
  });

  it("still resolves both KNOWN roles", () => {
    expect(deriveRefundReason({ escalationResolved: { role: "APPEAL", upheld: false } })?.value)
      .toBe("APPEAL_OVERTURN");
    expect(deriveRefundReason({ escalationResolved: { role: "EMERGENCY", upheld: false } })?.value)
      .toBe("EMERGENCY_OVERTURN");
  });
});
