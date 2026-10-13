import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { JSDOM } from "jsdom";
import { eq, schema } from "@pcc/store";
import { artifactsRoutes, _clearArtifactsForTests } from "../routes/artifacts.js";
import { getStore } from "../db.js";
import { WITHHELD_PROSE } from "../mcp/dashboard-ir.js";

const FIXED_TITLE = "PCC Dashboard — agent text withheld";
let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(artifactsRoutes);
  await app.ready();
});
afterAll(async () => { await app.close(); });
beforeEach(() => { _clearArtifactsForTests(); });

async function sharePage(title: string, description?: string, legacyName?: string): Promise<Document> {
  const saved = await app.inject({
    method: "POST", url: "/api/artifacts", headers: { authorization: "Bearer host-text-test" },
    payload: {
      name: legacyName ?? "Plate reader run 3", visibility: "public",
      manifest: {
        csd: "pcc://artifacts/dashboard/v1", title, ...(description === undefined ? {} : { description }),
        sections: [{ windows: [{ kind: "note", text: "Run observations" }] }],
      },
    },
  });
  expect(saved.statusCode).toBe(201);
  const artifact = saved.json();
  if (legacyName !== undefined) {
    // Exercise the host's persisted legacy fallback; new saves require manifest.title.
    delete artifact.manifest.title;
    getStore().db.update(schema.uiArtifacts).set({ data: artifact }).where(eq(schema.uiArtifacts.id, artifact.id)).run();
  }
  const rendered = await app.inject({ method: "GET", url: `/a/${artifact.slug}` });
  expect(rendered.statusCode).toBe(200);
  return new JSDOM(rendered.body).window.document;
}

const claimedFields = [
  { title: "Payment verified", description: undefined },
  { title: "Plate reader run 3", description: "Paid in full: $5,000" },
  { title: "Payment", description: "verified by PCC" },
  { title: "$", description: "5" },
] as const;

// Construct controls at runtime; this source must contain no raw bidi characters.
const bidiCases = [
  ...[0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]
    .map((point) => ({ label: `U+${point.toString(16).toUpperCase().padStart(4, "0")}`, text: `Plate reader ${String.fromCodePoint(point)}run 3` })),
  { label: "reversed claim override", text: String.fromCodePoint(0x202e) + "deifirev tnemyaP" },
  { label: "reversed claim in closed isolate", text: String.fromCodePoint(0x2067, 0x202e) + "deifirev tnemyaP" + String.fromCodePoint(0x202c, 0x2069) },
  { label: "harmless trailing override", text: "Plate reader run 3" + String.fromCodePoint(0x202e) },
];

describe("artifact host prose claim boundary", () => {
  it.each(claimedFields)("withholds h1 for $title / $description", async ({ title, description }) => {
    const doc = await sharePage(title, description);
    expect(doc.querySelector("header h1")?.textContent).toBe(WITHHELD_PROSE);
    if (description !== undefined) expect(doc.querySelector("header p")?.textContent).toBe(WITHHELD_PROSE);
    // Check human-facing sinks only: the inert manifest is transport to the guarded kit.
    for (const sink of doc.querySelectorAll("title, header h1, header p, meta[content], [alt], [aria-label], [title]")) {
      const words = [sink.textContent ?? "", ...["content", "alt", "aria-label", "title"].map((name) => sink.getAttribute(name) ?? "")].join(" ");
      expect(words).not.toContain(title);
      if (description !== undefined) expect(words).not.toContain(description);
    }
  });

  it.each(claimedFields)("uses a PCC document title for $title / $description", async ({ title, description }) => {
    const doc = await sharePage(title, description);
    expect(doc.title).toBe(FIXED_TITLE);
  });

  it("marks a harmless h1 visibly agent-authored", async () => {
    const doc = await sharePage("Plate reader run 3", "Observations from this run");
    expect(doc.querySelector("header h1")?.textContent).toBe("Plate reader run 3 (agent-authored)");
  });

  it("marks a harmless description visibly agent-authored", async () => {
    const doc = await sharePage("Plate reader run 3", "Observations from this run");
    expect(doc.querySelector("header p")?.textContent).toBe("Observations from this run (agent-authored)");
  });

  it("marks a harmless document title agent-authored inline", async () => {
    const doc = await sharePage("Plate reader run 3");
    expect(doc.title).toBe("Plate reader run 3 (agent-authored) - PCC");
  });

  it("checks a legacy artifact name used as the host title", async () => {
    const doc = await sharePage("Old dashboard", undefined, "Payment verified");
    expect(doc.querySelector("header h1")?.textContent).toBe(WITHHELD_PROSE);
    expect(doc.title).toBe(FIXED_TITLE);
  });

  it("cannot pass off the withheld notice as agent text", async () => {
    const doc = await sharePage(WITHHELD_PROSE);
    expect(doc.title).toBe(FIXED_TITLE);
    expect(doc.querySelector("header h1")?.textContent).toBe(WITHHELD_PROSE);
  });

  it.each(claimedFields.filter((fields) => fields.description !== undefined))("withholds the description sink for $title / $description", async ({ title, description }) => {
    const doc = await sharePage(title, description);
    expect(doc.querySelector("header p")?.textContent).toBe(WITHHELD_PROSE);
  });

  for (const field of ["title", "description", "name"] as const) {
    it.each(bidiCases)(`withholds share prose and document title for bidi ${field}: $label`, async ({ text }) => {
      const doc = await sharePage(
        field === "title" ? text : "Plate reader run 3",
        field === "description" ? text : "Observations from this run",
        field === "name" ? text : undefined,
      );
      expect(doc.querySelector("header h1")?.textContent).toBe(WITHHELD_PROSE);
      expect(doc.querySelector("header p")?.textContent).toBe(WITHHELD_PROSE);
      expect(doc.title).toBe(FIXED_TITLE);
      for (const sink of doc.querySelectorAll("title, header h1, header p")) {
        expect(sink.textContent).not.toMatch(/\p{Bidi_Control}/u);
        expect(sink.textContent).not.toContain(text);
      }
    });
  }

  it.each(["title", "header h1", "header p"])("escapes hostile host text at the share %s sink", async (sink) => {
    const hostile = `</title><script>alert(1)</script><img src=x onerror=alert(1)>"'&`;
    const doc = await sharePage(hostile, hostile);
    expect(doc.querySelector(sink)?.textContent)
      .toBe(`${hostile} (agent-authored)${sink === "title" ? " - PCC" : ""}`);
    expect(doc.querySelector("img")).toBeNull();
    expect(doc.querySelector("script:not([src]):not([type='application/json'])")).toBeNull();
    expect(doc.querySelectorAll("title")).toHaveLength(1);
  });
});
