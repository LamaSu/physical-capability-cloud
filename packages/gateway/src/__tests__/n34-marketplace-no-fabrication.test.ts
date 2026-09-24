/**
 * No fixture in production (board N34, the server side of PX-3), family "marketplace".
 *
 * Every /api/marketplace route but one used to answer from invented data: equipment
 * classes with made-up machine counts, utilization and job values, a sine-wave price
 * history and demand curve, supplier listings and orders. Its writes pushed into those
 * fixtures and wrote a telemetry event and an audit entry for a listing or order that
 * exists nowhere.
 *
 * Now, unless PCC_DEMO_ROUTES=true, each such route answers 501 not_available BEFORE any
 * fixture is read or changed. In demo, the old answers stay and are marked mock/demo.
 * GET /categories keeps the real taxonomy (the spec's MarketplaceCategory) and nulls the
 * fixture-derived counts. POST /roi, a calculator over the caller's own inputs, is unchanged.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { marketplaceRoutes } from "../routes/marketplace.js";
import { initStore, closeStore } from "../db.js";
import { auditService } from "../services/audit-service.js";

type Method = "GET" | "POST" | "PUT" | "DELETE";

let app: FastifyInstance;
let savedDemo: string | undefined;

beforeAll(async () => {
  savedDemo = process.env.PCC_DEMO_ROUTES;
  delete process.env.PCC_DEMO_ROUTES;
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  app = Fastify({ logger: false });
  await app.register(marketplaceRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeStore();
  if (savedDemo === undefined) delete process.env.PCC_DEMO_ROUTES;
  else process.env.PCC_DEMO_ROUTES = savedDemo;
});

beforeEach(() => {
  delete process.env.PCC_DEMO_ROUTES;
});

const req = (method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as any });

/** Values only the fixtures contain. None may reach a refusal. */
const FIXTURE =
  /ec-fdm|ec-cnc|FDM 3D Printer|networkMachineCount|averageUtilization|averageJobValue|trendPercent|"priceHistory"|"timeline"|"demand"|"supply"|lst-al6061-bar|lst-purexpress|supplier-metalcraft-us|supplier-neb-us|PURExpress|Aluminum 6061|US-Midwest|ord-demo-00|kernel-biopunk-lab/;

const FIXTURE_LISTING_IDS = [
  "lst-al6061-bar",
  "lst-pla-175mm",
  "lst-purexpress",
  "lst-96well-pcr",
  "lst-fr4-pcb-blank",
  "lst-endmill-14-4fl",
];
const NEW_LISTING = { name: "N34 probe listing", category: "tooling", pricePerUnit: 9, unit: "each" };
const NEW_ORDER = { listingId: "lst-al6061-bar", quantity: 2 };
const EQUIPMENT_SEE = ["/api/capabilities/types", "/api/capabilities/templates", "/api/kernels/marketplace"];
const CLASS_DETAIL_SEE = ["/api/capabilities/templates", "/api/capabilities/by-type/:type", "/api/kernels/marketplace"];
const LISTINGS_SAY = /^Marketplace supply listings are not recorded on this gateway, so nothing is returned rather than an example\.$/;
const ORDERS_SAY = /^Marketplace supply orders are not recorded on this gateway, so nothing is returned rather than an example\.$/;

interface Gated {
  method: Method;
  url: string;
  body?: unknown;
  see: string[];
  says: RegExp;
  demoStatus: number;
  /** The demo answer keeps the old shape. */
  demo: (body: any) => void;
}

// SERVED-MOCK routes. Order matters for the demo pass only: the writes run last.
const GATED: Gated[] = [
  {
    method: "GET",
    url: "/api/marketplace/classes",
    see: EQUIPMENT_SEE,
    says: /^Equipment classes and their market snapshots are not recorded on this gateway, so nothing is returned rather than an example\.$/,
    demoStatus: 200,
    demo: (b) => {
      expect(b.classes).toHaveLength(6);
      expect(b.classes[0]).toMatchObject({ id: "ec-fdm", snapshot: { networkMachineCount: 47 } });
    },
  },
  {
    method: "GET",
    url: "/api/marketplace/classes/ec-fdm",
    see: CLASS_DETAIL_SEE,
    says: /^Equipment class details, market snapshots and price history are not recorded on this gateway/,
    demoStatus: 200,
    demo: (b) => {
      expect(b.class.id).toBe("ec-fdm");
      expect(b.priceHistory).toHaveLength(30);
    },
  },
  {
    method: "GET",
    url: "/api/marketplace/demand-supply",
    see: ["/api/jobs", "/api/kernels"],
    says: /^A network demand and supply timeline is not recorded on this gateway, so nothing is returned rather than an example\.$/,
    demoStatus: 200,
    demo: (b) => expect(b.timeline).toHaveLength(12),
  },
  {
    method: "GET",
    url: "/api/marketplace/listings",
    see: [],
    says: LISTINGS_SAY,
    demoStatus: 200,
    demo: (b) => expect(b.listings.map((l: { id: string }) => l.id)).toEqual(expect.arrayContaining(["lst-al6061-bar"])),
  },
  {
    method: "GET",
    url: "/api/marketplace/listings/lst-al6061-bar",
    see: [],
    says: LISTINGS_SAY,
    demoStatus: 200,
    demo: (b) => expect(b.listing.id).toBe("lst-al6061-bar"),
  },
  {
    method: "GET",
    url: "/api/marketplace/orders",
    see: [],
    says: ORDERS_SAY,
    demoStatus: 200,
    demo: (b) => expect(b.orders.map((o: { id: string }) => o.id)).toEqual(expect.arrayContaining(["ord-demo-001", "ord-demo-002"])),
  },
  {
    method: "GET",
    url: "/api/marketplace/orders/ord-demo-001",
    see: [],
    says: ORDERS_SAY,
    demoStatus: 200,
    demo: (b) => expect(b).toMatchObject({ order: { id: "ord-demo-001" }, listing: { id: "lst-al6061-bar" } }),
  },
  {
    method: "POST",
    url: "/api/marketplace/listings",
    body: NEW_LISTING,
    see: [],
    says: /^Marketplace supply listings are not recorded on this gateway, so nothing was created\.$/,
    demoStatus: 201,
    demo: (b) => expect(b.listing).toMatchObject({ name: NEW_LISTING.name, category: "tooling" }),
  },
  {
    method: "PUT",
    url: "/api/marketplace/listings/lst-pla-175mm",
    body: { pricePerUnit: 1 },
    see: [],
    says: /^Marketplace supply listings are not recorded on this gateway, so nothing was changed\.$/,
    demoStatus: 200,
    demo: (b) => expect(b.listing).toMatchObject({ id: "lst-pla-175mm", pricePerUnit: 1 }),
  },
  {
    method: "DELETE",
    url: "/api/marketplace/listings/lst-endmill-14-4fl",
    see: [],
    says: /^Marketplace supply listings are not recorded on this gateway, so nothing was deleted\.$/,
    demoStatus: 200,
    demo: (b) => expect(b).toMatchObject({ deleted: true, id: "lst-endmill-14-4fl" }),
  },
  {
    method: "POST",
    url: "/api/marketplace/orders",
    body: NEW_ORDER,
    see: [],
    says: /^Marketplace supply orders are not recorded on this gateway, so no order was placed\.$/,
    demoStatus: 201,
    demo: (b) => expect(b.order).toMatchObject({ listingId: "lst-al6061-bar", quantity: 2, status: "pending" }),
  },
];

describe("NEGATIVE: outside demo, a fixture route refuses with 501 not_available", () => {
  for (const c of GATED) {
    it(`${c.method} ${c.url} -> 501, no fixture value in the body`, async () => {
      const res = await req(c.method, c.url, c.body);
      expect(res.statusCode, res.body).toBe(501);
      const body = res.json();
      expect(Object.keys(body).sort()).toEqual(["error", "message", "see"]);
      expect(body.error).toBe("not_available");
      expect(body.message).toMatch(c.says);
      expect(body.see).toEqual(c.see);
      expect(res.body).not.toMatch(FIXTURE);
    });
  }

  it("a write is refused before its input is even checked (an empty body is 501, not 400)", async () => {
    expect((await req("POST", "/api/marketplace/listings", {})).statusCode).toBe(501);
    expect((await req("POST", "/api/marketplace/orders", {})).statusCode).toBe(501);
  });

  it("an unknown id is 501 too, so the refusal does not reveal which fixture ids exist", async () => {
    for (const url of ["/api/marketplace/classes/nope", "/api/marketplace/listings/nope", "/api/marketplace/orders/nope"]) {
      expect((await req("GET", url)).statusCode).toBe(501);
    }
    expect((await req("PUT", "/api/marketplace/listings/nope", { pricePerUnit: 1 })).statusCode).toBe(501);
    expect((await req("DELETE", "/api/marketplace/listings/nope")).statusCode).toBe(501);
  });

  it("a refused write changes no fixture and writes no audit entry", async () => {
    const audits = () =>
      auditService.query({ eventType: "marketplace.listing_created" }).length +
      auditService.query({ eventType: "marketplace.order_placed" }).length;
    const before = audits();

    expect((await req("POST", "/api/marketplace/listings", NEW_LISTING)).statusCode).toBe(501);
    expect((await req("PUT", "/api/marketplace/listings/lst-pla-175mm", { pricePerUnit: 1 })).statusCode).toBe(501);
    expect((await req("DELETE", "/api/marketplace/listings/lst-fr4-pcb-blank")).statusCode).toBe(501);
    expect((await req("POST", "/api/marketplace/orders", NEW_ORDER)).statusCode).toBe(501);
    expect(audits()).toBe(before);

    // Look at the fixtures through the demo switch: all as they were.
    process.env.PCC_DEMO_ROUTES = "true";
    const listings = (await req("GET", "/api/marketplace/listings")).json().listings as Array<{ id: string; name: string; pricePerUnit: number }>;
    expect(listings.map((l) => l.id)).toEqual(FIXTURE_LISTING_IDS);
    expect(listings.find((l) => l.id === "lst-pla-175mm")!.pricePerUnit).toBe(22);
    expect(listings.some((l) => l.name === NEW_LISTING.name)).toBe(false);
    const orders = (await req("GET", "/api/marketplace/orders")).json().orders as Array<{ id: string }>;
    expect(orders.map((o) => o.id)).toEqual(["ord-demo-001", "ord-demo-002"]);
  });
});

describe("PCC_DEMO_ROUTES=true: the old answers, each marked mock/demo", () => {
  beforeEach(() => {
    process.env.PCC_DEMO_ROUTES = "true";
  });

  for (const c of GATED) {
    it(`${c.method} ${c.url} -> ${c.demoStatus} with mock:true, demo:true`, async () => {
      const res = await req(c.method, c.url, c.body);
      expect(res.statusCode, res.body).toBe(c.demoStatus);
      const body = res.json();
      expect(body).toMatchObject({ mock: true, demo: true });
      c.demo(body);
    });
  }

  it("a demo write still writes its audit entry (existing behavior)", async () => {
    const before = auditService.query({ eventType: "marketplace.listing_created" }).length;
    expect((await req("POST", "/api/marketplace/listings", { ...NEW_LISTING, name: "N34 second probe" })).statusCode).toBe(201);
    expect(auditService.query({ eventType: "marketplace.listing_created" }).length).toBe(before + 1);
  });

  it("demo errors are marked as well (404, 400, and the old 200 not_found for a class)", async () => {
    const missing = await req("GET", "/api/marketplace/listings/nope");
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: "listing_not_found", mock: true, demo: true });
    const bad = await req("POST", "/api/marketplace/orders", {});
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ mock: true, demo: true });
    const cls = await req("GET", "/api/marketplace/classes/nope");
    expect(cls.statusCode).toBe(200);
    expect(cls.json()).toEqual({ error: "not_found", mock: true, demo: true });
  });
});

describe("MIXED: GET /api/marketplace/categories keeps the real taxonomy", () => {
  const TAXONOMY = [
    "raw-metals", "plastics-polymers", "lab-reagents", "lab-consumables",
    "electronics", "chemicals", "biologicals", "tooling", "packaging",
    "calibration", "safety", "other",
  ];

  it("demo off: every category, each count null, and the counts named in `unavailable`", async () => {
    const res = await req("GET", "/api/marketplace/categories");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.categories.map((c: { category: string }) => c.category)).toEqual(TAXONOMY);
    expect(body.categories.every((c: { count: unknown }) => c.count === null)).toBe(true);
    expect(body.unavailable).toEqual(["categories[].count"]);
    expect(body).not.toHaveProperty("mock");
    expect(body).not.toHaveProperty("demo");
  });

  it("demo on: the fixture counts, marked, and nothing listed as unavailable", async () => {
    process.env.PCC_DEMO_ROUTES = "true";
    const res = await req("GET", "/api/marketplace/categories");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ mock: true, demo: true });
    expect(body.categories.map((c: { category: string }) => c.category)).toEqual(TAXONOMY);
    expect(body.categories.every((c: { count: unknown }) => typeof c.count === "number")).toBe(true);
    expect(body.categories.find((c: { category: string }) => c.category === "raw-metals").count).toBeGreaterThan(0);
    expect(body).not.toHaveProperty("unavailable");
  });
});

describe("REAL: POST /api/marketplace/roi (a calculator over the caller's inputs) is unchanged", () => {
  const INPUT = { monthlyCost: 200, avgJobValue: 30, utilization: 65 };

  it("the same answer with demo off and on, never marked", async () => {
    const off = await req("POST", "/api/marketplace/roi", INPUT);
    process.env.PCC_DEMO_ROUTES = "true";
    const on = await req("POST", "/api/marketplace/roi", INPUT);
    expect(off.statusCode).toBe(200);
    expect(on.statusCode).toBe(200);
    expect(off.json()).toEqual(on.json());
    expect(off.json()).not.toHaveProperty("mock");
    expect(off.json()).not.toHaveProperty("demo");
    // 14 jobs a month at 30 against 600 up front and 200 a month: net positive in month 3.
    expect(off.json().projection).toHaveLength(25);
    expect(off.json().breakEvenMonth).toBe(3);
  });
});
