import type { FastifyRequest } from "fastify";
import { isPlainIdentifier, logSafeId, logSafeInt, logSafeSmallInt, redactSecrets } from "../redaction.js";
import { analyticsIdentityDigest } from "./analytics-identity.js";

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
export function safeServerEventProperties(properties?: Record<string, unknown>, event?: string): Record<string, unknown> {
  if (event && Object.hasOwn(SECURITY_EVENT_PROPERTIES, event)) return safeSecurityEventProperties(event, properties);
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

/** Plain identifiers and monitor digests pass; other identities become process-local digests. */
export function safeServerEventDistinctId(value?: unknown): string {
  if (value === undefined || value === "") return "pcc-gateway";
  if (isPlainIdentifier(value)) return value;
  if (typeof value === "string" && /^security:[0-9a-f]{16}$/.test(value)) return value;
  return `h:${analyticsIdentityDigest(typeof value === "string" ? value : String(value))}`;
}

class PreparedServerEventIdentity {
  readonly #value: string;
  constructor(value: unknown) {
    this.#value = safeServerEventDistinctId(value);
    Object.freeze(this);
  }
  static read(value: PreparedServerEventIdentity): string { return value.#value; }
}

/** Carry a formatted identity to capture without treating a digest string as trusted input. */
export function prepareServerEventDistinctId(value?: unknown): string | PreparedServerEventIdentity {
  const safe = safeServerEventDistinctId(value);
  return value === undefined || value === "" || safe === value ? safe : new PreparedServerEventIdentity(value);
}

export function consumeServerEventDistinctId(value?: unknown): string {
  return value instanceof PreparedServerEventIdentity ? PreparedServerEventIdentity.read(value) : safeServerEventDistinctId(value);
}

const securityRoutePatterns = new Set<string>();

/** Only Fastify's matched declaration enters the path allow-list, never the requested URL. */
export function securityRoutePattern(req: Pick<FastifyRequest, "routeOptions">): string {
  const pattern = req.routeOptions?.url;
  if (!pattern) return "unmatched";
  securityRoutePatterns.add(pattern);
  return pattern;
}

const SECURITY_ENUM_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "OTHER"],
  uaClass: ["none", "headless", "automation", "ai_agent", "scanner", "http_library", "browser", "other"],
  referer: ["direct", "same_origin", "cross_origin", "invalid"],
  contentType: ["application/json", "application/x-www-form-urlencoded", "multipart/form-data", "text/plain", "text/html", "application/xml", "text/xml", "application/octet-stream", "other", "none"],
  edge: ["cloudflare", "railway", "vercel", "none"],
  attackType: ["sqli", "xss", "path_traversal", "cmd_injection"],
  attackSource: ["url", "query", "body", "header:referer", "header:user-agent", "header:x-forwarded-for", "header:cookie"],
  botType: ["headless", "automation", "stealth_browser", "scraper", "ai_agent", "known_scanner"],
  severity: ["medium", "high", "critical"],
  reason: ["HeadlessChrome in UA", "Automation framework in UA", "Legacy headless browser", "Chrome UA but missing sec-ch-ua header", "Browser UA but missing sec-fetch-* headers", "No accept-language header", "AI agent in UA", "Security scanner in UA", "HTTP library in UA", "Missing or minimal user-agent"],
};
const FINGERPRINT_PROPERTIES = ["clientId", "method", "path", "uaClass", "uaLength", "referer", "acceptLanguage", "contentType", "cfCountry", "edge", "forwardedHops", "timestamp"];
const SECURITY_EVENT_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  request_fingerprint: [...FINGERPRINT_PROPERTIES, "statusCode", "durationMs", "responseSize"],
  honeypot_triggered: [...FINGERPRINT_PROPERTIES, "honeypotPath", "severity"],
  attack_detected: [...FINGERPRINT_PROPERTIES, "attackType", "attackSource", "attackLength", "attackPayload", "severity"],
  bot_detected: [...FINGERPRINT_PROPERTIES, "botType", "confidence", "reason", "severity"],
  rate_limit_exceeded: [...FINGERPRINT_PROPERTIES, "requestCount", "windowMs", "severity"],
};
const SECURITY_COUNTS = new Set(["uaLength", "forwardedHops", "attackLength", "durationMs", "requestCount", "windowMs"]);

function safeSecurityEventProperties(event: string, properties?: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of SECURITY_EVENT_PROPERTIES[event] ?? []) {
    const value = properties?.[key];
    if (value === undefined) continue;
    if (Object.hasOwn(SECURITY_ENUM_PROPERTIES, key) && typeof value === "string" && SECURITY_ENUM_PROPERTIES[key].includes(value)) safe[key] = value;
    else if (SECURITY_COUNTS.has(key)) safe[key] = logSafeInt(value);
    else if (key === "statusCode") safe[key] = logSafeSmallInt(value, 100, 599);
    else if (key === "confidence" && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) safe[key] = value;
    else if (key === "clientId" && typeof value === "string" && /^[0-9a-f]{16}$/.test(value)) safe[key] = value;
    else if (["path", "honeypotPath"].includes(key) && typeof value === "string" && (value === "unmatched" || securityRoutePatterns.has(value))) safe[key] = value;
    else if (key === "acceptLanguage" && typeof value === "string" && /^(?:[a-z]{2,3}|other|none)$/.test(value)) safe[key] = value;
    else if (key === "cfCountry" && typeof value === "string" && /^(?:[A-Z]{2}|unknown)$/.test(value)) safe[key] = value;
    else if (key === "timestamp" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value))) safe[key] = value;
    else if (key === "responseSize") safe[key] = logSafeInt(typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : value);
  }
  // Rebuild the summary from validated classifications instead of accepting summary text.
  if (event === "attack_detected" && typeof safe.attackType === "string" && typeof safe.attackSource === "string" && typeof safe.attackLength === "number" && typeof safe.path === "string") {
    safe.attackPayload = `${safe.attackType} in ${safe.attackSource}, ${safe.attackLength} chars, at ${safe.path}`;
  }
  return safe;
}
