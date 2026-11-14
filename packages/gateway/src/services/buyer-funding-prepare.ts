/** Buyer-selected funding freezes one policy before the operator signs it. */
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { schema, eq, and, sql } from "@pcc/store";
import { computeTermsHash, computeAcceptedPolicyDigest, computeSubjectBlockHash, computeBindingsRoot } from "@pcc/spec";
import { DEFAULT_MARGIN_SECONDS, DRY_RUN_UNIT_TESTNET_V1, dryRunUnitPrincipalWord, FUNDING_PREPARE_SCHEMA } from "@pcc/spec/funding";
import { buildUnitConfig, compileVNextPolicy, jobIdHashOf, jobPolicyTypedData, unitsRoot, VNextCompileError,
  VNextSettlementEscrowABI, VNextSettlementEscrowFactoryABI, type UnitConfig } from "@pcc/contracts/vnext";
import { getAddress, hexToBigInt, keccak256, parseUnits, recoverAddress, stringToHex, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { getStore } from "../db.js";
import { getSignerAddress } from "../contracts/escrow-client.js";
import { emergencyStopState } from "../routes/device-relay.js";
import { BUYER_FUNDED_ESCROW_VERSION } from "./buyer-funded-escrow.js";
import { configuredVNextDeploymentRecord, type VNextDeploymentRecord } from "./paid-scope-activation-terms.js";
import { createVNextChainReads, vnextRpcUrl, type VNextPrepareReads } from "./vnext-rpc-client.js";
import { testnetBuyerAllowance, testnetBuyerRefusal } from "./funding-binding.js";
import { isTestProcess } from "./settlement-mode.js";
import { escrowForJob, SCOPE_AWAITING_FUNDING } from "./scope-acceptance.js";
import { scopeExpiryMs } from "./scope-expiry.js";
import { MAX_POST_ACTIVATION_TTL_MS } from "./reconcile-paid-scope.js";

export const BUYER_FUNDING_POLICY_KEY = "vnextBuyerFunding";
export const DRY_RUN_UNIT_ID = "dry-run-unit-testnet-v1";
export const PREPARE_PENDING_SCHEMA = "pcc.vnext.buyer-funding.pending.v1";
export const PREPARE_RETRY_AFTER_SECONDS = 5;
export const PREPARE_BUYER_SECONDS = 300n;
export const PREPARE_MARGIN_SECONDS = 300n;
export const SERVE_MARGIN_SECONDS = DEFAULT_MARGIN_SECONDS + PREPARE_BUYER_SECONDS;
export const CHAIN_CLOCK_LAG_MAX_SECONDS = 120n;
export const CHAIN_CLOCK_LEAD_MAX_SECONDS = 2640n;

/** Refusals in prepareBuyerFunding's check order. */
export const BUYER_FUNDING_PREPARE_REFUSALS = [
  /** The configured deployment or RPC is unavailable. */
  "buyer_funding_unavailable",
  /** The execution scope does not exist. */
  "scope_not_found",
  /** The frozen prepare's serving window ended. */
  "prepare_expired",
  /** The kernel policy or stop cannot be read. */
  "policy_unavailable",
  /** The policy or job does not select an unfunded unit. */
  "buyer_funding_not_selected",
  /** The operator has not left the scope awaiting funding. */
  "scope_not_awaiting_funding",
  /** The scope's acceptance window ended. */
  "scope_expired",
  /** The kernel's emergency stop is engaged. */
  "kernel_emergency_stopped",
  /** The buyer is not a wallet address. */
  "buyer_not_wallet",
  /** The testnet record does not allow this buyer. */
  "testnet_buyer_not_allowed",
  /** The operator cannot sign and receive this policy. */
  "operator_unusable",
  /** The quote is not the unit's gross USDC amount. */
  "total_gross_not_quote",
  /** The quoted milestones do not match the unit. */
  "milestones_not_quote",
  /** The job's tier does not match the unit. */
  "tier_not_quote",
  /** The deployment record does not name the selected unit's network. */
  "unit_needs_testnet_record",
  /** A chain read failed. */
  "rpc_unavailable",
  /** The RPC chain differs from the record. */
  "rpc_chain_mismatch",
  /** The chain clock exceeds the verifier's search bounds. */
  "chain_clock_skew",
  /** The deployed factory, implementation or token differs from the record. */
  "deployment_mismatch",
  /** Too little time remains to sign and fund. */
  "window_too_short",
  /** The reclaim timing exceeds the record's window. */
  "reclaim_window",
  /** No bounded post-activation TTL is available. */
  "ttl_unavailable",
  /** The canonical compiler refused or changed the configs. */
  "policy_not_compilable",
  /** The factory predicts another escrow. */
  "escrow_not_predicted",
  /** This policy already has funded escrow. */
  "escrow_already_funded",
  /** The policy nonce was revoked. */
  "nonce_revoked",
] as const;
export type BuyerFundingPrepareRefusal = (typeof BUYER_FUNDING_PREPARE_REFUSALS)[number];

/** Refusals in servePrepareSignature's check order. */
export const PREPARE_SIGNATURE_REFUSALS = [
  /** There is no frozen prepare. */
  "no_prepare",
  /** Another signature was already served. */
  "already_signed",
  /** The signature is not a canonical EOA signature. */
  "signature_malformed",
  /** The signature does not recover the operator. */
  "signature_not_operator",
  /** The job's marker escrow is no longer created. */
  "escrow_not_created",
] as const;
export type PrepareSignatureRefusal = (typeof PREPARE_SIGNATURE_REFUSALS)[number];

export class BuyerFundingSelectionError extends Error {
  constructor(readonly code: "buyer_funding_selection_invalid" | "buyer_funding_unavailable" | "buyer_not_wallet" | "escrow_buyer_funded") {
    super(code);
    this.name = "BuyerFundingSelectionError";
  }
}

export interface BuyerFundingUnitEntry {
  readonly id: string;
  readonly unit: typeof DRY_RUN_UNIT_TESTNET_V1;
  readonly chainId: number;
  readonly scheduleId: VNextDeploymentRecord["scheduleId"];
  readonly scheduleTestnetOnly: boolean;
  readonly usdc: Address;
  readonly finalitySeconds: bigint;
  readonly maxAcceptanceSeconds: bigint;
  readonly reclaimDelaySeconds: bigint;
  readonly reclaimSkewSeconds: bigint;
}
const dryRunEntry: BuyerFundingUnitEntry = Object.freeze({
  id: DRY_RUN_UNIT_ID, unit: DRY_RUN_UNIT_TESTNET_V1, chainId: 84532,
  scheduleId: "vnext-testnet-short-v1", scheduleTestnetOnly: true, usdc: DRY_RUN_UNIT_TESTNET_V1.usdc,
  finalitySeconds: 1800n, maxAcceptanceSeconds: DRY_RUN_UNIT_TESTNET_V1.maxAcceptanceSeconds,
  reclaimDelaySeconds: DRY_RUN_UNIT_TESTNET_V1.reclaimDelaySeconds, reclaimSkewSeconds: DRY_RUN_UNIT_TESTNET_V1.reclaimSkewSeconds,
});
let unitTable: Readonly<Record<string, BuyerFundingUnitEntry>> = Object.freeze({ [DRY_RUN_UNIT_ID]: dryRunEntry });
export function buyerFundingUnitEntry(unitId: string): BuyerFundingUnitEntry | undefined {
  return Object.hasOwn(unitTable, unitId) ? unitTable[unitId] : undefined;
}
export function __setBuyerFundingTestUnitForTest(entry: BuyerFundingUnitEntry | null): void {
  if (!isTestProcess()) throw new Error("buyer-funding test unit: test processes only");
  if (entry?.id === DRY_RUN_UNIT_ID) throw new Error("buyer-funding test unit: reserved id");
  unitTable = Object.freeze({ [DRY_RUN_UNIT_ID]: dryRunEntry, ...(entry ? { [entry.id]: Object.freeze({ ...entry }) } : {}) });
}

const { operatorPolicies } = schema;
const WALLET = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export function buyerFundingSelection(kernelId: string, mode: "commit" | "prepare"): string | null {
  let policy: unknown;
  try {
    const row = getStore().db.select().from(operatorPolicies).where(eq(operatorPolicies.kernelId, kernelId)).get();
    policy = row?.policy;
  } catch {
    if (mode === "prepare") throw new Error("policy_unavailable");
    return null;
  }
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)
    || !Object.hasOwn(policy, BUYER_FUNDING_POLICY_KEY)) return null;
  const value = (policy as Record<string, unknown>)[BUYER_FUNDING_POLICY_KEY];
  if (typeof value === "string" && buyerFundingUnitEntry(value)) return value;
  if (mode === "commit") throw new BuyerFundingSelectionError("buyer_funding_selection_invalid");
  return null;
}
export function buyerFundingAvailable(record: VNextDeploymentRecord | null = configuredVNextDeploymentRecord()): boolean {
  return record !== null && vnextRpcUrl() !== null;
}
function recordMatches(record: VNextDeploymentRecord, entry: BuyerFundingUnitEntry): boolean {
  return record.chainId === entry.chainId && record.scheduleId === entry.scheduleId
    && record.scheduleTestnetOnly === entry.scheduleTestnetOnly && same(record.usdc, entry.usdc);
}
export function commitBuyerFundingSelection(kernelId: string, buyer: string): string | null {
  const id = buyerFundingSelection(kernelId, "commit");
  if (id === null) return null;
  const record = configuredVNextDeploymentRecord();
  if (!buyerFundingAvailable(record) || !record || !recordMatches(record, buyerFundingUnitEntry(id)!)) {
    throw new BuyerFundingSelectionError("buyer_funding_unavailable");
  }
  if (!WALLET.test(buyer)) throw new BuyerFundingSelectionError("buyer_not_wallet");
  return id;
}

export type FundingPrepareRow = typeof schema.fundingPrepares.$inferSelect;
type PrepareResult = { kind: "answer"; row: FundingPrepareRow } | { kind: "refused"; code: BuyerFundingPrepareRefusal };
const refused = (code: BuyerFundingPrepareRefusal): PrepareResult => ({ kind: "refused", code });
export const fundingPrepareRow = (scopeId: string) => getStore().db.select().from(schema.fundingPrepares)
  .where(eq(schema.fundingPrepares.scopeId, scopeId)).get();
const scopeById = (id: string) => getStore().db.select().from(schema.executionScopes).where(eq(schema.executionScopes.id, id)).get();
const wire = (value: unknown) => JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v);
const lower = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString()
  : typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v) ? v.toLowerCase() : v));
function subjectFor(payer: string, operator: string, unit = DRY_RUN_UNIT_TESTNET_V1) {
  return { payer: dryRunUnitPrincipalWord(payer as Address), operatorPrincipal: dryRunUnitPrincipalWord(operator as Address),
    operatorSettlementAddress: operator.toLowerCase() as Address, authorizedTuplesRoot: zeroHash,
    committedProgramHash: unit.committedProgramHash, ...unit.zeroSubjectFields, integrityGrade: unit.integrityGrade };
}
/** computeTermsHash is the sole producer of prepared terms. */
export function preparedTermsHash(configs: readonly UnitConfig[], usdc: string): Hex {
  return computeTermsHash({ token: usdc.toLowerCase() as Address, assuranceTier: 1,
    milestones: configs.map(c => ({ milestoneIndex: c.milestoneIndex, stepId: c.stepId, amount: c.g, deadline: c.reclaimAt })) });
}
const quoteAmount = (v: unknown, gross: bigint) => typeof v === "string" && AMOUNT.test(v) && parseUnits(v, 6) === gross;

export async function prepareBuyerFunding(scopeId: string, deps: {
  reads?: VNextPrepareReads; now?: () => Date; record?: VNextDeploymentRecord; gatewaySigner?: () => string | null | undefined;
} = {}): Promise<PrepareResult> {
  const record = deps.record ?? configuredVNextDeploymentRecord();
  if (!buyerFundingAvailable(record) || !record) return refused("buyer_funding_unavailable");
  const scope = scopeById(scopeId);
  if (!scope) return refused("scope_not_found");
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const existing = fundingPrepareRow(scopeId);
  if (existing) return { kind: "answer", row: existing };
  let selected: string | null;
  try { selected = buyerFundingSelection(scope.kernelId, "prepare"); }
  catch { return refused("policy_unavailable"); }
  const session = scope.jobId ? getStore().db.select().from(schema.negotiationSessions)
    .where(eq(schema.negotiationSessions.jobId, scope.jobId)).get() : undefined;
  if (!selected || !scope.jobId || !session?.cwmId || escrowForJob(scope.jobId)) return refused("buyer_funding_not_selected");
  if (scope.status !== SCOPE_AWAITING_FUNDING) return refused("scope_not_awaiting_funding");
  const scopeExpMs = scopeExpiryMs(scope.expiresAt);
  if (scopeExpMs <= nowMs) return refused("scope_expired");
  const stop = emergencyStopState(scope.kernelId);
  if (stop !== "clear") return refused(stop === "stopped" ? "kernel_emergency_stopped" : "policy_unavailable");
  if (!WALLET.test(scope.createdBy)) return refused("buyer_not_wallet");
  if (testnetBuyerRefusal({ buyer: scope.createdBy }, testnetBuyerAllowance({ testnetOnly: record.scheduleTestnetOnly }))) {
    return refused("testnet_buyer_not_allowed");
  }
  const entry = buyerFundingUnitEntry(selected)!;
  const unit = entry.unit;
  const operator = getStore().db.select().from(schema.shopKernels).where(eq(schema.shopKernels.id, scope.kernelId)).get()?.operatorAddress;
  const signer = (deps.gatewaySigner ?? getSignerAddress)();
  if (!operator || !WALLET.test(operator) || same(operator, scope.createdBy) || (signer && same(operator, signer))
    || getStore().db.select().from(schema.apiKeys).all().some(k => k.operatorWalletAddress
      && same(k.operatorWalletAddress, operator) && k.operatorWalletCustody !== "operator")) return refused("operator_unusable");
  const quote = session.quote as Record<string, unknown> | null;
  if (!quoteAmount(quote?.totalPrice, unit.g) || quote?.currency !== "USDC") return refused("total_gross_not_quote");
  const terms = session.contractTerms as Record<string, unknown> | null;
  const milestones = terms?.milestones;
  if (Array.isArray(milestones) && (milestones.length > 1
    || (milestones.length === 1 && !quoteAmount(milestones[0]?.amount, unit.g)))) return refused("milestones_not_quote");
  const job = getStore().db.select().from(schema.jobs).where(eq(schema.jobs.id, scope.jobId)).get();
  if (job?.assuranceTier !== 1) return refused("tier_not_quote");
  if (!recordMatches(record, entry)) return refused("unit_needs_testnet_record");
  const reads = deps.reads ?? createVNextChainReads(vnextRpcUrl()!);
  let compiled: ReturnType<typeof compileVNextPolicy>;
  let expiry: bigint;
  let reclaimAt: bigint;
  let reconcileUntil: bigint;
  let termsHash: Hex;
  let acceptedPolicyDigest: Hex;
  try {
    if (await reads.chainId() !== record.chainId) return refused("rpc_chain_mismatch");
    const block = await reads.latestBlock();
    const C = block.timestamp;
    const nowS = BigInt(Math.ceil(nowMs / 1000));
    if (nowS - C > CHAIN_CLOCK_LAG_MAX_SECONDS || C - nowS > CHAIN_CLOCK_LEAD_MAX_SECONDS) return refused("chain_clock_skew");
    if (await reads.code(record.factory, block.hash) === "0x") return refused("deployment_mismatch");
    const callFactory = (name: string, args: readonly unknown[] = []) => reads.call(record.factory, VNextSettlementEscrowFactoryABI, name, args, block.hash);
    if (!same(String(await callFactory("implementation")), record.implementation)) return refused("deployment_mismatch");
    if (!same(String(await reads.call(record.implementation, VNextSettlementEscrowABI, "USDC", [], block.hash)), record.usdc)) return refused("deployment_mismatch");
    const scopeArm = BigInt(Math.floor(scopeExpMs / 1000)) - entry.finalitySeconds - PREPARE_MARGIN_SECONDS;
    expiry = scopeArm < C + entry.maxAcceptanceSeconds ? scopeArm : C + entry.maxAcceptanceSeconds;
    if (expiry < (C > nowS ? C : nowS) + SERVE_MARGIN_SECONDS) return refused("window_too_short");
    if (entry.reclaimDelaySeconds - (expiry - C) - DEFAULT_MARGIN_SECONDS - entry.reclaimSkewSeconds < BigInt(record.minReclaimDelaySec)
      || entry.reclaimDelaySeconds + entry.reclaimSkewSeconds > BigInt(record.maxReclaimDelaySec)) return refused("reclaim_window");
    reclaimAt = C + entry.reclaimDelaySeconds;
    const V = BigInt(record.challengeWindowSec + record.appealWindowSec + record.backupWindowSec);
    reconcileUntil = reclaimAt - (V > entry.finalitySeconds ? V : entry.finalitySeconds);
    const ttlMs = Number(reconcileUntil) * 1000 - scopeExpMs;
    if (!Number.isSafeInteger(ttlMs) || !(0 < ttlMs && ttlMs <= MAX_POST_ACTIVATION_TTL_MS)) return refused("ttl_unavailable");
    try {
      const spec = { milestoneIndex: 0n, stepId: keccak256(stringToHex(job.stepId)), requiredTier: unit.requiredTier,
        requestedTier: unit.requestedTier, g: unit.g, f: unit.f, n: unit.n, feeBps: unit.feeBps, feeRecipient: unit.feeRecipient,
        reclaimAt, compositionSchemaVersion: unit.compositionSchemaVersion, compositionRoot: unit.compositionRoot,
        payouts: [{ recipient: operator as Address, amount: unit.g }] };
      const configs = [buildUnitConfig(spec)];
      termsHash = preparedTermsHash(configs, record.usdc);
      acceptedPolicyDigest = computeAcceptedPolicyDigest({ termsHash, subjectBlockHash: computeSubjectBlockHash(subjectFor(scope.createdBy, operator, unit)),
        bindingsRoot: computeBindingsRoot(unit.bindings) });
      compiled = compileVNextPolicy({ chainId: BigInt(record.chainId), factory: record.factory, implementation: record.implementation,
        token: record.usdc, payer: scope.createdBy as Address, operator: operator as Address, jobIdHash: jobIdHashOf(scope.jobId), termsHash,
        policyNonce: 0n, acceptedPolicyDigest, expiry, fundingTime: expiry, units: [spec] });
      if (!isDeepStrictEqual(compiled.configs, configs)) return refused("policy_not_compilable");
    } catch (error) {
      if (error instanceof VNextCompileError) console.warn(error.code);
      return refused("policy_not_compilable");
    }
    if (!same(String(await callFactory("predictEscrow", [compiled.identity])), compiled.escrow)) return refused("escrow_not_predicted");
    if (!same(String(await callFactory("fundedEscrowOf", [compiled.policyKey])), zeroAddress)) return refused("escrow_already_funded");
    if (await callFactory("policyNonceFloor", [compiled.policyKey]) !== 0n) return refused("nonce_revoked");
  } catch { return refused("rpc_unavailable"); }
  const row: FundingPrepareRow = {
    id: `prep_${randomUUID()}`, scopeId, jobId: scope.jobId, jobIdHash: jobIdHashOf(scope.jobId).toLowerCase(),
    chainId: record.chainId, escrow: compiled.escrow.toLowerCase(), s01RecordSha256: record.recordSha256.toLowerCase(),
    s01ScheduleId: record.scheduleId, s01ScheduleTestnetOnly: record.scheduleTestnetOnly ? 1 : 0,
    factory: record.factory.toLowerCase(), implementation: record.implementation.toLowerCase(), usdc: record.usdc.toLowerCase(),
    payer: scope.createdBy.toLowerCase(), operator: operator.toLowerCase(), termsHash: termsHash.toLowerCase(), policyNonce: "0",
    prePolicyRoot: compiled.prePolicyRoot.toLowerCase(), acceptedPolicyDigest: acceptedPolicyDigest.toLowerCase(),
    totalGross: compiled.totalGross.toString(), quoteSnapshot: JSON.stringify(session.quote), configs: wire(lower(compiled.configs)), unitIds: wire(lower(compiled.unitIds)),
    expiry: Number(expiry), scopeExpiresAt: scope.expiresAt, finalityFS: Number(entry.finalitySeconds), marginMS: Number(PREPARE_MARGIN_SECONDS),
    reclaimAtEarliest: Number(reclaimAt), reclaimAtLatest: Number(reclaimAt), reconcileUntil: Number(reconcileUntil),
    typedDataDigest: compiled.digest.toLowerCase(), state: "pending_signature", createdAt: new Date(nowMs).toISOString(),
    operatorSignature: null, signatureVerifiedAt: null, signedAt: null, servedPayload: null, servedPayloadSha256: null,
    signatureRequestedAt: null, endedAt: null, supersededBy: null,
  };
  return getStore().db.transaction((tx): PrepareResult => {
    const winner = tx.select().from(schema.fundingPrepares).where(eq(schema.fundingPrepares.scopeId, scopeId)).get();
    if (winner) return { kind: "answer", row: winner };
    const current = tx.select().from(schema.executionScopes).where(eq(schema.executionScopes.id, scopeId)).get();
    if (!current || current.status !== SCOPE_AWAITING_FUNDING) return refused("scope_not_awaiting_funding");
    if (scopeExpiryMs(current.expiresAt) <= Date.now()) return refused("scope_expired");
    const stopNow = emergencyStopState(current.kernelId);
    if (stopNow !== "clear") return refused(stopNow === "stopped" ? "kernel_emergency_stopped" : "policy_unavailable");
    try { if (buyerFundingSelection(current.kernelId, "prepare") !== selected) return refused("buyer_funding_not_selected"); }
    catch { return refused("policy_unavailable"); }
    if (escrowForJob(current.jobId)) return refused("buyer_funding_not_selected");
    tx.insert(schema.fundingPrepares).values(row).run();
    const escrowId = `esc-${randomUUID().slice(0, 12)}`;
    tx.insert(schema.escrows).values({
      id: escrowId, cwmId: session.cwmId!, contractAddress: getAddress(compiled.escrow), payer: scope.createdBy,
      totalAmount: quote!.totalPrice as string, currency: "USDC", status: "created", createdAt: new Date(nowMs).toISOString(),
      deadline: (terms?.deadline as string) ?? new Date(nowMs + 24 * 60 * 60_000).toISOString(), version: BUYER_FUNDED_ESCROW_VERSION,
    }).run();
    tx.insert(schema.escrowMilestones).values({
      id: `ms-${randomUUID().slice(0, 12)}`, escrowId, stepId: job.stepId, amount: "1.00", status: "pending", bondAmount: "0.00",
    }).run();
    return { kind: "answer", row };
  }, { behavior: "immediate" });
}

export type PrepareHttpAnswer = { status: number; body: Record<string, unknown> | Buffer; contentType?: string };
const messages: Record<BuyerFundingPrepareRefusal | PrepareSignatureRefusal, string> = {
  buyer_funding_unavailable: "Buyer funding is unavailable.", scope_not_found: "The execution scope was not found.",
  prepare_expired: "The funding prepare has expired.", policy_unavailable: "The operator policy is unavailable.",
  buyer_funding_not_selected: "The job does not select buyer funding.", scope_not_awaiting_funding: "The scope is not awaiting funding.",
  scope_expired: "The execution scope has expired.", kernel_emergency_stopped: "The kernel is emergency stopped.",
  buyer_not_wallet: "The buyer must be a wallet.", testnet_buyer_not_allowed: "The buyer is not allowed on this testnet.",
  operator_unusable: "The operator cannot sign this policy.", total_gross_not_quote: "The quote does not match the unit gross amount.",
  milestones_not_quote: "The milestones do not match the unit quote.", tier_not_quote: "The job tier does not match the unit.",
  unit_needs_testnet_record: "The deployment record does not match the selected unit.", rpc_unavailable: "The chain reads are unavailable.",
  rpc_chain_mismatch: "The RPC chain does not match the deployment record.", chain_clock_skew: "The chain clock exceeds the prepare bounds.",
  deployment_mismatch: "The deployment does not match the record.", window_too_short: "The funding window is too short.",
  reclaim_window: "The reclaim window does not match the record.", ttl_unavailable: "The activation TTL is unavailable.",
  policy_not_compilable: "The funding policy cannot be compiled.", escrow_not_predicted: "The escrow does not match the factory prediction.",
  escrow_already_funded: "The policy already has funded escrow.", nonce_revoked: "The policy nonce has been revoked.",
  no_prepare: "The scope has no funding prepare.", already_signed: "The prepare has already been signed.",
  signature_malformed: "The signature must be a canonical EOA signature.", signature_not_operator: "The signature is not from the operator.",
  escrow_not_created: "The marker escrow is not created.",
};
export function prepareRefusalAnswer(code: BuyerFundingPrepareRefusal | PrepareSignatureRefusal): PrepareHttpAnswer {
  const status = code === "scope_not_found" || code === "no_prepare" ? 404 : code === "prepare_expired" ? 410
    : code === "testnet_buyer_not_allowed" ? 403 : ["signature_malformed", "signature_not_operator"].includes(code) ? 400
    : ["buyer_funding_unavailable", "policy_unavailable", "unit_needs_testnet_record", "rpc_unavailable", "rpc_chain_mismatch",
      "chain_clock_skew", "deployment_mismatch", "escrow_not_predicted"].includes(code) ? 503 : 409;
  return { status, body: code === "kernel_emergency_stopped" || code === "policy_unavailable" ? { error: code } : { error: code, message: messages[code] } };
}
const servedAnswer = (row: FundingPrepareRow): PrepareHttpAnswer => ({ status: 200, body: row.servedPayload!, contentType: "application/json; charset=utf-8" });
export function prepareRowAnswer(row: FundingPrepareRow, nowMs: number): PrepareHttpAnswer {
  if (row.state === "served") return servedAnswer(row);
  if (row.state !== "pending_signature") return prepareRefusalAnswer("prepare_expired");
  if (nowMs + Number(SERVE_MARGIN_SECONDS) * 1000 > row.expiry * 1000 || scopeExpiryMs(row.scopeExpiresAt) <= nowMs) {
    const result = getStore().db.update(schema.fundingPrepares).set({ state: "expired", endedAt: new Date(nowMs).toISOString() })
      .where(and(eq(schema.fundingPrepares.id, row.id), eq(schema.fundingPrepares.state, "pending_signature"))).run();
    if (!result.changes) return prepareRowAnswer(fundingPrepareRow(row.scopeId)!, nowMs);
    return prepareRefusalAnswer("prepare_expired");
  }
  return { status: 202, body: { schema: PREPARE_PENDING_SCHEMA, state: "pending_signature", retryAfterSeconds: PREPARE_RETRY_AFTER_SECONDS } };
}
function frozenPolicy(row: FundingPrepareRow) {
  return { chainId: BigInt(row.chainId), factory: row.factory as Address, implementation: row.implementation as Address,
    escrow: getAddress(row.escrow), payer: row.payer as Address, operator: row.operator as Address, jobIdHash: row.jobIdHash as Hex,
    termsHash: row.termsHash as Hex, policyNonce: BigInt(row.policyNonce), prePolicyRoot: row.prePolicyRoot as Hex,
    unitsRoot: unitsRoot(JSON.parse(row.unitIds)), expiry: BigInt(row.expiry), acceptedPolicyDigest: row.acceptedPolicyDigest as Hex };
}
export function prepareSigningInput(row: FundingPrepareRow) {
  return { policy: JSON.parse(wire(frozenPolicy(row))), units: JSON.parse(row.configs),
    subjectBlock: subjectFor(row.payer, row.operator), bindings: [] };
}
export function operatorPrepareView(scopeId: string, deps: { now?: () => Date } = {}): PrepareHttpAnswer {
  const row = fundingPrepareRow(scopeId);
  if (!row) return prepareRefusalAnswer("no_prepare");
  if (row.state === "served") return prepareRefusalAnswer("already_signed");
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const answer = prepareRowAnswer(row, nowMs);
  if (answer.status !== 202) return answer;
  getStore().db.update(schema.fundingPrepares).set({ signatureRequestedAt: new Date(nowMs).toISOString() })
    .where(and(eq(schema.fundingPrepares.id, row.id), eq(schema.fundingPrepares.state, "pending_signature"), sql`${schema.fundingPrepares.signatureRequestedAt} IS NULL`)).run();
  return { status: 200, body: prepareSigningInput(row) };
}
function payloadBytes(row: FundingPrepareRow, signature: string): Buffer {
  const typedData = lower(jobPolicyTypedData(frozenPolicy(row)));
  const payload = { schema: FUNDING_PREPARE_SCHEMA, chainId: String(row.chainId), factory: row.factory, escrow: row.escrow, usdc: row.usdc,
    totalGross: row.totalGross, expiry: String(row.expiry), typedData,
    approve: { token: row.usdc, spender: row.escrow, amount: row.totalGross },
    fund: { configs: lower(JSON.parse(row.configs)), acceptance: { expiry: String(row.expiry), payerSignature: "0x", operatorSignature: signature } } };
  return Buffer.from(JSON.stringify(payload), "utf8");
}
export async function servePrepareSignature(scopeId: string, signature: unknown, deps: { now?: () => Date } = {}): Promise<PrepareHttpAnswer> {
  const row = fundingPrepareRow(scopeId);
  if (!row) return prepareRefusalAnswer("no_prepare");
  const repeat = (r: FundingPrepareRow) => r.state === "served" && typeof signature === "string" && r.operatorSignature !== null
    && same(r.operatorSignature, signature) ? servedAnswer(r) : prepareRefusalAnswer(r.state === "served" ? "already_signed" : "prepare_expired");
  if (row.state === "served") return repeat(row);
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const answer = prepareRowAnswer(row, nowMs);
  if (answer.status !== 202) return answer;
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return prepareRefusalAnswer("signature_malformed");
  const v = Number.parseInt(signature.slice(-2), 16);
  const s = hexToBigInt(`0x${signature.slice(66, 130)}`);
  if ((v !== 27 && v !== 28) || s > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n) return prepareRefusalAnswer("signature_malformed");
  try {
    if (!same(await recoverAddress({ hash: row.typedDataDigest as Hex, signature: signature as Hex }), row.operator)) return prepareRefusalAnswer("signature_not_operator");
  } catch { return prepareRefusalAnswer("signature_not_operator"); }
  const scope = scopeById(scopeId);
  if (!scope || scope.status !== SCOPE_AWAITING_FUNDING) return prepareRefusalAnswer("scope_not_awaiting_funding");
  if (scopeExpiryMs(scope.expiresAt) <= nowMs) return prepareRefusalAnswer("scope_expired");
  const stop = emergencyStopState(scope.kernelId);
  if (stop !== "clear") return prepareRefusalAnswer(stop === "stopped" ? "kernel_emergency_stopped" : "policy_unavailable");
  const marker = escrowForJob(scope.jobId);
  if (!marker || marker.status !== "created" || !("version" in marker) || marker.version !== BUYER_FUNDED_ESCROW_VERSION) return prepareRefusalAnswer("escrow_not_created");
  const bytes = payloadBytes(row, signature.toLowerCase());
  const now = new Date(nowMs).toISOString();
  getStore().db.update(schema.fundingPrepares).set({ state: "served", operatorSignature: signature.toLowerCase(), signatureVerifiedAt: now,
    signedAt: now, servedPayload: bytes, servedPayloadSha256: createHash("sha256").update(bytes).digest("hex") })
    .where(and(eq(schema.fundingPrepares.id, row.id), eq(schema.fundingPrepares.state, "pending_signature"))).run();
  return repeat(fundingPrepareRow(scopeId)!);
}
