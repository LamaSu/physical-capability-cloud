/**
 * WP-A fold F1 (aeo #2352): discovery never advertises a placeholder payment
 * recipient.
 *
 * /.well-known/agent-card.json advertised `x-recipient: 0x…0001` whenever
 * TEMPO_RECIPIENT / PCC_TREASURY_ADDRESS were unset — telling every agent that
 * discovered PCC to pay an address nobody controls. With no configured
 * recipient the card now omits the payment scheme entirely (and its
 * recipient), and the ERC-8004 registration file stops claiming x402 support.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { wellKnownRoutes } from "../routes/well-known.js";
import { initSigningKey, _resetForTests } from "../signing-key.js";
import { initStore, closeStore } from "../db.js";

const PLACEHOLDER = "0x0000000000000000000000000000000000000001";
const TREASURY = "0x9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
const TEMPO = "0x4b20993bc481177ec7e8f571cecae8a9e22c02db";
const ENV_KEYS = [
  "PCC_TREASURY_ADDRESS",
  "TEMPO_RECIPIENT",
  "PCC_X402_LEGACY",
  "PCC_PAYMENT_ENABLED",
  "MPP_SECRET_KEY",
  "PCC_AGENT_CARD_SIGNING_KEY",
  "PCC_AGENT_CARD_SIGNING_KID",
] as const;
const saved: Record<string, string | undefined> = {};

let app: FastifyInstance | undefined;

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  _resetForTests();
  await initSigningKey(); // no key configured -> the unsigned card
  const a = Fastify({ logger: false });
  // Discovery reflects the payment gate as it RUNS (WP-A round 5, #2963), so the gate
  // is initialized first: enabled, with an MPP secret unless a test says otherwise.
  if (process.env.PCC_PAYMENT_ENABLED === undefined) process.env.PCC_PAYMENT_ENABLED = "true";
  if (process.env.MPP_SECRET_KEY === undefined) process.env.MPP_SECRET_KEY = "test-only-mpp-secret-key-0123456789abcdef";
  const { paymentGate } = await import("../middleware/x402-gate.js");
  await paymentGate(a);
  await a.register(wellKnownRoutes);
  await a.ready();
  return a;
}

async function card(): Promise<{ body: string; json: Record<string, any> }> {
  app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/.well-known/agent-card.json" });
  expect(res.statusCode).toBe(200);
  return { body: res.body, json: res.json() };
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(async () => {
  if (app) await app.close();
  app = undefined;
  closeStore();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("F1 — the A2A agent card advertises no placeholder recipient", () => {
  it("with NO recipient configured, the payment scheme and its recipient are omitted", async () => {
    const { body, json } = await card();
    expect(json.securitySchemes.x402).toBeUndefined();
    expect(body).not.toContain("x-recipient");
    expect(body).not.toContain(PLACEHOLDER);
    // The auth schemes are untouched.
    expect(json.securitySchemes.apiKey).toBeDefined();
  });

  it("an explicit placeholder or malformed recipient is treated as unconfigured", async () => {
    process.env.TEMPO_RECIPIENT = PLACEHOLDER;
    process.env.PCC_TREASURY_ADDRESS = TREASURY;
    const first = await card();
    expect(first.json.securitySchemes.x402).toBeUndefined();
    expect(first.body).not.toContain(PLACEHOLDER);
    await app!.close();
    closeStore();
    app = undefined;

    delete process.env.TEMPO_RECIPIENT;
    process.env.PCC_TREASURY_ADDRESS = "0xnot-an-address";
    const second = await card();
    expect(second.json.securitySchemes.x402).toBeUndefined();
    expect(second.body).not.toContain("0xnot-an-address");
  });

  it("control: a configured TEMPO_RECIPIENT is advertised as the MPP recipient", async () => {
    process.env.TEMPO_RECIPIENT = TEMPO;
    const { json } = await card();
    expect(json.securitySchemes.x402["x-recipient"]).toBe(TEMPO);
    expect(json.securitySchemes.x402["x-payment-protocol"]).toBe("mpp");
  });

  it("control: MPP falls back to a configured treasury when TEMPO_RECIPIENT is unset", async () => {
    process.env.PCC_TREASURY_ADDRESS = TREASURY;
    const { json } = await card();
    expect(json.securitySchemes.x402["x-recipient"]).toBe(TREASURY);
  });

  it("legacy x402 advertises PCC_TREASURY_ADDRESS only", async () => {
    process.env.PCC_X402_LEGACY = "true";
    process.env.TEMPO_RECIPIENT = TEMPO; // not the x402 payTo
    const unconfigured = await card();
    expect(unconfigured.json.securitySchemes.x402).toBeUndefined();
    await app!.close();
    closeStore();
    app = undefined;

    process.env.PCC_TREASURY_ADDRESS = TREASURY;
    const configured = await card();
    expect(configured.json.securitySchemes.x402["x-recipient"]).toBe(TREASURY);
    expect(configured.json.securitySchemes.x402["x-payment-protocol"]).toBe("x402");
  });
});

describe("F1 — the ERC-8004 registration file claims x402 support only when payable", () => {
  it("x402Support is false with no recipient, true with one (each read at startup, as the gate is)", async () => {
    app = await buildApp();
    const off = await app.inject({ method: "GET", url: "/.well-known/agent-registration.json" });
    expect(off.json().x402Support).toBe(false);
    await app.close();

    // WP-A round 5 (#2963): a recipient set after startup no longer flips discovery on its
    // own (the gate would not be charging it). A restart picks it up for both.
    process.env.PCC_TREASURY_ADDRESS = TREASURY;
    app = await buildApp();
    const on = await app.inject({ method: "GET", url: "/.well-known/agent-registration.json" });
    expect(on.json().x402Support).toBe(true);
  });
});

// ── WP-A round 5 (sol #2963): discovery follows the gate, not the environment ──
describe("discovery reflects the payment gate as initialized", () => {
  it("[neg] payments DISABLED: no scheme and no x402Support, even with a recipient configured", async () => {
    process.env.PCC_TREASURY_ADDRESS = TREASURY;
    process.env.TEMPO_RECIPIENT = TEMPO;
    process.env.PCC_PAYMENT_ENABLED = "false";
    const { body, json } = await card();
    expect(json.securitySchemes?.x402).toBeUndefined();
    expect(body).not.toContain(TEMPO);
    const reg = await app!.inject({ method: "GET", url: "/.well-known/agent-registration.json" });
    if (reg.statusCode === 200) expect(reg.json().x402Support).toBe(false);
  });

  it("[neg] MPP without MPP_SECRET_KEY: the gate runs x402, so the card says x402 with the treasury, never MPP", async () => {
    process.env.PCC_TREASURY_ADDRESS = TREASURY;
    process.env.TEMPO_RECIPIENT = TEMPO;
    process.env.MPP_SECRET_KEY = "";
    const { body } = await card();
    expect(body).toContain('"x-payment-protocol":"x402"');
    expect(body).toContain(TREASURY);
    expect(body).not.toContain(TEMPO);
  });

  it("[neg] a config change after startup does not change what discovery advertises (restart required)", async () => {
    process.env.TEMPO_RECIPIENT = TEMPO;
    app = await buildApp();
    process.env.TEMPO_RECIPIENT = "0x7a3f9b1c2d4e5f60718293a4b5c6d7e8f9012345"; // changed after the gate initialized
    const res = await app.inject({ method: "GET", url: "/.well-known/agent-card.json" });
    expect(res.body).toContain(TEMPO);
    expect(res.body).not.toContain("0x7a3f9b1c2d4e5f60718293a4b5c6d7e8f9012345");
  });
});
