/**
 * verifyBundleSignature must never accept a signature transport the pre-LO-EV-1
 * verifier rejected (review R20, #338). The old verifier decoded the value with
 * `fromHex` (still exported) and verified over the UTF-8 bytes of bundleHash;
 * this test runs both side by side.
 */
import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import { signingPreimage } from "@pcc/spec";
import type { EvidenceBundle } from "@pcc/spec";
import { fromHex, verifyBundleSignature } from "../job-handler.js";

const keyPair = nacl.sign.keyPair();
const BUNDLE_HASH = `sha256:${"ab".repeat(32)}`;
const SIG_HEX = Buffer.from(
  nacl.sign.detached(signingPreimage(BUNDLE_HASH), keyPair.secretKey),
).toString("hex");

const bundleWith = (value: string): EvidenceBundle =>
  ({
    bundleHash: BUNDLE_HASH,
    kernelSignature: { signer: "0x00", algorithm: "ed25519", value },
  }) as unknown as EvidenceBundle;

/** The verifier as it was before LO-EV-1. */
function oldVerify(bundle: EvidenceBundle, publicKey: Uint8Array): boolean {
  try {
    return nacl.sign.detached.verify(
      new TextEncoder().encode(bundle.bundleHash),
      fromHex(bundle.kernelSignature.value),
      publicKey,
    );
  } catch {
    return false;
  }
}

describe("verifyBundleSignature — no widening over the pre-LO-EV-1 verifier", () => {
  const cases: Array<[string, string]> = [
    ["unprefixed lowercase", SIG_HEX],
    ["unprefixed uppercase", SIG_HEX.toUpperCase()],
    ["0x-prefixed", `0x${SIG_HEX}`],
    ["0X-prefixed", `0X${SIG_HEX}`],
    ["one extra nibble", `${SIG_HEX}0`],
    ["one nibble short", SIG_HEX.slice(0, -1)],
    ["empty", ""],
  ];

  for (const [name, value] of cases) {
    it(`${name}: accepted now only if it was accepted before`, () => {
      const before = oldVerify(bundleWith(value), keyPair.publicKey);
      const now = verifyBundleSignature(bundleWith(value), keyPair.publicKey);
      if (now) expect(before, name).toBe(true);
    });
  }

  it("the prefixed forms fail exactly as before (the R20 widening is closed)", () => {
    for (const value of [`0x${SIG_HEX}`, `0X${SIG_HEX}`]) {
      expect(oldVerify(bundleWith(value), keyPair.publicKey)).toBe(false);
      expect(verifyBundleSignature(bundleWith(value), keyPair.publicKey)).toBe(false);
    }
  });

  it("valid unprefixed signatures, either case, still verify", () => {
    expect(verifyBundleSignature(bundleWith(SIG_HEX), keyPair.publicKey)).toBe(true);
    expect(verifyBundleSignature(bundleWith(SIG_HEX.toUpperCase()), keyPair.publicKey)).toBe(true);
  });

  it("documented narrowing: a trailing extra nibble used to be truncated and verify; it no longer does", () => {
    expect(oldVerify(bundleWith(`${SIG_HEX}0`), keyPair.publicKey)).toBe(true);
    expect(verifyBundleSignature(bundleWith(`${SIG_HEX}0`), keyPair.publicKey)).toBe(false);
  });

  it("a non-string signature value fails closed instead of throwing", () => {
    const bundle = { bundleHash: BUNDLE_HASH, kernelSignature: { value: 42 } } as unknown as EvidenceBundle;
    expect(verifyBundleSignature(bundle, keyPair.publicKey)).toBe(false);
  });
});
