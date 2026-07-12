#!/usr/bin/env node
/**
 * One-shot regeneration script for agent-package.json v2.13.0.
 *
 * Adds tools for endpoints landed in:
 *   PR #112 — operator-channels substrate
 *   PR #118 — pcc-suggest-templates A2A skill + CSD catalog
 *   PR #120 — operator self-service status
 *   PR #121 — compose.execute real wiring (pre-existing /api/compose routes)
 *
 * Run from repo root:
 *   node scripts/update-agent-package-v2.13.mjs
 *
 * Idempotent: detects already-applied tools by name and refuses to double-add.
 * Writes to apps/dashboard/public/agent-package.json in place.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_PACKAGE_PATH = join(ROOT, "apps", "dashboard", "public", "agent-package.json");

// ── DE-CONFLICTION GUARD (2026-07-11 · ai/research/pcc-agent-package-deconflict.md) ──
// `scripts/polish-agent-package-claude-max.mjs` is the SINGLE canonical writer of this
// file (live v2.18.0). This one-shot sets version 2.13.0 — a re-run DOWNGRADES the live
// version and clobbers. No lock — last-run-wins. Refuses unless --force.
if (!process.argv.includes("--force")) {
  console.error("[guard] SUPERSEDED — running this would DOWNGRADE + clobber the canonical agent-package.json (live v2.18.0).");
  console.error("[guard] Canonical: scripts/polish-agent-package-claude-max.mjs. Re-run with --force to override intentionally.");
  process.exit(1);
}

const TARGET_VERSION = "2.13.0";
const TARGET_LAST_UPDATED = "2026-06-14T00:00:00Z";

// ---------------------------------------------------------------------------
// New tools to add. Each follows the existing schema:
//   { name, description, input_schema, endpoint: { method, path } }
// Path placeholders use {param} (OpenAPI style) to match the rest of the file.
// ---------------------------------------------------------------------------

const NEW_TOOLS = [
  // -----------------------------------------------------------------------
  // PR #112 — operator-channels substrate (5 tools)
  // -----------------------------------------------------------------------
  {
    name: "attach_operator_channel",
    description:
      "Attach a notification/dispatch channel to an operator so PCC knows how to ping them when a job lands. The operator's onboarding agent calls this AFTER the conversation that produced the channel record. Transport is a small stable enum (webhook|email|sms|voice|push|mqtt|file|manual) — vendor specifics live in the free-form `describe` field, written by the operator's agent. PCC the substrate stays neutral. Returns the channel record with a generated id.",
    input_schema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "Operator slug (typically the operator's address or unique identifier).",
        },
        label: {
          type: "string",
          description:
            "Short human label shown to the operator and in admin UIs: 'Front counter printer', 'Owner's phone'.",
        },
        transport: {
          type: "string",
          enum: ["webhook", "email", "sms", "voice", "push", "mqtt", "file", "manual"],
          description:
            "Which wire does the message go over. `manual` = no machine endpoint (dashboard-only).",
        },
        direction: {
          type: "string",
          enum: ["out", "in-out", "in"],
          description:
            "out=PCC pushes only; in-out=operator's system also replies; in=operator pushes unsolicited.",
        },
        endpoint: {
          type: "object",
          description:
            "Transport-specific routing payload. webhook→{url}, email→{address}, sms/voice→{phoneE164}, push→{token,platform}, mqtt→{brokerUrl,topic}, file→{scheme,path}, manual→{}.",
        },
        credentialRef: {
          type: "string",
          description:
            "Reference to a secret in the credential vault (not the secret itself). PCC resolves it at dispatch time.",
        },
        describe: {
          type: "string",
          description:
            "Plain-English instructions for how PCC should talk to whatever is on the other end. Written by the operator's onboarding agent. Required, ≥4 chars. Example: 'POST JSON with keys order_id, line_items[], deadline_iso. I will POST back {order_id, status} to your reply URL.'",
        },
        replyContract: {
          type: "string",
          description:
            "Optional operator-authored contract describing how the operator's system will respond to evidence requests, status pings, etc.",
        },
        enabled: {
          type: "boolean",
          description: "Whether the channel is live (defaults to true).",
        },
      },
      required: ["slug", "label", "transport", "describe"],
    },
    endpoint: { method: "POST", path: "/api/operators/{slug}/channels" },
  },
  {
    name: "list_operator_channels",
    description:
      "List every channel attached to an operator. Returns the full channel records (id, transport, direction, endpoint, describe, enabled flags). Useful for an operator's onboarding agent to confirm what is wired up, and for status dashboards.",
    input_schema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Operator slug." },
      },
      required: ["slug"],
    },
    endpoint: { method: "GET", path: "/api/operators/{slug}/channels" },
  },
  {
    name: "update_operator_channel",
    description:
      "Update an existing channel — toggle enabled, rewrite the describe contract, change the endpoint payload, etc. Merges into the existing record. The operator slug, id, and createdAt are immutable.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Channel id (returned from attach_operator_channel).",
        },
        label: { type: "string" },
        direction: {
          type: "string",
          enum: ["out", "in-out", "in"],
        },
        endpoint: { type: "object" },
        credentialRef: { type: "string" },
        describe: { type: "string" },
        replyContract: { type: "string" },
        enabled: { type: "boolean" },
      },
      required: ["id"],
    },
    endpoint: { method: "PATCH", path: "/api/operators/channels/{id}" },
  },
  {
    name: "delete_operator_channel",
    description:
      "Remove a channel from an operator. Future jobs will not dispatch to it. Use update_operator_channel with enabled=false to silence temporarily without losing the recipe in `describe`.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Channel id." },
      },
      required: ["id"],
    },
    endpoint: { method: "DELETE", path: "/api/operators/channels/{id}" },
  },
  {
    name: "test_operator_channels",
    description:
      "Fire a synthetic job at every enabled channel for an operator so the onboarding agent (and the human watching) can confirm the integration end-to-end before a real job lands. Returns per-channel dispatch results (delivered, ref, warnings).",
    input_schema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Operator slug." },
      },
      required: ["slug"],
    },
    endpoint: { method: "POST", path: "/api/operators/{slug}/channels/test" },
  },

  // -----------------------------------------------------------------------
  // PR #118 — pcc-suggest-templates + popular (2 tools)
  // -----------------------------------------------------------------------
  {
    name: "suggest_csd_templates",
    description:
      "Bidirectional onboarding: the registry talks back. Describe in plain English what you are trying to set up — 'wood-fired pizza shop in SF', 'Opentrons OT-2 liquid handler', 'same-day SF courier' — and the registry returns N candidate Capability StructureDefinition (CSD) templates ranked by keyword-overlap relevance (name×3, tags×2, description×1; tie-break on usage). Empty query falls back to popularity-ordered top picks. After picking one, pass the chosen type to pcc-author-integration. Score-zero results are dropped.",
    input_schema: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description:
            "Plain-English description of the capability the user is trying to set up. Optional — empty falls back to popularity.",
        },
        limit: {
          type: "integer",
          description: "Max results (1..20, default 5).",
          minimum: 1,
          maximum: 20,
        },
        kind: {
          type: "string",
          enum: ["base", "profile", "extension", "workflow"],
          description: "Filter by CSD kind.",
        },
      },
      required: [],
    },
    endpoint: { method: "GET", path: "/api/csd/suggest" },
  },
  {
    name: "get_popular_csd_templates",
    description:
      "Return CSDs sorted by adoption (usage-count descending). Useful for first-time operators who want to see what kind of capabilities others are publishing. Each entry includes the CSD record plus usage attribution: count, recent adopters (deduped, capped at 50), and lastUsedAt.",
    input_schema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Max results (1..50, default 10).",
          minimum: 1,
          maximum: 50,
        },
      },
      required: [],
    },
    endpoint: { method: "GET", path: "/api/csd/popular" },
  },

  // -----------------------------------------------------------------------
  // PR #120 — operator self-service status (1 tool)
  // -----------------------------------------------------------------------
  {
    name: "get_operator_status",
    description:
      "Four-slot substrate view for an operator: kernels, capabilities (with sla + availability), notification channels, and the per-kernel A2A agent-card URLs. Returns totals and a `missing` list naming any of the four onboarding slots that are still empty. Use this from an onboarding agent's wrap-up step to confirm 'are all four slots wired before I go live?' status is `ready` | `partial` | `unconfigured`. Public — operator slug is non-secret and the response carries no credentials (channel `credentialRef` values are vault references, not secrets).",
    input_schema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description:
            "Operator slug — typically the operator's wallet address used as `operatorAddress` on their kernels.",
        },
      },
      required: ["slug"],
    },
    endpoint: { method: "GET", path: "/api/operators/{slug}/status" },
  },

  // -----------------------------------------------------------------------
  // Composition engine (3 tools — surface for the pre-existing routes
  // hardened by PR #121 with flag-gated real wiring via PCC_COMPOSE_EXECUTE_REAL)
  // -----------------------------------------------------------------------
  {
    name: "propose_composition",
    description:
      "Propose a composition — a sequenced DAG of capability instances to satisfy a multi-step outcome under a budget + assurance tier. Accepts either a flat `steps` list or an outcome chain. Returns a candidate plan ranked by `optimizeFor` (price | speed | quality) with per-step assignments. The composition is persisted for ~30 minutes (proposed status) and can be executed once via execute_composition.",
    input_schema: {
      type: "object",
      properties: {
        outcomeType: {
          type: "string",
          description: "High-level outcome label, ≤120 chars. Example: 'desk-robot-prototype'.",
        },
        steps: {
          type: "array",
          items: { type: "string" },
          description:
            "Ordered list of capability types this composition needs (1..20). Use this OR `outcomeChain`.",
        },
        outcomeChain: {
          type: "array",
          items: { type: "string" },
          description:
            "Alternative to `steps`: chain of named sub-outcomes. The planner expands each into capability types.",
        },
        budgetUSD: {
          type: "number",
          description: "Total budget the user is willing to spend across all steps.",
        },
        minAssuranceTier: {
          type: "integer",
          enum: [0, 1, 2, 3],
          description: "Minimum acceptable assurance tier on every step.",
        },
        location: {
          type: "object",
          description: "Geographic constraint (lat/lng + radius, or country, etc).",
        },
        optimizeFor: {
          type: "string",
          enum: ["price", "speed", "quality"],
          description: "Ranking objective (default `price`).",
        },
        requester: {
          type: "object",
          description: "{agentId, did?} — the agent submitting the request.",
        },
        description: {
          type: "string",
          description: "Free-form natural-language description (≤4000 chars).",
        },
      },
      required: ["outcomeType", "budgetUSD", "minAssuranceTier"],
    },
    endpoint: { method: "POST", path: "/api/compose" },
  },
  {
    name: "get_composition",
    description:
      "Retrieve a previously-proposed composition by id. Returns 404 if unknown, 410 if the 30-minute proposal window has expired. Use this to inspect a plan before executing, or to recover a plan id after a restart.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Composition id (returned from propose_composition).",
        },
      },
      required: ["id"],
    },
    endpoint: { method: "GET", path: "/api/compose/{id}" },
  },
  {
    name: "execute_composition",
    description:
      "Commit a proposed composition: drives the DAG through the workflow engine, each step records a reputation outcome, the composition's reputation is finalized when the run ends. When `PCC_COMPOSE_EXECUTE_REAL=true` is set on the gateway, steps submit real jobs via JobFacade and the workflow run is durable (@pcc/workflow). When the flag is off, the NOOP runner returns synthetic success — useful in dev/test. Re-executing an already-run composition replays the stored result (idempotent — reputation deltas are applied exactly once).",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Composition id from propose_composition. Must be in `proposed` status and not expired.",
        },
        idempotencyKey: {
          type: "string",
          description: "Optional caller-supplied key (≤120 chars) to dedupe execute calls.",
        },
      },
      required: ["id"],
    },
    endpoint: { method: "POST", path: "/api/compose/{id}/execute" },
  },
];

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

const raw = readFileSync(AGENT_PACKAGE_PATH, "utf-8");
const pkg = JSON.parse(raw);

if (!Array.isArray(pkg.tools)) {
  console.error("ERROR: agent-package.json has no `tools` array");
  process.exit(1);
}

const existingNames = new Set(pkg.tools.map((t) => t.name));
const skipped = [];
const added = [];

for (const tool of NEW_TOOLS) {
  if (existingNames.has(tool.name)) {
    skipped.push(tool.name);
    continue;
  }
  pkg.tools.push(tool);
  added.push(tool.name);
}

const newToolCount = pkg.tools.length;
pkg.version = TARGET_VERSION;
pkg.toolCount = newToolCount;
pkg.lastUpdated = TARGET_LAST_UPDATED;

if (pkg.metadata && typeof pkg.metadata === "object") {
  pkg.metadata.tool_count = newToolCount;
  pkg.metadata.updated = TARGET_LAST_UPDATED;
}

writeFileSync(AGENT_PACKAGE_PATH, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

console.log("=== agent-package.json refresh (v2.13.0) ===");
console.log(`Version:    ${pkg.version}`);
console.log(`toolCount:  ${pkg.toolCount}`);
console.log(`Added:      ${added.length} tool(s)`);
for (const n of added) console.log(`  + ${n}`);
if (skipped.length > 0) {
  console.log(`Skipped (already present): ${skipped.length}`);
  for (const n of skipped) console.log(`  · ${n}`);
}
console.log(`\nWrote ${AGENT_PACKAGE_PATH}`);
