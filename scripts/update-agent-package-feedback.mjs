#!/usr/bin/env node
/**
 * agent-package.json — wire `pcc_report` to the durable POST /api/feedback sink.
 *
 * Re-points the existing `pcc_report` tool from /api/feedback/agent-report to
 * /api/feedback, swaps its input_schema to the canonical feedback shape
 * ({type: bug|friction|idea, summary, detail, endpoint, traceId, severity,
 * agentId}), and aligns the system_prompt friction-reporting line to the new
 * endpoint + categories. Idempotent — re-running on an already-wired package is
 * a no-op.
 *
 * Run from repo root:
 *   node scripts/update-agent-package-feedback.mjs
 *
 * Writes apps/dashboard/public/agent-package.json in place.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_PACKAGE_PATH = join(ROOT, "apps", "dashboard", "public", "agent-package.json");

// ---------------------------------------------------------------------------
// Canonical pcc_report tool — points at the durable JSONL feedback sink.
// ---------------------------------------------------------------------------

const PCC_REPORT = {
  name: "pcc_report",
  description:
    "Report a bug, friction, or dead-end you hit while using PCC. Call this the moment you get stuck and cannot recover: an endpoint returned an unexplained 500, a tool description was misleading, a required field was undocumented, or the next step in a workflow was unclear and you abandoned it. PUBLIC — works even before you provision an API key (cold agents are exactly who this is for). Reports are persisted durably and reviewed by the PCC team. Rate-limited per IP to limit spam.",
  input_schema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["bug", "friction", "idea"],
        description:
          "bug = something is broken or wrong; friction = it works but was confusing/harder than it should be; idea = a suggestion or missing capability. Defaults to bug if omitted.",
      },
      summary: {
        type: "string",
        minLength: 4,
        maxLength: 5000,
        description:
          "1-line description of what went wrong. Example: 'POST /api/build/options returned 500 with no hint about the missing field.'",
      },
      detail: {
        type: "string",
        maxLength: 20000,
        description:
          "Multi-line context: the full error, what you tried, what you expected. Optional but recommended.",
      },
      endpoint: {
        type: "string",
        description:
          "The route you were on when you got stuck. Example: '/api/build/contract'.",
      },
      traceId: {
        type: "string",
        description:
          "Your onboarding journey ID, if you have one — returned by provision_api_key and present on every response as the `x-pcc-trace-id` header. Lets PCC replay your full journey.",
      },
      severity: {
        type: "string",
        enum: ["low", "medium", "high", "critical"],
        description: "How badly this blocked you. Optional.",
      },
      agentId: {
        type: "string",
        description:
          "Which model / agent you are. Example: 'claude', 'gpt-4o', 'gemini', 'canary'. Optional.",
      },
    },
    required: ["summary"],
  },
  endpoint: { method: "POST", path: "/api/feedback" },
};

// ---------------------------------------------------------------------------
// system_prompt friction line — realign to the new endpoint + categories.
// ---------------------------------------------------------------------------

const OLD_PROMPT_LINE =
  "When you get stuck, confused, or hit an error you cannot recover from, call `pcc_report` with your `trace_id` and a brief `summary`. This is how PCC learns about agent friction - every report goes to a dashboard that the team reads.";
const NEW_PROMPT_LINE =
  "When you hit a bug, friction, or a dead-end you cannot recover from, call `pcc_report` with a `type` (bug, friction, or idea), a brief `summary`, and — if you have them — the `endpoint`, your `traceId`, and a `severity`. This is how PCC learns about agent friction: every report is persisted durably and reviewed by the team.";

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

const raw = readFileSync(AGENT_PACKAGE_PATH, "utf-8");
const pkg = JSON.parse(raw);

if (!Array.isArray(pkg.tools)) {
  console.error("ERROR: agent-package.json has no `tools` array");
  process.exit(1);
}

const idx = pkg.tools.findIndex((t) => t.name === "pcc_report");
let toolChanged = false;
if (idx === -1) {
  pkg.tools.push(PCC_REPORT);
  toolChanged = true;
} else if (
  pkg.tools[idx].endpoint?.path !== PCC_REPORT.endpoint.path ||
  pkg.tools[idx].description !== PCC_REPORT.description ||
  JSON.stringify(pkg.tools[idx].input_schema) !== JSON.stringify(PCC_REPORT.input_schema)
) {
  pkg.tools[idx] = PCC_REPORT;
  toolChanged = true;
}

let promptChanged = false;
if (typeof pkg.system_prompt === "string" && pkg.system_prompt.includes(OLD_PROMPT_LINE)) {
  pkg.system_prompt = pkg.system_prompt.replace(OLD_PROMPT_LINE, NEW_PROMPT_LINE);
  promptChanged = true;
}

pkg.toolCount = pkg.tools.length;
if (pkg.metadata && typeof pkg.metadata === "object") {
  pkg.metadata.tool_count = pkg.tools.length;
}

if (!toolChanged && !promptChanged) {
  console.log("No changes — agent-package.json already wired pcc_report → /api/feedback.");
  process.exit(0);
}

writeFileSync(AGENT_PACKAGE_PATH, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

console.log("=== agent-package.json — pcc_report → POST /api/feedback ===");
console.log(`Tool changed:   ${toolChanged}`);
console.log(`Prompt changed: ${promptChanged}`);
console.log(`toolCount:      ${pkg.toolCount}`);
console.log(`\nWrote ${AGENT_PACKAGE_PATH}`);
