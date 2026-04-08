/**
 * Digital Product Passport (DPP) types for EU ESPR compliance.
 *
 * Regulation: EU 2024/1781 (Ecodesign for Sustainable Products Regulation)
 * Standard:   CEN-CLC/JTC 24 "Digital Product Passport – Framework and System"
 * Timeline:   Batteries mandatory February 2027; textiles mid-2027; electronics 2028
 *
 * PCC generates DPPs from evidence bundles — the evidence events collected during
 * physical manufacturing already capture most required DPP data fields.
 */

import type { Id, Timestamp } from "./common.js";
import type { EvidenceEvent } from "./evidence.js";

// ── Sub-types ─────────────────────────────────────────────────────────────────

/**
 * A single material entry in the product's bill of materials.
 * Maps to ESPR Art. 7(2)(d) material composition requirements.
 */
export interface DPPMaterialEntry {
  /** Common or trade name of the material */
  name: string;
  /** CAS Registry Number (if applicable) */
  casNumber?: string;
  /** EC (EINECS) number (if applicable) */
  ecNumber?: string;
  /** Mass of this material in the finished product (kg) */
  massKg: number;
  /** Mass fraction of this material in the finished product (0.0–1.0) */
  massFraction: number;
  /** Fraction of this material that is recycled post-consumer content (0.0–1.0) */
  recycledFraction: number;
  /** ISO 3166-1 alpha-2 country of material origin */
  originCountry?: string;
  /** True if classified as Substance of Very High Concern under REACH Annex XIV */
  isReachSvhc: boolean;
  /** True if restricted under RoHS Directive 2011/65/EU */
  isRoHSRestricted: boolean;
  /** REACH exemption reference if isReachSvhc and used under exemption */
  reachExemption?: string;
}

/**
 * Material composition of the product.
 * Satisfies ESPR Art. 7(2)(d) and (e).
 */
export interface DPPMaterialComposition {
  /** All materials in the product */
  materials: DPPMaterialEntry[];
  /** Total product mass in kg */
  totalMassKg: number;
  /** Overall recycled content by mass (0.0–1.0) */
  recycledContentFraction: number;
  /** Standard used for material declaration */
  declarationStandard: "ESPR-2024/1781" | "IEC-62474" | "ISO-14021";
  /** When this composition was declared */
  declaredAt: Timestamp;
  /** DID or kernel ID of the entity making this declaration */
  declaredBy: string;
}

/**
 * Carbon footprint following GHG Protocol / ISO 14067.
 * Satisfies ESPR Art. 7(2)(b).
 */
export interface DPPCarbonFootprint {
  /** Scope 1: Direct emissions from manufacturing site (kg CO₂e) */
  scope1KgCO2e?: number;
  /**
   * Scope 2: Indirect emissions from purchased electricity (kg CO₂e).
   * Derived from power_profile_summary energy × grid carbon intensity.
   */
  scope2KgCO2e: number;
  /** Scope 3: Value chain emissions (kg CO₂e) — optional initially */
  scope3KgCO2e?: number;
  /** Total lifecycle carbon footprint (kg CO₂e) */
  totalKgCO2e: number;
  /** Grid carbon intensity used for scope 2 calculation (gCO₂e/kWh) */
  gridCarbonIntensityGPerKwh: number;
  /** Source identifier for the grid carbon factor (e.g. "IEA-2025-DE") */
  gridCarbonSource: string;
  /** Accounting methodology */
  methodology: "GHG-Protocol" | "ISO-14067" | "PEF";
  /** Source energy consumption in kWh (from power_profile_summary) */
  energyKwh: number;
}

/**
 * EU Repair Index score and sub-scores.
 * Satisfies ESPR Art. 7(2)(h).
 */
export interface DPPRepairabilityScore {
  /** Overall repairability score (0.0–10.0, EU Repair Index scale) */
  score: number;
  /** Dismantlability sub-score (0.0–10.0) */
  dismantlability: number;
  /** Spare parts availability sub-score (0.0–10.0) */
  spareParts: number;
  /** Repair cost relative to product value sub-score (0.0–10.0) */
  repairCost: number;
  /** Repair documentation quality sub-score (0.0–10.0) */
  documentation: number;
  /** Software/firmware updateability sub-score (0.0–10.0) */
  software: number;
  /** Entity that performed the repairability assessment (DID or identifier) */
  assessedBy: string;
  /** Methodology version */
  methodology: "EU-Repair-Index-v1";
  /** When the assessment was performed */
  assessedAt: Timestamp;
}

/**
 * Supply chain actor (manufacturer, processor, importer, distributor).
 * Satisfies ESPR Art. 9(2).
 */
export interface DPPSupplyChainActor {
  /** Role in the supply chain */
  role: "manufacturer" | "processor" | "importer" | "distributor" | "operator" | "courier";
  /** Legal entity name */
  name?: string;
  /** EORI number (for EU customs actors) */
  eoriNumber?: string;
  /** DID or PCC identity */
  did?: string;
  /** ISO 3166-1 alpha-2 country of operation */
  country?: string;
  /** When this actor joined the chain (ISO 8601) */
  timestamp: Timestamp;
}

/**
 * Substance of concern declaration.
 * Satisfies ESPR Art. 7(2)(f) and REACH Annex XIV.
 */
export interface DPPSubstanceDeclaration {
  substanceName: string;
  casNumber: string;
  ecNumber?: string;
  /** Concentration in finished product (parts per million by mass) */
  massConcentrationPpm: number;
  isReachSvhc: boolean;
  isRoHSRestricted: boolean;
  exemption?: string;
  /** Basis for the declared value */
  declarationBasis: "measured" | "supplier-declared" | "calculated";
}

/**
 * Evidence of quality inspection (from CV inspection events).
 */
export interface DPPQualityRecord {
  /** Event type that generated this record */
  sourceEventType: "cv_inspection_result" | "instrument_result" | "batch_sample_result";
  /** Overall pass/fail */
  result: "PASS" | "FAIL" | "CONDITIONAL";
  /** Pass rate (0.0–1.0) */
  passRate?: number;
  /** Number of defects detected */
  defectsDetected?: number;
  /** Inspection timestamp */
  inspectedAt: Timestamp;
  /** Reference to the evidence event ID */
  evidenceEventId: Id;
}

// ── DigitalProductPassport ─────────────────────────────────────────────────────

/**
 * Digital Product Passport — EU ESPR compliant product data record.
 *
 * Follows the data model structure expected by CEN-CLC/JTC 24 and the
 * GS1 DPP Provisional Standard. Access via QR/NFC must resolve to this
 * record (or a JSON-LD serialisation of it).
 *
 * PCC generates this from evidence bundles using `evidenceToDPP()`.
 */
export interface DigitalProductPassport {
  // ── Identity ────────────────────────────────────────────────────────────────

  /** Unique passport identifier (urn:pcc:dpp:<jobId>) */
  passportId: Id;
  /** Version of this passport record */
  version: string;
  /** Lifecycle status */
  status: "active" | "recalled" | "withdrawn" | "archived";
  /** DID of the entity that issued this passport */
  issuer: string;
  /** When this passport was generated */
  issuedAt: Timestamp;
  /** When this passport was last updated */
  updatedAt?: Timestamp;
  /** URL that the DPP QR code resolves to */
  accessLink: string;

  // ── Product Identity ────────────────────────────────────────────────────────

  /** Unique product/batch identifier (maps to PCC jobId or batchId) */
  productId: Id;
  /** Product model/type designation (maps to CSD capabilityId) */
  productModel?: string;
  /** CSD URI linking to the capability StructureDefinition */
  csdUri?: string;
  /** Human-readable product name */
  productName?: string;
  /** ISO 3166-1 alpha-2 country where manufacturing occurred */
  countryOfOrigin?: string;
  /** Date manufacturing was completed */
  productionDate?: Timestamp;
  /** Batch identifier (if batch production) */
  batchId?: Id;

  // ── Manufacturer ────────────────────────────────────────────────────────────

  /** PCC Shop Kernel ID that executed the manufacturing job */
  kernelId?: Id;
  /** DID of the operator (manufacturer) */
  manufacturerDid?: string;
  /** EORI number of the manufacturer (for EU customs) */
  manufacturerEori?: string;
  /** Legal name of manufacturing entity */
  manufacturerName?: string;

  // ── Environmental / Sustainability ──────────────────────────────────────────

  /**
   * Carbon footprint of manufacturing.
   * Derived from power_profile_summary evidence events.
   */
  carbonFootprint?: DPPCarbonFootprint;

  /**
   * Total energy consumed during manufacturing (kWh).
   * Directly from power_profile_summary payload.totalKwh.
   */
  energyConsumptionKwh?: number;

  /**
   * Material composition (BOM).
   * Populated from material_bill_declared evidence events.
   */
  materialComposition?: DPPMaterialComposition;

  /**
   * Hazardous/concern substance declarations.
   * Populated from substance_declaration evidence events.
   */
  substanceDeclarations?: DPPSubstanceDeclaration[];

  // ── Repairability / Durability ───────────────────────────────────────────────

  /** EU Repair Index score. Populated from repairability_assessment events. */
  repairability?: DPPRepairabilityScore;

  /** Expected product lifespan in years (from CSD or operator declaration) */
  expectedLifespanYears?: number;

  /** Minimum warranty period in months */
  warrantyMonths?: number;

  /** URL to repair manual or service documentation */
  repairManualUrl?: string;

  /** End-of-life handling instructions */
  endOfLifeInstructions?: string;

  // ── Verification / Traceability ──────────────────────────────────────────────

  /**
   * Cryptographic proofs from TEE attestation and ZK verification.
   * Populated from tee_attestation and zk_proof_verified events.
   */
  verificationProofs?: Array<{
    type: "tee_attestation" | "zk_proof" | "verifier_consensus";
    proofReference: string;   // IPFS CID or on-chain tx hash
    verifiedAt: Timestamp;
    verifierDid?: string;
  }>;

  /**
   * Quality inspection records from CV inspection and instrument results.
   * Populated from cv_inspection_result, instrument_result events.
   */
  qualityRecords?: DPPQualityRecord[];

  /**
   * Supply chain actors involved in manufacturing and delivery.
   * Populated from custody_* and courier_* evidence events.
   */
  supplyChainActors?: DPPSupplyChainActor[];

  /**
   * Links to compliance certificates (calibration records, ISO certs).
   * Populated from calibration_record evidence events.
   */
  complianceCertificates?: Array<{
    standard: string;         // e.g. "ISO-9001", "FDA-21CFR-Part11"
    certificateId?: string;
    issuedBy?: string;
    issuedAt?: Timestamp;
    validUntil?: Timestamp;
    evidenceEventId: Id;
  }>;

  /** SHA-256 hash of the source evidence bundle */
  evidenceBundleHash?: string;

  /** IPFS CIDs of the source evidence bundles */
  evidenceCids?: string[];
}

// ── evidenceToDPP mapping function ────────────────────────────────────────────

/**
 * Map an array of EvidenceEvents to a partial DigitalProductPassport.
 *
 * This is the core transformation: evidence events → DPP data fields.
 * The result is a Partial<DigitalProductPassport> — many optional fields
 * (carbon footprint, material composition) require additional events or
 * operator-supplied data not available in all evidence bundles.
 *
 * Call generateDPP() in the gateway for the full assembled passport.
 *
 * @param events - All EvidenceEvents for a job (across all bundles)
 * @returns Partial DPP populated from available evidence
 */
export function evidenceToDPP(
  events: EvidenceEvent[],
): Partial<DigitalProductPassport> {
  const partial: Partial<DigitalProductPassport> = {};
  const verificationProofs: DigitalProductPassport["verificationProofs"] = [];
  const qualityRecords: DPPQualityRecord[] = [];
  const supplyChainActors: DPPSupplyChainActor[] = [];
  const complianceCertificates: DigitalProductPassport["complianceCertificates"] = [];
  const evidenceCids: string[] = [];

  for (const event of events) {
    const p = event.payload as Record<string, unknown>;

    switch (event.type) {
      // ── Product / job identity ─────────────────────────────────────────────

      case "batch_session_started":
        partial.batchId = (p["batchId"] as string | undefined) ?? partial.batchId;
        partial.productId = (p["jobId"] as string | undefined) ?? partial.productId;
        break;

      case "execution_started":
        partial.productionDate = event.timestamp;
        break;

      case "sequence_started":
        partial.productModel = (p["capabilityId"] as string | undefined) ?? partial.productModel;
        partial.csdUri = (p["csdUri"] as string | undefined) ?? partial.csdUri;
        break;

      case "gcode_loaded":
        // G-code metadata may include material BOM if operator populates it
        if (p["materials"]) {
          // Lightweight pass-through — full parsing done in generateDPP()
          partial.materialComposition = {
            materials: p["materials"] as DPPMaterialEntry[],
            totalMassKg: (p["totalMassKg"] as number | undefined) ?? 0,
            recycledContentFraction: (p["recycledContentFraction"] as number | undefined) ?? 0,
            declarationStandard: "ESPR-2024/1781",
            declaredAt: event.timestamp,
            declaredBy: event.source.kernelId,
          };
        }
        break;

      // ── Manufacturer / site identity ────────────────────────────────────────

      case "device_birth":
        partial.kernelId = event.source.kernelId;
        partial.manufacturerDid = (p["operatorDid"] as string | undefined) ?? partial.manufacturerDid;
        partial.countryOfOrigin = (p["location"] as string | undefined) ?? partial.countryOfOrigin;
        break;

      // ── Energy / carbon ─────────────────────────────────────────────────────

      case "power_profile_summary": {
        const kwh = (p["totalKwh"] as number | undefined);
        if (kwh !== undefined) {
          partial.energyConsumptionKwh = (partial.energyConsumptionKwh ?? 0) + kwh;
        }
        break;
      }

      // ── New DPP-specific events ──────────────────────────────────────────────

      case "material_bill_declared" as EvidenceEvent["type"]:
        partial.materialComposition = {
          materials: (p["materials"] as DPPMaterialEntry[]) ?? [],
          totalMassKg: (p["totalMassKg"] as number | undefined) ?? 0,
          recycledContentFraction: (p["recycledFraction"] as number | undefined) ?? 0,
          declarationStandard: (p["declarationStandard"] as DPPMaterialComposition["declarationStandard"]) ?? "ESPR-2024/1781",
          declaredAt: event.timestamp,
          declaredBy: (p["declaredBy"] as string | undefined) ?? event.source.kernelId,
        };
        break;

      case "carbon_footprint_declared" as EvidenceEvent["type"]:
        partial.carbonFootprint = {
          scope1KgCO2e: p["scope1KgCO2e"] as number | undefined,
          scope2KgCO2e: (p["scope2KgCO2e"] as number) ?? 0,
          scope3KgCO2e: p["scope3KgCO2e"] as number | undefined,
          totalKgCO2e: (p["totalKgCO2e"] as number) ?? 0,
          gridCarbonIntensityGPerKwh: (p["gridCarbonIntensityGPerKwh"] as number) ?? 233,
          gridCarbonSource: (p["gridCarbonSource"] as string) ?? "IEA-2024-EU-average",
          methodology: (p["methodology"] as DPPCarbonFootprint["methodology"]) ?? "GHG-Protocol",
          energyKwh: (p["energyKwh"] as number) ?? 0,
        };
        break;

      case "repairability_assessment" as EvidenceEvent["type"]:
        partial.repairability = {
          score: (p["score"] as number) ?? 0,
          dismantlability: (p["dismantlability"] as number) ?? 0,
          spareParts: (p["availability"] as number) ?? 0,
          repairCost: (p["pricing"] as number) ?? 0,
          documentation: (p["documentation"] as number) ?? 0,
          software: (p["software"] as number) ?? 0,
          assessedBy: (p["assessedBy"] as string) ?? event.source.kernelId,
          methodology: "EU-Repair-Index-v1",
          assessedAt: event.timestamp,
        };
        break;

      // ── Verification proofs ──────────────────────────────────────────────────

      case "tee_attestation":
        verificationProofs.push({
          type: "tee_attestation",
          proofReference: (p["attestationCid"] as string | undefined) ?? event.hash,
          verifiedAt: event.timestamp,
          verifierDid: (p["verifierDid"] as string | undefined),
        });
        break;

      case "zk_proof_verified":
        verificationProofs.push({
          type: "zk_proof",
          proofReference: (p["proofCid"] as string | undefined) ?? event.hash,
          verifiedAt: event.timestamp,
          verifierDid: (p["verifiedBy"] as string | undefined),
        });
        break;

      case "evidence_committed":
        if (p["cid"]) {
          evidenceCids.push(p["cid"] as string);
        }
        break;

      // ── Quality inspection ───────────────────────────────────────────────────

      case "cv_inspection_result":
        qualityRecords.push({
          sourceEventType: "cv_inspection_result",
          result: (p["pass"] as boolean) ? "PASS" : "FAIL",
          passRate: p["passRate"] as number | undefined,
          defectsDetected: p["defectsDetected"] as number | undefined,
          inspectedAt: event.timestamp,
          evidenceEventId: event.id,
        });
        break;

      case "instrument_result":
        qualityRecords.push({
          sourceEventType: "instrument_result",
          result: (p["pass"] as boolean | undefined) === false ? "FAIL" : "PASS",
          inspectedAt: event.timestamp,
          evidenceEventId: event.id,
        });
        break;

      case "batch_sample_result":
        qualityRecords.push({
          sourceEventType: "batch_sample_result",
          result: (p["status"] as string) === "PASS" ? "PASS" : "FAIL",
          inspectedAt: event.timestamp,
          evidenceEventId: event.id,
        });
        break;

      // ── Supply chain actors ──────────────────────────────────────────────────

      case "custody_handoff_initiated":
        supplyChainActors.push({
          role: "operator",
          did: (p["handoffTo"] as string | undefined),
          timestamp: event.timestamp,
        });
        break;

      case "courier_pickup_confirmed":
        supplyChainActors.push({
          role: "courier",
          did: (p["courierId"] as string | undefined),
          timestamp: event.timestamp,
        });
        break;

      case "courier_delivery_confirmed":
        supplyChainActors.push({
          role: "distributor",
          did: (p["deliveredTo"] as string | undefined),
          timestamp: event.timestamp,
        });
        break;

      // ── Calibration / compliance certificates ───────────────────────────────

      case "calibration_record":
        complianceCertificates.push({
          standard: (p["standard"] as string | undefined) ?? "ISO-17025",
          certificateId: p["calibrationId"] as string | undefined,
          issuedBy: p["calibratedBy"] as string | undefined,
          issuedAt: event.timestamp,
          validUntil: p["validUntil"] as string | undefined,
          evidenceEventId: event.id,
        });
        break;

      // ── Default: ignore event types not relevant to DPP ───────────────────

      default:
        break;
    }
  }

  // Attach collected arrays (only if non-empty)
  if (verificationProofs.length > 0) partial.verificationProofs = verificationProofs;
  if (qualityRecords.length > 0) partial.qualityRecords = qualityRecords;
  if (supplyChainActors.length > 0) partial.supplyChainActors = supplyChainActors;
  if (complianceCertificates.length > 0) partial.complianceCertificates = complianceCertificates;
  if (evidenceCids.length > 0) partial.evidenceCids = evidenceCids;

  // Derive carbon footprint from energy if not explicitly declared
  if (partial.carbonFootprint === undefined && partial.energyConsumptionKwh !== undefined) {
    const EU_AVERAGE_GRID_FACTOR_G_PER_KWH = 233;
    partial.carbonFootprint = {
      scope2KgCO2e: partial.energyConsumptionKwh * (EU_AVERAGE_GRID_FACTOR_G_PER_KWH / 1000),
      totalKgCO2e: partial.energyConsumptionKwh * (EU_AVERAGE_GRID_FACTOR_G_PER_KWH / 1000),
      gridCarbonIntensityGPerKwh: EU_AVERAGE_GRID_FACTOR_G_PER_KWH,
      gridCarbonSource: "IEA-2024-EU-average",
      methodology: "GHG-Protocol",
      energyKwh: partial.energyConsumptionKwh,
    };
  }

  return partial;
}
