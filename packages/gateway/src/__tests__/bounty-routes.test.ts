/**
 * Bounty route honesty tests (kits K0, ledger R7/R45).
 *
 * The in-memory bounty surface must never present unfunded demand as funded,
 * leak requester data, publish demand aggregates, or accept a caller's own
 * verification verdict. Uses Fastify's inject() instead of a real port.
 *
 * The route module holds one shared BountyService, so each test uses its own
 * capability type to stay independent of the others.
 */

import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { bountyRoutes, _bountyServiceForTests } from "../routes/bounty.js";

function makeApp() {
  const app = Fastify({ logger: false });
  void app.register(bountyRoutes);
  return app;
}

function demand(capabilityType: string, requesterId: string, extra: Record<string, unknown> = {}) {
  return {
    requesterId,
    capabilityType,
    description: `private need of ${requesterId}`,
    estimatedJobValue: 5000,
    estimatedFrequency: "daily",
    location: "private site, Building 7",
    assuranceTier: 2,
    ...extra,
  };
}

describe("POST /api/bounty/demand", () => {
  it("never auto-creates a bounty, even when both treasury thresholds fire", async () => {
    const app = makeApp();
    // Three distinct requesters AND an annual value far above $10K.
    for (const r of ["r1", "r2", "r3"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/bounty/demand",
        payload: demand("kits-test-no-autobounty", r),
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().autoBountiesCreated).toBe(0);
      expect(res.json().autoBounties).toEqual([]);
    }

    const list = await app.inject({
      method: "GET",
      url: "/api/bounty/list?capabilityType=kits-test-no-autobounty",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(0);
  });
});

describe("GET /api/bounty/demand", () => {
  it("returns only the public fields of each signal", async () => {
    const app = makeApp();
    await app.inject({
      method: "POST",
      url: "/api/bounty/demand",
      payload: demand("kits-test-redaction", "secret-requester"),
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/bounty/demand?capabilityType=kits-test-redaction",
    });
    expect(res.statusCode).toBe(200);
    const [signal] = res.json().signals;
    expect(Object.keys(signal).sort()).toEqual(
      ["assuranceTier", "capabilityType", "createdAt", "estimatedFrequency", "id", "status"],
    );
    const raw = res.body;
    expect(raw).not.toContain("secret-requester");
    expect(raw).not.toContain("private need");
    expect(raw).not.toContain("Building 7");
    expect(raw).not.toContain("estimatedJobValue");
  });
});

describe("GET /api/bounty/demand/top", () => {
  it("publishes no demand aggregate while requester identity is self-asserted", async () => {
    const app = makeApp();
    for (const r of ["a", "b", "c", "d", "e", "f"]) {
      await app.inject({
        method: "POST",
        url: "/api/bounty/demand",
        payload: demand("kits-test-aggregate", r),
      });
    }

    const res = await app.inject({ method: "GET", url: "/api/bounty/demand/top?limit=50" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.demand).toEqual([]);
    expect(body.suppressed).toBe(true);
    expect(body.reason).toMatch(/R29\/N2/);
    expect(res.body).not.toContain("kits-test-aggregate");
  });
});

describe("POST /api/bounty/verify", () => {
  it("refuses a caller-supplied verification with 410, whatever the payload", async () => {
    const app = makeApp();
    for (const payload of [
      { bountyId: "bounty-anything", jobId: "job-1", score: 1 },
      { bountyId: "bounty-anything", jobId: "job-1", score: 0.7 },
      {},
    ]) {
      const res = await app.inject({ method: "POST", url: "/api/bounty/verify", payload });
      expect(res.statusCode).toBe(410);
      expect(res.json().error).toBe("gone");
    }
  });

  it("changes no state: a claimed bounty stays claimed after a passing caller score", async () => {
    const app = makeApp();
    // Seed a claimed bounty directly; no route can create one any more.
    const svc = _bountyServiceForTests();
    const bounty = svc.createBounty({
      capabilityType: "kits-test-verify",
      description: "seeded for the verify test",
      bountyReward: 100,
      currency: "USDC",
      requirements: { minimumAssuranceTier: 1, mustComplete1Job: true, mustPassVerification: true },
      expiresInDays: 30,
    });
    svc.claimBounty(bounty.id, "operator-seeded");

    const res = await app.inject({
      method: "POST",
      url: "/api/bounty/verify",
      payload: { bountyId: bounty.id, jobId: "job-x", score: 0.99 },
    });
    expect(res.statusCode).toBe(410);

    const list = await app.inject({
      method: "GET",
      url: "/api/bounty/list?capabilityType=kits-test-verify",
    });
    const [after] = list.json().bounties;
    expect(after.status).toBe("claimed");
    expect(after.verificationScore).toBeUndefined();
    expect(after.fundingStatus).toBe("unfunded");
  });
});
