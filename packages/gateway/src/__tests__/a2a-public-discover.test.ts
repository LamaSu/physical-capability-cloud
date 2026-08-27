/**
 * POST /a2a/tasks/send — the discovery skill is PUBLIC, everything else is not.
 *
 * Coord #1667 / sol's verdict on #1659: a third-party host (a Runtype-hosted
 * agent, another team's agent reading our A2A card) must be able to discover
 * PCC capabilities with NO PCC credential existing on that host. The reads are
 * the same CapabilityFacade calls behind the already-public GET
 * /api/capabilities*, so the exposure delta is zero.
 *
 * The thing that must NOT change: pcc-submit reaches commitPccSession and
 * mints escrow. If anonymous callers can reach it, the A-1 side-door is open
 * again. So this file tests the DENY side as hard as the allow side, and the
 * negative control at the bottom is the one that matters — delete the skill
 * allowlist and the anon-submit test must go red.
 *
 * Unlike a2a-tasks.test.ts, this suite runs with AUTH ON
 * (PCC_A2A_AUTH_DISABLED unset). That is the whole point.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { a2aTasksRoutes, __resetA2ATasksForTest } from "../routes/a2a-tasks.js";
import { __resetAnonA2aDiscoverForTest } from "../middleware/security-hardening.js";
import { initStore, closeStore, getStore } from "../db.js";
import { schema } from "@pcc/store";

const { shopKernels, capabilities } = schema;

async function buildAppWithAuthOn(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  delete process.env.PCC_A2A_AUTH_DISABLED; // AUTH ON — the point of this suite
  initStore({ seed: true });

  const { db } = getStore();
  const now = new Date().toISOString();
  try {
    db.insert(shopKernels).values({
      id: "kernel-pub-discover",
      name: "Public Discover Kernel",
      operatorAddress: "0xpub",
      location: { lat: 0, lng: 0 },
      physicalAddress: "test",
      maxAssuranceTier: 2,
      publicKey: "pub-key",
      reputation: 0,
      totalJobsCompleted: 0,
      status: "online",
      registeredAt: now,
      lastHeartbeat: now,
      version: "1.0.0",
    } as any).run();
    db.insert(capabilities).values({
      id: "cap-pub-discover-fdm",
      kernelId: "kernel-pub-discover",
      type: "fdm",
      name: "Public Discover FDM",
      description: "findable without a bearer",
      materials: ["PLA"],
      assuranceTiers: [0, 1],
      pricing: { currency: "USDC", baseCost: "10", minimum: "5" },
      location: { lat: 0, lng: 0 },
      queueDepth: 0,
      availability: { timezone: "UTC", windows: {} },
    } as any).run();
  } catch {
    // seeded already
  }

  const app = Fastify({ logger: false });
  await app.register(a2aTasksRoutes);
  await app.ready();
  return app;
}

function send(app: FastifyInstance, method: string, params: unknown, id = "t1") {
  return app.inject({
    method: "POST",
    url: "/a2a/tasks/send",
    headers: { "content-type": "application/json" },
    // NO Authorization header — every request in this file is anonymous.
    payload: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

const AUTH_REQUIRED = -32600;
const RATE_LIMITED = -32000;

describe("anonymous POST /a2a/tasks/send — discovery is public", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildAppWithAuthOn();
  });
  afterAll(async () => {
    await app.close();
    closeStore();
  });
  beforeEach(() => {
    __resetA2ATasksForTest();
    __resetAnonA2aDiscoverForTest();
  });

  it("discover_capability (the card alias) returns REAL results with no bearer", async () => {
    const res = await send(app, "tasks/send", {
      skill: "discover_capability",
      params: { query: "fdm" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error, JSON.stringify(body.error)).toBeUndefined();
    // Existence is not evidence: the artifact must carry the seeded capability,
    // not merely "no auth error".
    const text = JSON.stringify(body.result);
    expect(text).toContain("cap-pub-discover-fdm");
  });

  it("pcc-discover (the canonical name) is public too", async () => {
    const res = await send(app, "tasks/send", {
      skill: "pcc-discover",
      params: { query: "fdm" },
    });
    const body = res.json();
    expect(body.error).toBeUndefined();
    expect(JSON.stringify(body.result)).toContain("cap-pub-discover-fdm");
  });

  it("skillId spelling is honoured the same as skill", async () => {
    const res = await send(app, "tasks/send", {
      skillId: "discover_capability",
      params: { query: "fdm" },
    });
    expect(res.json().error).toBeUndefined();
  });
});

describe("anonymous POST /a2a/tasks/send — everything else stays gated", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildAppWithAuthOn();
  });
  afterAll(async () => {
    await app.close();
    closeStore();
  });
  beforeEach(() => {
    __resetA2ATasksForTest();
    __resetAnonA2aDiscoverForTest();
  });

  it("hire_capability / pcc-submit — the escrow-minting path — is REFUSED without a bearer", async () => {
    // This is the A-1 side-door. If this test ever passes without auth, stop.
    for (const skill of ["hire_capability", "pcc-submit"]) {
      const res = await send(app, "tasks/send", {
        skill,
        params: { kernelId: "kernel-pub-discover", capabilityType: "fdm" },
      });
      const body = res.json();
      expect(body.error?.code, `${skill} must require auth`).toBe(AUTH_REQUIRED);
      expect(body.error?.message).toMatch(/authentication required/);
    }
  });

  it("pcc-quote, pcc-verify, pcc-settle are refused without a bearer", async () => {
    for (const skill of ["pcc-quote", "pcc-verify", "pcc-settle"]) {
      const res = await send(app, "tasks/send", { skill, params: {} });
      expect(res.json().error?.code, `${skill} must require auth`).toBe(AUTH_REQUIRED);
    }
  });

  it("tasks/get and tasks/cancel are refused without a bearer — a task is private to its creator", async () => {
    for (const method of ["tasks/get", "tasks/cancel"]) {
      const res = await send(app, method, { id: "does-not-matter" });
      expect(res.json().error?.code, `${method} must require auth`).toBe(AUTH_REQUIRED);
    }
  });

  it("a tasks/send with NO skill is refused — an unnamed task is not discovery", async () => {
    const res = await send(app, "tasks/send", { params: { query: "fdm" } });
    expect(res.json().error?.code).toBe(AUTH_REQUIRED);
  });

  it("a non-string skill cannot smuggle past the allowlist", async () => {
    const res = await send(app, "tasks/send", {
      skill: ["discover_capability"],
      params: { query: "fdm" },
    });
    expect(res.json().error?.code).toBe(AUTH_REQUIRED);
  });
});

describe("anonymous discovery is rate-limited per IP — public is not unbounded", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildAppWithAuthOn();
  });
  afterAll(async () => {
    await app.close();
    closeStore();
  });
  beforeEach(() => {
    __resetA2ATasksForTest();
    __resetAnonA2aDiscoverForTest();
  });

  it("the first call succeeds and a sustained burst from one IP is eventually refused with -32000", async () => {
    // Every tasks/send stores a task in the gateway's in-memory map. Without a
    // cap, anonymous discovery is a memory-fill vector. inject() presents one
    // remote address for every call, which is exactly the attacker shape.
    const first = await send(app, "tasks/send", {
      skill: "discover_capability",
      params: { query: "fdm" },
    });
    expect(first.json().error).toBeUndefined();

    let limited = 0;
    let limitedAt = -1;
    for (let i = 0; i < 80; i++) {
      const res = await send(app, "tasks/send", {
        skill: "discover_capability",
        params: { query: "fdm" },
      }, `burst-${i}`);
      const code = res.json().error?.code;
      if (code === RATE_LIMITED) {
        limited++;
        if (limitedAt < 0) limitedAt = i;
      } else {
        expect(code, `unexpected error at call ${i}`).toBeUndefined();
      }
    }
    expect(limited, "burst must be capped").toBeGreaterThan(0);
    // Sanity: the cap is a real number, not 0 (which would break legitimate
    // agents) and not absent (which would be the memory-fill hole).
    expect(limitedAt).toBeGreaterThan(10);
  });

  it("the rate-limit message tells the caller how to get more — authenticate", async () => {
    for (let i = 0; i < 70; i++) {
      await send(app, "tasks/send", { skill: "pcc-discover", params: { query: "fdm" } }, `b${i}`);
    }
    const res = await send(app, "tasks/send", { skill: "pcc-discover", params: { query: "fdm" } });
    const err = res.json().error;
    expect(err?.code).toBe(RATE_LIMITED);
    expect(err?.message).toMatch(/Authenticate/);
  });
});
