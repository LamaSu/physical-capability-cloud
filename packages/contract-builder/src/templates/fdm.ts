/**
 * FDM (Fused Deposition Modeling) capability template.
 *
 * 9 parameters in 3 groups + quantity:
 *   Material: material, color
 *   Print Settings: infill, layerHeight, supports, supportType, wallCount
 *   Post-Processing: postProcessing
 *   Order: quantity
 */

import type { CapabilityTemplate } from "@pcc/spec";

export const fdmTemplate: CapabilityTemplate = {
  capabilityType: "fdm",
  version: "1.0",
  name: "FDM 3D Printing",
  description: "Fused Deposition Modeling — layer-by-layer thermoplastic extrusion",
  params: [
    // ── Material Group ──
    {
      type: "enum",
      key: "material",
      label: "Material",
      description: "Filament material for the print",
      required: true,
      order: 1,
      group: "Material",
      options: [
        { value: "pla", label: "PLA", description: "Easy to print, biodegradable, low strength" },
        { value: "petg", label: "PETG", description: "Good strength, chemical resistance, slight stringing" },
        { value: "abs", label: "ABS", description: "Strong, heat-resistant, requires enclosure", pricingImpact: { mode: "percent", value: "10", label: "+10% for ABS (enclosure required)" } },
        { value: "tpu", label: "TPU", description: "Flexible, rubber-like, slow printing", pricingImpact: { mode: "percent", value: "20", label: "+20% for TPU (slow print)" } },
        { value: "nylon", label: "Nylon", description: "Very strong, flexible, hygroscopic", pricingImpact: { mode: "percent", value: "25", label: "+25% for Nylon" } },
        { value: "pc", label: "Polycarbonate", description: "Extremely strong, heat-resistant", pricingImpact: { mode: "percent", value: "30", label: "+30% for PC" } },
        { value: "asa", label: "ASA", description: "UV-resistant ABS alternative, outdoor use", pricingImpact: { mode: "percent", value: "15", label: "+15% for ASA" } },
        { value: "cf-nylon", label: "Carbon Fiber Nylon", description: "Stiff, lightweight, abrasive on nozzles", pricingImpact: { mode: "percent", value: "40", label: "+40% for CF-Nylon" } },
      ],
    },
    {
      type: "enum",
      key: "color",
      label: "Color",
      description: "Filament color",
      required: false,
      order: 2,
      group: "Material",
      defaultValue: "black",
      options: [
        { value: "black", label: "Black" },
        { value: "white", label: "White" },
        { value: "gray", label: "Gray" },
        { value: "red", label: "Red" },
        { value: "blue", label: "Blue" },
        { value: "green", label: "Green" },
        { value: "orange", label: "Orange" },
        { value: "natural", label: "Natural/Translucent" },
      ],
    },

    // ── Print Settings Group ──
    {
      type: "number",
      key: "infill",
      label: "Infill Density",
      description: "Internal fill percentage — higher = stronger but heavier and slower",
      required: true,
      order: 3,
      group: "Print Settings",
      min: 5,
      max: 100,
      step: 5,
      unit: "%",
      defaultValue: 20,
      pricingImpact: { mode: "per_unit", value: "0.01", label: "+$0.01 per 1% infill" },
    },
    {
      type: "enum",
      key: "layerHeight",
      label: "Layer Height",
      description: "Vertical resolution — lower = smoother surface but slower print",
      required: true,
      order: 4,
      group: "Print Settings",
      defaultValue: "0.20",
      options: [
        { value: "0.10", label: "0.10mm (Ultra Fine)", pricingImpact: { mode: "multiplier", value: "1.8", label: "1.8x (ultra fine layers)" } },
        { value: "0.15", label: "0.15mm (Fine)", pricingImpact: { mode: "multiplier", value: "1.4", label: "1.4x (fine layers)" } },
        { value: "0.20", label: "0.20mm (Standard)", pricingImpact: { mode: "multiplier", value: "1.0", label: "1.0x (standard)" } },
        { value: "0.30", label: "0.30mm (Draft)", pricingImpact: { mode: "multiplier", value: "0.7", label: "0.7x (fast draft)" } },
      ],
    },
    {
      type: "boolean",
      key: "supports",
      label: "Support Structures",
      description: "Enable support structures for overhangs",
      required: false,
      order: 5,
      group: "Print Settings",
      defaultValue: false,
      pricingImpact: { mode: "percent", value: "15", label: "+15% for supports" },
    },
    {
      type: "enum",
      key: "supportType",
      label: "Support Type",
      description: "Type of support structure",
      required: false,
      order: 6,
      group: "Print Settings",
      defaultValue: "normal",
      visibleWhen: { param: "supports", equals: true },
      options: [
        { value: "normal", label: "Normal", description: "Standard grid supports" },
        { value: "tree", label: "Tree Supports", description: "Branch-like, less scarring", pricingImpact: { mode: "flat", value: "2.00", label: "+$2 tree supports" } },
        { value: "organic", label: "Organic Supports", description: "Smooth organic shapes, best surface quality" },
      ],
    },
    {
      type: "number",
      key: "wallCount",
      label: "Wall Count",
      description: "Number of perimeter walls — more walls = stronger shell",
      required: false,
      order: 7,
      group: "Print Settings",
      min: 1,
      max: 8,
      step: 1,
      defaultValue: 3,
    },

    // ── Post-Processing Group ──
    {
      type: "enum",
      key: "postProcessing",
      label: "Post-Processing",
      description: "Optional finishing steps after printing",
      required: false,
      order: 8,
      group: "Post-Processing",
      multi: true,
      defaultValue: "none",
      options: [
        { value: "none", label: "None" },
        { value: "sanding", label: "Sanding", description: "Sand smooth to remove layer lines", pricingImpact: { mode: "flat", value: "10.00", label: "+$10 sanding" } },
        { value: "vapor-smoothing", label: "Vapor Smoothing", description: "Chemical vapor bath for glossy finish (ABS/ASA only)", pricingImpact: { mode: "flat", value: "15.00", label: "+$15 vapor smoothing" } },
        { value: "painting", label: "Painting", description: "Prime and paint to desired color", pricingImpact: { mode: "flat", value: "25.00", label: "+$25 painting" } },
        { value: "heat-inserts", label: "Heat-Set Inserts", description: "Install threaded brass inserts", pricingImpact: { mode: "flat", value: "5.00", label: "+$5 heat-set inserts" } },
      ],
    },

    // ── Order ──
    {
      type: "number",
      key: "quantity",
      label: "Quantity",
      description: "Number of units to print",
      required: true,
      order: 9,
      group: "Order",
      min: 1,
      max: 1000,
      step: 1,
      defaultValue: 1,
    },
  ],

  constraints: [
    // PLA cannot do vapor smoothing
    {
      when: { param: "material", equals: "pla" },
      then: [{ param: "postProcessing", exclude: ["vapor-smoothing"] }],
    },
    // PETG cannot do vapor smoothing
    {
      when: { param: "material", equals: "petg" },
      then: [{ param: "postProcessing", exclude: ["vapor-smoothing"] }],
    },
    // TPU restricted to normal supports only
    {
      when: { param: "material", equals: "tpu" },
      then: [{ param: "supportType", restrictTo: ["normal"] }],
    },
    // High infill restricts layer height to 0.2mm+ (too slow otherwise)
    {
      when: { param: "infill", gt: 80 },
      then: [{ param: "layerHeight", restrictTo: ["0.20", "0.30"] }],
    },
  ],

  basePricingHints: {
    basePrice: "15.00",
    currency: "USDC",
    perUnitLabel: "per part",
  },
};
