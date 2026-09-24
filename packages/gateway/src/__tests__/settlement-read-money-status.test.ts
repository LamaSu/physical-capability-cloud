/**
 * The money-status classifier (#313) against the settlement read routes' REAL bodies.
 *
 * #313's first cut classified a hand-written idea of the /lifecycle and /receipt shapes in which
 * isAllocated was true for the settled states. The routes say isAllocated:false there: it is true
 * for 6/7 ONLY ("outcome decided, money NOT fully moved", unit-state-mapper isAllocatedState), so a
 * genuinely settled unit rendered "fields disagree" and was never shown as settled.
 *
 * So the fixtures here come from the routes themselves (real Fastify + inject over a fake reader,
 * the same harness as settlement-read-routes.test.ts), for every reachable unit state, and each
 * body is classified by BOTH the spec classifier and the shipped kit's <status-map v2> region.
 * Only state 8 may be green, from either route; every tampered body is unknown.
 */
import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { classifySettlementRecord } from "@pcc/spec";
import { settlementReadRoutes, setSettlementUnitReader, type SettlementUnitReader } from "../routes/settlement-read.js";
import { UnitState } from "../settlement/unit-state-mapper.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const kitSrc = readFileSync(path.resolve(here, "../../../../apps/dashboard/public/ui-kit/v1/pcc-ui.js"), "utf8");
const SNAP_HASH = "0x" + "cd".repeat(32);
const UNIT = "0x" + "ab".repeat(32);

function kitClassifier(): (r: unknown) => [string, string | null, string] {
  const m = kitSrc.match(/\/\/ <status-map v2>[^\n]*\n([\s\S]*?)\/\/ <\/status-map v2>/);
  if (!m) throw new Error("<status-map v2> markers not found in pcc-ui.js");
  const ctx: Record<string, unknown> = {};
  vm.runInNewContext(m[1] + "\nthis.settlementRecordClass = settlementRecordClass;", ctx);
  return ctx.settlementRecordClass as (r: unknown) => [string, string | null, string];
}
const kit = kitClassifier();

function reader(state: UnitState): SettlementUnitReader {
  // A consistent same-block read: terminal -> no claims left; allocated -> one claim outstanding.
  const remainingClaimCount = state >= UnitState.SETTLED_RELEASED ? 0n : state >= UnitState.RELEASE_ALLOCATED ? 1n : undefined;
  return {
    binding: () => ({ chainId: 84532, escrow: "0xEsCrOw" }),
    windows: () => ({ challengeWindow: 3600n, appealWindow: 7200n }),
    pinSnapshot: async () => ({ asOfBlock: 100n, asOfBlockHash: SNAP_HASH, finality: "finalized" as const, logCompleteness: "complete" as const }),
    readAnchors: async () => ({ state, remainingClaimCount }),
    readRefundWitness: async () => ({}),
    readZeroingDischargeBlock: async () => 999n,
    readEconomics: async () => ({ amount: "1000000", feeAmount: "23500", recipient: "0xRecipient", token: "0xUSDC", assuranceTier: 1 }),
    readAssetIdentity: async () => ({ assetReality: "test" as const, registryId: "reg-1", revision: 3 }),
    readProvenance: async () => ({ availability: "AVAILABLE" as const, compositionRoot: "0xroot", revision: 1, leaves: [], nextCursor: null }),
    readOwnerTenant: async () => null,
  };
}
async function bodies(state: UnitState): Promise<{ lifecycle: Record<string, unknown>; receipt: Record<string, unknown> }> {
  setSettlementUnitReader(reader(state));
  const app: FastifyInstance = Fastify();
  app.addHook("onRequest", async (req) => { (req as unknown as { tenantId: string | null }).tenantId = "tenant-a"; });
  await app.register(settlementReadRoutes);
  await app.ready();
  const get = async (leaf: string) => {
    const res = await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/${leaf}` });
    expect(res.statusCode, `${leaf} @ state ${state}`).toBe(200);
    return res.json() as Record<string, unknown>;
  };
  const out = { lifecycle: await get("lifecycle"), receipt: await get("receipt") };
  await app.close();
  return out;
}
const both = (body: unknown) => {
  const spec = classifySettlementRecord(body);
  const [cls, label] = kit(body);
  expect(cls, JSON.stringify(body)).toBe("st-" + spec.tone); // the kit agrees with the spec on the real body
  expect(label, JSON.stringify(body)).toBe(spec.label);
  return spec;
};

afterEach(() => setSettlementUnitReader(null));

describe("#313 classifies the settlement routes' REAL bodies (spec and shipped kit agree)", () => {
  const STATES = [1, 2, 3, 4, 5, 6, 7, 8, 9] as UnitState[];
  const LIFECYCLE_TONE: Record<number, string> = { 1: "running", 2: "waiting", 3: "waiting", 4: "waiting", 5: "waiting", 6: "waiting", 7: "waiting", 8: "settled", 9: "refunded" };

  it("every reachable state, from /lifecycle and from /receipt, gets its honest tone; only state 8 is green", async () => {
    for (const s of STATES) {
      const b = await bodies(s);
      const lc = both(b.lifecycle), rc = both(b.receipt);
      expect(lc.tone, `lifecycle ${s}`).toBe(LIFECYCLE_TONE[s]);
      const receiptTone = s === 8 ? "settled" : s === 9 ? "refunded" : "waiting";
      expect(rc.tone, `receipt ${s}`).toBe(receiptTone);
      if (s === 6 || s === 7) expect(rc.label, `receipt ${s}`).toContain("not yet paid out");
      if (s >= 1 && s <= 5) expect(rc.label, `receipt ${s}`).toContain("no outcome decided");
      expect(lc.tone === "settled" || rc.tone === "settled", `green @ ${s}`).toBe(s === 8);
    }
  });

  it("the real settled bodies carry isAllocated:false (6/7 only) -- the semantics the classifier keys on", async () => {
    const b = await bodies(UnitState.SETTLED_RELEASED);
    expect(b.lifecycle).toMatchObject({ unitState: 8, finalState: "SETTLED_RELEASED", isTerminal: true, isAllocated: false, phase: "settled" });
    expect(b.receipt).toMatchObject({ finalState: "SETTLED_RELEASED", isAllocated: false, phase: "settled" });
    const six = await bodies(UnitState.RELEASE_ALLOCATED);
    expect(six.receipt).toMatchObject({ finalState: null, isAllocated: true, phase: "allocated" });
  });

  it("any single tampered field of a real settled body is unknown, never green", async () => {
    const { lifecycle, receipt } = await bodies(UnitState.SETTLED_RELEASED);
    const drop = (o: Record<string, unknown>, k: string) => { const c = { ...o }; delete c[k]; return c; };
    for (const bad of [
      { ...lifecycle, isAllocated: true }, { ...lifecycle, isTerminal: false }, { ...lifecycle, phase: "allocated" },
      { ...lifecycle, finalState: null }, { ...lifecycle, unitState: 6 }, drop(lifecycle, "phase"), drop(lifecycle, "isAllocated"),
      { ...receipt, isAllocated: true }, { ...receipt, phase: "allocated" }, { ...receipt, isTerminal: false },
      drop(receipt, "phase"), drop(receipt, "isAllocated"), { ...receipt, finalState: "RELEASED" },
    ]) {
      expect(both(bad).tone, JSON.stringify(bad)).toBe("unknown");
    }
    const six = await bodies(UnitState.RELEASE_ALLOCATED);
    expect(both({ ...six.receipt, finalState: "SETTLED_RELEASED" }).tone).toBe("unknown");
    expect(both({ ...six.lifecycle, isAllocated: false }).tone).toBe("unknown");
  });
});
