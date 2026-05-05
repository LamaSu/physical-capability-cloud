// repair-tier0-routes: orchestrator template directory + capability matcher.
//
// Two global routes the dashboard's orchestrator chat console needs:
//
//   GET  /api/orchestrator/templates
//        Server-side authoritative list of the template manifests. Mirrors
//        the client-side fallback at apps/dashboard/src/routes/orchestrator/
//        templates.ts. Intentionally PUBLIC (no auth) because the landing
//        page picker calls it before the user has provisioned an API key.
//
//   POST /api/capabilities/templates/match
//        body: { input: string }
//        Heuristic keyword/intent matcher that ranks the available templates
//        against a free-text user description (e.g. "I have a 3D-printing
//        shop" → physical-operator, "I have a Postgres dataset" →
//        data-product). Public for the same landing-page reason.
//
// Wave 4 will replace the hard-coded mirror with template-registry-backed
// hydration. For Tier 0 the static list is the source of truth so the chat
// console renders correctly even if the workspace template packages haven't
// been built yet (e.g. the @pcc/template-data-product flow is still a stub).

import type { FastifyInstance } from "fastify";

/** Public client manifest shape — matches apps/dashboard/src/routes/orchestrator/templates.ts. */
export interface TemplateClientManifest {
  slug: string;
  display_name: string;
  description: string;
  produces_kind: string;
  capability_class: "physical" | "digital";
  greeting: string;
  api_base: string;
}

/**
 * Authoritative template directory. Keep in sync with the dashboard's
 * client-side mirror at apps/dashboard/src/routes/orchestrator/templates.ts.
 *
 * This is hard-coded (rather than read from the workspace template packages)
 * for two reasons:
 *   1. The data-product template's flow is still a stub — its package's
 *      manifest doesn't carry a `greeting` field, only the orchestrator-sdk
 *      `TemplateManifest` shape, which is internal to the SDK runner.
 *   2. The chat console needs identical greeting/api_base values across
 *      server and client. A drift here breaks the picker silently.
 */
export const TEMPLATE_DIRECTORY: readonly TemplateClientManifest[] = [
  {
    slug: "physical-operator",
    display_name: "Physical Operator",
    description:
      "Onboard a machine shop, fleet, lab, or warehouse to PCC. Drop website, ERP/CMMS connections, SOPs/MOPs — Navi extracts capabilities and registers the operator.",
    produces_kind: "kernel-agent",
    capability_class: "physical",
    greeting:
      "Hi — I'm Navi. I'll help you onboard a physical operator (machine shop, fleet, lab, warehouse) to PCC. While you're on the phone with the voice agent, drop docs and connections here. What's your company name? (e.g. \"Oakland Titanium Mills at https://oakland-titanium-mills.example\")",
    api_base: "/api/onboard",
  },
  {
    slug: "data-product",
    display_name: "Data Product",
    description:
      "Publish a queryable dataset as a paid PCC capability. Walk through data location, schema, query interface (REST/GraphQL/SQL/MCP), pricing, refresh cadence.",
    produces_kind: "data-product",
    capability_class: "digital",
    greeting:
      "Hi — I'm Navi. I'll help you publish a queryable dataset as a paid PCC capability. Where does your data live? (e.g. Postgres, Snowflake, BigQuery, REST API, GraphQL endpoint, MCP server)",
    api_base: "/api/orchestrator/data-product",
  },
] as const;

// ── Heuristic matcher keywords ───────────────────────────────────────────────
//
// The matcher ranks each template by counting how many of the user's words
// hit a template's keyword bag. We deliberately keep this naive (no embeddings,
// no LLM) so the route stays cheap, deterministic, and offline-runnable. A
// real semantic matcher lives behind the Touchstone service in Wave 4; this
// is the bootstrap heuristic that the landing page uses pre-auth.

const PHYSICAL_KEYWORDS = [
  "shop",
  "fleet",
  "lab",
  "laboratory",
  "warehouse",
  "machine",
  "machines",
  "machining",
  "machinist",
  "printer",
  "printing",
  "manufacturing",
  "factory",
  "cnc",
  "fdm",
  "3d",
  "hplc",
  "pcb",
  "robot",
  "robotic",
  "fabrication",
  "fab",
  "operator",
  "physical",
  "milling",
  "lathe",
  "press",
  "molding",
  "assembly",
  "device",
  "kernel",
  "fleet",
  "workshop",
  "garage",
];

const DIGITAL_KEYWORDS = [
  "data",
  "dataset",
  "datasets",
  "database",
  "postgres",
  "postgresql",
  "snowflake",
  "bigquery",
  "redshift",
  "sql",
  "graphql",
  "rest",
  "api",
  "mcp",
  "csv",
  "parquet",
  "warehouse", // ambiguous; caps via reweight below
  "lake",
  "lakehouse",
  "schema",
  "query",
  "queryable",
  "feed",
  "stream",
  "etl",
  "olap",
  "analytics",
  "metrics",
  "endpoint",
];

// "warehouse" is intentionally listed for both — physical (storage facility)
// vs digital (data warehouse). The matcher counts it twice but the surrounding
// context (other keywords) usually breaks the tie. If both scores are equal
// after the pass, the tie-break order is physical-operator > data-product
// because the physical path has a wider operator base today.

interface MatchScore {
  slug: string;
  score: number;
  reason: string;
}

/**
 * Score one template's keyword bag against a tokenized user input.
 *
 * Returns the raw hit count — the route handler normalizes scores per template
 * by dividing by the bag size so a longer keyword list doesn't unfairly win.
 */
function scoreKeywords(tokens: ReadonlySet<string>, bag: readonly string[]): { score: number; hits: string[] } {
  const hits: string[] = [];
  for (const word of bag) {
    if (tokens.has(word)) hits.push(word);
  }
  // Score normalized to [0, 1] by dividing by bag size, then capped at 1.
  // This keeps the value comparable across templates with different bag sizes.
  const score = bag.length > 0 ? hits.length / bag.length : 0;
  return { score, hits };
}

/**
 * Tokenize a free-text user input into a lowercase word set. Strips punctuation
 * and collapses whitespace so "Postgres + GraphQL!" becomes
 * {"postgres", "graphql"}.
 */
function tokenize(input: string): Set<string> {
  return new Set(
    input
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2)
  );
}

/**
 * Public matcher. Returns templates ranked by hit-rate against the user's
 * keywords. Always returns at least one match (the highest-scoring template),
 * even if all scores are 0 — the caller can show "we're not sure, here's
 * physical-operator as the default" rather than an empty result set.
 */
export function matchTemplates(input: string): MatchScore[] {
  const tokens = tokenize(input);

  const physical = scoreKeywords(tokens, PHYSICAL_KEYWORDS);
  const digital = scoreKeywords(tokens, DIGITAL_KEYWORDS);

  const matches: MatchScore[] = [
    {
      slug: "physical-operator",
      score: physical.score,
      reason:
        physical.hits.length > 0
          ? `Matched physical-operator keywords: ${physical.hits.slice(0, 5).join(", ")}`
          : "Default — no physical-operator keywords matched",
    },
    {
      slug: "data-product",
      score: digital.score,
      reason:
        digital.hits.length > 0
          ? `Matched data-product keywords: ${digital.hits.slice(0, 5).join(", ")}`
          : "Default — no data-product keywords matched",
    },
  ];

  // Sort descending by score; tie-break physical-operator first.
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.slug === "physical-operator") return -1;
    if (b.slug === "physical-operator") return 1;
    return 0;
  });

  return matches;
}

export async function orchestratorTemplatesRoutes(app: FastifyInstance) {
  /**
   * GET /api/orchestrator/templates
   *
   * Public — used by the landing-page picker before the user has an API key.
   * Returns the static directory above. The shape is stable: every entry has
   * the seven `TemplateClientManifest` fields the dashboard renders against.
   */
  app.get("/api/orchestrator/templates", async () => {
    return { templates: [...TEMPLATE_DIRECTORY] };
  });

  /**
   * POST /api/capabilities/templates/match
   * Body: { input: string }
   *
   * Public — used by the landing-page picker to recommend a template based
   * on a free-text user description. Returns ALL templates ranked by score
   * (so the UI can show "best match" plus "second-best" if it wants).
   *
   * Validation: empty / non-string `input` returns 400. We deliberately
   * don't enforce a max length — the matcher is O(n) over the input tokens
   * and the request body limit (1MB) is the real upper bound.
   */
  app.post<{ Body: { input?: unknown } }>(
    "/api/capabilities/templates/match",
    async (req, reply) => {
      const body = req.body ?? {};
      const input = typeof body.input === "string" ? body.input.trim() : "";
      if (!input) {
        return reply.status(400).send({
          error: "input_required",
          message: "Pass a non-empty 'input' string describing what you want to onboard.",
          example: { input: "I run a 3D printing shop with two Prusa MK4s" },
        });
      }

      const matches = matchTemplates(input);
      return { matches };
    }
  );
}
