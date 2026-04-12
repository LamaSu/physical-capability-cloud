/**
 * Accounting touchstone library — known-answer tasks for accounting kernels.
 *
 * Every task has a deterministic, verifiable answer so that statistical
 * enforcement is exact-match or schema-based (zero false positives).
 */

import type { TouchstoneLibrary, TouchstoneTask } from "../types.js";

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const reconcileLedger: TouchstoneTask = {
  taskId: "acct-001-reconcile-ledger",
  workflowSteps: [
    {
      stepId: "load-ledger",
      description: "Load the provided general ledger entries.",
      input: {
        entries: [
          { account: "1000-Cash", debit: 5000, credit: 0 },
          { account: "2000-AP", debit: 0, credit: 3000 },
          { account: "4000-Revenue", debit: 0, credit: 2000 },
          { account: "5000-COGS", debit: 1500, credit: 0 },
          { account: "1000-Cash", debit: 0, credit: 1500 },
        ],
      },
    },
    {
      stepId: "reconcile",
      description:
        "Compute the net balance for each account and confirm debits equal credits.",
      input: {},
    },
  ],
  expectedOutput: {
    balances: {
      "1000-Cash": 3500,
      "2000-AP": -3000,
      "4000-Revenue": -2000,
      "5000-COGS": 1500,
    },
    totalDebits: 6500,
    totalCredits: 6500,
    balanced: true,
  },
  verificationMethod: "exact_match",
  scope: "accounting",
  metadata: { difficulty: "basic", category: "reconciliation" },
};

const sumInvoiceLineItems: TouchstoneTask = {
  taskId: "acct-002-sum-invoice-lines",
  workflowSteps: [
    {
      stepId: "parse-invoice",
      description: "Parse the provided invoice line items.",
      input: {
        lineItems: [
          { description: "Widget A", quantity: 10, unitPrice: 25.0 },
          { description: "Widget B", quantity: 5, unitPrice: 49.99 },
          { description: "Shipping", quantity: 1, unitPrice: 15.0 },
        ],
        taxRate: 0.085,
      },
    },
    {
      stepId: "compute-total",
      description: "Sum line items, apply tax, return subtotal, tax, and total.",
      input: {},
    },
  ],
  expectedOutput: {
    subtotal: 514.95,
    tax: 43.77,
    total: 558.72,
  },
  verificationMethod: "exact_match",
  scope: "accounting",
  metadata: { difficulty: "basic", category: "invoicing" },
};

const classifyExpense: TouchstoneTask = {
  taskId: "acct-003-classify-expense",
  workflowSteps: [
    {
      stepId: "read-transaction",
      description: "Read the provided transaction details.",
      input: {
        transaction: {
          date: "2026-03-15",
          vendor: "Office Depot",
          amount: 234.56,
          description: "Printer paper, toner cartridge, binder clips",
        },
      },
    },
    {
      stepId: "classify",
      description:
        "Classify the transaction into the correct expense category and output a structured record.",
      input: {
        categories: [
          "office_supplies",
          "equipment",
          "travel",
          "utilities",
          "professional_services",
        ],
      },
    },
  ],
  expectedOutput: {
    category: "office_supplies",
    confidence: 1.0,
    reasoning: "All items (paper, toner, clips) are standard office supplies.",
  },
  verificationMethod: "schema_validation",
  scope: "accounting",
  metadata: { difficulty: "basic", category: "classification" },
};

const depreciationSchedule: TouchstoneTask = {
  taskId: "acct-004-depreciation-schedule",
  workflowSteps: [
    {
      stepId: "load-asset",
      description: "Load the fixed asset record.",
      input: {
        asset: {
          name: "CNC Router",
          acquisitionCost: 50000,
          residualValue: 5000,
          usefulLifeYears: 5,
          method: "straight-line",
        },
      },
    },
    {
      stepId: "compute-schedule",
      description: "Compute annual depreciation and book value for each year.",
      input: {},
    },
  ],
  expectedOutput: {
    annualDepreciation: 9000,
    schedule: [
      { year: 1, depreciation: 9000, bookValue: 41000 },
      { year: 2, depreciation: 9000, bookValue: 32000 },
      { year: 3, depreciation: 9000, bookValue: 23000 },
      { year: 4, depreciation: 9000, bookValue: 14000 },
      { year: 5, depreciation: 9000, bookValue: 5000 },
    ],
  },
  verificationMethod: "exact_match",
  scope: "accounting",
  metadata: { difficulty: "intermediate", category: "fixed-assets" },
};

// ---------------------------------------------------------------------------
// Library export
// ---------------------------------------------------------------------------

export const accountingLibrary: TouchstoneLibrary = {
  id: "lib-accounting-v1",
  name: "Accounting Touchstones",
  taskType: "accounting",
  tasks: [reconcileLedger, sumInvoiceLineItems, classifyExpense, depreciationSchedule],
  description:
    "Known-answer tasks for accounting kernels: ledger reconciliation, invoice arithmetic, expense classification, and depreciation schedules.",
};
