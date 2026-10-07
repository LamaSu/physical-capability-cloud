/**
 * Attempt analysis — agent-onboarding observability, item 10a.
 *
 * Agents onboarding a device send "attempt reports" (one per runbook phase,
 * plus a final `session` roll-up) that the server stores as JSON records
 * under contract `attempt.v1`:
 *
 *   /mnt/sparkbulk/pcc-reconciliation/returns/pcc-painpoints-work/item3-attempt-reporting-contract-v1.md
 *
 * This module is the pure analysis layer described in item 10's design doc
 * (section "10a", items 1 and 4):
 *
 *   /mnt/sparkbulk/pcc-reconciliation/returns/pcc-painpoints-work/item10-attempt-analysis-design.md
 *
 * It turns a flat list of stored attempt records into:
 *
 *   1. sessionize       — group reports into per-session timelines.
 *   2. failureSignature — a stable key for "the same break", merging the
 *                         same failure across different ids/uuids/numbers.
 *   3. rankSignatures   — score signatures by reach, unrecovered share and
 *                         recency, so the worst live breaks sort first.
 *   4. phaseFunnel      — per-runbook-phase drop-off, agent side.
 *   5. proposalQueue    — agent-submitted improvement ideas, grouped and
 *                         routed to the lane that owns the target.
 *   6. weeklyDigest     — a small, pre-redacted Markdown summary safe to
 *                         post to the bus (no ids, no free text beyond
 *                         already-normalized templates/summaries).
 *
 * PURE: no fs, no network, no `Date.now()`. Every function that needs "the
 * current time" takes it as `now: number` (ms since epoch) so callers
 * control time and tests stay deterministic. Every input record is treated
 * as untrusted, already-(secret-)redacted data — parsing never throws on a
 * malformed shape; it just drops what it can't make sense of.
 */

import { createHash } from "node:crypto";

// ── Contract enums ──────────────────────────────────────────────────────────

export type AttemptPhase =
  | "prerequisites"
  | "identify"
  | "intake"
  | "research"
  | "build"
  | "register"
  | "verify"
  | "operate"
  | "publish"
  | "session"
  | "other";

/** Runbook phases in contract order. Excludes the `session` roll-up and `other`. */
export const RUNBOOK_PHASES: readonly AttemptPhase[] = [
  "prerequisites",
  "identify",
  "intake",
  "research",
  "build",
  "register",
  "verify",
  "operate",
  "publish",
];

const KNOWN_PHASES: ReadonlySet<string> = new Set<string>([...RUNBOOK_PHASES, "session", "other"]);

export type AttemptOutcome =
  | "ok"
  | "failed"
  | "blocked"
  | "skipped"
  | "budget_stop"
  | "abandoned"
  | "in_progress"
  | "unknown";

const KNOWN_OUTCOMES: ReadonlySet<string> = new Set<string>([
  "ok",
  "failed",
  "blocked",
  "skipped",
  "budget_stop",
  "abandoned",
  "in_progress",
  "unknown",
]);

/** Outcomes that count as "did not recover" for ranking purposes. */
const UNRECOVERED_OUTCOMES: ReadonlySet<AttemptOutcome> = new Set<AttemptOutcome>([
  "failed",
  "blocked",
  "abandoned",
  "budget_stop",
  "unknown",
]);

/**
 * Who sent the report, per the attempt.v1 contract (item3-attempt-reporting-
 * contract-v1.md §1): "anonymous" (no key/session), "apiKey" or "user". The
 * server never records the credential itself — only this coarse kind, plus
 * (for non-anonymous) a one-way `principalHash`.
 */
export type AttemptPrincipalKind = "anonymous" | "apiKey" | "user";

const KNOWN_PRINCIPAL_KINDS: ReadonlySet<string> = new Set<string>(["anonymous", "apiKey", "user"]);

/** Unknown/missing/malformed principal degrades to the LEAST trusted class. */
function normalizePrincipal(x: unknown): AttemptPrincipalKind {
  return typeof x === "string" && KNOWN_PRINCIPAL_KINDS.has(x) ? (x as AttemptPrincipalKind) : "anonymous";
}

// ── Record shape (loose — input is untrusted `unknown[]`) ──────────────────

export interface AttemptLogEntry {
  step: number | string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  note: string | null;
}

/** Only present on `phase: "session"` records — the client's own roll-up. */
export interface AttemptPhaseRollup {
  phase: string | null;
  outcome: string | null;
  durationMs: number | null;
}

export interface AttemptIds {
  kernelId: string | null;
  capabilityId: string | null;
  kitId: string | null;
  jobId: string | null;
}

export interface AttemptDevice {
  make: string | null;
  model: string | null;
  class: string | null;
}

export interface AttemptHarness {
  name: string | null;
  version: string | null;
  model: string | null;
  label: string | null;
}

export interface AttemptPack {
  version: string | null;
  digestPrefix: string | null;
}

export interface AttemptTokens {
  in: number | null;
  out: number | null;
  source: string | null;
}

export interface AttemptProposal {
  target: string | null;
  path: string | null;
  text: string | null;
}

/**
 * A single STORED attempt record, after defensive parsing. `sessionId`,
 * `seq`, `phase` and `outcome` are always populated (phase/outcome fall
 * back to "other" / "unknown"); everything else may be null when the raw
 * report omitted or malformed it.
 */
export interface AttemptRecord {
  id: string | null;
  sessionId: string;
  seq: number;
  phase: AttemptPhase;
  outcome: AttemptOutcome;
  durationMs: number | null;
  summary: string;
  detail: string | null;
  logs: AttemptLogEntry[];
  phases: AttemptPhaseRollup[] | null;
  ids: AttemptIds | null;
  device: AttemptDevice | null;
  harness: AttemptHarness | null;
  pack: AttemptPack | null;
  env: Record<string, unknown> | null;
  tokens: AttemptTokens | null;
  proposal: AttemptProposal | null;
  traceId: string | null;
  createdAt: string | null;
  /** Who sent this report. Defaults to "anonymous" — see normalizePrincipal. */
  principal: AttemptPrincipalKind;
  /** One-way hash of the credential, present only when principal !== "anonymous". */
  principalHash: string | null;
}

// ── Parsing helpers (never throw; unknown shapes degrade to null/defaults) ──

function asRecord(x: unknown): Record<string, unknown> | null {
  return x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function strField(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === "string" ? v : null;
}

function numField(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function normalizePhase(x: unknown): AttemptPhase {
  return typeof x === "string" && KNOWN_PHASES.has(x) ? (x as AttemptPhase) : "other";
}

function normalizeOutcome(x: unknown): AttemptOutcome {
  if (typeof x !== "string") return "unknown";
  const v = x === "budget-stop" ? "budget_stop" : x;
  return KNOWN_OUTCOMES.has(v) ? (v as AttemptOutcome) : "unknown";
}

function parseLogs(x: unknown): AttemptLogEntry[] {
  if (!Array.isArray(x)) return [];
  const out: AttemptLogEntry[] = [];
  for (const item of x) {
    const o = asRecord(item);
    if (!o) continue;
    const step = typeof o.step === "number" || typeof o.step === "string" ? o.step : null;
    out.push({ step, method: strField(o, "method"), path: strField(o, "path"), status: numField(o, "status"), note: strField(o, "note") });
  }
  return out;
}

function parsePhaseRollups(x: unknown): AttemptPhaseRollup[] | null {
  if (!Array.isArray(x)) return null;
  const out: AttemptPhaseRollup[] = [];
  for (const item of x) {
    const o = asRecord(item);
    if (!o) continue;
    out.push({ phase: strField(o, "phase"), outcome: strField(o, "outcome"), durationMs: numField(o, "durationMs") });
  }
  return out;
}

function parseIds(x: unknown): AttemptIds | null {
  const o = asRecord(x);
  if (!o) return null;
  return {
    kernelId: strField(o, "kernelId"),
    capabilityId: strField(o, "capabilityId"),
    kitId: strField(o, "kitId"),
    jobId: strField(o, "jobId"),
  };
}

function parseDevice(x: unknown): AttemptDevice | null {
  const o = asRecord(x);
  if (!o) return null;
  return { make: strField(o, "make"), model: strField(o, "model"), class: strField(o, "class") };
}

/**
 * attempt.v1 harness names (contract §1). Anything else reads as "other", as the
 * sink stores it, so a name that reaches the posted digest is always one of these
 * whoever wrote the record.
 */
const KNOWN_HARNESS_NAMES: ReadonlySet<string> = new Set<string>(["claude-code", "codex", "pcc-hosted", "other"]);

function parseHarness(x: unknown): AttemptHarness | null {
  const o = asRecord(x);
  if (!o) return null;
  const name = strField(o, "name");
  return {
    name: name === null || KNOWN_HARNESS_NAMES.has(name) ? name : "other",
    version: strField(o, "version"),
    model: strField(o, "model"),
    label: strField(o, "label"),
  };
}

function parsePack(x: unknown): AttemptPack | null {
  const o = asRecord(x);
  if (!o) return null;
  return { version: strField(o, "version"), digestPrefix: strField(o, "digestPrefix") };
}

function parseTokens(x: unknown): AttemptTokens | null {
  const o = asRecord(x);
  if (!o) return null;
  return { in: numField(o, "in"), out: numField(o, "out"), source: strField(o, "source") };
}

function parseProposal(x: unknown): AttemptProposal | null {
  const o = asRecord(x);
  if (!o) return null;
  return { target: strField(o, "target"), path: strField(o, "path"), text: strField(o, "text") };
}

/**
 * Validate + normalize one raw record. Returns null unless it is a
 * `kind: "attempt"` record with a string `sessionId` and integer `seq` —
 * the minimum needed to place it in a session timeline. Every other field
 * degrades gracefully (missing/wrong-typed → null / "other" / "unknown").
 */
function parseAttemptRecord(raw: unknown): AttemptRecord | null {
  const o = asRecord(raw);
  if (!o) return null;
  if (o.kind !== "attempt") return null;

  const sessionId = strField(o, "sessionId");
  if (sessionId === null || sessionId.length === 0) return null;

  const seq = typeof o.seq === "number" && Number.isInteger(o.seq) ? o.seq : null;
  if (seq === null) return null;

  const principal = normalizePrincipal(o.principal);

  return {
    id: strField(o, "id"),
    sessionId,
    seq,
    phase: normalizePhase(o.phase),
    outcome: normalizeOutcome(o.outcome),
    durationMs: numField(o, "durationMs"),
    summary: strField(o, "summary") ?? "",
    detail: strField(o, "detail"),
    logs: parseLogs(o.logs),
    phases: parsePhaseRollups(o.phases),
    ids: parseIds(o.ids),
    device: parseDevice(o.device),
    harness: parseHarness(o.harness),
    pack: parsePack(o.pack),
    env: asRecord(o.env),
    tokens: parseTokens(o.tokens),
    proposal: parseProposal(o.proposal),
    traceId: strField(o, "traceId"),
    createdAt: strField(o, "createdAt"),
    principal,
    // Only meaningful (and only ever set upstream) for a non-anonymous principal.
    principalHash: principal !== "anonymous" ? strField(o, "principalHash") : null,
  };
}

function toMs(createdAt: string | null): number | null {
  if (!createdAt) return null;
  const t = Date.parse(createdAt);
  return Number.isFinite(t) ? t : null;
}

function firstNonNull<T>(reports: AttemptRecord[], select: (r: AttemptRecord) => T | null): T | null {
  for (const r of reports) {
    const v = select(r);
    if (v !== null) return v;
  }
  return null;
}

// ── 1. sessionize ────────────────────────────────────────────────────────────

export interface AttemptSession {
  sessionId: string;
  /** Ordered by seq ascending; exact duplicate seqs dropped (first stored wins). */
  reports: AttemptRecord[];
  firstAt: number;
  lastAt: number;
  /** The last non-session report's phase, or null if only a roll-up arrived. */
  lastPhase: AttemptPhase | null;
  finalOutcome: AttemptOutcome;
  totalDurationMs: number;
  harnessName: string | null;
  deviceClass: string | null;
  packVersion: string | null;
  proposals: AttemptProposal[];
  /** No session roll-up, and nothing heard from in more than `stallMs`. */
  stalled: boolean;
  /** Any report (including the roll-up) reported outcome budget_stop. */
  budgetStop: boolean;
  /** The session's FIRST report's principal (F3: provenance follows the opening report). */
  principal: AttemptPrincipalKind;
  principalHash: string | null;
}

const DEFAULT_STALL_MS = 6 * 60 * 60 * 1000;

function buildSession(sessionId: string, reports: AttemptRecord[], now: number, stallMs: number): AttemptSession {
  const timestamps = reports.map((r) => toMs(r.createdAt)).filter((t): t is number => t !== null);
  const firstAt = timestamps.length > 0 ? Math.min(...timestamps) : now;
  const lastAt = timestamps.length > 0 ? Math.max(...timestamps) : now;

  const sessionReports = reports.filter((r) => r.phase === "session");
  const rollup = sessionReports.length > 0 ? sessionReports[sessionReports.length - 1] : null;

  const nonSessionReports = reports.filter((r) => r.phase !== "session");
  const lastPhase = nonSessionReports.length > 0 ? nonSessionReports[nonSessionReports.length - 1].phase : null;

  const finalOutcome: AttemptOutcome = rollup ? rollup.outcome : reports[reports.length - 1].outcome;

  const phaseDurationSum = nonSessionReports.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
  const totalDurationMs = rollup && rollup.durationMs != null ? rollup.durationMs : phaseDurationSum;

  const proposals: AttemptProposal[] = [];
  for (const r of reports) if (r.proposal) proposals.push(r.proposal);

  return {
    sessionId,
    reports,
    firstAt,
    lastAt,
    lastPhase,
    finalOutcome,
    totalDurationMs,
    harnessName: firstNonNull(reports, (r) => r.harness?.name ?? null),
    deviceClass: firstNonNull(reports, (r) => r.device?.class ?? null),
    packVersion: firstNonNull(reports, (r) => r.pack?.version ?? null),
    proposals,
    stalled: !rollup && now - lastAt > stallMs,
    budgetStop: reports.some((r) => r.outcome === "budget_stop"),
    principal: reports[0].principal,
    principalHash: reports[0].principalHash,
  };
}

/**
 * Group raw records into per-session timelines. Non-attempt records (any
 * `kind` other than `"attempt"`) and records without a string `sessionId` +
 * integer `seq` are silently dropped. Sessions are sorted by `lastAt` desc.
 */
export function sessionize(records: unknown[], opts: { now: number; stallMs?: number }): AttemptSession[] {
  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
  const bySession = new Map<string, Map<number, AttemptRecord>>();

  for (const raw of records) {
    const rec = parseAttemptRecord(raw);
    if (!rec) continue;
    let bySeq = bySession.get(rec.sessionId);
    if (!bySeq) {
      bySeq = new Map<number, AttemptRecord>();
      bySession.set(rec.sessionId, bySeq);
    }
    // Duplicate seq within a session: keep the first stored, drop the rest.
    if (!bySeq.has(rec.seq)) bySeq.set(rec.seq, rec);
  }

  const sessions: AttemptSession[] = [];
  for (const [sessionId, bySeq] of bySession) {
    const reports = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
    sessions.push(buildSession(sessionId, reports, opts.now, stallMs));
  }

  sessions.sort((a, b) => b.lastAt - a.lastAt);
  return sessions;
}

// ── 2/3. normalizePath / normalizeSummary ───────────────────────────────────

// Anchored forms — classify a single, already-lowercased path segment.
const UUID_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX_SEGMENT_RE = /^[0-9a-f]{8,}$/;
const NUMERIC_SEGMENT_RE = /^[0-9]+$/;
const ID_LIKE_SEGMENT_RE = /^[a-z0-9_-]+$/;

function isIdSegment(seg: string): boolean {
  if (seg.length === 0) return false;
  if (UUID_SEGMENT_RE.test(seg)) return true;
  if (HEX_SEGMENT_RE.test(seg)) return true;
  if (NUMERIC_SEGMENT_RE.test(seg)) return true;
  if (seg.length >= 6 && /[0-9]/.test(seg) && ID_LIKE_SEGMENT_RE.test(seg)) return true;
  return false;
}

/**
 * A path template: strip the query string, lowercase, and replace any
 * segment that is a UUID, a hex run of >=8 chars, a pure number, or looks
 * like an id (contains a digit, length >= 6) with ":id". Keeps the leading
 * slash (an empty leading segment is left as-is).
 */
export function normalizePath(path: string): string {
  const raw = typeof path === "string" ? path : "";
  const noQuery = raw.split("?")[0] ?? raw;
  const segments = noQuery.toLowerCase().split("/").map((seg) => (isIdSegment(seg) ? ":id" : seg));
  return segments.join("/");
}

// Unanchored/global forms — scrub free text. Order matters: a UUID's hex
// chunks (e.g. the leading 8 and trailing 12 hex chars) would otherwise be
// partially caught by the hex-run rule, so UUIDs are replaced first.
const UUID_TEXT_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
// A hex run needs >=1 a-f letter, otherwise a plain decimal number (e.g.
// "12345678") would be swallowed here instead of by the number rule below.
// Runs are matched whole and tested in the replacer: a lookahead here would
// re-scan each run from every position, which is quadratic on hostile input
// (summaries arrive from the public report route).
const HEX_RUN_RE = /[0-9a-f]{8,}/g;
const NUMBER_TEXT_RE = /[0-9]+/g;
// Quoted spans, bounded. A single quote opens and closes only at a word edge,
// so apostrophes inside words ("didn't") are left alone.
const QUOTED_TEXT_RE = /(?<![a-z0-9])'[^'\n]{0,200}'(?![a-z0-9])|"[^"\n]{0,200}"|`[^`\n]{0,200}`/g;

/**
 * Normalize free text for signature merging: lowercase; UUIDs -> "<uuid>";
 * hex runs (>=8 chars, containing a letter) -> "<hex>"; digit runs ->
 * "<n>"; quoted spans -> "<q>"; collapse whitespace; trim; cap at 160 chars.
 */
export function normalizeSummary(s: string): string {
  const raw = typeof s === "string" ? s : "";
  let out = raw.toLowerCase();
  out = out.replace(UUID_TEXT_RE, "<uuid>");
  out = out.replace(HEX_RUN_RE, (run) => (/[a-f]/.test(run) ? "<hex>" : run));
  out = out.replace(NUMBER_TEXT_RE, "<n>");
  out = out.replace(QUOTED_TEXT_RE, "<q>");
  out = out.replace(/\s+/g, " ").trim();
  return out.length > 160 ? out.slice(0, 160) : out;
}

// ── 4. failureSignature ──────────────────────────────────────────────────────

export interface FailureSignature {
  /** First 16 hex chars of sha256 over the normalized inputs. Stable across ids/uuids/numbers. */
  key: string;
  /** Human-readable rendering of the same inputs. May contain free text (summary) — JSON view only. */
  template: string;
  /**
   * F1: a rendering built ONLY from an allowlisted grammar — phase, outcome, a
   * known HTTP method, a route template and a bounded status — safe to post to
   * the bus. NEVER contains the summary. See buildDigestTemplate().
   */
  digestTemplate: string;
}

const FAILING_OUTCOMES: ReadonlySet<AttemptOutcome> = new Set<AttemptOutcome>(["failed", "blocked", "budget_stop"]);

// ── F1: allowlisted digest grammar ──────────────────────────────────────────
// The digest's signature rendering is intentionally coarser than `template`:
// exactly one placeholder token (":x") for anything that isn't a literal,
// short, lowercase route word. This also catches normalizePath's own ":id"
// placeholder — the digest grammar doesn't distinguish id KINDS, only
// word-vs-not-word, which is simpler to audit than normalizePath's heuristics.
const DIGEST_ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);
const DIGEST_SAFE_SEGMENT_RE = /^[a-z][a-z-]{0,39}$/;

/** `normalizedPath` is ALREADY normalizePath()'s output — segment-check only, no re-normalizing. */
function digestRouteTemplate(normalizedPath: string): string {
  const segments = normalizedPath
    .split("/")
    .map((seg) => (seg.length === 0 || DIGEST_SAFE_SEGMENT_RE.test(seg) ? seg : ":x"));
  return segments.join("/");
}

function buildDigestTemplate(
  phase: AttemptPhase,
  outcome: AttemptOutcome,
  logPart: { method: string; path: string; status: number | null } | null,
): string {
  let seg = `${phase}/${outcome}`;
  if (logPart) {
    const bits: string[] = [];
    if (DIGEST_ALLOWED_METHODS.has(logPart.method)) bits.push(logPart.method);
    bits.push(digestRouteTemplate(logPart.path));
    if (
      typeof logPart.status === "number" &&
      Number.isInteger(logPart.status) &&
      logPart.status >= 100 &&
      logPart.status <= 599
    ) {
      bits.push(String(logPart.status));
    }
    seg += ` ${bits.join(" ")}`;
  }
  // Defense in depth: nothing above should be able to carry whitespace/newlines
  // (the safe-word regex excludes them, and phase/outcome/method/status are all
  // fixed vocabularies), but collapse+trim anyway per the exact instruction.
  return seg.replace(/\s+/g, " ").trim();
}

/**
 * A stable key for "the same break": phase + outcome + the first failing
 * (status >= 400) log step's method/normalized-path/status, if any, + the
 * normalized summary. Different ids/uuids/numbers in the same break collapse
 * to one key; a different phase, endpoint or status is a different key.
 */
export function failureSignature(r: AttemptRecord): FailureSignature | null {
  if (!FAILING_OUTCOMES.has(r.outcome)) return null;

  const badLog = r.logs.find((l) => typeof l.status === "number" && l.status >= 400) ?? null;
  const logPart = badLog
    ? { method: (badLog.method ?? "").toUpperCase(), path: normalizePath(badLog.path ?? ""), status: badLog.status }
    : null;
  const normSummary = normalizeSummary(r.summary);

  const key = createHash("sha256")
    .update(JSON.stringify([r.phase, r.outcome, logPart, normSummary]))
    .digest("hex")
    .slice(0, 16);

  const logTemplatePart = logPart ? ` ${logPart.method} ${logPart.path} ${logPart.status}` : "";
  const template = `${r.phase}/${r.outcome}${logTemplatePart} · ${normSummary}`;
  const digestTemplate = buildDigestTemplate(r.phase, r.outcome, logPart);

  return { key, template, digestTemplate };
}

// ── 5. rankSignatures ────────────────────────────────────────────────────────

export interface RankedSignature {
  key: string;
  template: string;
  /** F1: allowlisted-grammar rendering — the ONLY form weeklyDigest() may print. */
  digestTemplate: string;
  sessionsHit: number;
  /** F3: of sessionsHit, how many carried an authenticated (apiKey/user) principal. */
  authenticatedSessionsHit: number;
  /** F3: of sessionsHit, how many were anonymous (no principal at all). */
  anonymousSessionsHit: number;
  harnessNames: string[];
  deviceClasses: string[];
  /** Share of the sessions that hit this signature and never recovered (or stalled). */
  unrecoveredShare: number;
  firstSeen: number;
  lastSeen: number;
  exampleSummary: string;
  score: number;
}

const DEFAULT_HALF_LIFE_DAYS = 7;
/** F3: an authenticated principal's sessions count toward reach only up to this many. */
const MAX_COUNTED_SESSIONS_PER_PRINCIPAL = 3;
/** F3: an anonymous session counts for less than an authenticated one — anyone can post one. */
const ANONYMOUS_SESSION_WEIGHT = 0.5;

interface SignatureAgg {
  template: string;
  digestTemplate: string;
  sessionIds: Set<string>;
  harnessNames: Set<string>;
  deviceClasses: Set<string>;
  firstSeen: number;
  lastSeen: number;
  exampleSummary: string;
}

/**
 * Rank failure signatures by reach, unrecovered share and recency.
 *
 * F3: reach is provenance-weighted, not a raw session count — an anonymous
 * session (anyone can post one, no verification at all) counts for
 * ANONYMOUS_SESSION_WEIGHT, and a single authenticated principal's sessions
 * count for at most MAX_COUNTED_SESSIONS_PER_PRINCIPAL, so one actor spinning
 * up many sessions (or many anonymous callers) can't numerically dominate the
 * ranking the way a raw sessionsHit count would let them:
 *
 *   effectiveReach = ANONYMOUS_SESSION_WEIGHT * anonymousSessionsHit
 *                    + Σ_principal min(sessionsForThatPrincipal, MAX_COUNTED_SESSIONS_PER_PRINCIPAL)
 *   score = effectiveReach * (1 + unrecoveredShare) * 0.5^((now-lastSeen)/halfLife)
 *
 * `sessionsHit` itself stays the raw, unweighted count (still useful as a
 * "how many total" figure) — only `score` uses the weighted effectiveReach.
 * Ties break on harness spread (a break hitting more harnesses ranks
 * higher), then on key for determinism.
 */
export function rankSignatures(sessions: AttemptSession[], opts: { now: number; halfLifeDays?: number }): RankedSignature[] {
  const halfLifeMs = (opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS) * 24 * 60 * 60 * 1000;
  const agg = new Map<string, SignatureAgg>();

  for (const session of sessions) {
    // A session roll-up restates the session's outcome. It names the break only
    // when no phase report failed; otherwise its generic summary ("session:
    // failed" when the agent sent none) would merge every failed session into
    // one noise signature at the top of the ranking.
    const phaseFailed = session.reports.some((r) => r.phase !== "session" && FAILING_OUTCOMES.has(r.outcome));
    for (const report of session.reports) {
      if (report.phase === "session" && phaseFailed) continue;
      const sig = failureSignature(report);
      if (!sig) continue;
      const hitAt = toMs(report.createdAt) ?? session.lastAt;

      let a = agg.get(sig.key);
      if (!a) {
        a = {
          template: sig.template,
          digestTemplate: sig.digestTemplate,
          sessionIds: new Set<string>(),
          harnessNames: new Set<string>(),
          deviceClasses: new Set<string>(),
          firstSeen: hitAt,
          lastSeen: hitAt,
          exampleSummary: normalizeSummary(report.summary),
        };
        agg.set(sig.key, a);
      }
      a.sessionIds.add(session.sessionId);
      if (session.harnessName) a.harnessNames.add(session.harnessName);
      if (session.deviceClass) a.deviceClasses.add(session.deviceClass);
      if (hitAt < a.firstSeen) a.firstSeen = hitAt;
      if (hitAt > a.lastSeen) a.lastSeen = hitAt;
    }
  }

  const sessionsById = new Map(sessions.map((s) => [s.sessionId, s] as const));
  const ranked: RankedSignature[] = [];

  for (const [key, a] of agg) {
    const sessionsHit = a.sessionIds.size;
    let unrecovered = 0;
    let anonymousSessionsHit = 0;
    // F3: authenticated sessions grouped by principal identity so one actor's
    // repeat sessions cap out instead of adding reach linearly forever.
    // Namespaced by kind ("apiKey:"/"user:") so an apiKey id and a user id
    // that happen to share a string value can't collide into one bucket.
    const perPrincipalSessions = new Map<string, number>();
    for (const sid of a.sessionIds) {
      const s = sessionsById.get(sid);
      if (!s) continue;
      if (UNRECOVERED_OUTCOMES.has(s.finalOutcome) || s.stalled) unrecovered++;
      if (s.principal === "anonymous") {
        anonymousSessionsHit++;
      } else {
        const pKey = `${s.principal}:${s.principalHash ?? ""}`;
        perPrincipalSessions.set(pKey, (perPrincipalSessions.get(pKey) ?? 0) + 1);
      }
    }
    const authenticatedSessionsHit = sessionsHit - anonymousSessionsHit;
    const unrecoveredShare = sessionsHit > 0 ? unrecovered / sessionsHit : 0;
    const recencyWeight = Math.pow(0.5, (opts.now - a.lastSeen) / halfLifeMs);

    let cappedAuthenticated = 0;
    for (const count of perPrincipalSessions.values()) {
      cappedAuthenticated += Math.min(count, MAX_COUNTED_SESSIONS_PER_PRINCIPAL);
    }
    const effectiveReach = ANONYMOUS_SESSION_WEIGHT * anonymousSessionsHit + cappedAuthenticated;
    const score = effectiveReach * (1 + unrecoveredShare) * recencyWeight;

    ranked.push({
      key,
      template: a.template,
      digestTemplate: a.digestTemplate,
      sessionsHit,
      authenticatedSessionsHit,
      anonymousSessionsHit,
      harnessNames: Array.from(a.harnessNames).sort(),
      deviceClasses: Array.from(a.deviceClasses).sort(),
      unrecoveredShare,
      firstSeen: a.firstSeen,
      lastSeen: a.lastSeen,
      exampleSummary: a.exampleSummary,
      score,
    });
  }

  ranked.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    if (y.harnessNames.length !== x.harnessNames.length) return y.harnessNames.length - x.harnessNames.length;
    return x.key.localeCompare(y.key);
  });

  return ranked;
}

// ── 6. phaseFunnel ───────────────────────────────────────────────────────────

export interface FunnelRow {
  phase: AttemptPhase;
  reached: number;
  ok: number;
  failed: number;
  blocked: number;
  skipped: number;
}

/**
 * Per-runbook-phase drop-off (agent side): sessions that reached each
 * phase, and how that phase's LAST report in the session came out.
 * `session` and `other` are excluded — this is the 9-phase runbook only.
 */
export function phaseFunnel(sessions: AttemptSession[]): FunnelRow[] {
  return RUNBOOK_PHASES.map((phase) => {
    let reached = 0;
    let ok = 0;
    let failed = 0;
    let blocked = 0;
    let skipped = 0;

    for (const session of sessions) {
      const phaseReports = session.reports.filter((r) => r.phase === phase);
      if (phaseReports.length === 0) continue;
      reached++;
      const last = phaseReports[phaseReports.length - 1];
      if (last.outcome === "ok") ok++;
      else if (last.outcome === "failed") failed++;
      else if (last.outcome === "blocked") blocked++;
      else if (last.outcome === "skipped") skipped++;
    }

    return { phase, reached, ok, failed, blocked, skipped };
  });
}

// ── 7. proposalQueue ─────────────────────────────────────────────────────────

export type ProposalTarget = "runbook" | "agent-package" | "docs" | "code" | "process" | "other";
export type ProposalRoute = "adk" | "launch" | "by-path" | "steward";

const PROPOSAL_TARGETS: ReadonlySet<string> = new Set<string>(["runbook", "agent-package", "docs", "code", "process", "other"]);

const PROPOSAL_ROUTES: Record<ProposalTarget, ProposalRoute> = {
  runbook: "adk",
  "agent-package": "adk",
  docs: "launch",
  code: "by-path",
  process: "steward",
  other: "steward",
};

function normalizeProposalTarget(x: string | null): ProposalTarget {
  return x !== null && PROPOSAL_TARGETS.has(x) ? (x as ProposalTarget) : "other";
}

export interface ProposalGroup {
  target: ProposalTarget;
  routeTo: ProposalRoute;
  /** Total proposals seen for this target (may exceed `sessions`). */
  count: number;
  /** Distinct sessions that contributed a proposal to this target. */
  sessions: number;
  /** Up to 5 distinct (case-insensitive) example texts, each capped at 200 chars. */
  examples: string[];
}

interface ProposalAgg {
  count: number;
  sessionIds: Set<string>;
  examples: string[];
  seenLower: Set<string>;
}

const MAX_PROPOSAL_EXAMPLES = 5;
const MAX_PROPOSAL_EXAMPLE_CHARS = 200;

/** Group session proposals by target, with routing, counts and a deduplicated text sample. */
export function proposalQueue(sessions: AttemptSession[]): ProposalGroup[] {
  const acc = new Map<ProposalTarget, ProposalAgg>();

  for (const session of sessions) {
    for (const proposal of session.proposals) {
      const target = normalizeProposalTarget(proposal.target);
      let a = acc.get(target);
      if (!a) {
        a = { count: 0, sessionIds: new Set<string>(), examples: [], seenLower: new Set<string>() };
        acc.set(target, a);
      }
      a.count++;
      a.sessionIds.add(session.sessionId);

      const text = (proposal.text ?? "").slice(0, MAX_PROPOSAL_EXAMPLE_CHARS);
      const lower = text.toLowerCase();
      if (text.length > 0 && !a.seenLower.has(lower) && a.examples.length < MAX_PROPOSAL_EXAMPLES) {
        a.seenLower.add(lower);
        a.examples.push(text);
      }
    }
  }

  const groups: ProposalGroup[] = Array.from(acc.entries()).map(([target, a]) => ({
    target,
    routeTo: PROPOSAL_ROUTES[target],
    count: a.count,
    sessions: a.sessionIds.size,
    examples: a.examples,
  }));

  groups.sort((x, y) => y.count - x.count);
  return groups;
}

// ── 8. weeklyDigest ──────────────────────────────────────────────────────────

export interface AttemptTotals {
  sessions: number;
  finishedOk: number;
  failedOrBlocked: number;
  abandoned: number;
  budgetStops: number;
  stalled: number;
  /** harness name (or "unknown") -> session count. */
  harnessSplit: Record<string, number>;
  /** F3: sessions whose FIRST report carried an authenticated principal (apiKey/user). */
  authenticatedSessions: number;
  /** F3: sessions with no principal at all — unverified, anyone can post one. */
  anonymousSessions: number;
}

export interface AttemptAnalysis {
  sessions: AttemptSession[];
  signatures: RankedSignature[];
  funnel: FunnelRow[];
  proposals: ProposalGroup[];
  totals: AttemptTotals;
}

const MAX_DIGEST_BYTES = 3000;
const DEFAULT_DIGEST_TOP_N = 5;

// Defense in depth: the digest builder never reads sessionId/ids/traceId, and
// every summary already passed through normalizeSummary (which strips UUIDs).
// This pass catches anything that still slipped through (e.g. an email
// address, which normalizeSummary does not target).
const DIGEST_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Bounded quantifiers and a start-of-run lookbehind keep this linear.
const DIGEST_EMAIL_RE = /(?<![a-z0-9._%+-])[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,8}/gi;

function scrubDigest(s: string): string {
  return s.replace(DIGEST_UUID_RE, "<uuid>").replace(DIGEST_EMAIL_RE, "[redacted-email]");
}

// F1: every value interpolated into the digest that isn't already drawn from a
// fixed, code-controlled vocabulary (harness names, the caller-supplied period
// label) is escaped so it can't forge Markdown structure or inject a fake
// heading/link/rule into the posted digest. Newlines collapse to a space FIRST
// (so a multi-line injection can't survive as a new digest line), then the
// remaining Markdown-significant characters are backslash-escaped.
const MARKDOWN_ESCAPE_RE = /[\\*_`~|>[\]()#]/g;

function escapeDigestMarkdown(s: string): string {
  return s.replace(/\r\n|\r|\n/g, " ").replace(MARKDOWN_ESCAPE_RE, "\\$&");
}

/** Truncate to a byte budget without splitting a UTF-16 surrogate pair. */
function truncateToBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(s.slice(0, mid), "utf8") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  if (lo > 0) {
    const code = s.charCodeAt(lo - 1);
    if (code >= 0xd800 && code <= 0xdbff) lo -= 1; // don't split a surrogate pair
  }
  return s.slice(0, lo);
}

/**
 * A Markdown digest, <=3000 bytes: totals, harness split, the phase funnel,
 * the top N signatures (template/reach/harnesses/unrecovered share) and the
 * proposal queue by target. Carries only counts and already-redacted
 * templates/summaries — no sessionId, no kernel/capability/kit/job id, no
 * traceId, and (defensively) no UUID or email-shaped text.
 */
export function weeklyDigest(a: AttemptAnalysis, opts: { periodLabel: string; topN?: number }): string {
  const topN = opts.topN ?? DEFAULT_DIGEST_TOP_N;
  const lines: string[] = [];

  lines.push(`# Attempt digest — ${escapeDigestMarkdown(opts.periodLabel)}`, "");

  lines.push("## Totals");
  lines.push(`- Sessions: ${a.totals.sessions}`);
  lines.push(`- Finished ok: ${a.totals.finishedOk}`);
  lines.push(`- Failed/blocked: ${a.totals.failedOrBlocked}`);
  lines.push(`- Abandoned: ${a.totals.abandoned}`);
  lines.push(`- Budget stops: ${a.totals.budgetStops}`);
  lines.push(`- Stalled: ${a.totals.stalled}`);
  // F3: provenance split, front and center — a reader must not mistake 101
  // anonymous reports for 101 verified participants.
  lines.push(`- Authenticated sessions: ${a.totals.authenticatedSessions}`);
  lines.push(`- Anonymous sessions: ${a.totals.anonymousSessions}`);
  lines.push("- Anonymous reports are unverified: anyone can post them.", "");

  lines.push("## Harness split");
  const harnessEntries = Object.entries(a.totals.harnessSplit).sort((x, y) => y[1] - x[1]);
  if (harnessEntries.length === 0) lines.push("- (no sessions)");
  else for (const [name, count] of harnessEntries) lines.push(`- ${escapeDigestMarkdown(name)}: ${count}`);
  lines.push("");

  lines.push("## Funnel");
  lines.push("| Phase | Reached | OK | Failed | Blocked | Skipped |");
  lines.push("|---|---|---|---|---|---|");
  for (const row of a.funnel) {
    lines.push(`| ${row.phase} | ${row.reached} | ${row.ok} | ${row.failed} | ${row.blocked} | ${row.skipped} |`);
  }
  lines.push("");

  lines.push("## Top signatures");
  const top = a.signatures.slice(0, topN);
  if (top.length === 0) lines.push("- (none)");
  else
    top.forEach((sig, i) => {
      const pct = Math.round(sig.unrecoveredShare * 100);
      const harnesses =
        sig.harnessNames.length > 0 ? sig.harnessNames.map(escapeDigestMarkdown).join(", ") : "unknown";
      // F1: digestTemplate ONLY — never `template` (which may carry the raw
      // normalized summary/path). F1: escaped defensively even though the
      // grammar's own charset already excludes Markdown-significant chars.
      lines.push(
        `${i + 1}. ${escapeDigestMarkdown(sig.digestTemplate)} — ${sig.sessionsHit} sessions, harnesses: ${harnesses}, unrecovered ${pct}%`,
      );
    });
  lines.push("");

  lines.push("## Proposals");
  if (a.proposals.length === 0) lines.push("- (none)");
  else for (const g of a.proposals) lines.push(`- ${g.target} → ${g.routeTo}: ${g.count} (${g.sessions} sessions)`);

  const raw = lines.join("\n");
  return truncateToBytes(scrubDigest(raw), MAX_DIGEST_BYTES);
}

// ── 9. analyzeAttempts ───────────────────────────────────────────────────────

function computeTotals(sessions: AttemptSession[]): AttemptTotals {
  const harnessSplit: Record<string, number> = {};
  let finishedOk = 0;
  let failedOrBlocked = 0;
  let abandoned = 0;
  let budgetStops = 0;
  let stalled = 0;
  let authenticatedSessions = 0;
  let anonymousSessions = 0;

  for (const s of sessions) {
    const h = s.harnessName ?? "unknown";
    harnessSplit[h] = (harnessSplit[h] ?? 0) + 1;
    if (s.finalOutcome === "ok") finishedOk++;
    if (s.finalOutcome === "failed" || s.finalOutcome === "blocked") failedOrBlocked++;
    if (s.finalOutcome === "abandoned") abandoned++;
    if (s.budgetStop) budgetStops++;
    if (s.stalled) stalled++;
    if (s.principal === "anonymous") anonymousSessions++;
    else authenticatedSessions++;
  }

  return {
    sessions: sessions.length,
    finishedOk,
    failedOrBlocked,
    abandoned,
    budgetStops,
    stalled,
    harnessSplit,
    authenticatedSessions,
    anonymousSessions,
  };
}

/** Compose the full analysis: sessionize -> rank signatures -> funnel -> proposals -> totals. */
export function analyzeAttempts(
  records: unknown[],
  opts: { now: number; stallMs?: number; halfLifeDays?: number },
): AttemptAnalysis {
  const sessions = sessionize(records, { now: opts.now, stallMs: opts.stallMs });
  const signatures = rankSignatures(sessions, { now: opts.now, halfLifeDays: opts.halfLifeDays });
  const funnel = phaseFunnel(sessions);
  const proposals = proposalQueue(sessions);
  const totals = computeTotals(sessions);
  return { sessions, signatures, funnel, proposals, totals };
}
