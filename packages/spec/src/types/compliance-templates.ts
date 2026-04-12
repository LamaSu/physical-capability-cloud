/**
 * Compliance template types — configurable regulatory compliance
 * per industry, jurisdiction, and capability type.
 *
 * Inspired by OPA/Rego rule engine + OSCAL catalog format + EU DPP
 * EPCIS event model. Extends the existing ComplianceFacade (which
 * hardcodes ISO 9001 + FDA Part 11) to support any regulation.
 */

import type { Id, Timestamp, AssuranceTier } from "./common.js";
import type { EvidenceEventType } from "./evidence.js";

// ── Compliance Templates ─────────────────────────────────────────

/** Industry verticals for compliance */
export type IndustryVertical =
  | "manufacturing"    // ISO 9001, ISO 14001
  | "pharma"           // GxP, 21 CFR Part 11, EU Annex 11
  | "food"             // HACCP, FDA FSMA
  | "medical_devices"  // ISO 13485, FDA 21 CFR 820, EU MDR
  | "aerospace"        // AS9100, NADCAP
  | "automotive"       // IATF 16949
  | "electronics"      // IPC standards
  | "financial"        // SOX, PCI-DSS
  | "defense"          // ITAR, DFARS
  | "general"          // no specific industry
  | (string & {});

/** A compliance template — machine-readable regulatory requirements */
export interface ComplianceTemplate {
  id: Id;
  /** Regulation identifier (e.g., "ISO-9001:2015", "FDA-21CFR-Part11") */
  regulationId: string;
  /** Human-readable name */
  name: string;
  /** Description */
  description: string;
  /** Version (semver — regulations evolve) */
  version: string;
  /** Which industries this applies to */
  industries: IndustryVertical[];
  /** Which jurisdictions (ISO country codes, or "global") */
  jurisdictions: string[];
  /** Which capability types this is relevant for (empty = all) */
  applicableCapabilityTypes: string[];
  /** The actual compliance rules */
  rules: ComplianceRule[];
  /** Minimum assurance tier required */
  minimumAssuranceTier: AssuranceTier;
  /** Data retention period in days */
  retentionPeriodDays: number;
  /** Author */
  authorId?: Id;
  /** Status */
  status: "draft" | "active" | "superseded" | "archived";
  /** If superseded, what replaced it */
  supersededBy?: Id;
  /** Effective date */
  effectiveDate: Timestamp;
  /** Sunset date (if known) */
  sunsetDate?: Timestamp;
  /** Usage count */
  usageCount: number;
  /** Rating */
  rating?: number;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}

/** A single compliance rule within a template */
export interface ComplianceRule {
  /** Rule identifier (unique within template) */
  ruleId: string;
  /** Human-readable name */
  name: string;
  /** Description of the requirement */
  description: string;
  /** Severity if rule is violated */
  severity: "critical" | "high" | "medium" | "low" | "informational";
  /** What this rule checks */
  check: ComplianceCheck;
}

/** Types of compliance checks */
export type ComplianceCheck =
  | EvidenceRequirementCheck
  | RetentionCheck
  | CalibrationCheck
  | CertificationCheck
  | AuditTrailCheck
  | CustomCheck;

/** Check that specific evidence types are present */
export interface EvidenceRequirementCheck {
  type: "evidence_requirement";
  /** Required evidence event types (same OR-group logic as DEFAULT_TIER_REQUIREMENTS) */
  requiredEventTypes: EvidenceEventType[][];
  /** Minimum number of events */
  minimumEvents: number;
}

/** Check that data is retained for a minimum period */
export interface RetentionCheck {
  type: "retention";
  /** Minimum retention in days */
  minimumDays: number;
  /** What data must be retained */
  dataTypes: string[];
}

/** Check that equipment calibration is current */
export interface CalibrationCheck {
  type: "calibration";
  /** Maximum age of calibration in days */
  maxCalibrationAgeDays: number;
  /** Device types that require calibration */
  deviceTypes: string[];
}

/** Check that operator holds required certifications */
export interface CertificationCheck {
  type: "certification";
  /** Required certification names */
  requiredCertifications: string[];
}

/** Check that audit trail meets requirements */
export interface AuditTrailCheck {
  type: "audit_trail";
  /** Minimum audit events per job */
  minimumEventsPerJob: number;
  /** Whether hash chain is required */
  requireHashChain: boolean;
  /** Whether tamper-evidence is required */
  requireTamperEvidence: boolean;
}

/** Custom check — evaluated as a predicate expression */
export interface CustomCheck {
  type: "custom";
  /** Predicate expression (evaluated against job/evidence data) */
  predicate: string;
  /** Human-readable explanation of what the predicate checks */
  explanation: string;
}

// ── Compliance Profile (operator's selected templates) ───────────

/** An operator's compliance profile — which templates they follow */
export interface ComplianceProfile {
  id: Id;
  /** Operator/kernel ID */
  kernelId: Id;
  /** Selected compliance template IDs */
  templateIds: Id[];
  /** Industry vertical this operator declares */
  industry: IndustryVertical;
  /** Jurisdictions the operator operates in */
  jurisdictions: string[];
  /** Any operator-specific overrides (stricter only, can't relax rules) */
  overrides?: ComplianceOverride[];
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}

/** An operator override to a compliance rule (can only be stricter) */
export interface ComplianceOverride {
  templateId: Id;
  ruleId: string;
  /** The override — e.g., shorter retention, more evidence, etc. */
  override: Partial<ComplianceCheck>;
  /** Reason for the override */
  reason: string;
}

// ── Compliance Score ─────────────────────────────────────────────

/** Compliance score for a kernel per regulation */
export interface ComplianceScore {
  kernelId: Id;
  templateId: Id;
  regulationId: string;
  /** Overall compliance score (0-100) */
  score: number;
  /** Per-rule results */
  ruleResults: ComplianceRuleResult[];
  /** Number of rules passed / total */
  passed: number;
  total: number;
  /** When this score was computed */
  computedAt: Timestamp;
}

/** Result of checking a single compliance rule */
export interface ComplianceRuleResult {
  ruleId: string;
  ruleName: string;
  passed: boolean;
  severity: ComplianceRule["severity"];
  /** Details of what passed/failed */
  details: string;
}
