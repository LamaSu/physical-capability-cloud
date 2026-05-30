/**
 * Urethane Casting capability template.
 *
 * Urethane casting (also called RTV silicone-mold casting or "vacuum
 * casting") is a low-volume manufacturing process that bridges the gap
 * between 3D-printing prototypes and hard-tooled injection molding:
 *
 *   - Operator casts a silicone (RTV) or epoxy mold from a master model
 *     (typically a high-resolution SLA print, machined master, or CAD).
 *   - Two-part polyurethane resin is poured into the mold under vacuum.
 *   - Each silicone mold produces 10-25 high-quality parts; epoxy 50-100;
 *     aluminum tools 200+.
 *
 * The result: production-grade plastic parts in 1-2 weeks (vs 6-12 weeks
 * for injection molding tooling), at runs of 10-200 units that would be
 * uneconomic for hard tooling.
 *
 * Coverage:
 *   - 8 resin families: PolyJet PR48 (simulated ABS), Smooth-Cast 326
 *     (clear), Smooth-Cast 65D (durable), Smooth-Cast 380 (medical-grade),
 *     TASK series (high-perf engineering), Vytaflex 30/60 (soft + firm
 *     rubber), Mold-Star 30 (silicone for re-casting).
 *   - Shore hardness number-input (Shore A or D scale, 10-90 range).
 *   - Color: clear, opaque-white/black, pantone-match (+30%), custom pigment.
 *   - Finish quality: as-cast / light-sand / mirror-polish / texture-matched.
 *   - Master-model source: customer-provides STL, PCC 3D-prints from CAD,
 *     PCC reverse-engineers CAD from drawing.
 *   - Tooling: silicone (10-25 parts), epoxy (50-100), aluminum (200+).
 *   - Post-processing: flash-trim, gate-removal, surface-prep-for-paint,
 *     primer-coat, masked-painting.
 *   - Medical certifications: ISO 10993 biocompat, USP Class VI; engineering:
 *     RoHS, REACH.
 *   - Timeline tiers: standard 7-10 days / expedited (+25%) 4-5 days /
 *     rush (+75%) 2-3 days.
 *
 * Cross-parameter constraints:
 *   - ISO 10993 / USP Class VI require resin in {Smooth-Cast 380, TASK medical-grade}
 *   - mirror-polish finish requires non-rubber resin (excludes Vytaflex 30/60, Mold-Star 30)
 *   - aluminum-tool only justified if quantity >= 200
 *
 * Capability type: "urethane-casting" — open string per CapabilityType union;
 * no BuiltinCapabilityType enum bump required.
 *
 * Base pricing: $30/part baseline (small parts, standard resin, silicone
 * mold). Plus tooling charge folded into per-part for low quantities.
 *
 * Author: implementer-india, 2026-05-27 (Wave 2 manufacturing templates)
 */

import type { CapabilityTemplate } from "@pcc/spec";

export const urethaneCastingTemplate: CapabilityTemplate = {
  capabilityType: "urethane-casting",
  version: "1.0",
  name: "Urethane Casting (RTV / Vacuum Casting)",
  description:
    "Low-volume production of polyurethane parts from silicone or epoxy molds (10-200 units). Bridges prototype-to-production at 1-2 week lead time. PolyJet PR48, Smooth-Cast / TASK / Vytaflex / Mold-Star resin families. Optional pantone-match color, mirror polish, medical-grade biocompat (ISO 10993, USP Class VI).",
  params: [
    // ── 1. Resin type (the central material decision) ──
    {
      type: "enum",
      key: "resinType",
      label: "Resin Type",
      description:
        "Two-part polyurethane resin family. Smooth-Cast 380 and TASK medical-grade are biocompat-rated. Vytaflex / Mold-Star produce soft rubber parts.",
      required: true,
      order: 1,
      group: "Material",
      options: [
        {
          value: "polyjet-pr48-simulated-abs",
          label: "PolyJet PR48 (Simulated ABS)",
          description: "ABS-equivalent stiffness; opaque. Consumer-grade.",
        },
        {
          value: "smooth-cast-326",
          label: "Smooth-Cast 326 (Clear)",
          description: "Water-clear urethane; optical clarity for lenses, light pipes.",
          pricingImpact: { mode: "percent", value: "30", label: "+30% clear urethane" },
        },
        {
          value: "smooth-cast-65d",
          label: "Smooth-Cast 65D (Durable)",
          description: "Shore D 65 — high-impact engineering parts.",
          pricingImpact: { mode: "percent", value: "20", label: "+20% durable 65D" },
        },
        {
          value: "smooth-cast-380",
          label: "Smooth-Cast 380 (Medical-Grade)",
          description:
            "ISO 10993-5 cytotoxicity-tested. Medical device housings, single-use surgical.",
          pricingImpact: { mode: "percent", value: "80", label: "+80% medical-grade 380" },
        },
        {
          value: "task-series-high-perf",
          label: "TASK Series (High-Performance Engineering)",
          description:
            "Smooth-On's engineering-grade urethanes (TASK-2 / TASK-9 / TASK-16). Highest mechanical performance.",
          pricingImpact: { mode: "percent", value: "60", label: "+60% TASK engineering" },
        },
        {
          value: "task-medical-grade",
          label: "TASK Medical-Grade (USP Class VI capable)",
          description:
            "TASK formulation cleared for USP Class VI biocompat. Implant-adjacent, oral.",
          pricingImpact: { mode: "percent", value: "120", label: "+120% TASK medical" },
        },
        {
          value: "vytaflex-30",
          label: "Vytaflex 30 (Soft Rubber)",
          description: "Shore A 30 — soft elastomer; bumpers, soft grips, seals.",
          pricingImpact: { mode: "percent", value: "15", label: "+15% Vytaflex 30" },
        },
        {
          value: "vytaflex-60",
          label: "Vytaflex 60 (Firm Rubber)",
          description: "Shore A 60 — firmer elastomer; gaskets, structural pads.",
          pricingImpact: { mode: "percent", value: "20", label: "+20% Vytaflex 60" },
        },
        {
          value: "mold-star-30",
          label: "Mold-Star 30 (Silicone for re-casting)",
          description:
            "Platinum-cure silicone. Used when the cast part is itself a re-castable mold.",
          pricingImpact: { mode: "percent", value: "50", label: "+50% Mold-Star 30" },
        },
      ],
    },

    // ── 2. Shore hardness (numeric) ──
    {
      type: "number",
      key: "shoreHardness",
      label: "Shore Hardness",
      description:
        "Target Shore hardness (A scale for soft rubbers, D scale for rigid plastics). Range 10 (soft sponge) to 90 (rigid).",
      required: false,
      order: 2,
      group: "Material",
      min: 10,
      max: 90,
      step: 1,
      defaultValue: 65,
    },

    // ── 3. Color ──
    {
      type: "enum",
      key: "color",
      label: "Color",
      description: "Pigment selection for the cast resin.",
      required: false,
      order: 3,
      group: "Aesthetic",
      defaultValue: "opaque-white",
      options: [
        { value: "clear", label: "Clear (no pigment)" },
        { value: "opaque-white", label: "Opaque White" },
        { value: "opaque-black", label: "Opaque Black" },
        {
          value: "pantone-match",
          label: "Pantone-Match (color-match service)",
          description: "Lab-matched pigment to a Pantone or RAL swatch.",
          pricingImpact: { mode: "percent", value: "30", label: "+30% pantone-match" },
        },
        {
          value: "custom-pigment",
          label: "Custom Pigment",
          description: "Customer-supplied or designer-selected pigment.",
          pricingImpact: { mode: "percent", value: "15", label: "+15% custom pigment" },
        },
      ],
    },

    // ── 4. Finish quality ──
    {
      type: "enum",
      key: "finishQuality",
      label: "Finish Quality",
      description: "Surface finish applied to every part.",
      required: false,
      order: 4,
      group: "Finish",
      defaultValue: "as-cast",
      options: [
        {
          value: "as-cast",
          label: "As-Cast (mold-direct)",
          description: "Mold parting-line + gate visible; standard for visible-but-not-cosmetic parts.",
        },
        {
          value: "light-sand",
          label: "Light Sand (gate flush)",
          description: "Sand gate flush; light overall sand. Standard for hand-feel parts.",
          pricingImpact: { mode: "flat", value: "8.00", label: "+$8 light sand" },
        },
        {
          value: "mirror-polish",
          label: "Mirror Polish (Ra <0.4 μm)",
          description: "Hand-polished to mirror finish. Clear lenses, optical surfaces.",
          pricingImpact: { mode: "percent", value: "50", label: "+50% mirror polish" },
        },
        {
          value: "texture-matched",
          label: "Texture-Matched (drawing texture)",
          description: "Texture pattern matched to engineering drawing (e.g., MoldTech, VDI).",
          pricingImpact: { mode: "flat", value: "30.00", label: "+$30 texture match" },
        },
      ],
    },

    // ── 5. Master-model source ──
    {
      type: "enum",
      key: "masterModel",
      label: "Master Model Source",
      description: "Where the master model that produces the mold comes from.",
      required: true,
      order: 5,
      group: "Tooling",
      defaultValue: "customer-provides",
      options: [
        {
          value: "customer-provides",
          label: "Customer Provides (STL/STEP)",
          description: "Customer ships a high-res master print or machined master.",
        },
        {
          value: "pcc-3d-prints-from-cad",
          label: "PCC 3D-Prints from CAD",
          description: "Customer ships CAD; PCC SLA-prints the master at $X surcharge.",
          pricingImpact: { mode: "flat", value: "120.00", label: "+$120 master print" },
        },
        {
          value: "pcc-cad-from-drawing",
          label: "PCC Generates CAD from Drawing",
          description: "Customer ships 2D drawing or sample; PCC reverse-engineers CAD + prints master.",
          pricingImpact: { mode: "flat", value: "350.00", label: "+$350 CAD + master" },
        },
      ],
    },

    // ── 6. Tooling type ──
    {
      type: "enum",
      key: "toolingType",
      label: "Tooling Type",
      description:
        "Silicone is fast + cheap, 10-25 part runs. Epoxy mid-tier, 50-100 parts. Aluminum tool is highest cost, only justified at 200+ parts.",
      required: true,
      order: 6,
      group: "Tooling",
      defaultValue: "silicone-mold",
      options: [
        {
          value: "silicone-mold",
          label: "Silicone Mold (standard, 10-25 parts)",
          description: "RTV silicone (Mold-Star or Mold-Max). 1-week lead.",
        },
        {
          value: "epoxy-mold",
          label: "Epoxy Mold (50-100 parts)",
          description: "Epoxy / aluminum-loaded composite. 2-week lead.",
          pricingImpact: { mode: "flat", value: "300.00", label: "+$300 epoxy tooling" },
        },
        {
          value: "aluminum-tool",
          label: "Aluminum Tool (200+ parts)",
          description: "Machined aluminum cavity. 3-4 week lead. Best per-part economics at volume.",
          pricingImpact: { mode: "flat", value: "1200.00", label: "+$1200 aluminum tool" },
        },
      ],
    },

    // ── 7. Post-processing (multi-select) ──
    {
      type: "enum",
      key: "postProcessing",
      label: "Post-Processing",
      description: "Operations applied to every part after demolding.",
      required: false,
      order: 7,
      group: "Post-Processing",
      multi: true,
      options: [
        {
          value: "flash-trim",
          label: "Flash Trim",
          description: "Trim parting-line flash from every part.",
          pricingImpact: { mode: "flat", value: "2.00", label: "+$2 flash trim" },
        },
        {
          value: "gate-removal",
          label: "Gate Removal (clean cut)",
          description: "Remove gate vestige; sand cut flush.",
          pricingImpact: { mode: "flat", value: "3.00", label: "+$3 gate removal" },
        },
        {
          value: "surface-prep-for-paint",
          label: "Surface Prep for Paint",
          description: "Sand + clean for paint adhesion.",
          pricingImpact: { mode: "flat", value: "6.00", label: "+$6 paint prep" },
        },
        {
          value: "primer-coat",
          label: "Primer Coat",
          description: "Single primer pass; adhesion + uniform color base.",
          pricingImpact: { mode: "flat", value: "10.00", label: "+$10 primer" },
        },
        {
          value: "masked-painting",
          label: "Masked Painting (2-color)",
          description: "Masked + painted two-color scheme. Color-matched per design.",
          pricingImpact: { mode: "flat", value: "20.00", label: "+$20 masked paint" },
        },
      ],
    },

    // ── 8. Certifications ──
    {
      type: "enum",
      key: "certifications",
      label: "Certifications Required",
      description: "Regulatory / industry certifications for the cast part.",
      required: false,
      order: 8,
      group: "Compliance",
      multi: true,
      options: [
        {
          value: "iso-10993-biocompat",
          label: "ISO 10993 Biocompatibility",
          description: "Medical biocompat for skin/oral contact.",
          pricingImpact: { mode: "percent", value: "40", label: "+40% ISO 10993" },
        },
        {
          value: "usp-class-vi",
          label: "USP Class VI (biocompatible)",
          description: "USP Class VI extractables/biocompat — implant-adjacent.",
          pricingImpact: { mode: "percent", value: "60", label: "+60% USP Class VI" },
        },
        { value: "rohs", label: "RoHS" },
        { value: "reach", label: "REACH" },
      ],
    },

    // ── 9. Quantity ──
    {
      type: "number",
      key: "quantity",
      label: "Quantity",
      description:
        "Total parts ordered. Drives tooling-type recommendation (silicone ≤25, epoxy 50-100, aluminum 200+).",
      required: true,
      order: 9,
      group: "Order",
      min: 1,
      max: 5000,
      step: 1,
      defaultValue: 25,
    },

    // ── 10. Timeline urgency ──
    {
      type: "enum",
      key: "timelineUrgency",
      label: "Timeline Urgency",
      description: "Standard 7-10 days. Expedited and rush carry premiums.",
      required: false,
      order: 10,
      group: "Order",
      defaultValue: "standard",
      options: [
        { value: "standard", label: "Standard (7-10 days)", description: "Normal queue position." },
        {
          value: "expedited",
          label: "Expedited (4-5 days)",
          description: "Bumps ahead of standard queue.",
          pricingImpact: { mode: "percent", value: "25", label: "+25% expedited" },
        },
        {
          value: "rush",
          label: "Rush (2-3 days)",
          description: "Stops the line. Overtime + weekend.",
          pricingImpact: { mode: "percent", value: "75", label: "+75% rush" },
        },
      ],
    },
  ],

  constraints: [
    // Medical certs (ISO 10993, USP Class VI) require medical-grade resins.
    {
      when: { param: "certifications", in: ["iso-10993-biocompat", "usp-class-vi"] },
      then: [{ param: "resinType", restrictTo: ["smooth-cast-380", "task-medical-grade"] }],
    },
    // Mirror polish doesn't work on rubber / silicone resins.
    {
      when: {
        param: "resinType",
        in: ["vytaflex-30", "vytaflex-60", "mold-star-30"],
      },
      then: [{ param: "finishQuality", exclude: ["mirror-polish"] }],
    },
    // Aluminum tooling is only economic at volume — restrict for low qty.
    // (Soft-gate via tooling-type exclude when qty < 200.)
    {
      when: { param: "quantity", lt: 200 },
      then: [{ param: "toolingType", exclude: ["aluminum-tool"] }],
    },
    // Conversely, very high volume (>200) should not use silicone single-mold.
    {
      when: { param: "quantity", gt: 200 },
      then: [{ param: "toolingType", restrictTo: ["epoxy-mold", "aluminum-tool"] }],
    },
  ],

  basePricingHints: {
    basePrice: "30.00",
    currency: "USDC",
    perUnitLabel: "per part (plus tooling, amortized for low qty)",
  },
};
