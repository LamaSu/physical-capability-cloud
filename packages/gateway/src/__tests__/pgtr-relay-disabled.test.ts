import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { apiGate } from "../middleware/api-gate.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { pgtrRelayRoutes, PGTR_RELAY_DISABLED_REFUSAL } from "../routes/pgtr-relay.js";

// ───────────────────────────────────────────────────────────────────────────
// POST /api/pgtr/relay is disabled (economics security finding, bus #7292).
//
// With both PGTR env vars set, the old handler sent PCCForwarder.relay from the
// relayer key with a caller-chosen payer, target and callData, and an amount of
// "0" skipped the forwarder's only signature check. These tests pin the 501:
// the route's onRequest hook answers every request, so no body parser, relayer
// key read, wallet client or forwarder call ever runs. The spies below stand in
// for the handler's whole on-chain path: they record any call that would load
// the relayer key (privateKeyToAccount), build a client, send the relay
// transaction (writeContract) or load the forwarder ABI.
// ───────────────────────────────────────────────────────────────────────────

const spies = vi.hoisted(() => {
  const writeContract = vi.fn(async () => `0x${"ab".repeat(32)}`);
  return {
    writeContract,
    privateKeyToAccount: vi.fn(() => ({ address: "0x00000000000000000000000000000000000000a1" })),
    createWalletClient: vi.fn(() => ({ writeContract })),
    createPublicClient: vi.fn(() => ({})),
    forwarderAbiLoads: vi.fn(),
  };
});

vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  createWalletClient: spies.createWalletClient,
  createPublicClient: spies.createPublicClient,
}));
vi.mock("viem/accounts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem/accounts")>()),
  privateKeyToAccount: spies.privateKeyToAccount,
}));
// The factory runs once, on the first import of the module, so forwarderAbiLoads
// can only ever count 1: it marks the test in which the forwarder ABI first loaded.
vi.mock("@pcc/contracts/abi", () => {
  spies.forwarderAbiLoads();
  return { PCCForwarderABI: [] };
});

const PGTR_ENV = ["PCC_PGTR_FORWARDER_ADDRESS", "PCC_PGTR_RELAYER_KEY"] as const;
// Built at runtime so no literal in this file looks like a key.
const FAKE_RELAYER_KEY = `0x${"5a".repeat(32)}`;
const FORWARDER = "0x00000000000000000000000000000000000000f0";
const PAYER = "0x00000000000000000000000000000000000000b0";
const TARGET = "0x00000000000000000000000000000000000000c0";

/** A request the old handler accepted in full: every shape check passes and it goes on-chain. */
function relayBody(amount: string) {
  return {
    payer: PAYER,
    amount,
    nonce: `0x${"01".repeat(32)}`,
    expiry: Math.floor(Date.now() / 1000) + 600,
    target: TARGET,
    selector: "0x12345678",
    callData: "0x12345678",
    v: 27,
    r: `0x${"02".repeat(32)}`,
    s: `0x${"03".repeat(32)}`,
  };
}

let envReads: string[] = [];
let realEnv: NodeJS.ProcessEnv;

function setPgtrEnv() {
  vi.stubEnv("PCC_PGTR_FORWARDER_ADDRESS", FORWARDER);
  vi.stubEnv("PCC_PGTR_RELAYER_KEY", FAKE_RELAYER_KEY);
  // A closed local port: if the guard broke and a mock failed, no call could reach a real chain.
  vi.stubEnv("PCC_RPC_URL", "http://127.0.0.1:9");
}

/** Records every read of the two PGTR env vars until afterEach restores process.env. */
function watchPgtrEnvReads() {
  envReads = [];
  const target = process.env;
  process.env = new Proxy(target, {
    get(t, prop) {
      if (typeof prop === "string" && (PGTR_ENV as readonly string[]).includes(prop)) envReads.push(prop);
      return t[prop as string];
    },
  });
}

/** Everything the relay path did during this test; NO_RELAY_WORK when it did nothing. */
function relayWork() {
  return {
    envReads: [...envReads],
    privateKeyToAccount: spies.privateKeyToAccount.mock.calls.length,
    createWalletClient: spies.createWalletClient.mock.calls.length,
    createPublicClient: spies.createPublicClient.mock.calls.length,
    writeContract: spies.writeContract.mock.calls.length,
    forwarderAbiLoads: spies.forwarderAbiLoads.mock.calls.length,
  };
}

const NO_RELAY_WORK = {
  envReads: [],
  privateKeyToAccount: 0,
  createWalletClient: 0,
  createPublicClient: 0,
  writeContract: 0,
  forwarderAbiLoads: 0,
};

beforeEach(() => {
  realEnv = process.env;
  for (const spy of Object.values(spies)) spy.mockClear();
});

afterEach(() => {
  process.env = realEnv;
  vi.unstubAllEnvs();
});

describe("POST /api/pgtr/relay answers 501 PGTR_RELAY_DISABLED to every request", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(pgtrRelayRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(["0", "1000000"])(
    "a well-formed relay with amount %s and both env vars set gets 501, without reading the relayer key or calling the forwarder",
    async (amount) => {
      setPgtrEnv();
      watchPgtrEnvReads();

      const res = await app.inject({ method: "POST", url: "/api/pgtr/relay", payload: relayBody(amount) });

      expect({ status: res.statusCode, body: res.json(), work: relayWork() }).toEqual({
        status: 501,
        body: PGTR_RELAY_DISABLED_REFUSAL,
        work: NO_RELAY_WORK,
      });
      expect(res.json().code).toBe("PGTR_RELAY_DISABLED");
      expect(res.body).not.toContain(FAKE_RELAYER_KEY);
    },
  );

  it.each([
    ["malformed JSON", "application/json", "{not json"],
    ["a content type with no parser", "application/xml", "<relay/>"],
    ["an empty JSON body", "application/json", ""],
  ])("%s gets 501, not a parser error: the hook answers before any body parser runs", async (_label, contentType, payload) => {
    setPgtrEnv();
    watchPgtrEnvReads();

    const res = await app.inject({
      method: "POST",
      url: "/api/pgtr/relay",
      headers: { "content-type": contentType },
      payload,
    });

    expect({ status: res.statusCode, body: res.json(), work: relayWork() }).toEqual({
      status: 501,
      body: PGTR_RELAY_DISABLED_REFUSAL,
      work: NO_RELAY_WORK,
    });
  });

  it("with neither env var set it still answers 501, not the old 503 not-configured", async () => {
    // Deleted, not stubbed: vitest 1.x's stubEnv(name, undefined) stores the string "undefined".
    const saved = PGTR_ENV.map((name) => [name, process.env[name]] as const);
    for (const name of PGTR_ENV) delete process.env[name];
    try {
      watchPgtrEnvReads();

      const res = await app.inject({ method: "POST", url: "/api/pgtr/relay", payload: relayBody("0") });

      expect({ status: res.statusCode, body: res.json(), work: relayWork() }).toEqual({
        status: 501,
        body: PGTR_RELAY_DISABLED_REFUSAL,
        work: NO_RELAY_WORK,
      });
    } finally {
      process.env = realEnv;
      for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
    }
  });

  it("GET /api/pgtr/status reports enabled: false even with both env vars set, and never the key", async () => {
    setPgtrEnv();

    const res = await app.inject({ method: "GET", url: "/api/pgtr/status" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      enabled: false,
      disabledCode: "PGTR_RELAY_DISABLED",
      forwarderAddress: FORWARDER,
      relayerConfigured: true,
    });
    expect(res.body).not.toContain(FAKE_RELAYER_KEY);
  });
});

describe("behind the real apiGate: any API key or SIWE session gets the 501", () => {
  let app: FastifyInstance;
  let apiKey: string;
  let siweToken: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = ":memory:";
    closeStore();
    initStore({ seed: false });

    // The production order (server.ts): apiGate's onRequest hook, then the relay plugin.
    app = Fastify({ logger: false });
    await app.register(apiGate);
    await app.register(pgtrRelayRoutes);
    await app.ready();

    apiKey = provisionApiKey({ operatorId: "pgtr-relay-caller" }).rawKey;
    siweToken = randomUUID();
    const now = new Date();
    getRepos().sessions.insert({
      id: randomUUID(),
      walletAddress: "0xabc0000000000000000000000000000000000003",
      token: siweToken,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      lastActiveAt: now.toISOString(),
    });
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  it.each([
    ["an API key", () => apiKey],
    ["a SIWE session", () => siweToken],
  ])("%s with both env vars set and amount 0 gets 501 and no relay work", async (_label, token) => {
    setPgtrEnv();
    watchPgtrEnvReads();

    const res = await app.inject({
      method: "POST",
      url: "/api/pgtr/relay",
      headers: { authorization: `Bearer ${token()}` },
      payload: relayBody("0"),
    });

    expect({ status: res.statusCode, body: res.json(), work: relayWork() }).toEqual({
      status: 501,
      body: PGTR_RELAY_DISABLED_REFUSAL,
      work: NO_RELAY_WORK,
    });
  });

  it("without credentials apiGate answers 401 first, and the relay still does no work", async () => {
    setPgtrEnv();
    watchPgtrEnvReads();

    const res = await app.inject({ method: "POST", url: "/api/pgtr/relay", payload: relayBody("0") });

    expect({ status: res.statusCode, work: relayWork() }).toEqual({ status: 401, work: NO_RELAY_WORK });
  });
});
