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
