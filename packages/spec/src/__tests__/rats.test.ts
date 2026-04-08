/**
 * Tests for RATS RFC 9334 type alignment layer in @pcc/spec
 *
 * These tests verify:
 *   1. Structural correctness of RATS type aliases (compile-time checks via assignment)
 *   2. Mapping function behavior
 *   3. RATSTopology factory
 *   4. Role interface contracts
 */

import { describe, it, expect } from "vitest";
import type {
  RATSEvidence,
  RATSAttestationResult,
  RATSClaim,
  RATSAttester,
  RATSVerifier,
  RATSRelyingParty,
  RATSEndorser,
  RATSEndorsement,
  RATSReferenceValueProvider,
  RATSReferenceValues,
  RATSTopology,
} from "../types/rats.js";
import {
  kernelToAttester,
  verifierToRATSVerifier,
  bundleToRATSEvidence,
  attestationToRATSResult,
  buildRATSTopology,
} from "../types/rats.js";
import type { EvidenceBundle } from "../types/evidence.js";
import type { VerificationAttestation } from "../types/verifier.js";
import type { SHA256, Signature } from "../types/common.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mockHash =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as SHA256;
const mockSig = "sig:aabbccdd" as unknown as Signature;

function makeBundle(): EvidenceBundle {
  return {
    id: "bundle-001",
    jobId: "job-001",
    stepId: "step-001",
    kernelId: "kernel-001",
    assuranceTier: 1,
    events: [],
    bundleHash: mockHash,
    kernelSignature: mockSig,
    createdAt: new Date().toISOString(),
  };
}

function makeAttestation(): VerificationAttestation {
  return {
    id: "attest-001",
    bundleId: "bundle-001",
    jobId: "job-001",
    verifierId: "verifier-001",
    result: "valid",
    confidence: 0.95,
    timestamp: new Date().toISOString(),
  };
}

// ── Type alias tests (structural) ─────────────────────────────────────────────

describe("RATS type aliases", () => {
  it("RATSEvidence is structurally identical to EvidenceBundle", () => {
    const bundle = makeBundle();
    // Type assignment: RATSEvidence = EvidenceBundle
    const ratsEvidence: RATSEvidence = bundle;
    expect(ratsEvidence.id).toBe("bundle-001");
    expect(ratsEvidence.kernelId).toBe("kernel-001");
    expect(ratsEvidence.assuranceTier).toBe(1);
  });

  it("RATSAttestationResult is structurally identical to VerificationAttestation", () => {
    const attest = makeAttestation();
    const ratsResult: RATSAttestationResult = attest;
    expect(ratsResult.verifierId).toBe("verifier-001");
    expect(ratsResult.result).toBe("valid");
    expect(ratsResult.confidence).toBe(0.95);
  });

  it("RATSClaim is structurally identical to EvidenceEvent", () => {
    const claim: RATSClaim = {
      id: "event-001",
      type: "execution_started",
      timestamp: new Date().toISOString(),
      source: {
        deviceId: "dev-001",
        deviceType: "controller",
        kernelId: "kernel-001",
      },
      payload: { note: "started" },
      hash: mockHash,
    };
    expect(claim.type).toBe("execution_started");
  });
});

// ── Mapping functions ─────────────────────────────────────────────────────────

describe("kernelToAttester()", () => {
  it("wraps kernelId in attesterId field", () => {
    const result = kernelToAttester("kernel-abc");
    expect(result.attesterId).toBe("kernel-abc");
  });

  it("returns an object matching Pick<RATSAttester, 'attesterId'>", () => {
    const attester: Pick<RATSAttester, "attesterId"> = kernelToAttester("kernel-xyz");
    expect(attester.attesterId).toBe("kernel-xyz");
  });
});

describe("verifierToRATSVerifier()", () => {
  it("wraps verifierId in verifierId field", () => {
    const result = verifierToRATSVerifier("verifier-001");
    expect(result.verifierId).toBe("verifier-001");
  });

  it("returns an object matching Pick<RATSVerifier, 'verifierId'>", () => {
    const verifier: Pick<RATSVerifier, "verifierId"> = verifierToRATSVerifier("v-999");
    expect(verifier.verifierId).toBe("v-999");
  });
});

describe("bundleToRATSEvidence()", () => {
  it("returns the same object (identity cast)", () => {
    const bundle = makeBundle();
    const evidence = bundleToRATSEvidence(bundle);
    expect(evidence).toBe(bundle);
  });

  it("preserves all bundle fields", () => {
    const bundle = makeBundle();
    const evidence = bundleToRATSEvidence(bundle);
    expect(evidence.jobId).toBe(bundle.jobId);
    expect(evidence.bundleHash).toBe(bundle.bundleHash);
    expect(evidence.kernelSignature).toBe(bundle.kernelSignature);
  });
});

describe("attestationToRATSResult()", () => {
  it("returns the same object (identity cast)", () => {
    const attest = makeAttestation();
    const result = attestationToRATSResult(attest);
    expect(result).toBe(attest);
  });

  it("preserves all attestation fields", () => {
    const attest = makeAttestation();
    const result = attestationToRATSResult(attest);
    expect(result.verifierId).toBe(attest.verifierId);
    expect(result.confidence).toBe(attest.confidence);
  });
});

// ── buildRATSTopology ─────────────────────────────────────────────────────────

describe("buildRATSTopology()", () => {
  const topology = buildRATSTopology({
    kernelId: "kernel-001",
    verifierIds: ["v-001", "v-002"],
    requesterId: "requester-did:pcc:abc",
    jobId: "job-001",
    manufacturerIds: ["manufacturer-A", "manufacturer-B"],
    csdUri: "csd:pcc/3dp/fdm/v1",
  });

  it("sets attester.attesterId to the kernelId", () => {
    expect(topology.attester.attesterId).toBe("kernel-001");
  });

  it("creates one verifier entry per verifierId", () => {
    expect(topology.verifiers).toHaveLength(2);
    expect(topology.verifiers[0].verifierId).toBe("v-001");
    expect(topology.verifiers[1].verifierId).toBe("v-002");
  });

  it("sets relyingParty fields", () => {
    expect(topology.relyingParty.entityId).toBe("requester-did:pcc:abc");
    expect(topology.relyingParty.jobId).toBe("job-001");
  });

  it("creates one endorser per manufacturerId", () => {
    expect(topology.endorsers).toHaveLength(2);
    expect(topology.endorsers[0].endorserId).toBe("manufacturer-A");
    expect(topology.endorsers[1].endorserId).toBe("manufacturer-B");
  });

  it("sets referenceValueProvider from csdUri", () => {
    expect(topology.referenceValueProvider.rvpId).toBe("csd:pcc/3dp/fdm/v1");
    expect(topology.referenceValueProvider.csdUri).toBe("csd:pcc/3dp/fdm/v1");
  });

  it("produces a valid RATSTopology shape", () => {
    const t: RATSTopology = topology;
    expect(t).toBeDefined();
  });
});

// ── RATSEndorser shape ─────────────────────────────────────────────────────────

describe("RATSEndorser structural shape", () => {
  it("can be constructed with required fields", () => {
    const endorser: RATSEndorser = {
      endorserId: "Ultimaker BV",
      endorsements: [
        {
          targetType: "fdm-printer",
          targetVersion: "S5-v2.1",
          expectedCharacteristics: {
            maxVelocity: 300,
            maxTemperature: 280,
            filamentDiameter: 2.85,
          },
          validUntil: "2027-01-01T00:00:00Z",
        },
      ],
    };
    expect(endorser.endorserId).toBe("Ultimaker BV");
    expect(endorser.endorsements).toHaveLength(1);
    expect(endorser.endorsements[0].targetType).toBe("fdm-printer");
  });

  it("endorsement signature field is optional", () => {
    const endorsement: RATSEndorsement = {
      targetType: "bioreactor",
      expectedCharacteristics: { maxRPM: 1200, maxTemp: 45 },
    };
    expect(endorsement.signature).toBeUndefined();
    expect(endorsement.validUntil).toBeUndefined();
  });
});

// ── RATSReferenceValues shape ──────────────────────────────────────────────────

describe("RATSReferenceValues structural shape", () => {
  it("can be constructed with required fields", () => {
    const refValues: RATSReferenceValues = {
      requiredEventTypes: [
        ["gcode_hash_verified"],
        ["execution_completed"],
        ["power_profile_sample", "power_profile_summary"],
      ],
      assuranceTier: 2,
      sourceCsdUri: "csd:pcc/3dp/fdm/v1",
      parameterRanges: {
        temperature: { min: 180, max: 280, unit: "celsius" },
        velocity: { max: 300, unit: "mm/s" },
      },
    };
    expect(refValues.requiredEventTypes).toHaveLength(3);
    expect(refValues.assuranceTier).toBe(2);
    expect(refValues.parameterRanges?.temperature?.max).toBe(280);
  });

  it("parameterRanges is optional", () => {
    const refValues: RATSReferenceValues = {
      requiredEventTypes: [["execution_completed"]],
      assuranceTier: 0,
    };
    expect(refValues.parameterRanges).toBeUndefined();
  });
});

// ── RATS role interface contracts ─────────────────────────────────────────────

describe("RATS role interface contracts (async implementation stubs)", () => {
  it("RATSAttester interface can be implemented", async () => {
    const attester: RATSAttester = {
      attesterId: "kernel-test",
      produceEvidence: async (jobId, stepId) => {
        return { ...makeBundle(), jobId, stepId };
      },
    };
    const evidence = await attester.produceEvidence("job-x", "step-1");
    expect(evidence.jobId).toBe("job-x");
    expect(evidence.stepId).toBe("step-1");
  });

  it("RATSVerifier interface can be implemented", async () => {
    const verifier: RATSVerifier = {
      verifierId: "verifier-test",
      appraise: async (evidence) => ({
        ...makeAttestation(),
        bundleId: evidence.id,
      }),
    };
    const bundle = makeBundle();
    const result = await verifier.appraise(bundle);
    expect(result.bundleId).toBe(bundle.id);
  });

  it("RATSRelyingParty interface can be implemented", async () => {
    const relyingParty: RATSRelyingParty = {
      evaluateAttestation: async (result) => result.result === "valid",
    };
    const validAttest = makeAttestation();
    const invalidAttest = { ...makeAttestation(), result: "invalid" as const };

    expect(await relyingParty.evaluateAttestation(validAttest)).toBe(true);
    expect(await relyingParty.evaluateAttestation(invalidAttest)).toBe(false);
  });

  it("RATSReferenceValueProvider interface can be implemented", async () => {
    const rvp: RATSReferenceValueProvider = {
      rvpId: "csd:pcc/3dp/fdm/v1",
      getReferenceValues: async (tier) => ({
        requiredEventTypes: [["execution_completed"]],
        assuranceTier: tier,
        sourceCsdUri: "csd:pcc/3dp/fdm/v1",
      }),
    };
    const values = await rvp.getReferenceValues(1);
    expect(values.assuranceTier).toBe(1);
    expect(values.sourceCsdUri).toBe("csd:pcc/3dp/fdm/v1");
  });
});
