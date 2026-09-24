/**
 * Template ownership (kits K0 slice 2; board rule 7).
 *
 * capability_template_store is the durable index under Capability Kits, so a
 * published template must be immutable and every write attributable to an
 * authenticated principal: no anonymous authors, no author-less publishing,
 * no one-identity rating floods. Runs against an in-memory store.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { templateRoutes } from "../routes/templates.js";
import { initStore, closeStore, getRepos } from "../db.js";

let app: FastifyInstance;
let seq = 0;

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  app = Fastify({ logger: false });
  // x-test-operator stands in for an authenticated API key; absent = anonymous.
  app.addHook("onRequest", async (req) => {
    const h = req.headers["x-test-operator"];
    if (typeof h === "string" && h !== "") (req as unknown as { operatorId?: string }).operatorId = h;
  });
  await app.register(templateRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeStore();
});

const as = (operatorId: string) => ({ "x-test-operator": operatorId });
const AUTHOR = "author@kits.test";
const OTHER = "other@kits.test";

async function createTemplate(author = AUTHOR) {
  const res = await app.inject({
    method: "POST",
    url: "/api/templates/capabilities",
    headers: as(author),
    payload: {
      capabilityType: `pcc://capabilities/liquid-handling/v1#t${++seq}`,
      name: `template ${seq}`,
      templateData: { adapter: "opentrons", steps: 3 },
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; authorId: string; status: string };
}

describe("template writes need an authenticated principal", () => {
  it("refuses anonymous create, fork, rate and machine-profile create (401)", async () => {
    const t = await createTemplate();
    const attempts = [
      { method: "POST" as const, url: "/api/templates/capabilities", payload: { capabilityType: "x", name: "y" } },
      { method: "POST" as const, url: `/api/templates/capabilities/${t.id}/fork`, payload: {} },
      { method: "POST" as const, url: `/api/templates/capabilities/${t.id}/rate`, payload: { score: 5 } },
      { method: "POST" as const, url: "/api/templates/machines", payload: { capabilityType: "x", machineName: "m" } },
    ];
    for (const a of attempts) {
      const res = await app.inject(a);
      expect(res.statusCode).toBe(401);
    }
  });

  it("attributes a new template to the authenticated principal", async () => {
    const t = await createTemplate();
    expect(t.authorId).toBe(AUTHOR);
    expect(t.status).toBe("draft");
  });
});

describe("PUT /api/templates/capabilities/:id", () => {
  it("refuses a non-author (403) and leaves the template unchanged", async () => {
    const t = await createTemplate();
    const res = await app.inject({
      method: "PUT",
      url: `/api/templates/capabilities/${t.id}`,
      headers: as(OTHER),
      payload: { templateData: { adapter: "hijacked" } },
    });
    expect(res.statusCode).toBe(403);
    const row = getRepos().templateStore.findCapabilityTemplateById(t.id)!;
    expect((row.templateData as { adapter: string }).adapter).toBe("opentrons");
  });

  it("lets the author edit a draft", async () => {
    const t = await createTemplate();
    const res = await app.inject({
      method: "PUT",
      url: `/api/templates/capabilities/${t.id}`,
      headers: as(AUTHOR),
      payload: { description: "edited draft" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().description).toBe("edited draft");
  });

  it("refuses to rewrite a PUBLISHED template in place, even for its author (409)", async () => {
    const t = await createTemplate();
    const pub = await app.inject({
      method: "POST", url: `/api/templates/capabilities/${t.id}/publish`, headers: as(AUTHOR),
    });
    expect(pub.statusCode).toBe(200);

    const res = await app.inject({
      method: "PUT",
      url: `/api/templates/capabilities/${t.id}`,
      headers: as(AUTHOR),
      payload: { templateData: { adapter: "silently-changed" } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("published_immutable");
    const row = getRepos().templateStore.findCapabilityTemplateById(t.id)!;
    expect((row.templateData as { adapter: string }).adapter).toBe("opentrons");
  });

  it("refuses to edit a template that has no recorded author", async () => {
    const orphanId = `orphan-${++seq}`;
    getRepos().templateStore.insertCapabilityTemplate({
      id: orphanId, capabilityType: "legacy", version: "1.0.0", name: "legacy orphan",
      templateData: {}, authorId: null, status: "draft", tags: null, usageCount: 0, forkCount: 0,
      rating: null, ratingCount: 0, forkedFrom: null, isVerified: false,
      createdAt: new Date().toISOString(), updatedAt: null,
    });
    for (const url of [`/api/templates/capabilities/${orphanId}`]) {
      const res = await app.inject({ method: "PUT", url, headers: as(OTHER), payload: { name: "claimed" } });
      expect(res.statusCode).toBe(403);
    }
    // Publishing an author-less template was previously open to anyone.
    const pub = await app.inject({
      method: "POST", url: `/api/templates/capabilities/${orphanId}/publish`, headers: as(OTHER),
    });
    expect(pub.statusCode).toBe(403);
  });
});

describe("POST /api/templates/capabilities/:id/rate", () => {
  it("accepts one rating per rater; a repeat from the same identity is refused (409)", async () => {
    const t = await createTemplate();
    const first = await app.inject({
      method: "POST", url: `/api/templates/capabilities/${t.id}/rate`, headers: as(OTHER), payload: { score: 5 },
    });
    expect(first.statusCode).toBe(200);
    const again = await app.inject({
      method: "POST", url: `/api/templates/capabilities/${t.id}/rate`,
      headers: as(" OTHER@kits.test "), payload: { score: 1 },
    });
    expect(again.statusCode).toBe(409);
    const row = getRepos().templateStore.findCapabilityTemplateById(t.id)!;
    expect(row.ratingCount).toBe(1);
    expect(row.rating).toBe(5);
  });
});

describe("PUT /api/templates/machines/:id", () => {
  it("refuses a non-author (403)", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/templates/machines", headers: as(AUTHOR),
      payload: { capabilityType: "liquid-handling", machineName: "OT-2 #1" },
    });
    expect(created.statusCode).toBe(201);
    const res = await app.inject({
      method: "PUT", url: `/api/templates/machines/${created.json().id}`,
      headers: as(OTHER), payload: { machineName: "renamed by someone else" },
    });
    expect(res.statusCode).toBe(403);
  });
});
