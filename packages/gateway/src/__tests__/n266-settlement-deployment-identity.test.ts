import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  settlementReadRoutes, setSettlementUnitReader, UnitNotFoundError,
  type SettlementUnitReader, type ChainSnapshot,
} from "../routes/settlement-read.js";
import { UnitState } from "../settlement/unit-state-mapper.js";

const UNIT = "0x" + "ab".repeat(32);
const SECOND = "0x" + "bc".repeat(32);
const SNAP = { asOfBlock: 100n, asOfBlockHash: "0x" + "cd".repeat(32), finality: "finalized", logCompleteness: "complete" } as const;
const DEPLOYMENT = { chainId: 84532, factory: "0x" + "fa".repeat(20), implementation: "0x" + "1e".repeat(20), recordSha256: "ab".repeat(32) };
const WINDOWS = { challengeWindow: 600n, appealWindow: 1500n };
const ROUTES = ["lifecycle", "receipt", "provenance"] as const;
const KEYS = ["chainId", "factory", "implementation", "recordSha256"].sort();
const apps: FastifyInstance[] = [];
function fake(over: Partial<SettlementUnitReader> = {}) {
  return {
    binding: vi.fn(async () => ({ chainId: 84532, escrow: "0xEscrow", deployment: DEPLOYMENT, windows: WINDOWS })),
    pinSnapshot: vi.fn(async () => SNAP),
    readAnchors: async () => ({ state: UnitState.SETTLED_RELEASED, remainingClaimCount: 0n }),
    readRefundWitness: async () => ({}), readZeroingDischargeBlock: async () => 99n,
    readEconomics: async () => ({ amount: "100", feeAmount: "5", recipient: "0xPayee", token: "0xUSDC", assuranceTier: 1 }),
    readAssetIdentity: async () => ({ assetReality: "test" as const, registryId: "r1", revision: 1 }),
    readProvenance: async () => ({ availability: "AVAILABLE" as const, compositionRoot: "0xroot", revision: 1, leaves: [], nextCursor: null }),
    readOwnerTenant: async () => null, ...over,
  } as unknown as SettlementUnitReader & { binding: ReturnType<typeof vi.fn>; pinSnapshot: ReturnType<typeof vi.fn> };
}
async function appFor(r: SettlementUnitReader) {
  setSettlementUnitReader(r);
  const app = Fastify(); apps.push(app);
  app.addHook("onRequest", async (req) => { (req as unknown as { tenantId: string }).tenantId = "tenant-a"; });
  await app.register(settlementReadRoutes);
  return app;
}
const get = (app: FastifyInstance, route: string, unit = UNIT, query = "") => app.inject({ method: "GET", url: `/api/settlement/units/${unit}/${route}${query}` });
afterEach(async () => { setSettlementUnitReader(null); await Promise.all(apps.splice(0).map(app => app.close())); });

describe("N266 deployment identity", () => {
  it.each(["AVAILABLE", "WITHHELD", "UNANCHORED"] as const)("I1 every 200 echoes exactly the identity (%s)", async availability => {
    const app = await appFor(fake({ readProvenance: async () => ({ availability, compositionRoot: "0xroot", revision: 1, leaves: [], nextCursor: null }) }));
    for (const route of ROUTES) {
      const res = await get(app, route); expect(res.statusCode).toBe(200);
      expect(res.json().deployment).toEqual(DEPLOYMENT);
      expect(Object.keys(res.json().deployment).sort()).toEqual(KEYS);
    }
  });
  it("I2 each unit has its own escrow and deployment on every route", async () => {
    const other = { ...DEPLOYMENT, chainId: 8453, factory: "0x" + "aa".repeat(20), implementation: "0x" + "bb".repeat(20), recordSha256: "cc".repeat(32) };
    const r = fake(); r.binding.mockImplementation(async (id: string) => ({ chainId: id === UNIT ? 84532 : 8453, escrow: id === UNIT ? "0xOne" : "0xTwo", deployment: id === UNIT ? DEPLOYMENT : other, windows: id === UNIT ? WINDOWS : { challengeWindow: 172800n, appealWindow: 432000n } }));
    const app = await appFor(r);
    for (const route of ROUTES) for (const id of [UNIT, SECOND]) {
      const res = await get(app, route, id); expect(res.statusCode).toBe(200);
      expect(res.json().escrow).toBe(id === UNIT ? "0xOne" : "0xTwo");
      expect(res.json().deployment).toEqual(id === UNIT ? DEPLOYMENT : other);
    }
  });
  it.each([false, true])("I3 binding receives unit and pinned snapshot (asOf=%s)", async explicit => {
    const snap: ChainSnapshot = { ...SNAP, asOfBlock: 123n, asOfBlockHash: "0x" + "ef".repeat(32) };
    const r = fake({ pinSnapshot: vi.fn(async () => snap) }); const app = await appFor(r);
    for (const route of ROUTES) {
      r.binding.mockClear(); const res = await get(app, route, SECOND, explicit ? `?asOf=${snap.asOfBlockHash}` : "");
      expect(res.statusCode).toBe(200); expect(r.binding).toHaveBeenCalledTimes(1); expect(r.binding).toHaveBeenLastCalledWith(SECOND, snap);
      expect(res.json().asOfBlock).toBe("123"); expect(res.json().asOfBlockHash).toBe(snap.asOfBlockHash);
      expect(r.pinSnapshot).toHaveBeenLastCalledWith(explicit ? snap.asOfBlockHash : undefined);
    }
  });
  const invalid = [
    ["missing", undefined], ["uppercase factory", { ...DEPLOYMENT, factory: "0x" + DEPLOYMENT.factory.slice(2).toUpperCase() }],
    ["uppercase implementation", { ...DEPLOYMENT, implementation: "0x" + DEPLOYMENT.implementation.slice(2).toUpperCase() }],
    ["array factory", { ...DEPLOYMENT, factory: [DEPLOYMENT.factory] }],
    ["short implementation", { ...DEPLOYMENT, implementation: "0x" + "a".repeat(39) }],
    ["prefixed hash", { ...DEPLOYMENT, recordSha256: "0x" + DEPLOYMENT.recordSha256 }],
    ["short hash", { ...DEPLOYMENT, recordSha256: "a".repeat(63) }],
    ["chainId mismatch", { ...DEPLOYMENT, chainId: 8453 }],
  ] as const;
  it.each(invalid)("I4 neg-invalid-identity: %s", async (_name, deployment) => {
    const r = fake(); r.binding.mockResolvedValue({ chainId: 84532, escrow: "0xEscrow", deployment, windows: WINDOWS }); const app = await appFor(r);
    for (const route of ROUTES) {
      const res = await get(app, route); expect(res.statusCode).toBe(503); expect(res.headers["retry-after"]).toBe("5");
      expect(res.json().error).toBe("INDEX_NOT_READY");
      for (const key of ["unitState", "finalState", "economics"]) expect(res.json()).not.toHaveProperty(key);
    }
  });
  it.each(["malformed", "bare-asOf", "non-finalized", "unknown-anchor", "foreign-tenant"] as const)("I5 neg-no-binding: %s", async which => {
    const r = fake(which === "non-finalized" ? { pinSnapshot: async () => ({ ...SNAP, finality: "safe" }) } : which === "unknown-anchor" ? { readAnchors: async () => { throw new UnitNotFoundError(UNIT); } } : which === "foreign-tenant" ? { readOwnerTenant: async () => "tenant-b" } : {});
    const app = await appFor(r);
    for (const route of ROUTES) {
      const res = await get(app, route, which === "malformed" ? "bad" : UNIT, which === "bare-asOf" ? "?asOf=100" : "");
      expect(res.statusCode).toBe(which === "bare-asOf" ? 409 : which === "non-finalized" ? 503 : 404);
      expect(r.binding).not.toHaveBeenCalled();
    }
  });
  it("I6 neg-binding-not-found is the same unknown-unit 404", async () => {
    const r = fake({ readAnchors: async () => { throw new UnitNotFoundError(UNIT); } }); const app = await appFor(r);
    for (const route of ROUTES) {
      const unknown = await get(app, route);
      r.readAnchors = async () => ({ state: UnitState.FUNDED_ACTIVE });
      r.binding.mockRejectedValue(new UnitNotFoundError(UNIT));
      const res = await get(app, route); expect(res.statusCode).toBe(404); expect(res.json()).toEqual(unknown.json());
      r.readAnchors = async () => { throw new UnitNotFoundError(UNIT); };
    }
  });
  it.each([[2, "1600", "173800"], [3, "3500", "434000"]] as const)("I7 state %s takes windows from each binding", async (state, short, long) => {
    const r = fake({ readAnchors: async () => ({ state, assertedAt: 1000n, challengedAt: 2000n }) });
    r.binding.mockImplementation(async (id: string) => ({ chainId: 84532, escrow: "0xEscrow", deployment: DEPLOYMENT, windows: id === UNIT ? WINDOWS : { challengeWindow: 172800n, appealWindow: 432000n } }));
    const app = await appFor(r);
    for (const [id, end] of [[UNIT, short], [SECOND, long]]) {
      const res = await get(app, "lifecycle", id); expect(res.statusCode).toBe(200); expect(res.json().windowEndsAt).toBe(end);
    }
  });
  it("I8 fresh echo excludes extra identity keys", async () => {
    const r = fake(); r.binding.mockResolvedValue({ chainId: 84532, escrow: "0xEscrow", deployment: { ...DEPLOYMENT, note: "must not escape" }, windows: WINDOWS }); const app = await appFor(r);
    for (const route of ROUTES) { const res = await get(app, route); expect(res.statusCode).toBe(200); expect(Object.keys(res.json().deployment).sort()).toEqual(KEYS); expect(res.json().deployment).toEqual(DEPLOYMENT); }
  });
  it("I9 schema and route agree on 14 near-miss identities", async () => {
    const { SettlementDeploymentIdentitySchema } = await vi.importActual<typeof import("@pcc/spec/recheck")>("@pcc/spec/recheck");
    const cases = [DEPLOYMENT, { ...DEPLOYMENT, factory: "0x" + "01".repeat(20) },
      ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "84532"].map(chainId => ({ ...DEPLOYMENT, chainId })),
      { ...DEPLOYMENT, factory: "0x" + "A".repeat(40) }, { ...DEPLOYMENT, implementation: "0x" + "a".repeat(39) },
      { ...DEPLOYMENT, implementation: "0x" + DEPLOYMENT.implementation.slice(2).toUpperCase() },
      { ...DEPLOYMENT, factory: [DEPLOYMENT.factory] },
      { ...DEPLOYMENT, recordSha256: "0x" + DEPLOYMENT.recordSha256 }, { ...DEPLOYMENT, recordSha256: "a".repeat(63) }, { ...DEPLOYMENT, recordSha256: "AB".repeat(32) }];
    expect(cases).toHaveLength(14);
    const r = fake(); const app = await appFor(r);
    for (const deployment of cases) {
      r.binding.mockResolvedValue({ chainId: deployment.chainId, escrow: "0xEscrow", deployment, windows: WINDOWS });
      for (const route of ROUTES) { const res = await get(app, route); expect(res.statusCode, JSON.stringify(deployment)).toBe(SettlementDeploymentIdentitySchema.safeParse(deployment).success ? 200 : 503); }
    }
    expect(SettlementDeploymentIdentitySchema.safeParse({ ...DEPLOYMENT, note: "extra" }).success).toBe(false);
  }, 60_000);
  it.each([2, 1])("I10 every route echoes the validated factory when its getter changes after %s reads", async validReads => {
    for (const availability of ["AVAILABLE", "WITHHELD", "UNANCHORED"] as const) {
      const r = fake({ readProvenance: async () => ({ availability, compositionRoot: "0xroot", revision: 1, leaves: [], nextCursor: null }) });
      r.binding.mockImplementation(async () => {
        let reads = 0;
        const deployment = { ...DEPLOYMENT, get factory() { return ++reads <= validReads ? DEPLOYMENT.factory : "NOT-AN-ADDRESS"; } };
        return { chainId: 84532, escrow: "0xEscrow", deployment, windows: WINDOWS };
      });
      const app = await appFor(r);
      for (const route of ROUTES) {
        const res = await get(app, route); expect(res.statusCode, `${route} ${availability}`).toBe(200);
        expect(res.json().deployment.factory, `${route} ${availability}`).toBe(DEPLOYMENT.factory);
      }
    }
  });
  it.each([
    ["undefined binding", undefined],
    ["missing windows", { chainId: 84532, escrow: "0xEscrow", deployment: DEPLOYMENT }],
    ["negative challengeWindow", { chainId: 84532, escrow: "0xEscrow", deployment: DEPLOYMENT, windows: { ...WINDOWS, challengeWindow: -1n } }],
  ] as const)("I11 invalid binding: %s", async (_name, binding) => {
    const r = fake({ readAnchors: async () => ({ state: UnitState.PRIMARY_ASSERTED, assertedAt: 1000n }) });
    r.binding.mockResolvedValue(binding); const app = await appFor(r);
    for (const route of ROUTES) {
      const res = await get(app, route); expect(res.statusCode, route).toBe(503);
      expect(res.headers["retry-after"]).toBe("5"); expect(res.json().error).toBe("INDEX_NOT_READY");
      expect(res.json().message).toBe("Settlement read is misbound: no valid binding");
    }
  });
});
