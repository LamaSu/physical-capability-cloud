/**
 * Tool Catalog route tests — exercises the scaffold's CRUD + bounty surface.
 *
 * Uses Fastify's inject() instead of spinning a real port.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import {
  toolCatalogRoutes,
  _clearCatalogForTests,
} from "../routes/tool-catalog.js";

function makeApp() {
  const app = Fastify({ logger: false });
  void app.register(toolCatalogRoutes);
  return app;
}

const SAMPLE = {
  packageName: "@lamasu/trilobio-adapter",
  name: "Trilobio fleet-controller adapter",
  description: "Talks to a Trilobio fleet controller via tcode-api HTTP.",
  repoUrl: "https://github.com/LamaSu/trilobio-adapter",
  capabilityTypes: ["lab-automation/v1", "liquid-handling"],
  maintainerDid: "did:erc8004:0xLAMASU",
  license: "Apache-2.0",
  language: "typescript",
  status: "experimental" as const,
};

describe("POST /api/tool-catalog/register", () => {
  beforeEach(() => _clearCatalogForTests());

  it("creates a new tool entry on first registration (201)", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/tool-catalog/register",
      payload: SAMPLE,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/^tool_/);
    expect(body.packageName).toBe(SAMPLE.packageName);
    expect(body.registeredAt).toBeDefined();
    expect(body.updatedAt).toBeDefined();
  });

  it("idempotently updates on re-registration by packageName (200)", async () => {
    const app = makeApp();
    const first = await app.inject({
      method: "POST",
      url: "/api/tool-catalog/register",
      payload: SAMPLE,
    });
    const firstBody = first.json();

    const second = await app.inject({
      method: "POST",
      url: "/api/tool-catalog/register",
      payload: { ...SAMPLE, description: "updated desc", status: "beta" },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json();
    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.description).toBe("updated desc");
    expect(secondBody.status).toBe("beta");
  });

  it("rejects invalid payload (400)", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/tool-catalog/register",
      payload: { name: "X" }, // missing required fields
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("validation_failed");
  });
});

describe("GET /api/tool-catalog", () => {
  beforeEach(() => _clearCatalogForTests());

  it("returns empty listing when nothing registered", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/api/tool-catalog" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      entries: [],
      total: 0,
      offset: 0,
      limit: 20,
    });
  });

  it("filters by capabilityType", async () => {
    const app = makeApp();
    await app.inject({
      method: "POST",
      url: "/api/tool-catalog/register",
      payload: SAMPLE,
    });
    await app.inject({
      method: "POST",
      url: "/api/tool-catalog/register",
      payload: {
        ...SAMPLE,
        packageName: "@lamasu/kernel-automata-linq",
        name: "Automata LINQ kernel",
        repoUrl: "https://github.com/LamaSu/kernel-automata-linq",
        capabilityTypes: ["lab-automation/v1"],
      },
    });
    const liquid = await app.inject({
      method: "GET",
      url: "/api/tool-catalog?capabilityType=liquid-handling",
    });
    expect(liquid.json().total).toBe(1);
    const lab = await app.inject({
      method: "GET",
      url: "/api/tool-catalog?capabilityType=lab-automation/v1",
    });
    expect(lab.json().total).toBe(2);
  });

  it("paginates with offset+limit", async () => {
    const app = makeApp();
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: "POST",
        url: "/api/tool-catalog/register",
        payload: {
          ...SAMPLE,
          packageName: `@lamasu/tool-${i}`,
          name: `tool ${i}`,
          repoUrl: `https://github.com/LamaSu/tool-${i}`,
        },
      });
    }
    const res = await app.inject({
      method: "GET",
      url: "/api/tool-catalog?offset=2&limit=2",
    });
    const body = res.json();
    expect(body.total).toBe(5);
    expect(body.entries.length).toBe(2);
    expect(body.offset).toBe(2);
    expect(body.limit).toBe(2);
  });
});

describe("GET /api/tool-catalog/by-type/:type", () => {
  beforeEach(() => _clearCatalogForTests());

  it("returns tools implementing a capability type", async () => {
    const app = makeApp();
    await app.inject({
      method: "POST",
      url: "/api/tool-catalog/register",
      payload: SAMPLE,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/tool-catalog/by-type/liquid-handling",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.capabilityType).toBe("liquid-handling");
    expect(body.count).toBe(1);
    expect(body.tools[0].packageName).toBe(SAMPLE.packageName);
  });

  it("returns empty when no tools match", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/tool-catalog/by-type/imaginary-type",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(0);
  });
});

describe("GET /api/tool-catalog/:id", () => {
  beforeEach(() => _clearCatalogForTests());

  it("returns entry by id", async () => {
    const app = makeApp();
    const reg = await app.inject({
      method: "POST",
      url: "/api/tool-catalog/register",
      payload: SAMPLE,
    });
    const id = reg.json().id;
    const res = await app.inject({
      method: "GET",
      url: `/api/tool-catalog/${id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
  });

  it("returns entry by packageName", async () => {
    const app = makeApp();
    await app.inject({
      method: "POST",
      url: "/api/tool-catalog/register",
      payload: SAMPLE,
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/tool-catalog/${encodeURIComponent(SAMPLE.packageName)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().packageName).toBe(SAMPLE.packageName);
  });

  it("returns 404 for unknown id", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/tool-catalog/tool_unknown",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/tool-catalog/bounty (type-level demand)", () => {
  beforeEach(() => _clearCatalogForTests());

  it("routes a bounty to all tools matching the capability type", async () => {
    const app = makeApp();
    await app.inject({
      method: "POST",
      url: "/api/tool-catalog/register",
      payload: SAMPLE,
    });
    await app.inject({
      method: "POST",
      url: "/api/tool-catalog/register",
      payload: {
        ...SAMPLE,
        packageName: "@lamasu/another-lab-tool",
        name: "Another lab tool",
        repoUrl: "https://github.com/LamaSu/another-lab-tool",
        capabilityTypes: ["lab-automation/v1"],
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/tool-catalog/bounty",
      payload: {
        capabilityType: "lab-automation/v1",
        description: "Need automated plating for screening 96-well plates.",
        budgetUSD: 500,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.bountyId).toMatch(/^bty_/);
    expect(body.matchingToolsNotified).toBe(2);
    expect(body.matchingTools.length).toBe(2);
    expect(body.expiresAt).toBeDefined();
  });

  it("filters by preferredMaintainers when supplied", async () => {
    const app = makeApp();
    await app.inject({
      method: "POST",
      url: "/api/tool-catalog/register",
      payload: SAMPLE,
    });
    await app.inject({
      method: "POST",
      url: "/api/tool-catalog/register",
      payload: {
        ...SAMPLE,
        packageName: "@other/tool",
        repoUrl: "https://github.com/other/tool",
        maintainerDid: "did:erc8004:0xOTHER",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/tool-catalog/bounty",
      payload: {
        capabilityType: "lab-automation/v1",
        description: "Specific maintainer only.",
        budgetUSD: 250,
        preferredMaintainers: ["did:erc8004:0xLAMASU"],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().matchingToolsNotified).toBe(1);
  });

  it("rejects invalid bounty payload", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/tool-catalog/bounty",
      payload: { capabilityType: "" },
    });
    expect(res.statusCode).toBe(400);
  });
});
