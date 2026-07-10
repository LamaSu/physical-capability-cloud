/**
 * RegisteredSigner normalization — fail-closed parser for the algorithm-tagged
 * signing key (Option C). Money path: anything that is not exactly one of the
 * two pinned shapes normalizes to null.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeRegisteredSigner,
  type RegisteredSigner,
} from "../evidence/verifiers/registered-signer.js";

// A canonical EIP-55 vector (from the EIP-55 spec examples). Feeding the
// all-lowercase form must reproduce this exact checksummed casing — this is
// the test that proves the keccak-based checksum implementation is correct.
const EIP55_CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const EIP55_LOWER = EIP55_CHECKSUMMED.toLowerCase();

// A raw 32-byte Ed25519 public key (64 hex). Value is arbitrary but well-formed.
const ED_PUB_64 =
  "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";

describe("normalizeRegisteredSigner — secp256k1 (money plane)", () => {
  it("checksums a bare lowercase address to EIP-55 (secp256k1 by default)", () => {
    const out = normalizeRegisteredSigner(EIP55_LOWER);
    expect(out).toEqual({ algorithm: "secp256k1", address: EIP55_CHECKSUMMED });
  });

  it("accepts an already-checksummed bare address and preserves the checksum", () => {
    const out = normalizeRegisteredSigner(EIP55_CHECKSUMMED);
    expect(out).toEqual({ algorithm: "secp256k1", address: EIP55_CHECKSUMMED });
  });

  it("accepts the tagged secp256k1 object and re-checksums the address", () => {
    const out = normalizeRegisteredSigner({
      algorithm: "secp256k1",
      address: EIP55_LOWER,
    });
    expect(out).toEqual({ algorithm: "secp256k1", address: EIP55_CHECKSUMMED });
  });

  it("rejects an address of the wrong length", () => {
    expect(normalizeRegisteredSigner("0x1234")).toBeNull();
    expect(normalizeRegisteredSigner(`${EIP55_LOWER}00`)).toBeNull();
  });

  it("rejects a non-hex address", () => {
    expect(
      normalizeRegisteredSigner("0xZZAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"),
    ).toBeNull();
  });
});

describe("normalizeRegisteredSigner — ed25519 (device/evidence plane)", () => {
  it("normalizes a tagged ed25519 key to 0x + lowercase 64-hex", () => {
    const out = normalizeRegisteredSigner({
      algorithm: "ed25519",
      publicKey: ED_PUB_64.toUpperCase(), // upper on input
    });
    expect(out).toEqual({ algorithm: "ed25519", publicKey: `0x${ED_PUB_64}` });
  });

  it("accepts a 0x-prefixed ed25519 key on input", () => {
    const out = normalizeRegisteredSigner({
      algorithm: "ed25519",
      publicKey: `0x${ED_PUB_64}`,
    });
    expect(out).toEqual({ algorithm: "ed25519", publicKey: `0x${ED_PUB_64}` });
  });

  it("rejects an ed25519 key of the wrong length (e.g. a 40-hex address)", () => {
    expect(
      normalizeRegisteredSigner({ algorithm: "ed25519", publicKey: EIP55_LOWER }),
    ).toBeNull();
  });

  it("does NOT treat a bare 64-hex string as ed25519 (bare string is secp256k1 only)", () => {
    // 64 hex is not a 40-hex address, so a bare string of that length is null.
    expect(normalizeRegisteredSigner(ED_PUB_64)).toBeNull();
  });
});

describe("normalizeRegisteredSigner — fail closed", () => {
  it("rejects an untagged object even if it carries an address", () => {
    expect(normalizeRegisteredSigner({ address: EIP55_LOWER })).toBeNull();
  });

  it("rejects an unknown algorithm", () => {
    expect(
      normalizeRegisteredSigner({ algorithm: "rsa", publicKey: ED_PUB_64 }),
    ).toBeNull();
  });

  it("rejects null / undefined / numbers / arrays", () => {
    expect(normalizeRegisteredSigner(null)).toBeNull();
    expect(normalizeRegisteredSigner(undefined)).toBeNull();
    expect(normalizeRegisteredSigner(42)).toBeNull();
    expect(normalizeRegisteredSigner([EIP55_LOWER])).toBeNull();
  });

  it("rejects a tagged secp256k1 object with a missing address", () => {
    expect(normalizeRegisteredSigner({ algorithm: "secp256k1" })).toBeNull();
  });

  it("produces a discriminable union usable by a tag switch", () => {
    const signer = normalizeRegisteredSigner(EIP55_LOWER) as RegisteredSigner;
    // Type-level: the switch narrows each arm; runtime asserts the tag.
    if (signer.algorithm === "secp256k1") {
      expect(signer.address).toBe(EIP55_CHECKSUMMED);
    } else {
      throw new Error("expected secp256k1");
    }
  });
});
