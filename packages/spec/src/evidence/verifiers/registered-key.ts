/**
 * `ident.registered_key` (#47): the signing subject resolves live in the
 * relevant pinned registry snapshot. It is the dependency of every signed
 * primitive (receipt.kernel_signed, machine.execution_log, ...), so no CSD
 * reaches tier 1 until it is verified.
 *
 * The registry it resolves against is the KERNEL SIGNING-KEY registry, a
 * map-shaped `RegistrySnapshot` (types/registry.ts) with id
 * `pcc.registry.kernel-signing-keys.v1`:
 *   key   = the kernel id (lowercase; computeMapSnapshotHash lowercases keys,
 *           so a mixed-case id is refused rather than silently folded);
 *   value = the kernel's device principal id, `ed25519:0x<64 lowercase hex>`
 *           (pcc.evidence.principal-id.v1), never a key whose secret is public.
 * Its hash is computeMapSnapshotHash (0x + sha256 of the canonical, key-sorted
 * entries). The gateway publishes snapshots of the registry it keeps, and the
 * accepted deal pins one (registryId + snapshotHash), so /settle checks a key
 * against the registry state the payer agreed to, never "whatever the registry
 * says now".
 *
 * `verifyRegisteredKey` recomputes the hash from the inline entries, requires
 * it to equal the pinned hash, finds the kernel's entry, and requires the
 * signer to be exactly that key. `makeRegisteredKeyVerifier` is the fail-closed
 * PrimitiveVerifier the oracle registers. verifierStatus stays "stub" until
 * the oracle runs it at /settle.
 */

import { computeMapSnapshotHash, type RegistrySnapshot } from "../../types/registry.js";
import type { PrimitiveVerifier, PrimitiveVerifyContext, PrimitiveVerifyResult } from "../verifier-interface.js";
import {
  formatDevicePrincipalId,
  isCompromisedDevicePublicKey,
  parseDevicePrincipalId,
  principalFromRegistry,
} from "../principal-id.js";

export const IDENT_REGISTERED_KEY_ID = "ident.registered_key";
export const KERNEL_SIGNING_KEY_REGISTRY_ID = "pcc.registry.kernel-signing-keys.v1";

/** One registry row: which Ed25519 key a kernel signs with. */
export interface KernelSigningKeyEntry {
  kernelId: string;
  devicePrincipalId: string;
}

const KERNEL_ID = /^[a-z0-9][a-z0-9._:-]*$/;

function entryProblem(e: { key?: unknown; value?: unknown }): string | null {
  if (typeof e.key !== "string" || !KERNEL_ID.test(e.key)) return "kernel id must be lowercase [a-z0-9._:-]";
  const principal = parseDevicePrincipalId(e.value);
  if (!principal) return "value must be ed25519:0x<64 lowercase hex>";
  if (isCompromisedDevicePublicKey(principal.publicKey)) return "value is a key whose secret is public";
  return null;
}

/** The snapshot hash of a kernel signing-key registry. Throws on a malformed or duplicate entry. */
export function computeKernelSigningKeySnapshotHash(entries: readonly KernelSigningKeyEntry[]): `0x${string}` {
  const mapEntries = entries.map((e) => ({ key: e.kernelId, value: e.devicePrincipalId }));
  for (const e of mapEntries) {
    const problem = entryProblem(e);
    if (problem) throw new Error(`kernel signing-key entry ${JSON.stringify(e.key)}: ${problem}`);
  }
  return computeMapSnapshotHash(mapEntries);
}

/** The device principal a signer stands for: a RegisteredSigner, a raw hex key, or a principal id. */
function signerPrincipal(signer: unknown): string | null {
  if (typeof signer === "string") {
    if (parseDevicePrincipalId(signer)) return signer;
    try {
      return formatDevicePrincipalId(signer);
    } catch {
      return null;
    }
  }
  const p = principalFromRegistry(signer, 1);
  return p !== null && p.startsWith("ed25519:") ? p : null;
}

export type RegisteredKeyResult = { ok: true } | { ok: false; reason: string };

/**
 * Does `signer` resolve, for `kernelId`, in the pinned kernel signing-key
 * snapshot? The snapshot must be the pinned one (registryId and snapshotHash),
 * carry its entries inline, and hash to its own and the pinned snapshotHash.
 */
export function verifyRegisteredKey(input: {
  snapshot: RegistrySnapshot;
  pinned: { registryId: string; snapshotHash: string };
  kernelId: string;
  signer: unknown;
}): RegisteredKeyResult {
  const { snapshot, pinned, kernelId, signer } = input;
  if (pinned.registryId !== KERNEL_SIGNING_KEY_REGISTRY_ID) {
    return { ok: false, reason: `pinned registry ${JSON.stringify(pinned.registryId)} is not the kernel signing-key registry` };
  }
  if (snapshot.registryId !== pinned.registryId) return { ok: false, reason: "snapshot is from another registry" };
  if (snapshot.entriesLocator.kind !== "inline") return { ok: false, reason: "snapshot entries must be inline to verify" };
  const entries = snapshot.entriesLocator.entries as { key?: unknown; value?: unknown }[];
  for (const e of entries) {
    const problem = entryProblem(e ?? {});
    if (problem) return { ok: false, reason: `malformed registry entry: ${problem}` };
  }
  let recomputed: string;
  try {
    recomputed = computeMapSnapshotHash(entries as { key: string; value: unknown }[]);
  } catch (err) {
    return { ok: false, reason: `malformed registry: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (recomputed !== snapshot.snapshotHash.toLowerCase() || recomputed !== pinned.snapshotHash.toLowerCase()) {
    return { ok: false, reason: "the snapshot does not hash to the pinned snapshotHash" };
  }
  const row = entries.find((e) => e.key === kernelId);
  if (!row) return { ok: false, reason: `kernel ${JSON.stringify(kernelId)} is not in the pinned registry` };
  const principal = signerPrincipal(signer);
  if (principal === null) return { ok: false, reason: "signer is not an Ed25519 key, or its secret is public" };
  if (principal !== row.value) return { ok: false, reason: "signer is not the key the pinned registry holds for this kernel" };
  return { ok: true };
}

/** The instance `ident.registered_key` verifies. */
export interface RegisteredKeyInstance {
  snapshot: RegistrySnapshot;
  kernelId: string;
  signer: unknown;
}

/**
 * The `ident.registered_key` PrimitiveVerifier. `params` is the primitive's
 * {registryId, snapshotHash}: the registry state the accepted deal pinned.
 * No instance yet means pending, and anything malformed fails closed. It never
 * throws.
 */
export function makeRegisteredKeyVerifier(): PrimitiveVerifier {
  return {
    id: IDENT_REGISTERED_KEY_ID,
    async verify(instance: unknown, params: unknown, _ctx: PrimitiveVerifyContext): Promise<PrimitiveVerifyResult> {
      if (instance === null || instance === undefined) {
        return { met: "pending", detail: ["no registry resolution yet"] };
      }
      try {
        const p = (params ?? {}) as { registryId?: unknown; snapshotHash?: unknown };
        if (typeof p.registryId !== "string" || typeof p.snapshotHash !== "string") {
          return { met: false, detail: ["params.registryId and params.snapshotHash are required: the deal pins the registry state"] };
        }
        const inst = instance as RegisteredKeyInstance;
        const r = verifyRegisteredKey({
          snapshot: inst.snapshot,
          pinned: { registryId: p.registryId, snapshotHash: p.snapshotHash },
          kernelId: inst.kernelId,
          signer: inst.signer,
        });
        return r.ok
          ? { met: true, detail: [`signer resolves for ${inst.kernelId} in the pinned registry`] }
          : { met: false, detail: [r.reason] };
      } catch (err) {
        return { met: false, detail: [`malformed instance: ${err instanceof Error ? err.message : String(err)}`] };
      }
    },
  };
}
