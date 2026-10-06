import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { getRepos } from "../db.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { hasValidAdminKey } from "../readmodels/job-execution.js";

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

describe("relay admin credential regressions", () => {
  it.each([
    ["one space", " "],
    ["three spaces", "   "],
    ["tab", "\t"],
    ["newline", "\n"],
    ["NBSP", "\u00a0"],
    ["mixed whitespace", " \t\u00a0\n"],
  ])("F1a: whitespace-only configured key (%s) grants nothing", (_label, value) => {
    expect(hasValidAdminKey(value, value)).toBe(false);
  });

  it.each([
    ["exact padded key", " k ", " k ", true],
    ["unpadded provided key", "k", " k ", false],
    ["unpadded configured key", " k ", "k", false],
  ] as const)("F1a: compares without trimming (%s)", (_label, provided, expected, valid) => {
    expect(hasValidAdminKey(provided, expected)).toBe(valid);
  });

  describe("raw admin header fields", () => {
    const envNames = ["PCC_ADMIN_KEY", "PCC_RELAY_GATE"] as const;
    let previousEnv: Map<string, string | undefined>;

    beforeEach(() => {
      previousEnv = new Map(envNames.map((name) => [name, process.env[name]]));
      process.env.PCC_ADMIN_KEY = "alpha, beta";
      delete process.env.PCC_RELAY_GATE;
    });

    afterEach(() => {
      for (const [name, value] of previousEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    it.each([
      ["same name", ["X-Admin-Key", "alpha", "X-Admin-Key", "beta"], "alpha, beta", true],
      ["mixed case", ["X-Admin-Key", "alpha", "x-admin-key", "beta"], "alpha, beta", true],
      ["two comma-valued fields", ["x-admin-key", "alpha, beta", "X-ADMIN-KEY", "alpha, beta"], "alpha, beta, alpha, beta", true],
      ["one comma-valued field", ["X-Admin-Key", "alpha, beta"], "alpha, beta", false],
    ] as const)("F1b: counts raw admin fields (%s)", async (_label, rawHeaders, header, refused) => {
      const { rejectRelayWithoutAdminKey } = await loadGate();
      const req = {
        url: "/api/relay/k/scope",
        routeOptions: { url: "/api/relay/:kernelId/scope" },
        headers: { "x-admin-key": header },
        raw: { rawHeaders: [...rawHeaders] },
      };
      const recorded: { status?: number; payload?: unknown } = {};
      const reply = { code: vi.fn(), send: vi.fn() };
      reply.code.mockImplementation((status: number) => {
        recorded.status = status;
        return reply;
      });
      reply.send.mockImplementation((payload: unknown) => {
        recorded.payload = payload;
        return reply;
      });
      await rejectRelayWithoutAdminKey(req as unknown as FastifyRequest, reply as unknown as FastifyReply);
      if (refused) {
        expect(recorded).toEqual({ status: 403, payload: REFUSAL });
        expect(reply.code).toHaveBeenCalledTimes(1);
        expect(reply.code).toHaveBeenCalledWith(403);
        expect(reply.send).toHaveBeenCalledTimes(1);
        expect(reply.send).toHaveBeenCalledWith(REFUSAL);
      } else {
        expect(reply.code).not.toHaveBeenCalled();
        expect(reply.send).not.toHaveBeenCalled();
      }
    });
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
  const emptyProbeCounts = () => ({
    onRequest: 0,
    preParsing: 0,
    jsonParser: 0,
    customParser: 0,
    preValidation: 0,
    preHandler: 0,
    handler: 0,
    notFound: 0,
    errorHandler: 0,
    onSend: 0,
    onResponse: 0,
  });
  let probeCounts = emptyProbeCounts();

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    process.env.PCC_SEED_DATA = "true";
    process.env.PCC_ADMIN_KEY = adminKey;
    delete process.env.PCC_RELAY_GATE;
    const { createGateway } = await import("../server.js");
    ({ app } = await createGateway(0));
    app.register(async (probe) => {
      probe.addHook("onRequest", async () => { probeCounts.onRequest++; });
      probe.addHook("preParsing", async (_req, _reply, payload) => {
        probeCounts.preParsing++;
        return payload;
      });
      probe.addHook("preValidation", async () => { probeCounts.preValidation++; });
      probe.addHook("preHandler", async () => { probeCounts.preHandler++; });
      probe.addHook("onSend", async (_req, _reply, payload) => {
        probeCounts.onSend++;
        return payload;
      });
      probe.addHook("onResponse", async () => { probeCounts.onResponse++; });
      probe.removeContentTypeParser("application/json");
      probe.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
        probeCounts.jsonParser++;
        try {
          done(null, JSON.parse(body as string));
        } catch (cause) {
          const error = cause as Error & { statusCode: number };
          error.statusCode = 400;
          done(error);
        }
      });
      probe.addContentTypeParser("application/x-gate-probe", { parseAs: "string" }, (_req, body, done) => {
        probeCounts.customParser++;
        done(null, body);
      });
      probe.setErrorHandler((error, _req, reply) => {
        probeCounts.errorHandler++;
        return reply.code(error.statusCode ?? 400).send({ probe: "error-handler" });
      });
      probe.setNotFoundHandler((_req, reply) => {
        probeCounts.notFound++;
        return reply.code(404).send({ probe: "not-found" });
      });
      probe.post("/:kernelId/scope", async () => {
        probeCounts.handler++;
        return { probe: "handler" };
      });
      probe.get("/:kernelId/tool-call/pending", async () => {
        probeCounts.handler++;
        return { probe: "handler" };
      });
    }, { prefix: "/api/relay/gate-probe" });
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

  function request(
    method: "GET" | "POST" | "OPTIONS",
    path: string,
    headers: Record<string, string | string[]> | Array<[string, string]> = {},
    body?: string,
  ) {
    if (transport === "inject") {
      const injectHeaders: Record<string, string> = {};
      const seen = new Set<string>();
      for (const [name, value] of Array.isArray(headers) ? headers : Object.entries(headers)) {
        if (Array.isArray(value) || seen.has(name.toLowerCase())) {
          throw new Error("Fact 3: light-my-request cannot send repeated header fields; it stringifies array values and builds ONE rawHeaders pair per name. Use the socket transport.");
        }
        seen.add(name.toLowerCase());
        injectHeaders[name] = value;
      }
      return app!.inject({ method, url: path, headers: injectHeaders, payload: body }).then((res) => ({
        status: res.statusCode,
        headers: res.headers as http.IncomingHttpHeaders,
        body: res.body ? res.json<Record<string, unknown>>() : {},
      }));
    }
    const socketHeaders: http.OutgoingHttpHeaders | string[] = Array.isArray(headers)
      ? ["Host", `127.0.0.1:${port}`, ...headers.flat()]
      : { ...headers };
    if (body !== undefined) {
      const length = String(Buffer.byteLength(body));
      if (Array.isArray(socketHeaders)) socketHeaders.push("Content-Length", length);
      else socketHeaders["content-length"] = length;
    }
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }>((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, method, path, headers: socketHeaders }, (res) => {
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
      req.end(body);
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

  const credentialEndpoints = [endpoints[2], endpoints[0]] as const;

  it.each(credentialEndpoints)("F1a: refuses a matching NBSP-only admin key on %s %s", async (method, path) => {
    process.env.PCC_ADMIN_KEY = "\u00a0";
    expectRefused(await request(method, path, { ...bearer(), "x-admin-key": "\u00a0" }));
  });

  if (transport === "inject") {
    // Fact 5: the HTTP parser trims ASCII spaces/tabs; inject preserves them.
    it.each(credentialEndpoints)("F1a: refuses a matching spaces-only admin key on %s %s", async (method, path) => {
      process.env.PCC_ADMIN_KEY = "   ";
      expectRefused(await request(method, path, { ...bearer(), "x-admin-key": "   " }));
    });

    it.each([
      ["same-name fields", [["X-Admin-Key", "alpha"], ["X-Admin-Key", "beta"]]],
      ["mixed-case fields", [["X-Admin-Key", "alpha"], ["x-admin-key", "beta"]]],
      ["array value", { "x-admin-key": ["alpha", "beta"] }],
    ] satisfies Array<[string, Record<string, string | string[]> | Array<[string, string]>]>)(
      "F1b: inject helper rejects %s instead of collapsing fields",
      (_label, headers) => {
        expect(() => request("GET", endpoints[2][1], headers)).toThrow(
          "Fact 3: light-my-request cannot send repeated header fields; it stringifies array values and builds ONE rawHeaders pair per name. Use the socket transport.",
        );
      },
    );
  }

  if (transport === "socket") {
    // Fact 3: light-my-request cannot represent repeated header fields.
    for (const [label, fieldName, first, second, configured] of [
      ["same name", "X-Admin-Key", "alpha", "beta", "alpha, beta"],
      ["mixed case", "x-admin-key", "alpha", "beta", "alpha, beta"],
      ["identical normal keys", "X-Admin-Key", adminKey, adminKey, adminKey],
    ] as const) {
      it.each(credentialEndpoints)(`F1b: refuses two admin fields (${label}) on %s %s`, async (method, path) => {
        process.env.PCC_ADMIN_KEY = configured;
        expectRefused(await request(method, path, [
          ["Authorization", `Bearer ${nonAdminKey}`],
          ["X-Admin-Key", first],
          [fieldName, second],
        ]));
      });
    }
  }

  it.each(credentialEndpoints)("F1b: lets one comma-valued admin field past the gate on %s %s", async (method, path) => {
    process.env.PCC_ADMIN_KEY = "alpha, beta";
    expectPastGate(await request(method, path, { ...bearer(), "x-admin-key": "alpha, beta" }));
  });

  it.each(["anonymous", "non-admin bearer"] as const)("F2: audits exactly one refused write from %s without resolving identity", async (caller) => {
    const path = `/api/relay/kernel-audit-${transport}-${caller === "anonymous" ? "anon" : "bearer"}/scope`;
    expectRefused(await request("POST", path, caller === "anonymous" ? {} : bearer()));
    const rows = () => getRepos().auditLog.query({ eventType: "http.write", limit: 10_000 })
      .filter((row) => (row.metadata as Record<string, unknown> | null)?.url === path);
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const matchingRows = rows();
    expect(matchingRows).toHaveLength(1);
    expect(matchingRows[0].metadata).toMatchObject({ url: path, statusCode: 403, method: "POST" });
    expect(matchingRows[0].actor).toBe(caller === "anonymous" ? "anonymous" : "authenticated");
    expect(matchingRows[0].actor).not.toBe(nonAdminKeyId);
    expect(matchingRows[0].actor).not.toBe("relay-gate-non-admin");
  });

  for (const [, path] of endpoints.slice(0, 2)) {
    it.each(["anonymous", "non-admin bearer"] as const)(`F3: refuses malformed JSON from %s before parsing on POST ${path}`, async (caller) => {
      expectRefused(await request("POST", path, {
        ...(caller === "anonymous" ? {} : bearer()),
        "content-type": "application/json",
      }, '{"scope":'));
    });

    it(`F3: admin malformed JSON reaches the root error handler on POST ${path}`, async () => {
      const response = await request("POST", path, {
        ...bearer(), "x-admin-key": adminKey, "content-type": "application/json",
      }, '{"scope":');
      expectPastGate(response);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "request_error", message: "Unexpected end of JSON input" });
    });

    it.each(["anonymous", "non-admin bearer"] as const)(`F3: refuses unsupported media type from %s before parsing on POST ${path}`, async (caller) => {
      expectRefused(await request("POST", path, {
        ...(caller === "anonymous" ? {} : bearer()),
        "content-type": "application/x-www-form-urlencoded",
      }, "scope=probe"));
    });

    it(`F3: admin unsupported media type reaches the root error handler on POST ${path}`, async () => {
      const response = await request("POST", path, {
        ...bearer(), "x-admin-key": adminKey, "content-type": "application/x-www-form-urlencoded",
      }, "scope=probe");
      expectPastGate(response);
      expect(response.status).toBe(415);
      expect(response.body).toEqual({
        error: "unsupported_media_type",
        message: "Unsupported Media Type: application/x-www-form-urlencoded",
      });
    });
  }

  const expectBadUrl = (response: Awaited<ReturnType<typeof request>>, path: string) => {
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "Bad Request",
      code: "FST_ERR_BAD_URL",
      message: `'${path}' is not a valid url component`,
      statusCode: 400,
    });
  };

  for (const caller of ["anonymous", "admin plus bearer"] as const) {
    it.each([
      ["GET", "/api/relay/%ZZ/tool-call/pending"],
      ["POST", "/api/relay/%ZZ/scope"],
    ] as const)(`F3: malformed URL bypasses hooks (${caller}) on %s %s`, async (method, path) => {
      expectBadUrl(await request(method, path, caller === "anonymous" ? {} : {
        ...bearer(), "x-admin-key": adminKey,
      }), path);
    });
  }

  it("F3: refuses a relay parameter longer than maxParamLength via the raw path", async () => {
    expectRefused(await request("GET", `/api/relay/${"k".repeat(101)}/tool-call/pending`, bearer()));
  });

  const probeCases = [
    ["valid JSON POST", "POST", "/api/relay/gate-probe/k/scope", "application/json", '{"scope":{}}'],
    ["malformed JSON POST", "POST", "/api/relay/gate-probe/k/scope", "application/json", '{"scope":'],
    ["custom media POST", "POST", "/api/relay/gate-probe/k/scope", "application/x-gate-probe", "probe"],
    ["matched GET", "GET", "/api/relay/gate-probe/k/tool-call/pending", undefined, undefined],
    ["unmatched GET", "GET", "/api/relay/gate-probe/no-such/route", undefined, undefined],
  ] as const;

  it.each(probeCases)("F3: probe refusal skips all request stages (%s)", async (_label, method, path, contentType, body) => {
    probeCounts = emptyProbeCounts();
    expectRefused(await request(method, path, {
      ...bearer(), ...(contentType ? { "content-type": contentType } : {}),
    }, body));
    await vi.waitFor(() => expect(probeCounts.onResponse).toBe(1));
    expect(probeCounts).toEqual({
      onRequest: 0, preParsing: 0, jsonParser: 0, customParser: 0,
      preValidation: 0, preHandler: 0, handler: 0, notFound: 0,
      errorHandler: 0, onSend: 1, onResponse: 1,
    });
  });

  for (const caller of ["non-admin bearer", "admin plus bearer"] as const) {
    it.each([
      ["GET", "/api/relay/gate-probe/%ZZ/tool-call/pending"],
      ["POST", "/api/relay/gate-probe/%ZZ/scope"],
    ] as const)(`F3: probe bad URL runs no hooks (${caller}) on %s %s`, async (method, path) => {
      probeCounts = emptyProbeCounts();
      expectBadUrl(await request(method, path, {
        ...bearer(), ...(caller === "admin plus bearer" ? { "x-admin-key": adminKey } : {}),
      }), path);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(probeCounts).toEqual({
        onRequest: 0, preParsing: 0, jsonParser: 0, customParser: 0,
        preValidation: 0, preHandler: 0, handler: 0, notFound: 0,
        errorHandler: 0, onSend: 0, onResponse: 0,
      });
    });
  }

  it.each([
    [probeCases[0][0], probeCases[0], 200, "handler", {
      onRequest: 1, preParsing: 1, jsonParser: 1, customParser: 0,
      preValidation: 1, preHandler: 1, handler: 1, notFound: 0,
      errorHandler: 0, onSend: 1, onResponse: 1,
    }],
    [probeCases[1][0], probeCases[1], 400, "error-handler", {
      onRequest: 1, preParsing: 1, jsonParser: 1, customParser: 0,
      preValidation: 0, preHandler: 0, handler: 0, notFound: 0,
      errorHandler: 1, onSend: 1, onResponse: 1,
    }],
    [probeCases[2][0], probeCases[2], 200, "handler", {
      onRequest: 1, preParsing: 1, jsonParser: 0, customParser: 1,
      preValidation: 1, preHandler: 1, handler: 1, notFound: 0,
      errorHandler: 0, onSend: 1, onResponse: 1,
    }],
    [probeCases[4][0], probeCases[4], 404, "not-found", {
      onRequest: 1, preParsing: 1, jsonParser: 0, customParser: 0,
      preValidation: 1, preHandler: 1, handler: 0, notFound: 1,
      errorHandler: 0, onSend: 1, onResponse: 1,
    }],
  ] as const)("F3: admin probe control reaches its callbacks (%s)", async (_caseLabel, scenario, status, probe, expectedCounts) => {
    const [_label, method, path, contentType, body] = scenario;
    probeCounts = emptyProbeCounts();
    const response = await request(method, path, {
      ...bearer(), "x-admin-key": adminKey,
      ...(contentType ? { "content-type": contentType } : {}),
    }, body);
    expectPastGate(response);
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ probe });
    await vi.waitFor(() => expect(probeCounts.onResponse).toBe(1));
    expect(probeCounts).toEqual(expectedCounts);
  });
});
