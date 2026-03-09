/**
 * SLA (Stereolithography) capability template.
 *
 * 8 parameters: resin, layerHeight, orientation, supports, hollowing, curing, postProcessing, quantity
 */

import type { CapabilityTemplate } from "@pcc/spec";

export const slaTemplate: CapabilityTemplate = {
  capabilityType: "sla",
  version: "1.0",
  name: "SLA Resin Printing",
  description: "Stereolithography — UV-cured liquid resin for high-detail parts",
  params: [
    {
      type: "enum",
      key: "resin",
      label: "Resin Type",
      description: "Type of photopolymer resin",
      required: true,
      order: 1,
      group: "Material",
      options: [
        { value: "standard", label: "Standard", description: "General purpose, good detail" },
        { value: "tough", label: "Tough Resin", description: "ABS-like toughness", pricingImpact: { mode: "percent", value: "20", label: "+20% tough resin" } },
        { value: "flexible", label: "Flexible Resin", description: "Rubber-like flexibility", pricingImpact: { mode: "percent", value: "25", label: "+25% flexible resin" } },
        { value: "castable", label: "Castable Resin", description: "Burns out cleanly for investment casting", pricingImpact: { mode: "percent", value: "30", label: "+30% castable resin" } },
        { value: "dental", label: "Dental Resin", description: "Biocompatible, FDA-cleared", pricingImpact: { mode: "percent", value: "50", label: "+50% dental resin" } },
        { value: "high-temp", label: "High Temperature", description: "Heat-resistant up to 238°C", pricingImpact: { mode: "percent", value: "35", label: "+35% high-temp resin" } },
      ],
    },
    {
      type: "enum",
      key: "layerHeight",
      label: "Layer Height",
      description: "Vertical resolution — lower = finer detail but slower",
      required: true,
      order: 2,
      group: "Print Settings",
      defaultValue: "0.050",
      options: [
        { value: "0.025", label: "0.025mm (Ultra Fine)", pricingImpact: { mode: "multiplier", value: "2.0", label: "2.0x (ultra fine)" } },
        { value: "0.050", label: "0.050mm (Fine)", pricingImpact: { mode: "multiplier", value: "1.0", label: "1.0x (standard)" } },
        { value: "0.100", label: "0.100mm (Fast)", pricingImpact: { mode: "multiplier", value: "0.7", label: "0.7x (fast)" } },
      ],
    },
    {
      type: "enum",
      key: "orientation",
      label: "Print Orientation",
      description: "How the part is oriented on the build plate",
      required: false,
      order: 3,
      group: "Print Settings",
      defaultValue: "auto",
      options: [
        { value: "auto", label: "Auto (Optimized)", description: "Software picks best orientation" },
        { value: "flat", label: "Flat on Plate", description: "Fastest, least supports" },
        { value: "angled", label: "45° Angle", description: "Good balance of speed and quality" },
        { value: "vertical", label: "Vertical", description: "Best for tall thin parts" },
      ],
    },
    {
      type: "boolean",
      key: "supports",
      label: "Support Structures",
      description: "Auto-generated support structures",
      required: false,
      order: 4,
      group: "Print Settings",
      defaultValue: true,
      pricingImpact: { mode: "percent", value: "10", label: "+10% for supports" },
    },
    {
      type: "boolean",
      key: "hollowing",
      label: "Hollow Part",
      description: "Hollow out the interior to save resin and reduce cost",
      required: false,
      order: 5,
      group: "Print Settings",
      defaultValue: false,
      pricingImpact: { mode: "percent", value: "-20", label: "-20% (hollow = less resin)" },
    },
    {
      type: "enum",
      key: "curing",
      label: "Post-Cure",
      description: "UV post-curing for final material properties",
      required: false,
      order: 6,
      group: "Post-Processing",
      defaultValue: "standard",
      options: [
        { value: "standard", label: "Standard Cure", description: "60 min UV at 60°C" },
        { value: "extended", label: "Extended Cure", description: "120 min for maximum strength", pricingImpact: { mode: "flat", value: "5.00", label: "+$5 extended cure" } },
        { value: "none", label: "No Post-Cure", description: "Green state only (not recommended)" },
      ],
    },
    {
      type: "enum",
      key: "postProcessing",
      label: "Post-Processing",
      description: "Optional finishing steps",
      required: false,
      order: 7,
      group: "Post-Processing",
      multi: true,
      defaultValue: "none",
      options: [
        { value: "none", label: "None" },
        { value: "sanding", label: "Sanding", pricingImpact: { mode: "flat", value: "10.00", label: "+$10 sanding" } },
        { value: "painting", label: "Painting", pricingImpact: { mode: "flat", value: "25.00", label: "+$25 painting" } },
        { value: "dyeing", label: "Dyeing", description: "Dye the part a specific color", pricingImpact: { mode: "flat", value: "8.00", label: "+$8 dyeing" } },
      ],
    },
    {
      type: "number",
      key: "quantity",
      label: "Quantity",
      description: "Number of units",
      required: true,
      order: 8,
      group: "Order",
      min: 1,
      max: 500,
      step: 1,
      defaultValue: 1,
    },
  ],

  constraints: [
    // Castable resin should not be hollowed (investment casting needs solid)
    {
      when: { param: "resin", equals: "castable" },
      then: [{ param: "hollowing", restrictTo: [] }],
    },
  ],

  basePricingHints: {
    basePrice: "25.00",
    currency: "USDC",
    perUnitLabel: "per part",
  },
};
