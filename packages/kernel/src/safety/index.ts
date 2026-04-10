export { SafetyGovernor } from "./governor.js";
export type {
  PhysicalCommand,
  CommandClass,
  OperationalEnvelope,
  GovernorVerdict,
  SafetyCheck,
  HardwareState,
} from "./governor.js";

export { CircuitBreaker } from "./circuit-breaker.js";
export type { CircuitState, CircuitBreakerConfig } from "./circuit-breaker.js";

/**
 * SafetyGateway — the single enforced choke point between agent code and hardware.
 *
 * In production, always use getSafetyGateway(). Direct construction is for unit tests only.
 */
export {
  SafetyGateway,
  getSafetyGateway,
  initSafetyGateway,
  resetSafetyGateway,
} from "./gateway.js";
export type { SafetyGatewayResult, SafetyGatewayConfig } from "./gateway.js";

/**
 * Constitutional Constraints — OWASP ASI01 Goal Hijack mitigation.
 *
 * Hard rules per agent role that cannot be violated regardless of instruction content.
 * Call applyConstitution() before SafetyGovernor.validateCommand() in SafetyGateway.execute().
 */
export {
  applyConstitution,
  applyConstitutionStrict,
  UNIVERSAL_CONSTITUTION,
  ROLE_CONSTITUTION,
} from "./constitutional.js";
export type {
  AgentRole,
  ConstitutionalConstraint,
  ConstitutionResult,
} from "./constitutional.js";
