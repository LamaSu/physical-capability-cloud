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
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { DashboardManifestSchema, containsApiKey } from "@pcc/spec";

// ---------------------------------------------------------------------------
// Constants — URIs, MIME, and the CSP shared by BOTH the MCP resource read
// (JSON-RPC over /mcp — that transport hijacks the raw HTTP reply, so no
// Fastify headers apply there; the CSP travels only via <meta http-equiv>)
// and the plain HTTP mirror route below (which DOES carry a real header).
// ---------------------------------------------------------------------------

export const MCP_APP_DASHBOARD_URI = "ui://pcc/dashboard";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
export const RENDER_DASHBOARD_TOOL_NAME = "render_pcc_dashboard";

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

function resolveGatewayAsset(relativeSegments: string[], envVarOverride?: string): string {
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

function buildMcpAppDashboardHtml(): string {
  const kitSource = readPccUiKitSource();
  // JSON.stringify safely escapes backslash/quote/control-chars/unicode for
  // embedding as a JS string literal; the extra replace guards the ONE thing
  // it does not escape — a literal "</script" substring, which would
  // otherwise prematurely terminate OUR <script> element when this page's
  // HTML is tokenized (pcc-ui.js itself contains no such substring today;
  // this is defensive for future edits to that file).
  const kitSourceLiteral = JSON.stringify(kitSource).replace(/<\/script/gi, "<\\/script");

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
