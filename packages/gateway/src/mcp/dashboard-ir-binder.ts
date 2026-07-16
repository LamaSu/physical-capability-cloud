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
import type { IrBind, IrNode } from "./dashboard-ir.ts";

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

export interface GetResult { status: number; redirected: boolean; bytesOver: boolean; json: unknown }
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

/**
 * Start binding one node; returns a `{ stop }` handle. GET-only, single channel,
 * bounded, and auto-stopping after the session cap. `onData(json)` hands a validated
 * 200 body to the caller (which routes it to bindScalar/bindListRows). No data is
 * delivered after `stop()`.
 */
export function startBind(node: IrNode, deps: BinderDeps, onData: (json: unknown) => void): { stop: () => void } {
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
  sessionTimer = deps.setTimer(stop, BINDER_LIM.sessionMs); // whole-session teardown

  if (channelFor(bind) === "sse" && deps.openSse && bind.sse) {
    const sseUrl = deps.origin + bind.sse;                // sse path already policy-validated
    sse = deps.openSse(sseUrl, (d) => { if (!stopped) onData(d); }, () => stop());
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
        if (r.status === 200 && !r.redirected && !r.bytesOver) { fails = 0; onData(r.json); } // consume ONLY a clean same-origin 200
        else { fails++; }
        pollTimer = deps.setTimer(tick, nextDelay());
      }).catch(() => { if (stopped) return; fails++; pollTimer = deps.setTimer(tick, nextDelay()); });
    };
    tick();
  }
  return { stop };
}
