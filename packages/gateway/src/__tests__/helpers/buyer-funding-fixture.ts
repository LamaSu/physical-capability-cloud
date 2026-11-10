/** Hermetic buyer funding rows and chain state. No wallet or network is used. */
import { vi } from "vitest";
import { eq, schema } from "@pcc/store";
import { compileVNextPolicy, buildUnitConfig, jobIdHashOf, payoutConfigHash, type UnitConfig } from "@pcc/contracts/vnext";
import { custom, decodeFunctionData, encodeFunctionResult, encodeEventTopics, encodeAbiParameters, parseAbi, toHex, zeroAddress, zeroHash, type Hex } from "viem";
import { VNextSettlementEscrowABI, VNextSettlementEscrowFactoryABI } from "@pcc/contracts/vnext";
import { BUYER_FUNDED_ESCROW_VERSION } from "../../services/buyer-funded-escrow.js";
import type { VNextChainReads } from "../../services/vnext-rpc-client.js";
import { VNEXT_SCHEDULE_TUPLES, type VNextDeploymentRecord } from "../../services/paid-scope-activation-terms.js";
import { __setFundingRecordStoreForTest, type FundingVerificationRecord } from "../../services/funding-record-port.js";
import { SqliteFundingRecordStore } from "../../services/sqlite-funding-record-store.js";
import { getRepos } from "../../db.js";
import { BUYER, T0, TERMS, db, submit, scopeRow, acceptScope, installActivationTerms, type Fixture } from "./paid-scope-fixture.js";

export const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
export const WRONG = "0x7777777777777777777777777777777777777777";
export const RECORD: VNextDeploymentRecord = {
  ...VNEXT_SCHEDULE_TUPLES[0]!, chainId: 84532,
  factory: "0x2222222222222222222222222222222222222222",
  implementation: "0x3333333333333333333333333333333333333333",
  usdc: "0x036cbd53842c5426634e7929541ec2318f3dcf7e", recordSha256: "ab".repeat(32),
};
export const B = { number: 1000n, hash: hash(1000), timestamp: BigInt(T0 / 1000 + 600) };
export const F0 = 640n;
export const FUND = 900n;
export type Prepare = typeof schema.fundingPrepares.$inferInsert;
export const wire = (v: unknown): string => JSON.stringify(v, (_, x) => typeof x === "bigint" ? x.toString() : x);
export function installBuyerFunding() {
  vi.stubEnv("PCC_VNEXT_TESTNET_BUYERS", BUYER);
  const store = new SqliteFundingRecordStore();
  __setFundingRecordStoreForTest(store);
  installActivationTerms({ ...TERMS, testnetOnly: true });
  return store;
}
export async function buyerFundingJob(f: Fixture, opts: {
  prepare?: Partial<Prepare>; accept?: boolean; buyer?: `0x${string}`; auto?: boolean;
} = {}) {
  const buyer = opts.buyer ?? BUYER;
  const response = await submit(f, buyer);
  if (response.statusCode !== 201) throw new Error(`fixture submit ${response.statusCode}: ${response.body}`);
  const { scopeId, jobId, escrowId } = response.json();
  const compiled = compileVNextPolicy({
    chainId: 84532n, factory: RECORD.factory, implementation: RECORD.implementation, token: RECORD.usdc,
    payer: buyer, operator: "0x1111111111111111111111111111111111111111", jobIdHash: jobIdHashOf(jobId),
    termsHash: hash(10), policyNonce: 1n, acceptedPolicyDigest: hash(11), expiry: BigInt(T0 / 1000 + 900), fundingTime: BigInt(T0 / 1000),
    units: [0, 1].map(i => buildUnitConfig({ milestoneIndex: BigInt(i), stepId: hash(20 + i), requiredTier: 0,
      g: 5_000_000n, feeBps: 0, feeRecipient: zeroAddress, reclaimAt: BigInt(T0 / 1000 + 10000),
      compositionSchemaVersion: 1, compositionRoot: zeroHash,
      payouts: [{ recipient: "0x1111111111111111111111111111111111111111", amount: 5_000_000n }],
    })),
  });
  const p: Prepare = {
    id: `prepare-${scopeId}`, scopeId, jobId, jobIdHash: compiled.identity.jobIdHash,
    chainId: RECORD.chainId, escrow: compiled.escrow.toLowerCase(), s01RecordSha256: RECORD.recordSha256,
    s01ScheduleId: RECORD.scheduleId, s01ScheduleTestnetOnly: 1,
    factory: RECORD.factory, implementation: RECORD.implementation, usdc: RECORD.usdc, payer: buyer,
    operator: compiled.identity.operator, termsHash: compiled.identity.termsHash, policyNonce: "1",
    prePolicyRoot: compiled.prePolicyRoot, acceptedPolicyDigest: compiled.identity.acceptedPolicyDigest,
    totalGross: compiled.totalGross.toString(), quoteSnapshot: "{}", configs: wire(compiled.configs), unitIds: wire(compiled.unitIds),
    expiry: Number(compiled.expiry), scopeExpiresAt: scopeRow(scopeId).expiresAt,
    finalityFS: 120, marginMS: 300, reclaimAtEarliest: T0 / 1000 + 9900, reclaimAtLatest: T0 / 1000 + 10100,
    reconcileUntil: T0 / 1000 + 3600, typedDataDigest: compiled.digest, operatorSignature: "0x1234",
    signatureVerifiedAt: new Date(T0).toISOString(), signedAt: new Date(T0 - 600_000).toISOString(),
    servedPayload: Buffer.from("fixture"), servedPayloadSha256: "cd".repeat(32), state: "served", createdAt: new Date(T0).toISOString(),
    ...opts.prepare,
  };
  db().update(schema.escrows).set({ contractAddress: p.escrow, version: BUYER_FUNDED_ESCROW_VERSION, status: "created" })
    .where(eq(schema.escrows.id, escrowId)).run();
  let milestones = getRepos().escrows.findMilestonesByEscrow(escrowId);
  if (!milestones.length) getRepos().escrows.insertMilestone({ id: `ms-${escrowId}`, escrowId, stepId: "step-1", amount: "10", status: "pending", bondAmount: "0" });
  db().update(schema.escrowMilestones).set({ status: "pending" }).where(eq(schema.escrowMilestones.escrowId, escrowId)).run();
  db().insert(schema.fundingPrepares).values(p).run();
  if (opts.accept !== false && scopeRow(scopeId).status === "awaiting_acceptance") {
    const accepted = await acceptScope(f, scopeId);
    if (accepted.statusCode !== 200) throw new Error(`fixture accept ${accepted.statusCode}: ${accepted.body}`);
  }
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const values: Record<string, unknown> = {
    implementation: RECORD.implementation, predictEscrow: compiled.escrow, factory: RECORD.factory,
    payer: buyer, operator: compiled.identity.operator, USDC: RECORD.usdc,
    policy: [compiled.identity.operator, 1n, compiled.prePolicyRoot, compiled.jobPolicyHash, compiled.identity.acceptedPolicyDigest],
    jobIdHash: compiled.identity.jobIdHash, termsHash: compiled.identity.termsHash, fundedEscrowOf: compiled.escrow, unitState: 1,
  };
  const block = (n: bigint) => ({ number: n, hash: hash(Number(n)), timestamp: B.timestamp - (B.number - n) * 2n });
  const reads: VNextChainReads = {
    chainId: vi.fn(async () => { calls.push({ method: "chainId", args: [] }); return 84532; }),
    finalizedBlock: vi.fn(async () => { calls.push({ method: "finalizedBlock", args: [] }); return B; }),
    blockByNumber: vi.fn(async n => { calls.push({ method: "blockByNumber", args: [n] }); return block(n); }),
    code: vi.fn(async (...args) => { calls.push({ method: "code", args }); return "0x6000"; }),
    call: vi.fn(async (address, abi, method, args, pin) => { calls.push({ method, args: [address, args, pin] }); return values[method]; }),
    unitConfigs: vi.fn(async (...args) => { calls.push({ method: "unitConfigs", args }); return { ok: true, chainId: 84532, escrow: compiled.escrow, blockNumber: B.number,
      blockHash: B.hash, prePolicyRoot: compiled.prePolicyRoot, units: compiled.unitIds.map((unitId, i) => ({ unitId, config: compiled.configs[i]! })), checks: [] }; }),
    fundedLogs: vi.fn(async (address, from, to) => { calls.push({ method: "fundedLogs", args: [address, from, to] });
      return from <= FUND && to >= FUND ? [{ blockNumber: FUND, blockHash: hash(Number(FUND)) }] : []; }),
  };
  const target = { chainId: p.chainId, escrow: p.escrow };
  const deps = { reads, record: RECORD, now: () => new Date(), gatewaySigner: () => null };
  const record: FundingVerificationRecord = { scopeId, escrowAddress: p.escrow, buyer, operator: compiled.identity.operator,
    chainId: 84532, blockNumber: B.number.toString(), blockHash: B.hash, fundingBlockNumber: FUND.toString(),
    fundingBlockHash: hash(Number(FUND)), fundedAt: Number(block(FUND).timestamp),
    verifierVersion: "pcc-gateway/buyer-funding-verifier/1", verifiedAt: new Date().toISOString(), finality: "finalized" };
  return { scopeId, jobId, escrowId, p, compiled, reads, values, calls, target, deps, record, block };
}
export type FundingJob = Awaited<ReturnType<typeof buyerFundingJob>>;
export const fundingCount = () => db().select().from(schema.escrowFunding).all().length;
export const escrowRow = (j: FundingJob) => getRepos().escrows.findById(j.escrowId)!;
export const milestoneRows = (j: FundingJob) => getRepos().escrows.findMilestonesByEscrow(j.escrowId);
export function plant(j: FundingJob, over: Partial<FundingVerificationRecord> = {}) {
  db().transaction(tx => new SqliteFundingRecordStore().insert(tx, { ...j.record, ...over }));
}

/** A viem transport serving the same state, including readUnitConfigs' reconstruction. */
export function fixtureTransport(j: FundingJob, requests: Array<{ method: string; params: any[] }>) {
  const extra = parseAbi([
    "function requiredTierOf(bytes32 id) view returns (uint8)", "function feeBpsOf(bytes32 id) view returns (uint16)",
    "function feeRecipientOf(bytes32 id) view returns (address)", "function feeAmountsOf(bytes32 id) view returns (uint256,uint256,uint256)",
    "function compositionRootOf(bytes32 id) view returns (bytes32)", "function unitCounters(bytes32 id) view returns (uint256,uint256,uint256)",
  ]);
  const abi = [...VNextSettlementEscrowABI, ...VNextSettlementEscrowFactoryABI, ...extra];
  return custom({ request: async ({ method, params = [] }: any) => {
    requests.push({ method, params });
    if (method === "eth_chainId") return toHex(84532);
    if (method === "eth_getCode") return "0x6000";
    if (method === "eth_getBlockByNumber") {
      const b = params[0] === "finalized" ? B : j.block(BigInt(params[0]));
      return { number: toHex(b.number), hash: b.hash, timestamp: toHex(b.timestamp), transactions: [] };
    }
    if (method === "eth_getLogs") {
      const from = BigInt(params[0].fromBlock), to = BigInt(params[0].toBlock);
      return from <= FUND && to >= FUND ? [{ address: j.p.escrow, blockNumber: toHex(FUND), blockHash: hash(Number(FUND)),
        transactionHash: hash(99), transactionIndex: "0x0", logIndex: "0x0", removed: false,
        topics: encodeEventTopics({ abi: VNextSettlementEscrowABI, eventName: "Funded" }),
        data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [2n, j.compiled.totalGross, 2n]) }] : [];
    }
    if (method !== "eth_call") throw new Error("unexpected fixture method");
    const decoded = decodeFunctionData({ abi, data: params[0].data });
    const name = decoded.functionName, args = decoded.args as any[];
    const index = Math.max(0, j.compiled.unitIds.indexOf(args?.[0]));
    const c: UnitConfig = j.compiled.configs[index]!;
    const reconstructed: Record<string, unknown> = {
      unitCount: 2n, unitIdAt: j.compiled.unitIds[Number(args?.[0] ?? 0)],
      unitTerms: [c.milestoneIndex, c.stepId, c.requestedTier, c.reclaimAt, payoutConfigHash(j.compiled.unitIds[index]!, c.payouts), c.compositionSchemaVersion, false],
      requiredTierOf: c.requiredTier, feeBpsOf: c.feeBps, feeRecipientOf: c.feeRecipient, feeAmountsOf: [c.g, c.f, c.n],
      compositionRootOf: c.compositionRoot, unitCounters: [c.g, 1n, 0n], payoutAt: [c.payouts[0]!.recipient, c.payouts[0]!.amount],
    };
    return encodeFunctionResult({ abi, functionName: name, result: (name in j.values ? j.values[name] : reconstructed[name]) as never });
  } }, { retryCount: 0 });
}
