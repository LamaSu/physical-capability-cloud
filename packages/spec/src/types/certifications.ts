/**
 * CertificationSpec — canonical registry of manufacturing certifications,
 * regulatory regimes, and quality-system standards a capability can satisfy.
 *
 * Each CertificationSpec is the single canonical record for one cert (e.g.
 * ISO 9001, AS9100D, USP Class VI, FDA 21 CFR Part 820). Templates and
 * MaterialSpec records reference certifications by `id` so that:
 *
 *   1. Governing-body language (TÜV / DEKRA / FDA / DDTC / NADCAP / SAE)
 *      lives in ONE place; updating an audit body name doesn't ripple to
 *      every template that surfaces the cert as an option.
 *
 *   2. Industry filtering works. A medical-device buyer searching for
 *      certified capabilities can filter on `industries: ["medical"]` and
 *      get a consistent set regardless of how each kernel listed itself.
 *
 *   3. Material-cert coupling is implicit. A MaterialSpec like PEEK that
 *      carries USP Class VI in `certifications: ["usp-class-vi"]` is
 *      surfaced as USP-Class-VI-eligible without the operator needing to
 *      re-declare the cert per capability instance.
 *
 *   4. `required_for_materials` documents the inverse: certs that ONLY make
 *      sense when paired with specific material classes (e.g. ISO 13485
 *      medical QMS coupled with implant-grade titanium / cobalt-chrome).
 *
 * Seed contains 11 of the most common certifications observed across
 * Xometry, Protolabs, Fictiv, Hubs catalogs plus the universal compliance
 * floor (RoHS / REACH / ITAR / NADCAP / MIL-STD-810) any aerospace,
 * medical, or defense buyer expects to see.
 *
 * Author: implementer-golf-2, 2026-05-23
 * Source catalog: ai/research/manufacturing-capability-catalog-2026-05-23.md
 */

import { z } from "zod";

// ── Industry tag (open enum for filtering) ───────────────────────────

export const IndustrySchema = z.enum([
  "aerospace",
  "automotive",
  "medical",
  "dental",
  "defense",
  "industrial",
  "consumer",
  "electronics",
  "energy",
  "food-beverage",
  "pharma",
  "biotech",
  "marine",
  "general",
] as const);
export type Industry = z.infer<typeof IndustrySchema>;

// ── CertificationSpec schema ─────────────────────────────────────────

/**
 * Canonical record for a manufacturing certification or regulatory regime.
 *
 * Field reference:
 *   - id                       canonical, kebab-case ("iso-9001")
 *   - displayName              human label ("ISO 9001:2015")
 *   - governingBody            audit/standards body name ("ISO", "FDA",
 *                              "SAE / Performance Review Institute")
 *   - industries               industries this cert is most relevant to
 *   - required_for_materials   if non-empty, this cert can only meaningfully
 *                              be claimed when the part is made from one of
 *                              the listed canonical material categories
 *                              (referenced by MaterialCategory id, not the
 *                              full material id, to avoid combinatorial
 *                              coupling)
 *   - notes                    operator-facing nuance: who audits, common
 *                              scope language, what a buyer typically asks
 *                              for as proof
 */
export const CertificationSpecSchema = z.object({
  id: z
    .string()
    .min(2)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "id must be kebab-case lowercase"),
  displayName: z.string().min(1),
  governingBody: z.string().min(1),
  industries: z.array(IndustrySchema).default([]),
  /**
   * Optional list of MaterialCategory ids (e.g. "metal-titanium",
   * "plastic-high-performance") for which this cert is typically claimed.
   * Empty array = cert is material-agnostic (applies regardless of
   * material).
   */
  required_for_materials: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type CertificationSpec = z.infer<typeof CertificationSpecSchema>;

// ── Seed registry ─────────────────────────────────────────────────────

/**
 * Seeded entries — 11 certifications observed in repeated cross-platform
 * catalog scans. Selection prioritized:
 *   - Generic QMS that every serious shop claims (ISO 9001)
 *   - Industry-specific QMS (AS9100D aerospace, ISO 13485 medical,
 *     IATF 16949 automotive)
 *   - Process-level audit (NADCAP for special processes — heat treat,
 *     coating, NDT, welding — commonly bundled with AS9100D)
 *   - Quality-of-manufacture process regulation (FDA 21 CFR Part 820
 *     medical device QSR)
 *   - Material-/contact-level certifications (USP Class VI biocompatible,
 *     food-contact via 21 CFR 177 — but the food-contact case is captured
 *     on MaterialSpec.food_safe rather than as a separate Cert id)
 *   - Universal substance compliance (RoHS, REACH)
 *   - Export-control regime (ITAR)
 *   - Defense environmental standard (MIL-STD-810)
 *
 * Tier 2 additions (deferred): UL 94 flame, IPC J-STD electronics,
 * ASME Section IX welding, ISO 14001 environmental, ISO 45001 H&S.
 */
export const CERTIFICATION_SEED: readonly CertificationSpec[] = [
  // ── Generic Quality Management Systems ──
  {
    id: "iso-9001",
    displayName: "ISO 9001:2015",
    governingBody: "International Organization for Standardization (ISO)",
    industries: ["general", "industrial", "aerospace", "automotive", "medical"],
    required_for_materials: [],
    notes:
      "Universal quality management system. Most contract manufacturers carry it; absence is a yellow flag.",
  },
  {
    id: "as9100d",
    displayName: "AS9100D (Aerospace QMS)",
    governingBody: "SAE International / IAQG",
    industries: ["aerospace", "defense"],
    required_for_materials: [],
    notes:
      "AS9100 Rev D supersedes Rev C. Audited annually by IAQG-recognized registrars. Often paired with NADCAP for special processes.",
  },
  {
    id: "iso-13485",
    displayName: "ISO 13485 (Medical Device QMS)",
    governingBody: "International Organization for Standardization (ISO)",
    industries: ["medical", "dental"],
    required_for_materials: [],
    notes:
      "Required for medical-device contract manufacturers. Buyers typically also expect FDA 21 CFR Part 820 if the device is sold in the US.",
  },
  {
    id: "iatf-16949",
    displayName: "IATF 16949 (Automotive QMS)",
    governingBody: "International Automotive Task Force",
    industries: ["automotive"],
    required_for_materials: [],
    notes:
      "Automotive-tier supplier QMS. PPAP submission required for production-part approval. Replaced ISO/TS 16949.",
  },

  // ── Process-level audits ──
  {
    id: "nadcap",
    displayName: "NADCAP (National Aerospace and Defense Contractors Accreditation Program)",
    governingBody: "SAE / Performance Review Institute (PRI)",
    industries: ["aerospace", "defense"],
    required_for_materials: [],
    notes:
      "Process-level accreditation: heat treat, NDT, surface enhancement, welding, coating. Customers typically require NADCAP scope-by-scope rather than a single cert.",
  },

  // ── Regulatory / device regulations ──
  {
    id: "fda-21-cfr-820",
    displayName: "FDA 21 CFR Part 820 (Quality System Regulation)",
    governingBody: "United States Food and Drug Administration (FDA)",
    industries: ["medical", "pharma"],
    required_for_materials: [],
    notes:
      "QSR for finished medical devices marketed in the US. Often claimed alongside ISO 13485 (the two regulations overlap substantially).",
  },

  // ── Biocompatibility / contact material ──
  {
    id: "usp-class-vi",
    displayName: "USP Class VI (Biocompatibility)",
    governingBody: "United States Pharmacopeia (USP)",
    industries: ["medical", "pharma", "dental"],
    required_for_materials: [
      "plastic-high-performance",
      "plastic-fluoropolymer",
      "elastomer-silicone",
      "metal-titanium",
      "metal-cobalt-chrome",
    ],
    notes:
      "Material-level: implant- and long-contact polymers/elastomers. PEEK, PTFE, LSR are commonly USP Class VI. Implantable metals (Ti, CoCr) typically claim ISO 10993 instead.",
  },

  // ── Substance / restriction regimes ──
  {
    id: "rohs",
    displayName: "RoHS (Restriction of Hazardous Substances)",
    governingBody: "European Union",
    industries: ["electronics", "consumer", "industrial"],
    required_for_materials: [],
    notes:
      "Restricts lead, mercury, cadmium, hex chrome, PBB, PBDE in electrical/electronic equipment sold in EU. Most contract manufacturers self-certify per Declaration of Conformity.",
  },
  {
    id: "reach",
    displayName: "REACH (Registration, Evaluation, Authorization, Restriction of Chemicals)",
    governingBody: "European Chemicals Agency (ECHA)",
    industries: ["electronics", "consumer", "industrial", "pharma"],
    required_for_materials: [],
    notes:
      "EU regulation covering ~224 SVHC chemicals. Article-level disclosure required >0.1% w/w. Often bundled with RoHS in supplier compliance statements.",
  },

  // ── Export control ──
  {
    id: "itar",
    displayName: "ITAR Registered (International Traffic in Arms Regulations)",
    governingBody: "US Directorate of Defense Trade Controls (DDTC)",
    industries: ["defense", "aerospace"],
    required_for_materials: [],
    notes:
      "Manufacturer must hold an active ITAR registration with DDTC. Required for defense articles on the US Munitions List. Buyer typically requires US-citizen-only handling.",
  },

  // ── Environmental / qualification ──
  {
    id: "mil-std-810",
    displayName: "MIL-STD-810 (Environmental Engineering)",
    governingBody: "US Department of Defense",
    industries: ["defense", "aerospace", "industrial"],
    required_for_materials: [],
    notes:
      "Environmental qualification: shock, vibration, temperature, humidity, salt fog, altitude. Tested per method-by-method; rarely a single 'pass'.",
  },
] as const;

// ── Registry helpers ─────────────────────────────────────────────────

const registry = new Map<string, CertificationSpec>();

/** Register a CertificationSpec. Throws on duplicate id. */
export function registerCertification(spec: CertificationSpec): void {
  CertificationSpecSchema.parse(spec);
  if (registry.has(spec.id)) {
    throw new Error(`CertificationSpec id collision: "${spec.id}"`);
  }
  registry.set(spec.id, spec);
}

/** Lookup a CertificationSpec by canonical id. */
export function getCertification(id: string): CertificationSpec | undefined {
  return registry.get(id);
}

/** Return all registered CertificationSpec entries. */
export function getAllCertifications(): CertificationSpec[] {
  return [...registry.values()];
}

/** Return CertificationSpec entries tagged with a given industry. */
export function getCertificationsForIndustry(industry: Industry): CertificationSpec[] {
  return [...registry.values()].filter((c) => c.industries.includes(industry));
}

// Self-register seeded entries (sealed at module load).
for (const spec of CERTIFICATION_SEED) {
  registerCertification(spec);
}
