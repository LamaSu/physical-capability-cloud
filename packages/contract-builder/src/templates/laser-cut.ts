/**
 * Laser Cutting capability template.
 *
 * 7 parameters: material, sheetThickness, cutType, engraving, edgeFinish, quantity
 */

import type { CapabilityTemplate } from "@pcc/spec";

export const laserCutTemplate: CapabilityTemplate = {
  capabilityType: "laser-cut",
  version: "1.0",
  name: "Laser Cutting",
  description: "Precision 2D cutting and engraving with CO2 or fiber laser",
  params: [
    {
      type: "enum",
      key: "material",
      label: "Material",
      description: "Sheet material to cut",
      required: true,
      order: 1,
      group: "Material",
      options: [
        { value: "acrylic", label: "Acrylic", description: "Clear or colored sheets" },
        { value: "plywood", label: "Plywood", description: "Birch or bamboo plywood" },
        { value: "mdf", label: "MDF", description: "Medium-density fiberboard" },
        { value: "steel-mild", label: "Mild Steel", pricingImpact: { mode: "percent", value: "30", label: "+30% for steel" } },
        { value: "steel-stainless", label: "Stainless Steel", pricingImpact: { mode: "percent", value: "50", label: "+50% for stainless" } },
        { value: "aluminum", label: "Aluminum", pricingImpact: { mode: "percent", value: "25", label: "+25% for aluminum" } },
        { value: "leather", label: "Leather", pricingImpact: { mode: "percent", value: "15", label: "+15% for leather" } },
        { value: "fabric", label: "Fabric", description: "Cotton, polyester, felt" },
      ],
    },
    {
      type: "enum",
      key: "sheetThickness",
      label: "Sheet Thickness",
      description: "Material thickness",
      required: true,
      order: 2,
      group: "Material",
      defaultValue: "3mm",
      options: [
        { value: "1mm", label: "1mm" },
        { value: "2mm", label: "2mm" },
        { value: "3mm", label: "3mm" },
        { value: "5mm", label: "5mm", pricingImpact: { mode: "percent", value: "10", label: "+10% thicker stock" } },
        { value: "6mm", label: "6mm", pricingImpact: { mode: "percent", value: "20", label: "+20% thicker stock" } },
        { value: "10mm", label: "10mm", pricingImpact: { mode: "percent", value: "40", label: "+40% thick stock" } },
        { value: "12mm", label: "12mm", pricingImpact: { mode: "percent", value: "60", label: "+60% thick stock" } },
      ],
    },
    {
      type: "enum",
      key: "cutType",
      label: "Cut Type",
      description: "Type of laser operation",
      required: true,
      order: 3,
      group: "Cut Settings",
      defaultValue: "through-cut",
      options: [
        { value: "through-cut", label: "Through Cut", description: "Cut all the way through" },
        { value: "kiss-cut", label: "Kiss Cut", description: "Cut through top layer only (stickers/labels)" },
        { value: "score", label: "Score/Etch", description: "Surface mark without cutting through", pricingImpact: { mode: "percent", value: "-20", label: "-20% (scoring only)" } },
      ],
    },
    {
      type: "boolean",
      key: "engraving",
      label: "Engraving",
      description: "Add raster engraving (logos, text, patterns)",
      required: false,
      order: 4,
      group: "Cut Settings",
      defaultValue: false,
      pricingImpact: { mode: "flat", value: "15.00", label: "+$15 engraving" },
    },
    {
      type: "enum",
      key: "edgeFinish",
      label: "Edge Finish",
      description: "How to treat cut edges",
      required: false,
      order: 5,
      group: "Post-Processing",
      defaultValue: "as-cut",
      options: [
        { value: "as-cut", label: "As Cut", description: "Raw laser-cut edge" },
        { value: "flame-polished", label: "Flame Polished", description: "Smooth transparent edges (acrylic)", pricingImpact: { mode: "flat", value: "8.00", label: "+$8 flame polish" } },
        { value: "sanded", label: "Sanded", pricingImpact: { mode: "flat", value: "5.00", label: "+$5 sanding" } },
        { value: "painted", label: "Edge Painted", pricingImpact: { mode: "flat", value: "12.00", label: "+$12 edge painting" } },
      ],
    },
    {
      type: "number",
      key: "quantity",
      label: "Quantity",
      description: "Number of pieces",
      required: true,
      order: 6,
      group: "Order",
      min: 1,
      max: 5000,
      step: 1,
      defaultValue: 1,
    },
  ],

  constraints: [
    // Flame polishing only works on acrylic
    {
      when: { param: "material", in: ["plywood", "mdf", "steel-mild", "steel-stainless", "aluminum", "leather", "fabric"] },
      then: [{ param: "edgeFinish", exclude: ["flame-polished"] }],
    },
    // Metals are limited to thinner sheets on CO2 laser
    {
      when: { param: "material", in: ["steel-mild", "steel-stainless", "aluminum"] },
      then: [{ param: "sheetThickness", restrictTo: ["1mm", "2mm", "3mm", "5mm", "6mm"] }],
    },
    // Fabric/leather limited to thin sheets
    {
      when: { param: "material", in: ["leather", "fabric"] },
      then: [{ param: "sheetThickness", restrictTo: ["1mm", "2mm", "3mm"] }],
    },
  ],

  basePricingHints: {
    basePrice: "20.00",
    currency: "USDC",
    perUnitLabel: "per sheet",
  },
};
