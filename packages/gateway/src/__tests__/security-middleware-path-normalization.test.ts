/**
 * Normalized path in every security middleware (WP-A A9, MUST-CLOSE 10).
 *
 * find-my-way percent-decodes before it matches, so `/api/capabilities/%73earch`
 * RUNS the `/api/capabilities/search` handler while `req.url` still reads the
 * encoded string. Any middleware that decided on `req.url` could therefore be
 * steered by encoding: the payment gate served a priced route free, AEGIS left a
 * body unscanned, idempotency re-executed a replayed key, the global limiter was
 * skipped entirely. Each now decides on `authPath(req)` (middleware/route-path.ts
 * — the matched route template, or the decoded path when nothing matched), the
 * helper api-gate and scope-checker already use.
 *
 * Each case asserts that the ENCODED variant of a path is treated EXACTLY like
 * the plain path. security-monitor keeps RAW-URL attack detection (it must see
 * what the client sent) and only normalizes its skip-list.
 *
 * NOTE on harness: aegisGate, paymentGate and securityMonitorPlugin are plain
 * (encapsulated) plugin functions, so here they are applied DIRECTLY to the root
 * instance — their hooks then govern every route, which is what exercises the
 * decision logic under test. (How server.ts registers them is a separate
 * matter, reported with WP-A.)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const { trackServerEvent } = vi.hoisted(() => ({ trackServerEvent: vi.fn() }));
vi.mock("../services/posthog-service.js", () => ({ trackServerEvent }));

const { rateLimiter, __resetRateLimitState } = await import("../middleware/rate-limiter.js");
const { idempotencyGate, _clearCacheForTesting } = await import("../middleware/idempotency.js");
const { aegisGate } = await import("../middleware/aegis-gate.js");
const { securityMonitorPlugin } = await import("../middleware/security-monitor.js");

// ── rate-limiter ────────────────────────────────────────────────────
describe("rate-limiter decides on the normalized path", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    __resetRateLimitState();
    app = Fastify({ logger: false });
    await app.register(rateLimiter);
    app.get("/api/test", async () => ({ ok: true }));
    app.get("/api/health", async () => ({ ok: true }));
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    __resetRateLimitState();
  });

  it("an encoded /api path is rate-limited (it used to skip the limiter)", async () => {
    const res = await app.inject({ method: "GET", url: "/%61pi/test", remoteAddress: "192.0.2.31" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["ratelimit-limit"]).toBe("200");
    expect(res.headers["ratelimit-remaining"]).toBe("199");
  });

  it("encoded and plain requests share ONE bucket and hit 429 together", async () => {
    const ip = "192.0.2.32";
    for (let i = 0; i < 200; i++) {
      const url = i % 2 === 0 ? "/api/test" : "/%61pi/%74est";
      expect((await app.inject({ method: "GET", url, remoteAddress: ip })).statusCode).toBe(200);
    }
    const limited = await app.inject({ method: "GET", url: "/%61pi/test", remoteAddress: ip });
    expect(limited.statusCode).toBe(429);
  });

  it("the health exemption applies to an encoded /api/health exactly like the plain one", async () => {
    const ip = "192.0.2.33";
    const plain = await app.inject({ method: "GET", url: "/api/health", remoteAddress: ip });
    const encoded = await app.inject({ method: "GET", url: "/api/%68ealth", remoteAddress: ip });
    expect(plain.headers["ratelimit-remaining"]).toBe("200");
    expect(encoded.headers["ratelimit-remaining"]).toBe("200");
    // ...and neither consumed the bucket.
    const next = await app.inject({ method: "GET", url: "/api/test", remoteAddress: ip });
    expect(next.headers["ratelimit-remaining"]).toBe("199");
  });
});

// ── idempotency ─────────────────────────────────────────────────────
describe("idempotency dedups on the normalized path", () => {
  let app: FastifyInstance;
  let calls = 0;
  beforeEach(async () => {
    calls = 0;
    _clearCacheForTesting();
    app = Fastify({ logger: false });
    await app.register(idempotencyGate);
    app.post("/api/capabilities/quote", async () => ({ quote: `q-${++calls}` }));
    app.post("/api/capabilities/simulate", async () => ({ sim: `s-${++calls}` }));
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    _clearCacheForTesting();
  });

  const post = (url: string, key: string) =>
    app.inject({
      method: "POST", url,
      headers: { "idempotency-key": key, "content-type": "application/json" },
      payload: "{}",
    });

  it("an ENCODED replay of a plain request is deduped (it used to re-execute the handler)", async () => {
    const first = await post("/api/capabilities/quote", "k-1");
    const replay = await post("/api/capabilities/%71uote", "k-1");
    expect(first.json().quote).toBe("q-1");
    expect(replay.json().quote).toBe("q-1");
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(calls).toBe(1);
  });

  it("a PLAIN replay of an encoded first request is deduped too", async () => {
    await post("/api/%63apabilities/quote", "k-2");
    const replay = await post("/api/capabilities/quote", "k-2");
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(calls).toBe(1);
  });

  it("key reuse across routes is still a 422, whatever the encoding", async () => {
    await post("/api/capabilities/%71uote", "k-3");
    const res = await post("/api/capabilities/%73imulate", "k-3");
    expect(res.statusCode).toBe(422);
    expect(res.json().original.path).toBe("/api/capabilities/quote");
    expect(res.json().current.path).toBe("/api/capabilities/simulate");
  });
});

// ── payment gate (x402 legacy path: deterministic, no MPP secret) ───
describe("payment gate prices the normalized path", () => {
  const saved = {
    enabled: process.env.PCC_PAYMENT_ENABLED,
    legacy: process.env.PCC_X402_LEGACY,
    treasury: process.env.PCC_TREASURY_ADDRESS,
  };
  let app: FastifyInstance;
  beforeEach(async () => {
    process.env.PCC_PAYMENT_ENABLED = "true";
    process.env.PCC_X402_LEGACY = "true";
    // A configured recipient (WP-A fold F1): with none, priced routes are now
    // refused 503 payments_not_configured instead of being gated on the old
    // 0x…0001 placeholder. This suite is about PATH normalization, so it
    // configures a real-looking treasury to exercise the 402 path.
    process.env.PCC_TREASURY_ADDRESS = "0x1111111111111111111111111111111111111111";
    const { paymentGate } = await import("../middleware/x402-gate.js");
    app = Fastify({ logger: false });
    await paymentGate(app); // hooks on the root: they govern every route
    app.get("/api/capabilities/search", async () => ({ capabilities: [] }));
    app.get("/api/capabilities/:capId", async () => ({ capability: null }));
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    for (const [k, v] of [
      ["PCC_PAYMENT_ENABLED", saved.enabled],
      ["PCC_X402_LEGACY", saved.legacy],
      ["PCC_TREASURY_ADDRESS", saved.treasury],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("the plain priced route is 402 (control)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/capabilities/search?q=x" });
    expect(res.statusCode).toBe(402);
  });

  it("an ENCODED variant of the priced route is 402 too (it used to be served free)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/capabilities/%73earch?q=x" });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("payment_required");
  });

  it("an unpriced route stays free", async () => {
    const res = await app.inject({ method: "GET", url: "/api/capabilities/cap-123" });
    expect(res.statusCode).toBe(200);
  });
});

// ── AEGIS content gate ──────────────────────────────────────────────
describe("AEGIS gate scans / skips on the normalized path", () => {
  let app: FastifyInstance;
  let scans = 0;
  const blockAll = {
    name: "block-all-test-scanner",
    scan: async () => {
      scans++;
      return { decision: "BLOCK", zone: "red", confidence: 1, triggeredLayers: ["test"] };
    },
  };
  beforeEach(async () => {
    scans = 0;
    app = Fastify({ logger: false });
    await aegisGate(app, { scanner: blockAll as never });
    app.post("/api/echo", async () => ({ reached: true }));
    app.post("/api/ot2/camera/frame", async () => ({ reached: true }));
    await app.ready();
  });
  afterEach(async () => { await app.close(); });

  const post = (url: string) =>
    app.inject({ method: "POST", url, payload: { text: "hello" } });

  it("an ENCODED /api path is scanned (it used to fall outside the '/api/' prefix and skip)", async () => {
    const plain = await post("/api/echo");
    const encoded = await post("/%61pi/echo");
    expect(plain.statusCode).toBe(403);
    expect(encoded.statusCode).toBe(403);
    expect(encoded.json().error).toBe("AEGIS_BLOCKED");
    expect(scans).toBe(2);
  });

  it("an ENCODED variant of a skip-listed route is skipped exactly like the plain route", async () => {
    const plain = await post("/api/ot2/camera/frame");
    const encoded = await post("/api/ot2/camera/%66rame");
    expect(plain.statusCode).toBe(200);
    expect(encoded.statusCode).toBe(200);
    expect(scans).toBe(0);
  });
});

// ── security-monitor ────────────────────────────────────────────────
describe("security-monitor: skip-list normalized, attack detection raw", () => {
  let app: FastifyInstance;
  const fingerprintedPaths = () =>
    trackServerEvent.mock.calls
      .filter((c) => c[0] === "request_fingerprint")
      .map((c) => String((c[1] as { path?: unknown }).path));

  beforeEach(async () => {
    trackServerEvent.mockClear();
    app = Fastify({ logger: false });
    await securityMonitorPlugin(app); // hooks on the root: they govern every route
    app.get("/api/health", async () => ({ ok: true }));
    app.get("/api/thing", async () => ({ ok: true }));
    await app.ready();
  });
  afterEach(async () => { await app.close(); });

  /** Send `url`, then a definitely-fingerprinted control, and wait for it. */
  async function sendThenControl(url: string, control: string): Promise<string[]> {
    await app.inject({ method: "GET", url });
    await app.inject({ method: "GET", url: control });
    await vi.waitFor(() => expect(fingerprintedPaths()).toContain(control));
    return fingerprintedPaths();
  }

  it("an ENCODED /api/health is skipped exactly like /api/health", async () => {
    const seen = await sendThenControl("/api/%68ealth", "/api/thing");
    expect(seen).not.toContain("/api/%68ealth");
    expect(seen).not.toContain("/api/health");
  });

  it("a query ending in '.js' no longer drops a request out of fingerprinting", async () => {
    await app.inject({ method: "GET", url: "/api/thing?x=.js" });
    // fingerprint `path` strips the query, so look for the route itself.
    await vi.waitFor(() => expect(fingerprintedPaths()).toContain("/api/thing"));
  });

  it("attack detection still sees the RAW request line (regression guard)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/thing/..%2f..%2fetc/passwd" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
  });
});
