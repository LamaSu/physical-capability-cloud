#!/usr/bin/env node
/**
 * agent-package.json refresh — v2.14.0 observability.
 *
 * Adds the `pcc_report` tool, the trace-id propagation hint in the
 * system_prompt, and updates version/tool-count fields. Idempotent —
 * detects already-applied changes and refuses to double-add.
 *
 * Run from repo root:
 *   node scripts/update-agent-package-v2.14-observability.mjs
 *
 * Writes to apps/dashboard/public/agent-package.json in place.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_PACKAGE_PATH = join(ROOT, "apps", "dashboard", "public", "agent-package.json");

// ── DE-CONFLICTION GUARD (2026-07-11 · ai/research/pcc-agent-package-deconflict.md) ──
// `scripts/polish-agent-package-claude-max.mjs` is the SINGLE canonical writer of this
// file (live v2.18.0). LIVE HAZARD: this one-shot sets version 2.14.0 — a re-run
// DOWNGRADES the live version, and its idempotency marker no longer matches the live
// prompt so it would ALSO duplicate the observability section. No lock — last-run-wins.
// Refuses unless --force.
if (!process.argv.includes("--force")) {
  console.error("[guard] SUPERSEDED — running this would DOWNGRADE to 2.14.0 + clobber/duplicate in the canonical agent-package.json (live v2.18.0).");
  console.error("[guard] Canonical: scripts/polish-agent-package-claude-max.mjs. Re-run with --force to override intentionally.");
  process.exit(1);
}

const TARGET_VERSION = "2.14.0";
const TARGET_LAST_UPDATED = "2026-06-14T01:00:00Z";

// ---------------------------------------------------------------------------
// New tool: pcc_report — observability piece 3.
// ---------------------------------------------------------------------------

const NEW_TOOL = {
  name: "pcc_report",
  description:
    "Report friction, confusion, or bugs you hit while onboarding. Call this when you get stuck and cannot recover from an error, when a tool description was misleading, when an endpoint returned an unexplained 500, or when you abandoned a workflow because the next step was unclear. Include your `trace_id` (returned from `provision_api_key` or echoed via the `x-pcc-trace-id` response header) so PCC operators can replay your full journey. PUBLIC — works even before you provision an API key. Rate-limited (30 reports/hour/IP) to limit spam.",
  input_schema: {
    type: "object",
    properties: {
      trace_id: {
        type: "string",
        pattern: "^tr_[0-9a-f]{16,32}$",
        description:
          "Your onboarding journey ID. Returned by provision_api_key (body field) and present on every response as the `x-pcc-trace-id` header.",
      },
      summary: {
        type: "string",
        minLength: 4,
        maxLength: 280,
        description:
          "1-line description of what went wrong. Example: 'Build options endpoint returned 500 with no hint about what was missing.'",
      },
      detail: {
        type: "string",
        maxLength: 4000,
        description:
          "Multi-line context: full error code, what you tried, what you expected. Optional but recommended.",
      },
      last_endpoint: {
        type: "string",
        maxLength: 200,
        description:
          "The route you were on when you got stuck. Example: '/api/build/contract'.",
      },
      last_error_code: {
        type: "string",
        maxLength: 200,
        description:
          "The error code from the Result<T> envelope you received, if any. Example: 'BAD_REQUEST', 'CAPABILITY_NOT_FOUND'.",
      },
      agent_kind: {
        type: "string",
        maxLength: 200,
        description:
          "Which model / agent you are. Example: 'claude', 'gpt-4o', 'gemini', 'canary'.",
      },
      confused_about: {
        type: "string",
        maxLength: 200,
        description:
          "Free-form category — which onboarding stage tripped you up. Example: 'auth', 'discovery', 'build', 'fund', 'submit', 'settle'.",
      },
    },
    required: ["summary"],
  },
  endpoint: { method: "POST", path: "/api/feedback/agent-report" },
};

// ---------------------------------------------------------------------------
// system_prompt addendum — trace-id + pcc_report bootstrap instructions.
// ---------------------------------------------------------------------------
//
// Appended ONCE. Detected by checking for the marker string below.

const SYSTEM_PROMPT_MARKER = "## Observability: trace_id + pcc_report";
const SYSTEM_PROMPT_ADDENDUM =
  "\n\n## Observability: trace_id + pcc_report\n" +
  "When you call provision_api_key OR redeem_invite, save the `trace_id` from the response body. " +
  "It is also returned on EVERY response as the `x-pcc-trace-id` header. " +
  "Echo it on every subsequent request via the same header so PCC can correlate your full onboarding journey: " +
  "`-H \"x-pcc-trace-id: tr_<your-id>\"`. " +
  "When you get stuck, confused, or hit an error you cannot recover from, call `pcc_report` with your `trace_id` and a brief `summary`. " +
  "This is how PCC learns about agent friction — every report goes to a dashboard that the team reads.";

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
const toolWasAdded = !existingNames.has(NEW_TOOL.name);
if (toolWasAdded) {
  pkg.tools.push(NEW_TOOL);
}

const promptWasAmended = typeof pkg.system_prompt === "string"
  && !pkg.system_prompt.includes(SYSTEM_PROMPT_MARKER);
if (promptWasAmended) {
  pkg.system_prompt = pkg.system_prompt + SYSTEM_PROMPT_ADDENDUM;
}

pkg.version = TARGET_VERSION;
pkg.toolCount = pkg.tools.length;
pkg.lastUpdated = TARGET_LAST_UPDATED;

if (pkg.metadata && typeof pkg.metadata === "object") {
  pkg.metadata.tool_count = pkg.tools.length;
  pkg.metadata.updated = TARGET_LAST_UPDATED;
}

writeFileSync(AGENT_PACKAGE_PATH, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

console.log("=== agent-package.json refresh (v2.14.0 observability) ===");
console.log(`Version:    ${pkg.version}`);
console.log(`toolCount:  ${pkg.toolCount}`);
console.log(`Tool added: ${toolWasAdded ? "yes (pcc_report)" : "no (already present)"}`);
console.log(`Prompt amended: ${promptWasAmended ? "yes (trace_id + pcc_report section)" : "no (already present)"}`);
console.log(`\nWrote ${AGENT_PACKAGE_PATH}`);
