/**
 * Procurement touchstone library — known-answer tasks for procurement kernels.
 *
 * Tasks cover quote comparison, PO field extraction, and vendor scoring,
 * all with deterministic or schema-verifiable answers.
 */

import type { TouchstoneLibrary, TouchstoneTask } from "../types.js";

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const compareQuotes: TouchstoneTask = {
  taskId: "proc-001-compare-quotes",
  workflowSteps: [
    {
      stepId: "load-quotes",
      description: "Load the three vendor quotes for comparison.",
      input: {
        quotes: [
          {
            vendor: "Acme Corp",
            unitPrice: 12.5,
            quantity: 1000,
            leadTimeDays: 14,
            shippingCost: 150,
          },
          {
            vendor: "Beta Supplies",
            unitPrice: 11.75,
            quantity: 1000,
            leadTimeDays: 21,
            shippingCost: 200,
          },
          {
            vendor: "Gamma Industrial",
            unitPrice: 13.0,
            quantity: 1000,
            leadTimeDays: 7,
            shippingCost: 0,
          },
        ],
      },
    },
    {
      stepId: "rank-quotes",
      description:
        "Rank quotes by total cost (unit price * quantity + shipping) and identify the lowest.",
      input: {},
    },
  ],
  expectedOutput: {
    rankings: [
      { vendor: "Beta Supplies", totalCost: 11950 },
      { vendor: "Acme Corp", totalCost: 12650 },
      { vendor: "Gamma Industrial", totalCost: 13000 },
    ],
    lowestCostVendor: "Beta Supplies",
    fastestDeliveryVendor: "Gamma Industrial",
  },
  verificationMethod: "exact_match",
  scope: "procurement",
  metadata: { difficulty: "basic", category: "quote-comparison" },
};

const extractPOFields: TouchstoneTask = {
  taskId: "proc-002-extract-po-fields",
  workflowSteps: [
    {
      stepId: "parse-document",
      description: "Extract structured fields from the provided purchase order text.",
      input: {
        documentText: [
          "PURCHASE ORDER #PO-2026-0042",
          "Date: March 10, 2026",
          "Vendor: Acme Corp (ID: VND-1001)",
          "Ship To: 123 Factory Lane, Detroit MI 48201",
          "Line 1: Widget A x100 @ $12.50 = $1,250.00",
          "Line 2: Widget B x50 @ $24.00 = $1,200.00",
          "Subtotal: $2,450.00",
          "Tax (6%): $147.00",
          "Total: $2,597.00",
          "Payment Terms: Net 30",
          "Authorized By: Jane Smith, Procurement Manager",
        ].join("\n"),
      },
    },
    {
      stepId: "output-structured",
      description: "Output the extracted fields as a structured JSON object.",
      input: {},
    },
  ],
  expectedOutput: {
    poNumber: "PO-2026-0042",
    date: "2026-03-10",
    vendorName: "Acme Corp",
    vendorId: "VND-1001",
    shipTo: "123 Factory Lane, Detroit MI 48201",
    lineItems: [
      { description: "Widget A", quantity: 100, unitPrice: 12.5, total: 1250.0 },
      { description: "Widget B", quantity: 50, unitPrice: 24.0, total: 1200.0 },
    ],
    subtotal: 2450.0,
    taxRate: 0.06,
    tax: 147.0,
    total: 2597.0,
    paymentTerms: "Net 30",
    authorizedBy: "Jane Smith",
  },
  verificationMethod: "schema_validation",
  scope: "procurement",
  metadata: { difficulty: "intermediate", category: "document-extraction" },
};

const vendorScorecard: TouchstoneTask = {
  taskId: "proc-003-vendor-scorecard",
  workflowSteps: [
    {
      stepId: "load-performance-data",
      description: "Load vendor performance data for scoring.",
      input: {
        vendor: "Acme Corp",
        deliveries: [
          { poId: "PO-001", promisedDays: 14, actualDays: 13, defectRate: 0.01 },
          { poId: "PO-002", promisedDays: 14, actualDays: 16, defectRate: 0.02 },
          { poId: "PO-003", promisedDays: 14, actualDays: 14, defectRate: 0.0 },
          { poId: "PO-004", promisedDays: 14, actualDays: 12, defectRate: 0.005 },
          { poId: "PO-005", promisedDays: 14, actualDays: 15, defectRate: 0.03 },
        ],
      },
    },
    {
      stepId: "compute-scorecard",
      description:
        "Compute on-time delivery rate, average defect rate, and overall score (0-100).",
      input: {
        weights: { onTimeDelivery: 0.6, qualityScore: 0.4 },
      },
    },
  ],
  expectedOutput: {
    vendor: "Acme Corp",
    onTimeDeliveryRate: 0.6,
    averageDefectRate: 0.013,
    onTimeScore: 60,
    qualityScore: 98.7,
    overallScore: 75.48,
  },
  verificationMethod: "exact_match",
  scope: "procurement",
  metadata: { difficulty: "intermediate", category: "vendor-scoring" },
};

const budgetAllocation: TouchstoneTask = {
  taskId: "proc-004-budget-allocation",
  workflowSteps: [
    {
      stepId: "load-budget",
      description: "Load the department procurement budget and spending categories.",
      input: {
        totalBudget: 100000,
        categories: [
          { name: "Raw Materials", allocation: 0.45 },
          { name: "Office Supplies", allocation: 0.10 },
          { name: "Equipment", allocation: 0.30 },
          { name: "Services", allocation: 0.15 },
        ],
        spent: {
          "Raw Materials": 38000,
          "Office Supplies": 9500,
          "Equipment": 25000,
          "Services": 12000,
        },
      },
    },
    {
      stepId: "compute-remaining",
      description:
        "Compute the remaining budget per category and total remaining.",
      input: {},
    },
  ],
  expectedOutput: {
    remaining: {
      "Raw Materials": 7000,
      "Office Supplies": 500,
      "Equipment": 5000,
      "Services": 3000,
    },
    totalRemaining: 15500,
    totalSpent: 84500,
    utilizationRate: 0.845,
  },
  verificationMethod: "exact_match",
  scope: "procurement",
  metadata: { difficulty: "basic", category: "budget-tracking" },
};

// ---------------------------------------------------------------------------
// Library export
// ---------------------------------------------------------------------------

export const procurementLibrary: TouchstoneLibrary = {
  id: "lib-procurement-v1",
  name: "Procurement Touchstones",
  taskType: "procurement",
  tasks: [compareQuotes, extractPOFields, vendorScorecard, budgetAllocation],
  description:
    "Known-answer tasks for procurement kernels: quote comparison, PO field extraction, vendor scorecards, and budget allocation tracking.",
};
