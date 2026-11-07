/**
 * JobExecutionDTO phase table (PX-6): exact lookup, fail-closed unknown, and coverage of
 * every documented job vocabulary.
 */
import { describe, it, expect } from "vitest";
import {
  DOCUMENTED_JOB_STATUS_PHASES,
  JOB_EXECUTION_PHASE_MAP,
  JOB_EXECUTION_SCHEMA_ID,
  TERMINAL_EXECUTION_PHASES,
  executionPhaseOf,
  isTerminalExecutionPhase,
  normalizeJobRowStatus,
} from "../readmodels/job-execution.js";

describe("executionPhaseOf: exact table", () => {
  it("maps every documented job vocabulary value to its documented phase", () => {
    for (const [status, phase] of Object.entries(DOCUMENTED_JOB_STATUS_PHASES)) {
      expect(executionPhaseOf(status), status).toBe(phase);
      expect(JOB_EXECUTION_PHASE_MAP[status], status).toBe(phase);
    }
  });

  it("covers the gateway's canonical JOB_STATUSES (config/job-status.ts)", () => {
    // Mirrors the gateway allowlist; the gateway test also checks it against the real export.
    for (const s of ["pending", "queued", "in_progress", "paused", "completed", "failed", "cancelled"]) {
      expect(executionPhaseOf(s), s).not.toBe("unknown");
    }
  });

  it("reads the gateway pipeline values as execution facts, never as money", () => {
    // `settled` is written by mock settlement with no money moving: execution-wise the
    // work was reported complete, and that is ALL this axis may say.
    expect(executionPhaseOf("settled")).toBe("completed");
    expect(executionPhaseOf("evidence_stored")).toBe("completed");
    expect(executionPhaseOf("evidence_submitted")).toBe("completed");
    expect(executionPhaseOf("active")).toBe("queued");
  });

  it("tolerates case and surrounding space, nothing else", () => {
    expect(normalizeJobRowStatus("  COMPLETED ")).toBe("completed");
    expect(executionPhaseOf(" Executing")).toBe("running");
    // No substring or separator inference: these are not documented values.
    expect(executionPhaseOf("in-progress")).toBe("unknown");
    expect(executionPhaseOf("completed_with_errors")).toBe("unknown");
    expect(executionPhaseOf("not_completed")).toBe("unknown");
  });
});

describe("executionPhaseOf: fails closed", () => {
  it("returns unknown (never a success phase) for undocumented or odd input", () => {
    for (const v of ["", "done", "success", "paid", "ok", "released", "refunded", null, undefined, 42, {}, "__proto__", "constructor", "toString"]) {
      expect(executionPhaseOf(v as unknown), String(v)).toBe("unknown");
    }
  });

  it("the table is frozen: a runtime write cannot add a success mapping", () => {
    expect(Object.isFrozen(JOB_EXECUTION_PHASE_MAP)).toBe(true);
    expect(() => {
      (JOB_EXECUTION_PHASE_MAP as Record<string, string>)["done"] = "completed";
    }).toThrow();
    expect(executionPhaseOf("done")).toBe("unknown");
  });
});

describe("terminal phases", () => {
  it("are exactly completed / failed / timed_out / cancelled", () => {
    expect([...TERMINAL_EXECUTION_PHASES].sort()).toEqual(["cancelled", "completed", "failed", "timed_out"]);
    expect(isTerminalExecutionPhase("completed")).toBe(true);
    expect(isTerminalExecutionPhase("running")).toBe(false);
    // An unknown status is NOT terminal: a surface keeps refreshing it instead of
    // presenting it as final.
    expect(isTerminalExecutionPhase("unknown")).toBe(false);
  });
});

describe("schema id", () => {
  it("is versioned for the render IR bind registry", () => {
    expect(JOB_EXECUTION_SCHEMA_ID).toBe("pcc.job-execution/v1");
  });
});
