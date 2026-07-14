/**
 * MCP Apps bridge — transport re-architecture (feat/mcp-apps-bridge).
 *
 * Covers the ONE-transport-contract additions (directives 1-5,7,15-17):
 *   - enrichOnRampToolResult now returns `structuredContent` (manifest for
 *     single-artifact tools, projected entries for search) + the canonical FIXED
 *     `_meta.ui.resourceUri` (saved/gallery) — no more per-slug resource_link;
 *   - private dashboards render from the AUTHENTICATED result's structuredContent,
 *     never a second anonymous lookup;
 *   - the in-view host->view verification (extractToolResultManifest) + the
 *     browser-safe manifest validator (isValidDashboardManifest) — the exact
 *     logic inlined into the view boot script;
 *   - outputSchema conformance for every structuredContent tool;
 *   - the public/unlisted SHARE view (getPublicArtifactForRender: slug-only,
 *     format-validated, passive);
 *   - the live /mcp surface: fixed UI resources, no {slug} on any tool descriptor,
 *     full _meta.ui.csp on every read.
 *
 * The DOM lifecycle (init handshake + a real tool-result MOUNTS the manifest and
 * the placeholder disappears) is covered in mcp-app-view-lifecycle.test.ts (jsdom).
 *
 * Network-free: artifacts are seeded straight into the same in-memory store the
 * MCP resource read consults (both go through routes/artifacts.ts's db()).
 */

import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DASHBOARD_CSD_URL, type UiArtifact } from "@pcc/spec";
import { httpMcpRoutes } from "../mcp/http-mcp-server.js";
import {
  _clearArtifactsForTests,
  _seedArtifactForTests,
  getPublicArtifactForRender,
} from "../routes/artifacts.js";
import {
  enrichOnRampToolResult,
  extractToolResultManifest,
  GALLERY_OUTPUT_SCHEMA,
  isValidDashboardManifest,
  MCP_APP_GALLERY_URI,
  MCP_APP_SAVED_URI,
  MCP_APP_TOOL_RESULT_METHOD,
  ON_RAMP_UI_TOOL_NAMES,
  onRampToolResourceUri,
  renderSavedDashboardHtml,
  SAVED_OUTPUT_SCHEMA,
  structuredContentConformsTo,
} from "../mcp/mcp-app-view.js";

const SEEDED_SLUG = "watch-my-pizza-8k3f";
const SEEDED_TITLE = "Watch my pizza + courier";

function manifestFor(title: string) {
  return {
    csd: DASHBOARD_CSD_URL,
    title,
    sections: [{ windows: [{ kind: "note", text: "Your pizza is in the oven." }] }],
  };
}

function seedDashboard(
  slug: string,
  title: string,
  visibility: UiArtifact["visibility"] = "public",
): void {
  const now = new Date().toISOString();
  _seedArtifactForTests({
    id: `ua_${slug}`,
    slug,
    csd: DASHBOARD_CSD_URL,
    name: title,
    manifest: manifestFor(title),
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
// enrichOnRampToolResult — structuredContent transport (directives 5,7,15,17).
// ---------------------------------------------------------------------------

describe("MCP Apps — enrichOnRampToolResult (structuredContent transport)", () => {
  it("carries the manifest in structuredContent + fixed saved URI for save/get/fork/update", () => {
    const manifest = manifestFor(SEEDED_TITLE);
    const payload = { slug: SEEDED_SLUG, name: SEEDED_TITLE, id: `ua_${SEEDED_SLUG}`, manifest };
    const result = enrichOnRampToolResult("save_dashboard", payload, JSON.stringify(payload));

    // Canonical fixed URI (no {slug}) matching the descriptor.
    expect(result._meta).toEqual({ ui: { resourceUri: MCP_APP_SAVED_URI } });
    // The manifest travels in structuredContent — the fixed saved view renders it.
    expect(result.structuredContent?.manifest).toEqual(manifest);
    expect(result.structuredContent?.slug).toBe(SEEDED_SLUG);
    // Conforms to the declared outputSchema.
    expect(structuredContentConformsTo(SAVED_OUTPUT_SCHEMA, result.structuredContent)).toBe(true);
    // Original text preserved; NO resource_link (the old anon-slug transport is gone).
    expect(result.content.find((c) => c.type === "text")?.text).toContain(SEEDED_SLUG);
    expect(result.content.some((c) => c.type === "resource_link")).toBe(false);
  });

  it("renders a PRIVATE dashboard from the authenticated structuredContent (never a 2nd anon lookup)", () => {
    const privateManifest = manifestFor("My private ops");
    // The authenticated get_dashboard result an owner receives for a PRIVATE artifact.
    const payload = {
      slug: "my-private-9999",
      name: "My private ops",
      visibility: "private",
      manifest: privateManifest,
    };
    const result = enrichOnRampToolResult("get_dashboard", payload, JSON.stringify(payload));
    expect(result._meta).toEqual({ ui: { resourceUri: MCP_APP_SAVED_URI } });
    expect(result.structuredContent?.manifest).toEqual(privateManifest);

    // And the public share path would REFUSE the same private slug — proving the
    // saved view does not depend on it (directive 5).
    seedDashboard("my-private-9999", "My private ops", "private");
    expect(getPublicArtifactForRender("my-private-9999")).toBeUndefined();
  });

  it("projects entries into structuredContent + fixed gallery URI for search_dashboards", () => {
    const payload = {
      entries: [
        { slug: "a-dash-1111", name: "A", manifest: manifestFor("Alpha") },
        { slug: "b-dash-2222", name: "B", manifest: manifestFor("Bravo") },
      ],
      total: 2,
      offset: 0,
      limit: 20,
    };
    const result = enrichOnRampToolResult("search_dashboards", payload, JSON.stringify(payload));

    expect(result._meta).toEqual({ ui: { resourceUri: MCP_APP_GALLERY_URI } });
    const entries = result.structuredContent?.entries as Array<Record<string, unknown>>;
    expect(entries.map((e) => e.slug)).toEqual(["a-dash-1111", "b-dash-2222"]);
    expect(entries[0].title).toBe("Alpha");
    expect(result.structuredContent?.total).toBe(2);
    expect(structuredContentConformsTo(GALLERY_OUTPUT_SCHEMA, result.structuredContent)).toBe(true);
    expect(result.content.some((c) => c.type === "resource_link")).toBe(false);
  });

  it("degrades to text-only (no UI) when the payload has no renderable manifest", () => {
    const result = enrichOnRampToolResult("get_dashboard", { error: "not_found" }, "boom");
    expect(result._meta).toBeUndefined();
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
  });

  it("routes each On-Ramp tool to its fixed UI resource (saved vs gallery)", () => {
    for (const name of ON_RAMP_UI_TOOL_NAMES) {
      const expected = name === "search_dashboards" ? MCP_APP_GALLERY_URI : MCP_APP_SAVED_URI;
      expect(onRampToolResourceUri(name)).toBe(expected);
      // No fixed URI contains an unresolved template variable.
      expect(onRampToolResourceUri(name)).not.toContain("{slug}");
    }
  });
});

// ---------------------------------------------------------------------------
// isValidDashboardManifest — the browser-safe in-view validator (directive 2).
// ---------------------------------------------------------------------------

describe("MCP Apps — isValidDashboardManifest (in-view validation)", () => {
  it("accepts a well-formed manifest", () => {
    expect(isValidDashboardManifest(manifestFor("ok"))).toBe(true);
  });

  it("rejects a wrong/missing csd, empty title, non-array sections, and unknown window kinds", () => {
    expect(isValidDashboardManifest({ ...manifestFor("x"), csd: "pcc://other" })).toBe(false);
    expect(isValidDashboardManifest({ ...manifestFor(""), title: "" })).toBe(false);
    expect(isValidDashboardManifest({ csd: DASHBOARD_CSD_URL, title: "x", sections: {} })).toBe(false);
    expect(
      isValidDashboardManifest({
        csd: DASHBOARD_CSD_URL,
        title: "x",
        sections: [{ windows: [{ kind: "evil-iframe" }] }],
      }),
    ).toBe(false);
  });

  it("rejects a manifest carrying an API-key substring (the no-key refine)", () => {
    const keyed = {
      csd: DASHBOARD_CSD_URL,
      title: "x",
      sections: [{ windows: [{ kind: "note", text: "pcc_live_leak" }] }],
    };
    expect(isValidDashboardManifest(keyed)).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isValidDashboardManifest(null)).toBe(false);
    expect(isValidDashboardManifest("nope")).toBe(false);
    expect(isValidDashboardManifest([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractToolResultManifest — host->view verification (directives 1,2). This is
// the EXACT logic inlined into the view boot script via .toString().
// ---------------------------------------------------------------------------

describe("MCP Apps — extractToolResultManifest (host handoff verification)", () => {
  const HOST = { name: "host-parent-frame" };

  const toolResult = (manifest: unknown, extra: Record<string, unknown> = {}) => ({
    jsonrpc: "2.0",
    method: MCP_APP_TOOL_RESULT_METHOD,
    params: {
      content: [{ type: "text", text: "Rendered a PCC dashboard." }],
      structuredContent: { manifest, ...extra },
    },
  });

  it("uses the exact SEP-1865 host->view notification method string", () => {
    expect(MCP_APP_TOOL_RESULT_METHOD).toBe("ui/notifications/tool-result");
  });

  it("accepts a valid tool-result from window.parent and returns ONLY the manifest", () => {
    const manifest = manifestFor("Live dashboard");
    expect(extractToolResultManifest(HOST, HOST, toolResult(manifest))).toEqual(manifest);
  });

  it("IGNORES token/apiBase/snapshot in the message — returns the manifest, never a credential", () => {
    const manifest = manifestFor("Live dashboard");
    const out = extractToolResultManifest(
      HOST,
      HOST,
      toolResult(manifest, {
        apiBase: "https://evil.example",
        snapshot: { "x.y": 1 },
        token: "pcc_live_from_host",
      }),
    );
    // The manifest comes back unchanged; nothing else does (no token/apiBase/snapshot).
    expect(out).toEqual(manifest);
    expect(JSON.stringify(out)).not.toContain("pcc_live_from_host");
    expect(JSON.stringify(out)).not.toContain("evil.example");
  });

  it("rejects a non-parent source (foreign frame)", () => {
    expect(extractToolResultManifest({ name: "not-parent" }, HOST, toolResult(manifestFor("x")))).toBeNull();
  });

  it("rejects a message lacking the JSON-RPC 2.0 envelope (the old permissive shapes)", () => {
    expect(extractToolResultManifest(HOST, HOST, { manifest: manifestFor("x") })).toBeNull();
    expect(
      extractToolResultManifest(HOST, HOST, { structuredContent: { manifest: manifestFor("x") } }),
    ).toBeNull();
    expect(extractToolResultManifest(HOST, HOST, { toolOutput: { manifest: manifestFor("x") } })).toBeNull();
    expect(extractToolResultManifest(HOST, HOST, null)).toBeNull();
    expect(extractToolResultManifest(HOST, HOST, "not-an-object")).toBeNull();
  });

  it("rejects the wrong method", () => {
    expect(
      extractToolResultManifest(HOST, HOST, {
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { structuredContent: { manifest: manifestFor("x") } },
      }),
    ).toBeNull();
  });

  it("rejects a correct notification whose manifest fails in-view validation", () => {
    // Right envelope, but the manifest is forged/invalid (unknown window kind).
    expect(
      extractToolResultManifest(HOST, HOST, {
        jsonrpc: "2.0",
        method: MCP_APP_TOOL_RESULT_METHOD,
        params: { structuredContent: { manifest: { csd: DASHBOARD_CSD_URL, title: "x", sections: [{ windows: [{ kind: "evil" }] }] } } },
      }),
    ).toBeNull();
    // Missing structuredContent.manifest entirely.
    expect(
      extractToolResultManifest(HOST, HOST, {
        jsonrpc: "2.0",
        method: MCP_APP_TOOL_RESULT_METHOD,
        params: { content: [{ type: "text", text: "no manifest" }] },
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getPublicArtifactForRender / renderSavedDashboardHtml — public SHARE surface
// (directive 16): slug-only, format-validated, passive, public|unlisted-only.
// ---------------------------------------------------------------------------

describe("MCP Apps — public share view (getPublicArtifactForRender)", () => {
  beforeAll(() => {
    _clearArtifactsForTests();
    seedDashboard(SEEDED_SLUG, SEEDED_TITLE, "public");
    seedDashboard("unlisted-dash-7777", "Unlisted", "unlisted");
    seedDashboard("private-dash-9999", "Private", "private");
  });

  it("renders a self-contained kit shell for a public artifact", () => {
    const html = renderSavedDashboardHtml(SEEDED_SLUG);
    expect(html).toContain('id="pcc-manifest"');
    expect(html).toContain(SEEDED_TITLE);
    expect(html).toContain("https://capability.network"); // api_base baked
    expect(html).toContain("KIT_SOURCE"); // kit inlined (boots without handoff)
  });

  it("serves an unlisted artifact by slug but never a private one", () => {
    expect(renderSavedDashboardHtml("unlisted-dash-7777")).toContain("Unlisted");
    expect(renderSavedDashboardHtml("private-dash-9999")).toContain("Dashboard not found");
  });

  it("accepts a well-formed SLUG only — rejects an id and malformed input", () => {
    expect(getPublicArtifactForRender(SEEDED_SLUG)?.slug).toBe(SEEDED_SLUG);
    // An id (ua_… with an underscore) is rejected: a read is not an id oracle.
    expect(getPublicArtifactForRender(`ua_${SEEDED_SLUG}`)).toBeUndefined();
    expect(getPublicArtifactForRender("Bad Slug!")).toBeUndefined();
    expect(getPublicArtifactForRender("../../etc/passwd")).toBeUndefined();
    expect(renderSavedDashboardHtml("no-such-dash-0000")).toContain("Dashboard not found");
  });

  it("is a PASSIVE read — does not bump loadCount/updatedAt", () => {
    getPublicArtifactForRender(SEEDED_SLUG);
    getPublicArtifactForRender(SEEDED_SLUG);
    expect(getPublicArtifactForRender(SEEDED_SLUG)?.loadCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Live /mcp surface — fixed UI resources, no {slug} on any tool, full CSP.
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
    seedDashboard(SEEDED_SLUG, SEEDED_TITLE, "public");

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

  it("advertises a FIXED, fetchable UI resource with no {slug} on every On-Ramp tool + outputSchema", async () => {
    const tools = (await rpc(2, "tools/list", {})).json().result.tools as Array<{
      name: string;
      _meta?: { ui?: { resourceUri?: string } };
      outputSchema?: { required?: string[] };
    }>;

    for (const name of ON_RAMP_UI_TOOL_NAMES) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `tool ${name} present`).toBeDefined();
      const uri = tool?._meta?.ui?.resourceUri;
      expect(uri, `tool ${name} fixed URI`).toBe(onRampToolResourceUri(name));
      expect(uri, `tool ${name} no template var`).not.toContain("{");
      expect(tool?.outputSchema, `tool ${name} outputSchema`).toBeDefined();
    }
  });

  it("still advertises the ui://pcc/dashboard/{slug} SHARE template (public sharing only)", async () => {
    const result = (await rpc(3, "resources/templates/list", {})).json().result;
    const templates = result.resourceTemplates as Array<{ uriTemplate: string; mimeType?: string }>;
    const tmpl = templates.find((t) => t.uriTemplate === "ui://pcc/dashboard/{slug}");
    expect(tmpl).toBeDefined();
    expect(tmpl?.mimeType).toBe("text/html;profile=mcp-app");
  });

  it("reads a saved public dashboard by slug (share view) with full _meta.ui.csp", async () => {
    const read = await rpc(4, "resources/read", { uri: `ui://pcc/dashboard/${SEEDED_SLUG}` });
    const contents = read.json().result.contents;
    expect(read.statusCode).toBe(200);
    expect(contents).toHaveLength(1);
    expect(contents[0].uri).toBe(`ui://pcc/dashboard/${SEEDED_SLUG}`);
    expect(contents[0].mimeType).toBe("text/html;profile=mcp-app");
    expect(contents[0].text).toContain('id="pcc-manifest"');
    expect(contents[0].text).toContain(SEEDED_TITLE);
    // Directive 3 — full CSP shape on the share read too.
    expect(contents[0]._meta?.ui?.csp?.connectDomains).toContain("https://capability.network");
    expect(contents[0]._meta?.ui?.csp?.resourceDomains).toEqual([]);
    expect(contents[0]._meta?.ui?.prefersBorder).toBe(true);
  });

  it("reads the fixed saved + gallery views with full _meta.ui.csp", async () => {
    for (const uri of [MCP_APP_SAVED_URI, MCP_APP_GALLERY_URI]) {
      const read = await rpc(6, "resources/read", { uri });
      const contents = read.json().result.contents;
      expect(read.statusCode, `read ${uri}`).toBe(200);
      expect(contents[0].mimeType).toBe("text/html;profile=mcp-app");
      // Standard lifecycle in every view.
      expect(contents[0].text).toContain("ui/initialize");
      expect(contents[0].text).toContain("ui/notifications/tool-result");
      expect(contents[0]._meta?.ui?.csp?.connectDomains).toContain("https://capability.network");
      expect(contents[0]._meta?.ui?.prefersBorder).toBe(true);
    }
  });

  it("reads a missing slug as a graceful not-found view, not a protocol error", async () => {
    const read = await rpc(5, "resources/read", { uri: `ui://pcc/dashboard/does-not-exist-0000` });
    const body = read.json();
    expect(read.statusCode).toBe(200);
    expect(body.error).toBeUndefined();
    expect(body.result.contents[0].text).toContain("Dashboard not found");
  });
});
