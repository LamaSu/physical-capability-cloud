/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Phase B — BROWSER composition root (item 8). esbuild bundles THIS + the audited
 * modules (dashboard-ir / -renderer / -binder) into
 *   apps/dashboard/public/ui-kit/v1/pcc-ir-kit.js   (committed, unminified, byte-checked)
 *
 * It imports the audited security core UNCHANGED and adds only browser glue:
 *  - a minimal READ-ONLY MCP Apps lifecycle (init handshake → tool-result → render);
 *  - the outer serialized-size cap before adapt/validate (sol R6 finding 2);
 *  - real transports: GET-only fetch (credentials:"omit", redirect:"error",
 *    incremental byte cap, JSON content-type) and fetch-streamed SSE (never
 *    EventSource; redirect:"error", event size/rate/lifetime caps);
 *  - a GLOBAL bind-concurrency cap, visibility pause/resume, and teardown.
 *
 * It exposes NO host-call interface and contains NONE of: tools/call,
 * __PCC_HOST_BRIDGE__, __PCC_HOST_OPERATIONS__, capability registration, or any
 * write transport. The pipeline is:  (untrusted) manifest → dashboardManifestToIr
 * → validateIr (in-browser gate) → bootIrView paint → startBind (GET-only).
 */
import { dashboardManifestToIr, validateIr } from "./dashboard-ir.js";
import type { IrDoc, IrNode } from "./dashboard-ir.js";
import { bootIrView, bindScalar, bindListRows } from "./dashboard-ir-renderer.js";
import type { RDocument, RElement } from "./dashboard-ir-renderer.js";
import { startBind } from "./dashboard-ir-binder.js";
import type { BinderDeps, GetResult } from "./dashboard-ir-binder.js";

const CAP = {
  docBytes: 256 * 1024,       // outer serialized-size cap on the inbound manifest
  respBytes: 512 * 1024,      // per-response byte cap (enforced incrementally)
  concurrent: 6,              // global max in-flight binds
  sseEvents: 10_000,          // per-stream event cap
  protocol: "2026-01-26",
  initId: 1,
} as const;
const MOUNT_ID = "pcc-ir-root";

// ── real DOM wrapped in the renderer's minimal RElement (children as an array; a
//    fresh detached container per render so the renderer's clear is a no-op) ──────
interface Wrapped extends RElement { _el: HTMLElement }
function wrapEl(real: HTMLElement): Wrapped {
  const children: RElement[] = [];
  const w: any = {
    _el: real, children,
    get textContent() { return real.textContent ?? ""; },
    set textContent(v: string) { real.textContent = v; },
    get className() { return real.className; },
    set className(v: string) { real.className = v; },
    setAttr(n: string, v: string) { real.setAttribute(n, v); },
    appendChild(c: Wrapped) { real.appendChild(c._el); children.push(c); return c; },
  };
  return w as Wrapped;
}
const rdoc: RDocument = { createElement: (tag: string) => wrapEl(document.createElement(tag)) as unknown as RElement };
function inert(mount: HTMLElement, msg: string): void {
  const p = document.createElement("p");
  p.className = "pcc-invalid";
  p.textContent = msg;
  mount.replaceChildren(p);
}

// ── transports (the getJson/openSse contracts the binder requires) ───────────────
function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total); let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
async function realGetJson(url: string, signal: AbortSignal): Promise<GetResult> {
  const resp = await fetch(url, {
    method: "GET", redirect: "error", credentials: "omit", cache: "no-store",
    headers: { accept: "application/json" }, signal,
  });
  const redirected = resp.redirected;
  const ct = resp.headers.get("content-type") || "";
  if (!/application\/json/i.test(ct)) return { status: resp.status, redirected, bytesOver: false, json: null };
  const reader = resp.body ? resp.body.getReader() : null;
  const chunks: Uint8Array[] = []; let received = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.length;
        if (received > CAP.respBytes) { try { await reader.cancel(); } catch { /* ignore */ } return { status: resp.status, redirected, bytesOver: true, json: null }; }
        chunks.push(value);
      }
    }
  }
  let json: unknown = null;
  try { json = JSON.parse(new TextDecoder().decode(concatChunks(chunks, received))); } catch { json = null; }
  return { status: resp.status, redirected, bytesOver: false, json };
}
// Global concurrency gate around getJson.
let inFlight = 0; const waiters: Array<() => void> = [];
async function gatedGetJson(url: string, signal: unknown): Promise<GetResult> {
  if (inFlight >= CAP.concurrent) await new Promise<void>((res) => waiters.push(res));
  inFlight++;
  try { return await realGetJson(url, signal as AbortSignal); }
  finally { inFlight--; const n = waiters.shift(); if (n) n(); }
}
// fetch-streamed SSE (never EventSource — it follows redirects + can't be byte/rate-capped).
function openSse(url: string, onData: (d: unknown) => void, onErr: () => void): { close: () => void } {
  const ctrl = new AbortController();
  let closed = false, events = 0, bytes = 0;
  fetch(url, { method: "GET", redirect: "error", credentials: "omit", cache: "no-store", headers: { accept: "text/event-stream" }, signal: ctrl.signal })
    .then(async (resp) => {
      if (!resp.ok || resp.redirected || !resp.body) { onErr(); return; }
      const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done || closed) break;
        if (value) { bytes += value.length; if (bytes > CAP.respBytes) { onErr(); return; } buf += dec.decode(value, { stream: true }); }
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          if (++events > CAP.sseEvents) { onErr(); return; }
          let data = "";
          for (const line of frame.split("\n")) if (line.indexOf("data:") === 0) data += line.slice(5).trim();
          if (data) { try { onData(JSON.parse(data)); } catch { /* ignore malformed event */ } }
        }
      }
    })
    .catch(() => { if (!closed) onErr(); });
  return { close() { closed = true; try { ctrl.abort(); } catch { /* ignore */ } } };
}
const binderDeps: BinderDeps = {
  origin: location.origin,
  getJson: gatedGetJson,
  openSse,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  makeSignal: () => AbortSignal.timeout(30_000),
};

// ── render + bind ────────────────────────────────────────────────────────────────
let rendered = false;
let boundHandles: Array<{ stop: () => void }> = [];
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
// Correlate bound IR nodes with painted elements by class + document order (paint
// order == walk order; deterministic). Then GET-bind each; card kinds stay static.
function startBinds(doc: IrDoc, root: HTMLElement): void {
  const { stats, lists, receipts } = collectBound(doc);
  const byClass = (cls: string) => Array.from(root.querySelectorAll<HTMLElement>("." + cls));
  const statEls = byClass("pcc-stat"), listEls = byClass("pcc-list"), receiptEls = byClass("pcc-receipt");
  const push = (h: { stop: () => void }) => boundHandles.push(h);
  stats.forEach((node, i) => { const el = statEls[i]; if (!el) return; const slot = el.querySelector<HTMLElement>(".pcc-value"); if (!slot) return; push(startBind(node, binderDeps, (data) => { slot.textContent = bindScalar(node, data); })); });
  receipts.forEach((node, i) => { const el = receiptEls[i]; if (!el) return; const slot = el.querySelector<HTMLElement>(".pcc-value"); if (!slot) return; push(startBind(node, binderDeps, (data) => { slot.textContent = bindScalar(node, data); })); });
  lists.forEach((node, i) => { const el = listEls[i]; if (!el) return; push(startBind(node, binderDeps, (data) => {
    const rows = Array.isArray(data) ? data : (data && typeof data === "object" && Array.isArray((data as any).items) ? (data as any).items : []);
    el.replaceChildren(); bindListRows(rdoc, wrapEl(el) as unknown as RElement, node, rows);
  })); });
}
function stopBinds(): void { for (const h of boundHandles) h.stop(); boundHandles = []; }

function renderManifest(manifest: unknown): void {
  if (rendered) return; // render exactly once; a hostile host re-sending cannot re-render
  const mount = document.getElementById(MOUNT_ID);
  if (!mount) return;
  let bytes = Infinity;
  try { bytes = JSON.stringify(manifest).length; } catch { bytes = Infinity; }
  if (bytes > CAP.docBytes) { rendered = true; inert(mount, "This dashboard is too large and was not rendered."); return; }
  const r = dashboardManifestToIr(manifest as any);
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
    if (ev.source !== parent) return;                 // host parent only
    const d = ev.data as Record<string, unknown> | null;
    if (!d || typeof d !== "object" || (d as any).jsonrpc !== "2.0") return;
    if (state === "init" && (d as any).id === CAP.initId && (d as any).result && typeof (d as any).result === "object") {
      if ((d as any).result.protocolVersion !== CAP.protocol) return;
      state = "ready";
      parent.postMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, "*");
      return;
    }
    if (state === "ready" && (d as any).method === "ui/notifications/tool-result") {
      const params = (d as any).params;
      const structured = params && typeof params === "object" ? params.structuredContent : null;
      const manifest = structured && typeof structured === "object" ? (structured as any).manifest : null;
      if (manifest != null) renderManifest(manifest);
    }
  });
  // pause on hidden, resume on visible, teardown on unload
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopBinds();
    else if (liveDoc && liveRoot) { stopBinds(); startBinds(liveDoc, liveRoot); }
  });
  window.addEventListener("pagehide", stopBinds);
  // Announce the app (initialize request); the host replies with the init result.
  parent.postMessage({ jsonrpc: "2.0", id: CAP.initId, method: "initialize", params: { protocolVersion: CAP.protocol, capabilities: {} } }, "*");
}

if (typeof window !== "undefined" && typeof document !== "undefined") boot();
