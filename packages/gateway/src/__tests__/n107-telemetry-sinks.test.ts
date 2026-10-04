/**
 * N107 (cross-family review r5 of #441, rm-px7-441-r5-179c4777, CRITICAL 2 and 3): two sinks took
 * raw request content past every redaction.
 *   CRITICAL 2  the security monitor sent PostHog the raw request URL, cookie or body as an attack
 *               event's attackPayload, and every event's fingerprint carried the raw Referer;
 *   CRITICAL 3  the payment gate kept each paid request's raw URL in recentPayments, and
 *               GET /api/x402/stats showed the list to any caller.
 * The rule now: no request content leaves through these sinks. An attack event carries a summary
 * (its type, its source, the path with no query or fragment, and the content's length); a payment
 * keeps the path with no query or fragment, and only an admin sees who paid for what.
 * Every value below is sent under an arbitrary name, not only a credential-like one.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import http from "node:http";
import type { AddressInfo } from "node:net";

const events = vi.hoisted(() => [] as Array<{ name: string; props: Record<string, unknown>; distinctId?: string }>);
vi.mock("../services/posthog-service.js", () => ({
  initPostHog: vi.fn(),
  trackServerEvent: (name: string, props: Record<string, unknown>, distinctId?: string) => events.push({ name, props, distinctId }),
  identifyAgent: vi.fn(),
  shutdownPostHog: vi.fn().mockResolvedValue(undefined),
}));

// Built at runtime, so no literal here looks like a secret.
const mark = (name: string) => ["n107", name, "7c1d"].join("-");
const ADMIN = ["n107", "admin", "key"].join("-");
const PAYER = "0x2222222222222222222222222222222222222222";

let app: FastifyInstance;
let port = 0;

beforeAll(async () => {
  process.env.PCC_ADMIN_KEY = ADMIN;
  process.env.PCC_PAYMENT_ENABLED = "true";
  process.env.PCC_X402_LEGACY = "true";
  app = Fastify({ logger: false });
  const { securityMonitorPlugin } = await import("../middleware/security-monitor.js");
  const { paymentGate } = await import("../middleware/x402-gate.js");
  await app.register(securityMonitorPlugin);
  await app.register(paymentGate);
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  await app?.close();
  delete process.env.PCC_ADMIN_KEY;
  delete process.env.PCC_PAYMENT_ENABLED;
  delete process.env.PCC_X402_LEGACY;
});

/** A raw HTTP request: the path is sent as written, a fragment included. */
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

/** The security monitor's PostHog calls are made without awaiting them: let them land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const sentSince = (start: number) => JSON.stringify(events.slice(start));

describe("CRITICAL 2 (N107): the security monitor sends PostHog no request content", () => {
  it("an attack in a JSON body: the event names the attack, never the body's values", async () => {
    const start = events.length;
    const secrets = [mark("password"), mark("zq1"), mark("code")];
    const res = await raw("POST", "/admin", { "content-type": "application/json" },
      JSON.stringify({ password: secrets[0], zq1: secrets[1], code: secrets[2], probe: "javascript:alert(1)" }));
    expect(res.status).toBe(403);
    await settle();
    const attack = events.slice(start).find((e) => e.name === "attack_detected");
    expect(attack, "the attack was reported").toBeDefined();
    for (const secret of secrets) expect(sentSince(start)).not.toContain(secret);
    expect(attack!.props).toMatchObject({ attackType: "xss", attackSource: "body", path: "/admin" });
    expect(typeof attack!.props.attackLength).toBe("number");
  });

  it("an attack in the URL, in a query value, or in a cookie: the same", async () => {
    const start = events.length;
    const secrets = [mark("url"), mark("query"), mark("cookie")];
    await raw("GET", `/admin?zq1=${secrets[0]}&f=../etc/passwd`);
    await raw("GET", `/admin?x_custom=${secrets[1]}%3Cscript%3E`);
    await raw("GET", "/admin", { cookie: `zq1=${secrets[2]}; x=<script>` });
    await settle();
    const attacks = events.slice(start).filter((e) => e.name === "attack_detected");
    expect(attacks.length, "each attack was reported").toBe(3);
    for (const secret of secrets) expect(sentSince(start)).not.toContain(secret);
  });

  it("a fingerprint's Referer and a path's fragment carry no query or fragment value", async () => {
    const start = events.length;
    const secrets = [mark("ref-q"), mark("ref-f"), mark("path-f")];
    await raw("GET", `/admin#zq1=${secrets[2]}`, { referer: `https://r.test/cb?zq1=${secrets[0]}#x_custom=${secrets[1]}` });
    await settle();
    const honeypot = events.slice(start).find((e) => e.name === "honeypot_triggered");
    expect(honeypot, "the honeypot was reported").toBeDefined();
    // A Referer is reported as a kind (r1 of #514): never its text.
    expect(honeypot!.props.referer).toBe("cross_origin");
    for (const secret of secrets) expect(sentSince(start)).not.toContain(secret);
  });
});

describe("CRITICAL 3 (N107): payment stats keep no paid request's URL, and only an admin sees who paid", () => {
  const signature = Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: { scheme: "exact", network: "eip155:84532", amount: "1000", payTo: "0x0000000000000000000000000000000000000001", asset: "0x0", maxTimeoutSeconds: 60 },
    payload: { signature: "0x" + "ab".repeat(65), authorization: { from: PAYER, to: "0x0000000000000000000000000000000000000001", value: "1000", validAfter: "0", validBefore: "9999999999", nonce: "0x" + "00".repeat(32) } },
  })).toString("base64");

  it("a verified paid request's query and fragment values are not kept, and another caller sees only the counts", async () => {
    const secrets = [mark("paid-q"), mark("paid-f")];
    const paid = await raw("GET", `/api/x402/routes?code=${secrets[0]}#zq1=${secrets[1]}`, { "payment-signature": signature });
    expect(paid.status).toBe(200);
    const other = await raw("GET", "/api/x402/stats");
    expect(other.status).toBe(200);
    for (const secret of secrets) expect(other.body).not.toContain(secret);
    const stats = JSON.parse(other.body);
    expect(stats.paidRequests).toBeGreaterThanOrEqual(1);
    expect(stats.recentPayments).toBeUndefined();
    expect(other.body).not.toContain(PAYER);
  });

  it("an admin sees each payment's path, with no query or fragment value", async () => {
    const res = await raw("GET", "/api/x402/stats", { "x-admin-key": ADMIN });
    expect(res.status).toBe(200);
    const stats = JSON.parse(res.body);
    expect(stats.recentPayments[0]).toMatchObject({ path: "/api/x402/routes", payer: PAYER, amount: "1000" });
    expect(res.body).not.toContain(mark("paid-q"));
    expect(res.body).not.toContain(mark("paid-f"));
  });
});
