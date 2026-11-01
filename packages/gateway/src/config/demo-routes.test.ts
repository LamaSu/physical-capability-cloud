import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { demoRoutesEnabled, gateDemoRoutes, notAvailable } from "./demo-routes.js";

const BODY = { error: "not_available" as const, message: "A. B.", see: ["/x"] };
let previousFlag: string | undefined;
let previousNodeEnv: string | undefined;
const apps: FastifyInstance[] = [];
beforeEach(() => {
  previousFlag = process.env.PCC_DEMO_ROUTES;
  previousNodeEnv = process.env.NODE_ENV;
  delete process.env.PCC_DEMO_ROUTES;
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  if (previousFlag === undefined) delete process.env.PCC_DEMO_ROUTES;
  else process.env.PCC_DEMO_ROUTES = previousFlag;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});

async function build(scope?: { except: readonly string[] } | { only: readonly string[] }) {
  const app = Fastify();
  apps.push(app);
  let calls = 0;
  await app.register(async (plugin) => {
    gateDemoRoutes(plugin, BODY, scope);
    plugin.get("/t", async () => { calls++; return { ran: true }; });
    plugin.get("/t/:id", async () => { calls++; return { ran: true }; });
    plugin.post("/t", async () => { calls++; return { ran: true }; });
  });
  await app.ready();
  return { app, calls: () => calls };
}

describe("N34 demo route helper", () => {
  it("A1 enables only the exact string 1", () => {
    expect(demoRoutesEnabled({ PCC_DEMO_ROUTES: "1" })).toBe(true);
    expect(demoRoutesEnabled({})).toBe(false);
    for (const value of ["", "0", "true", "TRUE", "yes", " 1", "1 ", "01"]) {
      expect(demoRoutesEnabled({ PCC_DEMO_ROUTES: value }), value).toBe(false);
    }
  });
  it("A1b ignores the demo flag in production", () => {
    expect(demoRoutesEnabled({ PCC_DEMO_ROUTES: "1", NODE_ENV: "production" })).toBe(false);
  });
  it("A2 returns exactly the ruled three-key body", () => {
    expect(notAvailable("A.", "B.", ["/x"])).toEqual(BODY);
    expect(Object.keys(notAvailable("A.", "B.", ["/x"])).sort()).toEqual(["error", "message", "see"]);
  });
  it("A3 except keeps its handler; all handlers run with the flag", async () => {
    const { app } = await build({ except: ["POST /t"] });
    for (const url of ["/t", "/t/1"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(501);
      expect(res.json()).toEqual(BODY);
    }
    const head = await app.inject({ method: "HEAD", url: "/t" });
    expect(head.statusCode).toBe(501);
    expect(head.body).toBe("");
    expect((await app.inject({ method: "POST", url: "/t" })).json()).toEqual({ ran: true });
    process.env.PCC_DEMO_ROUTES = "1";
    for (const [method, url] of [["GET", "/t"], ["GET", "/t/1"], ["POST", "/t"]] as const) {
      expect((await app.inject({ method, url })).json()).toEqual({ ran: true });
    }
  });
  it("A4 only gates its GET template and HEAD twin", async () => {
    const { app } = await build({ only: ["GET /t/:id"] });
    const get = await app.inject({ method: "GET", url: "/t/1" });
    expect(get.statusCode).toBe(501);
    expect(get.json()).toEqual(BODY);
    const head = await app.inject({ method: "HEAD", url: "/t/1" });
    expect(head.statusCode).toBe(501);
    expect(head.body).toBe("");
    for (const method of ["GET", "HEAD", "POST"] as const) {
      expect((await app.inject({ method, url: "/t" })).statusCode).toBe(200);
    }
    process.env.PCC_DEMO_ROUTES = "1";
    for (const [method, url] of [["GET", "/t"], ["GET", "/t/1"], ["POST", "/t"]] as const) {
      expect((await app.inject({ method, url })).json()).toEqual({ ran: true });
    }
  });
  it("A5 rejects before parsing malformed JSON", async () => {
    const { app } = await build();
    const res = await app.inject({ method: "POST", url: "/t", headers: { "content-type": "application/json" }, payload: "{not json" });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(BODY);
  });
  it("A6 never calls a gated GET, HEAD or POST handler", async () => {
    const { app, calls } = await build();
    for (const method of ["GET", "HEAD", "POST"] as const) {
      expect((await app.inject({ method, url: "/t" })).statusCode).toBe(501);
    }
    expect(calls()).toBe(0);
  });
});
