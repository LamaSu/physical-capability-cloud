/**
 * Route-level tests for the settlement READ routes (#573), contract v1.4.
 *
 * These are deliberately INTEGRATION-shaped (real Fastify + inject) rather than
 * unit tests over the handlers. Reason, learned the hard way on PR #283: unit
 * coverage of pure logic said 19/19 green while the middleware it belonged to
 * was never mounted and enforced nothing. Assert the wiring, not just the maths.
 *
 * The money-critical assertions here are the NEGATIVE ones — what the routes
 * must never say: no soundness assertion (rule 2), no distinguishable 403
 * (existence oracle), no fabricated provenance root, no DTO at all when the
 * read plane is unbound.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  settlementReadRoutes,
  setSettlementUnitReader,
  UnitNotFoundError,
  SnapshotMismatchError,
  type SettlementUnitReader,
} from "../routes/settlement-read.js";
import { UnitState } from "../settlement/unit-state-mapper.js";

/** The one finalized block every read in a response is pinned to (rule 22/24). */
const SNAP_HASH = "0x" + "cd".repeat(32);

const UNIT = "0x" + "ab".repeat(32);
const OTHER_TENANT = "tenant-b";

function makeReader(over: Partial<SettlementUnitReader> = {}): SettlementUnitReader {
  return {
    binding: () => ({ chainId: 84532, escrow: "0xEsCrOw" }),
    windows: () => ({ challengeWindow: 3600n, appealWindow: 7200n }),
    // v1.5 rule 22/24: ONE pinned FINALIZED snapshot per response, echoed on
    // every DTO so Surface A can assert all three routes agree.
    pinSnapshot: async (asOf?: string) => {
      if (asOf && asOf !== SNAP_HASH) {
        throw new SnapshotMismatchError(`unknown or reorged-out block ${asOf}`);
      }
      return { asOfBlock: 100n, asOfBlockHash: SNAP_HASH, finality: "finalized" as const, logCompleteness: "complete" as const };
    },
    readAnchors: async () => ({ state: UnitState.SETTLED_RELEASED, remainingClaimCount: 0n }),
    readRefundWitness: async () => ({}),
    readZeroingDischargeBlock: async () => 999n,
    readEconomics: async () => ({
      amount: "1000000",
      feeAmount: "23500",
      recipient: "0xRecipient",
      token: "0xUSDC",
      assuranceTier: 1,
    }),
    // rule 25/26: registry-derived, pinned separately, attests IDENTITY not liveness.
    readAssetIdentity: async () => ({ assetReality: "test" as const, registryId: "reg-1", revision: 3 }),
    readProvenance: async () => ({ availability: "AVAILABLE" as const, compositionRoot: "0xroot", revision: 1, leaves: [], nextCursor: null }),
    readOwnerTenant: async () => null,
    ...over,
  };
}

async function buildApp(tenantId: string | null = "tenant-a"): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as unknown as { tenantId: string | null }).tenantId = tenantId;
  });
  await app.register(settlementReadRoutes);
  await app.ready();
  return app;
}

afterEach(() => setSettlementUnitReader(null));

describe("unbound read plane — honest 503, never a fabricated DTO", () => {
  beforeEach(() => setSettlementUnitReader(null));

  it("answers 503 INDEX_NOT_READY with Retry-After, not an empty DTO", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/lifecycle` });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("INDEX_NOT_READY");
    expect(res.headers["retry-after"]).toBe("5");
    // Critically: no finalState/phase keys invented out of nothing.
    expect(res.json().finalState).toBeUndefined();
    await app.close();
  });

  it("applies to all three routes", async () => {
    const app = await buildApp();
    for (const leaf of ["receipt", "lifecycle", "provenance"]) {
      const res = await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/${leaf}` });
      expect(res.statusCode).toBe(503);
    }
    await app.close();
  });
});

describe("unit identity + existence", () => {
  it("rejects a malformed unitId without touching the reader", async () => {
    let touched = false;
    setSettlementUnitReader(makeReader({ readAnchors: async () => { touched = true; throw new Error("should not run"); } }));
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/settlement/units/not-a-unit/lifecycle" });
    expect(res.statusCode).toBe(404);
    expect(touched).toBe(false);
    await app.close();
  });

  it("maps the contract's UnitNotFound REVERT to 404 (F-5: not a state-0 branch)", async () => {
    setSettlementUnitReader(
      makeReader({ readAnchors: async () => { throw new UnitNotFoundError(UNIT); } }),
    );
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/lifecycle` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("UNKNOWN_UNIT");
    // Must NOT render "awaiting funding" for a unit that does not exist.
    expect(JSON.stringify(res.json())).not.toMatch(/awaiting/i);
    await app.close();
  });

  it("fails CLOSED on an unreachable state instead of rendering it", async () => {
    setSettlementUnitReader(
      makeReader({ readAnchors: async () => ({ state: UnitState.AWAITING_FUNDING }) }),
    );
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/lifecycle` });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe("tenant scoping is an INDISTINGUISHABLE 404, never a 403", () => {
  it("returns 404 with the same body as UNKNOWN_UNIT for a foreign tenant", async () => {
    setSettlementUnitReader(makeReader({ readOwnerTenant: async () => OTHER_TENANT }));
    const app = await buildApp("tenant-a");
    const forbidden = await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/lifecycle` });

    setSettlementUnitReader(
      makeReader({ readAnchors: async () => { throw new UnitNotFoundError(UNIT); } }),
    );
    const unknown = await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/lifecycle` });

    // A distinct 403 would confirm the unit EXISTS to someone not entitled to
    // know that — an existence oracle across tenants.
    expect(forbidden.statusCode).toBe(unknown.statusCode);
    expect(forbidden.json()).toEqual(unknown.json());
    await app.close();
  });

  it("permits an unowned unit (no tenant to leak)", async () => {
    setSettlementUnitReader(makeReader({ readOwnerTenant: async () => null }));
    const app = await buildApp("tenant-a");
    const res = await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/lifecycle` });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe("lifecycle DTO", () => {
  it("carries {chainId, escrow} and the terminal-set finalState", async () => {
    setSettlementUnitReader(makeReader());
    const app = await buildApp();
    const b = (await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/lifecycle` })).json();
    expect(b.chainId).toBe(84532);
    expect(b.escrow).toBe("0xEsCrOw");
    expect(b.finalState).toBe("SETTLED_RELEASED");
    expect(b.isTerminal).toBe(true);
    await app.close();
  });

  it("reports ALLOCATED (6) as non-terminal with NULL finalState — rule 12", async () => {
    setSettlementUnitReader(
      makeReader({ readAnchors: async () => ({ state: UnitState.RELEASE_ALLOCATED }) }),
    );
    const app = await buildApp();
    const b = (await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/lifecycle` })).json();
    expect(b.finalState).toBeNull();
    expect(b.isTerminal).toBe(false);
    expect(b.isAllocated).toBe(true);
    expect(b.phase).toBe("allocated");
    await app.close();
  });

  it("serialises windowEndsAt as a string (bigint-safe) and null when absent", async () => {
    setSettlementUnitReader(
      makeReader({ readAnchors: async () => ({ state: UnitState.PRIMARY_ASSERTED, assertedAt: 1000n }) }),
    );
    const app = await buildApp();
    const b = (await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/lifecycle` })).json();
    expect(b.windowEndsAt).toBe("4600");
    await app.close();
  });
});

describe("receipt DTO — rule 2 (asserts nothing sound) and rule 21 (marked sources)", () => {
  it("carries NO settled/verified/paid boolean", async () => {
    setSettlementUnitReader(makeReader());
    const app = await buildApp();
    const b = (await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/receipt` })).json();
    expect(b.settled).toBeUndefined();
    expect(b.verified).toBeUndefined();
    expect(b.paid).toBeUndefined();
    // Consumers key off finalState, which is staticcall-authoritative.
    expect(b.finalState).toBe("SETTLED_RELEASED");
    await app.close();
  });

  it("marks finalizedBlock as LOG-derived, not staticcall (reorg-exposed)", async () => {
    setSettlementUnitReader(makeReader());
    const app = await buildApp();
    const b = (await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/receipt` })).json();
    // rule 25: the envelope is enriched (chain, contract, block, finality,
    // completeness) — assert the load-bearing fields rather than an exact shape
    // that breaks every time the envelope legitimately grows.
    expect(b.finalizedBlock.value).toBe("999");
    expect(b.finalizedBlock.source).toBe("log");
    expect(b.finalizedBlock.blockHash).toBe(SNAP_HASH);
    await app.close();
  });

  it("marks refundReason LOG-derived on a refund path", async () => {
    setSettlementUnitReader(
      makeReader({
        readAnchors: async () => ({ state: UnitState.SETTLED_REFUNDED }),
        readRefundWitness: async () => ({ finalized: { released: false, code: 2 } }),
      }),
    );
    const app = await buildApp();
    const b = (await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/receipt` })).json();
    expect(b.refundReason.value).toBe("BACKUP_NO_RELEASE");
    expect(b.refundReason.source).toBe("log");
    expect(b.refundReason.completeness).toBe("complete");
    await app.close();
  });

  it("leaves refundReason null on a RELEASE path (no cause to name)", async () => {
    setSettlementUnitReader(makeReader());
    const app = await buildApp();
    const b = (await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/receipt` })).json();
    expect(b.refundReason).toBeNull();
    await app.close();
  });

  it("takes assetReality from the REGISTRY, not from chainId — rule 11", async () => {
    // chainId 84532 is a testnet, but assetReality must come from the registry
    // read, so a REAL asset on a testnet is still reported REAL (and vice versa).
    setSettlementUnitReader(
      makeReader({ readAssetIdentity: async () => ({ assetReality: "real", registryId: "circle-usdc" }) }),
    );
    const app = await buildApp();
    const b = (await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/receipt` })).json();
    // rule 25/26: assetReality is now a registry-pinned envelope, not a bare
    // string, and carries the identity-not-liveness marker.
    expect(b.assetReality.value).toBe("real");
    expect(b.assetReality.source).toBe("registry");
    expect(b.network.chainId).toBe(84532);
    await app.close();
  });
});

describe("provenance — real discriminated union, no fabricated roots (#567)", () => {
  it("returns 200 + WITHHELD (not an error) when data is unavailable", async () => {
    setSettlementUnitReader(makeReader({ readProvenance: async () => ({ availability: "WITHHELD" }) }));
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/provenance` });
    expect(res.statusCode).toBe(200);
    expect(res.json().provenanceAvailability).toBe("WITHHELD");
    await app.close();
  });

  it("does NOT fabricate compositionRoot/leaves when WITHHELD", async () => {
    setSettlementUnitReader(makeReader({ readProvenance: async () => ({ availability: "WITHHELD" }) }));
    const app = await buildApp();
    const b = (await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/provenance` })).json();
    // An empty root is indistinguishable from a real one — must be absent.
    expect(b.compositionRoot).toBeUndefined();
    expect(b.leaves).toBeUndefined();
    await app.close();
  });

  it("handles UNANCHORED the same honest way", async () => {
    setSettlementUnitReader(makeReader({ readProvenance: async () => ({ availability: "UNANCHORED" }) }));
    const app = await buildApp();
    const b = (await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/provenance` })).json();
    expect(b.provenanceAvailability).toBe("UNANCHORED");
    expect(b.compositionRoot).toBeUndefined();
    await app.close();
  });

  it("rejects an out-of-range limit", async () => {
    setSettlementUnitReader(makeReader());
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/provenance?limit=9999` });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("maps an expired cursor to 409 EXPIRED_CURSOR", async () => {
    setSettlementUnitReader(
      makeReader({ readProvenance: async () => { throw new Error("expired cursor for unit"); } }),
    );
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/provenance?cursor=x` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("EXPIRED_CURSOR");
    await app.close();
  });
});

describe("v1.5 rule 22/24 — pinned finalized snapshot, echoed and cross-route checkable", () => {
  it("every DTO echoes {asOfBlock, asOfBlockHash} so Surface A can assert agreement", async () => {
    setSettlementUnitReader(makeReader());
    const app = await buildApp();
    for (const leaf of ["receipt", "lifecycle", "provenance"]) {
      const b = (await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/${leaf}` })).json();
      expect(b.asOfBlock).toBe("100");
      expect(b.asOfBlockHash).toBe(SNAP_HASH);
      expect(b.finality).toBe("finalized");
    }
    await app.close();
  });

  it("REFUSES to serve a non-finalized head rather than rendering it as confirmed", async () => {
    // rule 22: Base has unsafe/safe/finalized L2 heads. A money display read at
    // a non-finalized head must be refused or marked — never rendered as though
    // it were confirmed.
    setSettlementUnitReader(
      makeReader({
        pinSnapshot: async () => ({ asOfBlock: 100n, asOfBlockHash: SNAP_HASH, finality: "unsafe", logCompleteness: "complete" }),
      }),
    );
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/lifecycle` });
    expect(res.statusCode).toBe(503);
    expect(res.json().finalState).toBeUndefined();
    await app.close();
  });

  it("honours a caller-supplied ?asOf and 409s a snapshot it cannot serve", async () => {
    setSettlementUnitReader(makeReader());
    const app = await buildApp();
    const ok = await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/lifecycle?asOf=${SNAP_HASH}` });
    expect(ok.statusCode).toBe(200);

    const other = "0x" + "ef".repeat(32);
    const bad = await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/lifecycle?asOf=${other}` });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error).toBe("REVISION_MISMATCH");
    await app.close();
  });

  it("rejects a bare block NUMBER as ?asOf — the token must be a hash", async () => {
    // A number is not a snapshot identity: two routes could pin different
    // blocks under the same label after a reorg.
    setSettlementUnitReader(makeReader());
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/lifecycle?asOf=100` });
    expect(res.statusCode).toBe(409);
    await app.close();
  });
});

describe("v1.5 rule 23 — ABSENCE IS NOT EVIDENCE", () => {
  it("renders UNKNOWN (not a cause) when the log index is incomplete", async () => {
    setSettlementUnitReader(
      makeReader({
        pinSnapshot: async () => ({ asOfBlock: 100n, asOfBlockHash: SNAP_HASH, finality: "finalized", logCompleteness: "incomplete" }),
        readAnchors: async () => ({ state: UnitState.SETTLED_REFUNDED, remainingClaimCount: 0n }),
        readRefundWitness: async () => ({}), // nothing found — but the index is BEHIND
      }),
    );
    const app = await buildApp();
    const b = (await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/receipt` })).json();
    // Must NOT be null-meaning-none, and must NOT be an eliminated guess.
    expect(b.refundReason).toBe("UNKNOWN");
    await app.close();
  });

  it("still reports a real cause when the index IS complete", async () => {
    setSettlementUnitReader(
      makeReader({
        readAnchors: async () => ({ state: UnitState.SETTLED_REFUNDED, remainingClaimCount: 0n }),
        readRefundWitness: async () => ({ finalized: { released: false, code: 2 } }),
      }),
    );
    const app = await buildApp();
    const b = (await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/receipt` })).json();
    expect(b.refundReason.value).toBe("BACKUP_NO_RELEASE");
    expect(b.refundReason.completeness).toBe("complete");
    await app.close();
  });
});

describe("v1.5 rule 26 — assetReality attests IDENTITY, not liveness", () => {
  it("carries an explicit attests marker so 'real' cannot imply 'settlement possible'", async () => {
    setSettlementUnitReader(
      makeReader({ readAssetIdentity: async () => ({ assetReality: "real", registryId: "circle-usdc", revision: 7 }) }),
    );
    const app = await buildApp();
    const b = (await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/receipt` })).json();
    expect(b.assetReality.value).toBe("real");
    expect(b.assetReality.source).toBe("registry");
    // USDC is upgradeable/pausable/blacklistable — a correctly-pinned "real"
    // asset may still be unable to move. The DTO must never let the renderer
    // read identity as liveness.
    expect(b.assetReality.attests).toBe("identity-not-liveness");
    await app.close();
  });
});
