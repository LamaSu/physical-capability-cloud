/**
 * Logistics routes never pass fixtures off as live data (board N34, the server side of PX-3).
 *
 * Every /api/logistics/* route answered from hard-coded fixtures: three providers with
 * contact details and ratings, two shipments with tracking and condition readings, space
 * bookings, installation orders, a timeline, counts over all of those, and a quote priced
 * by a made-up formula under two fixture providers' names. The PATCH route edited a
 * fixture in memory.
 *
 * Now, unless PCC_DEMO_ROUTES=true, every route answers 501 not_available before anything
 * is read, priced, parsed or changed. With the flag, the old answers come back marked
 * mock/demo. The gate is one onRequest hook encapsulated to the logistics plugin; the last
 * block proves it reaches no other plugin.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { logisticsRoutes } from "../routes/logistics.js";
import { kernelRoutes } from "../routes/kernels.js";
import { initStore, closeStore } from "../db.js";

// Values only the fixtures carry (ids, names, people, addresses, wallets, phone numbers,
// fixture-only keys). None may appear in a refusal.
const FIXTURE =
  /prov-|Riggers|Precision Equipment|Flatbed|shp-0|book-0|inst-0|tle-0|quot-|Prusa|Haas|Brooklyn|Ryan George|0x(a{40}|c{40}|d{40})|555-0|USDC|inTransit|trackingEvents/;
const CARRIER = ["GET /api/carrier/shipments/:jobId"];

type Case = {
  method: "GET" | "POST" | "PATCH";
  url: string;
  payload?: Record<string, unknown>;
  see: string[];
  /** The old (pre-gate) answer, which demo mode must still give. */
  old: (body: any) => void;
};

const CASES: Case[] = [
  { method: "GET", url: "/api/logistics/providers", see: [], old: (b) => expect(b.providers).toHaveLength(3) },
  {
    method: "GET",
    url: "/api/logistics/providers/prov-riggers",
    see: [],
    old: (b) => expect(b.provider.name).toBe("Northeast Riggers & Movers"),
  },
  { method: "GET", url: "/api/logistics/shipments", see: CARRIER, old: (b) => expect(b.shipments).toHaveLength(2) },
  { method: "GET", url: "/api/logistics/shipments/shp-001", see: CARRIER, old: (b) => expect(b.shipment.id).toBe("shp-001") },
  {
    method: "POST",
    url: "/api/logistics/shipments/quote",
    payload: { weightKg: 100, priority: "rush" },
    see: [],
    // (100 * 0.8 + 150) * 2.5: the made-up formula, unchanged in demo mode.
    old: (b) => expect(b.quotes.map((q: { price: string }) => q.price)).toEqual(["575.00", "661.25"]),
  },
  { method: "GET", url: "/api/logistics/bookings", see: [], old: (b) => expect(b.bookings).toHaveLength(2) },
  { method: "GET", url: "/api/logistics/bookings/book-001", see: [], old: (b) => expect(b.booking.slotPosition).toBe("Bay 3") },
  { method: "GET", url: "/api/logistics/installations", see: [], old: (b) => expect(b.installations).toHaveLength(2) },
  {
    method: "GET",
    url: "/api/logistics/installations/inst-001",
    see: [],
    old: (b) => expect(b.installation.steps).toHaveLength(10),
  },
  {
    method: "PATCH",
    url: "/api/logistics/installations/inst-002/steps/inst-002-s3",
    payload: { status: "in_progress" },
    see: [],
    old: (b) => expect(b.step).toMatchObject({ id: "inst-002-s3", status: "in_progress", startedAt: expect.any(String) }),
  },
  // A carrier shipment's tracking events are the only logistics events the gateway records.
  { method: "GET", url: "/api/logistics/timeline", see: CARRIER, old: (b) => expect(b.events[0].id).toBe("tle-05") },
  {
    method: "GET",
    url: "/api/logistics/summary",
    see: [],
    old: (b) => expect(b).toMatchObject({ shipments: { total: 2, inTransit: 1 }, providers: { total: 3 } }),
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
  await app.register(logisticsRoutes);
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

describe("NEGATIVE: without PCC_DEMO_ROUTES every logistics route refuses (501 not_available)", () => {
  for (const c of CASES) {
    it(`${c.method} ${c.url} -> 501 and nothing from the fixtures`, async () => {
      const res = await call(c);
      expect(res.statusCode, res.body).toBe(501);
      const body = res.json();
      // The refusal is the whole body: nothing else rides along.
      expect(Object.keys(body).sort()).toEqual(["error", "message", "see"]);
      expect(body.error).toBe("not_available");
      expect(body.message).toMatch(/ is not recorded on this gateway, so .*nothing is returned rather than an example\.$/);
      expect(body.see).toEqual(c.see);
      expect(res.body).not.toMatch(FIXTURE);
      expect(res.headers["x-pcc-demo"]).toBeUndefined();
    });
  }

  it("only the literal \"true\" turns demo on", async () => {
    for (const v of ["false", "1", "TRUE", "yes", ""]) {
      process.env.PCC_DEMO_ROUTES = v;
      const res = await call({ method: "GET", url: "/api/logistics/providers" });
      expect(res.statusCode, `PCC_DEMO_ROUTES=${JSON.stringify(v)}`).toBe(501);
    }
  });

  it("an unknown id is refused the same way (no fixture lookup, no not_found oracle)", async () => {
    const res = await call({ method: "GET", url: "/api/logistics/shipments/shp-999" });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe("not_available");
  });
});

describe("NEGATIVE: the installation-step PATCH refuses before anything is parsed or changed", () => {
  it("refuses a malformed body with 501, not a 400: the gate runs before parsing", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/logistics/installations/inst-001/steps/inst-001-s1",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().message).toContain("no step was updated");
  });

  it("a refused PATCH leaves the fixture untouched", async () => {
    const refused = await call({
      method: "PATCH",
      url: "/api/logistics/installations/inst-001/steps/inst-001-s1",
      payload: { status: "completed", completedBy: "mallory", notes: "forged sign-off" },
    });
    expect(refused.statusCode).toBe(501);

    process.env.PCC_DEMO_ROUTES = "true";
    const after = await call({ method: "GET", url: "/api/logistics/installations/inst-001" });
    const step = after.json().installation.steps.find((s: { id: string }) => s.id === "inst-001-s1");
    expect(step.status).toBe("pending");
    expect(step.completedBy).toBeUndefined();
    expect(step.completedAt).toBeUndefined();
    expect(step.notes).toBeUndefined();
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
    const res = await call({ method: "GET", url: "/api/logistics/providers/prov-none" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ error: "not_found", mock: true, demo: true });
  });
});

describe("the gate is encapsulated to the logistics plugin", () => {
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
    const leaky = Object.assign(async (i: FastifyInstance) => logisticsRoutes(i), {
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
