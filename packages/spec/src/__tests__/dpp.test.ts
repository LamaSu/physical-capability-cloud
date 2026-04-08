/**
 * Tests for Digital Product Passport (DPP) types and evidenceToDPP() mapping.
 *
 * All tests are structural — they verify that the types can be constructed,
 * that TypeScript narrowing works correctly, and that evidenceToDPP() maps
 * evidence events to the correct DPP fields with correct derivations.
 */

import { describe, it, expect } from "vitest";
import type {
  DigitalProductPassport,
  DPPMaterialComposition,
  DPPCarbonFootprint,
  DPPRepairabilityScore,
  DPPMaterialEntry,
  DPPSupplyChainActor,
  DPPQualityRecord,
} from "../types/dpp.js";
import { evidenceToDPP } from "../types/dpp.js";
import type { EvidenceEvent } from "../types/evidence.js";
import type { Id, SHA256 } from "../types/common.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const mockHash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as SHA256;

function makeEvent(
  type: EvidenceEvent["type"],
  payload: Record<string, unknown>,
  overrides: Partial<EvidenceEvent> = {},
): EvidenceEvent {
  return {
    id: `evt-${type}-1` as Id,
    type,
    timestamp: "2026-04-03T10:00:00.000Z",
    source: {
      deviceId: "dev-cnc-001" as Id,
      deviceType: "controller",
      kernelId: "kernel-sf-01" as Id,
    },
    payload,
    hash: mockHash,
    ...overrides,
  };
}

// ── Type construction tests ──────────────────────────────────────────────────

describe("DigitalProductPassport — type construction", () => {
  it("can construct a minimal valid DPP", () => {
    const dpp: DigitalProductPassport = {
      passportId: "urn:pcc:dpp:job-123",
      version: "1.0",
      status: "active",
      issuer: "did:pcc:gateway",
      issuedAt: "2026-04-03T00:00:00.000Z",
      accessLink: "https://capability.network/dpp/job-123",
      productId: "job-123",
    };
    expect(dpp.passportId).toBe("urn:pcc:dpp:job-123");
    expect(dpp.status).toBe("active");
  });

  it("supports all status values", () => {
    const statuses: DigitalProductPassport["status"][] = [
      "active",
      "recalled",
      "withdrawn",
      "archived",
    ];
    expect(statuses).toHaveLength(4);
  });

  it("can construct a full DPP with all optional fields", () => {
    const dpp: DigitalProductPassport = {
      passportId: "urn:pcc:dpp:job-456",
      version: "1.0",
      status: "active",
      issuer: "did:pcc:gateway",
      issuedAt: "2026-04-03T00:00:00.000Z",
      accessLink: "https://capability.network/dpp/job-456",
      productId: "job-456",
      productModel: "cap-cnc-milling-sf",
      csdUri: "pcc://capabilities/cap-cnc-milling-sf",
      productName: "Aluminium Bracket — Milled",
      countryOfOrigin: "DE",
      productionDate: "2026-04-03T09:00:00.000Z",
      batchId: "batch-2026-001",
      kernelId: "kernel-sf-01",
      manufacturerDid: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
      energyConsumptionKwh: 2.45,
      expectedLifespanYears: 10,
      warrantyMonths: 24,
      repairManualUrl: "https://docs.pcc.network/repair/bracket",
      endOfLifeInstructions: "Aluminium — 100% recyclable. Contact local recycler.",
      evidenceCids: ["bafybeig..."],
      evidenceBundleHash: "sha256:abc123",
    };
    expect(dpp.energyConsumptionKwh).toBe(2.45);
    expect(dpp.countryOfOrigin).toBe("DE");
  });
});

describe("DPPMaterialComposition — type construction", () => {
  it("can be constructed with required fields", () => {
    const entry: DPPMaterialEntry = {
      name: "Aluminium 6061",
      massKg: 0.45,
      massFraction: 0.85,
      recycledFraction: 0.3,
      isReachSvhc: false,
      isRoHSRestricted: false,
    };

    const composition: DPPMaterialComposition = {
      materials: [entry],
      totalMassKg: 0.53,
      recycledContentFraction: 0.25,
      declarationStandard: "ESPR-2024/1781",
      declaredAt: "2026-04-03T00:00:00.000Z",
      declaredBy: "did:key:z6Mk...",
    };

    expect(composition.materials).toHaveLength(1);
    expect(composition.recycledContentFraction).toBe(0.25);
    expect(composition.declarationStandard).toBe("ESPR-2024/1781");
  });

  it("supports all declaration standards", () => {
    const standards: DPPMaterialComposition["declarationStandard"][] = [
      "ESPR-2024/1781",
      "IEC-62474",
      "ISO-14021",
    ];
    expect(standards).toHaveLength(3);
  });

  it("can include SVHC-flagged materials", () => {
    const svhcMaterial: DPPMaterialEntry = {
      name: "Chromium VI compound",
      casNumber: "18540-29-9",
      massKg: 0.001,
      massFraction: 0.002,
      recycledFraction: 0,
      isReachSvhc: true,
      isRoHSRestricted: true,
      reachExemption: "REACH-Annex-XIV-exemption-7c",
    };
    expect(svhcMaterial.isReachSvhc).toBe(true);
    expect(svhcMaterial.reachExemption).toBeDefined();
  });
});

describe("DPPCarbonFootprint — type construction", () => {
  it("can be constructed with minimum scope 2 fields", () => {
    const cf: DPPCarbonFootprint = {
      scope2KgCO2e: 0.571,
      totalKgCO2e: 0.571,
      gridCarbonIntensityGPerKwh: 233,
      gridCarbonSource: "IEA-2024-EU-average",
      methodology: "GHG-Protocol",
      energyKwh: 2.45,
    };
    expect(cf.totalKgCO2e).toBe(0.571);
    expect(cf.methodology).toBe("GHG-Protocol");
  });

  it("supports all methodology values", () => {
    const methodologies: DPPCarbonFootprint["methodology"][] = [
      "GHG-Protocol",
      "ISO-14067",
      "PEF",
    ];
    expect(methodologies).toHaveLength(3);
  });
});

describe("DPPRepairabilityScore — type construction", () => {
  it("can be constructed with all required fields", () => {
    const score: DPPRepairabilityScore = {
      score: 7.5,
      dismantlability: 8.0,
      spareParts: 7.0,
      repairCost: 6.5,
      documentation: 9.0,
      software: 7.0,
      assessedBy: "did:pcc:evaluator-01",
      methodology: "EU-Repair-Index-v1",
      assessedAt: "2026-04-03T00:00:00.000Z",
    };
    expect(score.score).toBe(7.5);
    expect(score.methodology).toBe("EU-Repair-Index-v1");
  });
});

// ── evidenceToDPP() mapping tests ─────────────────────────────────────────────

describe("evidenceToDPP() — empty events", () => {
  it("returns an empty partial for no events", () => {
    const result = evidenceToDPP([]);
    expect(result).toEqual({});
  });
});

describe("evidenceToDPP() — product identity mapping", () => {
  it("maps batch_session_started to productId and batchId", () => {
    const events: EvidenceEvent[] = [
      makeEvent("batch_session_started", { jobId: "job-001", batchId: "batch-2026-A" }),
    ];
    const result = evidenceToDPP(events);
    expect(result.productId).toBe("job-001");
    expect(result.batchId).toBe("batch-2026-A");
  });

  it("maps execution_started timestamp to productionDate", () => {
    const ts = "2026-04-03T08:30:00.000Z";
    const events: EvidenceEvent[] = [
      makeEvent("execution_started", {}, { timestamp: ts }),
    ];
    const result = evidenceToDPP(events);
    expect(result.productionDate).toBe(ts);
  });

  it("maps sequence_started to productModel and csdUri", () => {
    const events: EvidenceEvent[] = [
      makeEvent("sequence_started", {
        capabilityId: "cap-cnc-milling-sf",
        csdUri: "pcc://capabilities/cap-cnc-milling-sf",
      }),
    ];
    const result = evidenceToDPP(events);
    expect(result.productModel).toBe("cap-cnc-milling-sf");
    expect(result.csdUri).toBe("pcc://capabilities/cap-cnc-milling-sf");
  });

  it("maps device_birth to kernelId and countryOfOrigin", () => {
    const events: EvidenceEvent[] = [
      makeEvent("device_birth", {
        operatorDid: "did:key:z6Mk...",
        location: "DE",
      }),
    ];
    const result = evidenceToDPP(events);
    expect(result.kernelId).toBe("kernel-sf-01");
    expect(result.manufacturerDid).toBe("did:key:z6Mk...");
    expect(result.countryOfOrigin).toBe("DE");
  });
});

describe("evidenceToDPP() — energy and carbon mapping", () => {
  it("accumulates energy from multiple power_profile_summary events", () => {
    const events: EvidenceEvent[] = [
      makeEvent("power_profile_summary", { totalKwh: 1.5 }),
      makeEvent("power_profile_summary", { totalKwh: 0.95 }),
    ];
    const result = evidenceToDPP(events);
    expect(result.energyConsumptionKwh).toBeCloseTo(2.45, 5);
  });

  it("derives carbon footprint from energy when no carbon event present", () => {
    const events: EvidenceEvent[] = [
      makeEvent("power_profile_summary", { totalKwh: 10.0 }),
    ];
    const result = evidenceToDPP(events);
    expect(result.carbonFootprint).toBeDefined();
    expect(result.carbonFootprint!.energyKwh).toBe(10.0);
    // 10 kWh × 233 g/kWh ÷ 1000 = 2.33 kgCO2e
    expect(result.carbonFootprint!.scope2KgCO2e).toBeCloseTo(2.33, 2);
    expect(result.carbonFootprint!.totalKgCO2e).toBeCloseTo(2.33, 2);
    expect(result.carbonFootprint!.gridCarbonSource).toBe("IEA-2024-EU-average");
    expect(result.carbonFootprint!.methodology).toBe("GHG-Protocol");
  });

  it("does not derive carbon if no energy events present", () => {
    const result = evidenceToDPP([]);
    expect(result.carbonFootprint).toBeUndefined();
    expect(result.energyConsumptionKwh).toBeUndefined();
  });
});

describe("evidenceToDPP() — verification proof mapping", () => {
  it("maps tee_attestation to verificationProofs", () => {
    const events: EvidenceEvent[] = [
      makeEvent("tee_attestation", {
        attestationCid: "bafybeiAttestation123",
        verifierDid: "did:pcc:verifier-01",
      }),
    ];
    const result = evidenceToDPP(events);
    expect(result.verificationProofs).toHaveLength(1);
    expect(result.verificationProofs![0].type).toBe("tee_attestation");
    expect(result.verificationProofs![0].proofReference).toBe("bafybeiAttestation123");
    expect(result.verificationProofs![0].verifierDid).toBe("did:pcc:verifier-01");
  });

  it("maps zk_proof_verified to verificationProofs", () => {
    const events: EvidenceEvent[] = [
      makeEvent("zk_proof_verified", {
        proofCid: "bafybeiZKProof456",
        verifiedBy: "did:pcc:verifier-02",
      }),
    ];
    const result = evidenceToDPP(events);
    expect(result.verificationProofs).toHaveLength(1);
    expect(result.verificationProofs![0].type).toBe("zk_proof");
  });

  it("collects multiple proofs from multiple events", () => {
    const events: EvidenceEvent[] = [
      makeEvent("tee_attestation", { attestationCid: "cid1" }),
      makeEvent("zk_proof_verified", { proofCid: "cid2" }),
    ];
    const result = evidenceToDPP(events);
    expect(result.verificationProofs).toHaveLength(2);
  });

  it("maps evidence_committed CIDs to evidenceCids", () => {
    const events: EvidenceEvent[] = [
      makeEvent("evidence_committed", { cid: "bafybeiBundle1" }),
      makeEvent("evidence_committed", { cid: "bafybeiBundle2" }),
    ];
    const result = evidenceToDPP(events);
    expect(result.evidenceCids).toEqual(["bafybeiBundle1", "bafybeiBundle2"]);
  });
});

describe("evidenceToDPP() — quality inspection mapping", () => {
  it("maps cv_inspection_result PASS to qualityRecords", () => {
    const events: EvidenceEvent[] = [
      makeEvent("cv_inspection_result", { pass: true, passRate: 0.98, defectsDetected: 0 }),
    ];
    const result = evidenceToDPP(events);
    expect(result.qualityRecords).toHaveLength(1);
    const qr = result.qualityRecords![0] as DPPQualityRecord;
    expect(qr.result).toBe("PASS");
    expect(qr.passRate).toBe(0.98);
    expect(qr.sourceEventType).toBe("cv_inspection_result");
  });

  it("maps cv_inspection_result FAIL correctly", () => {
    const events: EvidenceEvent[] = [
      makeEvent("cv_inspection_result", { pass: false, defectsDetected: 3 }),
    ];
    const result = evidenceToDPP(events);
    expect(result.qualityRecords![0].result).toBe("FAIL");
    expect(result.qualityRecords![0].defectsDetected).toBe(3);
  });

  it("maps instrument_result to qualityRecords", () => {
    const events: EvidenceEvent[] = [
      makeEvent("instrument_result", { pass: true }),
    ];
    const result = evidenceToDPP(events);
    expect(result.qualityRecords).toHaveLength(1);
    expect(result.qualityRecords![0].sourceEventType).toBe("instrument_result");
  });

  it("maps batch_sample_result to qualityRecords", () => {
    const events: EvidenceEvent[] = [
      makeEvent("batch_sample_result", { status: "PASS" }),
    ];
    const result = evidenceToDPP(events);
    expect(result.qualityRecords![0].result).toBe("PASS");
  });
});

describe("evidenceToDPP() — supply chain actor mapping", () => {
  it("maps custody_handoff_initiated to supplyChainActors", () => {
    const events: EvidenceEvent[] = [
      makeEvent("custody_handoff_initiated", { handoffTo: "did:pcc:operator-02" }),
    ];
    const result = evidenceToDPP(events);
    expect(result.supplyChainActors).toHaveLength(1);
    const actor = result.supplyChainActors![0] as DPPSupplyChainActor;
    expect(actor.role).toBe("operator");
    expect(actor.did).toBe("did:pcc:operator-02");
  });

  it("maps courier_pickup_confirmed to supplyChainActors with courier role", () => {
    const events: EvidenceEvent[] = [
      makeEvent("courier_pickup_confirmed", { courierId: "courier-fedex-001" }),
    ];
    const result = evidenceToDPP(events);
    expect(result.supplyChainActors![0].role).toBe("courier");
  });

  it("maps courier_delivery_confirmed to supplyChainActors with distributor role", () => {
    const events: EvidenceEvent[] = [
      makeEvent("courier_delivery_confirmed", { deliveredTo: "did:pcc:customer-01" }),
    ];
    const result = evidenceToDPP(events);
    expect(result.supplyChainActors![0].role).toBe("distributor");
  });

  it("builds full supply chain from custody sequence", () => {
    const events: EvidenceEvent[] = [
      makeEvent("custody_handoff_initiated", { handoffTo: "did:pcc:courier" }),
      makeEvent("courier_pickup_confirmed", { courierId: "ups-001" }),
      makeEvent("courier_delivery_confirmed", { deliveredTo: "did:pcc:buyer" }),
    ];
    const result = evidenceToDPP(events);
    expect(result.supplyChainActors).toHaveLength(3);
    expect(result.supplyChainActors!.map((a) => a.role)).toEqual([
      "operator",
      "courier",
      "distributor",
    ]);
  });
});

describe("evidenceToDPP() — calibration certificate mapping", () => {
  it("maps calibration_record to complianceCertificates", () => {
    const events: EvidenceEvent[] = [
      makeEvent("calibration_record", {
        standard: "ISO-17025",
        calibrationId: "cal-2026-001",
        calibratedBy: "did:pcc:lab-01",
        validUntil: "2027-04-03T00:00:00.000Z",
      }),
    ];
    const result = evidenceToDPP(events);
    expect(result.complianceCertificates).toHaveLength(1);
    const cert = result.complianceCertificates![0];
    expect(cert.standard).toBe("ISO-17025");
    expect(cert.certificateId).toBe("cal-2026-001");
    expect(cert.issuedBy).toBe("did:pcc:lab-01");
    expect(cert.validUntil).toBe("2027-04-03T00:00:00.000Z");
  });
});

describe("evidenceToDPP() — full job simulation", () => {
  it("maps a realistic full job evidence sequence to a rich partial DPP", () => {
    const events: EvidenceEvent[] = [
      makeEvent("batch_session_started", { jobId: "job-abc", batchId: "batch-001" }),
      makeEvent("device_birth", { operatorDid: "did:key:z6Mk...", location: "DE" }),
      makeEvent("sequence_started", {
        capabilityId: "cap-cnc-milling-sf",
        csdUri: "pcc://capabilities/cap-cnc-milling-sf",
      }),
      makeEvent("execution_started", {}, { timestamp: "2026-04-03T09:00:00.000Z" }),
      makeEvent("power_profile_summary", { totalKwh: 1.2 }),
      makeEvent("power_profile_summary", { totalKwh: 0.8 }),
      makeEvent("cv_inspection_result", { pass: true, passRate: 0.99 }),
      makeEvent("tee_attestation", { attestationCid: "bafyTEE" }),
      makeEvent("zk_proof_verified", { proofCid: "bafyZK" }),
      makeEvent("evidence_committed", { cid: "bafyBundle" }),
      makeEvent("calibration_record", { standard: "ISO-17025", calibrationId: "cal-001" }),
      makeEvent("custody_handoff_initiated", { handoffTo: "did:pcc:courier" }),
      makeEvent("courier_delivery_confirmed", { deliveredTo: "did:pcc:customer" }),
    ];

    const result = evidenceToDPP(events);

    // Identity
    expect(result.productId).toBe("job-abc");
    expect(result.batchId).toBe("batch-001");
    expect(result.productModel).toBe("cap-cnc-milling-sf");
    expect(result.kernelId).toBe("kernel-sf-01");
    expect(result.countryOfOrigin).toBe("DE");
    expect(result.productionDate).toBe("2026-04-03T09:00:00.000Z");

    // Energy
    expect(result.energyConsumptionKwh).toBeCloseTo(2.0, 5);

    // Derived carbon footprint
    expect(result.carbonFootprint).toBeDefined();
    expect(result.carbonFootprint!.energyKwh).toBeCloseTo(2.0, 5);
    expect(result.carbonFootprint!.methodology).toBe("GHG-Protocol");

    // Verification proofs
    expect(result.verificationProofs).toHaveLength(2);
    expect(result.evidenceCids).toEqual(["bafyBundle"]);

    // Quality
    expect(result.qualityRecords).toHaveLength(1);
    expect(result.qualityRecords![0].result).toBe("PASS");

    // Compliance certs
    expect(result.complianceCertificates).toHaveLength(1);

    // Supply chain
    expect(result.supplyChainActors).toHaveLength(2);

    // Result is a valid Partial<DigitalProductPassport> (TypeScript check)
    const _typed: Partial<DigitalProductPassport> = result;
    expect(_typed).toBeDefined();
  });
});
