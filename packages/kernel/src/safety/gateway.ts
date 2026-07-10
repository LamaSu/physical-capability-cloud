/**
 * SafetyGateway — the ONLY path from any caller to physical hardware.
 *
 * Architectural invariant (enforced here, not by convention):
 *   - All PhysicalCommands pass SafetyGovernor.validateCommand() before dispatch
 *   - All device commands pass CircuitBreaker.canExecute() before dispatch
 *   - Real execution failures are recorded to CircuitBreaker.recordFailure()
 *
 * Two execution shapes are supported:
 *   1. In-band — validateAndRelay(cmd, execute): the gateway holds the execute
 *      callback, runs it, and records the real success/failure itself.
 *   2. Out-of-band — validateOnly(cmd) for admission, then the caller executes
 *      elsewhere (a fire-and-forget in-process runner, or a REMOTE executor
 *      that polls the relay) and reports the true outcome back via
 *      recordDeviceSuccess()/recordDeviceFailure(). This path exists because
 *      physical execution is frequently remote — the gateway cannot hold a
 *      closure over hardware in another process. Callers on this path MUST
 *      report the outcome, otherwise the breaker never observes a real device
 *      failure. (Passing a no-op execute to validateAndRelay is NOT a valid
 *      substitute: it records a phantom SUCCESS that resets the failure count
 *      and keeps the breaker permanently closed.)
 *
 * Standards: IEC 61508 SIL-2 mandatory choke point pattern
 *            IEC 62443 zone-boundary enforcement
 *
 * In production, always obtain via getSafetyGateway().
 * Direct construction (new SafetyGateway()) is for unit tests only.
 */

import { SafetyGovernor } from "./governor.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import type {
  PhysicalCommand,
  GovernorVerdict,
  OperationalEnvelope,
  HardwareState,
} from "./governor.js";
import type { CircuitBreakerConfig } from "./circuit-breaker.js";

// ── Result Types ──────────────────────────────────────────────────────────────

export interface SafetyGatewayResult {
  /** Whether the governor and circuit breaker allowed this command */
  allowed: boolean;
  /** Whether execute() was invoked and returned without throwing */
  executed: boolean;
  /** Full governor verdict (always present) */
  verdict?: GovernorVerdict;
  /** Execute() return value on success */
  result?: unknown;
  /** Reason string when allowed=false due to circuit breaker */
  reason?: string;
  /** Error from execute() when allowed=true but executed=false */
  error?: string;
}

export interface SafetyGatewayConfig {
  envelope?: Partial<OperationalEnvelope>;
  circuitBreaker?: Partial<CircuitBreakerConfig>;
  initialHardwareState?: Partial<HardwareState>;
}

// ── SafetyGateway ─────────────────────────────────────────────────────────────

export class SafetyGateway {
  private readonly governor: SafetyGovernor;
  private readonly breaker: CircuitBreaker;

  constructor(config?: SafetyGatewayConfig) {
    this.governor = new SafetyGovernor(
      config?.envelope,
      config?.initialHardwareState,
    );
    this.breaker = new CircuitBreaker(config?.circuitBreaker);
  }

  /**
   * validateOnly — admission control WITHOUT executing or recording an outcome.
   *
   * Runs the same two gates as validateAndRelay (circuit-breaker fast-fail +
   * the governor's full pipeline) but invokes NO execute callback and records
   * NEITHER success NOR failure on the breaker. Use this when the real work
   * runs OUTSIDE the gateway — a fire-and-forget in-process runner, or a remote
   * executor that polls the relay. Those callers MUST report the true outcome
   * afterward via recordDeviceSuccess() / recordDeviceFailure(), otherwise the
   * breaker never sees a real device failure.
   *
   * Rationale: the prior pattern passed a no-op `async () => undefined` execute
   * to validateAndRelay for pre-flight, which recorded a phantom SUCCESS on
   * every admission — resetting the consecutive-failure counter so the breaker
   * could never trip from real failures. validateOnly removes that false signal
   * while preserving the fast-fail rejection of an already-open breaker.
   *
   * @param cmd Physical command descriptor (carries deviceId, agentDid, class, etc.)
   */
  async validateOnly(cmd: PhysicalCommand): Promise<SafetyGatewayResult> {
    // Step 1 — Circuit breaker pre-check (fast-fail, no governor overhead)
    if (!this.breaker.canExecute(cmd.deviceId)) {
      const circuitState = this.breaker.getDeviceState(cmd.deviceId);
      return {
        allowed: false,
        executed: false,
        reason: `circuit_open`,
        // Include a minimal verdict for callers that want to log a uniform structure
        verdict: {
          allowed: false,
          reason: `Circuit breaker OPEN for device ${cmd.deviceId} (state: ${circuitState})`,
          checks: [
            {
              name: "circuit_breaker",
              passed: false,
              detail: `state=${circuitState}`,
            },
          ],
          timestamp: Date.now(),
        },
      };
    }

    // Step 2 — Safety governor (full 5-check pipeline)
    const verdict = await this.governor.validateCommand(cmd);
    if (!verdict.allowed) {
      // Governor rejection does NOT trip the circuit breaker —
      // this is a policy/safety violation, not a device failure.
      return { allowed: false, executed: false, verdict };
    }

    // Admitted. The caller executes out-of-band and reports the real outcome
    // back via recordDeviceSuccess()/recordDeviceFailure().
    return { allowed: true, executed: false, verdict };
  }

  /**
   * validateAndRelay — in-band entry point: validate, execute, record.
   *
   * Flow:
   *   1. Circuit breaker pre-check (fast-fail if device is tripped)
   *   2. SafetyGovernor.validateCommand() — full 5-check pipeline
   *   3. execute() callback if both allow
   *   4. Record success/failure to circuit breaker
   *   5. Return full audit trail
   *
   * Use this when the gateway can hold the execute closure over the hardware.
   * When execution happens out-of-band (fire-and-forget or a remote executor),
   * use validateOnly() + recordDeviceSuccess()/recordDeviceFailure() instead —
   * do NOT pass a no-op execute here (it records a phantom success).
   *
   * @param cmd    Physical command descriptor (carries deviceId, agentDid, class, etc.)
   * @param execute Callback that performs the actual work. The gateway holds the only
   *               reference to hardware — callers supply a closure, not an adapter.
   */
  async validateAndRelay(
    cmd: PhysicalCommand,
    execute: () => Promise<unknown>,
  ): Promise<SafetyGatewayResult> {
    // Steps 1-2 — admission control (breaker fast-fail + governor pipeline).
    const admission = await this.validateOnly(cmd);
    if (!admission.allowed) {
      return admission;
    }
    const verdict = admission.verdict!;

    // Step 3 — Execute (the gateway holds the execute callback for this path).
    try {
      const result = await execute();

      // Step 4a — Record outcome. A callback can signal device failure two
      // ways: throwing (caught below), or resolving to a result object that
      // self-reports failure ({ success: false }, e.g. MachineCommandResult).
      // Recording the latter as a success would reset the breaker's
      // consecutive-failure count and mask real device failures — a
      // fail-loud adapter would be silenced right here.
      const selfReportedFailure =
        typeof result === "object" &&
        result !== null &&
        "success" in result &&
        (result as { success: unknown }).success === false;

      if (selfReportedFailure) {
        this.breaker.recordFailure(cmd.deviceId);
      } else {
        this.breaker.recordSuccess(cmd.deviceId);
      }

      return { allowed: true, executed: true, verdict, result };
    } catch (err) {
      // Step 4b — Record failure
      this.breaker.recordFailure(cmd.deviceId);

      return {
        allowed: true,
        executed: false,
        verdict,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Update hardware interlock state (e-stop, maintenance, LOTO).
   * Must be called from the e-stop interrupt handler and the AgentHeartbeatMonitor.
   */
  updateHardwareState(update: Partial<HardwareState>): void {
    this.governor.updateHardwareState(update);
  }

  /** Get current hardware state (for monitoring). */
  getHardwareState(): Readonly<HardwareState> {
    return this.governor.getHardwareState();
  }

  /**
   * Operator-level circuit reset.
   * Requires operator authorization check in the calling route before invocation.
   */
  resetCircuit(deviceId: string): void {
    this.breaker.reset(deviceId);
  }

  /**
   * Record the REAL outcome of a device execution that ran OUTSIDE the gateway
   * (a fire-and-forget in-process runner, or a remote executor reporting via
   * the relay's POST /tool-result). Pair with validateOnly(): validateOnly
   * admits the command; these feed the true result back into the breaker so it
   * can open on real, repeated device failures — and reset on recovery.
   *
   * DESIGN FLAG (arch review S3): breaker + governor state currently lives in
   * per-process RAM in a tier meant to scale horizontally — N gateway
   * instances hold N independent breaker truths, and a deploy resets a tripped
   * breaker. This wiring makes the cloud-side breaker REAL today; the durable
   * fix is device-side ownership of safety state (executor / pcc-node). That is
   * a separate design decision, deliberately not solved here.
   */
  recordDeviceSuccess(deviceId: string): void {
    this.breaker.recordSuccess(deviceId);
  }

  /** Record a real device-execution failure (see recordDeviceSuccess). */
  recordDeviceFailure(deviceId: string): void {
    this.breaker.recordFailure(deviceId);
  }

  /** Status snapshot for monitoring endpoints. */
  getStatus(): {
    hardwareState: Readonly<HardwareState>;
    circuits: ReturnType<CircuitBreaker["getStatus"]>;
  } {
    return {
      hardwareState: this.governor.getHardwareState(),
      circuits: this.breaker.getStatus(),
    };
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _gateway: SafetyGateway | null = null;

/**
 * Get the process-wide SafetyGateway.
 * Throws if initSafetyGateway() has not been called first.
 */
export function getSafetyGateway(): SafetyGateway {
  if (!_gateway) {
    throw new Error(
      "[safety-gateway] Not initialized — call initSafetyGateway() before submitting any job",
    );
  }
  return _gateway;
}

/**
 * Initialize the gateway singleton. Must be called once at process startup,
 * before any device command and before route handlers are registered.
 *
 * Idempotent — subsequent calls return the existing instance.
 */
export function initSafetyGateway(config?: SafetyGatewayConfig): SafetyGateway {
  if (_gateway) return _gateway;
  _gateway = new SafetyGateway(config);
  return _gateway;
}

/**
 * Reset the singleton. FOR TESTS ONLY — never call in production.
 */
export function resetSafetyGateway(): void {
  _gateway = null;
}
