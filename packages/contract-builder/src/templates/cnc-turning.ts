/**
 * CNC Turning (Lathe) capability template.
 *
 * Per the manufacturing capability catalog (2026-05-23, Section 5.2.A and
 * Section 6 Gap 3): CNC turning is a distinct capability from 3-axis
 * milling — different envelope (cylindrical not box), different feature
 * vocabulary (OD/ID threads, grooves, knurls, profile cuts), different
 * tolerances. Separate template prevents the configurator from offering
 * milling-only ops (pocketing, slotting) for turned parts.
 *
 *   - Cylindrical material catalog (round stock only — no sheet, no plate).
 *   - OD (outer diameter) + length envelope. Wall-thickness optional for
 *     tube turning.
 *   - OD/ID threading as a structured enum (UNC/UNF inch + ISO metric),
 *     not bare booleans.
 *   - Max-diameter envelope enforced via numeric `max` + a profile-class
 *     enum signalling "fits inside a 1in/2in/4in chuck etc".
 *   - Tolerance class (standard / fine / precision) — distinct from
 *     milling tolerances (turning routinely hits ±0.0005in on a Swiss).
 *   - Profile candidate enum (straight / taper / contour / threaded /
 *     grooved / knurled).
 *   - Finishes by FinishSpec id with material-restricted constraints.
 *
 * Source: ai/research/manufacturing-capability-catalog-2026-05-23.md §5.2.A
 *
 * Author: implementer-golf-2, 2026-05-23
 */

import type { CapabilityTemplate } from "@pcc/spec";

export const cncTurningTemplate: CapabilityTemplate = {
  capabilityType: "cnc-turning",
  version: "1.0",
  name: "CNC Turning (Lathe)",
  description:
    "Subtractive turning of cylindrical stock — metals and plastics. OD/ID threading, taper/contour profiles, fine tolerances. Distinct from 3-axis milling (envelope is cylindrical, not box).",
  params: [
    // ── 1. Material (cylindrical stock; MaterialSpec ids) ──
    {
      type: "enum",
      key: "material",
      label: "Material",
      description:
        "Round-stock material. References the canonical MaterialSpec registry by id. Subset of full registry — only grades commonly available as bar stock.",
      required: true,
      order: 1,
      group: "Material",
      options: [
        { value: "aluminum-6061-t6", label: "Aluminum 6061-T6", description: "General-purpose, easy turning." },
        {
          value: "aluminum-7075-t6",
          label: "Aluminum 7075-T6",
          description: "Aerospace, higher strength.",
          pricingImpact: { mode: "percent", value: "15", label: "+15% 7075" },
        },
        { value: "aluminum-2024", label: "Aluminum 2024", description: "Aerospace; weldable issues." },
        {
          value: "stainless-303",
          label: "Stainless 303 (free-machining)",
          description: "Best machinability of stainlesses.",
          pricingImpact: { mode: "percent", value: "30", label: "+30% SS303" },
        },
        {
          value: "stainless-304",
          label: "Stainless 304",
          description: "Food-grade; work-hardens.",
          pricingImpact: { mode: "percent", value: "40", label: "+40% SS304" },
        },
        {
          value: "stainless-316",
          label: "Stainless 316 (marine)",
          description: "Marine; biocompatible.",
          pricingImpact: { mode: "percent", value: "50", label: "+50% SS316" },
        },
        {
          value: "stainless-17-4-ph",
          label: "Stainless 17-4 PH",
          description: "Precipitation-hardened.",
          pricingImpact: { mode: "percent", value: "55", label: "+55% 17-4 PH" },
        },
        { value: "steel-1018", label: "Steel 1018 (low carbon)", description: "Easy turning, low cost." },
        {
          value: "steel-4140",
          label: "Steel 4140 (chrome-moly)",
          description: "Heat-treatable; shafts/spindles.",
          pricingImpact: { mode: "percent", value: "35", label: "+35% 4140" },
        },
        { value: "brass-360", label: "Brass C360 (free-machining)", description: "Decorative; valve bodies." },
        {
          value: "copper-110",
          label: "Copper C110",
          description: "Electrolytic tough pitch.",
          pricingImpact: { mode: "percent", value: "25", label: "+25% copper" },
        },
        {
          value: "titanium-grade-5",
          label: "Titanium Grade 5 (Ti-6Al-4V)",
          description: "Aerospace; abrasive on tools.",
          pricingImpact: { mode: "percent", value: "150", label: "+150% titanium" },
        },
        { value: "pom-delrin", label: "Delrin (POM/Acetal)", description: "Self-lubricating; gears." },
        { value: "nylon-6", label: "Nylon 6", description: "Bushings, rollers." },
        {
          value: "peek",
          label: "PEEK",
          description: "High-temp; medical/aerospace.",
          pricingImpact: { mode: "percent", value: "100", label: "+100% PEEK" },
        },
        { value: "ptfe-teflon", label: "PTFE (Teflon)", description: "Chemical seals." },
      ],
    },

    // ── 2. Outer diameter ──
    {
      type: "number",
      key: "outerDiameterMm",
      label: "Outer Diameter",
      description:
        "OD of the round stock / largest turned feature. Drives chuck-class constraint.",
      required: true,
      order: 2,
      group: "Geometry",
      min: 4,
      max: 431,
      step: 0.1,
      unit: "mm",
    },

    // ── 3. Part length ──
    {
      type: "number",
      key: "lengthMm",
      label: "Length",
      description: "Overall part length along the spindle axis.",
      required: true,
      order: 3,
      group: "Geometry",
      min: 1.27,
      max: 990,
      step: 0.1,
      unit: "mm",
    },

    // ── 4. Wall thickness (tube turning) ──
    {
      type: "number",
      key: "wallThicknessMm",
      label: "Min Wall Thickness",
      description: "For hollow / tube parts; min wall after boring.",
      required: false,
      order: 4,
      group: "Geometry",
      min: 0.5,
      max: 50,
      step: 0.1,
      unit: "mm",
      defaultValue: 1.0,
    },

    // ── 5. Chuck-class envelope (max-diameter signal) ──
    {
      type: "enum",
      key: "chuckClass",
      label: "Chuck / Stock Class",
      description:
        "Approximate envelope class. Drives which lathe family is appropriate.",
      required: true,
      order: 5,
      group: "Geometry",
      defaultValue: "standard-3in",
      options: [
        { value: "swiss-32mm", label: "Swiss bar (≤32mm OD)" },
        { value: "small-1in", label: "Small lathe (≤25mm/1in)" },
        { value: "standard-3in", label: "Standard lathe (≤76mm/3in)" },
        {
          value: "large-8in",
          label: "Large lathe (≤200mm/8in)",
          pricingImpact: { mode: "percent", value: "20", label: "+20% large chuck setup" },
        },
        {
          value: "vtl-17in",
          label: "Vertical turning lathe (≤431mm/17in)",
          pricingImpact: { mode: "percent", value: "60", label: "+60% VTL setup" },
        },
      ],
    },

    // ── 6. Profile / feature candidates ──
    {
      type: "enum",
      key: "profileFeatures",
      label: "Profile Features",
      description: "Pick all turning features the part requires.",
      required: false,
      order: 6,
      group: "Features",
      multi: true,
      options: [
        { value: "straight", label: "Straight OD/ID" },
        {
          value: "taper",
          label: "Taper",
          pricingImpact: { mode: "flat", value: "5.00", label: "+$5 taper setup" },
        },
        {
          value: "contour",
          label: "Contour (curved profile)",
          pricingImpact: { mode: "flat", value: "8.00", label: "+$8 contour profile" },
        },
        {
          value: "groove",
          label: "Groove (O-ring / retaining)",
          pricingImpact: { mode: "flat", value: "3.00", label: "+$3/groove" },
        },
        {
          value: "knurl",
          label: "Knurl (diamond / straight)",
          pricingImpact: { mode: "flat", value: "6.00", label: "+$6 knurl" },
        },
        {
          value: "face",
          label: "Face (end-cut perpendicular)",
        },
        {
          value: "bore",
          label: "Bore (ID feature)",
          pricingImpact: { mode: "flat", value: "10.00", label: "+$10 bore" },
        },
      ],
    },

    // ── 7. OD threading ──
    {
      type: "enum",
      key: "threadingOD",
      label: "OD Threading",
      description: "External thread cut on the OD.",
      required: false,
      order: 7,
      group: "Features",
      defaultValue: "none",
      options: [
        { value: "none", label: "None" },
        {
          value: "unc",
          label: "UNC (Unified Coarse, inch)",
          pricingImpact: { mode: "flat", value: "8.00", label: "+$8 OD UNC thread" },
        },
        {
          value: "unf",
          label: "UNF (Unified Fine, inch)",
          pricingImpact: { mode: "flat", value: "10.00", label: "+$10 OD UNF thread" },
        },
        {
          value: "iso-m",
          label: "ISO Metric (coarse)",
          pricingImpact: { mode: "flat", value: "8.00", label: "+$8 OD M-thread" },
        },
        {
          value: "iso-mf",
          label: "ISO Metric Fine",
          pricingImpact: { mode: "flat", value: "10.00", label: "+$10 OD MF-thread" },
        },
        {
          value: "npt",
          label: "NPT (National Pipe Taper)",
          pricingImpact: { mode: "flat", value: "12.00", label: "+$12 NPT taper" },
        },
        {
          value: "bsp",
          label: "BSP (British Standard Pipe)",
          pricingImpact: { mode: "flat", value: "12.00", label: "+$12 BSP" },
        },
        {
          value: "acme",
          label: "Acme (power transmission)",
          pricingImpact: { mode: "flat", value: "15.00", label: "+$15 Acme" },
        },
      ],
    },

    // ── 8. ID threading ──
    {
      type: "enum",
      key: "threadingID",
      label: "ID Threading",
      description: "Internal thread cut on the bore.",
      required: false,
      order: 8,
      group: "Features",
      defaultValue: "none",
      options: [
        { value: "none", label: "None" },
        {
          value: "unc",
          label: "UNC (Unified Coarse, inch)",
          pricingImpact: { mode: "flat", value: "10.00", label: "+$10 ID UNC tap" },
        },
        {
          value: "unf",
          label: "UNF (Unified Fine, inch)",
          pricingImpact: { mode: "flat", value: "12.00", label: "+$12 ID UNF tap" },
        },
        {
          value: "iso-m",
          label: "ISO Metric (coarse)",
          pricingImpact: { mode: "flat", value: "10.00", label: "+$10 ID M-tap" },
        },
        {
          value: "iso-mf",
          label: "ISO Metric Fine",
          pricingImpact: { mode: "flat", value: "12.00", label: "+$12 ID MF-tap" },
        },
        {
          value: "npt",
          label: "NPT (National Pipe Taper)",
          pricingImpact: { mode: "flat", value: "15.00", label: "+$15 ID NPT" },
        },
      ],
    },

    // ── 9. Tolerance class ──
    {
      type: "enum",
      key: "toleranceClass",
      label: "Tolerance Class",
      description:
        "Standard = ±0.005in / ±0.13mm. Fine = ±0.002in / ±0.05mm. Precision = ±0.001in / ±0.025mm. Anything tighter requires Swiss-type.",
      required: true,
      order: 9,
      group: "Quality",
      defaultValue: "standard",
      options: [
        { value: "standard", label: "Standard (±0.005in / ±0.13mm)" },
        {
          value: "fine",
          label: "Fine (±0.002in / ±0.05mm)",
          pricingImpact: { mode: "percent", value: "25", label: "+25% fine tolerance" },
        },
        {
          value: "precision",
          label: "Precision (±0.001in / ±0.025mm)",
          pricingImpact: { mode: "percent", value: "50", label: "+50% precision tolerance" },
        },
      ],
    },

    // ── 10. Surface finish (FinishSpec ids) ──
    {
      type: "enum",
      key: "surfaceFinish",
      label: "Surface Finish",
      description: "References the canonical FinishSpec registry by id.",
      required: false,
      order: 10,
      group: "Finish",
      defaultValue: "as-machined",
      options: [
        { value: "as-machined", label: "As Machined (Ra 3.2 μm)" },
        {
          value: "edges-broken",
          label: "Edges Broken + Light Bead Blast",
          pricingImpact: { mode: "flat", value: "5.00", label: "+$5 edge break" },
        },
        {
          value: "bead-blast",
          label: "Bead Blast (uniform matte)",
          pricingImpact: { mode: "flat", value: "8.00", label: "+$8 bead blast" },
        },
        {
          value: "media-tumble",
          label: "Media Tumble",
          pricingImpact: { mode: "flat", value: "10.00", label: "+$10 tumble" },
        },
        {
          value: "anodize-type-ii",
          label: "Anodize Type II (Al, MIL-A-8625)",
          pricingImpact: { mode: "flat", value: "20.00", label: "+$20 Type II" },
        },
        {
          value: "anodize-type-iii",
          label: "Anodize Type III Hardcoat (Al)",
          pricingImpact: { mode: "flat", value: "30.00", label: "+$30 Type III" },
        },
        {
          value: "chromate-conversion",
          label: "Chromate Conversion (Al, MIL-DTL-5541)",
          pricingImpact: { mode: "flat", value: "15.00", label: "+$15 chem film" },
        },
        {
          value: "ti-anodize",
          label: "Titanium Anodize (AMS-2488)",
          pricingImpact: { mode: "flat", value: "25.00", label: "+$25 Ti anodize" },
        },
        {
          value: "passivation",
          label: "Passivation (stainless, ASTM A967)",
          pricingImpact: { mode: "flat", value: "10.00", label: "+$10 passivation" },
        },
        {
          value: "polish-mirror",
          label: "Polished Mirror (Ra 0.4 μm)",
          pricingImpact: { mode: "percent", value: "25", label: "+25% mirror" },
        },
        {
          value: "electroless-nickel",
          label: "Electroless Nickel (MIL-C-26074)",
          pricingImpact: { mode: "flat", value: "25.00", label: "+$25 EN plate" },
        },
        {
          value: "laser-engrave",
          label: "Laser Engrave",
          pricingImpact: { mode: "flat", value: "5.00", label: "+$5 laser engrave" },
        },
      ],
    },

    // ── 11. Certifications ──
    {
      type: "enum",
      key: "certifications",
      label: "Certifications Required",
      description: "References the canonical CertificationSpec registry by id.",
      required: false,
      order: 11,
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
          value: "iso-13485",
          label: "ISO 13485 (Medical)",
          pricingImpact: { mode: "percent", value: "25", label: "+25% ISO 13485" },
        },
        {
          value: "iatf-16949",
          label: "IATF 16949 (Automotive)",
          pricingImpact: { mode: "percent", value: "20", label: "+20% IATF 16949" },
        },
        {
          value: "nadcap",
          label: "NADCAP",
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

    // ── 12. Quantity ──
    {
      type: "number",
      key: "quantity",
      label: "Quantity",
      required: true,
      order: 12,
      group: "Order",
      min: 1,
      max: 10000,
      step: 1,
      defaultValue: 1,
    },
  ],

  constraints: [
    // Anodize Type II/III is aluminum-only.
    {
      when: {
        param: "material",
        in: [
          "stainless-303",
          "stainless-304",
          "stainless-316",
          "stainless-17-4-ph",
          "steel-1018",
          "steel-4140",
          "brass-360",
          "copper-110",
          "titanium-grade-5",
          "pom-delrin",
          "nylon-6",
          "peek",
          "ptfe-teflon",
        ],
      },
      then: [{ param: "surfaceFinish", exclude: ["anodize-type-ii", "anodize-type-iii", "chromate-conversion"] }],
    },
    // Ti anodize is titanium-only.
    {
      when: {
        param: "material",
        in: [
          "aluminum-6061-t6",
          "aluminum-7075-t6",
          "aluminum-2024",
          "stainless-303",
          "stainless-304",
          "stainless-316",
          "stainless-17-4-ph",
          "steel-1018",
          "steel-4140",
          "brass-360",
          "copper-110",
          "pom-delrin",
          "nylon-6",
          "peek",
          "ptfe-teflon",
        ],
      },
      then: [{ param: "surfaceFinish", exclude: ["ti-anodize"] }],
    },
    // Passivation is stainless-only.
    {
      when: {
        param: "material",
        in: [
          "aluminum-6061-t6",
          "aluminum-7075-t6",
          "aluminum-2024",
          "steel-1018",
          "steel-4140",
          "brass-360",
          "copper-110",
          "titanium-grade-5",
          "pom-delrin",
          "nylon-6",
          "peek",
          "ptfe-teflon",
        ],
      },
      then: [{ param: "surfaceFinish", exclude: ["passivation"] }],
    },
    // Plastics use light or no finish — surface treatments don't apply.
    {
      when: { param: "material", in: ["pom-delrin", "nylon-6", "peek", "ptfe-teflon"] },
      then: [
        {
          param: "surfaceFinish",
          restrictTo: ["as-machined", "edges-broken", "polish-mirror", "laser-engrave"],
        },
      ],
    },
    // Precision tolerance requires Swiss or large-shop precision lathe.
    {
      when: { param: "toleranceClass", equals: "precision" },
      then: [{ param: "chuckClass", restrictTo: ["swiss-32mm", "small-1in", "standard-3in"] }],
    },
    // Large parts (≥200mm OD) need large or VTL chuck.
    {
      when: { param: "outerDiameterMm", gt: 200 },
      then: [{ param: "chuckClass", restrictTo: ["large-8in", "vtl-17in"] }],
    },
  ],

  basePricingHints: {
    basePrice: "85.00",
    currency: "USDC",
    perUnitLabel: "per part",
  },
};
