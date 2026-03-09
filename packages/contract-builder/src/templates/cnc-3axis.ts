/**
 * CNC 3-Axis Milling capability template.
 *
 * 8 parameters: material, tolerance, surfaceFinish, deburring, threadInserts, coolant, quantity
 */

import type { CapabilityTemplate } from "@pcc/spec";

export const cnc3AxisTemplate: CapabilityTemplate = {
  capabilityType: "cnc-3axis",
  version: "1.0",
  name: "CNC 3-Axis Milling",
  description: "Subtractive manufacturing — 3-axis milling of metals and plastics",
  params: [
    {
      type: "enum",
      key: "material",
      label: "Material",
      description: "Stock material for machining",
      required: true,
      order: 1,
      group: "Material",
      options: [
        { value: "aluminum-6061", label: "Aluminum 6061-T6", description: "General purpose, easy to machine" },
        { value: "aluminum-7075", label: "Aluminum 7075-T6", description: "Aerospace grade, stronger", pricingImpact: { mode: "percent", value: "15", label: "+15% for 7075" } },
        { value: "steel-1018", label: "Steel 1018", description: "Low carbon, easy to machine", pricingImpact: { mode: "percent", value: "20", label: "+20% for steel" } },
        { value: "steel-4140", label: "Steel 4140", description: "Alloy steel, heat treatable", pricingImpact: { mode: "percent", value: "35", label: "+35% for 4140" } },
        { value: "stainless-304", label: "Stainless 304", description: "Corrosion resistant, work-hardens", pricingImpact: { mode: "percent", value: "40", label: "+40% for SS304" } },
        { value: "stainless-316", label: "Stainless 316", description: "Marine grade, excellent corrosion resistance", pricingImpact: { mode: "percent", value: "50", label: "+50% for SS316" } },
        { value: "brass", label: "Brass C360", description: "Free-machining, decorative", pricingImpact: { mode: "percent", value: "10", label: "+10% for brass" } },
        { value: "copper", label: "Copper C101", description: "High conductivity", pricingImpact: { mode: "percent", value: "25", label: "+25% for copper" } },
        { value: "delrin", label: "Delrin (POM)", description: "Engineering plastic, excellent machinability" },
        { value: "nylon-6", label: "Nylon 6", description: "Tough engineering plastic" },
        { value: "peek", label: "PEEK", description: "High-performance polymer", pricingImpact: { mode: "percent", value: "100", label: "+100% for PEEK" } },
      ],
    },
    {
      type: "enum",
      key: "tolerance",
      label: "Tolerance",
      description: "Dimensional accuracy requirement",
      required: true,
      order: 2,
      group: "Machining",
      defaultValue: "standard",
      options: [
        { value: "standard", label: "Standard (±0.13mm / ±0.005\")", description: "Good for most applications" },
        { value: "precision", label: "Precision (±0.05mm / ±0.002\")", pricingImpact: { mode: "percent", value: "25", label: "+25% precision tolerance" } },
        { value: "high-precision", label: "High Precision (±0.025mm / ±0.001\")", pricingImpact: { mode: "percent", value: "50", label: "+50% high precision" } },
      ],
    },
    {
      type: "enum",
      key: "surfaceFinish",
      label: "Surface Finish",
      description: "Required surface quality",
      required: false,
      order: 3,
      group: "Machining",
      defaultValue: "as-machined",
      options: [
        { value: "as-machined", label: "As Machined (Ra 3.2)", description: "Standard mill finish" },
        { value: "fine", label: "Fine (Ra 1.6)", pricingImpact: { mode: "percent", value: "15", label: "+15% fine finish" } },
        { value: "mirror", label: "Mirror (Ra 0.4)", pricingImpact: { mode: "percent", value: "40", label: "+40% mirror finish" } },
        { value: "bead-blast", label: "Bead Blasted", description: "Uniform matte texture", pricingImpact: { mode: "flat", value: "10.00", label: "+$10 bead blast" } },
        { value: "anodized", label: "Anodized (Aluminum Only)", pricingImpact: { mode: "flat", value: "20.00", label: "+$20 anodizing" } },
      ],
    },
    {
      type: "boolean",
      key: "deburring",
      label: "Deburring",
      description: "Remove sharp edges and burrs after machining",
      required: false,
      order: 4,
      group: "Post-Processing",
      defaultValue: true,
      pricingImpact: { mode: "flat", value: "5.00", label: "+$5 deburring" },
    },
    {
      type: "boolean",
      key: "threadInserts",
      label: "Threaded Holes",
      description: "Add threaded holes per drawing specifications",
      required: false,
      order: 5,
      group: "Post-Processing",
      defaultValue: false,
      pricingImpact: { mode: "flat", value: "8.00", label: "+$8 threading" },
    },
    {
      type: "enum",
      key: "coolant",
      label: "Coolant Type",
      description: "Coolant strategy during machining",
      required: false,
      order: 6,
      group: "Machining",
      defaultValue: "flood",
      options: [
        { value: "flood", label: "Flood Coolant", description: "Standard liquid coolant" },
        { value: "mist", label: "Mist Coolant", description: "Less coolant, some materials preferred" },
        { value: "dry", label: "Dry Machining", description: "No coolant (plastics, some aluminum)" },
      ],
    },
    {
      type: "number",
      key: "quantity",
      label: "Quantity",
      description: "Number of parts",
      required: true,
      order: 7,
      group: "Order",
      min: 1,
      max: 500,
      step: 1,
      defaultValue: 1,
    },
  ],

  constraints: [
    // Anodizing only works on aluminum
    {
      when: { param: "material", in: ["steel-1018", "steel-4140", "stainless-304", "stainless-316", "brass", "copper", "delrin", "nylon-6", "peek"] },
      then: [{ param: "surfaceFinish", exclude: ["anodized"] }],
    },
    // Plastics should use dry machining
    {
      when: { param: "material", in: ["delrin", "nylon-6", "peek"] },
      then: [{ param: "coolant", restrictTo: ["dry", "mist"] }],
    },
  ],

  basePricingHints: {
    basePrice: "75.00",
    currency: "USDC",
    perUnitLabel: "per part",
  },
};
