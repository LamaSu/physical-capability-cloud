/**
 * Row 37 / operator item 109(b): the governed GenUI view (the closed-IR MCP App) reads PCC's
 * public read routes cross-origin with credentials:"omit". The view runs at the MCP App domain
 * or a host's sandbox origin, which can be the opaque "null".
 *
 * Before this change the gateway's CORS was a static, credentialed allowlist, so a browser
 * blocked every such read and every bound element rendered "unavailable".
 *
 * corsDelegator keeps that allowlist EXACTLY as before and adds ONE credential-less allowance:
 * a GET (or the preflight for a GET) of a route the closed IR can bind to, from any origin.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CORS_ALLOWLIST_OPTIONS, corsDelegator } from "../middleware/security-hardening.js";
import { isIrBindablePath } from "../mcp/dashboard-ir.js";

const IR_PATHS = [
  "/api/capabilities", "/api/capabilities/cap-1",
  "/api/kernels", "/api/kernels/k-1",
  "/api/jobs", "/api/jobs/j-1", "/api/jobs/j-1/status",
];
const NOT_IR_PATHS = [
  "/api/settlement/status",          // reserved: settlement is never bindable
  "/api/escrow/e1",                  // money state: never bindable
  "/api/keys",                       // not a read route the IR knows
  "/api/capabilities/types",         // a lowercase word is not an id segment
  "/api/kernels/marketplace",        // reserved collection route
  "/api/jobs/j-1/evidence",          // not in the bind registry
  "/api/capabilities%2Fcap-1",       // encoded separator
];
const ORIGINS: Array<string | undefined> = [
  undefined,                               // same-origin / server-to-server
  "https://capability.network",            // allowlisted
  "https://lamasu.github.io",              // allowlisted
  "http://localhost:5173",                 // allowlisted
  "https://evil.example",                  // unknown
  "https://mcp-apps.capability.network",   // the MCP App domain (unknown to the allowlist)
  "null",                                  // an opaque sandbox origin
];
const ALLOWLISTED = new Set(["https://capability.network", "https://lamasu.github.io", "http://localhost:5173"]);
const CORS_HEADERS = ["access-control-allow-origin", "access-control-allow-credentials", "access-control-allow-methods", "access-control-allow-headers", "access-control-max-age", "vary"];

async function appWith(opts: Record<string, unknown>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, opts);
  // Every path resolves, so only CORS decides the headers. The plugin owns OPTIONS (preflight).
  app.get("/*", async () => ({ ok: true }));
  app.post("/*", async () => ({ ok: true }));
  await app.ready();
  return app;
}
type Req = { method: "GET" | "POST" | "OPTIONS"; url: string; acrm?: string };
async function corsHeaders(app: FastifyInstance, origin: string | undefined, r: Req): Promise<Record<string, string | undefined>> {
  const headers: Record<string, string> = {};
  if (origin !== undefined) headers.origin = origin;
  if (r.acrm) headers["access-control-request-method"] = r.acrm;
  const res = await app.inject({ method: r.method, url: r.url, headers });
  const out: Record<string, string | undefined> = {};
  for (const h of CORS_HEADERS) { const v = res.headers[h]; out[h] = v === undefined ? undefined : String(v); }
  return out;
}

let legacy: FastifyInstance;
let next: FastifyInstance;
beforeAll(async () => {
  legacy = await appWith({ ...CORS_ALLOWLIST_OPTIONS }); // the pre-row-37 static configuration, verbatim
  next = await appWith({ delegator: corsDelegator });     // what server.ts registers now
});
afterAll(async () => { await legacy.close(); await next.close(); });

describe("isIrBindablePath: exactly the closed IR's bind registry", () => {
  it("accepts every IR-bindable read route", () => {
    for (const p of IR_PATHS) expect(isIrBindablePath(p), p).toBe(true);
  });
  it("refuses reserved, money, unknown, word-segment, encoded and dotted paths", () => {
    for (const p of [...NOT_IR_PATHS, "/api/capabilities/../keys", "/api/capabilities/./cap-1", "api/capabilities", ""]) expect(isIrBindablePath(p), p).toBe(false);
  });
});

describe("row 37: the gap at master (the old static CORS configuration)", () => {
  it("a credential-less GET from the MCP App domain got NO Access-Control-Allow-Origin, so the browser blocked it", async () => {
    const h = await corsHeaders(legacy, "https://mcp-apps.capability.network", { method: "GET", url: "/api/capabilities" });
    expect(h["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("corsDelegator: the allowlist is unchanged everywhere except the one new allowance", () => {
  const requests: Req[] = [
    ...[...IR_PATHS, ...NOT_IR_PATHS].map((url) => ({ method: "GET" as const, url })),
    ...[...IR_PATHS, ...NOT_IR_PATHS].map((url) => ({ method: "GET" as const, url: url + "?status=done&limit=5" })),
    { method: "POST", url: "/api/jobs" }, { method: "POST", url: "/api/capabilities" },
    { method: "OPTIONS", url: "/api/capabilities", acrm: "GET" }, { method: "OPTIONS", url: "/api/capabilities", acrm: "POST" },
    { method: "OPTIONS", url: "/api/jobs/j-1/status", acrm: "GET" }, { method: "OPTIONS", url: "/api/keys", acrm: "GET" },
    { method: "OPTIONS", url: "/api/escrow/e1", acrm: "GET" },
  ];
  const isNewAllowance = (origin: string | undefined, r: Req): boolean =>
    origin !== undefined && !ALLOWLISTED.has(origin) &&
    (r.method === "GET" || (r.method === "OPTIONS" && r.acrm === "GET")) && isIrBindablePath(r.url.split("?")[0]!);

  it("every other (origin, request) pair gets byte-identical CORS headers to the old configuration", async () => {
    let compared = 0;
    for (const origin of ORIGINS) for (const r of requests) {
      if (isNewAllowance(origin, r)) continue;
      expect(await corsHeaders(next, origin, r), `${origin ?? "(no origin)"} ${r.method} ${r.url} ${r.acrm ?? ""}`).toEqual(await corsHeaders(legacy, origin, r));
      compared++;
    }
    expect(compared).toBeGreaterThan(150); // the matrix is not vacuous
  });

  it("the new allowance: an unknown origin's GET of an IR route gets '*' and NEVER Allow-Credentials", async () => {
    let checked = 0;
    for (const origin of ORIGINS) for (const r of requests) {
      if (!isNewAllowance(origin, r) || r.method !== "GET") continue;
      const h = await corsHeaders(next, origin, r);
      expect(h["access-control-allow-origin"], `${origin} ${r.url}`).toBe("*");
      expect(h["access-control-allow-credentials"], `${origin} ${r.url}`).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(3 * IR_PATHS.length * 2); // 3 unknown origins x IR paths x (with and without a query)
  });

  it("the preflight for a GET of an IR route allows GET only, without credentials; a preflight for POST gets nothing new", async () => {
    const ok = await corsHeaders(next, "https://mcp-apps.capability.network", { method: "OPTIONS", url: "/api/capabilities", acrm: "GET" });
    expect(ok["access-control-allow-origin"]).toBe("*");
    expect(ok["access-control-allow-methods"]).toBe("GET");
    expect(ok["access-control-allow-credentials"]).toBeUndefined();
    const post = await corsHeaders(next, "https://mcp-apps.capability.network", { method: "OPTIONS", url: "/api/capabilities", acrm: "POST" });
    expect(post["access-control-allow-origin"]).toBeUndefined();
  });

  it("an unknown origin still gets NO CORS headers on a non-IR route or a write", async () => {
    for (const r of [{ method: "GET", url: "/api/keys" }, { method: "GET", url: "/api/escrow/e1" }, { method: "POST", url: "/api/capabilities" }] as Req[]) {
      const h = await corsHeaders(next, "https://evil.example", r);
      expect(h["access-control-allow-origin"], `${r.method} ${r.url}`).toBeUndefined();
      expect(h["access-control-allow-credentials"], `${r.method} ${r.url}`).toBeUndefined();
    }
  });
});

describe("wiring: server.ts registers the delegator, not the static options", () => {
  it("the gateway's CORS registration is { delegator: corsDelegator }", () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../server.ts"), "utf8");
    expect(src).toContain("await app.register(cors, { delegator: corsDelegator });");
    expect(src).not.toMatch(/register\(cors,\s*\{\s*origin:/);
  });
});
