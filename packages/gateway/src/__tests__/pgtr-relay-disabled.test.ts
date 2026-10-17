import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Socket } from "node:net";
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
// key read, wallet client or forwarder call ever runs. The spies below guard
// against the removed on-chain path returning: they record any call that would load
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

// ───────────────────────────────────────────────────────────────────────────
// The guard must hold while the 501 is still being sent.
//
// Production wraps the relay route in ROOT async onSend hooks (report_hint at server.ts:267 and
// irCorsReadProjection at :314, both added before the plugin registers at :728, at e20bd239), so a
// 501 sent from onRequest is still in flight when send() returns. The callback guard neither
// returns a promise nor calls done, so the hook runner receives no continuation (Fastify 4.29.1
// lib/hooks.js:230-263). An async guard that sends without returning reply resolves at once,
// while reply.sent (lib/reply.js:104-108: hijacked or raw.writableEnded) is still false, so the
// request goes on into preParsing and the body parser. The old async guard returned reply,
// which waited for completion but also fulfilled on premature close (lib/reply.js:491-510).
// The fixtures above have no onSend hook: send() ends the response at once, so they cannot
// distinguish those guards from the callback guard.
// This fixture holds the 501 in an async onSend hook until the test opens a gate.
// ───────────────────────────────────────────────────────────────────────────

/** A promise and the function that resolves it. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Lets queued work run for `turns` setImmediate turns, draining the nextTick and promise queues
 * between them. Microtasks alone are not enough: light-my-request delivers the body in a setImmediate.
 */
async function settle(turns = 20) {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Rejects with `message` if `promise` has not settled within `ms`, so a stuck request fails the test instead of hanging it. */
async function within<T>(promise: PromiseLike<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("with a root async onSend hook holding the 501, as in production, the request never gets past onRequest", () => {
  const RELAY_URL = "/api/pgtr/relay";
  const CONTROL_URL = "/__lifecycle-control";
  let app: FastifyInstance;
  let stages: string[] = [];
  let onSendEntered = deferred();
  let gate = deferred();

  beforeAll(async () => {
    app = Fastify({ logger: false });

    // ROOT hooks, added before the relay plugin registers, so they wrap its route as server.ts's root hooks do.
    // The hold, for the relay route only: an async onSend hook, like server.ts:267 and :314.
    app.addHook("onSend", async (request, _reply, payload) => {
      if (request.routeOptions.url !== RELAY_URL) return payload;
      onSendEntered.resolve();
      await gate.promise;
      return payload;
    });
    // A broken guard can queue a second response behind the same gate. Once the
    // first response is sent, discard duplicate writes without changing reply.sent
    // or the stage observations, so negative controls have no unhandled rejection.
    app.addHook("onSend", (_request, reply, payload, done) => {
      if (!reply.raw.headersSent) done(null, payload);
    });
    // Stage spies: each records that a request reached its stage.
    app.addHook("preParsing", async (_request, _reply, payload) => {
      stages.push("preParsing");
      return payload;
    });
    app.removeContentTypeParser("application/json");
    app.addContentTypeParser<string>("application/json", { parseAs: "string" }, (_request, body, done) => {
      stages.push("parse");
      try {
        done(null, JSON.parse(body));
      } catch (err) {
        done(err as Error);
      }
    });
    app.addHook("preValidation", async () => {
      stages.push("preValidation");
    });
    app.addHook("preHandler", async () => {
      stages.push("preHandler");
    });

    await app.register(pgtrRelayRoutes);
    // The live control: an unguarded route in its own plugin, as the relay route is, under the same root hooks.
    await app.register(async (sibling) => {
      sibling.post(CONTROL_URL, async () => ({ ok: true }));
    });
    await app.ready();
  });

  beforeEach(() => {
    stages = [];
    onSendEntered = deferred();
    gate = deferred();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(["0", "1000000"])(
    "a well-formed relay with amount %s and both env vars set gets 501, and no request stage, env read or relay work starts while onSend holds it",
    async (amount) => {
      setPgtrEnv();
      watchPgtrEnvReads();

      const pending = app.inject({ method: "POST", url: RELAY_URL, payload: relayBody(amount) });
      let responded = false;
      void pending.then(
        () => {
          responded = true;
        },
        () => {
          responded = true;
        },
      );
      try {
        await within(onSendEntered.promise, 2_000, "the relay request never reached the onSend hook");
        await settle();

        // The 501 is still held in onSend, and nothing after onRequest has started.
        expect({ responded, stages: [...stages], work: relayWork() }).toEqual({
          responded: false,
          stages: [],
          work: NO_RELAY_WORK,
        });

        gate.resolve();
        const res = await within(pending, 2_000, "the relay request never finished after the gate opened");
        expect({ status: res.statusCode, body: res.json() }).toEqual({ status: 501, body: PGTR_RELAY_DISABLED_REFUSAL });
        expect(res.json()).toMatchObject({ code: "PGTR_RELAY_DISABLED", error: "not_implemented" });

        // Nor once the response has gone.
        await settle();
        expect({ stages: [...stages], work: relayWork() }).toEqual({ stages: [], work: NO_RELAY_WORK });
      } finally {
        // Never leave the request held: a failed assertion must not leave it pending into the next test or app.close().
        gate.resolve();
        await within(pending, 2_000, "the relay request never finished").catch(() => undefined);
      }
    },
  );

  it("control: an unguarded sibling route under the same hooks runs preParsing, parse, preValidation and preHandler, in order", async () => {
    const res = await app.inject({ method: "POST", url: CONTROL_URL, payload: { probe: true } });

    expect({ status: res.statusCode, body: res.json(), stages: [...stages] }).toEqual({
      status: 200,
      body: { ok: true },
      stages: ["preParsing", "parse", "preValidation", "preHandler"],
    });
  });
});

describe("a premature close while the 501 is held does not let the request past onRequest", () => {
  const RELAY_URL = "/api/pgtr/relay";
  const CONTROL_URL = "/__premature-close-control";

  async function fixture() {
    const app = Fastify({ logger: false });
    const stages: string[] = [];
    const onSendEntered = deferred();
    const closed = deferred();
    const gate = deferred();
    let rawResponse: ServerResponse | undefined;

    // Both sibling routes are under the same root hold and stage observers.
    app.addHook("onSend", async (_request, reply, payload) => {
      if (!rawResponse) {
        rawResponse = reply.raw;
        reply.raw.once("close", closed.resolve);
        onSendEntered.resolve();
        await gate.promise;
      }
      return payload;
    });
    // After an abort, discard response writes (including an accidental second send).
    // This changes neither reply.sent nor request continuation: stages and signing
    // remain observable, without ERR_HTTP_HEADERS_SENT when the gate is released.
    app.addHook("onSend", (_request, reply, payload, done) => {
      if (!reply.raw.destroyed) done(null, payload);
    });
    app.addHook("preParsing", async (_request, _reply, payload) => {
      stages.push("preParsing");
      return payload;
    });
    app.removeContentTypeParser("application/json");
    app.addContentTypeParser<string>("application/json", { parseAs: "string" }, (_request, body, done) => {
      stages.push("parse");
      try {
        done(null, JSON.parse(body));
      } catch (err) {
        done(err as Error);
      }
    });
    app.addHook("preValidation", async () => {
      stages.push("preValidation");
    });
    app.addHook("preHandler", async () => {
      stages.push("preHandler");
    });
    await app.register(pgtrRelayRoutes);
    await app.register(async (sibling) => {
      sibling.post(CONTROL_URL, {
        // The old async guard deliberately resumes when reply.then fulfills on close.
        onRequest: async (_request, reply) => reply.code(501).send(PGTR_RELAY_DISABLED_REFUSAL),
      }, (_request, reply) => {
        stages.push("handler");
        reply.hijack(); // Record continuation without sending a second response.
      });
    });
    return { app, stages, onSendEntered, closed, gate, rawResponse: () => rawResponse };
  }

  async function abortedRequest(transport: "inject" | "http", amount: string | undefined, control = false) {
    const f = await fixture();
    let socket: Socket | undefined;
    let pending: Promise<void> | undefined;
    const url = control ? CONTROL_URL : RELAY_URL;
    const observe = () => ({ stages: [...f.stages], work: relayWork() });
    const assertStopped = () => expect(observe()).toEqual({ stages: [], work: NO_RELAY_WORK });
    const assertContinued = () => {
      expect(f.stages).toEqual(transport === "inject"
        ? ["preParsing", "parse", "preValidation", "preHandler", "handler"]
        : ["preParsing", "preValidation", "preHandler", "handler"]);
      expect(relayWork()).toEqual(NO_RELAY_WORK);
    };

    setPgtrEnv();
    watchPgtrEnvReads();
    try {
      if (transport === "inject") {
        // Attach both outcomes immediately: light-my-request rejects on response close.
        pending = f.app.inject({ method: "POST", url, payload: relayBody(amount!) }).then(
          () => undefined,
          () => undefined,
        );
      } else {
        await within(f.app.listen({ port: 0, host: "127.0.0.1" }), 2_000, "the local HTTP listener never started");
        const address = f.app.server.address();
        if (!address || typeof address === "string") throw new Error("expected a local TCP address");
        socket = connect({ port: address.port, host: "127.0.0.1" });
        const connected = new Promise<void>((resolve, reject) => {
          socket!.once("connect", resolve);
          socket!.once("error", reject);
        });
        // Also handle errors after connect; the bounded entry/close waits still fail if needed.
        socket.on("error", () => undefined);
        await within(connected, 2_000, "the local HTTP client never connected");
        const body = amount === undefined ? "" : JSON.stringify(relayBody(amount));
        socket.write(`POST ${url} HTTP/1.1\r\nHost: 127.0.0.1\r\n${amount === undefined ? "" : "Content-Type: application/json\r\n"}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      }

      await within(f.onSendEntered.promise, 2_000, "the request never entered the held onSend hook");
      const raw = f.rawResponse()!;
      expect(raw.writableEnded).toBe(false);
      if (transport === "inject") raw.destroy();
      else socket!.destroy();
      await within(f.closed.promise, 2_000, "the server response never emitted close");
      expect(raw.writableEnded).toBe(false); // Close happened before successful completion.
      await within(settle(), 2_000, "queued work never settled after close");
      // A shared short margin after close lets dynamic imports in a regressed signer finish.
      // Controls use exactly the same margin and waits as the real route.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      if (control) assertContinued();
      else assertStopped();

      f.gate.resolve();
      await within(settle(), 2_000, "queued work never settled after releasing onSend");
      if (control) assertContinued();
      else assertStopped();
    } finally {
      f.gate.resolve();
      socket?.destroy();
      f.rawResponse()?.destroy();
      try {
        if (pending) await within(pending, 2_000, "the aborted inject never settled");
        await within(settle(), 2_000, "cleanup work never settled");
      } finally {
        await within(f.app.close(), 2_000, "the app never closed");
      }
    }
  }

  it.each(["0", "1000000"])("inject with amount %s: no stages, env reads or relay work after premature close", async (amount) => {
    await abortedRequest("inject", amount);
  });

  it("real HTTP with JSON body: no stages, env reads or relay work after premature close", async () => {
    await abortedRequest("http", "0");
  });

  it("real HTTP with Content-Length: 0 and no Content-Type: no stages, env reads or relay work after premature close", async () => {
    await abortedRequest("http", undefined);
  });

  it("control: the old async guard continues through the handler after inject premature close", async () => {
    await abortedRequest("inject", "0", true);
  });

  it("control: the old async guard continues through the handler after bodyless HTTP premature close", async () => {
    await abortedRequest("http", undefined, true);
  });
});
