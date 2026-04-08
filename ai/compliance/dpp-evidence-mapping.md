# Digital Product Passport (DPP) — Evidence Mapping for PCC

**Regulation**: EU Regulation 2024/1781 (ESPR — Ecodesign for Sustainable Products Regulation)  
**Standard**: CEN-CLC/JTC 24 "Digital Product Passport – Framework and System" (harmonised standard in development)  
**Registry**: EU DPP Registry operational target: July 2026  
**First mandatory category**: Batteries (February 2027)  
**Prepared**: 2026-04-03  
**Sources**: [fluxy.one DPP Guide](https://fluxy.one/post/digital-product-passport-dpp-eu-guide-2025-2030), [EC Publications DPP Methodology](https://op.europa.eu/en/publication-detail/-/publication/026fc51a-240d-11f1-8c3a-01aa75ed71a1/language-en), [GS1 DPP Provisional Standard](https://www.gs1.org/standards/standards-emerging-regulations/DPP), [climatiq.io DPP Guide](https://www.climatiq.io/blog/digital-product-passports-what-you-need-to-know-to-be-ready-for-regulatory-compliance-in-2025)

---

## What is DPP in the Context of PCC?

PCC executes physical manufacturing jobs (CNC milling, 3D printing, lab work, assembly). Each completed job produces an **evidence bundle** — cryptographic proof that physical work happened. These evidence bundles contain nearly all data required by EU DPP for manufactured products.

**PCC's opportunity**: Automatically generate a standards-compliant DPP from each job's evidence bundle, giving PCC customers instant EU regulatory compliance for products manufactured through the network.

---

## DPP Required Data Fields — ESPR Framework

### Tier 1: Mandatory Core Fields (all product categories)

| DPP Field | ESPR Article | Description |
|-----------|-------------|-------------|
| `productId` | Art. 4(2)(a) | Unique product/batch/item identifier |
| `productModel` | Art. 4(2)(b) | Model or type designation |
| `manufacturer` | Art. 4(2)(c) | Legal entity name, address, EORI number |
| `countryOfOrigin` | Art. 4(2)(d) | Manufacturing location (ISO 3166-1 alpha-2) |
| `productionDate` | Art. 4(2)(e) | Date/batch of manufacture |
| `accessLink` | Art. 4(3) | QR/NFC/RFID resolvable URL to this DPP |
| `declarationOfConformity` | Annex I | CE/conformity declaration reference |

### Tier 2: Environmental / Sustainability Fields

| DPP Field | ESPR Article | Description |
|-----------|-------------|-------------|
| `carbonFootprint` | Art. 7(2)(b) | GWP in kg CO₂e (production + use + end-of-life) |
| `energyConsumption` | Art. 7(2)(c) | kWh consumed during manufacturing |
| `materialComposition` | Art. 7(2)(d) | List of materials, mass %, origin, recyclability |
| `recycledContent` | Art. 7(2)(e) | % recycled material by mass |
| `hazardousSubstances` | Art. 7(2)(f) | Substances of concern (SVHC list) |
| `endOfLifeInstructions` | Art. 7(2)(g) | Disassembly, recycling, disposal information |

### Tier 3: Repairability and Durability Fields

| DPP Field | ESPR Article | Description |
|-----------|-------------|-------------|
| `repairabilityScore` | Art. 7(2)(h) | Score 0–10 (EU Repair Index methodology) |
| `spareParts` | Art. 7(2)(i) | Availability of spare parts, supplier info |
| `repairManual` | Art. 7(2)(j) | Link to repair manual / service documentation |
| `expectedLifespan` | Art. 7(2)(k) | Design lifetime in years/cycles |
| `warrantyPeriod` | Art. 7(2)(l) | Minimum warranty period |

### Tier 4: Supply Chain / Traceability Fields

| DPP Field | ESPR Article | Description |
|-----------|-------------|-------------|
| `supplyChainActors` | Art. 9(2) | Manufacturers, processors, importers in chain |
| `substanceTraceability` | Art. 9(3) | Lot-level traceability for SVHC substances |
| `verificationProof` | Annex III | Cryptographic proof / third-party attestation |
| `complianceCertificates` | Art. 11 | Links to ISO/CE/other compliance certificates |

---

## PCC Evidence Event → DPP Field Mapping

### Events That Directly Satisfy DPP Requirements

| DPP Field | PCC Evidence Event Type | Payload Fields Used | Notes |
|-----------|------------------------|--------------------|----|
| `productId` | `batch_session_started` | `payload.batchId`, `payload.jobId` | Batch ID is the product instance identifier |
| `productionDate` | `execution_started` | `timestamp` | ISO 8601 — production start timestamp |
| `manufacturer` | `device_birth` | `source.kernelId`, `source.deviceId` | Kernel = manufacturing site operator |
| `countryOfOrigin` | `device_birth` | `payload.location` (if present) | Needs location enrichment in kernel config |
| `energyConsumption` | `power_profile_summary` | `payload.totalKwh`, `payload.durationMs` | Direct: kWh consumed during job |
| `carbonFootprint` | `power_profile_summary` | `payload.totalKwh` × grid carbon intensity | Derived: needs grid carbon intensity lookup |
| `verificationProof` | `tee_attestation` | `payload.attestationReport`, `hash` | Cryptographic proof of execution |
| `verificationProof` | `zk_proof_verified` | `payload.proofCid`, `payload.verifiedAt` | ZK proof as verifiable credential |
| `complianceCertificates` | `calibration_record` | `payload.calibrationId`, `payload.standard` | Instrument calibration = traceability cert |
| `materialComposition` | `gcode_loaded` | `payload.materials` (if present in G-code metadata) | Needs G-code metadata to include BOM |
| `qualityInspection` | `cv_inspection_result` | `payload.passRate`, `payload.defects` | Computer vision QC result |
| `processLog` | `execution_progress` | `payload.stepIndex`, `payload.parameters` | Process parameter traceability |
| `supplyChainActor` | `custody_handoff_initiated` | `source.deviceId`, `payload.handoffTo` | Chain of custody actors |
| `supplyChainActor` | `courier_delivery_confirmed` | `payload.courierId`, `payload.deliveredTo` | Delivery actor |
| `endOfLifeInstructions` | `method_loaded` | `payload.methodId` (links to CSD) | CSD contains disposal info if present |
| `productModel` | `sequence_started` | `payload.capabilityId`, `payload.csdUri` | Links to CSD = product type definition |

### DPP Fields PCC Does Not Yet Capture

| Missing DPP Field | Gap Description | Proposed Solution |
|------------------|-----------------|-------------------|
| `materialComposition` | G-code/job metadata rarely includes full BOM with material specs | New evidence event: `material_bill_declared` |
| `carbonFootprint` (full) | Only manufacturing energy is captured; supply chain + transport CO₂ missing | New event: `carbon_footprint_declared` with scope 1/2/3 |
| `recycledContent` | No current event captures % recycled material in feedstock | Field in `material_bill_declared` |
| `hazardousSubstances` | No SVHC substance tracking in current evidence | New event: `substance_declaration` |
| `repairabilityScore` | PCC doesn't assess product repairability | New event: `repairability_assessment` or CSD extension |
| `spareParts` | Not in scope for current evidence model | CSD extension field |
| `repairManual` | No link to repair documentation | CSD extension field |
| `expectedLifespan` | Not captured | CSD field |
| `warrantyPeriod` | Not captured | CSD field / contract field |
| `endOfLifeInstructions` | CSD may link to this but not systematically | CSD mandatory field |

---

## Proposed New Evidence Event Types for DPP

Add to `EvidenceEventType` in `packages/spec/src/types/evidence.ts`:

```typescript
// DPP-specific evidence events
| "material_bill_declared"     // BOM with material specs, recycled content, SVHC flags
| "carbon_footprint_declared"  // Scope 1/2/3 CO₂e with methodology reference
| "substance_declaration"      // SVHC/hazardous substance declaration per REACH Annex XIV
| "repairability_assessment"   // EU Repair Index score + scoring breakdown
| "dpp_generated"              // Record that a DPP was generated from this job's evidence
```

### Payload Schemas for New Events

**`material_bill_declared`**
```typescript
{
  materials: Array<{
    name: string;           // e.g. "PLA", "Aluminium 6061"
    massKg: number;         // mass of this material in the product
    massFraction: number;   // 0.0–1.0
    recycledFraction: number; // 0.0–1.0
    origin: string;         // ISO 3166-1 alpha-2 country of material origin
    svhcFlag: boolean;      // true if substance of very high concern (REACH)
    casNumber?: string;     // CAS registry number for substance tracking
  }>;
  totalMassKg: number;
  declaredBy: string;       // operator DID or kernel ID
  declarationStandard: "ESPR-2024/1781" | "IEC-62474";
}
```

**`carbon_footprint_declared`**
```typescript
{
  scope1KgCO2e: number;     // direct emissions (energy at site)
  scope2KgCO2e: number;     // indirect energy emissions (grid factor applied)
  scope3KgCO2e?: number;    // value chain emissions (optional initially)
  totalKgCO2e: number;
  gridCarbonIntensityGPerKwh: number;  // gCO₂e/kWh used for scope 2 calc
  gridCarbonSource: string; // e.g. "IEA-2025-DE" — grid factor source
  methodology: "GHG-Protocol" | "ISO-14067" | "PEF";
  energyKwh: number;        // from power_profile_summary
  declaredAt: string;       // ISO 8601
}
```

**`substance_declaration`**
```typescript
{
  substanceName: string;
  casNumber: string;
  ecNumber?: string;
  massConcentrationPpm: number;   // ppm in finished product
  isReachSvhc: boolean;
  isRoHSRestricted: boolean;
  exemption?: string;             // REACH exemption reference if applicable
  declarationBasis: "measured" | "supplier-declared" | "calculated";
}
```

**`repairability_assessment`**
```typescript
{
  score: number;            // 0.0–10.0 EU Repair Index scale
  dismantlability: number;  // sub-score
  availability: number;     // spare parts sub-score
  pricing: number;          // repair cost sub-score
  documentation: number;    // repair manual sub-score
  software: number;         // software/firmware update sub-score
  assessedBy: string;       // operator DID or third-party assessor
  methodology: "EU-Repair-Index-v1";
}
```

---

## `generateDPP(jobId)` Function — Code Sketch

```typescript
// packages/gateway/src/compliance/dpp-generator.ts

import type { DigitalProductPassport } from "@pcc/spec";
import type { ComplianceFacade } from "../facades/compliance.facade.js";
import { evidenceToDPP } from "@pcc/spec";

export async function generateDPP(
  jobId: string,
  facade: ComplianceFacade,
): Promise<DigitalProductPassport> {
  // 1. Load all evidence for this job
  const evidenceResult = await facade.getEvidenceForJob(jobId);
  if (!evidenceResult.success) {
    throw new Error(`Cannot generate DPP: ${evidenceResult.error.message}`);
  }

  // 2. Load all events from bundles (via ComplianceFacade)
  const allEvents = evidenceResult.data.flatMap((bundle) => bundle.events ?? []);

  // 3. Map evidence events to DPP partial
  const partial = evidenceToDPP(allEvents);

  // 4. Enrich with job metadata (capability CSD → productModel, kernelId → manufacturer)
  // ... load job from DB, load capability CSD, load kernel config ...

  // 5. Compute derived fields
  if (partial.carbonFootprint === undefined && partial.energyConsumptionKwh !== undefined) {
    // Derive scope 2 carbon from energy + default grid factor (0.233 kgCO₂e/kWh EU average)
    partial.carbonFootprint = {
      scope2KgCO2e: partial.energyConsumptionKwh * 0.233,
      totalKgCO2e: partial.energyConsumptionKwh * 0.233,
      methodology: "GHG-Protocol",
      gridCarbonIntensityGPerKwh: 233,
      gridCarbonSource: "IEA-2024-EU-average",
    };
  }

  // 6. Assemble full DPP
  return {
    ...partial,
    passportId: `urn:pcc:dpp:${jobId}`,
    issuer: "did:pcc:gateway",
    issuedAt: new Date().toISOString(),
    version: "1.0",
    status: "active",
    accessLink: `https://capability.network/dpp/${jobId}`,
  } as DigitalProductPassport;
}
```

---

## References

- [Digital Product Passport 2025–2030 Timeline and Compliance Guide](https://fluxy.one/post/digital-product-passport-dpp-eu-guide-2025-2030)
- [EC Publications: DPP Methodology under ESPR](https://op.europa.eu/en/publication-detail/-/publication/026fc51a-240d-11f1-8c3a-01aa75ed71a1/language-en)
- [GS1 Digital Product Passport Provisional Standard](https://www.gs1.org/standards/standards-emerging-regulations/DPP)
- [climatiq.io: Digital Product Passports Compliance Guide](https://www.climatiq.io/blog/digital-product-passports-what-you-need-to-know-to-be-ready-for-regulatory-compliance-in-2025)
- [CEN-CENELEC DPP Cooperation with OPC Foundation](https://www.cencenelec.eu/news-events/news/2026/brief-news/2026-02-24-opcf-liaison-agreement/)
- [circularise.com: DPPs Required by EU Legislation](https://www.circularise.com/blogs/dpps-required-by-eu-legislation-across-sectors)
- PCC internal: `ai/research/standards-landscape.md` §4.3
