import { encodeFunctionData, getAddress, zeroAddress, zeroHash, type Address, type Hex } from "viem";

export type OperatorChainId = 84532 | 31337;
export type OperatorSigningErrorCode = "bad_input" | "bad_escrow" | "bad_bytes32" |
  "bad_integer" | "zero_package_digest" | "signing_failed";

/** Signing errors retain only a closed code, never inputs or library exceptions. */
export class OperatorSigningError extends Error {
  readonly code: OperatorSigningErrorCode;
  constructor(code: OperatorSigningErrorCode) {
    super(code);
    this.name = "OperatorSigningError";
    this.code = code;
  }
}

export interface D1Input {
  escrow: Address;
  settlementUnitId: Hex;
  jobIdHash: Hex;
  milestoneIndex: number | bigint;
  stepId: Hex;
  compositionRoot: Hex;
  acceptedEnvelopeHash: Hex;
  packageBodyHash: Hex;
}

export interface SubmitEvidenceTxInput {
  escrow: Address;
  unitId: Hex;
  packageDigest: Hex;
  nonce: number | bigint;
  gas: number | bigint;
  maxFeePerGas: number | bigint;
  maxPriorityFeePerGas: number | bigint;
}

// Frozen recursively: an importer cannot change what the signing closure encodes.
export const submitEvidenceAbiItem = Object.freeze({
  type: "function",
  name: "submitEvidence",
  stateMutability: "nonpayable",
  inputs: Object.freeze([
    Object.freeze({ name: "unitId", type: "bytes32" }),
    Object.freeze({ name: "packageDigest", type: "bytes32" }),
  ]),
  outputs: Object.freeze([]),
} as const);

// Exact field order/types from gateway/settlement/operator-signature-verifier.ts.
const d1Types = Object.freeze({
  FinalMilestonePackageV2: Object.freeze([
    Object.freeze({ name: "chainId", type: "uint256" }),
    Object.freeze({ name: "escrow", type: "address" }),
    Object.freeze({ name: "settlementUnitId", type: "bytes32" }),
    Object.freeze({ name: "jobIdHash", type: "bytes32" }),
    Object.freeze({ name: "milestoneIndex", type: "uint256" }),
    Object.freeze({ name: "stepId", type: "bytes32" }),
    Object.freeze({ name: "compositionRoot", type: "bytes32" }),
    Object.freeze({ name: "acceptedEnvelopeHash", type: "bytes32" }),
    Object.freeze({ name: "packageBodyHash", type: "bytes32" }),
  ]),
} as const);

const uint256Max = (1n << 256n) - 1n;

/** Snapshot data properties once. Reject extras, inherited fields and accessors. */
function inputRecord(input: unknown, fields: readonly string[]): Record<string, unknown> {
  try {
    if (input === null || typeof input !== "object") throw new OperatorSigningError("bad_input");
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== null && prototype !== Object.prototype) throw new OperatorSigningError("bad_input");
    const names = Reflect.ownKeys(input);
    if (names.length !== fields.length || names.some((name) => typeof name !== "string" || !fields.includes(name))) {
      throw new OperatorSigningError("bad_input");
    }
    const record: Record<string, unknown> = Object.create(null);
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new OperatorSigningError("bad_input");
      }
      record[field] = descriptor.value;
    }
    return record;
  } catch {
    throw new OperatorSigningError("bad_input");
  }
}

function escrowAddress(value: unknown): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value) || value === zeroAddress) {
    throw new OperatorSigningError("bad_escrow");
  }
  try {
    if (getAddress(value) === value) return value as Address;
  } catch { /* Collapse address-library exceptions to the closed code. */ }
  throw new OperatorSigningError("bad_escrow");
}

function bytes32(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) throw new OperatorSigningError("bad_bytes32");
  return value as Hex;
}

function unsignedInteger(value: unknown, max = uint256Max): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new OperatorSigningError("bad_integer");
    value = BigInt(value);
  }
  if (typeof value !== "bigint" || value < 0n || value > max) throw new OperatorSigningError("bad_integer");
  return value;
}

export function prepareD1(input: D1Input, chainId: OperatorChainId) {
  const record = inputRecord(input, ["escrow", "settlementUnitId", "jobIdHash", "milestoneIndex",
    "stepId", "compositionRoot", "acceptedEnvelopeHash", "packageBodyHash"]);
  const escrow = escrowAddress(record.escrow);
  return {
    domain: { name: "PCC FinalMilestonePackage", version: "2", chainId, verifyingContract: escrow },
    types: d1Types,
    primaryType: "FinalMilestonePackageV2" as const,
    message: {
      chainId: BigInt(chainId), escrow,
      settlementUnitId: bytes32(record.settlementUnitId),
      jobIdHash: bytes32(record.jobIdHash),
      milestoneIndex: unsignedInteger(record.milestoneIndex),
      stepId: bytes32(record.stepId),
      compositionRoot: bytes32(record.compositionRoot),
      acceptedEnvelopeHash: bytes32(record.acceptedEnvelopeHash),
      packageBodyHash: bytes32(record.packageBodyHash),
    },
  };
}

export function prepareSubmitEvidenceTx(input: SubmitEvidenceTxInput, chainId: OperatorChainId) {
  const record = inputRecord(input, ["escrow", "unitId", "packageDigest", "nonce", "gas",
    "maxFeePerGas", "maxPriorityFeePerGas"]);
  const escrow = escrowAddress(record.escrow);
  const unitId = bytes32(record.unitId);
  const packageDigest = bytes32(record.packageDigest);
  if (packageDigest === zeroHash) throw new OperatorSigningError("zero_package_digest");
  return {
    type: "eip1559" as const,
    chainId,
    to: escrow,
    value: 0n,
    data: encodeFunctionData({ abi: [submitEvidenceAbiItem], functionName: "submitEvidence", args: [unitId, packageDigest] }),
    nonce: Number(unsignedInteger(record.nonce, BigInt(Number.MAX_SAFE_INTEGER))),
    gas: unsignedInteger(record.gas),
    maxFeePerGas: unsignedInteger(record.maxFeePerGas),
    maxPriorityFeePerGas: unsignedInteger(record.maxPriorityFeePerGas),
  };
}
