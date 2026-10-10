/**
 * The SDK's V-next encoders against the committed clean-room golden vectors (implementer-bravo, pcc-adk).
 *
 * `packages/contracts/test/fixtures/vnext-golden/vnext-golden-vectors.json` was computed by an independent
 * implementation from docs/VNEXT_SETTLEMENT_ABI.md alone, and the same values are pinned against the real
 * contracts (VNextAbiFreeze.t.sol) and the canonical compiler (vnext-compiler.test.ts). This test reads that
 * file rather than copying its literals, so a re-pin under the doc's §9 fails here until the SDK follows.
 * The Circle USDC pins are checked against VNextDeploySpec.sol the same way.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  concat,
  decodeAbiParameters,
  getAbiItem,
  hashTypedData,
  keccak256,
  parseAbiParameters,
  size,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { CIRCLE_USDC } from "../../funding/pins.js";
import {
  EIP712_DOMAIN_TYPEHASH,
  ESCROW_ABI,
  FACTORY_ABI,
  JOB_POLICY_TYPEHASH,
  POLICY_NONCE_DOMAIN,
  POLICY_SALT_DOMAIN,
  POLICY_VERSION,
  SETTLEMENT_UNIT_DOMAIN,
  acceptanceDigest,
  cloneInitCodeHash,
  cloneRuntimeCode,
  domainSeparator,
  jobIdHashOf,
  jobPolicyHash,
  jobPolicyTypedData,
  policyKey,
  policySalt,
  prePolicyRoot,
  predictEscrow,
  settlementUnitId,
  unitsRoot,
  type JobPolicyMessage,
  type UnitConfig,
} from "../../funding/vnext.js";

const CONTRACTS = new URL("../../../../contracts/", import.meta.url);
const golden = JSON.parse(readFileSync(new URL("test/fixtures/vnext-golden/vnext-golden-vectors.json", CONTRACTS), "utf8")) as {
  constants: Record<string, Hex>;
  derivedInputs: Record<string, Hex>;
  outputs: Record<string, string>;
  selectors: Record<string, Hex>;
  encodedConfigsHex: Hex;
};
const deploySpec = readFileSync(new URL("script/vnext/VNextDeploySpec.sol", CONTRACTS), "utf8");

/** Golden inputs that are not hashes (ABI doc §8 "Inputs"); addresses are anvil accounts 0 and 1, not keys. */
const CHAIN_ID = 8453n;
const PAYER: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OPERATOR: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const POLICY_NONCE = 7n;
const EXPIRY = 1_900_000_000n;

const CONFIG_TUPLES = parseAbiParameters(
  "(uint256,bytes32,uint8,uint8,uint256,uint256,uint256,uint16,address,uint256,uint16,bytes32,(address,uint256)[])[]",
);
const configs: UnitConfig[] = decodeAbiParameters(CONFIG_TUPLES, golden.encodedConfigsHex)[0].map((t) => ({
  milestoneIndex: t[0],
  stepId: t[1],
  requiredTier: t[2],
  requestedTier: t[3],
  g: t[4],
  f: t[5],
  n: t[6],
  feeBps: t[7],
  feeRecipient: t[8],
  reclaimAt: t[9],
  compositionSchemaVersion: t[10],
  compositionRoot: t[11],
  payouts: t[12].map((p) => ({ recipient: p[0], amount: p[1] })),
}));
const lc = (s: string) => s.toLowerCase();

describe("jobIdHashOf matches the canonical compiler's UTF-8 convention", () => {
  // Literals computed with packages/contracts/ts/vnext/compiler.ts:jobIdHashOf, not the SDK encoder.
  it.each([
    ["ASCII", "job-611-ascii", "0x586f24ab72321a4c051c3fbf02ba32451118816b2a7b8b1f734b20c78fa86cbb"],
    ["UUID", "550e8400-e29b-41d4-a716-446655440000", "0x2f779c94a35dceba72fe536ce28c5fea7566753044cdf9da29f6402ea964b7f9"],
    ["empty", "", "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"],
    ["non-ASCII", "job-" + String.fromCodePoint(0x00e9, 0x5236, 0x1f680), "0x1ac77bc57577bbd13c8ad3398c4aeb284c754754804da522054d15230b264a71"],
  ])("%s job id", (_label, jobId, hash) => {
    expect(jobIdHashOf(jobId!)).toBe(hash);
  });
});

describe("V-next encoders reproduce the golden vectors", () => {
  it("the domain constants and type hashes", () => {
    expect(SETTLEMENT_UNIT_DOMAIN).toBe(golden.constants.SETTLEMENT_UNIT_DOMAIN);
    expect(POLICY_SALT_DOMAIN).toBe(golden.constants.POLICY_SALT_DOMAIN);
    expect(POLICY_NONCE_DOMAIN).toBe(golden.constants.POLICY_NONCE_DOMAIN);
    expect(EIP712_DOMAIN_TYPEHASH).toBe(golden.constants.EIP712_DOMAIN_TYPEHASH);
    expect(JOB_POLICY_TYPEHASH).toBe(golden.constants.JOB_POLICY_TYPEHASH);
  });

  it("the decoded configs are the golden job (2 units, Σg = 1000000010)", () => {
    expect(configs).toHaveLength(2);
    expect(configs[0]!.g + configs[1]!.g).toBe(1_000_000_010n);
    expect(configs[1]!.milestoneIndex).toBe(0x0102030405060708090a0b0c0d0e0f10n);
  });

  it("prePolicyRoot, salt, clone init code, escrow, unit ids, unitsRoot, struct hash, domain, digest, policyKey", () => {
    const factory = golden.outputs.factory as Address;
    const implementation = golden.outputs.implementation as Address;
    const root = prePolicyRoot(configs);
    expect(root).toBe(golden.outputs.prePolicyRoot);
    const identity = {
      payer: PAYER,
      operator: OPERATOR,
      jobIdHash: golden.derivedInputs.jobIdHash!,
      termsHash: golden.derivedInputs.termsHash!,
      policyNonce: POLICY_NONCE,
      prePolicyRoot: root,
      acceptedPolicyDigest: golden.derivedInputs.acceptedPolicyDigest!,
    };
    const salt = policySalt(identity);
    expect(salt).toBe(golden.outputs.salt);
    expect(cloneInitCodeHash(implementation)).toBe(golden.outputs.initCodeHash);
    const escrow = predictEscrow(factory, implementation, salt);
    expect(lc(escrow)).toBe(golden.outputs.escrow);
    const ids = configs.map((c) =>
      settlementUnitId({ chainId: CHAIN_ID, escrow, jobIdHash: identity.jobIdHash, milestoneIndex: c.milestoneIndex, stepId: c.stepId }),
    );
    expect(ids).toEqual([golden.outputs.unitId0, golden.outputs.unitId1]);
    const uRoot = unitsRoot(ids);
    expect(uRoot).toBe(golden.outputs.unitsRoot);
    const message: JobPolicyMessage = {
      chainId: CHAIN_ID,
      factory,
      implementation,
      escrow,
      policyVersion: POLICY_VERSION,
      payer: PAYER,
      operator: OPERATOR,
      jobIdHash: identity.jobIdHash,
      termsHash: identity.termsHash,
      policyNonce: POLICY_NONCE,
      prePolicyRoot: root,
      unitsRoot: uRoot,
      expiry: EXPIRY,
      acceptedPolicyDigest: identity.acceptedPolicyDigest,
    };
    const structHash = jobPolicyHash(message);
    expect(structHash).toBe(golden.outputs.jobPolicyHash);
    const domainSep = domainSeparator(CHAIN_ID, escrow);
    expect(domainSep).toBe(golden.outputs.domainSeparator);
    const digest = acceptanceDigest(domainSep, structHash);
    expect(digest).toBe(golden.outputs.digest);
    // The typed data a wallet signs hashes to the same digest by viem's independent EIP-712 path.
    expect(hashTypedData(jobPolicyTypedData(message))).toBe(golden.outputs.digest);
    expect(policyKey(PAYER, OPERATOR, identity.jobIdHash)).toBe(golden.outputs.policyKey);
  });

  it("the fund() selector is the frozen one", () => {
    const fund = getAbiItem({ abi: ESCROW_ABI, name: "fund" });
    expect(toFunctionSelector(fund)).toBe(
      golden.selectors["fund((uint256,bytes32,uint8,uint8,uint256,uint256,uint256,uint16,address,uint256,uint16,bytes32,(address,uint256)[])[],(uint256,bytes,bytes))"],
    );
  });

  // reviewer-charlie L5 (implementer-delta): the two new live checks rest on these bytes.
  it("the factory's predictEscrow selector is the frozen one (its PolicyIdentity tuple in order)", () => {
    const predict = getAbiItem({ abi: FACTORY_ABI, name: "predictEscrow" });
    expect(toFunctionSelector(predict)).toBe(golden.selectors["predictEscrow((address,address,bytes32,bytes32,uint256,bytes32,bytes32))"]);
  });

  it("the clone runtime the SDK requires at the escrow is what the golden init code deploys", () => {
    const runtime = cloneRuntimeCode(golden.outputs.implementation as Address);
    expect(size(runtime)).toBe(45);
    // Clones.sol's 10-byte creation code copies the 0x2d bytes after it (offset 0x0a) and returns them as the code.
    expect(keccak256(concat(["0x3d602d80600a3d3981f3", runtime]))).toBe(golden.outputs.initCodeHash);
  });
});

describe("the built-in USDC pins are VNextDeploySpec's", () => {
  const pinned = (name: string): string => {
    const m = deploySpec.match(new RegExp(`address internal constant ${name} = (0x[0-9a-fA-F]{40});`));
    if (!m?.[1]) throw new Error(`VNextDeploySpec.sol has no ${name}`);
    return m[1];
  };
  it("Base mainnet and Base Sepolia, and no other chain", () => {
    expect(CIRCLE_USDC["8453"]).toBe(pinned("USDC_BASE"));
    expect(CIRCLE_USDC["84532"]).toBe(pinned("USDC_BASE_SEPOLIA"));
    expect(Object.keys(CIRCLE_USDC).sort()).toEqual(["8453", "84532"]);
  });
});
