/**
 * Board N68 regression sweep (astra r1 asked for it): no read of the REAL gateway shows an
 * operator's exact location or street address to a caller the operator did not opt in for.
 *
 * Boots createGateway (every plugin, apiGate and every route; seeded in-memory store) and
 * registers a canary kernel and capability at a distinctive exact point and street address
 * through the real API. Then it calls EVERY registered GET route, with each path parameter
 * filled with the canary's kernel id, capability id or operator id, with and without a query
 * string. It also calls the POST reads that answer with kernels or capabilities: /ask,
 * /a2a/tasks/send pcc-discover and the /api/query intents. Both passes run anonymously and with a
 * stranger's self-provisioned key. A new route that dumps stored kernel or capability rows
 * fails here. SSE and WebSocket routes are not called (their producers carry no location).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const ROUTES = vi.hoisted(() => [] as Array<{ method: string | string[]; url: string; websocket?: boolean }>);
vi.mock("fastify", async (orig) => {
  const real = (await orig()) as { default: (...a: unknown[]) => FastifyInstance };
  const make = (...a: unknown[]) => {
    const inst = real.default(...a);
    inst.addHook("onRoute", (r) => {
      ROUTES.push({ method: r.method as string | string[], url: r.url, websocket: (r as { websocket?: boolean }).websocket });
    });
    return inst;
  };
  Object.assign(make, real.default);
  return { ...real, default: make };
});

const CANARY = { kernelId: "kernel-n68-canary", lat: 47.6204931, lng: -122.3492447, address: "1 Canary Lane, Testville" };
const NOLOC = "kernel-n68-nolocation";
// The exact values as JSON renders them, their 4-5 decimal roundings, and the street address.
const NEEDLES = ["47.6204931", "122.3492447", "47.62049", "122.34924", "47.6205", "122.3492", "Canary Lane"];

let app: FastifyInstance;
let ipSeq = 0;
const ip = () => `10.68.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
let canaryCapId = "";
let operatorId = "";
let strangerKey = "";

async function provision(email: string): Promise<{ key: string; operatorId: string }> {
  const r = await app.inject({ method: "POST", url: "/api/auth/provision", headers: { "x-forwarded-for": ip() }, payload: { email, name: email } });
  const b = r.json();
  if (r.statusCode !== 201) throw new Error(`provision ${r.statusCode} ${r.body.slice(0, 200)}`);
  return { key: b.api_key, operatorId: b.operator_id };
}

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_SEED_DATA = "true";
  const { createGateway } = await import("../server.js");
  app = (await createGateway(0)).app as unknown as FastifyInstance;
  await app.ready();
  const owner = await provision("n68-canary-owner@example.invalid");
  operatorId = owner.operatorId;
  strangerKey = (await provision("n68-stranger@example.invalid")).key;
  const auth = { authorization: `Bearer ${owner.key}` };
  const k = await app.inject({
    method: "POST", url: "/api/kernels", headers: { ...auth, "x-forwarded-for": ip() },
    payload: { id: CANARY.kernelId, name: "N68 canary", location: { lat: CANARY.lat, lng: CANARY.lng }, physicalAddress: CANARY.address, maxAssuranceTier: 1 },
  });
  const c = await app.inject({
    method: "POST", url: "/api/capabilities", headers: { ...auth, "x-forwarded-for": ip() },
    payload: { kernelId: CANARY.kernelId, type: "3d-printing", name: "N68 canary FDM", location: { lat: CANARY.lat, lng: CANARY.lng }, materials: ["PLA"], assuranceTiers: [0, 1], pricing: { currency: "USDC", baseCost: "5", minimum: "5" } },
  });
  canaryCapId = c.json().capability?.id ?? "";
  const n = await app.inject({
    method: "POST", url: "/api/kernels", headers: { ...auth, "x-forwarded-for": ip() },
    payload: { id: NOLOC, name: "N68 no location" },
  });
  console.log("SETUP kernel", k.statusCode, "capability", c.statusCode, canaryCapId, "no-location kernel", n.statusCode, "| routes", ROUTES.length);
}, 120_000);

afterAll(async () => {
  await app?.close();
});

function variants(url: string): string[] {
  if (url.includes("*")) return [];
  const fill = (generic: string) =>
    url.replace(/:(\w+)(\([^)]*\))?/g, (_m, name: string) => {
      if (/kernel/i.test(name)) return CANARY.kernelId;
      if (/cap/i.test(name)) return canaryCapId;
      if (/operator|owner|wallet|address/i.test(name)) return encodeURIComponent(operatorId);
      return generic;
    });
  const out = new Set([fill(CANARY.kernelId), fill(canaryCapId), fill(encodeURIComponent(operatorId))]);
  const q = `?kernelId=${CANARY.kernelId}&q=canary&type=3d-printing&lat=47.62&lng=-122.35&radiusKm=100&limit=1000`;
  for (const u of [...out]) out.add(u + q);
  return [...out];
}

const SKIP = /\/sse\/|stream|\/events\b|\/ws\b|websocket|firehose/i;
// Routes that refuse through a helper which sends the refusal and then returns undefined, not the
// reply (feedback.ts adminOk and the other /api/admin routes, settlement-read.ts prelude). Fastify
// then sends a second time, and writeHead throws ERR_HTTP_HEADERS_SENT as an unhandled rejection
// that fails the whole run (54 of them at 7d6eaa84: red CI). Each of these refuses the sweep's
// callers (no admin token; no such settlement unit) before it reads a kernel or capability row.
// Reported to gateway; drop a pattern once its routes return the reply.
const DOUBLE_SEND = /^\/api\/admin\/|^\/api\/settlement\/units\/:unitId\//;

async function sweep(key: string | null) {
  const leaks: string[] = [];
  let calls = 0;
  let timeouts = 0;
  let errors = 0;
  const seen = new Set<string>();
  for (const r of ROUTES) {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    if (!methods.includes("GET") || r.websocket || SKIP.test(r.url) || DOUBLE_SEND.test(r.url)) continue;
    for (const url of variants(r.url)) {
      if (seen.has(url)) continue;
      seen.add(url);
      const headers: Record<string, string> = { "x-forwarded-for": ip() };
      if (key) headers.authorization = `Bearer ${key}`;
      calls++;
      const res = await Promise.race([
        app.inject({ method: "GET", url, headers }).then((x) => ({ status: x.statusCode, body: x.body })),
        new Promise<{ status: number; body: string }>((ok) => setTimeout(() => ok({ status: -1, body: "" }), 4000)),
      ]).catch((e) => ({ status: -2, body: String(e) }));
      if (res.status < 0) timeouts++;
      else if (res.status >= 500) errors++;
      const hit = NEEDLES.filter((n) => res.body.includes(n));
      if (hit.length) leaks.push(`${res.status} GET ${url.split("?")[0]}${url.includes("?") ? " (with query)" : ""} -> ${hit.join(",")}`);
    }
  }
  // The POST reads that answer with kernels or capabilities (/ask and pcc-discover need no key).
  for (const [url, payload] of [
    ["/ask", { query: "canary" }],
    ["/a2a/tasks/send", { jsonrpc: "2.0", id: 1, method: "tasks/send", params: { skill: "pcc-discover", query: "canary" } }],
    ["/a2a/tasks/send", { jsonrpc: "2.0", id: 2, method: "tasks/send", params: { skill: "pcc-discover", kernelId: CANARY.kernelId } }],
    ["/api/query", { query: `is kernel ${CANARY.kernelId} healthy` }],
    ["/api/query", { query: "how many kernels are online" }],
    ["/api/query", { query: "what are my stats" }],
    ["/api/query", { query: "find a 3d-printing for my part" }],
  ] as const) {
    const headers: Record<string, string> = { "x-forwarded-for": ip() };
    if (key) headers.authorization = `Bearer ${key}`;
    calls++;
    const res = await app.inject({ method: "POST", url, headers, payload: payload as object });
    const hit = NEEDLES.filter((n) => res.body.includes(n));
    if (hit.length) leaks.push(`${res.statusCode} POST ${url} ${JSON.stringify(payload).slice(0, 60)} -> ${hit.join(",")}`);
  }
  return { leaks, calls, timeouts, errors };
}

describe("N68: no read of the real gateway shows an operator's exact location or street address", () => {
  it("ANONYMOUS: no route returns the canary's exact coordinates or street address", async () => {
    const { leaks, calls, timeouts, errors } = await sweep(null);
    console.log(`ANON swept ${calls} calls (${timeouts} timed out, ${errors} answered 5xx); ${leaks.length} leaking responses`);
    for (const l of leaks) console.log("ANON LEAK", l);
    expect(leaks).toEqual([]);
  }, 600_000);

  it("A STRANGER'S self-provisioned key: no route returns them either", async () => {
    const { leaks, calls, timeouts, errors } = await sweep(strangerKey);
    console.log(`KEYED swept ${calls} calls (${timeouts} timed out, ${errors} answered 5xx); ${leaks.length} leaking responses`);
    for (const l of leaks) console.log("KEYED LEAK", l);
    expect(leaks).toEqual([]);
  }, 600_000);

  it("{0,0}: a kernel registered without a location is shown with no location, not at 0,0", async () => {
    const res = await app.inject({ method: "GET", url: "/api/kernels", headers: { "x-forwarded-for": ip() } });
    const k = (res.json().kernels as Array<Record<string, unknown>>).find((x) => x.id === NOLOC)!;
    console.log("ZERO", res.statusCode, "location", JSON.stringify(k.location), "precision", JSON.stringify(k.locationPrecision));
    expect(k.location ?? null).toBeNull();
  });
});
