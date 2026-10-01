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

// ---------------------------------------------------------------------------
// N15 round 5 (cross-family review A05c, finding F1)
// ---------------------------------------------------------------------------

/**
 * The snapshot inherited Object.prototype, and verifyCredential read `proof`,
 * `expirationDate` and `proofValue` from it with ordinary property reads. A member
 * that exists only on a polluted Object.prototype was therefore judged although it
 * was never part of what the snapshot hashed. The snapshot is prototype-less now:
 * what the credential does not own reads as undefined.
 */

/** Object.prototype's own names when this file loaded, before any test could pollute it. */
const OBJECT_PROTOTYPE_AT_LOAD = Object.getOwnPropertyNames(Object.prototype).sort();

/** Install `members` on Object.prototype while `fn` runs and always take them off again; assert after it returns. */
function withPollutedPrototype<T>(members: Record<string, unknown>, fn: () => T): T {
  const target = Object.prototype as unknown as Record<string, unknown>;
  const names = Object.keys(members);
  try {
    for (const name of names) target[name] = members[name];
    return fn();
  } finally {
    for (const name of names) delete target[name];
  }
}

describe("verifyCredential -- a polluted Object.prototype supplies nothing that was signed (N15 round 5, A05c F1)", () => {
  it("A05c F1: the verdict's repro: a proof that exists only on Object.prototype does not make an unsigned credential verify", () => {
    const { credential, publicKeyHex } = signedCredential(FUTURE);
    expect(verifyCredential(credential, publicKeyHex)).toBe(true); // control: the signed credential verifies
    const proof = credential.proof;
    const unsigned: Partial<CapabilityCredential> = { ...credential };
    delete unsigned.proof; // the credential's own data now carries no proof
    expect(Object.prototype.hasOwnProperty.call(unsigned, "proof")).toBe(false);

    const verdict = withPollutedPrototype({ proof }, () => verifyCredential(unsigned as CapabilityCredential, publicKeyHex));
    expect(verdict).toBe(false); // faac0003 returned true: the inherited proof was the one verified
  });

  it("A05c F1: a proofValue that exists only on Object.prototype does not complete a proof the credential does not carry", () => {
    const { credential, publicKeyHex } = signedCredential(FUTURE);
    const proofWithoutValue: Record<string, unknown> = { ...credential.proof };
    const proofValue = proofWithoutValue.proofValue;
    delete proofWithoutValue.proofValue;
    const forged = { ...credential, proof: proofWithoutValue } as unknown as CapabilityCredential;

    const verdict = withPollutedPrototype({ proofValue }, () => verifyCredential(forged, publicKeyHex));
    expect(verdict).toBe(false); // faac0003 returned true
  });

  it("A05c F1: an expirationDate that exists only on Object.prototype is not the credential's expiry", () => {
    const { credential, publicKeyHex } = signedCredential(); // signed with no expiry of its own
    expect(Object.prototype.hasOwnProperty.call(credential, "expirationDate")).toBe(false);

    const verdict = withPollutedPrototype({ expirationDate: PAST }, () => verifyCredential(credential, publicKeyHex));
    expect(verdict).toBe(true); // faac0003 judged the inherited past date and returned false
  });

  it("A05c F1: a credential's own proof and own expiry are still judged, whatever Object.prototype carries", () => {
    const valid = signedCredential(FUTURE);
    const expired = signedCredential(PAST);
    const verdicts = withPollutedPrototype({ proof: undefined, proofValue: "00", expirationDate: FUTURE }, () => [
      verifyCredential(valid.credential, valid.publicKeyHex),
      verifyCredential(expired.credential, expired.publicKeyHex), // its own past expiry wins over an inherited future one
    ]);
    expect(verdicts).toEqual([true, false]);
  });

  it("A05c F1: an issuer-signed credential whose expirationDate is not a date string fails closed", () => {
    // `new Date({})` is an Invalid Date, and `NaN < now` is false, so the expiry check used to be skipped and a
    // signed credential carrying an object as its expiry verified. The snapshot's object has no prototype to
    // coerce through, so the date cannot be built and the verdict is false.
    const keypair = createKeyDID();
    const credential = issueCapabilityCredential({
      issuerDid: keypair.did,
      subjectDid: createPCCDID("device", "dev_01"),
      capability: "fdm_printing",
      assuranceTier: 2,
      expirationDate: { not: "a date" } as unknown as string,
      issuerPrivateKeyHex: keypair.privateKeyHex,
    });
    expect(verifyCredential(credential, keypair.publicKeyHex)).toBe(false); // faac0003 returned true
  });

  it("leaves Object.prototype exactly as it found it (no test above leaks a pollution)", () => {
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(OBJECT_PROTOTYPE_AT_LOAD);
  });
});
