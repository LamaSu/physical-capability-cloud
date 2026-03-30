/**
 * Onboarding types — machine registration, documentation, and operator profiles.
 *
 * These types support the universal machine onboarding wizard, enabling
 * any machine of any complexity to be registered on the PCC network.
 */

import type { Id, Timestamp, Address, Amount, Currency } from "./common.js";
import type { CapabilityType, ToleranceSpec, WorkEnvelope } from "./capability.js";
import type { ParamDef } from "./contract-builder.js";

// ── Machine Registration ──

/** Machine registration submitted during onboarding */
export interface MachineRegistration {
  id: Id;
  name: string;
  category: CapabilityType;
  manufacturer: string;
  model: string;
  serialNumber?: string;
  description?: string;
  photos: string[];
  documents: OnboardingDocument[];
  capabilities: MachineCapabilityDef[];
  spaceRequirements: PhysicalSpaceRequirements;
  pricing: PricingConfig;
  operator: OperatorProfile;
  status: "draft" | "submitted" | "reviewing" | "approved" | "active" | "suspended" | "rejected";
  createdAt: Timestamp;
  submittedAt?: Timestamp;
  approvedAt?: Timestamp;
}

/** A capability definition for an onboarding machine */
export interface MachineCapabilityDef {
  id: Id;
  type: CapabilityType;
  name: string;
  description: string;
  materials: string[];
  tolerances?: ToleranceSpec;
  envelope?: WorkEnvelope;
  params: ParamDef[];
  source: "manual" | "ai-suggested";
}

// ── Document Analysis ──

/** Uploaded documentation for AI analysis */
export interface OnboardingDocument {
  id: Id;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  hash: string;
  uploadedAt: Timestamp;
  analysisStatus: "pending" | "analyzing" | "complete" | "failed";
  analysisResult?: DocumentAnalysisResult;
}

/** AI extraction result from processing a document */
export interface DocumentAnalysisResult {
  suggestedCapabilities: AISuggestedCapability[];
  extractedSpecs: Record<string, string>;
  extractedMaterials: string[];
  extractedTolerances: ToleranceSpec[];
  confidence: number;
  sourceDocumentId: Id;
}

/** AI-suggested capability from document analysis */
export interface AISuggestedCapability {
  id: Id;
  type: CapabilityType;
  name: string;
  description: string;
  materials: string[];
  tolerances?: ToleranceSpec;
  envelope?: WorkEnvelope;
  suggestedParams: ParamDef[];
  confidence: number;
  sourceReason: string;
}

// ── Physical Space Requirements ──

/** Physical space requirements for a machine */
export interface PhysicalSpaceRequirements {
  footprint: { width: number; depth: number; height: number; unit: "mm" | "in" | "ft" | "m" };
  clearances: { front: number; back: number; left: number; right: number; above: number; unit: "mm" | "in" | "ft" | "m" };
  weight: { value: number; unit: "kg" | "lb" };
  power: { voltage: number; amperage: number; phase: 1 | 3; frequency?: 50 | 60 };
  environmental: {
    tempRange?: { min: number; max: number; unit: "C" | "F" };
    humidityRange?: { min: number; max: number };
    ventilationRequired: boolean;
    dustExtraction: boolean;
    fumeExtraction: boolean;
    cleanRoomClass?: string;
  };
  utilities: {
    compressedAir: boolean;
    water: boolean;
    coolant: boolean;
    gasLines?: string[];
    wasteDrainage: boolean;
  };
  floorLoadCapacity?: { value: number; unit: "kg/m2" | "lb/ft2" };
  noiseLevel?: { value: number; unit: "dB" };
  vibrationIsolation: boolean;
  networkRequirements?: { ethernet: boolean; minBandwidth?: string; maxLatency?: string };
}

// ── Operator Profile ──

/** Operator profile with certifications */
export interface OperatorProfile {
  walletAddress: Address;
  displayName: string;
  certifications: OperatorCertification[];
  trainingAcknowledgments: Record<string, boolean>;
  insurance?: { provider: string; policyNumber: string; coverageAmount: Amount };
}

/** Operator certification record */
export interface OperatorCertification {
  id: Id;
  name: string;
  issuer: string;
  issuedAt: Timestamp;
  expiresAt: Timestamp;
  documentHash?: string;
  status: "valid" | "expiring" | "expired";
}

// ── Pricing ──

/** Pricing configuration for a machine */
export interface PricingConfig {
  baseCost: Amount;
  perMinute?: Amount;
  perGram?: Amount;
  perCm3?: Amount;
  minimum: Amount;
  currency: Currency;
}
