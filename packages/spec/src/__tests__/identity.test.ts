import { describe, it, expect } from "vitest";
import {
  createPCCDID,
  parsePCCDID,
  buildDIDDocument,
  isValidDID,
  isValidKeyDID,
  isValidPCCDID,
  isValidCredentialStructure,
} from "../identity/types.js";
import {
  createKeyDID,
  deriveKeyDID,
} from "../identity/did.js";
import {
  issueCapabilityCredential,
  verifyCredential,
} from "../identity/credentials.js";
import type { DIDString } from "../identity/types.js";

// ---------------------------------------------------------------------------
// DID Creation
// ---------------------------------------------------------------------------

describe("createKeyDID", () => {
  it("generates a valid did:key with Ed25519", () => {
    const keypair = createKeyDID();
    expect(keypair.did).toMatch(/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/);
    expect(keypair.publicKeyHex).toHaveLength(64); // 32 bytes hex
    expect(keypair.privateKeyHex).toHaveLength(64);
  });

  it("generates unique DIDs each time", () => {
    const a = createKeyDID();
    const b = createKeyDID();
    expect(a.did).not.toBe(b.did);
    expect(a.publicKeyHex).not.toBe(b.publicKeyHex);
  });

  it("includes a valid DID Document", () => {
    const keypair = createKeyDID();
    const doc = keypair.didDocument;
    expect(doc.id).toBe(keypair.did);
    expect(doc["@context"]).toContain("https://www.w3.org/ns/did/v1");
    expect(doc.verificationMethod).toHaveLength(1);
    expect(doc.verificationMethod[0].type).toBe("Ed25519VerificationKey2020");
    expect(doc.verificationMethod[0].publicKeyHex).toBe(keypair.publicKeyHex);
    expect(doc.authentication).toContain(`${keypair.did}#key-1`);
  });
});

describe("deriveKeyDID", () => {
  it("derives the same DID from the same public key", () => {
    const keypair = createKeyDID();
    const derived = deriveKeyDID(keypair.publicKeyHex);
    expect(derived).toBe(keypair.did);
  });

  it("rejects invalid key lengths", () => {
    expect(() => deriveKeyDID("abcd")).toThrow("Expected 32-byte");
  });
});

describe("createPCCDID", () => {
  it("creates a kernel DID", () => {
    const did = createPCCDID("kernel", "shop_001");
    expect(did).toBe("did:pcc:kernel:shop_001");
  });

  it("creates a device DID", () => {
    const did = createPCCDID("device", "prusa_mk4_01");
    expect(did).toBe("did:pcc:device:prusa_mk4_01");
  });

  it("creates an operator DID", () => {
    const did = createPCCDID("operator", "alice");
    expect(did).toBe("did:pcc:operator:alice");
  });

  it("creates an agent DID", () => {
    const did = createPCCDID("agent", "broker_01");
    expect(did).toBe("did:pcc:agent:broker_01");
  });

  it("rejects empty IDs", () => {
    expect(() => createPCCDID("kernel", "")).toThrow("must not be empty");
  });
});

describe("parsePCCDID", () => {
  it("parses a valid PCC DID", () => {
    const result = parsePCCDID("did:pcc:kernel:shop_001");
    expect(result).toEqual({ type: "kernel", id: "shop_001" });
  });

  it("parses device DIDs", () => {
    const result = parsePCCDID("did:pcc:device:prusa_mk4_01");
    expect(result).toEqual({ type: "device", id: "prusa_mk4_01" });
  });

  it("returns null for non-PCC DIDs", () => {
    expect(parsePCCDID("did:key:z123")).toBeNull();
  });

  it("returns null for invalid PCC types", () => {
    expect(parsePCCDID("did:pcc:unknown:foo")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DID Validation
// ---------------------------------------------------------------------------

describe("DID validation", () => {
  it("validates correct DID formats", () => {
    expect(isValidDID("did:key:z123")).toBe(true);
    expect(isValidDID("did:pcc:kernel:shop1")).toBe(true);
    expect(isValidDID("did:web:example.com")).toBe(true);
  });

  it("rejects invalid DID formats", () => {
    expect(isValidDID("not-a-did")).toBe(false);
    expect(isValidDID("did:")).toBe(false);
    expect(isValidDID("")).toBe(false);
  });

  it("validates did:key format", () => {
    const keypair = createKeyDID();
    expect(isValidKeyDID(keypair.did)).toBe(true);
    expect(isValidKeyDID("did:key:z123abc")).toBe(true);
    expect(isValidKeyDID("did:pcc:kernel:x")).toBe(false);
  });

  it("validates did:pcc format", () => {
    expect(isValidPCCDID("did:pcc:kernel:shop1")).toBe(true);
    expect(isValidPCCDID("did:pcc:device:dev1")).toBe(true);
    expect(isValidPCCDID("did:pcc:operator:alice")).toBe(true);
    expect(isValidPCCDID("did:pcc:agent:broker1")).toBe(true);
    expect(isValidPCCDID("did:pcc:unknown:foo")).toBe(false);
    expect(isValidPCCDID("did:key:z123")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Verifiable Credentials
// ---------------------------------------------------------------------------

describe("issueCapabilityCredential", () => {
  it("issues an unsigned credential", () => {
    const issuer = createPCCDID("kernel", "shop_001");
    const subject = createPCCDID("device", "prusa_mk4_01");

    const vc = issueCapabilityCredential({
      issuerDid: issuer,
      subjectDid: subject,
      capability: "fdm_printing",
      assuranceTier: 2,
      parameters: { materials: ["PLA", "PETG"], maxVolume: "250x210x210" },
    });

    expect(vc["@context"]).toContain("https://www.w3.org/2018/credentials/v1");
    expect(vc.type).toContain("VerifiableCredential");
    expect(vc.type).toContain("CapabilityCredential");
    expect(vc.issuer).toBe(issuer);
    expect(vc.credentialSubject.id).toBe(subject);
    expect(vc.credentialSubject.capability).toBe("fdm_printing");
    expect(vc.credentialSubject.assuranceTier).toBe(2);
    expect(vc.credentialSubject.parameters).toEqual({
      materials: ["PLA", "PETG"],
      maxVolume: "250x210x210",
    });
    expect(vc.proof).toBeUndefined();
  });

  it("issues a signed credential with a private key", () => {
    const keypair = createKeyDID();

    const vc = issueCapabilityCredential({
      issuerDid: keypair.did,
      subjectDid: createPCCDID("device", "haas_vf2_01"),
      capability: "cnc_milling",
      assuranceTier: 3,
      parameters: { axes: 3, tolerance: "0.01mm" },
      calibrationDate: "2026-03-01T00:00:00Z",
      issuerPrivateKeyHex: keypair.privateKeyHex,
    });

    expect(vc.proof).toBeDefined();
    expect(vc.proof!.type).toBe("Ed25519Signature2020");
    expect(vc.proof!.proofPurpose).toBe("assertionMethod");
    expect(vc.proof!.verificationMethod).toBe(`${keypair.did}#key-1`);
    expect(vc.proof!.proofValue).toMatch(/^[a-f0-9]+$/);
  });

  it("includes optional fields when provided", () => {
    const vc = issueCapabilityCredential({
      issuerDid: createPCCDID("kernel", "k1"),
      subjectDid: createPCCDID("device", "d1"),
      capability: "laser_cutting",
      assuranceTier: 1,
      calibrationDate: "2026-02-15T00:00:00Z",
      calibrationProof: "bafybeig1234567890",
      expirationDate: "2027-02-15T00:00:00Z",
    });

    expect(vc.credentialSubject.calibrationDate).toBe("2026-02-15T00:00:00Z");
    expect(vc.credentialSubject.calibrationProof).toBe("bafybeig1234567890");
    expect(vc.expirationDate).toBe("2027-02-15T00:00:00Z");
  });
});

describe("verifyCredential", () => {
  it("verifies a valid signed credential", () => {
    const keypair = createKeyDID();

    const vc = issueCapabilityCredential({
      issuerDid: keypair.did,
      subjectDid: createPCCDID("device", "dev_01"),
      capability: "fdm_printing",
      assuranceTier: 2,
      issuerPrivateKeyHex: keypair.privateKeyHex,
    });

    expect(verifyCredential(vc, keypair.publicKeyHex)).toBe(true);
  });

  it("rejects a credential with a tampered subject", () => {
    const keypair = createKeyDID();

    const vc = issueCapabilityCredential({
      issuerDid: keypair.did,
      subjectDid: createPCCDID("device", "dev_01"),
      capability: "fdm_printing",
      assuranceTier: 2,
      issuerPrivateKeyHex: keypair.privateKeyHex,
    });

    // Tamper with the credential
    vc.credentialSubject.assuranceTier = 3;

    expect(verifyCredential(vc, keypair.publicKeyHex)).toBe(false);
  });

  it("rejects a credential signed with a different key", () => {
    const issuerKeypair = createKeyDID();
    const otherKeypair = createKeyDID();

    const vc = issueCapabilityCredential({
      issuerDid: issuerKeypair.did,
      subjectDid: createPCCDID("device", "dev_01"),
      capability: "fdm_printing",
      assuranceTier: 2,
      issuerPrivateKeyHex: issuerKeypair.privateKeyHex,
    });

    // Verify with wrong key
    expect(verifyCredential(vc, otherKeypair.publicKeyHex)).toBe(false);
  });

  it("rejects an unsigned credential", () => {
    const vc = issueCapabilityCredential({
      issuerDid: createPCCDID("kernel", "k1"),
      subjectDid: createPCCDID("device", "d1"),
      capability: "fdm_printing",
      assuranceTier: 1,
    });

    expect(verifyCredential(vc, "a".repeat(64))).toBe(false);
  });

  it("rejects an expired credential", () => {
    const keypair = createKeyDID();

    const vc = issueCapabilityCredential({
      issuerDid: keypair.did,
      subjectDid: createPCCDID("device", "dev_01"),
      capability: "fdm_printing",
      assuranceTier: 2,
      expirationDate: "2020-01-01T00:00:00Z", // expired
      issuerPrivateKeyHex: keypair.privateKeyHex,
    });

    expect(verifyCredential(vc, keypair.publicKeyHex)).toBe(false);
  });
});

describe("isValidCredentialStructure", () => {
  it("validates a well-formed credential", () => {
    const vc = issueCapabilityCredential({
      issuerDid: createPCCDID("kernel", "k1"),
      subjectDid: createPCCDID("device", "d1"),
      capability: "fdm_printing",
      assuranceTier: 1,
    });

    expect(isValidCredentialStructure(vc)).toBe(true);
  });

  it("rejects null", () => {
    expect(isValidCredentialStructure(null)).toBe(false);
  });

  it("rejects a plain object missing required fields", () => {
    expect(isValidCredentialStructure({ type: "something" })).toBe(false);
  });

  it("rejects a credential missing capability in subject", () => {
    expect(
      isValidCredentialStructure({
        "@context": ["https://www.w3.org/2018/credentials/v1"],
        type: ["VerifiableCredential"],
        issuer: "did:pcc:kernel:k1",
        issuanceDate: "2026-01-01",
        credentialSubject: {
          id: "did:pcc:device:d1",
          // missing capability and assuranceTier
        },
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: DID + Credential round-trip
// ---------------------------------------------------------------------------

describe("DID + Credential integration", () => {
  it("full round-trip: create DID, issue credential, verify", () => {
    // Kernel creates its identity
    const kernelKeypair = createKeyDID();

    // Device gets a PCC DID
    const deviceDid = createPCCDID("device", "prusa_mk4_01");

    // Kernel issues a capability credential for the device
    const vc = issueCapabilityCredential({
      issuerDid: kernelKeypair.did,
      subjectDid: deviceDid,
      capability: "fdm_printing",
      assuranceTier: 2,
      parameters: {
        materials: ["PLA", "PETG", "ABS"],
        buildVolume: { x: 250, y: 210, z: 210 },
        layerResolution: "0.05mm",
      },
      calibrationDate: "2026-03-01T00:00:00Z",
      issuerPrivateKeyHex: kernelKeypair.privateKeyHex,
    });

    // Anyone can verify this credential using the kernel's public key
    expect(verifyCredential(vc, kernelKeypair.publicKeyHex)).toBe(true);

    // The credential correctly describes the device's capability
    expect(vc.credentialSubject.id).toBe(deviceDid);
    expect(vc.credentialSubject.capability).toBe("fdm_printing");
    expect(vc.credentialSubject.assuranceTier).toBe(2);

    // The DID can be resolved back to the kernel's public key via its DID document
    expect(kernelKeypair.didDocument.verificationMethod[0].publicKeyHex).toBe(
      kernelKeypair.publicKeyHex,
    );
  });
});
