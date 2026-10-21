/**
 * CapabilityObservationV1: read-only aggregation of job executions and tool receipts.
 *
 * RULES
 *  - Each input source is independently read or unavailable; failed reads are not empty reads.
 *  - A subject matches exact identifiers, without inferring cross-source attribution.
 *  - Each figure excludes only rows unreadable on the axes it actually uses.
 *  - Simulated work cannot contribute to reliability, turnaround or released prices.
 *  - Counts and evidence are recorded claims, never outcome or signature verification.
 *  - Prices are exact base units, grouped per currency; free calls are not zero prices.
 *  - Percentiles use nearest rank with exact BigInt comparisons.
 *  - Read times produce asOf but never affect the canonical observation digest.
 *  - Identifiers and currency entries have a stable code-unit sort order.
 *
 * Versioning: PRE-RELEASE. Until the first of a merged producer (code that emits or
 * stores an observation or its digest), a merged consumer outside tests, or the
 * first npm publish of @pcc/spec that carries this type, the shape may change under
 * the same CAPABILITY_OBSERVATION_SCHEMA_ID, and every change regenerates the golden
 * vectors in the same change. The change that ends pre-release pins the structural
 * fingerprint of these types and the golden vectors as a corpus. After it, every
 * shape, enum or accepted-value change bumps CAPABILITY_OBSERVATION_SCHEMA_ID.
 *
 * Browser-safe: no Node imports.
 */

import { isTerminalExecutionPhase, type JobExecutionDTO, type ReadError } from "./job-execution.js";
import { currencyDecimals, toBaseUnits } from "./operator-work.js";
import type { InvocationReceipt } from "../types/invocation-receipt.js";
import { canonicalize, sha256 } from "../util/canonical.js";
import { compareCodeUnits } from "../util/code-unit-order.js";

/** The versioned structure and meaning of a capability observation. */
export const CAPABILITY_OBSERVATION_SCHEMA_ID = "pcc.capability-observation/v1" as const;

/** Most ids a figure cites; `sources.total` counts them all. */
export const CAPABILITY_OBSERVATION_SOURCE_ID_LIMIT = 20;

/** Why a figure's value is null, unavailable or not available, or weaker than it looks. Closed. */
export const OBSERVATION_REASONS = Object.freeze([
  "no_samples",
  "source_read_failed",
  "signatures_unchecked",
  "no_public_outcome_verdict",
  "job_attribution_self_declared",
] as const);

/** Closed explanations of a figure's state or recorded assurance. */
export type ObservationReason = (typeof OBSERVATION_REASONS)[number];

/** Assurance level claimed by a figure; higher levels are not yet available. */
export type ObservationLevel =
  | "L0_self_attested"
  | "L1_gateway_recorded"
  | "L2_kernel_signed"
  | "L3_oracle_verified";

/** Whether a figure has usable samples, partial samples or no available value. */
export type ObservationFigureState = "ok" | "partial" | "unavailable" | "not_available";

/**
 * settlement_network_unrecorded: Neither source records a settlement network, so this amount
 * cannot be confirmed as value moved on any named network. It is a recorded amount.
 */
export type ObservationNotice = "settlement_network_unrecorded";

/**
 * price_unrecognized: Some rows record a price this read model does not recognize as a
 * countable amount, so they are counted in uncounted and never enter the p50. For a released
 * price: an unknown currency, or an amount that does not convert exactly. For a paid price: an
 * amount that does not convert exactly to more than zero, or a price or payment hash recorded
 * without the other.
 */
export type ObservationUncountedReason = "price_unrecognized";

/** An exact, source-specific key for one observed capability or one indexed tool. */
export type ObservationSubject =
  | {
      /** This subject identifies one capability offered on one kernel. */
      kind: "capability";
      /** Exact capability identifier. */
      capabilityId: string;
      /** Exact kernel identifier. */
      kernelId: string;
    }
  | {
      /** This subject identifies one version of one indexed tool. */
      kind: "indexed_tool";
      /** Exact indexed-tool identifier. */
      indexedToolId: string;
      /** Exact content identifier of the indexed tool. */
      toolCid: string;
    };

/** A source read with rows and a read time, or a failed read with its error. */
export type ObservationSourceRead<Row> =
  | {
      /** A source was successfully read, even if it held no rows. */
      state: "read";
      /** All rows from that source in this read. */
      rows: readonly Row[];
      /** When the source was read; excluded from the digest. */
      asOf: string;
    }
  | {
      /** This source could not be read, not a successful empty read. */
      state: "unavailable";
      /** Safe, source-provided failure details. */
      error: ReadError;
    };

/** The two independent inputs required for a capability observation. */
export interface CapabilityObservationInput {
  /** Exact subject to attribute rows to. */
  subject: ObservationSubject;
  /** Execution read or its explicit failure. */
  jobs: ObservationSourceRead<JobExecutionDTO>;
  /** Invocation-receipt read or its explicit failure. */
  receipts: ObservationSourceRead<InvocationReceipt>;
}

/** The digest-safe record of a source's read state, without any read times. */
export type ObservationInputState =
  | {
      /** A read took place. */
      state: "read";
      /** Total source rows, including unrelated subjects. */
      rows: number;
    }
  | {
      /** An unavailable read is not a zero-row read. */
      state: "unavailable";
      /** Safe, field-by-field copy of the source error. */
      error: ReadError;
    };

/** A figure plus the limits and provenance of its evidence. */
export interface ObservationFigure<T> {
  /** Usability of the figure's sample set. */
  state: ObservationFigureState;
  /** Aggregated number or statistic, null if no usable value exists. */
  value: T | null;
  /** Count of contributing rows, including zero-valued rows in count figures. */
  n: number;
  /** Candidate rows excluded because a required axis could not be read. */
  unreadable: number;
  /** The level this figure's value is reported at. A not_available or unavailable figure has no value, so it claims nothing. */
  level: ObservationLevel;
  /** Closed explanation of a missing or qualified value. */
  reason: ObservationReason | null;
  /** Source kind and the sorted, bounded identifiers of cited rows. */
  sources: {
    /** Whether these identifiers refer to jobs or invocation receipts. */
    kind: "job" | "receipt";
    /** First twenty ids in code-unit order. */
    ids: string[];
    /** Full number of cited rows, including those beyond the id limit. */
    total: number;
  };
}

/** One currency's nearest-rank median in integer base units. */
export interface ObservationCurrencyAmount {
  /** Normalized uppercase currency code. */
  currency: string;
  /** Exact decimal precision from the shared currency registry. */
  decimals: number;
  /** Nearest-rank median as an integer string of base units. */
  p50: string;
  /** Count of paid or released samples in this currency. */
  n: number;
}

/** A money figure, with unusable prices counted separately and a network notice. */
export interface ObservationMoneyFigure extends ObservationFigure<ObservationCurrencyAmount[]> {
  /** Rows with unrecognizable prices, omitted from all medians. */
  uncounted: number;
  /** Closed explanation for uncounted prices, null when none exist. */
  uncountedReason: ObservationUncountedReason | null;
  /** Limits on what can be inferred from the recorded amounts. */
  notices: ObservationNotice[];
}

/** One digestible read-only projection of recorded capability activity. */
export interface CapabilityObservationV1 {
  /** Identifies this observation structure and its semantics. */
  schemaId: typeof CAPABILITY_OBSERVATION_SCHEMA_ID;
  /** Hash of the canonical body, excluding this property and all read times. */
  observationDigest: string;
  /** Oldest validated source or job read time, null if nothing was read. */
  asOf: string | null;
  /** Exact identifiers of the observed subject; no display label is included. */
  subject: ObservationSubject;
  /** Independent job and receipt read states, without read times. */
  inputs: { jobs: ObservationInputState; receipts: ObservationInputState };
  /** Every matched job, simulated work included. Buckets are executor-reported, not verified. */
  outcomes: Record<"completed" | "failed" | "timed_out" | "cancelled" | "open" | "unknown", ObservationFigure<number>>;
  /** Completed of terminal, as the executor reported them; not a verified outcome. */
  reliability: ObservationFigure<{ completed: number; terminal: number }>;
  /** Turnaround distributions, excluding invalid or reverse timestamps. */
  latencyMs: {
    /** From the job row's creation (createdAt, not an execution start) to completedAt. */
    jobs: {
      /** Nearest-rank median job duration, in milliseconds. */
      p50: ObservationFigure<string>;
      /** Nearest-rank ninetieth-percentile job duration, in milliseconds. */
      p90: ObservationFigure<string>;
    };
    /** From each receipt's request timestamp to its response timestamp. */
    receipts: {
      /** Nearest-rank median receipt duration, in milliseconds. */
      p50: ObservationFigure<string>;
      /** Nearest-rank ninetieth-percentile receipt duration, in milliseconds. */
      p90: ObservationFigure<string>;
    };
  };
  /** Recorded monetary figures in exact base units. */
  price: {
    /** Reported released (record only): a milestone amount, not independently confirmed payment. */
    released: ObservationMoneyFigure;
    /** Price the receipt records as paid, with its payment hash: a recorded amount. A missing or null key counts as absent. */
    paid: ObservationMoneyFigure;
  };
  /** Counts from the receipt source only. */
  calls: {
    /** Receipts that record neither a price nor a payment hash, whatever the tool's listed price. */
    free: ObservationFigure<number>;
    /** Responses with status at least 400. */
    errorStatus: ObservationFigure<number>;
  };
  /** Gateway-stored evidence claims, without checked signatures. */
  evidence: {
    /** Jobs that have a recorded bundle. */
    jobsWithBundle: ObservationFigure<number>;
    /** Jobs with one or more recorded fabricated events. */
    jobsWithFabricatedEvents: ObservationFigure<number>;
    /** Maximum listed claim and whether truncation makes it only a lower bound. */
    maxClaimedTier: ObservationFigure<{ tier: number; lowerBound: boolean }>;
    /** Higher-level evidence has no publicly checkable value here. */
    level: ObservationFigure<never>;
  };
  /** Unavailable outcome verification and recorded, self-attributed capture verdict counts. */
  verification: {
    /** No public verdict of job outcome is present in the source. */
    outcome: ObservationFigure<never>;
    /** Per-verdict counts attributed using the uploader's own job label. */
    captureChecks: Record<"pass" | "partial" | "fail" | "unrecognized", ObservationFigure<number>>;
  };
  /** Rows not included or not identifiable, with null meaning source unreadable. */
  excluded: {
    /** Matched jobs explicitly marked simulated by a readable axis. */
    simulated: number | null;
    /** Matched jobs with a readable settlement whose payout is unknown. */
    unknownPayout: number | null;
    /** Rows belonging to another subject, not evidence for this one. */
    otherSubject: {
      /** Jobs that did not match this exact subject, null on failed read. */
      jobs: number | null;
      /** Receipts that did not match this exact subject, null on failed read. */
      receipts: number | null;
    };
  };
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const NETWORK_NOTICE: ObservationNotice[] = ["settlement_network_unrecorded"];
const L1: ObservationLevel = "L1_gateway_recorded";

type SourceKind = "job" | "receipt";
type OutcomeBucket = keyof CapabilityObservationV1["outcomes"];
type CaptureBucket = keyof CapabilityObservationV1["verification"]["captureChecks"];

function instantOf(value: unknown): number | null {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) return null;
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return null;
  if (new Date(instant).toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  return instant;
}

function durationBetween(start: string | null, end: string | null): bigint | null {
  const first = instantOf(start);
  const last = instantOf(end);
  return first === null || last === null || last < first ? null : BigInt(last - first);
}

function readableSettlement(row: JobExecutionDTO): boolean {
  const link = row.settlement.link;
  return link === "linked" || link === "not_linked" || link === "ambiguous" || link === "conflicting";
}

function nonnegativeSafe(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readableEvidence(row: JobExecutionDTO): boolean {
  const evidence = row.evidence;
  return (evidence.state === "none" || evidence.state === "received") && nonnegativeSafe(evidence.fabricatedEventCount);
}

function readableCapture(row: JobExecutionDTO): boolean {
  const state = row.verification.captureChecks.state;
  return state === "none" || state === "present";
}

function simulated(row: JobExecutionDTO): boolean {
  return (readableSettlement(row) && (row.settlement.payout === "simulated" || row.settlement.record?.simulated === true)) ||
    (readableEvidence(row) && row.evidence.state === "received" && row.evidence.fabricatedEventCount! > 0);
}

function figure<T>(
  kind: SourceKind,
  sourceRead: boolean,
  candidates: number,
  unreadable: number,
  n: number,
  value: T | null,
  citedIds: readonly string[],
  valueReason: ObservationReason | null = null,
  level: ObservationLevel = L1,
): ObservationFigure<T> {
  const unavailable = !sourceRead || (candidates > 0 && unreadable === candidates);
  const sampleCount = unavailable ? 0 : n;
  const ids = unavailable || sampleCount === 0 ? [] : [...citedIds].sort(compareCodeUnits);
  return {
    state: unavailable ? "unavailable" : unreadable > 0 ? "partial" : "ok",
    value: sampleCount === 0 ? null : value,
    n: sampleCount,
    unreadable: sourceRead ? unreadable : 0,
    level,
    reason: unavailable ? "source_read_failed" : sampleCount === 0 ? "no_samples" : valueReason,
    sources: { kind, ids: ids.slice(0, CAPABILITY_OBSERVATION_SOURCE_ID_LIMIT), total: ids.length },
  };
}

function missingHigherLevel(
  jobsRead: boolean,
  level: ObservationLevel,
  reason: ObservationReason,
): ObservationFigure<never> {
  if (!jobsRead) return figure<never>("job", false, 0, 0, 0, null, [], null, level);
  return {
    state: "not_available", value: null, n: 0, unreadable: 0, level, reason,
    sources: { kind: "job", ids: [], total: 0 },
  };
}

function moneyFigure(
  kind: SourceKind,
  sourceRead: boolean,
  candidates: number,
  unreadable: number,
  amounts: ReadonlyMap<string, { decimals: number; values: bigint[] }>,
  countedIds: readonly string[],
  uncounted: number,
): ObservationMoneyFigure {
  const values: ObservationCurrencyAmount[] = [...amounts.entries()]
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([currency, entry]) => ({
      currency,
      decimals: entry.decimals,
      p50: String(nearestRankPercentile(entry.values, 50)),
      n: entry.values.length,
    }));
  const base = figure("job" === kind ? "job" : "receipt", sourceRead, candidates, unreadable,
    countedIds.length, values.length === 0 ? null : values, countedIds);
  const allUnreadable = sourceRead && candidates > 0 && candidates === unreadable;
  const actualUncounted = sourceRead && !allUnreadable ? uncounted : 0;
  return {
    ...base,
    uncounted: actualUncounted,
    uncountedReason: actualUncounted > 0 ? "price_unrecognized" : null,
    notices: [...NETWORK_NOTICE],
  };
}

function addPrice(
  groups: Map<string, { decimals: number; values: bigint[] }>,
  currency: string,
  decimals: number,
  base: string,
): void {
  const existing = groups.get(currency);
  const value = BigInt(base);
  if (existing) existing.values.push(value);
  else groups.set(currency, { decimals, values: [value] });
}

function outcomeBucket(phase: JobExecutionDTO["execution"]["phase"]): OutcomeBucket {
  switch (phase) {
    case "completed": case "failed": case "timed_out": case "cancelled": return phase;
    case "pending": case "queued": case "dispatched": case "running":
    case "awaiting_handoff": case "paused": return "open";
    default: return "unknown";
  }
}

function safeCountSum(rows: readonly JobExecutionDTO[], verdict: CaptureBucket): number {
  let sum = 0n;
  for (const row of rows) sum += BigInt(row.verification.captureChecks[verdict]!);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError("capability observation: capture count is not a safe integer");
  return Number(sum);
}

/** Return the pth value by one-based nearest rank, comparing BigInts and leaving input untouched. */
export function nearestRankPercentile(values: readonly bigint[], percentile: 50 | 90): bigint | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const rank = Math.floor((percentile * sorted.length + 99) / 100);
  return sorted[rank - 1]!;
}

/** Build a source-faithful, order-independent observation without I/O or inferred verification. */
export async function summarizeObservations(input: CapabilityObservationInput): Promise<CapabilityObservationV1> {
  let oldest: number | null = null;
  const acceptTime = (instant: number): void => {
    oldest = oldest === null ? instant : Math.min(oldest, instant);
  };

  if (input.jobs.state === "read") {
    const at = instantOf(input.jobs.asOf);
    if (at === null) throw new TypeError("capability observation: jobs.asOf is not an ISO-8601 UTC timestamp");
    acceptTime(at);
    for (const row of input.jobs.rows) {
      const rowTime = instantOf(row.asOf);
      if (rowTime === null) throw new TypeError(`capability observation: the asOf of job ${row.job.jobId} is not an ISO-8601 UTC timestamp`);
      acceptTime(rowTime);
    }
    const seen = new Set<string>();
    for (const row of input.jobs.rows) {
      if (seen.has(row.job.jobId)) throw new TypeError(`capability observation: job ${row.job.jobId} is listed twice`);
      seen.add(row.job.jobId);
    }
  }
  if (input.receipts.state === "read") {
    const at = instantOf(input.receipts.asOf);
    if (at === null) throw new TypeError("capability observation: receipts.asOf is not an ISO-8601 UTC timestamp");
    acceptTime(at);
    const seen = new Set<string>();
    for (const row of input.receipts.rows) {
      if (seen.has(row.receiptCID)) throw new TypeError(`capability observation: receipt ${row.receiptCID} is listed twice`);
      seen.add(row.receiptCID);
    }
  }

  const subject: ObservationSubject = input.subject.kind === "capability"
    ? { kind: "capability", capabilityId: input.subject.capabilityId, kernelId: input.subject.kernelId }
    : { kind: "indexed_tool", indexedToolId: input.subject.indexedToolId, toolCid: input.subject.toolCid };
  const jobsRead = input.jobs.state === "read";
  const receiptsRead = input.receipts.state === "read";
  const jobs = input.jobs.state === "read" && subject.kind === "capability"
    ? input.jobs.rows.filter((row) => row.job.capabilityId === subject.capabilityId && row.job.kernelId === subject.kernelId)
    : [];
  const receipts = input.receipts.state === "read" && subject.kind === "indexed_tool"
    ? input.receipts.rows.filter((row) => row.indexedToolId === subject.indexedToolId && row.toolCID === subject.toolCid)
    : [];

  const inputs: CapabilityObservationV1["inputs"] = {
    jobs: input.jobs.state === "read" ? { state: "read", rows: input.jobs.rows.length }
      : { state: "unavailable", error: { code: input.jobs.error.code, message: input.jobs.error.message } },
    receipts: input.receipts.state === "read" ? { state: "read", rows: input.receipts.rows.length }
      : { state: "unavailable", error: { code: input.receipts.error.code, message: input.receipts.error.message } },
  };

  const outcomes = {} as CapabilityObservationV1["outcomes"];
  const buckets: readonly OutcomeBucket[] = ["completed", "failed", "timed_out", "cancelled", "open", "unknown"];
  for (const bucket of buckets) {
    const hits = jobs.filter((row) => outcomeBucket(row.execution.phase) === bucket);
    outcomes[bucket] = figure("job", jobsRead, jobs.length, 0, jobs.length, hits.length,
      hits.map((row) => row.job.jobId));
  }

  const readableForWork = (row: JobExecutionDTO): boolean => readableSettlement(row) && readableEvidence(row);
  const terminal = jobs.filter((row) => isTerminalExecutionPhase(row.execution.phase));
  const unreadableTerminal = terminal.filter((row) => !readableForWork(row)).length;
  const usableTerminal = terminal.filter((row) => readableForWork(row) && !simulated(row));
  const reliability = figure("job", jobsRead, terminal.length, unreadableTerminal, usableTerminal.length,
    { completed: usableTerminal.filter((row) => row.execution.phase === "completed").length, terminal: usableTerminal.length },
    usableTerminal.map((row) => row.job.jobId));

  const completed = jobs.filter((row) => row.execution.phase === "completed");
  const unreadableCompleted = completed.filter((row) => !readableForWork(row)).length;
  const completedDurations = completed.flatMap((row) => {
    if (!readableForWork(row) || simulated(row)) return [];
    const duration = durationBetween(row.job.createdAt, row.execution.completedAt);
    return duration === null ? [] : [{ id: row.job.jobId, duration }];
  });
  const makeJobLatency = (percentile: 50 | 90): ObservationFigure<string> =>
    figure("job", jobsRead, completed.length, unreadableCompleted, completedDurations.length,
      completedDurations.length ? String(nearestRankPercentile(completedDurations.map((row) => row.duration), percentile)) : null,
      completedDurations.map((row) => row.id));

  const released = new Map<string, { decimals: number; values: bigint[] }>();
  const releasedIds: string[] = [];
  let releasedUncounted = 0;
  const unreadableRelease = jobs.filter((row) => !readableForWork(row)).length;
  for (const row of jobs) {
    if (!readableForWork(row) || simulated(row)) continue;
    const { settlement } = row;
    const record = settlement.record;
    if (settlement.payout !== "reported_released" || settlement.payoutBasis !== "milestone_record" ||
      settlement.payoutConfirmation !== "record_only" || record === null || record.simulated !== false || record.milestone === null) continue;
    const currency = record.escrowTotal.currency;
    const decimals = currencyDecimals(currency);
    const base = toBaseUnits(record.milestone.amount, decimals);
    if (base === null || decimals === null) {
      releasedUncounted++;
      continue;
    }
    addPrice(released, currency.trim().toUpperCase(), decimals, base);
    releasedIds.push(row.job.jobId);
  }

  const evidenceReadable = jobs.filter(readableEvidence);
  const evidenceUnreadable = jobs.length - evidenceReadable.length;
  const withBundles = evidenceReadable.filter((row) => row.evidence.state === "received");
  const withFabrication = evidenceReadable.filter((row) => row.evidence.fabricatedEventCount! > 0);
  const tierEligible = evidenceReadable.filter((row) => row.evidence.bundles.every((bundle) => nonnegativeSafe(bundle.claimedTier)));
  const tierUnreadable = jobs.length - tierEligible.length;
  const tierSamples = tierEligible.filter((row) => row.evidence.state === "received" && row.evidence.bundles.length > 0);
  let maxTier = 0;
  for (const row of tierSamples) {
    for (const bundle of row.evidence.bundles) maxTier = Math.max(maxTier, bundle.claimedTier);
  }
  const evidence: CapabilityObservationV1["evidence"] = {
    jobsWithBundle: figure("job", jobsRead, jobs.length, evidenceUnreadable, evidenceReadable.length, withBundles.length,
      withBundles.map((row) => row.job.jobId), "signatures_unchecked"),
    jobsWithFabricatedEvents: figure("job", jobsRead, jobs.length, evidenceUnreadable, evidenceReadable.length, withFabrication.length,
      withFabrication.map((row) => row.job.jobId), "signatures_unchecked"),
    maxClaimedTier: figure("job", jobsRead, jobs.length, tierUnreadable, tierSamples.length,
      { tier: maxTier, lowerBound: tierSamples.some((row) => row.evidence.truncated) },
      tierSamples.map((row) => row.job.jobId), "signatures_unchecked"),
    level: missingHigherLevel(jobsRead, "L2_kernel_signed", "signatures_unchecked"),
  };

  const captureChecks = {} as CapabilityObservationV1["verification"]["captureChecks"];
  const captureBuckets: readonly CaptureBucket[] = ["pass", "partial", "fail", "unrecognized"];
  for (const verdict of captureBuckets) {
    const usable = jobs.filter((row) => readableCapture(row) && nonnegativeSafe(row.verification.captureChecks[verdict]));
    const unreadable = jobs.length - usable.length;
    const cited = usable.filter((row) => row.verification.captureChecks[verdict]! > 0);
    captureChecks[verdict] = figure("job", jobsRead, jobs.length, unreadable, usable.length,
      safeCountSum(usable, verdict), cited.map((row) => row.job.jobId), "job_attribution_self_declared");
  }

  const free = receipts.filter((row) => row.pricePaidUsdc == null && row.paymentTxHash == null);
  const errors = receipts.filter((row) => row.responseProjection.status >= 400);
  const receiptDurations = receipts.flatMap((row) => {
    const duration = durationBetween(row.requestProjection.timestamp, row.responseProjection.timestamp);
    return duration === null ? [] : [{ id: row.receiptCID, duration }];
  });
  const makeReceiptLatency = (percentile: 50 | 90): ObservationFigure<string> =>
    figure("receipt", receiptsRead, receipts.length, 0, receiptDurations.length,
      receiptDurations.length ? String(nearestRankPercentile(receiptDurations.map((row) => row.duration), percentile)) : null,
      receiptDurations.map((row) => row.id));
  const paid = new Map<string, { decimals: number; values: bigint[] }>();
  const paidIds: string[] = [];
  let paidUncounted = 0;
  const usdcDecimals = currencyDecimals("USDC");
  for (const row of receipts) {
    const hasPrice = row.pricePaidUsdc != null;
    const hasHash = row.paymentTxHash != null;
    if (!hasPrice && !hasHash) continue;
    const base = hasPrice && hasHash ? toBaseUnits(row.pricePaidUsdc, usdcDecimals) : null;
    if (base === null || usdcDecimals === null || BigInt(base) <= 0n) {
      paidUncounted++;
      continue;
    }
    addPrice(paid, "USDC", usdcDecimals, base);
    paidIds.push(row.receiptCID);
  }

  const body: Omit<CapabilityObservationV1, "asOf" | "observationDigest"> = {
    schemaId: CAPABILITY_OBSERVATION_SCHEMA_ID,
    subject,
    inputs,
    outcomes,
    reliability,
    latencyMs: {
      jobs: { p50: makeJobLatency(50), p90: makeJobLatency(90) },
      receipts: { p50: makeReceiptLatency(50), p90: makeReceiptLatency(90) },
    },
    price: {
      released: moneyFigure("job", jobsRead, jobs.length, unreadableRelease, released, releasedIds, releasedUncounted),
      paid: moneyFigure("receipt", receiptsRead, receipts.length, 0, paid, paidIds, paidUncounted),
    },
    calls: {
      free: figure("receipt", receiptsRead, receipts.length, 0, receipts.length, free.length,
        free.map((row) => row.receiptCID)),
      errorStatus: figure("receipt", receiptsRead, receipts.length, 0, receipts.length, errors.length,
        errors.map((row) => row.receiptCID)),
    },
    evidence,
    verification: {
      outcome: missingHigherLevel(jobsRead, "L3_oracle_verified", "no_public_outcome_verdict"),
      captureChecks,
    },
    excluded: {
      simulated: jobsRead ? jobs.filter(simulated).length : null,
      unknownPayout: jobsRead ? jobs.filter((row) => readableSettlement(row) && row.settlement.payout === "unknown").length : null,
      otherSubject: {
        jobs: input.jobs.state === "read" ? input.jobs.rows.length - jobs.length : null,
        receipts: input.receipts.state === "read" ? input.receipts.rows.length - receipts.length : null,
      },
    },
  };
  return {
    ...body,
    observationDigest: await sha256(canonicalize(body)),
    asOf: oldest === null ? null : new Date(oldest).toISOString(),
  };
}
