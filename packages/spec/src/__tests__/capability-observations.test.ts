/** Exact, source-scoped aggregate behavior and deterministic cross-language vectors. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_OBSERVATION_SCHEMA_ID,
  CAPABILITY_OBSERVATION_SOURCE_ID_LIMIT,
  OBSERVATION_REASONS,
  nearestRankPercentile,
  summarizeObservations,
  type CapabilityObservationInput,
  type CapabilityObservationV1,
  type ObservationCurrencyAmount,
  type ObservationFigure,
  type ObservationFigureState,
  type ObservationLevel,
  type ObservationMoneyFigure,
  type ObservationNotice,
  type ObservationReason,
  type ObservationSourceRead,
  type ObservationSubject,
} from "../readmodels/capability-observations.js";
import {
  isTerminalExecutionPhase,
  type EvidenceAxis,
  type ExecutionPhase,
  type JobExecutionDTO,
  type MoneyStateView,
  type ReadError,
  type SettlementAxis,
  type VerificationAxis,
} from "../readmodels/job-execution.js";
import type { InvocationReceipt } from "../types/invocation-receipt.js";
import type { SHA256 } from "../types/common.js";
import { DigitalCaptureClass } from "../types/dcc.js";
import { canonicalize, sha256 } from "../util/canonical.js";

const t = (milliseconds: number): string => new Date(Date.UTC(2000, 0, 1) + milliseconds).toISOString();
const READ_ERROR: ReadError = { code: "source_read_failed", message: "The store could not be read." };
const UNAVAILABLE: { state: "unavailable"; error: ReadError } = { state: "unavailable", error: READ_ERROR };
const CAP: ObservationSubject = { kind: "capability", capabilityId: "cap-1", kernelId: "kernel-1" };
const TOOL: ObservationSubject = { kind: "indexed_tool", indexedToolId: "tool-1", toolCid: "sha256:tool-v1" };
const N: ObservationNotice[] = ["settlement_network_unrecorded"];

function read<Row>(rows: readonly Row[], asOf = t(86_400_000)): ObservationSourceRead<Row> {
  return { state: "read", rows, asOf };
}
function observe(
  subject: ObservationSubject,
  jobs: ObservationSourceRead<JobExecutionDTO>,
  receipts: ObservationSourceRead<InvocationReceipt> = read([]),
): Promise<CapabilityObservationV1> {
  return summarizeObservations({ subject, jobs, receipts });
}
function MSV(sourceStatus: string, vocabulary: MoneyStateView["vocabulary"]): MoneyStateView {
  return { sourceStatus, vocabulary, tone: "settled", label: null, known: true };
}

const NOT_LINKED: SettlementAxis = {
  link: "not_linked", linkBasis: null, linkMatches: [], source: "gateway_escrow_record", record: null,
  payout: "unknown", payoutBasis: null, payoutUnknownReason: null, payoutConfirmation: null, error: null,
};
const SETTLEMENT_UNAVAILABLE: SettlementAxis = { ...NOT_LINKED, link: "unavailable", error: READ_ERROR };
interface ReleaseOptions {
  total?: string;
  simulated?: boolean;
  payout?: SettlementAxis["payout"];
  payoutBasis?: SettlementAxis["payoutBasis"];
  payoutConfirmation?: SettlementAxis["payoutConfirmation"];
  payoutUnknownReason?: SettlementAxis["payoutUnknownReason"];
}
function released(amount: string, currency: string, o: ReleaseOptions = {}): SettlementAxis {
  return {
    link: "linked", linkBasis: "job_cwm", linkMatches: ["job_cwm"], source: "gateway_escrow_record",
    record: {
      kind: "gateway_escrow_record", escrowId: "escrow-1",
      contractAddress: "0x00000000000000000000000000000000000000e1", contractVersion: null,
      simulated: o.simulated ?? false, escrow: MSV("SETTLED_RELEASED", "escrow_record"),
      milestoneMatch: "exact", milestoneClaimants: 1,
      milestone: {
        milestoneId: "milestone-1", stepId: "step-1",
        status: MSV("RELEASED", "escrow_milestone"), amount, challengeWindowEnd: null,
      },
      escrowTotal: { amount: o.total ?? amount, currency },
      createdAt: t(0), deadline: t(604_800_000), statusObservedAt: null,
    },
    payout: o.payout ?? "reported_released",
    payoutBasis: "payoutBasis" in o ? o.payoutBasis ?? null : "milestone_record",
    payoutUnknownReason: o.payoutUnknownReason ?? null,
    payoutConfirmation: "payoutConfirmation" in o ? o.payoutConfirmation ?? null : "record_only",
    error: null,
  };
}
const SIMULATED_ESCROW = released("10.00", "USDC", {
  simulated: true, payout: "simulated", payoutBasis: null, payoutConfirmation: null,
});

const EVIDENCE_NONE: EvidenceAxis = {
  state: "none", source: "gateway_evidence_store", bundleCount: 0, bundles: [], truncated: false,
  eventCount: 0, fabricatedEventCount: 0, latestStoredAt: null, error: null,
};
const EVIDENCE_UNAVAILABLE: EvidenceAxis = {
  state: "unavailable", source: "gateway_evidence_store", bundleCount: null, bundles: [], truncated: false,
  eventCount: null, fabricatedEventCount: null, latestStoredAt: null, error: READ_ERROR,
};
function bundles(tiers: number[], o: { truncated?: boolean; fabricated?: number } = {}): EvidenceAxis {
  return {
    state: "received", source: "gateway_evidence_store", bundleCount: o.truncated ? 21 : tiers.length,
    bundles: tiers.map((tier, i) => ({
      bundleId: "bundle-" + i, stepId: "step-1", bundleHash: "sha256:bundle-" + i,
      claimedTier: tier, eventCount: 1, fabricatedEventCount: i === 0 ? (o.fabricated ?? 0) : 0,
      signer: null, storedAt: t(0),
    })),
    truncated: o.truncated ?? false, eventCount: tiers.length,
    fabricatedEventCount: o.fabricated ?? 0, latestStoredAt: t(0), error: null,
  };
}

type Capture = VerificationAxis["captureChecks"];
const CAPTURE_NONE: Capture = {
  state: "none", source: "gateway_capture_verdicts", pass: 0, partial: 0, fail: 0,
  unrecognized: 0, latestAt: null, items: [], error: null,
};
const CAPTURE_UNAVAILABLE: Capture = {
  ...CAPTURE_NONE, state: "unavailable", pass: null, partial: null, fail: null,
  unrecognized: null, error: READ_ERROR,
};
function capture(counts: Pick<Capture, "pass" | "partial" | "fail" | "unrecognized">): Capture {
  return { ...CAPTURE_NONE, state: "present", latestAt: t(0), ...counts };
}

interface JobOptions {
  phase?: ExecutionPhase;
  createdAt?: string | null;
  completedAt?: string | null;
  asOf?: string;
  capabilityId?: string;
  kernelId?: string;
  settlement?: SettlementAxis;
  evidence?: EvidenceAxis;
  capture?: Capture;
}
function job(id: string, o: JobOptions = {}): JobExecutionDTO {
  const phase = o.phase ?? "completed";
  return {
    schemaId: "pcc.job-execution/v1", asOf: o.asOf ?? t(86_400_000),
    job: {
      jobId: id, stepId: "step-1", capabilityId: o.capabilityId ?? "cap-1", kernelId: o.kernelId ?? "kernel-1",
      capabilityType: "print", capabilityName: null, kernelName: null, contractedTier: null,
      createdAt: o.createdAt ?? t(0),
    },
    execution: {
      phase, sourceStatus: String(phase), source: "gateway_job_row",
      terminal: isTerminalExecutionPhase(phase), progressPercent: null,
      completedAt: "completedAt" in o ? o.completedAt ?? null : t(60_000),
    },
    evidence: o.evidence ?? EVIDENCE_NONE,
    verification: {
      outcome: { state: "not_available", reason: "no_public_outcome_verdict" },
      captureChecks: o.capture ?? CAPTURE_NONE,
    },
    settlement: o.settlement ?? NOT_LINKED,
    notices: [],
  };
}

interface ReceiptOptions {
  price?: string | null;
  tx?: string | null;
  indexedToolId?: string;
  toolCID?: SHA256;
  request?: string;
  response?: string;
  status?: number;
}
function receipt(cid: SHA256, o: ReceiptOptions = {}): InvocationReceipt {
  const built: InvocationReceipt = {
    receiptId: cid, receiptCID: cid, schemaVersion: "1.0",
    indexedToolId: o.indexedToolId ?? "tool-1", toolCID: o.toolCID ?? "sha256:tool-v1",
    toolSchemaHashAtCall: "sha256:schema-1",
    requestProjection: {
      method: "POST", url: "https://tool.example.test/run", headersHash: "sha256:h", bodyHash: "sha256:b",
      middlewareRedactions: [], timestamp: o.request ?? t(0),
    },
    responseProjection: {
      status: o.status ?? 200, headersHash: "sha256:h", bodyHash: "sha256:b",
      middlewareRedactions: [], timestamp: o.response ?? t(100),
    },
    requestedDccClass: DigitalCaptureClass.DCC1, effectiveDccClass: DigitalCaptureClass.DCC1,
    pccSignature: "sig", pccKeyId: "key-1", callerAgentId: "agent-1", callerSessionId: "session-1", pccFeeBps: 0,
  };
  if ("price" in o) {
    (built as unknown as { pricePaidUsdc: string | null | undefined }).pricePaidUsdc = o.price;
  }
  if ("tx" in o) {
    (built as unknown as { paymentTxHash: string | null | undefined }).paymentTxHash = o.tx;
  }
  return built;
}

function fig<T>(
  state: ObservationFigureState, value: T | null, n: number, unreadable: number,
  reason: ObservationReason | null, ids: string[], total: number,
  kind: "job" | "receipt" = "job", level: ObservationLevel = "L1_gateway_recorded",
): ObservationFigure<T> {
  return { state, value, n, unreadable, level, reason, sources: { kind, ids, total } };
}
function money(figure: ObservationFigure<ObservationCurrencyAmount[] | null>, uncounted = 0): ObservationMoneyFigure {
  return {
    ...figure, uncounted,
    uncountedReason: uncounted > 0 ? "price_unrecognized" : null,
    notices: N,
  };
}
function unavailable(kind: "job" | "receipt" = "job", level: ObservationLevel = "L1_gateway_recorded") {
  return fig("unavailable", null, 0, 0, "source_read_failed", [], 0, kind, level);
}
function empty(kind: "job" | "receipt" = "job") {
  return fig("ok", null, 0, 0, "no_samples", [], 0, kind);
}
function bodyOf(result: CapabilityObservationV1): Omit<CapabilityObservationV1, "asOf" | "observationDigest"> {
  const { asOf: _readTime, observationDigest: _hash, ...body } = result;
  return body;
}
function figuresOf(result: CapabilityObservationV1): ObservationFigure<unknown>[] {
  return [
    ...Object.values(result.outcomes), result.reliability,
    result.latencyMs.jobs.p50, result.latencyMs.jobs.p90,
    result.latencyMs.receipts.p50, result.latencyMs.receipts.p90,
    result.price.released, result.price.paid, result.calls.free, result.calls.errorStatus,
    result.evidence.jobsWithBundle, result.evidence.jobsWithFabricatedEvents,
    result.evidence.maxClaimedTier, result.evidence.level,
    result.verification.outcome, ...Object.values(result.verification.captureChecks),
  ];
}
function jobFiguresOf(result: CapabilityObservationV1): ObservationFigure<unknown>[] {
  return [
    ...Object.values(result.outcomes), result.reliability,
    result.latencyMs.jobs.p50, result.latencyMs.jobs.p90, result.price.released,
    result.evidence.jobsWithBundle, result.evidence.jobsWithFabricatedEvents,
    result.evidence.maxClaimedTier, result.evidence.level,
    result.verification.outcome, ...Object.values(result.verification.captureChecks),
  ];
}
function plusTime(timestamp: string, delta: number): string {
  return new Date(Date.parse(timestamp) + delta).toISOString();
}
function shiftReadTimes(input: CapabilityObservationInput, delta: number): CapabilityObservationInput {
  return {
    subject: input.subject,
    jobs: input.jobs.state === "read" ? {
      state: "read", asOf: plusTime(input.jobs.asOf, delta),
      rows: input.jobs.rows.map((row) => ({ ...row, asOf: plusTime(row.asOf, delta) })),
    } : input.jobs,
    receipts: input.receipts.state === "read"
      ? { ...input.receipts, asOf: plusTime(input.receipts.asOf, delta) }
      : input.receipts,
  };
}
function reverseInput(input: CapabilityObservationInput): CapabilityObservationInput {
  return {
    subject: input.subject,
    jobs: input.jobs.state === "read" ? { ...input.jobs, rows: [...input.jobs.rows].reverse() } : input.jobs,
    receipts: input.receipts.state === "read" ? { ...input.receipts, rows: [...input.receipts.rows].reverse() } : input.receipts,
  };
}
function rotate<Row>(rows: readonly Row[], offset: number): Row[] {
  return [...rows.slice(offset), ...rows.slice(0, offset)];
}
function rotateInput(input: CapabilityObservationInput): CapabilityObservationInput {
  return {
    subject: input.subject,
    jobs: input.jobs.state === "read" ? { ...input.jobs, rows: rotate(input.jobs.rows, 3) } : input.jobs,
    receipts: input.receipts.state === "read" ? { ...input.receipts, rows: rotate(input.receipts.rows, 2) } : input.receipts,
  };
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const PD_RECEIPTS: InvocationReceipt[] = [
  receipt("sha256:pd-a", { price: "0.50", tx: "tx-pd-a" }),
  receipt("sha256:pd-b", { price: "1.25", tx: "tx-pd-b" }),
  receipt("sha256:pd-c", { price: "2.00", tx: "tx-pd-c" }),
  receipt("sha256:pd-free-absent"),
  receipt("sha256:pd-free-null", { price: null, tx: null }),
  receipt("sha256:pd-zero", { price: "0", tx: "tx-pd-zero" }),
  receipt("sha256:pd-zero3", { price: "0.000", tx: "tx-pd-zero3" }),
  receipt("sha256:pd-price-only", { price: "1.10" }),
  receipt("sha256:pd-tx-only", { tx: "tx-pd-tx-only" }),
  receipt("sha256:pd-frac", { price: "1.0000004", tx: "tx-pd-frac" }),
  receipt("sha256:pd-text", { price: "abc", tx: "tx-pd-text" }),
  receipt("sha256:pd-neg", { price: "-1", tx: "tx-pd-neg" }),
];
const RX_RECEIPTS: InvocationReceipt[] = [
  receipt("sha256:rx-100", { response: t(100) }),
  receipt("sha256:rx-250", { response: t(250), status: 404 }),
  receipt("sha256:rx-50", { response: t(50), status: 500 }),
  receipt("sha256:rx-400", { response: t(400), status: 400 }),
  receipt("sha256:rx-302", { response: t(1_000), status: 302 }),
  receipt("sha256:rx-neg", { request: t(1_000), response: t(990) }),
  receipt("sha256:rx-fmt", { request: "2000-01-01 00:00:00", response: t(86_400_000) }),
];
const G_CAP: CapabilityObservationInput = {
  subject: CAP,
  jobs: read([
    job("g-ok-a", { settlement: released("10.00", "USDC"), capture: capture({ pass: 2, partial: 0, fail: 1, unrecognized: 0 }) }),
    job("g-ok-b", { completedAt: t(120_000), settlement: released("30.00", "USDC"), evidence: bundles([1, 3], { truncated: true }) }),
    job("g-ok-c", { completedAt: t(30_000), settlement: released("0.5", "ETH") }),
    job("g-failed", { phase: "failed" }),
    job("g-timed", { phase: "timed_out" }),
    job("g-running", { phase: "running" }),
    job("g-unknown", { phase: "unknown" }),
    job("g-sim", { settlement: SIMULATED_ESCROW }),
    job("g-fab", { settlement: released("70.00", "USDC"), evidence: bundles([0], { fabricated: 2 }) }),
    job("g-unread", { settlement: SETTLEMENT_UNAVAILABLE, capture: CAPTURE_UNAVAILABLE }),
    job("g-usd", { settlement: released("12.345", "USD") }),
    job("g-other", { kernelId: "kernel-2", asOf: t(80_000_000) }),
  ]),
  receipts: read([receipt("sha256:g-rcpt")]),
};
const G_TOOL: CapabilityObservationInput = {
  subject: TOOL, jobs: read([]), receipts: read([...PD_RECEIPTS, ...RX_RECEIPTS]),
};

interface GoldenCase {
  name: string;
  input: CapabilityObservationInput;
  expected: CapabilityObservationV1;
  canonicalBody: string;
}
async function buildVectors() {
  const selected: { name: string; input: CapabilityObservationInput }[] = [
    { name: "capability", input: G_CAP },
    { name: "indexed-tool", input: G_TOOL },
    { name: "jobs-unavailable", input: { subject: CAP, jobs: UNAVAILABLE, receipts: read([], t(3_600_000)) } },
    { name: "nothing-read", input: { subject: TOOL, jobs: UNAVAILABLE, receipts: UNAVAILABLE } },
  ];
  const cases: GoldenCase[] = [];
  for (const selectedCase of selected) {
    const expected = await summarizeObservations(selectedCase.input);
    cases.push({ ...selectedCase, expected, canonicalBody: canonicalize(bodyOf(expected)) });
  }
  const moved = await summarizeObservations(shiftReadTimes(reverseInput(G_CAP), 3_600_000));
  return {
    vector: "pcc.capability-observation/v1",
    note: "Public test data, generated by src/__tests__/capability-observations.test.ts. Regenerate it only on a deliberate change to the read model, with PCC_WRITE_VECTORS=1.",
    algorithm: 'observationDigest = "sha256:" + lowercase hex(sha256(UTF-8(canonicalize(body)))), where body is the observation without asOf and observationDigest, and canonicalize is packages/spec/src/util/canonical.ts. p50 and p90: nearest rank, rank = ceil(p * n / 100), 1-based, over BigInt values sorted ascending.',
    cases,
    permutation: {
      case: "capability",
      transform: "rows of both sources reversed; every read time and every row asOf plus 3600000 ms",
      expectedAsOf: moved.asOf,
      expectedDigest: moved.observationDigest,
    },
  };
}
const VECTOR = fileURLToPath(new URL("../readmodels/capability-observations.vectors.json", import.meta.url));

async function expectExactTypeError(promise: Promise<unknown>, message: string): Promise<void> {
  const error: unknown = await promise.then(() => null, (rejection: unknown) => rejection);
  expect(error).toBeInstanceOf(TypeError);
  expect((error as TypeError).message).toBe(message);
}

describe("nearest rank", () => {
  it("takes the hand-checked rank for n = 1, 2, 5, 6 and 10, and with duplicates", () => {
    const cases: Array<[bigint[], bigint | null, bigint | null]> = [
      [[7n], 7n, 7n],
      [[9n, 3n], 3n, 9n],
      [[50n, 10n, 40n, 20n, 30n], 30n, 50n],
      [[6n, 5n, 4n, 3n, 2n, 1n], 3n, 6n],
      [[100n, 90n, 80n, 70n, 60n, 50n, 40n, 30n, 20n, 10n], 50n, 90n],
      [[7n, 3n, 7n, 7n, 3n], 7n, 7n],
      [[5n, 5n, 5n, 8n], 5n, 8n],
      [[], null, null],
    ];
    for (const [input, p50, p90] of cases) {
      expect(nearestRankPercentile(input, 50)).toBe(p50);
      expect(nearestRankPercentile(input, 90)).toBe(p90);
    }
  });
  it("compares BigInt values exactly and leaves its argument unchanged", () => {
    const cases: Array<[bigint[], bigint, bigint | null]> = [
      [[10n, 9n], 9n, 10n],
      [[9007199254740993n, 9007199254740992n], 9007199254740992n, 9007199254740993n],
      [[9007199254740997n, 9007199254740995n, 9007199254740993n], 9007199254740995n, null],
    ];
    for (const [values, p50, p90] of cases) {
      const original = [...values];
      expect(nearestRankPercentile(values, 50)).toBe(p50);
      if (p90 !== null) expect(nearestRankPercentile(values, 90)).toBe(p90);
      expect(values).toEqual(original);
    }
  });
});

describe("inputs and asOf", () => {
  it("one source read and one unavailable", async () => {
    const a = await observe(CAP, read([
      job("as-a", { asOf: t(3_600_000) }), job("as-b", { asOf: t(5_400_000) }),
    ], t(7_200_000)), UNAVAILABLE);
    expect(a.asOf).toBe("2000-01-01T01:00:00.000Z");
    expect(a.inputs).toEqual({ jobs: { state: "read", rows: 2 }, receipts: { state: "unavailable", error: READ_ERROR } });
    expect(a.outcomes.completed).toEqual(fig("ok", 2, 2, 0, null, ["as-a", "as-b"], 2));
    expect(a.calls.free).toEqual(unavailable("receipt"));
    expect(a.calls.errorStatus).toEqual(unavailable("receipt"));
    expect(a.latencyMs.receipts.p50).toEqual(unavailable("receipt"));
    expect(a.latencyMs.receipts.p90).toEqual(unavailable("receipt"));
    expect(a.price.paid).toEqual(money(unavailable("receipt")));
    expect(a.excluded).toEqual({ simulated: 0, unknownPayout: 2, otherSubject: { jobs: 0, receipts: null } });

    const b = await observe(CAP, UNAVAILABLE, read([], t(100_000)));
    expect(b.asOf).toBe("2000-01-01T00:01:40.000Z");
    expect(jobFiguresOf(b)).toHaveLength(19);
    for (const actual of jobFiguresOf(b)) {
      const level = actual.level;
      expect(actual).toEqual(actual === b.price.released
        ? money(unavailable("job", level)) : unavailable("job", level));
    }
    expect(b.evidence.level.level).toBe("L2_kernel_signed");
    expect(b.verification.outcome.level).toBe("L3_oracle_verified");
    expect(b.calls.free).toEqual(empty("receipt"));
    expect(b.excluded).toEqual({ simulated: null, unknownPayout: null, otherSubject: { jobs: null, receipts: 0 } });
  });

  it("asOf is null and every figure unavailable when no source was read", async () => {
    const result = await observe(TOOL, UNAVAILABLE, UNAVAILABLE);
    expect(result.asOf).toBeNull();
    expect(result.inputs).toEqual({ jobs: UNAVAILABLE, receipts: UNAVAILABLE });
    expect(figuresOf(result)).toHaveLength(24);
    for (const actual of figuresOf(result)) {
      const kind = actual.sources.kind;
      const level = actual.level;
      const expected = actual === result.price.paid || actual === result.price.released
        ? money(unavailable(kind, level)) : unavailable(kind, level);
      expect(actual).toEqual(expected);
    }
    expect(result.excluded).toEqual({ simulated: null, unknownPayout: null, otherSubject: { jobs: null, receipts: null } });
    expect(result.observationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("asOf is the oldest read time, whether a row's or a source's, and a read with zero rows counts", async () => {
    const rows = [job("t-a", { asOf: t(14_400_000) }), job("t-b", { asOf: t(16_200_000) })];
    expect((await observe(CAP, read(rows, t(18_000_000)), read([], t(15_120_000)))).asOf)
      .toBe("2000-01-01T04:00:00.000Z");
    expect((await observe(CAP, read(rows, t(18_000_000)), read([], t(14_040_000)))).asOf)
      .toBe("2000-01-01T03:54:00.000Z");
    expect((await observe(CAP, read([], t(18_000_000)), read([], t(36_000)))).asOf)
      .toBe("2000-01-01T00:00:36.000Z");
    expect((await observe(CAP, read([], t(10_000)), read([], t(20_000)))).asOf)
      .toBe("2000-01-01T00:00:10.000Z");
    expect((await observe(CAP, read([job("t-c", { asOf: t(5_000) })], t(1_000)), read([], t(9_000)))).asOf)
      .toBe("2000-01-01T00:00:01.000Z");
  });

  it("compares instants, not strings, and returns one canonical form", async () => {
    expect((await observe(CAP, read([job("tie", { asOf: "2000-01-01T01:00:00Z" })],
      "2000-01-01T01:00:00Z"), read([], "2000-01-01T01:00:00.000Z"))).asOf)
      .toBe("2000-01-01T01:00:00.000Z");
    expect((await observe(CAP, read([], "2000-01-01T00:00:00.500Z"), read([], "2000-01-01T00:00:00Z"))).asOf)
      .toBe("2000-01-01T00:00:00.000Z");
    expect((await observe(CAP, read([], "2000-01-01T00:30:00Z"), read([], t(3_600_000)))).asOf)
      .toBe("2000-01-01T00:30:00.000Z");
  });

  it("every row of a read jobs source sets asOf, the subject's or not", async () => {
    const result = await observe(CAP, read([
      job("m-1", { asOf: t(14_400_000) }), job("other-1", { kernelId: "kernel-2", asOf: t(3_600_000) }),
    ], t(18_000_000)), read([], t(18_000_000)));
    expect(result.asOf).toBe("2000-01-01T01:00:00.000Z");
    expect(result.outcomes.completed).toEqual(fig("ok", 1, 1, 0, null, ["m-1"], 1));
    expect(result.excluded.otherSubject.jobs).toBe(1);
  });

  it("refuses a read time that is not an ISO-8601 UTC timestamp", async () => {
    const cases: Array<[ObservationSourceRead<JobExecutionDTO>, ObservationSourceRead<InvocationReceipt>, string]> = [
      [read([], "2000-01-01 00:00:00"), read([]), "capability observation: jobs.asOf is not an ISO-8601 UTC timestamp"],
      [read([]), read([], "2000-02-30T00:00:00.000Z"), "capability observation: receipts.asOf is not an ISO-8601 UTC timestamp"],
      [read([job("bad-asof", { asOf: "2000-01-01T00:00:00.5Z" })]), read([]),
        "capability observation: the asOf of job bad-asof is not an ISO-8601 UTC timestamp"],
      [read([], "2000-01-01T24:00:00.000Z"), read([]), "capability observation: jobs.asOf is not an ISO-8601 UTC timestamp"],
    ];
    for (const [jobs, receipts, message] of cases) {
      await expectExactTypeError(observe(CAP, jobs, receipts), message);
    }
  });

  it("refuses a job or a receipt listed twice", async () => {
    const duplicates: Array<[ObservationSourceRead<JobExecutionDTO>, ObservationSourceRead<InvocationReceipt>, string]> = [
      [read([job("dup-1"), job("dup-1")]), read([]), "capability observation: job dup-1 is listed twice"],
      [read([]), read([receipt("sha256:rcpt-dup"), receipt("sha256:rcpt-dup")]),
        "capability observation: receipt sha256:rcpt-dup is listed twice"],
    ];
    for (const [jobs, receipts, message] of duplicates) {
      await expectExactTypeError(observe(CAP, jobs, receipts), message);
    }
    expect((await observe(CAP, read([job("dup-1"), job("DUP-1")]))).outcomes.completed.value).toBe(2);
  });
});

describe("the digest", () => {
  it("the same rows in any order give the same observation", async () => {
    for (const input of [G_CAP, G_TOOL]) {
      const baseline = await summarizeObservations(input);
      expect(await summarizeObservations(reverseInput(input))).toEqual(baseline);
      expect(await summarizeObservations(rotateInput(input))).toEqual(baseline);
    }
  });

  it("changing only read times moves asOf and nothing else", async () => {
    const baseline = await summarizeObservations(G_CAP);
    expect(baseline.asOf).toBe("2000-01-01T22:13:20.000Z");
    const shifted = await summarizeObservations(shiftReadTimes(G_CAP, 3_600_000));
    expect(shifted.asOf).toBe("2000-01-01T23:13:20.000Z");
    const { asOf: _oldTime, ...baselineWithoutTime } = baseline;
    const { asOf: _newTime, ...shiftedWithoutTime } = shifted;
    expect(shiftedWithoutTime).toEqual(baselineWithoutTime);
    const changedReceipts: CapabilityObservationInput = {
      ...G_CAP, receipts: read(G_CAP.receipts.state === "read" ? G_CAP.receipts.rows : [], t(1_000)),
    };
    const moved = await summarizeObservations(changedReceipts);
    expect(moved.asOf).toBe("2000-01-01T00:00:01.000Z");
    expect(moved.observationDigest).toBe(baseline.observationDigest);
  });

  it("the digest is sha256 over the canonical body, and a cited row moves it", async () => {
    const baseline = await summarizeObservations(G_CAP);
    expect(baseline.observationDigest).toBe(await sha256(canonicalize(bodyOf(baseline))));
    expect(baseline.observationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    function checkNumbers(value: unknown): void {
      if (typeof value === "number") expect(Number.isSafeInteger(value)).toBe(true);
      if (value !== null && typeof value === "object") {
        for (const child of Object.values(value)) checkNumbers(child);
      }
    }
    checkNumbers(bodyOf(baseline));
    const smaller: CapabilityObservationInput = {
      ...G_CAP,
      jobs: G_CAP.jobs.state === "read"
        ? { ...G_CAP.jobs, rows: G_CAP.jobs.rows.filter((row) => row.job.jobId !== "g-fab") }
        : G_CAP.jobs,
    };
    const without = await summarizeObservations(smaller);
    expect(baseline.outcomes.completed.value).toBe(7);
    expect(without.outcomes.completed.value).toBe(6);
    expect(without.observationDigest).not.toBe(baseline.observationDigest);
  });

  it("cites at most 20 ids per figure, the first 20 in code-unit order", async () => {
    const rows = Array.from({ length: 21 }, (_, i) => job(`cap-${String(i).padStart(2, "0")}`)).reverse();
    const result = await observe(CAP, read(rows));
    const cited = Array.from({ length: 20 }, (_, i) => `cap-${String(i).padStart(2, "0")}`);
    expect(CAPABILITY_OBSERVATION_SOURCE_ID_LIMIT).toBe(20);
    expect(result.outcomes.completed).toEqual(fig("ok", 21, 21, 0, null, cited, 21));
  });
});

describe("subject", () => {
  it("a capability subject counts only rows with both ids exactly equal", async () => {
    const result = await observe(CAP, read([
      job("sb-1"), job("sb-2"), job("sb-k2", { kernelId: "kernel-2" }),
      job("sb-c2", { capabilityId: "cap-2" }), job("sb-case", { capabilityId: "CAP-1" }),
      job("sb-space", { kernelId: "kernel-1 " }),
    ]), read([receipt("sha256:sb-rcpt-a"), receipt("sha256:sb-rcpt-b")]));
    expect(result.outcomes.completed).toEqual(fig("ok", 2, 2, 0, null, ["sb-1", "sb-2"], 2));
    expect(result.excluded.otherSubject).toEqual({ jobs: 4, receipts: 2 });
    expect(result.calls.free).toEqual(empty("receipt"));
  });

  it("an indexed-tool subject counts only receipts with both ids exactly equal", async () => {
    const result = await observe(TOOL, read([job("sb-job")]), read([
      receipt("sha256:sb-a"), receipt("sha256:sb-b"),
      receipt("sha256:sb-cid2", { toolCID: "sha256:tool-v2" }),
      receipt("sha256:sb-tool2", { indexedToolId: "tool-2" }),
      receipt("sha256:sb-case", { indexedToolId: "TOOL-1" }),
    ]));
    expect(result.calls.free).toEqual(fig("ok", 2, 2, 0, null,
      ["sha256:sb-a", "sha256:sb-b"], 2, "receipt"));
    expect(result.excluded.otherSubject).toEqual({ jobs: 1, receipts: 3 });
    expect(result.outcomes.completed).toEqual(empty());
  });

  it("copies the subject field by field", async () => {
    const extra = { ...CAP, capabilityType: "print" } as ObservationSubject;
    const result = await observe(extra, read([job("sb-x")]), read([]));
    const baseline = await observe(CAP, read([job("sb-x")]), read([]));
    expect(result.subject).toEqual(CAP);
    expect(result.observationDigest).toBe(baseline.observationDigest);
  });
});

describe("outcomes, reliability and turnaround", () => {
  it("buckets every phase, keeps timed_out apart, and counts anything undocumented as unknown", async () => {
    const phases: Array<[string, ExecutionPhase]> = [
      ["oc-pending", "pending"], ["oc-queued", "queued"], ["oc-dispatched", "dispatched"],
      ["oc-running", "running"], ["oc-handoff", "awaiting_handoff"], ["oc-paused", "paused"],
      ["oc-completed", "completed"], ["oc-failed", "failed"], ["oc-timed", "timed_out"],
      ["oc-cancelled", "cancelled"], ["oc-unknown", "unknown"],
      ["oc-offtype", "settled" as ExecutionPhase],
    ];
    const result = await observe(CAP, read(phases.map(([id, phase]) => job(id, { phase }))));
    expect(result.outcomes.open).toEqual(fig("ok", 6, 12, 0, null,
      ["oc-dispatched", "oc-handoff", "oc-paused", "oc-pending", "oc-queued", "oc-running"], 6));
    expect(result.outcomes.completed).toEqual(fig("ok", 1, 12, 0, null, ["oc-completed"], 1));
    expect(result.outcomes.failed).toEqual(fig("ok", 1, 12, 0, null, ["oc-failed"], 1));
    expect(result.outcomes.timed_out).toEqual(fig("ok", 1, 12, 0, null, ["oc-timed"], 1));
    expect(result.outcomes.cancelled).toEqual(fig("ok", 1, 12, 0, null, ["oc-cancelled"], 1));
    expect(result.outcomes.unknown).toEqual(fig("ok", 2, 12, 0, null, ["oc-offtype", "oc-unknown"], 2));
  });

  it("reliability counts completed of terminal, without simulated work, unknown phases or unreadable rows", async () => {
    const rows = [
      job("rl-ok-1"), job("rl-ok-2"), job("rl-failed", { phase: "failed" }),
      job("rl-timed", { phase: "timed_out" }), job("rl-cancelled", { phase: "cancelled" }),
      job("rl-open", { phase: "running" }), job("rl-unknown", { phase: "unknown" }),
      job("rl-sim-escrow", { settlement: SIMULATED_ESCROW }),
      job("rl-sim-evidence", { phase: "failed", evidence: bundles([1], { fabricated: 2 }) }),
      job("rl-unread", { settlement: SETTLEMENT_UNAVAILABLE }),
    ];
    const result = await observe(CAP, read(rows));
    expect(result.reliability).toEqual(fig("partial", { completed: 2, terminal: 5 }, 5, 1, null,
      ["rl-cancelled", "rl-failed", "rl-ok-1", "rl-ok-2", "rl-timed"], 5));
    expect(result.outcomes.completed.value).toBe(4);
    expect(result.outcomes.completed.n).toBe(10);
    expect(result.outcomes.failed.value).toBe(2);
    expect(result.excluded).toEqual({ simulated: 2, unknownPayout: 8, otherSubject: { jobs: 0, receipts: 0 } });
  });

  it("job turnaround runs from creation to completion, by nearest rank, over completed and readable rows only", async () => {
    const rows = [
      job("lt-60", { completedAt: t(60_000) }), job("lt-120", { completedAt: t(120_000) }),
      job("lt-30", { completedAt: t(30_000) }), job("lt-nul", { completedAt: null }),
      job("lt-neg", { createdAt: t(10_000), completedAt: t(5_000) }),
      job("lt-fmt", { createdAt: "2000-01-01 00:00:00", completedAt: t(86_400_000) }),
      job("lt-sim", { completedAt: t(1_000), settlement: SIMULATED_ESCROW }),
      job("lt-unread", { completedAt: t(90_000), evidence: EVIDENCE_UNAVAILABLE }),
      job("lt-failed", { phase: "failed", completedAt: t(5_000) }),
    ];
    const result = await observe(CAP, read(rows));
    const cited = ["lt-120", "lt-30", "lt-60"];
    expect(result.latencyMs.jobs.p50).toEqual(fig("partial", "60000", 3, 1, null, cited, 3));
    expect(result.latencyMs.jobs.p90).toEqual(fig("partial", "120000", 3, 1, null, cited, 3));
  });

  it("an unknown payout stays unknown: never not_paid, never counted when unreadable", async () => {
    const result = await observe(CAP, read([
      job("uk-unknown", { settlement: released("1.00", "USDC", {
        payout: "unknown", payoutBasis: null, payoutConfirmation: null, payoutUnknownReason: "records_conflict",
      }) }),
      job("uk-notpaid", { settlement: released("1.00", "USDC", { payout: "not_paid", payoutConfirmation: null }) }),
      job("uk-refunded", { settlement: released("1.00", "USDC", { payout: "refunded" }) }),
      job("uk-unread", { settlement: SETTLEMENT_UNAVAILABLE }),
      job("uk-released", { settlement: released("1.00", "USDC") }),
    ]));
    expect(result.excluded.unknownPayout).toBe(1);
    expect(result.price.released).toEqual(money(fig("partial", [
      { currency: "USDC", decimals: 6, p50: "1000000", n: 1 },
    ], 1, 1, null, ["uk-released"], 1)));
  });
});

describe("money", () => {
  it("the released price is one p50 per currency, never pooled, never rounded", async () => {
    const rows = [
      job("mr-usdc-10", { settlement: released("10.00", "USDC", { total: "100.00" }) }),
      job("mr-usdc-30", { settlement: released("30.00", "usdc") }),
      job("mr-usdc-20", { settlement: released("20.00", " USDC ") }),
      job("mr-eth", { settlement: released("0.5", "ETH") }),
      job("mr-eur", { settlement: released("1.25", "EUR") }),
      job("mr-usd-frac", { settlement: released("12.345", "USD") }),
      job("mr-xyz", { settlement: released("5", "XYZ") }),
      job("mr-refunded", { settlement: released("40.00", "USDC", { payout: "refunded" }) }),
      job("mr-unconfirmed", { settlement: released("50.00", "USDC", { payoutConfirmation: null }) }),
      job("mr-nobasis", { settlement: released("60.00", "USDC", { payoutBasis: null }) }),
      job("mr-fabricated", { settlement: released("70.00", "USDC"), evidence: bundles([1], { fabricated: 1 }) }),
    ];
    const result = await observe(CAP, read(rows));
    expect(result.price.released).toEqual(money(fig("ok", [
      { currency: "ETH", decimals: 18, p50: "500000000000000000", n: 1 },
      { currency: "EUR", decimals: 2, p50: "125", n: 1 },
      { currency: "USDC", decimals: 6, p50: "20000000", n: 3 },
    ], 5, 0, null, ["mr-eth", "mr-eur", "mr-usdc-10", "mr-usdc-20", "mr-usdc-30"], 5), 2));
    expect(result.excluded.simulated).toBe(1);
  });

  it("compares base units as BigInt above 2^53", async () => {
    const result = await observe(CAP, read([
      job("mr-big-997", { settlement: released("0.009007199254740997", "ETH") }),
      job("mr-big-995", { settlement: released("0.009007199254740995", "ETH") }),
      job("mr-big-993", { settlement: released("0.009007199254740993", "ETH") }),
    ]));
    expect(result.price.released).toEqual(money(fig("ok", [
      { currency: "ETH", decimals: 18, p50: "9007199254740995", n: 3 },
    ], 3, 0, null, ["mr-big-993", "mr-big-995", "mr-big-997"], 3)));
    const zero = await observe(CAP, read([job("mr-zero", { settlement: released("0.00", "USDC") })]));
    expect(zero.price.released).toEqual(money(fig("ok", [
      { currency: "USDC", decimals: 6, p50: "0", n: 1 },
    ], 1, 0, null, ["mr-zero"], 1)));
  });

  it("every money figure carries the network notice, in every state", async () => {
    const readResult = await observe(CAP, read([job("nt-1")]), read([]));
    expect(readResult.price.released).toEqual(money(empty()));
    expect(readResult.price.paid).toEqual(money(empty("receipt")));
    const unavailableResult = await observe(CAP, UNAVAILABLE, UNAVAILABLE);
    expect(unavailableResult.price.released).toEqual(money(unavailable()));
    expect(unavailableResult.price.paid).toEqual(money(unavailable("receipt")));
  });

  it("unreadable rows make the released price partial, and all-unreadable makes it unavailable", async () => {
    const okay = job("pt-ok", { settlement: released("10.00", "USDC") });
    const noSettlement = job("pt-settle", { settlement: SETTLEMENT_UNAVAILABLE });
    const noEvidence = job("pt-evid", { settlement: released("20.00", "USDC"), evidence: EVIDENCE_UNAVAILABLE });
    const partial = await observe(CAP, read([okay, noSettlement, noEvidence]));
    expect(partial.price.released).toEqual(money(fig("partial", [
      { currency: "USDC", decimals: 6, p50: "10000000", n: 1 },
    ], 1, 2, null, ["pt-ok"], 1)));
    const unreadableResult = await observe(CAP, read([noSettlement, noEvidence]));
    const fullUnreadable = fig("unavailable", null, 0, 2, "source_read_failed", [], 0);
    expect(unreadableResult.price.released).toEqual(money(fullUnreadable));
    expect(unreadableResult.reliability).toEqual(fullUnreadable);
    expect(unreadableResult.latencyMs.jobs.p50).toEqual(fullUnreadable);
  });

  it("free calls are counted apart, and a price counts only with its payment hash as an exact amount above zero", async () => {
    const result = await observe(TOOL, read([]), read(PD_RECEIPTS));
    expect(result.price.paid).toEqual(money(fig("ok", [
      { currency: "USDC", decimals: 6, p50: "1250000", n: 3 },
    ], 3, 0, null, ["sha256:pd-a", "sha256:pd-b", "sha256:pd-c"], 3, "receipt"), 7));
    expect(result.calls.free).toEqual(fig("ok", 2, 12, 0, null,
      ["sha256:pd-free-absent", "sha256:pd-free-null"], 2, "receipt"));
    const mixed = await observe(TOOL, read([]), read([
      receipt("sha256:pd-mix-price", { price: "1.10", tx: null }),
      receipt("sha256:pd-mix-tx", { price: null, tx: "tx-pd-mix" }),
    ]));
    expect(mixed.price.paid).toEqual(money(empty("receipt"), 2));
    expect(mixed.calls.free).toEqual(fig("ok", 0, 2, 0, null, [], 0, "receipt"));
  });

  it("call turnaround and error status", async () => {
    const result = await observe(TOOL, read([]), read(RX_RECEIPTS));
    const cited = ["sha256:rx-100", "sha256:rx-250", "sha256:rx-302", "sha256:rx-400", "sha256:rx-50"];
    expect(result.latencyMs.receipts.p50).toEqual(fig("ok", "250", 5, 0, null, cited, 5, "receipt"));
    expect(result.latencyMs.receipts.p90).toEqual(fig("ok", "1000", 5, 0, null, cited, 5, "receipt"));
    expect(result.calls.errorStatus).toEqual(fig("ok", 3, 7, 0, null,
      ["sha256:rx-250", "sha256:rx-400", "sha256:rx-50"], 3, "receipt"));
  });
});

describe("evidence and capture checks", () => {
  it("evidence figures are stored claims at L1 with unchecked signatures, and the L2 level is not available", async () => {
    const result = await observe(CAP, read([
      job("ev-tiers", { evidence: bundles([1, 3]) }),
      job("ev-trunc", { evidence: bundles([2], { truncated: true }) }),
      job("ev-fab", { evidence: bundles([0], { fabricated: 3 }) }),
      job("ev-none"), job("ev-unread", { evidence: EVIDENCE_UNAVAILABLE }),
    ]));
    const cited = ["ev-fab", "ev-tiers", "ev-trunc"];
    expect(result.evidence.jobsWithBundle).toEqual(fig("partial", 3, 4, 1, "signatures_unchecked", cited, 3));
    expect(result.evidence.jobsWithFabricatedEvents).toEqual(fig("partial", 1, 4, 1, "signatures_unchecked", ["ev-fab"], 1));
    expect(result.evidence.maxClaimedTier).toEqual(fig("partial", { tier: 3, lowerBound: true }, 3, 1,
      "signatures_unchecked", cited, 3));
    expect(result.evidence.level).toEqual({
      state: "not_available", value: null, n: 0, unreadable: 0, level: "L2_kernel_signed",
      reason: "signatures_unchecked", sources: { kind: "job", ids: [], total: 0 },
    });
    expect(result.verification.outcome).toEqual({
      state: "not_available", value: null, n: 0, unreadable: 0, level: "L3_oracle_verified",
      reason: "no_public_outcome_verdict", sources: { kind: "job", ids: [], total: 0 },
    });
    expect(result.excluded.simulated).toBe(1);
    const invalidTier = await observe(CAP, read([
      job("ev-half", { evidence: bundles([2.5]) }),
      job("ev-whole", { evidence: bundles([2]) }),
    ]));
    expect(invalidTier.evidence.maxClaimedTier).toEqual(fig("partial", { tier: 2, lowerBound: false }, 1, 1,
      "signatures_unchecked", ["ev-whole"], 1));
    expect(invalidTier.evidence.jobsWithBundle).toEqual(fig("ok", 2, 2, 0, "signatures_unchecked",
      ["ev-half", "ev-whole"], 2));
  });

  it("nothing claims more than gateway-recorded, and reasons come from the closed list", async () => {
    expect(OBSERVATION_REASONS).toEqual([
      "no_samples", "source_read_failed", "signatures_unchecked",
      "no_public_outcome_verdict", "job_attribution_self_declared",
    ]);
    expect(Object.isFrozen(OBSERVATION_REASONS)).toBe(true);
    for (const input of [G_CAP, G_TOOL]) {
      const result = await summarizeObservations(input);
      expect(result.schemaId).toBe(CAPABILITY_OBSERVATION_SCHEMA_ID);
      for (const actual of figuresOf(result)) {
        if (actual.state === "ok" || actual.state === "partial") expect(actual.level).toBe("L1_gateway_recorded");
        expect(actual.level).not.toBe("L0_self_attested");
        expect(actual.reason === null || OBSERVATION_REASONS.includes(actual.reason)).toBe(true);
      }
      expect(result.evidence.level).toEqual({
        state: "not_available", value: null, n: 0, unreadable: 0, level: "L2_kernel_signed",
        reason: "signatures_unchecked", sources: { kind: "job", ids: [], total: 0 },
      });
      expect(result.verification.outcome).toEqual({
        state: "not_available", value: null, n: 0, unreadable: 0, level: "L3_oracle_verified",
        reason: "no_public_outcome_verdict", sources: { kind: "job", ids: [], total: 0 },
      });
    }
  });

  it("capture checks are summed per verdict; a count that cannot be read is never 0; the job link is self-declared", async () => {
    const result = await observe(CAP, read([
      job("cc-a", { capture: capture({ pass: 2, partial: 0, fail: 1, unrecognized: 1 }) }),
      job("cc-b", { capture: capture({ pass: 1, partial: 0, fail: 0, unrecognized: null }) }),
      job("cc-c"), job("cc-d", { capture: CAPTURE_UNAVAILABLE }),
    ]));
    const reason = "job_attribution_self_declared";
    expect(result.verification.captureChecks.pass).toEqual(fig("partial", 3, 3, 1, reason, ["cc-a", "cc-b"], 2));
    expect(result.verification.captureChecks.partial).toEqual(fig("partial", 0, 3, 1, reason, [], 0));
    expect(result.verification.captureChecks.fail).toEqual(fig("partial", 1, 3, 1, reason, ["cc-a"], 1));
    expect(result.verification.captureChecks.unrecognized).toEqual(fig("partial", 1, 2, 2, reason, ["cc-a"], 1));
  });

  it("an axis failure leaves a row out of only the figures that read that axis", async () => {
    const result = await observe(CAP, read([
      job("ax-capture", { settlement: released("10.00", "USDC"), capture: CAPTURE_UNAVAILABLE }),
      job("ax-settle", { settlement: SETTLEMENT_UNAVAILABLE,
        capture: capture({ pass: 1, partial: 0, fail: 0, unrecognized: 0 }) }),
      job("ax-evid", { evidence: EVIDENCE_UNAVAILABLE,
        capture: capture({ pass: 1, partial: 0, fail: 0, unrecognized: 0 }) }),
    ]));
    expect(result.reliability).toEqual(fig("partial", { completed: 1, terminal: 1 }, 1, 2, null, ["ax-capture"], 1));
    expect(result.price.released).toEqual(money(fig("partial", [
      { currency: "USDC", decimals: 6, p50: "10000000", n: 1 },
    ], 1, 2, null, ["ax-capture"], 1)));
    expect(result.verification.captureChecks.pass).toEqual(fig("partial", 2, 2, 1,
      "job_attribution_self_declared", ["ax-evid", "ax-settle"], 2));
    expect(result.evidence.jobsWithBundle).toEqual(fig("partial", 0, 2, 1, "signatures_unchecked", [], 0));
  });

  it("an undocumented axis state is unreadable", async () => {
    const result = await observe(CAP, read([
      job("fc-evid", { evidence: { ...bundles([2]), state: "verified" } as unknown as EvidenceAxis }),
      job("fc-capture", { capture: {
        ...capture({ pass: 1, partial: 0, fail: 0, unrecognized: 0 }), state: "complete",
      } as unknown as Capture }),
      job("fc-settle", { settlement: { ...released("10.00", "USDC"), link: "pending" } as unknown as SettlementAxis }),
      job("fc-ok"),
    ]));
    expect(result.evidence.jobsWithBundle).toEqual(fig("partial", 0, 3, 1, "signatures_unchecked", [], 0));
    expect(result.verification.captureChecks.pass).toEqual(fig("partial", 0, 3, 1,
      "job_attribution_self_declared", [], 0));
    expect(result.price.released).toEqual(money(fig("partial", null, 0, 2, "no_samples", [], 0)));
    expect(result.reliability).toEqual(fig("partial", { completed: 2, terminal: 2 }, 2, 2, null,
      ["fc-capture", "fc-ok"], 2));
    const nullCount = await observe(CAP, read([
      job("fc-count", { settlement: released("10.00", "USDC"), evidence: {
        ...bundles([1]), fabricatedEventCount: null,
      } }),
      job("fc-ok"),
    ]));
    expect(nullCount.reliability).toEqual(fig("partial", { completed: 1, terminal: 1 }, 1, 1, null, ["fc-ok"], 1));
    expect(nullCount.latencyMs.jobs.p50).toEqual(fig("partial", "60000", 1, 1, null, ["fc-ok"], 1));
    expect(nullCount.price.released).toEqual(money(fig("partial", null, 0, 1, "no_samples", [], 0)));
  });
});

describe("golden vectors", () => {
  it("regenerates the vectors file byte for byte", async () => {
    const first = JSON.stringify(await buildVectors(), null, 2) + "\n";
    if (process.env.PCC_WRITE_VECTORS === "1") writeFileSync(VECTOR, first);
    expect(new TextEncoder().encode(first).length).toBeLessThan(160 * 1024);
    expect(first).toBe(readFileSync(VECTOR, "utf8"));
    const second = JSON.stringify(await buildVectors(), null, 2) + "\n";
    expect(first).toBe(second);
  });

  it("each case reproduces its digest from its canonical body", async () => {
    const pinned = JSON.parse(readFileSync(VECTOR, "utf8")) as Awaited<ReturnType<typeof buildVectors>>;
    for (const entry of pinned.cases) {
      expect(await summarizeObservations(entry.input)).toEqual(entry.expected);
      expect(canonicalize(bodyOf(entry.expected))).toBe(entry.canonicalBody);
      expect(await sha256(entry.canonicalBody)).toBe(entry.expected.observationDigest);
    }
    const original = pinned.cases.find((entry) => entry.name === pinned.permutation.case);
    expect(original).toBeDefined();
    if (!original) throw new Error("The permutation must refer to a named case");
    expect(pinned.permutation.transform).toBe("rows of both sources reversed; every read time and every row asOf plus 3600000 ms");
    const moved = await summarizeObservations(shiftReadTimes(reverseInput(original.input), 3_600_000));
    expect(moved.observationDigest).toBe(original.expected.observationDigest);
    expect(moved.observationDigest).toBe(pinned.permutation.expectedDigest);
    expect(moved.asOf).toBe(pinned.permutation.expectedAsOf);
  });
});

describe("purity", () => {
  it("uses no clock, randomness, environment or Node import, and leaves its input untouched", async () => {
    const source = readFileSync(new URL("../readmodels/capability-observations.ts", import.meta.url), "utf8");
    const forbidden = [
      "Date." + "now", "new Date" + "()", "Math." + "random", "process" + ".",
      "performance" + ".", "from \"" + "node:", "require" + "(",
    ];
    for (const term of forbidden) expect(source.includes(term), term).toBe(false);
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    expect(imports).toEqual([
      "./job-execution.js", "./operator-work.js", "../types/invocation-receipt.js",
      "../util/canonical.js", "../util/code-unit-order.js",
    ]);
    const baseline = await summarizeObservations(G_CAP);
    const frozen = deepFreeze(G_CAP);
    expect(await summarizeObservations(frozen)).toEqual(baseline);
  });
});
