/**
 * R44 D2 — unmet-capture helpers (pure). Route-level and seam tests live in
 * unmet-capture-routes.test.ts.
 */
import { describe, it, expect } from "vitest";
import type { FastifyRequest } from "fastify";
import type { DemandEnvelope } from "@pcc/spec";
import {
  VERIFIED_ACTOR_TYPE,
  authenticatedPrincipal,
  computeUnmet,
  intentActor,
  isUnmetCaptureEnabled,
  principalFromApiKey,
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

describe("principal extraction (server-side auth context only)", () => {
  it("principalFromApiKey accepts only a non-empty string operatorId", () => {
    expect(principalFromApiKey({ operatorId: "op-1" })).toBe("op-1");
    expect(principalFromApiKey({ operatorId: "" })).toBeNull();
    expect(principalFromApiKey({ operatorId: 42 })).toBeNull();
    expect(principalFromApiKey(null)).toBeNull();
    expect(principalFromApiKey(undefined)).toBeNull();
  });

  it("authenticatedPrincipal reads apiGate's req.operatorId and never the body", () => {
    const withAuth = { operatorId: "op-auth", body: { operatorId: "body-forged" } } as unknown as FastifyRequest;
    const bodyOnly = { body: { operatorId: "body-forged", requesterEmail: "x@example.com" } } as unknown as FastifyRequest;
    expect(authenticatedPrincipal(withAuth)).toBe("op-auth");
    expect(authenticatedPrincipal(bodyOnly)).toBeNull();
  });
});

describe("intentActor", () => {
  const legacy = { actorId: "legacy@example.com", actorType: "requestor" as const };

  it("keeps the legacy actor when the flag is OFF, even with a principal", () => {
    expect(intentActor("op-1", legacy, OFF)).toEqual(legacy);
  });

  it("records the principal as authenticated_operator when ON", () => {
    expect(intentActor("op-1", legacy, ON)).toEqual({ actorId: "op-1", actorType: VERIFIED_ACTOR_TYPE });
    expect(VERIFIED_ACTOR_TYPE).toBe("authenticated_operator");
  });

  it("falls back to the legacy actor when ON but unauthenticated", () => {
    expect(intentActor(null, legacy, ON)).toEqual(legacy);
  });
});

describe("computeUnmet", () => {
  it("returns [] when every type is served", async () => {
    expect(await computeUnmet(["synthetic-widget"], { reads: reads({ "synthetic-widget": [live()] }, { "synthetic-widget": URI }) })).toEqual([]);
  });

  it("treats a type with live instances as served even when no CSD is registered", async () => {
    expect(await computeUnmet(["uncatalogued"], { reads: reads({ uncatalogued: [live()] }) })).toEqual([]);
  });

  it("reports no_capability_type with a kebab slug when there is no CSD and no instance", async () => {
    expect(await computeUnmet(["  3D Printing!  "], { reads: reads({}) })).toEqual([
      { capabilityType: "3d-printing", reason: "no_capability_type", supplyCount: 0 },
    ]);
  });

  it("reports no_kernel_offering keyed by the CSD URI when a CSD exists but no instance does", async () => {
    expect(await computeUnmet(["synthetic-widget"], { reads: reads({}, { "synthetic-widget": URI }) })).toEqual([
      { capabilityType: URI, reason: "no_kernel_offering", supplyCount: 0 },
    ]);
  });

  it("reports no_capacity when every instance is offline or unavailable", async () => {
    const r = reads({ "synthetic-widget": [offline(), busy()] }, { "synthetic-widget": URI });
    expect(await computeUnmet(["synthetic-widget"], { reads: r })).toEqual([
      { capabilityType: URI, reason: "no_capacity", supplyCount: 2 },
    ]);
  });

  it("reports tier_too_high when no live instance supports the requested tier", async () => {
    const r = reads({ "synthetic-widget": [live([0, 1]), live([1])] }, { "synthetic-widget": URI });
    expect(await computeUnmet(["synthetic-widget"], { reads: r, assuranceTier: 3 })).toEqual([
      { capabilityType: URI, reason: "tier_too_high", supplyCount: 2 },
    ]);
    expect(await computeUnmet(["synthetic-widget"], { reads: r, assuranceTier: 1 })).toEqual([]);
  });

  it("counts a type once however it is cased or repeated, and skips blanks", async () => {
    const out = await computeUnmet(["Gizmo", "gizmo", " ", "GIZMO"], { reads: reads({}) });
    expect(out).toEqual([{ capabilityType: "gizmo", reason: "no_capability_type", supplyCount: 0 }]);
  });

  it("returns null (record nothing) when supply cannot be read", async () => {
    const failing: SupplyReads = { findUrlByType: () => undefined, listByType: async () => { throw new Error("db down"); } };
    expect(await computeUnmet(["synthetic-widget"], { reads: failing })).toBeNull();
  });
});

describe("withUnmet", () => {
  const env = { id: "intent-1", capabilityTypes: ["x"] } as unknown as DemandEnvelope;

  it("leaves the envelope untouched when supply was unknown", () => {
    expect(withUnmet(env, null)).toBe(env);
  });

  it("marks a fully served intent auto, without an unmet list", () => {
    const out = withUnmet(env, []);
    expect(out.fulfillmentPath).toBe("auto");
    expect("unmet" in out).toBe(false);
  });

  it("marks an intent with unmet types unfulfilled and carries the list", () => {
    const unmet = [{ capabilityType: URI, reason: "no_kernel_offering" as const, supplyCount: 0 }];
    const out = withUnmet(env, unmet);
    expect(out.fulfillmentPath).toBe("unfulfilled");
    expect(out.unmet).toEqual(unmet);
    expect(env).not.toHaveProperty("fulfillmentPath");
  });
});
