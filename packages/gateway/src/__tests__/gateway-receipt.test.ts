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
