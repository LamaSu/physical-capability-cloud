/**
 * Safety Governor — independent pre-flight validator for physical commands.
 *
 * Sits between the AgentFacade/KernelService and physical hardware.
 * Validates every command against operational envelopes, rate limits,
 * and hardware interlocks BEFORE it reaches equipment.
 *
 * Standards: IEC 61508 (SIL-2 for motion commands), IEC 62443 (zone boundary)
 *
 * CRITICAL: This module must remain independent of the agent system.
 * The e-stop path bypasses all agent code entirely.
 */

import type { Id, Timestamp } from "@pcc/spec";

// ── Types ──────────────────────────────────────────────────────────────────

export interface PhysicalCommand {
  /** Unique command ID for audit trail */
  commandId: string;
  /** Target device */
  deviceId: Id;
  /** Command classification */
  class: CommandClass;
  /** Command type (e.g., "move", "home", "start_print", "run_protocol") */
  type: string;
  /** Command parameters */
  params: Record<string, unknown>;
  /** Requesting agent DID */
  agentDid: string;
  /** Execution scope ID (required for Class 3) */
  scopeId?: string;
}

export type CommandClass =
  | "read"       // Class 1: Always allowed (health, status, calibration)
  | "safe"       // Class 2: Allowed during active job (home, lights, identify)
  | "scoped"     // Class 3: Requires active scope (protocol upload, run)
  | "privileged"; // Class 4: Never auto-approved (shell, self-update)

export interface OperationalEnvelope {
  /** Max velocity (mm/s or equivalent), by magnitude; 0 is a limit, not "no limit" */
  maxVelocity?: number;
  /** Max temperature (°C), signed; 0 is a limit, not "no limit" */
  maxTemperature?: number;
  /** Max force (N), by magnitude; 0 is a limit, not "no limit" */
  maxForce?: number;
  /**
   * Allowed G-code commands. NOT enforced here: the governor never sees G-code
   * (jobs carry a gcodeHash), so a non-empty list throws at construction rather
   * than look enforced. Enforce it in the adapter that emits the G-code.
   */
  allowedGcodes?: string[];
  /** Forbidden parameter patterns (matched without the g or y flag, so every call is checked the same way) */
  forbiddenPatterns?: RegExp[];
  /** Max commands per minute, per device, whichever agent sends them */
  maxCommandRate: number;
  /** Max duration for a single scope (minutes). NOT enforced here: the governor never sees when a scope started. */
  maxScopeDuration: number;
}

export interface GovernorVerdict {
  allowed: boolean;
  reason?: string;
  /** Safety check results for audit logging */
  checks: SafetyCheck[];
  timestamp: number;
}

export interface SafetyCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

// ── Hardware State (read from independent safety channel) ──────────────────

export interface HardwareState {
  isEStopEngaged: boolean;
  isMaintenanceMode: boolean;
  isLotoActive: boolean;
  lastSafetyCheck: Timestamp;
}

// ── Governor Implementation ────────────────────────────────────────────────

const DEFAULT_ENVELOPE: OperationalEnvelope = {
  maxVelocity: 500,       // mm/s — conservative default
  maxTemperature: 300,     // °C
  maxForce: 100,           // N
  maxCommandRate: 60,      // per minute
  maxScopeDuration: 120,   // minutes
};

/** Parameters bounded by the envelope. A sign on velocity or force is a direction, so those are bounded by magnitude. */
const BOUNDED_PARAMS = [
  { param: "velocity", limit: "maxVelocity", label: "Velocity", unit: "", magnitude: true },
  { param: "temperature", limit: "maxTemperature", label: "Temperature", unit: "°C", magnitude: false },
  { param: "force", limit: "maxForce", label: "Force", unit: "N", magnitude: true },
] as const;

function describeValue(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "string" ? JSON.stringify(value) : `a ${typeof value}`;
}

export class SafetyGovernor {
  private readonly envelope: OperationalEnvelope;
  private readonly commandLog: Map<string, number[]> = new Map(); // deviceId → timestamps
  private hardwareState: HardwareState;

  constructor(
    envelope?: Partial<OperationalEnvelope>,
    initialHardwareState?: Partial<HardwareState>,
  ) {
    // Only declared values override a default: an explicit undefined must not remove a limit.
    const declared = Object.fromEntries(
      Object.entries(envelope ?? {}).filter(([, value]) => value !== undefined),
    ) as Partial<OperationalEnvelope>;
    if (declared.allowedGcodes?.length) {
      throw new Error(
        "allowedGcodes is not enforced by the SafetyGovernor, which never sees G-code; enforce it in the adapter, or leave it out",
      );
    }
    this.envelope = {
      ...DEFAULT_ENVELOPE,
      ...declared,
      // RegExp.test with the g or y flag resumes from lastIndex, so a repeat of a match would pass.
      forbiddenPatterns: declared.forbiddenPatterns?.map((p) => new RegExp(p.source, p.flags.replace(/[gy]/g, ""))),
    };
    this.hardwareState = {
      isEStopEngaged: false,
      isMaintenanceMode: false,
      isLotoActive: false,
      lastSafetyCheck: new Date().toISOString(),
      ...initialHardwareState,
    };
  }

  /**
   * Validate a physical command. Returns a verdict with full audit trail.
   * This is the ONLY path from agent code to physical hardware.
   */
  async validateCommand(cmd: PhysicalCommand): Promise<GovernorVerdict> {
    const checks: SafetyCheck[] = [];
    const now = Date.now();

    // 1. Hardware interlocks (highest priority — cannot be overridden)
    checks.push({
      name: "e_stop",
      passed: !this.hardwareState.isEStopEngaged,
      detail: this.hardwareState.isEStopEngaged ? "E-stop is engaged" : undefined,
    });

    checks.push({
      name: "maintenance_mode",
      passed: !this.hardwareState.isMaintenanceMode,
      detail: this.hardwareState.isMaintenanceMode ? "Equipment in maintenance mode" : undefined,
    });

    checks.push({
      name: "loto_active",
      passed: !this.hardwareState.isLotoActive,
      detail: this.hardwareState.isLotoActive ? "LOTO lockout active — physical isolation" : undefined,
    });

    // If any hardware interlock fails, deny immediately
    if (checks.some((c) => !c.passed)) {
      return { allowed: false, reason: "Hardware interlock active", checks, timestamp: now };
    }

    // 2. Command class check
    checks.push({
      name: "command_class",
      passed: this.isClassAllowed(cmd),
      detail: !this.isClassAllowed(cmd)
        ? `Class '${cmd.class}' requires ${cmd.class === "scoped" ? "active scope" : "operator approval"}`
        : undefined,
    });

    // 3. Rate limiting (prevent stuttering wear on physical equipment): per
    // device, so a second agent does not get a second budget on the same device.
    const rateOk = this.checkRateLimit(cmd.deviceId, now);
    checks.push({
      name: "rate_limit",
      passed: rateOk,
      detail: !rateOk
        ? `Exceeded ${this.envelope.maxCommandRate} commands/minute on device ${cmd.deviceId}`
        : undefined,
    });

    // 4. Operational envelope (parameter range validation)
    const envelopeChecks = this.checkEnvelope(cmd);
    checks.push(...envelopeChecks);

    // 5. Forbidden patterns (dangerous parameter combinations)
    const patternCheck = this.checkForbiddenPatterns(cmd);
    checks.push(patternCheck);

    // Final verdict
    const allPassed = checks.every((c) => c.passed);
    if (allPassed) {
      this.recordCommand(cmd.deviceId, now);
    }

    return {
      allowed: allPassed,
      reason: allPassed ? undefined : checks.find((c) => !c.passed)?.detail,
      checks,
      timestamp: now,
    };
  }

  /** Update hardware state from independent safety channel */
  updateHardwareState(update: Partial<HardwareState>): void {
    this.hardwareState = { ...this.hardwareState, ...update };
  }

  /** Get current hardware state (for monitoring) */
  getHardwareState(): Readonly<HardwareState> {
    return { ...this.hardwareState };
  }

  // ── Private Checks ───────────────────────────────────────────────────

  private isClassAllowed(cmd: PhysicalCommand): boolean {
    switch (cmd.class) {
      case "read":
        return true; // Always allowed
      case "safe":
        return true; // Allowed during active job (caller validates job state)
      case "scoped":
        return !!cmd.scopeId; // Requires active scope
      case "privileged":
        return false; // Never auto-approved — requires operator
    }
  }

  private checkRateLimit(deviceId: string, now: number): boolean {
    const window = 60_000; // 1 minute
    const timestamps = this.commandLog.get(deviceId) ?? [];
    const recent = timestamps.filter((t) => now - t < window);
    return recent.length < this.envelope.maxCommandRate;
  }

  private recordCommand(deviceId: string, now: number): void {
    const timestamps = this.commandLog.get(deviceId) ?? [];
    const window = 60_000;
    const recent = timestamps.filter((t) => now - t < window);
    recent.push(now);
    this.commandLog.set(deviceId, recent);
  }

  private checkEnvelope(cmd: PhysicalCommand): SafetyCheck[] {
    const checks: SafetyCheck[] = [];

    for (const { param, limit, label, unit, magnitude } of BOUNDED_PARAMS) {
      const value = cmd.params[param];
      if (value === undefined) continue; // the command does not set it
      const name = `${param}_envelope`;
      const max = this.envelope[limit];
      // A present value is checked or refused, never skipped: a numeric string,
      // an object, null or NaN would otherwise pass unchecked.
      if (typeof value !== "number" || !Number.isFinite(value)) {
        checks.push({ name, passed: false, detail: `${label} must be a finite number (got ${describeValue(value)})` });
        continue;
      }
      // 0 is a limit. An undeclared limit refuses rather than passes.
      if (max === undefined) {
        checks.push({ name, passed: false, detail: `${label} has no declared limit` });
        continue;
      }
      const measured = magnitude ? Math.abs(value) : value;
      checks.push({
        name,
        passed: measured <= max,
        detail:
          measured > max
            ? `${label} ${value}${unit} exceeds max ${max}${unit}${value < 0 && magnitude ? " in magnitude" : ""}`
            : undefined,
      });
    }

    return checks;
  }

  private checkForbiddenPatterns(cmd: PhysicalCommand): SafetyCheck {
    if (!this.envelope.forbiddenPatterns?.length) {
      return { name: "forbidden_patterns", passed: true };
    }

    const paramsJson = JSON.stringify(cmd.params);
    for (const pattern of this.envelope.forbiddenPatterns) {
      if (pattern.test(paramsJson)) {
        return {
          name: "forbidden_patterns",
          passed: false,
          detail: `Command parameters match forbidden pattern: ${pattern.source}`,
        };
      }
    }

    return { name: "forbidden_patterns", passed: true };
  }
}
