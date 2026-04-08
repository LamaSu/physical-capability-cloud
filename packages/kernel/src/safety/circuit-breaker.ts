/**
 * Circuit Breaker for physical equipment protection.
 *
 * Prevents repeated failures from damaging equipment.
 * Three states: CLOSED (normal) → OPEN (tripped) → HALF_OPEN (testing recovery).
 *
 * When open, ALL commands to the affected device are rejected until
 * the cooldown period elapses and a test command succeeds.
 */

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before tripping */
  failureThreshold: number;
  /** Cooldown period in ms before allowing a test command */
  cooldownMs: number;
  /** Number of successes in half_open to fully close */
  successThreshold: number;
}

interface CircuitRecord {
  state: CircuitState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastFailure: number;
  trippedAt: number | null;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  cooldownMs: 60_000, // 1 minute
  successThreshold: 2,
};

export class CircuitBreaker {
  private readonly config: CircuitBreakerConfig;
  private readonly circuits: Map<string, CircuitRecord> = new Map();

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Check if a command to this device is allowed */
  canExecute(deviceId: string): boolean {
    const circuit = this.getCircuit(deviceId);
    const now = Date.now();

    switch (circuit.state) {
      case "closed":
        return true;

      case "open":
        // Check if cooldown has elapsed
        if (circuit.trippedAt && now - circuit.trippedAt >= this.config.cooldownMs) {
          circuit.state = "half_open";
          circuit.consecutiveSuccesses = 0;
          return true; // Allow one test command
        }
        return false;

      case "half_open":
        return true; // Allow test commands
    }
  }

  /** Record a successful command execution */
  recordSuccess(deviceId: string): void {
    const circuit = this.getCircuit(deviceId);
    circuit.consecutiveFailures = 0;

    if (circuit.state === "half_open") {
      circuit.consecutiveSuccesses++;
      if (circuit.consecutiveSuccesses >= this.config.successThreshold) {
        circuit.state = "closed";
        circuit.trippedAt = null;
      }
    }
  }

  /** Record a failed command execution */
  recordFailure(deviceId: string): void {
    const circuit = this.getCircuit(deviceId);
    circuit.consecutiveFailures++;
    circuit.lastFailure = Date.now();
    circuit.consecutiveSuccesses = 0;

    if (circuit.state === "half_open") {
      // Any failure in half_open immediately re-trips
      circuit.state = "open";
      circuit.trippedAt = Date.now();
    } else if (circuit.consecutiveFailures >= this.config.failureThreshold) {
      circuit.state = "open";
      circuit.trippedAt = Date.now();
    }
  }

  /** Manually reset a circuit (operator override) */
  reset(deviceId: string): void {
    this.circuits.set(deviceId, {
      state: "closed",
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      lastFailure: 0,
      trippedAt: null,
    });
  }

  /** Get the current state of all circuits */
  getStatus(): Map<string, { state: CircuitState; failures: number }> {
    const status = new Map<string, { state: CircuitState; failures: number }>();
    for (const [id, record] of this.circuits) {
      status.set(id, { state: record.state, failures: record.consecutiveFailures });
    }
    return status;
  }

  /** Get circuit state for a specific device */
  getDeviceState(deviceId: string): CircuitState {
    return this.getCircuit(deviceId).state;
  }

  private getCircuit(deviceId: string): CircuitRecord {
    let circuit = this.circuits.get(deviceId);
    if (!circuit) {
      circuit = {
        state: "closed",
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        lastFailure: 0,
        trippedAt: null,
      };
      this.circuits.set(deviceId, circuit);
    }
    return circuit;
  }
}
