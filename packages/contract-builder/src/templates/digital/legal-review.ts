/**
 * Legal Review digital workflow template.
 *
 * A 3-step workflow: ingest_document -> extract_clauses -> assess_risk
 */

import type { CapabilityTemplate } from "@pcc/spec";

export const legalReviewTemplate: CapabilityTemplate = {
  capabilityType: "legal-review",
  version: "1.0",
  name: "Legal Document Review",
  description:
    "Analyze contracts and legal documents -- extract key clauses, identify risks, and produce a structured compliance assessment.",
  params: [
    {
      type: "enum",
      key: "documentType",
      label: "Document Type",
      description: "Type of legal document being reviewed",
      required: true,
      order: 1,
      group: "Input",
      options: [
        { value: "contract", label: "Contract" },
        { value: "nda", label: "NDA" },
        { value: "sla", label: "SLA" },
        { value: "terms-of-service", label: "Terms of Service" },
        { value: "compliance-policy", label: "Compliance Policy" },
      ],
    },
    {
      type: "enum",
      key: "reviewDepth",
      label: "Review Depth",
      description: "How thorough the review should be",
      required: true,
      order: 2,
      group: "Analysis",
      options: [
        { value: "summary", label: "Summary", description: "Key clause extraction only" },
        {
          value: "standard",
          label: "Standard",
          description: "Clause extraction + risk flags",
        },
        {
          value: "deep",
          label: "Deep Review",
          description: "Full legal analysis with precedent references",
          pricingImpact: { mode: "percent", value: "100", label: "+100% for deep analysis" },
        },
      ],
    },
    {
      type: "number",
      key: "pageCount",
      label: "Estimated Pages",
      description: "Approximate document length in pages",
      required: false,
      order: 3,
      group: "Input",
      min: 1,
      max: 500,
      step: 1,
      defaultValue: 10,
      pricingImpact: { mode: "per_unit", value: "0.50", label: "$0.50 per page" },
    },
  ],
  basePricingHints: {
    basePrice: "10.00",
    currency: "USDC",
    perUnitLabel: "per document review",
  },
};
