/**
 * Carried copy of the ratified v2.1 producer in tmp/vnext-termshash-golden-v1.md
 * (Encoding, Pinned normalization, EQUALITY PREDICATE), economics bus #8165 and
 * evidence #8168. Private to funding until evidence's public producer is available.
 * The funded order is load-bearing: never sort, deduplicate, or rematch milestones.
 */
import { encodeAbiParameters, isAddress, keccak256, stringToHex, type Address, type Hex } from "viem";

export interface TermsMilestoneV21 {
  readonly milestoneIndex: bigint;
  readonly stepId: Hex;
  readonly amount: bigint;
  readonly deadline: bigint;
}

export interface JobTermsV21 {
  readonly token: Address;
  readonly assuranceTier: number;
  readonly milestones: readonly TermsMilestoneV21[];
}

/** Funding maps this validation error to a buyer refusal before any RPC. */
export class TermsHashV21Error extends Error {
  readonly code = "INVALID_TERMS_V21";
  constructor(message: string) {
    super(message);
    this.name = "TermsHashV21Error";
  }
}

export const TERMS_DOMAIN_V1 = keccak256(stringToHex("PCC:vnext:job-terms:v1"));
const UINT256_MAX = (1n << 256n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;
const milestoneAbi = [{ type: "tuple[]", components: [
  { name: "milestoneIndex", type: "uint256" }, { name: "stepId", type: "bytes32" },
  { name: "amount", type: "uint256" }, { name: "deadline", type: "uint64" },
] }] as const;

function uint(value: unknown, max: bigint, field: string): asserts value is bigint {
  if (typeof value !== "bigint" || value < 0n || value > max) {
    throw new TermsHashV21Error(`${field} must be a bigint in 0..${max}`);
  }
}

export function computeMilestonesRootV21(milestones: readonly TermsMilestoneV21[]): Hex {
  if (!Array.isArray(milestones) || milestones.length === 0) {
    throw new TermsHashV21Error("milestones must contain at least one milestone");
  }
  const seen = new Set<string>();
  for (const [i, milestone] of milestones.entries()) {
    if (milestone === null || typeof milestone !== "object") throw new TermsHashV21Error(`milestones[${i}] must be an object`);
    uint(milestone.milestoneIndex, UINT256_MAX, `milestones[${i}].milestoneIndex`);
    uint(milestone.amount, UINT256_MAX, `milestones[${i}].amount`);
    uint(milestone.deadline, UINT64_MAX, `milestones[${i}].deadline`);
    if (typeof milestone.stepId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(milestone.stepId)) {
      throw new TermsHashV21Error(`milestones[${i}].stepId must be a 32-byte hex`);
    }
    const pair = `${milestone.milestoneIndex}:${milestone.stepId.toLowerCase()}`;
    if (seen.has(pair)) throw new TermsHashV21Error(`duplicate milestone (milestoneIndex, stepId) at ${i}`);
    seen.add(pair);
  }
  return keccak256(encodeAbiParameters(milestoneAbi, [milestones]));
}

export function computeTermsHashV21(terms: JobTermsV21): Hex {
  if (terms === null || typeof terms !== "object") throw new TermsHashV21Error("terms must be an object");
  const { token, assuranceTier, milestones } = terms;
  if (typeof token !== "string" || !isAddress(token, { strict: false })) throw new TermsHashV21Error("token must be a valid address");
  if (!Number.isInteger(assuranceTier) || assuranceTier < 0 || assuranceTier > 3) throw new TermsHashV21Error("assuranceTier must be an integer in 0..3");
  const milestonesRoot = computeMilestonesRootV21(milestones);
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "uint8" }, { type: "bytes32" }],
    [TERMS_DOMAIN_V1, token.toLowerCase() as Address, assuranceTier, milestonesRoot],
  ));
}
