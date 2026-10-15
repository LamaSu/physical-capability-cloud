/**
 * Ratified CanonicalJobTermsV1 v2.1 (Aug 6): ~/.claude/shared/vnext-termshash-golden-v1.md.
 * Reference: pcc-oracle src/terms-hash.ts @87bc14e. Replace this local
 * producer with @pcc/spec's producer when that merges, keeping the goldens.
 */
import { encodeAbiParameters, isAddress, keccak256, toBytes, type Address, type Hex } from "viem";

type Milestone = {
  readonly milestoneIndex: bigint | number;
  readonly stepId: Hex;
  readonly amount: bigint | number;
  readonly deadline: bigint | number;
};

export const TERMS_DOMAIN = keccak256(toBytes("PCC:vnext:job-terms:v1"));

function uint(value: bigint | number, bits: number): bigint {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || Object.is(value, -0))) {
    throw new Error(`Invalid uint${bits}`);
  }
  if (typeof value !== "number" && typeof value !== "bigint") throw new Error(`Invalid uint${bits}`);
  const integer = BigInt(value);
  if (integer < 0n || integer >= (1n << BigInt(bits))) throw new Error(`Invalid uint${bits}`);
  return integer;
}

export function computeMilestonesRoot(milestones: readonly Milestone[]): Hex {
  if (!Array.isArray(milestones) || milestones.length === 0) throw new Error("Missing milestones");
  const identities = new Set<string>();
  const values = milestones.map((milestone) => {
    const milestoneIndex = uint(milestone.milestoneIndex, 256);
    if (typeof milestone.stepId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(milestone.stepId)) {
      throw new Error("Invalid stepId");
    }
    const identity = `${milestoneIndex}:${milestone.stepId.toLowerCase()}`;
    if (identities.has(identity)) throw new Error("Duplicate milestone");
    identities.add(identity);
    return {
      milestoneIndex,
      stepId: milestone.stepId,
      amount: uint(milestone.amount, 256),
      deadline: uint(milestone.deadline, 64),
    };
  });
  return keccak256(encodeAbiParameters([{ type: "tuple[]", components: [
    { name: "milestoneIndex", type: "uint256" },
    { name: "stepId", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ] }], [values]));
}

export function computeTermsHash({ token, assuranceTier, milestones }: {
  readonly token: Address;
  readonly assuranceTier: bigint | number;
  readonly milestones: readonly Milestone[];
}): Hex {
  if (typeof token !== "string" || !isAddress(token, { strict: false })) throw new Error("Invalid token");
  const tier = Number(uint(assuranceTier, 8));
  if (tier > 3) throw new Error("Invalid assuranceTier: expected 0..3");
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "uint8" }, { type: "bytes32" }],
    [TERMS_DOMAIN, token, tier, computeMilestonesRoot(milestones)],
  ));
}
