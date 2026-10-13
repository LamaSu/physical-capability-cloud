import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  createGatewayClient,
  GatewayClientError,
  strictEmergencyStopReader,
  type EmergencyStopReader,
} from "../src/gateway-client.js";

const baseUrl = "https://gateway.example.test";
const kernelId = "kernel:n144";
const jobId = "job:n144";
const bundleHash = `sha256:${"a".repeat(64)}`;
const bundle = { events: [], bundleHash };
const apiKey = ["pcc", "test", randomBytes(24).toString("hex")].join("_");
const canary = `server-canary-${randomBytes(24).toString("hex")}`;
const noiseString = `${canary} ${apiKey}`;

type Client = ReturnType<typeof createGatewayClient>;
type ClientConfig = Parameters<typeof createGatewayClient>[0];
type Evidence = Parameters<Client["postRelayEvidence"]>[1];

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function fixture(response: Response | (() => Response) = () => json({ jobs: [] }), options: Partial<ClientConfig> = {}) {
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    typeof response === "function" ? response() : response);
  const client = createGatewayClient({ baseUrl, apiKey, kernelId, fetchImpl, ...options });
  return { client, fetchImpl };
}

function stored(extra: Record<string, unknown> = {}) {
  return {
    stored: true, jobId, bundleId: "bundle:n144", contentHash: bundleHash,
    hashModel: "event_bundle_hash", eventsStored: 0, ...extra,
  };
}

function request(fetchImpl: ReturnType<typeof fixture>["fetchImpl"], index = 0) {
  const [url, init] = fetchImpl.mock.calls[index]!;
  return {
    url: String(url), method: init?.method,
    headers: Object.fromEntries(new Headers(init?.headers)),
    body: init?.body, redirect: init?.redirect,
  };
}

function expectNoCanaries(value: unknown) {
  for (const rendered of [String(value), JSON.stringify(value), inspect(value, { showHidden: true, depth: 6 })]) {
    expect(rendered).not.toContain(canary);
    expect(rendered).not.toContain(apiKey);
  }
}

async function withInherited(property: string, value: unknown, operation: () => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, property);
  Object.defineProperty(Object.prototype, property, { value, configurable: true, writable: true });
  try { await operation(); } finally {
    if (previous) Object.defineProperty(Object.prototype, property, previous);
    else Reflect.deleteProperty(Object.prototype, property);
  }
}

describe("gateway client construction and public surface", () => {
  it("freezes exactly the four relay methods and public display methods", () => {
    const { client } = fixture();
    expect(Object.isFrozen(client)).toBe(true);
    expect(Reflect.ownKeys(client)).toEqual(expect.arrayContaining([
      "pollJobs", "heartbeat", "reportInProgress", "postRelayEvidence", "toJSON", "toString", inspect.custom,
    ]));
    expect(Reflect.ownKeys(client)).toHaveLength(7);
    expect(client.toJSON()).toEqual({ baseUrl, kernelId });
    expect(String(client)).toContain(baseUrl);
    expect(String(client)).toContain(kernelId);
    expectNoCanaries(client);
    expect(inspect(client, { showHidden: true, depth: 6 })).toContain(kernelId);
  });

  it.each([
    "http://remote.example.test", "https://operator@remote.example.test", "https://@remote.example.test",
    "https://remote.example.test/?access=private", "https://remote.example.test/#fragment",
    "https://remote.example.test/?", "https://remote.example.test/#", "https://remote.example.test/ with-space",
    "https:remote.example.test", "https:/remote.example.test", "https:///remote.example.test",
    String.raw`https:\\remote.example.test`, String.raw`https://remote.example.test\@other.example.test`,
  ])("rejects a gateway URL outside the HostConfig rule: %s", (invalidBaseUrl) => {
    let caught: unknown;
    try { fixture(undefined, { baseUrl: invalidBaseUrl }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(GatewayClientError);
    expectNoCanaries(caught);
  });

  it.each(["http://127.0.0.1:8080", "http://[::1]:8080", "http://localhost:8080"])("accepts loopback %s", (url) => {
    expect(() => fixture(undefined, { baseUrl: url })).not.toThrow();
  });

  it.each(["", "operator key", `${apiKey}\n`, ["pcc", "test", "a".repeat(15)].join("_"), ["pcc", "live", "a".repeat(257)].join("_")])(
    "rejects malformed keys without retaining their values (%s)", (key) => {
      let caught: unknown;
      try { fixture(undefined, { apiKey: key }); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(GatewayClientError);
      expectNoCanaries(caught);
    },
  );

  it.each([16, 256])("accepts both key environments at the %s-character token boundary", (length) => {
    for (const environment of ["live", "test"]) {
      const key = ["pcc", environment, "a".repeat(length)].join("_");
      expect(() => fixture(undefined, { apiKey: key })).not.toThrow();
    }
  });

  it.each(["", "a".repeat(201), "kernel\nother", "kernel\u007fother", "kernel\u0000other"])("rejects invalid kernel identity %j", (id) => {
    expect(() => fixture(undefined, { kernelId: id })).toThrow(GatewayClientError);
  });

  it("a malformed key and URL canary never reaches a thrown error or display", () => {
    for (const bad of [{ apiKey: `${apiKey} ${canary}` }, { baseUrl: `https://${canary}@example.test` }, { kernelId: `${canary}\n` }]) {
      let caught: unknown;
      try { fixture(undefined, bad); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(GatewayClientError);
      expectNoCanaries(caught);
      expectNoCanaries((caught as Error).message);
      expect(Object.hasOwn(caught as object, "cause")).toBe(false);
      expect(Object.keys(caught as object).every((key) => ["name", "code"].includes(key))).toBe(true);
      expect((caught as GatewayClientError).code).toMatch(/^[a-z_]+$/);
    }
  });

  it("replaces a getter's externally mutated GatewayClientError with its own closed error", () => {
    const external = new GatewayClientError("bad_api_key");
    external.message = noiseString;
    Object.defineProperty(external, "code", { value: noiseString });
    Object.defineProperty(external, "cause", { value: noiseString });
    const config = { baseUrl, kernelId, get apiKey(): string { throw external; } };
    let caught: unknown;
    try { createGatewayClient(config); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(GatewayClientError);
    expect(caught).not.toBe(external);
    expect((caught as GatewayClientError).code).toBe("bad_config");
    expectNoCanaries(caught);
    expectNoCanaries((caught as Error).message);
    expect(Object.hasOwn(caught as object, "cause")).toBe(false);
  });

  it.each([null, undefined, [], false, "configuration"])("rejects a nonobject configuration %j with a closed code", (config) => {
    let caught: unknown;
    try { createGatewayClient(config as unknown as ClientConfig); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(GatewayClientError);
    expect((caught as GatewayClientError).code).toBe("bad_config");
    expectNoCanaries(caught);
  });

  it.each([
    [{ timeoutMs: 0 }, "bad_timeout"], [{ timeoutMs: -1 }, "bad_timeout"],
    [{ timeoutMs: 1.5 }, "bad_timeout"], [{ timeoutMs: Number.NaN }, "bad_timeout"],
    [{ timeoutMs: Number.POSITIVE_INFINITY }, "bad_timeout"], [{ timeoutMs: 2_147_483_648 }, "bad_timeout"],
    [{ timeoutMs: null }, "bad_timeout"], [{ maxResponseBytes: 0 }, "bad_response_limit"],
    [{ maxResponseBytes: -1 }, "bad_response_limit"], [{ maxResponseBytes: 1.5 }, "bad_response_limit"],
    [{ maxResponseBytes: Number.NaN }, "bad_response_limit"], [{ maxResponseBytes: null }, "bad_response_limit"],
    [{ fetchImpl: noiseString }, "bad_fetch"], [{ emergencyStopReader: noiseString }, "bad_reader"],
  ] as const)("rejects invalid construction options %j with %s", (options, code) => {
    let caught: unknown;
    try { fixture(undefined, options as unknown as Partial<ClientConfig>); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(GatewayClientError);
    expect((caught as GatewayClientError).code).toBe(code);
    expectNoCanaries(caught);
  });
});

describe("the four operator relay requests", () => {
  it("polls queued jobs with the exact encoded URL and bearer header", async () => {
    const encodedKernel = "kernel:n144 /?#";
    const { client, fetchImpl } = fixture(json({ jobs: [{ id: jobId, kernelId: encodedKernel, status: "queued", inputs: canary }] }), { kernelId: encodedKernel });
    expect(await client.pollJobs()).toEqual({ ok: true, value: {
      stop: { proceed: false, why: "reader_unavailable" }, jobs: [{ jobId, status: "queued" }], foreignJobsDropped: 0, truncated: false,
    } });
    expect(request(fetchImpl)).toEqual({
      url: `${baseUrl}/api/operator/jobs?kernelId=${encodeURIComponent(encodedKernel)}&status=queued`,
      method: "GET", headers: { authorization: `Bearer ${apiKey}` }, body: undefined, redirect: "error",
    });
    expect(fetchImpl.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends only the online heartbeat identity and returns validUntil", async () => {
    const { client, fetchImpl } = fixture(json({ acknowledged: true, validUntil: "2026-10-12T15:00:00Z" }));
    expect(await client.heartbeat()).toEqual({ ok: true, value: { validUntil: "2026-10-12T15:00:00Z" } });
    expect(request(fetchImpl)).toEqual({
      url: `${baseUrl}/api/operator/heartbeat`, method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ kernelId, status: "online" }), redirect: "error",
    });
    expect(JSON.parse(String(request(fetchImpl).body))).not.toHaveProperty("capabilities");
  });

  it.each([{}, { validUntil: null }, { validUntil: 42 }])("uses null for absent or nonstring heartbeat validity: %j", async (fields) => {
    const { client } = fixture(json({ acknowledged: true, ...fields }));
    expect(await client.heartbeat()).toEqual({ ok: true, value: null });
  });

  it("reports only in_progress with the exact job-status request", async () => {
    const { client, fetchImpl } = fixture(json({ updated: true }));
    expect(await client.reportInProgress(jobId)).toMatchObject({ ok: true });
    expect(request(fetchImpl)).toEqual({
      url: `${baseUrl}/api/operator/job-status`, method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ jobId, status: "in_progress" }), redirect: "error",
    });
  });

  it("posts one LO-EV envelope through the evidence relay with the exact request", async () => {
    const { client, fetchImpl } = fixture(json(stored()));
    expect(await client.postRelayEvidence(jobId, bundle as Evidence)).toEqual({ ok: true, value: {
      jobId, contentHash: bundleHash, hashModel: "event_bundle_hash",
    } });
    expect(request(fetchImpl)).toEqual({
      url: `${baseUrl}/api/operator/evidence`, method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ jobId, kernelId, evidence: bundle }), redirect: "error",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a spy over every method proves only in_progress can reach job-status, even with extra status arguments", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/jobs")) return json({ jobs: [] });
      if (path.endsWith("/heartbeat")) return json({ acknowledged: true });
      if (path.endsWith("/job-status")) return json({ updated: true });
      return json(stored());
    });
    const client = createGatewayClient({ baseUrl, apiKey, kernelId, fetchImpl });
    await client.pollJobs();
    await client.heartbeat();
    await client.postRelayEvidence(jobId, bundle as Evidence);
    for (const status of ["completed", "failed", "cancelled", "paused", "queued", canary]) {
      await (client.reportInProgress as (...args: unknown[]) => Promise<unknown>)(jobId, status);
    }
    const calls = fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/job-status"));
    expect(calls).toHaveLength(6);
    for (const [, init] of calls as [RequestInfo | URL, RequestInit][]) {
      expect(JSON.parse(String(init.body))).toEqual({ jobId, status: "in_progress" });
    }
    for (const [, init] of fetchImpl.mock.calls as [RequestInfo | URL, RequestInit][]) expect(init.redirect).toBe("error");
  });
});

describe("closed gateway status mapping", () => {
  it.each([
    [401, { error: "api_key_required" }, "unauthenticated"],
    [401, { error: "authentication_required" }, "unauthenticated"],
    [403, { error: "forbidden", reason: "not_kernel_operator" }, "not_kernel_operator"],
    [403, { error: "forbidden", reason: "operator_proof_required" }, "operator_proof_required"],
    [403, { error: "forbidden", reason: "job_has_no_kernel" }, "job_has_no_kernel"],
    [403, { error: "insufficient_scope" }, "insufficient_scope"],
    [403, { error: "forbidden", message: "Request blocked by security policy" }, "blocked_by_policy"],
    [403, { error: "AEGIS_BLOCKED" }, "blocked_by_policy"],
    [403, { error: "AEGIS_REVIEW_BLOCKED" }, "blocked_by_policy"],
    [403, { error: canary, reason: canary, message: canary }, "forbidden"],
    [404, { error: "kernel_not_found" }, "kernel_not_found"],
    [404, { error: canary }, "route_unavailable"],
    [429, { error: "rate_limited" }, "rate_limited"],
    [400, { error: "invalid_request" }, "bad_request"],
    [503, { error: "read_failed" }, "unavailable"],
    [503, { error: "scope_requirements_unavailable" }, "unavailable"],
    [500, { error: "evidence_store_failed", message: canary }, "server_error"],
    [502, { error: canary }, "server_error"],
    [599, { error: canary }, "server_error"],
  ] as const)("maps HTTP %s (%j) to %s without server text", async (status, body, code) => {
    const { client } = fixture(json({ ...body, unknown: canary }, status, { "X-Debug": canary }));
    const result = await client.pollJobs();
    expect(result).toMatchObject({ ok: false, code, status });
    expectNoCanaries(result);
  });

  it.each(["0", "1", "3600"])("accepts bounded integer Retry-After %s", async (header) => {
    const { client } = fixture(json({ error: "rate_limited" }, 429, { "Retry-After": header }));
    expect(await client.pollJobs()).toEqual({ ok: false, code: "rate_limited", status: 429, retryAfterS: Number(header) });
  });

  it.each(["-1", "3601", "99999999999999999999999", "1.5", "+2", "2seconds", "Wed, 21 Oct 2026 07:28:00 GMT", canary])(
    "omits unsafe Retry-After %s", async (header) => {
      const { client } = fixture(json({ error: "rate_limited" }, 429, { "Retry-After": header }));
      const result = await client.pollJobs();
      expect(result).toEqual({ ok: false, code: "rate_limited", status: 429 });
      expectNoCanaries(result);
    },
  );

  it("maps a rejection before headers to network with no exception text", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error(`${canary} ${apiKey}`); });
    const client = createGatewayClient({ baseUrl, apiKey, kernelId, fetchImpl });
    const result = await client.pollJobs();
    expect(result).toEqual({ ok: false, code: "network", status: null });
    expectNoCanaries(result);
  });

  it("maps timeout before headers to timeout", async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(() => {}));
    const client = createGatewayClient({ baseUrl, apiKey, kernelId, fetchImpl, timeoutMs: 10 });
    expect(await client.pollJobs()).toEqual({ ok: false, code: "timeout", status: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it.each([
    [200, { updated: false, warning: "job_not_found" }, "job_not_found"],
    [409, { error: "settlement_owned_status" }, "settlement_owned_status"],
    [409, { error: "job_kernel_changed" }, "job_kernel_changed"],
    [400, { error: "invalid_status" }, "invalid_status"],
    [500, { error: canary }, "server_error"],
  ] as const)("maps job-status HTTP %s (%j) to %s", async (status, body, code) => {
    const { client } = fixture(json({ ...body, message: canary }, status));
    const result = await client.reportInProgress(jobId);
    expect(result).toMatchObject({ ok: false, code, status });
    expectNoCanaries(result);
  });
});

describe("strictEmergencyStopReader", () => {
  it.each([
    ["clear", "clear", { proceed: true }],
    ["stopped", "stopped", { proceed: false, why: "stopped" }],
    ["unavailable", "unavailable", { proceed: false, why: "unavailable" }],
    ["undefined", undefined, { proceed: false, why: "malformed" }],
    ["null", null, { proceed: false, why: "malformed" }],
    ["true", true, { proceed: false, why: "malformed" }],
    ["false", false, { proceed: false, why: "malformed" }],
    ["number", 0, { proceed: false, why: "malformed" }],
    ["bigint", 1n, { proceed: false, why: "malformed" }],
    ["symbol", Symbol("clear"), { proceed: false, why: "malformed" }],
    ["function", () => "clear", { proceed: false, why: "malformed" }],
    ["CLEAR", "CLEAR", { proceed: false, why: "malformed" }],
    ["leading whitespace", " clear", { proceed: false, why: "malformed" }],
    ["trailing whitespace", "clear ", { proceed: false, why: "malformed" }],
    ["empty string", "", { proceed: false, why: "malformed" }],
    ["array", ["clear"], { proceed: false, why: "malformed" }],
    ["object", { emergencyStop: "clear" }, { proceed: false, why: "malformed" }],
    ["boxed string", new String("clear"), { proceed: false, why: "malformed" }],
  ] as const)("maps own emergencyStop %s with an own jobs array", (_label, emergencyStop, expected) => {
    expect(strictEmergencyStopReader({ jobs: [], emergencyStop })).toEqual(expected);
  });

  it.each([
    ["missing emergencyStop", { jobs: [] }, "absent"],
    ["missing both properties", {}, "absent"],
    ["inherited emergencyStop", Object.assign(Object.create({ emergencyStop: "clear" }), { jobs: [] }), "absent"],
    ["missing jobs", { emergencyStop: "clear" }, "malformed"],
    ["inherited jobs", Object.assign(Object.create({ jobs: [] }), { emergencyStop: "clear" }), "malformed"],
  ] as const)("refuses %s", (_label, body, why) => {
    expect(strictEmergencyStopReader(body)).toEqual({ proceed: false, why });
  });

  it.each([
    ["undefined", undefined], ["null", null], ["boolean", true],
    ["number", 0], ["bigint", 1n], ["string", "[]"],
    ["symbol", Symbol("jobs")], ["function", () => []], ["object", { length: 0 }],
  ] as const)("refuses clear with jobs of type %s", (_label, jobs) => {
    expect(strictEmergencyStopReader({ emergencyStop: "clear", jobs })).toEqual({ proceed: false, why: "malformed" });
  });

  it.each(["stopped", "unavailable"] as const)("preserves %s when jobs are missing", (emergencyStop) => {
    expect(strictEmergencyStopReader({ emergencyStop })).toEqual({ proceed: false, why: emergencyStop });
  });

  it("accepts a null-prototype body with both own properties", () => {
    expect(strictEmergencyStopReader(Object.assign(Object.create(null), { emergencyStop: "clear", jobs: [] })))
      .toEqual({ proceed: true });
  });

  it.each(["emergencyStop", "jobs"])("does not read an inherited %s accessor", (property) => {
    const getter = vi.fn(() => { throw new Error(noiseString); });
    const prototype = Object.defineProperty({}, property, { get: getter });
    const body = Object.assign(Object.create(prototype), property === "emergencyStop" ? { jobs: [] } : { emergencyStop: "clear" });
    expect(strictEmergencyStopReader(body)).toEqual({ proceed: false, why: property === "emergencyStop" ? "absent" : "malformed" });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(["emergencyStop", "jobs"])("maps a throwing own %s accessor to malformed", (property) => {
    const body = Object.defineProperty({ jobs: [], emergencyStop: "clear" }, property, {
      get() { throw new Error(noiseString); },
    });
    const decision = strictEmergencyStopReader(body);
    expect(decision).toEqual({ proceed: false, why: "malformed" });
    expectNoCanaries(decision);
  });

  it("maps a throwing own-property check to malformed", () => {
    const body = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(noiseString); } });
    expect(strictEmergencyStopReader(body)).toEqual({ proceed: false, why: "malformed" });
  });

  it("maps a revoked proxy to malformed", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(strictEmergencyStopReader(proxy)).toEqual({ proceed: false, why: "malformed" });
  });

  it.each([null, undefined, [], "clear", true, 0, 1n, Symbol("body"), () => ({})])("refuses a nonobject body (%#)", (body) => {
    expect(strictEmergencyStopReader(body as unknown as Record<string, unknown>)).toEqual({ proceed: false, why: "malformed" });
  });

  it("reads the production contract through a gateway poll without changing the library placeholder", async () => {
    const { client } = fixture(json({ jobs: [], emergencyStop: "clear" }), { emergencyStopReader: strictEmergencyStopReader });
    expect(await client.pollJobs()).toMatchObject({ ok: true, value: { stop: { proceed: true } } });
    expect(await fixture(json({ jobs: [], emergencyStop: "clear" })).client.pollJobs())
      .toMatchObject({ ok: true, value: { stop: { proceed: false, why: "reader_unavailable" } } });
  });
});

describe("strict successful response parsing and emergency stop", () => {
  it.each([null, [], {}, { jobs: null }, { jobs: {} }, { jobs: [null] }, { jobs: [{ id: jobId, status: "queued" }] },
    { jobs: [{ id: "", kernelId, status: "queued" }] }, { jobs: [{ id: "a".repeat(201), kernelId, status: "queued" }] },
    { jobs: [{ id: "job\nsecret", kernelId, status: "queued" }] }, { jobs: [{ id: jobId, kernelId: 1, status: "queued" }] },
    { jobs: [{ id: jobId, kernelId, status: null }] }])("rejects malformed jobs %j", async (body) => {
    const reader = vi.fn(() => ({ proceed: true as const }));
    const { client } = fixture(json(body), { emergencyStopReader: reader });
    expect(await client.pollJobs()).toMatchObject({ ok: false, code: "malformed_response", status: 200 });
    expect(reader).not.toHaveBeenCalled();
  });

  it.each([{}, { acknowledged: false }, { acknowledged: 1 }, { acknowledged: "true" }])("requires acknowledged === true: %j", async (body) => {
    const { client } = fixture(json(body));
    expect(await client.heartbeat()).toMatchObject({ ok: false, code: "malformed_response", status: 200 });
  });

  it.each([{}, { updated: false }, { updated: "true" }])("requires updated === true: %j", async (body) => {
    const { client } = fixture(json(body));
    expect(await client.reportInProgress(jobId)).toMatchObject({ ok: false, code: "malformed_response", status: 200 });
  });

  it.each([undefined, "clear", "stopped", canary])("the placeholder never proceeds for emergencyStop %s", async (emergencyStop) => {
    const { client } = fixture(json({ jobs: [], emergencyStop }));
    expect(await client.pollJobs()).toMatchObject({ ok: true, value: { stop: { proceed: false, why: "reader_unavailable" } } });
  });

  it.each([
    { proceed: true as const },
    { proceed: false as const, why: "stopped" as const },
    { proceed: false as const, why: "unavailable" as const },
    { proceed: false as const, why: "absent" as const },
    { proceed: false as const, why: "malformed" as const },
    { proceed: false as const, why: "poll_failed" as const },
  ])("passes through an injected reader decision %j", async (decision) => {
    const body = { jobs: [], emergencyStop: "clear" };
    const reader: EmergencyStopReader = vi.fn(() => decision);
    const { client } = fixture(json(body), { emergencyStopReader: reader });
    expect(await client.pollJobs()).toMatchObject({ ok: true, value: { stop: decision } });
    expect(reader).toHaveBeenCalledOnce();
    expect(reader).toHaveBeenCalledWith(body);
  });

  it("failed polls never invoke the emergency-stop reader", async () => {
    const reader = vi.fn(() => ({ proceed: true as const }));
    const { client } = fixture(json({ jobs: [], emergencyStop: "clear" }, 503), { emergencyStopReader: reader });
    expect(await client.pollJobs()).toMatchObject({ ok: false, code: "unavailable" });
    expect(reader).not.toHaveBeenCalled();
  });

  it("a throwing emergency-stop reader prevents execution without leaking its exception", async () => {
    const { client } = fixture(json({ jobs: [] }), { emergencyStopReader: () => { throw new Error(`${canary} ${apiKey}`); } });
    const result = await client.pollJobs();
    expect(result).toMatchObject({ ok: true, value: { stop: { proceed: false, why: "unavailable" } } });
    expectNoCanaries(result);
  });

  it("a malformed emergency-stop decision prevents execution and keeps only a closed why", async () => {
    const reader = (() => ({ proceed: false, why: canary, unknown: canary })) as EmergencyStopReader;
    const { client } = fixture(json({ jobs: [] }), { emergencyStopReader: reader });
    const result = await client.pollJobs();
    expect(result).toMatchObject({ ok: true, value: { stop: { proceed: false, why: "malformed" } } });
    expectNoCanaries(result);
  });

  it("a throwing reader-result accessor prevents execution without leaking its exception", async () => {
    const reader: EmergencyStopReader = () => ({
      proceed: false,
      get why(): "stopped" { throw new Error(noiseString); },
    });
    const { client } = fixture(json({ jobs: [] }), { emergencyStopReader: reader });
    const result = await client.pollJobs();
    expect(result).toMatchObject({ ok: true, value: { stop: { proceed: false, why: "unavailable" } } });
    expectNoCanaries(result);
  });

  it("drops foreign-kernel jobs and counts them", async () => {
    const { client } = fixture(json({ jobs: [
      { id: "job:ours", kernelId, status: "queued" },
      { id: "job:foreign", kernelId: "kernel:other", status: "queued" },
      { id: "job:foreign2", kernelId: "KERNEL:N144", status: "queued" },
    ] }));
    expect(await client.pollJobs()).toMatchObject({ ok: true, value: {
      jobs: [{ jobId: "job:ours", status: "queued" }], foreignJobsDropped: 2, truncated: false,
    } });
  });

  it.each([49, 50, 51])("sets truncated from the original %s jobs", async (count) => {
    const jobs = Array.from({ length: count }, (_, index) => ({ id: `job:${index}`, kernelId: "kernel:foreign", status: "queued" }));
    const { client } = fixture(json({ jobs }));
    expect(await client.pollJobs()).toMatchObject({ ok: true, value: { jobs: [], foreignJobsDropped: count, truncated: count >= 50 } });
  });

  it("requires jobs and each job field to be own properties", async () => {
    await withInherited("jobs", [], async () => {
      expect(await fixture(json({})).client.pollJobs()).toMatchObject({ ok: false, code: "malformed_response" });
    });
    for (const field of ["id", "kernelId", "status"] as const) {
      const job: Record<string, string> = { id: jobId, kernelId, status: "queued" };
      const value = job[field];
      delete job[field];
      await withInherited(field, value, async () => {
        expect(await fixture(json({ jobs: [job] })).client.pollJobs()).toMatchObject({ ok: false, code: "malformed_response" });
      });
    }
  });

  it("requires acknowledgment and update flags to be own properties", async () => {
    await withInherited("acknowledged", true, async () => {
      expect(await fixture(json({})).client.heartbeat()).toMatchObject({ ok: false, code: "malformed_response" });
    });
    await withInherited("updated", true, async () => {
      expect(await fixture(json({})).client.reportInProgress(jobId)).toMatchObject({ ok: false, code: "malformed_response" });
    });
    await withInherited("validUntil", "2026-10-12T15:00:00Z", async () => {
      expect(await fixture(json({ acknowledged: true })).client.heartbeat()).toEqual({ ok: true, value: null });
    });
  });

  it("an inherited ok property never bypasses successful-response parsing", async () => {
    await withInherited("ok", false, async () => {
      const { client } = fixture(json({ jobs: [], unknown: canary }));
      const result = await client.pollJobs();
      expect(result).toMatchObject({ ok: true, value: { jobs: [] } });
      expectNoCanaries(result);
    });
  });

  it("never classifies an inherited server error or reason", async () => {
    await withInherited("reason", "not_kernel_operator", async () => {
      expect(await fixture(json({ error: "forbidden" }, 403)).client.pollJobs())
        .toEqual({ ok: false, code: "forbidden", status: 403 });
    });
    await withInherited("error", "kernel_not_found", async () => {
      expect(await fixture(json({}, 404)).client.pollJobs())
        .toEqual({ ok: false, code: "route_unavailable", status: 404 });
    });
    await withInherited("message", "Request blocked by security policy", async () => {
      expect(await fixture(json({ error: "forbidden" }, 403)).client.pollJobs())
        .toEqual({ ok: false, code: "forbidden", status: 403 });
    });
  });

  it.each(["text/plain", "text/html", "application/xml", ""])("rejects a 200 non-JSON content type %j", async (contentType) => {
    const { client } = fixture(new Response('{"jobs":[]}', { headers: { "Content-Type": contentType } }));
    expect(await client.pollJobs()).toMatchObject({ ok: false, code: "malformed_response", status: 200 });
  });

  it("rejects malformed JSON without retaining parser excerpts", async () => {
    const { client } = fixture(new Response(`${canary} {`, { headers: { "Content-Type": "application/json" } }));
    const result = await client.pollJobs();
    expect(result).toMatchObject({ ok: false, code: "malformed_response", status: 200 });
    expectNoCanaries(result);
  });

  it("a slow body after headers still times out", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({}), { headers: { "Content-Type": "application/json" } });
    const { client, fetchImpl } = fixture(response, { timeoutMs: 10 });
    expect(await client.pollJobs()).toMatchObject({ ok: false, code: "timeout", status: 200 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it("an oversized streamed response is malformed and cancels the stream", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(33)); }, cancel,
    }), { headers: { "Content-Type": "application/json" } });
    const { client } = fixture(response, { maxResponseBytes: 32 });
    expect(await client.pollJobs()).toMatchObject({ ok: false, code: "malformed_response", status: 200 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("applies the streamed response limit across chunks", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(20));
        controller.enqueue(new Uint8Array(20));
      }, cancel,
    }), { headers: { "Content-Type": "application/json" } });
    const { client } = fixture(response, { maxResponseBytes: 32 });
    expect(await client.pollJobs()).toMatchObject({ ok: false, code: "malformed_response", status: 200 });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("evidence outcomes never imply a retry or a false store", () => {
  it("rejects a bare 64-hex bundle hash without sending", async () => {
    const { client, fetchImpl } = fixture(json(stored()));
    expect(await client.postRelayEvidence(jobId, { events: [], bundleHash: "a".repeat(64) } as Evidence))
      .toEqual({ ok: false, code: "bad_bundle", status: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "", `sha256:${"A".repeat(64)}`, `sha256:${"a".repeat(63)}`, `sha256:${"a".repeat(65)}`,
    `SHA256:${"a".repeat(64)}`, `sha256:sha256:${"a".repeat(64)}`, ` ${bundleHash}`, `${bundleHash}\n`,
    undefined, null, 42,
  ])("rejects malformed tagged bundle hash %s without sending", async (hash) => {
    const { client, fetchImpl } = fixture(json(stored()));
    const result = await client.postRelayEvidence(jobId, { events: [], bundleHash: hash } as Evidence);
    expect(result).toEqual({ ok: false, code: "bad_bundle", status: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("the serialized 1,000,000-byte evidence cap refuses without fetch", async () => {
    const { client, fetchImpl } = fixture(json(stored()));
    const large = { ...bundle, events: [], padding: "x".repeat(1_000_000) } as Evidence;
    expect(await client.postRelayEvidence(jobId, large)).toEqual({ ok: false, code: "payload_too_large", status: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("measures the serialized evidence cap in UTF-8 bytes", async () => {
    const { client, fetchImpl } = fixture(json(stored()));
    const large = { ...bundle, padding: "\u00e9".repeat(500_000) } as Evidence;
    expect(await client.postRelayEvidence(jobId, large)).toMatchObject({ ok: false, code: "payload_too_large", status: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { contentHash: `sha256:${"b".repeat(64)}` }, { contentHash: "a".repeat(64) },
    { contentHash: `sha256:${bundleHash}` }, { contentHash: `${bundleHash}\n` },
    { jobId: "job:other" }, { hashModel: "other_model" }, { hashModel: undefined },
  ])("stored=true with mismatched receipt %j is stored_mismatch", async (fields) => {
    const { client } = fixture(json(stored(fields)));
    expect(await client.postRelayEvidence(jobId, bundle as Evidence)).toEqual({ ok: false, code: "stored_mismatch", status: 200 });
  });

  it("requires each stored receipt field to be an own property", async () => {
    for (const field of ["jobId", "contentHash", "hashModel"] as const) {
      const body: Record<string, unknown> = stored();
      const value = body[field];
      delete body[field];
      await withInherited(field, value, async () => {
        const { client } = fixture(json(body));
        expect(await client.postRelayEvidence(jobId, bundle as Evidence))
          .toEqual({ ok: false, code: "stored_mismatch", status: 200 });
      });
    }
  });

  it.each([
    [{ stored: false, warning: "job_not_found" }, "job_not_found"],
    [{ stored: false, error: "storage_failed" }, "storage_failed"],
    [{ stored: false, error: canary, warning: canary, message: canary }, "other"],
  ] as const)("stored=false %j is not_stored/%s", async (body, sub) => {
    const { client } = fixture(json(body));
    const result = await client.postRelayEvidence(jobId, bundle as Evidence);
    expect(result).toEqual({ ok: false, code: "not_stored", status: 200, sub });
    expectNoCanaries(result);
  });

  it.each([
    [409, "kernel_mismatch"], [409, "job_mismatch"],
    [422, "malformed_envelope"], [422, "ambiguous_envelope"], [422, "events_malformed"],
    [422, "event_hash_mismatch"], [422, "bundle_hash_mismatch"], [422, "bundle_hash_malformed"],
    [422, "evidence_not_lo_ev"], [422, "evidence_not_canonical"], [422, "evidence_not_bound"],
    [409, canary], [422, canary],
  ] as const)("evidence refusal HTTP %s/%s has only an allowlisted sub-code", async (status, error) => {
    const { client } = fixture(json({ stored: false, error, message: canary }, status));
    const result = await client.postRelayEvidence(jobId, bundle as Evidence);
    expect(result).toEqual({ ok: false, code: "evidence_refused", status, sub: error === canary ? "other" : error });
    expectNoCanaries(result);
  });

  it("an evidence timeout is indeterminate with exactly one fetch and no retry", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({}), { headers: { "Content-Type": "application/json" } });
    const { client, fetchImpl } = fixture(response, { timeoutMs: 10 });
    expect(await client.postRelayEvidence(jobId, bundle as Evidence)).toMatchObject({ ok: false, code: "indeterminate", status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a 200 non-JSON evidence reply is indeterminate and never retries", async () => {
    const { client, fetchImpl } = fixture(new Response(noiseString, { headers: { "Content-Type": "text/html" } }));
    const result = await client.postRelayEvidence(jobId, bundle as Evidence);
    expect(result).toEqual({ ok: false, code: "indeterminate", status: 200 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expectNoCanaries(result);
  });

  it("a 200 evidence reply with invalid JSON is indeterminate", async () => {
    const { client, fetchImpl } = fixture(new Response(`${noiseString} {`, { headers: { "Content-Type": "application/json" } }));
    const result = await client.postRelayEvidence(jobId, bundle as Evidence);
    expect(result).toEqual({ ok: false, code: "indeterminate", status: 200 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expectNoCanaries(result);
  });

  it.each([null, [], false, 7, "stored", {}, { stored: null }, { stored: "true" }, { stored: 1 }])(
    "a 200 evidence reply without a boolean stored flag is indeterminate: %j", async (body) => {
      const { client, fetchImpl } = fixture(json(body));
      expect(await client.postRelayEvidence(jobId, bundle as Evidence))
        .toEqual({ ok: false, code: "indeterminate", status: 200 });
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("an inherited stored flag leaves the evidence outcome indeterminate", async () => {
    await withInherited("stored", true, async () => {
      const { stored: _stored, ...body } = stored();
      const { client, fetchImpl } = fixture(json(body));
      expect(await client.postRelayEvidence(jobId, bundle as Evidence))
        .toEqual({ ok: false, code: "indeterminate", status: 200 });
      expect(fetchImpl).toHaveBeenCalledOnce();
    });
  });

  it("an oversized 200 evidence reply is indeterminate and cancels its stream", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(33)); }, cancel,
    }), { headers: { "Content-Type": "application/json" } });
    const { client, fetchImpl } = fixture(response, { maxResponseBytes: 32 });
    expect(await client.postRelayEvidence(jobId, bundle as Evidence))
      .toEqual({ ok: false, code: "indeterminate", status: 200 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("a body-read failure after evidence 200 headers is indeterminate", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error(noiseString)); },
    }), { headers: { "Content-Type": "application/json" } });
    const { client, fetchImpl } = fixture(response);
    const result = await client.postRelayEvidence(jobId, bundle as Evidence);
    expect(result).toEqual({ ok: false, code: "indeterminate", status: 200 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expectNoCanaries(result);
  });

  it("a 502 evidence reply is indeterminate and never retries", async () => {
    const { client, fetchImpl } = fixture(json({ error: canary }, 502));
    const result = await client.postRelayEvidence(jobId, bundle as Evidence);
    expect(result).toEqual({ ok: false, code: "indeterminate", status: 502 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expectNoCanaries(result);
  });

  it("a 503 read_failed evidence reply is unavailable because storage was refused", async () => {
    const { client, fetchImpl } = fixture(json({ error: "read_failed" }, 503));
    expect(await client.postRelayEvidence(jobId, bundle as Evidence))
      .toEqual({ ok: false, code: "unavailable", status: 503 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    [500, "evidence_store_failed", "server_error"],
    [503, "scope_requirements_unavailable", "unavailable"],
    [500, "read_failed", "indeterminate"],
    [500, "scope_requirements_unavailable", "indeterminate"],
    [503, "evidence_store_failed", "indeterminate"],
    [502, "evidence_store_failed", "indeterminate"],
    [504, "read_failed", "indeterminate"],
    [500, canary, "indeterminate"],
    [503, canary, "indeterminate"],
    [599, canary, "indeterminate"],
  ] as const)("maps evidence HTTP %s/%s to %s using the exact known refusal", async (status, error, code) => {
    const { client, fetchImpl } = fixture(json({ error, message: noiseString }, status));
    const result = await client.postRelayEvidence(jobId, bundle as Evidence);
    expect(result).toEqual({ ok: false, code, status });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expectNoCanaries(result);
  });

  it.each([500, 502, 503, 599])("a non-JSON evidence HTTP %s reply is indeterminate", async (status) => {
    const { client, fetchImpl } = fixture(new Response(noiseString, { status, headers: { "Content-Type": "text/plain" } }));
    const result = await client.postRelayEvidence(jobId, bundle as Evidence);
    expect(result).toEqual({ ok: false, code: "indeterminate", status });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expectNoCanaries(result);
  });

  it.each([500, 503])("invalid JSON in an evidence HTTP %s reply is indeterminate", async (status) => {
    const { client } = fixture(new Response(`${noiseString} {`, { status, headers: { "Content-Type": "application/json" } }));
    const result = await client.postRelayEvidence(jobId, bundle as Evidence);
    expect(result).toEqual({ ok: false, code: "indeterminate", status });
    expectNoCanaries(result);
  });

  it("an inherited 503 read_failed cannot prove storage was refused", async () => {
    await withInherited("error", "read_failed", async () => {
      const { client } = fixture(json({}, 503));
      expect(await client.postRelayEvidence(jobId, bundle as Evidence))
        .toEqual({ ok: false, code: "indeterminate", status: 503 });
    });
  });

  it("a failed evidence fetch is indeterminate and never retries", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error(`${canary} ${apiKey}`); });
    const client = createGatewayClient({ baseUrl, apiKey, kernelId, fetchImpl });
    const result = await client.postRelayEvidence(jobId, bundle as Evidence);
    expect(result).toEqual({ ok: false, code: "indeterminate", status: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expectNoCanaries(result);
  });
});

describe("server and key canary isolation", () => {
  it.each(["pollJobs", "heartbeat", "reportInProgress", "postRelayEvidence"] as const)(
    "keeps every untrusted server field and header out of %s results and client displays", async (method) => {
      const noise = { error: noiseString, message: noiseString, warning: noiseString, reason: noiseString, unknown: noiseString };
      const successes = {
        pollJobs: { jobs: [], ...noise }, heartbeat: { acknowledged: true, ...noise },
        reportInProgress: { updated: true, ...noise }, postRelayEvidence: stored(noise),
      };
      for (const [status, body] of [[200, successes[method]], [403, noise], [500, noise]] as const) {
        const { client } = fixture(json(body, status, { "X-Canary": noiseString, "Retry-After": noiseString }));
        const result = method === "pollJobs" ? await client.pollJobs()
          : method === "heartbeat" ? await client.heartbeat()
            : method === "reportInProgress" ? await client.reportInProgress(jobId)
              : await client.postRelayEvidence(jobId, bundle as Evidence);
        expectNoCanaries(result);
        expectNoCanaries(client);
        expectNoCanaries(client.toJSON());
      }
    },
  );
});
