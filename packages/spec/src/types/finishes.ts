/**
 * FinishSpec — canonical registry of surface finishes & post-processing
 * operations applicable to manufactured parts.
 *
 * Templates reference finishes by `id` so that:
 *   - Mil-spec callouts (MIL-A-8625, MIL-DTL-5541, AMS-2488/2482) live in
 *     ONE place; adding a new spec callout doesn't ripple to every template.
 *   - Process compatibility (a CNC turning template and a sheet-metal
 *     template both offer "anodize Type II" — same finish id, same spec
 *     callout, no duplication of meta).
 *   - Standard color enums (RAL, Pantone) are referenced by spec id, not
 *     re-inlined per template.
 *
 * Seed contains ~20 of the most common finishes observed across Xometry,
 * Protolabs, Fictiv, Hubs (manufacturing-capability-catalog-2026-05-23.md).
 *
 * Author: implementer-golf, 2026-05-23
 * Source catalog: ai/research/manufacturing-capability-catalog-2026-05-23.md
 */

import { z } from "zod";

// ── Finish category ──────────────────────────────────────────────────

export const FinishCategorySchema = z.enum([
  "as-fabricated",     // tool marks, edges-broken, no further finish
  "abrasive",          // bead blast, media tumble, sand blast
  "anodize",           // electrolytic anodic oxide on Al/Ti
  "plating",           // zinc, nickel, gold, silver, chromate
  "conversion-coating",// chem film, Alodine, passivation
  "paint-coating",     // powder coat, wet paint, e-coat
  "polish",            // mirror, brushed, electropolish
  "heat-treat",        // not strictly a finish, but a post-op
  "marking",           // laser-engrave, pad-print, silk-screen, hot stamp
  "texture",           // SPI/VDI/MoldTech mold textures
  "other",
] as const);
export type FinishCategory = z.infer<typeof FinishCategorySchema>;

// ── Process compatibility (open enum) ────────────────────────────────

export const FinishProcessSchema = z.enum([
  "cnc-3axis",
  "cnc-5axis",
  "cnc-turning",
  "cnc-swiss",
  "sheet-metal",
  "laser-cut",
  "injection-molding",
  "fdm",
  "sla",
  "sls",
  "mjf",
  "dmls",
  "die-casting",
  "urethane-casting",
  "metal-stamping",
]);
export type FinishProcess = z.infer<typeof FinishProcessSchema>;

// ── FinishSpec schema ────────────────────────────────────────────────

/**
 * Canonical record for a surface finish or post-process operation.
 *
 * Field reference:
 *   - id                         canonical, kebab-case ("anodize-type-ii")
 *   - displayName                human label ("Anodize Type II (Sulfuric)")
 *   - category                   bucket for filtering
 *   - applicableProcesses        process ids this finish can layer onto
 *   - colorOptions               for color-bearing finishes (anodize II
 *                                colors, powder coat RAL/Pantone)
 *   - mil_spec                   mil-spec/AMS/ASTM/MIL-DTL callout, if any
 *   - common_thickness_microns   typical deposit thickness (Type II ≈ 8 μm)
 *   - notes                      operator-facing nuance
 */
export const FinishSpecSchema = z.object({
  id: z
    .string()
    .min(2)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "id must be kebab-case lowercase"),
  displayName: z.string().min(1),
  category: FinishCategorySchema,
  applicableProcesses: z.array(FinishProcessSchema).min(1),
  colorOptions: z.array(z.string()).optional(),
  mil_spec: z.string().optional(),
  common_thickness_microns: z.number().positive().optional(),
  notes: z.string().optional(),
});
export type FinishSpec = z.infer<typeof FinishSpecSchema>;

// ── Seed registry ─────────────────────────────────────────────────────

/**
 * Seeded entries — the most common ~20 finishes across the 4 surveyed
 * platforms. Selection focuses on machining + sheet-metal + die-cast
 * finishes (highest cross-template re-use). Process-specific texture
 * codes (SPI A-1, VDI 18, MoldTech MT-11010) are seeded for use by the
 * injection-molding template.
 */
export const FINISH_SEED: readonly FinishSpec[] = [
  // ── As-fabricated ──
  {
    id: "as-machined",
    displayName: "As Machined (Ra 3.2 μm)",
    category: "as-fabricated",
    applicableProcesses: ["cnc-3axis", "cnc-5axis", "cnc-turning", "cnc-swiss"],
    notes: "Standard mill finish with visible tool marks.",
  },
  {
    id: "edges-broken",
    displayName: "Edges Broken (deburr)",
    category: "as-fabricated",
    applicableProcesses: [
      "cnc-3axis", "cnc-5axis", "cnc-turning", "cnc-swiss", "sheet-metal", "laser-cut",
    ],
    notes: "Sharp edges manually broken; no further finishing.",
  },

  // ── Abrasive ──
  {
    id: "bead-blast",
    displayName: "Bead Blast (uniform matte)",
    category: "abrasive",
    applicableProcesses: [
      "cnc-3axis", "cnc-5axis", "cnc-turning", "sheet-metal", "die-casting", "dmls", "mjf",
    ],
    notes: "Glass-bead blasted to a uniform matte surface.",
  },
  {
    id: "media-tumble",
    displayName: "Media Tumbling (deburr + light polish)",
    category: "abrasive",
    applicableProcesses: ["cnc-3axis", "cnc-turning", "sheet-metal", "die-casting", "sls", "mjf"],
  },
  {
    id: "sand-blast",
    displayName: "Sand Blast",
    category: "abrasive",
    applicableProcesses: ["sheet-metal", "die-casting", "cnc-3axis"],
  },

  // ── Anodize ──
  {
    id: "anodize-type-ii",
    displayName: "Anodize Type II (Sulfuric, MIL-A-8625)",
    category: "anodize",
    applicableProcesses: ["cnc-3axis", "cnc-5axis", "cnc-turning", "sheet-metal", "die-casting"],
    colorOptions: ["clear", "black", "red", "blue", "gold", "green"],
    mil_spec: "MIL-A-8625 Type II",
    common_thickness_microns: 8,
    notes: "Aluminum only. Decorative + corrosion resistance.",
  },
  {
    id: "anodize-type-iii",
    displayName: "Anodize Type III Hardcoat (MIL-A-8625)",
    category: "anodize",
    applicableProcesses: ["cnc-3axis", "cnc-5axis", "cnc-turning", "sheet-metal"],
    colorOptions: ["clear", "black"],
    mil_spec: "MIL-A-8625 Type III",
    common_thickness_microns: 50,
    notes: "Aluminum only. Thick, wear-resistant; dyed colors restricted.",
  },
  {
    id: "ti-anodize",
    displayName: "Titanium Anodize (AMS-2488 Type 2)",
    category: "anodize",
    applicableProcesses: ["cnc-3axis", "cnc-5axis", "cnc-turning"],
    colorOptions: ["blue", "purple", "gold", "rainbow"],
    mil_spec: "AMS-2488 Type 2",
    notes: "Titanium-only color anodize. Decorative.",
  },

  // ── Plating ──
  {
    id: "zinc-plate",
    displayName: "Zinc Plating (ASTM B633)",
    category: "plating",
    applicableProcesses: ["sheet-metal", "cnc-3axis", "cnc-turning", "metal-stamping"],
    colorOptions: ["clear", "yellow", "black"],
    mil_spec: "ASTM B633-15",
    common_thickness_microns: 8,
    notes: "Steel only. Corrosion barrier.",
  },
  {
    id: "electroless-nickel",
    displayName: "Electroless Nickel (MIL-C-26074)",
    category: "plating",
    applicableProcesses: ["sheet-metal", "cnc-3axis", "cnc-turning", "die-casting"],
    mil_spec: "MIL-C-26074",
    common_thickness_microns: 25,
    notes: "Uniform, hard, wear-resistant; works on most metals.",
  },
  {
    id: "gold-plate",
    displayName: "Gold Plating (MIL-G-45204, ASTM B488)",
    category: "plating",
    applicableProcesses: ["sheet-metal", "cnc-3axis", "cnc-turning"],
    mil_spec: "MIL-G-45204",
    common_thickness_microns: 1,
    notes: "Decorative or low-resistance contact surfaces.",
  },

  // ── Conversion coatings ──
  {
    id: "chromate-conversion",
    displayName: "Chromate Conversion (Chem Film, MIL-DTL-5541)",
    category: "conversion-coating",
    applicableProcesses: ["cnc-3axis", "cnc-5axis", "cnc-turning", "sheet-metal", "die-casting"],
    colorOptions: ["clear", "gold"],
    mil_spec: "MIL-DTL-5541",
    common_thickness_microns: 1,
    notes: "Aluminum corrosion barrier; aerospace standard.",
  },
  {
    id: "passivation",
    displayName: "Passivation (ASTM A967)",
    category: "conversion-coating",
    applicableProcesses: ["cnc-3axis", "cnc-5axis", "cnc-turning", "sheet-metal"],
    mil_spec: "ASTM A967 / AMS-QQ-P-35",
    notes: "Stainless steel only. Removes free iron; restores corrosion resistance.",
  },
  {
    id: "black-oxide",
    displayName: "Black Oxide",
    category: "conversion-coating",
    applicableProcesses: ["cnc-3axis", "cnc-turning", "sheet-metal"],
    notes: "Steel only. Decorative + mild corrosion barrier.",
  },

  // ── Paint / coating ──
  {
    id: "powder-coat",
    displayName: "Powder Coat (RAL/Pantone color)",
    category: "paint-coating",
    applicableProcesses: ["sheet-metal", "die-casting", "metal-stamping", "cnc-3axis"],
    colorOptions: [
      "RAL 9005 (Jet Black)", "RAL 9003 (Signal White)", "RAL 7035 (Light Grey)",
      "RAL 3020 (Traffic Red)", "RAL 5005 (Signal Blue)", "RAL 6005 (Moss Green)",
      "Custom (Pantone)",
    ],
    common_thickness_microns: 60,
    notes: "Specify RAL or Pantone code for color match.",
  },

  // ── Polish ──
  {
    id: "polish-mirror",
    displayName: "Polished Mirror (Ra 0.4 μm)",
    category: "polish",
    applicableProcesses: ["cnc-3axis", "cnc-5axis", "cnc-turning", "sheet-metal"],
    notes: "High labor cost; specify only where visual surface matters.",
  },
  {
    id: "brushed",
    displayName: "Brushed (Ra 1.2 μm, #4 finish)",
    category: "polish",
    applicableProcesses: ["sheet-metal", "cnc-3axis", "cnc-turning"],
    notes: "Decorative; common on stainless 304/316 architectural panels.",
  },
  {
    id: "electropolish",
    displayName: "Electropolish (ASTM B912)",
    category: "polish",
    applicableProcesses: ["cnc-3axis", "cnc-turning", "sheet-metal"],
    mil_spec: "ASTM B912-02",
    notes: "Stainless preferred. Medical / cleanroom surfaces.",
  },

  // ── Marking ──
  {
    id: "laser-engrave",
    displayName: "Laser Engrave (serialization / logo)",
    category: "marking",
    applicableProcesses: [
      "cnc-3axis", "cnc-turning", "sheet-metal", "injection-molding", "die-casting",
    ],
  },
  {
    id: "silk-screen",
    displayName: "Silk Screen Printing",
    category: "marking",
    applicableProcesses: ["sheet-metal", "injection-molding"],
  },

  // ── Injection-molding texture codes ──
  {
    id: "spi-a1",
    displayName: "SPI A-1 (#3 Diamond, mirror)",
    category: "texture",
    applicableProcesses: ["injection-molding"],
    notes: "Highest-cost cosmetic grade.",
  },
  {
    id: "spi-a2",
    displayName: "SPI A-2 (#6 Diamond)",
    category: "texture",
    applicableProcesses: ["injection-molding"],
  },
  {
    id: "spi-b1",
    displayName: "SPI B-1 (600 grit paper)",
    category: "texture",
    applicableProcesses: ["injection-molding"],
    notes: "Most common production grade.",
  },
  {
    id: "spi-c3",
    displayName: "SPI C-3 (320 grit stone)",
    category: "texture",
    applicableProcesses: ["injection-molding"],
  },
  {
    id: "spi-d2",
    displayName: "SPI D-2 (Dry blast #240)",
    category: "texture",
    applicableProcesses: ["injection-molding"],
  },
  {
    id: "vdi-27",
    displayName: "VDI 27 (Ra 1.6 μm)",
    category: "texture",
    applicableProcesses: ["injection-molding"],
    notes: "Common semi-matte mold texture.",
  },
  {
    id: "moldtech-mt11010",
    displayName: "MoldTech MT-11010 (light texture)",
    category: "texture",
    applicableProcesses: ["injection-molding"],
  },
  {
    id: "moldtech-mt11020",
    displayName: "MoldTech MT-11020 (medium texture)",
    category: "texture",
    applicableProcesses: ["injection-molding"],
  },
  {
    id: "moldtech-mt11030",
    displayName: "MoldTech MT-11030 (heavy texture)",
    category: "texture",
    applicableProcesses: ["injection-molding"],
  },
] as const;

// ── Registry helpers ─────────────────────────────────────────────────

const registry = new Map<string, FinishSpec>();

/** Register a FinishSpec. Throws on duplicate id. */
export function registerFinish(spec: FinishSpec): void {
  FinishSpecSchema.parse(spec);
  if (registry.has(spec.id)) {
    throw new Error(`FinishSpec id collision: "${spec.id}"`);
  }
  registry.set(spec.id, spec);
}

/** Lookup a FinishSpec by canonical id. */
export function getFinish(id: string): FinishSpec | undefined {
  return registry.get(id);
}

/** Return all registered FinishSpec entries. */
export function getAllFinishes(): FinishSpec[] {
  return [...registry.values()];
}

/** Return FinishSpec entries applicable to a given process. */
export function getFinishesForProcess(process: FinishProcess): FinishSpec[] {
  return [...registry.values()].filter((f) => f.applicableProcesses.includes(process));
}

// Self-register seeded entries.
for (const spec of FINISH_SEED) {
  registerFinish(spec);
}
