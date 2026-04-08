import { describe, it, expect } from "vitest";
import {
  PACKML_STATES,
  PACKML_MODES,
  PACKML_COMMANDS,
  PACKML_TRANSITIONS,
  ACTING_STATES,
  WAIT_STATES,
  isValidTransition,
  getNextState,
  getAvailableCommands,
  isActingState,
  isWaitState,
  stepStatusToPackML,
  deviceStatusToPackML,
  packMLToStepStatus,
  type PackMLState,
  type PackMLMode,
  type PackMLCommand,
} from "../types/packml.js";

// ── PACKML_STATES ─────────────────────────────────────────────────────────────

describe("PACKML_STATES", () => {
  it("contains exactly 17 states", () => {
    expect(PACKML_STATES).toHaveLength(17);
  });

  it("contains all ISA-TR88 acting states", () => {
    const acting: PackMLState[] = [
      "Clearing", "Starting", "Stopping", "Aborting",
      "Holding", "Unholding", "Suspending", "Unsuspending",
      "Resetting", "Completing",
    ];
    for (const s of acting) {
      expect(PACKML_STATES).toContain(s);
    }
  });

  it("contains all ISA-TR88 wait states", () => {
    const wait: PackMLState[] = [
      "Stopped", "Idle", "Suspended", "Execute", "Held", "Complete", "Aborted",
    ];
    for (const s of wait) {
      expect(PACKML_STATES).toContain(s);
    }
  });

  it("has no duplicates", () => {
    const set = new Set(PACKML_STATES);
    expect(set.size).toBe(PACKML_STATES.length);
  });
});

// ── PACKML_MODES ──────────────────────────────────────────────────────────────

describe("PACKML_MODES", () => {
  it("contains exactly 4 modes", () => {
    expect(PACKML_MODES).toHaveLength(4);
  });

  it("contains Production, Maintenance, Manual, Dry-run", () => {
    const modes: PackMLMode[] = ["Production", "Maintenance", "Manual", "Dry-run"];
    for (const m of modes) {
      expect(PACKML_MODES).toContain(m);
    }
  });
});

// ── PACKML_COMMANDS ───────────────────────────────────────────────────────────

describe("PACKML_COMMANDS", () => {
  it("contains exactly 10 commands", () => {
    expect(PACKML_COMMANDS).toHaveLength(10);
  });

  it("contains all expected operator commands", () => {
    const expected: PackMLCommand[] = [
      "Reset", "Start", "Stop", "Hold", "Unhold",
      "Suspend", "Unsuspend", "Abort", "Clear", "SC",
    ];
    for (const cmd of expected) {
      expect(PACKML_COMMANDS).toContain(cmd);
    }
  });

  it("does not contain 'Complete' (state name, not a command)", () => {
    expect(PACKML_COMMANDS).not.toContain("Complete");
  });
});

// ── ACTING_STATES / WAIT_STATES ───────────────────────────────────────────────

describe("ACTING_STATES", () => {
  it("contains exactly 10 acting states", () => {
    expect(ACTING_STATES.size).toBe(10);
  });

  it("contains all acting state names", () => {
    const expected: PackMLState[] = [
      "Clearing", "Starting", "Stopping", "Aborting",
      "Holding", "Unholding", "Suspending", "Unsuspending",
      "Resetting", "Completing",
    ];
    for (const s of expected) {
      expect(ACTING_STATES.has(s)).toBe(true);
    }
  });

  it("does not contain Execute (Execute is a wait state)", () => {
    expect(ACTING_STATES.has("Execute")).toBe(false);
  });

  it("does not contain any wait states", () => {
    for (const s of WAIT_STATES) {
      expect(ACTING_STATES.has(s)).toBe(false);
    }
  });
});

describe("WAIT_STATES", () => {
  it("contains exactly 7 wait states", () => {
    expect(WAIT_STATES.size).toBe(7);
  });

  it("contains all wait state names", () => {
    const expected: PackMLState[] = [
      "Stopped", "Idle", "Suspended", "Execute", "Held", "Complete", "Aborted",
    ];
    for (const s of expected) {
      expect(WAIT_STATES.has(s)).toBe(true);
    }
  });

  it("does not contain any acting states", () => {
    for (const s of ACTING_STATES) {
      expect(WAIT_STATES.has(s)).toBe(false);
    }
  });
});

describe("ACTING_STATES + WAIT_STATES cover all 17 states", () => {
  it("union equals all PackML states", () => {
    const union = new Set([...ACTING_STATES, ...WAIT_STATES]);
    expect(union.size).toBe(17);
    for (const s of PACKML_STATES) {
      expect(union.has(s)).toBe(true);
    }
  });
});

// ── PACKML_TRANSITIONS ────────────────────────────────────────────────────────

describe("PACKML_TRANSITIONS", () => {
  it("includes normal production cycle", () => {
    const pairs: Array<[PackMLState | "*", PackMLCommand | "auto", PackMLState]> = [
      ["Resetting",  "auto",  "Idle"],
      ["Idle",       "Start", "Starting"],
      ["Starting",   "auto",  "Execute"],
      ["Execute",    "SC",    "Completing"],
      ["Completing", "auto",  "Complete"],
      ["Complete",   "Reset", "Resetting"],
    ];
    for (const [from, cmd, to] of pairs) {
      const match = PACKML_TRANSITIONS.find(
        (t) => t.from === from && t.command === cmd && t.to === to
      );
      expect(match, `Expected transition ${from} --[${cmd}]--> ${to}`).toBeDefined();
    }
  });

  it("includes Hold/Unhold path", () => {
    const pairs: Array<[PackMLState, PackMLState]> = [
      ["Execute",    "Holding"],
      ["Starting",   "Holding"],
      ["Suspending", "Holding"],
      ["Suspended",  "Holding"],
      ["Unsuspending","Holding"],
      ["Unholding",  "Holding"],
    ];
    for (const [from, to] of pairs) {
      const match = PACKML_TRANSITIONS.find(
        (t) => t.from === from && t.command === "Hold" && t.to === to
      );
      expect(match, `Expected ${from} --[Hold]--> ${to}`).toBeDefined();
    }
    expect(PACKML_TRANSITIONS.find((t) => t.from === "Holding" && t.command === "auto" && t.to === "Held")).toBeDefined();
    expect(PACKML_TRANSITIONS.find((t) => t.from === "Held" && t.command === "Unhold" && t.to === "Unholding")).toBeDefined();
    expect(PACKML_TRANSITIONS.find((t) => t.from === "Unholding" && t.command === "auto" && t.to === "Execute")).toBeDefined();
  });

  it("includes Suspend/Unsuspend path", () => {
    expect(PACKML_TRANSITIONS.find((t) => t.from === "Execute" && t.command === "Suspend" && t.to === "Suspending")).toBeDefined();
    expect(PACKML_TRANSITIONS.find((t) => t.from === "Suspending" && t.command === "auto" && t.to === "Suspended")).toBeDefined();
    expect(PACKML_TRANSITIONS.find((t) => t.from === "Suspended" && t.command === "Unsuspend" && t.to === "Unsuspending")).toBeDefined();
    expect(PACKML_TRANSITIONS.find((t) => t.from === "Unsuspending" && t.command === "auto" && t.to === "Execute")).toBeDefined();
  });

  it("includes wildcard Stop transition", () => {
    const stopWild = PACKML_TRANSITIONS.find((t) => t.from === "*" && t.command === "Stop");
    expect(stopWild).toBeDefined();
    expect(stopWild?.to).toBe("Stopping");
  });

  it("includes wildcard Abort transition", () => {
    const abortWild = PACKML_TRANSITIONS.find((t) => t.from === "*" && t.command === "Abort");
    expect(abortWild).toBeDefined();
    expect(abortWild?.to).toBe("Aborting");
  });

  it("includes Clear path from Aborted", () => {
    expect(PACKML_TRANSITIONS.find((t) => t.from === "Aborted" && t.command === "Clear" && t.to === "Clearing")).toBeDefined();
    expect(PACKML_TRANSITIONS.find((t) => t.from === "Clearing" && t.command === "auto" && t.to === "Stopped")).toBeDefined();
  });
});

// ── isValidTransition ─────────────────────────────────────────────────────────

describe("isValidTransition", () => {
  it("returns true for valid normal transitions", () => {
    expect(isValidTransition("Idle", "Start")).toBe(true);
    expect(isValidTransition("Starting", "auto")).toBe(true);
    expect(isValidTransition("Execute", "SC")).toBe(true);
    expect(isValidTransition("Complete", "Reset")).toBe(true);
    expect(isValidTransition("Stopped", "Reset")).toBe(true);
    expect(isValidTransition("Held", "Unhold")).toBe(true);
    expect(isValidTransition("Suspended", "Unsuspend")).toBe(true);
    expect(isValidTransition("Aborted", "Clear")).toBe(true);
  });

  it("returns false for invalid transitions", () => {
    expect(isValidTransition("Idle", "Unhold")).toBe(false);
    expect(isValidTransition("Complete", "Start")).toBe(false);
    expect(isValidTransition("Held", "Start")).toBe(false);
    expect(isValidTransition("Aborted", "Reset")).toBe(false);
  });

  it("Stop is valid from most states but not Stopped, Stopping, Aborted, Aborting", () => {
    expect(isValidTransition("Execute", "Stop")).toBe(true);
    expect(isValidTransition("Idle", "Stop")).toBe(true);
    expect(isValidTransition("Held", "Stop")).toBe(true);
    expect(isValidTransition("Complete", "Stop")).toBe(true);
    // Excluded states
    expect(isValidTransition("Stopped", "Stop")).toBe(false);
    expect(isValidTransition("Stopping", "Stop")).toBe(false);
    expect(isValidTransition("Aborted", "Stop")).toBe(false);
    expect(isValidTransition("Aborting", "Stop")).toBe(false);
  });

  it("Abort is valid from most states but not Aborting or Aborted", () => {
    expect(isValidTransition("Execute", "Abort")).toBe(true);
    expect(isValidTransition("Idle", "Abort")).toBe(true);
    expect(isValidTransition("Stopped", "Abort")).toBe(true);
    expect(isValidTransition("Held", "Abort")).toBe(true);
    expect(isValidTransition("Starting", "Abort")).toBe(true);
    // Excluded states
    expect(isValidTransition("Aborting", "Abort")).toBe(false);
    expect(isValidTransition("Aborted", "Abort")).toBe(false);
  });
});

// ── getNextState ──────────────────────────────────────────────────────────────

describe("getNextState", () => {
  it("returns next state for standard transitions", () => {
    expect(getNextState("Idle", "Start")).toBe("Starting");
    expect(getNextState("Starting", "auto")).toBe("Execute");
    expect(getNextState("Execute", "SC")).toBe("Completing");
    expect(getNextState("Completing", "auto")).toBe("Complete");
    expect(getNextState("Complete", "Reset")).toBe("Resetting");
    expect(getNextState("Resetting", "auto")).toBe("Idle");
    expect(getNextState("Stopped", "Reset")).toBe("Resetting");
    expect(getNextState("Held", "Unhold")).toBe("Unholding");
    expect(getNextState("Aborted", "Clear")).toBe("Clearing");
    expect(getNextState("Clearing", "auto")).toBe("Stopped");
  });

  it("returns null for invalid transitions", () => {
    expect(getNextState("Idle", "Unhold")).toBeNull();
    expect(getNextState("Complete", "Start")).toBeNull();
    expect(getNextState("Stopped", "Stop")).toBeNull();
    expect(getNextState("Aborted", "Abort")).toBeNull();
  });

  it("Stop from Execute goes to Stopping", () => {
    expect(getNextState("Execute", "Stop")).toBe("Stopping");
  });

  it("Stop from Stopped returns null (excluded)", () => {
    expect(getNextState("Stopped", "Stop")).toBeNull();
  });

  it("Abort from Execute goes to Aborting", () => {
    expect(getNextState("Execute", "Abort")).toBe("Aborting");
  });

  it("Abort from Aborted returns null (excluded)", () => {
    expect(getNextState("Aborted", "Abort")).toBeNull();
  });

  it("Hold from OPC UA extended states goes to Holding", () => {
    expect(getNextState("Starting", "Hold")).toBe("Holding");
    expect(getNextState("Suspending", "Hold")).toBe("Holding");
    expect(getNextState("Suspended", "Hold")).toBe("Holding");
    expect(getNextState("Unsuspending", "Hold")).toBe("Holding");
    expect(getNextState("Unholding", "Hold")).toBe("Holding");
  });
});

// ── getAvailableCommands ──────────────────────────────────────────────────────

describe("getAvailableCommands", () => {
  it("from Idle: Start, Stop, Abort are available", () => {
    const cmds = getAvailableCommands("Idle");
    expect(cmds).toContain("Start");
    expect(cmds).toContain("Stop");
    expect(cmds).toContain("Abort");
  });

  it("from Execute: Hold, Suspend, SC, Stop, Abort are available", () => {
    const cmds = getAvailableCommands("Execute");
    expect(cmds).toContain("Hold");
    expect(cmds).toContain("Suspend");
    expect(cmds).toContain("SC");
    expect(cmds).toContain("Stop");
    expect(cmds).toContain("Abort");
  });

  it("from Held: Unhold, Stop, Abort are available", () => {
    const cmds = getAvailableCommands("Held");
    expect(cmds).toContain("Unhold");
    expect(cmds).toContain("Stop");
    expect(cmds).toContain("Abort");
    expect(cmds).not.toContain("Start");
  });

  it("from Suspended: Unsuspend, Hold, Stop, Abort are available", () => {
    const cmds = getAvailableCommands("Suspended");
    expect(cmds).toContain("Unsuspend");
    expect(cmds).toContain("Hold");
    expect(cmds).toContain("Stop");
    expect(cmds).toContain("Abort");
  });

  it("from Aborted: Clear is available; Stop and Abort are not", () => {
    const cmds = getAvailableCommands("Aborted");
    expect(cmds).toContain("Clear");
    expect(cmds).not.toContain("Stop");
    expect(cmds).not.toContain("Abort");
  });

  it("from Stopped: Reset, Abort are available; Stop is not", () => {
    const cmds = getAvailableCommands("Stopped");
    expect(cmds).toContain("Reset");
    expect(cmds).toContain("Abort");
    expect(cmds).not.toContain("Stop");
  });

  it("from Complete: Reset, Stop, Abort are available", () => {
    const cmds = getAvailableCommands("Complete");
    expect(cmds).toContain("Reset");
    expect(cmds).toContain("Stop");
    expect(cmds).toContain("Abort");
  });

  it("returns only valid PackML commands (no 'auto')", () => {
    for (const state of PACKML_STATES) {
      const cmds = getAvailableCommands(state);
      for (const cmd of cmds) {
        expect(PACKML_COMMANDS).toContain(cmd);
      }
    }
  });
});

// ── isActingState / isWaitState ───────────────────────────────────────────────

describe("isActingState", () => {
  it("returns true for all 10 acting states", () => {
    const acting: PackMLState[] = [
      "Clearing", "Starting", "Stopping", "Aborting",
      "Holding", "Unholding", "Suspending", "Unsuspending",
      "Resetting", "Completing",
    ];
    for (const s of acting) {
      expect(isActingState(s)).toBe(true);
    }
  });

  it("returns false for all 7 wait states", () => {
    const wait: PackMLState[] = [
      "Stopped", "Idle", "Suspended", "Execute", "Held", "Complete", "Aborted",
    ];
    for (const s of wait) {
      expect(isActingState(s)).toBe(false);
    }
  });

  it("Execute is NOT an acting state", () => {
    expect(isActingState("Execute")).toBe(false);
  });
});

describe("isWaitState", () => {
  it("returns true for all 7 wait states", () => {
    const wait: PackMLState[] = [
      "Stopped", "Idle", "Suspended", "Execute", "Held", "Complete", "Aborted",
    ];
    for (const s of wait) {
      expect(isWaitState(s)).toBe(true);
    }
  });

  it("returns false for all 10 acting states", () => {
    const acting: PackMLState[] = [
      "Clearing", "Starting", "Stopping", "Aborting",
      "Holding", "Unholding", "Suspending", "Unsuspending",
      "Resetting", "Completing",
    ];
    for (const s of acting) {
      expect(isWaitState(s)).toBe(false);
    }
  });

  it("Execute IS a wait state", () => {
    expect(isWaitState("Execute")).toBe(true);
  });

  it("every state is either acting or wait (no gaps, no overlap)", () => {
    for (const s of PACKML_STATES) {
      const acting = isActingState(s);
      const wait = isWaitState(s);
      expect(acting || wait, `${s} must be either acting or wait`).toBe(true);
      expect(acting && wait, `${s} must not be both acting and wait`).toBe(false);
    }
  });
});

// ── stepStatusToPackML ────────────────────────────────────────────────────────

describe("stepStatusToPackML", () => {
  it("maps pending → Stopped", () => {
    expect(stepStatusToPackML("pending")).toBe("Stopped");
  });

  it("maps scheduled → Idle", () => {
    expect(stepStatusToPackML("scheduled")).toBe("Idle");
  });

  it("maps in_progress → Execute", () => {
    expect(stepStatusToPackML("in_progress")).toBe("Execute");
  });

  it("maps awaiting_verification → Completing", () => {
    expect(stepStatusToPackML("awaiting_verification")).toBe("Completing");
  });

  it("maps verified → Complete", () => {
    expect(stepStatusToPackML("verified")).toBe("Complete");
  });

  it("maps completed → Complete", () => {
    expect(stepStatusToPackML("completed")).toBe("Complete");
  });

  it("maps failed → Aborted", () => {
    expect(stepStatusToPackML("failed")).toBe("Aborted");
  });

  it("maps cancelled → Stopped", () => {
    expect(stepStatusToPackML("cancelled")).toBe("Stopped");
  });

  it("maps disputed → Aborted (no PackML analog; treat as fault)", () => {
    expect(stepStatusToPackML("disputed")).toBe("Aborted");
  });

  it("all mappings return a valid PackMLState", () => {
    const statuses = [
      "pending", "scheduled", "in_progress", "awaiting_verification",
      "verified", "completed", "failed", "cancelled", "disputed",
    ] as const;
    for (const s of statuses) {
      const result = stepStatusToPackML(s);
      expect(PACKML_STATES).toContain(result);
    }
  });
});

// ── deviceStatusToPackML ──────────────────────────────────────────────────────

describe("deviceStatusToPackML", () => {
  it("maps idle → Idle", () => {
    expect(deviceStatusToPackML("idle")).toBe("Idle");
  });

  it("maps busy → Execute", () => {
    expect(deviceStatusToPackML("busy")).toBe("Execute");
  });

  it("maps error → Aborted", () => {
    expect(deviceStatusToPackML("error")).toBe("Aborted");
  });

  it("maps offline → Stopped", () => {
    expect(deviceStatusToPackML("offline")).toBe("Stopped");
  });

  it("maps maintenance → Held", () => {
    expect(deviceStatusToPackML("maintenance")).toBe("Held");
  });

  it("maps unknown status → Stopped (safe default)", () => {
    expect(deviceStatusToPackML("unknown")).toBe("Stopped");
    expect(deviceStatusToPackML("")).toBe("Stopped");
    expect(deviceStatusToPackML("foobar")).toBe("Stopped");
  });

  it("all known statuses return valid PackMLState", () => {
    const known = ["idle", "busy", "error", "offline", "maintenance"];
    for (const s of known) {
      expect(PACKML_STATES).toContain(deviceStatusToPackML(s));
    }
  });
});

// ── packMLToStepStatus ────────────────────────────────────────────────────────

describe("packMLToStepStatus", () => {
  it("maps Idle → scheduled", () => {
    expect(packMLToStepStatus("Idle")).toBe("scheduled");
  });

  it("maps Execute → in_progress", () => {
    expect(packMLToStepStatus("Execute")).toBe("in_progress");
  });

  it("maps Starting → in_progress", () => {
    expect(packMLToStepStatus("Starting")).toBe("in_progress");
  });

  it("maps Completing → awaiting_verification", () => {
    expect(packMLToStepStatus("Completing")).toBe("awaiting_verification");
  });

  it("maps Complete → completed", () => {
    expect(packMLToStepStatus("Complete")).toBe("completed");
  });

  it("maps Aborted → failed", () => {
    expect(packMLToStepStatus("Aborted")).toBe("failed");
  });

  it("maps Aborting → failed", () => {
    expect(packMLToStepStatus("Aborting")).toBe("failed");
  });

  it("maps Stopped → cancelled", () => {
    expect(packMLToStepStatus("Stopped")).toBe("cancelled");
  });

  it("maps Stopping → cancelled", () => {
    expect(packMLToStepStatus("Stopping")).toBe("cancelled");
  });

  it("maps Clearing → pending", () => {
    expect(packMLToStepStatus("Clearing")).toBe("pending");
  });

  it("maps Resetting → pending", () => {
    expect(packMLToStepStatus("Resetting")).toBe("pending");
  });

  it("maps all Held/Holding/Suspended/Suspending/Unsuspending/Unholding → in_progress", () => {
    const inProgress: PackMLState[] = [
      "Holding", "Held", "Unholding", "Suspending", "Suspended", "Unsuspending",
    ];
    for (const s of inProgress) {
      expect(packMLToStepStatus(s)).toBe("in_progress");
    }
  });

  it("all 17 states produce a valid StepStatus", () => {
    const validStatuses = [
      "pending", "scheduled", "in_progress", "awaiting_verification",
      "verified", "disputed", "completed", "failed", "cancelled",
    ];
    for (const s of PACKML_STATES) {
      const result = packMLToStepStatus(s);
      expect(validStatuses, `${s} → '${result}' should be a valid StepStatus`).toContain(result);
    }
  });
});

// ── Round-trip consistency ────────────────────────────────────────────────────

describe("round-trip: stepStatus → packML → stepStatus", () => {
  it("in_progress → Execute → in_progress", () => {
    const mid = stepStatusToPackML("in_progress");
    expect(packMLToStepStatus(mid)).toBe("in_progress");
  });

  it("failed → Aborted → failed", () => {
    const mid = stepStatusToPackML("failed");
    expect(packMLToStepStatus(mid)).toBe("failed");
  });

  it("scheduled → Idle → scheduled", () => {
    const mid = stepStatusToPackML("scheduled");
    expect(packMLToStepStatus(mid)).toBe("scheduled");
  });
});

// ── Key invariants from spec ──────────────────────────────────────────────────

describe("Key invariants (ISA-TR88 spec)", () => {
  it("Invariant 1: Abort is reachable from every non-abort state", () => {
    const nonAbort: PackMLState[] = PACKML_STATES.filter(
      (s) => s !== "Aborting" && s !== "Aborted"
    );
    for (const s of nonAbort) {
      expect(
        isValidTransition(s, "Abort"),
        `Abort must be valid from ${s}`
      ).toBe(true);
    }
  });

  it("Invariant 2: Stop is blocked from Stopped, Stopping, Aborted, Aborting", () => {
    for (const s of ["Stopped", "Stopping", "Aborted", "Aborting"] as PackMLState[]) {
      expect(isValidTransition(s, "Stop")).toBe(false);
    }
  });

  it("Invariant 3: All acting states have an auto transition", () => {
    for (const s of ACTING_STATES) {
      expect(
        isValidTransition(s, "auto"),
        `Acting state ${s} must have an auto transition`
      ).toBe(true);
    }
  });

  it("Invariant 4: No wait state has an auto transition (except via specific commands)", () => {
    // Wait states do NOT auto-transition; they wait for a command
    for (const s of WAIT_STATES) {
      expect(
        isValidTransition(s, "auto"),
        `Wait state ${s} must NOT have an auto transition`
      ).toBe(false);
    }
  });

  it("Invariant 5: Execute is the only productive wait state (reachable from Starting, Unholding, Unsuspending)", () => {
    expect(getNextState("Starting", "auto")).toBe("Execute");
    expect(getNextState("Unholding", "auto")).toBe("Execute");
    expect(getNextState("Unsuspending", "auto")).toBe("Execute");
  });
});
