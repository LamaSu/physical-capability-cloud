/**
 * MCP Apps bridge — the ONE unbuilt transport for PCC's shipped On-Ramp
 * generative-UI kit (see apps/dashboard/public/ui-kit/v1/pcc-ui.js).
 *
 * PCC's LLM-authored `DashboardManifest` + the pcc-ui kit already render live
 * dashboards over four transports (gateway shell, standalone shell, inlined
 * artifact export, and now this one). This module exposes the SAME kit as an
 * MCP App (Anthropic MCP Apps convention: `ui://` resources,
 * `_meta.ui.resourceUri` on tool results, a strict per-view CSP) so a host
 * that calls the PCC MCP server's `render_pcc_dashboard` tool can render the
 * composed dashboard inline in the conversation (Claude Desktop / ChatGPT
 * Apps), instead of only returning text.
 *
 * This is a BRIDGE, not a new renderer: the view resource below inlines the
 * EXISTING pcc-ui.js kit unmodified (this file only reads it from disk and
 * wraps it in an MCP-Apps-shaped HTML document), the tool validates against
 * the EXISTING `DashboardManifestSchema`, and nothing here touches
 * settlement/escrow/auth.
 *
 * Host->view handoff assumption (documented — the exact MCP-Apps host<->view
 * postMessage envelope is not yet uniformly standardized across hosts as of
 * this SDK version): the view's boot script listens broadly on `window`
 * "message" events for a `manifest` field (optionally nested under
 * `toolOutput` / `structuredContent` / `payload`), matching the
 * `structuredContent: { manifest }` shape `handleRenderDashboardTool` below
 * returns, plus a couple of reasonably-named alternate envelopes for
 * interoperability with different host implementations. See
 * buildMcpAppDashboardHtml()'s inline boot script for the exact logic.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { DashboardManifestSchema, containsApiKey, type DashboardManifest } from "@pcc/spec";
import { getPublicArtifactForRender } from "../routes/artifacts.js";

// ---------------------------------------------------------------------------
// Constants — URIs, MIME, and the CSP shared by BOTH the MCP resource read
// (JSON-RPC over /mcp — that transport hijacks the raw HTTP reply, so no
// Fastify headers apply there; the CSP travels only via <meta http-equiv>)
// and the plain HTTP mirror route below (which DOES carry a real header).
// ---------------------------------------------------------------------------

export const MCP_APP_DASHBOARD_URI = "ui://pcc/dashboard";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
export const RENDER_DASHBOARD_TOOL_NAME = "render_pcc_dashboard";

/** Resource TEMPLATE for a SAVED dashboard artifact, keyed by its slug. Distinct
 * from the static MCP_APP_DASHBOARD_URI above (the transient host-handoff view for
 * render_pcc_dashboard): this one renders a persisted on-ramp artifact. The SDK
 * advertises it via `resources/templates/list` and matches a concrete
 * `ui://pcc/dashboard/<slug>` read against it, handing the read callback `{slug}`. */
export const MCP_APP_DASHBOARD_TEMPLATE_URI = "ui://pcc/dashboard/{slug}";

/** Live gateway origin baked into a self-contained (host-iframe) view's manifest
 * so the kit's live-data bindings resolve to the network instead of the opaque
 * host origin. Mirrors http-mcp-server.ts's PCC_API_BASE_URL. */
const MCP_APP_API_BASE_URL = "https://capability.network";

/** The 5 On-Ramp dashboard tools (from agent-package.json) that carry a UI:
 * save/get/fork/update return one artifact; search returns a list. Their MCP
 * tool definitions get `_meta.ui.resourceUri` = the template, and their CallTool
 * results get a resource_link to the concrete `ui://pcc/dashboard/<slug>`. */
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

/** The concrete `ui://` resource URI for one saved dashboard slug. Slugs are
 * minted `[a-z0-9-]` (routes/artifacts.ts slugify), so no escaping is needed. */
export function dashboardResourceUriForSlug(slug: string): string {
  return `ui://pcc/dashboard/${slug}`;
}

/** The `_meta` block a UI-bearing tool carries on tools/list — points a host at
 * the dashboard template so it knows the tool renders UI before ever calling it. */
export function onRampToolUiMeta(): { ui: { resourceUri: string } } {
  return { ui: { resourceUri: MCP_APP_DASHBOARD_TEMPLATE_URI } };
}

/** Anthropic MCP Apps view CSP. No `*` anywhere — every directive names the
 * specific origins the view is allowed to talk to / be framed by. */
export const MCP_APP_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self' https://capability.network; " +
  "form-action 'self' https://capability.network; frame-ancestors https://chatgpt.com https://claude.ai";

const HTTP_MIRROR_PATH = "/mcp-apps/ui/dashboard";

// ---------------------------------------------------------------------------
// Asset resolution — mirrors http-mcp-server.ts's resolveAgentPackagePath()
// candidate-path search (compiled dist/, tsx-run src/, or cwd-relative),
// generalized here so it can also locate pcc-ui.js + manifest.schema.json,
// both of which live under apps/dashboard/public (outside this package).
// ---------------------------------------------------------------------------

/** Exported so other MCP surfaces (e.g. docs-mcp-server.ts) that also need to
 * locate a repo-root-relative asset from either compiled dist/ or tsx-run
 * src/ don't have to re-derive this candidate-path search a third time. */
export function resolveGatewayAsset(relativeSegments: string[], envVarOverride?: string): string {
  const override = envVarOverride ? process.env[envVarOverride] : undefined;
  if (override && existsSync(override)) return resolvePath(override);

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

/** Read pcc-ui.js fresh on every call — same "discovery follows updates"
 * choice loadAgentPackage() makes; the kit is small and this is not a hot
 * path (an MCP resource is fetched once per conversation, not per request). */
function readPccUiKitSource(): string {
  return readFileSync(resolveGatewayAsset(PCC_UI_KIT_RELATIVE, "PCC_UI_KIT_PATH"), "utf8");
}

function readDashboardManifestJsonSchema(): Record<string, unknown> {
  const raw = readFileSync(
    resolveGatewayAsset(DASHBOARD_MANIFEST_SCHEMA_RELATIVE, "PCC_DASHBOARD_SCHEMA_PATH"),
    "utf8",
  );
  return JSON.parse(raw) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The MCP App view — self-contained HTML: inlines pcc-ui.js, sets
// window.__PCC_HOST__ BEFORE the kit ever runs, and defers actually booting
// the kit until a DashboardManifest arrives from the host (see the module
// doc comment's host->view handoff assumption). Shared verbatim by the MCP
// `resources/read` handler and the plain HTTP mirror route.
// ---------------------------------------------------------------------------

/** pcc-ui.js source as a safe JS string literal for inline embedding.
 * JSON.stringify escapes backslash/quote/control-chars/unicode; the extra
 * replace guards the ONE thing it does not — a literal "</script" substring,
 * which would otherwise prematurely terminate the embedding <script> element
 * when the page's HTML is tokenized (pcc-ui.js contains no such substring
 * today; this is defensive for future edits). Shared by both the host-handoff
 * view and the self-contained per-slug view below. */
function pccUiKitSourceLiteral(): string {
  return JSON.stringify(readPccUiKitSource()).replace(/<\/script/gi, "<\\/script");
}

/** Escape a JSON string for safe placement inside a `<script type="application/json">`
 * data block — only `<`/`>` need neutralizing (mirrors routes/artifacts.ts's
 * inlineManifestJson). U+2028/U+2029 are harmless in a non-executable block. */
function inlineJsonForScriptData(value: unknown): string {
  return JSON.stringify(value).split("<").join("\\u003c").split(">").join("\\u003e");
}

function buildMcpAppDashboardHtml(): string {
  const kitSourceLiteral = pccUiKitSourceLiteral();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${MCP_APP_CSP}">
<meta name="color-scheme" content="dark light">
<title>PCC Dashboard</title>
</head>
<body>
<main id="pcc-root">
  <p id="pcc-kit-status">Waiting for the host to hand off a dashboard&hellip;</p>
</main>
<script type="application/json" id="pcc-manifest">null</script>
<script>
(function () {
  'use strict';
  // Tier D: announce the host bridge BEFORE the kit ever runs, so
  // pcc-ui.js's detectMode() resolves to 'host' the instant it boots.
  window.__PCC_HOST__ = true;

  var KIT_SOURCE = ${kitSourceLiteral};
  var booted = false;

  function escapeForScriptData(s) {
    return s.split('<').join('\\u003c').split('>').join('\\u003e');
  }

  function bootWithManifest(manifest, snapshot, apiBase, token) {
    if (booted || !manifest) return;
    booted = true;
    var m = (apiBase && !manifest.api_base) ? Object.assign({}, manifest, { api_base: apiBase }) : manifest;
    var manifestNode = document.getElementById('pcc-manifest');
    if (manifestNode) manifestNode.textContent = escapeForScriptData(JSON.stringify(m));
    if (snapshot) {
      var snapNode = document.createElement('script');
      snapNode.type = 'application/json';
      snapNode.id = 'pcc-snapshot';
      snapNode.textContent = escapeForScriptData(JSON.stringify(snapshot));
      document.body.appendChild(snapNode);
    }
    if (token) {
      try { sessionStorage.setItem('pcc.key', String(token)); } catch (e) {}
    }
    // Inject the kit LAST, only once the manifest is in place — pcc-ui.js
    // mounts synchronously against #pcc-manifest the moment it executes.
    var kit = document.createElement('script');
    kit.textContent = KIT_SOURCE;
    document.body.appendChild(kit);
  }

  // Accept a DashboardManifest handed over by the embedding host. The exact
  // MCP-Apps host->view postMessage envelope is not yet uniformly
  // standardized across hosts as of this kit version, so this looks for a
  // "manifest" field either at the top level or nested under a few
  // reasonably-named wrappers (toolOutput / structuredContent / payload),
  // matching the { structuredContent: { manifest } } shape the
  // render_pcc_dashboard tool result carries.
  function extractHandoff(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.manifest) return data;
    var nested = data.toolOutput || data.structuredContent ||
      (data.payload && (data.payload.toolOutput || data.payload.structuredContent)) ||
      data.payload;
    if (nested && nested.manifest) {
      return {
        manifest: nested.manifest,
        snapshot: nested.snapshot || data.snapshot,
        apiBase: nested.apiBase || data.apiBase,
        token: nested.token || data.token
      };
    }
    return null;
  }

  window.addEventListener('message', function (event) {
    var handoff = extractHandoff(event && event.data);
    if (!handoff) return;
    bootWithManifest(handoff.manifest, handoff.snapshot, handoff.apiBase, handoff.token);
  });

  // Announce readiness to the embedding host — the MCP-UI / Apps-SDK
  // convention of the view signalling it is ready to receive the tool's
  // structured output over postMessage.
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'ui-lifecycle-iframe-ready' }, '*');
    }
  } catch (e) {}
})();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// resources/list + resources/read — registered on the McpServer so the
// `resources` capability is advertised in the initialize handshake.
// ---------------------------------------------------------------------------

export function registerMcpAppResource(server: McpServer): void {
  server.registerResource(
    "pcc-dashboard",
    MCP_APP_DASHBOARD_URI,
    {
      title: "PCC Dashboard (MCP App)",
      description:
        "Interactive MCP App view for render_pcc_dashboard. Renders a DashboardManifest as a live " +
        "PCC dashboard using the shipped On-Ramp pcc-ui kit.",
      mimeType: MCP_APP_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: MCP_APP_DASHBOARD_URI,
          mimeType: MCP_APP_MIME_TYPE,
          text: buildMcpAppDashboardHtml(),
        },
      ],
    }),
  );
}

// ---------------------------------------------------------------------------
// Per-slug SAVED-dashboard view — a self-contained MCP App document (manifest
// pre-inlined + kit inlined, boots immediately, no host handoff) plus the
// `ui://pcc/dashboard/{slug}` resource TEMPLATE that serves it. This is the
// artifact-backed complement to the transient render_pcc_dashboard view above.
// ---------------------------------------------------------------------------

/** Minimal HTML-text escape for the `<title>` / not-found copy. */
function escapeHtmlText(s: string): string {
  return s.split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;");
}

/** A self-contained MCP App document for one already-resolved manifest: the
 * manifest is inlined (kit reads it synchronously on mount) and the kit is
 * injected via textContent so a literal "</script" in it can't break parsing.
 * Unlike buildMcpAppDashboardHtml() this needs NO host handoff — it renders the
 * moment the host loads it. The live gateway origin is baked into api_base so
 * bindings resolve from the host iframe's opaque origin. */
function buildMcpAppDashboardHtmlForManifest(manifest: DashboardManifest, displayTitle: string): string {
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
<meta http-equiv="Content-Security-Policy" content="${MCP_APP_CSP}">
<meta name="color-scheme" content="dark light">
<title>${title} - PCC</title>
</head>
<body>
<main id="pcc-root">
  <p id="pcc-kit-status">Loading the PCC dashboard&hellip;</p>
</main>
<script type="application/json" id="pcc-manifest">${manifestJson}</script>
<script>
(function () {
  'use strict';
  // Self-contained: the manifest is already inlined above, so boot the kit
  // immediately (no host handoff). textContent injection keeps a literal
  // "</script" in the kit source from terminating this element.
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
 * (missing, retired, or private) — a valid resource read, never a thrown error,
 * so the host renders a friendly page rather than a protocol failure. */
function buildDashboardNotFoundHtml(slug: string): string {
  const s = escapeHtmlText(slug);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${MCP_APP_CSP}">
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

/** Register the `ui://pcc/dashboard/{slug}` resource TEMPLATE. The SDK advertises
 * it via resources/templates/list and routes a concrete `ui://pcc/dashboard/<slug>`
 * read here with the resolved `{slug}`. `list` is undefined on purpose: the MCP
 * server is an origin-locked proxy and does not enumerate the whole public
 * artifact set on every resources/list — hosts reach a specific view through the
 * resource_link carried on the on-ramp tool results. */
export function registerMcpAppDashboardSlugResource(server: McpServer): void {
  server.registerResource(
    "pcc-dashboard-by-slug",
    new ResourceTemplate(MCP_APP_DASHBOARD_TEMPLATE_URI, { list: undefined }),
    {
      title: "PCC saved dashboard (MCP App)",
      description:
        "Renders a SAVED On-Ramp dashboard artifact by slug as a live MCP App view (the " +
        "shipped pcc-ui kit). The concrete ui://pcc/dashboard/<slug> is carried on the " +
        "save_dashboard / get_dashboard / fork_dashboard / update_dashboard tool results.",
      mimeType: MCP_APP_MIME_TYPE,
    },
    async (uri, variables) => {
      const raw = variables.slug;
      const slug = Array.isArray(raw) ? raw[0] : raw;
      const html =
        typeof slug === "string" && slug.length
          ? renderSavedDashboardHtml(slug)
          : buildDashboardNotFoundHtml(String(slug ?? ""));
      return {
        contents: [{ uri: uri.toString(), mimeType: MCP_APP_MIME_TYPE, text: html }],
      };
    },
  );
}

// ---------------------------------------------------------------------------
// CallTool result enrichment for the 5 On-Ramp UI tools — adds an MCP-Apps
// resource_link (and, for the single-artifact tools, `_meta.ui.resourceUri`)
// to the SAME result IN ADDITION to the existing text content, so text-only
// consumers are unaffected and MCP-Apps hosts gain a renderable view.
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

function resourceLinkForSlug(slug: string, name?: string) {
  return {
    type: "resource_link" as const,
    uri: dashboardResourceUriForSlug(slug),
    name: `pcc-dashboard-${slug}`,
    title: name ?? "PCC dashboard",
    mimeType: MCP_APP_MIME_TYPE,
    description: "Open this saved PCC dashboard as a live MCP App view.",
  };
}

/**
 * Enrich an On-Ramp tool result. `payload` is the parsed upstream JSON (an
 * artifact for save/get/fork/update; `{ entries, ... }` for search). Returns a
 * CallToolResult carrying the original text PLUS resource_link(s); the four
 * single-artifact tools additionally set `_meta.ui.resourceUri` to the concrete
 * saved-dashboard view. If no slug can be found the result is text-only.
 */
export function enrichOnRampToolResult(
  toolName: string,
  payload: unknown,
  text: string,
): CallToolResult {
  const textItem = { type: "text" as const, text };

  if (toolName === "search_dashboards") {
    const entries = Array.isArray(asObject(payload)?.entries)
      ? (asObject(payload)!.entries as unknown[])
      : [];
    const links = entries
      .map((e) => {
        const obj = asObject(e);
        const slug = stringField(obj, "slug");
        return slug ? resourceLinkForSlug(slug, stringField(obj, "name")) : undefined;
      })
      .filter((x): x is ReturnType<typeof resourceLinkForSlug> => x !== undefined);
    return { content: [textItem, ...links] };
  }

  const obj = asObject(payload);
  const slug = stringField(obj, "slug");
  if (!slug) return { content: [textItem] };
  return {
    _meta: { ui: { resourceUri: dashboardResourceUriForSlug(slug) } },
    content: [textItem, resourceLinkForSlug(slug, stringField(obj, "name"))],
  };
}

// ---------------------------------------------------------------------------
// Plain HTTP mirror of the SAME view. The MCP `resources/read` path above is
// served over the /mcp JSON-RPC transport, which hijacks the raw HTTP
// response (no Fastify onSend hooks run there) — so it carries the CSP only
// via the <meta http-equiv> tag baked into the HTML. This route serves the
// IDENTICAL document with a REAL "Content-Security-Policy" HTTP header, for
// any consumer that fetches the view directly instead of over MCP. The
// gateway's site-wide default CSP (frame-ancestors 'none') and
// X-Frame-Options: DENY — set by security-hardening.ts's onSend hook — would
// otherwise forbid embedding this view in the Claude/ChatGPT hosts; the
// route-level onSend hook here runs AFTER that app-level hook (Fastify
// always runs route-level hooks after application-level ones) and overrides
// both, for this one public, self-contained view only.
// ---------------------------------------------------------------------------

export function registerMcpAppHttpRoute(app: FastifyInstance): void {
  app.get(
    HTTP_MIRROR_PATH,
    {
      onSend: async (_request, reply, payload) => {
        reply.header("Content-Security-Policy", MCP_APP_CSP);
        reply.removeHeader("X-Frame-Options");
        reply.header("access-control-allow-origin", "*");
        return payload;
      },
    },
    async (_request, reply) => {
      return reply.type("text/html; charset=utf-8").send(buildMcpAppDashboardHtml());
    },
  );
}

// ---------------------------------------------------------------------------
// render_pcc_dashboard — the UI-composition tool. inputSchema reuses the
// EXISTING manifest.schema.json (the JSON-Schema mirror of
// DashboardManifestSchema) verbatim; the handler validates with the SAME
// Zod schema the gateway's artifact routes already use.
// ---------------------------------------------------------------------------

export function buildRenderDashboardTool(): Tool {
  return {
    name: RENDER_DASHBOARD_TOOL_NAME,
    description:
      "Compose a live PCC dashboard for a physical-capability task — pass a DashboardManifest " +
      "(windows + live data bindings + actions) and it renders as an interactive MCP App.",
    inputSchema: readDashboardManifestJsonSchema() as unknown as Tool["inputSchema"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    // MCP Apps convention: a tool that RENDERS a ui:// resource declares the
    // link on the tools/list definition itself, not only on the call result
    // (handleRenderDashboardTool already returns the same _meta below) — a
    // host/scanner reading tools/list should be able to tell up front that
    // this tool has a UI without first calling it. The SDK's Tool._meta is
    // typed Record<string, unknown>, so this needs no schema workaround.
    _meta: { ui: { resourceUri: MCP_APP_DASHBOARD_URI } },
  };
}

function toolErrorResult(text: string) {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

/**
 * Handler for render_pcc_dashboard. Arguments ARE the DashboardManifest
 * directly (no wrapper) — the manifest is the whole UI-composition surface
 * the agent authors. Validation failures return an MCP tool-result error
 * (isError: true content) and never throw — a malformed manifest is the
 * agent's mistake to see and fix, not a protocol-level failure.
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
  // substrings (so this branch is effectively unreachable via THIS schema
  // today) — kept explicit per spec, and as defense-in-depth against a
  // future schema change, matching the same belt-and-suspenders pattern
  // routes/artifacts.ts uses for the identical guard.
  if (containsApiKey(manifest)) {
    return toolErrorResult(
      "Refused: the manifest must not contain an API key (pcc_live_/pcc_test_ substring) — it would travel with the rendered dashboard.",
    );
  }

  const sectionCount = manifest.sections.length;
  return {
    _meta: { ui: { resourceUri: MCP_APP_DASHBOARD_URI } },
    structuredContent: { manifest },
    content: [
      {
        type: "text" as const,
        text: `Rendered a PCC dashboard: ${manifest.title} — ${sectionCount} section${sectionCount === 1 ? "" : "s"}.`,
      },
    ],
  };
}
