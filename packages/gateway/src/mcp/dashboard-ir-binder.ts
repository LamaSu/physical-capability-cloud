/**
 * Phase B — data BINDER (item 8 core). Feeds fetched data to the renderer's
 * bindScalar/bindListRows. This is the ONE new browser capability B adds, so it is
 * built to sol's R6 pre-wiring checklist and kept small + testable.
 *
 * Invariants (each mapped to a checklist item):
 *  - FIXED ORIGIN: every URL is `origin + bind.path (+query)`; `bindUrl` refuses a
 *    protocol-relative `//host`, a scheme, `..`, whitespace, or a non-`/api/` path —
 *    a bind can never escape the one PCC origin (no SSRF / cross-origin).
 *  - GET-ONLY, NO REDIRECTS: the injected `getJson` must use a hardcoded GET with
 *    redirect="error"; the binder consumes a response ONLY when status==200 &&
 *    !redirected && !bytesOver.
 *  - SSE XOR POLL: `channelFor` picks exactly one channel per node — never both.
 *  - BOUNDED: `clampPoll` floors cadence at 5s; a whole-session timer auto-stops the
 *    node after 30 min; response byte/row caps live in `getJson`/the renderer.
 *  - TEARABLE: `stop()` clears the poll timer, closes the SSE, and latches so no
 *    late callback paints after unmount.
 *  - NO AUTH IN URL: the binder puts ONLY bind.query on the URL; auth is the host
 *    transport's business, never a query param the manifest can influence.
 *
 * Dependency-injected (getJson/openSse/timers) → testable under --experimental-strip-types
 * and self-contained for `.toString()` inlining next to the renderer.
 */
import type { IrBind, IrNode, KitText } from "./dashboard-ir.js";
import { kitText } from "./dashboard-ir.js";

export const BINDER_LIM = { maxBytes: 512 * 1024, maxRows: 200, minPollMs: 5000, maxPollMs: 3_600_000, defaultPollMs: 30_000, sessionMs: 30 * 60 * 1000 } as const;

/** Build the absolute URL for a bind — ONLY against the fixed origin. Returns null
 * (bind is dropped) for anything that could escape it. bind.path is already
 * policy-validated upstream; this is the transport-layer re-guard. */
export function bindUrl(origin: string, bind: IrBind): string | null {
  const p = bind.path;
  if (typeof p !== "string" || p.length < 2) return null;
  if (p[0] !== "/" || p[1] === "/") return null;            // must be root-relative, not //host
  if (p.indexOf("..") !== -1) return null;                   // no traversal
  if (/[\s<>"'`\\?#]/.test(p)) return null;                  // no whitespace / query / fragment / quotes
  if (p.indexOf("/api/") !== 0) return null;                 // /api/ only
  let qs = "";
  if (bind.query) {
    const parts: string[] = [];
    for (const k of Object.keys(bind.query)) {
      if (!Object.prototype.hasOwnProperty.call(bind.query, k)) continue;
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String((bind.query as Record<string, unknown>)[k])));
    }
    if (parts.length) qs = "?" + parts.join("&");
  }
  return origin + p + qs;
}

/** Exactly one live channel per node — SSE if present, else polling. Never both. */
export function channelFor(bind: IrBind): "sse" | "poll" {
  return bind.sse ? "sse" : "poll";
}

/** Poll cadence, clamped to [5s, 1h] with a ~30s default (never faster than the floor). */
export function clampPoll(bind: IrBind): number {
  const ms = typeof bind.pollMs === "number" && Number.isFinite(bind.pollMs) ? bind.pollMs : BINDER_LIM.defaultPollMs;
  return Math.max(BINDER_LIM.minPollMs, Math.min(ms, BINDER_LIM.maxPollMs));
}

export interface GetResult {
  status: number; redirected: boolean; bytesOver: boolean; json: unknown;
  /** False when the transport already knows the read failed (wrong content type, unreadable or
   *  empty JSON). A failure is never delivered as data (PX-4 review #2524). */
  ok?: boolean;
  /** Short fixed reason for a failed read ("unexpected content type", ...). */
  reason?: KitText;
}
export interface BinderDeps {
  origin: string;
  /** REQUIRED transport contract (sol R7): hardcoded `method:"GET"`, `redirect:"error"`,
   * `credentials:"omit"` (no implicit same-origin cookies) + fixed headers; enforce the
   * byte cap INCREMENTALLY while reading (not only Content-Length) → set `bytesOver`;
   * require an `application/json` content type; reject otherwise. */
  getJson: (url: string, signal: unknown) => Promise<GetResult>;
  /** REQUIRED (sol R7): use FETCH-STREAMED SSE (not native EventSource, which follows
   * redirects) with `redirect:"error"`, abort support, and limits on event size, event
   * rate, reconnects, and total lifetime; same-origin only. onData per event; onErr on failure. */
  openSse?: (url: string, onData: (d: unknown) => void, onErr: () => void) => { close: () => void };
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  makeSignal: () => unknown;
}

/** Transport-owned HTTP status copy, never a server response body. */
export function httpStatusText(status: number): KitText { return ("HTTP " + status) as KitText; }

// ── Provenance freshness (PX-4) ──────────────────────────────────────────────
/** Max future skew tolerated on a source `asOf`. A timestamp further ahead than this is
 *  not trusted (it would otherwise "win" forever and freeze the view against later real
 *  updates). */
export const ASOF_MAX_SKEW_MS = 120_000;
/** The only years a source may plausibly report. Outside this, a timestamp is not trusted
 *  (catches a unit/format bug — e.g. Unix seconds misread as a year, an epoch placeholder —
 *  independent of "now", so it holds even for a long-past or far-future legitimate read). */
export const ASOF_MIN_YEAR = 2020;
export const ASOF_MAX_YEAR = 2100;
/** Canonical UTC ONLY: `YYYY-MM-DDTHH:mm:ss(.sss)?Z`. No bare offset (`+02:00`), no missing
 *  zone, no non-ISO format. `Date.parse` is deliberately NOT used on the raw string: it is
 *  locale/implementation-lenient (a missing zone reads as local time, "09/24/2026" parses,
 *  an out-of-range field like Feb 30 silently rolls into March), which would make freshness
 *  non-deterministic across environments and let a malformed `asOf` still "win". */
const ASOF_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?Z$/;
/** The moment the SOURCE read this state: an own-property, canonical-UTC, calendar-valid,
 *  in-range-year `asOf` on the payload, not future-dated beyond the skew, normalized
 *  (toISOString) so comparisons are exact. NULL when the source did not say, or said
 *  something that is not a trustworthy timestamp: receipt time is NOT a substitute (PX-4
 *  review #2524), so data without a source time is never presented as fresh. */
export function sourceAsOf(json: unknown, nowMs: number): string | null {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
  if (!Object.prototype.hasOwnProperty.call(json, "asOf")) return null;
  const raw = (json as Record<string, unknown>).asOf;
  if (typeof raw !== "string") return null;
  const m = ASOF_RE.exec(raw);
  if (!m) return null; // not canonical UTC — no zone, an offset, or any other format
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]), hh = Number(m[4]), mi = Number(m[5]), ss = Number(m[6]);
  if (y < ASOF_MIN_YEAR || y > ASOF_MAX_YEAR) return null;
  // Round-trip the calendar via Date.UTC's own normalization: Date.UTC silently rolls an
  // out-of-range field into the next unit (Feb 30 -> Mar 2, hour 99 -> +4 days...); reading
  // the fields back and requiring an EXACT match rejects any date the calendar doesn't have.
  const calendarMs = Date.UTC(y, mo - 1, d, hh, mi, ss);
  const check = new Date(calendarMs);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d ||
      check.getUTCHours() !== hh || check.getUTCMinutes() !== mi || check.getUTCSeconds() !== ss) return null;
  const ms = m[7] ? Number((m[7].slice(1) + "000").slice(0, 3)) : 0; // ".5"->500, ".12"->120, ".123"->123
  const t = calendarMs + ms;
  if (!Number.isFinite(t) || t > nowMs + ASOF_MAX_SKEW_MS) return null;
  return new Date(t).toISOString();
}
/** Older than the source's freshness budget at `nowMs`. */
export function isStale(asOfIso: string, maxAgeMs: number, nowMs: number): boolean {
  const t = Date.parse(asOfIso);
  return !Number.isFinite(t) || nowMs - t > maxAgeMs;
}
/** No-regression rule: an update may replace the shown datum only if it is not OLDER. An
 *  EQUAL timestamp is accepted only when its datum fingerprint (the bound value the caller
 *  actually extracted for this node — see dashboard-ir-browser-entry.ts) matches the one
 *  already shown: an idempotent refresh (same source read, same value) may refresh
 *  freshness, but two DIFFERENT payloads reported under the same `asOf` are undecidable by
 *  time alone, and arrival order must not matter — so the rule is total and deterministic:
 *  whichever payload is already shown keeps winning until a genuinely newer `asOf` arrives.
 *  A `null` incoming fingerprint (the caller could not extract one) is not a known duplicate
 *  and is let through, so the caller's own validation decides rather than the view silently
 *  freezing on a fingerprinting gap. Reconnects and out-of-order polls can therefore never
 *  roll authoritative state backwards, and never flap between two conflicting same-timestamp
 *  payloads depending on network timing. */
export function acceptsNewer(currentAsOf: string | null, incomingAsOf: string, currentFingerprint: string | null, incomingFingerprint: string | null): boolean {
  if (currentAsOf === null) return true;
  const cur = Date.parse(currentAsOf), inc = Date.parse(incomingAsOf);
  if (inc > cur) return true;
  if (inc < cur) return false;
  if (incomingFingerprint === null) return true;
  return incomingFingerprint === currentFingerprint;
}

/**
 * Start binding one node; returns a `{ stop }` handle. GET-only, single channel,
 * bounded, and auto-stopping after the session cap. `onData(json)` hands a validated
 * clean-200 JSON object or array to the painter. `onStale(why)` (optional) fires when a read
 * FAILS, with a short fixed reason ("HTTP 401", "unexpected content type", ...), so the view
 * says the source is unavailable instead of implying it is current. `onEnded(why)` (optional)
 * fires once when the session cap ends the binding. Nothing is delivered after `stop()`.
 */
export function startBind(node: IrNode, deps: BinderDeps, onData: (json: unknown) => void, onStale?: (why: KitText) => void, onEnded?: (why: KitText) => void): { stop: () => void } {
  const bind = node.bind;
  let stopped = false;
  let pollTimer: unknown = null;
  let sse: { close: () => void } | null = null;
  let sessionTimer: unknown = null;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (pollTimer !== null) { deps.clearTimer(pollTimer); pollTimer = null; }
    if (sessionTimer !== null) { deps.clearTimer(sessionTimer); sessionTimer = null; }
    if (sse) { sse.close(); sse = null; }
  };
  if (!bind) return { stop };
  const url = bindUrl(deps.origin, bind);
  if (url === null) { stop(); return { stop }; }         // unbuildable URL → bind is inert
  sessionTimer = deps.setTimer(() => { // whole-session teardown: the view must stop claiming currency
    if (stopped) return;
    stop();
    if (onEnded) onEnded(kitText("updates stopped"));
  }, BINDER_LIM.sessionMs);

  if (channelFor(bind) === "sse" && deps.openSse && bind.sse) {
    const sseUrl = deps.origin + bind.sse;                // sse path already policy-validated
    sse = deps.openSse(sseUrl, (d) => { if (!stopped) onData(d); }, () => { if (!stopped && onStale) onStale(kitText("stream error")); stop(); });
  } else {
    // ONE in-flight request per bind (the next tick is scheduled only after this one
    // settles — a timer never overlaps its request). Failures back off exponentially
    // (capped) so a flapping endpoint can't hammer the origin; a clean 200 resets it.
    let fails = 0;
    const nextDelay = (): number => Math.min(clampPoll(bind) * Math.pow(2, fails < 6 ? fails : 6), BINDER_LIM.maxPollMs);
    const tick = (): void => {
      if (stopped) return;
      deps.getJson(url, deps.makeSignal()).then((r) => {
        if (stopped) return;
        const clean = r.ok !== false && r.status === 200 && !r.redirected && !r.bytesOver && r.json !== null && typeof r.json === "object";
        if (clean) { fails = 0; onData(r.json); } // consume ONLY a clean same-origin JSON object/array
        else { // the read failed: nothing current to show
          fails++;
          if (onStale) onStale(r.reason ?? (r.redirected ? kitText("redirected") : r.bytesOver ? kitText("response too large") : r.status !== 200 ? httpStatusText(r.status) : kitText("empty response")));
        }
        pollTimer = deps.setTimer(tick, nextDelay());
      }).catch(() => { if (stopped) return; fails++; if (onStale) onStale(kitText("network error")); pollTimer = deps.setTimer(tick, nextDelay()); });
    };
    tick();
  }
  return { stop };
}
