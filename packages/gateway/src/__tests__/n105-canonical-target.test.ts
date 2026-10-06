/**
 * N105 (LIVE CRITICAL), internal until the prod fix ships. The router (find-my-way, Fastify 4) routes a
 * DIFFERENT path than the raw request target that every onRequest decision reads (apiGate's "/api/"
 * test, scopeChecker's rule match). Over a real socket (light-my-request's inject normalises targets,
 * so these tests speak raw HTTP to the real gateway):
 *   - "/%61pi/kernels" routes to /api/kernels (percent-encoded unreserved characters are decoded);
 *   - "http://x/api/kernels" (absolute form) routes to /api/kernels, while req.url keeps "http://x...";
 *   - "/api/contributors;/x" routes /api/contributors (";" is Fastify 4's second query delimiter), while the raw path has an
 *     extra segment that no scope rule matches;
 *   - "#..." is dropped by the router but kept in req.url.
 * Each of these, on master, skips authentication or a scope rule. The fix refuses all four, first.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import net from "node:net";
import type { AddressInfo } from "node:net";

process.env.PCC_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.PCC_SEED_DATA = "false";
process.env.PCC_ADMIN_KEY = "n105-test-admin-secret-0123456789";

let app: FastifyInstance;
let port = 0;
let operatorKey = "";
const CANONICAL_REFUSAL = { error: "bad_request", message: "The request target is not in canonical form." };

/** One raw HTTP/1.1 request; the target is sent byte for byte. */
function raw(method: string, target: string, headers: Record<string, string> = {}, body = ""): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      const head = [
        `${method} ${target} HTTP/1.1`,
        "Host: n105.test",
        "Connection: close",
        `Content-Length: ${Buffer.byteLength(body)}`,
        ...(body ? ["Content-Type: application/json"] : []),
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ].join("\r\n");
      socket.write(`${head}\r\n\r\n${body}`);
    });
    let data = "";
    socket.on("data", (c) => (data += c.toString("utf8")));
    socket.on("end", () => {
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0);
      resolve({ status, body: data.split("\r\n\r\n").slice(1).join("\r\n\r\n") });
    });
    socket.on("error", reject);
  });
}
const json = (b: string): unknown => {
  try {
    return JSON.parse(b.replace(/^[0-9a-f]+\r\n/i, "").replace(/\r\n0\r\n\r\n$/, ""));
  } catch {
    return b;
  }
};

beforeAll(async () => {
  const server = await import("../server.js");
  app = (await server.createGateway(0)).app as unknown as FastifyInstance;
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
  // A key that holds ONLY the operator scope, inserted directly (self-service provisioning mints ["*"],
  // which passes every scope rule and would prove nothing about the scope layer).
  const { getRepos } = await import("../db.js");
  const { generateApiKey } = await import("../auth/api-key-auth.js");
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  getRepos().apiKeys.insert({
    id: "n105-key-operator-only",
    keyHash,
    keyPrefix,
    operatorId: "n105-operator",
    scopes: JSON.stringify(["operator"]),
    rateLimit: "1000/hour",
    usageCount: "0",
    createdAt: new Date().toISOString(),
  } as never);
  operatorKey = rawKey;
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe("N105: the gateway refuses a request target the router would route differently", () => {
  it("control: the canonical target with no credentials is 401 (apiGate)", async () => {
    const res = await raw("POST", "/api/kernels", {}, "{}");
    expect(res.status).toBe(401);
  });

  it("[neg] reproduction: a percent-encoded /api prefix with no credentials is refused, never routed past apiGate", async () => {
    const res = await raw("POST", "/%61pi/kernels", {}, "{}");
    expect(json(res.body)).toEqual(CANONICAL_REFUSAL);
    expect(res.status).toBe(400);
  });

  it("[neg] reproduction: an encoded letter later in the path is refused too (/api/kern%65ls)", async () => {
    const res = await raw("POST", "/api/kern%65ls", {}, "{}");
    expect(json(res.body)).toEqual(CANONICAL_REFUSAL);
  });

  it("[neg] reproduction: an absolute-form target with no credentials is refused, never routed past apiGate", async () => {
    const res = await raw("POST", `http://127.0.0.1:${port}/api/kernels`, {}, "{}");
    expect(json(res.body)).toEqual(CANONICAL_REFUSAL);
    expect(res.status).toBe(400);
  });

  // The enforced scope rules in a governance-seeded database are the endpoint_scopes rows (N108 drops the
  // defaults whenever rows exist), e.g. POST /api/contributors -> contributor:write, an EXACT pattern.
  it("control: an operator-only key on POST /api/contributors (contributor:write) is 403 insufficient_scope", async () => {
    const res = await raw("POST", "/api/contributors", { Authorization: `Bearer ${operatorKey}` }, "{}");
    expect(res.status).toBe(403);
    expect((json(res.body) as { error?: string }).error).toBe("insufficient_scope");
  });

  it("[neg] reproduction: ';/x' after POST /api/contributors is refused, never routed past its scope rule", async () => {
    const res = await raw("POST", "/api/contributors;/x", { Authorization: `Bearer ${operatorKey}` }, "{}");
    expect(json(res.body)).toEqual(CANONICAL_REFUSAL);
    expect(res.status).toBe(400);
  });

  it("[neg] a raw '#' in the target is refused", async () => {
    const res = await raw("GET", "/api/kernels#x", { Authorization: `Bearer ${operatorKey}` });
    expect(json(res.body)).toEqual(CANONICAL_REFUSAL);
  });

  it("control: ';' and percent-escapes in the QUERY are not path decisions and stay allowed", async () => {
    const res = await raw("GET", "/api/kernels?q=%61;b", { Authorization: `Bearer ${operatorKey}` });
    expect(json(res.body)).not.toEqual(CANONICAL_REFUSAL);
  });

  it("control: an encoded RESERVED character in a path segment (%40, %3A) stays allowed", async () => {
    const res = await raw("GET", "/api/kernels/did%3Apkh%3Aa%40b", { Authorization: `Bearer ${operatorKey}` });
    expect(json(res.body)).not.toEqual(CANONICAL_REFUSAL);
  });
});
