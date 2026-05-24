/**
 * CNC Swiss-Type Turning capability template (SCAFFOLD).
 *
 * Per the manufacturing capability catalog (2026-05-23, §5.2.C and §3.21):
 * Swiss-type turning is a distinct sub-class of CNC turning specialized for
 * SUB-MILLIMETER PRECISION on small parts (medical screws, dental
 * implants, electronics connectors, micro fasteners). Key differences from
 * standard CNC turning:
 *
 *   - Maximum stock diameter ≤32mm (limited by guide-bushing bore size).
 *   - Routine tolerance ±0.0005in / ±0.013mm (10x tighter than precision-
 *     class on a standard lathe).
 *   - Live tooling (cross-axis milling, gang tools) typical.
 *   - Single-part-per-cycle cycle times measured in tens of seconds; very
 *     high throughput on long bar stock.
 *   - Premium base pricing reflecting the specialty machine class
 *     (typically Citizen, Star, Tornos).
 *
 * Status: SCAFFOLD ONLY.
 *
 * The full Swiss template requires a separate sub-mm pricing model (live-
 * tool premiums, gang-tool count, sub-spindle ops, guide-bushing setup
 * fees, deburr-by-tumble vs hand) that wasn't captured at the same
 * fidelity in the 2026-05-23 catalog scan. Implementer-golf-2 ships this
 * scaffold to (a) reserve the capabilityType in the registry, (b) document
 * the shape that the full template will take, and (c) give downstream
 * consumers a non-null template to resolve against (graceful degradation
 * to the cnc-turning template's parameter set with a Swiss-class chuck
 * pre-selected).
 *
 * TODO (Tier-1 follow-up): expand into a full parameter surface. See
 * ai/research/manufacturing-capability-catalog-2026-05-23.md §3.21
 * (Xometry Swiss-Type Turning deep dive) for the parameter list.
 *
 * Author: implementer-golf-2, 2026-05-23
 */

import type { CapabilityTemplate } from "@pcc/spec";

export const cncSwissTemplate: CapabilityTemplate = {
  capabilityType: "cnc-swiss",
  version: "0.1",
  name: "CNC Swiss-Type Turning",
  description:
    "Sub-millimeter precision turning of small-diameter (≤32mm) parts. Specialty machine class for medical, dental, electronics. Routine ±0.0005in tolerance. SCAFFOLD: full parameter surface lands in a follow-up template revision.",
  params: [
    // ── 1. Material (subset of CNC-turning materials — round bar stock only,
    //      typically medical/electronics-grade) ──
    {
      type: "enum",
      key: "material",
      label: "Material",
      description: "Round bar stock material. Sub-mm precision class.",
      required: true,
      order: 1,
      group: "Material",
      options: [
        { value: "stainless-303", label: "Stainless 303 (free-machining)" },
        {
          value: "stainless-304",
          label: "Stainless 304",
          pricingImpact: { mode: "percent", value: "30", label: "+30% SS304" },
        },
        {
          value: "stainless-316",
          label: "Stainless 316 (marine / biocompatible)",
          pricingImpact: { mode: "percent", value: "40", label: "+40% SS316" },
        },
        {
          value: "stainless-17-4-ph",
          label: "Stainless 17-4 PH",
          pricingImpact: { mode: "percent", value: "45", label: "+45% 17-4 PH" },
        },
        { value: "brass-360", label: "Brass C360 (electronics connectors)" },
        {
          value: "titanium-grade-5",
          label: "Titanium Grade 5 (medical implants)",
          pricingImpact: { mode: "percent", value: "150", label: "+150% titanium" },
        },
        {
          value: "peek",
          label: "PEEK (medical / dental)",
          pricingImpact: { mode: "percent", value: "100", label: "+100% PEEK" },
        },
      ],
    },

    // ── 2. Outer diameter (Swiss envelope: ≤32mm) ──
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
      required: true,
      order: 3,
      group: "Geometry",
      min: 1,
      max: 300,
      step: 0.1,
      unit: "mm",
    },

    // ── 4. Tolerance class (sub-mm precision — minimum is fine-class) ──
    {
      type: "enum",
      key: "toleranceClass",
      label: "Tolerance Class",
      description: "Swiss baseline is precision (±0.001in). Ultra is ±0.0005in (sub-mm precision).",
      required: true,
      order: 4,
      group: "Quality",
      defaultValue: "precision",
      options: [
        { value: "precision", label: "Precision (±0.001in / ±0.025mm)" },
        {
          value: "ultra-precision",
          label: "Ultra-Precision (±0.0005in / ±0.013mm)",
          pricingImpact: { mode: "percent", value: "40", label: "+40% ultra-precision (sub-mm)" },
        },
      ],
    },

    // ── 5. Quantity (Swiss shops typically priced for 100+ unit runs) ──
    {
      type: "number",
      key: "quantity",
      label: "Quantity",
      description: "Swiss is optimized for medium-to-high volume (100-100K parts).",
      required: true,
      order: 5,
      group: "Order",
      min: 1,
      max: 100000,
      step: 1,
      defaultValue: 100,
    },

    // ── 6. Certifications (medical / dental / electronics) ──
    {
      type: "enum",
      key: "certifications",
      label: "Certifications Required",
      description: "References the canonical CertificationSpec registry by id.",
      required: false,
      order: 6,
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
        { value: "rohs", label: "RoHS" },
      ],
    },
  ],

  constraints: [
    // TODO: full constraint surface (live-tool feasibility, sub-spindle
    // op compatibility, guide-bushing setup-fee tiers) lands in the
    // follow-up revision.
  ],

  basePricingHints: {
    basePrice: "120.00",
    currency: "USDC",
    perUnitLabel: "per part (Swiss premium)",
  },
};
