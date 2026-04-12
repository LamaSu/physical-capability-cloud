// packages/gateway/src/routes/nl-query.ts
//
// Natural language query interface — Pattern 3.
//
// POST /api/query          — submit a natural language query
// GET  /api/query/intents  — list supported intent types
//
// Architecture:
//   1. Classify intent from the natural language query (deterministic, keyword/regex)
//   2. Look up matching QueryTemplate from DB (or fall back to built-in defaults)
//   3. Execute parameterized queries via repository layer (type-safe)
//   4. Return NLQueryResponse with source citations
//
// All data access is through the repository layer — no ad-hoc SQL execution.

import type { FastifyInstance, FastifyReply } from "fastify";
import { getRepos } from "../db.js";
import { getIntentClassifier } from "../services/intent-classifier.js";

// ── Local type aliases (avoid importing from @pcc/spec dist which may be stale) ─

type QueryIntent = string;

interface QuerySource {
  source: string;
  table: string;
  references: string[];
  asOf: string;
  description: string;
}

interface NLQueryResponse {
  answer: string;
  data: Record<string, unknown>[];
  sources: QuerySource[];
  templateId: string;
  intent: QueryIntent;
  confidence: number;
  grounding: "template" | "fallback";
  latencyMs: number;
}

// ── Built-in default query templates ─────────────────────────────────────
//
// These cover the most common intents without requiring DB seed data.
// Real deployments can extend via the queryTemplates table.

interface BuiltInTemplate {
  id: string;
  intent: string;
  name: string;
  description: string;
  requiredSlots: string[];
  responseTemplate: string;
  /** Which repository table this accesses (for source citation) */
  sourceTable: string;
}

const DEFAULT_TEMPLATES: BuiltInTemplate[] = [
  {
    id: "builtin:job_status",
    intent: "job_status",
    name: "Job Status",
    description: "Get the current status of a job by ID",
    requiredSlots: ["jobId"],
    responseTemplate: "Job {{id}} is currently {{status}}.",
    sourceTable: "jobs",
  },
  {
    id: "builtin:network_status",
    intent: "network_status",
    name: "Network Status",
    description: "Get the total number of kernels and how many are online",
    requiredSlots: [],
    responseTemplate: "Found {{count}} kernels on the network.",
    sourceTable: "shop_kernels",
  },
  {
    id: "builtin:find_capability",
    intent: "find_capability",
    name: "Find Capability",
    description: "Search for capabilities by type",
    requiredSlots: [],
    responseTemplate: "Found {{count}} capabilities matching your search.",
    sourceTable: "capabilities",
  },
  {
    id: "builtin:job_history",
    intent: "job_history",
    name: "Job History",
    description: "List recent jobs",
    requiredSlots: [],
    responseTemplate: "Here are your {{count}} most recent jobs.",
    sourceTable: "jobs",
  },
  {
    id: "builtin:operator_stats",
    intent: "operator_stats",
    name: "Operator Stats",
    description: "Get statistics for a kernel/operator",
    requiredSlots: [],
    responseTemplate: "Found stats for {{count}} kernel(s).",
    sourceTable: "shop_kernels",
  },
  {
    id: "builtin:kernel_health",
    intent: "kernel_health",
    name: "Kernel Health",
    description: "Check if a kernel is healthy and online",
    requiredSlots: [],
    responseTemplate: "Kernel {{name}} is currently {{status}}.",
    sourceTable: "shop_kernels",
  },
  {
    id: "builtin:compliance_query",
    intent: "compliance_query",
    name: "Compliance Query",
    description: "List active compliance templates",
    requiredSlots: [],
    responseTemplate: "Found {{count}} active compliance templates.",
    sourceTable: "compliance_templates",
  },
  {
    id: "builtin:template_search",
    intent: "template_search",
    name: "Template Search",
    description: "Search for capability templates",
    requiredSlots: [],
    responseTemplate: "Found {{count}} matching templates.",
    sourceTable: "capability_template_store",
  },
];

// ── Answer generation ─────────────────────────────────────────────────────

/** Generate a human-readable answer from a result set */
function generateAnswer(template: BuiltInTemplate, rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "No results found.";
  const first = rows[0] ?? {};
  return template.responseTemplate.replace(/\{\{(\w+)\}\}/g, (_m, key) =>
    key === "count" ? String(rows.length) : String(first[key] ?? ""),
  );
}

// ── Repository-based query execution ─────────────────────────────────────

/**
 * Execute a query against the repository layer based on the classified intent.
 * Uses typed repository methods — no raw SQL strings.
 */
function executeIntentQuery(
  intent: string,
  slots: Record<string, string | number | boolean>,
): { rows: Record<string, unknown>[]; table: string } {
  const repos = getRepos();

  switch (intent) {
    case "job_status": {
      const jobId = String(slots["jobId"] ?? "");
      if (jobId) {
        const job = repos.jobs.findById(jobId);
        return {
          rows: job ? [job as unknown as Record<string, unknown>] : [],
          table: "jobs",
        };
      }
      return {
        rows: (repos.jobs.findAll() as unknown as Record<string, unknown>[]).slice(0, 5),
        table: "jobs",
      };
    }

    case "job_history": {
      const limit = Math.min(Number(slots["limit"] ?? 10), 50);
      return {
        rows: (repos.jobs.findAll() as unknown as Record<string, unknown>[]).slice(0, limit),
        table: "jobs",
      };
    }

    case "find_capability": {
      const capType = String(slots["capabilityType"] ?? "");
      const capabilities = capType
        ? repos.capabilities.findByType(capType)
        : repos.capabilities.findAll();
      return {
        rows: (capabilities as unknown as Record<string, unknown>[]).slice(0, 20),
        table: "capabilities",
      };
    }

    case "network_status":
    case "operator_stats":
    case "kernel_health": {
      const kernelId = String(slots["kernelId"] ?? "");
      if (kernelId) {
        const kernel = repos.kernels.findById(kernelId);
        return {
          rows: kernel ? [kernel as unknown as Record<string, unknown>] : [],
          table: "shop_kernels",
        };
      }
      return {
        rows: (repos.kernels.findAll() as unknown as Record<string, unknown>[]).slice(0, 20),
        table: "shop_kernels",
      };
    }

    case "compliance_query": {
      return {
        rows: repos.analytics.findComplianceTemplatesByStatus("active") as unknown as Record<string, unknown>[],
        table: "compliance_templates",
      };
    }

    case "template_search": {
      const machineModel = String(slots["machineModel"] ?? "");
      const templates = machineModel
        ? repos.templateStore.searchCapabilityTemplates(machineModel)
        : repos.templateStore.findAllCapabilityTemplates();
      return {
        rows: (templates as unknown as Record<string, unknown>[]).slice(0, 20),
        table: "capability_template_store",
      };
    }

    default:
      return { rows: [], table: "unknown" };
  }
}

// ── Route helper ─────────────────────────────────────────────────────────

function errorResponse(reply: FastifyReply, code: number, message: string) {
  return reply.code(code).send({ error: message });
}

// ── Routes ────────────────────────────────────────────────────────────────

export async function nlQueryRoutes(app: FastifyInstance) {
  const classifier = getIntentClassifier();

  // ── GET /api/query/intents — list supported intents ──────────────────────
  app.get("/api/query/intents", async () => {
    return {
      intents: DEFAULT_TEMPLATES.map((t) => ({
        intent: t.intent,
        name: t.name,
        description: t.description,
        templateId: t.id,
        requiredSlots: t.requiredSlots,
      })),
      total: DEFAULT_TEMPLATES.length,
    };
  });

  // ── POST /api/query — submit a NL query ──────────────────────────────────
  app.post<{ Body: { query?: string; operatorId?: string } }>(
    "/api/query",
    async (req, reply) => {
      const startMs = Date.now();
      const body = req.body ?? {};
      const rawQuery = typeof body.query === "string" ? body.query.trim() : "";

      if (!rawQuery) {
        return errorResponse(reply, 400, "query is required");
      }

      // 1. Classify intent
      const classification = classifier.classify(rawQuery);
      const { intent, confidence, slots } = classification;

      // 2. Look up template — DB first, then built-in defaults
      let template: BuiltInTemplate | null = null;

      try {
        const repos = getRepos();
        const dbTemplates = repos.templateStore.findQueryTemplatesByIntent(intent);
        if (dbTemplates.length > 0) {
          const dbTpl = dbTemplates[0]!;
          template = {
            id: dbTpl.id,
            intent: dbTpl.intent,
            name: dbTpl.name,
            description: String((dbTpl as unknown as { description?: string }).description ?? ""),
            requiredSlots: [],
            responseTemplate: String(
              (dbTpl as unknown as { responseTemplate?: string }).responseTemplate ?? "Found {{count}} results.",
            ),
            sourceTable: "query_templates",
          };
        }
      } catch {
        // DB lookup failure — fall through to built-in defaults
      }

      if (!template) {
        template = DEFAULT_TEMPLATES.find((t) => t.intent === intent) ?? null;
      }

      if (!template) {
        const response: NLQueryResponse = {
          answer:
            "I don't know how to answer that yet. Try asking about job status, network status, or capabilities.",
          data: [],
          sources: [],
          templateId: "builtin:fallback",
          intent,
          confidence,
          grounding: "fallback",
          latencyMs: Date.now() - startMs,
        };
        return response;
      }

      // 3. Execute via repository layer
      let rows: Record<string, unknown>[] = [];
      const sources: QuerySource[] = [];

      try {
        const result = executeIntentQuery(intent, slots);
        rows = result.rows;

        sources.push({
          source: "sqlite",
          table: result.table,
          references: rows.map((r) => String(r["id"] ?? "")).filter(Boolean).slice(0, 10),
          asOf: new Date().toISOString(),
          description: `Query against ${result.table}`,
        });
      } catch {
        const response: NLQueryResponse = {
          answer: "I encountered an error executing that query. The data may not be available.",
          data: [],
          sources: [],
          templateId: template.id,
          intent,
          confidence,
          grounding: "template",
          latencyMs: Date.now() - startMs,
        };
        return response;
      }

      // 4. Build response
      const response: NLQueryResponse = {
        answer: generateAnswer(template, rows),
        data: rows,
        sources,
        templateId: template.id,
        intent,
        confidence,
        grounding: "template",
        latencyMs: Date.now() - startMs,
      };

      return response;
    },
  );
}
