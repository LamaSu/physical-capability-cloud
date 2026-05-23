/**
 * Tests for POST /api/intents/ingest — Phase 2.1 external intent capture.
 *
 * Covers (6 cases minimum):
 *   1. Valid envelope → 202 + event emitted
 *   2. Missing auth (no operatorId attached) → 401
 *   3. Bad envelope shape → 400
 *   4. Idempotency replay → same envelopeId, Idempotency-Replayed: true
 *   5. Rate-limit trip after RATE_LIMIT_PER_MIN calls → 429
 *   6. intent.external_ingest event emitted with the right shape
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  intentIngestRoutes,
  _clearIntentIngestCacheForTesting,
} from "../routes/intent-ingest.js";
import { getEventBus, resetEventBus } from "../services/event-bus.js";
import type { AnalyticsEvent, DemandEnvelope } from "@pcc/spec";
import { computeCompositionSignature } from "@pcc/spec";

// ---------------------------------------------------------------------------
// App builders
// ---------------------------------------------------------------------------

/** Authed app — simulates apiGate having attached operatorId. */
async function buildAuthedApp(operatorId: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("operatorId", null);
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.addHook("onRequest", async (req) => {
    (req as unknown as { operatorId: string }).operatorId = operatorId;
  });
  await app.register(intentIngestRoutes);
  await app.ready();
  return app;
}

/** Unauthed app — no onRequest hook attaches operatorId. */
async function buildUnauthedApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("operatorId", null);
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  await app.register(intentIngestRoutes);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OP_ID = "op-test-001";

function makeValidEnvelope(overrides: Partial<DemandEnvelope> = {}): DemandEnvelope {
  const capabilityTypes = ["3d-printing"];
  const sig = computeCompositionSignature(capabilityTypes, []);
  return {
    id: "intent-test-001",
    source: "mcp_broker",
    compositionSignature: sig,
    capabilityTypes,
    summary: "Print a small ABS bracket for a desk lamp arm",
    budgetBand: "100_1k",
    urgencyBand: "standard",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetEventBus();
  _clearIntentIngestCacheForTesting();
});

afterEach(() => {
  resetEventBus();
  _clearIntentIngestCacheForTesting();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/intents/ingest", () => {
  // ── 1. Valid envelope ──────────────────────────────────────────────
  it("accepts a valid envelope and returns 202 with envelopeId + dedupeKey", async () => {
    const app = await buildAuthedApp(OP_ID);
    try {
      const env = makeValidEnvelope();
      const res = await app.inject({
        method: "POST",
        url: "/api/intents/ingest",
        payload: env,
      });
      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.accepted).toBe(true);
      expect(body.envelopeId).toBe(env.id);
      expect(body.dedupeKey).toBe(`${OP_ID}:${env.compositionSignature}`);
    } finally {
      await app.close();
    }
  });

  // ── 2. Missing auth ────────────────────────────────────────────────
  it("returns 401 when no operatorId is attached", async () => {
    const app = await buildUnauthedApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/intents/ingest",
        payload: makeValidEnvelope(),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("authentication_required");
    } finally {
      await app.close();
    }
  });

  // ── 3. Bad envelope ────────────────────────────────────────────────
  it("returns 400 for an envelope that doesn't match the schema", async () => {
    const app = await buildAuthedApp(OP_ID);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/intents/ingest",
        payload: { not: "a valid envelope" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_envelope");
      expect(res.json().details).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("returns 400 when compositionSignature is malformed", async () => {
    const app = await buildAuthedApp(OP_ID);
    try {
      const bad = { ...makeValidEnvelope(), compositionSignature: "not-hex" };
      const res = await app.inject({
        method: "POST",
        url: "/api/intents/ingest",
        payload: bad,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ── 4. Idempotency replay ──────────────────────────────────────────
  it("returns the same envelopeId for repeated idempotency keys without re-emitting", async () => {
    const app = await buildAuthedApp(OP_ID);
    try {
      const events: AnalyticsEvent[] = [];
      getEventBus().onEvent((ev) => {
        if (ev.eventType === "intent.external_ingest") events.push(ev);
      });

      const env = makeValidEnvelope();
      const first = await app.inject({
        method: "POST",
        url: "/api/intents/ingest",
        payload: env,
        headers: { "idempotency-key": "client-batch-42" },
      });
      const second = await app.inject({
        method: "POST",
        url: "/api/intents/ingest",
        payload: env,
        headers: { "idempotency-key": "client-batch-42" },
      });

      expect(first.statusCode).toBe(202);
      expect(second.statusCode).toBe(202);
      expect(first.json().envelopeId).toBe(second.json().envelopeId);
      expect(second.headers["idempotency-replayed"]).toBe("true");

      // The second call must NOT have re-emitted the event.
      expect(events).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  // ── 5. Rate-limit trip ─────────────────────────────────────────────
  // The 600/min limit is enforced per-operator. We pick a unique operator
  // ID for this test so it doesn't share state with the other tests
  // (checkCallerRate's map is module-level).
  it("returns 429 once the per-operator rate limit is exceeded", async () => {
    const burstOp = `op-rate-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const app = await buildAuthedApp(burstOp);
    try {
      // Spend the full budget of 600 calls, then expect the 601st to 429.
      // We send 600 quick injects, then assert the next one trips the limit.
      const env = makeValidEnvelope();
      // Fire 600 sequentially (fast — in-memory, no I/O).
      for (let i = 0; i < 600; i++) {
        const r = await app.inject({
          method: "POST",
          url: "/api/intents/ingest",
          payload: { ...env, id: `intent-${i}` },
        });
        expect(r.statusCode).toBe(202);
      }
      const tripped = await app.inject({
        method: "POST",
        url: "/api/intents/ingest",
        payload: { ...env, id: "intent-601" },
      });
      expect(tripped.statusCode).toBe(429);
      expect(tripped.json().error).toBe("rate_limited");
      expect(tripped.headers["retry-after"]).toBe("60");
    } finally {
      await app.close();
    }
  }, 20_000);

  // ── 6. Event shape verification ────────────────────────────────────
  it("emits intent.external_ingest with actorType=agent and the envelope as payload", async () => {
    const app = await buildAuthedApp(OP_ID);
    try {
      const captured: AnalyticsEvent[] = [];
      getEventBus().onEvent((ev) => {
        if (ev.eventType === "intent.external_ingest") captured.push(ev);
      });

      const env = makeValidEnvelope({ source: "sdk", originAgentVendor: "claude" });
      const res = await app.inject({
        method: "POST",
        url: "/api/intents/ingest",
        payload: env,
      });
      expect(res.statusCode).toBe(202);
      expect(captured).toHaveLength(1);

      const ev = captured[0];
      expect(ev.eventType).toBe("intent.external_ingest");
      expect(ev.category).toBe("intent");
      expect(ev.actorId).toBe(OP_ID);
      expect(ev.actorType).toBe("agent");
      expect(ev.resourceType).toBe("intent");
      expect(ev.resourceId).toBe(env.id);
      expect(ev.payload).toMatchObject({
        id: env.id,
        source: "sdk",
        compositionSignature: env.compositionSignature,
        originAgentVendor: "claude",
      });
    } finally {
      await app.close();
    }
  });
});
