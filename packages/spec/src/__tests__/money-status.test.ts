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
  DOCUMENTED_SPEC_MONEY_STATUSES,
} from "../money/money-status.js";

// The sec-A conformance table: [status, tone, labelSubstr | null]
const SECTION_A: Array<[string, string, string | null]> = [
  ["SETTLED_RELEASED", "settled", "operator distribution discharged"],
  ["SETTLED_REFUNDED", "refunded", "operator NOT paid"],
  ["RELEASE_ALLOCATED", "waiting", "payment incomplete"],
  ["REFUND_ALLOCATED", "waiting", "refund incomplete"],
  ["AWAITING_FUNDING", "waiting", null],
  ["FUNDED_ACTIVE", "running", null],
  ["PRIMARY_ASSERTED", "waiting", null],
  ["CHALLENGED", "waiting", null],
  ["BACKUP_PENDING", "waiting", null],
  ["BACKUP_ASSERTED", "waiting", null],
];

describe("canonical money-status map", () => {
  it("sec-A settlement states -> honest tone + direction label", () => {
    for (const [s, tone, label] of SECTION_A) {
      const c = classifyMoneyStatus(s);
      expect(c.tone, s).toBe(tone);
      expect(c.known, s).toBe(true);
      if (label) expect(String(c.label), s).toContain(label);
    }
  });

  it("the ONLY settled (green) states are documented final releases to the operator", () => {
    const green = Object.keys(MONEY_STATUS_MAP).filter((k) => MONEY_STATUS_MAP[k]!.tone === "settled").sort();
    expect(green).toEqual(["RELEASED", "SETTLED_RELEASED"]);
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
    "COMPLETED", "completed",
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
    expect(classifyMoneyStatus("settled_released").tone).toBe("settled");
    expect(classifyMoneyStatus("Settled Released").tone).toBe("settled");
    expect(classifyMoneyStatus("refund_allocated").tone).toBe("waiting");
    expect(classifyMoneyStatus("milestone-met").tone).toBe("waiting");
  });

  it("covers every documented escrow vocabulary on master (no canonical state renders 'unknown')", () => {
    // spec EscrowStatus + Escrow.status: derived from the TYPES via a compile-time coverage record.
    expect(DOCUMENTED_SPEC_MONEY_STATUSES.length).toBeGreaterThanOrEqual(15);
    // dashboard dto EscrowStatus, V-next UnitState, context-pack summary: listed with their source.
    const others = [
      "pending", "funded", "active", "released", "disputed", "refunded", "expired", // apps/dashboard/src/types/dto.ts
      "AWAITING_FUNDING", "FUNDED_ACTIVE", "PRIMARY_ASSERTED", "CHALLENGED", "BACKUP_PENDING",
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
});
