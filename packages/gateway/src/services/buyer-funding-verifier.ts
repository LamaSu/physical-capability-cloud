/** Finalized, read-only proof of a buyer's funding, followed by one atomic local commit. */
import { and, eq, schema } from "@pcc/store";
import { isAddress, zeroHash, type Address, type Hex } from "viem";
import {
  VNextSettlementEscrowABI, VNextSettlementEscrowFactoryABI,
  predictEscrow, policySalt, policyKey, jobPolicyHash, unitsRoot, settlementUnitId, jobIdHashOf,
  type UnitConfig, type PolicyIdentity,
} from "@pcc/contracts/vnext";
import { CIRCLE_USDC } from "@pcc/spec/funding";
import { getStore } from "../db.js";
import { getSignerAddress } from "../contracts/escrow-client.js";
import { sameIdentity } from "../auth/buyer-identity.js";
import { BUYER_FUNDED_ESCROW_VERSION, isBuyerFundedEscrowRow } from "./buyer-funded-escrow.js";
import { fundingRecordStore, sameAddress, isWellFormedFundingRecord, type FundingTx, type FundingDbHandle, type FundingVerificationRecord } from "./funding-record-port.js";
import { configuredVNextDeploymentRecord, paidScopeActivationTerms, type VNextDeploymentRecord } from "./paid-scope-activation-terms.js";
import { reconcilePaidScope, type ReconcileResult } from "./reconcile-paid-scope.js";
import { testnetBuyerAllowance, testnetBuyerRefusal } from "./funding-binding.js";
import { scopeExpiryMs } from "./scope-expiry.js";
import type { VNextBlock, VNextChainReads } from "./vnext-rpc-client.js";

export const BUYER_FUNDING_VERIFIER_VERSION = "pcc-gateway/buyer-funding-verifier/1";
export const BUYER_FUNDING_VERIFY_CODES = Object.freeze([
  "funding_record_store_unavailable", "deployment_record_unavailable", "prepare_not_found", "funding_conflict",
  "prepare_inconsistent", "prepare_not_record", "token_not_circle_usdc", "prepare_not_scope", "scope_not_awaiting_funding",
  "escrow_row_not_prepare", "testnet_buyer_not_allowed", "rpc_unavailable", "rpc_chain_mismatch", "finalized_block_unavailable",
  "pinned_block_unaddressable", "escrow_not_predicted", "payer_not_buyer", "payer_is_gateway_signer", "operator_not_prepared",
  "token_not_pinned", "not_funded_at_finalized", "funded_under_other_policy", "escrow_identity_mismatch", "finalized_block_moved",
  "unit_configs_unverified", "total_gross_not_quote", "factory_not_witness", "unit_not_funded_active", "reclaim_before_deadline",
  "funding_block_unproven", "chain_read_failed", "pinned_block_reorged", "escrow_row_not_awaiting", "commit_failed",
] as const);
export type BuyerFundingVerifyCode = typeof BUYER_FUNDING_VERIFY_CODES[number];
export type BuyerFundingOutcome =
  | { kind: "recorded"; record: FundingVerificationRecord; activation: ReconcileResult | { kind: "reconcile_threw" } }
  | { kind: "duplicate"; record: FundingVerificationRecord }
  | { kind: "refused"; code: BuyerFundingVerifyCode };
export interface BuyerFundingVerifierDeps {
  reads?: VNextChainReads;
  record?: VNextDeploymentRecord | null;
  now?: () => Date;
  reconcile?: typeof reconcilePaidScope;
  gatewaySigner?: () => string | null | undefined;
}
const refused = (code: BuyerFundingVerifyCode): BuyerFundingOutcome => ({ kind: "refused", code });
const { fundingPrepares, executionScopes, escrows, escrowMilestones, negotiationSessions } = schema;
const bytes32 = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
const uint = (v: unknown): bigint => {
  if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(v) || BigInt(v) >= (1n << 256n)) throw new Error("prepare_inconsistent");
  return BigInt(v);
};
function small(v: unknown, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max) throw new Error("prepare_inconsistent");
  return v;
}
function address(v: unknown): Address {
  if (typeof v !== "string" || !isAddress(v, { strict: true })) throw new Error("prepare_inconsistent");
  return v;
}
function hex(v: unknown): Hex { if (!bytes32(v)) throw new Error("prepare_inconsistent"); return v; }
function obj(v: unknown, keys: string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== keys.length || !keys.every(k => Object.hasOwn(v, k))) throw new Error("prepare_inconsistent");
  return v as Record<string, unknown>;
}
function array(v: unknown, max: number): unknown[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > max) throw new Error("prepare_inconsistent");
  return v;
}
function parseConfigs(raw: string): UnitConfig[] {
  return array(JSON.parse(raw), 16).map(v => {
    const c = obj(v, ["milestoneIndex", "stepId", "requiredTier", "requestedTier", "g", "f", "n", "feeBps", "feeRecipient", "reclaimAt", "compositionSchemaVersion", "compositionRoot", "payouts"]);
    return {
      milestoneIndex: uint(c.milestoneIndex), stepId: hex(c.stepId), requiredTier: small(c.requiredTier, 255), requestedTier: small(c.requestedTier, 255),
      g: uint(c.g), f: uint(c.f), n: uint(c.n), feeBps: small(c.feeBps, 65535), feeRecipient: address(c.feeRecipient), reclaimAt: uint(c.reclaimAt),
      compositionSchemaVersion: small(c.compositionSchemaVersion, 65535), compositionRoot: hex(c.compositionRoot),
      payouts: array(c.payouts, 16).map(v => { const p = obj(v, ["recipient", "amount"]); return { recipient: address(p.recipient), amount: uint(p.amount) }; }),
    };
  });
}
function equalConfig(a: UnitConfig, b: UnitConfig): boolean {
  const keys = ["milestoneIndex", "stepId", "requiredTier", "requestedTier", "g", "f", "n", "feeBps", "feeRecipient", "reclaimAt", "compositionSchemaVersion", "compositionRoot"] as const;
  return keys.every(k => String(a[k]).toLowerCase() === String(b[k]).toLowerCase())
    && a.payouts.length === b.payouts.length && a.payouts.every((p, i) => sameAddress(p.recipient, b.payouts[i]?.recipient) && p.amount === b.payouts[i]?.amount);
}
function escrowForJob(handle: FundingDbHandle, jobId: string | null) {
  if (!jobId) return undefined;
  const session = handle.select().from(negotiationSessions).where(eq(negotiationSessions.jobId, jobId)).get();
  return session?.cwmId ? handle.select().from(escrows).where(eq(escrows.cwmId, session.cwmId)).get() : undefined;
}
class RowNotAwaiting extends Error { constructor() { super("escrow_row_not_awaiting"); } }
/** Both compare-and-sets use the caller's transaction. A wrong count aborts the entire commit. */
export function markBuyerFunded(tx: FundingTx, escrowId: string, milestoneCount: number): void {
  const moved = tx.update(escrows).set({ status: "funded" }).where(and(
    eq(escrows.id, escrowId), eq(escrows.status, "created"), eq(escrows.version, BUYER_FUNDED_ESCROW_VERSION),
  )).run();
  if (moved.changes !== 1) throw new RowNotAwaiting();
  const milestones = tx.update(escrowMilestones).set({ status: "funded" }).where(and(
    eq(escrowMilestones.escrowId, escrowId), eq(escrowMilestones.status, "pending"),
  )).run();
  if (milestones.changes !== milestoneCount) throw new RowNotAwaiting();
}

/** Find the first block at created_at minus skew, then locate the one Funded event in bounded chunks. */
async function fundingBlock(reads: VNextChainReads, escrow: Address, createdMs: number, b: VNextBlock): Promise<VNextBlock | null> {
  const threshold = BigInt(Math.ceil(createdMs / 1000) - 120);
  let low = b.number > 20_000n ? b.number - 20_000n : 0n;
  let high = b.number;
  const lowest = await reads.blockByNumber(low);
  if (lowest.timestamp > threshold || b.timestamp < threshold) return null;
  while (low < high) {
    const mid = (low + high) / 2n;
    if ((await reads.blockByNumber(mid)).timestamp >= threshold) high = mid;
    else low = mid + 1n;
  }
  if (b.number - low + 1n > 20_000n) return null;
  for (let from = low; from <= b.number; from += 199n) {
    const to = from + 198n < b.number ? from + 198n : b.number;
    const logs = await reads.fundedLogs(escrow, from, to);
    if (!logs.length) continue;
    if (logs.length !== 1) return null;
    const log = logs[0]!;
    if (log.blockNumber < from || log.blockNumber > to || log.blockNumber > b.number) return null;
    const block = await reads.blockByNumber(log.blockNumber);
    return block.hash === log.blockHash ? block : null;
  }
  return null;
}

export async function verifyBuyerFunding(target: { chainId: number; escrow: string }, deps: BuyerFundingVerifierDeps = {}): Promise<BuyerFundingOutcome> {
  const store = fundingRecordStore();
  if (!store) return refused("funding_record_store_unavailable");
  const deployment = deps.record === undefined ? configuredVNextDeploymentRecord() : deps.record;
  if (!deployment) return refused("deployment_record_unavailable");
  const db = getStore().db;
  const p = db.select().from(fundingPrepares).where(and(eq(fundingPrepares.chainId, target.chainId), eq(fundingPrepares.escrow, target.escrow.toLowerCase()))).get();
  if (!p || (p.state !== "served" && p.state !== "expired")) return refused("prepare_not_found");
  const kept = store.findByEscrow(db, target.chainId, p.escrow);
  if (kept?.scopeId === p.scopeId) return { kind: "duplicate", record: kept };
  if (kept || store.findByScope(db, p.scopeId)) return refused("funding_conflict");
  let configs: UnitConfig[], ids: Hex[], createdMs: number;
  let identity: PolicyIdentity;
  try {
    configs = parseConfigs(p.configs);
    ids = array(JSON.parse(p.unitIds), 16).map(hex);
    createdMs = Date.parse(p.createdAt);
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(p.createdAt) || !Number.isFinite(createdMs)) throw new Error("prepare_inconsistent");
    identity = { payer: address(p.payer), operator: address(p.operator), jobIdHash: hex(p.jobIdHash), termsHash: hex(p.termsHash),
      policyNonce: uint(p.policyNonce), prePolicyRoot: hex(p.prePolicyRoot), acceptedPolicyDigest: hex(p.acceptedPolicyDigest) };
    uint(p.totalGross);
  } catch { return refused("prepare_inconsistent"); }
  if (p.chainId !== deployment.chainId || !sameAddress(p.factory, deployment.factory) || !sameAddress(p.implementation, deployment.implementation)
    || !sameAddress(p.usdc, deployment.usdc) || p.s01RecordSha256 !== deployment.recordSha256 || p.s01ScheduleId !== deployment.scheduleId
    || p.s01ScheduleTestnetOnly !== Number(deployment.scheduleTestnetOnly)) return refused("prepare_not_record");
  const circle = CIRCLE_USDC[String(deployment.chainId)];
  if (circle && !sameAddress(p.usdc, circle)) return refused("token_not_circle_usdc");
  const s = db.select().from(executionScopes).where(eq(executionScopes.id, p.scopeId)).get();
  if (!s || p.jobId !== s.jobId || !sameIdentity(p.payer, s.createdBy)) return refused("prepare_not_scope");
  const now = deps.now ?? (() => new Date());
  if (s.status !== "awaiting_funding" || scopeExpiryMs(s.expiresAt) <= now().getTime()) return refused("scope_not_awaiting_funding");
  const e = escrowForJob(db, s.jobId);
  if (!e || !isBuyerFundedEscrowRow(e) || !sameAddress(e.contractAddress, p.escrow) || !sameIdentity(e.payer, s.createdBy) || e.status !== "created") return refused("escrow_row_not_prepare");
  if (testnetBuyerRefusal({ buyer: p.payer } as FundingVerificationRecord, testnetBuyerAllowance({ testnetOnly: deployment.scheduleTestnetOnly }))) return refused("testnet_buyer_not_allowed");
  const reads = deps.reads;
  if (!reads) return refused("rpc_unavailable");
  try { if (await reads.chainId() !== deployment.chainId) return refused("rpc_chain_mismatch"); }
  catch { return refused("chain_read_failed"); }
  let b: VNextBlock;
  try {
    b = await reads.finalizedBlock();
    if (typeof b.number !== "bigint" || !bytes32(b.hash)) return refused("finalized_block_unavailable");
  } catch { return refused("finalized_block_unavailable"); }
  const factory = p.factory as Address, escrow = p.escrow as Address;
  try { await reads.code(factory, b.hash); }
  catch { return refused("pinned_block_unaddressable"); }
  const callFactory = (name: string, args: readonly unknown[] = []) => reads.call(factory, VNextSettlementEscrowFactoryABI, name, args, b.hash);
  const callEscrow = (name: string, args: readonly unknown[] = []) => reads.call(escrow, VNextSettlementEscrowABI, name, args, b.hash);
  try {
    const implementation = await callFactory("implementation");
    const predicted = await callFactory("predictEscrow", [identity]);
    const purePrediction = predictEscrow({ factory, implementation: p.implementation as Address, salt: policySalt(identity) });
    const code = await reads.code(escrow, b.hash);
    const escrowFactory = await callEscrow("factory");
    if (!sameAddress(implementation, p.implementation) || !sameAddress(predicted, escrow) || !sameAddress(purePrediction, escrow) || code === "0x" || !sameAddress(escrowFactory, factory)) return refused("escrow_not_predicted");
    const payer = await callEscrow("payer");
    if (!sameAddress(payer, p.payer)) return refused("payer_not_buyer");
    const signer = (deps.gatewaySigner ?? getSignerAddress)();
    if (signer && sameAddress(payer, signer)) return refused("payer_is_gateway_signer");
    const operator = await callEscrow("operator");
    const policy = await callEscrow("policy") as readonly [Address, bigint, Hex, Hex, Hex];
    if (!sameAddress(operator, p.operator) || !sameAddress(policy[0], p.operator)) return refused("operator_not_prepared");
    if (!sameAddress(await callEscrow("USDC"), p.usdc)) return refused("token_not_pinned");
    if (policy[3] === zeroHash) return refused("not_funded_at_finalized");
    const expectedPolicy = jobPolicyHash({ ...identity, chainId: BigInt(p.chainId), factory, implementation: p.implementation as Address,
      escrow, unitsRoot: unitsRoot(ids), expiry: BigInt(p.expiry) });
    if (policy[3] !== expectedPolicy) return refused("funded_under_other_policy");
    if (policy[1] !== identity.policyNonce || policy[2] !== p.prePolicyRoot || policy[4] !== p.acceptedPolicyDigest
      || await callEscrow("jobIdHash") !== p.jobIdHash || await callEscrow("termsHash") !== p.termsHash
      || jobIdHashOf(p.jobId) !== p.jobIdHash) return refused("escrow_identity_mismatch");
    const units = await reads.unitConfigs(escrow, b.number);
    if (units.blockHash !== b.hash) return refused("finalized_block_moved");
    if (!units.ok || units.prePolicyRoot !== p.prePolicyRoot || units.units.length !== ids.length || configs.length !== ids.length
      || !units.units.every((u, i) => u.unitId === ids[i] && equalConfig(u.config, configs[i]!)
        && settlementUnitId({ chainId: BigInt(p.chainId), escrow, jobIdHash: identity.jobIdHash, milestoneIndex: u.config.milestoneIndex, stepId: u.config.stepId }) === ids[i])) return refused("unit_configs_unverified");
    if (units.units.reduce((sum, u) => sum + u.config.g, 0n) !== BigInt(p.totalGross)) return refused("total_gross_not_quote");
    if (!sameAddress(await callFactory("fundedEscrowOf", [policyKey(identity.payer, identity.operator, identity.jobIdHash)]), escrow)) return refused("factory_not_witness");
    for (const id of ids) if (await callEscrow("unitState", [id]) !== 1) return refused("unit_not_funded_active");
    if (!units.units.every(({ config: c }) => c.reclaimAt >= BigInt(p.reclaimAtEarliest) && c.reclaimAt <= BigInt(p.reclaimAtLatest)
      && BigInt(p.reconcileUntil) + BigInt(p.finalityFS) <= c.reclaimAt
      && (p.s01ScheduleTestnetOnly === 1 || BigInt(p.reconcileUntil) <= c.reclaimAt - 777600n))) return refused("reclaim_before_deadline");
    const funded = await fundingBlock(reads, escrow, createdMs, b);
    if (!funded) return refused("funding_block_unproven");
    if ((await reads.blockByNumber(b.number)).hash !== b.hash) return refused("pinned_block_reorged");
    if (await reads.chainId() !== deployment.chainId) return refused("rpc_chain_mismatch");
    const record: FundingVerificationRecord = {
      scopeId: p.scopeId, escrowAddress: p.escrow, buyer: (payer as string).toLowerCase(), operator: (operator as string).toLowerCase(), chainId: deployment.chainId,
      blockNumber: b.number.toString(), blockHash: b.hash, fundingBlockNumber: funded.number.toString(), fundingBlockHash: funded.hash,
      fundedAt: Number(funded.timestamp), verifierVersion: BUYER_FUNDING_VERIFIER_VERSION, verifiedAt: now().toISOString(), finality: "finalized",
    };
    if (!isWellFormedFundingRecord(record)) return refused("funding_block_unproven");
    let commit: BuyerFundingOutcome | null;
    try {
      commit = db.transaction(tx => {
        const fresh = tx.select().from(executionScopes).where(eq(executionScopes.id, s.id)).get();
        if (!fresh || fresh.status !== "awaiting_funding" || scopeExpiryMs(fresh.expiresAt) <= now().getTime()) return refused("scope_not_awaiting_funding");
        const row = escrowForJob(tx, fresh.jobId);
        if (!row || row.id !== e.id || !isBuyerFundedEscrowRow(row) || row.status !== "created" || !sameAddress(row.contractAddress, escrow)
          || !sameIdentity(row.payer, fresh.createdBy) || !sameIdentity(fresh.createdBy, s.createdBy)) return refused("escrow_row_not_awaiting");
        const milestones = tx.select().from(escrowMilestones).where(eq(escrowMilestones.escrowId, row.id)).all();
        if (!milestones.length || milestones.some(m => m.status !== "pending")) return refused("escrow_row_not_awaiting");
        const forEscrow = store.findByEscrow(tx, deployment.chainId, escrow);
        const forScope = store.findByScope(tx, s.id);
        if (forEscrow?.scopeId === s.id && (!forScope || (forScope.chainId === deployment.chainId && sameAddress(forScope.escrowAddress, escrow)))) return { kind: "duplicate", record: forEscrow } as BuyerFundingOutcome;
        if (forEscrow || forScope) return refused("funding_conflict");
        store.insert(tx, record);
        markBuyerFunded(tx, row.id, milestones.length);
        return null;
      }, { behavior: "immediate" });
    } catch (error) {
      if (error instanceof RowNotAwaiting) return refused("escrow_row_not_awaiting");
      // SQLite exposes stable constraint codes; diagnostic text never crosses this boundary.
      const code = (error as { code?: string })?.code;
      if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_TRIGGER" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") return refused("funding_conflict");
      return refused("commit_failed");
    }
    if (commit) return commit;
    let activation: ReconcileResult | { kind: "reconcile_threw" };
    try { activation = (deps.reconcile ?? reconcilePaidScope)(s.id, record, paidScopeActivationTerms(s)); }
    catch { activation = { kind: "reconcile_threw" }; }
    return { kind: "recorded", record, activation };
  } catch {
    try { if ((await reads.blockByNumber(b.number)).hash !== b.hash) return refused("pinned_block_reorged"); }
    catch { /* No canonical block can be established. Fail closed without RPC details. */ }
    return refused("chain_read_failed");
  }
}
