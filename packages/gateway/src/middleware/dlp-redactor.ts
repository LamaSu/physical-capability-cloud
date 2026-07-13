/**
 * DLP Redactor middleware — role-aware response redaction.
 *
 * Attaches an `onSend` hook that intercepts JSON responses and applies
 * field-level redaction rules based on the caller's role. Rules come from
 * the dlpRules table (cached 5 minutes) with hardcoded defaults as fallback.
 *
 * Redaction strategies:
 *   - remove      — delete the field entirely
 *   - mask        — show partial value (e.g., "0x****abcd")
 *   - hash        — replace with SHA-256 hex digest
 *   - regionalize — reduce location precision (lat/lng → city-level or
 *                   replace location strings with region label)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHash } from "node:crypto";
import { getRepos } from "../db.js";

// ── Redaction Rule Types ─────────────────────────────────────────

interface RedactionRule {
  fieldPath: string;
  resourceType: string;
  visibleToRoles: string[];
  strategy: "remove" | "mask" | "hash" | "regionalize";
  maskPattern?: string;
  regionPrecision?: string;
}

// ── Default Rules ────────────────────────────────────────────────

const DEFAULT_RULES: RedactionRule[] = [
  // Wallet addresses — visible to owner and admin only
  {
    fieldPath: "operatorAddress",
    resourceType: "*",
    visibleToRoles: ["admin", "operator"],
    strategy: "mask",
    maskPattern: "0x****{last4}",
  },
  // Physical location — remove for non-owners (sensitive physical security info)
  {
    fieldPath: "physicalAddress",
    resourceType: "kernel",
    visibleToRoles: ["admin", "operator"],
    strategy: "remove",
  },
  // Coordinates — city-level precision for non-owners
  {
    fieldPath: "location",
    resourceType: "kernel",
    visibleToRoles: ["admin", "operator"],
    strategy: "regionalize",
    regionPrecision: "city",
  },
  // API key values — never expose raw keys (defence in depth)
  {
    fieldPath: "rawKey",
    resourceType: "*",
    visibleToRoles: [],
    strategy: "remove",
  },
  {
    fieldPath: "keyHash",
    resourceType: "*",
    visibleToRoles: ["admin"],
    strategy: "mask",
  },
  // Job parameters may contain trade secrets (G-code, toolpaths)
  {
    fieldPath: "parameters.gcode",
    resourceType: "job",
    visibleToRoles: ["admin", "operator"],
    strategy: "hash",
  },
  {
    fieldPath: "parameters.toolpath",
    resourceType: "job",
    visibleToRoles: ["admin", "operator"],
    strategy: "hash",
  },
];

// ── DLP Rule Cache ───────────────────────────────────────────────

let ruleCache: RedactionRule[] = [];
let lastRuleCacheRefresh = 0;
const RULE_CACHE_TTL = 300_000; // 5 minutes

function refreshRuleCache(): void {
  try {
    const rows = getRepos().governance.findAllDlpRules();
    if (rows.length > 0) {
      ruleCache = rows.map((r) => ({
        fieldPath: r.fieldPath,
        resourceType: r.resourceType,
        visibleToRoles: Array.isArray(r.visibleToRoles) ? r.visibleToRoles : [],
        strategy: r.redactionStrategy as RedactionRule["strategy"],
        maskPattern: r.maskPattern ?? undefined,
        regionPrecision: r.regionPrecision ?? undefined,
      }));
    } else {
      ruleCache = [...DEFAULT_RULES];
    }
  } catch {
    // DB not ready — use defaults
    if (ruleCache.length === 0) {
      ruleCache = [...DEFAULT_RULES];
    }
  }
  lastRuleCacheRefresh = Date.now();
}

function ensureRuleCacheReady(): void {
  if (Date.now() - lastRuleCacheRefresh > RULE_CACHE_TTL) {
    refreshRuleCache();
  }
}

// ── Redaction Strategies ─────────────────────────────────────────

function maskValue(value: unknown, maskPattern?: string): unknown {
  const str = String(value ?? "");
  if (!maskPattern) {
    // Default mask: show first 4 and last 4 chars
    if (str.length <= 8) return "****";
    return `${str.slice(0, 4)}****${str.slice(-4)}`;
  }
  // Support {last4} placeholder
  const last4 = str.slice(-4);
  return maskPattern.replace("{last4}", last4);
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

/**
 * Reduce coordinate precision to city-level (1 decimal place ~ 11km radius).
 * For string locations, returns a generic region label.
 */
function regionalizeValue(value: unknown, regionPrecision?: string): unknown {
  if (value === null || value === undefined) return value;

  // Numeric coordinate — truncate precision
  if (typeof value === "number") {
    const precision = regionPrecision === "country" ? 0
      : regionPrecision === "region" ? 1
      : regionPrecision === "exact" ? 6
      : 1; // "city" = 1 decimal place
    return parseFloat(value.toFixed(precision));
  }

  // Object with lat/lng fields — regionalize both coordinates
  if (typeof value === "object" && !Array.isArray(value)) {
    const loc = value as Record<string, unknown>;
    const result: Record<string, unknown> = { ...loc };
    if (typeof loc["lat"] === "number") {
      result["lat"] = regionalizeValue(loc["lat"], regionPrecision);
    }
    if (typeof loc["lng"] === "number") {
      result["lng"] = regionalizeValue(loc["lng"], regionPrecision);
    }
    if (typeof loc["lon"] === "number") {
      result["lon"] = regionalizeValue(loc["lon"], regionPrecision);
    }
    return result;
  }

  // String address — redact to generic label
  if (typeof value === "string") {
    return "[location redacted]";
  }

  return value;
}

function redactValue(
  value: unknown,
  strategy: RedactionRule["strategy"],
  maskPattern?: string,
  regionPrecision?: string,
): unknown {
  switch (strategy) {
    case "remove":      return undefined; // signal to delete the key
    case "mask":        return maskValue(value, maskPattern);
    case "hash":        return hashValue(value);
    case "regionalize": return regionalizeValue(value, regionPrecision);
    default:            return value;
  }
}

// ── Object Walker ────────────────────────────────────────────────

/**
 * Get a nested value by dot-separated path (e.g., "parameters.gcode").
 * Returns undefined if any segment is missing.
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Set a nested value by dot-separated path, or delete it if value is undefined.
 */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (typeof current[part] !== "object" || current[part] === null) return;
    current = current[part] as Record<string, unknown>;
  }

  const lastKey = parts[parts.length - 1];
  if (value === undefined) {
    delete current[lastKey];
  } else {
    current[lastKey] = value;
  }
}

/**
 * Apply redaction rules to an object (deep clone first).
 * Only rules whose resourceType matches "*" or the detected resource type are applied.
 */
function applyRedaction(
  obj: Record<string, unknown>,
  rules: RedactionRule[],
  callerRoles: string[],
): Record<string, unknown> {
  const result = structuredClone(obj);

  for (const rule of rules) {
    // Check if caller has any of the visible roles
    const callerCanSee = rule.visibleToRoles.some((r) => callerRoles.includes(r));
    if (callerCanSee) continue;

    // Check if the field exists
    const currentValue = getNestedValue(result, rule.fieldPath);
    if (currentValue === undefined) continue;

    // Apply the redaction strategy
    const redacted = redactValue(currentValue, rule.strategy, rule.maskPattern, rule.regionPrecision);
    setNestedValue(result, rule.fieldPath, redacted);
  }

  return result;
}

// ── Role Resolution ──────────────────────────────────────────────

/**
 * Determine caller's roles from request context. FAIL CLOSED — an unresolved
 * caller gets NO privileged role and therefore the fully-redacted view.
 *
 * For API-key callers: read the literal scopes from the key record.
 * C-01: "*" is NOT a privileged role and does NOT map to admin/all-roles —
 * un-redaction requires the literal role (e.g. "admin", "operator").
 * C-02: a SIWE principal is NOT auto-operator; without an authoritative role
 * record it gets no privileged role.
 */
function getCallerRoles(req: FastifyRequest): string[] {
  if (!req.apiKeyId && !req.operatorId && !req.userId) {
    return [];
  }

  if (req.apiKeyId) {
    try {
      const keyRecord = getRepos().apiKeys.findById(req.apiKeyId);
      if (!keyRecord) return [];

      let scopesRaw: unknown;
      try {
        scopesRaw = JSON.parse(keyRecord.scopes);
      } catch {
        scopesRaw = keyRecord.scopes;
      }

      const scopes: string[] = Array.isArray(scopesRaw)
        ? (scopesRaw as string[]).filter((s) => typeof s === "string")
        : typeof scopesRaw === "string"
          ? scopesRaw.split(",").map((s) => s.trim()).filter(Boolean)
          : [];

      // C-01: strip "*" — a wildcard scope confers no privileged visibility.
      return scopes.filter((s) => s !== "*");
    } catch {
      return [];
    }
  }

  // C-02: SIWE session users (or a bare operatorId) are NOT defaulted to the
  // operator role. Without an authoritative record they hold no privileged role
  // and see the redacted view, identical to any other unprivileged principal.
  // TODO(audit P0 follow-up, Wave 1): resolve the role from a normalized
  // principal / ownership record — e.g. grant "operator" only for the wallet
  // that actually owns the resource in the response being redacted.
  return [];
}

// ── JSON Detection ───────────────────────────────────────────────

function isJsonContentType(reply: FastifyReply): boolean {
  const ct = reply.getHeader("content-type");
  if (!ct) return false;
  const ctStr = Array.isArray(ct) ? ct[0] : String(ct);
  return ctStr.includes("application/json");
}

// ── Fastify Plugin ───────────────────────────────────────────────

async function dlpRedactorImpl(app: FastifyInstance) {
  app.addHook("onSend", async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    // Only process JSON responses
    if (!isJsonContentType(reply)) return payload;

    // Skip non-string payloads (buffers, streams — not typical for JSON routes)
    if (typeof payload !== "string") return payload;

    ensureRuleCacheReady();

    const callerRoles = getCallerRoles(req);

    // Admin callers see everything unredacted
    if (callerRoles.includes("admin")) return payload;

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // Not valid JSON — pass through unchanged
      return payload;
    }

    if (typeof parsed !== "object" || parsed === null) return payload;

    const redacted = applyRedaction(
      parsed as Record<string, unknown>,
      ruleCache.length > 0 ? ruleCache : DEFAULT_RULES,
      callerRoles,
    );

    return JSON.stringify(redacted);
  });
}

// C-01/C-02: dlpRedactor MUST run as a NON-ENCAPSULATED plugin (mirroring
// apiGate) so its onSend hook applies to sibling route plugins; without the
// skip-override symbol its redaction is INERT on routes registered elsewhere.
(dlpRedactorImpl as unknown as Record<symbol, unknown>)[Symbol.for("skip-override")] = true;
(dlpRedactorImpl as unknown as Record<symbol, unknown>)[Symbol.for("fastify.display-name")] = "dlpRedactor";

export const dlpRedactor = dlpRedactorImpl;
