/**
 * EAS batch-attestation client — `multiAttest` for settling multiple milestones
 * in one transaction.
 *
 * The V2 settlement gate binds an EAS attestation (by UID) per milestone. When a
 * job has several milestones that settle together, minting their evidence
 * attestations one `EAS.attest()` at a time is N transactions (N nonces, N gas
 * lumps, N round-trips). `EAS.multiAttest([...])` mints them in ONE tx.
 *
 * Scope + flag-gating (keeps V1/V2 live paths intact):
 *   - These helpers are ADDITIVE. The live `/complete` flow settles a single
 *     milestone (index 0) and lets the OFF-CHAIN oracle mint via the EAS SDK, so
 *     nothing here is auto-engaged by the default flow.
 *   - This is the gateway-as-attester / self-hosted-oracle seam: when the gateway
 *     itself mints ≥2 evidence attestations together, it should use multiAttest.
 *     Gate that batch path with `PCC_EAS_MULTIATTEST=true` (`easMultiAttestEnabled`)
 *     so turning it on is an explicit, reversible per-deploy decision.
 *   - Writes go through escrow-client's `writeWithSigner`, so they share the ONE
 *     hot signer + the ONE nonce queue (a batch mint can't race an escrow release).
 *
 * Pure encoders (`encodeMultiAttest`, `buildEvidenceMultiAttestRequest`,
 * `groupEvidenceAttestationsBySchema`) take no wallet/network and are unit-tested
 * directly against viem's encode/decode.
 */

import { encodeFunctionData, type Address, type Hex } from "viem";
import { writeWithSigner, type WriteResult } from "./escrow-client.js";

/**
 * EAS predeploy address (Base + Base Sepolia OP-Stack predeploy). Override with
 * `EAS_CONTRACT_ADDRESS` for other chains. Mirrors escrow-client's default so a
 * batch mint and the per-milestone UID read resolve the same EAS contract.
 */
const DEFAULT_EAS_ADDRESS: Address =
  (process.env.EAS_CONTRACT_ADDRESS as Address | undefined) ??
  "0x4200000000000000000000000000000000000021";

/** bytes32 zero — default `refUID` (no parent attestation). */
const ZERO_BYTES32: Hex = `0x${"00".repeat(32)}`;

/**
 * Minimal IEAS `multiAttest` surface. Tuple component order mirrors the canonical
 * EAS `MultiAttestationRequest` / `AttestationRequestData` structs verbatim — it
 * is LOAD-BEARING (a node decodes calldata positionally).
 */
export const EAS_MULTIATTEST_ABI = [
  {
    name: "multiAttest",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "multiRequests",
        type: "tuple[]",
        components: [
          { name: "schema", type: "bytes32" },
          {
            name: "data",
            type: "tuple[]",
            components: [
              { name: "recipient", type: "address" },
              { name: "expirationTime", type: "uint64" },
              { name: "revocable", type: "bool" },
              { name: "refUID", type: "bytes32" },
              { name: "data", type: "bytes" },
              { name: "value", type: "uint256" },
            ],
          },
        ],
      },
    ],
    outputs: [{ name: "", type: "bytes32[]" }],
  },
] as const;

/** One attestation's payload within a multiAttest request (EAS AttestationRequestData). */
export interface EasAttestationRequestData {
  recipient: Address;
  expirationTime: bigint;
  revocable: boolean;
  refUID: Hex;
  /** ABI-encoded schema payload (e.g. `buildEasAttestationMetadata().encoded`). */
  data: Hex;
  value: bigint;
}

/** A group of attestations sharing one schema (EAS MultiAttestationRequest). */
export interface EasMultiAttestationRequest {
  schema: Hex;
  data: EasAttestationRequestData[];
}

/** Loose per-milestone input; sensible EAS defaults fill the rest. */
export interface EvidenceAttestationItem {
  /** The milestone's escrow address — becomes the EAS attestation recipient. */
  recipient: Address;
  /** ABI-encoded evidence payload (the bytes the escrow re-validates by UID). */
  data: Hex;
  /** EAS schema UID this attestation is made under. */
  schemaUid: Hex;
  refUID?: Hex;
  expirationTime?: bigint;
  revocable?: boolean;
  value?: bigint;
}

/** True when the gateway-mint batch path is explicitly enabled for this deploy. */
export function easMultiAttestEnabled(): boolean {
  const v = process.env.PCC_EAS_MULTIATTEST;
  return v === "true" || v === "1" || v === "yes";
}

/** The configured EAS contract address (predeploy unless EAS_CONTRACT_ADDRESS set). */
export function getEasAddress(easAddress?: Address): Address {
  return easAddress ?? DEFAULT_EAS_ADDRESS;
}

/** Map one item to EAS AttestationRequestData, applying defaults. */
function toRequestData(item: EvidenceAttestationItem): EasAttestationRequestData {
  return {
    recipient: item.recipient,
    expirationTime: item.expirationTime ?? 0n,
    revocable: item.revocable ?? true,
    refUID: item.refUID ?? ZERO_BYTES32,
    data: item.data,
    value: item.value ?? 0n,
  };
}

/**
 * Build a single MultiAttestationRequest for N items that share `schemaUid`.
 * Throws if any item carries a different schema (use
 * `groupEvidenceAttestationsBySchema` for mixed-schema batches).
 */
export function buildEvidenceMultiAttestRequest(
  schemaUid: Hex,
  items: EvidenceAttestationItem[],
): EasMultiAttestationRequest {
  for (const it of items) {
    if (it.schemaUid.toLowerCase() !== schemaUid.toLowerCase()) {
      throw new Error(
        `buildEvidenceMultiAttestRequest: item schema ${it.schemaUid} != group schema ${schemaUid}`,
      );
    }
  }
  return { schema: schemaUid, data: items.map(toRequestData) };
}

/**
 * Group mixed-schema items into one MultiAttestationRequest per distinct schema
 * (EAS multiAttest takes an array of per-schema groups). Preserves first-seen
 * schema order and item order within each group.
 */
export function groupEvidenceAttestationsBySchema(
  items: EvidenceAttestationItem[],
): EasMultiAttestationRequest[] {
  const order: string[] = [];
  const groups = new Map<string, EasMultiAttestationRequest>();
  for (const item of items) {
    const key = item.schemaUid.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = { schema: item.schemaUid, data: [] };
      groups.set(key, group);
      order.push(key);
    }
    group.data.push(toRequestData(item));
  }
  return order.map((k) => groups.get(k)!);
}

/** ABI-encode an `EAS.multiAttest(MultiAttestationRequest[])` call (pure). */
export function encodeMultiAttest(requests: EasMultiAttestationRequest[]): Hex {
  return encodeFunctionData({
    abi: EAS_MULTIATTEST_ABI,
    functionName: "multiAttest",
    args: [requests],
  });
}

/**
 * Mint a batch of EAS attestations in one `multiAttest` transaction, through the
 * gateway's nonce-managed hot signer. Returns the tx result plus the count of
 * attestations minted (sum across all schema groups).
 *
 * Throws on an empty batch — a no-op multiAttest would waste a tx + a nonce.
 */
export async function multiAttestEAS(
  requests: EasMultiAttestationRequest[],
  easAddress?: Address,
): Promise<WriteResult & { attestationCount: number }> {
  if (requests.length === 0) {
    throw new Error("multiAttestEAS: no attestation requests to submit");
  }
  const attestationCount = requests.reduce((n, r) => n + r.data.length, 0);
  if (attestationCount === 0) {
    throw new Error("multiAttestEAS: every request group is empty");
  }

  const res = await writeWithSigner({
    address: getEasAddress(easAddress),
    abi: EAS_MULTIATTEST_ABI,
    functionName: "multiAttest",
    args: [requests],
  });
  return { ...res, attestationCount };
}

/**
 * High-level helper: batch-mint evidence attestations for multiple milestones
 * that settle together. Groups by schema and issues ONE multiAttest tx.
 *
 * Returns `{ skipped: true }` without writing when the batch path is disabled
 * (`PCC_EAS_MULTIATTEST` unset) or there are fewer than 2 items — the caller then
 * falls back to the existing per-milestone single-attestation path. This is the
 * integration seam for a future multi-milestone settle; the live single-milestone
 * `/complete` flow is unchanged.
 */
export async function submitMilestoneAttestationsBatch(
  items: EvidenceAttestationItem[],
  easAddress?: Address,
): Promise<
  | { skipped: true; reason: string }
  | (WriteResult & { attestationCount: number; skipped: false })
> {
  if (!easMultiAttestEnabled()) {
    return { skipped: true, reason: "PCC_EAS_MULTIATTEST disabled" };
  }
  if (items.length < 2) {
    return { skipped: true, reason: `batch needs >=2 items, got ${items.length}` };
  }
  const requests = groupEvidenceAttestationsBySchema(items);
  const res = await multiAttestEAS(requests, easAddress);
  return { ...res, skipped: false };
}
