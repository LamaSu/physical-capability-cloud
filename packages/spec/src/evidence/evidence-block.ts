/**
 * EvidenceBlockV1 v2 — the evidence commitment a FinalMilestonePackageV2
 * carries as `evidence.evidenceBlockHash`. Ported from the evidence lane's
 * golden mirror (`packages/verifier/test-vectors/evidence-block-v2-mirror.cjs`
 * on #270) so a producer exists in public PCC; the mirror's pinned goldens are
 * reproduced byte-exact in the tests.
 *
 *   evidenceBlockHash = keccak256(abi.encode(
 *     bytes32 keccak256("PCC:vnext:evidence-block:v2"), uint16 2,
 *     bytes32 unitContextDigest, bytes32 kernelSignedEventsRoot,
 *     bytes32 sessionKeyAuthDigest, bytes32 attestationSetRoot,
 *     bytes32 workProductRoot, bytes32 programHash))
 *
 * The six roots:
 *   unitContextDigest       keccak256(abi.encode(keccak256("PCC:vnext:unit-context:v1"),
 *                           uint256 chainId, address escrow, bytes32 settlementUnitId,
 *                           bytes32 jobIdHash, uint256 milestoneIndex, bytes32 stepId,
 *                           bytes32 challengeNonce)): binds the block to one settlement
 *                           unit and one challenge, so evidence for unit A cannot be
 *                           replayed onto unit B
 *   kernelSignedEventsRoot  the bundle's `hashBundle` digest, as 0x + hex
 *   sessionKeyAuthDigest    0x + sha256(canonicalize(SessionKeyAuthorization))
 *   attestationSetRoot      0x + sha256(canonicalize(sorted role digests)); each role
 *                           digest binds roleId, the quorum config, the job and the
 *                           role's sorted attestation hashes, so attestations cannot be
 *                           relabelled to another role or a weaker quorum
 *   workProductRoot         `computeWorkProductHash` (WorkProduct.productHash)
 *   programHash             the committed program hash (`computeVerificationProgramHash`)
 *
 * `settlementUnitId` is the escrow's frozen derivation, keccak256(abi.encode(
 * keccak256("PCC:vnext:settlement-unit:v1"), uint256 chainId, address escrow,
 * bytes32 jobIdHash, uint256 milestoneIndex, bytes32 stepId)); a unit context
 * whose milestoneIndex or stepId does not reproduce it is incoherent.
 *
 * Input forms are pinned so the digests cannot depend on spelling: every hex
 * value is 0x + lowercase hex of its exact width (an EIP-55 checksummed address
 * must be lowercased by the caller), and integers are non-negative bigints,
 * safe integers or decimal strings.
 *
 * The block is evaluator-ready, not a money authority by itself: the oracle
 * reconstructs the unit context independently and pins programHash to the
 * funded policy's committed program.
 */

import { createHash } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3";
import { canonicalize } from "../util/canonical.js";
import type { SessionKeyAuthorization } from "../types/evidence.js";

export type Bytes32Hex = `0x${string}`;

const BYTES32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

/** Raised for an input that is not in its pinned form. */
export class EvidenceBlockInputError extends Error {
  readonly field: string;
  constructor(field: string, reason: string) {
    super(`EvidenceBlock input ${field}: ${reason}`);
    this.name = "EvidenceBlockInputError";
    this.field = field;
  }
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function keccakUtf8(s: string): Bytes32Hex {
  return `0x${toHex(keccak_256(new TextEncoder().encode(s)))}`;
}

export const EVIDENCE_BLOCK_DOMAIN_V2: Bytes32Hex = keccakUtf8("PCC:vnext:evidence-block:v2");
export const EVIDENCE_BLOCK_VERSION = 2;
export const UNIT_CONTEXT_DOMAIN_V1: Bytes32Hex = keccakUtf8("PCC:vnext:unit-context:v1");
export const SETTLEMENT_UNIT_DOMAIN_V1: Bytes32Hex = keccakUtf8("PCC:vnext:settlement-unit:v1");

// ── Static ABI words (every field here is a 32-byte head word) ──────────────

function bytes32Word(field: string, value: unknown): Uint8Array {
  if (typeof value !== "string" || !BYTES32.test(value)) {
    throw new EvidenceBlockInputError(field, "expected 0x + 64 lowercase hex");
  }
  return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
}

function addressWord(field: string, value: unknown): Uint8Array {
  if (typeof value !== "string" || !ADDRESS.test(value)) {
    throw new EvidenceBlockInputError(field, "expected 0x + 40 lowercase hex");
  }
  const word = new Uint8Array(32);
  word.set(Buffer.from(value.slice(2), "hex"), 12);
  return word;
}

function uintWord(field: string, value: unknown, bits: number): Uint8Array {
  let n: bigint;
  if (typeof value === "bigint") n = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === "string" && DECIMAL.test(value)) n = BigInt(value);
  else throw new EvidenceBlockInputError(field, "expected a non-negative integer");
  if (n < 0n || n >= 1n << BigInt(bits)) {
    throw new EvidenceBlockInputError(field, `out of range for uint${bits}`);
  }
  const word = new Uint8Array(32);
  for (let i = 31; i >= 0 && n > 0n; i--) {
    word[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return word;
}

function keccakWords(words: Uint8Array[]): Bytes32Hex {
  const buf = new Uint8Array(words.length * 32);
  words.forEach((w, i) => buf.set(w, i * 32));
  return `0x${toHex(keccak_256(buf))}`;
}

function sha256Canonical(value: unknown): Bytes32Hex {
  return `0x${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

// ── Unit identity ────────────────────────────────────────────────────────────

export interface SettlementUnitRef {
  chainId: bigint | number | string;
  escrow: string;
  jobIdHash: string;
  milestoneIndex: bigint | number | string;
  stepId: string;
}

/** The escrow's frozen settlement-unit id derivation. */
export function computeSettlementUnitId(unit: SettlementUnitRef): Bytes32Hex {
  return keccakWords([
    bytes32Word("SETTLEMENT_UNIT_DOMAIN_V1", SETTLEMENT_UNIT_DOMAIN_V1),
    uintWord("chainId", unit.chainId, 256),
    addressWord("escrow", unit.escrow),
    bytes32Word("jobIdHash", unit.jobIdHash),
    uintWord("milestoneIndex", unit.milestoneIndex, 256),
    bytes32Word("stepId", unit.stepId),
  ]);
}

export interface UnitContext extends SettlementUnitRef {
  settlementUnitId: string;
  challengeNonce: string;
}

/**
 * The unit + challenge context bound inside the block. Refuses a context whose
 * settlementUnitId does not derive from its own chainId, escrow, jobIdHash,
 * milestoneIndex and stepId.
 */
export function computeUnitContextDigest(ctx: UnitContext): Bytes32Hex {
  if (computeSettlementUnitId(ctx) !== ctx.settlementUnitId) {
    throw new EvidenceBlockInputError(
      "settlementUnitId",
      "does not derive from the context's chainId, escrow, jobIdHash, milestoneIndex and stepId",
    );
  }
  return keccakWords([
    bytes32Word("UNIT_CONTEXT_DOMAIN_V1", UNIT_CONTEXT_DOMAIN_V1),
    uintWord("chainId", ctx.chainId, 256),
    addressWord("escrow", ctx.escrow),
    bytes32Word("settlementUnitId", ctx.settlementUnitId),
    bytes32Word("jobIdHash", ctx.jobIdHash),
    uintWord("milestoneIndex", ctx.milestoneIndex, 256),
    bytes32Word("stepId", ctx.stepId),
    bytes32Word("challengeNonce", ctx.challengeNonce),
  ]);
}

// ── The sha256 roots ─────────────────────────────────────────────────────────

/** A tagged evidence digest (`sha256:<hex>`, e.g. a bundleHash) as a bytes32 root. */
export function taggedDigestToBytes32(digest: string): Bytes32Hex {
  if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new EvidenceBlockInputError("kernelSignedEventsRoot", "expected sha256: + 64 lowercase hex");
  }
  return `0x${digest.slice("sha256:".length)}`;
}

export function computeSessionKeyAuthDigest(auth: SessionKeyAuthorization): Bytes32Hex {
  return sha256Canonical(auth);
}

export interface AttestationQuorumRole {
  roleId: string;
  minPositive: number;
  total: number;
  minScore: number;
  /** Hashes of the role's attestations (0x + 64 lowercase hex). */
  attestationHashes: string[];
}

/** One role's digest: binds roleId, its quorum config, the job and its sorted attestations. */
export function computeAttestationRoleDigest(job: string, role: AttestationQuorumRole): Bytes32Hex {
  role.attestationHashes.forEach((h, i) => bytes32Word(`attestationHashes[${i}]`, h));
  return sha256Canonical({
    roleId: role.roleId,
    minPositive: role.minPositive,
    total: role.total,
    minScore: role.minScore,
    job,
    hashes: [...role.attestationHashes].sort(),
  });
}

export function computeAttestationSetRoot(job: string, roles: readonly AttestationQuorumRole[]): Bytes32Hex {
  return sha256Canonical(roles.map((r) => computeAttestationRoleDigest(job, r)).sort());
}

// ── The block ────────────────────────────────────────────────────────────────

export interface EvidenceBlockRoots {
  unitContextDigest: string;
  kernelSignedEventsRoot: string;
  sessionKeyAuthDigest: string;
  attestationSetRoot: string;
  workProductRoot: string;
  programHash: string;
}

export function computeEvidenceBlockHash(roots: EvidenceBlockRoots): Bytes32Hex {
  return keccakWords([
    bytes32Word("EVIDENCE_BLOCK_DOMAIN_V2", EVIDENCE_BLOCK_DOMAIN_V2),
    uintWord("version", EVIDENCE_BLOCK_VERSION, 16),
    bytes32Word("unitContextDigest", roots.unitContextDigest),
    bytes32Word("kernelSignedEventsRoot", roots.kernelSignedEventsRoot),
    bytes32Word("sessionKeyAuthDigest", roots.sessionKeyAuthDigest),
    bytes32Word("attestationSetRoot", roots.attestationSetRoot),
    bytes32Word("workProductRoot", roots.workProductRoot),
    bytes32Word("programHash", roots.programHash),
  ]);
}
