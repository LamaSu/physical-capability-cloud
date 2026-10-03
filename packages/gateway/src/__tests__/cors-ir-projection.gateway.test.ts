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
    for (const k of Object.keys(body)) expect(["items", "total", "offset", "limit", "hasMore", "asOf"]).toContain(k);
  });
});
