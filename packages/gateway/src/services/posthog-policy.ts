import { logSafeId, logSafeInt, logSafeSmallInt, redactSecrets } from "../redaction.js";

const IDENTIFIER_PROPERTIES = new Set([
  "kernelId", "deviceId", "jobId", "stepId", "capabilityType", "bundleId",
  "kernel_id", "device_id", "job_id", "capability_id", "trace_id",
]);
const COUNT_PROPERTIES = new Set([
  "capabilitiesRegistered", "proofCount", "log_count", "duration_ms", "quantity",
]);
const ENUM_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  type: ["machine", "sensor", "camera", "printer", "merkle_root", "proof"],
  adapterType: ["octoprint", "modbus", "opcua", "sila", "ipp", "generic-http", "mock"],
  action: ["created", "updated"],
  reason: ["queue_only", "emergency_stop", "policy_unavailable", "not_local", "no_configured_local_kernel"],
  operation: ["encrypt", "decrypt"],
  path: ["lit_action", "local"],
  first_stage: ["provision"],
  status: ["success", "failure", "completed", "failed"],
};

/** Operator identities retain bounded email or identifier forms only. */
function safeOperatorIdentity(value: unknown): string {
  if (typeof value === "string" && value.length <= 320 &&
      /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/.test(value) &&
      redactSecrets(value) === value) return value;
  return logSafeId(value);
}

/** Analytics accepts declared fields with bounded formats; free text is omitted. */
export function safeServerEventProperties(properties?: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (IDENTIFIER_PROPERTIES.has(key)) safe[key] = logSafeId(value);
    else if (key === "operatorAddress") safe[key] = safeOperatorIdentity(value);
    else if (COUNT_PROPERTIES.has(key)) safe[key] = logSafeInt(value);
    else if (key === "assuranceTier") safe[key] = logSafeSmallInt(value, 0, 3);
    else if (key === "http_status") safe[key] = logSafeSmallInt(value, 100, 599);
    else if (["external", "encrypted", "mock", "has_proposal"].includes(key) && typeof value === "boolean") safe[key] = value;
    else if (Object.hasOwn(ENUM_PROPERTIES, key) && typeof value === "string" && ENUM_PROPERTIES[key].includes(value)) safe[key] = value;
  }
  return safe;
}

/** Distinct IDs use the same identifier policy as diagnostic identifiers. */
export function safeServerEventDistinctId(value?: unknown): string {
  return value === undefined || value === "" ? "pcc-gateway" : logSafeId(value);
}
