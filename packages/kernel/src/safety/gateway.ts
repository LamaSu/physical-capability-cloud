/**
 * SafetyGateway — the ONLY path from any caller to physical hardware.
 *
 * Architectural invariant (enforced here, not by convention):
 *   - All PhysicalCommands pass SafetyGovernor.validateCommand() before dispatch
 *   - All device commands pass CircuitBreaker.canExecute() before dispatch
 *   - Execution failures are recorded to CircuitBreaker.recordFailure()
 *   - The execute callback is held by the gateway, not by callers
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
   * validateAndRelay — the ONLY entry point for physical commands.
   *
   * Flow:
   *   1. Circuit breaker pre-check (fast-fail if device is tripped)
   *   2. SafetyGovernor.validateCommand() — full 5-check pipeline
   *   3. execute() callback if both allow
   *   4. Record success/failure to circuit breaker
   *   5. Return full audit trail
   *
   * @param cmd    Physical command descriptor (carries deviceId, agentDid, class, etc.)
   * @param execute Callback that performs the actual work. The gateway holds the only
   *               reference to hardware — callers supply a closure, not an adapter.
   */
  async validateAndRelay(
    cmd: PhysicalCommand,
    execute: () => Promise<unknown>,
  ): Promise<SafetyGatewayResult> {
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

    // Step 3 — Execute
    try {
      const result = await execute();

      // Step 4a — Record success
      this.breaker.recordSuccess(cmd.deviceId);

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
