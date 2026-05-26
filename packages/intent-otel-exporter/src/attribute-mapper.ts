/**
 * OpenTelemetry semantic-convention → DemandEnvelope mapping.
 *
 * The strategy is deliberately permissive: an OTel span is intent-shaped if
 * its name OR attributes signal a tool/MCP/agent/HTTP intent. We pull a
 * conservative subset of fields out of the span attributes and project them
 * into a DemandEnvelope. Missing fields fall back to neutral defaults so the
 * envelope still validates against DemandEnvelopeSchema.
 *
 * Sources for the conventions we honor:
 *   - GenAI semantic conventions (work-in-progress on opentelemetry-specification):
 *       gen_ai.system            (e.g. "anthropic", "openai")
 *       gen_ai.operation.name    (e.g. "chat", "tool_use", "completion")
 *       gen_ai.tool.name         (e.g. "browser_search", "code_executor")
 *       gen_ai.tool.call.id
 *   - General attributes:
 *       http.url / http.target / http.method
 *       url.full / url.path
 *       service.name             (from resource)
 *   - PCC-specific (clients can pre-stamp these to skip heuristics):
 *       pcc.capability_types     (string array or comma-separated string)
 *       pcc.budget_band          (one of the BudgetBand enum values)
 *       pcc.urgency_band         (one of the UrgencyBand enum values)
 *       pcc.assurance_tier       (0|1|2|3)
 *       pcc.geographic_region    (country code or region tag)
 *       pcc.origin_agent_id
 *       pcc.origin_agent_vendor
 *       pcc.requester_id_hash    (sha256 hex; never raw PII)
 *       pcc.summary              (≤200 chars; otherwise built from name)
 *
 * If the client supplies any pcc.* attribute, it overrides the heuristic
 * default. No raw bodies, no headers, no PII ever cross this boundary.
 */

import { computeCompositionSignature } from "@pcc/spec";
import type { BudgetBand, DemandEnvelope, IntentSource, UrgencyBand } from "@pcc/spec";

// ── OTel span shape ────────────────────────────────────────────────────────

/**
 * Minimal cross-section of a ReadableSpan we depend on. We avoid importing
 * the `@opentelemetry/sdk-trace-base` types at module-eval time so the
 * mapper is unit-testable without booting the SDK.
 */
export interface MinimalSpan {
  name: string;
  attributes: Record<string, unknown>;
  /** Resource attributes (e.g. service.name) — optional, some processors don't surface this */
  resource?: { attributes?: Record<string, unknown> } | undefined;
  /** ISO timestamp; defaults to now when unavailable */
  startTimeISO?: string;
  /** Span kind name — INTERNAL, CLIENT, SERVER, PRODUCER, CONSUMER */
  kindName?: string;
}

// ── Intent-shape detection ────────────────────────────────────────────────

/** Span name prefixes that mark intent-shaped activity. */
const INTENT_SPAN_NAME_PATTERNS: ReadonlyArray<RegExp> = [
  /^tool\./i,
  /^mcp\./i,
  /^agent\./i,
  /^gen_ai\./i,
  /^http\.request$/i,
];

/** Attribute keys whose presence (any of) flags a span as intent-shaped. */
const INTENT_ATTRIBUTE_KEYS: ReadonlyArray<string> = [
  "gen_ai.tool.name",
  "gen_ai.operation.name",
  "gen_ai.system",
  "mcp.tool.name",
  "agent.action",
  "pcc.capability_types",
];

/**
 * Heuristic: does this span represent an intent that should be captured?
 * Permissive by design — false negatives waste agent telemetry, false
 * positives are caught by DemandEnvelopeSchema validation downstream.
 */
export function isIntentShapedSpan(span: MinimalSpan): boolean {
  for (const pat of INTENT_SPAN_NAME_PATTERNS) {
    if (pat.test(span.name)) return true;
  }
  for (const k of INTENT_ATTRIBUTE_KEYS) {
    if (span.attributes[k] !== undefined && span.attributes[k] !== null) return true;
  }
  return false;
}

// ── Attribute helpers ──────────────────────────────────────────────────────

function attrString(attrs: Record<string, unknown>, key: string): string | undefined {
  const v = attrs[key];
  if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

function attrStringArray(attrs: Record<string, unknown>, key: string): string[] | undefined {
  const v = attrs[key];
  if (Array.isArray(v)) {
    const cleaned = v.filter((x): x is string => typeof x === "string" && x.length > 0);
    return cleaned.length > 0 ? cleaned : undefined;
  }
  if (typeof v === "string" && v.length > 0) {
    // Allow comma-separated as fallback (OTel string-array support varies by exporter)
    const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
    return parts.length > 0 ? parts : undefined;
  }
  return undefined;
}

function attrNumber(attrs: Record<string, unknown>, key: string): number | undefined {
  const v = attrs[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

// ── Defaults / classification ─────────────────────────────────────────────

const VALID_BUDGET_BANDS: ReadonlySet<BudgetBand> = new Set([
  "under_100",
  "100_1k",
  "1k_10k",
  "10k_100k",
  "100k_plus",
]);

const VALID_URGENCY_BANDS: ReadonlySet<UrgencyBand> = new Set([
  "standard",
  "rush",
  "emergency",
]);

function normalizeBudgetBand(input: unknown): BudgetBand {
  if (typeof input === "string" && VALID_BUDGET_BANDS.has(input as BudgetBand)) {
    return input as BudgetBand;
  }
  return "under_100";
}

function normalizeUrgencyBand(input: unknown): UrgencyBand {
  if (typeof input === "string" && VALID_URGENCY_BANDS.has(input as UrgencyBand)) {
    return input as UrgencyBand;
  }
  return "standard";
}

function normalizeAssuranceTier(input: unknown): 0 | 1 | 2 | 3 | undefined {
  const n = typeof input === "number" ? input : typeof input === "string" ? Number(input) : NaN;
  if (n === 0 || n === 1 || n === 2 || n === 3) return n;
  return undefined;
}

// ── Capability extraction ─────────────────────────────────────────────────

/**
 * Build the `capabilityTypes` array. Precedence:
 *   1. pcc.capability_types (explicit)
 *   2. gen_ai.tool.name      (single tool invocation)
 *   3. mcp.tool.name         (MCP-routed tool)
 *   4. span name             (last-resort fallback)
 */
function extractCapabilityTypes(span: MinimalSpan): string[] {
  const fromPcc = attrStringArray(span.attributes, "pcc.capability_types");
  if (fromPcc) return fromPcc;

  const tool =
    attrString(span.attributes, "gen_ai.tool.name") ??
    attrString(span.attributes, "mcp.tool.name");
  if (tool) return [tool];

  return [span.name];
}

/**
 * Build the ≤200-char summary string. Precedence:
 *   1. pcc.summary (explicit, truncated)
 *   2. gen_ai.operation.name + tool name
 *   3. span name + operation hint
 *   4. span name
 */
function extractSummary(span: MinimalSpan): string {
  const explicit = attrString(span.attributes, "pcc.summary");
  if (explicit) return explicit.slice(0, 200);

  const op = attrString(span.attributes, "gen_ai.operation.name");
  const tool =
    attrString(span.attributes, "gen_ai.tool.name") ??
    attrString(span.attributes, "mcp.tool.name");

  if (op && tool) return `${op} ${tool}`.slice(0, 200);
  if (op) return `${op} ${span.name}`.slice(0, 200);
  if (tool) return `tool call: ${tool}`.slice(0, 200);

  // HTTP-flavored fallback
  const httpMethod = attrString(span.attributes, "http.method");
  const url =
    attrString(span.attributes, "url.full") ??
    attrString(span.attributes, "http.url") ??
    attrString(span.attributes, "http.target");
  if (httpMethod && url) return `${httpMethod} ${url}`.slice(0, 200);

  return span.name.slice(0, 200);
}

/**
 * Best-effort vendor extraction. Reads gen_ai.system, then service.name from
 * resource attributes, then pcc.origin_agent_vendor explicit override.
 */
function extractVendor(span: MinimalSpan): string | undefined {
  const explicit = attrString(span.attributes, "pcc.origin_agent_vendor");
  if (explicit) return explicit;

  const system = attrString(span.attributes, "gen_ai.system");
  if (system) return system;

  const svc =
    span.resource?.attributes && attrString(span.resource.attributes, "service.name");
  if (svc) return svc;

  return undefined;
}

// ── Mapper ─────────────────────────────────────────────────────────────────

export interface MapOptions {
  /** Override the source enum (defaults to "otel" per IntentSource union). */
  source?: IntentSource;
  /** Provide a clock for deterministic createdAt values in tests. */
  now?: () => Date;
  /** Custom id factory; defaults to a span-derived id. */
  idFactory?: (span: MinimalSpan) => string;
}

/**
 * Map a span to a DemandEnvelope. Does NOT validate the result against
 * DemandEnvelopeSchema — that's the caller's job (and the gateway re-validates
 * server-side as a third gate).
 */
export function spanToDemandEnvelope(
  span: MinimalSpan,
  opts: MapOptions = {},
): DemandEnvelope {
  const capabilityTypes = extractCapabilityTypes(span);
  const summary = extractSummary(span);
  const vendor = extractVendor(span);

  const budgetBand = normalizeBudgetBand(span.attributes["pcc.budget_band"]);
  const urgencyBand = normalizeUrgencyBand(span.attributes["pcc.urgency_band"]);
  const assuranceTier = normalizeAssuranceTier(span.attributes["pcc.assurance_tier"]);
  const geographicRegion = attrString(span.attributes, "pcc.geographic_region");
  const originAgentId = attrString(span.attributes, "pcc.origin_agent_id");
  const requesterIdHash = attrString(span.attributes, "pcc.requester_id_hash");

  // OTel spans are atomic invocations — no dependency edges to encode.
  const compositionSignature = computeCompositionSignature(capabilityTypes, []);

  const now = opts.now ?? (() => new Date());
  const createdAt = span.startTimeISO ?? now().toISOString();

  const id =
    opts.idFactory?.(span) ??
    `otel-${(attrString(span.attributes, "gen_ai.tool.call.id") ?? `${createdAt}-${capabilityTypes[0] ?? "intent"}`).slice(0, 80)}`;

  // We're careful not to set keys to undefined under exactOptionalPropertyTypes.
  const envelope: DemandEnvelope = {
    id,
    source: opts.source ?? "otel",
    compositionSignature,
    capabilityTypes,
    summary,
    budgetBand,
    urgencyBand,
    createdAt,
  };
  if (assuranceTier !== undefined) envelope.assuranceTier = assuranceTier;
  if (geographicRegion !== undefined) envelope.geographicRegion = geographicRegion;
  if (originAgentId !== undefined) envelope.originAgentId = originAgentId;
  if (vendor !== undefined) envelope.originAgentVendor = vendor;
  if (requesterIdHash !== undefined) envelope.requesterIdHash = requesterIdHash;

  // Numeric attribute that some clients may stamp for embedding-based clustering.
  const embeddingFlag = attrNumber(span.attributes, "pcc.has_embedding");
  if (embeddingFlag !== undefined && embeddingFlag > 0) {
    // We don't pull the actual embedding vector from OTel attrs to keep
    // payload size bounded; clients can stamp `pcc.summary` instead and let
    // PCC's own embedder run downstream.
  }

  return envelope;
}
