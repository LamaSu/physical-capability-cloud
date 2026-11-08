import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { eq, schema } from "@pcc/store";
import { runBuyerFundingSweepOnce, buyerFundingSweepStartRefusal, makeBuyerFundingSweepTicker, resolveBuyerFundingSweepIntervalSec, BUYER_FUNDING_SWEEP_INTERVAL_SEC, startBuyerFundingSweep, stopBuyerFundingSweep } from "../services/buyer-funding-sweep.js";
import { verifyBuyerFunding } from "../services/buyer-funding-verifier.js";
import * as settlementMode from "../services/settlement-mode.js";
import * as rpc from "../services/vnext-rpc-client.js";
import { reconcilePaidScope } from "../services/reconcile-paid-scope.js";
import { fundingRecordStore } from "../services/funding-record-port.js";
import { __setPaidScopeActivationTermsForTest } from "../services/paid-scope-activation-terms.js";
import { getRepos } from "../db.js";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { actAsJobParty } from "./helpers/job-read-party.js";
import { setUpFixture, tearDownFixture, acceptScope, scopeRow, db, T0, TTL, TERMS, ACTIVATION_TTL, BUYER, KERNEL, ADMIN, basePolicy, setPolicy, type Fixture } from "./helpers/paid-scope-fixture.js";
import { buyerFundingJob, installBuyerFunding, RECORD, plant, fundingCount, escrowRow, milestoneRows, hash, type FundingJob } from "./helpers/buyer-funding-fixture.js";

let f: Fixture;
beforeEach(async () => { f = await setUpFixture(); installBuyerFunding(); });
afterEach(async () => { stopBuyerFundingSweep(); await tearDownFixture(f); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const sweep = (j: FundingJob, over = {}) => runBuyerFundingSweepOnce({ ...j.deps, ...over });
const funded = async (j: FundingJob, reconcile: any = () => ({ kind: "refused", reason: "policy_unavailable" })) => verifyBuyerFunding(j.target, { ...j.deps, reconcile });
const setScope = (j: FundingJob, over: object) => db().update(schema.executionScopes).set(over).where(eq(schema.executionScopes.id, j.scopeId)).run();
const expectPending = (j: FundingJob) => { expect(fundingCount()).toBe(0); expect(escrowRow(j).status).toBe("created"); expect(milestoneRows(j).every(m => m.status === "pending")).toBe(true); };

describe("buyer funding sweep and activation cells", () => {
  it("C1: record after accept activates and starts its TTL", async () => {
    const j = await buyerFundingJob(f, { accept: false });
    const accepted = await acceptScope(f, j.scopeId);
    expect(accepted.statusCode).toBe(200); expect(accepted.json()).toMatchObject({ status: "awaiting_funding", fundingRefusal: "escrow_not_funded" });
    vi.setSystemTime(T0 + 1000);
    const out = await verifyBuyerFunding(j.target, j.deps);
    expect(out).toMatchObject({ kind: "recorded", activation: { kind: "activated" } });
    expect(scopeRow(j.scopeId).status).toBe("active"); expect(scopeRow(j.scopeId).expiresAt).toBe(new Date(T0 + 1000 + ACTIVATION_TTL).toISOString()); expect(fundingCount()).toBe(1);
  });
  it("C2: auto accepted scope activates once without accept", async () => {
    setPolicy(KERNEL, { ...basePolicy(), approvalMode: "policy", trustedAgents: [BUYER] });
    const mockFunds = vi.spyOn(settlementMode, "mockFundsWrites").mockReturnValue(false);
    const j = await buyerFundingJob(f, { accept: false });
    mockFunds.mockRestore();
    expect(scopeRow(j.scopeId).status).toBe("awaiting_funding"); expect(scopeRow(j.scopeId).expiresAt).toBe(new Date(T0 + TTL).toISOString());
    const accept = await acceptScope(f, j.scopeId); expect(accept.statusCode).toBe(409); expect(accept.json().error).toBe("already_decided");
    expect(await verifyBuyerFunding(j.target, j.deps)).toMatchObject({ kind: "recorded", activation: { kind: "activated" } });
    expect(await sweep(j)).toEqual({ passA: {}, passB: {} }); expect(fundingCount()).toBe(1);
  });
  it("C3: record first leaves accept unchanged and sweep skips active scope", async () => {
    const j = await buyerFundingJob(f, { accept: false }); plant(j);
    db().update(schema.escrows).set({ status: "funded" }).where(eq(schema.escrows.id, j.escrowId)).run();
    const res = await acceptScope(f, j.scopeId); expect(res.statusCode).toBe(200); expect(res.json()).toMatchObject({ status: "active", activation: { kind: "activated" }, fundingRefusal: null });
    const reconcile = vi.fn(); expect(await sweep(j, { reconcile })).toEqual({ passA: {}, passB: {} }); expect(reconcile).not.toHaveBeenCalled();
    expect(reconcilePaidScope(j.scopeId, j.record, TERMS).kind).toBe("already_active"); expect(fundingCount()).toBe(1);
  });
  it("C4: reconcile runs outside commit; throw or refusal is retried", async () => {
    for (const kind of ["throw", "refuse"]) {
      const j = await buyerFundingJob(f); const reconcile = vi.fn(() => {
        expect((db() as any).session.client.inTransaction).toBe(false);
        if (kind === "throw") throw new Error("reconcile failed");
        return { kind: "refused", reason: "policy_unavailable" } as const;
      });
      expect(await funded(j, reconcile)).toMatchObject({ kind: "recorded", activation: { kind: kind === "throw" ? "reconcile_threw" : "refused" } });
      expect(reconcile.mock.results[0].value?.message ?? "").not.toContain("expected");
      expect(escrowRow(j).status).toBe("funded"); expect(milestoneRows(j).every(m => m.status === "funded")).toBe(true); expect(scopeRow(j.scopeId).status).toBe("awaiting_funding");
      expect((await sweep(j)).passA).toEqual({ activated: 1 }); expect(scopeRow(j.scopeId).status).toBe("active");
    }
    expect(fundingCount()).toBe(2);
  });
  it("C5: retry inside window, then never again after activation", async () => {
    const j = await buyerFundingJob(f); await funded(j); const reconcile = vi.fn(reconcilePaidScope);
    expect((await sweep(j, { reconcile })).passA).toEqual({ activated: 1 }); expect(reconcile).toHaveBeenCalledWith(j.scopeId, j.record, expect.objectContaining({ postActivationTtlMs: ACTIVATION_TTL }));
    await sweep(j, { reconcile }); expect(reconcile).toHaveBeenCalledOnce();
  });
  it("C6: both passes skip lapsed windows, including one selected just before lapse", async () => {
    const j = await buyerFundingJob(f); await funded(j); const k = await buyerFundingJob(f);
    vi.setSystemTime(T0 + TTL); const reconcile = vi.fn(reconcilePaidScope);
    expect(await sweep(j, { reconcile })).toEqual({ passA: {}, passB: {} }); expect(reconcile).not.toHaveBeenCalled(); expect(k.calls).toEqual([]);
    expect(reconcilePaidScope(j.scopeId, j.record, TERMS)).toEqual({ kind: "expired", scopeId: j.scopeId, windowEndedAt: new Date(T0 + TTL).toISOString() });
    const res = await sweep(j, { now: () => new Date(T0 + TTL - 1) }); expect(res.passA).toEqual({ expired: 1 });
    expect(scopeRow(j.scopeId).status).toBe("awaiting_funding"); expect(fundingCount()).toBe(1);
  });
  it("C7: emergency stop refuses, resume in window activates once; late resume expires", async () => {
    const j = await buyerFundingJob(f); await funded(j);
    const stop = await f.app.inject({ method: "POST", url: "/api/operator/emergency-stop", payload: { kernelId: KERNEL } }); expect(stop.statusCode).toBe(200);
    expect(reconcilePaidScope(j.scopeId, j.record, TERMS)).toEqual({ kind: "refused", reason: "kernel_emergency_stopped" }); expect(scopeRow(j.scopeId).status).toBe("awaiting_funding"); expect(fundingCount()).toBe(1);
    const resume = await f.app.inject({ method: "POST", url: "/api/operator/emergency-resume", payload: { kernelId: KERNEL } }); expect(resume.statusCode).toBe(200);
    expect((await sweep(j)).passA).toEqual({ activated: 1 }); expect((await sweep(j)).passA).toEqual({});
    const k = await buyerFundingJob(f); await funded(k);
    await f.app.inject({ method: "POST", url: "/api/operator/emergency-stop", payload: { kernelId: KERNEL } });
    vi.setSystemTime(T0 + TTL);
    expect(reconcilePaidScope(k.scopeId, k.record, TERMS).kind).toBe("expired");
    await f.app.inject({ method: "POST", url: "/api/operator/emergency-resume", payload: { kernelId: KERNEL } });
    expect(reconcilePaidScope(k.scopeId, k.record, TERMS).kind).toBe("expired"); expect((await sweep(k)).passA).toEqual({});
  });
  it("C8: repeat verifier and reconcile move no rows or TTL", async () => {
    const j = await buyerFundingJob(f); expect(await verifyBuyerFunding(j.target, j.deps)).toMatchObject({ kind: "recorded" }); const before = scopeRow(j.scopeId);
    j.calls.length = 0; expect(await verifyBuyerFunding(j.target, j.deps)).toEqual({ kind: "duplicate", record: j.record }); expect(j.calls).toEqual([]);
    expect(reconcilePaidScope(j.scopeId, j.record, TERMS).kind).toBe("already_active"); expect(scopeRow(j.scopeId)).toEqual(before); expect(fundingCount()).toBe(1);
  });
  it("C9: unset opt-ins leave verifier, sweep, accept and operator jobs inert", async () => {
    const j = await buyerFundingJob(f, { accept: false }); __setPaidScopeActivationTermsForTest(null);
    for (const key of ["PCC_VNEXT_RECORD_NETWORK", "PCC_VNEXT_ALLOW_TESTNET_RECORD", "PCC_VNEXT_TESTNET_BUYERS"]) { vi.stubEnv(key, ""); delete process.env[key]; }
    expect(await verifyBuyerFunding(j.target, { ...j.deps, record: null })).toEqual({ kind: "refused", code: "deployment_record_unavailable" });
    expect(await runBuyerFundingSweepOnce()).toEqual({ skipped: "deployment_record_unavailable" }); expectPending(j);
    const accepted = await acceptScope(f, j.scopeId); expect(accepted.json().fundingRefusal).toBe("escrow_not_funded");
    db().update(schema.escrows).set({ status: "funded" }).where(eq(schema.escrows.id, j.escrowId)).run();
    const k = await buyerFundingJob(f, { accept: false }); db().update(schema.escrows).set({ status: "funded" }).where(eq(schema.escrows.id, k.escrowId)).run();
    expect((await acceptScope(f, k.scopeId)).json().fundingRefusal).toBe("escrow_not_buyer_funded");
    expect(reconcilePaidScope(j.scopeId, j.record, { expectedChainId: null, postActivationTtlMs: null, testnetOnly: false })).toEqual({ kind: "refused", reason: "expected_chain_unavailable" });
    const relay = Fastify({ logger: false }); actAsJobParty(relay, null); await relay.register(operatorRelayRoutes); await relay.ready();
    try { getRepos().jobs.update(j.jobId, { status: "queued" }); const res = await relay.inject({ method: "GET", url: `/api/operator/jobs?kernelId=${KERNEL}&status=queued`, headers: { "x-admin-key": ADMIN } });
      expect(res.statusCode).toBe(200); const row = res.json().jobs.find((x: any) => x.id === j.jobId); expect(row.funding.scopes[0].binding).toBe("no_record");
    } finally { await relay.close(); }
    expect(fundingCount()).toBe(0); expect(j.calls).toEqual([]);
  });
  it("S1: pass A selects finalized records only for open awaiting scopes", async () => {
    const j = await buyerFundingJob(f); await funded(j);
    for (const over of [{ status: "active" }, { status: "awaiting_acceptance" }, { expiresAt: new Date(T0).toISOString() }, { expiresAt: "garbled" }]) {
      const k = await buyerFundingJob(f); await funded(k); setScope(k, over);
    }
    const k = await buyerFundingJob(f); db().insert(schema.escrowFunding).values({ ...k.record, escrow: k.p.escrow, finality: "latest" } as any).run();
    const reconcile = vi.fn(() => ({ kind: "expired" }));
    const result = await sweep(j, { reconcile }); expect(result.passA).toEqual({ expired: 1 }); expect(reconcile.mock.calls[0][0]).toBe(j.scopeId); expect(reconcile).toHaveBeenCalledOnce();
  });
  it("S2: pass B orders by created_at then id and caps each pass", async () => {
    const jobs = [];
    for (const [id, time] of [["z", 0], ["b", -1000], ["a", -1000]] as const) jobs.push(await buyerFundingJob(f, { prepare: { id, createdAt: new Date(T0 + time).toISOString(), state: id === "a" ? "expired" : "served", endedAt: id === "a" ? new Date().toISOString() : null } }));
    const seen: string[] = []; const read = jobs[0].reads;
    vi.mocked(read.call).mockImplementation(async (address, abi, name) => { if (name === "implementation") seen.push(address); return jobs[0].values[name]; });
    const res = await sweep(jobs[0], { cap: 2, reads: read }); expect(Object.values(res.passB).reduce((a: number, b: any) => a + b, 0)).toBe(2);
    const prepares = db().select().from(schema.fundingPrepares).all();
    // The first pinned factory code request identifies each selected prepare through its subsequent prediction args.
    const predictions = vi.mocked(read.call).mock.calls.filter(c => c[2] === "predictEscrow");
    expect(predictions.map(c => (c[3][0] as any).jobIdHash)).toEqual([jobs[2].p.jobIdHash, jobs[1].p.jobIdHash]);
    expect(prepares).toHaveLength(3);
    const pending = await buyerFundingJob(f); await funded(pending);
    const pending2 = await buyerFundingJob(f); await funded(pending2);
    const reconcile = vi.fn(() => ({ kind: "expired" })); await sweep(pending, { cap: 1, reconcile }); expect(reconcile).toHaveBeenCalledOnce();
  });
  it("S3: superseded, pending_signature and another chain are never read", async () => {
    const j = await buyerFundingJob(f, { prepare: { state: "superseded", endedAt: new Date().toISOString(), supersededBy: "next" } });
    await buyerFundingJob(f, { prepare: { state: "pending_signature" } }); await buyerFundingJob(f, { prepare: { chainId: 8453 } });
    expect(await sweep(j)).toEqual({ passA: {}, passB: {} }); expect(j.calls).toEqual([]); expect(fundingCount()).toBe(0);
  });
  it("S4: row throw is closed and later rows continue; logs carry scopeId only", async () => {
    const j = await buyerFundingJob(f); await funded(j); const k = await buyerFundingJob(f); await funded(k);
    let n = 0; const reconcile = vi.fn(() => { if (++n === 1) throw new Error("secret-error-text"); return { kind: "expired" }; }); const logger = { info: vi.fn(), warn: vi.fn() };
    expect((await sweep(j, { reconcile, logger })).passA).toEqual({ row_failed: 1, expired: 1 }); expect(reconcile).toHaveBeenCalledTimes(2);
    expect(new Set(reconcile.mock.calls.map(c => c[0]))).toEqual(new Set([j.scopeId, k.scopeId]));
    expect(logger.info.mock.calls).toEqual([[`buyer_funding_sweep A row_failed ${reconcile.mock.calls[0][0]}`], [`buyer_funding_sweep A expired ${reconcile.mock.calls[1][0]}`]]);
  });
  it("S5: ticker skips overlapping run, releases after rejection", async () => {
    let release!: () => void; const run = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const tick = makeBuyerFundingSweepTicker(run); const first = tick(); await tick(); expect(run).toHaveBeenCalledOnce(); release(); await first;
    const second = tick(); expect(run).toHaveBeenCalledTimes(2); release(); await second;
    const failing = vi.fn().mockRejectedValueOnce(new Error("private")).mockResolvedValueOnce(undefined); const retry = makeBuyerFundingSweepTicker(failing); await retry(); await retry(); expect(failing).toHaveBeenCalledTimes(2);
  });
  it("S6: gate checks test, record and URL in order and accepts committed record", () => {
    vi.stubEnv("PCC_VNEXT_RECORD_NETWORK", undefined); expect(buyerFundingSweepStartRefusal({ NODE_ENV: "test" })).toBe("test_process");
    expect(buyerFundingSweepStartRefusal({ NODE_ENV: "production" })).toBe("deployment_record_unavailable");
    vi.stubEnv("PCC_VNEXT_RECORD_NETWORK", "base-sepolia"); vi.stubEnv("PCC_VNEXT_ALLOW_TESTNET_RECORD", "1"); vi.stubEnv("PCC_VNEXT_RECORD_LABEL", ""); delete process.env.PCC_VNEXT_RECORD_LABEL;
    expect(buyerFundingSweepStartRefusal({ NODE_ENV: "production" })).toBe("rpc_url_invalid");
    expect(buyerFundingSweepStartRefusal({ NODE_ENV: "production", PCC_VNEXT_RPC_URL: "https://fixture.invalid" })).toBeNull();
    const h = startBuyerFundingSweep(); h.stop(); stopBuyerFundingSweep();
  });
  it("S7: strict decimal interval uses frozen 60..180 band", () => {
    expect(BUYER_FUNDING_SWEEP_INTERVAL_SEC).toEqual({ min: 60, max: 180, default: 60 }); expect(Object.isFrozen(BUYER_FUNDING_SWEEP_INTERVAL_SEC)).toBe(true); expect(BUYER_FUNDING_SWEEP_INTERVAL_SEC.max + 120).toBeLessThanOrEqual(300);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("PCC_VNEXT_FUNDING_SWEEP_INTERVAL_SEC", ""); delete process.env.PCC_VNEXT_FUNDING_SWEEP_INTERVAL_SEC; expect(resolveBuyerFundingSweepIntervalSec()).toBe(60); expect(warn).not.toHaveBeenCalled();
    for (const n of ["60", "180"]) { vi.stubEnv("PCC_VNEXT_FUNDING_SWEEP_INTERVAL_SEC", n); expect(resolveBuyerFundingSweepIntervalSec()).toBe(Number(n)); }
    for (const value of ["30", "59", "181", "abc", "1e2", ""]) { warn.mockClear(); vi.stubEnv("PCC_VNEXT_FUNDING_SWEEP_INTERVAL_SEC", value); expect(resolveBuyerFundingSweepIntervalSec()).toBe(60); expect(warn).toHaveBeenCalledOnce(); expect(warn.mock.calls[0][0]).toContain("[60,180]"); }
  });
  it("S8: absent opt-ins skip before building reads or touching rows", async () => {
    const j = await buyerFundingJob(f); vi.stubEnv("PCC_VNEXT_RECORD_NETWORK", undefined); vi.stubEnv("PCC_VNEXT_ALLOW_TESTNET_RECORD", undefined); vi.stubEnv("PCC_VNEXT_TESTNET_BUYERS", undefined);
    const factory = vi.spyOn(rpc, "createVNextChainReads"); expect(await runBuyerFundingSweepOnce()).toEqual({ skipped: "deployment_record_unavailable" }); expect(factory).not.toHaveBeenCalled(); expectPending(j); expect(j.calls).toEqual([]);
  });
});
