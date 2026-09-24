/**
 * Hosting-space routes never pass fixtures off as live data (board N34, the server side
 * of PX-3).
 *
 * /api/spaces and /api/spaces/:id answered from two hard-coded spaces (names, street
 * addresses, operator wallets, power, slots, ratings), and POST /api/spaces/match scored
 * them with Math.random(): a 70-95 "matchScore" with no basis, different on every call.
 *
 * Now, unless PCC_DEMO_ROUTES=true, every route answers 501 not_available before anything
 * is parsed or scored. With the flag, the old answers come back marked mock/demo. The gate
 * is one onRequest hook encapsulated to the spaces plugin; the last block proves it
 * reaches no other plugin.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { spaceRoutes } from "../routes/spaces.js";
import { kernelRoutes } from "../routes/kernels.js";
import { initStore, closeStore } from "../db.js";

// Values only the fixtures carry. None may appear in a refusal.
const FIXTURE =
  /space-bk|space-sf|Brooklyn|SF Fabrication|Townsend|Industrial Rd|0x(a{40}|b{40})|Fume hood|Cleanroom|Loading dock|matchScore|availableSlots/;
const MESSAGE = "Hosting space data is not recorded on this gateway, so nothing is returned rather than an example.";

type Case = {
  method: "GET" | "POST";
  url: string;
  payload?: Record<string, unknown>;
  /** The old (pre-gate) answer, which demo mode must still give. */
  old: (body: any) => void;
};

const CASES: Case[] = [
  { method: "GET", url: "/api/spaces", old: (b) => expect(b.spaces).toHaveLength(2) },
  // The old filters still apply in demo mode.
  { method: "GET", url: "/api/spaces?maxSqft=1000", old: (b) => expect(b.spaces.map((s: { id: string }) => s.id)).toEqual(["space-sf"]) },
  { method: "GET", url: "/api/spaces/space-sf", old: (b) => expect(b.space.name).toBe("SF Fabrication Center") },
  {
    method: "POST",
    url: "/api/spaces/match",
    payload: { voltage: 480 },
    old: (b) => {
      expect(b.matches.map((m: { id: string }) => m.id)).toEqual(["space-sf"]);
      expect(b.matches[0].matchScore).toBeGreaterThanOrEqual(70);
      expect(b.matches[0].matchScore).toBeLessThanOrEqual(95);
    },
  },
];

const ENV = ["PCC_DEMO_ROUTES", "PCC_DB_PATH"] as const;
const saved: Record<string, string | undefined> = {};
let app: FastifyInstance;

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  delete process.env.PCC_DEMO_ROUTES;
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  app = Fastify({ logger: false });
  // Siblings: a root route declared before the plugin, and a real DB-backed plugin
  // registered after it (the order in which a leaked hook would reach it).
  app.get("/probe/root", async () => ({ ok: true }));
  await app.register(spaceRoutes);
  await app.register(kernelRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeStore();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  delete process.env.PCC_DEMO_ROUTES;
});

const call = (c: Pick<Case, "method" | "url" | "payload">) => app.inject({ method: c.method, url: c.url, payload: c.payload });

describe("NEGATIVE: without PCC_DEMO_ROUTES every spaces route refuses (501 not_available)", () => {
  for (const c of CASES) {
    it(`${c.method} ${c.url} -> 501 and nothing from the fixtures`, async () => {
      const res = await call(c);
      expect(res.statusCode, res.body).toBe(501);
      const body = res.json();
      // The refusal is the whole body: nothing else rides along.
      expect(body).toEqual({ error: "not_available", message: MESSAGE, see: [] });
      expect(res.body).not.toMatch(FIXTURE);
      expect(res.headers["x-pcc-demo"]).toBeUndefined();
    });
  }

  it("only the literal \"true\" turns demo on", async () => {
    for (const v of ["false", "1", "TRUE", "yes", ""]) {
      process.env.PCC_DEMO_ROUTES = v;
      const res = await call({ method: "POST", url: "/api/spaces/match", payload: {} });
      expect(res.statusCode, `PCC_DEMO_ROUTES=${JSON.stringify(v)}`).toBe(501);
    }
  });

  it("/match refuses a malformed body with 501, not a 400: the gate runs before parsing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/spaces/match",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe("not_available");
  });

  it("an unknown id is refused the same way (no fixture lookup, no not_found oracle)", async () => {
    const res = await call({ method: "GET", url: "/api/spaces/space-none" });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe("not_available");
  });
});

describe("PCC_DEMO_ROUTES=true: the old answers, each marked mock/demo", () => {
  beforeEach(() => {
    process.env.PCC_DEMO_ROUTES = "true";
  });

  for (const c of CASES) {
    it(`${c.method} ${c.url} -> 200 with mock:true, demo:true`, async () => {
      const res = await call(c);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ mock: true, demo: true });
      expect(res.headers["x-pcc-demo"]).toBe("true");
      c.old(body);
    });
  }

  it("the old not_found answer stays as it was (200), and is marked demo too", async () => {
    const res = await call({ method: "GET", url: "/api/spaces/space-none" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ error: "not_found", mock: true, demo: true });
  });
});

describe("the gate is encapsulated to the spaces plugin", () => {
  for (const demo of [false, true]) {
    it(`siblings are untouched with PCC_DEMO_ROUTES ${demo ? "on" : "off"}`, async () => {
      if (demo) process.env.PCC_DEMO_ROUTES = "true";
      const kernels = await app.inject({ method: "GET", url: "/api/kernels" });
      expect(kernels.statusCode, kernels.body).toBe(200);
      expect(kernels.json().kernels.length).toBeGreaterThan(0);
      expect(kernels.json()).not.toHaveProperty("mock");
      expect(kernels.json()).not.toHaveProperty("demo");
      expect(kernels.headers["x-pcc-demo"]).toBeUndefined();

      const root = await app.inject({ method: "GET", url: "/probe/root" });
      expect(root.statusCode).toBe(200);
      expect(root.json()).toEqual({ ok: true });
      expect(root.headers["x-pcc-demo"]).toBeUndefined();
    });
  }

  it("control: the same plugin with skip-override WOULD gate a sibling, so the check above can fail", async () => {
    const leaky = Object.assign(async (i: FastifyInstance) => spaceRoutes(i), {
      [Symbol.for("skip-override")]: true,
    });
    const probe = Fastify({ logger: false });
    await probe.register(leaky);
    probe.get("/probe/after", async () => ({ ok: true }));
    await probe.ready();
    try {
      const res = await probe.inject({ method: "GET", url: "/probe/after" });
      expect(res.statusCode).toBe(501);
    } finally {
      await probe.close();
    }
  });
});
