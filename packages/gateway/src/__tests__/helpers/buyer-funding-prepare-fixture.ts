/** Frozen prepare inputs and read-only chain responses for prepareBuyerFunding. */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { eq, schema } from "@pcc/store";
import { compileVNextPolicy, buildUnitConfig, jobIdHashOf, predictEscrow, policySalt } from "@pcc/contracts/vnext";
import { DRY_RUN_UNIT_TESTNET_V1 } from "@pcc/spec/funding";
import { keccak256, stringToHex, zeroAddress, type Address } from "viem";
import { getRepos } from "../../db.js";
import { configuredVNextDeploymentRecord } from "../../services/paid-scope-activation-terms.js";
import { type VNextPrepareReads } from "../../services/vnext-rpc-client.js";
import { DRY_RUN_UNIT_ID } from "../../services/buyer-funding-prepare.js";
import { KERNEL, basePolicy, setPolicy, db } from "./paid-scope-fixture.js";
import { hash } from "./buyer-funding-fixture.js";

const fixture = (kind: string) => JSON.parse(readFileSync(new URL(`../fixtures/vnext-dry-run-prepare-v1.${kind}.json`, import.meta.url), "utf8"));
export const inputs = fixture("inputs");
export const payload = fixture("payload");
export const C = BigInt(inputs.latestBlockTimestamp);
export const pendingBody = { schema: "pcc.vnext.buyer-funding.pending.v1", state: "pending_signature", retryAfterSeconds: 5 };
export function configure() {
  vi.stubEnv("PCC_VNEXT_RECORD_NETWORK", "base-sepolia");
  vi.stubEnv("PCC_VNEXT_ALLOW_TESTNET_RECORD", "1");
  vi.stubEnv("PCC_VNEXT_RPC_URL", "https://rpc.invalid");
  vi.stubEnv("PCC_VNEXT_TESTNET_BUYERS", inputs.payer);
}
export function selectUnit(value: unknown = DRY_RUN_UNIT_ID) {
  setPolicy(KERNEL, { ...basePolicy(), vnextBuyerFunding: value });
}
export function seedPrepare(over: { payer?: string; operator?: string; scopeExp?: bigint; jobId?: string; scopeId?: string } = {}) {
  const payer = over.payer ?? inputs.payer;
  const operator = over.operator ?? inputs.operator;
  const jobId = over.jobId ?? inputs.jobId;
  const scopeId = over.scopeId ?? `scope-${randomUUID()}`;
  const cwmId = `cwm-${randomUUID()}`;
  const sessionId = `session-${randomUUID()}`;
  const createdAt = new Date(Number(C) * 1000).toISOString();
  const expiresAt = new Date(Number(over.scopeExp ?? BigInt(inputs.scopeExpiresAt)) * 1000).toISOString();
  db().update(schema.shopKernels).set({ operatorAddress: operator }).where(eq(schema.shopKernels.id, KERNEL)).run();
  selectUnit();
  db().insert(schema.negotiationSessions).values({ id: sessionId, kernelId: KERNEL, userAgentId: payer, capabilityType: "liquid-handler",
    status: "committed", jobId, cwmId, quote: { totalPrice: "1.00", currency: "USDC" }, contractTerms: {}, selections: {},
    operatorConstraints: {}, transitions: [], createdAt, expiresAt }).run();
  getRepos().jobs.insert({ ...getRepos().jobs.findAll()[0]!, id: jobId, cwmId, kernelId: KERNEL, stepId: inputs.stepIdSource, assuranceTier: 1 });
  db().insert(schema.executionScopes).values({ id: scopeId, kernelId: KERNEL, jobId, createdBy: payer,
    status: "awaiting_funding", allowedTools: [], createdAt, expiresAt }).run();
  return { scopeId, jobId, sessionId, cwmId, payer, operator, expiresAt };
}
export function prepareReads(timestamp = C) {
  const record = configuredVNextDeploymentRecord()!;
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const values: Record<string, unknown> = { implementation: record.implementation, USDC: record.usdc,
    fundedEscrowOf: zeroAddress, policyNonceFloor: 0n };
  const block = { number: 100n, hash: hash(100), timestamp };
  const unexpected = vi.fn(async () => { throw new Error("unexpected read"); });
  const reads: VNextPrepareReads = {
    chainId: vi.fn(async () => { calls.push({ method: "chainId", args: [] }); return 84532; }),
    latestBlock: vi.fn(async () => { calls.push({ method: "latestBlock", args: [] }); return block; }),
    code: vi.fn(async (...args) => { calls.push({ method: "code", args }); return "0x6000"; }),
    call: vi.fn(async (address, _abi, method, args, pin) => {
      calls.push({ method, args: [address, args, pin] });
      if (Object.hasOwn(values, method)) return values[method];
      if (method === "predictEscrow") return predictEscrow({ factory: record.factory, implementation: record.implementation, salt: policySalt(args[0] as never) });
      throw new Error("unexpected call");
    }),
    finalizedBlock: unexpected, blockByNumber: unexpected, unitConfigs: unexpected, fundedLogs: unexpected,
  };
  return { reads, calls, values, block, record, deps: { reads, now: () => new Date(Number(timestamp) * 1000), gatewaySigner: () => null } };
}
export function recompile(jobId = inputs.jobId, payer = inputs.payer, operator = inputs.operator, expiry = C + 1200n) {
  const r = configuredVNextDeploymentRecord()!;
  const u = DRY_RUN_UNIT_TESTNET_V1;
  return compileVNextPolicy({ chainId: 84532n, factory: r.factory, implementation: r.implementation, token: r.usdc,
    payer: payer as Address, operator: operator as Address, jobIdHash: jobIdHashOf(jobId), termsHash: payload.typedData.message.termsHash,
    policyNonce: 0n, acceptedPolicyDigest: payload.typedData.message.acceptedPolicyDigest, expiry, fundingTime: expiry,
    units: [buildUnitConfig({ milestoneIndex: 0n, stepId: keccak256(stringToHex(inputs.stepIdSource)), requiredTier: u.requiredTier, g: u.g,
      feeBps: u.feeBps, feeRecipient: u.feeRecipient, reclaimAt: C + u.reclaimDelaySeconds, compositionSchemaVersion: u.compositionSchemaVersion,
      compositionRoot: u.compositionRoot, payouts: [{ recipient: operator as Address, amount: u.g }] })] });
}
export const counts = () => [db().select().from(schema.fundingPrepares).all().length,
  db().select().from(schema.escrows).all().length, db().select().from(schema.escrowMilestones).all().length];
