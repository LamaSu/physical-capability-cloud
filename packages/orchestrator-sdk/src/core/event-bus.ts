// Global in-memory event bus — every integration tool emits here so the UI
// can render real logs/telemetry, not just one-line "called X" badges.
//
// Ported from `LamaSu/navi` packages/backend/src/lib/event-bus.ts as part of
// Wave 2.5 of the Navi v2 migration. Vendor-agnostic: when PCC's
// observability pipeline (OTel / Sentry) is wired in Wave 4, drop in a
// transport here without changing tool callsites.
//
// Hardening (Tier 1, 2026-04-29):
//   - T1.6: redact credential-shaped substrings from text + payload before
//     they hit the in-memory log (and from there, the chat thread, the
//     activity feed, and the audit JSONL).
//   - T1.6: cap individual payload serializations at 64 KB; truncate with
//     a sentinel string instead of letting a 5 GB blob silently consume
//     process memory.
//   - T1.6: bring MAX from 500 → 200 to bound steady-state memory at
//     ~200 × 64KB ≈ 13 MB worst case, well under any sane container budget.

const MAX_LOG_SIZE = 200;
const PAYLOAD_BYTE_CAP = 64 * 1024; // 64 KB ceiling per payload
const TRUNCATE_SUFFIX = "...[truncated]";

export interface AppEvent {
  t: number;
  kind: string;
  sponsor: string;
  text: string;
  session_id?: string;
  level?: "info" | "ok" | "warn" | "err";
  payload?: Record<string, unknown>;
  duration_ms?: number;
}

const log: AppEvent[] = [];

/**
 * Wave 4.4 — subscriber hook so observability adapters (OTel, Sentry, custom)
 * can attach to the bus without changing tool callsites. Subscribers are
 * invoked synchronously after each emit; an exception in one subscriber is
 * isolated and logged but does NOT propagate to the emitter or subsequent
 * subscribers. Subscribers see post-redaction events (the same shape that
 * lands in the in-memory log).
 */
type EventSubscriber = (e: AppEvent) => void;
const subscribers = new Set<EventSubscriber>();

/**
 * Register a subscriber. Returns an unsubscribe function. The subscriber
 * begins receiving events on the very next emit().
 */
export function subscribe(fn: EventSubscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Test-only — drain subscriber list. */
export function _resetSubscribersForTests(): void {
  subscribers.clear();
}

/**
 * Patterns that match credential-shaped strings. Each pattern is paired with
 * a replacement function that preserves enough surrounding context for the
 * event to remain debuggable while removing the secret.
 *
 * Order matters: more specific patterns (DB URI with embedded password) run
 * before broader ones (Bearer token in headers).
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, (match: string, ...groups: string[]) => string]> = [
  // postgres://user:secret@host -> postgres://user:***@host
  // Same for postgresql, mysql, mongodb, redis, amqp.
  [
    /(postgres(?:ql)?|mysql|mongodb|redis|amqp):\/\/([^:\/\s]+):([^@\s]+)@/gi,
    (_m, scheme: string, user: string) => `${scheme}://${user}:***REDACTED***@`,
  ],
  // Authorization: Bearer <token>
  [/(authorization\s*:\s*bearer\s+)[A-Za-z0-9._\-+/=]{8,}/gi, (_m, prefix: string) => `${prefix}***REDACTED***`],
  // Bearer <token> (without the Authorization: prefix)
  [/\bbearer\s+[A-Za-z0-9._\-+/=]{20,}/gi, () => "Bearer ***REDACTED***"],
  // OpenAI / Anthropic / Stripe / similar SK-style tokens
  [/\b(sk|pk)[_-][A-Za-z]*[_-]?[A-Za-z0-9]{20,}/g, () => "***REDACTED***"],
  // PCC live API keys (pcc_live_<base64ish>)
  [/\bpcc_(?:live|test)_[A-Za-z0-9_\-]{16,}/g, () => "pcc_***REDACTED***"],
  // GitHub PATs
  [/\bgh[pousr]_[A-Za-z0-9]{32,}/g, () => "gh***REDACTED***"],
  // AWS access keys
  [/\bAKIA[0-9A-Z]{16}\b/g, () => "AKIA***REDACTED***"],
  // Generic "api_key": "..." / api-key=... / token=... / secret=...
  [
    /\b(api[_-]?key|secret|token|access[_-]?token|refresh[_-]?token|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9._\-+/=]{12,}["']?/gi,
    (_m, label: string) => `${label}=***REDACTED***`,
  ],
];

/**
 * Walk a string and replace any credential-shaped substring with a sentinel.
 * Skips strings that already contain a redaction sentinel to avoid double
 * processing.
 */
export function redactString(input: string): string {
  if (!input) return input;
  if (input.includes("***REDACTED***")) return input;
  let out = input;
  for (const [pattern, replacer] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacer as (substring: string, ...args: unknown[]) => string);
  }
  return out;
}

/**
 * Recursively redact a JSON-serializable value. Strings flow through
 * `redactString`; nested objects/arrays are walked. Cycles raise a
 * runtime error from JSON.stringify upstream — payloads are expected to be
 * tree-shaped.
 */
export function redactPayload<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((v) => redactPayload(v)) as unknown as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactPayload(v);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Cap a payload's serialized size. We measure via JSON.stringify because
 * that's the surface that crosses the network / disk boundary anyway.
 * Returns a marker payload when the original would have exceeded the cap.
 */
function capPayloadSize(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!payload) return payload;
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return { _truncated: true, _reason: "non-serializable payload" };
  }
  if (Buffer.byteLength(serialized, "utf8") <= PAYLOAD_BYTE_CAP) {
    return payload;
  }
  return {
    _truncated: true,
    _original_bytes: Buffer.byteLength(serialized, "utf8"),
    _preview: `${serialized.slice(0, PAYLOAD_BYTE_CAP - TRUNCATE_SUFFIX.length)}${TRUNCATE_SUFFIX}`,
  };
}

export function emit(e: Omit<AppEvent, "t">): AppEvent {
  // Redact text first; it's where most leak vectors live (Authorization
  // header lines passed straight through, postgres:// URIs in error
  // messages, etc.).
  const safeText = redactString(e.text);
  const redactedPayload = e.payload ? redactPayload(e.payload) : e.payload;
  const cappedPayload = capPayloadSize(redactedPayload);

  // Build the cleaned event preserving optionality so undefined fields stay
  // off the object (matches navi v1 wire shape).
  const ev: AppEvent = {
    t: Date.now(),
    kind: e.kind,
    sponsor: e.sponsor,
    text: safeText,
    ...(e.session_id !== undefined ? { session_id: e.session_id } : {}),
    ...(e.level !== undefined ? { level: e.level } : {}),
    ...(cappedPayload !== undefined ? { payload: cappedPayload } : {}),
    ...(e.duration_ms !== undefined ? { duration_ms: e.duration_ms } : {}),
  };
  log.push(ev);
  if (log.length > MAX_LOG_SIZE) log.shift();
  // Wave 4.4 — fan out to observability subscribers AFTER the event is logged
  // so a slow/throwing subscriber can't delay the in-memory record. Errors
  // are isolated per-subscriber so one buggy adapter doesn't break the bus
  // (or other subscribers attached later).
  for (const sub of subscribers) {
    try {
      sub(ev);
    } catch (err) {
      // Use stderr directly — recursive emit() to log the failure would risk
      // infinite loops if the subscriber itself caused the failure.
      // eslint-disable-next-line no-console
      console.error("[event-bus] subscriber threw, ignoring:", err);
    }
  }
  return ev;
}

export function tail(since = 0): AppEvent[] {
  return log.filter((e) => e.t > since);
}

export function snapshot(): AppEvent[] {
  return [...log];
}

/** Test-only helper: drain the in-memory log so tests don't observe each
 *  other's events. Excluded from the public surface in index.ts. */
export function _resetEventLogForTests(): void {
  log.length = 0;
}

// Convenience helpers for tool wrappers — emit a BEGIN, run the work, emit END
export async function tracked<T>(
  meta: { kind: string; sponsor: string; text: string; session_id?: string; payload?: Record<string, unknown> },
  fn: () => Promise<T>
): Promise<T> {
  const t0 = Date.now();
  emit({ ...meta, level: "info" });
  try {
    const result = await fn();
    emit({
      kind: meta.kind + ".done",
      sponsor: meta.sponsor,
      text: `${meta.text} done`,
      ...(meta.session_id !== undefined ? { session_id: meta.session_id } : {}),
      level: "ok",
      payload: result && typeof result === "object" ? (result as Record<string, unknown>) : undefined,
      duration_ms: Date.now() - t0,
    });
    return result;
  } catch (e) {
    emit({
      kind: meta.kind + ".err",
      sponsor: meta.sponsor,
      text: `${meta.text} fail: ${e instanceof Error ? e.message : String(e)}`,
      ...(meta.session_id !== undefined ? { session_id: meta.session_id } : {}),
      level: "err",
      duration_ms: Date.now() - t0,
    });
    throw e;
  }
}
