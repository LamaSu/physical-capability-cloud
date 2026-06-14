/**
 * Regression check for agent-package.json v2.13.0.
 *
 * Asserts every tool/skill required by PRs #112 + #118 + #120 + #121 is
 * present and points at the correct endpoint. Fails fast — meant to be wired
 * into CI alongside scripts/validate-agent-package.ts.
 *
 * Run:
 *   node_modules/.bin/tsx scripts/verify-agent-package-v2.13.ts
 *
 * Exit codes:
 *   0 — all required tools + skills present and well-formed
 *   1 — at least one required tool missing or version mismatch
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_PACKAGE_PATH = join(ROOT, "apps", "dashboard", "public", "agent-package.json");
const WELL_KNOWN_PATH = join(ROOT, "packages", "gateway", "src", "routes", "well-known.ts");

interface Tool {
  name: string;
  description?: string;
  input_schema?: unknown;
  endpoint: { method: string; path: string };
}

interface AgentPackage {
  version?: string;
  toolCount?: number;
  tools: Tool[];
}

// ---------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------

const MIN_VERSION = "2.13.0";

const REQUIRED_TOOLS: Array<{ name: string; method: string; path: string }> = [
  // PR #112 — operator-channels
  { name: "attach_operator_channel", method: "POST", path: "/api/operators/{slug}/channels" },
  { name: "list_operator_channels", method: "GET", path: "/api/operators/{slug}/channels" },
  { name: "update_operator_channel", method: "PATCH", path: "/api/operators/channels/{id}" },
  { name: "delete_operator_channel", method: "DELETE", path: "/api/operators/channels/{id}" },
  { name: "test_operator_channels", method: "POST", path: "/api/operators/{slug}/channels/test" },

  // PR #118 — csd suggest + popular
  { name: "suggest_csd_templates", method: "GET", path: "/api/csd/suggest" },
  { name: "get_popular_csd_templates", method: "GET", path: "/api/csd/popular" },

  // PR #120 — operator status
  { name: "get_operator_status", method: "GET", path: "/api/operators/{slug}/status" },

  // PR #121 — composition engine surface (real wiring via PCC_COMPOSE_EXECUTE_REAL)
  { name: "propose_composition", method: "POST", path: "/api/compose" },
  { name: "get_composition", method: "GET", path: "/api/compose/{id}" },
  { name: "execute_composition", method: "POST", path: "/api/compose/{id}/execute" },
];

// Agent-card skills (lives in well-known.ts; the static agent-package.json
// does NOT carry the A2A skills list — that comes from /.well-known/agent-card.json.
// But the briefing asks us to confirm all 8 A2A skills are advertised, so we
// grep the source.)
const REQUIRED_AGENT_CARD_SKILLS = [
  "pcc-discover",
  "pcc-quote",
  "pcc-submit",
  "pcc-verify",
  "pcc-settle",
  "pcc-author-integration",
  "pcc-attach-channel",
  "pcc-suggest-templates",
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

let pkg: AgentPackage;
try {
  pkg = JSON.parse(readFileSync(AGENT_PACKAGE_PATH, "utf-8")) as AgentPackage;
} catch (err) {
  console.error(`ERROR: could not read agent-package.json at ${AGENT_PACKAGE_PATH}`);
  console.error(String(err));
  process.exit(1);
}

const issues: string[] = [];

// Version check
if (!pkg.version || compareSemver(pkg.version, MIN_VERSION) < 0) {
  issues.push(`version: expected ≥ ${MIN_VERSION}, got ${pkg.version ?? "(missing)"}`);
}

// toolCount consistency
if (typeof pkg.toolCount === "number" && pkg.toolCount !== pkg.tools.length) {
  issues.push(`toolCount field (${pkg.toolCount}) does not match tools.length (${pkg.tools.length})`);
}

// Required tools present + well-formed
const byName = new Map<string, Tool>(pkg.tools.map((t) => [t.name, t] as const));
for (const want of REQUIRED_TOOLS) {
  const got = byName.get(want.name);
  if (!got) {
    issues.push(`missing tool: ${want.name}`);
    continue;
  }
  if (got.endpoint?.method !== want.method) {
    issues.push(
      `tool ${want.name} method mismatch: expected ${want.method}, got ${got.endpoint?.method ?? "(none)"}`,
    );
  }
  if (got.endpoint?.path !== want.path) {
    issues.push(
      `tool ${want.name} path mismatch: expected ${want.path}, got ${got.endpoint?.path ?? "(none)"}`,
    );
  }
  if (!got.description || got.description.length < 20) {
    issues.push(`tool ${want.name} has missing or too-short description`);
  }
  if (!got.input_schema) {
    issues.push(`tool ${want.name} has no input_schema`);
  }
}

// A2A agent-card skills (grep source)
let wellKnownSource = "";
try {
  wellKnownSource = readFileSync(WELL_KNOWN_PATH, "utf-8");
} catch {
  issues.push(`could not read ${WELL_KNOWN_PATH} for agent-card skill check`);
}
if (wellKnownSource) {
  for (const skillId of REQUIRED_AGENT_CARD_SKILLS) {
    if (!wellKnownSource.includes(`id: "${skillId}"`)) {
      issues.push(`agent-card skill missing in well-known.ts: ${skillId}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log("=== agent-package.json v2.13 regression check ===\n");
console.log(`Version:    ${pkg.version}`);
console.log(`toolCount:  ${pkg.toolCount} (tools.length=${pkg.tools.length})`);
console.log(`Checked:    ${REQUIRED_TOOLS.length} required tools + ${REQUIRED_AGENT_CARD_SKILLS.length} A2A skills`);

if (issues.length === 0) {
  console.log("\nAll required tools + skills are present and well-formed.");
  process.exit(0);
}

console.log(`\n${issues.length} issue(s):`);
for (const i of issues) console.log(`  - ${i}`);
process.exit(1);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
  }
  return 0;
}
