/**
 * Phase B — closed, PCC-owned render IR + adapter (read-only `/mcp/apps`).
 * Design + sol audits (R1-R5 folded): ai/research/pcc-genui-b-closed-ir-design.md. Spec §6.
 *
 * Projected DashboardManifest → a closed IR (strict subset of Atelier's UiTree).
 * Rules: PCC picks every node `type` (frozen catalog = EXACTLY what the adapter
 * emits) + rebuilds every prop from a closed grammar; STRICT REJECTION (never
 * strip/clamp/truncate) with exact own-key (`onlyKeys` over Reflect.ownKeys) at
 * every level; recursive prototype rejection; governed per-kind bindings pinned to
 * the REAL route table (exact end-anchored routes + reserved-collision guard +
 * selector/query grammar + SSE/path identity correlation); NO actions/capability
 * (inert ≠ safe) — effecting kinds render neutral; ALL manifest prose `untrusted`.
 * `validateIr` is an independent whole-tree oracle that MIRRORS every adapter
 * guarantee (same BIND_POLICY, same prop schemas, same parent/child grammar).
 * Runtime dependency-free (type-only import) → runnable via --experimental-strip-types.
 *
 * NOTE (projection follow-up): metric `format` is intentionally NOT accepted here
 * (§6.2 locked: PCC pre-formats the scalar, the IR omits `format`). The upstream
 * projection still preserves `format`; it should be updated to drop it. Until then
 * a metric window carrying `format` is rejected — the correct strict signal.
 */
import type { DashboardManifest } from "@pcc/spec";

// Frozen catalog = the EXACT set of node types the adapter emits (nothing more).
export const IR_NODE_TYPES = [
  "root", "section", "heading", "text", "stat", "card", "receipt", "list",
  "badge", "grid", "approval-notice", "plan", "form-summary", "field-label",
] as const;
export type IrNodeType = (typeof IR_NODE_TYPES)[number];
const FROZEN: ReadonlySet<string> = new Set(IR_NODE_TYPES);
export const BADGE_TONES = ["neutral", "info", "positive", "warning", "danger"] as const;
const TONE_SET: ReadonlySet<string> = new Set(BADGE_TONES);
const CARD_KINDS: ReadonlySet<string> = new Set(["capability", "run"]);
const GRID_KINDS: ReadonlySet<string> = new Set(["actions-readonly"]);
const PLAN_KINDS: ReadonlySet<string> = new Set(["composition"]);

const LIM = {
  sections: 24, windowsPerSection: 32, nodesTotal: 2000, depth: 8, inputDepth: 16,
  str: 2000, listRows: 200, fields: 64, metaItems: 12, queryKeys: 16,
  path: 512, select: 256, title: 400,
  pollMinMs: 5000, pollMaxMs: 3_600_000, boundWindowsTotal: 64, // poll-amplification cap (sol R5)
  cleanNodes: 50_000, // deepClean traversal budget — >> any legit manifest/IR, kills wide-object DoS (sol R6)
} as const;
// The ONE fixed PCC-owned approval sentence. B renders exactly this — never manifest prose.
const APPROVAL_NOTICE = "This action is confirmed only on the authenticated PCC surface.";

// ── Governed bindings — EXACT, end-anchored routes pinned to the REAL route table ──
// Deny-by-default. Each RegExp is a specific verified read endpoint.
const PATH_GRAMMAR = /^\/api\/[A-Za-z0-9._~\-/]+$/; // root-relative /api; no scheme/host/query/fragment/{}
const SSE_GRAMMAR = /^\/sse\/[A-Za-z0-9._~\-/]+$/;
const SELECT_GRAMMAR = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
const OP_ID_GRAMMAR = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/; // typed op id (discarded in B, still grammared)

// ── The collision defense (sol R3-R6): an ID_SEG is one path segment that is NOT a
// bare lowercase-alpha(-hyphen) word. PCC resource ids carry a DIGIT / underscore /
// uppercase / 0x-prefix (uuids, cap-1, kernel_x, 0x…); the collection/status/verb
// route NAMES that collide with a detail template — types, status, graph-stats,
// lit-status, submit, submit-from-discovery, … — are pure lowercase-alpha(-hyphen).
// So a `:` template matcher REJECTS THAT WHOLE CLASS by construction, robust to new
// sibling routes, instead of depending on a hand-maintained blocklist being complete.
const ID_SEG = "(?![a-z]+(?:-[a-z]+)*(?:/|$))[A-Za-z0-9_~.-]+";
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Compile a route template; ":" marks an ID_SEG. e.g. "/api/jobs/:/status". */
function route(template: string): RegExp {
  return new RegExp("^" + template.split("/").map((s) => (s === ":" ? ID_SEG : escRe(s))).join("/") + "$");
}
/** Same, but ":" becomes a CAPTURE group (for sse↔path id correlation). */
function routeCap(template: string): RegExp {
  return new RegExp("^" + template.split("/").map((s) => (s === ":" ? "(" + ID_SEG + ")" : escRe(s))).join("/") + "$");
}
// Secondary explicit denylist: the id-grammar above catches every pure-alpha sibling;
// this is belt-and-suspenders for any DIGIT-bearing reserved word the grammar can't
// (none currently) + a documented record of the known collisions found by sol.
const RESERVED_EXACT: ReadonlySet<string> = new Set([
  "/api/capabilities/types", "/api/capabilities/templates", "/api/capabilities/search",
  "/api/capabilities/graph-stats", "/api/capabilities/graph-search",
  "/api/settlement/status", "/api/settlement/epochs", "/api/settlement/flush",
  "/api/settlement/submit", "/api/settlement/release",
  "/api/evidence/lit-status", "/api/evidence/archive", "/api/evidence/embed", "/api/evidence/search",
  "/api/jobs/submit", "/api/jobs/submit-from-discovery",
  "/api/kernels/marketplace", "/api/kernels/register", "/api/escrow/chain",
]);
export type BindSchema = "capability-summary-v1" | "run-summary-v1";
interface BindPolicy {
  routes: RegExp[];
  needsSelect?: boolean;
  sse?: RegExp[];
  correlate?: { pathRe: RegExp; sseRe: RegExp };
  schema?: BindSchema;
}
const BIND_POLICY: Record<string, BindPolicy> = {
  // metric: object-returning read + a REQUIRED scalar `select` (else the whole object shows).
  // Only NON-money, non-settlement-timestamp scalar routes are allowed. REMOVED:
  //  - /api/settlement/:, /api/escrow/: (settlement/payment STATE → "Payment received");
  //  - /api/fiat-ramp/.../wallet/:/balance (an ARBITRARY address's usdc, no ownership → a
  //    manifest could label it "Payment received");
  //  - /api/jobs/:id detail (exposes updatedAt/completedAt-derived + escrow amounts → "Settled at").
  // jobs/:id/status + kernels/:id expose no money amount / settlement timestamp. The real
  // gate is the METRIC_SELECT_LABEL allowlist (PCC-owned label per allowlisted selector) — a
  // manifest can neither select a money/timestamp scalar NOR supply a payment/settlement label.
  metric: {
    routes: [route("/api/jobs/:/status"), route("/api/kernels/:")],
    needsSelect: true,
  },
  // capability card: a fixed PCC-owned SUMMARY (name/type/price/tiers/availability),
  // rendered from the KNOWN CapabilityDTO schema — the manifest supplies NO selectors.
  capability: { routes: [route("/api/capabilities/:")], schema: "capability-summary-v1" }, // ID_SEG excludes types/templates/search/graph-*
  // NOTE: `receipt` has NO bind policy — the settlement record is a STATIC POINTER (no
  // fetch). A public read GET cannot reach settlement (auth-gated) and, worse, the
  // endpoint reports `settled` for a merely-completed job and exposes the PHYSICAL
  // completion time as `settledAt` — so a fetched "Settled at" label would affirmatively
  // assert a settlement that never occurred. The authoritative receipt is the out-of-band
  // Surface-B signed receipt (VCR); B only points at it. (See the receipt case below.)
  list: { routes: [route("/api/jobs"), route("/api/kernels"), route("/api/capabilities"), route("/api/escrow")] },
  // run card: a fixed PCC-owned SUMMARY (status/progress) read from the KNOWN job
  // schema. The manifest's statusFrom/latestFrom are validated but IGNORED at render
  // (they may never relabel an arbitrary field as "Status" — PCC owns the meaning).
  run: {
    routes: [route("/api/jobs/:"), route("/api/jobs/:/status")],
    sse: [route("/sse/stream/job/:")],
    correlate: { pathRe: new RegExp("^/api/jobs/(" + ID_SEG + ")(?:/status)?$"), sseRe: routeCap("/sse/stream/job/:") },
    schema: "run-summary-v1",
  },
  // approval in B is a STATIC notice — no live bind (live approval state is C+D out-of-band).
};

export interface IrBind { path: string; select?: string; query?: Record<string, string | number | boolean>; pollMs?: number; sse?: string; schema?: BindSchema }
export interface IrNode { type: IrNodeType; id: string; props?: Record<string, string | number | boolean | string[]>; bind?: IrBind; children?: IrNode[]; untrusted?: true }
export interface IrDoc { ir: "pcc-dashboard-ir/v1"; title: IrNode; root: IrNode }
export type IrResult = { ok: true; doc: IrDoc } | { ok: false; reason: string };

// ── Safe primitives (REJECT, never strip) ────────────────────────────────────────
const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/** Plain object whose prototype is exactly Object.prototype or null (rejects
 * Object.create(evil), poisoned prototypes, class instances). */
function isPlain(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}
function strictStr(v: unknown, max: number = LIM.str): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}
/** Own-key allowlist over ALL own keys (enumerable + non-enumerable + symbol).
 * Rejects: any symbol own key, any string own key outside `allowed`, and any
 * NON-ENUMERABLE own key even with an allowed name (a hidden data-shaped prop). */
function onlyKeys(o: object, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  for (const k of Reflect.ownKeys(o)) {
    if (typeof k === "symbol") return false;
    if (!set.has(k)) return false;
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (!d || !d.enumerable) return false;
  }
  return true;
}
const INDEX_KEY = /^(0|[1-9][0-9]*)$/;
/** Recursively require plain objects/arrays/finite scalars and reject prototype /
 * symbol / non-enumerable / non-index own keys ANYWHERE (over Reflect.ownKeys).
 * BUDGETED: a shared node counter fails fast so a hostile wide/deep object cannot
 * force full traversal before rejection (browser-side validateIr availability). */
function deepClean(v: unknown, depth = 0, budget: { n: number } = { n: LIM.cleanNodes }): boolean {
  if (depth > LIM.inputDepth) return false;
  if (--budget.n < 0) return false;
  const t = typeof v;
  if (v === null || t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(v as number);
  if (Array.isArray(v)) {
    for (const k of Reflect.ownKeys(v)) { // reject symbol / extra / non-index own keys on the array itself
      if (typeof k === "symbol") return false;
      if (k !== "length" && !INDEX_KEY.test(k)) return false;
    }
    for (const e of v) if (!deepClean(e, depth + 1, budget)) return false;
    return true;
  }
  if (!isPlain(v)) return false;
  for (const k of Reflect.ownKeys(v)) {
    if (typeof k === "symbol" || PROTO_KEYS.has(k)) return false;
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d || !d.enumerable) return false;
    if (!deepClean((v as Record<string, unknown>)[k], depth + 1, budget)) return false;
  }
  return true;
}
/** Dotted selector with NO prototype segment. */
function isSelector(s: unknown): s is string {
  if (typeof s !== "string" || !SELECT_GRAMMAR.test(s) || s.length > LIM.select) return false;
  for (const seg of s.split(".")) if (PROTO_KEYS.has(seg)) return false;
  return true;
}
/** Read path: grammar + no `..` and no single-dot segment. */
function isReadPath(s: unknown, grammar: RegExp = PATH_GRAMMAR): s is string {
  if (typeof s !== "string" || !grammar.test(s) || s.length > LIM.path) return false;
  for (const seg of s.split("/")) if (seg === ".." || seg === ".") return false;
  return true;
}
// Credential-named field DETECTION (normalized: lowercase, strip separators) — for
// form field labels. Exact-match set avoids "author"/"shipping" false positives;
// the short substring set catches compounds (userPassword, client_secret).
const CRED_EXACT: ReadonlySet<string> = new Set([
  "password", "secret", "token", "credential", "apikey", "privatekey", "authorization",
  "bearer", "accesstoken", "refreshtoken", "clientsecret", "sessiontoken", "otp", "cvv",
  "pin", "mnemonic", "seedphrase", "passphrase", "privkey", "signingkey",
]);
const CRED_SUBSTR = ["password", "secret", "privatekey", "apikey", "credential", "passphrase"];
function isCredentialName(k: string): boolean {
  const n = k.toLowerCase().replace(/[_\-\s]/g, "");
  if (CRED_EXACT.has(n)) return true;
  return CRED_SUBSTR.some((t) => n.includes(t));
}
// PCC-OWNED metric labels (sol finding 3 durable fix). A metric renders a scalar under a
// LABEL; PCC must own that label so a manifest can never frame a scalar as a payment or a
// settlement ("Payment received", "Funds received at", "Settled at"). Metric may bind ONLY
// these selectors, each with a FIXED PCC label; the manifest's `label` is ACCEPTED but
// IGNORED (the label is derived here). None of these is a money amount or a settlement/
// heartbeat timestamp, so a manifest can neither assert money/settlement framing NOR select a
// money/timestamp scalar (e.g. usdc, lastHeartbeat, updatedAt are not selectable). A closed
// (selector → label) map beats a denylist (which leaks: "Disbursement time", "Credited at").
// validateIr MIRRORS this exactly (stat.props.label must equal the map value for bind.select).
const METRIC_SELECT_LABEL: Record<string, string> = {
  status: "Status",
  progress: "Progress",
  reputation: "Reputation",
  uptimePercent: "Uptime",
  capabilityCount: "Capabilities",
  totalJobsCompleted: "Jobs completed",
  activeJobCount: "Active jobs",
};
const isMetricSelector = (s: unknown): s is string => typeof s === "string" && Object.prototype.hasOwnProperty.call(METRIC_SELECT_LABEL, s);
/** Closed typed-op descriptor grammar (submit/execute/approve/deny/action). Its
 * content is DISCARDED in B, but a malformed shape is REJECTED, never stripped. */
function isOpDescriptor(v: unknown): boolean {
  if (!isPlain(v) || !onlyKeys(v, ["id", "label", "confirm", "intentText", "operation_id", "arguments"])) return false;
  if (v.operation_id !== undefined && (typeof v.operation_id !== "string" || !OP_ID_GRAMMAR.test(v.operation_id))) return false;
  if (v.id !== undefined && strictStr(v.id, LIM.title) === null) return false;
  if (v.label !== undefined && strictStr(v.label, LIM.title) === null) return false;
  if (v.intentText !== undefined && strictStr(v.intentText, LIM.str) === null) return false;
  // Real Action.confirm is the enum "inline"|"approval" (spec/ui-artifact.ts), NOT boolean.
  if (v.confirm !== undefined && v.confirm !== "inline" && v.confirm !== "approval") return false;
  if (v.arguments !== undefined && !isPlain(v.arguments)) return false; // deepClean already ran
  return true;
}

// ── Shared bind gate — the ONE policy check both adapter and validator call ────────
function bindMatchesPolicy(bind: IrBind, key: string): string | null {
  const policy = BIND_POLICY[key];
  if (!policy) return `no bind policy for ${key}`;
  if (!isReadPath(bind.path)) return "bind.path grammar";
  if (RESERVED_EXACT.has(bind.path)) return "bind.path is a reserved/collection route";
  if (!policy.routes.some((re) => re.test(bind.path))) return `bind.path outside ${key} allowlist`;
  if (bind.select !== undefined && !isSelector(bind.select)) return "bind.select grammar";
  if (policy.needsSelect && bind.select === undefined) return `${key} requires a scalar select`;
  if (!policy.needsSelect && bind.select !== undefined) return `${key} may not select`;
  if (bind.query !== undefined) {
    if (!isPlain(bind.query) || Object.keys(bind.query).length > LIM.queryKeys) return "bind.query shape";
    for (const [k, v] of Object.entries(bind.query)) {
      if (!isSelector(k)) return "query key grammar";
      const t = typeof v;
      if (!(t === "string" && (v as string).length <= LIM.str) && t !== "boolean" && !(t === "number" && Number.isFinite(v))) return "query value type";
    }
  }
  if (bind.pollMs !== undefined && (typeof bind.pollMs !== "number" || !Number.isFinite(bind.pollMs) || bind.pollMs < LIM.pollMinMs || bind.pollMs > LIM.pollMaxMs)) return "bind.pollMs range";
  if (bind.sse !== undefined) {
    if (!policy.sse) return `${key} may not stream`;
    if (!isReadPath(bind.sse, SSE_GRAMMAR) || !policy.sse.some((re) => re.test(bind.sse as string))) return "bind.sse outside allowlist";
    if (policy.correlate) {
      const mp = policy.correlate.pathRe.exec(bind.path);
      const ms = policy.correlate.sseRe.exec(bind.sse);
      if (!mp || !ms || mp[1] !== ms[1]) return "sse/path identity mismatch";
    }
  }
  if (policy.schema) { if (bind.schema !== policy.schema) return `bind.schema must be ${policy.schema}`; }
  else if (bind.schema !== undefined) return "unexpected bind.schema";
  return null;
}

// ── The adapter ─────────────────────────────────────────────────────────────────
export function dashboardManifestToIr(m: DashboardManifest | null | undefined): IrResult {
  if (!isPlain(m)) return { ok: false, reason: "manifest not a plain object" };
  if (!deepClean(m)) return { ok: false, reason: "prototype/nonfinite/symbol in manifest" };
  const mm = m as Record<string, unknown>;
  if (!onlyKeys(mm, ["csd", "title", "description", "theme", "sections"])) return { ok: false, reason: "unexpected top-level key" };
  const title = strictStr(mm.title, LIM.title);
  if (title === null) return { ok: false, reason: "title invalid" };
  if (!Array.isArray(mm.sections)) return { ok: false, reason: "sections not array" };
  if (mm.sections.length > LIM.sections) return { ok: false, reason: "too many sections" };

  let count = 0;
  const budget = (): boolean => ++count <= LIM.nodesTotal;
  let bindCount = 0;
  const bindBudget = (): boolean => ++bindCount <= LIM.boundWindowsTotal; // aggregate poll-amplification cap
  const nextId = (() => { let n = 0; return () => `n${++n}`; })();

  const sectionNodes: IrNode[] = [];
  for (const secRaw of mm.sections) {
    if (!isPlain(secRaw) || !onlyKeys(secRaw, ["heading", "windows"])) return { ok: false, reason: "bad section" };
    if (!Array.isArray(secRaw.windows)) return { ok: false, reason: "section.windows not array" };
    if (secRaw.windows.length > LIM.windowsPerSection) return { ok: false, reason: "too many windows" };
    const children: IrNode[] = [];
    if (secRaw.heading !== undefined) {
      const h = strictStr(secRaw.heading, LIM.title);
      if (h === null) return { ok: false, reason: "section.heading invalid" };
      if (!budget()) return { ok: false, reason: "node budget" };
      children.push({ type: "heading", id: nextId(), props: { level: 2, text: h }, untrusted: true });
    }
    for (const w of secRaw.windows) { const r = mapWindow(w, nextId, budget, bindBudget); if (!r.ok) return r; children.push(r.node); }
    if (!budget()) return { ok: false, reason: "node budget" };
    sectionNodes.push({ type: "section", id: nextId(), children });
  }
  if (!budget()) return { ok: false, reason: "node budget" };
  const titleNode: IrNode = { type: "heading", id: nextId(), props: { level: 1, text: title }, untrusted: true };
  if (!budget()) return { ok: false, reason: "node budget" };
  return { ok: true, doc: { ir: "pcc-dashboard-ir/v1", title: titleNode, root: { type: "root", id: nextId(), children: sectionNodes } } };
}

type MapResult = { ok: true; node: IrNode } | { ok: false; reason: string };

function mapWindow(w: unknown, nextId: () => string, budget: () => boolean, bindBudget: () => boolean): MapResult {
  if (!budget()) return { ok: false, reason: "node budget" };
  if (!isPlain(w)) return { ok: false, reason: "window not plain object" };
  const kind = w.kind;
  if (typeof kind !== "string") return { ok: false, reason: "window.kind missing" };
  const id = nextId();
  const chargeBind = (): boolean => bindBudget(); // every window that emits a live bind charges the poll budget
  switch (kind) {
    case "note":
      if (!onlyKeys(w, ["kind", "text"])) return { ok: false, reason: "note extra key" };
      { const text = strictStr(w.text); if (text === null) return { ok: false, reason: "note.text" };
        return { ok: true, node: { type: "text", id, props: { text }, untrusted: true } }; }
    case "metric":
      // `format` intentionally NOT accepted (see file header). select is top-level + required.
      if (!onlyKeys(w, ["kind", "label", "binding", "select"])) return { ok: false, reason: "metric extra key" };
      { // The manifest `label` is ACCEPTED but IGNORED — PCC OWNS the metric label, derived
        // from the allowlisted selector. Only known infra/execution selectors are bindable, so
        // no money amount or settlement/heartbeat timestamp is even selectable. `format` NOT accepted.
        if (!isMetricSelector(w.select)) return { ok: false, reason: "metric.select not an allowlisted metric field" };
        const label = METRIC_SELECT_LABEL[w.select]; // PCC-owned; manifest w.label ignored
        const b = mapBind(w.binding, "metric", w.select); if (!b.ok) return b;
        if (!chargeBind()) return { ok: false, reason: "bound-window budget" };
        return { ok: true, node: { type: "stat", id, props: { label }, bind: b.bind } }; } // PCC-owned label → NOT untrusted
    case "capability":
      if (!onlyKeys(w, ["kind", "binding"])) return { ok: false, reason: "capability extra key" };
      { const b = mapBind(w.binding, "capability"); if (!b.ok) return b;
        if (!chargeBind()) return { ok: false, reason: "bound-window budget" };
        return { ok: true, node: { type: "card", id, props: { kind: "capability" }, bind: b.bind } }; }
    case "receipt":
      // STATIC settlement-record POINTER — no live bind (accepts + ignores a binding, like
      // `approval`). A public read GET can neither reach settlement (auth-gated) nor prove a
      // job status is a settlement event; the endpoint even reports `settled` for a merely
      // completed job and exposes the PHYSICAL completion time as `settledAt`. So B renders
      // ONLY the fixed read-only heading + "not proof of payment" pointer to the
      // authoritative out-of-band Surface-B signed receipt — no fetched, mislabellable data.
      if (!onlyKeys(w, ["kind", "binding"])) return { ok: false, reason: "receipt extra key" };
      if (w.binding !== undefined && !isPlain(w.binding)) return { ok: false, reason: "receipt.binding shape" };
      return { ok: true, node: { type: "receipt", id } };
    case "list":
      if (!onlyKeys(w, ["kind", "binding", "item", "limit"])) return { ok: false, reason: "list extra key" };
      { const b = mapBind(w.binding, "list"); if (!b.ok) return b;
        if (!chargeBind()) return { ok: false, reason: "bound-window budget" };
        const item = w.item;
        if (!isPlain(item) || !onlyKeys(item, ["title", "meta", "statusFrom"])) return { ok: false, reason: "list.item" };
        if (!isSelector(item.title)) return { ok: false, reason: "list.item.title selector" };
        const rowMeta: string[] = [];
        if (item.meta !== undefined) {
          if (!Array.isArray(item.meta) || item.meta.length > LIM.metaItems) return { ok: false, reason: "list.meta" };
          for (const mi of item.meta) { if (!isSelector(mi)) return { ok: false, reason: "list.meta selector" }; rowMeta.push(mi); }
        }
        const props: IrNode["props"] = { rowTitle: item.title, rowMeta };
        if (item.statusFrom !== undefined) { if (!isSelector(item.statusFrom)) return { ok: false, reason: "list.statusFrom selector" }; props.statusFrom = item.statusFrom; }
        if (w.limit !== undefined) { if (typeof w.limit !== "number" || !Number.isInteger(w.limit) || w.limit <= 0 || w.limit > LIM.listRows) return { ok: false, reason: "list.limit" }; props.limit = w.limit; }
        return { ok: true, node: { type: "list", id, bind: b.bind, props } }; }
    case "run":
      if (!onlyKeys(w, ["kind", "binding", "statusFrom", "latestFrom"])) return { ok: false, reason: "run extra key" };
      { const b = mapBind(w.binding, "run"); if (!b.ok) return b;
        if (!chargeBind()) return { ok: false, reason: "bound-window budget" };
        if (!isSelector(w.statusFrom) || !isSelector(w.latestFrom)) return { ok: false, reason: "run selectors" };
        return { ok: true, node: { type: "card", id, props: { kind: "run", statusFrom: w.statusFrom, latestFrom: w.latestFrom }, bind: b.bind } }; }
    case "form":
      if (!onlyKeys(w, ["kind", "schema", "submit"])) return { ok: false, reason: "form extra key" };
      if (w.submit !== undefined && !isOpDescriptor(w.submit)) return { ok: false, reason: "form.submit grammar" };
      { const labels = fieldLabels(w.schema); if (!labels.ok) return labels;
        const children: IrNode[] = [];
        for (const l of labels.labels) { if (!budget()) return { ok: false, reason: "node budget" }; children.push({ type: "field-label", id: nextId(), props: { label: l }, untrusted: true }); }
        return { ok: true, node: { type: "form-summary", id, children } }; }
    case "approval":
      if (!onlyKeys(w, ["kind", "binding", "approve", "deny"])) return { ok: false, reason: "approval extra key" };
      if (w.approve !== undefined && !isOpDescriptor(w.approve)) return { ok: false, reason: "approval.approve grammar" };
      if (w.deny !== undefined && !isOpDescriptor(w.deny)) return { ok: false, reason: "approval.deny grammar" };
      if (w.binding !== undefined && !isPlain(w.binding)) return { ok: false, reason: "approval.binding shape" };
      // Static notice, NO bind — live approval state is the C+D out-of-band surface.
      return { ok: true, node: { type: "approval-notice", id, props: { notice: APPROVAL_NOTICE } } };
    case "chain":
      if (!onlyKeys(w, ["kind", "composeRef", "execute"])) return { ok: false, reason: "chain extra key" };
      if (!isPlain(w.composeRef)) return { ok: false, reason: "chain.composeRef shape" };
      if (w.execute !== undefined && !isOpDescriptor(w.execute)) return { ok: false, reason: "chain.execute grammar" };
      return { ok: true, node: { type: "plan", id, props: { kind: "composition" } } };
    case "actions":
      if (!onlyKeys(w, ["kind", "actions"])) return { ok: false, reason: "actions extra key" };
      { const acts = w.actions;
        if (!Array.isArray(acts) || acts.length === 0 || acts.length > LIM.fields) return { ok: false, reason: "actions" };
        const children: IrNode[] = [];
        for (const a of acts) {
          if (!budget()) return { ok: false, reason: "node budget" };
          if (!isOpDescriptor(a)) return { ok: false, reason: "action grammar" };
          const label = strictStr((a as Record<string, unknown>).label, LIM.title); if (label === null) return { ok: false, reason: "action.label" };
          children.push({ type: "badge", id: nextId(), props: { text: label, tone: "neutral" }, untrusted: true });
        }
        return { ok: true, node: { type: "grid", id, props: { kind: "actions-readonly" }, children } }; }
    default:
      return { ok: false, reason: `unknown window kind: ${kind}` };
  }
}

function mapBind(b: unknown, key: string, topSelect?: unknown): { ok: true; bind: IrBind } | { ok: false; reason: string } {
  const policy = BIND_POLICY[key];
  if (!policy) return { ok: false, reason: `no bind policy for ${key}` };
  const allowed = policy.sse ? ["path", "query", "pollMs", "sse"] : ["path", "query", "pollMs"];
  if (!isPlain(b) || !onlyKeys(b, allowed)) return { ok: false, reason: "binding shape" };
  const bind: IrBind = { path: b.path as string };
  if (topSelect !== undefined) bind.select = topSelect as string; // metric scalar (validated by caller + policy)
  if (b.sse !== undefined) bind.sse = b.sse as string;
  if (b.pollMs !== undefined) bind.pollMs = b.pollMs as number;
  if (b.query !== undefined) {
    if (!isPlain(b.query)) return { ok: false, reason: "binding.query shape" };
    const q: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(b.query)) { if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return { ok: false, reason: "query value type" }; q[k] = v; }
    bind.query = q;
  }
  if (policy.schema) bind.schema = policy.schema;
  const reason = bindMatchesPolicy(bind, key);
  return reason ? { ok: false, reason } : { ok: true, bind };
}

/** Read-only field LABELS from a projected form schema — closed field grammar. */
function fieldLabels(schema: unknown): { ok: true; labels: string[] } | { ok: false; reason: string } {
  if (!isPlain(schema) || !onlyKeys(schema, ["type", "properties", "required"])) return { ok: false, reason: "form.schema shape" };
  if (schema.type !== undefined && schema.type !== "object") return { ok: false, reason: "form.schema.type" };
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((x) => typeof x === "string"))) return { ok: false, reason: "form.schema.required" };
  const props = schema.properties;
  if (!isPlain(props)) return { ok: false, reason: "form.schema.properties" };
  const keys = Object.keys(props);
  if (keys.length > LIM.fields) return { ok: false, reason: "too many fields" };
  const labels: string[] = [];
  for (const key of keys) {
    if (PROTO_KEYS.has(key) || isCredentialName(key)) return { ok: false, reason: "credential/proto field" };
    const def = (props as Record<string, unknown>)[key];
    if (!isPlain(def) || !onlyKeys(def, ["type", "title", "description", "enum", "format", "minimum", "maximum", "minLength", "maxLength"])) return { ok: false, reason: "form field-def shape" };
    if (def.type !== undefined && !["string", "number", "integer", "boolean"].includes(String(def.type))) return { ok: false, reason: "form field type" };
    if (def.title !== undefined && strictStr(def.title, LIM.title) === null) return { ok: false, reason: "form field title" };
    const rawLabel = typeof def.title === "string" ? def.title : key;
    const s = strictStr(rawLabel, LIM.title); if (s === null) return { ok: false, reason: "field label" };
    labels.push(s);
  }
  return { ok: true, labels };
}

// ── Independent whole-tree validator — MIRRORS every adapter guarantee ─────────────
type PropT = "s400" | "s2000" | "number" | "limit" | "boolean" | "string[]" | "level" | "tone" | "card-kind" | "grid-kind" | "plan-kind" | "selector";
type PropSpec = Record<string, PropT>;
interface NodeSpec { props?: PropSpec; required?: readonly string[]; optional?: readonly string[]; bindKey?: string; needsBind?: boolean; noBind?: boolean; prose?: boolean; parentOf?: readonly IrNodeType[]; childless?: boolean; minChildren?: number; maxChildren?: number }
const NODE_SCHEMA: Record<IrNodeType, NodeSpec> = {
  root: { noBind: true, parentOf: ["section"], maxChildren: LIM.sections },
  section: { noBind: true, parentOf: ["heading", "text", "stat", "card", "receipt", "list", "grid", "approval-notice", "plan", "form-summary"] },
  heading: { props: { level: "level", text: "s400" }, required: ["level", "text"], noBind: true, prose: true, childless: true },
  text: { props: { text: "s2000" }, required: ["text"], noBind: true, prose: true, childless: true },
  stat: { props: { label: "s400" }, required: ["label"], bindKey: "metric", needsBind: true, childless: true }, // label is PCC-owned (not prose) — mirrored below
  card: { props: { kind: "card-kind", statusFrom: "selector", latestFrom: "selector" }, required: ["kind"], optional: ["statusFrom", "latestFrom"], bindKey: "capability", needsBind: true, childless: true },
  receipt: { noBind: true, childless: true }, // STATIC settlement-record pointer — no bind, no props, no children
  list: { props: { rowTitle: "selector", rowMeta: "string[]", statusFrom: "selector", limit: "limit" }, required: ["rowTitle", "rowMeta"], optional: ["statusFrom", "limit"], bindKey: "list", needsBind: true, childless: true },
  badge: { props: { text: "s400", tone: "tone" }, required: ["text", "tone"], noBind: true, prose: true, childless: true },
  grid: { props: { kind: "grid-kind" }, required: ["kind"], noBind: true, parentOf: ["badge"], minChildren: 1, maxChildren: LIM.fields },
  "approval-notice": { props: { notice: "s2000" }, required: ["notice"], noBind: true, childless: true },
  plan: { props: { kind: "plan-kind" }, required: ["kind"], noBind: true, childless: true },
  "form-summary": { noBind: true, parentOf: ["field-label"], maxChildren: LIM.fields },
  "field-label": { props: { label: "s400" }, required: ["label"], noBind: true, prose: true, childless: true },
};
function propType(v: unknown, t: PropT): boolean {
  switch (t) {
    case "s400": return typeof v === "string" && v.length > 0 && v.length <= LIM.title;
    case "s2000": return typeof v === "string" && v.length > 0 && v.length <= LIM.str;
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "limit": return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= LIM.listRows;
    case "boolean": return typeof v === "boolean";
    case "string[]": return Array.isArray(v) && v.length <= LIM.metaItems && v.every((x) => isSelector(x));
    case "level": return v === 1 || v === 2 || v === 3;
    case "tone": return typeof v === "string" && TONE_SET.has(v);
    case "card-kind": return typeof v === "string" && CARD_KINDS.has(v);
    case "grid-kind": return typeof v === "string" && GRID_KINDS.has(v);
    case "plan-kind": return typeof v === "string" && PLAN_KINDS.has(v);
    case "selector": return isSelector(v);
  }
}
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
export function validateIr(doc: unknown): { ok: true } | { ok: false; reason: string } {
  if (!isPlain(doc) || doc.ir !== "pcc-dashboard-ir/v1" || !onlyKeys(doc, ["ir", "title", "root"])) return { ok: false, reason: "not an IR doc" };
  if (!deepClean(doc)) return { ok: false, reason: "proto/nonfinite/symbol in IR" };
  if (!isPlain(doc.title) || (doc.title as Record<string, unknown>).type !== "heading" || (doc.title as any).props?.level !== 1) return { ok: false, reason: "doc.title not H1" };
  if (!isPlain(doc.root) || (doc.root as Record<string, unknown>).type !== "root") return { ok: false, reason: "doc.root not root" };
  const ids = new Set<string>();
  let count = 0;
  let bindCount = 0;
  const walk = (n: unknown, depth: number): string | null => {
    if (depth > LIM.depth) return "depth";
    if (++count > LIM.nodesTotal) return "node count";
    if (!isPlain(n)) return "node not plain";
    if (!onlyKeys(n, ["type", "id", "props", "bind", "children", "untrusted"])) return "unexpected node key";
    if (typeof n.type !== "string" || !FROZEN.has(n.type)) return `type not frozen: ${String(n.type)}`;
    if (typeof n.id !== "string" || !/^n[0-9]+$/.test(n.id) || ids.has(n.id)) return "id format/dup";
    ids.add(n.id);
    const spec = NODE_SCHEMA[n.type as IrNodeType];
    // props: exact keys, exact types, required present via own-property
    if (n.props !== undefined) {
      if (!isPlain(n.props) || !onlyKeys(n.props, Object.keys(spec.props ?? {}))) return `props off-schema for ${n.type}`;
      for (const [k, v] of Object.entries(n.props)) if (!propType(v, (spec.props as PropSpec)[k])) return `prop ${k} wrong type on ${n.type}`;
    }
    for (const req of spec.required ?? []) if (!n.props || !hasOwn(n.props as object, req)) return `missing prop ${req} on ${n.type}`;
    // approval-notice text is the ONE fixed PCC sentence — never manifest prose
    if (n.type === "approval-notice" && (n.props as any)?.notice !== APPROVAL_NOTICE) return "approval-notice text not the fixed PCC sentence";
    // card kind ⇒ exact companion props
    if (n.type === "card") {
      const k = (n.props as any)?.kind;
      if (k === "run") { if (!hasOwn(n.props as object, "statusFrom") || !hasOwn(n.props as object, "latestFrom")) return "run card missing selectors"; }
      else if (hasOwn((n.props ?? {}) as object, "statusFrom") || hasOwn((n.props ?? {}) as object, "latestFrom")) return "capability card has run props";
    }
    // bind: mirror BIND_POLICY exactly
    if (n.bind !== undefined) {
      if (spec.noBind || !spec.bindKey) return `${n.type} must not bind`;
      if (!isPlain(n.bind) || !onlyKeys(n.bind, ["path", "select", "query", "pollMs", "sse", "schema"])) return "bind shape";
      const bk = n.type === "card" ? ((n.props as any).kind === "run" ? "run" : "capability") : spec.bindKey;
      const reason = bindMatchesPolicy(n.bind as unknown as IrBind, bk); if (reason) return `bind: ${reason}`;
      if (++bindCount > LIM.boundWindowsTotal) return "bound-window budget"; // poll-amplification cap (mirrors adapter)
    } else if (spec.needsBind) return `${n.type} requires a bind`;
    // stat (metric) label is PCC-OWNED — must equal the fixed label for its ALLOWLISTED
    // selector (mirror of the adapter; a directly-constructed IR cannot invent a label like
    // "Payment received" or select a non-allowlisted / money / timestamp scalar).
    if (n.type === "stat") {
      const sel = (n.bind as { select?: unknown } | undefined)?.select;
      if (typeof sel !== "string" || !hasOwn(METRIC_SELECT_LABEL, sel)) return "stat select not an allowlisted metric field";
      if ((n.props as { label?: unknown } | undefined)?.label !== METRIC_SELECT_LABEL[sel]) return "stat label is not the PCC-owned label for its selector";
    }
    // prose provenance
    if (spec.prose && n.untrusted !== true) return `prose ${n.type} not untrusted`;
    if (!spec.prose && n.untrusted !== undefined) return `non-prose ${n.type} marked untrusted`;
    // children: exact parent/child grammar; containers require an array, leaves forbid it
    if (spec.childless) { if (n.children !== undefined) return `${n.type} may not have children`; }
    else {
      if (!Array.isArray(n.children)) return `${n.type} requires children array`;
      if (spec.minChildren !== undefined && n.children.length < spec.minChildren) return `${n.type} too few children`;
      if (spec.maxChildren !== undefined && n.children.length > spec.maxChildren) return `${n.type} too many children`;
      let windowKids = 0;
      for (let i = 0; i < n.children.length; i++) {
        const c = n.children[i];
        if (!isPlain(c) || !spec.parentOf || !spec.parentOf.includes((c as Record<string, unknown>).type as IrNodeType)) return `illegal child under ${n.type}`;
        if (n.type === "section") { // ≤1 heading, only at index 0, H2; the rest are windows (≤ cap)
          const ct = (c as Record<string, unknown>).type;
          if (ct === "heading") { if (i !== 0) return "section heading must be first"; if ((c as any).props?.level !== 2) return "section heading must be H2"; }
          else if (++windowKids > LIM.windowsPerSection) return "too many windows in section";
        }
        const e = walk(c, depth + 1); if (e) return e;
      }
    }
    return null;
  };
  const e1 = walk(doc.title, 0); if (e1) return { ok: false, reason: `title: ${e1}` };
  const e2 = walk(doc.root, 0); return e2 ? { ok: false, reason: e2 } : { ok: true };
}
