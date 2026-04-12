/**
 * Procurement RFQ digital workflow template.
 *
 * A 3-step workflow: gather_requirements -> compare_quotes -> emit_recommendation
 */

import type { CapabilityTemplate } from "@pcc/spec";

export const procurementRfqTemplate: CapabilityTemplate = {
  capabilityType: "procurement-rfq",
  version: "1.0",
  name: "Procurement RFQ Analysis",
  description:
    "Analyze vendor quotes for a procurement request -- compare pricing, lead times, quality scores, and produce a ranked recommendation.",
  params: [
    {
      type: "number",
      key: "quoteCount",
      label: "Number of Quotes",
      description: "How many vendor quotes to compare",
      required: true,
      order: 1,
      group: "Input",
      min: 2,
      max: 50,
      step: 1,
      defaultValue: 3,
    },
    {
      type: "enum",
      key: "scoringModel",
      label: "Scoring Model",
      description: "Weighting model for vendor comparison",
      required: true,
      order: 2,
      group: "Analysis",
      options: [
        { value: "price-first", label: "Price First", description: "Weight price at 60%" },
        {
          value: "balanced",
          label: "Balanced",
          description: "Equal weight across price, lead time, quality",
        },
        {
          value: "quality-first",
          label: "Quality First",
          description: "Weight quality at 60%",
          pricingImpact: { mode: "percent", value: "25", label: "+25% for deeper analysis" },
        },
      ],
    },
    {
      type: "string",
      key: "currencyCode",
      label: "Currency",
      description: "Currency for price comparison",
      required: false,
      order: 3,
      group: "Input",
      defaultValue: "USD",
    },
  ],
  basePricingHints: {
    basePrice: "3.00",
    currency: "USDC",
    perUnitLabel: "per RFQ analysis",
  },
};
