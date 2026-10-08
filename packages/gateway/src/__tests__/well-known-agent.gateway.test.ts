/**
 * Opus r1 F4 (#603): well-known-agent.test.ts serves /.well-known/agent.md from a bare Fastify, so it
 * never sees the root hooks of the real server, nor HEAD, nor the headers the server adds.
 *
 * Every root hook reaches this route, whatever the registration order: in Fastify 4.29.1 a hook added
 * to the root is also added to each existing child context (fastify.js _addHook, which recurses over
 * kChildren). So the N105 target guard, CORS, the IR projection, security headers, the rate limiter and
 * apiGate all run here; apiGate refuses a non-canonical target itself and skips non-/api paths.
 *
 * This drives the FULL gateway (createGateway). The non-canonical targets go over a raw socket,
 * because light-my-request's inject normalises a target before routing it.
 */
import { readFileSync } from "node:fs";
import net from "node:net";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.PCC_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.PCC_SEED_DATA = "false";

const artifact = readFileSync(new URL("../../../../apps/dashboard/public/.well-known/agent.md", import.meta.url), "utf8");
const FOREIGN_ORIGIN = "https://elsewhere.example";

let app: FastifyInstance;
let port = 0;

/** The status line of one raw HTTP/1.1 GET, with the target sent byte for byte. */
function rawStatus(target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: agent-md.test\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (chunk) => (data += chunk.toString("utf8")));
    socket.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0)));
    socket.on("error", reject);
  });
}

beforeAll(async () => {
  const { createGateway } = await import("../server.js");
  app = (await createGateway(0)).app as unknown as FastifyInstance;
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe("/.well-known/agent.md through the real gateway (Opus r1 F4)", () => {
  for (const method of ["GET", "HEAD"] as const) {
    for (const origin of [undefined, FOREIGN_ORIGIN]) {
      it(`${method} with no key${origin ? ", from a foreign Origin" : ""}: 200, the artifact, markdown, 300 s cache, ACAO * and nosniff`, async () => {
        const res = await app.inject({ method, url: "/.well-known/agent.md", headers: origin ? { origin } : {} });
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toBe("text/markdown; charset=utf-8");
        expect(res.headers["cache-control"]).toBe("public, max-age=300");
        expect(res.headers["access-control-allow-origin"]).toBe("*");
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
        expect(res.body).toBe(method === "GET" ? artifact : "");
      });
    }
  }

  it("refuses non-canonical spellings of the path with 400 (N105), and serves the canonical one over the same socket client", async () => {
    expect(await rawStatus("/.well-known/agent.md")).toBe(200);
    expect(await rawStatus("/.well-known/agent.md;x")).toBe(400);
    expect(await rawStatus("/.well-known/%61gent.md")).toBe(400);
  });
});

/**
 * Opus r1 F6: agent.md's auth labels were hand-kept, and no test tied them to the gate. Each buyer
 * action is sent with no key and an empty body: a "public" action must not get apiGate's 401
 * api_key_required (nor a 402); a "Bearer <key> required" action must get exactly that 401.
 */
describe("each buyer action's auth label matches the real gateway (Opus r1 F6)", () => {
  interface LabelledAction { method: string; route: string; auth: string }
  const buyer = JSON.parse(readFileSync(new URL("../../../../starter/buyer/buyer-path.json", import.meta.url), "utf8")) as {
    steps: Array<{ actions: LabelledAction[] }>;
    reporting: LabelledAction;
  };
  const actions = [...buyer.steps.flatMap((step) => step.actions), buyer.reporting];

  it("labels every action public or key-required", () => {
    expect(actions.length).toBeGreaterThan(5);
    for (const { auth } of actions) expect(auth).toMatch(/^public\b|^Authorization: Bearer <key> required\b/);
  });

  for (const action of actions) {
    it(`${action.method} ${action.route} with no key: ${action.auth.startsWith("public") ? "not refused by the gate" : "401 api_key_required"}`, async () => {
      const res = await app.inject({
        method: action.method as "GET" | "POST",
        url: action.route.replace(/\{[^}]+\}/g, "auth-label-probe"),
        ...(action.method === "GET" ? {} : { payload: {} }),
      });
      const refusedByGate = res.statusCode === 401 && JSON.parse(res.body).error === "api_key_required";
      if (action.auth.startsWith("public")) {
        expect(refusedByGate, `${res.statusCode} ${res.body.slice(0, 120)}`).toBe(false);
        expect(res.statusCode).not.toBe(402);
      } else {
        expect(refusedByGate, `${res.statusCode} ${res.body.slice(0, 120)}`).toBe(true);
      }
    });
  }
});
