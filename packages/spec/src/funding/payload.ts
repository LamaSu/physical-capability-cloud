/**
 * The strict parser for a gateway's buyer-funding prepare payload. Author: implementer-bravo (pcc-adk).
 *
 * Wire shape `pcc.vnext.buyer-funding.prepare.v1`: the buyer-funding plan's §3 step 4 list (chainId, factory,
 * escrow, USDC, ΣG, the typed data, the exact `fund()` args, expiry), plus a schema tag and the approve the gateway
 * expects the buyer to send. This is a proposal for plan S1.1; the gateway lane owns the route.
 *
 * Strict by design, and it never repairs a value:
 *   - every object has exactly its keys, no more and no fewer;
 *   - uint256 values are canonical decimal strings (a JS number silently corrupts values above 2^53), and
 *     uint8/uint16 values are integer numbers;
 *   - addresses are lowercase or valid EIP-55; bytes32 values are 0x plus 64 hex digits;
 *   - arrays are bounded by the contract's own caps (1..16 units, 1..16 payout legs per unit).
 * The result is built from fresh objects, so a caller mutating its payload later changes nothing.
 */
import { isAddress, type Address, type Hex } from "viem";
import { refuse } from "./errors.js";
import { JOB_POLICY_FIELDS, MAX_PAYOUT_LEGS, MAX_UNITS, type JobPolicyMessage, type UnitConfig } from "./vnext.js";

export const FUNDING_PREPARE_SCHEMA = "pcc.vnext.buyer-funding.prepare.v1";

/**
 * Keys that mark an x402 payment-required body or payment requirement. x402 "exact" pays with an EIP-3009
 * transfer to `payTo`: it cannot call `fund()`, and paying the escrow that way strands the USDC (plan G10).
 */
const X402_MARKERS = ["x402Version", "accepts", "payTo", "maxAmountRequired", "paymentRequirements", "scheme"];
/** Typed-data primary types that move tokens by signature alone (EIP-3009, EIP-2612). This SDK never signs one. */
const TOKEN_AUTH_TYPES = ["TransferWithAuthorization", "ReceiveWithAuthorization", "Permit"];

export interface PreparePayload {
  chainId: bigint;
  factory: Address;
  escrow: Address;
  usdc: Address;
  totalGross: bigint;
  expiry: bigint;
  typedData: {
    domain: { name: string; version: string; chainId: bigint; verifyingContract: Address };
    types: { JobPolicy: Array<{ name: string; type: string }> };
    primaryType: string;
    message: JobPolicyMessage;
  };
  approve: { token: Address; spender: Address; amount: bigint };
  fund: { configs: UnitConfig[]; acceptance: { expiry: bigint; payerSignature: Hex; operatorSignature: Hex } };
}

const UINT256_MAX = (1n << 256n) - 1n;
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
/** `VNextSettlementLib.MAX_SIGNATURE_BYTES`. */
const MAX_SIGNATURE_BYTES = 1024;
const MAX_STRING = 256;

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function obj(v: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(v)) refuse("BAD_PAYLOAD", `${path} is not a plain object`);
  const got = Object.keys(v).sort();
  const want = [...keys].sort();
  if (got.length !== want.length || got.some((key, i) => key !== want[i])) {
    refuse("BAD_PAYLOAD", `${path} has keys [${got.join(", ")}]; expected exactly [${want.join(", ")}]`);
  }
  return v;
}

function arr(v: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(v)) refuse("BAD_PAYLOAD", `${path} is not an array`);
  if (v.length < min || v.length > max) refuse("BAD_PAYLOAD", `${path} has ${v.length} entries; expected ${min}..${max}`);
  return v;
}

function uint256(v: unknown, path: string): bigint {
  if (typeof v !== "string" || !DECIMAL.test(v)) refuse("BAD_PAYLOAD", `${path} must be a canonical decimal string`);
  const n = BigInt(v);
  if (n > UINT256_MAX) refuse("BAD_PAYLOAD", `${path} exceeds uint256`);
  return n;
}

function small(v: unknown, path: string, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max) {
    refuse("BAD_PAYLOAD", `${path} must be an integer in [0, ${max}]`);
  }
  return v;
}

function address(v: unknown, path: string): Address {
  if (typeof v !== "string" || !isAddress(v)) refuse("BAD_PAYLOAD", `${path} is not an address (lowercase or valid EIP-55)`);
  return v;
}

function bytes32(v: unknown, path: string): Hex {
  if (typeof v !== "string" || !BYTES32.test(v)) refuse("BAD_PAYLOAD", `${path} is not a bytes32`);
  return v as Hex;
}

function signatureBytes(v: unknown, path: string): Hex {
  if (typeof v !== "string" || !HEX_BYTES.test(v) || (v.length - 2) / 2 > MAX_SIGNATURE_BYTES) {
    refuse("BAD_PAYLOAD", `${path} must be 0x-prefixed hex bytes, at most ${MAX_SIGNATURE_BYTES} bytes`);
  }
  return v as Hex;
}

function str(v: unknown, path: string): string {
  if (typeof v !== "string" || v.length > MAX_STRING) refuse("BAD_PAYLOAD", `${path} must be a string of at most ${MAX_STRING} characters`);
  return v;
}

const CONFIG_KEYS = [
  "milestoneIndex",
  "stepId",
  "requiredTier",
  "requestedTier",
  "g",
  "f",
  "n",
  "feeBps",
  "feeRecipient",
  "reclaimAt",
  "compositionSchemaVersion",
  "compositionRoot",
  "payouts",
] as const;

function unitConfig(v: unknown, i: number): UnitConfig {
  const at = `fund.configs[${i}]`;
  const c = obj(v, at, CONFIG_KEYS);
  return {
    milestoneIndex: uint256(c.milestoneIndex, `${at}.milestoneIndex`),
    stepId: bytes32(c.stepId, `${at}.stepId`),
    requiredTier: small(c.requiredTier, `${at}.requiredTier`, 0xff),
    requestedTier: small(c.requestedTier, `${at}.requestedTier`, 0xff),
    g: uint256(c.g, `${at}.g`),
    f: uint256(c.f, `${at}.f`),
    n: uint256(c.n, `${at}.n`),
    feeBps: small(c.feeBps, `${at}.feeBps`, 0xffff),
    feeRecipient: address(c.feeRecipient, `${at}.feeRecipient`),
    reclaimAt: uint256(c.reclaimAt, `${at}.reclaimAt`),
    compositionSchemaVersion: small(c.compositionSchemaVersion, `${at}.compositionSchemaVersion`, 0xffff),
    compositionRoot: bytes32(c.compositionRoot, `${at}.compositionRoot`),
    payouts: arr(c.payouts, `${at}.payouts`, 1, MAX_PAYOUT_LEGS).map((leg, j) => {
      const p = obj(leg, `${at}.payouts[${j}]`, ["recipient", "amount"]);
      return {
        recipient: address(p.recipient, `${at}.payouts[${j}].recipient`),
        amount: uint256(p.amount, `${at}.payouts[${j}].amount`),
      };
    }),
  };
}

function jobPolicyMessage(v: unknown): JobPolicyMessage {
  const at = "typedData.message";
  const m = obj(v, at, JOB_POLICY_FIELDS.map((f) => f.name));
  return {
    chainId: uint256(m.chainId, `${at}.chainId`),
    factory: address(m.factory, `${at}.factory`),
    implementation: address(m.implementation, `${at}.implementation`),
    escrow: address(m.escrow, `${at}.escrow`),
    policyVersion: uint256(m.policyVersion, `${at}.policyVersion`),
    payer: address(m.payer, `${at}.payer`),
    operator: address(m.operator, `${at}.operator`),
    jobIdHash: bytes32(m.jobIdHash, `${at}.jobIdHash`),
    termsHash: bytes32(m.termsHash, `${at}.termsHash`),
    policyNonce: uint256(m.policyNonce, `${at}.policyNonce`),
    prePolicyRoot: bytes32(m.prePolicyRoot, `${at}.prePolicyRoot`),
    unitsRoot: bytes32(m.unitsRoot, `${at}.unitsRoot`),
    expiry: uint256(m.expiry, `${at}.expiry`),
    acceptedPolicyDigest: bytes32(m.acceptedPolicyDigest, `${at}.acceptedPolicyDigest`),
  };
}

/** Parse a prepare payload, refusing x402 first (its own code), then anything off-schema (BAD_PAYLOAD). */
export function parsePreparePayload(raw: unknown): PreparePayload {
  if (!isPlainObject(raw)) refuse("BAD_PAYLOAD", "the payload is not a plain object");
  for (const marker of X402_MARKERS) {
    if (has(raw, marker)) refuse("X402_REFUSED", `the payload carries the x402 field "${marker}": x402 never funds a V-next escrow (plan G10)`);
  }
  const td0 = raw.typedData;
  if (isPlainObject(td0) && typeof td0.primaryType === "string" && TOKEN_AUTH_TYPES.includes(td0.primaryType)) {
    refuse("X402_REFUSED", `the typed data is an EIP-3009/EIP-2612 "${td0.primaryType}": this SDK signs only JobPolicy (plan G10)`);
  }

  const p = obj(raw, "payload", ["schema", "chainId", "factory", "escrow", "usdc", "totalGross", "expiry", "typedData", "approve", "fund"]);
  if (p.schema !== FUNDING_PREPARE_SCHEMA) refuse("BAD_PAYLOAD", `schema must be "${FUNDING_PREPARE_SCHEMA}"`);

  const td = obj(p.typedData, "typedData", ["domain", "types", "primaryType", "message"]);
  const d = obj(td.domain, "typedData.domain", ["name", "version", "chainId", "verifyingContract"]);
  const types = obj(td.types, "typedData.types", ["JobPolicy"]);
  const jobPolicyType = arr(types.JobPolicy, "typedData.types.JobPolicy", 1, 64).map((field, i) => {
    const f = obj(field, `typedData.types.JobPolicy[${i}]`, ["name", "type"]);
    return { name: str(f.name, `typedData.types.JobPolicy[${i}].name`), type: str(f.type, `typedData.types.JobPolicy[${i}].type`) };
  });

  const a = obj(p.approve, "approve", ["token", "spender", "amount"]);
  const f = obj(p.fund, "fund", ["configs", "acceptance"]);
  const acc = obj(f.acceptance, "fund.acceptance", ["expiry", "payerSignature", "operatorSignature"]);

  return {
    chainId: uint256(p.chainId, "chainId"),
    factory: address(p.factory, "factory"),
    escrow: address(p.escrow, "escrow"),
    usdc: address(p.usdc, "usdc"),
    totalGross: uint256(p.totalGross, "totalGross"),
    expiry: uint256(p.expiry, "expiry"),
    typedData: {
      domain: {
        name: str(d.name, "typedData.domain.name"),
        version: str(d.version, "typedData.domain.version"),
        chainId: uint256(d.chainId, "typedData.domain.chainId"),
        verifyingContract: address(d.verifyingContract, "typedData.domain.verifyingContract"),
      },
      types: { JobPolicy: jobPolicyType },
      primaryType: str(td.primaryType, "typedData.primaryType"),
      message: jobPolicyMessage(td.message),
    },
    approve: {
      token: address(a.token, "approve.token"),
      spender: address(a.spender, "approve.spender"),
      amount: uint256(a.amount, "approve.amount"),
    },
    fund: {
      configs: arr(f.configs, "fund.configs", 1, MAX_UNITS).map(unitConfig),
      acceptance: {
        expiry: uint256(acc.expiry, "fund.acceptance.expiry"),
        payerSignature: signatureBytes(acc.payerSignature, "fund.acceptance.payerSignature"),
        operatorSignature: signatureBytes(acc.operatorSignature, "fund.acceptance.operatorSignature"),
      },
    },
  };
}
