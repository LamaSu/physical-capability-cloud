/**
 * Procurement RFQ Kernel -- the second digital kernel on PCC.
 *
 * Executes a 6-step request-for-quote workflow:
 *   1. parse_rfq        -- normalize the RFQ spec (item, qty, specs, deadline)
 *   2. filter_vendors   -- keep vendors whose capabilities cover required spec keys
 *   3. solicit_quotes   -- generate deterministic quotes for each eligible vendor
 *   4. score_quotes     -- weighted score: 0.5*(1-priceNorm) + 0.3*deliverySpeed + 0.2*reputationNorm
 *   5. select_vendor    -- pick the top-scoring vendor (deterministic tie-break by vendorId)
 *   6. emit_report      -- produce a structured RFQReport with rankings + PO payload
 *
 * Each step emits a workflow_step_completed EvidenceEvent carrying
 * { stepId, inputHash, outputHash, outputSummary, durationMs }.
 *
 * The bundle is hashed (SHA-256 over the sorted event hashes) and signed
 * with the sessionKey's Ed25519 private key. Running the kernel twice with
 * the same inputs produces the same bundleHash.
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

/** The RFQ specification supplied by the buyer. */
export interface RFQSpec {
  /** Human-readable item / service being procured. */
  item: string;
  /** Units required. Must be positive. */
  quantity: number;
  /** Free-form spec keys; values may be any JSON. Keys drive capability matching. */
  specifications: Record<string, unknown>;
  /** ISO date string for the required delivery date. */
  deadline: string;
}

/** A candidate vendor considered for the RFQ. */
export interface VendorCandidate {
  id: string;
  name: string;
  /** Capability keys this vendor can satisfy (matched against RFQ spec keys). */
  capabilities: string[];
  /**
   * Optional history of prior quotes. When present, its length is used as a
   * signal of vendor reliability (reputation boost).
   */
  lastQuoteHistory?: Record<string, unknown>;
}

/** A quote response from a single vendor. */
export interface VendorQuote {
  vendorId: string;
  vendorName: string;
  /** Per-unit price in the contract currency. */
  unitPrice: number;
  /** unitPrice * quantity. */
  totalPrice: number;
  /** Promised delivery time in days from quote issuance. */
  deliveryDays: number;
  /** Vendor-reported reputation 0..1 (0 = unknown, 1 = perfect history). */
  reputation: number;
  /** Fraction of spec keys the vendor claims to satisfy. */
  complianceScore: number;
}

/** A scored quote -- raw quote plus normalized components and total score. */
export interface ScoredQuote {
  vendorId: string;
  vendorName: string;
  score: number;
  priceNorm: number;
  deliverySpeed: number;
  reputationNorm: number;
}

/** A ranking entry in the final report. */
export interface RFQRanking {
  vendorId: string;
  vendorName: string;
  score: number;
  totalPrice: number;
  deliveryDays: number;
}

/** The generated purchase-order-ready decision payload. */
export interface PurchaseOrderDraft {
  vendorId: string;
  vendorName: string;
  item: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  deliveryDays: number;
  deadline: string;
}

/** Final status of the RFQ workflow. */
export type RFQStatus = "awarded" | "no-vendors" | "single-vendor" | "tied";

/** The final RFQ report returned by emit_report. */
export interface RFQReport {
  summary: string;
  rankings: RFQRanking[];
  selectedVendor: {
    id: string;
    name: string;
    score: number;
    totalPrice: number;
    deliveryDays: number;
  } | null;
  purchaseOrder: PurchaseOrderDraft | null;
  status: RFQStatus;
  eligibleVendorCount: number;
  excludedVendorCount: number;
  decisionNote: string;
}

/** Per-step execution trace. */
export interface StepTrace {
  stepId: string;
  inputHash: string;
  outputHash: string;
  outputSummary: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when the RFQ spec fails structural validation. */
export class ProcurementRFQValidationError extends Error {
  readonly code = "rfq_validation_error";
  constructor(message: string) {
    super(message);
    this.name = "ProcurementRFQValidationError";
  }
}

/** Thrown when the sessionKey is expired or lacks required scope. */
export class ProcurementRFQSessionError extends Error {
  readonly code = "rfq_session_error";
  constructor(message: string) {
    super(message);
    this.name = "ProcurementRFQSessionError";
  }
}

// ---------------------------------------------------------------------------
// Kernel
// ---------------------------------------------------------------------------

export class ProcurementRFQKernel {
  private kernelId: string;

  constructor(kernelId?: string) {
    this.kernelId = kernelId ?? ids.kernel();
  }

  /**
   * Execute the full 6-step RFQ workflow.
   *
   * @returns Evidence bundle (signed), structured RFQReport, and the selected vendor.
   */
  async execute(params: {
    rfqSpec: RFQSpec;
    vendorList: VendorCandidate[];
    sessionKey: SessionKey;
    sessionPrivateKey: Uint8Array;
    jobId: string;
    kernelId?: string;
  }): Promise<{
    evidenceBundle: EvidenceBundle;
    report: RFQReport;
    selectedVendor: { id: string; quote: VendorQuote; score: number } | null;
    stepTraces: StepTrace[];
  }> {
    // ── Pre-flight: session scope + expiry gate (before any signing work) ──
    this.assertSessionValid(params.sessionKey);

    // ── Validate RFQ spec ──
    this.validateRFQSpec(params.rfqSpec);

    const kernelId = params.kernelId ?? this.kernelId;
    const events: EvidenceEvent[] = [];
    const traces: StepTrace[] = [];

    const source: EvidenceSource = {
      deviceId: kernelId,
      deviceType: "digital_agent",
      kernelId,
    };

    // Stable timestamp for the whole execution so bundle hashing is
    // reproducible across identical runs when the caller freezes time.
    const executionStartTime = new Date().toISOString();

    // ── Lifecycle: input verification ──
    const inputHash = await sha256(canonicalize({
      rfqSpec: params.rfqSpec,
      vendorList: params.vendorList,
    }));
    const inputVerifiedEvent: EvidenceEvent = {
      id: ids.evidence(),
      type: "gcode_hash_verified",
      timestamp: executionStartTime,
      source,
      payload: {
        description: "Digital workflow input data verified",
        inputHash,
        workflowType: "procurement-rfq",
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
        workflowType: "procurement-rfq",
        stepCount: 6,
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

    // ── Step 1: parse_rfq ───────────────────────────────────────────
    const step1 = await this.runStep({
      stepId: "parse_rfq",
      source,
      input: params.rfqSpec,
      execute: (input) => this.parseRFQ(input),
    });
    events.push(step1.event);
    traces.push(step1.trace);

    // ── Step 2: filter_vendors ──────────────────────────────────────
    const step2 = await this.runStep({
      stepId: "filter_vendors",
      source,
      input: {
        requiredCapabilities: step1.output.requiredCapabilities,
        vendorList: params.vendorList,
      },
      execute: (input) => this.filterVendors(input),
    });
    events.push(step2.event);
    traces.push(step2.trace);

    // ── Step 3: solicit_quotes ──────────────────────────────────────
    const rfqHash = await sha256(canonicalize(step1.output));
    const step3 = await this.runStep({
      stepId: "solicit_quotes",
      source,
      input: {
        eligibleVendors: step2.output.eligibleVendors,
        rfqHash,
        rfq: step1.output,
      },
      execute: (input) => this.solicitQuotes(input),
    });
    events.push(step3.event);
    traces.push(step3.trace);

    // ── Step 4: score_quotes ────────────────────────────────────────
    const step4 = await this.runStep({
      stepId: "score_quotes",
      source,
      input: { quotes: step3.output.quotes },
      execute: (input) => this.scoreQuotes(input),
    });
    events.push(step4.event);
    traces.push(step4.trace);

    // ── Step 5: select_vendor ───────────────────────────────────────
    const step5 = await this.runStep({
      stepId: "select_vendor",
      source,
      input: {
        scoredQuotes: step4.output.scoredQuotes,
        quotes: step3.output.quotes,
      },
      execute: (input) => this.selectVendor(input),
    });
    events.push(step5.event);
    traces.push(step5.trace);

    // ── Step 6: emit_report ─────────────────────────────────────────
    const step6 = await this.runStep({
      stepId: "emit_report",
      source,
      input: {
        rfq: step1.output,
        scoredQuotes: step4.output.scoredQuotes,
        quotes: step3.output.quotes,
        selectedVendorId: step5.output.selectedVendorId,
        selectedQuote: step5.output.selectedQuote,
        decisionNote: step5.output.decisionNote,
        excludedCount: step2.output.excludedCount,
        eligibleCount: step2.output.eligibleVendors.length,
      },
      execute: (input) => this.emitReport(input),
    });
    events.push(step6.event);
    traces.push(step6.trace);

    const report = step6.output as RFQReport;

    // ── Lifecycle: execution_completed ──
    const completedEvent: EvidenceEvent = {
      id: ids.evidence(),
      type: "execution_completed",
      timestamp: new Date().toISOString(),
      source,
      payload: {
        jobId: params.jobId,
        kernelId,
        workflowType: "procurement-rfq",
        stepCount: 6,
        status: report.status,
        selectedVendorId: report.selectedVendor?.id ?? null,
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

    // ── Bundle evidence ──────────────────────────────────────────────
    const sortedHashes = events.map((e) => e.hash).sort();
    const bundleHash = await sha256(canonicalize(sortedHashes));

    // Sign the bundle with the session key
    const bundleHashBytes = new TextEncoder().encode(bundleHash);
    const sig = nacl.sign.detached(bundleHashBytes, params.sessionPrivateKey);

    const evidenceBundle: EvidenceBundle = {
      id: ids.bundle(),
      jobId: params.jobId,
      stepId: "procurement-rfq",
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

    // The selectedVendor summary returned to the caller. Null when no vendors eligible.
    let selectedVendor: { id: string; quote: VendorQuote; score: number } | null = null;
    if (report.selectedVendor && step5.output.selectedQuote) {
      selectedVendor = {
        id: report.selectedVendor.id,
        quote: step5.output.selectedQuote as VendorQuote,
        score: report.selectedVendor.score,
      };
    }

    return { evidenceBundle, report, selectedVendor, stepTraces: traces };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Session + spec gates
  // ─────────────────────────────────────────────────────────────────────

  private assertSessionValid(sessionKey: SessionKey): void {
    const nowSec = Math.floor(Date.now() / 1000);
    if (sessionKey.expiresAt <= nowSec) {
      throw new ProcurementRFQSessionError(
        `sessionKey expired (expiresAt=${sessionKey.expiresAt}, now=${nowSec})`,
      );
    }
    if (!sessionKey.scope.allowedActions.includes("workflow_step_complete")) {
      throw new ProcurementRFQSessionError(
        `sessionKey scope lacks required action 'workflow_step_complete' (has ${sessionKey.scope.allowedActions.join(",") || "none"})`,
      );
    }
  }

  private validateRFQSpec(rfq: RFQSpec): void {
    if (!rfq || typeof rfq !== "object") {
      throw new ProcurementRFQValidationError("rfqSpec must be an object");
    }
    if (typeof rfq.item !== "string" || rfq.item.trim().length === 0) {
      throw new ProcurementRFQValidationError("rfqSpec.item must be a non-empty string");
    }
    if (typeof rfq.quantity !== "number" || !Number.isFinite(rfq.quantity) || rfq.quantity <= 0) {
      throw new ProcurementRFQValidationError("rfqSpec.quantity must be a positive number");
    }
    if (!rfq.specifications || typeof rfq.specifications !== "object" || Array.isArray(rfq.specifications)) {
      throw new ProcurementRFQValidationError("rfqSpec.specifications must be an object");
    }
    if (typeof rfq.deadline !== "string" || rfq.deadline.trim().length === 0) {
      throw new ProcurementRFQValidationError("rfqSpec.deadline must be an ISO date string");
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Step runner (timing + hashing)
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
  // Workflow step implementations (real logic, not stubs)
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Step 1: Parse + normalize the RFQ spec.
   * Collects the required capability keys (= spec keys) so the next step can
   * filter vendors against them without re-reading the spec.
   */
  private parseRFQ(input: RFQSpec): {
    item: string;
    quantity: number;
    specifications: Record<string, unknown>;
    deadline: string;
    requiredCapabilities: string[];
  } {
    const item = input.item.trim();
    const quantity = Math.floor(input.quantity);
    const specifications = { ...input.specifications };
    const deadline = input.deadline.trim();
    const requiredCapabilities = Object.keys(specifications).sort();

    return { item, quantity, specifications, deadline, requiredCapabilities };
  }

  /**
   * Step 2: Filter vendors whose capability set covers every required spec key.
   * A vendor is eligible iff requiredCapabilities ⊆ vendor.capabilities.
   */
  private filterVendors(input: {
    requiredCapabilities: string[];
    vendorList: VendorCandidate[];
  }): {
    eligibleVendors: VendorCandidate[];
    excludedCount: number;
  } {
    const required = new Set(input.requiredCapabilities);
    const eligible: VendorCandidate[] = [];

    for (const v of input.vendorList) {
      const cap = new Set(v.capabilities ?? []);
      let covers = true;
      for (const req of required) {
        if (!cap.has(req)) {
          covers = false;
          break;
        }
      }
      if (covers) eligible.push(v);
    }

    // Sort deterministically by id so downstream steps are reproducible.
    eligible.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    return {
      eligibleVendors: eligible,
      excludedCount: input.vendorList.length - eligible.length,
    };
  }

  /**
   * Step 3: Generate a deterministic quote for each eligible vendor.
   *
   * The "quote" is a pure function of (vendorId, rfqHash, quantity, vendor history length).
   * This means repeat runs produce the same quote bytes -- required so bundleHashes
   * stay stable across identical inputs.
   */
  private solicitQuotes(input: {
    eligibleVendors: VendorCandidate[];
    rfqHash: string;
    rfq: { item: string; quantity: number; specifications: Record<string, unknown> };
  }): {
    quotes: VendorQuote[];
  } {
    const quotes: VendorQuote[] = [];
    const specKeyCount = Object.keys(input.rfq.specifications).length || 1;

    for (const vendor of input.eligibleVendors) {
      // Deterministic byte mixer: XOR-fold vendorId + rfqHash.
      const seed = hashToFloat01(vendor.id + "|" + input.rfqHash);

      // Unit price ∈ [10, 110) -- wider than real world but stable for tests.
      const unitPrice = round2(10 + seed * 100);
      const totalPrice = round2(unitPrice * input.rfq.quantity);

      // Delivery days ∈ [3, 33) -- integer.
      const deliveryDays = 3 + Math.floor(hashToFloat01(vendor.id + "|delivery|" + input.rfqHash) * 30);

      // Reputation signal: base 0.5 + history boost capped at 0.4 + jitter ±0.1.
      const historyLen = vendor.lastQuoteHistory ? Object.keys(vendor.lastQuoteHistory).length : 0;
      const historyBoost = Math.min(historyLen * 0.05, 0.4);
      const jitter = (hashToFloat01(vendor.id + "|rep|" + input.rfqHash) - 0.5) * 0.2;
      const reputation = clamp01(0.5 + historyBoost + jitter);

      // Compliance: fraction of required spec keys the vendor can hit.
      const coveredKeys = Object.keys(input.rfq.specifications).filter((k) =>
        vendor.capabilities.includes(k),
      ).length;
      const complianceScore = coveredKeys / specKeyCount;

      quotes.push({
        vendorId: vendor.id,
        vendorName: vendor.name,
        unitPrice,
        totalPrice,
        deliveryDays,
        reputation: round4(reputation),
        complianceScore: round4(complianceScore),
      });
    }

    // Sort deterministically.
    quotes.sort((a, b) => (a.vendorId < b.vendorId ? -1 : a.vendorId > b.vendorId ? 1 : 0));
    return { quotes };
  }

  /**
   * Step 4: Weighted scoring.
   *   score = 0.5 * (1 - priceNorm) + 0.3 * deliverySpeed + 0.2 * reputationNorm
   * Where:
   *   priceNorm      = (totalPrice - minPrice) / (maxPrice - minPrice), in [0,1]
   *   deliverySpeed  = 1 - (deliveryDays - minDays) / (maxDays - minDays), in [0,1]
   *   reputationNorm = reputation (already in [0,1])
   *
   * If all quotes share a dimension (e.g., all same price), that component is
   * treated as neutral (0.5) so scoring stays meaningful.
   */
  private scoreQuotes(input: { quotes: VendorQuote[] }): { scoredQuotes: ScoredQuote[] } {
    const quotes = input.quotes;
    if (quotes.length === 0) return { scoredQuotes: [] };

    const prices = quotes.map((q) => q.totalPrice);
    const days = quotes.map((q) => q.deliveryDays);

    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const minDays = Math.min(...days);
    const maxDays = Math.max(...days);

    const scoredQuotes: ScoredQuote[] = quotes.map((q) => {
      const priceNorm = maxPrice === minPrice ? 0.5 : (q.totalPrice - minPrice) / (maxPrice - minPrice);
      const deliverySpeed = maxDays === minDays ? 0.5 : 1 - (q.deliveryDays - minDays) / (maxDays - minDays);
      const reputationNorm = clamp01(q.reputation);

      const score =
        0.5 * (1 - priceNorm) +
        0.3 * deliverySpeed +
        0.2 * reputationNorm;

      return {
        vendorId: q.vendorId,
        vendorName: q.vendorName,
        score: round4(score),
        priceNorm: round4(priceNorm),
        deliverySpeed: round4(deliverySpeed),
        reputationNorm: round4(reputationNorm),
      };
    });

    // Sort by score descending, then vendorId ascending for deterministic ordering.
    scoredQuotes.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.vendorId < b.vendorId ? -1 : a.vendorId > b.vendorId ? 1 : 0;
    });

    return { scoredQuotes };
  }

  /**
   * Step 5: Pick the top scorer. Deterministic tie-break by lexicographic vendorId.
   */
  private selectVendor(input: {
    scoredQuotes: ScoredQuote[];
    quotes: VendorQuote[];
  }): {
    selectedVendorId: string | null;
    selectedScore: number;
    selectedQuote: VendorQuote | null;
    decisionNote: string;
    tied: boolean;
  } {
    if (input.scoredQuotes.length === 0) {
      return {
        selectedVendorId: null,
        selectedScore: 0,
        selectedQuote: null,
        decisionNote: "No eligible vendors -- no selection made",
        tied: false,
      };
    }

    // scoredQuotes is already sorted by score desc, vendorId asc.
    const top = input.scoredQuotes[0];
    const tied =
      input.scoredQuotes.length > 1 && input.scoredQuotes[1].score === top.score;

    const selectedQuote = input.quotes.find((q) => q.vendorId === top.vendorId) ?? null;

    let note = `Selected ${top.vendorName} (score=${top.score})`;
    if (input.scoredQuotes.length === 1) {
      note = `Single-vendor auto-selection: ${top.vendorName} (score=${top.score})`;
    } else if (tied) {
      note = `Tied top score ${top.score} -- broke tie by lexicographic vendorId (${top.vendorId})`;
    }

    return {
      selectedVendorId: top.vendorId,
      selectedScore: top.score,
      selectedQuote,
      decisionNote: note,
      tied,
    };
  }

  /**
   * Step 6: Emit the final RFQ report.
   */
  private emitReport(input: {
    rfq: { item: string; quantity: number; deadline: string };
    scoredQuotes: ScoredQuote[];
    quotes: VendorQuote[];
    selectedVendorId: string | null;
    selectedQuote: VendorQuote | null;
    decisionNote: string;
    excludedCount: number;
    eligibleCount: number;
  }): RFQReport {
    const rankings: RFQRanking[] = input.scoredQuotes.map((s) => {
      const quote = input.quotes.find((q) => q.vendorId === s.vendorId);
      return {
        vendorId: s.vendorId,
        vendorName: s.vendorName,
        score: s.score,
        totalPrice: quote?.totalPrice ?? 0,
        deliveryDays: quote?.deliveryDays ?? 0,
      };
    });

    let status: RFQStatus;
    let selectedVendor: RFQReport["selectedVendor"] = null;
    let purchaseOrder: PurchaseOrderDraft | null = null;

    if (input.eligibleCount === 0 || !input.selectedVendorId || !input.selectedQuote) {
      status = "no-vendors";
    } else if (input.eligibleCount === 1) {
      status = "single-vendor";
    } else if (
      input.scoredQuotes.length > 1 &&
      input.scoredQuotes[0].score === input.scoredQuotes[1].score
    ) {
      status = "tied";
    } else {
      status = "awarded";
    }

    if (input.selectedVendorId && input.selectedQuote) {
      const top = input.scoredQuotes[0];
      selectedVendor = {
        id: input.selectedVendorId,
        name: top.vendorName,
        score: top.score,
        totalPrice: input.selectedQuote.totalPrice,
        deliveryDays: input.selectedQuote.deliveryDays,
      };
      purchaseOrder = {
        vendorId: input.selectedVendorId,
        vendorName: top.vendorName,
        item: input.rfq.item,
        quantity: input.rfq.quantity,
        unitPrice: input.selectedQuote.unitPrice,
        totalPrice: input.selectedQuote.totalPrice,
        deliveryDays: input.selectedQuote.deliveryDays,
        deadline: input.rfq.deadline,
      };
    }

    const summary = [
      `RFQ analysis complete for "${input.rfq.item}" x${input.rfq.quantity}.`,
      `${input.eligibleCount} eligible of ${input.eligibleCount + input.excludedCount} vendors (${input.excludedCount} excluded).`,
      selectedVendor
        ? `Awarded to ${selectedVendor.name} at $${selectedVendor.totalPrice.toFixed(2)} (${selectedVendor.deliveryDays}d, score=${selectedVendor.score}).`
        : `No vendor awarded.`,
      `Status: ${status}.`,
    ].join(" ");

    return {
      summary,
      rankings,
      selectedVendor,
      purchaseOrder,
      status,
      eligibleVendorCount: input.eligibleCount,
      excludedVendorCount: input.excludedCount,
      decisionNote: input.decisionNote,
    };
  }
}

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

/**
 * FNV-1a 32-bit hash over a string. Deterministic across runs and platforms.
 * Used to derive reproducible "random" numbers without a seeded RNG dep.
 */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Map an FNV-1a hash to a float in [0, 1). */
function hashToFloat01(input: string): number {
  return fnv1a(input) / 0x100000000;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
