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
import { classifySettlementRecord, classifySettlementRead, chainPin } from "@pcc/spec";
import { settlementReadRoutes, setSettlementUnitReader, type SettlementUnitReader } from "../routes/settlement-read.js";
import { UnitState } from "../settlement/unit-state-mapper.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const kitSrc = readFileSync(path.resolve(here, "../../../../apps/dashboard/public/ui-kit/v1/pcc-ui.js"), "utf8");
const SNAP_HASH = "0x" + "cd".repeat(32);
// R12: a well-formed escrow address, so the real bodies carry a valid pin (a placeholder such as "0xEsCrOw" is pending).
const ESCROW = "0x" + "e5".repeat(20);
const UNIT = "0x" + "ab".repeat(32);

type KitClass = [string, string | null, string];
function kitClassifiers(): { record: (r: unknown) => KitClass; read: (r: unknown, path: unknown, live: unknown) => KitClass } {
  const m = kitSrc.match(/\/\/ <status-map v2>[^\n]*\n([\s\S]*?)\/\/ <\/status-map v2>/);
  if (!m) throw new Error("<status-map v2> markers not found in pcc-ui.js");
  const ctx: Record<string, unknown> = {};
  vm.runInNewContext(m[1] + "\nthis.settlementRecordClass = settlementRecordClass; this.settlementReadClass = settlementReadClass;", ctx);
  return { record: ctx.settlementRecordClass as (r: unknown) => KitClass, read: ctx.settlementReadClass as (r: unknown, path: unknown, live: unknown) => KitClass };
}
const kitFns = kitClassifiers();
const kit = kitFns.record;

function reader(state: UnitState, binding: { chainId: number; escrow: string } = { chainId: 84532, escrow: ESCROW }): SettlementUnitReader {
  // A consistent same-block read: terminal -> no claims left; allocated -> one claim outstanding.
  const remainingClaimCount = state >= UnitState.SETTLED_RELEASED ? 0n : state >= UnitState.RELEASE_ALLOCATED ? 1n : undefined;
  return {
    binding: () => binding,
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
async function bodies(state: UnitState, binding?: { chainId: number; escrow: string }): Promise<{ lifecycle: Record<string, unknown>; receipt: Record<string, unknown> }> {
  setSettlementUnitReader(reader(state, binding));
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

  it("a /receipt that ALSO carries unitState (escrow ruling #3163, additive) classifies the same, with the 6-vs-7 direction from unitState", async () => {
    for (const s of STATES) {
      const b = await bodies(s);
      const rc = both({ ...b.receipt, unitState: b.lifecycle.unitState });
      expect(rc.tone, `receipt+unitState ${s}`).toBe(LIFECYCLE_TONE[s]);
      expect(rc.tone === "settled", `green @ ${s}`).toBe(s === 8);
      if (s === 6) expect(rc.label).toContain("release decided");
      if (s === 7) expect(rc.label).toContain("refund decided");
    }
    const eight = await bodies(UnitState.SETTLED_RELEASED);
    const withState = { ...eight.receipt, unitState: 8 };
    for (const bad of [{ ...withState, unitState: 6 }, { ...withState, isAllocated: true }, { ...withState, phase: "allocated" }, { ...withState, isTerminal: false }]) {
      expect(both(bad).tone, JSON.stringify(bad)).toBe("unknown");
    }
  });

  it("DISPLAY gate (astra r2 on #313): the real bodies show a final state only as a LIVE read of their own route", async () => {
    for (const s of [UnitState.SETTLED_RELEASED, UnitState.SETTLED_REFUNDED, UnitState.RELEASE_ALLOCATED]) {
      const b = await bodies(s);
      for (const [leaf, body] of [["lifecycle", b.lifecycle], ["receipt", b.receipt]] as const) {
        const path = `/api/settlement/units/${UNIT}/${leaf}`;
        const final = s === UnitState.SETTLED_RELEASED || s === UnitState.SETTLED_REFUNDED;
        const live = classifySettlementRead(body, { path, live: true });
        expect(live.tone, `${leaf} ${s} live`).toBe(classifySettlementRecord(body).tone);
        // R12: the route's REAL DTO carries a valid pin (chainId, escrow, unitId, a decimal-string asOfBlock,
        // asOfBlockHash, finality "finalized"), and the same body with a malformed escrow is only pending.
        expect(chainPin(body, path), `${leaf} ${s} pin`).toMatchObject({ chainId: 84532, network: "Base Sepolia", escrow: ESCROW, unitId: UNIT, asOfBlock: "100", asOfBlockHash: SNAP_HASH, finality: "finalized" });
        if (final) expect(classifySettlementRead({ ...(body as object), escrow: "0xEsCrOw" }, { path, live: true }).tone, `${leaf} ${s} bad pin`).toBe("waiting");
        const offline = classifySettlementRead(body, { path, live: false });
        const elsewhere = classifySettlementRead(body, { path: "/api/jobs/j1", live: true });
        // R12 r2 D: not only a final state -- NO state is shown without a live read of the unit's own route.
        expect(offline.tone, `${leaf} ${s} snapshot`).toBe("unknown");
        expect(elsewhere.tone, `${leaf} ${s} other route`).toBe("unknown");
      }
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

  // R12 r2 D (ChatGPT run 2 F1 HIGH on #599 @aa0b8df6): EVERY chain-derived state needs the live pin, not
  // only 8 and 9. The bodies below come from the routes themselves; each broken pin is the real producer's
  // own output where it can produce one (a placeholder escrow, a chain outside the network table, a read
  // classified under another unit's route), and a hand edit of a real body where the route refuses to (it
  // never answers 200 for a non-finalized head; a missing pin models a non-conforming producer).
  it("R12 r2 D: every state 1..9 of the REAL bodies, from both routes, shows only from a live read of its own route with a valid pin (spec == kit)", async () => {
    const OTHER_UNIT = "0x" + "ef".repeat(32);
    const PIN_KEYS = ["chainId", "escrow", "unitId", "asOfBlock", "asOfBlockHash", "finality", "network"];
    const strip = (o: Record<string, unknown>) => { const c = { ...o }; for (const k of PIN_KEYS) delete c[k]; return c; };
    const agree = (body: unknown, path: string, live: unknown, want: { tone: string; label: string | null }, tag: string) => {
      const spec = classifySettlementRead(body, { path, live });
      expect({ tone: spec.tone, label: spec.label }, tag).toEqual(want);
      const [cls, label] = kitFns.read(body, path, live);
      expect([cls, label], tag).toEqual(["st-" + spec.tone, spec.label]);
    };
    const PENDING = { tone: "waiting", label: "pending - not confirmed at a finalized block" };
    const NOT_SHOWN = { tone: "unknown", label: "state not shown - not a live read of a settlement route" };
    for (const s of [1, 2, 3, 4, 5, 6, 7, 8, 9] as UnitState[]) {
      const real = await bodies(s);
      const placeholder = await bodies(s, { chainId: 84532, escrow: "0xEsCrOw" }); // the routes' own test fixture escrow
      const otherChain = await bodies(s, { chainId: 1, escrow: ESCROW }); // Ethereum mainnet: not a settlement network
      for (const leaf of ["lifecycle", "receipt"] as const) {
        const path = `/api/settlement/units/${UNIT}/${leaf}`;
        const own = classifySettlementRecord(real[leaf]);
        expect(own.known, `${leaf} ${s}`).toBe(true);
        agree(real[leaf], path, true, { tone: own.tone, label: own.label }, `${leaf} ${s} pinned live`);
        for (const [name, body, p] of [
          ["placeholder escrow", placeholder[leaf], path], ["chain 1", otherChain[leaf], path],
          ["another unit's route", real[leaf], `/api/settlement/units/${OTHER_UNIT}/${leaf}`],
          ["no pin", strip(real[leaf]), path], ["safe head", { ...real[leaf], finality: "safe" }, path],
        ] as Array<[string, Record<string, unknown>, string]>) {
          agree(body, p, true, PENDING, `${leaf} ${s} ${name}`);
        }
        for (const [name, p, live] of [["snapshot", path, false], ["a job route", "/api/jobs/j1", true], ["provenance", `/api/settlement/units/${UNIT}/provenance`, true]] as Array<[string, string, unknown]>) {
          agree(real[leaf], p, live, NOT_SHOWN, `${leaf} ${s} ${name}`);
        }
      }
    }
  });
});
