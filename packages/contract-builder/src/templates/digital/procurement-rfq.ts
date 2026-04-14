/**
 * Procurement RFQ digital workflow template.
 *
 * A 6-step workflow DAG for vendor RFQ analysis:
 *   parse_rfq -> filter_vendors -> solicit_quotes -> score_quotes -> select_vendor -> emit_report
 *
 * Each step produces a structured output and an evidence event.  The kernel
 * implementation (packages/kernel/src/digital/procurement-rfq-kernel.ts)
 * executes these steps deterministically so tests and E2E runs produce
 * identical bundleHashes for identical inputs.
 */

import type { CapabilityTemplate, DigitalWorkflowStep } from "@pcc/spec";

/** Pre-defined workflow steps for procurement RFQ analysis. */
export const procurementRfqWorkflowSteps: DigitalWorkflowStep[] = [
  {
    stepId: "parse_rfq",
    stepType: "transform",
    description:
      "Normalize the RFQ spec (item, quantity, specifications, deadline) into a canonical shape.",
    inputSchema: {
      type: "object",
      properties: {
        item: { type: "string" },
        quantity: { type: "number" },
        specifications: { type: "object" },
        deadline: { type: "string", format: "date" },
      },
      required: ["item", "quantity", "specifications", "deadline"],
    },
    outputSchema: {
      type: "object",
      properties: {
        item: { type: "string" },
        quantity: { type: "number" },
        specifications: { type: "object" },
        deadline: { type: "string" },
        requiredCapabilities: { type: "array", items: { type: "string" } },
      },
    },
    dependsOn: [],
    constraints: {
      maxDurationMs: 10000,
      maxRetries: 2,
      requiredEvidence: ["execution_trace"],
    },
  },
  {
    stepId: "filter_vendors",
    stepType: "transform",
    description:
      "Filter the vendor list down to those whose capabilities satisfy the RFQ specification keys.",
    inputSchema: {
      type: "object",
      properties: {
        requiredCapabilities: { type: "array", items: { type: "string" } },
        vendorList: { type: "array" },
      },
      required: ["requiredCapabilities", "vendorList"],
    },
    outputSchema: {
      type: "object",
      properties: {
        eligibleVendors: { type: "array" },
        excludedCount: { type: "number" },
      },
    },
    dependsOn: ["parse_rfq"],
    constraints: {
      maxDurationMs: 15000,
      maxRetries: 2,
      requiredEvidence: ["execution_trace"],
    },
  },
  {
    stepId: "solicit_quotes",
    stepType: "api_call",
    description:
      "Generate or collect quotes from each eligible vendor. Deterministic when no external API is wired.",
    inputSchema: {
      type: "object",
      properties: {
        eligibleVendors: { type: "array" },
        rfqHash: { type: "string" },
        rfq: { type: "object" },
      },
      required: ["eligibleVendors", "rfqHash", "rfq"],
    },
    outputSchema: {
      type: "object",
      properties: {
        quotes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              vendorId: { type: "string" },
              unitPrice: { type: "number" },
              totalPrice: { type: "number" },
              deliveryDays: { type: "number" },
              reputation: { type: "number" },
              complianceScore: { type: "number" },
            },
          },
        },
      },
    },
    dependsOn: ["filter_vendors"],
    constraints: {
      maxDurationMs: 60000,
      maxRetries: 3,
      requiredEvidence: ["execution_trace", "output_hash"],
    },
  },
  {
    stepId: "score_quotes",
    stepType: "transform",
    description:
      "Compute a weighted score per quote: 0.5*(1-priceNorm) + 0.3*deliverySpeed + 0.2*reputationNorm.",
    inputSchema: {
      type: "object",
      properties: {
        quotes: { type: "array" },
      },
      required: ["quotes"],
    },
    outputSchema: {
      type: "object",
      properties: {
        scoredQuotes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              vendorId: { type: "string" },
              score: { type: "number" },
              priceNorm: { type: "number" },
              deliverySpeed: { type: "number" },
              reputationNorm: { type: "number" },
            },
          },
        },
      },
    },
    dependsOn: ["solicit_quotes"],
    constraints: {
      maxDurationMs: 20000,
      maxRetries: 2,
      requiredEvidence: ["execution_trace", "output_hash"],
    },
  },
  {
    stepId: "select_vendor",
    stepType: "aggregate",
    description:
      "Pick the top-scoring vendor. Deterministic tie-break by lexicographic vendorId.",
    inputSchema: {
      type: "object",
      properties: {
        scoredQuotes: { type: "array" },
        quotes: { type: "array" },
      },
      required: ["scoredQuotes", "quotes"],
    },
    outputSchema: {
      type: "object",
      properties: {
        selectedVendorId: { type: "string" },
        selectedScore: { type: "number" },
        selectedQuote: { type: "object" },
        decisionNote: { type: "string" },
      },
    },
    dependsOn: ["score_quotes"],
    constraints: {
      maxDurationMs: 10000,
      maxRetries: 1,
      requiredEvidence: ["execution_trace"],
    },
  },
  {
    stepId: "emit_report",
    stepType: "aggregate",
    description:
      "Produce the structured RFQReport: rankings, selected vendor, PO-ready decision, status.",
    inputSchema: {
      type: "object",
      properties: {
        rfq: { type: "object" },
        scoredQuotes: { type: "array" },
        selectedVendorId: { type: "string" },
        selectedQuote: { type: "object" },
        decisionNote: { type: "string" },
        excludedCount: { type: "number" },
      },
      required: ["rfq", "scoredQuotes", "selectedVendorId"],
    },
    outputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        rankings: { type: "array" },
        selectedVendor: { type: "object" },
        purchaseOrder: { type: "object" },
        status: { type: "string", enum: ["awarded", "no-vendors", "single-vendor", "tied"] },
      },
    },
    dependsOn: ["select_vendor"],
    constraints: {
      maxDurationMs: 15000,
      maxRetries: 1,
      requiredEvidence: ["execution_trace", "output_hash"],
    },
  },
];

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
