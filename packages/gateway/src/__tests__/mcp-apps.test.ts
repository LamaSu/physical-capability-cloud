/**
 * MCP Apps bridge — per-slug SAVED-dashboard view (feat/mcp-apps-bridge).
 *
 * Complements http-mcp.test.ts (which already covers the transient
 * render_pcc_dashboard tool + the static ui://pcc/dashboard resource). This
 * file exercises the artifact-backed additions:
 *   - the 5 On-Ramp dashboard tools carry `_meta.ui.resourceUri` on tools/list,
 *   - the ui://pcc/dashboard/{slug} resource TEMPLATE is advertised, and
 *   - reading ui://pcc/dashboard/<slug> returns the shipped-kit shell HTML for a
 *     saved public artifact (and a graceful not-found page otherwise),
 *   - enrichOnRampToolResult attaches a resource_link (+ _meta for the single-
 *     artifact tools) IN ADDITION to the existing text content.
 *
 * Network-free: the artifact is seeded straight into the same in-memory store
 * the MCP resource read consults (both go through routes/artifacts.ts's db()).
 */

import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DASHBOARD_CSD_URL, type UiArtifact } from "@pcc/spec";
import { httpMcpRoutes } from "../mcp/http-mcp-server.js";
import { _clearArtifactsForTests, _seedArtifactForTests } from "../routes/artifacts.js";
import {
  dashboardResourceUriForSlug,
  enrichOnRampToolResult,
  MCP_APP_DASHBOARD_TEMPLATE_URI,
  ON_RAMP_UI_TOOL_NAMES,
  renderSavedDashboardHtml,
} from "../mcp/mcp-app-view.js";

const SEEDED_SLUG = "watch-my-pizza-8k3f";
const SEEDED_TITLE = "Watch my pizza + courier";

function seedPublicDashboard(slug: string, title: string, visibility: UiArtifact["visibility"] = "public"): void {
  const now = new Date().toISOString();
  _seedArtifactForTests({
    id: `ua_${slug}`,
    slug,
    csd: DASHBOARD_CSD_URL,
    name: title,
    manifest: {
      csd: DASHBOARD_CSD_URL,
      title,
      sections: [{ windows: [{ kind: "note", text: "Your pizza is in the oven." }] }],
    },
    capabilityTypes: ["pizza.order"],
    visibility,
    owner: "op_test",
    useCount: 0,
    loadCount: 0,
    forkCount: 0,
    status: "active",
    createdAt: now,
    updatedAt: now,
    version: 1,
  } as UiArtifact);
}

// ---------------------------------------------------------------------------
// Pure-function coverage (no transport) — the enrichment + slug render logic.
// ---------------------------------------------------------------------------

describe("MCP Apps — enrichOnRampToolResult", () => {
  it("attaches _meta + a resource_link to a single-artifact result (save/get/fork/update)", () => {
    const payload = { slug: SEEDED_SLUG, name: SEEDED_TITLE, id: `ua_${SEEDED_SLUG}` };
    const result = enrichOnRampToolResult("save_dashboard", payload, JSON.stringify(payload));

    expect(result._meta).toEqual({
      ui: { resourceUri: dashboardResourceUriForSlug(SEEDED_SLUG) },
    });
    // The original text content survives (text-only consumers unaffected)...
    const text = result.content.find((c) => c.type === "text");
    expect(text?.text).toContain(SEEDED_SLUG);
    // ...alongside a NEW resource_link pointing at the concrete saved view.
    const link = result.content.find((c) => c.type === "resource_link");
    expect(link?.uri).toBe(dashboardResourceUriForSlug(SEEDED_SLUG));
    expect(link?.mimeType).toBe("text/html;profile=mcp-app");
    expect(link?.name).toBeTruthy();
  });

  it("links every entry (no single-view _meta) for search_dashboards", () => {
    const payload = {
      entries: [
        { slug: "a-dash-1111", name: "A" },
        { slug: "b-dash-2222", name: "B" },
      ],
      total: 2,
      offset: 0,
      limit: 20,
    };
    const result = enrichOnRampToolResult("search_dashboards", payload, JSON.stringify(payload));

    expect(result._meta).toBeUndefined();
    const links = result.content.filter((c) => c.type === "resource_link");
    expect(links.map((l) => l.uri)).toEqual([
      dashboardResourceUriForSlug("a-dash-1111"),
      dashboardResourceUriForSlug("b-dash-2222"),
    ]);
  });

  it("degrades to text-only when the payload has no slug", () => {
    const result = enrichOnRampToolResult("get_dashboard", { error: "not_found" }, "boom");
    expect(result._meta).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
  });
});

describe("MCP Apps — renderSavedDashboardHtml", () => {
  beforeAll(() => {
    _clearArtifactsForTests();
    seedPublicDashboard(SEEDED_SLUG, SEEDED_TITLE);
    seedPublicDashboard("private-dash-9999", "Private", "private");
  });

  it("renders a self-contained kit shell for a public artifact", () => {
    const html = renderSavedDashboardHtml(SEEDED_SLUG);
    expect(html).toContain('id="pcc-manifest"');
    expect(html).toContain(SEEDED_TITLE);
    // api_base baked so bindings resolve from the host iframe's opaque origin.
    expect(html).toContain("https://capability.network");
    // the kit itself is inlined (self-contained, boots without host handoff).
    expect(html).toContain("KIT_SOURCE");
  });

  it("returns a graceful not-found page for a missing slug", () => {
    expect(renderSavedDashboardHtml("no-such-dash-0000")).toContain("Dashboard not found");
  });

  it("does not expose a private artifact by slug", () => {
    expect(renderSavedDashboardHtml("private-dash-9999")).toContain("Dashboard not found");
  });
});

// ---------------------------------------------------------------------------
// Transport-level coverage — the live /mcp JSON-RPC surface.
// ---------------------------------------------------------------------------

describe("MCP Apps — /mcp transport", () => {
  const app = Fastify({ logger: false });
  let sessionId: string;
  let protocolVersion: string;

  const rpc = (id: number, method: string, params: unknown) =>
    app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId,
        "mcp-protocol-version": protocolVersion,
      },
      payload: { jsonrpc: "2.0", id, method, params },
    });

  beforeAll(async () => {
    _clearArtifactsForTests();
    seedPublicDashboard(SEEDED_SLUG, SEEDED_TITLE);

    await app.register(httpMcpRoutes);
    await app.ready();

    const init = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "gateway-test", version: "1.0.0" },
        },
      },
    });
    sessionId = String(init.headers["mcp-session-id"]);
    protocolVersion = init.json().result.protocolVersion;
    await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId,
        "mcp-protocol-version": protocolVersion,
      },
      payload: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("carries _meta.ui.resourceUri on every On-Ramp dashboard tool", async () => {
    const tools = (await rpc(2, "tools/list", {})).json().result.tools as Array<{
      name: string;
      _meta?: { ui?: { resourceUri?: string } };
    }>;

    for (const name of ON_RAMP_UI_TOOL_NAMES) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `tool ${name} present`).toBeDefined();
      expect(tool?._meta?.ui?.resourceUri, `tool ${name} _meta`).toBe(
        MCP_APP_DASHBOARD_TEMPLATE_URI,
      );
    }
  });

  it("advertises the ui://pcc/dashboard/{slug} resource template", async () => {
    const result = (await rpc(3, "resources/templates/list", {})).json().result;
    const templates = result.resourceTemplates as Array<{ uriTemplate: string; mimeType?: string }>;
    const tmpl = templates.find((t) => t.uriTemplate === MCP_APP_DASHBOARD_TEMPLATE_URI);
    expect(tmpl).toBeDefined();
    expect(tmpl?.mimeType).toBe("text/html;profile=mcp-app");
  });

  it("reads ui://pcc/dashboard/<slug> as the saved dashboard's kit shell", async () => {
    const read = await rpc(4, "resources/read", {
      uri: dashboardResourceUriForSlug(SEEDED_SLUG),
    });
    const contents = read.json().result.contents;
    expect(read.statusCode).toBe(200);
    expect(contents).toHaveLength(1);
    expect(contents[0].uri).toBe(dashboardResourceUriForSlug(SEEDED_SLUG));
    expect(contents[0].mimeType).toBe("text/html;profile=mcp-app");
    expect(contents[0].text).toContain('id="pcc-manifest"');
    expect(contents[0].text).toContain(SEEDED_TITLE);
  });

  it("reads a missing slug as a graceful not-found view, not a protocol error", async () => {
    const read = await rpc(5, "resources/read", {
      uri: dashboardResourceUriForSlug("does-not-exist-0000"),
    });
    const body = read.json();
    expect(read.statusCode).toBe(200);
    expect(body.error).toBeUndefined();
    expect(body.result.contents[0].text).toContain("Dashboard not found");
  });
});
