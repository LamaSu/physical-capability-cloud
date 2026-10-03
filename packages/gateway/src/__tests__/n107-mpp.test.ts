/**
 * Cross-family review r1 of #514 (rm-n107-514-r1-081b0c49), MEDIUM 3, MPP half: the MPP payment
 * path keeps a paid request's path only, and its 402, success and fail-closed outcomes move
 * exactly the counters they should. The MPP charge handler is replaced by a scripted one; the
 * payment gate runs unchanged.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Writable } from "node:stream";

const charges = vi.hoisted(() => ({ next: [] as Array<"402" | "ok" | "throw" | "throw-marker"> }));
vi.mock("@pcc/payments", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const Real = actual.MppMiddleware as { parsePrice(price: string): unknown };
  class ScriptedMpp {
    static parsePrice(price: string) {
      return Real.parsePrice(price);
    }
    constructor(_config: unknown) {}
    getProtectedRoutes() {
      return [];
    }
    getRouteHandler(_method: string, path: string) {
      return path === "/api/x402/routes"
        ? { isProtected: true, routeConfig: { amount: "0.25", description: "priced read" } }
        : { isProtected: false };
    }
    createChargeHandler() {
      return async (input: Request) => {
        const outcome = charges.next.shift() ?? "402";
        if (outcome === "throw") throw new Error("charge failed");
        // A payment library whose error echoes the request it handled (#514 r2, MEDIUM 2).
        if (outcome === "throw-marker") throw new Error(`bad charge for ${new URL(input.url).searchParams.get("marker")}`);
        if (outcome === "402") {
          return { status: 402, challenge: new Response(null, { status: 402, headers: { "WWW-Authenticate": 'Payment realm="n107"' } }) };
        }
        return { status: 200 };
      };
    }
  }
  return { ...actual, MppMiddleware: ScriptedMpp };
});

const mark = (name: string) => ["n107mpp", name, "9b3f"].join("-");
const ADMIN = ["n107mpp", "admin", "key"].join("-");

let app: FastifyInstance;
const logLines: string[] = [];

beforeAll(async () => {
  process.env.PCC_ADMIN_KEY = ADMIN;
  process.env.PCC_PAYMENT_ENABLED = "true";
  process.env.MPP_SECRET_KEY = ["n107mpp", "secret", "value"].join("-");
  delete process.env.PCC_X402_LEGACY;
  delete process.env.MPP_ENABLED;
  // The gateway's closed logger options (N107b); before them, pino's defaults (the reproduction).
  const sinksModule = (await import("../observability/closed-sinks.js").catch(() => null)) as { gatewayLoggerOptions(): Record<string, unknown> } | null;
  const gatewayLoggerOptions = () => (sinksModule ? sinksModule.gatewayLoggerOptions() : { level: "info" });
  const stream = new Writable({
    write(chunk, _encoding, done) {
      logLines.push(String(chunk));
      done();
    },
  });
  app = Fastify({ logger: { ...gatewayLoggerOptions(), stream } });
  const { paymentGate } = await import("../middleware/x402-gate.js");
  await app.register(paymentGate);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  delete process.env.PCC_ADMIN_KEY;
  delete process.env.PCC_PAYMENT_ENABLED;
  delete process.env.MPP_SECRET_KEY;
});

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers });
const stats = async () => (await get("/api/x402/stats", { "x-admin-key": ADMIN })).json();
const delta = (a: any, b: any) => [b.totalRequests - a.totalRequests, b.gatedRequests - a.gatedRequests, b.paidRequests - a.paidRequests];

describe("MEDIUM 3 (r1 of #514, MPP): payments keep the path only, and each outcome moves exactly its counters", () => {
  it("a 402, a success and a failed charge", async () => {
    const s0 = await stats();
    expect(s0.protocol).toBe("mpp");

    charges.next.push("402");
    const unpaid = await get(`/api/x402/routes?zq1=${mark("unpaid")}`);
    expect(unpaid.statusCode).toBe(402);
    expect(unpaid.headers["www-authenticate"]).toContain("Payment");
    const s1 = await stats();
    // Each stats read is itself a request the gate counts.
    expect(delta(s0, s1)).toEqual([2, 1, 0]);

    charges.next.push("ok");
    const paid = await get(`/api/x402/routes?code=${mark("paid")}`);
    expect(paid.statusCode).toBe(200);
    const s2 = await stats();
    expect(delta(s1, s2)).toEqual([2, 0, 1]);
    expect(s2.recentPayments[0]).toMatchObject({ path: "/api/x402/routes", payer: "mpp-verified", amount: "0.25" });

    charges.next.push("throw");
    const failed = await get(`/api/x402/routes?x_custom=${mark("failed")}`);
    expect(failed.statusCode).toBe(402);
    const s3 = await stats();
    expect(delta(s2, s3)).toEqual([2, 1, 0]);

    const all = JSON.stringify(s3);
    for (const name of ["unpaid", "paid", "failed"]) expect(all).not.toContain(mark(name));
    // Another caller sees the counts, never the list.
    const other = (await get("/api/x402/stats")).json();
    expect(other.recentPayments).toBeUndefined();
    expect(other.paidRequests).toBe(s3.paidRequests);
  });
});

describe("MEDIUM 2 (r2 of #514): the MPP failure log carries a fixed code and the error's class, never the library's message", () => {
  it("a charge that throws with the request's value in its message: the value is not logged", async () => {
    const marker = mark("thrown");
    const start = logLines.length;
    charges.next.push("throw-marker");
    const failed = await get(`/api/x402/routes?marker=${marker}`);
    expect(failed.statusCode).toBe(402);
    const logged = logLines.slice(start).join("");
    expect(logged).toContain("mpp_check_failed");
    expect(logged).toContain('"errorClass":"Error"');
    expect(logged).not.toContain(marker);
  });
});
