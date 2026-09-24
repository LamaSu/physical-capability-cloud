/**
 * WP-A fold F1 (aeo #2352): the payment recipient FAILS CLOSED.
 *
 * middleware/x402-gate.ts defaulted PCC_TREASURY_ADDRESS / TEMPO_RECIPIENT to
 * 0x0000000000000000000000000000000000000001 and /.well-known/agent-card.json
 * advertised the same placeholder: an unconfigured gateway asked every client
 * to pay an address nobody controls. Now, with payment enabled and no
 * configured (well-formed, non-placeholder) recipient, priced routes answer
 * 503 `payments_not_configured`, and the discovery documents omit the payment
 * scheme and its recipient. Nothing ever requires or accepts payment to a
 * placeholder.
 *
 * HARNESS: the payment gate is an encapsulated plugin (server.ts registers it
 * with a plain app.register, so today its hooks govern only its own routes —
 * reported separately as WP-G). Here the gate and the priced routes live in ONE
 * app: paymentGate is applied to the root instance, so its hooks govern the
 * routes registered next to it. server.ts registration is NOT changed.
 *
 * The gate module is re-imported per test (vi.resetModules) so env set in a
 * test is what the gate sees, whether it reads env at import or registration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const PLACEHOLDER = "0x0000000000000000000000000000000000000001";
const TREASURY = "0x1111111111111111111111111111111111111111";
const TEMPO = "0x2222222222222222222222222222222222222222";

const ENV_KEYS = [
  "PCC_PAYMENT_ENABLED",
  "PCC_X402_ENABLED",
  "PCC_X402_LEGACY",
  "MPP_ENABLED",
  "MPP_SECRET_KEY",
  "PCC_TREASURY_ADDRESS",
  "TEMPO_RECIPIENT",
] as const;
const saved: Record<string, string | undefined> = {};

function resetEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

async function buildGateApp(): Promise<FastifyInstance> {
  vi.resetModules();
  const { paymentGate } = await import("../middleware/x402-gate.js");
  const app = Fastify({ logger: false });
  await paymentGate(app); // hooks on the root: they govern the routes below
  app.post("/api/capabilities/quote", async () => ({ quoted: true }));
  app.get("/api/capabilities/search", async () => ({ capabilities: [] }));
  app.get("/api/capabilities/types", async () => ({ types: [] })); // unpriced
  await app.ready();
  return app;
}

function decodePaymentRequired(header: string | string[] | undefined): { accepts: Array<{ payTo: string }> } {
  return JSON.parse(Buffer.from(String(header), "base64").toString("utf8"));
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  resetEnv();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("F1 — payment gate (legacy x402 path)", () => {
  beforeEach(() => {
    process.env.PCC_PAYMENT_ENABLED = "true";
    process.env.PCC_X402_LEGACY = "true";
  });

  it("with NO treasury configured, a priced route is 503 payments_not_configured (not a 402 to a placeholder)", async () => {
    const app = await buildGateApp();
    const res = await app.inject({ method: "POST", url: "/api/capabilities/quote" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("payments_not_configured");
    expect(res.headers["payment-required"]).toBeUndefined();
    expect(res.body).not.toContain(PLACEHOLDER);
    await app.close();
  });

  it("the GET priced route is refused too, and an ENCODED variant exactly like it", async () => {
    const app = await buildGateApp();
    for (const url of ["/api/capabilities/search?q=x", "/api/capabilities/%73earch?q=x"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(503);
    }
    await app.close();
  });

  it("an EXPLICIT placeholder treasury is refused like an unset one", async () => {
    for (const bad of [PLACEHOLDER, "0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dEaD"]) {
      process.env.PCC_TREASURY_ADDRESS = bad;
      const app = await buildGateApp();
      const res = await app.inject({ method: "POST", url: "/api/capabilities/quote" });
      expect(res.statusCode, bad).toBe(503);
      await app.close();
    }
  });

  it("a MALFORMED treasury is refused (never echoed as a payTo)", async () => {
    process.env.PCC_TREASURY_ADDRESS = "not-an-address";
    const app = await buildGateApp();
    const res = await app.inject({ method: "POST", url: "/api/capabilities/quote" });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("not-an-address");
    await app.close();
  });

  it("unpriced routes stay free while unconfigured", async () => {
    const app = await buildGateApp();
    const res = await app.inject({ method: "GET", url: "/api/capabilities/types" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("/api/x402/routes advertises NO payTo while unconfigured", async () => {
    const app = await buildGateApp();
    const res = await app.inject({ method: "GET", url: "/api/x402/routes" });
    expect(res.statusCode).toBe(200);
    expect(res.json().payTo).toBeUndefined();
    expect(res.json().configured).toBe(false);
    expect(res.body).not.toContain(PLACEHOLDER);
    await app.close();
  });

  it("control: a CONFIGURED treasury gets the 402 challenge, paying exactly that address", async () => {
    process.env.PCC_TREASURY_ADDRESS = TREASURY;
    const app = await buildGateApp();
    const res = await app.inject({ method: "POST", url: "/api/capabilities/quote" });
    expect(res.statusCode).toBe(402);
    expect(decodePaymentRequired(res.headers["payment-required"]).accepts[0].payTo).toBe(TREASURY);
    const routes = await app.inject({ method: "GET", url: "/api/x402/routes" });
    expect(routes.json().payTo).toBe(TREASURY);
    await app.close();
  });
});

describe("F1 — payment gate (MPP, the default protocol)", () => {
  beforeEach(() => {
    process.env.PCC_PAYMENT_ENABLED = "true";
    process.env.MPP_SECRET_KEY = "test-only-mpp-secret-key-0123456789abcdef";
  });

  it("with NO recipient configured, a priced route is 503 payments_not_configured", async () => {
    const app = await buildGateApp();
    const res = await app.inject({ method: "POST", url: "/api/capabilities/quote" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("payments_not_configured");
    expect(res.headers["www-authenticate"]).toBeUndefined();
    await app.close();
  });

  it("a SET-but-placeholder TEMPO_RECIPIENT is refused — it does not fall back to the treasury", async () => {
    process.env.TEMPO_RECIPIENT = PLACEHOLDER;
    process.env.PCC_TREASURY_ADDRESS = TREASURY;
    const app = await buildGateApp();
    const res = await app.inject({ method: "POST", url: "/api/capabilities/quote" });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("control: a configured TEMPO_RECIPIENT gets the MPP 402 challenge", async () => {
    process.env.TEMPO_RECIPIENT = TEMPO;
    const app = await buildGateApp();
    const res = await app.inject({ method: "POST", url: "/api/capabilities/quote" });
    expect(res.statusCode).toBe(402);
    expect(res.json().protocol).toBe("mpp");
    expect(String(res.headers["www-authenticate"] ?? "")).not.toBe("");
    await app.close();
  });
});

describe("MPP challenge is header-safe (found while testing F1)", () => {
  it("every priced route's description is printable ASCII (it rides in WWW-Authenticate)", async () => {
    vi.resetModules();
    const { PAYMENT_ROUTES } = await import("../middleware/x402-gate.js");
    for (const [route, { description }] of Object.entries(PAYMENT_ROUTES)) {
      expect(description, route).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});

describe("F1 — payment disabled is unchanged", () => {
  it("with payment disabled every route is free, recipient or not", async () => {
    const app = await buildGateApp();
    const res = await app.inject({ method: "POST", url: "/api/capabilities/quote" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
