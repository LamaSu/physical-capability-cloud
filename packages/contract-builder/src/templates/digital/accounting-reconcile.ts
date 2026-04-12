/**
 * Accounting Reconciliation digital workflow template.
 *
 * A 5-step workflow DAG that reconciles a general ledger against bank statements:
 *   fetch_ledger → parse_entries ─┐
 *                                  ├→ match_invoices → compute_adjustments → emit_report
 *   (both depend on nothing)     ─┘
 *
 * Template parameters expose the same CapabilityTemplate shape as physical
 * templates so they plug into the existing registry and resolver pipeline.
 * The workflowSteps are generated at build time by the builder.
 */

import type { CapabilityTemplate } from "@pcc/spec";
import type { DigitalWorkflowStep } from "@pcc/spec";

/** Pre-defined workflow steps for accounting reconciliation */
export const accountingReconcileWorkflowSteps: DigitalWorkflowStep[] = [
  {
    stepId: "fetch_ledger",
    stepType: "api_call",
    description: "Retrieve general ledger entries for the specified period",
    inputSchema: {
      type: "object",
      properties: {
        ledgerSource: { type: "string", description: "Ledger system identifier or URL" },
        periodStart: { type: "string", format: "date" },
        periodEnd: { type: "string", format: "date" },
        currencyCode: { type: "string" },
      },
      required: ["ledgerSource", "periodStart", "periodEnd"],
    },
    outputSchema: {
      type: "object",
      properties: {
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              date: { type: "string" },
              description: { type: "string" },
              amount: { type: "number" },
              account: { type: "string" },
              reference: { type: "string" },
            },
          },
        },
        totalEntries: { type: "number" },
      },
    },
    dependsOn: [],
    constraints: {
      maxDurationMs: 30000,
      maxRetries: 3,
      requiredEvidence: ["execution_trace"],
    },
  },
  {
    stepId: "parse_entries",
    stepType: "transform",
    description: "Parse and normalize bank statement entries into a common format",
    inputSchema: {
      type: "object",
      properties: {
        statementSource: { type: "string", description: "Bank statement file or API endpoint" },
        format: { type: "string", enum: ["csv", "ofx", "pdf", "json"] },
      },
      required: ["statementSource"],
    },
    outputSchema: {
      type: "object",
      properties: {
        transactions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              date: { type: "string" },
              description: { type: "string" },
              amount: { type: "number" },
              reference: { type: "string" },
              bankCode: { type: "string" },
            },
          },
        },
        totalTransactions: { type: "number" },
      },
    },
    dependsOn: [],
    constraints: {
      maxDurationMs: 60000,
      maxRetries: 2,
      requiredEvidence: ["execution_trace"],
    },
  },
  {
    stepId: "match_invoices",
    stepType: "llm_call",
    description: "Match ledger entries against bank transactions using configured matching strategy",
    inputSchema: {
      type: "object",
      properties: {
        ledgerEntries: { type: "array" },
        bankTransactions: { type: "array" },
        matchingStrategy: { type: "string", enum: ["strict", "fuzzy", "ml-assisted"] },
        toleranceAmount: { type: "number", description: "Maximum difference to consider a match" },
      },
      required: ["ledgerEntries", "bankTransactions", "matchingStrategy"],
    },
    outputSchema: {
      type: "object",
      properties: {
        matched: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ledgerEntry: { type: "object" },
              bankTransaction: { type: "object" },
              confidence: { type: "number" },
            },
          },
        },
        unmatchedLedger: { type: "array" },
        unmatchedBank: { type: "array" },
        matchRate: { type: "number" },
      },
    },
    dependsOn: ["fetch_ledger", "parse_entries"],
    constraints: {
      maxDurationMs: 120000,
      maxRetries: 2,
      requiredEvidence: ["execution_trace", "output_hash"],
    },
  },
  {
    stepId: "compute_adjustments",
    stepType: "transform",
    description: "Compute required accounting adjustments from unmatched entries",
    inputSchema: {
      type: "object",
      properties: {
        unmatchedLedger: { type: "array" },
        unmatchedBank: { type: "array" },
        currencyCode: { type: "string" },
      },
      required: ["unmatchedLedger", "unmatchedBank"],
    },
    outputSchema: {
      type: "object",
      properties: {
        adjustments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["debit", "credit"] },
              amount: { type: "number" },
              account: { type: "string" },
              reason: { type: "string" },
            },
          },
        },
        totalVariance: { type: "number" },
        varianceByCurrency: { type: "object" },
      },
    },
    dependsOn: ["match_invoices"],
    constraints: {
      maxDurationMs: 30000,
      maxRetries: 2,
    },
  },
  {
    stepId: "emit_report",
    stepType: "aggregate",
    description: "Produce the final reconciliation report summarizing all findings",
    inputSchema: {
      type: "object",
      properties: {
        matched: { type: "array" },
        adjustments: { type: "array" },
        totalVariance: { type: "number" },
        periodStart: { type: "string" },
        periodEnd: { type: "string" },
      },
      required: ["matched", "adjustments", "totalVariance"],
    },
    outputSchema: {
      type: "object",
      properties: {
        report: {
          type: "object",
          properties: {
            summary: { type: "string" },
            matchRate: { type: "number" },
            totalMatched: { type: "number" },
            totalUnmatched: { type: "number" },
            totalVariance: { type: "number" },
            adjustmentsRequired: { type: "number" },
            status: { type: "string", enum: ["clean", "variance-within-threshold", "requires-review"] },
          },
        },
        detailedFindings: { type: "array" },
      },
    },
    dependsOn: ["compute_adjustments"],
    constraints: {
      maxDurationMs: 30000,
      maxRetries: 1,
      requiredEvidence: ["execution_trace", "output_hash"],
    },
  },
];

/**
 * Accounting reconciliation capability template.
 * Uses CapabilityType as an open string union — "accounting-reconcile"
 * is valid without modifying BuiltinCapabilityType.
 */
export const accountingReconcileTemplate: CapabilityTemplate = {
  capabilityType: "accounting-reconcile",
  version: "1.0",
  name: "Accounting Reconciliation",
  description:
    "Reconcile general ledger entries against bank statements — automated matching, variance computation, and adjustment report generation",
  params: [
    // ── Source Group ──
    {
      type: "string",
      key: "ledgerSource",
      label: "Ledger Source",
      description: "GL system identifier, API endpoint, or file URI",
      required: true,
      order: 1,
      group: "Source",
      placeholder: "https://erp.example.com/api/gl or file://ledger.csv",
    },
    {
      type: "string",
      key: "statementSource",
      label: "Bank Statement Source",
      description: "Bank statement file, API endpoint, or OFX/CSV path",
      required: true,
      order: 2,
      group: "Source",
      placeholder: "https://bank.example.com/statements or file://statement.ofx",
    },
    // ── Matching Group ──
    {
      type: "enum",
      key: "matchingStrategy",
      label: "Matching Strategy",
      description: "How to match ledger entries against bank transactions",
      required: true,
      order: 3,
      group: "Matching",
      options: [
        { value: "strict", label: "Strict", description: "Exact amount + date match only" },
        {
          value: "fuzzy",
          label: "Fuzzy",
          description: "Approximate matching with configurable tolerance",
          pricingImpact: { mode: "percent", value: "20", label: "+20% for fuzzy matching" },
        },
        {
          value: "ml-assisted",
          label: "ML-Assisted",
          description: "Machine learning model for complex matching patterns",
          pricingImpact: { mode: "percent", value: "50", label: "+50% for ML-assisted matching" },
        },
      ],
    },
    // ── Period Group ──
    {
      type: "string",
      key: "periodStart",
      label: "Period Start",
      description: "Start of the reconciliation period (ISO date)",
      required: true,
      order: 4,
      group: "Period",
      placeholder: "2026-01-01",
    },
    {
      type: "string",
      key: "periodEnd",
      label: "Period End",
      description: "End of the reconciliation period (ISO date)",
      required: true,
      order: 5,
      group: "Period",
      placeholder: "2026-01-31",
    },
    // ── Currency Group ──
    {
      type: "enum",
      key: "currencyCode",
      label: "Currency",
      description: "Currency for the reconciliation",
      required: false,
      order: 6,
      group: "Currency",
      defaultValue: "USD",
      options: [
        { value: "USD", label: "US Dollar" },
        { value: "EUR", label: "Euro" },
        { value: "GBP", label: "British Pound" },
        { value: "JPY", label: "Japanese Yen" },
        { value: "CHF", label: "Swiss Franc" },
      ],
    },
    // ── Pricing Group ──
    {
      type: "number",
      key: "estimatedEntries",
      label: "Estimated Entries",
      description: "Approximate number of ledger entries to process (affects pricing)",
      required: false,
      order: 7,
      group: "Pricing",
      min: 1,
      max: 1000000,
      step: 1,
      defaultValue: 100,
      pricingImpact: { mode: "per_unit", value: "0.02", label: "$0.02 per entry" },
    },
  ],
  basePricingHints: {
    basePrice: "5.00",
    currency: "USDC",
    perUnitLabel: "per reconciliation",
  },
};
