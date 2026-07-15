#!/usr/bin/env node
/**
 * agent-package.json — make agent feedback AUTOMATIC (agent DX, Phase 1).
 *
 * Three additive changes so third-party agents report bugs+context the moment they
 * hit a failure, instead of only when they remember the tool exists:
 *
 *   1. Re-point `pcc_report` at the DURABLE, admin-readable POST /api/feedback (on
 *      master it still points at /api/feedback/agent-report), with a shape that
 *      matches the server's `report_hint.send{}` block (adds method + status).
 *   2. Rewrite the two SOFT system_prompt mentions into a STRICT, throttled trigger
 *      contract (report on 5xx / unrecoverable 4xx / repeat failure; once, never
 *      loop; never send secrets).
 *   3. Add a top-level `error_reporting` field so a harness that never parses the
 *      22k-char system_prompt can still discover + honor the contract.
 *
 * Pairs with the server-side `report_hint` block (packages/gateway/src/server.ts
 * setErrorHandler) that hands the agent this contract AT the failure site.
 * Idempotent — re-running on an already-wired package is a no-op.
 *
 * Run from repo root:  node scripts/update-agent-package-auto-feedback.mjs
 * Design: ai/research/agent-feedback-auto-design.md
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_PACKAGE_PATH = join(ROOT, "apps", "dashboard", "public", "agent-package.json");
const FEEDBACK_ENDPOINT = { method: "POST", path: "/api/feedback" };

// ── 1. Canonical pcc_report tool → durable /api/feedback ────────────────────────
const PCC_REPORT = {
  name: "pcc_report",
  description:
    "Report a bug, friction, or dead-end you hit while using PCC. Call this the moment you get stuck and cannot recover: a 5xx (its response carries a `report_hint` with pre-filled fields), a 4xx you cannot fix from its message, the same step failing twice, or a misleading tool/description. PUBLIC — works before you provision an API key (cold agents are exactly who this is for). Persisted durably and reviewed by the PCC team. Report each distinct failure ONCE; never include an API key, token, or wallet secret. Rate-limited per IP.",
  input_schema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["bug", "friction", "idea"],
        description:
          "bug = something is broken/wrong; friction = it works but was confusing/harder than it should be; idea = a suggestion or missing capability. Defaults to bug.",
      },
      summary: {
        type: "string",
        minLength: 4,
        maxLength: 5000,
        description:
          "1-line description of what you were doing and what went wrong. Example: 'POST /api/build/contract returned 500 with no hint about the missing field.'",
      },
      detail: {
        type: "string",
        maxLength: 20000,
        description: "Multi-line context: the full error body, what you tried, what you expected. Optional but recommended.",
      },
      endpoint: {
        type: "string",
        description: "The route you were on when you got stuck. From a 5xx `report_hint.send.endpoint`. Example: '/api/build/contract'.",
      },
      method: {
        type: "string",
        description: "The HTTP method you used. From `report_hint.send.method`. Example: 'POST'.",
      },
      status: {
        type: "integer",
        description: "The HTTP status you got. From `report_hint.send.status`. Example: 500.",
      },
      errorCode: {
        type: "string",
        description: "The machine error code from the response body, if any. From `report_hint.send.errorCode`.",
      },
      traceId: {
        type: "string",
        description:
          "Your journey ID — returned by provision_api_key and on every response as `x-pcc-trace-id` (also in a 5xx `report_hint.traceId`). Lets PCC replay your full run.",
      },
      severity: {
        type: "string",
        enum: ["low", "medium", "high", "critical"],
        description: "How badly this blocked you. Optional.",
      },
      agentId: {
        type: "string",
        description: "Which model/agent you are. Example: 'claude', 'gpt-4o', 'gemini'. Optional.",
      },
    },
    required: ["summary"],
  },
  endpoint: FEEDBACK_ENDPOINT,
};

// ── 2. system_prompt: soft mentions → strict trigger contract ───────────────────
// Anchored on distinctive substrings (no non-ASCII in the anchors) so the replace is
// robust to surrounding edits. Each has a "new already present" guard for idempotency.
const PROMPT_EDITS = [
  {
    old: "optionally call `pcc_report` with the trace_id so the team can replay your run.",
    new: "the response includes a `report_hint` block — copy its `send{}` fields into `pcc_report` with your `traceId` and a one-line `summary` so the team can fix it and replay your run.",
  },
  {
    old: "When you get stuck, `pcc_report { trace_id, summary }` logs to the team's dashboard. This is how friction gets fixed.",
    new:
      "Report failures automatically: call `pcc_report` (POST /api/feedback — public, no key needed) whenever you hit a 5xx, a 4xx you cannot fix from its message, the same step failing twice, or a response that contradicts this package. Send `{type, summary, endpoint, method, status, errorCode, traceId}`. Report each distinct failure ONCE — never loop-report — and NEVER include an API key, token, or wallet secret. This is how friction gets fixed.",
  },
];

// ── 3. Top-level machine-readable error_reporting contract ──────────────────────
const ERROR_REPORTING = {
  tool: "pcc_report",
  endpoint: FEEDBACK_ENDPOINT,
  auth: "none (public — no API key required; cold agents can report)",
  report_when: [
    "any 5xx response",
    "a 4xx you cannot fix from its message",
    "the same step fails twice in a row",
    "a response whose shape contradicts this package",
  ],
  on_error_response:
    "5xx responses include a `report_hint` object: { tool, how, traceId, note, send:{ type, endpoint, method, status, errorCode } }. Copy `send` into pcc_report and add a one-line `summary`.",
  send: ["type", "summary", "endpoint", "method", "status", "errorCode", "traceId"],
  never_send: ["API keys", "bearer tokens", "wallet private keys", "seed phrases", "any secret"],
  throttle: "report each distinct failure once; do not loop-report the same error",
};

// ── Apply ───────────────────────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(AGENT_PACKAGE_PATH, "utf-8"));
if (!Array.isArray(pkg.tools)) {
  console.error("ERROR: agent-package.json has no `tools` array");
  process.exit(1);
}

let changed = false;

// 1. tool
const idx = pkg.tools.findIndex((t) => t.name === "pcc_report");
if (idx === -1) {
  pkg.tools.push(PCC_REPORT);
  changed = true;
} else if (JSON.stringify(pkg.tools[idx]) !== JSON.stringify(PCC_REPORT)) {
  pkg.tools[idx] = PCC_REPORT;
  changed = true;
}

// 2. system_prompt
if (typeof pkg.system_prompt === "string") {
  for (const { old, new: neu } of PROMPT_EDITS) {
    if (pkg.system_prompt.includes(neu)) continue; // already applied
    if (pkg.system_prompt.includes(old)) {
      pkg.system_prompt = pkg.system_prompt.replace(old, neu);
      changed = true;
    } else {
      console.warn(`WARN: system_prompt anchor not found (skipped): "${old.slice(0, 60)}…"`);
    }
  }
}

// 3. error_reporting
if (JSON.stringify(pkg.error_reporting) !== JSON.stringify(ERROR_REPORTING)) {
  pkg.error_reporting = ERROR_REPORTING;
  changed = true;
}

pkg.toolCount = pkg.tools.length;
if (pkg.metadata && typeof pkg.metadata === "object") pkg.metadata.tool_count = pkg.tools.length;

if (!changed) {
  console.log("No changes — agent-package.json already wired for auto-feedback.");
  process.exit(0);
}

writeFileSync(AGENT_PACKAGE_PATH, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
console.log("=== agent-package.json — auto-feedback wiring ===");
console.log(`pcc_report → ${PCC_REPORT.endpoint.method} ${PCC_REPORT.endpoint.path}`);
console.log(`error_reporting field: present`);
console.log(`toolCount: ${pkg.toolCount}`);
console.log(`Wrote ${AGENT_PACKAGE_PATH}`);
