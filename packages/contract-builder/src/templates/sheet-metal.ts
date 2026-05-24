/**
 * Sheet Metal Fabrication capability template.
 *
 * Per the manufacturing capability catalog (2026-05-23, Section 6 Gap 2):
 * sheet metal is a multi-op family — cutting (laser / waterjet / punch) is
 * only one of many ops a sheet-metal house actually delivers. The template
 * surfaces:
 *
 *   - Multi-op selection: laser-cut, waterjet, punch, form/bend, weld,
 *     deburr, PEM hardware insert, tap. Operators select the ops that
 *     apply to their part; pricing accumulates per op.
 *   - Bend count + bend tier (simple, complex, hemming) as a number param
 *     plus per-bend pricing impact.
 *   - PEM hardware enum (nut / stud / standoff / rivet-nut).
 *   - Weld type enum (TIG / MIG / spot / robotic) with cert tag (AWS D1.1,
 *     AWS D17, MIL-STD-1595) for aerospace/defense use.
 *   - Finishes referenced from the canonical FinishSpec registry by id;
 *     options surfaced inline so the operator picks from the relevant
 *     subset (anodize requires aluminum, zinc-plate requires steel).
 *   - Tolerance enum (standard / tight).
 *   - Industry certifications via CertificationSpec id refs.
 *
 * The existing `laser-cut.ts` template stays in place for laser-only shops
 * that don't want to expose the full sheet-metal op surface. This template
 * is the FULL surface for shops that do.
 *
 * Source: ai/research/manufacturing-capability-catalog-2026-05-23.md §5.2.D
 *
 * Author: implementer-golf-2, 2026-05-23
 */

import type { CapabilityTemplate } from "@pcc/spec";

export const sheetMetalTemplate: CapabilityTemplate = {
  capabilityType: "sheet-metal",
  version: "1.0",
  name: "Sheet Metal Fabrication",
  description:
    "Multi-operation sheet metal: laser/waterjet/punch cutting, form/bend, weld, PEM hardware, finishing. Carries cert tags for aerospace (AS9100D), automotive (IATF 16949), and defense (ITAR / MIL-STD-810).",
  params: [
    // ── 1. Material (references MaterialSpec ids) ──
    {
      type: "enum",
      key: "material",
      label: "Material",
      description:
        "Sheet stock material. References the canonical MaterialSpec registry by id.",
      required: true,
      order: 1,
      group: "Material",
      options: [
        { value: "aluminum-5052-h32", label: "Aluminum 5052-H32", description: "Marine/architectural; weldable." },
        {
          value: "aluminum-6061-t6",
          label: "Aluminum 6061-T6",
          description: "General-purpose structural.",
          pricingImpact: { mode: "percent", value: "10", label: "+10% 6061" },
        },
        { value: "aluminum-3003-h14", label: "Aluminum 3003-H14", description: "Formable, food-grade." },
        {
          value: "stainless-304",
          label: "Stainless 304",
          description: "Food-grade, weldable.",
          pricingImpact: { mode: "percent", value: "30", label: "+30% SS304" },
        },
        {
          value: "stainless-316",
          label: "Stainless 316 (marine)",
          description: "Marine-grade, biocompatible (ISO 10993).",
          pricingImpact: { mode: "percent", value: "45", label: "+45% SS316" },
        },
        { value: "steel-1018", label: "Steel 1018 (cold rolled)", description: "Low carbon, machinable." },
        { value: "steel-a36", label: "Steel A36 (structural hot rolled)", description: "Weldable structural." },
        {
          value: "steel-galvanized",
          label: "A653 Galvanized Steel",
          description: "Zinc-coated; outdoor / HVAC.",
        },
        {
          value: "copper-110",
          label: "Copper C110",
          description: "Electrolytic tough pitch; conductive.",
          pricingImpact: { mode: "percent", value: "60", label: "+60% copper" },
        },
        {
          value: "brass-260",
          label: "Brass C260 (cartridge)",
          description: "Decorative; formable.",
          pricingImpact: { mode: "percent", value: "40", label: "+40% brass" },
        },
        {
          value: "titanium-grade-5",
          label: "Titanium Grade 5 (Ti-6Al-4V)",
          description: "Aerospace; biocompatible.",
          pricingImpact: { mode: "percent", value: "200", label: "+200% titanium" },
        },
      ],
    },

    // ── 2. Sheet stock thickness ──
    {
      type: "number",
      key: "thicknessMm",
      label: "Thickness",
      description: "Sheet stock thickness. Typical aerospace 0.5-3mm; structural up to 6.35mm.",
      required: true,
      order: 2,
      group: "Material",
      min: 0.5,
      max: 6.35,
      step: 0.1,
      unit: "mm",
      defaultValue: 1.5,
    },

    // ── 3. Part dimensions ──
    {
      type: "number",
      key: "partXmm",
      label: "Part Length",
      description: "Longest sheet dimension after cut/form.",
      required: true,
      order: 3,
      group: "Geometry",
      min: 10,
      max: 3050,
      step: 1,
      unit: "mm",
    },
    {
      type: "number",
      key: "partYmm",
      label: "Part Width",
      required: true,
      order: 4,
      group: "Geometry",
      min: 10,
      max: 1524,
      step: 1,
      unit: "mm",
    },

    // ── 4. Operations (multi-select) ──
    {
      type: "enum",
      key: "operations",
      label: "Operations",
      description: "Pick all ops that apply. Pricing accumulates per op.",
      required: true,
      order: 5,
      group: "Process",
      multi: true,
      options: [
        { value: "laser-cut", label: "Laser Cut", description: "Fiber laser; ≤12mm steel, ≤6mm aluminum." },
        {
          value: "waterjet",
          label: "Waterjet Cut",
          description: "Abrasive waterjet; no HAZ; up to 50mm.",
          pricingImpact: { mode: "percent", value: "15", label: "+15% waterjet" },
        },
        {
          value: "punch",
          label: "Punch (turret)",
          description: "CNC turret punch press; high-volume holes/forms.",
        },
        {
          value: "form-bend",
          label: "Form / Bend (press brake)",
          description: "CNC press-brake forming.",
          pricingImpact: { mode: "flat", value: "8.00", label: "+$8 setup per bend job" },
        },
        {
          value: "weld",
          label: "Weld",
          description: "TIG/MIG/spot/robotic — see weldType.",
          pricingImpact: { mode: "percent", value: "20", label: "+20% welding" },
        },
        {
          value: "deburr",
          label: "Deburr (edge break)",
          description: "Manual or wheel deburr.",
          pricingImpact: { mode: "flat", value: "3.00", label: "+$3 deburr" },
        },
        {
          value: "pem-insert",
          label: "PEM Hardware Insertion",
          description: "Press-in nuts/studs/standoffs — see pemHardware.",
          pricingImpact: { mode: "flat", value: "0.50", label: "+$0.50/insert" },
        },
        {
          value: "tap",
          label: "Tap (thread holes)",
          description: "Form-tap or cut-tap blind/through holes.",
          pricingImpact: { mode: "flat", value: "0.30", label: "+$0.30/tap" },
        },
      ],
    },

    // ── 5. Bend parameters ──
    {
      type: "number",
      key: "bendCount",
      label: "Bend Count",
      description: "Number of bends in the part.",
      required: false,
      order: 6,
      group: "Process",
      min: 0,
      max: 50,
      step: 1,
      defaultValue: 0,
      visibleWhen: { param: "operations", equals: "form-bend" },
    },
    {
      type: "enum",
      key: "bendTier",
      label: "Bend Complexity Tier",
      description: "Simple = 90° flange. Complex = hemming, joggling, multi-axis. Sharp-radius = ≤material thickness.",
      required: false,
      order: 7,
      group: "Process",
      defaultValue: "simple",
      visibleWhen: { param: "operations", equals: "form-bend" },
      options: [
        { value: "simple", label: "Simple (90° flange)" },
        {
          value: "complex",
          label: "Complex (multi-axis, joggle)",
          pricingImpact: { mode: "percent", value: "20", label: "+20% complex bends" },
        },
        {
          value: "hemming",
          label: "Hemming (rolled / closed edge)",
          pricingImpact: { mode: "percent", value: "30", label: "+30% hemming" },
        },
        {
          value: "sharp-radius",
          label: "Sharp Radius (≤material thickness)",
          pricingImpact: { mode: "percent", value: "25", label: "+25% sharp radius" },
        },
      ],
    },

    // ── 6. PEM hardware enum ──
    {
      type: "enum",
      key: "pemHardware",
      label: "PEM Hardware Type",
      description: "PEM = Penn Engineering manufactured. Press-fit fasteners.",
      required: false,
      order: 8,
      group: "Process",
      multi: true,
      visibleWhen: { param: "operations", equals: "pem-insert" },
      options: [
        { value: "pem-nut", label: "PEM Nut (S/SP/SS)" },
        { value: "pem-stud", label: "PEM Stud (FH/FHS/HFS)" },
        { value: "pem-standoff", label: "PEM Standoff (SO/SOS/BSO)" },
        { value: "pem-flush-nut", label: "PEM Flush-Mount Nut (LK)" },
        { value: "rivet-nut", label: "Rivet Nut (steel / stainless)" },
      ],
    },

    // ── 7. Weld type + cert ──
    {
      type: "enum",
      key: "weldType",
      label: "Weld Type",
      description: "Required when 'weld' is selected.",
      required: false,
      order: 9,
      group: "Process",
      defaultValue: "tig",
      visibleWhen: { param: "operations", equals: "weld" },
      options: [
        { value: "tig", label: "TIG (cosmetic, slow)" },
        {
          value: "mig",
          label: "MIG (production speed)",
          pricingImpact: { mode: "percent", value: "-15", label: "-15% MIG faster" },
        },
        {
          value: "spot",
          label: "Spot Welding",
          pricingImpact: { mode: "flat", value: "2.00", label: "+$2 spot weld" },
        },
        {
          value: "robotic",
          label: "Robotic Welding",
          pricingImpact: { mode: "percent", value: "-25", label: "-25% robotic at volume" },
        },
      ],
    },
    {
      type: "enum",
      key: "weldCert",
      label: "Weld Certification",
      description: "Welder qualification standard. Required for aerospace/defense.",
      required: false,
      order: 10,
      group: "Process",
      visibleWhen: { param: "operations", equals: "weld" },
      options: [
        { value: "none", label: "None (uncertified weld)" },
        {
          value: "aws-d1-1",
          label: "AWS D1.1 (Structural Steel)",
          pricingImpact: { mode: "percent", value: "10", label: "+10% AWS D1.1" },
        },
        {
          value: "aws-d17-1",
          label: "AWS D17.1 (Aerospace Fusion)",
          pricingImpact: { mode: "percent", value: "20", label: "+20% AWS D17.1" },
        },
        {
          value: "aws-d17-2",
          label: "AWS D17.2 (Aerospace Resistance)",
          pricingImpact: { mode: "percent", value: "20", label: "+20% AWS D17.2" },
        },
        {
          value: "mil-std-1595",
          label: "MIL-STD-1595 (Military Aircraft Welding)",
          pricingImpact: { mode: "percent", value: "25", label: "+25% MIL-STD-1595" },
        },
      ],
    },

    // ── 8. Surface finishes (FinishSpec refs) ──
    {
      type: "enum",
      key: "surfaceFinish",
      label: "Surface Finish",
      description:
        "References the canonical FinishSpec registry by id. Aluminum-only finishes (anodize) are restricted by constraint when material is non-aluminum.",
      required: false,
      order: 11,
      group: "Finish",
      multi: true,
      defaultValue: "edges-broken",
      options: [
        { value: "edges-broken", label: "Edges Broken (deburr only)" },
        {
          value: "bead-blast",
          label: "Bead Blast (uniform matte)",
          pricingImpact: { mode: "flat", value: "8.00", label: "+$8 bead blast" },
        },
        {
          value: "anodize-type-ii",
          label: "Anodize Type II (Al, MIL-A-8625)",
          pricingImpact: { mode: "flat", value: "20.00", label: "+$20 Type II" },
        },
        {
          value: "anodize-type-iii",
          label: "Anodize Type III Hardcoat (Al, MIL-A-8625)",
          pricingImpact: { mode: "flat", value: "30.00", label: "+$30 Type III" },
        },
        {
          value: "powder-coat",
          label: "Powder Coat (RAL/Pantone color)",
          pricingImpact: { mode: "flat", value: "15.00", label: "+$15 powder coat" },
        },
        {
          value: "zinc-plate",
          label: "Zinc Plating (steel, ASTM B633)",
          pricingImpact: { mode: "flat", value: "12.00", label: "+$12 zinc plate" },
        },
        {
          value: "chromate-conversion",
          label: "Chromate Conversion (Chem Film, MIL-DTL-5541)",
          pricingImpact: { mode: "flat", value: "15.00", label: "+$15 chem film" },
        },
        {
          value: "electroless-nickel",
          label: "Electroless Nickel (MIL-C-26074)",
          pricingImpact: { mode: "flat", value: "25.00", label: "+$25 EN plate" },
        },
        {
          value: "passivation",
          label: "Passivation (stainless, ASTM A967)",
          pricingImpact: { mode: "flat", value: "10.00", label: "+$10 passivation" },
        },
        {
          value: "brushed",
          label: "Brushed #4 Finish",
          pricingImpact: { mode: "flat", value: "8.00", label: "+$8 brushed" },
        },
        {
          value: "laser-engrave",
          label: "Laser Engrave (markings)",
          pricingImpact: { mode: "flat", value: "5.00", label: "+$5 laser engrave" },
        },
        {
          value: "silk-screen",
          label: "Silk Screen",
          pricingImpact: { mode: "flat", value: "10.00", label: "+$10 silk screen" },
        },
      ],
    },

    // ── 9. Tolerance ──
    {
      type: "enum",
      key: "tolerance",
      label: "Cut Tolerance",
      description: "Per-feature cut tolerance.",
      required: false,
      order: 12,
      group: "Quality",
      defaultValue: "standard",
      options: [
        { value: "standard", label: "Standard (±0.127mm / ±0.005in)" },
        {
          value: "tight",
          label: "Tight (±0.076mm / ±0.003in)",
          pricingImpact: { mode: "percent", value: "20", label: "+20% tight tolerance" },
        },
      ],
    },

    // ── 10. Certifications ──
    {
      type: "enum",
      key: "certifications",
      label: "Certifications Required",
      description: "References the canonical CertificationSpec registry by id.",
      required: false,
      order: 13,
      group: "Compliance",
      multi: true,
      options: [
        { value: "iso-9001", label: "ISO 9001:2015" },
        {
          value: "as9100d",
          label: "AS9100D (Aerospace)",
          pricingImpact: { mode: "percent", value: "15", label: "+15% AS9100D" },
        },
        {
          value: "iatf-16949",
          label: "IATF 16949 (Automotive)",
          pricingImpact: { mode: "percent", value: "20", label: "+20% IATF 16949" },
        },
        {
          value: "nadcap",
          label: "NADCAP (Special Processes)",
          pricingImpact: { mode: "percent", value: "20", label: "+20% NADCAP" },
        },
        {
          value: "itar",
          label: "ITAR Registered",
          pricingImpact: { mode: "percent", value: "30", label: "+30% ITAR" },
        },
        { value: "rohs", label: "RoHS" },
        { value: "reach", label: "REACH" },
      ],
    },

    // ── 11. Quantity ──
    {
      type: "number",
      key: "quantity",
      label: "Quantity",
      required: true,
      order: 14,
      group: "Order",
      min: 1,
      max: 10000,
      step: 1,
      defaultValue: 1,
    },
  ],

  constraints: [
    // Anodize (Type II/III) is aluminum-only.
    {
      when: {
        param: "material",
        in: [
          "stainless-304",
          "stainless-316",
          "steel-1018",
          "steel-a36",
          "steel-galvanized",
          "copper-110",
          "brass-260",
          "titanium-grade-5",
        ],
      },
      then: [{ param: "surfaceFinish", exclude: ["anodize-type-ii", "anodize-type-iii"] }],
    },
    // Zinc plating is steel-only.
    {
      when: {
        param: "material",
        in: [
          "aluminum-5052-h32",
          "aluminum-6061-t6",
          "aluminum-3003-h14",
          "stainless-304",
          "stainless-316",
          "copper-110",
          "brass-260",
          "titanium-grade-5",
        ],
      },
      then: [{ param: "surfaceFinish", exclude: ["zinc-plate"] }],
    },
    // Passivation is stainless-only.
    {
      when: {
        param: "material",
        in: [
          "aluminum-5052-h32",
          "aluminum-6061-t6",
          "aluminum-3003-h14",
          "steel-1018",
          "steel-a36",
          "steel-galvanized",
          "copper-110",
          "brass-260",
          "titanium-grade-5",
        ],
      },
      then: [{ param: "surfaceFinish", exclude: ["passivation"] }],
    },
    // Chromate conversion (chem film) is aluminum-only.
    {
      when: {
        param: "material",
        in: [
          "stainless-304",
          "stainless-316",
          "steel-1018",
          "steel-a36",
          "steel-galvanized",
          "copper-110",
          "brass-260",
          "titanium-grade-5",
        ],
      },
      then: [{ param: "surfaceFinish", exclude: ["chromate-conversion"] }],
    },
    // Laser cutting steel above 12mm not feasible; waterjet required.
    {
      when: { param: "thicknessMm", gt: 6 },
      then: [{ param: "operations", exclude: ["laser-cut"] }],
    },
  ],

  basePricingHints: {
    basePrice: "35.00",
    currency: "USDC",
    perUnitLabel: "per part",
  },
};
