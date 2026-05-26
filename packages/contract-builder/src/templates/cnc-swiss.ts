/**
 * CNC Swiss-Type Turning capability template.
 *
 * Per the manufacturing capability catalog (2026-05-23, §5.2.C, §3.21, §5.2.A):
 * Swiss-type turning is a distinct sub-class of CNC turning specialized for
 * SUB-MILLIMETER PRECISION on small parts (medical screws, dental
 * implants, electronics connectors, micro fasteners). Key differences from
 * standard CNC turning:
 *
 *   - Maximum stock diameter ≤32mm (limited by guide-bushing bore size).
 *   - Routine tolerance ±0.0005in / ±0.013mm (10x tighter than precision-
 *     class on a standard lathe). Ultra-precision class hits ±0.0001in.
 *   - Live tooling (cross-axis milling, cross-drilling, slotting, knurling)
 *     typical for done-in-one parts in a single setup.
 *   - Gang tooling for sequential ops without indexing time.
 *   - Sub-spindle for back-side machining in single setup.
 *   - Bar feeders (single-bar, multi-bar-loader) for unattended high-
 *     volume production. Bar stock typically 3m or 6m.
 *   - Single-part-per-cycle cycle times measured in tens of seconds; very
 *     high throughput on long bar stock — Swiss shines at 1,000+ unit runs.
 *   - Premium base pricing reflecting the specialty machine class
 *     (typically Citizen Cincom, Star SB-20, Tornos DECO).
 *   - Materials skew toward medical/electronics grades: 304/316L stainless,
 *     Ti-6Al-4V, PEEK, Delrin, brass C360, aluminum 7075.
 *
 * Visibility note (matches sheet-metal.ts pattern): the resolver's
 * `visibleWhen` uses strict `===` equality. To gate dependent params off
 * a multi-select like `liveToolOps`, we use a boolean (`liveTooling`,
 * `subSpindle`, `gangTooling`) as the visibility key. Operators flip the
 * boolean on; the dependent multi-select appears.
 *
 * Source: ai/research/manufacturing-capability-catalog-2026-05-23.md §5.2.C
 *
 * Author: implementer-mike, 2026-05-23 (expanded from golf-2 scaffold)
 */

import type { CapabilityTemplate } from "@pcc/spec";

export const cncSwissTemplate: CapabilityTemplate = {
  capabilityType: "cnc-swiss",
  version: "1.0",
  name: "CNC Swiss-Type Turning",
  description:
    "Sub-millimeter precision turning of small-diameter (≤32mm) parts. Specialty machine class for medical, dental, electronics. Live tooling, sub-spindle, bar feeder. Routine ±0.0005in tolerance; ultra-precision ±0.0001in.",
  params: [
    // ── 1. Material (medical/electronics-grade round bar stock only) ──
    {
      type: "enum",
      key: "material",
      label: "Material",
      description:
        "Round bar stock material. Swiss-class machines excel with medical-grade stainless, titanium, biocompatible plastics, and free-machining brass.",
      required: true,
      order: 1,
      group: "Material",
      options: [
        { value: "stainless-303", label: "Stainless 303 (free-machining)", description: "Easiest stainless to turn." },
        {
          value: "stainless-304",
          label: "Stainless 304",
          description: "Food-grade; work-hardens.",
          pricingImpact: { mode: "percent", value: "30", label: "+30% SS304" },
        },
        {
          value: "stainless-316",
          label: "Stainless 316 (medical / marine)",
          description: "Biocompatible (ISO 10993); medical implants.",
          pricingImpact: { mode: "percent", value: "40", label: "+40% SS316" },
        },
        {
          value: "stainless-316l",
          label: "Stainless 316L (medical-grade low-carbon)",
          description: "Low-carbon variant; preferred for implants and surgical instruments.",
          pricingImpact: { mode: "percent", value: "45", label: "+45% SS316L" },
        },
        {
          value: "stainless-17-4-ph",
          label: "Stainless 17-4 PH",
          description: "Precipitation-hardened; high strength.",
          pricingImpact: { mode: "percent", value: "50", label: "+50% 17-4 PH" },
        },
        { value: "brass-360", label: "Brass C360 (electronics connectors)", description: "Best machinability; pins, contacts." },
        {
          value: "aluminum-7075-t6",
          label: "Aluminum 7075-T6",
          description: "Aerospace; high strength-to-weight.",
          pricingImpact: { mode: "percent", value: "15", label: "+15% 7075" },
        },
        {
          value: "titanium-grade-5",
          label: "Titanium Grade 5 (Ti-6Al-4V)",
          description: "Medical implants; aerospace fasteners. Abrasive on tools.",
          pricingImpact: { mode: "percent", value: "150", label: "+150% titanium" },
        },
        {
          value: "peek",
          label: "PEEK (medical / dental)",
          description: "High-temp biocompatible polymer.",
          pricingImpact: { mode: "percent", value: "100", label: "+100% PEEK" },
        },
        {
          value: "pom-delrin",
          label: "Delrin (POM/Acetal)",
          description: "Self-lubricating; small gears and bushings.",
        },
      ],
    },

    // ── 2. Outer diameter (Swiss envelope: ≤32mm guide-bushing bore) ──
    {
      type: "number",
      key: "outerDiameterMm",
      label: "Outer Diameter",
      description: "Bar-stock OD. Swiss guide-bushing bore caps at 32mm.",
      required: true,
      order: 2,
      group: "Geometry",
      min: 0.5,
      max: 32,
      step: 0.01,
      unit: "mm",
    },

    // ── 3. Length ──
    {
      type: "number",
      key: "lengthMm",
      label: "Length",
      description: "Overall part length. Swiss is typically used for parts up to ~300mm.",
      required: true,
      order: 3,
      group: "Geometry",
      min: 1,
      max: 300,
      step: 0.1,
      unit: "mm",
    },

    // ── 4. Tolerance class (Swiss baseline = precision; ultra = sub-mm) ──
    {
      type: "enum",
      key: "toleranceClass",
      label: "Tolerance Class",
      description:
        "Standard ±0.0005in / ±0.013mm — the Swiss baseline (already finer than precision-class on a standard lathe). Precision ±0.0002in / ±0.005mm. Ultra-precision ±0.0001in / ±0.0025mm for medical-implant-grade work.",
      required: true,
      order: 4,
      group: "Quality",
      defaultValue: "standard",
      options: [
        { value: "standard", label: "Standard (±0.0005in / ±0.013mm)" },
        {
          value: "precision",
          label: "Precision (±0.0002in / ±0.005mm)",
          pricingImpact: { mode: "percent", value: "30", label: "+30% precision" },
        },
        {
          value: "ultra-precision",
          label: "Ultra-Precision (±0.0001in / ±0.0025mm)",
          pricingImpact: { mode: "percent", value: "75", label: "+75% ultra-precision" },
        },
      ],
    },

    // ── 5. Live tooling (cross-axis milling) ──
    {
      type: "boolean",
      key: "liveTooling",
      label: "Live Tooling",
      description: "Powered cross-axis tools for milling operations on the turned part.",
      required: false,
      order: 5,
      group: "Tooling",
      defaultValue: false,
    },

    // ── 6. Live-tool ops (visible only when liveTooling=true) ──
    {
      type: "enum",
      key: "liveToolOps",
      label: "Live-Tool Operations",
      description: "Pick all cross-axis milling/drilling ops the part requires.",
      required: false,
      order: 6,
      group: "Tooling",
      multi: true,
      visibleWhen: { param: "liveTooling", equals: true },
      options: [
        {
          value: "cross-drill",
          label: "Cross-drill (radial hole)",
          pricingImpact: { mode: "flat", value: "6.00", label: "+$6 cross-drill" },
        },
        {
          value: "cross-tap",
          label: "Cross-tap (radial thread)",
          pricingImpact: { mode: "flat", value: "10.00", label: "+$10 cross-tap" },
        },
        {
          value: "end-mill",
          label: "End-mill (axial pocket)",
          pricingImpact: { mode: "flat", value: "12.00", label: "+$12 end-mill" },
        },
        {
          value: "slot",
          label: "Slot (cross-axis slot cut)",
          pricingImpact: { mode: "flat", value: "8.00", label: "+$8 slot" },
        },
        {
          value: "knurl-cross",
          label: "Cross-knurl (live-tool knurling)",
          pricingImpact: { mode: "flat", value: "10.00", label: "+$10 cross-knurl" },
        },
      ],
    },

    // ── 7. Gang tooling (multi-tool indexing) ──
    {
      type: "boolean",
      key: "gangTooling",
      label: "Gang Tooling",
      description: "Multiple tools indexed for sequential ops without separate setup time.",
      required: false,
      order: 7,
      group: "Tooling",
      defaultValue: false,
      pricingImpact: { mode: "flat", value: "8.00", label: "+$8 gang-tool setup" },
    },

    // ── 8. Sub-spindle (back-side machining in single setup) ──
    {
      type: "boolean",
      key: "subSpindle",
      label: "Sub-Spindle",
      description: "Back-side machining via secondary spindle in a single setup (done-in-one).",
      required: false,
      order: 8,
      group: "Tooling",
      defaultValue: false,
    },

    // ── 9. Sub-spindle ops (visible only when subSpindle=true) ──
    {
      type: "enum",
      key: "subSpindleOps",
      label: "Sub-Spindle Operations",
      description: "Pick all back-side operations the part requires.",
      required: false,
      order: 9,
      group: "Tooling",
      multi: true,
      visibleWhen: { param: "subSpindle", equals: true },
      options: [
        {
          value: "face",
          label: "Back-face (perpendicular end-cut)",
          pricingImpact: { mode: "flat", value: "4.00", label: "+$4 back-face" },
        },
        {
          value: "drill",
          label: "Back-drill (axial back hole)",
          pricingImpact: { mode: "flat", value: "6.00", label: "+$6 back-drill" },
        },
        {
          value: "tap",
          label: "Back-tap (axial back thread)",
          pricingImpact: { mode: "flat", value: "10.00", label: "+$10 back-tap" },
        },
        {
          value: "part-off",
          label: "Part-off (cutoff from bar)",
          pricingImpact: { mode: "flat", value: "3.00", label: "+$3 part-off" },
        },
      ],
    },

    // ── 10. Bar feeder ──
    {
      type: "enum",
      key: "barFeeder",
      label: "Bar Feeder",
      description: "Bar-feeding system for unattended high-volume production.",
      required: false,
      order: 10,
      group: "Stock Feeding",
      defaultValue: "single-bar",
      options: [
        { value: "none", label: "None (manual feed)" },
        { value: "single-bar", label: "Single-bar feeder (one bar at a time)" },
        {
          value: "multi-bar-loader",
          label: "Multi-bar loader (8-12 bars, fully unattended)",
          pricingImpact: { mode: "flat", value: "5.00", label: "+$5 multi-bar setup" },
        },
      ],
    },

    // ── 11. Bar stock diameter (Swiss bar capacity ≤32mm) ──
    {
      type: "number",
      key: "barStockDiameter",
      label: "Bar Stock Diameter",
      description: "Diameter of the bar stock feeding the machine. Hard cap at 32mm — the Swiss guide-bushing bore limit.",
      required: false,
      order: 11,
      group: "Stock Feeding",
      min: 0.5,
      max: 32,
      step: 0.1,
      unit: "mm",
      defaultValue: 12,
    },

    // ── 12. Bar stock length ──
    {
      type: "number",
      key: "barStockLength",
      label: "Bar Stock Length",
      description: "Typical bar stock lengths are 3000mm (3m) or 6000mm (6m).",
      required: false,
      order: 12,
      group: "Stock Feeding",
      min: 100,
      max: 6000,
      step: 100,
      unit: "mm",
      defaultValue: 3000,
    },

    // ── 13. Run volume (Swiss is high-volume; 1000+ optimal) ──
    {
      type: "number",
      key: "runVolume",
      label: "Run Volume",
      description: "Expected production run size. Swiss-type pricing is optimized for runs of 1,000+ parts; smaller runs carry setup-cost amortization.",
      required: false,
      order: 13,
      group: "Order",
      min: 1,
      max: 100000,
      step: 1,
      defaultValue: 1000,
    },

    // ── 14. Surface finish (Swiss-typical: as-turned, polish, passivate) ──
    {
      type: "enum",
      key: "surfaceFinish",
      label: "Surface Finish",
      description: "Swiss-typical finishes — Ra<0.2μm polish is achievable due to the high-precision class.",
      required: false,
      order: 14,
      group: "Finish",
      defaultValue: "as-turned",
      options: [
        { value: "as-turned", label: "As Turned (Ra ~0.8 μm)" },
        {
          value: "deburr-tumble",
          label: "Deburr / Tumble",
          pricingImpact: { mode: "flat", value: "5.00", label: "+$5 deburr" },
        },
        {
          value: "polish-fine",
          label: "Polish (Ra <0.2 μm)",
          pricingImpact: { mode: "flat", value: "12.00", label: "+$12 fine polish" },
        },
        {
          value: "passivation",
          label: "Passivation (stainless, ASTM A967)",
          pricingImpact: { mode: "flat", value: "8.00", label: "+$8 passivation" },
        },
        {
          value: "electropolish",
          label: "Electropolish (medical/food-grade stainless)",
          pricingImpact: { mode: "flat", value: "18.00", label: "+$18 electropolish" },
        },
        {
          value: "ti-anodize",
          label: "Titanium Anodize (AMS-2488)",
          pricingImpact: { mode: "flat", value: "25.00", label: "+$25 Ti anodize" },
        },
        {
          value: "laser-engrave",
          label: "Laser Engrave (small part marking)",
          pricingImpact: { mode: "flat", value: "5.00", label: "+$5 laser engrave" },
        },
      ],
    },

    // ── 15. Quantity (Swiss shops priced per-unit for batches) ──
    {
      type: "number",
      key: "quantity",
      label: "Quantity",
      description: "Total parts ordered (drives final pricing; the multiplier applies to per-unit cost).",
      required: true,
      order: 15,
      group: "Order",
      min: 1,
      max: 100000,
      step: 1,
      defaultValue: 100,
    },

    // ── 16. Certifications (medical / dental / electronics) ──
    {
      type: "enum",
      key: "certifications",
      label: "Certifications Required",
      description: "References the canonical CertificationSpec registry by id.",
      required: false,
      order: 16,
      group: "Compliance",
      multi: true,
      options: [
        { value: "iso-9001", label: "ISO 9001:2015" },
        {
          value: "iso-13485",
          label: "ISO 13485 (Medical)",
          pricingImpact: { mode: "percent", value: "25", label: "+25% ISO 13485" },
        },
        {
          value: "fda-21-cfr-820",
          label: "FDA 21 CFR Part 820 (Medical QSR)",
          pricingImpact: { mode: "percent", value: "35", label: "+35% FDA QSR" },
        },
        {
          value: "usp-class-vi",
          label: "USP Class VI (biocompatible)",
          pricingImpact: { mode: "percent", value: "40", label: "+40% USP Class VI" },
        },
        {
          value: "as9100d",
          label: "AS9100D (Aerospace)",
          pricingImpact: { mode: "percent", value: "20", label: "+20% AS9100D" },
        },
        {
          value: "iatf-16949",
          label: "IATF 16949 (Automotive)",
          pricingImpact: { mode: "percent", value: "20", label: "+20% IATF 16949" },
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
  ],

  constraints: [
    // Passivation / electropolish are stainless-only.
    {
      when: {
        param: "material",
        in: ["brass-360", "aluminum-7075-t6", "titanium-grade-5", "peek", "pom-delrin"],
      },
      then: [{ param: "surfaceFinish", exclude: ["passivation", "electropolish"] }],
    },
    // Ti anodize is titanium-only.
    {
      when: {
        param: "material",
        in: [
          "stainless-303",
          "stainless-304",
          "stainless-316",
          "stainless-316l",
          "stainless-17-4-ph",
          "brass-360",
          "aluminum-7075-t6",
          "peek",
          "pom-delrin",
        ],
      },
      then: [{ param: "surfaceFinish", exclude: ["ti-anodize"] }],
    },
    // Plastics restrict finish to a minimal set (no chemical surface treatments).
    {
      when: { param: "material", in: ["peek", "pom-delrin"] },
      then: [
        {
          param: "surfaceFinish",
          restrictTo: ["as-turned", "deburr-tumble", "polish-fine", "laser-engrave"],
        },
      ],
    },
    // Bar stock diameter cannot exceed the part OD (you can't make a 20mm OD from 10mm bar).
    // Constraint: when outerDiameterMm is large (e.g., near the 32mm cap),
    // barStockDiameter must be at least equal — restrict the bar floor.
    {
      when: { param: "outerDiameterMm", gt: 20 },
      then: [{ param: "barStockDiameter", setMin: 20 }],
    },
    // Ultra-precision tolerance restricts material — only stable, fine-grain
    // alloys hold ±0.0001in. Plastics creep too much; aluminum 7075 work-
    // hardens unpredictably at sub-mm scale.
    {
      when: { param: "toleranceClass", equals: "ultra-precision" },
      then: [
        {
          param: "material",
          restrictTo: ["stainless-303", "stainless-316", "stainless-316l", "stainless-17-4-ph", "brass-360", "titanium-grade-5"],
        },
      ],
    },
  ],

  basePricingHints: {
    basePrice: "120.00",
    currency: "USDC",
    perUnitLabel: "per part (Swiss premium)",
  },
};
