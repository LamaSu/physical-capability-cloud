import { describe, it, expect } from "vitest";
import { VCVerifier, verifiableCredentialSchema } from "../vc.js";
import { DIDResolver } from "../resolver.js";
import type { VerifiableCredential, DIDDocument } from "../types.js";

const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const ISSUER_DID = `did:pkh:eip155:8453:${VITALIK}`;
const VM_ID = `${ISSUER_DID}#blockchainAccountId`;

function buildVC(overrides: Partial<VerifiableCredential> = {}): VerifiableCredential {
  return {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    type: ["VerifiableCredential", "OperatorAttestation"],
    issuer: ISSUER_DID,
    issuanceDate: new Date(Date.now() - 86_400_000).toISOString(),
    expirationDate: new Date(Date.now() + 86_400_000 * 365).toISOString(),
    credentialSubject: { id: "did:web:operator.test", role: "operator" },
    proof: {
      type: "EcdsaSecp256k1RecoverySignature2020",
      created: new Date().toISOString(),
      verificationMethod: VM_ID,
      proofPurpose: "assertionMethod",
      jws: "eyJhbGciOiJFUzI1NkstUiJ9..fake-signature-here",
    },
    ...overrides,
  };
}

describe("verifiableCredentialSchema", () => {
  it("validates a well-formed VC", () => {
    const result = verifiableCredentialSchema.safeParse(buildVC());
    expect(result.success).toBe(true);
  });

  it("rejects a VC missing issuer", () => {
    const vc = buildVC();
    const stripped = { ...vc };
    // @ts-expect-error - intentional deletion for test
    delete stripped.issuer;
    expect(verifiableCredentialSchema.safeParse(stripped).success).toBe(false);
  });

  it("rejects a VC missing proof", () => {
    const vc = buildVC();
    const stripped = { ...vc };
    // @ts-expect-error - intentional deletion for test
    delete stripped.proof;
    expect(verifiableCredentialSchema.safeParse(stripped).success).toBe(false);
  });

  it("accepts issuer as object with id", () => {
    const vc = buildVC({ issuer: { id: ISSUER_DID, name: "Hamilton Robotics" } });
    expect(verifiableCredentialSchema.safeParse(vc).success).toBe(true);
  });

  it("accepts proof as array", () => {
    const single = buildVC();
    const proof = Array.isArray(single.proof) ? single.proof[0]! : single.proof;
    const vc = buildVC({ proof: [proof, proof] });
    expect(verifiableCredentialSchema.safeParse(vc).success).toBe(true);
  });
});

describe("VCVerifier.issuerDid", () => {
  it("returns string issuer as-is", () => {
    expect(VCVerifier.issuerDid(buildVC())).toBe(ISSUER_DID);
  });

  it("extracts id from object issuer", () => {
    const vc = buildVC({ issuer: { id: ISSUER_DID, name: "Org" } });
    expect(VCVerifier.issuerDid(vc)).toBe(ISSUER_DID);
  });
});

describe("VCVerifier.isExpired", () => {
  it("returns false when no expirationDate", () => {
    const vc = buildVC({ expirationDate: undefined });
    const verifier = new VCVerifier(new DIDResolver());
    expect(verifier.isExpired(vc)).toBe(false);
  });

  it("returns false when expirationDate is in the future", () => {
    const vc = buildVC({ expirationDate: new Date(Date.now() + 86_400_000).toISOString() });
    const verifier = new VCVerifier(new DIDResolver());
    expect(verifier.isExpired(vc)).toBe(false);
  });

  it("returns true when expirationDate is in the past", () => {
    const vc = buildVC({ expirationDate: new Date(Date.now() - 1).toISOString() });
    const verifier = new VCVerifier(new DIDResolver());
    expect(verifier.isExpired(vc)).toBe(true);
  });

  it("honors the now override", () => {
    const expDate = "2026-01-01T00:00:00Z";
    const vc = buildVC({ expirationDate: expDate });
    const verifier = new VCVerifier(new DIDResolver());
    expect(verifier.isExpired(vc, new Date("2025-06-01T00:00:00Z"))).toBe(false);
    expect(verifier.isExpired(vc, new Date("2026-06-01T00:00:00Z"))).toBe(true);
  });

  it("returns false for invalid expirationDate strings", () => {
    const vc = buildVC({ expirationDate: "not-a-date" });
    const verifier = new VCVerifier(new DIDResolver());
    expect(verifier.isExpired(vc)).toBe(false);
  });
});

describe("VCVerifier.verify", () => {
  it("returns invalid for malformed VC", async () => {
    const verifier = new VCVerifier(new DIDResolver());
    const result = await verifier.verify({ foo: "bar" });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("returns invalid for expired VC", async () => {
    const verifier = new VCVerifier(new DIDResolver());
    const vc = buildVC({
      expirationDate: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const result = await verifier.verify(vc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("expired"))).toBe(true);
  });

  it("returns invalid for far-future issuanceDate", async () => {
    const verifier = new VCVerifier(new DIDResolver());
    const vc = buildVC({
      issuanceDate: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const result = await verifier.verify(vc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("future"))).toBe(true);
  });

  it("resolves the issuer DID and locates the verificationMethod", async () => {
    const verifier = new VCVerifier(new DIDResolver(), {
      jwsVerifier: async () => true,
    });
    const result = await verifier.verify(buildVC());
    expect(result.valid).toBe(true);
  });

  it("reports failure when jwsVerifier returns false", async () => {
    const verifier = new VCVerifier(new DIDResolver(), {
      jwsVerifier: async () => false,
    });
    const result = await verifier.verify(buildVC());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("JWS"))).toBe(true);
  });

  it("warns when expiring within 7 days", async () => {
    const verifier = new VCVerifier(new DIDResolver(), {
      jwsVerifier: async () => true,
    });
    const vc = buildVC({
      expirationDate: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    });
    const result = await verifier.verify(vc);
    expect(result.warnings?.some((w) => w.includes("7 days"))).toBe(true);
  });

  it("reports cannot verify when JWS present but no verifier supplied", async () => {
    const verifier = new VCVerifier(new DIDResolver());
    const result = await verifier.verify(buildVC());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("jwsVerifier"))).toBe(true);
  });

  it("fails when proof has neither jws nor proofValue", async () => {
    const verifier = new VCVerifier(new DIDResolver(), {
      jwsVerifier: async () => true,
    });
    const vc = buildVC();
    const proof = (Array.isArray(vc.proof) ? vc.proof[0]! : vc.proof);
    const proofNoJws = {
      type: proof.type,
      created: proof.created,
      verificationMethod: proof.verificationMethod,
      proofPurpose: proof.proofPurpose,
    };
    const vcNoJws = { ...vc, proof: proofNoJws };
    const result = await verifier.verify(vcNoJws);
    expect(result.valid).toBe(false);
  });

  it("fails when verificationMethod not on issuer DID document", async () => {
    const verifier = new VCVerifier(new DIDResolver(), {
      jwsVerifier: async () => true,
    });
    const vc = buildVC();
    const proof = Array.isArray(vc.proof) ? vc.proof[0]! : vc.proof;
    const fudgedProof = { ...proof, verificationMethod: `${ISSUER_DID}#nonexistent-key` };
    const result = await verifier.verify({ ...vc, proof: fudgedProof });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("verificationMethod"))).toBe(true);
  });

  it("verifies a did:web-issued VC end-to-end", async () => {
    const webDid = "did:web:hamilton.test";
    const webDoc: DIDDocument = {
      "@context": "https://www.w3.org/ns/did/v1",
      id: webDid,
      verificationMethod: [
        {
          id: `${webDid}#key-1`,
          type: "Ed25519VerificationKey2018",
          controller: webDid,
          publicKeyMultibase: "z6MkpzYjk3Z2gjK4PnD8nLBJrXqWzVqxJpZGfXmf6t5HRrCu",
        },
      ],
    };
    const resolver = new DIDResolver({
      fetchImpl: (async (url: string) => {
        if (!url.includes("hamilton.test")) {
          throw new Error("unexpected url " + url);
        }
        return { ok: true, status: 200, json: () => Promise.resolve(webDoc) } as Response;
      }) as unknown as typeof fetch,
    });
    const verifier = new VCVerifier(resolver, { jwsVerifier: async () => true });
    const vc = buildVC({
      issuer: webDid,
      proof: {
        type: "Ed25519Signature2018",
        created: new Date().toISOString(),
        verificationMethod: `${webDid}#key-1`,
        jws: "eyJhbGciOiJFZERTQSJ9..fake",
      },
    });
    const result = await verifier.verify(vc);
    expect(result.valid).toBe(true);
  });
});
