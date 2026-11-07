import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { analyticsIdentityDigest } from "../services/analytics-identity.js";
import { prepareServerEventDistinctId, safeServerEventDistinctId } from "../services/posthog-policy.js";

const capture = vi.hoisted(() => vi.fn());
const identify = vi.hoisted(() => vi.fn());
const constructed = vi.hoisted(() => vi.fn());
vi.mock("posthog-node", () => ({
  PostHog: class {
    capture = capture;
    identify = identify;
    shutdown = vi.fn().mockResolvedValue(undefined);
    constructor() { constructed(); }
  },
}));

const hostile = ["pcc", "live", "N71-SENTINEL"].join("_");
const emailA = "first-operator@example.invalid";
const emailB = "second-operator@example.invalid";
let app: FastifyInstance;
let service: typeof import("../services/posthog-service.js");

beforeAll(async () => {
  vi.stubEnv("POSTHOG_API_KEY", hostile);
  vi.stubEnv("NODE_ENV", "test");
  service = await import("../services/posthog-service.js");
  service.initPostHog();
  await vi.waitFor(() => expect(constructed).toHaveBeenCalledOnce());
  app = Fastify({ logger: false });
  const { securityMonitorPlugin } = await import("../middleware/security-monitor.js");
  await securityMonitorPlugin(app);
  app.get("/analytics/items/:itemId", async () => ({ ok: true }));
  app.post("/analytics/items/:itemId", async () => ({ ok: true }));
  // Populate the boundary's route-pattern allow-list through a matched Fastify request.
  await app.inject({ method: "GET", url: "/analytics/items/first", remoteAddress: "192.0.2.1" });
  await vi.waitFor(() => expect(capture).toHaveBeenCalled());
});

beforeEach(() => {
  capture.mockClear();
  identify.mockClear();
});

afterAll(async () => {
  await app?.close();
  await service?.shutdownPostHog();
  vi.unstubAllEnvs();
});

describe("N71 round 9 analytics identities at the remote boundary", () => {
  it("correlates two security clients separately with the shared process key", async () => {
    for (const remoteAddress of ["192.0.2.11", "192.0.2.12"]) {
      await app.inject({ method: "GET", url: "/analytics/items/opaque", remoteAddress });
    }
    await vi.waitFor(() => expect(capture.mock.calls.filter(([value]) => value.event === "request_fingerprint")).toHaveLength(2));
    const events = capture.mock.calls.map(([value]) => value).filter((value) => value.event === "request_fingerprint");
    expect(events.map((event) => event.distinctId)).toEqual([
      `security:${analyticsIdentityDigest("192.0.2.11")}`,
      `security:${analyticsIdentityDigest("192.0.2.12")}`,
    ]);
    expect(new Set(events.map((event) => event.distinctId)).size).toBe(2);
    for (const event of events) {
      expect(event.distinctId).toMatch(/^security:[0-9a-f]{16}$/);
      expect(event.distinctId).toBe(`security:${event.properties.clientId}`);
    }
  });

  it("preserves plain IDs and hashes separate email operators and credential-shaped IDs", () => {
    const identities = ["operator-plain", emailA, emailB, hostile, "security:bad", "security:0123456789ABCDEF"];
    for (const identity of identities) service.trackServerEvent("operator_activity", { operatorAddress: identity }, identity);
    const events = capture.mock.calls.map(([value]) => value);
    expect(events[0].distinctId).toBe("operator-plain");
    for (const event of events.slice(1)) expect(event.distinctId).toMatch(/^h:[0-9a-f]{16}$/);
    expect(events.map((event) => event.distinctId)).toEqual(identities.map(safeServerEventDistinctId));
    expect(new Set(events.map((event) => event.distinctId)).size).toBe(identities.length);
    expect(events[1].properties.operatorAddress).toBe(emailA);
    expect(events[2].properties.operatorAddress).toBe(emailB);
    expect(events.map((event) => event.distinctId).join(" ")).not.toContain(emailA);
    expect(events.map((event) => event.distinctId).join(" ")).not.toContain(emailB);
    expect(JSON.stringify(events)).not.toContain(hostile);
    service.trackServerEvent("operator_activity", undefined, emailA);
    expect(capture.mock.calls.at(-1)?.[0].distinctId).toBe(events[1].distinctId);
  });

  it("formats identify properties and its distinct ID through the real client", () => {
    service.identifyAgent(hostile, {
      kernelId: hostile, deviceId: hostile, jobId: hostile, operatorAddress: hostile,
      unexpected: hostile, capabilitiesRegistered: hostile, assuranceTier: hostile,
      kind: hostile, source: hostile, environment: hostile, first_stage: "provision",
    });
    expect(identify).toHaveBeenCalledOnce();
    expect(identify).toHaveBeenCalledWith({
      distinctId: safeServerEventDistinctId(hostile),
      properties: {
        kernelId: "[invalid id]", deviceId: "[invalid id]", jobId: "[invalid id]", operatorAddress: "[invalid id]",
        capabilitiesRegistered: null, assuranceTier: null, first_stage: "provision",
        kind: "agent_journey", source: "gateway", environment: "test",
      },
    });
    expect(identify.mock.calls[0][0].distinctId).toMatch(/^h:[0-9a-f]{16}$/);
    expect(JSON.stringify(identify.mock.calls)).not.toContain(hostile);
  });

  it("hashes a prepared caller identity once and refuses an arbitrary digest string", () => {
    expect(prepareServerEventDistinctId("operator-plain")).toBe("operator-plain");
    expect(prepareServerEventDistinctId("security:0123456789abcdef")).toBe("security:0123456789abcdef");
    expect(prepareServerEventDistinctId("")).toBe("pcc-gateway");
    expect(prepareServerEventDistinctId()).toBe("pcc-gateway");
    const prepared = prepareServerEventDistinctId(emailA);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(() => Object.defineProperty(prepared, "value", { value: hostile })).toThrow();
    service.trackServerEvent("operator_activity", {}, prepared);
    service.trackServerEvent("operator_activity", {}, emailA);
    service.trackServerEvent("operator_activity", {}, safeServerEventDistinctId(emailA));
    expect(capture.mock.calls[0][0].distinctId).toBe(safeServerEventDistinctId(emailA));
    expect(capture.mock.calls[1][0].distinctId).toBe(capture.mock.calls[0][0].distinctId);
    expect(capture.mock.calls[2][0].distinctId).not.toBe(capture.mock.calls[0][0].distinctId);
    expect(capture.mock.calls[2][0].distinctId).toMatch(/^h:[0-9a-f]{16}$/);
    expect(JSON.stringify(capture.mock.calls)).not.toContain(hostile);
  });

  it("formats unknown NODE_ENV in capture and identify", () => {
    vi.stubEnv("NODE_ENV", hostile);
    try {
      service.trackServerEvent("operator_activity", {}, "operator-plain");
      service.identifyAgent("operator-plain", {});
      expect(capture.mock.calls[0][0].properties.environment).toBe("unknown");
      expect(identify.mock.calls[0][0].properties.environment).toBe("unknown");
      expect(JSON.stringify([capture.mock.calls, identify.mock.calls])).not.toContain(hostile);
    } finally {
      vi.stubEnv("NODE_ENV", "test");
    }
  });
});

const fingerprint = {
  clientId: "0123456789abcdef", method: "POST", path: "/analytics/items/:itemId", uaClass: "automation",
  uaLength: 24, referer: "cross_origin", acceptLanguage: "en", contentType: "application/json",
  cfCountry: "GB", edge: "cloudflare", forwardedHops: 2, timestamp: "2026-10-16T12:00:00.000Z",
};
const securityExamples: Record<string, Record<string, unknown>> = {
  request_fingerprint: { ...fingerprint, statusCode: 200, durationMs: 12, responseSize: 11 },
  honeypot_triggered: { ...fingerprint, honeypotPath: "/admin", severity: "high" },
  attack_detected: { ...fingerprint, attackType: "xss", attackSource: "body", attackLength: 30, attackPayload: "xss in body, 30 chars, at /analytics/items/:itemId", severity: "critical" },
  bot_detected: { ...fingerprint, botType: "automation", confidence: 0.95, reason: "Automation framework in UA", severity: "high" },
  rate_limit_exceeded: { ...fingerprint, requestCount: 101, windowMs: 60_000, severity: "medium" },
};

describe("N71 round 9 security schemas at the remote boundary", () => {
  beforeAll(async () => {
    await app.inject({ method: "GET", url: "/admin" });
  });

  it("keeps the monitor's real fingerprint, bot and attack derived fields", async () => {
    await app.inject({
      method: "GET", url: "/analytics/items/private-value?opaque=private-query", remoteAddress: "192.0.2.21",
      headers: {
        "user-agent": "puppeteer client", "accept-language": "en-GB,en;q=0.9", "content-type": "application/json",
        referer: "https://example.invalid/source", "cf-ipcountry": "GB", "cf-ray": "edge-marker",
        "x-forwarded-for": "192.0.2.20,192.0.2.21",
      },
    });
    await app.inject({
      method: "POST", url: "/analytics/items/private-value", remoteAddress: "192.0.2.21",
      payload: { probe: "javascript:alert(1)" },
    });
    await vi.waitFor(() => expect(capture.mock.calls.some(([event]) => event.event === "attack_detected")).toBe(true));
    const events = capture.mock.calls.map(([event]) => event);
    const fp = events.find((event) => event.event === "request_fingerprint");
    expect(fp.properties).toMatchObject({
      clientId: analyticsIdentityDigest("192.0.2.21"), method: "GET", path: "/analytics/items/:itemId",
      uaClass: "automation", uaLength: 16, referer: "cross_origin", acceptLanguage: "en", contentType: "application/json",
      cfCountry: "GB", edge: "cloudflare", forwardedHops: 2, statusCode: 200, source: "gateway", environment: "test",
    });
    expect(fp.properties.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(fp.properties.durationMs).toEqual(expect.any(Number));
    expect(fp.properties.responseSize).toEqual(expect.any(Number));
    expect(events.find((event) => event.event === "bot_detected").properties).toMatchObject({ botType: "automation", confidence: 0.95, reason: "Automation framework in UA", severity: "high" });
    expect(events.find((event) => event.event === "attack_detected").properties).toMatchObject({ attackType: "xss", attackSource: "body", attackLength: 31, severity: "critical", path: "/analytics/items/:itemId" });
    expect(JSON.stringify(events)).not.toContain("private-value");
    expect(JSON.stringify(events)).not.toContain("private-query");
  });

  for (const [event, properties] of Object.entries(securityExamples)) {
    it(`${event} retains every declared derived field and drops unknown fields`, () => {
      service.trackServerEvent(event, { ...properties, unexpected: hostile }, "security:0123456789abcdef");
      expect(capture).toHaveBeenCalledWith({
        event, distinctId: "security:0123456789abcdef",
        properties: { ...properties, source: "gateway", environment: "test" },
      });
    });

    it(`${event} drops or formats a hostile value in every declared field`, () => {
      for (const key of Object.keys(properties)) {
        service.trackServerEvent(event, { ...properties, [key]: hostile }, "security:0123456789abcdef");
        const output = capture.mock.calls.at(-1)?.[0].properties;
        expect(output[key], key).not.toBe(hostile);
        expect(JSON.stringify(output), key).not.toContain(hostile);
        if (key !== "attackPayload") expect(output[key] === undefined || output[key] === null, key).toBe(true);
      }
    });
  }

  it("accepts unmatched and refuses unregistered paths, enum impostors and invalid numeric ranges", () => {
    service.trackServerEvent("request_fingerprint", {
      ...fingerprint, path: "/analytics/items/raw-value", method: "GET-extra", uaClass: "browser-extra",
      statusCode: 600, durationMs: -1, responseSize: "2bytes", forwardedHops: Infinity,
    });
    expect(capture.mock.calls[0][0].properties).toEqual({
      clientId: fingerprint.clientId, uaLength: 24, referer: "cross_origin", acceptLanguage: "en",
      contentType: "application/json", cfCountry: "GB", edge: "cloudflare", timestamp: fingerprint.timestamp,
      statusCode: null, durationMs: null, responseSize: null, forwardedHops: null, source: "gateway", environment: "test",
    });
    service.trackServerEvent("request_fingerprint", { path: "unmatched" });
    expect(capture.mock.calls[1][0].properties.path).toBe("unmatched");
    service.trackServerEvent("operator_activity", { ...fingerprint, severity: "high" });
    expect(capture.mock.calls[2][0].properties).toEqual({ source: "gateway", environment: "test" });
  });
});
