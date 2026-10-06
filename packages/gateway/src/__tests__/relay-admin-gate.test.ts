import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { getRepos } from "../db.js";
import { provisionApiKey } from "../auth/api-key-auth.js";

const REFUSAL = {
  error: "forbidden",
  reason: "relay_disabled",
  message: "The device relay is closed on this deployment.",
};

// Load inside each unit test so the tests-first run also exercises the real
// server when this new middleware module has not been implemented yet.
async function loadGate() {
  const modulePath = "../middleware/relay-admin-gate.js";
  return import(modulePath) as Promise<typeof import("../middleware/relay-admin-gate.js")>;
}

describe("relay admin gate helpers", () => {
  it("exports the fixed refusal body", async () => {
    expect((await loadGate()).RELAY_DISABLED_REFUSAL).toEqual(REFUSAL);
  });

  it.each([
    [undefined, false],
    ["", false],
    ["OPEN", false],
    ["Open", false],
    ["true", false],
    [" open", false],
    ["open ", false],
    ["closed", false],
    ["open", true],
  ] as const)("PCC_RELAY_GATE=%s opens the gate: %s", async (value, expected) => {
    const { isRelayGateOpen } = await loadGate();
    const env: NodeJS.ProcessEnv = value === undefined ? {} : { PCC_RELAY_GATE: value };
    expect(isRelayGateOpen(env)).toBe(expected);
  });

  it.each([
    ["/api/relay", "/unrelated", true],
    ["/api/relay/:kernelId/tool-call", "/unrelated", true],
    ["/api/ot2", "/unrelated", true],
    ["/api/ot2/*", "/unrelated", true],
    [undefined, "/api/relay", true],
    [undefined, "/api/relay/kernel-a/tool-call", true],
    [undefined, "/api/ot2", true],
    [undefined, "/api/ot2/scope", true],
    [undefined, "/api/relay?target=/other", true],
    [undefined, "/api/ot2/scope?next=/other?x=1", true],
    [undefined, "//api///relay//kernel-a///tool-call", true],
    [undefined, "/api//ot2///scope?next=//other", true],
    ["/unrelated", "/api/relay/kernel-a/scope", true],
    ["/unrelated", "/api/ot2/scope", true],
    [undefined, "/api/kernels", false],
    [undefined, "/api/kernels?next=/api/relay/scope", false],
    [undefined, "/api/relay-other", false],
    [undefined, "/api/ot20/scope", false],
    [undefined, "/API/relay/kernel-a/scope", false],
    [undefined, "/api/Relay/kernel-a/scope", false],
    [undefined, "/api/OT2/scope", false],
    ["/api/relay-other", "/unrelated", false],
    ["/api/ot20/*", "/unrelated", false],
    ["/api/RELAY/:kernelId/scope", "/unrelated", false],
  ] as const)("matched route %s and raw URL %s count as relay: %s", async (route, url, expected) => {
    const { isRelayRequest } = await loadGate();
    expect(isRelayRequest({ url, routeOptions: route === undefined ? undefined : { url: route } })).toBe(expected);
  });
});

describe.each(["inject", "socket"] as const)("relay admin gate through createGateway (%s)", (transport) => {
  const envNames = ["PCC_DB_PATH", "PCC_SEED_DATA", "PCC_ADMIN_KEY", "PCC_RELAY_GATE"] as const;
  const previousEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  const adminKey = "relay-admin-gate-test-secret";
  const endpoints = [
    ["POST", "/api/relay/kernel-gate-test/scope"],
    ["POST", "/api/relay/kernel-gate-test/tool-call"],
    ["GET", "/api/relay/kernel-gate-test/tool-call/pending"],
  ] as const;
  let app: FastifyInstance | undefined;
  let port: number;
  let nonAdminKey: string;
  let nonAdminKeyId: string;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    process.env.PCC_SEED_DATA = "true";
    process.env.PCC_ADMIN_KEY = adminKey;
    delete process.env.PCC_RELAY_GATE;
    const { createGateway } = await import("../server.js");
    ({ app } = await createGateway(0));
    const key = provisionApiKey({
      operatorId: "relay-gate-non-admin",
      name: "Fully scoped non-admin relay caller",
      scopes: ["*"],
    });
    nonAdminKey = key.rawKey;
    nonAdminKeyId = key.record.id;
    await app.ready();
    if (transport === "socket") {
      await app.listen({ port: 0, host: "127.0.0.1" });
      port = (app.server.address() as AddressInfo).port;
    }
  }, 120_000);

  beforeEach(() => {
    process.env.PCC_ADMIN_KEY = adminKey;
    delete process.env.PCC_RELAY_GATE;
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      for (const [name, value] of previousEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  function request(method: "GET" | "POST" | "OPTIONS", path: string, headers: Record<string, string> = {}) {
    if (transport === "inject") {
      return app!.inject({ method, url: path, headers }).then((res) => ({
        status: res.statusCode,
        headers: res.headers as http.IncomingHttpHeaders,
        body: res.body ? res.json<Record<string, unknown>>() : {},
      }));
    }
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }>((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, method, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          try {
            const body = Buffer.concat(chunks).toString("utf8");
            resolve({ status: res.statusCode!, headers: res.headers, body: body ? JSON.parse(body) : {} });
          } catch (error) {
            reject(error);
          }
        });
      });
      req.setTimeout(5_000, () => req.destroy(new Error("Relay gate socket request timed out")));
      req.on("error", reject);
      req.end();
    });
  }

  const bearer = () => ({ authorization: `Bearer ${nonAdminKey}` });
  const expectRefused = (response: Awaited<ReturnType<typeof request>>) => {
    expect(response.status).toBe(403);
    expect(response.body).toEqual(REFUSAL);
  };
  const expectPastGate = (response: Awaited<ReturnType<typeof request>>) => {
    expect(response.status === 403 && response.body.reason === "relay_disabled").toBe(false);
  };

  it.each(endpoints)("refuses a fully scoped non-admin key on %s %s", async (method, path) => {
    expectRefused(await request(method, path, bearer()));
  });

  it.each(endpoints)("lets the admin key past the gate on %s %s", async (method, path) => {
    expectPastGate(await request(method, path, { ...bearer(), "x-admin-key": adminKey }));
  });

  it.each(["wrong", "empty", "unset", "blank"] as const)("refuses when the admin credential is %s", async (condition) => {
    const header = condition === "empty" ? "" : condition === "wrong" ? "wrong-admin-key" : adminKey;
    if (condition === "unset") delete process.env.PCC_ADMIN_KEY;
    if (condition === "blank") process.env.PCC_ADMIN_KEY = "";
    for (const [method, path] of endpoints) {
      expectRefused(await request(method, path, { ...bearer(), "x-admin-key": header }));
    }
  });

  it.each(endpoints)("open mode lets the non-admin key past the gate on %s %s", async (method, path) => {
    process.env.PCC_RELAY_GATE = "open";
    expectPastGate(await request(method, path, bearer()));
  });

  it("reads the mode and admin secret per request on the same running server", async () => {
    const [method, path] = endpoints[2];
    expectRefused(await request(method, path, bearer()));
    process.env.PCC_RELAY_GATE = "open";
    expectPastGate(await request(method, path, bearer()));
    process.env.PCC_RELAY_GATE = "OPEN";
    expectRefused(await request(method, path, bearer()));
    process.env.PCC_ADMIN_KEY = "rotated-relay-admin-key";
    expectRefused(await request(method, path, { ...bearer(), "x-admin-key": adminKey }));
    expectPastGate(await request(method, path, { ...bearer(), "x-admin-key": process.env.PCC_ADMIN_KEY }));
  });

  it("refuses anonymous relay requests before apiGate", async () => {
    expectRefused(await request("POST", endpoints[0][1]));
  });

  it("refuses preflight before CORS can reply", async () => {
    expectRefused(await request("OPTIONS", endpoints[0][1], {
      origin: "https://capability.network",
      "access-control-request-method": "POST",
    }));
  });

  it("refuses before CORS, rate limiting, trace-ID and API-key resolution run", async () => {
    const before = getRepos().apiKeys.findById(nonAdminKeyId)!.usageCount;
    const response = await request("GET", endpoints[2][1], { ...bearer(), origin: "https://capability.network" });
    expectRefused(response);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["ratelimit-limit"]).toBeUndefined();
    expect(response.headers["x-pcc-trace-id"]).toBeUndefined();
    expect(getRepos().apiKeys.findById(nonAdminKeyId)!.usageCount).toBe(before);
  });

  it.each([
    "/api/relay",
    "/api/relay/unmatched-route",
    "/api/ot2",
    "/api/ot2/tool-call/pending?kernelId=kernel-gate-test",
    "//api///relay//kernel-gate-test///tool-call/pending?next=/other",
  ])("refuses the relay family even at unmatched or normalized path %s", async (path) => {
    expectRefused(await request("GET", path, bearer()));
  });

  it("a valid admin key still needs the existing API authentication", async () => {
    const response = await request("GET", endpoints[2][1], { "x-admin-key": adminKey });
    expectPastGate(response);
    expect(response.status).toBe(401);
    expect(response.body.error).toBe("api_key_required");
  });

  it("keeps GET /api/kernels public without credentials", async () => {
    const response = await request("GET", "/api/kernels");
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.kernels)).toBe(true);
  });

  it("keeps POST /api/kernels at 401 api_key_required without credentials", async () => {
    const response = await request("POST", "/api/kernels");
    expect(response.status).toBe(401);
    expect(response.body.error).toBe("api_key_required");
  });
});
