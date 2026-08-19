/**
 * GatewayReceiptV1 — cross-confirm against the ORACLE's published golden.
 *
 * The oracle OWNS this encoding (pcc-oracle `src/gateway-receipt.ts` @ 1738586,
 * coord #703); the gateway builds to it. These tests are the gateway half of the
 * same publish→cross-confirm loop that closed termsHash, FinalMilestonePackageV2
 * and acceptedPolicyDigest: if the two sides ever drift, THIS fails rather than a
 * settlement failing in production with an unverifiable signature.
 *
 * The negative-parity block is the important part. It proves every field is
 * genuinely bound — in particular `packageDigest`, without which a receipt could
 * be REPLAYED onto different evidence for the same unit.
 */

import { describe, it, expect } from "vitest";
import { generateEd25519Keypair, verifyEd25519Signature } from "../auth/ed25519.js";
import {
  GATEWAY_RECEIPT_DOMAIN,
  GATEWAY_RECEIPT_VERSION,
  computeGatewayReceiptDomain,
  computeGatewayReceiptDigest,
  signGatewayReceipt,
  devSignerFromPrivateKeyHex,
  ReceiptSigningUnavailableError,
  type GatewayReceipt,
} from "../settlement/gateway-receipt.js";
import { toBytes } from "viem";

/** Oracle's published golden (#703). */
const GOLDEN: GatewayReceipt = {
  chainId: 8453,
  escrow: "0x00000000000000000000000000000000000E5C0F",
  settlementUnitId: "0x4453a3d232c24342539bc5ae06089f1cf7ccf93f737cffd67cf0a6ea76904ef1",
  packageDigest: "0xe1e5c30d2ed795e28ccb035edc53daacf13c5a077686dc4141c49ed9768a3fb5",
  receivedAt: 1700000000,
};
const GOLDEN_DIGEST =
  "0xe805d61778bd424deaf8cb7a47240e9982289017e977e4ad45e085280e6e223e";
const GOLDEN_DOMAIN =
  "0xc6ba37cf35ac305d82792d994f57aaeca940fad501e197ab9057214ff4d67699";

describe("GatewayReceiptV1 — oracle cross-confirm (#703)", () => {
  it("domain matches keccak256('PCC:vnext:gateway-receipt:v1')", () => {
    expect(GATEWAY_RECEIPT_DOMAIN.toLowerCase()).toBe(GOLDEN_DOMAIN);
  });

  it("the PINNED domain constant equals its recomputed preimage", () => {
    // A mistyped constant would otherwise produce a self-consistent but
    // oracle-incompatible signature that only fails in production.
    expect(computeGatewayReceiptDomain().toLowerCase()).toBe(
      GATEWAY_RECEIPT_DOMAIN.toLowerCase(),
    );
  });

  it("reproduces the published receiptDigest byte-for-byte", () => {
    expect(computeGatewayReceiptDigest(GOLDEN).toLowerCase()).toBe(GOLDEN_DIGEST);
  });

  it("pins the schema version at 1", () => {
    expect(GATEWAY_RECEIPT_VERSION).toBe(1);
  });
});

describe("negative parity — every field is bound", () => {
  const base = computeGatewayReceiptDigest(GOLDEN);

  it("chainId is bound", () => {
    expect(computeGatewayReceiptDigest({ ...GOLDEN, chainId: 8454 })).not.toBe(base);
  });

  it("escrow is bound", () => {
    expect(
      computeGatewayReceiptDigest({
        ...GOLDEN,
        escrow: "0x00000000000000000000000000000000000E5C10",
      }),
    ).not.toBe(base);
  });

  it("settlementUnitId is bound", () => {
    expect(
      computeGatewayReceiptDigest({ ...GOLDEN, settlementUnitId: `0x${"11".repeat(32)}` }),
    ).not.toBe(base);
  });

  it("packageDigest is bound — this is what prevents REPLAY onto other evidence", () => {
    // Without packageDigest in the preimage a receipt would attest only
    // "unit U received at time T" and could be reused for a different package.
    expect(
      computeGatewayReceiptDigest({ ...GOLDEN, packageDigest: `0x${"22".repeat(32)}` }),
    ).not.toBe(base);
  });

  it("receivedAt is bound — a one-second shift changes the digest", () => {
    expect(computeGatewayReceiptDigest({ ...GOLDEN, receivedAt: 1700000001 })).not.toBe(base);
  });
});

describe("signing", () => {
  it("signs the raw 32 digest bytes and verifies against the public key", () => {
    const kp = generateEd25519Keypair();
    const signed = signGatewayReceipt(
      GOLDEN,
      devSignerFromPrivateKeyHex(kp.privateKeyHex),
      kp.publicKeyHex,
    );
    expect(signed.receiptDigest.toLowerCase()).toBe(GOLDEN_DIGEST);
    // The oracle recomputes the digest and verifies over its BYTES.
    expect(
      verifyEd25519Signature(
        kp.publicKeyHex,
        Buffer.from(toBytes(signed.receiptDigest)),
        signed.signature,
      ),
    ).toBe(true);
  });

  it("a signature over a DIFFERENT receipt does not verify against this digest", () => {
    const kp = generateEd25519Keypair();
    const other = signGatewayReceipt(
      { ...GOLDEN, receivedAt: 1700009999 },
      devSignerFromPrivateKeyHex(kp.privateKeyHex),
      kp.publicKeyHex,
    );
    expect(
      verifyEd25519Signature(
        kp.publicKeyHex,
        Buffer.from(toBytes(GOLDEN_DIGEST)),
        other.signature,
      ),
    ).toBe(false);
  });

  it("FAILS CLOSED when the signer cannot sign, rather than emitting an unsigned receipt", () => {
    // An unsigned receipt is worthless to the oracle; letting one travel would
    // fail confusingly downstream instead of here.
    expect(() => signGatewayReceipt(GOLDEN, () => null, "pub")).toThrow(
      ReceiptSigningUnavailableError,
    );
  });
});

describe("ORACLE cross-family signed vector (#800) — the loop, proven both directions", () => {
  /**
   * Oracle published a DETERMINISTIC signed vector so each side could verify the
   * other's crypto rather than only its own half. This pins it permanently: if
   * either side's signing preimage ever drifts, THIS fails here instead of a
   * settlement failing in production with an unverifiable signature.
   *
   * Vector (coord #800, oracle commit 2041818): ed25519 seed 0x01..01 signing the
   * 32 RAW BYTES of the #703 golden receiptDigest — no extra hashing.
   */
  const SEED = "01".repeat(32);
  const ORACLE_PUBKEY =
    "8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c";
  const ORACLE_SIG =
    "52be6edad949088f9e92e054a6fc68f0cf85ce17d3e7f2bd182057bbcc14299c" +
    "4aa981b58b58b822dbc07680afff3e1a44f565127871ab966b4fd3f570f80501";

  const digestBytes = () => Buffer.from(toBytes(computeGatewayReceiptDigest(GOLDEN)));

  it("the gateway VERIFIES the oracle's signature (their sig -> our verify)", () => {
    expect(verifyEd25519Signature(ORACLE_PUBKEY, digestBytes(), ORACLE_SIG)).toBe(true);
  });

  it("the gateway PRODUCES a byte-identical signature (our sig -> their verify)", () => {
    // Byte-identity is a stronger claim than mutual verification: it proves both
    // sides sign exactly the same preimage, so there is no ambiguity about
    // whether the digest is hashed again, hex-encoded, or domain-wrapped first.
    const signed = signGatewayReceipt(GOLDEN, devSignerFromPrivateKeyHex(SEED), ORACLE_PUBKEY);
    expect(signed.signature.toLowerCase()).toBe(ORACLE_SIG);
  });

  it("REJECTS a valid signature presented under a different pubkey", () => {
    // signing != authorization: a well-formed signature from an unauthorized key
    // must not pass. The oracle pins ONE authorized gateway receipt-signer pubkey.
    const other = generateEd25519Keypair();
    expect(verifyEd25519Signature(other.publicKeyHex, digestBytes(), ORACLE_SIG)).toBe(false);
  });

  it("REJECTS a tampered receiptDigest", () => {
    const tampered = digestBytes();
    tampered[0] ^= 0xff;
    expect(verifyEd25519Signature(ORACLE_PUBKEY, tampered, ORACLE_SIG)).toBe(false);
  });
});
