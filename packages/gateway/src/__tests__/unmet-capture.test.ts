/**
 * R44 D2 — unmet-capture helpers (pure). Route-level and seam tests live in
 * unmet-capture-routes.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import { UnmetCapabilitySchema, type DemandEnvelope } from "@pcc/spec";
import {
  KEY_ACTOR_TYPE,
  MAX_MATCH_TYPES,
  VERIFIED_ACTOR_TYPE,
  authenticatedPrincipal,
  cachedSupplyReads,
  captureUnmetThenEmit,
  capturePrincipal,
  computeUnmet,
  intentActor,
  isUnmetCaptureEnabled,
  principalFromA2AAuth,
  principalFromApiKey,
  provenPrincipal,
  withUnmet,
  type SupplyCapability,
  type SupplyReads,
} from "../services/unmet-capture.js";

const ON = { PCC_UNMET_CAPTURE_ENABLED: "true" } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;
const URI = "pcc://capabilities/synthetic-widget/v1";

function reads(supply: Record<string, SupplyCapability[]>, csds: Record<string, string> = {}): SupplyReads {
  return {
    findUrlByType: (t) => csds[t.toLowerCase()],
    listByType: async (t) => supply[t] ?? [],
  };
}

const live = (tiers: number[] = [0, 1]): SupplyCapability => ({ available: true, kernelStatus: "online", assuranceTiers: tiers as never });
const offline = (): SupplyCapability => ({ available: true, kernelStatus: "offline", assuranceTiers: [0, 1] as never });
const busy = (): SupplyCapability => ({ available: false, kernelStatus: "online", assuranceTiers: [0, 1] as never });

describe("isUnmetCaptureEnabled", () => {
  it("defaults OFF and only the exact string 'true' turns it on", () => {
    expect(isUnmetCaptureEnabled(OFF)).toBe(false);
    expect(isUnmetCaptureEnabled({ PCC_UNMET_CAPTURE_ENABLED: "1" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isUnmetCaptureEnabled({ PCC_UNMET_CAPTURE_ENABLED: "TRUE" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isUnmetCaptureEnabled(ON)).toBe(true);
  });
});

describe("principals (server-side auth context only, two strengths)", () => {
  it("principalFromApiKey accepts only a non-empty string operatorId", () => {
    expect(principalFromApiKey({ operatorId: "op-1" })).toBe("op-1");
    expect(principalFromApiKey({ operatorId: "" })).toBeNull();
    expect(principalFromApiKey({ operatorId: 42 })).toBeNull();
    expect(principalFromApiKey(null)).toBeNull();
    expect(principalFromApiKey(undefined)).toBeNull();
  });

  it("reads req.operatorId and req.provenWallet, never the body", () => {
    const req = {
      operatorId: "op-auth",
      provenWallet: "0xABCDEF",
      body: { operatorId: "forged", provenWallet: "0xforged" },
    } as unknown as FastifyRequest;
    expect(authenticatedPrincipal(req)).toBe("op-auth");
    expect(provenPrincipal(req)).toBe("0xabcdef");
    expect(capturePrincipal(req)).toEqual({ proven: "0xabcdef", key: "op-auth" });
    const bodyOnly = { body: { operatorId: "forged", provenWallet: "0xforged" } } as unknown as FastifyRequest;
    expect(capturePrincipal(bodyOnly)).toEqual({ proven: null, key: null });
  });

  it("maps the A2A route's own resolution: a key is a key holder, a SIWE session is proven", () => {
    expect(principalFromA2AAuth({ operatorId: "op-key" }, null)).toEqual({ proven: null, key: "op-key" });
    expect(principalFromA2AAuth(null, { address: "0xAbC" })).toEqual({ proven: "0xabc", key: null });
    expect(principalFromA2AAuth(null, null)).toEqual({ proven: null, key: null });
  });
});

describe("intentActor", () => {
  const legacy = { actorId: "legacy@example.com", actorType: "requestor" as const };

  it("keeps the legacy actor when the flag is OFF, whatever principal exists", () => {
    expect(intentActor({ proven: "0xa", key: "op-1" }, legacy, OFF)).toEqual(legacy);
  });

  it("labels a proven identity authenticated_operator (verified)", () => {
    expect(intentActor({ proven: "0xa", key: "op-1" }, legacy, ON)).toEqual({ actorId: "0xa", actorType: VERIFIED_ACTOR_TYPE });
    expect(VERIFIED_ACTOR_TYPE).toBe("authenticated_operator");
  });

  it("labels a plain key holder authenticated_key (volume, never verified)", () => {
    expect(intentActor({ proven: null, key: "op-1" }, legacy, ON)).toEqual({ actorId: "op-1", actorType: KEY_ACTOR_TYPE });
    expect(KEY_ACTOR_TYPE).toBe("authenticated_key");
  });

  it("falls back to the legacy actor when ON but unauthenticated", () => {
    expect(intentActor({ proven: null, key: null }, legacy, ON)).toEqual(legacy);
  });
});

describe("computeUnmet", () => {
  it("returns no unmet types when every type is served", async () => {
    expect(await computeUnmet(["synthetic-widget"], { reads: reads({ "synthetic-widget": [live()] }, { "synthetic-widget": URI }) })).toEqual({ unmet: [], truncated: false, unkeyed: 0 });
  });

  it("treats a type with live instances as served even when no CSD is registered", async () => {
    expect((await computeUnmet(["uncatalogued"], { reads: reads({ uncatalogued: [live()] }) }))?.unmet).toEqual([]);
  });

  it("reports no_capability_type with a kebab slug when there is no CSD and no instance", async () => {
    expect((await computeUnmet(["  3D Printing!  "], { reads: reads({}) }))?.unmet).toEqual([
      { capabilityType: "3d-printing", reason: "no_capability_type", supplyCount: 0 },
    ]);
  });

  it("reports no_kernel_offering keyed by the CSD URI when a CSD exists but no instance does", async () => {
    expect((await computeUnmet(["synthetic-widget"], { reads: reads({}, { "synthetic-widget": URI }) }))?.unmet).toEqual([
      { capabilityType: URI, reason: "no_kernel_offering", supplyCount: 0 },
    ]);
  });

  it("reports no_capacity when every instance is offline or unavailable", async () => {
    const r = reads({ "synthetic-widget": [offline(), busy()] }, { "synthetic-widget": URI });
    expect((await computeUnmet(["synthetic-widget"], { reads: r }))?.unmet).toEqual([
      { capabilityType: URI, reason: "no_capacity", supplyCount: 2 },
    ]);
  });

  it("reports tier_too_high when no live instance supports the requested tier", async () => {
    const r = reads({ "synthetic-widget": [live([0, 1]), live([1])] }, { "synthetic-widget": URI });
    expect((await computeUnmet(["synthetic-widget"], { reads: r, assuranceTier: 3 }))?.unmet).toEqual([
      { capabilityType: URI, reason: "tier_too_high", supplyCount: 2 },
    ]);
    expect((await computeUnmet(["synthetic-widget"], { reads: r, assuranceTier: 1 }))?.unmet).toEqual([]);
  });

  it("counts a type once however it is cased or repeated, and skips blanks", async () => {
    const out = await computeUnmet(["Gizmo", "gizmo", " ", "GIZMO"], { reads: reads({}) });
    expect(out).toEqual({ unmet: [{ capabilityType: "gizmo", reason: "no_capability_type", supplyCount: 0 }], truncated: false, unkeyed: 0 });
  });

  describe("keys must match their reason (PX-13 round-1 F3)", () => {
    it("counts, but does not list, no_capacity or tier_too_high for a type with no CSD", async () => {
      expect(await computeUnmet(["uncatalogued"], { reads: reads({ uncatalogued: [offline()] }) })).toEqual({ unmet: [], truncated: false, unkeyed: 1 });
      expect(await computeUnmet(["uncatalogued"], { reads: reads({ uncatalogued: [live([0])] }), assuranceTier: 3 })).toEqual({ unmet: [], truncated: false, unkeyed: 1 });
    });

    it("counts, but does not list, a registered URL that is not a canonical CSD URI", async () => {
      const r = reads({}, { odd: "https://example.invalid/csd/odd", upper: "pcc://capabilities/Upper/v1" });
      expect(await computeUnmet(["odd", "upper"], { reads: r })).toEqual({ unmet: [], truncated: false, unkeyed: 2 });
    });

    it("counts, but does not list, a name that does not slugify or slugifies past 100 characters", async () => {
      expect(await computeUnmet(["!!!", "a".repeat(150)], { reads: reads({}) })).toEqual({ unmet: [], truncated: false, unkeyed: 2 });
    });

    it("never lists a CSD-shaped key for a type with no CSD: an unregistered URI-like name becomes a slug", async () => {
      const out = await computeUnmet(["pcc://capabilities/proposed-secret-us-ca-sf-20260910-123456/v1"], { reads: reads({}) });
      expect(out?.unmet).toEqual([
        { capabilityType: "pcc-capabilities-proposed-secret-us-ca-sf-20260910-123456-v1", reason: "no_capability_type", supplyCount: 0 },
      ]);
    });

    it("lists only entries that pass UnmetCapabilitySchema", async () => {
      const r = reads(
        { a: [offline()], b: [live([1])], c: [] , d: [] },
        { a: URI, b: "pcc://capabilities/synthetic-b/v1", c: "pcc://capabilities/synthetic-c/v2" },
      );
      const out = await computeUnmet(["a", "b", "c", "d", "e"], { reads: r, assuranceTier: 2 });
      expect(out?.unmet.map((u) => u.reason)).toEqual(["no_capacity", "tier_too_high", "no_kernel_offering", "no_capability_type", "no_capability_type"]);
      for (const u of out!.unmet) expect(UnmetCapabilitySchema.safeParse(u).success).toBe(true);
    });
  });

  it(`matches at most ${MAX_MATCH_TYPES} distinct types and records the truncation`, async () => {
    const calls: string[] = [];
    const r: SupplyReads = { findUrlByType: () => undefined, listByType: async (t) => (calls.push(t), []) };
    const types = Array.from({ length: MAX_MATCH_TYPES + 5 }, (_, i) => `type-${i}`);
    const out = await computeUnmet([...types, "type-0", "TYPE-1"], { reads: r });
    expect(out?.truncated).toBe(true);
    expect(out?.unmet).toHaveLength(MAX_MATCH_TYPES);
    expect(calls).toHaveLength(MAX_MATCH_TYPES);
    expect((await computeUnmet(types.slice(0, MAX_MATCH_TYPES), { reads: r }))?.truncated).toBe(false);
  });

  it("returns null (record nothing) when supply cannot be read", async () => {
    const failing: SupplyReads = { findUrlByType: () => undefined, listByType: async () => { throw new Error("db down"); } };
    expect(await computeUnmet(["synthetic-widget"], { reads: failing })).toBeNull();
  });
});

describe("cachedSupplyReads", () => {
  it("serves repeats from cache within the TTL and re-reads after it", async () => {
    let t = 1_000;
    const inner = { findUrlByType: vi.fn(() => URI), listByType: vi.fn(async () => [live()]) };
    const r = cachedSupplyReads(inner, { ttlMs: 30_000, now: () => t });
    await r.listByType("synthetic-widget");
    await r.listByType("synthetic-widget");
    expect(inner.listByType).toHaveBeenCalledTimes(1);
    t += 29_999;
    await r.listByType("synthetic-widget");
    expect(inner.listByType).toHaveBeenCalledTimes(1);
    t += 2;
    await r.listByType("synthetic-widget");
    expect(inner.listByType).toHaveBeenCalledTimes(2);
    expect(r.findUrlByType("synthetic-widget")).toBe(URI);
  });

  it("bounds the number of cached types", async () => {
    const inner = { findUrlByType: () => undefined, listByType: vi.fn(async () => []) };
    const r = cachedSupplyReads(inner, { maxEntries: 2, now: () => 0 });
    await r.listByType("a");
    await r.listByType("b");
    await r.listByType("c"); // evicts "a"
    await r.listByType("b");
    await r.listByType("a");
    expect(inner.listByType).toHaveBeenCalledTimes(4);
  });
});

describe("withUnmet", () => {
  const env = { id: "intent-1", capabilityTypes: ["x"] } as unknown as DemandEnvelope;
  const unmet = [{ capabilityType: URI, reason: "no_kernel_offering" as const, supplyCount: 0 }];

  it("leaves the envelope untouched when supply was unknown", () => {
    expect(withUnmet(env, null)).toBe(env);
  });

  it("marks a fully served intent auto, without an unmet list", () => {
    const out = withUnmet(env, { unmet: [], truncated: false, unkeyed: 0 });
    expect(out.fulfillmentPath).toBe("auto");
    expect("unmet" in out).toBe(false);
    expect("unmetTruncated" in out).toBe(false);
  });

  it("marks unfulfilled without a list when every unmet type was unkeyed", () => {
    const out = withUnmet(env, { unmet: [], truncated: false, unkeyed: 2 });
    expect(out.fulfillmentPath).toBe("unfulfilled");
    expect("unmet" in out).toBe(false);
  });

  it("marks unmet types unfulfilled, carries the list, and records truncation", () => {
    const out = withUnmet(env, { unmet, truncated: true, unkeyed: 0 });
    expect(out.fulfillmentPath).toBe("unfulfilled");
    expect(out.unmet).toEqual(unmet);
    expect(out.unmetTruncated).toBe(true);
    expect(env).not.toHaveProperty("fulfillmentPath");
  });
});

describe("captureUnmetThenEmit", () => {
  const env = { id: "intent-1", capabilityTypes: ["synthetic-widget"] } as unknown as DemandEnvelope;

  it("emits the stamped envelope", async () => {
    const emitted: DemandEnvelope[] = [];
    await captureUnmetThenEmit(env, (e) => emitted.push(e), { reads: reads({}, { "synthetic-widget": URI }) });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.fulfillmentPath).toBe("unfulfilled");
  });

  it("emits the envelope unstamped when supply cannot be read", async () => {
    const emitted: DemandEnvelope[] = [];
    const failing: SupplyReads = { findUrlByType: () => undefined, listByType: async () => { throw new Error("db down"); } };
    await captureUnmetThenEmit(env, (e) => emitted.push(e), { reads: failing });
    expect(emitted).toEqual([env]);
  });

  it("never rejects, even if emitting throws", async () => {
    await expect(
      captureUnmetThenEmit(env, () => { throw new Error("bus down"); }, { reads: reads({}) }),
    ).resolves.toBeUndefined();
  });
});
