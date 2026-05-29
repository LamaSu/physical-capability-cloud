/**
 * DMLS (Direct Metal Laser Sintering) capability template.
 *
 * DMLS is a metal additive manufacturing process: a high-power laser fuses
 * fine metal powder layer-by-layer to build complex geometries that are
 * impractical to machine (internal channels, lattice structures, conformal
 * cooling). Distinct from SLS (polymer powder) and DMLM/SLM (cousin
 * technologies). Pricing skews high — DMLS is premium-class additive used
 * for aerospace fasteners, medical implants, F1 components, and oil/gas
 * tooling.
 *
 * Coverage:
 *   - 9 metal powders: Ti-6Al-4V (Grade 5 + Grade 23 ELI), Inconel 625/718,
 *     AlSi10Mg, Stainless 316L, Stainless 17-4 PH, Cobalt-Chrome CoCrMo,
 *     Tool Steel H13. Each material has a pricing impact reflecting
 *     powder cost + laser-time + post-process burden.
 *   - 3 layer thicknesses (20 / 30 / 60 μm) trading off detail vs build speed.
 *   - 4-tier support strategy (minimal / heavy / tree / breakaway).
 *   - Post-processing multi-select: stress-relief, HIP, heat-treat-aging,
 *     critical-surface machining, polish, bead-blast, shot-peen. HIP is
 *     restricted to Ti/Inconel by constraint (only meaningful for those
 *     high-temp materials).
 *   - Certifications: AS9100 (aerospace), ISO 13485 (medical), Nadcap,
 *     ASTM F2924 (Ti), traceable-material-cert. Medical certs gate
 *     material via constraint.
 *   - 3 tolerance tiers (standard / precision / high-precision).
 *   - Build-volume operator-side info (max XxYxZ mm).
 *
 * Cross-parameter constraints:
 *   - HIP visibility gated by material in {Ti-Grade-5, Ti-Grade-23, Inconel-625, Inconel-718}
 *   - ISO 13485 (medical) requires material in {Ti-Grade-23, CoCrMo}
 *   - AS9100 + Nadcap pair meaningful only for {Ti, Inconel} family
 *
 * Capability type: "dmls" — open string per CapabilityType union; no
 * BuiltinCapabilityType enum bump required.
 *
 * Base pricing: $80/cm³ baseline for AlSi10Mg (cheapest powder), scaled
 * by material and complexity multipliers. Per-part minimum $250.
 *
 * Author: implementer-india, 2026-05-27 (Wave 2 manufacturing templates)
 */

import type { CapabilityTemplate } from "@pcc/spec";

export const dmlsTemplate: CapabilityTemplate = {
  capabilityType: "dmls",
  version: "1.0",
  name: "DMLS (Direct Metal Laser Sintering)",
  description:
    "Metal additive — fuses metal powder layer-by-layer with a high-power laser. Premium-class for aerospace, medical implants, and complex internal geometries impractical to machine. Ti, Inconel, CoCrMo, AlSi10Mg, 316L, 17-4 PH, H13 powders. Optional HIP, machined critical surfaces, AS9100/ISO 13485/Nadcap certifications.",
  params: [
    // ── 1. Material (metal powder selection) ──
    {
      type: "enum",
      key: "material",
      label: "Metal Powder",
      description:
        "Powder bed material. Ti and Inconel are the most expensive (premium aerospace/medical). AlSi10Mg is the cost baseline.",
      required: true,
      order: 1,
      group: "Material",
      options: [
        {
          value: "alsi10mg",
          label: "AlSi10Mg (cast-aluminum equivalent)",
          description: "Lightweight cast-aluminum equivalent; baseline DMLS powder.",
        },
        {
          value: "ti-6al-4v-grade-5",
          label: "Ti-6Al-4V (Grade 5)",
          description: "Aerospace fasteners / structural; high strength-to-weight.",
          pricingImpact: { mode: "percent", value: "200", label: "+200% Ti Grade 5" },
        },
        {
          value: "ti-6al-4v-grade-23-eli",
          label: "Ti-6Al-4V ELI (Grade 23, medical-implant)",
          description:
            "Extra-low interstitials — implant-grade titanium per ASTM F136. Required for medical implants.",
          pricingImpact: { mode: "percent", value: "240", label: "+240% Ti Grade 23 ELI" },
        },
        {
          value: "inconel-625",
          label: "Inconel 625",
          description: "Nickel-chromium superalloy; corrosion-resistant aerospace + chemical.",
          pricingImpact: { mode: "percent", value: "180", label: "+180% Inconel 625" },
        },
        {
          value: "inconel-718",
          label: "Inconel 718",
          description: "Precipitation-hardenable; gas-turbine blades, rocket motors.",
          pricingImpact: { mode: "percent", value: "200", label: "+200% Inconel 718" },
        },
        {
          value: "stainless-316l",
          label: "Stainless 316L",
          description: "Low-carbon austenitic; biocompatible, marine-grade.",
          pricingImpact: { mode: "percent", value: "60", label: "+60% SS316L" },
        },
        {
          value: "stainless-17-4-ph",
          label: "Stainless 17-4 PH",
          description: "Precipitation-hardenable; high-strength tooling.",
          pricingImpact: { mode: "percent", value: "70", label: "+70% 17-4 PH" },
        },
        {
          value: "cocrmo",
          label: "Cobalt-Chrome (CoCrMo)",
          description: "Biocompatible per ASTM F75; dental + orthopedic implants.",
          pricingImpact: { mode: "percent", value: "150", label: "+150% CoCrMo" },
        },
        {
          value: "tool-steel-h13",
          label: "Tool Steel H13",
          description: "Hot-work tool steel; injection-mold inserts, conformal-cooling tooling.",
          pricingImpact: { mode: "percent", value: "90", label: "+90% H13 tool steel" },
        },
      ],
    },

    // ── 2. Layer thickness (detail vs build speed tradeoff) ──
    {
      type: "enum",
      key: "layerThickness",
      label: "Layer Thickness",
      description:
        "Powder-bed layer thickness. 20μm is highest detail (longest build); 60μm is fastest (rougher surface, larger features only).",
      required: true,
      order: 2,
      group: "Process",
      defaultValue: "30um",
      options: [
        {
          value: "20um",
          label: "20 μm (highest detail)",
          description: "Best surface finish + fine features; slow build.",
          pricingImpact: { mode: "percent", value: "50", label: "+50% 20μm slow-build" },
        },
        {
          value: "30um",
          label: "30 μm (standard)",
          description: "Standard DMLS layer; balanced detail + speed.",
        },
        {
          value: "60um",
          label: "60 μm (fastest)",
          description: "Coarse features only; ~2x build-speed of standard.",
          pricingImpact: { mode: "percent", value: "-20", label: "-20% 60μm fast-build" },
        },
      ],
    },

    // ── 3. Part orientation (operator-decided vs customer-specified) ──
    {
      type: "enum",
      key: "partOrientation",
      label: "Part Orientation",
      description:
        "Auto = the operator's CAM software picks the orientation that minimizes support material and build time. Customer-specified = drawing dictates orientation (e.g., for grain-direction reasons).",
      required: false,
      order: 3,
      group: "Process",
      defaultValue: "auto",
      options: [
        { value: "auto", label: "Auto (machine decides)", description: "CAM-optimized." },
        {
          value: "specified-by-customer",
          label: "Customer-Specified",
          description: "Drawing dictates orientation.",
          pricingImpact: { mode: "percent", value: "10", label: "+10% specified orientation" },
        },
      ],
    },

    // ── 4. Support strategy ──
    {
      type: "enum",
      key: "supportStrategy",
      label: "Support Strategy",
      description: "How the part's overhangs are supported during the build.",
      required: false,
      order: 4,
      group: "Process",
      defaultValue: "minimal-support",
      options: [
        {
          value: "minimal-support",
          label: "Minimal (designed-in self-support)",
          description: "Part geometry self-supports; very little powder removal.",
        },
        {
          value: "heavy-support",
          label: "Heavy (any geometry)",
          description: "Maximally supported; safe for any geometry but slower post-processing.",
          pricingImpact: { mode: "percent", value: "20", label: "+20% heavy support burden" },
        },
        {
          value: "tree-support",
          label: "Tree (branching)",
          description: "Tree-like branching supports; less mass than heavy.",
          pricingImpact: { mode: "percent", value: "10", label: "+10% tree support" },
        },
        {
          value: "breakaway-support",
          label: "Breakaway (snap-off)",
          description: "Hand-removable supports for accessible features.",
          pricingImpact: { mode: "percent", value: "5", label: "+5% breakaway" },
        },
      ],
    },

    // ── 5. Post-processing (multi-select) ──
    {
      type: "enum",
      key: "postProcessing",
      label: "Post-Processing",
      description: "Operations applied to every part after build completes.",
      required: false,
      order: 5,
      group: "Post-Processing",
      multi: true,
      options: [
        {
          value: "stress-relief-anneal",
          label: "Stress-Relief Anneal",
          description: "Thermal cycle to relieve build-induced residual stress.",
          pricingImpact: { mode: "flat", value: "40.00", label: "+$40 stress-relief" },
        },
        {
          value: "hip",
          label: "HIP (Hot Isostatic Pressing)",
          description:
            "High-temp + high-pressure cycle that closes internal porosity. Standard for Ti/Inconel critical-load components.",
          pricingImpact: { mode: "flat", value: "150.00", label: "+$150 HIP cycle" },
        },
        {
          value: "heat-treat-aging",
          label: "Heat Treat Aging (precipitation harden)",
          description: "T6/T74 aging for AlSi10Mg, solution + age for 17-4 PH and Inconel 718.",
          pricingImpact: { mode: "flat", value: "60.00", label: "+$60 aging cycle" },
        },
        {
          value: "machining-critical-surfaces",
          label: "Critical-Surface Machining",
          description: "5-axis CNC of mating surfaces / sealing faces to tighter-than-print tolerance.",
          pricingImpact: { mode: "flat", value: "75.00", label: "+$75 critical-surface CNC" },
        },
        {
          value: "surface-finish-polish",
          label: "Surface Polish (Ra <0.4 μm)",
          description: "Polishing of as-built surfaces; required for flow-path components.",
          pricingImpact: { mode: "flat", value: "50.00", label: "+$50 polish" },
        },
        {
          value: "bead-blast",
          label: "Bead Blast (uniform matte)",
          description: "Removes loose powder; uniform matte cosmetic finish.",
          pricingImpact: { mode: "flat", value: "15.00", label: "+$15 bead blast" },
        },
        {
          value: "shot-peen",
          label: "Shot Peen",
          description: "Compressive residual stress in surface — fatigue-life enhancement.",
          pricingImpact: { mode: "flat", value: "30.00", label: "+$30 shot peen" },
        },
      ],
    },

    // ── 6. Certifications ──
    {
      type: "enum",
      key: "certifications",
      label: "Certifications Required",
      description: "Industry / regulatory certifications applied to this build.",
      required: false,
      order: 6,
      group: "Compliance",
      multi: true,
      options: [
        {
          value: "as9100",
          label: "AS9100 (Aerospace)",
          pricingImpact: { mode: "percent", value: "15", label: "+15% AS9100" },
        },
        {
          value: "iso-13485",
          label: "ISO 13485 (Medical)",
          pricingImpact: { mode: "percent", value: "25", label: "+25% ISO 13485" },
        },
        {
          value: "nadcap",
          label: "NADCAP (Special Processes)",
          pricingImpact: { mode: "percent", value: "20", label: "+20% NADCAP" },
        },
        {
          value: "astm-f2924",
          label: "ASTM F2924 (Ti Additive Manufacturing)",
          description: "Ti-6Al-4V powder-bed fusion standard.",
          pricingImpact: { mode: "percent", value: "10", label: "+10% ASTM F2924" },
        },
        {
          value: "traceable-material-cert",
          label: "Traceable Material Cert (CoC)",
          description: "Lot-traceable powder Certificate of Conformity.",
          pricingImpact: { mode: "flat", value: "25.00", label: "+$25 material CoC" },
        },
      ],
    },

    // ── 7. Tolerance ──
    {
      type: "enum",
      key: "tolerance",
      label: "Tolerance",
      description: "Dimensional accuracy class for the as-built part (before secondary machining).",
      required: true,
      order: 7,
      group: "Quality",
      defaultValue: "standard",
      options: [
        { value: "standard", label: "Standard (±0.1mm)", description: "DMLS as-built default." },
        {
          value: "precision",
          label: "Precision (±0.05mm)",
          description: "Tighter as-built (selective re-coating).",
          pricingImpact: { mode: "percent", value: "25", label: "+25% precision" },
        },
        {
          value: "high-precision",
          label: "High Precision (±0.025mm)",
          description: "Combined with critical-surface machining for tightest hold.",
          pricingImpact: { mode: "percent", value: "50", label: "+50% high precision" },
        },
      ],
    },

    // ── 8. Build volume (operator-side info) ──
    {
      type: "number",
      key: "buildVolume",
      label: "Build Volume (max XxYxZ mm)",
      description:
        "Operator-side hint for machine class. Typical EOS M290 = 250x250x325mm; Renishaw AM400 = 250x250x300mm. Larger machines (M400-4) reach 400x400x400mm.",
      required: false,
      order: 8,
      group: "Machine",
      min: 50,
      max: 800,
      step: 10,
      unit: "mm",
      defaultValue: 250,
    },

    // ── 9. Quantity ──
    {
      type: "number",
      key: "quantity",
      label: "Quantity",
      description: "Number of parts. Multiple parts share build-plate area; quote is per-part.",
      required: true,
      order: 9,
      group: "Order",
      min: 1,
      max: 500,
      step: 1,
      defaultValue: 1,
    },
  ],

  constraints: [
    // HIP is only meaningful (and supported) for Ti and Inconel.
    // Exclude HIP from postProcessing options when material is non-Ti/Inconel.
    {
      when: {
        param: "material",
        in: [
          "alsi10mg",
          "stainless-316l",
          "stainless-17-4-ph",
          "cocrmo",
          "tool-steel-h13",
        ],
      },
      then: [{ param: "postProcessing", exclude: ["hip"] }],
    },
    // Medical (ISO 13485) restricts material to implant-grade Ti or CoCrMo.
    {
      when: { param: "certifications", in: ["iso-13485"] },
      then: [{ param: "material", restrictTo: ["ti-6al-4v-grade-23-eli", "cocrmo"] }],
    },
    // AS9100 + Nadcap are meaningful primarily on Ti / Inconel aerospace alloys.
    // When the customer requires either, gate material to that family.
    {
      when: { param: "certifications", in: ["as9100", "nadcap"] },
      then: [
        {
          param: "material",
          restrictTo: [
            "ti-6al-4v-grade-5",
            "ti-6al-4v-grade-23-eli",
            "inconel-625",
            "inconel-718",
            "alsi10mg",
            "stainless-17-4-ph",
          ],
        },
      ],
    },
    // ASTM F2924 is a Ti-only powder-bed-fusion standard.
    {
      when: { param: "certifications", in: ["astm-f2924"] },
      then: [{ param: "material", restrictTo: ["ti-6al-4v-grade-5", "ti-6al-4v-grade-23-eli"] }],
    },
    // High-precision tolerance requires critical-surface machining
    // (recommend it via constraint by gating tolerance away from high-precision
    // when machining isn't selected — but soft-gate by NOT excluding here;
    // we leave the choice open since the operator may have an alternate
    // process. We DO restrict tolerance options on the simplest material
    // (alsi10mg) to standard/precision because 25μm is impractical on AlSi10Mg
    // as-built without machining).
    {
      when: { param: "material", equals: "alsi10mg" },
      then: [{ param: "tolerance", exclude: ["high-precision"] }],
    },
  ],

  basePricingHints: {
    basePrice: "250.00",
    currency: "USDC",
    perUnitLabel: "per part (DMLS premium; $80/cm³ AlSi10Mg baseline scaled by material)",
  },
};
