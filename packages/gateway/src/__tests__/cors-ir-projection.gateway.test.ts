/**
 * #562 r1 (astra) F1, CRITICAL: the CORS wildcard released the RAW response of anonymous IR
 * routes to any web origin. GET /api/kernels carries the DLP-designated operatorAddress, precise
 * location and physicalAddress; GET /api/capabilities carries precise location too.
 *
 * The property, tested through the FULL gateway (createGateway: the real routes, API gate, DLP
 * plugin and CORS), never stubs: a cross-origin wildcard response carries ONLY the fields the
 * closed IR reads (the server-side IR projection), never the raw body. Client-side filtering is
 * not a confidentiality boundary.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let app: any;
beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  const { createGateway } = await import("../server.js");
  ({ app } = await createGateway(0));
  await app.ready();
}, 120_000);
afterAll(async () => { await app?.close(); });

const UNKNOWN = "https://evil.example";
// Every DLP-designated field (middleware/dlp-redactor.ts DEFAULT_RULES), plus the leaf names of
// its nested job rules. None may appear, at any depth, in a wildcard (cross-origin) response.
const DLP_FIELDS = new Set(["operatorAddress", "physicalAddress", "location", "rawKey", "keyHash", "gcode", "toolpath"]);
function dlpHits(v: unknown, path = "$", out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x, i) => dlpHits(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
    if (DLP_FIELDS.has(k)) out.push(`${path}.${k}`);
    dlpHits(x, `${path}.${k}`, out);
  }
  return out;
}
const keysOf = (rows: unknown[]): Set<string> => new Set(rows.flatMap((r) => (r && typeof r === "object" ? Object.keys(r) : [])));

describe("#562 r1 F1 reproduced (verify before fix): a wildcard response is the IR projection, never the raw body", () => {
  it("anonymous GET /api/kernels from an unknown origin: no DLP field; rows carry only the kernels list profile's fields", async () => {
    const res = await app.inject({ method: "GET", url: "/api/kernels", headers: { origin: UNKNOWN } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    const body = res.json();
    expect(dlpHits(body)).toEqual([]);
    expect(Array.isArray(body.kernels) && body.kernels.length).toBeGreaterThan(0);
    for (const k of keysOf(body.kernels)) expect(["name", "id", "status", "version", "capabilityCount"]).toContain(k);
  });

  it("anonymous GET /api/capabilities from an unknown origin: no DLP field (no precise location); rows carry only the capabilities list profile's fields", async () => {
    const res = await app.inject({ method: "GET", url: "/api/capabilities", headers: { origin: UNKNOWN } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    const body = res.json();
    expect(dlpHits(body)).toEqual([]);
    expect(Array.isArray(body.items) && body.items.length).toBeGreaterThan(0);
    for (const k of keysOf(body.items)) expect(["name", "id", "type", "kernelId", "available"]).toContain(k);
    // Page metadata: only the profile's declared paged.total, which N110's window note reads; never offset, limit or hasMore (#562 r2 F2).
    for (const k of Object.keys(body)) expect(["items", "asOf", "total"]).toContain(k);
  });
});

describe("the fix (#562 r2): the projection is the only cross-origin body; everything else is unchanged", () => {
  it("allowlisted origins and no-Origin requests still get the RAW body (#562 changes only cross-origin wildcard responses)", async () => {
    // The raw anonymous body still carries the DLP fields for non-browser clients: that is the
    // pre-existing server-side DLP gap, reported to the gateway (steward #6101), not #562's to change.
    for (const headers of [{ origin: "https://capability.network" }, {}] as Array<Record<string, string>>) {
      const body = (await app.inject({ method: "GET", url: "/api/kernels", headers })).json();
      expect(Object.keys(body.kernels[0])).toContain("capabilityTypes"); // a raw-only field: the body is not projected
    }
  });

  it("an auth-gated IR route answers an unknown origin with its status and an EMPTY body, nothing else", async () => {
    const res = await app.inject({ method: "GET", url: "/api/jobs", headers: { origin: UNKNOWN } });
    expect(res.statusCode).toBe(401);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.body).toBe("{}");
  });

  it("a CORS preflight stays a bodiless 204 (the projection only rewrites GETs)", async () => {
    const res = await app.inject({ method: "OPTIONS", url: "/api/capabilities", headers: { origin: UNKNOWN, "access-control-request-method": "GET" } });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
  });

  it("the closed IR still renders real rows from the projection (no row fails closed)", async () => {
    const { listRowsOf, LIST_PROFILES } = await import("../mcp/dashboard-ir.js");
    const { bindListRows, listRowsReadable, UNAVAILABLE } = await import("../mcp/dashboard-ir-renderer.js");
    type El = { textContent: string; className: string; children: El[]; setAttr: (n: string, v: string) => void; appendChild: (c: El) => El };
    const doc = { createElement(): El { const e: El = { textContent: "", className: "", children: [], setAttr() {}, appendChild(c) { e.children.push(c); return c; } }; return e; } };
    const leaves = (e: El): string[] => [e.textContent, ...e.children.flatMap(leaves)].filter((t) => t !== "");
    for (const path of ["/api/capabilities", "/api/kernels"]) {
      const body = (await app.inject({ method: "GET", url: path, headers: { origin: UNKNOWN } })).json();
      const rows = listRowsOf(path, body);
      expect(rows && rows.length, path).toBeGreaterThan(0);
      const prof = LIST_PROFILES[path]!;
      const node = { type: "list", id: "n1", props: { rowTitle: prof.title[0], rowMeta: [...prof.meta], statusFrom: prof.status[0] }, bind: { path } } as any;
      expect(listRowsReadable(node, rows!), path).toBe(true);
      const el = doc.createElement();
      bindListRows(doc as any, el as any, node, rows!, body);
      expect(el.children.filter((c) => c.className === "pcc-row").length, path).toBe(rows!.length);
      expect(leaves(el), path).not.toContain(UNAVAILABLE);
    }
  });
});

describe("projectIrRead (unit)", () => {
  it("an unknown path or a non-object body projects to {}", async () => {
    const { projectIrRead } = await import("../mcp/dashboard-ir-read-projection.js");
    expect(projectIrRead("/api/keys", { a: 1 })).toEqual({});
    expect(projectIrRead("/api/capabilities", [1, 2])).toEqual({});
    expect(projectIrRead("/api/capabilities", null)).toEqual({});
  });
  it("copies only primitive leaves by own-property paths; object leaves, inherited and prototype keys are dropped", async () => {
    const { projectIrRead } = await import("../mcp/dashboard-ir-read-projection.js");
    const inherited = Object.create({ name: "inherited" });
    const out = projectIrRead("/api/capabilities", {
      items: [{ name: "A", id: "cap-1", type: "t", kernelId: "k-1", available: true, location: { lat: 1.2345, lng: 2.3456 }, operatorAddress: "0x1" }, inherited, 7],
      total: 3, offset: 0, limit: 50, hasMore: false, asOf: "2026-10-03T00:00:00.000Z", secret: "x", __proto__: { polluted: 1 },
    } as any);
    expect(out).toEqual({ items: [{ name: "A", id: "cap-1", type: "t", kernelId: "k-1", available: true }, {}, {}], total: 3, asOf: "2026-10-03T00:00:00.000Z" });
  });
  it("a PROFILE field whose value is an object is dropped whole (it could carry fields the IR never reads)", async () => {
    const { projectIrRead } = await import("../mcp/dashboard-ir-read-projection.js");
    expect(projectIrRead("/api/capabilities", { items: [{ name: { physicalAddress: "x" }, id: "c-1" }] })).toEqual({ items: [{ id: "c-1" }] });
  });
  it("a capability detail keeps exactly its card fields; a kernel detail exactly its metric sources", async () => {
    const { projectIrRead } = await import("../mcp/dashboard-ir-read-projection.js");
    expect(projectIrRead("/api/capabilities/Cap1", { name: "A", type: "t", pricing: { baseCost: "5", currency: "USDC", secretRate: 9 }, assuranceTiers: [0, 1], available: true, location: { lat: 1 }, physicalAddress: "x" }))
      .toEqual({ name: "A", type: "t", pricing: { baseCost: "5", currency: "USDC" }, assuranceTiers: [0, 1], available: true });
    expect(projectIrRead("/api/kernels/K1", { kernel: { status: "online", reputation: 5, operatorAddress: "0x1", location: { lat: 1 }, physicalAddress: "x" }, asOf: "2026-10-03T00:00:00.000Z" }))
      .toEqual({ kernel: { status: "online", reputation: 5 }, asOf: "2026-10-03T00:00:00.000Z" });
  });
});

describe("#562 r2 reproduced (verify before fix)", () => {
  it("F2: a wildcard list response carries no page metadata the browser IR never reads (only its rows, asOf and the profile's declared total, which N110 reads)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/capabilities?limit=1", headers: { origin: UNKNOWN } });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    for (const k of Object.keys(res.json())) expect(["items", "asOf", "total"], k).toContain(k);
  });
  it("F3: an ordered alternative projects ONLY the first present key; an invalid first value never falls back to a later one", async () => {
    const { projectIrRead } = await import("../mcp/dashboard-ir-read-projection.js");
    // The renderer reads the FIRST present key and fails the card if it is invalid; the projection must not turn that into a valid card.
    const bad = projectIrRead("/api/jobs/j-1/status", { status: { secret: "x" }, job: { status: "completed" } });
    expect(bad, JSON.stringify(bad)).not.toHaveProperty("job");
    expect(bad).not.toHaveProperty("status");
    // Positive controls: the first present key wins, and an absent first key falls through to the next.
    expect(projectIrRead("/api/jobs/j-1/status", { status: "completed", job: { status: "failed" } })).toEqual({ status: "completed" });
    expect(projectIrRead("/api/jobs/j-1/status", { job: { status: "completed", progress: 40 } })).toEqual({ job: { status: "completed", progress: 40 } });
  });
});

describe("N110 x #562 (the merge-up): a cross-origin list keeps the ONE page field the IR reads, its profile's declared paged.total", () => {
  // N110's window note (dashboard-ir-renderer.ts listWindow) reads the route's own `paged.total`
  // from the fetched body. The governed view fetches cross-origin, so it sees the projection, not
  // the raw body: the projection must carry that one declared field, or the note can never say
  // "N of M returned" in a real host.
  const listNode = (path: string, query?: Record<string, unknown>) =>
    ({ type: "list", id: "n1", props: {}, bind: { path, ...(query ? { query } : {}) } }) as any;

  it("GET /api/capabilities?limit=5 from an unknown origin: the window note reports the server's real total", async () => {
    const { listWindow } = await import("../mcp/dashboard-ir-renderer.js");
    const raw = (await app.inject({ method: "GET", url: "/api/capabilities" })).json();
    expect(Number.isSafeInteger(raw.total) && raw.total > 5).toBe(true);
    const res = await app.inject({ method: "GET", url: "/api/capabilities?limit=5", headers: { origin: UNKNOWN } });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    const body = res.json();
    expect(body.items).toHaveLength(5);
    expect(listWindow(listNode("/api/capabilities", { limit: 5 }), body, 5).note).toBe(`5 of ${raw.total} returned`);
  });

  it("GET /api/capabilities from an unknown origin: a window holding the whole collection needs no note (the total vouches for it)", async () => {
    const { listWindow } = await import("../mcp/dashboard-ir-renderer.js");
    const raw = (await app.inject({ method: "GET", url: "/api/capabilities" })).json();
    const res = await app.inject({ method: "GET", url: "/api/capabilities", headers: { origin: UNKNOWN } });
    const body = res.json();
    expect(body.items).toHaveLength(raw.total);
    // Before this merge-up the projection dropped `total`, so this note was "total not shown".
    expect(listWindow(listNode("/api/capabilities"), body, body.items.length).note).toBeNull();
  });

  it("the projection's page fields are EXACTLY the declared paged.total keys: never offset, limit or hasMore; none for a profile that declares no total", async () => {
    const { projectIrRead } = await import("../mcp/dashboard-ir-read-projection.js");
    const { LIST_PROFILES } = await import("../mcp/dashboard-ir.js");
    expect(LIST_PROFILES["/api/capabilities"]!.paged?.total).toBe("total");
    expect(LIST_PROFILES["/api/jobs"]!.paged?.total).toBeUndefined();
    const page = { total: 3, offset: 0, limit: 50, hasMore: false };
    expect(projectIrRead("/api/capabilities", { items: [], ...page })).toEqual({ items: [], total: 3 });
    expect(projectIrRead("/api/jobs", { jobs: [], ...page })).toEqual({ jobs: [] });
    // A declared total that is not a primitive is dropped whole, like any other projected leaf.
    expect(projectIrRead("/api/capabilities", { items: [], total: { n: 3, secret: "x" } })).toEqual({ items: [] });
  });
});
