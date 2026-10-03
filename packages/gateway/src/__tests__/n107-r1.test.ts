/**
 * Cross-family review r1 of #514 (rm-n107-514-r1-081b0c49, DO-NOT-SHIP), N107:
 *   CRITICAL 1  every security fingerprint sent PostHog raw header values (User-Agent,
 *               Accept-Language, Content-Type, cf-*, X-Forwarded-For, x-railway-edge), and the
 *               Referer kept its userinfo;
 *   CRITICAL 2  the monitor's logs carried raw User-Agent text (HONEYPOT's ua, and bot reasons);
 *   MEDIUM 3    (legacy x402 half) the 402 path and the exact count deltas were not pinned.
 * The rule now: a fingerprint is a closed schema of derived values, never a header's text.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import http from "node:http";
import { Writable } from "node:stream";
import type { AddressInfo } from "node:net";

const events = vi.hoisted(() => [] as Array<{ name: string; props: Record<string, unknown>; distinctId?: string }>);
vi.mock("../services/posthog-service.js", () => ({
  initPostHog: vi.fn(),
  trackServerEvent: (name: string, props: Record<string, unknown>, distinctId?: string) => events.push({ name, props, distinctId }),
  identifyAgent: vi.fn(),
  shutdownPostHog: vi.fn().mockResolvedValue(undefined),
}));

// Built at runtime, so no literal here looks like a secret.
const mark = (name: string) => ["n107r1", name, "4e2a"].join("-");
const ADMIN = ["n107r1", "admin", "key"].join("-");
const PAYER = "0x3333333333333333333333333333333333333333";

const logLines: string[] = [];
let app: FastifyInstance;
let port = 0;

beforeAll(async () => {
  process.env.PCC_ADMIN_KEY = ADMIN;
  process.env.PCC_PAYMENT_ENABLED = "true";
  process.env.PCC_X402_LEGACY = "true";
  const stream = new Writable({
    write(chunk, _encoding, done) {
      logLines.push(String(chunk));
      done();
    },
  });
  app = Fastify({ logger: { level: "info", stream } });
  const { securityMonitorPlugin } = await import("../middleware/security-monitor.js");
  const { paymentGate } = await import("../middleware/x402-gate.js");
  await app.register(securityMonitorPlugin);
  await app.register(async (scope) => {
    // The gate's hooks reach a priced route only inside its own scope (board row N45).
    await paymentGate(scope);
    scope.get("/api/capabilities/search", async () => ({ ok: true }));
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  await app?.close();
  delete process.env.PCC_ADMIN_KEY;
  delete process.env.PCC_PAYMENT_ENABLED;
  delete process.env.PCC_X402_LEGACY;
});

const raw = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("CRITICAL 1 (r1 of #514): a fingerprint carries no header's text", () => {
  it("the verdict's reproduction and every fingerprint header: no marker reaches PostHog", async () => {
    const start = events.length;
    const m = {
      ua: mark("ua"), lang: mark("lang"), ref: mark("ref"), ctype: mark("ctype"), country: mark("country"),
      ray: mark("ray"), xff: mark("xff"), edge: mark("edge"), vercel: mark("vercel"),
    };
    await raw("GET", "/admin", {
      "user-agent": `client ${m.ua}`,
      "accept-language": m.lang,
      referer: `https://user:${m.ref}@example.test/cb?drop=1`,
      "content-type": `application/json; zq1=${m.ctype}`,
      "cf-ipcountry": m.country,
      "cf-ray": m.ray,
      "x-forwarded-for": m.xff,
      "x-railway-edge": m.edge,
      "x-vercel-ip-country": m.vercel,
    });
    await settle();
    const sent = JSON.stringify(events.slice(start));
    expect(events.slice(start).some((e) => e.name === "honeypot_triggered"), "the honeypot was reported").toBe(true);
    for (const [name, value] of Object.entries(m)) expect(sent, name).not.toContain(value);
  });

  it("a fingerprint is the closed schema: derived values only", async () => {
    const start = events.length;
    await raw("GET", "/admin", { "user-agent": "Mozilla/5.0 (X11) Firefox/128.0", "accept-language": "en-US,en;q=0.9", referer: "https://elsewhere.test/a" });
    await settle();
    const honeypot = events.slice(start).find((e) => e.name === "honeypot_triggered")!;
    // N107b (the PR steward's closed schema): the Accept-Language is not reported at all.
    expect(honeypot.props).toMatchObject({ uaClass: "browser", referer: "cross_origin", path: "/admin" });
    for (const key of ["ip", "userAgent", "xForwardedFor", "railwayEdge", "cfRay", "acceptLanguage", "uaLength"]) expect(honeypot.props, key).not.toHaveProperty(key);
    // The client is a keyed hash, and PostHog's distinct id is built from it, never from the address.
    expect(honeypot.props.clientId).toMatch(/^h:[0-9a-f]{32}$/);
    expect(honeypot.distinctId).toBe(`security:${honeypot.props.clientId}`);
    expect(JSON.stringify(honeypot)).not.toContain("127.0.0.1");
  });
});

describe("MEDIUM 1 (r2 of #514): a caller's two letters are no country, and the language is not reported", () => {
  it("Accept-Language zqx and cf-ipcountry ZQ: no language field, and the country is other; a real code stays", async () => {
    const start = events.length;
    await raw("GET", "/admin", { "accept-language": "zqx", "cf-ipcountry": "ZQ" });
    await raw("GET", "/admin", { "cf-ipcountry": "US" });
    await settle();
    const honeypots = events.slice(start).filter((e) => e.name === "honeypot_triggered");
    expect(honeypots).toHaveLength(2);
    expect(honeypots[0]!.props).not.toHaveProperty("acceptLanguage");
    expect(honeypots[0]!.props.cfCountry).toBe("other");
    expect(honeypots[1]!.props.cfCountry).toBe("US");
    expect(JSON.stringify(honeypots)).not.toContain("zqx");
  });
});

describe("CRITICAL 2 (r1 of #514): the monitor's logs carry no User-Agent text", () => {
  it("HONEYPOT and BOT_DETECTED lines name the agent's class, never its text", async () => {
    const start = logLines.length;
    const secrets = [mark("nmap"), mark("puppeteer"), mark("claude"), mark("requests")];
    await raw("GET", "/admin", { "user-agent": `nmap ${secrets[0]}` });
    await raw("GET", "/admin", { "user-agent": `puppeteer ${secrets[1]}` });
    await raw("GET", "/admin", { "user-agent": `claude ${secrets[2]}` });
    await raw("GET", "/admin", { "user-agent": `python-requests ${secrets[3]}` });
    await settle();
    const logged = logLines.slice(start).join("");
    expect(logged).toContain("HONEYPOT");
    expect(logged).toContain("BOT_DETECTED");
    for (const secret of secrets) expect(logged).not.toContain(secret);
  });
});

describe("MEDIUM 3 (r1 of #514, legacy x402): a 402 and a payment move exactly the counters they should", () => {
  const signature = Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: { scheme: "exact", network: "eip155:84532", amount: "1000", payTo: "0x0000000000000000000000000000000000000001", asset: "0x0", maxTimeoutSeconds: 60 },
    payload: { signature: "0x" + "ab".repeat(65), authorization: { from: PAYER, to: "0x0000000000000000000000000000000000000001", value: "1000", validAfter: "0", validBefore: "9999999999", nonce: "0x" + "00".repeat(32) } },
  })).toString("base64");
  const stats = async () => JSON.parse((await raw("GET", "/api/x402/stats", { "x-admin-key": ADMIN })).body);

  it("an unpaid request is gated (402); a paid one is counted once and kept as its path only", async () => {
    const s0 = await stats();
    const unpaid = await raw("GET", `/api/capabilities/search?zq1=${mark("unpaid")}`);
    expect(unpaid.status).toBe(402);
    const s1 = await stats();
    // Each stats read is itself a request the gate counts.
    expect([s1.totalRequests - s0.totalRequests, s1.gatedRequests - s0.gatedRequests, s1.paidRequests - s0.paidRequests]).toEqual([2, 1, 0]);
    const paid = await raw("GET", `/api/capabilities/search?code=${mark("paid")}`, { "payment-signature": signature });
    expect(paid.status).toBe(200);
    const s2 = await stats();
    expect([s2.totalRequests - s1.totalRequests, s2.gatedRequests - s1.gatedRequests, s2.paidRequests - s1.paidRequests]).toEqual([2, 0, 1]);
    expect(s2.recentPayments[0]).toMatchObject({ path: "/api/capabilities/search", payer: PAYER });
    expect(JSON.stringify(s2)).not.toContain(mark("paid"));
    expect(JSON.stringify(s2)).not.toContain(mark("unpaid"));
  });
});
