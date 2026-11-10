import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CIRCLE_USDC, DRY_RUN_UNIT_TESTNET_V1, FUNDING_PREPARE_SCHEMA, RECLAIM_WINDOWS, VNEXT_FACTORY,
  dryRunUnitTestnetExpectation, prepareFunding } from "@pcc/spec/funding";
import { computeAcceptedPolicyDigest, computeBindingsRoot, computeSubjectBlockHash, computeTermsHash } from "@pcc/spec";
import { compileVNextPolicy, jobIdHashOf, predictEscrow, policySalt, prePolicyRoot, VNextSettlementEscrowFactoryABI } from "@pcc/contracts/vnext";
import { VNEXT_SCHEDULE_TUPLES, vnextDeploymentRecord, vnextNetworkSlug } from "../services/paid-scope-activation-terms.js";
import { createPublicClient, createWalletClient, custom, decodeFunctionData, encodeFunctionData, encodeFunctionResult,
  keccak256, parseAbi, recoverAddress, stringToHex, toHex, zeroHash, type Address, type Hex } from "viem";

const contractsRoot = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const record = JSON.parse(readFileSync(join(contractsRoot, "deployments/vnext/base-sepolia/CANONICAL.json"), "utf8"));
const fixture = (kind: string) => JSON.parse(readFileSync(new URL(`./fixtures/vnext-dry-run-prepare-v1.${kind}.json`, import.meta.url), "utf8"));
const payload = fixture("payload");
const inputs = fixture("inputs");
const C = BigInt(inputs.latestBlockTimestamp);
const lower = (value: unknown): any => JSON.parse(JSON.stringify(value, (_k, v) => typeof v === "bigint" ? v.toString() :
  typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v) ? v.toLowerCase() : v));
const readRecord = () => vnextDeploymentRecord(contractsRoot, "base-sepolia")!;
const windowOf = (r: any) => ({ scheduleId: r.scheduleId, testnetOnly: r.scheduleTestnetOnly,
  minReclaimDelay: BigInt(r.minReclaimDelaySec), maxReclaimDelay: BigInt(r.maxReclaimDelaySec) });
const identityOf = (m: any, root: Hex) => ({ payer: m.payer, operator: m.operator, jobIdHash: m.jobIdHash,
  termsHash: m.termsHash, policyNonce: BigInt(m.policyNonce), prePolicyRoot: root, acceptedPolicyDigest: m.acceptedPolicyDigest });

function compile() {
  const u = DRY_RUN_UNIT_TESTNET_V1;
  return compileVNextPolicy({ chainId: 84532n, factory: record.factory, implementation: record.implementation, token: record.usdc,
    payer: inputs.payer, operator: inputs.operator, jobIdHash: jobIdHashOf(inputs.jobId),
    termsHash: payload.typedData.message.termsHash, policyNonce: BigInt(inputs.policyNonce),
    acceptedPolicyDigest: payload.typedData.message.acceptedPolicyDigest,
    expiry: C + 1_200n, fundingTime: C + 1_200n,
    units: [{ milestoneIndex: 0n, stepId: keccak256(stringToHex(inputs.stepIdSource)),
      requiredTier: u.requiredTier, requestedTier: u.requestedTier, g: u.g, f: u.f, n: u.n,
      feeBps: u.feeBps, feeRecipient: u.feeRecipient, reclaimAt: C + 7_200n,
      compositionSchemaVersion: u.compositionSchemaVersion, compositionRoot: u.compositionRoot,
      payouts: [{ recipient: inputs.operator, amount: 1_000_000n }] }],
  });
}

function node() {
  const methods: string[] = [];
  const block = { number: "0x64", hash: keccak256(stringToHex("ns5:golden:block")), parentHash: zeroHash,
    timestamp: toHex(C), transactions: [] };
  const usdcAbi = parseAbi(["function USDC() view returns (address)"]);
  const transport = custom({ async request({ method, params }: { method: string; params?: readonly unknown[] }) {
    methods.push(method);
    switch (method) {
      case "eth_chainId": return toHex(84532);
      case "eth_getBlockByNumber": case "eth_getBlockByHash": return block;
      case "eth_getCode": return String(params![0]).toLowerCase() === record.factory.toLowerCase() ? "0x6080" : "0x";
      case "eth_call": {
        const { to, data } = params![0] as { to: Address; data: Hex };
        expect(params![1]).toEqual({ blockHash: block.hash, requireCanonical: true });
        if (to.toLowerCase() === record.factory.toLowerCase()) {
          const decoded = decodeFunctionData({ abi: VNextSettlementEscrowFactoryABI, data });
          if (decoded.functionName === "implementation") return encodeFunctionResult({ abi: VNextSettlementEscrowFactoryABI, functionName: "implementation", result: record.implementation });
          if (decoded.functionName === "predictEscrow") {
            const [identity] = decoded.args!;
            return encodeFunctionResult({ abi: VNextSettlementEscrowFactoryABI, functionName: "predictEscrow",
              result: predictEscrow({ factory: record.factory, implementation: record.implementation, salt: policySalt(identity as never) }) });
          }
        }
        if (to.toLowerCase() === record.implementation.toLowerCase() && decodeFunctionData({ abi: usdcAbi, data }).functionName === "USDC") {
          return encodeFunctionResult({ abi: usdcAbi, functionName: "USDC", result: record.usdc });
        }
        throw new Error(`unexpected eth_call ${to} ${data.slice(0, 10)}`);
      }
      default: throw new Error(`unexpected RPC method ${method}`);
    }
  } }, { retryCount: 0 });
  return { methods, publicClient: createPublicClient({ transport }), wallet: createWalletClient({ account: inputs.payer as Address, transport }) };
}
function prepare(raw = payload) {
  const fake = node();
  const own = dryRunUnitTestnetExpectation({ jobId: inputs.jobId, operator: inputs.operator, fundingWallet: inputs.payer,
    subject: inputs.subject, bindings: [], latestBlockTimestamp: C });
  return { fake, pending: prepareFunding({ payload: raw, wallet: fake.wallet, publicClient: fake.publicClient,
    quote: { maxTotalGross: 1_000_000n }, expect: own }) };
}

beforeEach(() => { vi.stubEnv("PCC_VNEXT_ALLOW_TESTNET_RECORD", "1"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("NS-5 buyer SDK and canonical record", () => {
  it("T18 drift: factory agrees across the SDK, record and reader", () => {
    expect(VNEXT_FACTORY["84532"]).toBe(record.factory);
    expect(readRecord().factory).toBe(record.factory.toLowerCase());
  });
  it("T19 drift: USDC agrees across the SDK, record and reader", () => {
    expect(CIRCLE_USDC["84532"]!.toLowerCase()).toBe(record.usdc.toLowerCase());
    expect(readRecord().usdc).toBe(record.usdc.toLowerCase());
  });
  it("T20 drift: reclaim window and reader schedule agree", () => {
    const reader = readRecord();
    const tuple = { scheduleId: reader.scheduleId, testnetOnly: reader.scheduleTestnetOnly,
      minReclaimDelay: BigInt(reader.minReclaimDelaySec), maxReclaimDelay: BigInt(reader.maxReclaimDelaySec) };
    expect(RECLAIM_WINDOWS["84532"]).toEqual(windowOf(record));
    expect(RECLAIM_WINDOWS["84532"]).toEqual(tuple);
    const { chainId, factory, implementation, usdc, recordSha256, ...schedule } = reader;
    expect(schedule).toEqual(VNEXT_SCHEDULE_TUPLES.find(t => t.scheduleId === reader.scheduleId));
  });
  it("T21 every SDK built-in has a committed record and the golden pins its exact bytes", () => {
    for (const table of [VNEXT_FACTORY, RECLAIM_WINDOWS]) {
      expect(Object.keys(table)).toEqual(["84532"]);
      for (const key of Object.keys(table)) {
        expect(vnextDeploymentRecord(contractsRoot, vnextNetworkSlug(Number(key)))?.chainId).toBe(Number(key));
      }
    }
    expect(inputs.recordSha256).toBe(readRecord().recordSha256);
  });
  it("T22 the golden prepares with dry-run buyer intent and no pins", async () => {
    expect(Object.keys(inputs)).toEqual(["schema", "recordNetwork", "recordSha256", "payer", "operator", "jobId", "stepIdSource",
      "latestBlockTimestamp", "scopeExpiresAt", "policyNonce", "subject", "bindings"]);
    expect(inputs.schema).toBe("pcc.ns5.golden-inputs.v1");
    expect(inputs.recordNetwork).toBe("base-sepolia");
    expect(Object.keys(inputs.subject)).toHaveLength(18);
    expect(inputs.subject.authorizedTuplesRoot).toBe(zeroHash);
    expect(inputs.bindings).toEqual([]);
    const { fake, pending } = prepare();
    const prepared = await pending;
    expect(prepared.escrow.toLowerCase()).toBe(payload.escrow);
    expect(prepared.unchecked).toEqual([]);
    expect(fake.methods.every(m => ["eth_chainId", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getCode", "eth_call"].includes(m))).toBe(true);
  });
  it("T23 NS-3 D8: the full identity uses the canonical recomputed root", async () => {
    const prepared = await prepare().pending;
    const expected = identityOf(payload.typedData.message, prePolicyRoot(prepared.configs));
    const compiled = compile();
    expect(lower(prepared.identity)).toEqual(lower(expected));
    expect(lower(prepared.identity)).toEqual(lower(compiled.identity));
    const encode = (identity: typeof compiled.identity) => encodeFunctionData({ abi: VNextSettlementEscrowFactoryABI, functionName: "createEscrow", args: [identity] });
    expect(encode(prepared.identity)).toBe(encode(compiled.identity));
  });
  it("T24 the v1 key set stays exact and non-v1 bodies refuse without RPC", async () => {
    expect(FUNDING_PREPARE_SCHEMA).toBe("pcc.vnext.buyer-funding.prepare.v1");
    expect(Object.keys(payload)).toEqual(["schema", "chainId", "factory", "escrow", "usdc", "totalGross", "expiry", "typedData", "approve", "fund"]);
    expect(Object.keys(payload.typedData)).toEqual(["domain", "types", "primaryType", "message"]);
    expect(Object.keys(payload.typedData.domain)).toEqual(["name", "version", "chainId", "verifyingContract"]);
    expect(Object.keys(payload.typedData.types)).toEqual(["JobPolicy"]);
    const fields = ["chainId", "factory", "implementation", "escrow", "policyVersion", "payer", "operator", "jobIdHash", "termsHash", "policyNonce", "prePolicyRoot", "unitsRoot", "expiry", "acceptedPolicyDigest"];
    expect(Object.keys(payload.typedData.message)).toEqual(fields);
    expect(payload.typedData.types.JobPolicy).toEqual(fields.map((name, i) => ({ name,
      type: ["uint256", "address", "address", "address", "uint256", "address", "address", "bytes32", "bytes32", "uint256", "bytes32", "bytes32", "uint256", "bytes32"][i] })));
    for (const entry of payload.typedData.types.JobPolicy) expect(Object.keys(entry)).toEqual(["name", "type"]);
    expect(Object.keys(payload.approve)).toEqual(["token", "spender", "amount"]);
    expect(Object.keys(payload.fund)).toEqual(["configs", "acceptance"]);
    expect(Object.keys(payload.fund.acceptance)).toEqual(["expiry", "payerSignature", "operatorSignature"]);
    expect(Object.keys(payload.fund.configs[0])).toEqual(["milestoneIndex", "stepId", "requiredTier", "requestedTier", "g", "f", "n", "feeBps", "feeRecipient", "reclaimAt", "compositionSchemaVersion", "compositionRoot", "payouts"]);
    expect(Object.keys(payload.fund.configs[0].payouts[0])).toEqual(["recipient", "amount"]);
    for (const raw of [{ ...payload, extra: true }, { schema: "pcc.vnext.buyer-funding.pending.v1", state: "pending_signature", retryAfterSeconds: 5 }]) {
      const { fake, pending } = prepare(raw);
      await expect(pending).rejects.toMatchObject({ code: "BAD_PAYLOAD" });
      expect(fake.methods).toEqual([]);
    }
  });
  it("T25 the golden is the canonical compiler's and its signature recovers the operator", async () => {
    const compiled = compile();
    const termsHash = computeTermsHash({ token: record.usdc.toLowerCase(), assuranceTier: 1,
      milestones: compiled.configs.map(c => ({ milestoneIndex: c.milestoneIndex, stepId: c.stepId, amount: c.g, deadline: c.reclaimAt })) });
    expect(termsHash).toBe(payload.typedData.message.termsHash);
    expect(computeAcceptedPolicyDigest({ termsHash, subjectBlockHash: computeSubjectBlockHash(inputs.subject), bindingsRoot: computeBindingsRoot(inputs.bindings) }))
      .toBe(payload.typedData.message.acceptedPolicyDigest);
    expect(lower({ escrow: compiled.escrow, typedData: compiled.typedData, configs: compiled.configs, totalGross: compiled.totalGross, expiry: compiled.expiry }))
      .toEqual({ escrow: payload.escrow, typedData: payload.typedData, configs: payload.fund.configs, totalGross: payload.totalGross, expiry: payload.expiry });
    expect((await recoverAddress({ hash: compiled.digest, signature: payload.fund.acceptance.operatorSignature })).toLowerCase()).toBe(inputs.operator);
  });
});
