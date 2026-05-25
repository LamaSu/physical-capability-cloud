/**
 * Injection Molding capability template.
 *
 * Highest-value template per the manufacturing capability catalog (2026-05-23,
 * Section 6 Gap 1). Covers prototype-to-production thermoplastic injection
 * molding with the full Xometry/Protolabs/Fictiv parameter surface:
 *
 *   - 40+ resin grades (commodity + engineering + glass-filled +
 *     high-performance + elastomers) sourced from the canonical MaterialSpec
 *     registry — adding a new resin is a one-line addition to MATERIAL_SEED.
 *   - SPI A-1..D-3 cosmetic grade enum (12 grades, sourced from FinishSpec
 *     where seeded; remaining SPI codes inlined as enum options for fast
 *     path until expanded into FinishSpec).
 *   - VDI 18..33 + MoldTech MT-11010..11030 texture enum (mold texture is
 *     a separate axis from cosmetic grade).
 *   - 2K/3K overmolding flag + overmold-resin sub-enum (LSR, TPE, TPU, TPV).
 *   - Insert-molding flag.
 *   - Tooling type derived from annual quantity via constraint
 *     (aluminum prototype <1K, hardened steel >100K).
 *   - Tooling amortization expressed as a `multiplier` pricing impact on
 *     `toolingType` so that the per-unit price reflects the steel-tool
 *     premium without a separate flat tooling line item (kept simple for
 *     v1; full cavity-amortization math comes in v1.1).
 *   - Gate-type enum incl. valve gate + hot runner pricing impact.
 *   - Secondary ops multi-select (insert install, pad-print, painting,
 *     plating, ultrasonic weld, laser-engrave, hot-stamp, post-mold
 *     machining, in-mold labeling).
 *   - Certifications multi-select referencing CertificationSpec ids.
 *
 * Source: ai/research/manufacturing-capability-catalog-2026-05-23.md §5.2.E
 *
 * Author: implementer-golf-2, 2026-05-23
 */

import type { CapabilityTemplate } from "@pcc/spec";

export const injectionMoldingTemplate: CapabilityTemplate = {
  capabilityType: "injection-molding",
  version: "1.0",
  name: "Plastic Injection Molding",
  description:
    "Thermoplastic injection molding — prototype runs (aluminum tools) to high-volume production (hardened steel tools). 40+ resins, full SPI/VDI/MoldTech finish coverage, 2K/3K overmolding, insert-molding, secondary ops, multi-industry certifications.",
  params: [
    // ── 1. Resin (Material registry refs) ──
    {
      type: "enum",
      key: "resin",
      label: "Resin",
      description:
        "Thermoplastic resin. References the canonical MaterialSpec registry by id.",
      required: true,
      order: 1,
      group: "Material",
      options: [
        // Commodity thermoplastics (5)
        { value: "abs", label: "ABS", description: "Tough, easy to mold, common consumer goods." },
        { value: "pp", label: "Polypropylene (PP)", description: "Living-hinge friendly, food-safe." },
        { value: "hdpe", label: "HDPE", description: "Chemical-resistant, food-safe." },
        { value: "ldpe", label: "LDPE", description: "Flexible, food-safe, low strength." },
        { value: "pvc-rigid", label: "PVC Rigid", description: "Chemical-resistant, lower-temp." },

        // Engineering thermoplastics (7)
        { value: "pc", label: "Polycarbonate (PC)", description: "Transparent, impact-resistant." },
        { value: "pmma-acrylic", label: "PMMA (Acrylic)", description: "Optical clarity, brittle." },
        { value: "pet", label: "PET", description: "Food-grade, common in bottles." },
        { value: "pbt", label: "PBT", description: "Dimensionally stable, electrical applications." },
        { value: "nylon-66", label: "Nylon 6/6 (PA66)", description: "Wear-resistant, hygroscopic." },
        { value: "nylon-6", label: "Nylon 6 (PA6)", description: "Tougher than PA66, more moisture absorption." },
        { value: "pom-delrin", label: "POM / Acetal (Delrin)", description: "Self-lubricating, low friction." },

        // Blends (2)
        {
          value: "pc-abs",
          label: "PC/ABS Blend",
          description: "PC stiffness with ABS ease of molding.",
          pricingImpact: { mode: "percent", value: "10", label: "+10% PC/ABS blend" },
        },
        {
          value: "pc-pbt",
          label: "PC/PBT Blend",
          description: "Chemical resistance + impact.",
          pricingImpact: { mode: "percent", value: "15", label: "+15% PC/PBT blend" },
        },

        // Styrenics (3)
        { value: "ps-gp", label: "Polystyrene (GP)", description: "Brittle, cheap, optical clarity." },
        { value: "hips", label: "High-Impact Polystyrene (HIPS)", description: "Better impact than GPPS." },
        { value: "asa", label: "ASA", description: "UV-stable ABS alternative." },
        { value: "san", label: "SAN", description: "Clearer than HIPS, low cost." },

        // Glass-filled (3)
        {
          value: "nylon-66-gf30",
          label: "Nylon 6/6 30% Glass-Filled",
          description: "Strength + dimensional stability.",
          pricingImpact: { mode: "percent", value: "20", label: "+20% GF (abrasive wear on tooling)" },
        },
        {
          value: "pc-gf20",
          label: "PC 20% Glass-Filled",
          description: "PC stiffness + glass reinforcement.",
          pricingImpact: { mode: "percent", value: "15", label: "+15% GF PC" },
        },
        {
          value: "pp-gf30",
          label: "PP 30% Glass-Filled",
          description: "PP with structural reinforcement.",
          pricingImpact: { mode: "percent", value: "20", label: "+20% GF PP" },
        },

        // High-performance (8)
        {
          value: "peek",
          label: "PEEK",
          description: "USP Class VI, 250°C continuous, aerospace/medical.",
          pricingImpact: { mode: "percent", value: "300", label: "+300% PEEK (premium polymer)" },
        },
        {
          value: "pei-ultem",
          label: "PEI / Ultem 1000",
          description: "Aerospace polymer, FAA-compliant.",
          pricingImpact: { mode: "percent", value: "150", label: "+150% Ultem" },
        },
        {
          value: "ppsu",
          label: "PPSU (Polyphenylsulfone)",
          description: "Medical sterilizable.",
          pricingImpact: { mode: "percent", value: "120", label: "+120% PPSU" },
        },
        {
          value: "ppa",
          label: "PPA (Polyphthalamide)",
          description: "Nylon-class but higher heat.",
          pricingImpact: { mode: "percent", value: "100", label: "+100% PPA" },
        },
        {
          value: "pps",
          label: "PPS (Polyphenylene Sulfide)",
          description: "Chemical-resistant, electrical.",
          pricingImpact: { mode: "percent", value: "80", label: "+80% PPS" },
        },
        {
          value: "lcp",
          label: "LCP (Liquid Crystal Polymer)",
          description: "Micro-electronics, thin walls.",
          pricingImpact: { mode: "percent", value: "200", label: "+200% LCP" },
        },
        {
          value: "ptfe-teflon",
          label: "PTFE (Teflon)",
          description: "Non-stick, chemical-resistant, hard to mold.",
          pricingImpact: { mode: "percent", value: "150", label: "+150% PTFE" },
        },
        {
          value: "pvdf",
          label: "PVDF",
          description: "Chemical-resistant fluoropolymer.",
          pricingImpact: { mode: "percent", value: "100", label: "+100% PVDF" },
        },

        // Elastomers (3) — also valid as overmold resins below
        { value: "tpe", label: "TPE", description: "Soft-touch grips, seals." },
        { value: "tpu", label: "TPU", description: "Abrasion-resistant, flexible." },
        { value: "tpv", label: "TPV (Santoprene)", description: "Weatherable elastomer." },
      ],
    },

    // ── 2. Part geometry ──
    {
      type: "number",
      key: "partXmm",
      label: "Part Length",
      description: "Longest part dimension.",
      required: true,
      order: 2,
      group: "Geometry",
      min: 3,
      max: 2000,
      step: 1,
      unit: "mm",
    },
    {
      type: "number",
      key: "partYmm",
      label: "Part Width",
      required: true,
      order: 3,
      group: "Geometry",
      min: 3,
      max: 1500,
      step: 1,
      unit: "mm",
    },
    {
      type: "number",
      key: "partZmm",
      label: "Part Depth",
      required: true,
      order: 4,
      group: "Geometry",
      min: 3,
      max: 500,
      step: 1,
      unit: "mm",
    },
    {
      type: "number",
      key: "wallThicknessMm",
      label: "Nominal Wall Thickness",
      description:
        "Typical 1.0-3.0mm for thermoplastics. Thin walls (<0.8mm) need micro-molding tooling.",
      required: true,
      order: 5,
      group: "Geometry",
      min: 0.5,
      max: 6,
      step: 0.1,
      unit: "mm",
      defaultValue: 1.5,
    },

    // ── 3. Annual quantity (drives tooling choice) ──
    {
      type: "number",
      key: "quantity",
      label: "Annual Quantity",
      description:
        "Total parts per year. Drives the tooling-type constraint: <1K aluminum, 1K-100K either, >100K hardened steel.",
      required: true,
      order: 6,
      group: "Order",
      min: 1,
      max: 1000000,
      step: 1,
      defaultValue: 100,
    },

    // ── 4. Tooling ──
    {
      type: "enum",
      key: "toolingType",
      label: "Tooling Type",
      description:
        "Aluminum is fast + cheap, limited shot count. Hardened steel is slow + expensive, unlimited shots. Selection is constrained by annual quantity.",
      required: true,
      order: 7,
      group: "Tooling",
      defaultValue: "aluminum-prototype",
      options: [
        {
          value: "aluminum-prototype",
          label: "Aluminum Prototype (≤2K shots)",
          description: "Single-cavity; 1-3 week lead time.",
        },
        {
          value: "aluminum-multi-cavity",
          label: "Aluminum Multi-Cavity (single + multi)",
          description: "Aluminum with multiple cavities; ~10K-50K shots.",
          pricingImpact: { mode: "multiplier", value: "1.5", label: "1.5x multi-cavity aluminum" },
        },
        {
          value: "steel-production",
          label: "Hardened Steel Production (100K-1M+ shots)",
          description: "Long-run production tooling. 6-12 week lead time.",
          pricingImpact: { mode: "multiplier", value: "3.0", label: "3.0x hardened steel premium" },
        },
      ],
    },
    {
      type: "number",
      key: "cavityCount",
      label: "Cavity Count",
      description:
        "Number of parts per shot. Higher = lower per-unit price but higher tool cost. Typical: 1, 2, 4, 8, 16, 32, 64.",
      required: false,
      order: 8,
      group: "Tooling",
      min: 1,
      max: 64,
      step: 1,
      defaultValue: 1,
    },
    {
      type: "boolean",
      key: "ownsTooling",
      label: "Customer Owns Mold",
      description: "If true, an existing customer-owned mold is being run (lower per-part cost).",
      required: false,
      order: 9,
      group: "Tooling",
      defaultValue: false,
      pricingImpact: { mode: "flat", value: "-500.00", label: "-$500 customer-owned mold credit" },
    },

    // ── 5. Finish — SPI cosmetic grade ──
    {
      type: "enum",
      key: "spiFinish",
      label: "SPI Cosmetic Grade",
      description: "Society of the Plastics Industry mold-finish standard. A-1 is mirror; D-3 is heavily textured.",
      required: true,
      order: 10,
      group: "Finish",
      defaultValue: "spi-b1",
      options: [
        {
          value: "spi-a1",
          label: "A-1 (#3 Diamond, mirror)",
          pricingImpact: { mode: "percent", value: "30", label: "+30% mirror finish (slow polish)" },
        },
        {
          value: "spi-a2",
          label: "A-2 (#6 Diamond)",
          pricingImpact: { mode: "percent", value: "20", label: "+20% A-2" },
        },
        {
          value: "spi-a3",
          label: "A-3 (#15 Diamond)",
          pricingImpact: { mode: "percent", value: "15", label: "+15% A-3" },
        },
        { value: "spi-b1", label: "B-1 (600 paper)" },
        { value: "spi-b2", label: "B-2 (400 paper)" },
        { value: "spi-b3", label: "B-3 (320 paper)" },
        { value: "spi-c1", label: "C-1 (600 stone)" },
        { value: "spi-c2", label: "C-2 (400 stone)" },
        { value: "spi-c3", label: "C-3 (320 stone)" },
        { value: "spi-d1", label: "D-1 (Dry blast glass)" },
        { value: "spi-d2", label: "D-2 (Dry blast #240)" },
        { value: "spi-d3", label: "D-3 (Dry blast #24)" },
      ],
    },

    // ── 6. Mold texture (VDI / MoldTech) ──
    {
      type: "enum",
      key: "textureVDI",
      label: "VDI / MoldTech Texture",
      description: "Mold-side texture, layered on top of SPI grade.",
      required: false,
      order: 11,
      group: "Finish",
      defaultValue: "none",
      options: [
        { value: "none", label: "None" },
        { value: "vdi-18", label: "VDI 18 (Ra 0.45 μm)" },
        { value: "vdi-24", label: "VDI 24 (Ra 1.0 μm)" },
        { value: "vdi-27", label: "VDI 27 (Ra 1.6 μm)" },
        { value: "vdi-30", label: "VDI 30 (Ra 2.5 μm)" },
        { value: "vdi-33", label: "VDI 33 (Ra 4.5 μm)" },
        { value: "moldtech-mt11010", label: "MoldTech MT-11010 (Light)" },
        { value: "moldtech-mt11020", label: "MoldTech MT-11020 (Medium)" },
        { value: "moldtech-mt11030", label: "MoldTech MT-11030 (Heavy)" },
      ],
    },

    // ── 7. Gate type ──
    {
      type: "enum",
      key: "gateType",
      label: "Gate Type",
      description: "Where the molten resin enters the cavity. Drives vestige location + flow pattern.",
      required: false,
      order: 12,
      group: "Process",
      defaultValue: "edge",
      options: [
        { value: "edge", label: "Edge Gate", description: "Default; visible vestige on parting line." },
        { value: "tunnel", label: "Tunnel / Submarine", description: "Auto-degates; small parts." },
        { value: "hot-tip", label: "Hot Tip", description: "Central gate; no runner waste." },
        { value: "pin-point", label: "Pin Point", description: "Small witness mark; cosmetic surfaces." },
        {
          value: "valve",
          label: "Valve Gate",
          description: "Cleanest vestige; controlled flow.",
          pricingImpact: { mode: "flat", value: "200.00", label: "+$200 valve gate tooling" },
        },
        {
          value: "hot-runner",
          label: "Hot Runner (multi-cavity)",
          description: "Hot manifold; no runner re-grind.",
          pricingImpact: { mode: "flat", value: "500.00", label: "+$500 hot runner" },
        },
      ],
    },

    // ── 8. Overmolding (2K) ──
    {
      type: "boolean",
      key: "isOvermold",
      label: "Overmolding (2-shot)",
      description: "True for 2K overmolded parts (e.g. rigid + soft-touch grip).",
      required: false,
      order: 13,
      group: "Advanced",
      defaultValue: false,
      pricingImpact: { mode: "percent", value: "40", label: "+40% overmold 2-shot" },
    },
    {
      type: "enum",
      key: "overmoldResin",
      label: "Overmold Resin",
      description: "Resin used for the soft/elastomer second shot.",
      required: false,
      order: 14,
      group: "Advanced",
      visibleWhen: { param: "isOvermold", equals: true },
      options: [
        { value: "tpe", label: "TPE" },
        { value: "tpu", label: "TPU" },
        { value: "tpv", label: "TPV (Santoprene)" },
        { value: "lsr-silicone", label: "Liquid Silicone Rubber (LSR)" },
      ],
    },

    // ── 9. Insert molding ──
    {
      type: "boolean",
      key: "isInsertMold",
      label: "Insert Molding",
      description: "Pre-placed metal inserts (threads, electrical contacts) over which resin is shot.",
      required: false,
      order: 15,
      group: "Advanced",
      defaultValue: false,
      pricingImpact: { mode: "percent", value: "25", label: "+25% insert molding" },
    },

    // ── 10. Secondary operations ──
    {
      type: "enum",
      key: "secondaryOps",
      label: "Secondary Operations",
      description: "Post-mold processing applied to every part.",
      required: false,
      order: 16,
      group: "Secondary",
      multi: true,
      options: [
        {
          value: "insert-install",
          label: "Threaded Insert Install (heat-set or ultrasonic)",
          pricingImpact: { mode: "flat", value: "0.50", label: "+$0.50/insert install" },
        },
        {
          value: "pad-print",
          label: "Pad Printing",
          pricingImpact: { mode: "flat", value: "0.75", label: "+$0.75 pad-print" },
        },
        {
          value: "silk-screen",
          label: "Silk Screen Printing",
          pricingImpact: { mode: "flat", value: "1.00", label: "+$1.00 silk-screen" },
        },
        {
          value: "painting",
          label: "Painting",
          pricingImpact: { mode: "flat", value: "2.00", label: "+$2.00 paint" },
        },
        {
          value: "plating",
          label: "Plating (Cr, Ni)",
          pricingImpact: { mode: "flat", value: "5.00", label: "+$5.00 plate" },
        },
        {
          value: "ultrasonic-weld",
          label: "Ultrasonic Welding (assembly)",
          pricingImpact: { mode: "flat", value: "1.00", label: "+$1.00 sonic weld" },
        },
        {
          value: "laser-engrave",
          label: "Laser Engraving",
          pricingImpact: { mode: "flat", value: "0.75", label: "+$0.75 laser engrave" },
        },
        {
          value: "hot-stamp",
          label: "Hot Stamping",
          pricingImpact: { mode: "flat", value: "0.50", label: "+$0.50 hot stamp" },
        },
        {
          value: "post-mold-machine",
          label: "Post-Mold Machining",
          pricingImpact: { mode: "flat", value: "3.00", label: "+$3.00 secondary machining" },
        },
        {
          value: "iml",
          label: "In-Mold Labeling",
          pricingImpact: { mode: "flat", value: "0.75", label: "+$0.75 IML" },
        },
      ],
    },

    // ── 11. Certifications (CertificationSpec ids) ──
    {
      type: "enum",
      key: "certifications",
      label: "Certifications Required",
      description: "References the canonical CertificationSpec registry by id.",
      required: false,
      order: 17,
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
          value: "itar",
          label: "ITAR Registered",
          pricingImpact: { mode: "percent", value: "30", label: "+30% ITAR scope" },
        },
        {
          value: "usp-class-vi",
          label: "USP Class VI (biocompatible)",
          pricingImpact: { mode: "percent", value: "40", label: "+40% USP Class VI" },
        },
        {
          value: "fda-21-cfr-820",
          label: "FDA 21 CFR Part 820 (Medical QSR)",
          pricingImpact: { mode: "percent", value: "35", label: "+35% FDA QSR" },
        },
        {
          value: "nadcap",
          label: "NADCAP (Special Processes)",
          pricingImpact: { mode: "percent", value: "20", label: "+20% NADCAP" },
        },
        { value: "rohs", label: "RoHS" },
        { value: "reach", label: "REACH" },
      ],
    },
  ],

  constraints: [
    // Tooling type derived from annual quantity
    {
      when: { param: "quantity", lt: 1000 },
      then: [{ param: "toolingType", restrictTo: ["aluminum-prototype", "aluminum-multi-cavity"] }],
    },
    {
      when: { param: "quantity", gt: 100000 },
      then: [{ param: "toolingType", restrictTo: ["steel-production"] }],
    },
    // USP Class VI / FDA 21 CFR Part 820 only meaningful on medical-grade
    // polymers. We allow operators to claim them more broadly because the
    // certification is on the QMS, not the part — but we restrict the
    // overmold resin choice to LSR when USP Class VI is required (other
    // overmold options aren't biocompatible).
    {
      when: { param: "certifications", in: ["usp-class-vi"] },
      then: [{ param: "overmoldResin", restrictTo: ["lsr-silicone"] }],
    },
    // PEEK / Ultem / PPSU / LCP / PTFE / PVDF are not feasible on aluminum
    // prototype tooling (too high melt temperature, too abrasive). Force
    // steel-production tooling when these high-performance resins are
    // selected.
    {
      when: {
        param: "resin",
        in: ["peek", "pei-ultem", "ppsu", "ppa", "pps", "lcp", "ptfe-teflon", "pvdf"],
      },
      then: [{ param: "toolingType", restrictTo: ["steel-production"] }],
    },
  ],

  basePricingHints: {
    basePrice: "8000.00",
    currency: "USDC",
    perUnitLabel: "tooling amortized + per part",
  },
};
