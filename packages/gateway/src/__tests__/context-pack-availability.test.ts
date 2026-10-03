/**
 * Board N34 (reviewer-n34-a, reviewer-n34-c): the agent context pack listed the routes that now
 * answer 501 not_available as live endpoints, so an agent following it walked into refusals.
 * The pack lists them apart ("Not available on this gateway (demo only)" and
 * `demoOnlyEndpoints`). This test asks the N34 route families themselves which routes refuse
 * (PCC_DEMO_ROUTES unset), so neither list can drift from the routes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const norm = (method: string, path: string) => `${method} ${path.replace(/:[A-Za-z_]+/g, ":_").replace(/\/$/, "")}`;

let refused: Set<string>;
/** GET routes that answered live (not 501 not_available), by route file — reviewer round 2 MEDIUM A. */
let liveGetsByFile: Map<string, string[]>;
let markdown: string;
let pack: any;
const saved = { demo: process.env.PCC_DEMO_ROUTES, db: process.env.PCC_DB_PATH };

beforeAll(async () => {
  delete process.env.PCC_DEMO_ROUTES;
  process.env.PCC_DB_PATH = ":memory:";
  const db = await import("../db.js");
  db.initStore({ seed: true });
  const families: Array<{ file: string; register: (app: FastifyInstance) => Promise<void> }> = [
    { file: "agents.ts", register: (await import("../routes/agents.js")).agentRoutes },
    { file: "discover.ts", register: (await import("../routes/discover.js")).discoverRoutes },
    { file: "logistics.ts", register: (await import("../routes/logistics.js")).logisticsRoutes },
    { file: "marketplace.ts", register: (await import("../routes/marketplace.js")).marketplaceRoutes },
    { file: "registry.ts", register: (await import("../routes/registry.js")).registryRoutes },
    { file: "rewards.ts", register: (await import("../routes/rewards.js")).rewardRoutes },
    { file: "spaces.ts", register: (await import("../routes/spaces.js")).spaceRoutes },
    { file: "orchestrator.ts", register: (await import("../routes/orchestrator.js")).orchestratorRoutes },
    { file: "protocols.ts", register: (await import("../routes/protocols.js")).protocolRoutes },
    { file: "swf.ts", register: (await import("../routes/swf.js")).swfRoutes },
  ];
  refused = new Set();
  liveGetsByFile = new Map();
  for (const { file, register } of families) {
    const routes: Array<{ method: string; url: string }> = [];
    const app = Fastify({ logger: false });
    app.addHook("onRoute", (r) => {
      for (const m of Array.isArray(r.method) ? r.method : [r.method]) if (m !== "HEAD" && m !== "OPTIONS") routes.push({ method: m, url: r.url });
    });
    await app.register(register);
    await app.ready();
    const liveGets: string[] = [];
    for (const r of routes) {
      const write = r.method === "POST" || r.method === "PUT" || r.method === "PATCH";
      const res = await app.inject({ method: r.method as any, url: r.url.replace(/:[A-Za-z_]+/g, "probe-x"), ...(write ? { payload: {} } : {}) });
      const isRefused = res.statusCode === 501 && res.json().error === "not_available";
      if (isRefused) refused.add(norm(r.method, r.url));
      else if (r.method === "GET") liveGets.push(norm(r.method, r.url));
    }
    if (liveGets.length > 0) liveGetsByFile.set(file, liveGets);
    await app.close();
  }

  const { contextPackRoutes } = await import("../routes/context-pack.js");
  const app = Fastify({ logger: false });
  await app.register(contextPackRoutes);
  await app.ready();
  markdown = (await app.inject({ method: "GET", url: "/agent-context-pack" })).body;
  pack = (await app.inject({ method: "GET", url: "/agent-context-pack.json" })).json();
  await app.close();
}, 60_000);

afterAll(async () => {
  (await import("../db.js")).closeStore();
  if (saved.demo === undefined) delete process.env.PCC_DEMO_ROUTES;
  else process.env.PCC_DEMO_ROUTES = saved.demo;
  if (saved.db === undefined) delete process.env.PCC_DB_PATH;
  else process.env.PCC_DB_PATH = saved.db;
});

const ROW = /^\| (GET|POST|PUT|PATCH|DELETE) \| (\/[^ |]*) \|/gm;
const rowsOf = (text: string) => [...text.matchAll(ROW)].map((m) => norm(m[1]!, m[2]!));
const DEMO_HEADING = "### Not available on this gateway (demo only)";

describe("agent context pack: routes that refuse are never listed as available", () => {
  it("the N34 families refuse routes with demo off (the probe works)", () => {
    expect(refused.size).toBeGreaterThan(50);
    expect(refused.has("GET /api/logistics/shipments")).toBe(true);
    // The SWF is demo-only too (astra round 1 on #421, r1a HIGH): its in-memory service is a simulation.
    expect(refused.has("GET /api/swf/summary")).toBe(true);
  });

  it("NEGATIVE: no markdown row above the demo-only list refuses", () => {
    const [available] = markdown.split(DEMO_HEADING);
    const listed = rowsOf(available!);
    expect(listed.length).toBeGreaterThan(100);
    expect(listed.filter((r) => refused.has(r))).toEqual([]);
  });

  it("every row in the markdown demo-only list does refuse, and the JSON pack lists the same rows", () => {
    const demoPart = markdown.split(DEMO_HEADING)[1]!.split("## Data Types")[0]!;
    const demoRows = rowsOf(demoPart);
    expect(demoRows.length).toBeGreaterThan(0);
    expect(demoRows.filter((r) => !refused.has(r))).toEqual([]);
    expect(pack.demoOnlyEndpoints.endpoints.map((e: any) => norm(e.method, e.path))).toEqual(demoRows);
    expect(pack.demoOnlyEndpoints.note).toMatch(/501 not_available/);
  });

  it("NEGATIVE: no JSON endpointGroups entry refuses", () => {
    const listed = pack.endpointGroups.flatMap((g: any) => g.endpoints.map((e: any) => norm(e.method, e.path)));
    expect(listed.length).toBeGreaterThan(20);
    expect(listed.filter((r: string) => refused.has(r))).toEqual([]);
  });

  it("NEGATIVE (F-E, reviewer r1b/r1a): every route the N34 families actually refuse is documented — refused ⊆ documented", () => {
    // The existing tests above only check the forward direction (documented rows really
    // refuse). They miss the reverse: a route that refuses but was never added to
    // demoOnlyEndpoints, so an agent reading the pack sees it nowhere on the demo-only
    // list and has no reason to expect a 501. Derived from the SAME `refused` set the
    // tests above already trust (registered directly from the route plugins, demo off).
    //
    // A route pinned instead as conditionally live (reviewer round 2, MEDIUM B) counts too:
    // this sandbox has no working mDNS, so discover's scan/onboard land in `refused` here
    // exactly like a true demo-only route would, even though production behavior depends on
    // whether THIS gateway can reach its own network, not on demo mode. The pack says so
    // (conditionallyLiveEndpoints), which is what an agent actually needs to know.
    const documented = new Set([
      ...pack.demoOnlyEndpoints.endpoints.map((e: any) => norm(e.method, e.path)),
      ...pack.conditionallyLiveEndpoints.endpoints.map((e: any) => norm(e.method, e.path)),
    ]);
    const missing = [...refused].filter((r) => !documented.has(r)).sort();
    expect(missing, `${missing.length} refused route(s) missing from demoOnlyEndpoints or conditionallyLiveEndpoints`).toEqual([]);
  });
});

/**
 * N34 route inventory (reviewer round 2, MEDIUM A): the fabrication ratchet's source scan and
 * the refused-is-documented check above only catch a new route that REFUSES (501) without
 * being listed in demoOnlyEndpoints. A new route that answers 200 with an inline fixture
 * literal — never bound to a module-scope fixture-named declarator, so invisible to the
 * ratchet, and never 501, so invisible to refused-is-documented — passes both unnoticed.
 * Reproduced: adding `app.get("/api/marketplace/new", async () => [{ id: "fixture" }])` to
 * marketplace.ts left every test in both files green (astra round-2 verdict, MEDIUM A).
 *
 * This closes the gap STRUCTURALLY, not by source pattern, for GET routes in the ten N34
 * families probed above: it pins the exact set of GET paths that answer live (not 501
 * not_available) today, by file — the same shrink-only, name-pinned shape as the fabrication
 * ratchet's ALLOWLIST, applied to routes instead of fixture bindings. A new live GET path in
 * one of these families, real data or fixture alike, is not in this pin and fails until a
 * reviewer explicitly adds it.
 *
 * Scope: GET only, and only these ten families. A new POST/PUT/PATCH/DELETE route serving a
 * fixture with a 200, a live GET added to a route file OUTSIDE this list, or an existing
 * route's handler rewritten in place (same path, swapped body) are all still invisible here.
 */
const LIVE_GET_ALLOWLIST: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "marketplace.ts": ["GET /api/marketplace/categories"],
  "registry.ts": [
    "GET /api/registry/entities",
    "GET /api/registry/entities/:_",
    "GET /api/registry/reputation/:_",
    "GET /api/registry/reputation/leaderboard",
    "GET /api/registry/summary",
  ],
});

describe("N34 route inventory: no new live GET route is undocumented (reviewer round 2, MEDIUM A)", () => {
  it("every GET route in an N34 family is pinned as either refused (above) or live (here)", () => {
    const mismatches: string[] = [];
    const files = new Set([...Object.keys(LIVE_GET_ALLOWLIST), ...liveGetsByFile.keys()]);
    for (const file of files) {
      const allowed = [...(LIVE_GET_ALLOWLIST[file] ?? [])].sort();
      const found = [...(liveGetsByFile.get(file) ?? [])].sort();
      if (JSON.stringify(allowed) !== JSON.stringify(found)) {
        mismatches.push(`${file}: pinned live GETs ${JSON.stringify(allowed)}, found ${JSON.stringify(found)}`);
      }
    }
    expect(
      mismatches,
      "A new live GET route appeared in an N34 family (or a pinned one vanished/changed). " +
        "Confirm it is a real read (not a fixture) and add it to LIVE_GET_ALLOWLIST, or refuse it and document it in demoOnlyEndpoints instead.",
    ).toEqual([]);
  });
});

/**
 * Discovery routes are CONDITIONALLY live (reviewer round 2, MEDIUM B): discover.ts returns
 * real discovered devices when this gateway can run network discovery (mDNS), and only
 * refuses (or, in demo mode, returns marked examples) when it cannot — see discover.ts:268-283
 * and :305-318. The pack once blanket-listed both routes under demoOnlyEndpoints, which told an
 * agent they ALWAYS refuse outside demo mode; false on any gateway where mDNS actually works.
 * This sandbox has no working mDNS, so both routes land in `refused` above (demo off, same as
 * every true demo-only route) — that observed 501 is exactly what let the mischaracterization
 * ship undetected. These tests pin the pack's classification directly against its own content,
 * not against this sandbox's (unavoidably one-sided) runtime behavior.
 */
describe("agent context pack: discovery routes are classified as conditionally live, not demo-only (reviewer round 2, MEDIUM B)", () => {
  it("the two discovery routes are NOT listed as demo-only", () => {
    const demoOnly = new Set(pack.demoOnlyEndpoints.endpoints.map((e: any) => norm(e.method, e.path)));
    expect(demoOnly.has("POST /api/discover/scan")).toBe(false);
    expect(demoOnly.has("POST /api/discover/onboard")).toBe(false);
  });

  it("the pack instead lists them as conditionally live, with wording that states the condition", () => {
    const conditional = pack.conditionallyLiveEndpoints.endpoints.map((e: any) => norm(e.method, e.path));
    expect([...conditional].sort()).toEqual(["POST /api/discover/onboard", "POST /api/discover/scan"]);
    expect(pack.conditionallyLiveEndpoints.note).toMatch(/network discovery/i);
    expect(pack.conditionallyLiveEndpoints.note).not.toMatch(/unless the gateway runs with PCC_DEMO_ROUTES/);
  });

  it("the markdown carries the same conditionally-live table, outside the demo-only block", () => {
    const afterDemo = markdown.split(DEMO_HEADING)[1]!;
    expect(afterDemo).toContain("/api/discover/scan");
    expect(afterDemo).toContain("/api/discover/onboard");
    const demoPart = afterDemo.split("## Data Types")[0]!;
    expect(demoPart).not.toContain("/api/discover/scan");
    expect(demoPart).not.toContain("/api/discover/onboard");
  });
});
