/**
 * PackML (ISA-TR88.00.02-2022) state machine for PCC equipment lifecycle.
 *
 * Provides the canonical 17-state model used by shop kernels and device
 * adapters to represent equipment operational status in a standardized,
 * interoperable way compatible with OPC UA 30050 companion spec.
 *
 * Key invariants:
 *  - Abort is always valid from any state (safety requirement)
 *  - Stop is valid from any state except Stopped and Stopping
 *  - Acting states complete automatically (SC / "auto" command)
 *  - StepStatus and device status strings are bridged via mapping helpers
 */

import type { StepStatus } from "./common.js";

// ── State Definitions ───────────────────────────────────────────────────────

/**
 * All 17 PackML states per ISA-TR88.00.02 + OPC UA 30050.
 * Numeric identifiers from OPC UA are preserved as JSDoc comments.
 */
export const PACKML_STATES = [
  "Clearing",     // 1 — acting: clearing faults after Aborted
  "Stopped",      // 2 — wait:   controlled halt; reset required before restart
  "Starting",     // 3 — acting: ramp-up sequence before Execute
  "Idle",         // 4 — wait:   ready, awaiting Start command
  "Suspended",    // 5 — wait:   paused due to external upstream/downstream condition
  "Execute",      // 6 — wait:   the productive state (machine actively working)
  "Stopping",     // 7 — acting: controlled deceleration toward Stopped
  "Aborting",     // 8 — acting: emergency stop sequence (from any state)
  "Aborted",      // 9 (OPC: 18) — wait: fault state; Clear required
  "Holding",      // 10 — acting: transitioning toward Held
  "Held",         // 11 — wait:  paused due to internal machine condition
  "Unholding",    // 12 — acting: resuming from Held toward Execute
  "Suspending",   // 13 — acting: transitioning toward Suspended
  "Unsuspending", // 14 — acting: resuming from Suspended toward Execute
  "Resetting",    // 15 — acting: preparing to return to Idle
  "Completing",   // 16 — acting: shutting down current production cycle
  "Complete",     // 17 — wait:  production cycle finished normally
] as const;

export type PackMLState = (typeof PACKML_STATES)[number];

/** Acting states — machine is executing a transition sequence; completes automatically. */
export type PackMLActingState =
  | "Clearing"
  | "Starting"
  | "Stopping"
  | "Aborting"
  | "Holding"
  | "Unholding"
  | "Suspending"
  | "Unsuspending"
  | "Resetting"
  | "Completing";

/** Wait states — machine is stable, awaiting a command or external condition. */
export type PackMLWaitState =
  | "Stopped"
  | "Idle"
  | "Suspended"
  | "Execute"
  | "Held"
  | "Complete"
  | "Aborted";

// ── Mode Definitions ────────────────────────────────────────────────────────

/** The 4 PackML operational modes (3 standard + 1 well-known custom). */
export const PACKML_MODES = [
  "Production",  // normal automated operation; all 17 states active
  "Maintenance", // planned maintenance; Hold/Suspend branches optional
  "Manual",      // step-by-step operator mode; most states bypassed
  "Dry-run",     // simulated production; full state machine, no physical output
] as const;

export type PackMLMode = (typeof PACKML_MODES)[number];

// ── Command Definitions ─────────────────────────────────────────────────────

/**
 * PackML commands issued by operators or automation.
 * "SC" (State Complete) is the automatic transition trigger emitted by the
 * machine when an acting state finishes — not issued by an operator.
 * 10 commands per ISA-TR88.00.02-2022.
 */
export const PACKML_COMMANDS = [
  "Start",
  "Stop",
  "Abort",
  "Hold",
  "Unhold",
  "Suspend",
  "Unsuspend",
  "Reset",
  "Clear",
  "SC", // state-complete: automatic transition (acting state → next wait state)
] as const;

export type PackMLCommand = (typeof PACKML_COMMANDS)[number];

// ── Transition Descriptor ───────────────────────────────────────────────────

/**
 * A single valid state transition.
 * `from: "*"` denotes a wildcard — the transition is valid from any state
 * (used for Abort and Stop which must be universally reachable).
 */
export interface PackMLTransition {
  from: PackMLState | "*";
  command: PackMLCommand | "auto";
  to: PackMLState;
}

// ── Per-Device State Record ─────────────────────────────────────────────────

/**
 * The full PackML state record for a single device.
 * Replaces legacy KernelDevice.status + DeviceHealthStatus for rich tracking.
 */
export interface PackMLDeviceState {
  deviceId: string;
  state: PackMLState;
  mode: PackMLMode;
  /** ISO 8601 timestamp of last state change */
  stateChangedAt: string;
  /** Acting states: 0–100 progress toward automatic transition */
  progress?: number;
  /** Fault description when state is Aborting or Aborted */
  faultDescription?: string;
  /**
   * LOTO (Lockout/Tagout) physical isolation flag.
   * NOT a PackML concept — layered on top and blocks ALL commands regardless
   * of mode or state.
   */
  isLotoActive?: boolean;
}

// ── Canonical Transition Table ──────────────────────────────────────────────

/**
 * Every valid PackML transition per ISA-TR88.00.02 + OPC UA 30050.
 *
 * Implementation notes:
 * - "auto" command = acting state completes → next wait state (SC trigger)
 * - "*" from = applies to any state (Abort, Stop universally valid)
 * - Stop from Stopped/Stopping is excluded (no-op / already there)
 * - Abort from Aborting/Aborted is excluded (already in fault path)
 * - OPC UA Hold extensions allow Hold from Starting, Suspending, Suspended,
 *   Unsuspending, Unholding (section 9.3 of OPC 30050)
 */
export const PACKML_TRANSITIONS: ReadonlyArray<PackMLTransition> = [
  // ── Normal production path ──────────────────────────────────────────────
  { from: "Resetting",    command: "auto",      to: "Idle" },
  { from: "Idle",         command: "Start",     to: "Starting" },
  { from: "Starting",     command: "auto",      to: "Execute" },
  { from: "Execute",      command: "SC",        to: "Completing" },
  { from: "Completing",   command: "auto",      to: "Complete" },
  { from: "Complete",     command: "Reset",     to: "Resetting" },

  // ── Hold/Unhold path (internal machine condition) ──────────────────────
  { from: "Execute",      command: "Hold",      to: "Holding" },
  { from: "Starting",     command: "Hold",      to: "Holding" }, // OPC UA ext
  { from: "Suspending",   command: "Hold",      to: "Holding" }, // OPC UA ext
  { from: "Suspended",    command: "Hold",      to: "Holding" }, // OPC UA ext
  { from: "Unsuspending", command: "Hold",      to: "Holding" }, // OPC UA ext
  { from: "Unholding",    command: "Hold",      to: "Holding" }, // OPC UA ext
  { from: "Holding",      command: "auto",      to: "Held" },
  { from: "Held",         command: "Unhold",    to: "Unholding" },
  { from: "Unholding",    command: "auto",      to: "Execute" },

  // ── Suspend/Unsuspend path (external upstream/downstream condition) ─────
  { from: "Execute",      command: "Suspend",   to: "Suspending" },
  { from: "Suspending",   command: "auto",      to: "Suspended" },
  { from: "Suspended",    command: "Unsuspend", to: "Unsuspending" },
  { from: "Unsuspending", command: "auto",      to: "Execute" },

  // ── Stop path (controlled halt from any non-stopped state) ────────────
  // Wildcard "*" excluding already-stopped/stopping states handled in getNextState
  { from: "*",            command: "Stop",      to: "Stopping" },
  { from: "Stopping",     command: "auto",      to: "Stopped" },
  { from: "Stopped",      command: "Reset",     to: "Resetting" },

  // ── Abort path (emergency; from any state) ────────────────────────────
  { from: "*",            command: "Abort",     to: "Aborting" },
  { from: "Aborting",     command: "auto",      to: "Aborted" },
  { from: "Aborted",      command: "Clear",     to: "Clearing" },
  { from: "Clearing",     command: "auto",      to: "Stopped" },
] as const;

// ── State Classification Sets ───────────────────────────────────────────────

/**
 * States where the machine is actively executing a transition sequence.
 * These complete automatically (no external command needed to leave them).
 * 10 acting states per ISA-TR88.00.02 + OPC UA 30050.
 */
export const ACTING_STATES: ReadonlySet<PackMLState> = new Set<PackMLState>([
  "Clearing",
  "Starting",
  "Stopping",
  "Aborting",
  "Holding",
  "Unholding",
  "Suspending",
  "Unsuspending",
  "Resetting",
  "Completing",
]);

/**
 * States where the machine is stable and waiting for a command or external
 * condition to change (does not self-transition).
 * 7 wait states per ISA-TR88.00.02 + OPC UA 30050.
 * Note: Execute is a wait state — the machine actively produces but stays
 * in Execute until the SC command or a Hold/Suspend/Stop/Abort is received.
 */
export const WAIT_STATES: ReadonlySet<PackMLState> = new Set<PackMLState>([
  "Stopped",
  "Idle",
  "Suspended",
  "Execute",
  "Held",
  "Complete",
  "Aborted",
]);

// ── Stop/Abort Exclusions ───────────────────────────────────────────────────

/**
 * States from which Stop is NOT valid (already in stop path or fault path).
 * Stop is excluded from: Stopped, Stopping, Aborted, Aborting.
 * ISA-TR88 spec note: "any acting/wait state except Stopped/Aborted".
 * We also exclude Stopping (already decelerating) and Aborting (abort supersedes).
 */
const STOP_EXCLUDED: ReadonlySet<PackMLState> = new Set<PackMLState>([
  "Stopped",
  "Stopping",
  "Aborted",
  "Aborting",
]);

/**
 * States from which Abort is NOT re-issued (already in abort path).
 * Abort is the highest-priority command and is valid from essentially any
 * state, but re-triggering from Aborting or Aborted is a no-op.
 */
const ABORT_EXCLUDED: ReadonlySet<PackMLState> = new Set<PackMLState>([
  "Aborting",
  "Aborted",
]);

// ── Core State Machine Functions ────────────────────────────────────────────

/**
 * Returns the next state given the current state and a command, or null if
 * the transition is not valid.
 *
 * Handles wildcard transitions for Stop and Abort with exclusion rules.
 */
export function getNextState(
  from: PackMLState,
  command: PackMLCommand | "auto"
): PackMLState | null {
  // Special handling for Stop wildcard with exclusions
  if (command === "Stop" && STOP_EXCLUDED.has(from)) {
    return null;
  }

  // Special handling for Abort wildcard with exclusions
  if (command === "Abort" && ABORT_EXCLUDED.has(from)) {
    return null;
  }

  // Find matching transition (specific match first, then wildcard)
  const specific = PACKML_TRANSITIONS.find(
    (t) => t.from === from && t.command === command
  );
  if (specific) return specific.to;

  const wildcard = PACKML_TRANSITIONS.find(
    (t) => t.from === "*" && t.command === command
  );
  return wildcard?.to ?? null;
}

/**
 * Returns true if transitioning from `from` with `command` is valid.
 */
export function isValidTransition(
  from: PackMLState,
  command: PackMLCommand | "auto"
): boolean {
  return getNextState(from, command) !== null;
}

/**
 * Returns all commands that can be issued from the given state.
 * Does not include "auto" (system-internal) or "SC" unless Execute→Completing
 * is a user-triggerable complete command.
 */
export function getAvailableCommands(state: PackMLState): PackMLCommand[] {
  const available: PackMLCommand[] = [];

  for (const cmd of PACKML_COMMANDS) {
    if (getNextState(state, cmd) !== null) {
      available.push(cmd);
    }
  }

  return available;
}

/**
 * Returns true if the given state is an acting state (self-transitions
 * automatically when its sequence completes).
 */
export function isActingState(state: PackMLState): boolean {
  return ACTING_STATES.has(state);
}

/**
 * Returns true if the given state is a wait state (stable, awaiting a
 * command or external condition).
 */
export function isWaitState(state: PackMLState): boolean {
  return WAIT_STATES.has(state);
}

// ── Mapping Helpers ─────────────────────────────────────────────────────────

/**
 * Maps a PCC StepStatus (job-level workflow state) to the closest PackML
 * equipment lifecycle state.
 *
 * Note: StepStatus is job business logic; PackML is equipment lifecycle.
 * They coexist — this mapping bridges them at the populator layer.
 * `disputed` has no PackML analog and maps to Aborted (fault state).
 */
export function stepStatusToPackML(status: StepStatus): PackMLState {
  switch (status) {
    case "pending":
      return "Stopped";       // pre-start; awaiting Reset + Start
    case "scheduled":
      return "Idle";           // assigned to kernel, ready for Start
    case "in_progress":
      return "Execute";        // actively executing
    case "awaiting_verification":
      return "Completing";     // finishing, collecting evidence
    case "verified":
      return "Complete";       // cycle finished normally
    case "completed":
      return "Complete";       // cycle finished normally
    case "failed":
      return "Aborted";        // fault state
    case "cancelled":
      return "Stopped";        // operator-initiated stop
    case "disputed":
      return "Aborted";        // no PackML analog; treat as fault state
    default: {
      // Exhaustive check — TypeScript will error if a new StepStatus is added
      const _exhaustive: never = status;
      void _exhaustive;
      return "Stopped";
    }
  }
}

/**
 * Maps a PCC device operational status string (KernelDevice.status) to
 * the corresponding PackML equipment state.
 */
export function deviceStatusToPackML(status: string): PackMLState {
  switch (status) {
    case "idle":
      return "Idle";
    case "busy":
      return "Execute";
    case "error":
      return "Aborted";
    case "offline":
      return "Stopped";
    case "maintenance":
      return "Held";
    default:
      return "Stopped";        // unknown status — safest assumption
  }
}

/**
 * Maps a PackML state back to the closest PCC StepStatus for backward
 * compatibility. Multiple PackML states can map to the same StepStatus.
 *
 * Note: Not all PackML states have a clean StepStatus equivalent. Acting
 * states that are intermediate phases map to the nearest logical StepStatus.
 */
export function packMLToStepStatus(state: PackMLState): StepStatus {
  switch (state) {
    case "Idle":
      return "scheduled";
    case "Starting":
      return "in_progress";
    case "Execute":
      return "in_progress";
    case "Completing":
      return "awaiting_verification";
    case "Complete":
      return "completed";
    case "Aborted":
      return "failed";
    case "Aborting":
      return "failed";
    case "Stopped":
      return "cancelled";
    case "Stopping":
      return "cancelled";
    case "Clearing":
      return "pending";
    case "Resetting":
      return "pending";
    case "Holding":
      return "in_progress";
    case "Held":
      return "in_progress";
    case "Unholding":
      return "in_progress";
    case "Suspending":
      return "in_progress";
    case "Suspended":
      return "in_progress";
    case "Unsuspending":
      return "in_progress";
    default: {
      const _exhaustive: never = state;
      void _exhaustive;
      return "pending";
    }
  }
}
