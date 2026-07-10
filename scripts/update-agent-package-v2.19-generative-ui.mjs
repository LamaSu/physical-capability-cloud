#!/usr/bin/env node
/**
 * agent-package.json refresh — v2.19.0 generative UI (PCC On-Ramp, Wave 3).
 *
 * Distribution half of the on-ramp: bakes the generated-dashboard capability
 * into the live agent pack so every entry point (pack URL, MCP, skill, /start)
 * hands out the upgraded behavior the moment the pack + kit deploy.
 *
 * This script owns the TOOLS + the top-level `ui` field + the 4th worked
 * example. Its sibling `polish-agent-package-claude-max.mjs` owns the
 * system_prompt teaching ("Generating a dashboard" + "Configure before you
 * commit"). Both scripts stamp version 2.19.0, so the pack's version is
 * correct no matter which runs last (the polish runs last in the regeneration
 * flow; it preserves the 4th example this script adds instead of clobbering
 * it — see that script's examples-merge).
 *
 * Adds five thin tools mapping to the Wave-1 artifact registry routes
 * (packages/gateway/src/routes/artifacts.ts, §5.3 of the on-ramp spec):
 *   save_dashboard    POST /api/artifacts
 *   get_dashboard     GET  /api/artifacts/{idOrSlug}
 *   search_dashboards GET  /api/artifacts
 *   fork_dashboard    POST /api/artifacts/{id}/fork
 *   update_dashboard  PUT  /api/artifacts/{id}
 *
 * Run from repo root:
 *   node scripts/update-agent-package-v2.19-generative-ui.mjs
 *
 * Idempotent: tools are added by name (skip if present); the example is added
 * by user_request (skip if present); the `ui` field is owned by this script
 * (overwritten with the in-script content). Re-running produces a byte-
 * identical file (lastUpdated is a fixed constant, not `new Date()`).
 *
 * Writes to apps/dashboard/public/agent-package.json in place.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_PACKAGE_PATH = join(ROOT, "apps", "dashboard", "public", "agent-package.json");

const TARGET_VERSION = "2.19.0";
const TARGET_LAST_UPDATED = "2026-07-09T00:00:00Z";

// ---------------------------------------------------------------------------
// The five generative-UI tools. Same schema as every other pack tool:
//   { name, description, input_schema, endpoint: { method, path } }
// Paths use OpenAPI {param} placeholders (the rest of the file's convention);
// they map onto the artifacts.ts route params :idOrSlug / :id / :slug.
// ---------------------------------------------------------------------------

const NEW_TOOLS = [
  {
    name: "save_dashboard",
    description:
      "Save a generated dashboard to the network so the user gets a live, shareable URL: https://capability.network/a/<slug>. Pass a `manifest` — a small declarative DashboardManifest (windows + live-data bindings + actions) conforming to the schema at https://capability.network/ui-kit/v1/manifest.schema.json; the shipped pcc-ui kit renders it identically everywhere (you compose the manifest, the kit renders it — never hand-rolled HTML). WHEN to call this: only when the task needs a surface to watch/approve/compare/reuse (a live job, a value chain, a settlement trail, a recurring order) — never for a one-line answer. RECALL FIRST: call search_dashboards before generating; reload or fork a match instead of duplicating. The manifest MUST NOT contain an API key (a shared artifact travels with its contents — the network rejects one that does). Returns the stored artifact incl. its slug. Defaults visibility to 'unlisted' (link-shareable, not listed).",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short human name for the dashboard, e.g. 'Watch my pizza + courier'. Used to mint the slug.",
        },
        description: {
          type: "string",
          description: "One-line description of what the dashboard shows.",
        },
        manifest: {
          type: "object",
          description:
            "The DashboardManifest (2-6KB JSON) conforming to https://capability.network/ui-kit/v1/manifest.schema.json. Required top-level keys: `csd` (must be 'pcc://artifacts/dashboard/v1'), `title`, and `sections[]` (each section has `windows[]`). Window kinds: note, metric, capability, list, form, run, approval, receipt, chain, actions. Bindings point at live routes you already use (/api/jobs/:id, /api/escrow/:id, /sse/stream/job/:id). No API key anywhere in the manifest.",
        },
        capabilityTypes: {
          type: "array",
          items: { type: "string" },
          description:
            "Capability types this dashboard is about, e.g. ['pizza.order','courier.dispatch']. This is the discovery join — it's how search_dashboards finds this artifact later.",
        },
        composeRefs: {
          type: "array",
          items: { type: "object" },
          description:
            "Optional pinned, re-plannable ComposeRequest objects (value chains). Pin the request, never a compositionId (those expire in 30 min).",
        },
        visibility: {
          type: "string",
          enum: ["private", "unlisted", "public"],
          description: "Who can load it. Default 'unlisted' (anyone with the link; not in listings). 'public' appears in search_dashboards; 'private' is owner-only.",
        },
        renderedCid: {
          type: "string",
          description: "Optional CID of a rendered-HTML export saved via /api/storage.",
        },
      },
      required: ["name", "manifest"],
    },
    endpoint: { method: "POST", path: "/api/artifacts" },
  },
  {
    name: "get_dashboard",
    description:
      "Recall a saved dashboard by its id or slug. Returns the full artifact (manifest + metadata). Use this to reload a dashboard the user asks for again ('open my pizza dashboard') instead of regenerating it — a saved dashboard reloads with zero regeneration. Public for public/unlisted artifacts; owner-only for private ones. Increments the load counter (a popularity signal).",
    input_schema: {
      type: "object",
      properties: {
        idOrSlug: {
          type: "string",
          description: "The artifact id (ua_...) or its slug (e.g. 'watch-my-pizza-8k3f', the tail of the /a/<slug> URL).",
        },
      },
      required: ["idOrSlug"],
    },
    endpoint: { method: "GET", path: "/api/artifacts/{idOrSlug}" },
  },
  {
    name: "search_dashboards",
    description:
      "Discover existing public dashboards before you generate a new one (recall-first — the library accrues; adopt > extend > build for UIs too). Filter by `capabilityType` (e.g. 'pizza.order'), free-text `q` over name/description/types, and `sort` by popularity or recency. Returns { entries, total, offset, limit }. Only public artifacts are listed; unlisted ones load by slug via get_dashboard but never appear here.",
    input_schema: {
      type: "object",
      properties: {
        capabilityType: {
          type: "string",
          description: "Filter to dashboards tagged with this capability type, e.g. 'pizza.order'.",
        },
        q: {
          type: "string",
          description: "Free-text search over name, description, and capability types.",
        },
        sort: {
          type: "string",
          enum: ["popular", "recent"],
          description: "Ranking: 'popular' (by use+load+fork counts) or 'recent' (default).",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Pagination offset (default 0).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Max results (1..100, default 20).",
        },
      },
      required: [],
    },
    endpoint: { method: "GET", path: "/api/artifacts" },
  },
  {
    name: "fork_dashboard",
    description:
      "Fork an existing dashboard into a new artifact you own, preserving lineage back to the original (the social remix verb). Use this to adapt a popular dashboard rather than build from scratch — e.g. fork a 'watch pizza' dashboard and raise the budget or add a receipt window via update_dashboard. Increments the source's fork counter. You can fork any public/unlisted artifact, or a private one you own.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The id (ua_...) of the artifact to fork.",
        },
        name: {
          type: "string",
          description: "Optional name for the fork (defaults to '<original> (fork)').",
        },
        visibility: {
          type: "string",
          enum: ["private", "unlisted", "public"],
          description: "Visibility of the fork (default 'unlisted').",
        },
      },
      required: ["id"],
    },
    endpoint: { method: "POST", path: "/api/artifacts/{id}/fork" },
  },
  {
    name: "update_dashboard",
    description:
      "Modify a dashboard you own (owner-only). Replace the manifest or any metadata field; the version increments. Use this to edit a saved surface meaningfully — 'raise budgetUSD to 40', 'add a receipt window', 'make it public'. A replaced manifest must still conform to the schema and must not contain an API key. Only send the fields you want to change.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The id (ua_...) of the artifact to update.",
        },
        name: { type: "string", description: "New name." },
        description: { type: "string", description: "New description." },
        manifest: {
          type: "object",
          description:
            "Replacement DashboardManifest (must conform to the schema; no API key). Omit to leave the manifest unchanged.",
        },
        capabilityTypes: {
          type: "array",
          items: { type: "string" },
          description: "Replacement capability-type tags.",
        },
        composeRefs: {
          type: "array",
          items: { type: "object" },
          description: "Replacement pinned ComposeRequest objects.",
        },
        visibility: {
          type: "string",
          enum: ["private", "unlisted", "public"],
          description: "New visibility (e.g. flip 'unlisted' -> 'public' to list it).",
        },
        renderedCid: {
          type: "string",
          description: "New rendered-HTML export CID.",
        },
      },
      required: ["id"],
    },
    endpoint: { method: "PUT", path: "/api/artifacts/{id}" },
  },
];

// ---------------------------------------------------------------------------
// Top-level `ui` field — where the kit + schema + render base + examples live,
// so any consumer (LLM or tool) can find the generative-UI surface. Owned by
// this script; overwritten with the in-script content on every run. Paths are
// the Wave-2 static assets under apps/dashboard/public/ui-kit/v1/.
// ---------------------------------------------------------------------------

const UI_FIELD = {
  csd: "pcc://artifacts/dashboard/v1",
  kit_url: "https://capability.network/ui-kit/v1/pcc-ui.js",
  shell_url: "https://capability.network/ui-kit/v1/shell.html",
  manifest_schema: "https://capability.network/ui-kit/v1/manifest.schema.json",
  render_base: "https://capability.network/a/",
  description:
    "Generative UI: emit a DashboardManifest (schema at manifest_schema), save it with the save_dashboard tool, and share the live page at render_base + <slug>. The pcc-ui kit renders any manifest identically everywhere — you compose the manifest, the kit does the rendering, so it is never hand-rolled HTML. See the system_prompt section 'Generating a dashboard (when the task needs a surface)'.",
  example_manifests: [
    "https://capability.network/ui-kit/v1/example-manifests/job-watch.json",
    "https://capability.network/ui-kit/v1/example-manifests/chain.json",
    "https://capability.network/ui-kit/v1/example-manifests/operator.json",
  ],
};

// ---------------------------------------------------------------------------
// 4th worked example — the generative-UI flow end to end. Demonstrates
// recall-first (search_dashboards), discover-and-ask (build/options ->
// present -> confirm price), the pizza+courier composition, then generate ->
// save -> share, then recall. Added by user_request match (idempotent).
// ---------------------------------------------------------------------------

const NEW_EXAMPLE = {
  user_request:
    "Order me a pizza and dispatch a courier to bring it — and give me a live dashboard I can watch and reuse.",
  what_claude_does: [
    "1. Recall first: search_dashboards({ capabilityType: 'pizza.order' }). If a matching dashboard already exists, get_dashboard or fork_dashboard it and skip regenerating.",
    "2. Discover + ask (never order blind): POST /api/build/options for the pizza to get the real size/crust/topping choices, then present them and get the user's selections. A fiddly config like this is a good `form`-window candidate rather than a long Q&A. GET /api/capabilities?type=pizza.order&within=<coords>,10 to pick a shop.",
    "3. Price + confirm: POST /api/build/price with the chosen selections; show the total to the user and get explicit confirmation BEFORE committing.",
    "4. Post the pizza offer: POST /api/job-offers (capabilityType=pizza.order, requirements from the confirmed selections, a stable idempotencyKey). Set requirements.pickupReadyAt = now + estimatedWaitMinutes + 5min buffer.",
    "5. Compose the courier: GET /api/capabilities?type=courier.dispatch, then POST /api/job-offers (courier.dispatch, dispatchAt = pickupReadyAt - driverETA). The two offers settle independently.",
    "6. Now the task needs a surface to watch — emit a DashboardManifest conforming to /ui-kit/v1/manifest.schema.json: a `chain` window pinning the pizza+courier ComposeRequest, a `run` window per offer bound to /sse/stream/job/:id, and a `receipt` window on the settlement. No API key anywhere in the manifest.",
    "7. save_dashboard({ name:'Watch my pizza + courier', manifest, capabilityTypes:['pizza.order','courier.dispatch'] }); hand the user https://capability.network/a/<slug> (append #pcc_key=<their key> only in this private chat).",
    "8. Poll both offers to status=settled; the dashboard shows it live. Next time, 'open my pizza dashboard' is a search_dashboards/get_dashboard recall — zero regeneration.",
  ].join("\n"),
  tools_used: [
    "search_dashboards",
    "build_options",
    "search_capabilities",
    "save_dashboard",
    "get_dashboard",
    "POST /api/job-offers",
  ],
};

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

const raw = readFileSync(AGENT_PACKAGE_PATH, "utf-8");
const pkg = JSON.parse(raw);

if (!Array.isArray(pkg.tools)) {
  console.error("ERROR: agent-package.json has no `tools` array");
  process.exit(1);
}

// 1. Tools — add by name (idempotent).
const existingNames = new Set(pkg.tools.map((t) => t.name));
const addedTools = [];
const skippedTools = [];
for (const tool of NEW_TOOLS) {
  if (existingNames.has(tool.name)) {
    skippedTools.push(tool.name);
    continue;
  }
  pkg.tools.push(tool);
  addedTools.push(tool.name);
}

// 2. `ui` field — owned by this script; overwrite with in-script content.
const uiAdded = !("ui" in pkg);
pkg.ui = UI_FIELD;

// 3. 4th example — add by user_request (idempotent). Guard a missing array.
if (!Array.isArray(pkg.examples)) pkg.examples = [];
const exampleAlready = pkg.examples.some(
  (e) => e && e.user_request === NEW_EXAMPLE.user_request,
);
if (!exampleAlready) pkg.examples.push(NEW_EXAMPLE);

// 4. Version + counts (fixed constants → byte-identical re-runs).
const newToolCount = pkg.tools.length;
pkg.version = TARGET_VERSION;
pkg.toolCount = newToolCount;
pkg.lastUpdated = TARGET_LAST_UPDATED;

if (pkg.metadata && typeof pkg.metadata === "object") {
  pkg.metadata.tool_count = newToolCount;
  pkg.metadata.updated = TARGET_LAST_UPDATED;
}

writeFileSync(AGENT_PACKAGE_PATH, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

console.log("=== agent-package.json refresh (v2.19.0 generative UI) ===");
console.log(`Version:     ${pkg.version}`);
console.log(`toolCount:   ${pkg.toolCount}`);
console.log(`ui field:    ${uiAdded ? "added" : "present (overwritten)"}`);
console.log(`4th example: ${exampleAlready ? "no (already present)" : "added"}`);
console.log(`Tools added: ${addedTools.length}`);
for (const n of addedTools) console.log(`  + ${n}`);
if (skippedTools.length > 0) {
  console.log(`Tools skipped (already present): ${skippedTools.length}`);
  for (const n of skippedTools) console.log(`  · ${n}`);
}
console.log(`\nWrote ${AGENT_PACKAGE_PATH}`);
