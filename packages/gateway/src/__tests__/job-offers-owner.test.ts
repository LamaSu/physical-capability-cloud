/**
 * WP-A round 5 (coord-watch #2883): job-offer owner checks fail closed and compare
 * normalized identities.
 *
 * patch / cancel / heartbeat used `if (o.posterDid && o.posterDid !== poster)`. An
 * offer with NO recorded poster was therefore editable by anyone, and a different
 * spelling of the owner (case, surrounding space, compatibility form) was refused.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initJobOffersStore, _resetJobOffersStoreForTests } from "../services/job-offers-store.js";

const base = {
  capabilityType: "opentrons.runProtocol",
  requirements: { protocolFile: "ipfs://Qm...", instrument: "OT-2" },
  pricing: { amount: 50, currency: "USDC", model: "fixed" as const },
};
const newPricing = { amount: 1, currency: "USDC", model: "fixed" as const };

beforeEach(() => _resetJobOffersStoreForTests());
afterEach(() => _resetJobOffersStoreForTests());

async function offer(posterDid: string | null) {
  const store = initJobOffersStore({});
  const res = await store.create({ ...base, posterDid });
  if (!res.ok) throw new Error(`create failed: ${JSON.stringify(res)}`);
  return { store, id: res.offer.id };
}

describe("job-offer owner checks", () => {
  it("[neg] an offer with no recorded poster cannot be patched, cancelled or heartbeated by anyone", async () => {
    const { store, id } = await offer(null);
    expect(store.patch(id, "anyone@x.test", { pricing: newPricing })).toMatchObject({ ok: false, reason: "forbidden" });
    expect(store.heartbeat(id, "anyone@x.test")).toMatchObject({ ok: false, reason: "forbidden" });
    expect(store.cancel(id, "anyone@x.test")).toMatchObject({ ok: false, reason: "forbidden" });
  });

  it("[neg] a different identity is refused", async () => {
    const { store, id } = await offer("alice@x.test");
    expect(store.cancel(id, "mallory@x.test")).toMatchObject({ ok: false, reason: "forbidden" });
  });

  it("the poster is recognized in any normalized spelling (case, space, fullwidth)", async () => {
    const { store, id } = await offer("Alice@X.test");
    expect(store.heartbeat(id, " alice@x.test ")).toMatchObject({ ok: true });
    expect(store.patch(id, "ａｌｉｃｅ@x.test", { pricing: newPricing })).toMatchObject({ ok: true });
    expect(store.cancel(id, "ALICE@x.TEST")).toMatchObject({ ok: true });
  });
});
