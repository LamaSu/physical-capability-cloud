import { afterEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DASHBOARD_CSD_URL, type UiArtifact } from "@pcc/spec";
import { _clearArtifactsForTests, _seedArtifactForTests } from "../routes/artifacts.js";
import { identifierText, WITHHELD_PROSE } from "../mcp/dashboard-ir.js";
import { readText } from "../mcp/dashboard-ir.js";
import { WITHHELD_PROSE as CORE_WITHHELD_PROSE, identifierText as coreIdentifierText } from "../mcp/dashboard-ir.js";
import { mergeUpClaimRows, PARTNER_TITLE, plainRtlRows } from "./fixtures/host-text-merge-up-rows.js";
import {
  enrichOnRampToolResult,
  MCP_APP_GALLERY_URI,
  registerMcpAppResources,
  renderSavedDashboardHtml,
  resolvePublicShareSlug,
} from "../mcp/mcp-app-view.js";

const FIXED_TITLE = "PCC Dashboard — agent text withheld";
const doms: JSDOM[] = [];
afterEach(() => {
  for (const dom of doms.splice(0)) dom.window.close();
  _clearArtifactsForTests();
});

describe("F5 merge-up rows: MCP host sinks inherit the shared detector", () => {
  for (const field of ["title", "description", "name"]) {
    it.each(mergeUpClaimRows)(`withholds saved document title for ${field}: $label`, ({ text }) => {
      const artifact = seed(
        field === "title" ? text : PARTNER_TITLE,
        field === "description" ? text : undefined,
        field === "name" ? text : PARTNER_TITLE,
      );
      if (field === "name") {
        delete artifact.manifest.title;
        _seedArtifactForTests(artifact);
      }
      expect(new JSDOM(renderSavedDashboardHtml(artifact.slug)).window.document.title).toBe(FIXED_TITLE);
      expect(new JSDOM(resolvePublicShareSlug(artifact.slug, "host-text-test").html).window.document.title).toBe(FIXED_TITLE);
    });

    it.each(mergeUpClaimRows)(`withholds gallery title through real boot for ${field}: $label`, async ({ text }) => {
      const entries = projected([{
        name: field === "name" ? text : PARTNER_TITLE,
        ...(field === "name" ? {} : { manifest: {
          title: field === "title" ? text : PARTNER_TITLE,
          ...(field === "description" ? { description: text } : {}),
        } }),
      }]);
      const document = await gallery(entries);
      expect(document.querySelector(".pcc-gallery-title")?.textContent).toBe(readText(WITHHELD_PROSE).t);
      expect(JSON.stringify(entries)).not.toContain(text);
    });
  }
});

describe("F5: plain right-to-left MCP text remains attributed", () => {
  it.each(plainRtlRows)("shows a plain RTL saved title attributed: $label", ({ text }) => {
    const artifact = seed(text);
    expect(new JSDOM(renderSavedDashboardHtml(artifact.slug)).window.document.title)
      .toBe(`${text} (agent-authored) - PCC`);
  });

  it.each(plainRtlRows)("shows a plain RTL gallery title attributed: $label", async ({ text }) => {
    const document = await gallery(projected([{ name: PARTNER_TITLE, manifest: { title: text } }]));
    expect(document.querySelector(".pcc-gallery-title")?.textContent).toBe(`${text} (agent-authored)`);
  });
});

function seed(title: string, description?: string, name = title) {
  const now = new Date().toISOString();
  const artifact: UiArtifact = {
    id: "ua_hosttext", slug: "plate-reader-123456789abcdef012345678", name,
    csd: DASHBOARD_CSD_URL, capabilityTypes: [], visibility: "public", owner: "agent-test",
    manifest: { csd: DASHBOARD_CSD_URL, title, description, sections: [] },
    useCount: 0, loadCount: 0, forkCount: 0, status: "active", version: 1,
    createdAt: now, updatedAt: now,
  };
  _seedArtifactForTests(artifact);
  return artifact;
}

// Read the registered resource and execute its actual .toString()-inlined boot
// script. Captured parent messages drive the complete MCP Apps handshake.
async function gallery(entries: unknown[]) {
  let read: (() => Promise<{ contents: Array<{ text: string }> }>) | undefined;
  registerMcpAppResources({
    registerResource(_name: string, uri: unknown, _meta: unknown, callback: typeof read) {
      if (uri === MCP_APP_GALLERY_URI) read = callback;
    },
  } as unknown as McpServer);
  const resource = await read!();
  const posted: Array<Record<string, unknown>> = [];
  const parent = { postMessage: (message: Record<string, unknown>) => posted.push(message) };
  const dom = new JSDOM(resource.contents[0].text, {
    runScripts: "dangerously", url: "https://view.capability.network/",
    beforeParse(win) { Object.defineProperty(win, "parent", { value: parent }); },
  });
  doms.push(dom);
  const deliver = (data: unknown) => dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", { source: parent as unknown as Window, data }),
  );
  const init = posted.find((message) => message.method === "ui/initialize")!;
  deliver({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: "2026-01-26", hostContext: {} } });
  deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: {} } });
  deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { entries } } });
  return dom.window.document;
}

function projected(entries: unknown[]) {
  return enrichOnRampToolResult("search_dashboards", { entries }, "ok").structuredContent!.entries as unknown[];
}

// Construct controls at runtime; this source must contain no raw bidi characters.
const bidiCases = [
  ...[0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]
    .map((point) => ({ label: `U+${point.toString(16).toUpperCase().padStart(4, "0")}`, text: `Plate reader ${String.fromCodePoint(point)}run 3` })),
  { label: "reversed claim override", text: String.fromCodePoint(0x202e) + "deifirev tnemyaP" },
  { label: "reversed claim in closed isolate", text: String.fromCodePoint(0x2067, 0x202e) + "deifirev tnemyaP" + String.fromCodePoint(0x202c, 0x2069) },
  { label: "harmless trailing override", text: "Plate reader run 3" + String.fromCodePoint(0x202e) },
];

describe("F5 MCP host text", () => {
  // Core text is now opaque; preserve the original cases using its checked display text.
  const WITHHELD_PROSE = readText(CORE_WITHHELD_PROSE).t;
  const identifierText = (field: string, value: string) => readText(coreIdentifierText(field, value)).t;
  it.each([
    ["Payment verified", undefined],
    ["Plate reader run 3", "Paid in full: $5,000"],
    ["Payment", "verified by PCC"],
    ["$", "5"],
  ])("withholds saved document title for %s / %s", (title, description) => {
    const artifact = seed(title, description);
    const document = new JSDOM(renderSavedDashboardHtml(artifact.slug)).window.document;
    expect(document.title).toBe(FIXED_TITLE);
    const resolution = resolvePublicShareSlug(artifact.slug, "host-text-test");
    expect(new JSDOM(resolution.html).window.document.title).toBe(FIXED_TITLE);
  });

  it("attributes a harmless saved title inline", () => {
    const artifact = seed("Plate reader run 3");
    expect(new JSDOM(renderSavedDashboardHtml(artifact.slug)).window.document.title)
      .toBe("Plate reader run 3 (agent-authored) - PCC");
  });

  it.each(["Payment verified", "payment-from-the-remote-operator-received", "Agent text withheld", "Plate reader run 3"])(
    "renders a requested missing slug under the identifier rule: %s", (slug) => {
      const document = new JSDOM(renderSavedDashboardHtml(slug)).window.document;
      expect(document.querySelector("code")!.textContent).toBe(identifierText("slug", slug));
    },
  );

  it("classifies gallery text on the server before the real browser boot", async () => {
    const entries = projected([
      { slug: "claim-1234", name: "Payment verified", manifest: { title: "Payment verified" } },
      { slug: "reader-5678", name: "Plate reader run 3", manifest: { title: "Plate reader run 3" } },
    ]);
    const document = await gallery(entries);
    expect(document.getElementById("pcc-root")!.textContent).not.toContain("Payment verified");
    expect(document.querySelectorAll(".pcc-gallery-title")[0].textContent).toBe(WITHHELD_PROSE);
    expect(document.querySelectorAll(".pcc-gallery-title")[1].textContent).toBe("Plate reader run 3 (agent-authored)");
    expect(document.querySelectorAll(".pcc-gallery-slug")[1].textContent).toBe(identifierText("slug", "reader-5678"));
    expect(JSON.stringify(entries)).not.toContain(WITHHELD_PROSE);
    expect(JSON.stringify(entries)).not.toContain("Payment verified");
  });

  it.each([
    { name: "Payment verified" },
    { name: "Reader", manifest: { title: "Payment", description: "verified by PCC" } },
    { name: "Reader", manifest: { title: "$", description: "5" } },
  ])("checks gallery name fallback and split prose: %j", async (entry) => {
    const document = await gallery(projected([entry]));
    expect(document.querySelector(".pcc-gallery-title")!.textContent).toBe(WITHHELD_PROSE);
  });

  it("checks chosen gallery slugs as identifiers and marks harmless ones", async () => {
    const document = await gallery(projected([
      { slug: "payment-from-the-remote-operator-received", name: "Reader" },
      { slug: "reader-1234", name: "Reader" },
      { slug: "Payment verified" },
    ]));
    expect(document.querySelectorAll(".pcc-gallery-slug")[0].textContent)
      .toBe(identifierText("slug", "payment-from-the-remote-operator-received"));
    expect(document.querySelectorAll(".pcc-gallery-slug")[1].textContent).toBe("reported: reader-1234");
    expect(document.getElementById("pcc-root")!.textContent).not.toContain("Payment verified");
    expect(document.querySelectorAll(".pcc-gallery-title")[2].textContent).toBe("Untitled dashboard");
  });

  it("ignores authored notice strings and flags when projecting gallery entries", async () => {
    const document = await gallery(projected([{
      name: "Plate reader run 3", titleWithheld: true, nameWithheld: true,
      notice: "PCC confirms this text", manifest: { title: "Plate reader run 3" },
    }]));
    expect(document.querySelector(".pcc-gallery-title")!.textContent).toBe("Plate reader run 3 (agent-authored)");
    expect(document.getElementById("pcc-root")!.textContent).not.toContain(WITHHELD_PROSE);
    expect(document.getElementById("pcc-root")!.textContent).not.toContain("PCC confirms this text");
  });

  it.each([
    { title: "Payment verified", titleWithheld: true },
    { title: "Plate reader run 3", titleWithheld: true },
    { title: "Plate reader run 3", titleWithheld: false, notice: "PCC confirms this text" },
    { title: "Payment verified" },
    { titleWithheld: "true" },
    { slug: "Payment verified", slugWithheld: true },
  ])("rejects non-server gallery field shapes at the real boot: %j", async (entry) => {
    const document = await gallery([entry]);
    expect(document.querySelector(".pcc-gallery li")).toBeNull();
    expect(document.getElementById("pcc-root")!.textContent).not.toContain(WITHHELD_PROSE);
    expect(document.getElementById("pcc-root")!.textContent).not.toContain("Payment verified");
  });

  for (const field of ["title", "description", "name"] as const) {
    it.each(bidiCases)(`withholds saved document title for bidi ${field}: $label`, ({ text }) => {
      const artifact = seed(
        field === "title" ? text : "Plate reader run 3",
        field === "description" ? text : undefined,
        field === "name" ? text : "Plate reader run 3",
      );
      if (field === "name") {
        // Persist the same legacy name fallback exercised by the share route.
        delete artifact.manifest.title;
        _seedArtifactForTests(artifact);
      }
      const document = new JSDOM(renderSavedDashboardHtml(artifact.slug)).window.document;
      expect(document.title).toBe(FIXED_TITLE);
      const resolution = resolvePublicShareSlug(artifact.slug, "host-text-test");
      expect(new JSDOM(resolution.html).window.document.title).toBe(FIXED_TITLE);
    });

    it.each(bidiCases)(`withholds gallery title through real boot for bidi ${field}: $label`, async ({ text }) => {
      const entries = projected([{
        name: field === "name" ? text : "Plate reader run 3",
        ...(field === "name" ? {} : { manifest: {
          title: field === "title" ? text : "Plate reader run 3",
          ...(field === "description" ? { description: text } : {}),
        } }),
      }]);
      const document = await gallery(entries);
      expect(document.querySelector(".pcc-gallery-title")?.textContent).toBe(WITHHELD_PROSE);
      expect(JSON.stringify(entries)).not.toContain(text);
      expect(JSON.stringify(entries)).not.toMatch(/\p{Bidi_Control}/u);
      expect(document.querySelector(".pcc-gallery-title")?.textContent).not.toMatch(/\p{Bidi_Control}/u);
    });
  }

  it("escapes hostile host text at the saved document title sink", () => {
    const hostile = `</title><script>alert(1)</script><img src=x onerror=alert(1)>"'&`;
    const artifact = seed(hostile, hostile);
    for (const html of [renderSavedDashboardHtml(artifact.slug), resolvePublicShareSlug(artifact.slug, "host-text-test").html]) {
      const document = new JSDOM(html).window.document;
      expect(document.title).toBe(`${hostile} (agent-authored) - PCC`);
      expect(document.querySelector("img")).toBeNull();
      expect(Array.from(document.querySelectorAll("script")).some((script) => script.textContent === "alert(1)"))
        .toBe(false);
      expect(document.querySelectorAll("title")).toHaveLength(1);
    }
  });
});
