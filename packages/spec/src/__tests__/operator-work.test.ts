/**
 * OperatorWorkDTO helpers (PX-7): exact phase maps that fail closed, and money amounts that
 * convert to base units exactly or not at all.
 */
import { describe, it, expect } from "vitest";
import {
  JOB_OFFER_PHASE_MAP,
  KERNEL_JOB_PHASE_MAP,
  OPERATOR_INCOME_SCHEMA_ID,
  OPERATOR_WORK_SCHEMA_ID,
  currencyDecimals,
  operatorPhaseOf,
  toBaseUnits,
} from "../readmodels/operator-work.js";
import { JOB_EXECUTION_PHASE_MAP } from "../readmodels/job-execution.js";

describe("operator phase maps", () => {
  it("carry versioned schema ids", () => {
    expect(OPERATOR_WORK_SCHEMA_ID).toBe("pcc.operator-work/v1");
    expect(OPERATOR_INCOME_SCHEMA_ID).toBe("pcc.operator-income/v1");
  });

  it("map every job-offer status the gateway store defines", () => {
    for (const s of ["open", "claimed", "in_progress", "delivered", "settled", "cancelled", "expired", "disputed"]) {
      expect(operatorPhaseOf(JOB_OFFER_PHASE_MAP, s).phase, s).not.toBe("unknown");
    }
  });

  it("map every execution phase except unknown", () => {
    const phases = new Set(Object.values(JOB_EXECUTION_PHASE_MAP));
    for (const p of phases) {
      if (p === "unknown") continue;
      expect(operatorPhaseOf(KERNEL_JOB_PHASE_MAP, p).phase, p).not.toBe("unknown");
    }
  });

  it("NEGATIVE: an unmapped status is unknown, asserted by the server, never progress", () => {
    for (const map of [JOB_OFFER_PHASE_MAP, KERNEL_JOB_PHASE_MAP]) {
      expect(operatorPhaseOf(map, "done")).toEqual({ phase: "unknown", source: "server" });
      expect(operatorPhaseOf(map, undefined)).toEqual({ phase: "unknown", source: "server" });
      expect(operatorPhaseOf(map, "toString")).toEqual({ phase: "unknown", source: "server" });
    }
  });

  it("NEGATIVE: completion is reported by the operator, never verified; a settled offer is not a payment", () => {
    expect(operatorPhaseOf(KERNEL_JOB_PHASE_MAP, "completed")).toEqual({ phase: "reported_done", source: "operator_reported" });
    expect(operatorPhaseOf(JOB_OFFER_PHASE_MAP, "settled")).toEqual({ phase: "reported_done", source: "operator_reported" });
    for (const map of [JOB_OFFER_PHASE_MAP, KERNEL_JOB_PHASE_MAP]) {
      for (const v of Object.values(map)) {
        expect(v.phase).not.toBe("verified");
        expect(v.source).not.toBe("verifier");
      }
    }
  });

  it("is case- and whitespace-insensitive, and frozen", () => {
    expect(operatorPhaseOf(JOB_OFFER_PHASE_MAP, " Claimed ").phase).toBe("accepted");
    expect(Object.isFrozen(JOB_OFFER_PHASE_MAP)).toBe(true);
    expect(Object.isFrozen(KERNEL_JOB_PHASE_MAP)).toBe(true);
  });
});

describe("money amounts", () => {
  it("knows the decimals of recorded currencies, and nothing else", () => {
    expect(currencyDecimals("USDC")).toBe(6);
    expect(currencyDecimals(" usdc ")).toBe(6);
    expect(currencyDecimals("ETH")).toBe(18);
    expect(currencyDecimals("USD")).toBe(2);
    expect(currencyDecimals("XYZ")).toBeNull();
    expect(currencyDecimals(6)).toBeNull();
    expect(currencyDecimals(null)).toBeNull();
  });

  it("converts exact amounts to base units", () => {
    expect(toBaseUnits("12.50", 6)).toBe("12500000");
    expect(toBaseUnits(25, 6)).toBe("25000000");
    expect(toBaseUnits(12.5, 6)).toBe("12500000");
    expect(toBaseUnits("0", 6)).toBe("0");
    expect(toBaseUnits("0.000001", 6)).toBe("1");
    expect(toBaseUnits("007.50", 2)).toBe("750");
    expect(toBaseUnits("1.10", 1)).toBe("11");
  });

  it("NEGATIVE: never rounds, guesses decimals, or accepts a malformed or negative amount", () => {
    expect(toBaseUnits("1.234", 2)).toBeNull();
    expect(toBaseUnits(0.1 + 0.2, 6)).toBeNull();
    expect(toBaseUnits("12.50", null)).toBeNull();
    expect(toBaseUnits("-1", 6)).toBeNull();
    expect(toBaseUnits(-1, 6)).toBeNull();
    expect(toBaseUnits("1e3", 6)).toBeNull();
    expect(toBaseUnits(1e21, 6)).toBeNull();
    expect(toBaseUnits("12,50", 6)).toBeNull();
    expect(toBaseUnits("", 6)).toBeNull();
    expect(toBaseUnits(Number.NaN, 6)).toBeNull();
    expect(toBaseUnits({}, 6)).toBeNull();
    expect(toBaseUnits("1", 1.5)).toBeNull();
  });
});
