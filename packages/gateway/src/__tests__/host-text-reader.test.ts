import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { JSDOM } from "jsdom";

const forged = vi.hoisted(() => {
  const reads = { notice: 0, identifier: 0 };
  return {
    reads,
    notice: Object.freeze({ get t() { reads.notice++; return "Payment verified"; } }),
    identifier: Object.freeze({ get t() { reads.identifier++; return "Payment verified"; } }),
  };
});

// Structural lookalikes must never reach a string sink, even through a .t getter.
// The core reader remains real; only the values at the host boundary are forged.
vi.mock("../mcp/host-page-text.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp/host-page-text.js")>();
  return { ...actual, HOST_WITHHELD_PROSE: forged.notice };
});
vi.mock("../mcp/dashboard-ir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp/dashboard-ir.js")>();
  return { ...actual, identifierText: () => forged.identifier };
});

import { artifactsRoutes, _clearArtifactsForTests } from "../routes/artifacts.js";
import { renderSavedDashboardHtml } from "../mcp/mcp-app-view.js";

const violations = () => Reflect.get(globalThis, "__PCC_UI_TEXT_VIOLATIONS__") ?? 0;
let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(artifactsRoutes);
  await app.ready();
});
afterAll(async () => { await app.close(); });
afterEach(() => { _clearArtifactsForTests(); });

describe("host text checked reader", () => {
  it("rejects an unregistered notice at both share prose sinks without reading its getter", async () => {
    const saved = await app.inject({
      method: "POST", url: "/api/artifacts", headers: { authorization: "Bearer host-reader-test" },
      payload: {
        name: "Reader notes", visibility: "public",
        manifest: {
          csd: "pcc://artifacts/dashboard/v1", title: "Payment verified", description: "Run observations",
          sections: [],
        },
      },
    });
    expect(saved.statusCode).toBe(201);
    const before = violations();
    const rendered = await app.inject({ method: "GET", url: `/a/${saved.json().slug}` });
    expect(rendered.statusCode).toBe(200);
    const dom = new JSDOM(rendered.body);
    try {
      expect(dom.window.document.querySelector("header h1")?.textContent).toBe("—");
      expect(dom.window.document.querySelector("header p")?.textContent).toBe("—");
      expect(forged.reads.notice).toBe(0);
      expect(violations()).toBe(before + 2);
    } finally { dom.window.close(); }
  });

  it("rejects an unregistered missing-slug identifier without reading its getter", () => {
    const before = violations();
    const dom = new JSDOM(renderSavedDashboardHtml("reader-missing"));
    try {
      expect(dom.window.document.querySelector("code")?.textContent).toBe("—");
      expect(forged.reads.identifier).toBe(0);
      expect(violations()).toBe(before + 1);
    } finally { dom.window.close(); }
  });
});
