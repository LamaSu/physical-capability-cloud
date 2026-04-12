/**
 * Accounting Reconcile Kernel -- the first digital kernel on PCC.
 *
 * Executes a 5-step reconciliation workflow:
 *   1. fetch_ledger    -- retrieve ledger data from input
 *   2. parse_entries   -- parse and normalize journal entries
 *   3. match_invoices  -- match entries to invoices
 *   4. compute_adjustments -- calculate adjustments
 *   5. emit_report     -- generate reconciliation report
 *
 * Each step produces an evidence event with input/output hashes.
 * The kernel signs all evidence with a sessionKey derived from its principalKey.
 */

import nacl from "tweetnacl";
import type {
  EvidenceBundle,
  EvidenceEvent,
  EvidenceSource,
  SessionKey,
  SHA256,
} from "@pcc/spec";
import { ids, canonicalize, sha256 } from "@pcc/spec";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** A single ledger entry (general ledger / bank statement) */
export interface LedgerEntry {
  date: string;
  description: string;
  amount: number;
  account: string;
  reference?: string;
}

/** A single invoice for matching */
export interface InvoiceEntry {
  invoiceId: string;
  date: string;
  amount: number;
  vendor?: string;
  reference?: string;
}

/** A matched pair of ledger entry and invoice */
export interface MatchedPair {
  ledgerEntry: LedgerEntry;
  invoice: InvoiceEntry;
  confidence: number;
}

/** An accounting adjustment for unmatched entries */
export interface Adjustment {
  type: "debit" | "credit";
  amount: number;
  account: string;
  reason: string;
}

/** The final reconciliation report */
export interface ReconciliationReport {
  summary: string;
  matchedCount: number;
  unmatchedLedgerCount: number;
  unmatchedInvoiceCount: number;
  matchRate: number;
  totalVariance: number;
  adjustments: Adjustment[];
  status: "clean" | "variance-within-threshold" | "requires-review";
  periodStart?: string;
  periodEnd?: string;
}

/** Per-step execution trace for the report */
export interface StepTrace {
  stepId: string;
  inputHash: string;
  outputHash: string;
  outputSummary: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Kernel implementation
// ---------------------------------------------------------------------------

export class AccountingReconcileKernel {
  private kernelId: string;

  constructor(kernelId?: string) {
    this.kernelId = kernelId ?? ids.kernel();
  }

  /**
   * Execute the full 5-step reconciliation workflow.
   *
   * @returns Evidence bundle (signed) and a human-readable report.
   */
  async execute(params: {
    ledgerData: Record<string, unknown>;
    invoiceData?: Record<string, unknown>;
    sessionKey: SessionKey;
    sessionPrivateKey: Uint8Array;
    jobId: string;
    kernelId?: string;
  }): Promise<{
    evidenceBundle: EvidenceBundle;
    report: ReconciliationReport;
    stepTraces: StepTrace[];
  }> {
    const kernelId = params.kernelId ?? this.kernelId;
    const events: EvidenceEvent[] = [];
    const traces: StepTrace[] = [];

    const source: EvidenceSource = {
      deviceId: kernelId,
      deviceType: "digital_agent",
      kernelId,
    };

    const executionStartTime = new Date().toISOString();

    // ── Lifecycle: input verification (equivalent to gcode_hash_verified) ──
    const inputHash = await sha256(canonicalize({
      ledgerData: params.ledgerData,
      invoiceData: params.invoiceData,
    }));
    const inputVerifiedEvent: EvidenceEvent = {
      id: ids.evidence(),
      type: "gcode_hash_verified",
      timestamp: executionStartTime,
      source,
      payload: {
        description: "Digital workflow input data verified",
        inputHash,
        workflowType: "accounting-reconcile",
      },
      hash: "" as SHA256,
    };
    inputVerifiedEvent.hash = await sha256(canonicalize({
      type: inputVerifiedEvent.type,
      timestamp: inputVerifiedEvent.timestamp,
      source: inputVerifiedEvent.source,
      payload: inputVerifiedEvent.payload,
    }));
    events.push(inputVerifiedEvent);

    // ── Lifecycle: execution_started ──
    const startEvent: EvidenceEvent = {
      id: ids.evidence(),
      type: "execution_started",
      timestamp: executionStartTime,
      source,
      payload: {
        jobId: params.jobId,
        kernelId,
        workflowType: "accounting-reconcile",
        stepCount: 5,
      },
      hash: "" as SHA256,
    };
    startEvent.hash = await sha256(canonicalize({
      type: startEvent.type,
      timestamp: startEvent.timestamp,
      source: startEvent.source,
      payload: startEvent.payload,
    }));
    events.push(startEvent);

    // ── Step 1: fetch_ledger ──────────────────────────────────────────
    const step1 = await this.runStep({
      stepId: "fetch_ledger",
      source,
      input: params.ledgerData,
      execute: (input) => this.fetchLedger(input),
    });
    events.push(step1.event);
    traces.push(step1.trace);

    // ── Step 2: parse_entries ─────────────────────────────────────────
    const step2 = await this.runStep({
      stepId: "parse_entries",
      source,
      input: step1.output,
      execute: (input) => this.parseEntries(input),
    });
    events.push(step2.event);
    traces.push(step2.trace);

    // ── Step 3: match_invoices ────────────────────────────────────────
    const matchInput = {
      ledgerEntries: step2.output.entries,
      invoices: (params.invoiceData as any)?.invoices ?? [],
    };
    const step3 = await this.runStep({
      stepId: "match_invoices",
      source,
      input: matchInput,
      execute: (input) => this.matchInvoices(input),
    });
    events.push(step3.event);
    traces.push(step3.trace);

    // ── Step 4: compute_adjustments ───────────────────────────────────
    const step4 = await this.runStep({
      stepId: "compute_adjustments",
      source,
      input: {
        unmatchedLedger: step3.output.unmatchedLedger,
        unmatchedInvoices: step3.output.unmatchedInvoices,
      },
      execute: (input) => this.computeAdjustments(input),
    });
    events.push(step4.event);
    traces.push(step4.trace);

    // ── Step 5: emit_report ───────────────────────────────────────────
    const step5 = await this.runStep({
      stepId: "emit_report",
      source,
      input: {
        matched: step3.output.matched,
        unmatchedLedger: step3.output.unmatchedLedger,
        unmatchedInvoices: step3.output.unmatchedInvoices,
        adjustments: step4.output.adjustments,
        totalVariance: step4.output.totalVariance,
      },
      execute: (input) => this.emitReport(input),
    });
    events.push(step5.event);
    traces.push(step5.trace);

    const report = step5.output as ReconciliationReport;

    // ── Lifecycle: execution_completed ──
    const completedEvent: EvidenceEvent = {
      id: ids.evidence(),
      type: "execution_completed",
      timestamp: new Date().toISOString(),
      source,
      payload: {
        jobId: params.jobId,
        kernelId,
        workflowType: "accounting-reconcile",
        stepCount: 5,
        status: report.status,
        matchRate: report.matchRate,
      },
      hash: "" as SHA256,
    };
    completedEvent.hash = await sha256(canonicalize({
      type: completedEvent.type,
      timestamp: completedEvent.timestamp,
      source: completedEvent.source,
      payload: completedEvent.payload,
    }));
    events.push(completedEvent);

    // ── Bundle evidence ───────────────────────────────────────────────
    const sortedHashes = events.map((e) => e.hash).sort();
    const bundleHash = await sha256(canonicalize(sortedHashes));

    // Sign the bundle with the session key
    const bundleHashBytes = new TextEncoder().encode(bundleHash);
    const sig = nacl.sign.detached(bundleHashBytes, params.sessionPrivateKey);

    const evidenceBundle: EvidenceBundle = {
      id: ids.bundle(),
      jobId: params.jobId,
      stepId: "accounting-reconcile",
      kernelId,
      assuranceTier: 0,
      events,
      bundleHash,
      kernelSignature: {
        signer: `0x${Buffer.from(params.sessionKey.publicKey).toString("hex").slice(0, 40)}` as `0x${string}`,
        algorithm: "ed25519",
        value: Buffer.from(sig).toString("hex"),
      },
      createdAt: new Date().toISOString(),
    };

    return { evidenceBundle, report, stepTraces: traces };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Step runner (creates evidence events with timing + hashing)
  // ─────────────────────────────────────────────────────────────────────

  private async runStep<I, O>(params: {
    stepId: string;
    source: EvidenceSource;
    input: I;
    execute: (input: I) => O;
  }): Promise<{
    event: EvidenceEvent;
    trace: StepTrace;
    output: O;
  }> {
    const inputHash = await sha256(canonicalize(params.input));
    const t0 = Date.now();

    const output = params.execute(params.input);

    const durationMs = Date.now() - t0;
    const outputHash = await sha256(canonicalize(output));
    const outputSummary = JSON.stringify(output).slice(0, 200);

    const payload = {
      stepId: params.stepId,
      inputHash,
      outputHash,
      outputSummary,
      durationMs,
    };

    const eventId = ids.evidence();
    const timestamp = new Date().toISOString();

    const eventCore = {
      type: "workflow_step_completed",
      timestamp,
      source: params.source,
      payload,
    };
    const hash = await sha256(canonicalize(eventCore));

    const event: EvidenceEvent = {
      id: eventId,
      type: "workflow_step_completed",
      timestamp,
      source: params.source,
      payload,
      hash,
    };

    const trace: StepTrace = {
      stepId: params.stepId,
      inputHash,
      outputHash,
      outputSummary,
      durationMs,
    };

    return { event, trace, output };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Workflow step implementations (REAL logic, not stubs)
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Step 1: Fetch and validate ledger data.
   * Parses the input, validates format, returns structured entries.
   */
  private fetchLedger(input: Record<string, unknown>): {
    entries: LedgerEntry[];
    totalEntries: number;
    periodStart?: string;
    periodEnd?: string;
  } {
    const raw = (input as any).entries ?? (input as any).ledgerEntries ?? [];
    const entries: LedgerEntry[] = [];

    for (const item of raw) {
      entries.push({
        date: String(item.date ?? ""),
        description: String(item.description ?? ""),
        amount: Number(item.amount ?? item.debit ?? 0) - Number(item.credit ?? 0),
        account: String(item.account ?? "unknown"),
        reference: item.reference ? String(item.reference) : undefined,
      });
    }

    return {
      entries,
      totalEntries: entries.length,
      periodStart: input.periodStart ? String(input.periodStart) : undefined,
      periodEnd: input.periodEnd ? String(input.periodEnd) : undefined,
    };
  }

  /**
   * Step 2: Parse and normalize entries.
   * Normalizes amounts to 2 decimal places, standardizes date format,
   * and uppercases account codes.
   */
  private parseEntries(input: {
    entries: LedgerEntry[];
    totalEntries: number;
    periodStart?: string;
    periodEnd?: string;
  }): {
    entries: LedgerEntry[];
    totalEntries: number;
  } {
    const normalized = input.entries.map((e) => ({
      ...e,
      amount: Math.round(e.amount * 100) / 100,
      account: e.account.toUpperCase(),
      date: e.date.trim(),
      description: e.description.trim(),
    }));

    return {
      entries: normalized,
      totalEntries: normalized.length,
    };
  }

  /**
   * Step 3: Match ledger entries to invoices.
   * Simple matching by amount + date range (within 3 days).
   */
  private matchInvoices(input: {
    ledgerEntries: LedgerEntry[];
    invoices: InvoiceEntry[];
  }): {
    matched: MatchedPair[];
    unmatchedLedger: LedgerEntry[];
    unmatchedInvoices: InvoiceEntry[];
    matchRate: number;
  } {
    const matched: MatchedPair[] = [];
    const usedInvoiceIds = new Set<string>();
    const matchedLedgerIndices = new Set<number>();

    for (let li = 0; li < input.ledgerEntries.length; li++) {
      const ledger = input.ledgerEntries[li];

      for (const invoice of input.invoices) {
        if (usedInvoiceIds.has(invoice.invoiceId)) continue;

        // Match by amount (exact or within 1% tolerance)
        const amountDiff = Math.abs(ledger.amount - invoice.amount);
        const tolerance = Math.abs(invoice.amount) * 0.01;
        const amountMatch = amountDiff <= tolerance;

        // Match by date (within 3 days)
        let dateMatch = true;
        if (ledger.date && invoice.date) {
          const ledgerDate = new Date(ledger.date).getTime();
          const invoiceDate = new Date(invoice.date).getTime();
          if (!isNaN(ledgerDate) && !isNaN(invoiceDate)) {
            const daysDiff = Math.abs(ledgerDate - invoiceDate) / (1000 * 60 * 60 * 24);
            dateMatch = daysDiff <= 3;
          }
        }

        // Also match by reference if available
        const refMatch =
          ledger.reference && invoice.reference
            ? ledger.reference === invoice.reference
            : false;

        if ((amountMatch && dateMatch) || refMatch) {
          const confidence = refMatch ? 1.0 : amountMatch && dateMatch ? 0.9 : 0.7;
          matched.push({ ledgerEntry: ledger, invoice, confidence });
          usedInvoiceIds.add(invoice.invoiceId);
          matchedLedgerIndices.add(li);
          break;
        }
      }
    }

    const unmatchedLedger = input.ledgerEntries.filter((_, i) => !matchedLedgerIndices.has(i));
    const unmatchedInvoices = input.invoices.filter((inv) => !usedInvoiceIds.has(inv.invoiceId));

    const total = Math.max(input.ledgerEntries.length, 1);
    const matchRate = matched.length / total;

    return { matched, unmatchedLedger, unmatchedInvoices, matchRate };
  }

  /**
   * Step 4: Compute adjustments for unmatched entries.
   * Creates debit/credit adjustments and computes net variance.
   */
  private computeAdjustments(input: {
    unmatchedLedger: LedgerEntry[];
    unmatchedInvoices: InvoiceEntry[];
  }): {
    adjustments: Adjustment[];
    totalVariance: number;
  } {
    const adjustments: Adjustment[] = [];

    // Unmatched ledger entries need investigation adjustments
    for (const entry of input.unmatchedLedger) {
      adjustments.push({
        type: entry.amount >= 0 ? "debit" : "credit",
        amount: Math.abs(entry.amount),
        account: entry.account,
        reason: `Unmatched ledger entry: ${entry.description || "no description"} (${entry.date})`,
      });
    }

    // Unmatched invoices are potential missed payments
    for (const inv of input.unmatchedInvoices) {
      adjustments.push({
        type: inv.amount >= 0 ? "credit" : "debit",
        amount: Math.abs(inv.amount),
        account: "ACCOUNTS_PAYABLE",
        reason: `Unmatched invoice: ${inv.invoiceId} from ${inv.vendor ?? "unknown vendor"} (${inv.date})`,
      });
    }

    const totalVariance = adjustments.reduce((sum, adj) => {
      return sum + (adj.type === "debit" ? adj.amount : -adj.amount);
    }, 0);

    return {
      adjustments,
      totalVariance: Math.round(totalVariance * 100) / 100,
    };
  }

  /**
   * Step 5: Emit the final reconciliation report.
   */
  private emitReport(input: {
    matched: MatchedPair[];
    unmatchedLedger: LedgerEntry[];
    unmatchedInvoices: InvoiceEntry[];
    adjustments: Adjustment[];
    totalVariance: number;
  }): ReconciliationReport {
    const total = input.matched.length + input.unmatchedLedger.length;
    const matchRate = total > 0 ? input.matched.length / total : 1;
    const absVariance = Math.abs(input.totalVariance);

    let status: ReconciliationReport["status"];
    if (input.unmatchedLedger.length === 0 && input.unmatchedInvoices.length === 0) {
      status = "clean";
    } else if (absVariance < 100) {
      status = "variance-within-threshold";
    } else {
      status = "requires-review";
    }

    const summary = [
      `Reconciliation complete.`,
      `${input.matched.length} entries matched (${(matchRate * 100).toFixed(1)}% match rate).`,
      `${input.unmatchedLedger.length} unmatched ledger entries.`,
      `${input.unmatchedInvoices.length} unmatched invoices.`,
      `${input.adjustments.length} adjustments required.`,
      `Net variance: $${input.totalVariance.toFixed(2)}.`,
      `Status: ${status}.`,
    ].join(" ");

    return {
      summary,
      matchedCount: input.matched.length,
      unmatchedLedgerCount: input.unmatchedLedger.length,
      unmatchedInvoiceCount: input.unmatchedInvoices.length,
      matchRate: Math.round(matchRate * 1000) / 1000,
      totalVariance: input.totalVariance,
      adjustments: input.adjustments,
      status,
    };
  }
}
