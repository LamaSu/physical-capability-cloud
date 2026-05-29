/**
 * OASF skill / domain / module catalog cache.
 *
 * OASF requires `skills[]` and `domains[]` to be `{name, id}` pairs where
 * `id` is the numeric ID from the OASF schema server at
 * https://schema.oasf.outshift.com/ (skill_categories / domain_categories /
 * module_categories). We do not fetch the catalog at runtime in Phase 1 —
 * the cache below is a small subset of well-known IDs sufficient for the
 * agent skills OASF v1.0.0 ships with plus PCC's physical-capability
 * bridge defaults. Unknown skills/domains fall back to a top-level
 * category ID (1001 / 1500) and the full PCC taxonomy rides on the
 * `physical-capability/v1` module instead.
 *
 * Phase 2 will replace this with a weekly ETag-revalidated fetch from
 * https://schema.oasf.outshift.com/skill_categories etc.
 *
 * See: ai/scoping/agntcy-ads-oasf-bridge-2026-05-23.md §3.3 §10 (item 3)
 */

// ── Skill catalog (subset; OASF v1.0.0) ───────────────────────────────────

/**
 * Default skill IDs by hierarchical slug. Top-level fallback is 1001
 * (`agent_orchestration/task_decomposition`) — every PCC capability has
 * SOME orchestration aspect (we accept a job, run it, return result),
 * so this is the safest closest-match for unmapped physical skills.
 */
const SKILL_ID_MAP: Record<string, number> = {
  // Agent orchestration (OASF baseline — the closest existing skills)
  "agent_orchestration/task_decomposition": 1001,
  "agent_orchestration/multi_agent_planning": 1003,
  "agent_orchestration/agent_coordination": 1004,
  "agent_orchestration/workflow_execution": 1005,
  // NLP
  "natural_language_processing/text_completion": 2001,
  "natural_language_processing/summarization": 2002,
  "natural_language_processing/translation": 2003,
  // Vision
  "computer_vision/image_classification": 3001,
  "computer_vision/object_detection": 3002,
  // Data
  "data_processing/structured_extraction": 4001,
  "data_processing/transformation": 4002,
  // Defaults for PCC namespaces (Phase 3 will replace with OASF-registered IDs)
  "manufacturing/cnc-3axis": 9101,
  "manufacturing/cnc-5axis": 9102,
  "manufacturing/fdm": 9103,
  "manufacturing/sla": 9104,
  "manufacturing/laser-cut": 9105,
  "manufacturing/waterjet": 9106,
  "biotech/hplc": 9201,
  "biotech/pcr": 9202,
  "biotech/sequencing": 9203,
  "biotech/microscopy": 9204,
};

/**
 * Look up an OASF skill ID by hierarchical slug. Returns undefined if
 * the skill isn't known; callers should fall back to the top-level
 * category ID (1001).
 */
export function lookupSkillId(slug: string): number | undefined {
  return SKILL_ID_MAP[slug];
}

// ── Domain catalog ────────────────────────────────────────────────────────

const DOMAIN_ID_MAP: Record<string, number> = {
  // OASF baseline
  "hospitality_and_tourism/tourism_management": 1505,
  "software_engineering/code_generation": 2105,
  // PCC bridge defaults
  "manufacturing/general": 9001,
  "manufacturing/cnc": 9011,
  "manufacturing/additive": 9012,
  "manufacturing/subtractive": 9013,
  "biotech/general": 9501,
  "biotech/analytical": 9511,
  "biotech/molecular": 9512,
  "biotech/imaging": 9513,
};

/**
 * Look up an OASF domain ID by hierarchical slug. Returns undefined if
 * the domain isn't known; callers should fall back to 1500 (top-level
 * generic).
 */
export function lookupDomainId(slug: string): number | undefined {
  return DOMAIN_ID_MAP[slug];
}

// ── Module catalog ────────────────────────────────────────────────────────

/**
 * Well-known OASF module slugs. We carry our own `physical-capability/v1`
 * and `tool-schema/v1` because OASF doesn't model them natively, but we
 * still list them here so the catalog has a single source of truth.
 */
export const KNOWN_MODULES = {
  PHYSICAL_CAPABILITY_V1: "physical-capability/v1",
  TOOL_SCHEMA_V1: "tool-schema/v1",
  INTEGRATION_AGENTSPEC: "integration/agentspec",
} as const;

// ── Locator type inference ────────────────────────────────────────────────

/**
 * Infer the OASF locator type from a URL. OASF defines a closed set:
 * `"source_code" | "docker_image" | "ipfs" | "binary" | "rest_endpoint" |
 * "mcp_server" | "a2a_card"`. We fall back to `"binary"` for anything
 * unrecognized — consumers can still fetch the URL, they just don't get
 * a typed hint.
 */
export function inferLocatorType(url: string): string {
  const u = url.toLowerCase();
  if (u.startsWith("ipfs://")) return "ipfs";
  if (u.includes("github.com") || u.endsWith(".git")) return "source_code";
  if (
    u.includes("docker.io") ||
    u.includes("ghcr.io") ||
    u.includes("/docker/")
  ) {
    return "docker_image";
  }
  if (u.includes("/mcp") || u.includes("mcp.json")) return "mcp_server";
  if (u.includes("agent-card.json") || u.includes("/.well-known/agent")) {
    return "a2a_card";
  }
  if (u.startsWith("http://") || u.startsWith("https://")) {
    return "rest_endpoint";
  }
  return "binary";
}
