/**
 * Canonical money-status map (packages/spec/src/money/money-status.ts).
 * Spec: genui read-route contract sec-A (the 10-state table) + rule 1 (no refund-as-payment).
 * Ported from PR #313's node --test file (which no CI job ran) and extended to every
 * documented escrow vocabulary on master.
 */
import { describe, it, expect } from "vitest";
import {
  MONEY_STATUS_MAP,
  classifyMoneyStatus,
  normalizeMoneyStatus,
  classifySettlementRecord,
  vnextUnitStateName,
  VNEXT_UNIT_STATES,
  DOCUMENTED_SPEC_MONEY_STATUSES,
} from "../money/money-status.js";

// sec-A names as BARE words (the flat table): [status, tone, labelSubstr | null]. A bare
// SETTLED_RELEASED is not green: only a consistent read model is (see classifySettlementRecord).
const SECTION_A: Array<[string, string, string | null]> = [
  ["SETTLED_RELEASED", "waiting", "not confirmed by a settlement read"],
  ["SETTLED_REFUNDED", "refunded", "payees NOT paid"],
  ["RELEASE_ALLOCATED", "waiting", "payout outstanding"],
  ["REFUND_ALLOCATED", "waiting", "payer not yet refunded"],
  ["FUNDED_ACTIVE", "running", null],
  ["PRIMARY_ASSERTED", "waiting", "not final"],
  ["CHALLENGED", "waiting", "not final"],
  ["BACKUP_PENDING", "waiting", null],
  ["BACKUP_ASSERTED", "waiting", null],
];

describe("canonical money-status map", () => {
  it("sec-A names as bare words -> honest tone + direction label (never green)", () => {
    for (const [s, tone, label] of SECTION_A) {
      const c = classifyMoneyStatus(s);
      expect(c.tone, s).toBe(tone);
      expect(c.known, s).toBe(true);
      if (label) expect(String(c.label), s).toContain(label);
    }
  });

  it("the flat word table has NO green entry: a bare word is never settlement state", () => {
    const green = Object.keys(MONEY_STATUS_MAP).filter((k) => MONEY_STATUS_MAP[k]!.tone === "settled");
    expect(green).toEqual([]);
  });

  it("AWAITING_FUNDING (state 0) is intentionally unknown: unitState() reverts for a missing unit", () => {
    expect(classifyMoneyStatus("AWAITING_FUNDING").known).toBe(false);
    expect(vnextUnitStateName(0)).toBeNull();
    expect(vnextUnitStateName("AWAITING_FUNDING")).toBeNull();
  });

  // THE load-bearing invariant: nothing that is not a discharged RELEASE may render green.
  const NEVER_GREEN: unknown[] = [
    "refunded", "REFUNDED", "SETTLED_REFUNDED", "REFUND_ALLOCATED", "RELEASE_ALLOCATED",
    "UNRELEASED", "INCOMPLETE", "UNSUCCESSFUL", "NOT_APPROVED", "INACTIVE", "UNDERFUNDED",
    "PARTIALLY_PAID", "PARTIALLY_RELEASED", "PARTIALLY_REFUNDED",
    "FUNDED", "ACTIVE", "CREATED", "DISPUTED", "PENDING", "RELEASING", "COMPLETING",
    "LOCKED", "SLASHED", "EXPIRED", "MILESTONE_MET",
    // direction-less / ambiguous money words: not confirmable -> not green
    "settled", "SETTLED", "paid",
    // generic success words are NOT money states
    "done", "success", "ok", "ready", "resolved", "succeeded", "complete",
    "wat", "", null, undefined, "zzz_unknown_state", 42, {}, [],
    // "completed" ends many NON-money DTOs (jobs, steps, batch claims where paid != completed)
    "COMPLETED", "completed", "RELEASED", "released", "SETTLED_RELEASED",
    "RELEASED?", "\u274cRELEASED", "rele\u017fed",
    // decorated / non-string forms of a green word must not normalize into it
    "released!", "*released*", "(released)", "released\u0000", "released\u200b", "RELEASED\u0130",
    ["released"], [["released"]], { toString: () => "released" }, "settled_released!",
  ];
  it("nothing but a documented final release renders settled", () => {
    for (const s of NEVER_GREEN) {
      expect(classifyMoneyStatus(s).tone, JSON.stringify(s)).not.toBe("settled");
    }
  });

  it("a refund is 'refunded' (never green, never a generic failure)", () => {
    expect(classifyMoneyStatus("refunded").tone).toBe("refunded");
    expect(classifyMoneyStatus("SETTLED_REFUNDED").tone).toBe("refunded");
    expect(String(classifyMoneyStatus("SETTLED_REFUNDED").label)).toContain("NOT paid");
  });

  it("unmapped / ambiguous values fail closed to 'unknown' with no label", () => {
    for (const s of ["zzz", "wat", "partially_paid", "unreleased", "settled", "paid", "done", "success", "", null, undefined]) {
      const c = classifyMoneyStatus(s);
      expect(c.tone, JSON.stringify(s)).toBe("unknown");
      expect(c.known, JSON.stringify(s)).toBe(false);
      expect(c.label, JSON.stringify(s)).toBeNull();
    }
  });

  it("'completed' is known but never green: settlement not confirmed", () => {
    const c = classifyMoneyStatus("completed");
    expect(c.known).toBe(true);
    expect(c.tone).toBe("waiting");
    expect(String(c.label)).toContain("settlement not confirmed");
  });

  it("only plain status words normalize; anything else is '' (unknown)", () => {
    for (const s of ["released!", "(released)", "released\u0000", "released\u200b", "RELEASED\u0130", "re/leased", "released.", 7, true, null, ["released"], { toString: () => "released" }]) {
      expect(normalizeMoneyStatus(s), JSON.stringify(String(s))).toBe("");
    }
  });

  it("normalization: casing / whitespace / separators", () => {
    expect(normalizeMoneyStatus("  settled-released ")).toBe("SETTLED_RELEASED");
    expect(classifyMoneyStatus("settled_released").key).toBe("SETTLED_RELEASED");
    expect(classifyMoneyStatus("Settled Released").key).toBe("SETTLED_RELEASED");
    expect(classifyMoneyStatus("Settled Released").tone).toBe("waiting"); // a bare word is never green
    expect(classifyMoneyStatus("refund_allocated").tone).toBe("waiting");
    expect(classifyMoneyStatus("milestone-met").tone).toBe("waiting");
  });

  it("covers every documented escrow vocabulary on master (no canonical state renders 'unknown')", () => {
    // spec EscrowStatus + Escrow.status: derived from the TYPES via a compile-time coverage record.
    expect(DOCUMENTED_SPEC_MONEY_STATUSES.length).toBeGreaterThanOrEqual(15);
    // dashboard dto EscrowStatus, V-next UnitState, context-pack summary: listed with their source.
    const others = [
      "pending", "funded", "active", "released", "disputed", "refunded", "expired", // apps/dashboard/src/types/dto.ts
      "FUNDED_ACTIVE", "PRIMARY_ASSERTED", "CHALLENGED", "BACKUP_PENDING",
      "BACKUP_ASSERTED", "RELEASE_ALLOCATED", "REFUND_ALLOCATED", "SETTLED_RELEASED", "SETTLED_REFUNDED", // gateway UnitState
      "created", "funded", "milestone_met", "disputed", // gateway context-pack (bare "settled" is deliberately unmapped)
    ];
    for (const s of [...DOCUMENTED_SPEC_MONEY_STATUSES, ...others]) {
      expect(classifyMoneyStatus(s).known, s).toBe(true);
    }
  });

  it("the table is frozen: runtime mutation cannot turn a refund green", () => {
    expect(Object.isFrozen(MONEY_STATUS_MAP)).toBe(true);
    expect(Object.isFrozen(MONEY_STATUS_MAP["REFUNDED"])).toBe(true);
    expect(() => {
      (MONEY_STATUS_MAP as Record<string, { tone: string; label: string }>)["REFUNDED"] = { tone: "settled", label: "paid" };
    }).toThrow();
    expect(() => {
      (MONEY_STATUS_MAP["REFUNDED"] as { tone: string }).tone = "settled";
    }).toThrow();
    expect(classifyMoneyStatus("refunded").tone).toBe("refunded");
  });

  // ── source-schema classification (escrow #2580, product-qa #2594, steward #2688) ─────────────
  const NAMES = VNEXT_UNIT_STATES;
  const lifecycle = (n: number) => ({
    chainId: 84532, escrow: "0xE", unitId: "u1", unitState: n,
    phase: n >= 8 ? "settled" : n >= 6 ? "allocated" : "active",
    finalState: n >= 8 ? NAMES[n] : null, isTerminal: n >= 8, isAllocated: n >= 6,
  });
  const receipt = (finalState: unknown, isAllocated: unknown) => ({ chainId: 84532, escrow: "0xE", unitId: "u1", finalState, isAllocated, phase: "x", economics: null });

  it("a /lifecycle read with a NUMERIC unitState 1..9 classifies by its ordinal (wire shape)", () => {
    const tones = [null, "running", "waiting", "waiting", "waiting", "waiting", "waiting", "waiting", "settled", "refunded"];
    for (let n = 1; n <= 9; n++) {
      const c = classifySettlementRecord(lifecycle(n));
      expect(c.tone, String(n)).toBe(tones[n]);
      expect(c.known, String(n)).toBe(true);
    }
    expect(classifySettlementRecord(lifecycle(8)).label).toContain("payout distribution discharged");
    expect(classifySettlementRecord(lifecycle(9)).label).toContain("payees NOT paid");
    expect(classifySettlementRecord(lifecycle(7)).label).toContain("payer not yet refunded");
  });

  it("only state 8 from a CONSISTENT read model is green", () => {
    for (let n = 1; n <= 9; n++) expect(classifySettlementRecord(lifecycle(n)).tone === "settled", String(n)).toBe(n === 8);
  });

  it("state 0, non-integers and inexact names are unreadable (fail closed)", () => {
    for (const v of [0, -1, 10, 8.5, "8", "settled_released", "SETTLED_RELEASED ", null, true, [8]]) {
      const c = classifySettlementRecord({ unitState: v });
      expect(c.tone, JSON.stringify(v)).toBe("unknown");
    }
    expect(classifySettlementRecord({ ...lifecycle(8), unitState: "SETTLED_RELEASED" }).tone).toBe("settled"); // an exact name is accepted
    // a final state with missing corroboration is not final (absence is not corroboration)
    expect(classifySettlementRecord({ unitState: "SETTLED_RELEASED" }).tone).toBe("unknown");
    expect(classifySettlementRecord({ unitState: 8, finalState: "SETTLED_RELEASED", isAllocated: true }).tone).toBe("unknown");
    expect(classifySettlementRecord({ finalState: "SETTLED_RELEASED" }).tone).toBe("unknown");
  });

  it("any disagreement between unitState, finalState, isAllocated and isTerminal fails closed", () => {
    for (const bad of [
      { ...lifecycle(8), finalState: null }, { ...lifecycle(8), isAllocated: false }, { ...lifecycle(8), isTerminal: false },
      { ...lifecycle(6), finalState: "SETTLED_RELEASED" }, { ...lifecycle(9), finalState: "SETTLED_RELEASED" },
      { ...lifecycle(3), isAllocated: true }, { ...lifecycle(8), finalState: "SETTLED_REFUNDED" },
    ]) {
      expect(classifySettlementRecord(bad).tone, JSON.stringify(bad)).toBe("unknown");
    }
  });

  it("a /receipt (no unitState) counts finalState only when terminal and isAllocated agrees", () => {
    expect(classifySettlementRecord(receipt("SETTLED_RELEASED", true)).tone).toBe("settled");
    expect(classifySettlementRecord(receipt("SETTLED_REFUNDED", true)).tone).toBe("refunded");
    expect(classifySettlementRecord(receipt("SETTLED_RELEASED", false)).tone).toBe("unknown");
    const decided = classifySettlementRecord(receipt(null, true));
    expect(decided.tone).toBe("waiting");
    expect(decided.label).toContain("not yet paid out");
    expect(classifySettlementRecord(receipt(null, false)).tone).toBe("waiting");
    for (const f of [8, "RELEASED", "SETTLED", "released", "RELEASE_ALLOCATED", undefined]) {
      expect(classifySettlementRecord(receipt(f, true)).tone, JSON.stringify(f)).toBe("unknown");
    }
  });

  it("a JOB or A2A record is NOT a settlement record, whatever its status says (product-qa #2594)", () => {
    for (const rec of [
      { id: "j1", status: "completed", capabilityId: "c" }, { id: "t1", state: "completed" },
      { id: "j2", status: "released" }, { status: "SETTLED_RELEASED" }, null, [], "SETTLED_RELEASED", 8,
    ]) {
      const c = classifySettlementRecord(rec);
      expect(c.tone, JSON.stringify(rec)).toBe("unknown");
    }
    expect(classifySettlementRecord({ id: "j1", status: "completed" }).label).toBe("not a settlement record");
  });

  it("a legacy escrow record uses the flat table on its status (never green)", () => {
    expect(classifySettlementRecord({ status: "refunded", contractAddress: "0x1", milestones: [] }).tone).toBe("refunded");
    expect(classifySettlementRecord({ status: "released", contractAddress: "0x1" }).tone).toBe("waiting");
    expect(classifySettlementRecord({ status: "completed", totalAmount: "1" }).tone).toBe("waiting");
  });
});
