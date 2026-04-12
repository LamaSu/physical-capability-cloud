/**
 * Data Extraction digital workflow template.
 *
 * A 3-step workflow: ingest_source -> extract_fields -> validate_output
 */

import type { CapabilityTemplate } from "@pcc/spec";

export const dataExtractionTemplate: CapabilityTemplate = {
  capabilityType: "data-extraction",
  version: "1.0",
  name: "Structured Data Extraction",
  description:
    "Extract structured data from unstructured sources -- PDFs, images, emails, or web pages into typed JSON records.",
  params: [
    {
      type: "enum",
      key: "sourceFormat",
      label: "Source Format",
      description: "Format of the input data",
      required: true,
      order: 1,
      group: "Input",
      options: [
        { value: "pdf", label: "PDF" },
        { value: "image", label: "Image (OCR)" },
        { value: "email", label: "Email" },
        { value: "html", label: "HTML / Web Page" },
        { value: "csv", label: "CSV / Spreadsheet" },
      ],
    },
    {
      type: "enum",
      key: "extractionMode",
      label: "Extraction Mode",
      description: "How fields should be extracted",
      required: true,
      order: 2,
      group: "Analysis",
      options: [
        { value: "template", label: "Template-Based", description: "Use predefined field schemas" },
        {
          value: "adaptive",
          label: "Adaptive",
          description: "LLM-assisted field discovery",
          pricingImpact: { mode: "percent", value: "40", label: "+40% for adaptive extraction" },
        },
      ],
    },
    {
      type: "number",
      key: "documentCount",
      label: "Document Count",
      description: "Number of documents to process",
      required: false,
      order: 3,
      group: "Input",
      min: 1,
      max: 10000,
      step: 1,
      defaultValue: 1,
      pricingImpact: { mode: "per_unit", value: "0.10", label: "$0.10 per document" },
    },
  ],
  basePricingHints: {
    basePrice: "2.00",
    currency: "USDC",
    perUnitLabel: "per extraction batch",
  },
};
