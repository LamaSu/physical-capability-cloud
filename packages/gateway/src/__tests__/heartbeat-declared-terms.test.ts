/**
 * Board N23, the data-layer half (steward #3538): a heartbeat registers only the terms a kernel DECLARED.
 *
 * The heartbeat used to complete a capability announced without terms with tiers [0, 1] and "USDC 0".
 * Every reader then took the default as the provider's own offer: the catalog showed a price nobody
 * set, and the plan re-read (R10, #355) would sell tier 1 on a kernel that never offered it. These
 * tests drive the real routes and the real facade over a real (in-memory) store, including the exact
 * announcement pcc-node's daemon sends today ({type, deviceId, protocol}: no tiers, no pricing).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { kernelRoutes } from "../routes/kernels.js";
import { capabilityRoutes } from "../routes/capabilities.js";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { declaredPricing, declaredTiers } from "../facades/kernel.facade.js";

vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: { emit: vi.fn() },
}));

const PRICING = { currency: "USDC", baseCost: "12.50", minimum: "10" };

describe("a heartbeat registers only declared terms (N23)", () => {
  let app: FastifyInstance;
  const kernelId = "kernel-n23";

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    app = Fastify({ logger: false });
    await app.register(kernelRoutes);
    await app.register(capabilityRoutes);
    await app.register(operatorRelayRoutes);
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: { id: kernelId, name: "N23 kernel", operatorAddress: "0x" + "b".repeat(40), location: { lat: 1, lng: 2 } },
    });
    expect(res.statusCode).toBe(201);
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  const beat = (capabilities: unknown[]) =>
    app.inject({ method: "POST", url: `/api/kernels/${kernelId}/heartbeat`, payload: { status: "online", capabilities } });
  const operatorBeat = (capabilities: unknown[]) =>
    app.inject({ method: "POST", url: "/api/operator/heartbeat", payload: { kernelId, status: "online", capabilities } });
  const row = (type: string) => getRepos().capabilities.findById(`cap-${kernelId}-${type}`) as
    | { assuranceTiers: number[]; pricing: Record<string, string> }
    | undefined;
  const listed = async (type: string) => {
    const res = await app.inject({ method: "GET", url: "/api/capabilities" });
    return (res.json().items as Array<{ id: string }>).some((c) => c.id === `cap-${kernelId}-${type}`);
  };
  const anyRowOffers = (tier: number) =>
    (getRepos().capabilities.findByKernel(kernelId) as Array<{ assuranceTiers: number[] }>).some((c) => c.assuranceTiers.includes(tier));

  it("no declared tiers: no row, so nothing can sell tier 1 (the default used to be [0, 1])", async () => {
    const res = await beat([{ type: "doc-print", pricing: PRICING }]);
    expect(res.statusCode).toBe(200);
    expect(res.json().capabilitiesSkipped).toEqual([{ type: "doc-print", reason: "no-declared-tiers" }]);
    expect(res.json().capabilitiesReceived).toBe(1);
    expect(row("doc-print")).toBeUndefined();
    expect(await listed("doc-print")).toBe(false);
    expect(anyRowOffers(1)).toBe(false);
  });

  it("no declared pricing: no row (the default used to be USDC 0)", async () => {
    const res = await beat([{ type: "cnc-mill", assuranceTiers: [0, 1] }]);
    expect(res.json().capabilitiesSkipped).toEqual([{ type: "cnc-mill", reason: "no-declared-pricing" }]);
    expect(row("cnc-mill")).toBeUndefined();
    expect(await listed("cnc-mill")).toBe(false);
  });

  it("a declared zero price is skipped: USDC 0 is not a price", async () => {
    const res = await beat([{ type: "laser", assuranceTiers: [0], pricing: { currency: "USDC", baseCost: "0", minimum: "0.00" } }]);
    expect(res.json().capabilitiesSkipped).toEqual([{ type: "laser", reason: "zero-price" }]);
    expect(row("laser")).toBeUndefined();
  });

  it("declared terms are registered exactly: tiers as a sorted set, pricing as declared", async () => {
    const pricing = { currency: "USDC", baseCost: "0", minimum: "0", perMinute: "0.25" };
    const res = await beat([{ type: "fdm", assuranceTiers: [2, 0, 2], pricing }]);
    expect(res.json().capabilitiesSkipped).toEqual([]);
    expect(row("fdm")?.assuranceTiers).toEqual([0, 2]);
    expect(row("fdm")?.pricing).toEqual(pricing);
    expect(await listed("fdm")).toBe(true);
  });

  it("an existing row is only refreshed: a later heartbeat never rewrites its terms", async () => {
    const res = await beat([{ type: "fdm", assuranceTiers: [1, 3], pricing: { currency: "USDC", baseCost: "1", minimum: "1" } }]);
    expect(res.json().capabilitiesSkipped).toEqual([]);
    expect(row("fdm")?.assuranceTiers).toEqual([0, 2]);
    expect(row("fdm")?.pricing).toEqual({ currency: "USDC", baseCost: "0", minimum: "0", perMinute: "0.25" });
  });

  it("the operator heartbeat, which pcc-node's daemon calls with {type, deviceId, protocol}, applies the same rule", async () => {
    const daemon = await operatorBeat([{ type: "visual-inspection", deviceId: "cam-1", protocol: "camera" }]);
    expect(daemon.statusCode).toBe(200);
    expect(daemon.json().capabilitiesSkipped).toEqual([{ type: "visual-inspection", reason: "no-declared-tiers" }]);
    expect(row("visual-inspection")).toBeUndefined();

    const declared = await operatorBeat([{ type: "visual-inspection", assuranceTiers: [0], pricing: PRICING }]);
    expect(declared.json().capabilitiesSkipped).toEqual([]);
    expect(row("visual-inspection")?.assuranceTiers).toEqual([0]);
  });

  it("a mixed announcement registers only the declared capability", async () => {
    const res = await beat([
      { type: "mixed-ok", assuranceTiers: [1], pricing: PRICING },
      { type: "mixed-bad", assuranceTiers: [1] },
    ]);
    expect(res.json().capabilitiesSkipped).toEqual([{ type: "mixed-bad", reason: "no-declared-pricing" }]);
    expect(res.json().capabilitiesReceived).toBe(2);
    expect(row("mixed-ok")?.assuranceTiers).toEqual([1]);
    expect(row("mixed-bad")).toBeUndefined();
  });

  // 437-M1 (astra review, Q1 MEDIUM): `cap.type` was read via a bare type
  // assertion, outside any per-entry try/catch. A `null` entry threw at
  // that read, escaping the whole loop and aborting every later entry —
  // including ones with perfectly valid declared terms.
  it("null_announcement_does_not_abort_later_valid_entries", async () => {
    const res = await beat([null as unknown as Record<string, unknown>, { type: "after-null", assuranceTiers: [1], pricing: PRICING }]);
    expect(res.statusCode).toBe(200);
    expect(res.json().capabilitiesReceived).toBe(2);
    expect(res.json().capabilitiesSkipped).toEqual([{ type: "unknown", reason: "invalid-entry" }]);
    expect(row("after-null")?.assuranceTiers).toEqual([1]);
    expect(await listed("after-null")).toBe(true);
  });

  // 437-M1 continued: the same bare assertion let a non-string `type`
  // (or `capability_type`) reach id interpolation and insertion uncoerced.
  it("a non-string type is skipped and reported, never interpolated into an id", async () => {
    const res = await beat([{ type: 12345, assuranceTiers: [1], pricing: PRICING }]);
    expect(res.json().capabilitiesSkipped).toEqual([{ type: "unknown", reason: "invalid-entry" }]);
    expect(row("12345")).toBeUndefined();
  });

  // 437-M2 (astra review, Q1 MEDIUM): an insertion exception was swallowed by
  // the outer non-fatal catch with no skip reason, so the response
  // acknowledged a capability that was never persisted.
  it("failed_insert_is_reported_as_unregistered", async () => {
    const insertSpy = vi.spyOn(getRepos().capabilities, "insert").mockImplementationOnce(() => {
      throw new Error("simulated storage failure");
    });
    try {
      const res = await beat([{ type: "storage-fail", assuranceTiers: [0], pricing: PRICING }]);
      expect(res.json().capabilitiesSkipped).toEqual([{ type: "storage-fail", reason: "storage-failed" }]);
      expect(row("storage-fail")).toBeUndefined();
      expect(await listed("storage-fail")).toBe(false);
    } finally {
      insertSpy.mockRestore();
    }
  });

  // 437-M3 (astra review, Q1 MEDIUM): "00.10" registered successfully here
  // but R10 (packages/gateway/src/services/plan-snapshot-revalidation.ts on
  // the stacked branch, not on this one) rejects it at acceptance time as a
  // non-canonical spelling — an availability/interop defect, never a claim
  // of incorrect payment. Never rewrite the declared string; skip + report.
  it("heartbeat_rejects_noncanonical_leading_zero_price", async () => {
    const res = await beat([{ type: "leading-zero", assuranceTiers: [0], pricing: { currency: "USDC", baseCost: "00.10", minimum: "0" } }]);
    expect(res.json().capabilitiesSkipped).toEqual([{ type: "leading-zero", reason: "invalid-pricing" }]);
    expect(row("leading-zero")).toBeUndefined();
    expect(await listed("leading-zero")).toBe(false);
  });

  // Canonical-form control: R10's grammar accepts these exact spellings, so
  // the heartbeat must too, or a declared price could never sell.
  it("canonical decimal spellings (no leading zeros, trailing fractional zeros OK) register", async () => {
    const res = await beat([{ type: "canonical-price", assuranceTiers: [0], pricing: { currency: "USDC", baseCost: "6.50", minimum: "7" } }]);
    expect(res.json().capabilitiesSkipped).toEqual([]);
    expect(row("canonical-price")?.pricing).toEqual({ currency: "USDC", baseCost: "6.50", minimum: "7" });
  });
});

describe("declaredTiers and declaredPricing", () => {
  it("tiers: integers 0..3, non-empty, at most 16 entries; kept as a sorted set", () => {
    expect(declaredTiers(undefined)).toEqual({ ok: false, reason: "no-declared-tiers" });
    expect(declaredTiers(null)).toEqual({ ok: false, reason: "no-declared-tiers" });
    for (const bad of [[], [4], [-1], [1.5], ["1"], [Number.NaN], [null], "0,1", { 0: 0 }, new Array(17).fill(0)]) {
      expect(declaredTiers(bad)).toEqual({ ok: false, reason: "invalid-tiers" });
    }
    expect(declaredTiers([3, 0, 3, 1])).toEqual({ ok: true, tiers: [0, 1, 3] });
    expect(declaredTiers(new Array(16).fill(2))).toEqual({ ok: true, tiers: [2] });
  });

  it("pricing: a currency, baseCost and minimum as plain decimal strings, at least one component non-zero", () => {
    expect(declaredPricing(undefined)).toEqual({ ok: false, reason: "no-declared-pricing" });
    expect(declaredPricing(null)).toEqual({ ok: false, reason: "no-declared-pricing" });
    for (const bad of [
      "USDC 5",
      [],
      { baseCost: "5", minimum: "5" },
      { currency: "", baseCost: "5", minimum: "5" },
      { currency: "US DC", baseCost: "5", minimum: "5" },
      { currency: "USDC", baseCost: "5" },
      { currency: "USDC", minimum: "5" },
      { currency: "USDC", baseCost: 5, minimum: "5" },
      { currency: "USDC", baseCost: "-5", minimum: "5" },
      { currency: "USDC", baseCost: "1e3", minimum: "5" },
      { currency: "USDC", baseCost: "5.", minimum: "5" },
      { currency: "USDC", baseCost: "5", minimum: "5", perGram: "abc" },
      // 437-M3: non-canonical leading-zero spellings — R10 rejects these.
      { currency: "USDC", baseCost: "00.10", minimum: "0" },
      { currency: "USDC", baseCost: "01", minimum: "0" },
    ]) {
      expect(declaredPricing(bad)).toEqual({ ok: false, reason: "invalid-pricing" });
    }
    expect(declaredPricing({ currency: "USDC", baseCost: "0", minimum: "0.000", perMinute: "0" })).toEqual({ ok: false, reason: "zero-price" });
    // Only the known components are kept; anything else is not a term this column stores.
    expect(declaredPricing({ currency: "USDC", baseCost: "0", minimum: "0", perMinute: "0.25", note: "x" })).toEqual({
      ok: true,
      pricing: { currency: "USDC", baseCost: "0", minimum: "0", perMinute: "0.25" },
    });
    // 437-M3: R10's canonical grammar accepts a bare "0" integer part, and
    // trailing fractional zeros — these must keep registering.
    expect(declaredPricing({ currency: "USDC", baseCost: "0.10", minimum: "7" })).toEqual({
      ok: true,
      pricing: { currency: "USDC", baseCost: "0.10", minimum: "7" },
    });
  });
});
