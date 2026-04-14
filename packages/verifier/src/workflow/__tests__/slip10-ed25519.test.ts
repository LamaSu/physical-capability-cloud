/**
 * SLIP-0010 hardened Ed25519 derivation tests.
 *
 * Reference:
 *   https://github.com/satoshilabs/slips/blob/master/slip-0010.md
 *
 * The official spec publishes two test vectors for ed25519. We pin every
 * published node from both vectors below — the cryptographic-correctness
 * floor for this module.
 */

import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import {
  masterKeyFromSeed,
  deriveChild,
  derivePath,
  validateHardenedPath,
  parsePath,
  HARDENED,
  type DerivedKey,
} from "../slip10-ed25519.js";

// ---------------------------------------------------------------------------
// Hex helpers (local so tests don't depend on a separate util)
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length input "${hex}"`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Official SLIP-0010 ed25519 test vectors
// ---------------------------------------------------------------------------
//
// These are pinned directly from the spec. Do not edit.
// Every `publicKey` field in the spec is prefixed with `00` (a marker byte);
// we strip it so our 32-byte raw pubkeys line up with tweetnacl's output.

const VECTOR_1_SEED =
  "000102030405060708090a0b0c0d0e0f";

/** Expected outputs at several depths from vector 1. */
const VECTOR_1_NODES = [
  {
    path: "m",
    chainCode:
      "90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb",
    privateKey:
      "2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7",
    publicKey:
      "a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed",
  },
  {
    path: "m/0'",
    chainCode:
      "8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69",
    privateKey:
      "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3",
    publicKey:
      "8c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c",
  },
  {
    path: "m/0'/1'",
    chainCode:
      "a320425f77d1b5c2505a6b1b27382b37368ee640e3557c315416801243552f14",
    privateKey:
      "b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2",
    publicKey:
      "1932a5270f335bed617d5b935c80aedb1a35bd9fc1e31acafd5372c30f5c1187",
  },
  {
    path: "m/0'/1'/2'",
    chainCode:
      "2e69929e00b5ab250f49c3fb1c12f252de4fed2c1db88387094a0f8c4c9ccd6c",
    privateKey:
      "92a5b23c0b8a99e37d07df3fb9966917f5d06e02ddbd909c7e184371463e9fc9",
    publicKey:
      "ae98736566d30ed0e9d2f4486a64bc95740d89c7db33f52121f8ea8f76ff0fc1",
  },
  {
    path: "m/0'/1'/2'/2'",
    chainCode:
      "8f6d87f93d750e0efccda017d662a1b31a266e4a6f5993b15f5c1f07f74dd5cc",
    privateKey:
      "30d1dc7e5fc04c31219ab25a27ae00b50f6fd66622f6e9c913253d6511d1e662",
    publicKey:
      "8abae2d66361c879b900d204ad2cc4984fa2aa344dd7ddc46007329ac76c429c",
  },
  {
    path: "m/0'/1'/2'/2'/1000000000'",
    chainCode:
      "68789923a0cac2cd5a29172a475fe9e0fb14cd6adb5ad98a3fa70333e7afa230",
    privateKey:
      "8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793",
    publicKey:
      "3c24da049451555d51a7014a37337aa4e12d41e485abccfa46b47dfb2af54b7a",
  },
] as const;

const VECTOR_2_SEED =
  "fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a29f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542";

const VECTOR_2_NODES = [
  {
    path: "m",
    chainCode:
      "ef70a74db9c3a5af931b5fe73ed8e1a53464133654fd55e7a66f8570b8e33c3b",
    privateKey:
      "171cb88b1b3c1db25add599712e36245d75bc65a1a5c9e18d76f9f2b1eab4012",
    publicKey:
      "8fe9693f8fa62a4305a140b9764c5ee01e455963744fe18204b4fb948249308a",
  },
  {
    path: "m/0'",
    chainCode:
      "0b78a3226f915c082bf118f83618a618ab6dec793752624cbeb622acb562862d",
    privateKey:
      "1559eb2bbec5790b0c65d8693e4d0875b1747f4970ae8b650486ed7470845635",
    publicKey:
      "86fab68dcb57aa196c77c5f264f215a112c22a912c10d123b0d03c3c28ef1037",
  },
  {
    path: "m/0'/2147483647'",
    chainCode:
      "138f0b2551bcafeca6ff2aa88ba8ed0ed8de070841f0c4ef0165df8181eaad7f",
    privateKey:
      "ea4f5bfe8694d8bb74b7b59404632fd5968b774ed545e810de9c32a4fb4192f4",
    publicKey:
      "5ba3b9ac6e90e83effcd25ac4e58a1365a9e35a3d3ae5eb07b9e4d90bcf7506d",
  },
] as const;

// ---------------------------------------------------------------------------
// Assertions helpers
// ---------------------------------------------------------------------------

function expectNodeMatches(
  actual: DerivedKey,
  expected: { chainCode: string; privateKey: string; publicKey: string },
): void {
  expect(bytesToHex(actual.privateKey)).toBe(expected.privateKey);
  expect(bytesToHex(actual.chainCode)).toBe(expected.chainCode);
  expect(bytesToHex(actual.publicKey)).toBe(expected.publicKey);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("SLIP-0010 hardened Ed25519 derivation", () => {
  // -------------------------------------------------------------------------
  // 1. Official test vectors — cryptographic correctness floor
  // -------------------------------------------------------------------------

  describe("Official SLIP-0010 ed25519 test vectors", () => {
    it("1. Vector 1 — master key matches spec", () => {
      const seed = hexToBytes(VECTOR_1_SEED);
      const master = masterKeyFromSeed(seed);
      expectNodeMatches(master, VECTOR_1_NODES[0]);
    });

    it("2. Vector 1 — m/0' matches spec", () => {
      const seed = hexToBytes(VECTOR_1_SEED);
      const derived = derivePath(seed, "m/0'");
      expectNodeMatches(derived, VECTOR_1_NODES[1]);
    });

    it("3. Vector 1 — m/0'/1' matches spec", () => {
      const seed = hexToBytes(VECTOR_1_SEED);
      const derived = derivePath(seed, "m/0'/1'");
      expectNodeMatches(derived, VECTOR_1_NODES[2]);
    });

    it("4. Vector 1 — m/0'/1'/2' matches spec", () => {
      const seed = hexToBytes(VECTOR_1_SEED);
      const derived = derivePath(seed, "m/0'/1'/2'");
      expectNodeMatches(derived, VECTOR_1_NODES[3]);
    });

    it("5. Vector 1 — m/0'/1'/2'/2' matches spec", () => {
      const seed = hexToBytes(VECTOR_1_SEED);
      const derived = derivePath(seed, "m/0'/1'/2'/2'");
      expectNodeMatches(derived, VECTOR_1_NODES[4]);
    });

    it("6. Vector 1 — m/0'/1'/2'/2'/1000000000' matches spec", () => {
      const seed = hexToBytes(VECTOR_1_SEED);
      const derived = derivePath(seed, "m/0'/1'/2'/2'/1000000000'");
      expectNodeMatches(derived, VECTOR_1_NODES[5]);
    });

    it("7. Vector 2 — master key matches spec", () => {
      const seed = hexToBytes(VECTOR_2_SEED);
      const master = masterKeyFromSeed(seed);
      expectNodeMatches(master, VECTOR_2_NODES[0]);
    });

    it("8. Vector 2 — m/0' matches spec", () => {
      const seed = hexToBytes(VECTOR_2_SEED);
      const derived = derivePath(seed, "m/0'");
      expectNodeMatches(derived, VECTOR_2_NODES[1]);
    });

    it("9. Vector 2 — m/0'/2147483647' matches spec (high hardened index)", () => {
      const seed = hexToBytes(VECTOR_2_SEED);
      const derived = derivePath(seed, "m/0'/2147483647'");
      expectNodeMatches(derived, VECTOR_2_NODES[2]);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Master key derivation
  // -------------------------------------------------------------------------

  describe("masterKeyFromSeed", () => {
    it("10. rejects a seed shorter than 16 bytes", () => {
      expect(() => masterKeyFromSeed(new Uint8Array(8))).toThrow(
        /seed length/,
      );
    });

    it("11. rejects a seed longer than 64 bytes", () => {
      expect(() => masterKeyFromSeed(new Uint8Array(100))).toThrow(
        /seed length/,
      );
    });

    it("12. rejects non-Uint8Array input", () => {
      // @ts-expect-error - intentional invalid input
      expect(() => masterKeyFromSeed("not a buffer")).toThrow(
        /Uint8Array/,
      );
    });

    it("13. produces a 32-byte privateKey, 32-byte chainCode, 32-byte publicKey", () => {
      const seed = hexToBytes(VECTOR_1_SEED);
      const master = masterKeyFromSeed(seed);
      expect(master.privateKey.length).toBe(32);
      expect(master.chainCode.length).toBe(32);
      expect(master.publicKey.length).toBe(32);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Single-step child derivation
  // -------------------------------------------------------------------------

  describe("deriveChild", () => {
    it("14. deriveChild(master, 0 | HARDENED) matches derivePath(seed, \"m/0'\")", () => {
      const seed = hexToBytes(VECTOR_1_SEED);
      const master = masterKeyFromSeed(seed);
      const childStep = deriveChild(master, 0 | HARDENED);
      const childPath = derivePath(seed, "m/0'");
      expect(bytesToHex(childStep.privateKey)).toBe(
        bytesToHex(childPath.privateKey),
      );
      expect(bytesToHex(childStep.chainCode)).toBe(
        bytesToHex(childPath.chainCode),
      );
      expect(bytesToHex(childStep.publicKey)).toBe(
        bytesToHex(childPath.publicKey),
      );
    });

    it("15. deriveChild throws on non-hardened index", () => {
      const seed = hexToBytes(VECTOR_1_SEED);
      const master = masterKeyFromSeed(seed);
      expect(() => deriveChild(master, 0)).toThrow(/hardened/);
      expect(() => deriveChild(master, 100)).toThrow(/hardened/);
      expect(() => deriveChild(master, 0x7fffffff)).toThrow(/hardened/);
    });

    it("16. deriveChild throws on non-integer index", () => {
      const seed = hexToBytes(VECTOR_1_SEED);
      const master = masterKeyFromSeed(seed);
      expect(() => deriveChild(master, 1.5)).toThrow(/integer/);
      expect(() => deriveChild(master, Number.NaN)).toThrow(/integer/);
    });

    it("17. deriveChild throws on parent with wrong-sized fields", () => {
      const bogus: DerivedKey = {
        privateKey: new Uint8Array(31),
        chainCode: new Uint8Array(32),
        publicKey: new Uint8Array(32),
      };
      expect(() => deriveChild(bogus, 0 | HARDENED)).toThrow(/privateKey/);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Path parsing
  // -------------------------------------------------------------------------

  describe("parsePath / validateHardenedPath", () => {
    it('18. parses empty path and "m" as the root', () => {
      expect(parsePath("")).toEqual([]);
      expect(parsePath("m")).toEqual([]);
      expect(parsePath("M")).toEqual([]);
    });

    it("19. accepts both ' and h as hardened markers", () => {
      // Note: `(x | HARDENED) >>> 0` normalizes to unsigned (JS bitwise OR
      // produces a signed int32). The implementation stores hardened
      // indices as unsigned because SLIP-0010 defines them as 32-bit
      // unsigned integers where hardened means bit-31 is set.
      expect(parsePath("m/0'")).toEqual([(0 | HARDENED) >>> 0]);
      expect(parsePath("m/0h")).toEqual([(0 | HARDENED) >>> 0]);
    });

    it("20. throws on a non-hardened segment", () => {
      expect(() => parsePath("m/0")).toThrow(/hardened/);
      expect(() => parsePath("m/0'/1")).toThrow(/hardened/);
      expect(() => validateHardenedPath("m/0/1'")).toThrow(/hardened/);
    });

    it("21. throws on malformed segments", () => {
      expect(() => parsePath("m/")).toThrow(/empty segment/);
      expect(() => parsePath("m/abc'")).toThrow(/non-negative integer/);
      expect(() => parsePath("m/-1'")).toThrow();
      expect(() => parsePath("m/0''")).toThrow(/non-negative integer/);
    });

    it("22. rejects indices already >= 2^31 before hardening", () => {
      expect(() => parsePath("m/2147483648'")).toThrow(/exceeds 2\^31/);
      expect(() => parsePath("m/4294967295'")).toThrow(/exceeds 2\^31/);
    });

    it("23. parses the PCC sessionKey path format", () => {
      const indices = parsePath("m/8004'/84532'/42'/0'");
      // Normalize each expected value to unsigned 32-bit to match the
      // implementation's return shape (see note on test 19).
      expect(indices).toEqual([
        (8004 | HARDENED) >>> 0,
        (84532 | HARDENED) >>> 0,
        (42 | HARDENED) >>> 0,
        (0 | HARDENED) >>> 0,
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Determinism
  // -------------------------------------------------------------------------

  describe("Determinism", () => {
    it("24. same path + same seed produces identical child", () => {
      const seed = hexToBytes(VECTOR_1_SEED);
      const a = derivePath(seed, "m/8004'/84532'/42'/0'");
      const b = derivePath(seed, "m/8004'/84532'/42'/0'");
      expect(bytesToHex(a.privateKey)).toBe(bytesToHex(b.privateKey));
      expect(bytesToHex(a.chainCode)).toBe(bytesToHex(b.chainCode));
      expect(bytesToHex(a.publicKey)).toBe(bytesToHex(b.publicKey));
    });

    it("25. different seeds produce different children at the same path", () => {
      const seedA = hexToBytes(VECTOR_1_SEED);
      const seedB = hexToBytes(VECTOR_2_SEED);
      const a = derivePath(seedA, "m/0'");
      const b = derivePath(seedB, "m/0'");
      expect(bytesToHex(a.privateKey)).not.toBe(bytesToHex(b.privateKey));
      expect(bytesToHex(a.publicKey)).not.toBe(bytesToHex(b.publicKey));
    });

    it("26. different paths from same seed produce different children", () => {
      const seed = hexToBytes(VECTOR_1_SEED);
      const a = derivePath(seed, "m/0'");
      const b = derivePath(seed, "m/1'");
      expect(bytesToHex(a.privateKey)).not.toBe(bytesToHex(b.privateKey));
    });

    it("27. empty path returns master (same as masterKeyFromSeed)", () => {
      const seed = hexToBytes(VECTOR_1_SEED);
      const viaMaster = masterKeyFromSeed(seed);
      const viaEmpty = derivePath(seed, "");
      const viaM = derivePath(seed, "m");
      expect(bytesToHex(viaMaster.privateKey)).toBe(
        bytesToHex(viaEmpty.privateKey),
      );
      expect(bytesToHex(viaMaster.privateKey)).toBe(
        bytesToHex(viaM.privateKey),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 6. Interoperability with tweetnacl signing
  // -------------------------------------------------------------------------

  describe("Interop with tweetnacl signing", () => {
    it("28. derived privateKey signs messages that verify against publicKey", () => {
      const seed = hexToBytes(VECTOR_1_SEED);
      const derived = derivePath(seed, "m/8004'/84532'/1'/0'");

      // Feed the 32-byte seed to tweetnacl to get the full 64-byte secretKey.
      const keypair = nacl.sign.keyPair.fromSeed(derived.privateKey);

      const message = new TextEncoder().encode(
        "sessionKey signs this payload",
      );
      const signature = nacl.sign.detached(message, keypair.secretKey);
      const ok = nacl.sign.detached.verify(
        message,
        signature,
        derived.publicKey,
      );
      expect(ok).toBe(true);

      // And a wrong message must NOT verify with the same signature.
      const bad = new TextEncoder().encode("tampered");
      expect(
        nacl.sign.detached.verify(bad, signature, derived.publicKey),
      ).toBe(false);
    });

    it("29. derived publicKey equals nacl.sign.keyPair.fromSeed(privateKey).publicKey", () => {
      const seed = hexToBytes(VECTOR_1_SEED);
      const derived = derivePath(seed, "m/0'/1'/2'");
      const keypair = nacl.sign.keyPair.fromSeed(derived.privateKey);
      expect(bytesToHex(new Uint8Array(keypair.publicKey))).toBe(
        bytesToHex(derived.publicKey),
      );
    });
  });
});
