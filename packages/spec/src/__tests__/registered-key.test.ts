import { describe, it, expect } from "vitest";
import {
  IDENT_REGISTERED_KEY_ID,
  KERNEL_SIGNING_KEY_REGISTRY_ID,
  computeKernelSigningKeySnapshotHash,
  makeRegisteredKeyVerifier,
  verifyRegisteredKey,
  type KernelSigningKeyEntry,
} from "../evidence/verifiers/registered-key.js";
import { COMPROMISED_DEVICE_PUBLIC_KEYS } from "../evidence/principal-id.js";
import type { RegistrySnapshot } from "../types/registry.js";

const KEY_A = "0x" + "7a".repeat(32);
const KEY_B = "0x" + "7b".repeat(32);
const ENTRIES: KernelSigningKeyEntry[] = [
  { kernelId: "kernel-a", devicePrincipalId: `ed25519:${KEY_A}` },
  { kernelId: "kernel-b", devicePrincipalId: `ed25519:${KEY_B}` },
];

function snapshotOf(entries: KernelSigningKeyEntry[], over: Partial<RegistrySnapshot> = {}): RegistrySnapshot {
  return {
    registryId: KERNEL_SIGNING_KEY_REGISTRY_ID,
    version: 1,
    snapshotHash: computeKernelSigningKeySnapshotHash(entries),
    entriesLocator: { kind: "inline", entries: entries.map((e) => ({ key: e.kernelId, value: e.devicePrincipalId })) },
    publisherSignature: "0x00",
    publishedAt: 0,
    ...over,
  } as RegistrySnapshot;
}
const SNAP = snapshotOf(ENTRIES);
const PINNED = { registryId: KERNEL_SIGNING_KEY_REGISTRY_ID, snapshotHash: SNAP.snapshotHash };
const verify = (kernelId: string, signer: unknown, snapshot = SNAP, pinned = PINNED) =>
  verifyRegisteredKey({ snapshot, pinned, kernelId, signer });

describe("the kernel signing-key registry snapshot", () => {
  it("hashes the same set the same way whatever the order", () => {
    expect(computeKernelSigningKeySnapshotHash([...ENTRIES].reverse())).toBe(SNAP.snapshotHash);
    // Pinned: sha256(canonicalize({entries: key-sorted})), the map-registry hash (types/registry.ts).
    expect(SNAP.snapshotHash).toBe("0x38ff407cb60d5a24aa977dd3684fe66f83cea2fb62e644dbf68b4789f1d428db");
  });

  it("refuses rows the registry must never hold", () => {
    const leaked = [...COMPROMISED_DEVICE_PUBLIC_KEYS][0]!;
    for (const bad of [
      [{ kernelId: "Kernel-A", devicePrincipalId: `ed25519:${KEY_A}` }],
      [{ kernelId: "kernel-a", devicePrincipalId: KEY_A }],
      [{ kernelId: "kernel-a", devicePrincipalId: `ed25519:${leaked}` }],
      [ENTRIES[0]!, { ...ENTRIES[1]!, kernelId: "kernel-a" }],
    ]) {
      expect(() => computeKernelSigningKeySnapshotHash(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe("verifyRegisteredKey", () => {
  it("the kernel's own key resolves, however the signer is spelled", () => {
    expect(verify("kernel-a", KEY_A)).toEqual({ ok: true });
    expect(verify("kernel-a", KEY_A.toUpperCase().replace("0X", "0x"))).toEqual({ ok: true });
    expect(verify("kernel-a", { algorithm: "ed25519", publicKey: KEY_A })).toEqual({ ok: true });
    expect(verify("kernel-a", `ed25519:${KEY_A}`)).toEqual({ ok: true });
  });

  it("another kernel's key, an unknown kernel and a non-Ed25519 signer do not resolve", () => {
    expect(verify("kernel-a", KEY_B).ok).toBe(false);
    expect(verify("kernel-c", KEY_A).ok).toBe(false);
    expect(verify("kernel-a", { algorithm: "secp256k1", address: "0x" + "ab".repeat(20) }).ok).toBe(false);
  });

  it("only the PINNED snapshot counts: another state, a tampered one, another registry, an unfetched one", () => {
    const rotated = snapshotOf([{ ...ENTRIES[0]!, devicePrincipalId: `ed25519:${KEY_B}` }, ENTRIES[1]!]);
    expect(verify("kernel-a", KEY_B, rotated).ok).toBe(false); // valid snapshot, but not the one the deal pinned
    const tampered = snapshotOf(ENTRIES);
    (tampered.entriesLocator as { entries: { key: string; value: string }[] }).entries[0]!.value = `ed25519:${KEY_B}`;
    expect(verify("kernel-a", KEY_B, tampered).ok).toBe(false);
    expect(verify("kernel-a", KEY_A, SNAP, { ...PINNED, registryId: "pcc.registry.other.v1" }).ok).toBe(false);
    expect(verify("kernel-a", KEY_A, snapshotOf(ENTRIES, { registryId: "pcc.registry.other.v1" })).ok).toBe(false);
    // A deal that pinned a DIFFERENT registry (same entry shape) is not the kernel signing-key registry.
    const other = snapshotOf(ENTRIES, { registryId: "pcc.registry.other.v1" });
    expect(verify("kernel-a", KEY_A, other, { registryId: "pcc.registry.other.v1", snapshotHash: other.snapshotHash }).ok).toBe(false);
    const ipfs = snapshotOf(ENTRIES, { entriesLocator: { kind: "ipfs", cid: "bafy", entryCount: 2 } as never });
    expect(verify("kernel-a", KEY_A, ipfs).ok).toBe(false);
  });
});

describe("ident.registered_key PrimitiveVerifier", () => {
  const v = makeRegisteredKeyVerifier();
  const ctx = { vocabVersion: 1 };
  const params = { registryId: KERNEL_SIGNING_KEY_REGISTRY_ID, snapshotHash: SNAP.snapshotHash };

  it("is registered under its vocabulary id", () => {
    expect(v.id).toBe(IDENT_REGISTERED_KEY_ID);
  });

  it("pending with no instance; met for the kernel's key in the pinned snapshot", async () => {
    expect((await v.verify(null, params, ctx)).met).toBe("pending");
    expect((await v.verify({ snapshot: SNAP, kernelId: "kernel-a", signer: KEY_A }, params, ctx)).met).toBe(true);
  });

  it("not met without pinned params, for another key, or for garbage, and never throws", async () => {
    expect((await v.verify({ snapshot: SNAP, kernelId: "kernel-a", signer: KEY_A }, {}, ctx)).met).toBe(false);
    expect((await v.verify({ snapshot: SNAP, kernelId: "kernel-a", signer: KEY_B }, params, ctx)).met).toBe(false);
    const r = await v.verify({ snapshot: {}, kernelId: 7, signer: null }, params, ctx);
    expect(r.met).toBe(false);
  });
});
