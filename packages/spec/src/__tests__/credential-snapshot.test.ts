import { describe, it, expect } from "vitest";
import { createPCCDID } from "../identity/types.js";
import { createKeyDID } from "../identity/did.js";
import { issueCapabilityCredential, verifyCredential } from "../identity/credentials.js";
import type { CapabilityCredential } from "../identity/types.js";

/**
 * N15 round 4 (cross-family review A05b, finding 3, verifyCredential): the
 * expiration was checked on the object the caller handed in, and the signed body
 * was built from it later. A stateful Proxy can answer the expiry check with a
 * future date and the later copy with the signed, expired one, so an expired
 * signed credential verified. verifyCredential now snapshots the credential
 * first (canonicalize, parse the canonical text once) and judges the expiry, the
 * signed body and the proof on that snapshot, never reading the object again.
 */

const FUTURE = "2999-01-01T00:00:00Z";
const PAST = "2020-01-01T00:00:00Z";

function signedCredential(expirationDate?: string) {
  const keypair = createKeyDID();
  const credential = issueCapabilityCredential({
    issuerDid: keypair.did,
    subjectDid: createPCCDID("device", "dev_01"),
    capability: "fdm_printing",
    assuranceTier: 2,
    ...(expirationDate ? { expirationDate } : {}),
    issuerPrivateKeyHex: keypair.privateKeyHex,
  });
  return { credential, publicKeyHex: keypair.publicKeyHex };
}

describe("verifyCredential — evaluates the snapshot it checked (N15 round 4, A05b #3)", () => {
  it("rejects an expired signed credential even when a stateful Proxy shows the expiry check a future date", () => {
    const { credential, publicKeyHex } = signedCredential(PAST);
    expect(verifyCredential(credential, publicKeyHex)).toBe(false); // control: the plain object is rejected

    let expirationReads = 0;
    const hostile = new Proxy(credential, {
      get(target, key, receiver) {
        if (key === "expirationDate") {
          expirationReads++;
          // The expiry check reads it twice and the body copy reads it a third time.
          return expirationReads <= 2 ? FUTURE : Reflect.get(target, key, receiver);
        }
        return Reflect.get(target, key, receiver);
      },
    });
    expect(verifyCredential(hostile, publicKeyHex)).toBe(false); // round 3 returned true
    expect(expirationReads).toBe(0);
  });

  it("never reads the object it was handed through [[Get]]: an honest Proxy verifies, and its get trap never runs", () => {
    const { credential, publicKeyHex } = signedCredential(FUTURE);
    let gets = 0;
    const honest = new Proxy(credential, {
      get(target, key, receiver) {
        gets++;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(verifyCredential(honest, publicKeyHex)).toBe(true);
    expect(gets).toBe(0);
  });

  it("the proof is read from the snapshot too: an accessor proofValue fails closed and its getter never runs", () => {
    const { credential, publicKeyHex } = signedCredential(FUTURE);
    expect(verifyCredential(credential, publicKeyHex)).toBe(true); // control
    const realProofValue = credential.proof!.proofValue;
    let ran = 0;
    const proof = Object.defineProperty({ ...credential.proof }, "proofValue", {
      enumerable: true,
      get: () => (ran++, realProofValue),
    });
    const tricky = { ...credential, proof } as CapabilityCredential;
    expect(verifyCredential(tricky, publicKeyHex)).toBe(false); // round 3 ran the getter and returned true
    expect(ran).toBe(0);
  });

  it("keeps its existing verdicts on plain credentials: valid, expired, unsigned, wrong key, tampered", () => {
    const valid = signedCredential(FUTURE);
    expect(verifyCredential(valid.credential, valid.publicKeyHex)).toBe(true);
    const noExpiry = signedCredential();
    expect(verifyCredential(noExpiry.credential, noExpiry.publicKeyHex)).toBe(true);
    const expired = signedCredential(PAST);
    expect(verifyCredential(expired.credential, expired.publicKeyHex)).toBe(false);
    const unsigned = issueCapabilityCredential({
      issuerDid: createPCCDID("kernel", "k1"),
      subjectDid: createPCCDID("device", "d1"),
      capability: "fdm_printing",
      assuranceTier: 1,
    });
    expect(verifyCredential(unsigned, "a".repeat(64))).toBe(false);
    expect(verifyCredential(valid.credential, createKeyDID().publicKeyHex)).toBe(false);
    const tampered = structuredClone(valid.credential);
    tampered.credentialSubject.assuranceTier = 3;
    expect(verifyCredential(tampered, valid.publicKeyHex)).toBe(false);
  });
});
