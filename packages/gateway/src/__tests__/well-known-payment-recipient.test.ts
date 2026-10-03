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
const TREASURY = "0x1111111111111111111111111111111111111111";
const TEMPO = "0x2222222222222222222222222222222222222222";
const ENV_KEYS = [
  "PCC_TREASURY_ADDRESS",
  "TEMPO_RECIPIENT",
  "PCC_X402_LEGACY",
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
  it("x402Support is false with no recipient, true with one", async () => {
    app = await buildApp();
    const off = await app.inject({ method: "GET", url: "/.well-known/agent-registration.json" });
    expect(off.json().x402Support).toBe(false);

    process.env.PCC_TREASURY_ADDRESS = TREASURY;
    const on = await app.inject({ method: "GET", url: "/.well-known/agent-registration.json" });
    expect(on.json().x402Support).toBe(true);
  });
});
