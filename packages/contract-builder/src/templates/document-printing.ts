/**
 * Document Printing capability template.
 *
 * 6 parameters in 3 groups + quantity:
 *   Paper: paperSize, paperType
 *   Print Settings: colorMode, duplex, quality
 *   Order: quantity (pages)
 */

import type { CapabilityTemplate } from "@pcc/spec";

export const documentPrintingTemplate: CapabilityTemplate = {
  capabilityType: "document-printing",
  version: "1.0",
  name: "Document Printing",
  description: "Black-and-white or color document printing on standard paper sizes",
  params: [
    // ── Paper Group ──
    {
      type: "enum",
      key: "paperSize",
      label: "Paper Size",
      description: "Standard paper size for the print job",
      required: true,
      order: 1,
      group: "Paper",
      options: [
        { value: "letter", label: "Letter (8.5×11\")" },
        { value: "legal", label: "Legal (8.5×14\")", pricingImpact: { mode: "percent", value: "20", label: "+20% for legal" } },
        { value: "a4", label: "A4 (210×297mm)" },
        { value: "a3", label: "A3 (297×420mm)", pricingImpact: { mode: "percent", value: "50", label: "+50% for A3" } },
        { value: "tabloid", label: "Tabloid (11×17\")", pricingImpact: { mode: "percent", value: "60", label: "+60% for tabloid" } },
      ],
    },
    {
      type: "enum",
      key: "paperType",
      label: "Paper Type",
      description: "Paper stock type",
      required: false,
      order: 2,
      group: "Paper",
      defaultValue: "plain",
      options: [
        { value: "plain", label: "Plain Paper" },
        { value: "cardstock", label: "Card Stock", pricingImpact: { mode: "percent", value: "30", label: "+30% for card stock" } },
        { value: "photo", label: "Photo Paper", pricingImpact: { mode: "percent", value: "100", label: "+100% for photo paper" } },
        { value: "glossy", label: "Glossy", pricingImpact: { mode: "percent", value: "50", label: "+50% for glossy" } },
        { value: "recycled", label: "Recycled" },
      ],
    },
    // ── Print Settings Group ──
    {
      type: "enum",
      key: "colorMode",
      label: "Color Mode",
      description: "Black-and-white or full color",
      required: true,
      order: 3,
      group: "Print Settings",
      options: [
        { value: "bw", label: "Black & White" },
        { value: "color", label: "Color", pricingImpact: { mode: "percent", value: "100", label: "+100% for color" } },
        { value: "grayscale", label: "Grayscale", pricingImpact: { mode: "percent", value: "20", label: "+20% for grayscale" } },
      ],
    },
    {
      type: "enum",
      key: "duplex",
      label: "Duplex",
      description: "Single-sided or double-sided printing",
      required: false,
      order: 4,
      group: "Print Settings",
      defaultValue: "single",
      options: [
        { value: "single", label: "Single-Sided" },
        { value: "long-edge", label: "Double-Sided (Long Edge)" },
        { value: "short-edge", label: "Double-Sided (Short Edge)" },
      ],
    },
    {
      type: "enum",
      key: "quality",
      label: "Print Quality",
      description: "Print resolution / quality level",
      required: false,
      order: 5,
      group: "Print Settings",
      defaultValue: "standard",
      options: [
        { value: "draft", label: "Draft (300dpi)", pricingImpact: { mode: "percent", value: "-30", label: "-30% for draft" } },
        { value: "standard", label: "Standard (600dpi)" },
        { value: "high", label: "High Quality (1200dpi)", pricingImpact: { mode: "percent", value: "30", label: "+30% for high quality" } },
      ],
    },
    // ── Order Group ──
    {
      type: "number",
      key: "quantity",
      label: "Pages",
      description: "Number of pages to print",
      required: true,
      order: 6,
      group: "Order",
      min: 1,
      max: 10000,
      step: 1,
      defaultValue: 1,
    },
  ],
  basePricingHints: {
    basePrice: "0.10",
    currency: "USDC",
    perUnitLabel: "per page",
  },
};
