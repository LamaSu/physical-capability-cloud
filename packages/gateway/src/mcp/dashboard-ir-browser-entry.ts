/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Phase B — BROWSER composition root (item 8). esbuild bundles THIS + the audited
 * modules (dashboard-ir / -renderer / -binder) into
 *   apps/dashboard/public/ui-kit/v1/pcc-ir-kit.js   (committed, unminified, byte-checked)
 *
 * Imports the audited security core UNCHANGED; adds only browser glue:
 *  - the read-only MCP Apps lifecycle (ui/initialize → ui/notifications/initialized →
 *    ui/notifications/tool-result; answers ui/resource-teardown), render-once;
 *  - a FIXED PCC API origin injected by the trusted server boot script
 *    (window.__PCC_IR_ORIGIN__) — never the manifest/parent/document origin; no valid
 *    origin ⇒ no live binding (static render);
 *  - a bounded size preflight before adapt/validate (no unbounded serialize);
 *  - GET-only fetch (credentials:"omit", redirect:"error", exact application/json,
 *    non-clean bodies cancelled, incremental 512KB cap) — SSE is NOT used (run cards
 *    bind via GET poll, so the audited SSE policy is unreachable here);
 *  - a global 6-way concurrency gate with cancellation-aware, permit-reserving waiters;
 *  - per-render bind GENERATION with an AbortController: visibility-hide / teardown /
 *    pagehide abort in-flight GETs and drop queued waiters, so visibility churn cannot
 *    grow work unbounded.
 *
 * Exposes NO host-call interface; contains NONE of tools/call, __PCC_HOST_BRIDGE__,
 * __PCC_HOST_OPERATIONS__, capability registration, or a write transport.
 */
import { dashboardManifestToIr, validateIr, provenanceOf, metricSourceType, recordValueText } from "./dashboard-ir.js";
import type { IrDoc, IrNode } from "./dashboard-ir.js";
import { bootIrView, bindListRows, listRowsReadable, bindSchemaCard, applyFreshness, applyUnavailable, applyUnknownTime } from "./dashboard-ir-renderer.js";
import type { RDocument, RElement } from "./dashboard-ir-renderer.js";
import { startBind, sourceAsOf, isStale, acceptsNewer } from "./dashboard-ir-binder.js";
import type { BinderDeps, GetResult } from "./dashboard-ir-binder.js";

const CAP = {
  docChars: 256 * 1024,   // bounded manifest preflight: total string + key chars
  maxNodes: 20_000,       // bounded manifest preflight: total DISTINCT nodes visited
  maxFanout: 4096,        // bounded manifest preflight: per-container children
  maxPending: 100_000,    // bounded manifest preflight: max enqueued (stack) references
  respBytes: 512 * 1024,  // per-response byte cap (incremental)
  concurrent: 6,          // global max in-flight binds
  reqTimeoutMs: 30_000,
  protocol: "2026-01-26",
  initId: 1,
} as const;
const MOUNT_ID = "pcc-ir-root";

/** Fixed PCC API origin — injected by the trusted (nonce) server boot script into
 * window.__PCC_IR_ORIGIN__, matching MCP_APP_API_BASE_URL + the CSP connect-src. NEVER
 * derived from the manifest / parent / runtime document origin (which may be the app
 * domain, a host origin, or "null"). Returns null if absent/invalid ⇒ no binding. */
function pccApiOrigin(): string | null {
  const o = (window as unknown as { __PCC_IR_ORIGIN__?: unknown }).__PCC_IR_ORIGIN__;
  return typeof o === "string" && /^https:\/\/[a-z0-9.-]+$/i.test(o) ? o : null;
}

// ── real DOM wrapped in the renderer's minimal RElement (fresh detached container per render) ──
interface Wrapped extends RElement { _el: HTMLElement }
function wrapEl(real: HTMLElement): Wrapped {
  const children: RElement[] = [];
  const w = {
    _el: real, children,
    get textContent() { return real.textContent ?? ""; },
    set textContent(v: string) { real.textContent = v; },
    get className() { return real.className; },
    set className(v: string) { real.className = v; },
    setAttr(n: string, v: string) { real.setAttribute(n, v); },
    removeAttr(n: string) { real.removeAttribute(n); },
    appendChild(c: Wrapped) { real.appendChild(c._el); children.push(c); return c; },
  };
  return w as unknown as Wrapped;
}
const rdoc: RDocument = { createElement: (tag: string) => wrapEl(document.createElement(tag)) as unknown as RElement };
function inert(mount: HTMLElement, msg: string): void {
  const p = document.createElement("p");
  p.className = "pcc-invalid";
  p.textContent = msg;
  mount.replaceChildren(p);
}

/** Bounded preflight — reject an oversized/pathological manifest BEFORE any full
 * serialize/traverse. Cycle- and shared-reference-safe (structured clone allows both):
 * a WeakSet skips already-visited objects, `pending` caps enqueued work, per-container
 * fanout is enforced WITHOUT materializing a key array (for-in + early break), and
 * property-name characters count against the char budget. */
function tooLarge(root: unknown): boolean {
  const seen = new WeakSet<object>();
  let nodes = 0, chars = 0, pending = 1;
  const stack: unknown[] = [root];
  while (stack.length) {
    const v = stack.pop(); pending--;
    if (++nodes > CAP.maxNodes) return true;
    if (typeof v === "string") { chars += v.length; if (chars > CAP.docChars) return true; continue; }
    if (!v || typeof v !== "object") continue;
    if (seen.has(v)) continue; // cycle / shared reference already accounted
    seen.add(v);
    if (Array.isArray(v)) {
      if (v.length > CAP.maxFanout || pending + v.length > CAP.maxPending) return true;
      for (let i = 0; i < v.length; i++) { stack.push(v[i]); pending++; }
    } else {
      let kn = 0;
      for (const k in v) {
        if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
        if (++kn > CAP.maxFanout || pending + 1 > CAP.maxPending) return true;
        chars += k.length; if (chars > CAP.docChars) return true;
        stack.push((v as Record<string, unknown>)[k]); pending++;
      }
    }
  }
  return false;
}

// ── global concurrency gate: cancellation-aware; a woken waiter inherits the permit ──
let inFlight = 0;
interface Waiter { wake: () => void; onAbort: () => void }
const waiters: Waiter[] = [];
function acquire(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
  if (inFlight < CAP.concurrent) { inFlight++; return Promise.resolve(); }
  return new Promise<void>((resolve, reject) => {
    const w: Waiter = { wake: () => {}, onAbort: () => {} };
    w.onAbort = () => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); reject(new DOMException("aborted", "AbortError")); };
    w.wake = () => { signal.removeEventListener("abort", w.onAbort); resolve(); }; // permit transferred from releaser; inFlight unchanged
    signal.addEventListener("abort", w.onAbort, { once: true });
    waiters.push(w);
  });
}
function release(): void { const n = waiters.shift(); if (n) n.wake(); else inFlight--; }

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total); let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
/** GET-only, fixed-origin, redirect:"error", credentials:"omit". Consumes a body ONLY
 * for a clean same-origin 200 with an EXACT application/json type; every non-clean
 * response (non-200 / redirected / wrong type / oversize) is cancelled, not read. */
async function realGetJson(url: string, signal: AbortSignal): Promise<GetResult> {
  const resp = await fetch(url, { method: "GET", redirect: "error", credentials: "omit", cache: "no-store", headers: { accept: "application/json" }, signal });
  const redirected = resp.redirected;
  const ct = (resp.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (resp.status !== 200 || redirected || ct !== "application/json") {
    try { await resp.body?.cancel(); } catch { /* ignore */ }
    const reason = resp.status !== 200 ? "HTTP " + resp.status : redirected ? "redirected" : "unexpected content type";
    return { status: resp.status, redirected, bytesOver: false, json: null, ok: false, reason };
  }
  const reader = resp.body ? resp.body.getReader() : null;
  const chunks: Uint8Array[] = []; let received = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.length;
        if (received > CAP.respBytes) { try { await reader.cancel(); } catch { /* ignore */ } return { status: 200, redirected: false, bytesOver: true, json: null, ok: false, reason: "response too large" }; }
        chunks.push(value);
      }
    }
  }
  let json: unknown = null;
  try { json = JSON.parse(new TextDecoder().decode(concat(chunks, received))); } catch {
    return { status: 200, redirected: false, bytesOver: false, json: null, ok: false, reason: "unreadable response" };
  }
  if (json === null || typeof json !== "object") return { status: 200, redirected: false, bytesOver: false, json: null, ok: false, reason: "empty response" };
  return { status: 200, redirected: false, bytesOver: false, json, ok: true };
}

// ── render + bind ────────────────────────────────────────────────────────────────
let rendered = false;
let disposed = false; // TERMINAL: after ui/resource-teardown, no path renders/binds/reacts again
let boundHandles: Array<{ stop: () => void }> = [];
let genController: AbortController | null = null;
let liveDoc: IrDoc | null = null;
let liveRoot: HTMLElement | null = null;

function collectBound(doc: IrDoc): { stats: IrNode[]; lists: IrNode[]; schemaCards: IrNode[] } {
  // schemaCards = the data-bearing capability/run cards, in document order (aligned with the
  // `.pcc-schema-card` query in startBinds). The settlement record is a STATIC pointer (no
  // bind, no `.pcc-schema-card` class) → intentionally not collected here.
  const stats: IrNode[] = [], lists: IrNode[] = [], schemaCards: IrNode[] = [];
  const walk = (n: IrNode): void => {
    if (n.bind) {
      if (n.type === "stat") stats.push(n);
      else if (n.type === "list") lists.push(n);
      else if (n.type === "card") schemaCards.push(n);
    }
    if (n.children) for (const c of n.children) walk(c);
  };
  walk(doc.root);
  return { stats, lists, schemaCards };
}
/** PX-4 provenance gate for one bound node (hardened per cross-family review #2524).
 *  - Absence is not evidence: a failed, errored, timed-out, off-schema, partial or unreadable
 *    read CLEARS what was shown and says "unavailable · <why>". Nothing last-known or default
 *    is ever left on screen as if current.
 *  - Freshness: a datum is "fresh" only when the SOURCE said when it read it (asOf), and only
 *    until the route's budget runs out: a timer marks it stale on its own, and a resume
 *    re-checks it. Data without a source time is shown with "source time not reported" and is
 *    never presented as fresh (receipt time is kept separate).
 *  - No regression: an update older than the ordering watermark, or without a source time
 *    once a timed datum has been accepted, is dropped. The watermark is kept apart from
 *    whether a value is currently shown, and it survives binding restarts.
 *  - One state and one metadata line per bound node, kept across restarts (hide/show).
 *  `paint(data, sourceAsOf)` must validate the complete route-specific payload and paint ONLY
 *  if it fits; otherwise it returns a short fixed reason and leaves the DOM untouched.
 *  `clear()` removes shown values. */
interface ProvState { meta: HTMLElement; watermark: string | null; shown: boolean; timeKnown: boolean; expiry: ReturnType<typeof setTimeout> | null }
const provStates = new Map<string, ProvState>();
function provenanced(node: IrNode, el: HTMLElement, paint: (data: unknown, src: string | null) => true | string, clear: () => void): { onData: (d: unknown) => void; onStale: (why: string) => void; onEnded: (why: string) => void } {
  const prov = provenanceOf(node);
  const host = wrapEl(el) as unknown as RElement;
  let st = provStates.get(node.id);
  if (!st) {
    const metaReal = document.createElement("div");
    if (el.parentNode) el.parentNode.insertBefore(metaReal, el.nextSibling);
    st = { meta: metaReal, watermark: null, shown: false, timeKnown: false, expiry: null };
    provStates.set(node.id, st);
  }
  const state = st;
  const meta = wrapEl(state.meta) as unknown as RElement;
  const disarm = (): void => { if (state.expiry !== null) { clearTimeout(state.expiry); state.expiry = null; } };
  const markFresh = (): void => { // (re)evaluate freshness now and arm the expiry for later
    disarm();
    if (!state.shown || !state.timeKnown || state.watermark === null || !prov) return;
    const now = Date.now();
    const stale = isStale(state.watermark, prov.maxAgeMs, now);
    applyFreshness(host, meta, state.watermark, stale);
    if (!stale) {
      const left = Date.parse(state.watermark) + prov.maxAgeMs - now;
      state.expiry = setTimeout(() => { state.expiry = null; if (state.shown && state.watermark) applyFreshness(host, meta, state.watermark, true); }, Math.max(0, left) + 1);
    }
  };
  const failed = (why: string): void => {
    disarm();
    clear();
    state.shown = false;
    applyUnavailable(host, meta, why);
  };
  markFresh(); // a restart (resume) re-checks what is already shown
  return {
    onData: (data) => {
      const now = Date.now();
      const src = sourceAsOf(data, now);
      if (state.watermark !== null && (src === null || !acceptsNewer(state.watermark, src))) return; // never roll back
      const painted = paint(data, src);
      if (painted !== true) { failed(painted); return; } // not data for this route
      state.shown = true;
      if (src !== null) { state.watermark = src; state.timeKnown = true; markFresh(); }
      else { disarm(); state.timeKnown = false; applyUnknownTime(host, meta, new Date(now).toISOString()); }
    },
    onStale: failed,
    onEnded: failed,
  };
}
function startBinds(doc: IrDoc, root: HTMLElement): void {
  const origin = pccApiOrigin();
  if (!origin) {
    // No trusted PCC origin injected: nothing can be read, and the bound elements must say so
    // rather than sit empty (absence is not evidence).
    const { stats, lists, schemaCards } = collectBound(doc);
    const els = (cls: string) => Array.from(root.querySelectorAll<HTMLElement>("." + cls));
    const mark = (nodes: IrNode[], cls: string) => nodes.forEach((node, i) => { const el = els(cls)[i]; if (el) provenanced(node, el, () => "no live data source", () => {}).onStale("no live data source"); });
    mark(stats, "pcc-stat"); mark(lists, "pcc-list"); mark(schemaCards, "pcc-schema-card");
    return;
  }
  const gen = new AbortController();
  genController = gen;
  const deps: BinderDeps = {
    origin,
    // The signal is the GENERATION signal; per request we add a timeout + gen-link on a
    // fresh controller and clean BOTH up when the request settles (no leaked timer/listener).
    getJson: async (url: string, sig: unknown) => {
      const s = sig as AbortSignal;
      await acquire(s); // rejects if the generation already aborted / aborts while queued
      const ctrl = new AbortController();
      const onGen = () => ctrl.abort(new DOMException("generation aborted", "AbortError"));
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        if (s.aborted) ctrl.abort();
        else s.addEventListener("abort", onGen, { once: true });
        timer = setTimeout(() => ctrl.abort(new DOMException("timeout", "TimeoutError")), CAP.reqTimeoutMs);
        return await realGetJson(url, ctrl.signal);
      } finally {
        if (timer !== null) clearTimeout(timer);
        s.removeEventListener("abort", onGen);
        release();
      }
    },
    // NO openSse: SSE transport intentionally absent — run cards bind via GET poll only.
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    makeSignal: () => gen.signal,
  };
  const { stats, lists, schemaCards } = collectBound(doc);
  const byClass = (cls: string) => Array.from(root.querySelectorAll<HTMLElement>("." + cls));
  const statEls = byClass("pcc-stat"), listEls = byClass("pcc-list"), schemaEls = byClass("pcc-schema-card");
  const push = (h: { stop: () => void }) => boundHandles.push(h);
  stats.forEach((node, i) => {
    const el = statEls[i]; const slot = el?.querySelector<HTMLElement>(".pcc-value"); if (!el || !slot) return;
    const want = node.bind ? metricSourceType(node.bind.path, node.bind.select) : null;
    const pv = provenanced(node, el, (data) => {
      // The metric's field must be present with its declared type; anything else is not data.
      let cur: unknown = data;
      for (const seg of String(node.bind?.select ?? "").split(".")) {
        if (cur === null || typeof cur !== "object" || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return "missing field";
        cur = (cur as Record<string, unknown>)[seg];
      }
      if (want === "number" ? !(typeof cur === "number" && Number.isFinite(cur)) : !(typeof cur === "string" && cur !== "")) return "mistyped field";
      // A status metric's money-state word is qualified, exactly as bindScalar does (#3013).
      slot.textContent = recordValueText(String(node.bind?.select ?? ""), String(cur));
      return true;
    }, () => { slot.textContent = ""; });
    push(startBind(node, deps, pv.onData, pv.onStale, pv.onEnded));
  });
  // Fixed-schema cards (capability/run/settlement): PCC owns the labels; each value slot
  // ← its ONE fixed key via bindSchemaCard. The manifest supplies NO selector here, so it
  // can neither relabel a field nor surface an off-schema response field.
  schemaCards.forEach((node, i) => {
    const el = schemaEls[i]; if (!el) return;
    const schema = node.bind?.schema; if (!schema) return;
    const slots = Array.from(el.querySelectorAll<HTMLElement>(".pcc-value"));
    const pv = provenanced(node, el, (data) => (bindSchemaCard(schema, data, slots) ? true : "missing required fields"), () => { for (const sl of slots) sl.textContent = ""; });
    push(startBind(node, deps, pv.onData, pv.onStale, pv.onEnded));
  });
  lists.forEach((node, i) => { const el = listEls[i]; if (!el) return; const pv = provenanced(node, el, (data, src) => {
    // collection-v1 is a top-level array or { items: [...] }. Anything else is NOT an empty
    // list: rendering it as one would claim "none" of something the source never listed.
    const rows = Array.isArray(data) ? data : (data && typeof data === "object" && Array.isArray((data as { items?: unknown }).items) ? (data as { items: unknown[] }).items : null);
    if (rows === null) return "unexpected response shape";
    // A partial collection (any unreadable row) is not data.
    if (!listRowsReadable(node, rows)) return "partial collection";
    // Empty-read policy: "none" is shown only when the SOURCE vouches for when it read the
    // empty set; an empty result without a source time is not evidence of absence.
    if (rows.length === 0 && src === null) return "empty result without a source time";
    const staging = document.createElement("div"); // paint off-DOM: a rejected payload never touches the view
    bindListRows(rdoc, wrapEl(staging) as unknown as RElement, node, rows, node.bind?.path ?? "");
    el.replaceChildren(...Array.from(staging.childNodes));
    return true;
  }, () => { el.replaceChildren(); }); push(startBind(node, deps, pv.onData, pv.onStale, pv.onEnded)); });
}
function stopBinds(): void {
  for (const h of boundHandles) h.stop();
  boundHandles = [];
  if (genController) { genController.abort(); genController = null; } // abort in-flight GETs + drop queued waiters
}

function renderManifest(manifest: unknown): void {
  if (disposed || rendered) return; // render exactly once; never after teardown
  const mount = document.getElementById(MOUNT_ID);
  if (!mount) return;
  if (tooLarge(manifest)) { rendered = true; inert(mount, "This dashboard is too large and was not rendered."); return; }
  // Any exception while adapting or validating is the same inert failure, never a partial render.
  let r: ReturnType<typeof dashboardManifestToIr>;
  try { r = dashboardManifestToIr(manifest as never); } catch { r = { ok: false, reason: "adapter threw" }; }
  if (!r.ok) { rendered = true; inert(mount, "This dashboard could not be verified and was not rendered."); return; }
  rendered = true;
  const container = wrapEl(document.createElement("div"));
  let painted = false;
  try { painted = bootIrView(rdoc, container as unknown as RElement, r.doc, validateIr); } // in-browser re-validate + paint
  catch { inert(mount, "This dashboard could not be verified and was not rendered."); return; }
  mount.replaceChildren(container._el);
  if (painted) { liveDoc = r.doc; liveRoot = container._el; startBinds(r.doc, container._el); }
}

// ── read-only MCP Apps lifecycle (no bridge, no outbound calls) ──────────────────
function boot(): void {
  const parent = window.parent;
  let state: "init" | "ready" = "init";
  window.addEventListener("message", (ev: MessageEvent) => {
    if (ev.source !== parent) return; // host parent only
    const d = ev.data as Record<string, unknown> | null;
    if (!d || typeof d !== "object" || (d as { jsonrpc?: unknown }).jsonrpc !== "2.0") return;
    // graceful teardown (a request with an id) — LATCH terminal, then stop + ack.
    if ((d as { method?: unknown }).method === "ui/resource-teardown" && "id" in d) {
      if (!disposed) { disposed = true; stopBinds(); }
      try { parent.postMessage({ jsonrpc: "2.0", id: (d as { id: unknown }).id, result: {} }, "*"); } catch { /* ignore */ }
      return;
    }
    if (disposed) return; // terminal — ignore init results, tool-results, everything after teardown
    if (state === "init" && (d as { id?: unknown }).id === CAP.initId && (d as { result?: unknown }).result && typeof (d as { result: unknown }).result === "object") {
      if ((d as { result: { protocolVersion?: unknown } }).result.protocolVersion !== CAP.protocol) return;
      state = "ready";
      parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*");
      return;
    }
    if (state === "ready" && (d as { method?: unknown }).method === "ui/notifications/tool-result") {
      const params = (d as { params?: unknown }).params;
      const structured = params && typeof params === "object" ? (params as { structuredContent?: unknown }).structuredContent : null;
      const manifest = structured && typeof structured === "object" ? (structured as { manifest?: unknown }).manifest : null;
      if (manifest != null) renderManifest(manifest);
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (disposed) return; // terminal — a visible event after teardown must not restart binds
    if (document.hidden) stopBinds();
    else if (liveDoc && liveRoot) { stopBinds(); startBinds(liveDoc, liveRoot); }
  });
  window.addEventListener("pagehide", stopBinds);
  // Announce the app; the host replies with the ui/initialize result.
  parent.postMessage({ jsonrpc: "2.0", id: CAP.initId, method: "ui/initialize", params: { protocolVersion: CAP.protocol, appInfo: { name: "pcc-dashboard-ir", version: "1" }, appCapabilities: {} } }, "*");
}

if (typeof window !== "undefined" && typeof document !== "undefined") boot();
