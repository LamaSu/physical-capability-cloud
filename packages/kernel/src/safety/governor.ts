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
  /** Max velocity (mm/s or equivalent) */
  maxVelocity?: number;
  /** Max temperature (°C) */
  maxTemperature?: number;
  /** Max force (N) */
  maxForce?: number;
  /** Allowed G-code commands (if applicable) */
  allowedGcodes?: string[];
  /** Forbidden parameter patterns */
  forbiddenPatterns?: RegExp[];
  /** Max commands per minute */
  maxCommandRate: number;
  /** Max duration for a single scope (minutes) */
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

export class SafetyGovernor {
  private readonly envelope: OperationalEnvelope;
  private readonly commandLog: Map<string, number[]> = new Map(); // agentDid → timestamps
  private hardwareState: HardwareState;

  constructor(
    envelope?: Partial<OperationalEnvelope>,
    initialHardwareState?: Partial<HardwareState>,
  ) {
    this.envelope = { ...DEFAULT_ENVELOPE, ...envelope };
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

    // 3. Rate limiting (prevent stuttering wear on physical equipment)
    const rateOk = this.checkRateLimit(cmd.agentDid, now);
    checks.push({
      name: "rate_limit",
      passed: rateOk,
      detail: !rateOk
        ? `Exceeded ${this.envelope.maxCommandRate} commands/minute`
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
      this.recordCommand(cmd.agentDid, now);
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

  private checkRateLimit(agentDid: string, now: number): boolean {
    const window = 60_000; // 1 minute
    const timestamps = this.commandLog.get(agentDid) ?? [];
    const recent = timestamps.filter((t) => now - t < window);
    return recent.length < this.envelope.maxCommandRate;
  }

  private recordCommand(agentDid: string, now: number): void {
    const timestamps = this.commandLog.get(agentDid) ?? [];
    const window = 60_000;
    const recent = timestamps.filter((t) => now - t < window);
    recent.push(now);
    this.commandLog.set(agentDid, recent);
  }

  private checkEnvelope(cmd: PhysicalCommand): SafetyCheck[] {
    const checks: SafetyCheck[] = [];

    // Velocity check
    if (this.envelope.maxVelocity && typeof cmd.params.velocity === "number") {
      checks.push({
        name: "velocity_envelope",
        passed: cmd.params.velocity <= this.envelope.maxVelocity,
        detail:
          cmd.params.velocity > this.envelope.maxVelocity
            ? `Velocity ${cmd.params.velocity} exceeds max ${this.envelope.maxVelocity}`
            : undefined,
      });
    }

    // Temperature check
    if (this.envelope.maxTemperature && typeof cmd.params.temperature === "number") {
      checks.push({
        name: "temperature_envelope",
        passed: cmd.params.temperature <= this.envelope.maxTemperature,
        detail:
          cmd.params.temperature > this.envelope.maxTemperature
            ? `Temperature ${cmd.params.temperature}°C exceeds max ${this.envelope.maxTemperature}°C`
            : undefined,
      });
    }

    // Force check
    if (this.envelope.maxForce && typeof cmd.params.force === "number") {
      checks.push({
        name: "force_envelope",
        passed: cmd.params.force <= this.envelope.maxForce,
        detail:
          cmd.params.force > this.envelope.maxForce
            ? `Force ${cmd.params.force}N exceeds max ${this.envelope.maxForce}N`
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
