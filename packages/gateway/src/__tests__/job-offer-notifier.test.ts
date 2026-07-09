/**
 * Tests for the operator-notification trigger (services/job-offer-notifier.ts)
 * and its wiring into JobOffersStore.create() (services/job-offers-store.ts).
 *
 * This is the gap NOTIFICATION-NOTES.md flagged after the B5 email-transport
 * fix landed: dispatchToChannels was real, but nothing called it when a job
 * actually landed. These tests pin the fix:
 *
 *   - JobOffersStore.create() fires an injected notifyOperators hook exactly
 *     once per NEWLY-created offer, never on an idempotent replay, and a
 *     throwing/rejecting hook can never fail the job post (best-effort).
 *     Omitting the hook (all pre-existing callers) stays a no-op.
 *   - createOperatorNotifier() dispatches to every operator its (injectable)
 *     OperatorLookup returns, skips operators with no attached channel, and
 *     degrades gracefully (no throw) when the lookup fails.
 *   - offerToDispatchPayload() shape: priceUSD only for USD, deadlineSec
 *     derived from deadlineIso (falling back to validUntil), contextRef
 *     points at the job-offers detail route.
 *   - defaultOperatorLookup() against a real in-memory DB: exact-match on
 *     capabilities.type, dedup across multiple kernels for one operator, no
 *     match for an unrelated type.
 *   - End-to-end: JobOffersStore.create() -> createOperatorNotifier() ->
 *     dispatchToChannels() -> the (fake) email transport actually receives
 *     a send.
 *
 * DB-backed tests mirror the fixture pattern already used by
 * operator-status.test.ts (initStore({seed:true}) against :memory:, wipe
 * capabilities/shopKernels in beforeEach).
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import {
  JobOffersStore,
  type JobOffer,
  type CreateJobOfferInput,
} from "../services/job-offers-store.js";
import {
  createOperatorNotifier,
  defaultOperatorLookup,
  offerToDispatchPayload,
} from "../services/job-offer-notifier.js";
import {
  attachChannel,
  _clearOperatorChannelsForTests,
} from "../routes/operator-channels.js";
import {
  __setEmailTransportForTests,
  type EmailTransport,
  type EmailMessage,
} from "../services/email-transport.js";
import { initStore, closeStore, getStore } from "../db.js";
import { schema } from "@pcc/store";

const { shopKernels, capabilities } = schema;

// ── Helpers ──────────────────────────────────────────────────────────────

/** A fake transport that records what it was asked to send and returns a canned id. */
function fakeTransport(id = "fake-msg-id-123"): EmailTransport & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    provider: "fake",
    sent,
    async send(msg: EmailMessage) {
      sent.push(msg);
      return { id, provider: "fake" };
    },
  };
}

function makeOffer(overrides: Partial<JobOffer> = {}): JobOffer {
  const now = new Date().toISOString();
  return {
    id: "offer-test-1",
    capabilityType: "courier.dispatch",
    requirements: {},
    requirementsValidated: false,
    serviceAreaGeofence: null,
    pricing: { amount: 6.5, currency: "USD", model: "fixed" },
    deadlineIso: null,
    assuranceTier: null,
    evidenceRequirements: null,
    sourceVerifyUrl: null,
    requireHeartbeat: false,
    posterDid: null,
    posterKernelId: null,
    idempotencyKey: null,
    status: "open",
    postedAt: now,
    validUntil: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    claimedByKernelId: null,
    claimedAt: null,
    claimSignature: null,
    driverEtaMin: null,
    driverContact: null,
    verified: false,
    lastVerifyAt: null,
    lastHeartbeatAt: null,
    deliveredAt: null,
    cancelledAt: null,
    expiredAt: null,
    ...overrides,
  };
}

function baseInput(id: string, overrides: Partial<CreateJobOfferInput> = {}): CreateJobOfferInput {
  return {
    id,
    capabilityType: "courier.dispatch",
    requirements: {
      pickup: { lat: 37.77, lng: -122.42 },
      dropoff: { lat: 37.78, lng: -122.4 },
    },
    pricing: { amount: 6.5, currency: "USD", model: "fixed" },
    ...overrides,
  };
}

// ── JobOffersStore.create() -> notifyOperators wiring ─────────────────────

describe("JobOffersStore — notifyOperators trigger", () => {
  it("invokes notifyOperators exactly once for a newly-created offer", async () => {
    const calls: JobOffer[] = [];
    const store = new JobOffersStore({
      notifyOperators: (offer) => {
        calls.push(offer);
      },
    });
    const res = await store.create(baseInput("offer-a"));
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe("offer-a");
    expect(calls[0]!.capabilityType).toBe("courier.dispatch");
  });

  it("does NOT invoke notifyOperators on an idempotent replay (same id)", async () => {
    const calls: JobOffer[] = [];
    const store = new JobOffersStore({
      notifyOperators: (offer) => {
        calls.push(offer);
      },
    });
    const first = await store.create(baseInput("offer-b"));
    const second = await store.create(baseInput("offer-b"));
    expect(first.ok && first.created).toBe(true);
    expect(second.ok && !second.created).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("does NOT invoke notifyOperators on an idempotent replay (idempotencyKey)", async () => {
    const calls: JobOffer[] = [];
    const store = new JobOffersStore({
      notifyOperators: (offer) => {
        calls.push(offer);
      },
    });
    await store.create(baseInput("offer-c1", { idempotencyKey: "idem-1" }));
    await store.create(baseInput("offer-c2", { idempotencyKey: "idem-1" }));
    expect(calls).toHaveLength(1);
  });

  it("a synchronously-throwing notifyOperators does not fail job-offer creation", async () => {
    const store = new JobOffersStore({
      notifyOperators: () => {
        throw new Error("boom-sync");
      },
    });
    const res = await store.create(baseInput("offer-d"));
    expect(res.ok).toBe(true);
    expect(res.ok && res.created).toBe(true);
    expect(store.get("offer-d")).toBeDefined();
  });

  it("a rejecting (async) notifyOperators does not fail job-offer creation", async () => {
    const store = new JobOffersStore({
      notifyOperators: async () => {
        throw new Error("boom-async");
      },
    });
    const res = await store.create(baseInput("offer-e"));
    expect(res.ok).toBe(true);
    expect(res.ok && res.created).toBe(true);
  });

  it("omitting notifyOperators entirely is a no-op (pre-existing behaviour unchanged)", async () => {
    const store = new JobOffersStore({});
    const res = await store.create(baseInput("offer-f"));
    expect(res.ok).toBe(true);
    expect(res.ok && res.created).toBe(true);
  });
});

// ── offerToDispatchPayload ──────────────────────────────────────────────

describe("offerToDispatchPayload", () => {
  it("includes priceUSD for USD pricing", () => {
    const offer = makeOffer({ pricing: { amount: 12.5, currency: "USD", model: "fixed" } });
    expect(offerToDispatchPayload(offer).priceUSD).toBe(12.5);
  });

  it("omits priceUSD for non-USD pricing", () => {
    const offer = makeOffer({ pricing: { amount: 12.5, currency: "USDC", model: "fixed" } });
    expect(offerToDispatchPayload(offer).priceUSD).toBeUndefined();
  });

  it("computes deadlineSec from deadlineIso when present", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const offer = makeOffer({ deadlineIso: future });
    const payload = offerToDispatchPayload(offer);
    expect(payload.deadlineSec).toBeGreaterThan(0);
    expect(payload.deadlineSec).toBeLessThanOrEqual(60);
  });

  it("falls back to validUntil when deadlineIso is null", () => {
    const future = new Date(Date.now() + 120_000).toISOString();
    const offer = makeOffer({ deadlineIso: null, validUntil: future });
    const payload = offerToDispatchPayload(offer);
    expect(payload.deadlineSec).toBeGreaterThan(0);
    expect(payload.deadlineSec).toBeLessThanOrEqual(120);
  });

  it("summary names the capability type and (for USD) the price", () => {
    const offer = makeOffer({
      capabilityType: "pizza.order",
      pricing: { amount: 21.71, currency: "USD", model: "fixed" },
    });
    expect(offerToDispatchPayload(offer).summary).toBe("New pizza.order job available — $21.71 USD");
  });

  it("summary omits the price segment for non-USD pricing", () => {
    const offer = makeOffer({
      capabilityType: "lab.hplc",
      pricing: { amount: 40, currency: "USDC", model: "per-unit", unit: "sample" },
    });
    expect(offerToDispatchPayload(offer).summary).toBe("New lab.hplc job available");
  });

  it("contextRef points at the job-offers detail endpoint", () => {
    const offer = makeOffer({ id: "offer-xyz" });
    expect(offerToDispatchPayload(offer).contextRef).toBe("/api/job-offers/offer-xyz");
  });

  it("jobId matches the offer id", () => {
    const offer = makeOffer({ id: "offer-jid" });
    expect(offerToDispatchPayload(offer).jobId).toBe("offer-jid");
  });
});

// ── createOperatorNotifier ───────────────────────────────────────────────

describe("createOperatorNotifier", () => {
  beforeEach(() => {
    _clearOperatorChannelsForTests();
    __setEmailTransportForTests(undefined);
  });

  afterEach(() => {
    _clearOperatorChannelsForTests();
    __setEmailTransportForTests(undefined);
  });

  it("dispatches to an operator the lookup returns that has a channel attached", async () => {
    attachChannel("op-a", {
      label: "Owner email",
      transport: "email",
      endpoint: { address: "opA@example.com" },
      describe: "Email me when a courier job lands",
    });
    const fake = fakeTransport();
    __setEmailTransportForTests(fake);

    const notifier = createOperatorNotifier(async () => ["op-a"]);
    const offer = makeOffer({ id: "offer-notify-1" });
    const outcomes = await notifier(offer);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.operatorSlug).toBe("op-a");
    expect(outcomes[0]!.channelResults).toHaveLength(1);
    expect(outcomes[0]!.channelResults[0]!.delivered).toBe(true);
    expect(outcomes[0]!.channelResults[0]!.ref).toBe("fake-msg-id-123");
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.to).toBe("opA@example.com");
    expect(fake.sent[0]!.text).toContain("offer-notify-1");
  });

  it("skips operators the lookup returns that have no channel attached", async () => {
    // no attachChannel call for "op-empty"
    const notifier = createOperatorNotifier(async () => ["op-empty"]);
    const outcomes = await notifier(makeOffer());
    expect(outcomes).toHaveLength(0);
  });

  it("notifies multiple matched operators independently", async () => {
    attachChannel("op-a", {
      label: "A",
      transport: "email",
      endpoint: { address: "a@example.com" },
      describe: "notify a",
    });
    attachChannel("op-b", {
      label: "B",
      transport: "email",
      endpoint: { address: "b@example.com" },
      describe: "notify b",
    });
    const fake = fakeTransport();
    __setEmailTransportForTests(fake);

    const notifier = createOperatorNotifier(async () => ["op-a", "op-b"]);
    const outcomes = await notifier(makeOffer());

    expect(outcomes).toHaveLength(2);
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent.map((m) => m.to).sort()).toEqual(["a@example.com", "b@example.com"]);
  });

  it("returns [] and logs (never throws) when the lookup rejects", async () => {
    const warnings: string[] = [];
    const notifier = createOperatorNotifier(
      async () => {
        throw new Error("db down");
      },
      { warn: (m) => warnings.push(m) },
    );
    const outcomes = await notifier(makeOffer());
    expect(outcomes).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("operator lookup failed");
  });

  it("returns [] with no channel side effects when the lookup finds no operators", async () => {
    const fake = fakeTransport();
    __setEmailTransportForTests(fake);
    const notifier = createOperatorNotifier(async () => []);
    const outcomes = await notifier(makeOffer());
    expect(outcomes).toEqual([]);
    expect(fake.sent).toHaveLength(0);
  });

  it("an operator with no email provider configured gets an honest not-delivered outcome, not a throw", async () => {
    attachChannel("op-noprovider", {
      label: "Owner email",
      transport: "email",
      endpoint: { address: "op@example.com" },
      describe: "notify me",
    });
    __setEmailTransportForTests(null); // simulate "no provider configured"
    const notifier = createOperatorNotifier(async () => ["op-noprovider"]);
    const outcomes = await notifier(makeOffer());
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.channelResults[0]!.delivered).toBe(false);
    expect(outcomes[0]!.channelResults[0]!.error).toBe("email_not_configured");
  });
});

// ── defaultOperatorLookup (real in-memory DB) ────────────────────────────

describe("defaultOperatorLookup (DB-backed)", () => {
  beforeAll(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
  });

  afterAll(() => {
    closeStore();
  });

  beforeEach(() => {
    try {
      const { db } = getStore();
      db.delete(capabilities).run();
      db.delete(shopKernels).run();
    } catch {
      /* no-op */
    }
  });

  function seedKernel(id: string, operatorAddress: string): void {
    const { db } = getStore();
    const now = new Date().toISOString();
    db.insert(shopKernels)
      .values({
        id,
        name: `Kernel ${id}`,
        operatorAddress,
        location: { lat: 0, lng: 0 },
        physicalAddress: "test",
        maxAssuranceTier: 2,
        publicKey: "test-key",
        reputation: 0,
        totalJobsCompleted: 0,
        status: "online",
        registeredAt: now,
        lastHeartbeat: now,
        version: "1.0.0",
      } as any)
      .run();
  }

  function seedCapability(id: string, kernelId: string, type: string): void {
    const { db } = getStore();
    db.insert(capabilities)
      .values({
        id,
        kernelId,
        type,
        name: `${type} cap`,
        description: `${type} capability for testing`,
        materials: [],
        assuranceTiers: [0, 1],
        pricing: { currency: "USDC", baseCost: "10", minimum: "5" },
        location: { lat: 0, lng: 0 },
        queueDepth: 0,
        availability: {},
        sla: null,
      } as any)
      .run();
  }

  it("returns the operatorAddress for a matching capability type", async () => {
    seedKernel("kernel-notif-1", "op-courier-1");
    seedCapability("cap-notif-1", "kernel-notif-1", "courier.dispatch");
    const slugs = await defaultOperatorLookup("courier.dispatch");
    expect(slugs).toEqual(["op-courier-1"]);
  });

  it("returns [] for a capability type nobody offers", async () => {
    const slugs = await defaultOperatorLookup("nonexistent.type");
    expect(slugs).toEqual([]);
  });

  it("dedupes when one operator runs multiple kernels/capabilities of the same type", async () => {
    seedKernel("kernel-notif-2a", "op-multi");
    seedKernel("kernel-notif-2b", "op-multi");
    seedCapability("cap-notif-2a", "kernel-notif-2a", "lab.hplc");
    seedCapability("cap-notif-2b", "kernel-notif-2b", "lab.hplc");
    const slugs = await defaultOperatorLookup("lab.hplc");
    expect(slugs).toEqual(["op-multi"]);
  });

  it("matches exactly, not by prefix (courier.quote does not match courier.dispatch)", async () => {
    seedKernel("kernel-notif-3", "op-narrow");
    seedCapability("cap-notif-3", "kernel-notif-3", "courier.quote");
    const slugs = await defaultOperatorLookup("courier.dispatch");
    expect(slugs).toEqual([]);
  });

  it("returns distinct operators when several operators offer the same type", async () => {
    seedKernel("kernel-notif-4a", "op-4a");
    seedKernel("kernel-notif-4b", "op-4b");
    seedCapability("cap-notif-4a", "kernel-notif-4a", "pizza.order");
    seedCapability("cap-notif-4b", "kernel-notif-4b", "pizza.order");
    const slugs = await defaultOperatorLookup("pizza.order");
    expect(slugs.sort()).toEqual(["op-4a", "op-4b"]);
  });
});

// ── End-to-end: create() -> notifier -> dispatchToChannels -> transport ──

describe("end-to-end: JobOffersStore.create() triggers a real email send", () => {
  beforeEach(() => {
    _clearOperatorChannelsForTests();
    __setEmailTransportForTests(undefined);
  });

  afterEach(() => {
    _clearOperatorChannelsForTests();
    __setEmailTransportForTests(undefined);
  });

  it("posting a new offer notifies the matched operator's email channel", async () => {
    attachChannel("op-e2e", {
      label: "Owner email",
      transport: "email",
      endpoint: { address: "owner@example.com" },
      describe: "Ping me the second a courier job is posted",
    });
    const fake = fakeTransport("resend-like-id-789");
    __setEmailTransportForTests(fake);

    const notifier = createOperatorNotifier(async (capabilityType) =>
      capabilityType === "courier.dispatch" ? ["op-e2e"] : [],
    );
    const store = new JobOffersStore({ notifyOperators: notifier });

    const res = await store.create(
      baseInput("offer-e2e-1", {
        capabilityType: "courier.dispatch",
        pricing: { amount: 9.5, currency: "USD", model: "fixed" },
      }),
    );

    expect(res.ok).toBe(true);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.to).toBe("owner@example.com");
    expect(fake.sent[0]!.subject).toContain("offer-e2e-1");
    expect(fake.sent[0]!.text).toContain("$9.5 USD");
  });

  it("an unmatched capability type sends nothing", async () => {
    attachChannel("op-e2e-2", {
      label: "Owner email",
      transport: "email",
      endpoint: { address: "owner2@example.com" },
      describe: "Only notify for pizza.order",
    });
    const fake = fakeTransport();
    __setEmailTransportForTests(fake);

    const notifier = createOperatorNotifier(async (capabilityType) =>
      capabilityType === "pizza.order" ? ["op-e2e-2"] : [],
    );
    const store = new JobOffersStore({ notifyOperators: notifier });

    await store.create(baseInput("offer-e2e-2", { capabilityType: "courier.dispatch" }));

    expect(fake.sent).toHaveLength(0);
  });
});
