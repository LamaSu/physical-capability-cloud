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
 *    are unbound, so the audited SSE policy is unreachable here);
 *  - a global 6-way concurrency gate with cancellation-aware, permit-reserving waiters;
 *  - per-render bind GENERATION with an AbortController: visibility-hide / teardown /
 *    pagehide abort in-flight GETs and drop queued waiters, so visibility churn cannot
 *    grow work unbounded.
 *
 * Exposes NO host-call interface; contains NONE of tools/call, __PCC_HOST_BRIDGE__,
 * __PCC_HOST_OPERATIONS__, capability registration, or a write transport.
 */
import { dashboardManifestToIr, validateIr } from "./dashboard-ir.js";
import type { IrDoc, IrNode } from "./dashboard-ir.js";
import { bootIrView, bindScalar, bindListRows } from "./dashboard-ir-renderer.js";
import type { RDocument, RElement } from "./dashboard-ir-renderer.js";
import { startBind } from "./dashboard-ir-binder.js";
import type { BinderDeps, GetResult } from "./dashboard-ir-binder.js";

const CAP = {
  docChars: 256 * 1024,   // bounded manifest preflight: total string chars
  maxNodes: 20_000,       // bounded manifest preflight: total nodes
  maxFanout: 4096,        // bounded manifest preflight: per-container children
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
 * serialize/traverse (a hostile parent must not force a large alloc first). */
function tooLarge(root: unknown): boolean {
  let nodes = 0, chars = 0;
  const stack: unknown[] = [root];
  while (stack.length) {
    const v = stack.pop();
    if (++nodes > CAP.maxNodes) return true;
    if (typeof v === "string") { chars += v.length; if (chars > CAP.docChars) return true; }
    else if (Array.isArray(v)) { if (v.length > CAP.maxFanout) return true; for (let i = 0; i < v.length; i++) stack.push(v[i]); }
    else if (v && typeof v === "object") { const ks = Object.keys(v as object); if (ks.length > CAP.maxFanout) return true; for (const k of ks) stack.push((v as Record<string, unknown>)[k]); }
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

/** A per-bind AbortSignal linked to the current bind GENERATION + a request timeout
 * (no AbortSignal.timeout dependency). Aborting the generation aborts every in-flight
 * request derived from it. */
function makeSignal(gen: AbortController): AbortSignal {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("timeout", "TimeoutError")), CAP.reqTimeoutMs);
  ctrl.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  if (gen.signal.aborted) ctrl.abort();
  else gen.signal.addEventListener("abort", () => ctrl.abort(new DOMException("generation aborted", "AbortError")), { once: true });
  return ctrl.signal;
}

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
  if (resp.status !== 200 || redirected || ct !== "application/json") { try { await resp.body?.cancel(); } catch { /* ignore */ } return { status: resp.status, redirected, bytesOver: false, json: null }; }
  const reader = resp.body ? resp.body.getReader() : null;
  const chunks: Uint8Array[] = []; let received = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.length;
        if (received > CAP.respBytes) { try { await reader.cancel(); } catch { /* ignore */ } return { status: 200, redirected: false, bytesOver: true, json: null }; }
        chunks.push(value);
      }
    }
  }
  let json: unknown = null;
  try { json = JSON.parse(new TextDecoder().decode(concat(chunks, received))); } catch { json = null; }
  return { status: 200, redirected: false, bytesOver: false, json };
}

// ── render + bind ────────────────────────────────────────────────────────────────
let rendered = false;
let boundHandles: Array<{ stop: () => void }> = [];
let genController: AbortController | null = null;
let liveDoc: IrDoc | null = null;
let liveRoot: HTMLElement | null = null;

function collectBound(doc: IrDoc): { stats: IrNode[]; lists: IrNode[]; receipts: IrNode[] } {
  const stats: IrNode[] = [], lists: IrNode[] = [], receipts: IrNode[] = [];
  const walk = (n: IrNode): void => {
    if (n.bind) { if (n.type === "stat") stats.push(n); else if (n.type === "list") lists.push(n); else if (n.type === "receipt") receipts.push(n); }
    if (n.children) for (const c of n.children) walk(c);
  };
  walk(doc.root);
  return { stats, lists, receipts };
}
function startBinds(doc: IrDoc, root: HTMLElement): void {
  const origin = pccApiOrigin();
  if (!origin) return; // no trusted PCC origin injected → static render, no live binding
  const gen = new AbortController();
  genController = gen;
  const deps: BinderDeps = {
    origin,
    getJson: async (url: string, sig: unknown) => { const s = sig as AbortSignal; await acquire(s); try { return await realGetJson(url, s); } finally { release(); } },
    // NO openSse: SSE transport intentionally absent (run cards are unbound below).
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    makeSignal: () => makeSignal(gen),
  };
  const { stats, lists, receipts } = collectBound(doc);
  const byClass = (cls: string) => Array.from(root.querySelectorAll<HTMLElement>("." + cls));
  const statEls = byClass("pcc-stat"), listEls = byClass("pcc-list"), receiptEls = byClass("pcc-receipt");
  const push = (h: { stop: () => void }) => boundHandles.push(h);
  stats.forEach((node, i) => { const el = statEls[i]; const slot = el?.querySelector<HTMLElement>(".pcc-value"); if (slot) push(startBind(node, deps, (data) => { slot.textContent = bindScalar(node, data); })); });
  receipts.forEach((node, i) => { const el = receiptEls[i]; const slot = el?.querySelector<HTMLElement>(".pcc-value"); if (slot) push(startBind(node, deps, (data) => { slot.textContent = bindScalar(node, data); })); });
  lists.forEach((node, i) => { const el = listEls[i]; if (!el) return; push(startBind(node, deps, (data) => {
    const rows = Array.isArray(data) ? data : (data && typeof data === "object" && Array.isArray((data as { items?: unknown }).items) ? (data as { items: unknown[] }).items : []);
    el.replaceChildren(); bindListRows(rdoc, wrapEl(el) as unknown as RElement, node, rows);
  })); });
}
function stopBinds(): void {
  for (const h of boundHandles) h.stop();
  boundHandles = [];
  if (genController) { genController.abort(); genController = null; } // abort in-flight GETs + drop queued waiters
}

function renderManifest(manifest: unknown): void {
  if (rendered) return; // render exactly once; a hostile host re-sending cannot re-render
  const mount = document.getElementById(MOUNT_ID);
  if (!mount) return;
  if (tooLarge(manifest)) { rendered = true; inert(mount, "This dashboard is too large and was not rendered."); return; }
  const r = dashboardManifestToIr(manifest as never);
  if (!r.ok) { rendered = true; inert(mount, "This dashboard could not be verified and was not rendered."); return; }
  rendered = true;
  const container = wrapEl(document.createElement("div"));
  const painted = bootIrView(rdoc, container as unknown as RElement, r.doc, validateIr); // in-browser re-validate + paint
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
    // graceful teardown (a request with an id) — stop work + ack
    if ((d as { method?: unknown }).method === "ui/resource-teardown" && "id" in d) {
      stopBinds();
      try { parent.postMessage({ jsonrpc: "2.0", id: (d as { id: unknown }).id, result: {} }, "*"); } catch { /* ignore */ }
      return;
    }
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
    if (document.hidden) stopBinds();
    else if (liveDoc && liveRoot) { stopBinds(); startBinds(liveDoc, liveRoot); }
  });
  window.addEventListener("pagehide", stopBinds);
  // Announce the app; the host replies with the ui/initialize result.
  parent.postMessage({ jsonrpc: "2.0", id: CAP.initId, method: "ui/initialize", params: { protocolVersion: CAP.protocol, appInfo: { name: "pcc-dashboard-ir", version: "1" }, appCapabilities: {} } }, "*");
}

if (typeof window !== "undefined" && typeof document !== "undefined") boot();
