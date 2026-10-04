/**
 * Board N68 (operator item 81, decided 2026-09-29): no read shows an operator's exact location or
 * street address unless the operator opted in (a public storefront), and a kernel registered
 * without coordinates reads as no location rather than {0,0}.
 *
 * The real apiGate and routes, on an in-memory store. Keys are self-provisioned, as anyone's can
 * be, so "a key" here is as public as no key. One stand-in app (no apiGate) sets `provenWallet`
 * the way WP-A (#326) will, to test that path before WP-A merges.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const AUDIT = vi.hoisted(() => ({ log: [] as Array<Record<string, unknown>> }));
vi.mock("../telemetry.js", () => ({ pipelineTelemetry: { emit: vi.fn() } }));
vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn(), shutdownPostHog: vi.fn() }));
vi.mock("../services/audit-service.js", async (orig) => {
  const real = (await orig()) as { auditService: object };
  // The real service, with `log` recorded instead of written.
  const auditService = Object.create(real.auditService, {
    log: { value: (e: Record<string, unknown>) => void AUDIT.log.push(e) },
  });
  return { ...real, auditService };
});
vi.mock("../middleware/security-hardening.js", async (orig) => ({
  ...((await orig()) as object),
  canProvision: () => true,
}));

import { apiGate } from "../middleware/api-gate.js";
import { provisionRoutes } from "../routes/provision.js";
import { kernelRoutes } from "../routes/kernels.js";
import { capabilityRoutes } from "../routes/capabilities.js";
import { wellKnownAeoRoutes } from "../routes/well-known-aeo.js";
import { a2aTasksRoutes } from "../routes/a2a-tasks.js";
import { statusRoutes } from "../routes/status.js";
import { operatorStatusRoutes } from "../routes/operator-status.js";
import { kernelAgentPackageRoutes } from "../routes/kernel-agent-package.js";
import { nlQueryRoutes } from "../routes/nl-query.js";
import { planComposition } from "../routes/compose.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { geohashCenter } from "../facades/populators/public-location.js";

const SITE = { lat: 47.6204931, lng: -122.3492447 };
const CELL = "c22yz";
const CENTRE = geohashCenter(CELL);
const ADDRESS = "1 Canary Lane, Testville";
const ADMIN = "n68-admin-secret";
/** The site's own values as JSON would render them: none may appear in a coarse read. */
const EXACT_STRINGS = ["47.6204931", "122.3492447", "Canary Lane"];

let app: FastifyInstance;
let ownerKey = "";
let ownerId = "";
let strangerKey = "";
const savedEnv: Record<string, string | undefined> = {};

async function provision(email: string): Promise<{ key: string; operatorId: string }> {
  const r = await app.inject({ method: "POST", url: "/api/auth/provision", payload: { email, name: email } });
  expect(r.statusCode).toBe(201);
  return { key: r.json().api_key, operatorId: r.json().operator_id };
}
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const register = (payload: Record<string, unknown>, headers: Record<string, string> = bearer(ownerKey)) =>
  app.inject({ method: "POST", url: "/api/kernels", headers, payload });
const kernelIn = async (id: string) =>
  ((await app.inject({ method: "GET", url: "/api/kernels" })).json().kernels as Array<Record<string, unknown>>).find((k) => k.id === id)!;
const capabilityOf = async (kernelId: string) =>
  ((await app.inject({ method: "GET", url: "/api/capabilities?limit=200" })).json().items as Array<Record<string, unknown>>).find(
    (c) => c.kernelId === kernelId,
  )!;

beforeAll(async () => {
  for (const k of ["PCC_DB_PATH", "PCC_ADMIN_KEY", "PCC_A2A_AUTH_DISABLED", "PCC_COMPOSE_USE_FACADE"]) savedEnv[k] = process.env[k];
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ADMIN;
  delete process.env.PCC_A2A_AUTH_DISABLED;
  initStore({ seed: false });
  app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(provisionRoutes);
  await app.register(kernelRoutes);
  await app.register(capabilityRoutes);
  await app.register(wellKnownAeoRoutes);
  await app.register(a2aTasksRoutes);
  await app.register(statusRoutes);
  await app.register(operatorStatusRoutes);
  await app.register(kernelAgentPackageRoutes);
  await app.register(nlQueryRoutes);
  await app.ready();

  ({ key: ownerKey, operatorId: ownerId } = await provision("n68-owner@example.invalid"));
  strangerKey = (await provision("n68-stranger@example.invalid")).key;
  expect((await register({ id: "kernel-n68-a", name: "N68 A", location: SITE, physicalAddress: ADDRESS })).statusCode).toBe(201);
  const cap = await app.inject({
    method: "POST",
    url: "/api/capabilities",
    headers: bearer(ownerKey),
    payload: { kernelId: "kernel-n68-a", type: "3d-printing", name: "N68 canary FDM", location: SITE },
  });
  expect(cap.statusCode).toBe(201);
});

afterAll(async () => {
  await app.close();
  closeStore();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("coarse by default: nobody reads the exact site or the street address", () => {
  it("anonymous GET /api/kernels: the centre of the site's geohash-5 cell, and no street address", async () => {
    const res = await app.inject({ method: "GET", url: "/api/kernels" });
    expect(res.statusCode).toBe(200);
    const k = (res.json().kernels as Array<Record<string, unknown>>).find((x) => x.id === "kernel-n68-a")!;
    expect(k.location).toEqual(CENTRE);
    expect(k.locationPrecision).toBe("approximate");
    expect(k.locationCell).toBe(CELL);
    expect(k.physicalAddress).toBeNull();
    for (const s of EXACT_STRINGS) expect(res.body).not.toContain(s);
  });

  it("anonymous capability reads (list, detail, search) show the capability's site the same way", async () => {
    const capId = (await capabilityOf("kernel-n68-a")).id as string;
    for (const url of ["/api/capabilities", `/api/capabilities/${capId}`, "/api/capabilities/search?q=canary"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      for (const s of EXACT_STRINGS) expect(res.body, url).not.toContain(s);
      expect(res.body, url).toContain(`"locationCell":"${CELL}"`);
    }
    const detail = (await app.inject({ method: "GET", url: `/api/capabilities/${capId}` })).json();
    expect([detail.location, detail.locationPrecision]).toEqual([CENTRE, "approximate"]);
  });

  it("a stranger's key reads the same, on every kernel and capability read and the dumps", async () => {
    const capId = (await capabilityOf("kernel-n68-a")).id as string;
    for (const url of [
      "/api/kernels",
      "/api/kernels/kernel-n68-a",
      "/api/capabilities/by-kernel/kernel-n68-a",
      `/api/capabilities/${capId}`,
      "/api/telemetry/system",
      `/api/operators/${encodeURIComponent(ownerId)}/status`,
      "/api/kernels/kernel-n68-a/agent-package",
    ]) {
      const res = await app.inject({ method: "GET", url, headers: bearer(strangerKey) });
      expect(res.statusCode, url).toBe(200);
      for (const s of EXACT_STRINGS) expect(res.body, url).not.toContain(s);
    }
  });

  it("the raw dumps carry the projection, not the stored point", async () => {
    const tele = (await app.inject({ method: "GET", url: "/api/telemetry/system", headers: bearer(strangerKey) })).json();
    const rows = JSON.stringify(tele);
    expect(rows).toContain("N68 canary FDM");
    expect(rows).toContain(`"locationCell":"${CELL}"`);
    const status = (
      await app.inject({ method: "GET", url: `/api/operators/${encodeURIComponent(ownerId)}/status`, headers: bearer(strangerKey) })
    ).json();
    expect(status.capabilities[0]).toMatchObject({ location: CENTRE, locationPrecision: "approximate", locationCell: CELL });
    const pkg = (await app.inject({ method: "GET", url: "/api/kernels/kernel-n68-a/agent-package", headers: bearer(strangerKey) })).json();
    expect(pkg.kernel).toMatchObject({ location: CENTRE, locationPrecision: "approximate", locationCell: CELL });
    expect(JSON.stringify(pkg)).toContain(`the centre of geohash cell ${CELL}`);
  });

  it("the owner's own reads are coarse too: the registration response and GET /api/kernels/:id", async () => {
    const res = await register({ id: "kernel-n68-a", name: "N68 A" });
    expect(res.statusCode).toBe(200);
    expect(res.json().kernel).toMatchObject({ location: CENTRE, locationPrecision: "approximate", physicalAddress: null });
    const own = (await app.inject({ method: "GET", url: "/api/kernels/kernel-n68-a", headers: bearer(ownerKey) })).json();
    expect(own.kernel).toMatchObject({ location: CENTRE, locationPrecision: "approximate", physicalAddress: null });
  });

  it("the public searches that need no key (/ask and A2A discover) show it coarse", async () => {
    const ask = await app.inject({ method: "POST", url: "/ask", payload: { query: "canary" } });
    expect(ask.statusCode).toBe(200);
    const result = (ask.json().results as Array<Record<string, any>>).find((r) => r.name === "N68 canary FDM")!;
    expect(result.areaServed).toEqual({
      "@type": "GeoCircle",
      geoMidpoint: { "@type": "GeoCoordinates", latitude: CENTRE.lat, longitude: CENTRE.lng },
      geoRadius: 3500,
    });
    for (const s of EXACT_STRINGS) expect(ask.body).not.toContain(s);
    const a2a = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: { jsonrpc: "2.0", id: 1, method: "tasks/send", params: { skill: "pcc-discover", kernelId: "kernel-n68-a" } },
    });
    expect(a2a.statusCode).toBe(200);
    expect(a2a.body).toContain(`"locationCell":"${CELL}"`);
    for (const s of EXACT_STRINGS) expect(a2a.body).not.toContain(s);
  });
});

describe("POST /api/query (astra N68 r1, CRITICAL): its kernel and capability answers are the projected reads", () => {
  // Each query picks one intent: kernel_health by id; network_status and operator_stats list every
  // kernel; find_capability lists a type's capabilities. They used to return the stored rows.
  for (const query of ["is kernel kernel-n68-a healthy", "how many kernels are online", "what are my stats", "find a 3d-printing for my part"]) {
    it(`a stranger's key asking "${query}" learns neither the exact site nor the street address`, async () => {
      const res = await app.inject({ method: "POST", url: "/api/query", headers: bearer(strangerKey), payload: { query } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { intent: string; data: Array<Record<string, unknown>> };
      for (const s of EXACT_STRINGS) expect(res.body, `${body.intent}: ${s}`).not.toContain(s);
      const row = body.data.find((r) => r.id === "kernel-n68-a" || r.kernelId === "kernel-n68-a");
      expect(row, body.intent).toBeDefined();
      expect(row).toMatchObject({ location: CENTRE, locationPrecision: "approximate", locationCell: CELL });
    });
  }
});

describe("{0,0} is no location", () => {
  it("a kernel registered without coordinates reads as no location, not as a point at 0,0", async () => {
    expect((await register({ id: "kernel-n68-noloc", name: "N68 no location" })).statusCode).toBe(201);
    const k = await kernelIn("kernel-n68-noloc");
    expect([k.location, k.locationPrecision, k.locationCell]).toEqual([null, "none", null]);
    expect(getRepos().kernels.findById("kernel-n68-noloc")!.location).toEqual({ lat: 0, lng: 0 });
  });

  it("/ask gives such a capability no areaServed at all", async () => {
    await app.inject({
      method: "POST",
      url: "/api/capabilities",
      headers: bearer(ownerKey),
      payload: { kernelId: "kernel-n68-noloc", type: "3d-printing", name: "N68 nowhere FDM" },
    });
    const ask = (await app.inject({ method: "POST", url: "/ask", payload: { query: "nowhere" } })).json();
    const result = (ask.results as Array<Record<string, unknown>>).find((r) => r.name === "N68 nowhere FDM")!;
    expect(result).not.toHaveProperty("areaServed");
  });
});

describe("exact only by explicit opt-in, which needs the admin key or a proven wallet", () => {
  it("an invalid choice is refused, and nothing changes", async () => {
    const res = await register({ id: "kernel-n68-a", locationVisibility: "public" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_location_visibility");
  });

  it("the owner's key alone cannot opt in (a key names an identity; it does not prove one)", async () => {
    const res = await register({ id: "kernel-n68-a", locationVisibility: "exact" });
    expect(res.statusCode).toBe(403);
    expect((await kernelIn("kernel-n68-a")).locationPrecision).toBe("approximate");
  });

  it("nor can a second key provisioned for the owner's email, which is how an impersonator would try", async () => {
    const twin = await provision("n68-owner@example.invalid");
    expect(twin.operatorId).toBe(ownerId);
    expect((await register({ id: "kernel-n68-a", locationVisibility: "exact" }, bearer(twin.key))).statusCode).toBe(403);
    expect((await kernelIn("kernel-n68-a")).locationPrecision).toBe("approximate");
  });

  it("nor can a key whose operatorId NAMES a wallet it never proved (apiGate sets no proven wallet)", async () => {
    const W = "0xabcdefabcdefabcdefabcdefabcdefabcdef0123";
    const claimed = provisionApiKey({ operatorId: W, name: "n68-claims-a-wallet" }).rawKey;
    expect((await register({ id: "kernel-n68-claimed", location: SITE }, bearer(claimed))).statusCode).toBe(201);
    expect((await register({ id: "kernel-n68-claimed", locationVisibility: "exact" }, bearer(claimed))).statusCode).toBe(403);
    expect((await kernelIn("kernel-n68-claimed")).locationPrecision).toBe("approximate");
  });

  it("a wrong, empty or repeated admin key grants nothing", async () => {
    for (const admin of ["wrong", "", [ADMIN, ADMIN]] as const) {
      const res = await app.inject({
        method: "POST",
        url: "/api/kernels",
        headers: { ...bearer(ownerKey), "x-admin-key": admin as string },
        payload: { id: "kernel-n68-a", locationVisibility: "exact" },
      });
      expect(res.statusCode, JSON.stringify(admin)).toBe(403);
    }
    expect((await kernelIn("kernel-n68-a")).locationPrecision).toBe("approximate");
  });

  it("with PCC_ADMIN_KEY unset or blank, no header opts in, in any environment", async () => {
    for (const unset of [undefined, "", "   "]) {
      if (unset === undefined) delete process.env.PCC_ADMIN_KEY;
      else process.env.PCC_ADMIN_KEY = unset;
      const res = await register({ id: "kernel-n68-a", locationVisibility: "exact" }, { ...bearer(ownerKey), "x-admin-key": unset ?? "" });
      expect(res.statusCode).toBe(403);
    }
    process.env.PCC_ADMIN_KEY = ADMIN;
    expect((await kernelIn("kernel-n68-a")).locationPrecision).toBe("approximate");
  });

  it("with the admin key, the kernel and its capability read exact, with the street address", async () => {
    AUDIT.log.length = 0;
    const res = await register({ id: "kernel-n68-a", locationVisibility: "exact" }, { ...bearer(ownerKey), "x-admin-key": ADMIN });
    expect(res.statusCode).toBe(200);
    const k = await kernelIn("kernel-n68-a");
    expect([k.location, k.locationPrecision, k.locationCell, k.physicalAddress]).toEqual([SITE, "exact", CELL, ADDRESS]);
    const c = await capabilityOf("kernel-n68-a");
    expect([c.location, c.locationPrecision]).toEqual([SITE, "exact"]);
    const ask = (await app.inject({ method: "POST", url: "/ask", payload: { query: "canary" } })).json();
    expect((ask.results as Array<Record<string, any>>).find((r) => r.name === "N68 canary FDM")!.areaServed).toEqual({
      "@type": "Place",
      geo: { "@type": "GeoCoordinates", latitude: SITE.lat, longitude: SITE.lng },
    });
    expect(AUDIT.log.filter((e) => e.eventType === "kernel.location_visibility")).toEqual([
      expect.objectContaining({ resourceId: "kernel-n68-a", metadata: { from: "approximate", to: "exact", authority: "admin_key" } }),
    ]);
  });

  it("re-registering without naming the choice keeps it (pcc-node re-registers on every start)", async () => {
    const moved = { lat: 47.6097, lng: -122.3331 };
    expect((await register({ id: "kernel-n68-a", name: "N68 A", location: moved })).statusCode).toBe(200);
    const k = await kernelIn("kernel-n68-a");
    expect([k.location, k.locationPrecision]).toEqual([moved, "exact"]);
    expect((await register({ id: "kernel-n68-a", location: SITE })).statusCode).toBe(200);
  });

  it("the owner can opt out with no admin key, and every read is coarse again", async () => {
    const res = await register({ id: "kernel-n68-a", locationVisibility: "approximate" });
    expect(res.statusCode).toBe(200);
    const k = await kernelIn("kernel-n68-a");
    expect([k.location, k.locationPrecision, k.physicalAddress]).toEqual([CENTRE, "approximate", null]);
    expect((await capabilityOf("kernel-n68-a")).locationPrecision).toBe("approximate");
    expect(getRepos().kernels.findById("kernel-n68-a")!.location).toEqual(SITE);
  });

  it("a new kernel created opted in needs the admin key too; refused, nothing is stored", async () => {
    const refused = await register({ id: "kernel-n68-new", location: SITE, locationVisibility: "exact" });
    expect(refused.statusCode).toBe(403);
    expect(getRepos().kernels.findById("kernel-n68-new")).toBeFalsy();
    const made = await register(
      { id: "kernel-n68-new", location: SITE, physicalAddress: ADDRESS, locationVisibility: "exact" },
      { ...bearer(ownerKey), "x-admin-key": ADMIN },
    );
    expect(made.statusCode).toBe(201);
    expect(made.json().kernel).toMatchObject({ location: SITE, locationPrecision: "exact", physicalAddress: ADDRESS });
  });
});

describe("a proven wallet (as WP-A #326 sets it) may opt in its own kernel, and only its own", () => {
  const W1 = "0xabcdefabcdefabcdefabcdefabcdefabcdefab01";
  const W2 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02";
  let stand: FastifyInstance;
  beforeAll(async () => {
    stand = Fastify({ logger: false });
    stand.addHook("onRequest", async (req) => {
      const principal = req.headers["x-test-principal"];
      if (typeof principal === "string") (req as { operatorId?: string }).operatorId = principal;
      const proven = req.headers["x-test-proven"];
      if (typeof proven === "string") (req as { provenWallet?: string }).provenWallet = proven;
    });
    await stand.register(kernelRoutes);
    await stand.ready();
  });
  afterAll(async () => {
    await stand.close();
  });
  const post = (payload: Record<string, unknown>, principal: string, proven?: string) =>
    stand.inject({
      method: "POST",
      url: "/api/kernels",
      headers: { "x-test-principal": principal, ...(proven ? { "x-test-proven": proven } : {}) },
      payload,
    });

  it("the operator's own proven wallet (any letter case) opts in", async () => {
    expect((await post({ id: "kernel-n68-w1", location: SITE }, W1)).statusCode).toBe(201);
    const mixedCase = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefAB01";
    expect(mixedCase.toLowerCase()).toBe(W1);
    const res = await post({ id: "kernel-n68-w1", locationVisibility: "exact" }, W1, mixedCase);
    expect(res.statusCode).toBe(200);
    expect(res.json().kernel.locationPrecision).toBe("exact");
  });

  it("another proven wallet cannot, even when its key claims the operator's identity", async () => {
    expect((await post({ id: "kernel-n68-w1b", location: SITE }, W1)).statusCode).toBe(201);
    expect((await post({ id: "kernel-n68-w1b", locationVisibility: "exact" }, W1, W2)).statusCode).toBe(403);
  });

  it("a proven wallet never matches an operator named by email or the zero address", async () => {
    expect((await post({ id: "kernel-n68-mail", location: SITE }, "n68-mail@example.invalid")).statusCode).toBe(201);
    expect((await post({ id: "kernel-n68-mail", locationVisibility: "exact" }, "n68-mail@example.invalid", W1)).statusCode).toBe(403);
    const zero = "0x0000000000000000000000000000000000000000";
    expect((await post({ id: "kernel-n68-zero", location: SITE, locationVisibility: "exact" }, zero, zero)).statusCode).toBe(403);
  });
});

describe("compose: a location constraint is checked against the projected site", () => {
  it("a capability with no location never satisfies a radius (it used to read as {0,0}, which did not either)", async () => {
    process.env.PCC_COMPOSE_USE_FACADE = "true";
    try {
      await app.inject({
        method: "POST",
        url: "/api/capabilities",
        headers: bearer(ownerKey),
        payload: { kernelId: "kernel-n68-noloc", type: "n68.nowhere", name: "N68 nowhere only", pricing: { currency: "USDC", baseCost: "1", minimum: "1" } },
      });
      const near = await planComposition({ outcomeType: "n68.nowhere", budgetUSD: 1000, minAssuranceTier: 0, location: { ...SITE, radiusKm: 50 } } as never);
      expect(near.steps ?? []).toHaveLength(0);
      const anywhere = await planComposition({ outcomeType: "n68.nowhere", budgetUSD: 1000, minAssuranceTier: 0 } as never);
      expect((anywhere.steps ?? []).map((s: { capabilityId?: string }) => s.capabilityId)).toEqual(["cap-kernel-n68-noloc-n68.nowhere"]);
    } finally {
      delete process.env.PCC_COMPOSE_USE_FACADE;
    }
  });
});
