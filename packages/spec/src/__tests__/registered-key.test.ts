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

  it("orders punctuation kernel ids by code unit, never locale collation (oracle #3348)", () => {
    // ICU would order these kernel_a, kernel-1, kernel-a, kernel:a, kernel.a, kernela.
    const ids = ["kernel_a", "kernel-1", "kernel-a", "kernel:a", "kernel.a", "kernela"];
    const entries = ids.map((kernelId, i) => ({
      kernelId,
      devicePrincipalId: `ed25519:0x${(i + 1).toString(16).padStart(2, "0").repeat(32)}`,
    }));
    const hash = computeKernelSigningKeySnapshotHash(entries);
    expect(computeKernelSigningKeySnapshotHash([...entries].reverse())).toBe(hash);
    // Pinned, and reproduced in Python over byte-sorted keys; the ICU order would hash to 0x3f68b28d…2d71.
    expect(hash).toBe("0xdc7e41004bdeba49e24f968e3138cd5cd5a1249823089ec6052651ddb867dd58");
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

describe("each registry entry is read once, and a leaked key never resolves (E2 finding 1)", () => {
  const v = makeRegisteredKeyVerifier();
  const ctx = { vocabVersion: 1 };
  const LEAKED = [...COMPROMISED_DEVICE_PUBLIC_KEYS][0]!;
  const ATTACKER = "0x" + "c3".repeat(32);

  /** A snapshot carrying `entries` but claiming the hash of `pinnedRows`, and the pin a deal holds for it. */
  function pinnedAs(pinnedRows: KernelSigningKeyEntry[], entries: unknown[]) {
    const snapshotHash = computeKernelSigningKeySnapshotHash(pinnedRows);
    const snapshot = { ...SNAP, snapshotHash, entriesLocator: { kind: "inline", entries } } as RegistrySnapshot;
    return { snapshot, pinned: { registryId: KERNEL_SIGNING_KEY_REGISTRY_ID, snapshotHash } };
  }

  /** Answers `first` for the first `n` reads and `later` from then on. */
  function flipsAfter<T>(n: number, first: T, later: T): () => T {
    let reads = 0;
    return () => (++reads <= n ? first : later);
  }

  // The deal pinned kernel-a to KEY_A. Each shape shows the reads that validate
  // and hash the snapshot the pinned rows, and any later read a row that makes
  // `evil` kernel-a's key.
  const attacks: [string, (evil: string) => ReturnType<typeof pinnedAs>][] = [
    ["a value getter", (evil) => {
      const value = flipsAfter(2, `ed25519:${KEY_A}`, `ed25519:${evil}`);
      return pinnedAs([ENTRIES[0]!], [{ key: "kernel-a", get value() { return value(); } }]);
    }],
    ["a key getter on another kernel's row", (evil) => {
      const key = flipsAfter(3, "kernel-x", "kernel-a");
      return pinnedAs(
        [ENTRIES[0]!, { kernelId: "kernel-x", devicePrincipalId: `ed25519:${evil}` }],
        [{ get key() { return key(); }, value: `ed25519:${evil}` }, { key: "kernel-a", value: `ed25519:${KEY_A}` }],
      );
    }],
    ["a proxied entries array", (evil) => {
      const row = flipsAfter(2, { key: "kernel-a", value: `ed25519:${KEY_A}` }, { key: "kernel-a", value: `ed25519:${evil}` });
      return pinnedAs([ENTRIES[0]!], new Proxy<unknown[]>([{}], { get: (t, p, r) => (p === "0" ? row() : Reflect.get(t, p, r)) }));
    }],
  ];

  it.each(attacks)("%s cannot show the hash one row and the signer comparison another", async (_shape, attack) => {
    const once = attack(ATTACKER);
    expect(verifyRegisteredKey({ ...once, kernelId: "kernel-a", signer: ATTACKER })).toMatchObject({ ok: false });
    const again = attack(ATTACKER);
    const r = await v.verify({ snapshot: again.snapshot, kernelId: "kernel-a", signer: ATTACKER }, again.pinned, ctx);
    expect(r).toMatchObject({ met: false });
  });

  it("reads each entry, and its key and value, exactly once", () => {
    const reads: Record<string, number> = {};
    const count = (what: string) => {
      reads[what] = (reads[what] ?? 0) + 1;
    };
    const rows = ENTRIES.map((e, i) => ({
      get key() {
        count(`[${i}].key`);
        return e.kernelId;
      },
      get value() {
        count(`[${i}].value`);
        return e.devicePrincipalId;
      },
    }));
    const entries = new Proxy(rows, {
      get: (t, p, r) => {
        if (typeof p === "string" && /^\d+$/.test(p)) count(`[${p}]`);
        return Reflect.get(t, p, r);
      },
    });
    const snapshot = { ...SNAP, entriesLocator: { kind: "inline", entries } } as RegistrySnapshot;
    expect(verify("kernel-a", KEY_A, snapshot)).toEqual({ ok: true });
    expect(reads).toEqual({ "[0]": 1, "[0].key": 1, "[0].value": 1, "[1]": 1, "[1].key": 1, "[1].value": 1 });
  });

  it("the leaked key does not resolve through a value getter either", async () => {
    const signer = `ed25519:${LEAKED}`;
    const once = attacks[0]![1](LEAKED);
    expect(verifyRegisteredKey({ ...once, kernelId: "kernel-a", signer })).toMatchObject({ ok: false });
    const again = attacks[0]![1](LEAKED);
    const r = await v.verify({ snapshot: again.snapshot, kernelId: "kernel-a", signer }, again.pinned, ctx);
    expect(r).toMatchObject({ met: false });
  });

  it("still refuses inline entries that are not an array, even an iterable of the pinned rows", () => {
    const set = new Set((SNAP.entriesLocator as { entries: unknown[] }).entries);
    expect(verify("kernel-a", KEY_A, { ...SNAP, entriesLocator: { kind: "inline", entries: set } } as never).ok).toBe(false);
  });

  it("refuses the leaked key spelled as a principal id, as it does its raw and object spellings", () => {
    for (const signer of [LEAKED, { algorithm: "ed25519", publicKey: LEAKED }, `ed25519:${LEAKED}`]) {
      expect(verify("kernel-a", signer), JSON.stringify(signer)).toEqual({
        ok: false,
        reason: "signer is not an Ed25519 key, or its secret is public",
      });
    }
  });
});

describe("verifyRegisteredKey fails closed on malformed runtime input and never throws (E2 finding 2)", () => {
  const good = { snapshot: SNAP, pinned: PINNED, kernelId: "kernel-a", signer: KEY_A };
  const inline = (entries: unknown) => ({ ...SNAP, entriesLocator: { kind: "inline", entries } });
  const unprintable = {
    toString(): string {
      throw new Error("cannot print");
    },
  };
  const cases: [string, unknown][] = [
    ["snapshot {} (the verdict's case)", { ...good, snapshot: {} }],
    ["a kernel-registry snapshot with no entriesLocator", { ...good, snapshot: { registryId: KERNEL_SIGNING_KEY_REGISTRY_ID } }],
    ["a null snapshot", { ...good, snapshot: null }],
    ["inline entries that are not an array", { ...good, snapshot: inline(5) }],
    ["a snapshotHash that is not a string", { ...good, snapshot: { ...SNAP, snapshotHash: 7 } }],
    ["no pinned", { ...good, pinned: undefined }],
    ["a pinned snapshotHash that is not a string", { ...good, pinned: { ...PINNED, snapshotHash: 7 } }],
    ["a bigint kernel id", { ...good, kernelId: 10n }],
    ["an entry getter that throws", { ...good, snapshot: inline([{ get key(): string { throw new Error("boom"); } }]) }],
    ["an entry getter that throws an unprintable value", { ...good, snapshot: inline([{ get key(): string { throw unprintable; } }]) }],
    ["no input at all", null],
  ];

  it.each(cases)("%s", (_name, input) => {
    let r: unknown;
    expect(() => {
      r = verifyRegisteredKey(input as never);
    }).not.toThrow();
    expect(r).toEqual({ ok: false, reason: expect.any(String) });
  });
});

describe("ident.registered_key checks the pinned params before the pending rule (E2 finding 3)", () => {
  const v = makeRegisteredKeyVerifier();
  const ctx = { vocabVersion: 1 };
  const cases: [string, unknown][] = [
    ["no params", undefined],
    ["null params", null],
    ["empty params (the verdict's case)", {}],
    ["no snapshotHash", { registryId: KERNEL_SIGNING_KEY_REGISTRY_ID }],
    ["no registryId", { snapshotHash: SNAP.snapshotHash }],
    ["a registryId that is not a string", { registryId: 7, snapshotHash: SNAP.snapshotHash }],
    ["another registry", { registryId: "pcc.registry.other.v1", snapshotHash: SNAP.snapshotHash }],
    ["a snapshotHash that is not a hash", { registryId: KERNEL_SIGNING_KEY_REGISTRY_ID, snapshotHash: "0x1234" }],
  ];

  it.each(cases)("not met, never pending, with %s and no instance yet", async (_name, params) => {
    expect(await v.verify(null, params, ctx)).toMatchObject({ met: false });
    expect(await v.verify(undefined, params, ctx)).toMatchObject({ met: false });
  });

  it("well-formed params still wait for an instance, and a digest in any case is the same hash", async () => {
    const instance = { snapshot: SNAP, kernelId: "kernel-a", signer: KEY_A };
    const upper = SNAP.snapshotHash.toUpperCase();
    for (const snapshotHash of [SNAP.snapshotHash, upper, "0x" + upper.slice(2)]) {
      const params = { registryId: KERNEL_SIGNING_KEY_REGISTRY_ID, snapshotHash };
      expect((await v.verify(null, params, ctx)).met, snapshotHash).toBe("pending");
      expect((await v.verify(instance, params, ctx)).met, snapshotHash).toBe(true);
    }
  });
});

describe("the ident.registered_key verifier never throws, even on a hostile thrown value (E2 finding 2, found in the fix round)", () => {
  const v = makeRegisteredKeyVerifier();
  const ctx = { vocabVersion: 1 };

  it("a getter that throws a value whose toString also throws still gives met:false", async () => {
    const hostile = { toString(): string { throw new Error("toString ran"); } };
    const params = { registryId: KERNEL_SIGNING_KEY_REGISTRY_ID, snapshotHash: `0x${"ab".repeat(32)}` };
    const instance = { get snapshot(): never { throw hostile; }, kernelId: "kernel-1", signer: "x" };
    const r = await v.verify(instance, params, ctx);
    expect(r.met).toBe(false);
  });
});
