/**
 * Unit tests for NATSJetStreamBackend.
 *
 * These tests inject a structural mock of the nats.js client via the
 * `connectFn` option. NO running NATS server is required and the real `nats`
 * npm module is never loaded in this suite.
 *
 * Integration suite (run against a real server):
 *   1. Start NATS with JetStream:
 *        docker run --rm -p 4222:4222 nats:latest -js
 *   2. Run:
 *        NATS_INTEGRATION=1 pnpm --filter @pcc/a2a test nats-backend
 *
 *   The integration tests in this file are gated behind the env var; CI runs
 *   the unit suite only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NATSJetStreamBackend,
  type NatsConnectFn,
  type NatsConnectionLike,
  type JetStreamClientLike,
  type JetStreamManagerLike,
  type ConsumerLike,
  type ConsumerMessagesLike,
  type JsMsgLike,
  type PubAckLike,
  type ConsumerAddConfig,
  type NatsAuthHelpers,
  type NatsConnectionOptions,
} from "../backends/nats-jetstream-backend.js";
import { createBackendFromEnv } from "../backends/index.js";
import type { A2AMessage } from "../types.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<A2AMessage> = {}): A2AMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 8)}`,
    conversationId: "conv_test",
    from: "agent_alice",
    to: "agent_bob",
    intent: { type: "text_message", text: "hello" },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Build a fake `consume()` iterator backed by a queue + a never-resolving
 * sentinel promise that completes when stop() is called. Sufficient to drive
 * the backend's runConsumeLoop().
 */
function makeFakeMessages(initial: JsMsgLike[] = []): ConsumerMessagesLike & {
  push(m: JsMsgLike): void;
  stopped(): boolean;
} {
  const queue: JsMsgLike[] = [...initial];
  let stopped = false;
  let waiterResolve: (() => void) | undefined;
  function notify() {
    if (waiterResolve) {
      waiterResolve();
      waiterResolve = undefined;
    }
  }
  const iter: ConsumerMessagesLike & {
    push(m: JsMsgLike): void;
    stopped(): boolean;
  } = {
    stop() {
      stopped = true;
      notify();
    },
    push(m: JsMsgLike) {
      queue.push(m);
      notify();
    },
    stopped() {
      return stopped;
    },
    [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<JsMsgLike>> => {
          while (!stopped) {
            if (queue.length > 0) {
              return { value: queue.shift()!, done: false };
            }
            await new Promise<void>((res) => {
              waiterResolve = res;
            });
          }
          return { value: undefined as unknown as JsMsgLike, done: true };
        },
      };
    },
  };
  return iter;
}

interface FakeServer {
  connectFn: NatsConnectFn;
  /** Subjects published with the encoded payloads */
  published: Array<{ subject: string; payload: Uint8Array }>;
  /** Streams that exist on the "server" */
  streams: Set<string>;
  /** Consumers added: stream→Map<durable, cfg> */
  consumers: Map<string, Map<string, ConsumerAddConfig>>;
  /** Messages-iterators handed back to subscribers, keyed by durable */
  iterators: Map<string, ReturnType<typeof makeFakeMessages>>;
  /** How many times connect() was called */
  connectCalls: number;
  /** Toggle: when true, `streams.info()` rejects to force `add()` */
  streamMissing: boolean;
  /** Toggle: when true, `consumers.info()` rejects to force `add()` */
  consumerMissing: boolean;
  /** Ack/nak tracking — per durable name */
  acks: Map<string, number>;
  naks: Map<string, number>;
  /** Track whether close()/drain() were called on the connection */
  closed: boolean;
  drained: boolean;
  /** Track deleted consumers */
  consumerDeleted: Set<string>;
}

function makeFakeServer(): FakeServer {
  const server: FakeServer = {
    connectFn: null as unknown as NatsConnectFn,
    published: [],
    streams: new Set(),
    consumers: new Map(),
    iterators: new Map(),
    connectCalls: 0,
    streamMissing: true,
    consumerMissing: true,
    acks: new Map(),
    naks: new Map(),
    closed: false,
    drained: false,
    consumerDeleted: new Set(),
  };

  server.connectFn = async () => {
    server.connectCalls++;

    const js: JetStreamClientLike = {
      async publish(subject, payload) {
        server.published.push({ subject, payload });
        const ack: PubAckLike = { seq: server.published.length, stream: "PCC_A2A_TEST" };
        return ack;
      },
      consumers: {
        async get(stream, name): Promise<ConsumerLike> {
          const iter = server.iterators.get(name) ?? makeFakeMessages();
          server.iterators.set(name, iter);
          return {
            async consume() {
              return iter;
            },
            async delete() {
              server.consumerDeleted.add(name);
              iter.stop();
              return true;
            },
          };
        },
      },
    };

    const jsm: JetStreamManagerLike = {
      streams: {
        async info(name) {
          if (server.streamMissing || !server.streams.has(name)) {
            throw new Error(`stream not found: ${name}`);
          }
          return { name };
        },
        async add(cfg) {
          server.streams.add(cfg.name);
          server.streamMissing = false;
          return { name: cfg.name, subjects: cfg.subjects };
        },
      },
      consumers: {
        async info(stream, name) {
          if (server.consumerMissing) {
            throw new Error(`consumer not found: ${name}`);
          }
          const byName = server.consumers.get(stream);
          if (!byName?.has(name)) throw new Error(`consumer not found: ${name}`);
          return { name };
        },
        async add(stream, cfg) {
          let byName = server.consumers.get(stream);
          if (!byName) {
            byName = new Map();
            server.consumers.set(stream, byName);
          }
          byName.set(cfg.durable_name, cfg);
          return { name: cfg.durable_name };
        },
      },
    };

    const nc: NatsConnectionLike = {
      isClosed: () => server.closed,
      isDraining: () => false,
      async drain() {
        server.drained = true;
        server.closed = true;
        // Stop every iterator so consume loops exit gracefully.
        for (const it of server.iterators.values()) it.stop();
      },
      async close() {
        server.closed = true;
        for (const it of server.iterators.values()) it.stop();
      },
      jetstream() {
        return js;
      },
      async jetstreamManager() {
        return jsm;
      },
    };

    return nc;
  };

  return server;
}

/**
 * Build a JsMsg whose ack()/nak() update the server's per-durable counters.
 * Pass the durable name so we can attribute the ack.
 */
function makeJsMsg(
  server: FakeServer,
  durable: string,
  payload: Uint8Array,
): JsMsgLike {
  return {
    data: payload,
    ack() {
      server.acks.set(durable, (server.acks.get(durable) ?? 0) + 1);
    },
    nak(_millis?: number) {
      server.naks.set(durable, (server.naks.get(durable) ?? 0) + 1);
    },
    string() {
      return new TextDecoder().decode(payload);
    },
  };
}

function encodeMsg(msg: A2AMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg));
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("NATSJetStreamBackend (unit, mocked nats.js)", () => {
  let server: FakeServer;
  let backend: NATSJetStreamBackend;

  beforeEach(() => {
    server = makeFakeServer();
    backend = new NATSJetStreamBackend({
      url: "nats://localhost:4222",
      streamName: "PCC_A2A_TEST",
      connectFn: server.connectFn,
    });
  });

  // ── Identity ─────────────────────────────────────────────────────────────

  it("exposes backend.name as 'nats'", () => {
    expect(backend.name).toBe("nats");
  });

  // ── Lazy connect ─────────────────────────────────────────────────────────

  describe("lazy connect", () => {
    it("does not connect at construction time", () => {
      expect(server.connectCalls).toBe(0);
    });

    it("connects exactly once on first publish()", async () => {
      const msg = makeMessage();
      await backend.publish("pcc.a2a.text_message", msg);
      expect(server.connectCalls).toBe(1);
      await backend.publish("pcc.a2a.text_message", msg);
      expect(server.connectCalls).toBe(1);
      await backend.close();
    });

    it("connects exactly once when publish and subscribe race", async () => {
      const [, sub] = await Promise.all([
        backend.publish("pcc.a2a.text_message", makeMessage()),
        backend.subscribe("pcc.a2a.text_message", () => {}),
      ]);
      expect(server.connectCalls).toBe(1);
      await sub.unsubscribe();
      await backend.close();
    });
  });

  // ── Stream creation (idempotent) ─────────────────────────────────────────

  describe("stream creation", () => {
    it("creates the stream with the correct subject pattern on first connect", async () => {
      await backend.publish("pcc.a2a.text_message", makeMessage());
      expect(server.streams.has("PCC_A2A_TEST")).toBe(true);
      await backend.close();
    });

    it("uses the default subject pattern pcc.a2a.>", async () => {
      const addSpy = vi.fn(async (cfg: { name: string; subjects: string[] }) => {
        server.streams.add(cfg.name);
        return { name: cfg.name, subjects: cfg.subjects };
      });
      // Wrap the original add to spy.
      const origConnect = server.connectFn;
      server.connectFn = async () => {
        const nc = await origConnect({} as never);
        const origJsm = await nc.jetstreamManager();
        const wrapped: JetStreamManagerLike = {
          ...origJsm,
          streams: {
            info: origJsm.streams.info.bind(origJsm.streams),
            add: addSpy,
          },
        };
        return {
          ...nc,
          async jetstreamManager() {
            return wrapped;
          },
        };
      };
      backend = new NATSJetStreamBackend({
        url: "nats://localhost:4222",
        streamName: "PCC_A2A_TEST",
        connectFn: server.connectFn,
      });
      await backend.publish("pcc.a2a.text_message", makeMessage());
      expect(addSpy).toHaveBeenCalledOnce();
      expect(addSpy.mock.calls[0][0]).toEqual({
        name: "PCC_A2A_TEST",
        subjects: ["pcc.a2a.>"],
      });
      await backend.close();
    });

    it("does NOT recreate the stream if it already exists (info succeeds)", async () => {
      server.streamMissing = false;
      server.streams.add("PCC_A2A_TEST");
      const addSpy = vi.fn();
      const origConnect = server.connectFn;
      server.connectFn = async () => {
        const nc = await origConnect({} as never);
        const origJsm = await nc.jetstreamManager();
        return {
          ...nc,
          async jetstreamManager() {
            return {
              ...origJsm,
              streams: {
                info: origJsm.streams.info.bind(origJsm.streams),
                add: addSpy,
              },
            };
          },
        };
      };
      backend = new NATSJetStreamBackend({
        url: "nats://localhost:4222",
        streamName: "PCC_A2A_TEST",
        connectFn: server.connectFn,
      });
      await backend.publish("pcc.a2a.text_message", makeMessage());
      expect(addSpy).not.toHaveBeenCalled();
      await backend.close();
    });

    it("calls add() exactly once even when many publish/subscribe operations race", async () => {
      const addSpy = vi.fn(async (cfg: { name: string; subjects: string[] }) => {
        server.streams.add(cfg.name);
        server.streamMissing = false;
        return { name: cfg.name, subjects: cfg.subjects };
      });
      const origConnect = server.connectFn;
      server.connectFn = async () => {
        const nc = await origConnect({} as never);
        const origJsm = await nc.jetstreamManager();
        return {
          ...nc,
          async jetstreamManager() {
            return {
              ...origJsm,
              streams: {
                info: origJsm.streams.info.bind(origJsm.streams),
                add: addSpy,
              },
            };
          },
        };
      };
      backend = new NATSJetStreamBackend({
        url: "nats://localhost:4222",
        streamName: "PCC_A2A_TEST",
        connectFn: server.connectFn,
      });
      await Promise.all([
        backend.publish("pcc.a2a.text_message", makeMessage()),
        backend.publish("pcc.a2a.text_message", makeMessage()),
        backend.subscribe("pcc.a2a.text_message", () => {}),
      ]);
      expect(addSpy).toHaveBeenCalledOnce();
      await backend.close();
    });
  });

  // ── Publish ──────────────────────────────────────────────────────────────

  describe("publish", () => {
    it("publishes to the exact subject passed in", async () => {
      const msg = makeMessage({ intent: { type: "request_quote", capabilityType: "fdm", params: {}, assuranceTier: 0 } });
      await backend.publish("pcc.a2a.request_quote", msg);
      expect(server.published).toHaveLength(1);
      expect(server.published[0].subject).toBe("pcc.a2a.request_quote");
      await backend.close();
    });

    it("serializes the message as JSON Uint8Array", async () => {
      const msg = makeMessage({ id: "msg_known" });
      await backend.publish("pcc.a2a.text_message", msg);
      const decoded = JSON.parse(
        new TextDecoder().decode(server.published[0].payload),
      ) as A2AMessage;
      expect(decoded.id).toBe("msg_known");
      expect(decoded.intent.type).toBe("text_message");
      await backend.close();
    });

    it("rejects publish after close()", async () => {
      await backend.close();
      await expect(
        backend.publish("pcc.a2a.text_message", makeMessage()),
      ).rejects.toThrow(/closed/);
    });
  });

  // ── Subscribe (consumer create + consume + ack) ──────────────────────────

  describe("subscribe", () => {
    it("creates a durable consumer with explicit ack policy", async () => {
      const sub = await backend.subscribe(
        "pcc.a2a.text_message",
        async () => {},
      );
      const consumers = server.consumers.get("PCC_A2A_TEST");
      expect(consumers).toBeDefined();
      expect(consumers!.size).toBe(1);
      const [name, cfg] = [...consumers!.entries()][0];
      expect(name).toMatch(/^pcc-a2a-bus-/);
      expect(cfg.ack_policy).toBe("explicit");
      expect(cfg.filter_subject).toBe("pcc.a2a.text_message");
      await sub.unsubscribe();
      await backend.close();
    });

    it("delivers a published message to the handler", async () => {
      const handler = vi.fn();
      const sub = await backend.subscribe("pcc.a2a.text_message", handler);
      // Grab the iterator the consumer was bound to.
      const durables = [...server.consumers.get("PCC_A2A_TEST")!.keys()];
      const iter = server.iterators.get(durables[0])!;
      const msg = makeMessage({ id: "delivered_1" });
      iter.push(makeJsMsg(server, durables[0], encodeMsg(msg)));
      // Yield a few microtasks so the consume loop runs.
      await new Promise((r) => setTimeout(r, 10));
      expect(handler).toHaveBeenCalledOnce();
      const received = handler.mock.calls[0][0] as A2AMessage;
      expect(received.id).toBe("delivered_1");
      expect(server.acks.get(durables[0])).toBe(1);
      await sub.unsubscribe();
      await backend.close();
    });

    it("acks after successful handler invocation", async () => {
      const sub = await backend.subscribe("pcc.a2a.text_message", async () => {});
      const [durable] = [...server.consumers.get("PCC_A2A_TEST")!.keys()];
      const iter = server.iterators.get(durable)!;
      iter.push(makeJsMsg(server, durable, encodeMsg(makeMessage())));
      iter.push(makeJsMsg(server, durable, encodeMsg(makeMessage())));
      await new Promise((r) => setTimeout(r, 10));
      expect(server.acks.get(durable)).toBe(2);
      expect(server.naks.get(durable) ?? 0).toBe(0);
      await sub.unsubscribe();
      await backend.close();
    });

    it("nak()s when the handler throws", async () => {
      const sub = await backend.subscribe("pcc.a2a.text_message", async () => {
        throw new Error("handler boom");
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const [durable] = [...server.consumers.get("PCC_A2A_TEST")!.keys()];
      const iter = server.iterators.get(durable)!;
      iter.push(makeJsMsg(server, durable, encodeMsg(makeMessage())));
      await new Promise((r) => setTimeout(r, 10));
      expect(server.naks.get(durable)).toBe(1);
      expect(server.acks.get(durable) ?? 0).toBe(0);
      errSpy.mockRestore();
      await sub.unsubscribe();
      await backend.close();
    });

    it("ack()s and drops messages with malformed payloads (no infinite redeliver)", async () => {
      const handler = vi.fn();
      const sub = await backend.subscribe("pcc.a2a.text_message", handler);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const [durable] = [...server.consumers.get("PCC_A2A_TEST")!.keys()];
      const iter = server.iterators.get(durable)!;
      iter.push(makeJsMsg(server, durable, new TextEncoder().encode("not json {{{")));
      await new Promise((r) => setTimeout(r, 10));
      expect(handler).not.toHaveBeenCalled();
      expect(server.acks.get(durable)).toBe(1);
      errSpy.mockRestore();
      await sub.unsubscribe();
      await backend.close();
    });

    it("each subscribe() gets a unique durable name", async () => {
      const sub1 = await backend.subscribe("pcc.a2a.text_message", () => {});
      const sub2 = await backend.subscribe("pcc.a2a.request_quote", () => {});
      const durables = [...server.consumers.get("PCC_A2A_TEST")!.keys()];
      expect(durables).toHaveLength(2);
      expect(new Set(durables).size).toBe(2);
      await sub1.unsubscribe();
      await sub2.unsubscribe();
      await backend.close();
    });

    it("rejects subscribe after close()", async () => {
      await backend.close();
      await expect(
        backend.subscribe("pcc.a2a.text_message", () => {}),
      ).rejects.toThrow(/closed/);
    });

    it("unsubscribe is idempotent", async () => {
      const sub = await backend.subscribe("pcc.a2a.text_message", () => {});
      await sub.unsubscribe();
      await expect(sub.unsubscribe()).resolves.toBeUndefined();
      await backend.close();
    });

    it("unsubscribe deletes the underlying consumer", async () => {
      const sub = await backend.subscribe("pcc.a2a.text_message", () => {});
      const [durable] = [...server.consumers.get("PCC_A2A_TEST")!.keys()];
      await sub.unsubscribe();
      expect(server.consumerDeleted.has(durable)).toBe(true);
      await backend.close();
    });
  });

  // ── close() — drain + idempotency ────────────────────────────────────────

  describe("close", () => {
    it("calls nc.drain() on close", async () => {
      await backend.publish("pcc.a2a.text_message", makeMessage());
      await backend.close();
      expect(server.drained).toBe(true);
    });

    it("is idempotent", async () => {
      await backend.publish("pcc.a2a.text_message", makeMessage());
      await backend.close();
      await expect(backend.close()).resolves.toBeUndefined();
      expect(server.drained).toBe(true);
    });

    it("stops all subscriptions before draining the connection", async () => {
      const sub1 = await backend.subscribe("pcc.a2a.text_message", () => {});
      const sub2 = await backend.subscribe("pcc.a2a.request_quote", () => {});
      const durables = [...server.consumers.get("PCC_A2A_TEST")!.keys()];
      await backend.close();
      // All consumers should have been deleted before drain.
      for (const d of durables) {
        expect(server.consumerDeleted.has(d)).toBe(true);
      }
      expect(server.drained).toBe(true);
      // Re-using sub handles after close is a no-op.
      await expect(sub1.unsubscribe()).resolves.toBeUndefined();
      await expect(sub2.unsubscribe()).resolves.toBeUndefined();
    });

    it("close before any publish/subscribe does not crash", async () => {
      await expect(backend.close()).resolves.toBeUndefined();
      // And does not open a connection.
      expect(server.connectCalls).toBe(0);
    });
  });

  // ── Reconnect delay (exponential + bounded) ──────────────────────────────

  describe("computeReconnectDelay (via custom reconnectDelayHandler)", () => {
    it("hands a delay function to the underlying nats.js connect()", async () => {
      // Capture the connect args
      let capturedOpts: Record<string, unknown> | undefined;
      const origConnect = server.connectFn;
      server.connectFn = async (opts) => {
        capturedOpts = opts as unknown as Record<string, unknown>;
        return origConnect(opts);
      };
      backend = new NATSJetStreamBackend({
        url: "nats://localhost:4222",
        streamName: "PCC_A2A_TEST",
        connectFn: server.connectFn,
        reconnectBaseDelayMs: 500,
        reconnectMaxDelayMs: 30_000,
        maxReconnectAttempts: 10,
      });
      await backend.publish("pcc.a2a.text_message", makeMessage());
      expect(capturedOpts).toBeDefined();
      expect(capturedOpts!.reconnect).toBe(true);
      expect(capturedOpts!.maxReconnectAttempts).toBe(10);
      const handler = capturedOpts!.reconnectDelayHandler as () => number;
      expect(typeof handler).toBe("function");

      // First attempt: base*2^0 = 500 + jitter < 750
      const d0 = handler();
      expect(d0).toBeGreaterThanOrEqual(500);
      expect(d0).toBeLessThan(500 + 250);

      // Second attempt: base*2^1 = 1000 + jitter
      const d1 = handler();
      expect(d1).toBeGreaterThanOrEqual(1000);
      expect(d1).toBeLessThan(1000 + 250);

      // Tenth attempt: should be capped at max.
      for (let i = 0; i < 20; i++) handler();
      const big = handler();
      expect(big).toBeLessThanOrEqual(30_000 + 250);
      expect(big).toBeGreaterThanOrEqual(30_000);

      await backend.close();
    });

    it("respects custom maxReconnectAttempts (-1 means unlimited)", async () => {
      let capturedOpts: Record<string, unknown> | undefined;
      const origConnect = server.connectFn;
      server.connectFn = async (opts) => {
        capturedOpts = opts as unknown as Record<string, unknown>;
        return origConnect(opts);
      };
      backend = new NATSJetStreamBackend({
        url: "nats://localhost:4222",
        streamName: "PCC_A2A_TEST",
        connectFn: server.connectFn,
        maxReconnectAttempts: -1,
      });
      await backend.publish("pcc.a2a.text_message", makeMessage());
      expect(capturedOpts!.maxReconnectAttempts).toBe(-1);
      await backend.close();
    });
  });

  // ── Connect failure handling ────────────────────────────────────────────

  describe("connect failure", () => {
    it("propagates the error and allows a subsequent retry", async () => {
      let callCount = 0;
      const failingThenOk: NatsConnectFn = async (opts) => {
        callCount++;
        if (callCount === 1) throw new Error("simulated handshake failure");
        return server.connectFn(opts);
      };
      backend = new NATSJetStreamBackend({
        url: "nats://localhost:4222",
        streamName: "PCC_A2A_TEST",
        connectFn: failingThenOk,
      });
      await expect(
        backend.publish("pcc.a2a.text_message", makeMessage()),
      ).rejects.toThrow(/handshake failure/);
      // Retry succeeds.
      await expect(
        backend.publish("pcc.a2a.text_message", makeMessage()),
      ).resolves.toBeUndefined();
      expect(callCount).toBe(2);
      await backend.close();
    });
  });
});

// ── TLS option forwarding ───────────────────────────────────────────────────

describe("NATSJetStreamBackend TLS options", () => {
  let server: FakeServer;
  let capturedOpts: NatsConnectionOptions | undefined;

  beforeEach(() => {
    server = makeFakeServer();
    capturedOpts = undefined;
    const orig = server.connectFn;
    server.connectFn = async (opts) => {
      capturedOpts = opts;
      return orig(opts);
    };
  });

  it("forwards `tls: true` as boolean", async () => {
    const backend = new NATSJetStreamBackend({
      url: "tls://nats.example:4222",
      streamName: "PCC_A2A_TEST",
      connectFn: server.connectFn,
      tls: true,
    });
    await backend.publish("pcc.a2a.text_message", makeMessage());
    expect(capturedOpts?.tls).toBe(true);
    await backend.close();
  });

  it("reads caFile/certFile/keyFile from disk and forwards PEM contents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pcc-nats-tls-"));
    const caFile = join(dir, "ca.pem");
    const certFile = join(dir, "cert.pem");
    const keyFile = join(dir, "key.pem");
    writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\nFAKE_CA\n-----END CERTIFICATE-----\n");
    writeFileSync(certFile, "-----BEGIN CERTIFICATE-----\nFAKE_CERT\n-----END CERTIFICATE-----\n");
    writeFileSync(keyFile, "-----BEGIN PRIVATE KEY-----\nFAKE_KEY\n-----END PRIVATE KEY-----\n");
    try {
      const backend = new NATSJetStreamBackend({
        url: "tls://nats.example:4222",
        streamName: "PCC_A2A_TEST",
        connectFn: server.connectFn,
        tls: { caFile, certFile, keyFile, rejectUnauthorized: true, servername: "nats.example" },
      });
      await backend.publish("pcc.a2a.text_message", makeMessage());
      const tls = capturedOpts?.tls;
      expect(typeof tls).toBe("object");
      if (typeof tls === "object") {
        expect(tls.caCerts?.[0]).toContain("FAKE_CA");
        expect(tls.certs?.[0]).toContain("FAKE_CERT");
        expect(tls.keys?.[0]).toContain("FAKE_KEY");
        expect(tls.rejectUnauthorized).toBe(true);
        expect(tls.servername).toBe("nats.example");
      }
      await backend.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT set `tls` on the connect options when option is omitted", async () => {
    const backend = new NATSJetStreamBackend({
      url: "nats://localhost:4222",
      streamName: "PCC_A2A_TEST",
      connectFn: server.connectFn,
    });
    await backend.publish("pcc.a2a.text_message", makeMessage());
    expect(capturedOpts?.tls).toBeUndefined();
    await backend.close();
  });

  it("forwards rejectUnauthorized=false when explicitly disabled", async () => {
    const backend = new NATSJetStreamBackend({
      url: "tls://nats.example:4222",
      streamName: "PCC_A2A_TEST",
      connectFn: server.connectFn,
      tls: { rejectUnauthorized: false },
    });
    await backend.publish("pcc.a2a.text_message", makeMessage());
    const tls = capturedOpts?.tls;
    expect(typeof tls).toBe("object");
    if (typeof tls === "object") {
      expect(tls.rejectUnauthorized).toBe(false);
    }
    await backend.close();
  });
});

// ── Auth option forwarding ──────────────────────────────────────────────────

describe("NATSJetStreamBackend auth options", () => {
  let server: FakeServer;
  let capturedOpts: NatsConnectionOptions | undefined;

  beforeEach(() => {
    server = makeFakeServer();
    capturedOpts = undefined;
    const orig = server.connectFn;
    server.connectFn = async (opts) => {
      capturedOpts = opts;
      return orig(opts);
    };
  });

  it("forwards token auth", async () => {
    const backend = new NATSJetStreamBackend({
      url: "nats://localhost:4222",
      streamName: "PCC_A2A_TEST",
      connectFn: server.connectFn,
      auth: { kind: "token", token: "secret-token" },
    });
    await backend.publish("pcc.a2a.text_message", makeMessage());
    expect(capturedOpts?.token).toBe("secret-token");
    expect(capturedOpts?.user).toBeUndefined();
    await backend.close();
  });

  it("forwards userPass auth", async () => {
    const backend = new NATSJetStreamBackend({
      url: "nats://localhost:4222",
      streamName: "PCC_A2A_TEST",
      connectFn: server.connectFn,
      auth: { kind: "userPass", user: "alice", pass: "p@ss" },
    });
    await backend.publish("pcc.a2a.text_message", makeMessage());
    expect(capturedOpts?.user).toBe("alice");
    expect(capturedOpts?.pass).toBe("p@ss");
    expect(capturedOpts?.token).toBeUndefined();
    await backend.close();
  });

  it("forwards nkey auth with injected helpers (no real nats module loaded)", async () => {
    const fakeHelpers: NatsAuthHelpers = {
      nkeys: {
        fromSeed(_seed: Uint8Array) {
          return {
            sign: (_input: Uint8Array) => new Uint8Array([1, 2, 3]),
            getPublicKey: () => "UABCDEFTESTPUBLICKEY",
          };
        },
      },
      credsAuthenticator: () => ({ kind: "creds-auth" }),
      jwtAuthenticator: (_jwt: string, _seed?: Uint8Array) => ({ kind: "jwt-auth" }),
    };
    const backend = new NATSJetStreamBackend({
      url: "nats://localhost:4222",
      streamName: "PCC_A2A_TEST",
      connectFn: server.connectFn,
      natsAuthHelpers: fakeHelpers,
      auth: { kind: "nkey", nkeySeed: "SUAAFAKESEED" },
    });
    await backend.publish("pcc.a2a.text_message", makeMessage());
    expect(capturedOpts?.nkey).toBe("UABCDEFTESTPUBLICKEY");
    expect(typeof capturedOpts?.authenticator).toBe("function");
    await backend.close();
  });

  it("forwards jwt auth with injected helpers", async () => {
    const fakeHelpers: NatsAuthHelpers = {
      nkeys: { fromSeed: () => ({ sign: () => new Uint8Array(), getPublicKey: () => "" }) },
      credsAuthenticator: () => ({ kind: "creds-auth" }),
      jwtAuthenticator: vi.fn((_jwt: string, _seed?: Uint8Array) => ({ kind: "jwt-auth" })),
    };
    const backend = new NATSJetStreamBackend({
      url: "nats://localhost:4222",
      streamName: "PCC_A2A_TEST",
      connectFn: server.connectFn,
      natsAuthHelpers: fakeHelpers,
      auth: { kind: "jwt", jwt: "eyJ.fakeJWT", nkeySeed: "SUAFAKESEED" },
    });
    await backend.publish("pcc.a2a.text_message", makeMessage());
    expect(capturedOpts?.jwt).toBe("eyJ.fakeJWT");
    expect(capturedOpts?.authenticator).toEqual({ kind: "jwt-auth" });
    expect(fakeHelpers.jwtAuthenticator).toHaveBeenCalledOnce();
    await backend.close();
  });

  it("forwards credsFile auth by reading the file and passing bytes to credsAuthenticator", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pcc-nats-creds-"));
    const credsPath = join(dir, "user.creds");
    writeFileSync(credsPath, "-----BEGIN NATS USER JWT-----\nFAKE_CREDS\n------END NATS USER JWT------\n");
    try {
      const credsCall = vi.fn((bytes: Uint8Array) => ({ kind: "creds-auth", size: bytes.length }));
      const fakeHelpers: NatsAuthHelpers = {
        nkeys: { fromSeed: () => ({ sign: () => new Uint8Array(), getPublicKey: () => "" }) },
        credsAuthenticator: credsCall,
        jwtAuthenticator: () => ({ kind: "jwt-auth" }),
      };
      const backend = new NATSJetStreamBackend({
        url: "nats://localhost:4222",
        streamName: "PCC_A2A_TEST",
        connectFn: server.connectFn,
        natsAuthHelpers: fakeHelpers,
        auth: { kind: "credsFile", path: credsPath },
      });
      await backend.publish("pcc.a2a.text_message", makeMessage());
      expect(credsCall).toHaveBeenCalledOnce();
      const bytes = credsCall.mock.calls[0][0];
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBeGreaterThan(0);
      expect(capturedOpts?.authenticator).toMatchObject({ kind: "creds-auth" });
      await backend.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("validation", () => {
    it("rejects empty token", () => {
      expect(
        () =>
          new NATSJetStreamBackend({
            url: "nats://localhost:4222",
            streamName: "PCC_A2A_TEST",
            connectFn: server.connectFn,
            auth: { kind: "token", token: "" },
          }),
      ).toThrow(/non-empty token/);
    });

    it("rejects missing userPass fields", () => {
      expect(
        () =>
          new NATSJetStreamBackend({
            url: "nats://localhost:4222",
            streamName: "PCC_A2A_TEST",
            connectFn: server.connectFn,
            // @ts-expect-error -- intentional: empty user
            auth: { kind: "userPass", user: "", pass: "x" },
          }),
      ).toThrow(/requires user/);
    });

    it("rejects jwt without nkeySeed", () => {
      expect(
        () =>
          new NATSJetStreamBackend({
            url: "nats://localhost:4222",
            streamName: "PCC_A2A_TEST",
            connectFn: server.connectFn,
            // @ts-expect-error -- intentional: missing seed
            auth: { kind: "jwt", jwt: "eyJ.x", nkeySeed: "" },
          }),
      ).toThrow(/requires nkeySeed/);
    });

    it("rejects credsFile without path", () => {
      expect(
        () =>
          new NATSJetStreamBackend({
            url: "nats://localhost:4222",
            streamName: "PCC_A2A_TEST",
            connectFn: server.connectFn,
            auth: { kind: "credsFile", path: "" },
          }),
      ).toThrow(/requires path/);
    });
  });
});

// ── Env-var → backend wiring (createBackendFromEnv) ─────────────────────────

describe("createBackendFromEnv NATS env-var parsing", () => {
  const origEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "PCC_MESSAGE_BUS_BACKEND",
    "NATS_URL",
    "NATS_STREAM_NAME",
    "NATS_DURABLE_NAME",
    "NATS_TLS",
    "NATS_TLS_CA_FILE",
    "NATS_TLS_CERT_FILE",
    "NATS_TLS_KEY_FILE",
    "NATS_TLS_REJECT_UNAUTHORIZED",
    "NATS_TLS_SERVERNAME",
    "NATS_AUTH_KIND",
    "NATS_TOKEN",
    "NATS_USER",
    "NATS_PASS",
    "NATS_NKEY_SEED",
    "NATS_JWT",
    "NATS_CREDS_FILE",
  ] as const;

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      origEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (origEnv[k] === undefined) delete process.env[k];
      else process.env[k] = origEnv[k];
    }
  });

  it("returns InMemoryBackend by default", async () => {
    const backend = await createBackendFromEnv();
    expect(backend.name).toBe("memory");
    await backend.close();
  });

  it("returns NATSJetStreamBackend when PCC_MESSAGE_BUS_BACKEND=nats", async () => {
    process.env.PCC_MESSAGE_BUS_BACKEND = "nats";
    const backend = await createBackendFromEnv();
    expect(backend.name).toBe("nats");
    await backend.close();
  });

  it("throws on unknown PCC_MESSAGE_BUS_BACKEND", async () => {
    process.env.PCC_MESSAGE_BUS_BACKEND = "kafka";
    await expect(createBackendFromEnv()).rejects.toThrow(/not a known backend/);
  });

  it("warns when TLS env vars are set but URL uses nats:// scheme", async () => {
    process.env.PCC_MESSAGE_BUS_BACKEND = "nats";
    process.env.NATS_URL = "nats://localhost:4222";
    process.env.NATS_TLS = "1";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backend = await createBackendFromEnv();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("nats://"));
    warnSpy.mockRestore();
    await backend.close();
  });

  it("does NOT warn when URL uses tls:// scheme", async () => {
    process.env.PCC_MESSAGE_BUS_BACKEND = "nats";
    process.env.NATS_URL = "tls://nats.example:4222";
    process.env.NATS_TLS = "1";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backend = await createBackendFromEnv();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    await backend.close();
  });

  it("rejects NATS_AUTH_KIND=token without NATS_TOKEN", async () => {
    process.env.PCC_MESSAGE_BUS_BACKEND = "nats";
    process.env.NATS_AUTH_KIND = "token";
    await expect(createBackendFromEnv()).rejects.toThrow(/requires NATS_TOKEN/);
  });

  it("rejects NATS_AUTH_KIND=userPass missing NATS_PASS", async () => {
    process.env.PCC_MESSAGE_BUS_BACKEND = "nats";
    process.env.NATS_AUTH_KIND = "userPass";
    process.env.NATS_USER = "alice";
    await expect(createBackendFromEnv()).rejects.toThrow(/requires NATS_USER and NATS_PASS/);
  });

  it("rejects NATS_AUTH_KIND=jwt missing NATS_NKEY_SEED", async () => {
    process.env.PCC_MESSAGE_BUS_BACKEND = "nats";
    process.env.NATS_AUTH_KIND = "jwt";
    process.env.NATS_JWT = "eyJ.x";
    await expect(createBackendFromEnv()).rejects.toThrow(/requires NATS_JWT and NATS_NKEY_SEED/);
  });

  it("rejects unknown NATS_AUTH_KIND", async () => {
    process.env.PCC_MESSAGE_BUS_BACKEND = "nats";
    process.env.NATS_AUTH_KIND = "kerberos";
    await expect(createBackendFromEnv()).rejects.toThrow(/is not recognized/);
  });

  it("accepts NATS_AUTH_KIND=token with NATS_TOKEN set", async () => {
    process.env.PCC_MESSAGE_BUS_BACKEND = "nats";
    process.env.NATS_AUTH_KIND = "token";
    process.env.NATS_TOKEN = "secret";
    const backend = await createBackendFromEnv();
    expect(backend.name).toBe("nats");
    await backend.close();
  });

  it("accepts NATS_AUTH_KIND=credsFile with NATS_CREDS_FILE set", async () => {
    process.env.PCC_MESSAGE_BUS_BACKEND = "nats";
    process.env.NATS_AUTH_KIND = "credsFile";
    process.env.NATS_CREDS_FILE = "/etc/pcc/nats.creds";
    const backend = await createBackendFromEnv();
    expect(backend.name).toBe("nats");
    await backend.close();
  });
});

// ── Integration suite — gated behind NATS_INTEGRATION=1 ─────────────────────
// Run `docker run --rm -p 4222:4222 nats:latest -js` first, then:
//   NATS_INTEGRATION=1 pnpm --filter @pcc/a2a test nats-backend

const runIntegration = process.env.NATS_INTEGRATION === "1";

describe.skipIf(!runIntegration)("NATSJetStreamBackend (integration)", () => {
  it("connects to a real NATS server and round-trips a message", async () => {
    const backend = new NATSJetStreamBackend({
      url: "nats://localhost:4222",
      streamName: `PCC_A2A_INT_${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    });
    const received: A2AMessage[] = [];
    const sub = await backend.subscribe(
      "pcc.a2a.text_message",
      async (m) => {
        received.push(m);
      },
    );
    const msg = makeMessage({ id: `int_${Date.now()}` });
    await backend.publish("pcc.a2a.text_message", msg);
    // JetStream delivery is asynchronous; allow up to 2s.
    for (let i = 0; i < 20 && received.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe(msg.id);
    await sub.unsubscribe();
    await backend.close();
  }, 15_000);
});
