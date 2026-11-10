import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { eq, schema, sql } from "@pcc/store";
import { zeroAddress, zeroHash } from "viem";
import { compileVNextPolicy, buildUnitConfig } from "@pcc/contracts/vnext";
import { verifyBuyerFunding, BUYER_FUNDING_VERIFY_CODES, markBuyerFunded } from "../services/buyer-funding-verifier.js";
import { buyerFundedEscrowRefusal, findEscrowRowByAddress, isBuyerFundedEscrowRow } from "../services/buyer-funded-escrow.js";
import { __setFundingRecordStoreForTest } from "../services/funding-record-port.js";
import { createVNextChainReads, __setVNextTransportForTest } from "../services/vnext-rpc-client.js";
import { setUpFixture, tearDownFixture, db, scopeRow, BUYER, OTHER, T0, type Fixture } from "./helpers/paid-scope-fixture.js";
import { buyerFundingJob, installBuyerFunding, RECORD, B, FUND, F0, WRONG, hash, wire, plant, fundingCount, escrowRow, milestoneRows, fixtureTransport, type FundingJob } from "./helpers/buyer-funding-fixture.js";

let f: Fixture;
beforeEach(async () => { f = await setUpFixture(); installBuyerFunding(); });
afterEach(async () => { __setVNextTransportForTest(null); await tearDownFixture(f); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const run = (j: FundingJob, over = {}) => verifyBuyerFunding(j.target, { ...j.deps, ...over });
async function refuses(j: FundingJob, code: string, over = {}) {
  expect(await run(j, over)).toEqual({ kind: "refused", code });
  expect(fundingCount()).toBe(0);
  expect(escrowRow(j).status).toBe("created");
  expect(milestoneRows(j).every(m => m.status === "pending")).toBe(true);
}
const scope = (j: FundingJob, over: object) => db().update(schema.executionScopes).set(over).where(eq(schema.executionScopes.id, j.scopeId)).run();
const escrow = (j: FundingJob, over: object) => db().update(schema.escrows).set(over).where(eq(schema.escrows.id, j.escrowId)).run();
const changePolicy = (j: FundingJob, index: number, value: unknown) => { (j.values.policy as unknown[])[index] = value; };
function lastRead(j: FundingJob, fn: () => void) {
  let calls = 0;
  vi.mocked(j.reads.chainId).mockImplementation(async () => { if (++calls === 2) fn(); return 84532; });
}

describe("buyer funding finalized verifier", () => {
  it("V0: records all fields, moves both rows, then activates once", async () => {
    const j = await buyerFundingJob(f); const reconcile = vi.fn((...args: any[]) => {
      expect(fundingCount()).toBe(1); expect(escrowRow(j).status).toBe("funded");
      return { kind: "activated" } as any;
    });
    const out = await run(j, { reconcile });
    expect(out).toEqual({ kind: "recorded", record: j.record, activation: { kind: "activated" } });
    expect(reconcile).toHaveBeenCalledOnce(); expect(reconcile.mock.calls[0][0]).toBe(j.scopeId);
    expect(milestoneRows(j).every(m => m.status === "funded")).toBe(true);
    expect(j.calls.some(c => /balanceOf|allowance|receipt/i.test(c.method))).toBe(false);
    expect(BUYER_FUNDING_VERIFY_CODES[0]).toBe("funding_record_store_unavailable");
    expect(Object.isFrozen(BUYER_FUNDING_VERIFY_CODES)).toBe(true);
    expect(isBuyerFundedEscrowRow(escrowRow(j))).toBe(true);
    expect(findEscrowRowByAddress(j.p.escrow)).toEqual(escrowRow(j));
    expect(buyerFundedEscrowRefusal(j.p.escrow)).toBe("escrow_buyer_funded");
    expect(buyerFundedEscrowRefusal(WRONG)).toBeNull();
  });
  it("V1: missing store", async () => { const j = await buyerFundingJob(f); __setFundingRecordStoreForTest(null); await refuses(j, "funding_record_store_unavailable"); });
  it("V2: null record reads nothing", async () => { const j = await buyerFundingJob(f); await refuses(j, "deployment_record_unavailable", { record: null }); expect(j.calls).toEqual([]); });
  it("V3: missing or unserved prepare", async () => {
    const j = await buyerFundingJob(f, { prepare: { state: "pending_signature" } }); await refuses(j, "prepare_not_found");
    expect(await verifyBuyerFunding({ chainId: 84532, escrow: WRONG }, j.deps)).toEqual({ kind: "refused", code: "prepare_not_found" });
    const k = await buyerFundingJob(f, { prepare: { state: "superseded", endedAt: new Date().toISOString(), supersededBy: "later" } }); await refuses(k, "prepare_not_found");
  });
  it("V4: duplicate is a read-free no-op; either conflicting key refuses", async () => {
    const j = await buyerFundingJob(f); plant(j); const reconcile = vi.fn();
    expect(await run(j, { reconcile })).toEqual({ kind: "duplicate", record: j.record });
    expect(j.calls).toEqual([]); expect(reconcile).not.toHaveBeenCalled(); expect(fundingCount()).toBe(1); expect(escrowRow(j).status).toBe("created");
    const k = await buyerFundingJob(f); plant(k, { scopeId: "other-scope" });
    expect(await run(k)).toEqual({ kind: "refused", code: "funding_conflict" });
    const l = await buyerFundingJob(f); plant(l, { escrowAddress: WRONG });
    expect(await run(l)).toEqual({ kind: "refused", code: "funding_conflict" }); expect(l.calls).toEqual([]);
  });
  it("V5: strictly parses configs, ids and created_at", async () => {
    for (const over of [{ configs: "[{}]" }, { unitIds: '["bad"]' }, { createdAt: "yesterday" },
      { configs: '[{"milestoneIndex":1}]' }]) { const j = await buyerFundingJob(f, { prepare: over }); await refuses(j, "prepare_inconsistent"); }
    const base = await buyerFundingJob(f);
    const config = JSON.parse(base.p.configs);
    for (const field of ["milestoneIndex", "g", "f", "n", "reclaimAt"]) {
      const c = structuredClone(config); c[0][field] = "01";
      await refuses(await buyerFundingJob(f, { prepare: { configs: wire(c) } }), "prepare_inconsistent");
    }
    for (const change of [(c: any) => c[0].requiredTier = 256, (c: any) => c[0].feeBps = 65536,
      (c: any) => c[0].unexpected = 1, (c: any) => c[0].payouts[0].amount = 1]) {
      const c = structuredClone(config); change(c);
      await refuses(await buyerFundingJob(f, { prepare: { configs: wire(c) } }), "prepare_inconsistent");
    }
  });
  it("V6: every deployment pin comes from one record", async () => {
    for (const over of [{ chainId: 8453 }, { factory: WRONG }, { implementation: WRONG }, { usdc: WRONG },
      { recordSha256: "ef".repeat(32) }, { scheduleId: "vnext-mainnet-v1" }, { scheduleTestnetOnly: false }]) {
      const j = await buyerFundingJob(f); await refuses(j, "prepare_not_record", { record: { ...RECORD, ...over } });
    }
  });
  it("V7: shared non-Circle token refuses", async () => { const j = await buyerFundingJob(f, { prepare: { usdc: WRONG } }); await refuses(j, "token_not_circle_usdc", { record: { ...RECORD, usdc: WRONG } }); });
  it("V8: scope missing, wrong job, wrong buyer", async () => {
    const j = await buyerFundingJob(f, { prepare: { scopeId: "missing" } }); await refuses(j, "prepare_not_scope");
    const k = await buyerFundingJob(f, { prepare: { jobId: "another" } }); await refuses(k, "prepare_not_scope");
    const l = await buyerFundingJob(f, { prepare: { payer: OTHER } }); await refuses(l, "prepare_not_scope");
  });
  it("V9: active, unaccepted and lapsed scopes refuse", async () => {
    for (const status of ["active", "awaiting_acceptance"]) { const j = await buyerFundingJob(f); scope(j, { status }); await refuses(j, "scope_not_awaiting_funding"); }
    const j = await buyerFundingJob(f); scope(j, { expiresAt: new Date(T0).toISOString() }); await refuses(j, "scope_not_awaiting_funding");
  });
  it("V10: escrow must be the prepared created marker row", async () => {
    for (const over of [{ cwmId: "hidden" }, { version: "v2" }, { contractAddress: WRONG }, { payer: OTHER }, { status: "funded" }]) {
      const j = await buyerFundingJob(f); escrow(j, over);
      expect(await run(j)).toEqual({ kind: "refused", code: "escrow_row_not_prepare" }); expect(fundingCount()).toBe(0);
    }
  });
  it("V11: testnet list absent or excludes buyer", async () => {
    const j = await buyerFundingJob(f); vi.stubEnv("PCC_VNEXT_TESTNET_BUYERS", undefined); await refuses(j, "testnet_buyer_not_allowed");
    vi.stubEnv("PCC_VNEXT_TESTNET_BUYERS", OTHER); await refuses(j, "testnet_buyer_not_allowed");
  });
  it("V12: no RPC reads", async () => { await refuses(await buyerFundingJob(f), "rpc_unavailable", { reads: undefined }); });
  it("V13: chain id is checked before and after pinned reads", async () => {
    const j = await buyerFundingJob(f); vi.mocked(j.reads.chainId).mockResolvedValue(8453); await refuses(j, "rpc_chain_mismatch");
    vi.mocked(j.reads.chainId).mockResolvedValueOnce(84532).mockResolvedValueOnce(8453); await refuses(j, "rpc_chain_mismatch");
  });
  it("V14: finalized block throws or is pending", async () => {
    const j = await buyerFundingJob(f); vi.mocked(j.reads.finalizedBlock).mockRejectedValueOnce(new Error("private")); await refuses(j, "finalized_block_unavailable");
    for (const over of [{ number: null }, { hash: null }]) { vi.mocked(j.reads.finalizedBlock).mockResolvedValueOnce({ ...B, ...over } as any); await refuses(j, "finalized_block_unavailable"); }
  });
  it("V15: first hash-pinned code read cannot be addressed", async () => { const j = await buyerFundingJob(f); vi.mocked(j.reads.code).mockRejectedValueOnce(new Error("private")); await refuses(j, "pinned_block_unaddressable"); });
  it("V16: implementation, factory prediction, pure prediction, code and factory link", async () => {
    for (const name of ["implementation", "predictEscrow", "factory"]) { const j = await buyerFundingJob(f); j.values[name] = WRONG; await refuses(j, "escrow_not_predicted"); }
    const j = await buyerFundingJob(f, { prepare: { escrow: WRONG } }); j.values.predictEscrow = WRONG; await refuses(j, "escrow_not_predicted");
    const k = await buyerFundingJob(f); vi.mocked(k.reads.code).mockResolvedValueOnce("0x6000").mockResolvedValueOnce("0x"); await refuses(k, "escrow_not_predicted");
  });
  it("V17: payer equals buyer and is never gateway signer", async () => {
    const j = await buyerFundingJob(f); j.values.payer = OTHER; await refuses(j, "payer_not_buyer");
    const k = await buyerFundingJob(f); await refuses(k, "payer_is_gateway_signer", { gatewaySigner: () => BUYER });
  });
  it("V18: both operator reads match", async () => {
    const j = await buyerFundingJob(f); j.values.operator = WRONG; await refuses(j, "operator_not_prepared");
    const k = await buyerFundingJob(f); changePolicy(k, 0, WRONG); await refuses(k, "operator_not_prepared");
  });
  it("V19: escrow token matches pins", async () => { const j = await buyerFundingJob(f); j.values.USDC = WRONG; await refuses(j, "token_not_pinned"); });
  it("V20: zero, other hash and all five escrow identity fields", async () => {
    for (const [value, code] of [[zeroHash, "not_funded_at_finalized"], [hash(999), "funded_under_other_policy"]] as const) {
      const j = await buyerFundingJob(f); changePolicy(j, 3, value); await refuses(j, code);
    }
    for (const [index, value] of [[1, 2n], [2, hash(99)], [4, hash(99)]] as const) { const j = await buyerFundingJob(f); changePolicy(j, index, value); await refuses(j, "escrow_identity_mismatch"); }
    for (const name of ["jobIdHash", "termsHash"]) { const j = await buyerFundingJob(f); j.values[name] = hash(99); await refuses(j, "escrow_identity_mismatch"); }
  });
  it("V21: unit reconstruction, hash, root, ids and every config field", async () => {
    for (const which of ["ok", "hash", "root", "ids", "config"]) {
      const j = await buyerFundingJob(f); const result = await j.reads.unitConfigs(j.compiled.escrow, B.number);
      if (which === "ok") result.ok = false;
      if (which === "hash") result.blockHash = hash(99);
      if (which === "root") result.prePolicyRoot = hash(99);
      if (which === "ids") result.units[0].unitId = hash(99);
      if (which === "config") result.units[0] = { ...result.units[0], config: { ...result.units[0].config, reclaimAt: result.units[0].config.reclaimAt + 1n } };
      vi.mocked(j.reads.unitConfigs).mockResolvedValue(result);
      await refuses(j, which === "hash" ? "finalized_block_moved" : "unit_configs_unverified");
    }
  });
  it("V22: gross sum equals frozen quote", async () => { const j = await buyerFundingJob(f, { prepare: { totalGross: "999999" } }); await refuses(j, "total_gross_not_quote"); });
  it("V23: factory witnesses the funded escrow", async () => { const j = await buyerFundingJob(f); j.values.fundedEscrowOf = WRONG; await refuses(j, "factory_not_witness"); });
  it("V24: each unit is FUNDED_ACTIVE", async () => { const j = await buyerFundingJob(f); j.values.unitState = 2; await refuses(j, "unit_not_funded_active"); });
  it("V25: reclaim range and both deadline constraints", async () => {
    for (const over of [{ reclaimAtEarliest: T0 / 1000 + 10001 }, { reclaimAtLatest: T0 / 1000 + 9999 }]) {
      const j = await buyerFundingJob(f, { prepare: over }); await refuses(j, "reclaim_before_deadline");
    }
  });
  it("V26: missing, multiple, above-finalized or noncanonical funding log", async () => {
    for (const logs of [[], [{ blockNumber: FUND, blockHash: hash(900) }, { blockNumber: FUND, blockHash: hash(900) }],
      [{ blockNumber: B.number + 1n, blockHash: hash(1001) }], [{ blockNumber: FUND, blockHash: hash(999) }]]) {
      const j = await buyerFundingJob(f); vi.mocked(j.reads.fundedLogs).mockResolvedValue(logs); await refuses(j, "funding_block_unproven");
    }
  });
  it("V27: pinned read error with canonical B is closed", async () => { const j = await buyerFundingJob(f); vi.mocked(j.reads.call).mockRejectedValueOnce(new Error("private")); await refuses(j, "chain_read_failed"); });
  it("V28: reorg just before commit refuses", async () => {
    const j = await buyerFundingJob(f); vi.mocked(j.reads.blockByNumber).mockImplementation(async n => ({ ...j.block(n), hash: n === B.number ? hash(999) : j.block(n).hash }));
    await refuses(j, "pinned_block_reorged");
  });
  it("V29: production viem transport pins reads and uses created_at F0 and 199-block chunks", async () => {
    const j = await buyerFundingJob(f); const requests: any[] = [];
    __setVNextTransportForTest(fixtureTransport(j, requests));
    const out = await run(j, { reads: createVNextChainReads("https://fixture.invalid/private-path") });
    expect(out.kind).toBe("recorded");
    for (const r of requests.filter(r => r.method === "eth_call" || r.method === "eth_getCode")) expect(r.params[1]).toEqual({ blockHash: B.hash, requireCanonical: true });
    expect(requests.some(r => r.method === "eth_getBlockByNumber" && r.params[0] === "finalized")).toBe(true);
    const logs = requests.filter(r => r.method === "eth_getLogs"); expect(logs.length).toBeGreaterThan(1);
    expect(BigInt(logs[0].params[0].fromBlock)).toBe(F0);
    for (const r of logs) expect(BigInt(r.params[0].toBlock) - BigInt(r.params[0].fromBlock) + 1n).toBeLessThanOrEqual(199n);
  });
  it("T1: throwing reconcile leaves committed funding and row moves", async () => {
    const j = await buyerFundingJob(f); const reconcile = vi.fn(() => {
      expect((db() as any).session.client.inTransaction).toBe(false);
      throw new Error("private reconcile");
    });
    const out = await run(j, { reconcile }); expect(out).toMatchObject({ kind: "recorded", activation: { kind: "reconcile_threw" } });
    expect(fundingCount()).toBe(1); expect(escrowRow(j).status).toBe("funded"); expect(milestoneRows(j).every(m => m.status === "funded")).toBe(true);
    expect(scopeRow(j.scopeId).status).toBe("awaiting_funding"); expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile.mock.results[0].value?.message).toBe("private reconcile");
  });
  it("T2: racing conflicting insert leaves rows created and pending", async () => {
    const j = await buyerFundingJob(f); lastRead(j, () => plant(j, { scopeId: "racer" }));
    expect(await run(j)).toEqual({ kind: "refused", code: "funding_conflict" }); expect(fundingCount()).toBe(1); expect(escrowRow(j).status).toBe("created"); expect(milestoneRows(j).every(m => m.status === "pending")).toBe(true);
  });
  it("T3: escrow/milestone races and compare-and-set counts roll back", async () => {
    for (const which of ["escrow", "milestone"]) { const j = await buyerFundingJob(f); lastRead(j, () => which === "escrow" ? escrow(j, { status: "active" }) : db().update(schema.escrowMilestones).set({ status: "released" }).where(eq(schema.escrowMilestones.escrowId, j.escrowId)).run());
      expect(await run(j)).toEqual({ kind: "refused", code: "escrow_row_not_awaiting" }); expect(fundingCount()).toBe(0); }
    const j = await buyerFundingJob(f);
    escrow(j, { status: "active" });
    expect(() => db().transaction(tx => markBuyerFunded(tx, j.escrowId, milestoneRows(j).length))).toThrow("escrow_row_not_awaiting");
    escrow(j, { status: "created" });
    db().update(schema.escrowMilestones).set({ status: "released" }).where(eq(schema.escrowMilestones.escrowId, j.escrowId)).run();
    expect(() => db().transaction(tx => markBuyerFunded(tx, j.escrowId, milestoneRows(j).length))).toThrow("escrow_row_not_awaiting"); expect(escrowRow(j).status).toBe("created");
  });
  it("T4: scope revoked before commit writes nothing", async () => { const j = await buyerFundingJob(f); lastRead(j, () => scope(j, { status: "revoked" })); await refuses(j, "scope_not_awaiting_funding"); });
  it("T5: racing identical record is duplicate without row moves", async () => { const j = await buyerFundingJob(f); lastRead(j, () => plant(j));
    const reconcile = vi.fn(); expect(await run(j, { reconcile })).toEqual({ kind: "duplicate", record: j.record }); expect(fundingCount()).toBe(1); expect(escrowRow(j).status).toBe("created"); expect(milestoneRows(j).every(m => m.status === "pending")).toBe(true); expect(reconcile).not.toHaveBeenCalled();
  });
  it("T6: the scope's window lapsing between the reads and the commit writes nothing", async () => {
    const j = await buyerFundingJob(f); lastRead(j, () => scope(j, { expiresAt: new Date(T0).toISOString() }));
    await refuses(j, "scope_not_awaiting_funding");
  });
  it("V13b: chainId() throwing before B is chain_read_failed and reads no block", async () => {
    const j = await buyerFundingJob(f); vi.mocked(j.reads.chainId).mockRejectedValueOnce(new Error("private"));
    await refuses(j, "chain_read_failed"); expect(j.calls.some(c => c.method === "finalizedBlock")).toBe(false);
  });
  it("V20b: a prepare whose job_id_hash is not jobIdHashOf(job_id) refuses, though the chain agrees with the prepare", async () => {
    const other = compileVNextPolicy({
      chainId: 84532n, factory: RECORD.factory, implementation: RECORD.implementation, token: RECORD.usdc,
      payer: BUYER, operator: "0x1111111111111111111111111111111111111111", jobIdHash: hash(77),
      termsHash: hash(10), policyNonce: 1n, acceptedPolicyDigest: hash(11), expiry: BigInt(T0 / 1000 + 900), fundingTime: BigInt(T0 / 1000),
      units: [0, 1].map(i => buildUnitConfig({ milestoneIndex: BigInt(i), stepId: hash(20 + i), requiredTier: 0,
        g: 5_000_000n, feeBps: 0, feeRecipient: zeroAddress, reclaimAt: BigInt(T0 / 1000 + 10000), compositionSchemaVersion: 1, compositionRoot: zeroHash,
        payouts: [{ recipient: "0x1111111111111111111111111111111111111111", amount: 5_000_000n }] })),
    });
    const j = await buyerFundingJob(f, { prepare: { jobIdHash: other.identity.jobIdHash, escrow: other.escrow.toLowerCase(),
      prePolicyRoot: other.prePolicyRoot, configs: wire(other.configs), unitIds: wire(other.unitIds), typedDataDigest: other.digest } });
    Object.assign(j.values, { predictEscrow: other.escrow, fundedEscrowOf: other.escrow, jobIdHash: other.identity.jobIdHash,
      policy: [other.identity.operator, 1n, other.prePolicyRoot, other.jobPolicyHash, other.identity.acceptedPolicyDigest] });
    vi.mocked(j.reads.unitConfigs).mockResolvedValue({ ok: true, chainId: 84532, escrow: other.escrow, blockNumber: B.number, blockHash: B.hash,
      prePolicyRoot: other.prePolicyRoot, units: other.unitIds.map((unitId, i) => ({ unitId, config: other.configs[i]! })), checks: [] });
    await refuses(j, "escrow_identity_mismatch");
  });
});

describe("N325 funding search by timestamp", () => {
  const t0 = BigInt(T0 / 1000);
  const fastTimestamp = (n: bigint) => t0 - 1_000_000n + n / 5n;
  function chain(j: FundingJob, height: bigint, funded: bigint, timestamp: (n: bigint) => bigint) {
    const head = { number: height, hash: B.hash, timestamp: timestamp(height) };
    vi.mocked(j.reads.finalizedBlock).mockResolvedValue(head);
    vi.mocked(j.reads.blockByNumber).mockImplementation(async n => n === height
      ? head : { number: n, hash: hash(Number(n)), timestamp: timestamp(n) });
    vi.mocked(j.reads.fundedLogs).mockImplementation(async (_address, from, to) => from <= funded && funded <= to
      ? [{ blockNumber: funded, blockHash: hash(Number(funded)) }] : []);
  }

  it("C1: 200 ms blocks find funding three hours before the finalized head", async () => {
    const j = await buyerFundingJob(f); const height = 5_055_502n;
    chain(j, height, 5_001_502n, fastTimestamp);
    expect(await run(j)).toMatchObject({ kind: "recorded", record: {
      fundingBlockNumber: "5001502", fundingBlockHash: hash(5_001_502), fundedAt: Number(t0 + 300n),
      blockNumber: "5055502", blockHash: B.hash,
    } });
    expect(vi.mocked(j.reads.fundedLogs).mock.calls).toHaveLength(11);
    expect(vi.mocked(j.reads.blockByNumber).mock.calls.length).toBeLessThanOrEqual(height.toString(2).length + 3);
  });

  it("C2: two-second blocks find funding three days after the fixture head", async () => {
    const j = await buyerFundingJob(f);
    chain(j, 130_600n, FUND, n => j.block(n).timestamp);
    expect(await run(j)).toMatchObject({ kind: "recorded", record: {
      fundingBlockNumber: "900", fundedAt: Number(t0 + 400n), blockNumber: "130600",
    } });
    const calls = vi.mocked(j.reads.fundedLogs).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![1]).toBe(640n);
  });

  it("C3: starts at the first block of a repeated threshold second with spans at most 199", async () => {
    const j = await buyerFundingJob(f);
    chain(j, 5_055_502n, 5_001_502n, fastTimestamp);
    expect((await run(j)).kind).toBe("recorded");
    const calls = vi.mocked(j.reads.fundedLogs).mock.calls;
    expect(calls[0]![1]).toBe(4_999_400n);
    for (const [, from, to] of calls) expect(to - from + 1n).toBeLessThanOrEqual(199n);
  });

  it("C4: refuses a within-expiry log beyond the 101-chunk budget", async () => {
    const j = await buyerFundingJob(f); const height = 5_100_000n;
    chain(j, height, 5_017_199n, n => t0 - 200_000n + n / 25n);
    await refuses(j, "funding_block_unproven");
    const calls = vi.mocked(j.reads.fundedLogs).mock.calls;
    expect(calls).toHaveLength(101);
    expect(calls[100]![2]).toBe(5_017_098n);
    expect(vi.mocked(j.reads.blockByNumber).mock.calls.length).toBeLessThanOrEqual(height.toString(2).length + 3);
  });

  it("C5a: includes the last block of the signed expiry second", async () => {
    const j = await buyerFundingJob(f);
    chain(j, 5_055_502n, 5_004_504n, fastTimestamp);
    expect(await run(j)).toMatchObject({ kind: "recorded", record: {
      fundingBlockNumber: "5004504", fundedAt: Number(t0 + 900n),
    } });
    expect(vi.mocked(j.reads.fundedLogs).mock.calls).toHaveLength(26);
  });

  it("C5b: refuses a log block one second past the signed expiry", async () => {
    const j = await buyerFundingJob(f);
    chain(j, 5_055_502n, 5_004_505n, fastTimestamp);
    await refuses(j, "funding_block_unproven");
  });

  it("C6: a finalized head before the threshold reads no blocks or logs", async () => {
    const j = await buyerFundingJob(f);
    chain(j, B.number, FUND, n => n === B.number ? t0 - 121n : j.block(n).timestamp);
    await refuses(j, "funding_block_unproven");
    expect(vi.mocked(j.reads.blockByNumber).mock.calls).toHaveLength(0);
    expect(vi.mocked(j.reads.fundedLogs).mock.calls).toHaveLength(0);
  });

  it("C7: covers the 1,200-second prepare window with a late finalized head", async () => {
    const j = await buyerFundingJob(f, { prepare: { createdAt: new Date(T0 - 300_000).toISOString() } });
    chain(j, 5_040_504n, 5_004_504n, fastTimestamp);
    expect(await run(j)).toMatchObject({ kind: "recorded", record: {
      fundingBlockNumber: "5004504", fundedAt: Number(t0 + 900n),
    } });
    const calls = vi.mocked(j.reads.fundedLogs).mock.calls;
    expect(calls).toHaveLength(34);
    expect(calls[0]![1]).toBe(4_997_900n);
  });

  it("C8: finds the threshold across a switch from two-second to 200 ms blocks", async () => {
    const j = await buyerFundingJob(f);
    chain(j, 1_055_502n, 1_001_502n, n => n < 1_000_000n
      ? t0 - 2n * (1_000_000n - n) : t0 + (n - 1_000_000n) / 5n);
    expect(await run(j)).toMatchObject({ kind: "recorded", record: {
      fundingBlockNumber: "1001502", fundedAt: Number(t0 + 300n),
    } });
    const calls = vi.mocked(j.reads.fundedLogs).mock.calls;
    expect(calls).toHaveLength(8);
    expect(calls[0]![1]).toBe(999_940n);
  });

  it("C9: retries the same job after a replica misses the funding log", async () => {
    const j = await buyerFundingJob(f);
    chain(j, B.number, FUND, n => j.block(n).timestamp);
    let missed = false;
    vi.mocked(j.reads.fundedLogs).mockImplementation(async (_address, from, to) => {
      if (from > FUND || FUND > to) return [];
      if (!missed) { missed = true; return []; }
      return [{ blockNumber: FUND, blockHash: hash(Number(FUND)) }];
    });
    await refuses(j, "funding_block_unproven");
    expect(vi.mocked(j.reads.fundedLogs).mock.calls).toHaveLength(2);
    expect(await run(j)).toMatchObject({ kind: "recorded", record: { fundingBlockNumber: "900" } });
  });

  it("C10: an unfunded prepare refuses before any funding search", async () => {
    const j = await buyerFundingJob(f);
    chain(j, 130_600n, FUND, n => j.block(n).timestamp);
    changePolicy(j, 3, zeroHash);
    vi.mocked(j.reads.fundedLogs).mockResolvedValue([]);
    await refuses(j, "not_funded_at_finalized");
    expect(vi.mocked(j.reads.blockByNumber).mock.calls).toHaveLength(0);
    expect(vi.mocked(j.reads.fundedLogs).mock.calls).toHaveLength(0);
  });

  it("C11: refuses an in-range funding log whose block hash is not canonical", async () => {
    const j = await buyerFundingJob(f);
    vi.mocked(j.reads.fundedLogs).mockImplementation(async (_address, from, to) => from <= FUND && FUND <= to
      ? [{ blockNumber: FUND, blockHash: hash(999) }] : []);
    await refuses(j, "funding_block_unproven");
    expect(vi.mocked(j.reads.blockByNumber).mock.calls.some(([n]) => n === FUND)).toBe(true);
  });

  it("C12: no funding-log query reaches past the finalized head", async () => {
    const j = await buyerFundingJob(f);
    expect((await run(j)).kind).toBe("recorded");
    for (const [, , to] of vi.mocked(j.reads.fundedLogs).mock.calls) expect(to).toBeLessThanOrEqual(B.number);
  });

  it("C13: a glitched bisection on one verify is not carried to the next", async () => {
    const j = await buyerFundingJob(f); let glitch = true;
    vi.mocked(j.reads.blockByNumber).mockImplementation(async n => glitch && n !== B.number && n <= 950n
      ? { ...j.block(n), timestamp: t0 - 10_000n } : j.block(n));
    await refuses(j, "funding_block_unproven");
    glitch = false;
    expect(await run(j)).toMatchObject({ kind: "recorded", record: { fundingBlockNumber: "900" } });
  });
});
