/**
 * R44 D2 — route-level and seam tests for server-side unmet-demand capture.
 *
 * Proves, against the real routes and an in-memory seeded store:
 *   - flag OFF: capture point A emits exactly the legacy actor and envelope;
 *   - flag ON: the principal comes from apiGate's context (never the body), and
 *     unmet types are computed from live supply;
 *   - /api/intents/ingest always drops caller-asserted fulfillmentPath/unmet;
 *   - SEAM: events captured by the route feed @pcc/demand-intel's
 *     UnmetDemandLens, whose output projects to a public aggregate only at k.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import { createStore } from "@pcc/store";
import { UnmetDemandLens } from "@pcc/demand-intel";
import { toPublicOpportunityAggregate, type AnalyticsEvent, type CSD } from "@pcc/spec";
import { requestRoutes, resetRequestsStore } from "../routes/requests.js";
import { intentIngestRoutes, _clearIntentIngestCacheForTesting } from "../routes/intent-ingest.js";
import { getCsdRegistry, resetCsdRegistry } from "../routes/csd.js";
import { getCapabilityFacade } from "../facades/index.js";
import { initStore, closeStore } from "../db.js";
import { initJobOffersStore, _resetJobOffersStoreForTests } from "../services/job-offers-store.js";
import { getEventBus, resetEventBus } from "../services/event-bus.js";
import { computeCompositionSignature } from "@pcc/spec";

const LH_URI = "pcc://capabilities/liquid-handling/v1";

const LAB_REQUEST = {
  title: "HPLC Purity Analysis",
  description: "HPLC analysis and characterization of compound X. Need purity assay.",
  budget: 500,
  currency: "USDC",
  deadline: "2026-12-15T23:59:59Z",
  urgency: "standard",
  requesterEmail: "lab@example.com",
};

beforeAll(() => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  initJobOffersStore({});
});

afterAll(() => {
  closeStore();
  _resetJobOffersStoreForTests();
});

let captured: AnalyticsEvent[] = [];

beforeEach(() => {
  delete process.env.PCC_UNMET_CAPTURE_ENABLED;
  resetEventBus();
  resetCsdRegistry();
  resetRequestsStore();
  _clearIntentIngestCacheForTesting();
  captured = [];
  getEventBus().onEvent((ev) => {
    if (ev.eventType.startsWith("intent.")) captured.push(ev);
  });
});

afterEach(() => {
  delete process.env.PCC_UNMET_CAPTURE_ENABLED;
  resetEventBus();
  resetCsdRegistry();
});

async function app(operatorId: string | null, plugin: (a: FastifyInstance) => Promise<void>): Promise<FastifyInstance> {
  const a = Fastify({ logger: false });
  a.decorateRequest("operatorId", null);
  a.decorateRequest("userId", null);
  a.decorateRequest("apiKeyId", null);
  if (operatorId !== null) {
    a.addHook("onRequest", async (req) => {
      (req as unknown as { operatorId: string }).operatorId = operatorId;
    });
  }
  await a.register(plugin);
  await a.ready();
  return a;
}

async function postRequest(operatorId: string | null, body: Record<string, unknown> = LAB_REQUEST): Promise<AnalyticsEvent> {
  const a = await app(operatorId, requestRoutes);
  try {
    const before = captured.length;
    const res = await a.inject({ method: "POST", url: "/api/requests", payload: body });
    expect(res.statusCode).toBe(201);
    const mine = captured.slice(before).filter((e) => e.eventType === "intent.composite_request");
    expect(mine).toHaveLength(1);
    return mine[0]!;
  } finally {
    await a.close();
  }
}

/** Does the store hold at least one available, online instance of this type? */
async function hasLiveSupply(type: string): Promise<boolean> {
  const res = await getCapabilityFacade().listByType(type);
  return res.success && res.data.some((c) => c.available && (c.kernelStatus === undefined || c.kernelStatus === "online"));
}

function registerLiquidHandlingCsd(): void {
  const catalog = JSON.parse(readFileSync(new URL("../../../../scripts/seed-csd-catalog.json", import.meta.url), "utf8")) as CSD[];
  const csd = catalog.find((c) => c.url === LH_URI);
  if (!csd) throw new Error("liquid-handling CSD missing from scripts/seed-csd-catalog.json");
  getCsdRegistry().register(csd);
}

describe("capture point A (POST /api/requests)", () => {
  it("flag OFF: emits the legacy body actor and no server-only fields", async () => {
    const ev = await postRequest("op-a");
    expect(ev.actorId).toBe("lab@example.com");
    expect(ev.actorType).toBe("requestor");
    expect(ev.payload).not.toHaveProperty("fulfillmentPath");
    expect(ev.payload).not.toHaveProperty("unmet");
  });

  it("flag ON: records the authenticated principal and unmet types that match live supply", async () => {
    process.env.PCC_UNMET_CAPTURE_ENABLED = "true";
    const ev = await postRequest("op-a");
    expect(ev.actorId).toBe("op-a");
    expect(ev.actorType).toBe("authenticated_operator");
    const p = ev.payload as { capabilityTypes: string[]; fulfillmentPath?: string; unmet?: Array<{ capabilityType: string; reason: string }> };
    const unmetTypes = new Set((p.unmet ?? []).map((u) => u.capabilityType));
    for (const t of new Set(p.capabilityTypes)) {
      // Served iff live supply exists, checked against the same store.
      expect(unmetTypes.has(t)).toBe(!(await hasLiveSupply(t)));
    }
    expect(p.fulfillmentPath).toBe(unmetTypes.size > 0 ? "unfulfilled" : "auto");
  });

  it("flag ON without authentication falls back to the legacy actor and still computes unmet", async () => {
    process.env.PCC_UNMET_CAPTURE_ENABLED = "true";
    const ev = await postRequest(null);
    expect(ev.actorId).toBe("lab@example.com");
    expect(ev.actorType).toBe("requestor");
    expect(ev.payload).toHaveProperty("fulfillmentPath");
  });

  it("ignores identity and actor fields smuggled into the body", async () => {
    process.env.PCC_UNMET_CAPTURE_ENABLED = "true";
    const forged = { ...LAB_REQUEST, operatorId: "forged-op", actorId: "forged-op", actorType: "authenticated_operator" };
    const unauthed = await postRequest(null, forged);
    expect(unauthed.actorId).not.toBe("forged-op");
    expect(unauthed.actorType).toBe("requestor");
    const authed = await postRequest("op-real", forged);
    expect(authed.actorId).toBe("op-real");
  });

  it("keys a type whose CSD is registered by its URI", async () => {
    process.env.PCC_UNMET_CAPTURE_ENABLED = "true";
    registerLiquidHandlingCsd();
    const ev = await postRequest("op-a");
    const unmet = (ev.payload as { unmet?: Array<{ capabilityType: string; reason: string }> }).unmet ?? [];
    // Premise, asserted rather than assumed: the seed has no live liquid-handling supply.
    expect(await hasLiveSupply("liquid-handling")).toBe(false);
    expect(unmet).toContainEqual({ capabilityType: LH_URI, reason: "no_kernel_offering", supplyCount: 0 });
    expect(unmet.some((u) => u.capabilityType === "liquid-handling")).toBe(false);
  });
});

describe("POST /api/intents/ingest drops caller-asserted server-only fields", () => {
  for (const flag of [undefined, "true"]) {
    it(`strips fulfillmentPath and unmet (flag ${flag ?? "OFF"})`, async () => {
      if (flag) process.env.PCC_UNMET_CAPTURE_ENABLED = flag;
      const a = await app("op-ingest", intentIngestRoutes);
      try {
        const res = await a.inject({
          method: "POST",
          url: "/api/intents/ingest",
          payload: {
            id: "intent-forged-1",
            source: "sdk",
            compositionSignature: computeCompositionSignature(["synthetic-widget"], []),
            capabilityTypes: ["synthetic-widget"],
            summary: "forged unmet demand",
            budgetBand: "100_1k",
            urgencyBand: "standard",
            createdAt: new Date().toISOString(),
            fulfillmentPath: "unfulfilled",
            unmet: [{ capabilityType: "pcc://capabilities/synthetic-widget/v1", reason: "no_kernel_offering", supplyCount: 0 }],
          },
        });
        expect(res.statusCode).toBe(202);
        const ev = captured.find((e) => e.eventType === "intent.external_ingest");
        expect(ev).toBeDefined();
        expect(ev!.payload).not.toHaveProperty("fulfillmentPath");
        expect(ev!.payload).not.toHaveProperty("unmet");
        expect(ev!.payload).toMatchObject({ id: "intent-forged-1", source: "sdk" });
      } finally {
        await a.close();
      }
    });
  }
});

describe("seam: route capture -> UnmetDemandLens -> public projection", () => {
  async function lensFromCaptured() {
    const lensStore = createStore({ dbPath: ":memory:", seed: false });
    for (const ev of captured) {
      lensStore.repos.analytics.insertEvent({
        id: ev.id,
        eventType: ev.eventType,
        category: ev.category,
        timestamp: ev.timestamp,
        actorId: ev.actorId,
        actorType: ev.actorType,
        resourceType: ev.resourceType,
        resourceId: ev.resourceId,
        payload: ev.payload,
        hash: ev.hash,
        previousHash: ev.previousHash ?? null,
      } as Parameters<typeof lensStore.repos.analytics.insertEvent>[0]);
    }
    const now = Date.now();
    return new UnmetDemandLens(lensStore.repos).compute({
      from: new Date(now - 35 * 86_400_000).toISOString(),
      to: new Date(now + 86_400_000).toISOString(),
    });
  }

  it("counts distinct authenticated operators and publishes the type only at k = 5", async () => {
    process.env.PCC_UNMET_CAPTURE_ENABLED = "true";
    registerLiquidHandlingCsd();
    // Premise, asserted rather than assumed: the seed has no live liquid-handling supply.
    expect(await hasLiveSupply("liquid-handling")).toBe(false);

    for (const op of ["op-1", "op-2", "op-3", "op-4"]) await postRequest(op);
    let lh = (await lensFromCaptured()).signals.find((s) => s.capabilityKey === LH_URI);
    expect(lh?.internal?.distinctVerifiedRequesters).toBe(4);
    expect(lh?.internal?.distinctVerifiedRequestersAtOrAbove.authenticated_order).toBe(4);
    expect(toPublicOpportunityAggregate(lh!)).toBeNull();

    await postRequest("op-5");
    await postRequest("op-5"); // the same operator again adds volume, not breadth
    lh = (await lensFromCaptured()).signals.find((s) => s.capabilityKey === LH_URI);
    expect(lh?.internal?.unmetCount).toBe(6);
    expect(lh?.internal?.distinctVerifiedRequesters).toBe(5);
    expect(toPublicOpportunityAggregate(lh!)).toMatchObject({
      capabilityType: LH_URI,
      demandBand: "5-9",
      countedEvidence: "authenticated_order",
    });
  });

  it("flag OFF records no unmet demand at all, so the lens yields nothing", async () => {
    registerLiquidHandlingCsd();
    for (let i = 0; i < 6; i++) await postRequest(`op-${i}`, { ...LAB_REQUEST, requesterEmail: `buyer-${i}@example.com` });
    const { signals } = await lensFromCaptured();
    // Flag OFF: no unmet is recorded at all, so the lens yields no signals.
    expect(signals).toEqual([]);
  });

  it("never publishes types without a CSD (proposed keys), whatever their breadth", async () => {
    process.env.PCC_UNMET_CAPTURE_ENABLED = "true";
    for (const op of ["op-1", "op-2", "op-3", "op-4", "op-5", "op-6"]) await postRequest(op);
    const { signals } = await lensFromCaptured();
    const proposed = signals.filter((s) => s.capabilityKey.startsWith("proposed:"));
    expect(proposed.length).toBeGreaterThan(0);
    for (const s of proposed) {
      expect(s.internal?.distinctVerifiedRequesters).toBe(6);
      expect(toPublicOpportunityAggregate(s)).toBeNull();
    }
  });
});
