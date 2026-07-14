/**
 * MCP Apps bridge — the ONE transport for PCC's shipped On-Ramp generative-UI
 * kit (see apps/dashboard/public/ui-kit/v1/pcc-ui.js), speaking the STANDARD
 * MCP Apps protocol (SEP-1865, spec status Stable 2026-01-26).
 *
 * PCC's LLM-authored `DashboardManifest` + the pcc-ui kit already render live
 * dashboards over several transports (gateway shell, standalone shell, inlined
 * artifact export). This module exposes the SAME kit as an MCP App so a host
 * (Claude Desktop / ChatGPT Apps) that calls the PCC MCP server can render the
 * composed dashboard inline instead of only returning text.
 *
 * ─── ONE transport contract (all three UI surfaces converge here) ───────────
 * Every UI-bearing tool declares a FIXED, predeclared, fetchable `ui://`
 * resource on its descriptor (`_meta.ui.resourceUri`, canonical nested form) —
 * NO unresolved `{slug}` template:
 *   - `render_pcc_dashboard`                → ui://pcc/dashboard/render
 *   - save/get/fork/update_dashboard        → ui://pcc/dashboard/saved
 *   - search_dashboards                     → ui://pcc/dashboard/gallery
 * The tool's DATA travels in the tool result's `structuredContent` (validated
 * by each tool's `outputSchema`), and the host delivers it to the view over the
 * standard lifecycle notification `ui/notifications/tool-result`. The view then
 * VALIDATES the payload in-browser before rendering. `render` and `saved` are
 * the same single-manifest view (manifest at `params.structuredContent.manifest`);
 * `gallery` is the list view (`params.structuredContent.entries`).
 *
 * The per-slug `ui://pcc/dashboard/{slug}` resource is kept ONLY as an optional
 * public/unlisted SHARING view (self-contained, manifest pre-inlined, no host
 * handoff, public|unlisted-only via getPublicArtifactForRender). It is not
 * advertised on any tool descriptor or result.
 *
 * ─── Standard MCP Apps lifecycle (hand-implemented per apps.mdx; NO new dep) ──
 * The view acts as an MCP client over `postMessage`:
 *   1. View → Host:  `ui/initialize` request (protocolVersion "2026-01-26").
 *   2. Host → View:  `McpUiInitializeResult` (the response to step 1).
 *   3. View → Host:  `ui/notifications/initialized` notification.
 *   4. Host → View:  `ui/notifications/tool-input` (params.arguments) — accepted, no-op.
 *   5. Host → View:  `ui/notifications/tool-result` (params IS a CallToolResult).
 * The view accepts a tool-result ONLY from a message whose `event.source ===
 * window.parent`, carrying a JSON-RPC 2.0 envelope with method
 * `ui/notifications/tool-result`; it reads the manifest/entries ONLY from
 * `params.structuredContent`, re-validates in-view, and boots. It NEVER accepts
 * a token/apiBase/snapshot from a message and NEVER writes a credential to
 * storage. A hostile first message cannot latch the view.
 *
 * `@modelcontextprotocol/ext-apps` is deliberately NOT added: it is not an
 * installed/transitive dependency (verified against the lockfile), and the
 * lifecycle is small enough to implement directly per the spec (clean-room).
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  DashboardManifestSchema,
  containsApiKey,
  type DashboardManifest,
} from "@pcc/spec";
import {
  getPublicArtifactForRender,
  publicLookupThrottled,
  notePublicLookupFailure,
} from "../routes/artifacts.js";
import { REGISTERED_OPERATION_IDS } from "./operation-ids.js";

// ---------------------------------------------------------------------------
// Constants — MIME, tool name, and the FIXED predeclared UI resource URIs.
// Each fixed URI is fetchable before its tool runs and contains no `{slug}`
// template variable (directive 4/15). The SDK resolves an exact resource read
// before any template match, so these never collide with the `{slug}` share
// template (and real slugs always carry a random `-<hex>` suffix).
// ---------------------------------------------------------------------------

export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
export const RENDER_DASHBOARD_TOOL_NAME = "render_pcc_dashboard";

/** Transient composed dashboard (render_pcc_dashboard). Single-manifest view. */
export const MCP_APP_RENDER_URI = "ui://pcc/dashboard/render";
/** Saved artifact (save/get/fork/update_dashboard). Same single-manifest view. */
export const MCP_APP_SAVED_URI = "ui://pcc/dashboard/saved";
/** Search results (search_dashboards). List view. */
export const MCP_APP_GALLERY_URI = "ui://pcc/dashboard/gallery";

/** Optional public/unlisted SHARING resource TEMPLATE, keyed by slug. Reached
 * only via an out-of-band public share URI — never advertised on a tool
 * descriptor or result. Kept for public|unlisted sharing (directive 4/16). */
export const MCP_APP_DASHBOARD_TEMPLATE_URI = "ui://pcc/dashboard/{slug}";

/** Live gateway origin baked into a self-contained (share) view's manifest so
 * the kit's live-data bindings resolve to the network, not the opaque host
 * origin. Mirrors http-mcp-server.ts's PCC_API_BASE_URL. */
const MCP_APP_API_BASE_URL = "https://capability.network";

/** The 5 On-Ramp dashboard tools (from agent-package.json) that carry a UI.
 * search returns a list (gallery); the other four return one artifact (saved). */
export const ON_RAMP_UI_TOOL_NAMES = [
  "save_dashboard",
  "get_dashboard",
  "search_dashboards",
  "fork_dashboard",
  "update_dashboard",
] as const;

const ON_RAMP_UI_TOOL_SET: ReadonlySet<string> = new Set(ON_RAMP_UI_TOOL_NAMES);

/** Whether a tool name is one of the On-Ramp dashboard UI tools. */
export function isOnRampUiTool(name: string): boolean {
  return ON_RAMP_UI_TOOL_SET.has(name);
}

/** The concrete `ui://` SHARE resource URI for one saved dashboard slug. Slugs
 * are minted `[a-z0-9-]` (routes/artifacts.ts slugify), so no escaping needed. */
export function dashboardResourceUriForSlug(slug: string): string {
  return `ui://pcc/dashboard/${slug}`;
}

/** The fixed UI resource a UI-bearing On-Ramp tool renders into: the gallery
 * (list) view for search, the saved (single-manifest) view for the rest. Used
 * BOTH on the tools/list descriptor and on the call result, so the two agree
 * and the host never needs a post-exec override (directive 4/5/17). */
export function onRampToolResourceUri(toolName: string): string {
  return toolName === "search_dashboards" ? MCP_APP_GALLERY_URI : MCP_APP_SAVED_URI;
}

/** Canonical `_meta.ui` block for a UI-bearing On-Ramp tool (directive 17 —
 * nested `ui.resourceUri`, never the deprecated flat `ui/resourceUri`). */
export function onRampToolUiMeta(toolName: string): { ui: { resourceUri: string } } {
  return { ui: { resourceUri: onRampToolResourceUri(toolName) } };
}

/** MCP Apps (SEP-1865) host->view notification method that carries a tool's
 * result into the view. Its params IS a standard `CallToolResult`. The view
 * accepts a handoff ONLY from a message whose method equals this string. */
export const MCP_APP_TOOL_RESULT_METHOD = "ui/notifications/tool-result";

// ---------------------------------------------------------------------------
// Unique MCP-App domain (`_meta.ui.domain`) — the D14 browser-storage isolation
// signal. A compliant host uses `_meta.ui.domain` to give the view its OWN
// iframe origin, so the view's sessionStorage/localStorage is isolated from
// every other view and no sibling view can read a credential a different one
// stored. Sourced from PCC_MCP_APP_DOMAIN: a bare https origin, required in
// production, a reserved placeholder in dev/test.
// ---------------------------------------------------------------------------

/** Env var naming the UNIQUE https origin the MCP App view is served under. */
export const MCP_APP_DOMAIN_ENV = "PCC_MCP_APP_DOMAIN";

/** Non-production fallback when PCC_MCP_APP_DOMAIN is unset. `.invalid` is
 * reserved (RFC 2606) and never resolves — safe in dev/test, never shipped to
 * production (resolveMcpAppDomain THROWS there instead). */
export const MCP_APP_DOMAIN_PLACEHOLDER = "https://pcc-mcp-app.invalid";

/**
 * Validate a configured MCP-App domain: it MUST be a bare https ORIGIN — a valid
 * absolute https URL with NO credentials, path, query, or fragment. Returns the
 * normalized origin; throws a clear, actionable diagnostic otherwise.
 */
export function validateMcpAppDomain(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${MCP_APP_DOMAIN_ENV} must be a valid absolute https origin URL — got "${value}"`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${MCP_APP_DOMAIN_ENV} must be an https:// origin — got "${value}"`);
  }
  if (url.username || url.password) {
    throw new Error(`${MCP_APP_DOMAIN_ENV} must not contain credentials — got "${value}"`);
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(`${MCP_APP_DOMAIN_ENV} must be a bare origin with no path — got "${value}"`);
  }
  if (url.search) {
    throw new Error(`${MCP_APP_DOMAIN_ENV} must not contain a query string — got "${value}"`);
  }
  if (url.hash) {
    throw new Error(`${MCP_APP_DOMAIN_ENV} must not contain a fragment — got "${value}"`);
  }
  return url.origin;
}

/**
 * Resolve the MCP-App `_meta.ui.domain`. Reads + validates PCC_MCP_APP_DOMAIN.
 * Unset in production → THROWS (surfaced at startup via primeMcpAppAssets, so a
 * misconfigured prod image fails to BOOT rather than serving non-isolated views).
 * Unset in non-production → the reserved placeholder origin.
 */
export function resolveMcpAppDomain(): string {
  const configured = process.env[MCP_APP_DOMAIN_ENV];
  if (configured && configured.trim().length > 0) {
    return validateMcpAppDomain(configured.trim());
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `${MCP_APP_DOMAIN_ENV} must be set to a UNIQUE https origin in production. It becomes the MCP App view's ` +
        `_meta.ui.domain — the host uses it to give the view its own iframe origin so its browser storage is ` +
        `isolated from every other view (D14 cross-view credential-theft mitigation). Set it to a dedicated ` +
        `origin (e.g. https://pcc-mcp-app.example); non-production defaults to ${MCP_APP_DOMAIN_PLACEHOLDER}.`,
    );
  }
  return MCP_APP_DOMAIN_PLACEHOLDER;
}

/** MCP Apps (SEP-1865) resource-content CSP metadata. A compliant host builds
 * the view iframe's sandbox Content-Security-Policy from `_meta.ui.csp`
 * (camelCase keys) — it does NOT read the HTML `<meta http-equiv>` CSP for the
 * sandbox — so the live PCC API origin the kit fetches from MUST be declared as
 * a connect-src origin here, or the host blocks those requests. Attached to
 * EVERY UI `resources/read` (render, saved, gallery, and the per-slug share
 * view) so each ships an identical policy; the HTML `<meta>` CSP stays as
 * defense-in-depth (directive 3).
 *   - connectDomains → CSP connect-src (the live PCC API the kit calls)
 *   - resourceDomains: [] → no external scripts/styles/images/fonts (self-only)
 *   - prefersBorder: true → request a host-drawn border (hosts' defaults vary)
 */
export const MCP_APP_CSP_META = {
  ui: {
    csp: { connectDomains: [MCP_APP_API_BASE_URL], resourceDomains: [] as string[] },
    prefersBorder: true,
  },
};

/** The canonical `_meta.ui` block attached to EVERY UI `resources/read` (render,
 * saved, gallery, and the per-slug share view): the host-enforced CSP + border
 * hint from MCP_APP_CSP_META, PLUS the unique `domain` (D14 browser-storage
 * isolation) resolved FRESH from PCC_MCP_APP_DOMAIN so the value tracks the
 * runtime env (and a production misconfig fails loudly at startup). */
export function mcpAppUiResourceMeta(): {
  ui: {
    domain: string;
    csp: { connectDomains: string[]; resourceDomains: string[] };
    prefersBorder: boolean;
  };
} {
  return { ui: { domain: resolveMcpAppDomain(), ...MCP_APP_CSP_META.ui } };
}

const HTTP_MIRROR_PATH = "/mcp-apps/ui/dashboard";

// ---------------------------------------------------------------------------
// Asset resolution — mirrors http-mcp-server.ts's candidate-path search
// (compiled dist/, tsx-run src/, or cwd-relative), generalized so it can also
// locate pcc-ui.js + manifest.schema.json (under apps/dashboard/public).
// ---------------------------------------------------------------------------

/** Exported so other MCP surfaces (e.g. docs-mcp-server.ts) that also need to
 * locate a repo-root-relative asset don't re-derive this candidate search. */
export function resolveGatewayAsset(relativeSegments: string[], envVarOverride?: string): string {
  const override = envVarOverride ? process.env[envVarOverride] : undefined;
  if (override) {
    // An EXPLICIT override that points nowhere is an operator misconfiguration —
    // fail loudly rather than silently falling back to a bundled copy (directive 6).
    if (existsSync(override)) return resolvePath(override);
    throw new Error(
      `${relativeSegments.join("/")}: ${envVarOverride}="${override}" was set but no file exists there`,
    );
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolvePath(here, "..", "..", "..", "..", ...relativeSegments),
    resolvePath(here, "..", "..", "..", ...relativeSegments),
    resolvePath(process.cwd(), ...relativeSegments),
  ];

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    const hint = envVarOverride ? ` (set ${envVarOverride} to its absolute path)` : "";
    throw new Error(`${relativeSegments.join("/")} was not found${hint}`);
  }
  return found;
}

const PCC_UI_KIT_RELATIVE = ["apps", "dashboard", "public", "ui-kit", "v1", "pcc-ui.js"];
const DASHBOARD_MANIFEST_SCHEMA_RELATIVE = [
  "apps",
  "dashboard",
  "public",
  "ui-kit",
  "v1",
  "manifest.schema.json",
];

// Startup asset cache (directive 6). Each mandatory MCP-App asset is read from
// disk ONCE — at server boot via primeMcpAppAssets(), or lazily on first use in a
// test — and served from memory thereafter. This (a) removes a per-request disk
// read from tools/list (buildRenderDashboardTool) and every UI resources/read
// (the HTML builders), and (b) lets the gateway FAIL AT STARTUP with a clear
// diagnostic when the production image is missing an asset, instead of throwing
// deep inside tools/list / resources/read at request time — which would make
// every PCC tool undiscoverable, silently (audit finding/directive 6).
let pccUiKitSourceCache: string | undefined;
let dashboardManifestSchemaCache: Record<string, unknown> | undefined;

/** pcc-ui.js source — read + cached once (primed at startup, see primeMcpAppAssets). */
function readPccUiKitSource(): string {
  if (pccUiKitSourceCache === undefined) {
    pccUiKitSourceCache = readFileSync(
      resolveGatewayAsset(PCC_UI_KIT_RELATIVE, "PCC_UI_KIT_PATH"),
      "utf8",
    );
  }
  return pccUiKitSourceCache;
}

/** manifest.schema.json — read + parsed + cached once (primed at startup). */
function readDashboardManifestJsonSchema(): Record<string, unknown> {
  if (dashboardManifestSchemaCache === undefined) {
    const raw = readFileSync(
      resolveGatewayAsset(DASHBOARD_MANIFEST_SCHEMA_RELATIVE, "PCC_DASHBOARD_SCHEMA_PATH"),
      "utf8",
    );
    dashboardManifestSchemaCache = JSON.parse(raw) as Record<string, unknown>;
  }
  return dashboardManifestSchemaCache;
}

/**
 * Eagerly load + cache every mandatory MCP-App runtime asset (pcc-ui.js and
 * manifest.schema.json) at server startup. Throws a SINGLE clear diagnostic
 * naming EVERY missing/unreadable asset, so a misbuilt production image fails to
 * BOOT (loud, caught by the deploy /health smoke check) rather than serving a
 * broken tools/list at request time. Called once from httpMcpRoutes; idempotent
 * (the underlying reads are cached).
 */
export function primeMcpAppAssets(): void {
  const failures: string[] = [];
  try {
    readPccUiKitSource();
  } catch (error) {
    failures.push(`pcc-ui.js — ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    readDashboardManifestJsonSchema();
  } catch (error) {
    failures.push(
      `manifest.schema.json — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Fail at boot if the unique MCP-App domain is misconfigured (unset in prod, or
  // an invalid origin) — a non-storage-isolated MCP App view must never reach
  // production (D14). In non-prod this is the harmless placeholder and never throws.
  try {
    resolveMcpAppDomain();
  } catch (error) {
    failures.push(`${MCP_APP_DOMAIN_ENV} — ${error instanceof Error ? error.message : String(error)}`);
  }
  if (failures.length > 0) {
    throw new Error(
      "MCP Apps assets are missing from the runtime image — the gateway cannot serve the " +
        `generative-UI surface. Missing: ${failures.join("; ")}. These are committed under ` +
        "apps/dashboard/public/ui-kit/v1/ and MUST ship in the production image (see " +
        "docs/DEPLOY.md / Dockerfile). Override paths with PCC_UI_KIT_PATH / " +
        "PCC_DASHBOARD_SCHEMA_PATH.",
    );
  }
}

/** Test-only: drop the startup asset cache so a following prime re-reads disk. */
export function _resetMcpAppAssetCacheForTests(): void {
  pccUiKitSourceCache = undefined;
  dashboardManifestSchemaCache = undefined;
}

// ---------------------------------------------------------------------------
// Browser-safe in-view logic. Every function in this block is (a) exported and
// unit-tested and (b) inlined VERBATIM into the view HTML via `.toString()`, so
// the browser boot script and the tested definition are ONE source of truth and
// cannot drift. They are written in conservative ES5 style (var + function
// expressions; no arrow fns, optional chaining, or `??`) so `.toString()` yields
// stable, widely-compatible browser JS regardless of the TS compile target, and
// are deliberately self-contained EXCEPT for calling their siblings by name
// (every sibling is inlined in the same IIFE scope, so the names resolve).
// ---------------------------------------------------------------------------

/** Minimal structural view-DOM types (the gateway tsconfig has no "dom" lib). */
interface ViewNode {
  textContent: string | null;
  parentNode: { removeChild(child: ViewNode): void } | null;
  className: string;
  appendChild(child: ViewNode): ViewNode;
}
interface ViewDocument {
  getElementById(id: string): ViewNode | null;
  createElement(tag: string): ViewNode;
  body: ViewNode;
}
interface ViewParent {
  postMessage(message: unknown, targetOrigin: string): void;
}
interface ViewMessageEvent {
  source: unknown;
  data: unknown;
}
interface ViewWindow {
  parent: ViewParent;
  document: ViewDocument;
  addEventListener(type: string, handler: (event: ViewMessageEvent) => void): void;
  __PCC_HOST__?: boolean;
  __PCC_BOOTED__?: boolean;
  /** R4 PR2 — the typed-operation bridge the kit uses to run a registered
   *  operation via the host's tools/call (set by mountManifestIntoView). */
  __PCC_HOST_BRIDGE__?: {
    callOperation?: (operationId: string, args: unknown) => Promise<unknown>;
    [key: string]: unknown;
  };
  /** R4 PR2 — the server-authored allowlist of registered operation ids. */
  __PCC_HOST_OPERATIONS__?: string[];
}

/**
 * Browser-safe structural validator for a DashboardManifest — the in-view
 * re-validation the spec's threat model requires (a hostile parent must not be
 * able to inject a forged manifest that renders as an approval/payment/receipt).
 * Mirrors the top-level shape + closed window-kind set + the no-API-key refine
 * of `DashboardManifestSchema` (a unit test asserts these literals stay in sync
 * with the imported schema, so they cannot silently drift). Server validation is
 * NOT assumed sufficient — the host is untrusted from the view's perspective.
 */
export function isValidDashboardManifest(m: unknown): boolean {
  if (!m || typeof m !== "object") return false;
  var man = m as { csd?: unknown; title?: unknown; sections?: unknown; theme?: unknown };
  if (man.csd !== "pcc://artifacts/dashboard/v1") return false;
  if (typeof man.title !== "string" || man.title.length === 0) return false;
  if (!Array.isArray(man.sections)) return false;
  var kinds = [
    "note",
    "metric",
    "capability",
    "list",
    "form",
    "run",
    "approval",
    "receipt",
    "chain",
    "actions",
  ];
  for (var i = 0; i < man.sections.length; i++) {
    var sec = man.sections[i] as { windows?: unknown };
    if (!sec || typeof sec !== "object") return false;
    var wins = sec.windows;
    if (!Array.isArray(wins)) return false;
    for (var j = 0; j < wins.length; j++) {
      var w = wins[j] as { kind?: unknown };
      if (!w || typeof w !== "object") return false;
      if (typeof w.kind !== "string") return false;
      var known = false;
      for (var k = 0; k < kinds.length; k++) {
        if (kinds[k] === w.kind) {
          known = true;
          break;
        }
      }
      if (!known) return false;
    }
  }
  if (man.theme !== undefined && man.theme !== "auto" && man.theme !== "dark" && man.theme !== "light") {
    return false;
  }
  // No-key refine (matches DashboardManifestSchema): a rendered manifest must
  // never carry an API key — it would travel with the view.
  var s = JSON.stringify(m);
  if (s.indexOf("pcc_live_") !== -1 || s.indexOf("pcc_test_") !== -1) return false;
  return true;
}

/**
 * Verify + extract a DashboardManifest from a `window` "message" event, per the
 * MCP Apps host->view contract. Returns the validated manifest ONLY when the
 * message is a genuine tool-result notification from the embedding host; returns
 * `null` for everything else, so a caller never boots on an unverified message.
 * Requires ALL of: `source === parent`; a JSON-RPC 2.0 envelope; method
 * `ui/notifications/tool-result`; a `params.structuredContent.manifest` that
 * passes `isValidDashboardManifest`. Reads NOTHING else from the message — no
 * token, no apiBase, no snapshot (those are never accepted from a message).
 */
export function extractToolResultManifest(source: unknown, parent: unknown, data: unknown): unknown | null {
  if (source !== parent) return null;
  if (!data || typeof data !== "object") return null;
  var envelope = data as { jsonrpc?: unknown; method?: unknown; params?: unknown };
  if (envelope.jsonrpc !== "2.0") return null;
  if (envelope.method !== "ui/notifications/tool-result") return null;
  var params = envelope.params;
  if (!params || typeof params !== "object") return null;
  var structured = (params as { structuredContent?: unknown }).structuredContent;
  if (!structured || typeof structured !== "object") return null;
  var manifest = (structured as { manifest?: unknown }).manifest;
  if (!isValidDashboardManifest(manifest)) return null;
  return manifest;
}

/**
 * Same host->view verification as extractToolResultManifest, but for the gallery
 * (search) view: returns the `params.structuredContent.entries` array, or null.
 */
export function extractToolResultEntries(source: unknown, parent: unknown, data: unknown): unknown[] | null {
  if (source !== parent) return null;
  if (!data || typeof data !== "object") return null;
  var envelope = data as { jsonrpc?: unknown; method?: unknown; params?: unknown };
  if (envelope.jsonrpc !== "2.0") return null;
  if (envelope.method !== "ui/notifications/tool-result") return null;
  var params = envelope.params;
  if (!params || typeof params !== "object") return null;
  var structured = (params as { structuredContent?: unknown }).structuredContent;
  if (!structured || typeof structured !== "object") return null;
  var entries = (structured as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return null;
  return entries;
}

/**
 * Mount a validated manifest into the single-manifest view and boot the kit.
 * Idempotent (a `__PCC_BOOTED__` latch renders at most once — so a hostile
 * message that arrives BEFORE a valid one can never pre-empt the real mount,
 * and a duplicate result can't remount). Writes the manifest into
 * `#pcc-manifest` (programmatic textContent — no HTML re-parse, no escaping
 * needed), removes the "waiting for the host" placeholder, announces the host
 * bridge (`__PCC_HOST__` → the kit's detectMode() resolves to 'host'), then
 * injects the kit LAST. NEVER writes a credential to storage.
 */
export function mountManifestIntoView(
  win: ViewWindow,
  manifest: unknown,
  kitSource: string,
  callHostTool?: (name: string, args: unknown) => Promise<unknown>,
): boolean {
  if (win.__PCC_BOOTED__) return false;
  win.__PCC_BOOTED__ = true;
  win.__PCC_HOST__ = true;
  // R4 PR2 — expose the typed-operation bridge BEFORE the kit boots. The kit
  // calls callOperation(operationId, args) for a REGISTERED operation (present
  // in __PCC_HOST_OPERATIONS__), which sends a tools/call for the mapped
  // pcc.op.<id> tool through the host. With no bridge the kit stays inert (the
  // PR1 read-only lockdown), so raw manifest-authored writes never resurface.
  if (typeof callHostTool === "function") {
    var bridge = win.__PCC_HOST_BRIDGE__ || {};
    bridge.callOperation = function (operationId: string, args: unknown): Promise<unknown> {
      return callHostTool("pcc.op." + operationId, args);
    };
    win.__PCC_HOST_BRIDGE__ = bridge;
  }
  var doc = win.document;
  var manifestNode = doc.getElementById("pcc-manifest");
  if (manifestNode) manifestNode.textContent = JSON.stringify(manifest);
  var status = doc.getElementById("pcc-kit-status");
  if (status && status.parentNode) status.parentNode.removeChild(status);
  var kit = doc.createElement("script");
  kit.textContent = kitSource;
  doc.body.appendChild(kit);
  return true;
}

/**
 * Render the gallery (search results) into the list view, from a validated
 * entries array. Idempotent via the same `__PCC_BOOTED__` latch. Builds the DOM
 * with createElement + textContent ONLY (never innerHTML) — search entries are
 * untrusted content. Removes the "waiting" placeholder on first render.
 */
export function renderGalleryIntoView(win: ViewWindow, entries: unknown[]): boolean {
  if (win.__PCC_BOOTED__) return false;
  win.__PCC_BOOTED__ = true;
  var doc = win.document;
  var root = doc.getElementById("pcc-root") || doc.body;
  var status = doc.getElementById("pcc-kit-status");
  if (status && status.parentNode) status.parentNode.removeChild(status);
  if (!entries.length) {
    var empty = doc.createElement("p");
    empty.textContent = "No dashboards found.";
    root.appendChild(empty);
    return true;
  }
  var list = doc.createElement("ul");
  list.className = "pcc-gallery";
  for (var i = 0; i < entries.length; i++) {
    var e = (entries[i] || {}) as { slug?: unknown; name?: unknown; title?: unknown };
    var li = doc.createElement("li");
    var titleNode = doc.createElement("span");
    titleNode.className = "pcc-gallery-title";
    var title = e.title || e.name || e.slug || "Untitled dashboard";
    titleNode.textContent = String(title);
    li.appendChild(titleNode);
    if (e.slug) {
      var slugNode = doc.createElement("code");
      slugNode.className = "pcc-gallery-slug";
      slugNode.textContent = String(e.slug);
      li.appendChild(slugNode);
    }
    list.appendChild(li);
  }
  root.appendChild(list);
  return true;
}

/**
 * The ONE MCP Apps lifecycle client, shared by every view (directive 15). Sends
 * `ui/initialize`, replies to the host's init result with
 * `ui/notifications/initialized`, and dispatches a verified
 * `ui/notifications/tool-result` to the view-specific `onToolResult` handler.
 * Every inbound message is gated on `source === win.parent` + JSON-RPC 2.0 here,
 * before any handler runs.
 *
 * R4 PR2 — returns a `callHostTool(name, args)` that sends an OUTBOUND
 * `tools/call` request to the host and resolves on the matching-`id` response.
 * This is how a locked-down hosted view performs a registered typed operation:
 * it never issues a raw HTTP write (still inert in host mode), it asks the HOST
 * to invoke the server-authorized `pcc.op.*` tool. The response listener lives
 * HERE (same `source === parent` + JSON-RPC gate), correlating each response to
 * its pending request by id (ids start at 2, distinct from INIT_ID=1).
 */
export function connectMcpAppView(
  win: ViewWindow,
  onToolResult: (source: unknown, parent: unknown, data: unknown) => void,
): (name: string, args: unknown) => Promise<unknown> {
  var INIT_ID = 1;
  var initialized = false;
  var nextCallId = 2;
  var pending: Record<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }> = {};
  win.addEventListener("message", function (event: ViewMessageEvent) {
    var source = event ? event.source : undefined;
    var data = event ? event.data : undefined;
    if (source !== win.parent) return;
    if (!data || typeof data !== "object") return;
    var msg = data as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown; method?: unknown };
    if (msg.jsonrpc !== "2.0") return;
    if (msg.id === INIT_ID && msg.result && !initialized) {
      initialized = true;
      win.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*");
      return;
    }
    // Correlate a tools/call RESPONSE (result or error) back to its caller. Only
    // ids we actually issued are in `pending`, so an unsolicited id is ignored.
    if (msg.id !== undefined && msg.id !== null && pending[String(msg.id)]) {
      var entry = pending[String(msg.id)];
      delete pending[String(msg.id)];
      if (msg.error) {
        var em = msg.error as { message?: unknown };
        entry.reject(new Error(em && typeof em.message === "string" ? em.message : "operation failed"));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (msg.method === "ui/notifications/tool-result") {
      onToolResult(source, win.parent, data);
    }
    // ui/notifications/tool-input is accepted but a no-op: the render/saved view
    // takes its manifest from the tool RESULT, not the input arguments.
  });
  win.parent.postMessage(
    {
      jsonrpc: "2.0",
      id: INIT_ID,
      method: "ui/initialize",
      params: {
        protocolVersion: "2026-01-26",
        appCapabilities: {},
        clientInfo: { name: "pcc-dashboard-view", version: "1.0.0" },
      },
    },
    "*",
  );
  return function callHostTool(name: string, args: unknown): Promise<unknown> {
    return new Promise(function (resolve, reject) {
      var id = nextCallId++;
      pending[String(id)] = { resolve: resolve, reject: reject };
      win.parent.postMessage(
        { jsonrpc: "2.0", id: id, method: "tools/call", params: { name: name, arguments: args || {} } },
        "*",
      );
    });
  };
}

/** Boot the single-manifest view (render + saved): validate the host's
 * tool-result manifest in-view and mount the kit. */
export function runDashboardViewBoot(win: ViewWindow, kitSource: string): void {
  var callHostTool = connectMcpAppView(win, function (source: unknown, parent: unknown, data: unknown) {
    var manifest = extractToolResultManifest(source, parent, data);
    if (manifest) mountManifestIntoView(win, manifest, kitSource, callHostTool);
  });
}

/** Boot the gallery (search) view: validate the host's tool-result entries
 * in-view and render the list. */
export function runGalleryViewBoot(win: ViewWindow): void {
  connectMcpAppView(win, function (source: unknown, parent: unknown, data: unknown) {
    var entries = extractToolResultEntries(source, parent, data);
    if (entries) renderGalleryIntoView(win, entries);
  });
}

// ---------------------------------------------------------------------------
// HTML builders. Each inlines the browser-safe functions above verbatim via
// `.toString()` (single source of truth), then calls the view's boot fn.
// ---------------------------------------------------------------------------

/** Hosts allowed to FRAME the mirror view. Meaningful ONLY in an HTTP response
 * header (see registerMcpAppHttpRoute) — a `frame-ancestors` directive in a
 * `<meta>` CSP is silently ignored by browsers, so it is deliberately absent
 * from buildMcpAppCsp() below (directive 12). In the MCP transport the HOST
 * sandbox controls framing. */
export const MCP_APP_FRAME_ANCESTORS = "https://chatgpt.com https://claude.ai";

/** A fresh CSP nonce (128 bits, base64) for one rendered document. */
export function cspNonce(): string {
  return randomBytes(16).toString("base64");
}

/**
 * The MCP Apps view CSP for the HTML `<meta>` (defense-in-depth; the
 * host-enforced sandbox CSP comes from resource-content `_meta.ui.csp`).
 * Directive 12:
 *   - NO `unsafe-eval` (never present — the kit uses no eval/new Function).
 *   - script-src is `'nonce-<n>' 'strict-dynamic'` — the inline boot `<script
 *     nonce>` is trusted and, via strict-dynamic, may inject the kit `<script>`
 *     it builds; NO `unsafe-inline` for scripts.
 *   - NO `frame-ancestors` here (meaningless in a `<meta>`; it lives on the HTTP
 *     mirror header where it is enforced).
 *   - style-src keeps `'unsafe-inline'` — the kit injects its BUILD-CONTROLLED
 *     stylesheet as a programmatic `<style>` textContent; a nonce on a
 *     programmatically-created `<style>` is not reliably honored across engines,
 *     and CSS cannot execute script, so this is the low-risk residue. No `*`.
 */
export function buildMcpAppCsp(nonce: string): string {
  return (
    "default-src 'self'; " +
    `script-src 'nonce-${nonce}' 'strict-dynamic'; ` +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; " +
    "connect-src 'self' https://capability.network; " +
    "form-action 'self' https://capability.network"
  );
}

/** pcc-ui.js source as a safe JS string literal for inline embedding.
 * JSON.stringify escapes backslash/quote/control-chars; the extra replace guards
 * the ONE thing it does not — a literal "</script" substring, which would
 * otherwise prematurely terminate the embedding <script> when the HTML is
 * tokenized. */
function pccUiKitSourceLiteral(): string {
  return JSON.stringify(readPccUiKitSource()).replace(/<\/script/gi, "<\\/script");
}

/** Escape a JSON string for safe placement inside a `<script type="application/json">`
 * data block that IS parsed by the HTML tokenizer (only `<`/`>` need neutralizing;
 * `JSON.parse` recovers them). Used only for build-time PRE-inlined manifests. */
function inlineJsonForScriptData(value: unknown): string {
  return JSON.stringify(value).split("<").join("\\u003c").split(">").join("\\u003e");
}

/** The shared inlined-function preamble for the single-manifest view. */
function dashboardViewBootScript(): string {
  const kitSourceLiteral = pccUiKitSourceLiteral();
  // R4 PR2 — the registered typed-operation ids, server-authored. Injected onto
  // the window so the inlined kit offers ONLY these operations under host
  // lockdown; every other action stays inert (default-DENY on the client too).
  const operationsLiteral = JSON.stringify([...REGISTERED_OPERATION_IDS]);
  return `(function () {
  'use strict';
  var KIT_SOURCE = ${kitSourceLiteral};
  window.__PCC_HOST_OPERATIONS__ = ${operationsLiteral};
  var isValidDashboardManifest = ${isValidDashboardManifest.toString()};
  var extractToolResultManifest = ${extractToolResultManifest.toString()};
  var mountManifestIntoView = ${mountManifestIntoView.toString()};
  var connectMcpAppView = ${connectMcpAppView.toString()};
  var runDashboardViewBoot = ${runDashboardViewBoot.toString()};
  runDashboardViewBoot(window, KIT_SOURCE);
})();`;
}

/** The shared inlined-function preamble for the gallery (list) view. */
function galleryViewBootScript(): string {
  return `(function () {
  'use strict';
  var extractToolResultEntries = ${extractToolResultEntries.toString()};
  var renderGalleryIntoView = ${renderGalleryIntoView.toString()};
  var connectMcpAppView = ${connectMcpAppView.toString()};
  var runGalleryViewBoot = ${runGalleryViewBoot.toString()};
  runGalleryViewBoot(window);
})();`;
}

/**
 * The single-manifest MCP App view (render + saved). Holds a neutral "waiting
 * for the host" state and boots the kit only when a VALIDATED manifest arrives
 * over the standard `ui/notifications/tool-result` lifecycle notification.
 */
function buildMcpAppDashboardHtml(nonce: string = cspNonce()): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${buildMcpAppCsp(nonce)}">
<meta name="color-scheme" content="dark light">
<title>PCC Dashboard</title>
</head>
<body>
<main id="pcc-root">
  <p id="pcc-kit-status">Waiting for the host to hand off a dashboard&hellip;</p>
</main>
<script type="application/json" id="pcc-manifest">null</script>
<script nonce="${nonce}">
${dashboardViewBootScript()}
</script>
</body>
</html>`;
}

/**
 * The gallery (search results) MCP App view. Holds a neutral "waiting" state and
 * renders the list only when a VALIDATED entries array arrives over the standard
 * `ui/notifications/tool-result` lifecycle notification.
 */
function buildMcpAppGalleryHtml(nonce: string = cspNonce()): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${buildMcpAppCsp(nonce)}">
<meta name="color-scheme" content="dark light">
<title>PCC Dashboards</title>
<style>
#pcc-root{font:14px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:12px}
.pcc-gallery{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.pcc-gallery li{display:flex;flex-direction:column;gap:2px}
.pcc-gallery-title{font-weight:600}
.pcc-gallery-slug{opacity:.6;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
</style>
</head>
<body>
<main id="pcc-root">
  <p id="pcc-kit-status">Waiting for the host to hand off saved dashboards&hellip;</p>
</main>
<script nonce="${nonce}">
${galleryViewBootScript()}
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Per-slug SAVED-dashboard SHARE view — a self-contained MCP App document
// (manifest pre-inlined + kit inlined, boots immediately, no host handoff) plus
// the `ui://pcc/dashboard/{slug}` resource TEMPLATE that serves it. Public /
// unlisted sharing ONLY (directive 16).
// ---------------------------------------------------------------------------

/** Minimal HTML-text escape for the `<title>` / not-found copy. */
function escapeHtmlText(s: string): string {
  return s.split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;");
}

/** A self-contained MCP App document for one already-resolved public manifest:
 * the manifest is inlined (kit reads it synchronously on mount) and the kit is
 * injected via textContent. Renders the moment the host loads it (no handoff). */
function buildMcpAppDashboardHtmlForManifest(
  manifest: DashboardManifest,
  displayTitle: string,
  nonce: string = cspNonce(),
): string {
  const kitSourceLiteral = pccUiKitSourceLiteral();
  const withApiBase: DashboardManifest =
    manifest.api_base ? manifest : { ...manifest, api_base: MCP_APP_API_BASE_URL };
  const manifestJson = inlineJsonForScriptData(withApiBase);
  const title = escapeHtmlText(displayTitle);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${buildMcpAppCsp(nonce)}">
<meta name="color-scheme" content="dark light">
<title>${title} - PCC</title>
</head>
<body>
<main id="pcc-root">
  <p id="pcc-kit-status">Loading the PCC dashboard&hellip;</p>
</main>
<script type="application/json" id="pcc-manifest">${manifestJson}</script>
<script nonce="${nonce}">
(function () {
  'use strict';
  // Self-contained: the manifest is already inlined above, so announce the host
  // bridge and boot the kit immediately (no host handoff). textContent injection
  // keeps a literal "</script" in the kit source from terminating this element.
  // The kit <script> is injected by THIS nonce-trusted boot script, so it runs
  // under 'strict-dynamic' without needing its own nonce.
  window.__PCC_HOST__ = true;
  var KIT_SOURCE = ${kitSourceLiteral};
  var kit = document.createElement('script');
  kit.textContent = KIT_SOURCE;
  document.body.appendChild(kit);
})();
</script>
</body>
</html>`;
}

/** The MCP App document shown when a slug names no publicly-readable artifact
 * (missing, retired, private, or malformed) — a valid resource read, never a
 * thrown error, so the host renders a friendly page. */
function buildDashboardNotFoundHtml(slug: string, nonce: string = cspNonce()): string {
  const s = escapeHtmlText(slug);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${buildMcpAppCsp(nonce)}">
<title>Dashboard not found - PCC</title></head>
<body><main id="pcc-root"><h1>Dashboard not found</h1>
<p>No public dashboard exists at <code>${s}</code>, or it has been retired or is private.</p></main></body>
</html>`;
}

/** Resolve a saved public/unlisted artifact by slug to its self-contained MCP
 * App HTML (or the not-found page). Split out from the resource callback so it
 * is unit-testable against a seeded store without the MCP transport. */
export function renderSavedDashboardHtml(slug: string): string {
  const artifact = getPublicArtifactForRender(slug);
  if (!artifact) return buildDashboardNotFoundHtml(slug);
  const title = artifact.manifest.title || artifact.name || "PCC Dashboard";
  return buildMcpAppDashboardHtmlForManifest(artifact.manifest, title);
}

// ---------------------------------------------------------------------------
// Resource registration — render, saved, gallery (fixed) + the {slug} share
// template. All are registered on the McpServer so the `resources` capability is
// advertised in the initialize handshake, and each `resources/read` ships the
// full `_meta.ui.csp` (directive 3).
// ---------------------------------------------------------------------------

function uiResourceContents(uri: string, html: string) {
  return { contents: [{ uri, mimeType: MCP_APP_MIME_TYPE, text: html, _meta: mcpAppUiResourceMeta() }] };
}

/** Register the three fixed UI resources (render, saved, gallery) + the per-slug
 * public share template. One entry point so http-mcp-server wires them together. */
export function registerMcpAppResources(server: McpServer): void {
  server.registerResource(
    "pcc-dashboard-render",
    MCP_APP_RENDER_URI,
    {
      title: "PCC Dashboard (MCP App)",
      description:
        "Interactive MCP App view for render_pcc_dashboard. Renders the composed DashboardManifest " +
        "delivered in the tool result's structuredContent, using the shipped On-Ramp pcc-ui kit.",
      mimeType: MCP_APP_MIME_TYPE,
    },
    async () => uiResourceContents(MCP_APP_RENDER_URI, buildMcpAppDashboardHtml()),
  );

  server.registerResource(
    "pcc-dashboard-saved",
    MCP_APP_SAVED_URI,
    {
      title: "PCC saved dashboard (MCP App)",
      description:
        "MCP App view for save/get/fork/update_dashboard. Renders the artifact's DashboardManifest " +
        "delivered in the AUTHENTICATED tool result's structuredContent (never a second anonymous lookup).",
      mimeType: MCP_APP_MIME_TYPE,
    },
    async () => uiResourceContents(MCP_APP_SAVED_URI, buildMcpAppDashboardHtml()),
  );

  server.registerResource(
    "pcc-dashboard-gallery",
    MCP_APP_GALLERY_URI,
    {
      title: "PCC dashboard gallery (MCP App)",
      description:
        "MCP App view for search_dashboards. Renders the list of matching dashboards delivered in the " +
        "tool result's structuredContent.",
      mimeType: MCP_APP_MIME_TYPE,
    },
    async () => uiResourceContents(MCP_APP_GALLERY_URI, buildMcpAppGalleryHtml()),
  );

  // Optional public/unlisted SHARE template — self-contained, boots immediately,
  // reached only via an out-of-band `ui://pcc/dashboard/<slug>` (never on a tool
  // descriptor/result). `list` is undefined: the server does not enumerate the
  // whole public artifact set on resources/list.
  server.registerResource(
    "pcc-dashboard-share",
    new ResourceTemplate(MCP_APP_DASHBOARD_TEMPLATE_URI, { list: undefined }),
    {
      title: "PCC shared dashboard (MCP App)",
      description:
        "Renders a PUBLIC or UNLISTED saved On-Ramp dashboard by slug as a self-contained MCP App view. " +
        "Sharing surface only — private dashboards are never exposed here.",
      mimeType: MCP_APP_MIME_TYPE,
    },
    async (uri, variables, extra) => {
      const raw = variables.slug;
      const slug = Array.isArray(raw) ? raw[0] : raw;
      const slugStr = typeof slug === "string" ? slug : String(slug ?? "");
      // Anti-enumeration rate limit (directive 13). There is no per-caller IP at
      // the MCP resource layer — key on the host session id when present, else a
      // shared bucket. A throttled caller gets the SAME not-found view (no
      // existence oracle) and no store lookup.
      const sessionId =
        extra && typeof extra === "object" && extra !== null && "sessionId" in extra
          ? String((extra as { sessionId?: unknown }).sessionId ?? "")
          : "";
      const rateKey = "mcp:" + (sessionId || "anon");
      if (publicLookupThrottled(rateKey)) {
        return uiResourceContents(uri.toString(), buildDashboardNotFoundHtml(slugStr));
      }
      const artifact = slugStr.length ? getPublicArtifactForRender(slugStr) : undefined;
      if (!artifact) {
        // Missing / retired / private ALL collapse to the SAME not-found view —
        // the response never reveals whether a private artifact exists.
        notePublicLookupFailure(rateKey);
        return uiResourceContents(uri.toString(), buildDashboardNotFoundHtml(slugStr));
      }
      const title = artifact.manifest.title || artifact.name || "PCC Dashboard";
      return uiResourceContents(
        uri.toString(),
        buildMcpAppDashboardHtmlForManifest(artifact.manifest, title),
      );
    },
  );
}

// ---------------------------------------------------------------------------
// outputSchema for every structuredContent-bearing tool (directive 7). Each is
// a JSON Schema with `additionalProperties: false` at the wrapper; returned
// structuredContent MUST conform (enrichOnRampToolResult guarantees it).
// ---------------------------------------------------------------------------

export const RENDER_OUTPUT_SCHEMA = {
  type: "object",
  properties: { manifest: { type: "object" } },
  required: ["manifest"],
  additionalProperties: false,
};

export const SAVED_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    manifest: { type: "object" },
    slug: { type: "string" },
    name: { type: "string" },
  },
  required: ["manifest"],
  additionalProperties: false,
};

export const GALLERY_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          slug: { type: "string" },
          name: { type: "string" },
          title: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    total: { type: "number" },
  },
  required: ["entries"],
  additionalProperties: false,
};

/** The outputSchema a UI-bearing On-Ramp tool declares. */
export function onRampToolOutputSchema(toolName: string): Record<string, unknown> {
  return toolName === "search_dashboards" ? GALLERY_OUTPUT_SCHEMA : SAVED_OUTPUT_SCHEMA;
}

/**
 * Minimal structural conformance check of a structuredContent value against one
 * of the outputSchema shapes above (top-level `required` present + no keys
 * outside `properties` when `additionalProperties:false`). Exported for the
 * runtime guard below and for tests. Not a full JSON-Schema validator — it
 * covers exactly the wrapper-level guarantees the directive requires.
 */
export function structuredContentConformsTo(
  outputSchema: Record<string, unknown>,
  value: unknown,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  const required = Array.isArray(outputSchema.required) ? (outputSchema.required as string[]) : [];
  for (const key of required) {
    if (!(key in obj)) return false;
  }
  if (outputSchema.additionalProperties === false) {
    const props = (outputSchema.properties as Record<string, unknown> | undefined) ?? {};
    for (const key of Object.keys(obj)) {
      if (!(key in props)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// CallTool result enrichment for the 5 On-Ramp UI tools — attaches the tool's
// data as `structuredContent` (which the fixed saved/gallery view renders over
// the lifecycle), plus the canonical `_meta.ui.resourceUri` matching the tool
// descriptor. The ORIGINAL text content is preserved so text-only consumers are
// unaffected. Private artifacts render from THIS authenticated result — never a
// second anonymous lookup (directive 5/15).
// ---------------------------------------------------------------------------

function asObject(payload: unknown): Record<string, unknown> | undefined {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
}

function stringField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = obj?.[key];
  return typeof v === "string" && v.length ? v : undefined;
}

/** Project one search entry (a full UiArtifact) to the compact {slug,name,title}
 * shape the gallery outputSchema declares. */
function projectGalleryEntry(entry: unknown): { slug?: string; name?: string; title?: string } | undefined {
  const o = asObject(entry);
  if (!o) return undefined;
  const out: { slug?: string; name?: string; title?: string } = {};
  const slug = stringField(o, "slug");
  const name = stringField(o, "name");
  const title = stringField(asObject(o.manifest), "title") ?? name;
  if (slug) out.slug = slug;
  if (name) out.name = name;
  if (title) out.title = title;
  return Object.keys(out).length ? out : undefined;
}

/**
 * Enrich an On-Ramp tool result. `payload` is the parsed upstream JSON (a
 * UiArtifact for save/get/fork/update; `{ entries, ... }` for search). Returns a
 * CallToolResult carrying the original text PLUS `structuredContent` conforming
 * to the tool's outputSchema, and the canonical `_meta.ui.resourceUri`. If no
 * renderable data is present (e.g. an upstream error passthrough), the result is
 * text-only (no UI, no structuredContent) — a valid MCP result.
 */
export function enrichOnRampToolResult(
  toolName: string,
  payload: unknown,
  text: string,
): CallToolResult {
  const textItem = { type: "text" as const, text };

  if (toolName === "search_dashboards") {
    const obj = asObject(payload);
    const rawEntries = Array.isArray(obj?.entries) ? (obj!.entries as unknown[]) : [];
    const entries = rawEntries
      .map(projectGalleryEntry)
      .filter((e): e is { slug?: string; name?: string; title?: string } => e !== undefined);
    const total = typeof obj?.total === "number" ? (obj.total as number) : entries.length;
    const structuredContent = { entries, total };
    if (!structuredContentConformsTo(GALLERY_OUTPUT_SCHEMA, structuredContent)) {
      return { content: [textItem] };
    }
    return { _meta: onRampToolUiMeta(toolName), structuredContent, content: [textItem] };
  }

  const obj = asObject(payload);
  const manifest = asObject(obj?.manifest);
  if (!manifest) {
    // No renderable manifest (e.g. an upstream error/passthrough) → text-only.
    return { content: [textItem] };
  }
  const structuredContent: Record<string, unknown> = { manifest };
  const slug = stringField(obj, "slug");
  if (slug) structuredContent.slug = slug;
  const name = stringField(obj, "name");
  if (name) structuredContent.name = name;
  if (!structuredContentConformsTo(SAVED_OUTPUT_SCHEMA, structuredContent)) {
    return { content: [textItem] };
  }
  return { _meta: onRampToolUiMeta(toolName), structuredContent, content: [textItem] };
}

// ---------------------------------------------------------------------------
// Plain HTTP mirror of the render view. The MCP `resources/read` path is served
// over the /mcp JSON-RPC transport (which hijacks the raw HTTP response, so no
// Fastify onSend hooks run there — it carries the CSP only via <meta>). This
// route serves the IDENTICAL render document with a REAL Content-Security-Policy
// header, for any consumer that fetches the view directly instead of over MCP.
// ---------------------------------------------------------------------------

export function registerMcpAppHttpRoute(app: FastifyInstance): void {
  app.get(HTTP_MIRROR_PATH, async (_request, reply) => {
    // One nonce per response, shared by the served HTML's inline <script nonce>
    // and this REAL Content-Security-Policy header (directive 12). Because the
    // mirror is fetched by a browser directly, the HEADER — not the <meta> — is
    // the authoritative policy: nonce + 'strict-dynamic' means the boot script is
    // trusted and may inject the kit <script>, with NO unsafe-inline / unsafe-eval
    // for scripts. `frame-ancestors` is meaningful in a header (it is ignored in a
    // <meta>), so the embed allowlist lives HERE.
    const nonce = cspNonce();
    reply.header(
      "Content-Security-Policy",
      `${buildMcpAppCsp(nonce)}; frame-ancestors ${MCP_APP_FRAME_ANCESTORS}`,
    );
    // X-Frame-Options is intentionally NOT set: it is superseded by the CSP
    // frame-ancestors allowlist above, and an XFO of DENY/SAMEORIGIN would break
    // the required host framing. Strip any XFO a global hook may have added.
    reply.removeHeader("X-Frame-Options");
    // `Access-Control-Allow-Origin: *` removed — this view is host-embedded or
    // same-origin fetched, not a cross-origin-readable API; the wildcard was
    // unnecessary exposure.
    return reply.type("text/html; charset=utf-8").send(buildMcpAppDashboardHtml(nonce));
  });
}

// ---------------------------------------------------------------------------
// render_pcc_dashboard — the UI-composition tool. inputSchema reuses the
// EXISTING manifest.schema.json; the handler validates with the SAME Zod schema
// the gateway's artifact routes use, and returns the manifest in structuredContent
// (conforming to RENDER_OUTPUT_SCHEMA) for the fixed render view.
// ---------------------------------------------------------------------------

export function buildRenderDashboardTool(): Tool {
  return {
    name: RENDER_DASHBOARD_TOOL_NAME,
    description:
      "Compose a live PCC dashboard for a physical-capability task — pass a DashboardManifest " +
      "(windows + live data bindings + actions) and it renders as an interactive MCP App.",
    inputSchema: readDashboardManifestJsonSchema() as unknown as Tool["inputSchema"],
    outputSchema: RENDER_OUTPUT_SCHEMA as unknown as Tool["outputSchema"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    // MCP Apps convention: a tool that RENDERS a ui:// resource declares the
    // FIXED link on the tools/list definition itself, so a host/scanner reading
    // tools/list can tell up front that this tool has a UI (no {slug} template).
    _meta: { ui: { resourceUri: MCP_APP_RENDER_URI } },
  };
}

function toolErrorResult(text: string) {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

/**
 * Handler for render_pcc_dashboard. Arguments ARE the DashboardManifest directly
 * (no wrapper). Validation failures return an MCP tool-result error (never
 * throw). On success, returns the manifest in `structuredContent` (conforming to
 * RENDER_OUTPUT_SCHEMA) — the host delivers it to the fixed render view over the
 * `ui/notifications/tool-result` lifecycle notification.
 */
export function handleRenderDashboardTool(rawArguments: unknown) {
  const parsed = DashboardManifestSchema.safeParse(rawArguments);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map((e) => `${e.path.length ? e.path.join(".") : "(root)"}: ${e.message}`)
      .join("; ");
    return toolErrorResult(`Invalid DashboardManifest — ${detail}`);
  }

  const manifest = parsed.data;
  // DashboardManifestSchema's own .refine already rejects pcc_live_/pcc_test_
  // substrings; kept explicit as defense-in-depth (matches routes/artifacts.ts).
  if (containsApiKey(manifest)) {
    return toolErrorResult(
      "Refused: the manifest must not contain an API key (pcc_live_/pcc_test_ substring) — it would travel with the rendered dashboard.",
    );
  }

  const sectionCount = manifest.sections.length;
  return {
    _meta: { ui: { resourceUri: MCP_APP_RENDER_URI } },
    structuredContent: { manifest },
    content: [
      {
        type: "text" as const,
        text: `Rendered a PCC dashboard: ${manifest.title} — ${sectionCount} section${sectionCount === 1 ? "" : "s"}.`,
      },
    ],
  };
}
