/**
 * MaterialSpec — canonical registry of manufacturing materials.
 *
 * Each MaterialSpec is the single canonical record for a material grade
 * (e.g. Aluminum 6061-T6, Stainless 304, ABS, PEEK). Capability templates
 * reference materials by `id` rather than inlining string enums, so that:
 *
 *   1. Material properties (density, certifications, food-safe, biocompatible)
 *      stay in ONE place — adding a new cert or alias never requires touching
 *      every template that already references the material.
 *
 *   2. Cross-platform routing parity works. Each platform names the same
 *      grade differently (Xometry "Delrin" = Protolabs "Acetal Homopolymer"
 *      = Fictiv "Delrin (150)" = Hubs "POM Acetal Copolymer/Homopolymer").
 *      `platformAliases` lets the router collapse a Xometry quote and a Hubs
 *      quote to the same canonical material when comparing prices.
 *
 *   3. DFM constraints can derive bend radius, machinability class, or
 *      shrinkage from canonical properties instead of re-stating them per
 *      template.
 *
 * Seed contains ~50 of the most common grades observed across Xometry,
 * Protolabs, Fictiv, Hubs (manufacturing-capability-catalog-2026-05-23.md).
 * Tier 2 expansion (~150 total entries) is wave 2.
 *
 * Author: implementer-golf, 2026-05-23
 * Source catalog: ai/research/manufacturing-capability-catalog-2026-05-23.md
 */

import { z } from "zod";

// ── Material category ────────────────────────────────────────────────

export const MaterialCategorySchema = z.enum([
  "metal-aluminum",
  "metal-stainless-steel",
  "metal-carbon-steel",
  "metal-alloy-steel",
  "metal-tool-steel",
  "metal-titanium",
  "metal-brass",
  "metal-bronze",
  "metal-copper",
  "metal-nickel-alloy",
  "metal-cobalt-chrome",
  "metal-zinc",
  "metal-magnesium",
  "plastic-thermoplastic",
  "plastic-thermoset",
  "plastic-fluoropolymer",
  "plastic-engineering",
  "plastic-high-performance",
  "plastic-filled",
  "elastomer-thermoplastic",
  "elastomer-thermoset",
  "elastomer-silicone",
  "resin-photopolymer",
  "composite",
] as const);
export type MaterialCategory = z.infer<typeof MaterialCategorySchema>;

// ── Machinability class (CNC) ────────────────────────────────────────

export const MachinabilityClassSchema = z.enum([
  "easy",       // brass-360, aluminum-6061, delrin
  "moderate",   // aluminum-7075, mild steel
  "difficult",  // stainless steels, hardened tool steel
  "abrasive",   // titanium, inconel, PEEK CF
]);
export type MachinabilityClass = z.infer<typeof MachinabilityClassSchema>;

// ── Biocompatibility class (medical) ─────────────────────────────────

export const BiocompatibilityClassSchema = z.enum([
  "usp-class-vi",  // implant + long-term contact
  "iso-10993",     // medical device general
  "iso-13485",     // medical QMS bonded
  "fda-21cfr177",  // food-contact polymers
  "none",
]);
export type BiocompatibilityClass = z.infer<typeof BiocompatibilityClassSchema>;

// ── MaterialSpec schema ──────────────────────────────────────────────

/**
 * Canonical record for a material grade.
 *
 * Field reference:
 *   - id              canonical, kebab-case ("aluminum-6061-t6")
 *   - displayName     human label ("Aluminum 6061-T6")
 *   - category        family bucket for filtering/grouping
 *   - density_g_cm3   for material-cost math (volume × density × per-kg)
 *   - machinability_class  for CNC pricing modifier (abrasive = +cost)
 *   - food_safe       true iff FDA-compliant for food contact
 *   - biocompatible_class  medical / implant rating, if any
 *   - fda_compliant   broad FDA compliance flag
 *   - rohs            RoHS-compliant (EU electronics)
 *   - certifications  cert IDs (from CertificationSpec registry) the material
 *                     intrinsically satisfies (e.g. PEEK-USP-VI carries
 *                     "usp-class-vi" without the operator needing to apply
 *                     it separately)
 *   - platformAliases mapping of platform → that platform's display name,
 *                     used by the router to collapse quotes from different
 *                     vendors onto the same canonical material
 */
export const MaterialSpecSchema = z.object({
  id: z
    .string()
    .min(2)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "id must be kebab-case lowercase"),
  displayName: z.string().min(1),
  category: MaterialCategorySchema,
  density_g_cm3: z.number().positive().optional(),
  machinability_class: MachinabilityClassSchema.optional(),
  food_safe: z.boolean().optional(),
  biocompatible_class: BiocompatibilityClassSchema.optional(),
  fda_compliant: z.boolean().optional(),
  rohs: z.boolean().optional(),
  certifications: z.array(z.string()).default([]),
  /**
   * Cross-platform aliases. Keys are platform slugs ("xometry", "protolabs",
   * "fictiv", "hubs"); values are the human-facing label that platform uses.
   * Empty object permitted for materials only PCC names.
   */
  platformAliases: z.record(z.string(), z.string()).default({}),
});
export type MaterialSpec = z.infer<typeof MaterialSpecSchema>;

// ── Seed registry ─────────────────────────────────────────────────────

/**
 * Seeded entries — the most common ~50 grades across the 4 surveyed
 * platforms. Selection criteria: appears in at least 2 platforms OR is
 * the highest-frequency grade within its category. The remaining ~100
 * grades (full Hubs alloy catalog, brand-specific resin families)
 * land in wave 2.
 */
export const MATERIAL_SEED: readonly MaterialSpec[] = [
  // ── Aluminum (6 grades) ──
  {
    id: "aluminum-6061-t6",
    displayName: "Aluminum 6061-T6",
    category: "metal-aluminum",
    density_g_cm3: 2.70,
    machinability_class: "easy",
    rohs: true,
    certifications: [],
    platformAliases: {
      xometry: "Aluminum 6061",
      protolabs: "Aluminum 6061-T651",
      fictiv: "Aluminum 6061-T6",
      hubs: "Aluminum 6061-T651",
    },
  },
  {
    id: "aluminum-7075-t6",
    displayName: "Aluminum 7075-T6",
    category: "metal-aluminum",
    density_g_cm3: 2.81,
    machinability_class: "moderate",
    rohs: true,
    certifications: [],
    platformAliases: {
      xometry: "Aluminum 7075",
      protolabs: "Aluminum 7075-T651",
      fictiv: "Aluminum 7075-T6",
      hubs: "Aluminum 7075-T651",
    },
  },
  {
    id: "aluminum-2024",
    displayName: "Aluminum 2024 (aerospace)",
    category: "metal-aluminum",
    density_g_cm3: 2.78,
    machinability_class: "moderate",
    rohs: true,
    certifications: [],
    platformAliases: { xometry: "Aluminum 2024", fictiv: "Aluminum 2024" },
  },
  {
    id: "aluminum-5052-h32",
    displayName: "Aluminum 5052-H32",
    category: "metal-aluminum",
    density_g_cm3: 2.68,
    machinability_class: "easy",
    rohs: true,
    certifications: [],
    platformAliases: {
      xometry: "Aluminum 5052-H32",
      fictiv: "Aluminum 5052-H32",
      hubs: "Aluminum 5052",
    },
  },
  {
    id: "aluminum-mic6",
    displayName: "Aluminum MIC-6 (precision cast)",
    category: "metal-aluminum",
    density_g_cm3: 2.70,
    machinability_class: "easy",
    rohs: true,
    certifications: [],
    platformAliases: { xometry: "MIC-6", fictiv: "MIC6", hubs: "MIC6" },
  },
  {
    id: "aluminum-3003-h14",
    displayName: "Aluminum 3003-H14",
    category: "metal-aluminum",
    density_g_cm3: 2.73,
    machinability_class: "easy",
    rohs: true,
    certifications: [],
    platformAliases: { fictiv: "Aluminum 3003-H14" },
  },

  // ── Stainless Steel (5 grades) ──
  {
    id: "stainless-303",
    displayName: "Stainless 303 (free-machining)",
    category: "metal-stainless-steel",
    density_g_cm3: 8.00,
    machinability_class: "moderate",
    rohs: true,
    certifications: [],
    platformAliases: { xometry: "303", fictiv: "303", hubs: "303" },
  },
  {
    id: "stainless-304",
    displayName: "Stainless 304",
    category: "metal-stainless-steel",
    density_g_cm3: 8.00,
    machinability_class: "difficult",
    rohs: true,
    food_safe: true,
    certifications: [],
    platformAliases: {
      xometry: "304",
      fictiv: "304L",
      hubs: "304/304L",
    },
  },
  {
    id: "stainless-316",
    displayName: "Stainless 316 (marine)",
    category: "metal-stainless-steel",
    density_g_cm3: 8.00,
    machinability_class: "difficult",
    rohs: true,
    food_safe: true,
    biocompatible_class: "iso-10993",
    certifications: [],
    platformAliases: {
      xometry: "316/316L",
      fictiv: "316L",
      hubs: "316/316L",
    },
  },
  {
    id: "stainless-17-4-ph",
    displayName: "Stainless 17-4 PH (precipitation hardened)",
    category: "metal-stainless-steel",
    density_g_cm3: 7.80,
    machinability_class: "difficult",
    rohs: true,
    certifications: [],
    platformAliases: { xometry: "17-4", fictiv: "17-4PH", hubs: "17-4 PH" },
  },
  {
    id: "stainless-440c",
    displayName: "Stainless 440C (hardened bearing)",
    category: "metal-stainless-steel",
    density_g_cm3: 7.80,
    machinability_class: "difficult",
    rohs: true,
    certifications: [],
    platformAliases: { xometry: "440C", fictiv: "440C", hubs: "440C" },
  },

  // ── Carbon / Alloy / Tool Steel (5 grades) ──
  {
    id: "steel-1018",
    displayName: "Steel 1018 (low carbon)",
    category: "metal-carbon-steel",
    density_g_cm3: 7.87,
    machinability_class: "easy",
    rohs: true,
    certifications: [],
    platformAliases: {
      xometry: "1018",
      hubs: "1018",
    },
  },
  {
    id: "steel-4140",
    displayName: "Steel 4140 (chrome-moly alloy)",
    category: "metal-alloy-steel",
    density_g_cm3: 7.85,
    machinability_class: "moderate",
    rohs: true,
    certifications: [],
    platformAliases: {
      xometry: "4140",
      protolabs: "4140",
      fictiv: "4140",
      hubs: "4140",
    },
  },
  {
    id: "steel-4340",
    displayName: "Steel 4340 (high-strength alloy)",
    category: "metal-alloy-steel",
    density_g_cm3: 7.85,
    machinability_class: "moderate",
    rohs: true,
    certifications: [],
    platformAliases: { xometry: "4340", fictiv: "4340", hubs: "4340" },
  },
  {
    id: "steel-a36",
    displayName: "Steel A36 (structural)",
    category: "metal-carbon-steel",
    density_g_cm3: 7.85,
    machinability_class: "easy",
    rohs: true,
    certifications: [],
    platformAliases: { xometry: "A36", fictiv: "A36", hubs: "A36" },
  },
  {
    id: "steel-a2-tool",
    displayName: "A2 Tool Steel",
    category: "metal-tool-steel",
    density_g_cm3: 7.86,
    machinability_class: "difficult",
    rohs: true,
    certifications: [],
    platformAliases: { xometry: "A2 Tool", fictiv: "A2", hubs: "A2" },
  },

  // ── Titanium (2 grades) ──
  {
    id: "titanium-grade-2",
    displayName: "Titanium Grade 2 (commercially pure)",
    category: "metal-titanium",
    density_g_cm3: 4.51,
    machinability_class: "difficult",
    rohs: true,
    biocompatible_class: "iso-10993",
    certifications: [],
    platformAliases: { xometry: "Grade 2", hubs: "Grade 2" },
  },
  {
    id: "titanium-grade-5",
    displayName: "Titanium Grade 5 (Ti-6Al-4V)",
    category: "metal-titanium",
    density_g_cm3: 4.43,
    machinability_class: "abrasive",
    rohs: true,
    biocompatible_class: "iso-10993",
    certifications: [],
    platformAliases: {
      xometry: "Grade 5",
      fictiv: "Grade 5",
      hubs: "Grade 5",
      protolabs: "Ti-6Al-4V",
    },
  },

  // ── Brass / Bronze / Copper (5 grades) ──
  {
    id: "brass-360",
    displayName: "Brass C360 (free-machining)",
    category: "metal-brass",
    density_g_cm3: 8.50,
    machinability_class: "easy",
    rohs: false, // contains lead — RoHS-restricted in EU electronics
    certifications: [],
    platformAliases: { xometry: "Brass 360", fictiv: "Brass 360", hubs: "C360" },
  },
  {
    id: "brass-260",
    displayName: "Brass C260 (cartridge brass)",
    category: "metal-brass",
    density_g_cm3: 8.53,
    machinability_class: "moderate",
    rohs: true,
    certifications: [],
    platformAliases: {
      xometry: "260 brass",
      fictiv: "C260",
      hubs: "Cz121",
    },
  },
  {
    id: "copper-110",
    displayName: "Copper C110 (electrolytic tough pitch)",
    category: "metal-copper",
    density_g_cm3: 8.94,
    machinability_class: "easy",
    rohs: true,
    certifications: [],
    platformAliases: {
      xometry: "C110",
      fictiv: "C110",
      hubs: "C110",
    },
  },
  {
    id: "copper-101",
    displayName: "Copper C101 (oxygen-free)",
    category: "metal-copper",
    density_g_cm3: 8.94,
    machinability_class: "easy",
    rohs: true,
    certifications: [],
    platformAliases: { xometry: "101", fictiv: "C101", hubs: "C101" },
  },
  {
    id: "bronze-932",
    displayName: "Bronze C932 (bearing bronze)",
    category: "metal-bronze",
    density_g_cm3: 8.93,
    machinability_class: "easy",
    rohs: true,
    certifications: [],
    platformAliases: {
      xometry: "C932",
      fictiv: "Bronze 932",
      hubs: "Bearing 932",
    },
  },

  // ── Nickel alloys (1 grade) ──
  {
    id: "inconel-718",
    displayName: "Inconel 718 (nickel-chrome superalloy)",
    category: "metal-nickel-alloy",
    density_g_cm3: 8.19,
    machinability_class: "abrasive",
    rohs: true,
    certifications: [],
    platformAliases: { protolabs: "Inconel 718", hubs: "Inconel 718" },
  },

  // ── Zinc / Magnesium / Cobalt-Chrome (3 grades) ──
  {
    id: "zinc-zamak-3",
    displayName: "Zinc Zamak 3 (die casting)",
    category: "metal-zinc",
    density_g_cm3: 6.60,
    machinability_class: "easy",
    rohs: true,
    certifications: [],
    platformAliases: { xometry: "Zamak 3" },
  },
  {
    id: "magnesium-az91d",
    displayName: "Magnesium AZ91D (die casting)",
    category: "metal-magnesium",
    density_g_cm3: 1.81,
    machinability_class: "easy",
    rohs: true,
    certifications: [],
    platformAliases: { xometry: "Magnesium" },
  },
  {
    id: "cobalt-chrome",
    displayName: "Cobalt Chrome (medical/aerospace)",
    category: "metal-cobalt-chrome",
    density_g_cm3: 8.30,
    machinability_class: "abrasive",
    rohs: true,
    biocompatible_class: "iso-10993",
    certifications: [],
    platformAliases: { xometry: "Cobalt Chrome", protolabs: "Cobalt Chrome" },
  },

  // ── Thermoplastics — commodity (5) ──
  {
    id: "abs",
    displayName: "ABS",
    category: "plastic-thermoplastic",
    density_g_cm3: 1.04,
    machinability_class: "easy",
    rohs: true,
    certifications: [],
    platformAliases: {
      xometry: "ABS",
      protolabs: "ABS",
      fictiv: "ABS",
      hubs: "ABS",
    },
  },
  {
    id: "pp",
    displayName: "Polypropylene (PP)",
    category: "plastic-thermoplastic",
    density_g_cm3: 0.90,
    machinability_class: "easy",
    rohs: true,
    food_safe: true,
    certifications: [],
    platformAliases: { xometry: "Polypropylene", protolabs: "PP", fictiv: "PP", hubs: "PP" },
  },
  {
    id: "hdpe",
    displayName: "HDPE (High-Density Polyethylene)",
    category: "plastic-thermoplastic",
    density_g_cm3: 0.96,
    machinability_class: "easy",
    rohs: true,
    food_safe: true,
    certifications: [],
    platformAliases: { xometry: "HDPE", protolabs: "HDPE", fictiv: "HDPE", hubs: "HDPE" },
  },
  {
    id: "ldpe",
    displayName: "LDPE (Low-Density Polyethylene)",
    category: "plastic-thermoplastic",
    density_g_cm3: 0.92,
    machinability_class: "easy",
    rohs: true,
    food_safe: true,
    certifications: [],
    platformAliases: { xometry: "LDPE", protolabs: "LDPE" },
  },
  {
    id: "pvc-rigid",
    displayName: "PVC Rigid",
    category: "plastic-thermoplastic",
    density_g_cm3: 1.38,
    machinability_class: "easy",
    rohs: true,
    certifications: [],
    platformAliases: { xometry: "PVC (rigid)", protolabs: "PVC", fictiv: "PVC", hubs: "PVC" },
  },

  // ── Thermoplastics — engineering (7) ──
  {
    id: "pc",
    displayName: "Polycarbonate (PC)",
    category: "plastic-engineering",
    density_g_cm3: 1.20,
    machinability_class: "easy",
    rohs: true,
    certifications: [],
    platformAliases: {
      xometry: "PC",
      protolabs: "PC",
      fictiv: "PC",
      hubs: "PC",
    },
  },
  {
    id: "pmma-acrylic",
    displayName: "PMMA (Acrylic)",
    category: "plastic-engineering",
    density_g_cm3: 1.18,
    machinability_class: "easy",
    rohs: true,
    certifications: [],
    platformAliases: { xometry: "Acrylic", protolabs: "PMMA", fictiv: "Acrylic", hubs: "PMMA" },
  },
  {
    id: "pet",
    displayName: "PET",
    category: "plastic-engineering",
    density_g_cm3: 1.40,
    machinability_class: "easy",
    rohs: true,
    food_safe: true,
    certifications: [],
    platformAliases: { protolabs: "PET", fictiv: "PET", hubs: "PET" },
  },
  {
    id: "pbt",
    displayName: "PBT",
    category: "plastic-engineering",
    density_g_cm3: 1.31,
    machinability_class: "moderate",
    rohs: true,
    certifications: [],
    platformAliases: { xometry: "PBT", protolabs: "PBT", fictiv: "PBT" },
  },
  {
    id: "nylon-66",
    displayName: "Nylon 6/6 (PA66)",
    category: "plastic-engineering",
    density_g_cm3: 1.14,
    machinability_class: "moderate",
    rohs: true,
    certifications: [],
    platformAliases: {
      xometry: "Nylon 6/6",
      fictiv: "Nylon 6/6",
      hubs: "Nylon (PA 6/6 30% GF)",
    },
  },
  {
    id: "nylon-6",
    displayName: "Nylon 6 (PA6)",
    category: "plastic-engineering",
    density_g_cm3: 1.13,
    machinability_class: "moderate",
    rohs: true,
    certifications: [],
    platformAliases: { hubs: "PA6" },
  },
  {
    id: "pom-delrin",
    displayName: "POM / Acetal (Delrin)",
    category: "plastic-engineering",
    density_g_cm3: 1.41,
    machinability_class: "easy",
    rohs: true,
    food_safe: true,
    certifications: [],
    platformAliases: {
      xometry: "Delrin (Acetal)",
      protolabs: "Acetal (Copolymer, Homopolymer/Delrin)",
      fictiv: "Delrin 150",
      hubs: "POM/Delrin",
    },
  },

  // ── Thermoplastics — high-performance (4) ──
  {
    id: "peek",
    displayName: "PEEK",
    category: "plastic-high-performance",
    density_g_cm3: 1.32,
    machinability_class: "abrasive",
    rohs: true,
    biocompatible_class: "usp-class-vi",
    fda_compliant: true,
    certifications: ["usp-class-vi"],
    platformAliases: {
      xometry: "PEEK",
      protolabs: "PEEK",
      fictiv: "PEEK",
      hubs: "PEEK",
    },
  },
  {
    id: "pei-ultem",
    displayName: "PEI / Ultem 1000",
    category: "plastic-high-performance",
    density_g_cm3: 1.27,
    machinability_class: "difficult",
    rohs: true,
    certifications: [],
    platformAliases: {
      xometry: "ULTEM 1000",
      protolabs: "PEI",
      fictiv: "ULTEM",
      hubs: "PEI (Ultem 1000)",
    },
  },
  {
    id: "ppsu",
    displayName: "PPSU (Polyphenylsulfone)",
    category: "plastic-high-performance",
    density_g_cm3: 1.29,
    machinability_class: "moderate",
    rohs: true,
    certifications: [],
    platformAliases: {
      protolabs: "PPSU",
      fictiv: "PPSU",
      hubs: "PPSU",
    },
  },
  {
    id: "pps",
    displayName: "PPS (Polyphenylene Sulfide)",
    category: "plastic-high-performance",
    density_g_cm3: 1.35,
    machinability_class: "difficult",
    rohs: true,
    certifications: [],
    platformAliases: { fictiv: "PPS", hubs: "PPS" },
  },

  // ── Fluoropolymers (1) ──
  {
    id: "ptfe-teflon",
    displayName: "PTFE (Teflon)",
    category: "plastic-fluoropolymer",
    density_g_cm3: 2.20,
    machinability_class: "easy",
    rohs: true,
    food_safe: true,
    certifications: [],
    platformAliases: { xometry: "PTFE", protolabs: "PTFE", fictiv: "PTFE", hubs: "PTFE" },
  },

  // ── Filled plastics (1 highlight; more in wave 2) ──
  {
    id: "nylon-66-gf30",
    displayName: "Nylon 6/6 30% Glass-Filled",
    category: "plastic-filled",
    density_g_cm3: 1.37,
    machinability_class: "abrasive",
    rohs: true,
    certifications: [],
    platformAliases: { hubs: "PA 66 30% GF" },
  },

  // ── Elastomers (3) ──
  {
    id: "tpe",
    displayName: "TPE (Thermoplastic Elastomer)",
    category: "elastomer-thermoplastic",
    density_g_cm3: 0.92,
    rohs: true,
    certifications: [],
    platformAliases: { xometry: "TPE", protolabs: "TPE", fictiv: "TPE", hubs: "TPE" },
  },
  {
    id: "tpu",
    displayName: "TPU (Thermoplastic Polyurethane)",
    category: "elastomer-thermoplastic",
    density_g_cm3: 1.20,
    rohs: true,
    certifications: [],
    platformAliases: { xometry: "TPU", protolabs: "TPU", fictiv: "TPU", hubs: "TPU" },
  },
  {
    id: "lsr-silicone",
    displayName: "LSR (Liquid Silicone Rubber)",
    category: "elastomer-silicone",
    density_g_cm3: 1.15,
    biocompatible_class: "usp-class-vi",
    fda_compliant: true,
    food_safe: true,
    rohs: true,
    certifications: ["usp-class-vi", "fda-21cfr177"],
    platformAliases: {
      protolabs: "Liquid Silicone Rubber",
      fictiv: "Silicone (LSR)",
      hubs: "LSR Two-part thermoset",
    },
  },
] as const;

// ── Registry helpers ─────────────────────────────────────────────────

const registry = new Map<string, MaterialSpec>();

/** Register a MaterialSpec. Throws on duplicate id. */
export function registerMaterial(spec: MaterialSpec): void {
  // Validate before insert
  MaterialSpecSchema.parse(spec);
  if (registry.has(spec.id)) {
    throw new Error(`MaterialSpec id collision: "${spec.id}"`);
  }
  registry.set(spec.id, spec);
}

/** Lookup a MaterialSpec by canonical id. */
export function getMaterial(id: string): MaterialSpec | undefined {
  return registry.get(id);
}

/** Return all registered MaterialSpec entries. */
export function getAllMaterials(): MaterialSpec[] {
  return [...registry.values()];
}

/** Return all MaterialSpec entries in a category. */
export function getMaterialsByCategory(category: MaterialCategory): MaterialSpec[] {
  return [...registry.values()].filter((m) => m.category === category);
}

/**
 * Resolve a vendor's display name back to a canonical material id.
 * Returns the FIRST id whose platformAliases[platform] matches (case-insensitive,
 * trim). Returns undefined if no match found.
 */
export function resolvePlatformAlias(
  platform: string,
  vendorName: string,
): MaterialSpec | undefined {
  const platformKey = platform.toLowerCase().trim();
  const target = vendorName.toLowerCase().trim();
  for (const spec of registry.values()) {
    const alias = spec.platformAliases[platformKey];
    if (alias && alias.toLowerCase().trim() === target) return spec;
  }
  return undefined;
}

// Self-register seeded entries (sealed at module load).
for (const spec of MATERIAL_SEED) {
  registerMaterial(spec);
}
