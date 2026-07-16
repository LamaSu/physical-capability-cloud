/**
 * Phase B — closed, PCC-owned render IR + adapter (read-only `/mcp/apps`).
 * Design + sol audits (R1-R3 folded): ai/research/pcc-genui-b-closed-ir-design.md. Spec §6.
 *
 * Projected DashboardManifest → a closed IR (strict subset of Atelier's UiTree).
 * Rules: PCC picks every node `type` (frozen catalog) + rebuilds every prop from a
 * closed grammar; STRICT REJECTION (never strip/clamp/truncate) with exact-key
 * (`onlyKeys`) at every level; recursive prototype rejection; governed per-kind
 * bindings (exact route family + selector/query grammar; end-anchored); NO
 * actions/capability (inert ≠ safe); effecting kinds render neutral; ALL manifest
 * prose marked `untrusted`. Fails closed on anything unexpected. The independent
 * `validateIr` mirrors these guarantees. Runtime dependency-free (type-only import).
 */
import type { DashboardManifest } from "@pcc/spec";

export const IR_NODE_TYPES = [
  "root", "section", "card", "grid", "text", "heading", "stat", "badge",
  "list", "progress", "divider", "receipt", "approval-notice", "plan",
  "form-summary", "field-label",
] as const;
export type IrNodeType = (typeof IR_NODE_TYPES)[number];
const FROZEN: ReadonlySet<string> = new Set(IR_NODE_TYPES);
export const BADGE_TONES = ["neutral", "info", "positive", "warning", "danger"] as const;
const TONE_SET: ReadonlySet<string> = new Set(BADGE_TONES);

const LIM = {
  sections: 24, windowsPerSection: 32, nodesTotal: 2000, depth: 6, inputDepth: 16,
  str: 2000, listRows: 200, fields: 64, metaItems: 12, queryKeys: 16,
  path: 512, select: 256, title: 400,
} as const;

// ── Governed bindings — EXACT, end-anchored per-kind route allowlist ──────────────
// Deny-by-default. Every route is a specific read endpoint (see the API guide). This
// list is the security-critical surface — review before widening. sole `sse` for the
// live streams; other kinds poll.
const PATH_GRAMMAR = /^\/api\/[A-Za-z0-9._~\-/]+$/; // root-relative /api; no scheme/host/query/fragment/{}
const SSE_GRAMMAR = /^\/sse\/[A-Za-z0-9._~\-/]+$/;
const SELECT_GRAMMAR = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
type BindSchema = "receipt" | "approval-state";
interface BindPolicy { routes: RegExp[]; sse?: RegExp[]; schema?: BindSchema }
const BIND_POLICY: Record<string, BindPolicy> = {
  // metric binds one object-returning read route + `select`s a scalar.
  metric: { routes: [
    /^\/api\/fiat-ramp\/wallet\/balance$/, /^\/api\/jobs\/[^/]+$/, /^\/api\/kernels\/[^/]+$/,
    /^\/api\/escrow\/[^/]+$/, /^\/api\/settlement\/status$/, /^\/api\/pool\/[^/]+$/,
  ] },
  capability: { routes: [/^\/api\/capabilities\/(?!types$|templates$|search$|by-kernel|by-type)[^/]+$/] },
  receipt: { routes: [
    /^\/api\/jobs\/[^/]+\/settlement$/, /^\/api\/jobs\/[^/]+\/evidence$/,
    /^\/api\/settlement\/[^/]+$/, /^\/api\/compliance\/evidence\/[^/]+$/,
  ], schema: "receipt" },
  list: { routes: [
    /^\/api\/jobs$/, /^\/api\/kernels$/, /^\/api\/capabilities$/, /^\/api\/escrow$/,
    /^\/api\/protocols$/, /^\/api\/settlement\/epochs$/, /^\/api\/marketplace\/listings$/,
  ] },
  run: { routes: [/^\/api\/jobs\/[^/]+$/, /^\/api\/jobs\/[^/]+\/status$/], sse: [/^\/sse\/stream\/job\/[^/]+$/] },
  // approval in B is a STATIC notice — no live bind (live approval state is C+D out-of-band).
};

export interface IrBind { path: string; select?: string; query?: Record<string, string | number | boolean>; pollMs?: number; sse?: string; schema?: BindSchema }
export interface IrNode { type: IrNodeType; id: string; props?: Record<string, string | number | boolean | string[]>; bind?: IrBind; children?: IrNode[]; untrusted?: true }
export interface IrDoc { ir: "pcc-dashboard-ir/v1"; title: IrNode; root: IrNode }
export type IrResult = { ok: true; doc: IrDoc } | { ok: false; reason: string };

// ── Safe primitives (REJECT, never strip) ────────────────────────────────────────
const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/** A plain object whose prototype is exactly Object.prototype or null (rejects
 * Object.create(evil), poisoned prototypes, class instances). */
function isPlain(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}
function strictStr(v: unknown, max = LIM.str): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}
function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  for (const k of Object.keys(o)) if (!set.has(k)) return false;
  return true;
}
/** Recursively require plain objects/arrays/scalars and reject prototype keys anywhere. */
function deepClean(v: unknown, depth = 0): boolean {
  if (depth > LIM.inputDepth) return false;
  const t = typeof v;
  if (v === null || t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(v as number);
  if (Array.isArray(v)) { for (const e of v) if (!deepClean(e, depth + 1)) return false; return true; }
  if (!isPlain(v)) return false;
  for (const k of Object.keys(v)) { if (PROTO_KEYS.has(k)) return false; if (!deepClean((v as Record<string, unknown>)[k], depth + 1)) return false; }
  return true;
}
/** A dotted selector with NO prototype segment. */
function isSelector(s: string): boolean {
  if (!SELECT_GRAMMAR.test(s) || s.length > LIM.select) return false;
  for (const seg of s.split(".")) if (PROTO_KEYS.has(seg)) return false;
  return true;
}
/** A read path: grammar + no `..` + no single-dot segment. */
function isReadPath(s: string, grammar = PATH_GRAMMAR): boolean {
  if (!grammar.test(s) || s.length > LIM.path) return false;
  for (const seg of s.split("/")) if (seg === ".." || seg === ".") return false;
  return true;
}

// ── The adapter ─────────────────────────────────────────────────────────────────
export function dashboardManifestToIr(m: DashboardManifest | null | undefined): IrResult {
  if (!isPlain(m)) return { ok: false, reason: "manifest not a plain object" };
  if (!deepClean(m)) return { ok: false, reason: "prototype/nonfinite in manifest" };
  const mm = m as Record<string, unknown>;
  if (!onlyKeys(mm, ["csd", "title", "description", "theme", "sections"])) return { ok: false, reason: "unexpected top-level key" };
  const title = strictStr(mm.title, LIM.title);
  if (title === null) return { ok: false, reason: "title invalid" };
  if (!Array.isArray(mm.sections)) return { ok: false, reason: "sections not array" };
  if (mm.sections.length > LIM.sections) return { ok: false, reason: "too many sections" };

  let count = 0;
  const budget = (): boolean => ++count <= LIM.nodesTotal;
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
    for (const w of secRaw.windows) { const r = mapWindow(w, nextId, budget); if (!r.ok) return r; children.push(r.node); }
    if (!budget()) return { ok: false, reason: "node budget" };
    sectionNodes.push({ type: "section", id: nextId(), children });
  }
  if (!budget()) return { ok: false, reason: "node budget" };
  const titleNode: IrNode = { type: "heading", id: nextId(), props: { level: 1, text: title }, untrusted: true };
  if (!budget()) return { ok: false, reason: "node budget" };
  return { ok: true, doc: { ir: "pcc-dashboard-ir/v1", title: titleNode, root: { type: "root", id: nextId(), children: sectionNodes } } };
}

type MapResult = { ok: true; node: IrNode } | { ok: false; reason: string };

function mapWindow(w: unknown, nextId: () => string, budget: () => boolean): MapResult {
  if (!budget()) return { ok: false, reason: "node budget" };
  if (!isPlain(w)) return { ok: false, reason: "window not plain object" };
  const kind = w.kind;
  if (typeof kind !== "string") return { ok: false, reason: "window.kind missing" };
  const id = nextId();
  switch (kind) {
    case "note":
      if (!onlyKeys(w, ["kind", "text"])) return { ok: false, reason: "note extra key" };
      { const text = strictStr(w.text); if (text === null) return { ok: false, reason: "note.text" };
        return { ok: true, node: { type: "text", id, props: { text }, untrusted: true } }; }
    case "metric":
      if (!onlyKeys(w, ["kind", "label", "binding", "select", "format"])) return { ok: false, reason: "metric extra key" };
      { const label = strictStr(w.label, LIM.title); if (label === null) return { ok: false, reason: "metric.label" };
        const b = mapBind(w.binding, "metric"); if (!b.ok) return b;
        return { ok: true, node: { type: "stat", id, props: { label }, bind: b.bind, untrusted: true } }; }
    case "capability":
      if (!onlyKeys(w, ["kind", "binding"])) return { ok: false, reason: "capability extra key" };
      { const b = mapBind(w.binding, "capability"); if (!b.ok) return b;
        return { ok: true, node: { type: "card", id, props: { kind: "capability" }, bind: b.bind } }; }
    case "receipt":
      if (!onlyKeys(w, ["kind", "binding"])) return { ok: false, reason: "receipt extra key" };
      { const b = mapBind(w.binding, "receipt"); if (!b.ok) return b;
        return { ok: true, node: { type: "receipt", id, bind: b.bind } }; }
    case "list":
      if (!onlyKeys(w, ["kind", "binding", "item", "limit"])) return { ok: false, reason: "list extra key" };
      { const b = mapBind(w.binding, "list"); if (!b.ok) return b;
        const item = w.item;
        if (!isPlain(item) || !onlyKeys(item, ["title", "meta", "statusFrom"])) return { ok: false, reason: "list.item" };
        const rowTitle = strictStr(item.title, LIM.select); if (rowTitle === null || !isSelector(rowTitle)) return { ok: false, reason: "list.item.title selector" };
        const rowMeta: string[] = [];
        if (item.meta !== undefined) { if (!Array.isArray(item.meta) || item.meta.length > LIM.metaItems) return { ok: false, reason: "list.meta" };
          for (const mi of item.meta) { const s = strictStr(mi, LIM.select); if (s === null || !isSelector(s)) return { ok: false, reason: "list.meta selector" }; rowMeta.push(s); } }
        const props: IrNode["props"] = { rowTitle, rowMeta };
        if (item.statusFrom !== undefined) { const s = strictStr(item.statusFrom, LIM.select); if (s === null || !isSelector(s)) return { ok: false, reason: "list.statusFrom selector" }; props.statusFrom = s; }
        if (w.limit !== undefined) { if (typeof w.limit !== "number" || !Number.isInteger(w.limit) || w.limit <= 0 || w.limit > LIM.listRows) return { ok: false, reason: "list.limit" }; props.limit = w.limit; }
        return { ok: true, node: { type: "list", id, bind: b.bind, props } }; }
    case "run":
      if (!onlyKeys(w, ["kind", "binding", "statusFrom", "latestFrom"])) return { ok: false, reason: "run extra key" };
      { const b = mapBind(w.binding, "run"); if (!b.ok) return b;
        const statusFrom = strictStr(w.statusFrom, LIM.select), latestFrom = strictStr(w.latestFrom, LIM.select);
        if (statusFrom === null || latestFrom === null || !isSelector(statusFrom) || !isSelector(latestFrom)) return { ok: false, reason: "run selectors" };
        return { ok: true, node: { type: "card", id, props: { kind: "run", statusFrom, latestFrom }, bind: b.bind } }; }
    case "form":
      if (!onlyKeys(w, ["kind", "schema", "submit"])) return { ok: false, reason: "form extra key" };
      { const labels = fieldLabels(w.schema); if (!labels.ok) return labels;
        const children: IrNode[] = [];
        for (const l of labels.labels) { if (!budget()) return { ok: false, reason: "node budget" }; children.push({ type: "field-label", id: nextId(), props: { label: l }, untrusted: true }); }
        return { ok: true, node: { type: "form-summary", id, children } }; }
    case "approval":
      if (!onlyKeys(w, ["kind", "binding", "approve", "deny"])) return { ok: false, reason: "approval extra key" };
      // Static notice, NO bind — live approval state is the C+D out-of-band surface.
      return { ok: true, node: { type: "approval-notice", id, props: { notice: "This action is confirmed only on the authenticated PCC surface." } } };
    case "chain":
      if (!onlyKeys(w, ["kind", "composeRef", "execute"])) return { ok: false, reason: "chain extra key" };
      return { ok: true, node: { type: "plan", id, props: { kind: "composition" } } };
    case "actions":
      if (!onlyKeys(w, ["kind", "actions"])) return { ok: false, reason: "actions extra key" };
      { const acts = w.actions;
        if (!Array.isArray(acts) || acts.length === 0 || acts.length > LIM.fields) return { ok: false, reason: "actions" };
        const children: IrNode[] = [];
        for (const a of acts) {
          if (!budget()) return { ok: false, reason: "node budget" };
          if (!isPlain(a) || !onlyKeys(a, ["id", "label", "confirm", "intentText", "operation_id", "arguments"])) return { ok: false, reason: "action extra key" };
          const label = strictStr(a.label, LIM.title); if (label === null) return { ok: false, reason: "action.label" };
          children.push({ type: "badge", id: nextId(), props: { text: label, tone: "neutral" }, untrusted: true });
        }
        return { ok: true, node: { type: "grid", id, props: { kind: "actions-readonly" }, children } }; }
    default:
      return { ok: false, reason: `unknown window kind: ${kind}` };
  }
}

function mapBind(b: unknown, kind: string): { ok: true; bind: IrBind } | { ok: false; reason: string } {
  const policy = BIND_POLICY[kind];
  if (!policy) return { ok: false, reason: `no bind policy for ${kind}` };
  if (!isPlain(b) || !onlyKeys(b, ["path", "select", "query", "pollMs", "sse"])) return { ok: false, reason: "binding shape" };
  const path = strictStr(b.path, LIM.path);
  if (path === null || !isReadPath(path)) return { ok: false, reason: "binding.path grammar" };
  if (!policy.routes.some((re) => re.test(path))) return { ok: false, reason: `binding.path outside ${kind} route allowlist` };
  const bind: IrBind = { path };
  if (b.select !== undefined) { const s = strictStr(b.select, LIM.select); if (s === null || !isSelector(s)) return { ok: false, reason: "binding.select" }; bind.select = s; }
  if (b.sse !== undefined) { const s = strictStr(b.sse, LIM.path); if (s === null || !isReadPath(s, SSE_GRAMMAR) || !(policy.sse ?? []).some((re) => re.test(s))) return { ok: false, reason: "binding.sse outside allowlist" }; bind.sse = s; }
  if (b.pollMs !== undefined) { if (typeof b.pollMs !== "number" || !Number.isFinite(b.pollMs) || b.pollMs < 250 || b.pollMs > 3_600_000) return { ok: false, reason: "binding.pollMs" }; bind.pollMs = b.pollMs; }
  if (b.query !== undefined) {
    if (!isPlain(b.query) || Object.keys(b.query).length > LIM.queryKeys) return { ok: false, reason: "binding.query shape" };
    const q: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(b.query)) {
      if (!isSelector(k)) return { ok: false, reason: "query key grammar" };
      if (typeof v === "string") { if (v.length > LIM.str) return { ok: false, reason: "query value length" }; q[k] = v; }
      else if (typeof v === "boolean") q[k] = v;
      else if (typeof v === "number" && Number.isFinite(v)) q[k] = v;
      else return { ok: false, reason: "query value type" };
    }
    bind.query = q;
  }
  if (policy.schema) bind.schema = policy.schema;
  return { ok: true, bind };
}

/** Read-only field LABELS from a projected form schema — with a closed field grammar. */
function fieldLabels(schema: unknown): { ok: true; labels: string[] } | { ok: false; reason: string } {
  if (!isPlain(schema) || !onlyKeys(schema, ["type", "properties", "required"])) return { ok: false, reason: "form.schema shape" };
  const props = schema.properties;
  if (!isPlain(props)) return { ok: false, reason: "form.schema.properties" };
  const keys = Object.keys(props);
  if (keys.length > LIM.fields) return { ok: false, reason: "too many fields" };
  const CRED = /pass|secret|token|credential|apikey|privatekey|otp|cvv|pin/i;
  const labels: string[] = [];
  for (const key of keys) {
    if (PROTO_KEYS.has(key) || CRED.test(key)) return { ok: false, reason: "credential/proto field" };
    const def = (props as Record<string, unknown>)[key];
    // closed field-def grammar (no props/actions/children/capability/etc.)
    if (!isPlain(def) || !onlyKeys(def, ["type", "title", "description", "enum", "format", "minimum", "maximum", "minLength", "maxLength"])) return { ok: false, reason: "form field-def shape" };
    if (def.type !== undefined && !["string", "number", "integer", "boolean"].includes(String(def.type))) return { ok: false, reason: "form field type" };
    const rawLabel = typeof def.title === "string" ? def.title : key;
    const s = strictStr(rawLabel, LIM.title); if (s === null) return { ok: false, reason: "field label" };
    labels.push(s);
  }
  return { ok: true, labels };
}

// ── Independent whole-tree validator (mirrors the adapter's guarantees) ───────────
type PropSpec = Record<string, "string" | "number" | "boolean" | "string[]" | "level" | "tone">;
const NODE_SCHEMA: Record<IrNodeType, { props?: PropSpec; required?: readonly string[]; bindSchema?: BindSchema; noBind?: boolean; prose?: boolean; parentOf?: readonly IrNodeType[] }> = {
  root: { noBind: true, parentOf: ["section"] },
  section: { noBind: true },
  heading: { props: { level: "level", text: "string" }, required: ["level", "text"], noBind: true, prose: true },
  text: { props: { text: "string" }, required: ["text"], noBind: true, prose: true },
  stat: { props: { label: "string" }, required: ["label"], prose: true },
  badge: { props: { text: "string", tone: "tone" }, required: ["text", "tone"], noBind: true, prose: true },
  card: { props: { kind: "string", statusFrom: "string", latestFrom: "string" } },
  grid: { props: { kind: "string" }, noBind: true },
  list: { props: { rowTitle: "string", rowMeta: "string[]", statusFrom: "string", limit: "number" }, required: ["rowTitle", "rowMeta"] },
  progress: {}, divider: { noBind: true },
  receipt: { bindSchema: "receipt" },
  "approval-notice": { props: { notice: "string" }, required: ["notice"], noBind: true },
  plan: { props: { kind: "string" }, noBind: true },
  "form-summary": { noBind: true, parentOf: ["field-label"] },
  "field-label": { props: { label: "string" }, required: ["label"], noBind: true, prose: true },
};
function propType(v: unknown, t: PropSpec[string]): boolean {
  if (t === "string") return typeof v === "string";
  if (t === "number") return typeof v === "number" && Number.isFinite(v);
  if (t === "boolean") return typeof v === "boolean";
  if (t === "string[]") return Array.isArray(v) && v.every((x) => typeof x === "string");
  if (t === "level") return v === 1 || v === 2 || v === 3;
  if (t === "tone") return typeof v === "string" && TONE_SET.has(v);
  return false;
}
export function validateIr(doc: unknown): { ok: true } | { ok: false; reason: string } {
  if (!isPlain(doc) || doc.ir !== "pcc-dashboard-ir/v1" || !onlyKeys(doc, ["ir", "title", "root"])) return { ok: false, reason: "not an IR doc" };
  if (!deepClean(doc)) return { ok: false, reason: "proto/nonfinite in IR" };
  if (!isPlain(doc.title) || (doc.title as Record<string, unknown>).type !== "heading") return { ok: false, reason: "doc.title not heading" };
  if (!isPlain(doc.root) || (doc.root as Record<string, unknown>).type !== "root") return { ok: false, reason: "doc.root not root" };
  const ids = new Set<string>();
  let count = 0;
  const walk = (n: unknown, depth: number): string | null => {
    if (depth > LIM.depth) return "depth";
    if (++count > LIM.nodesTotal) return "node count";
    if (!isPlain(n)) return "node not plain";
    if (!onlyKeys(n, ["type", "id", "props", "bind", "children", "untrusted"])) return "unexpected node key";
    if (typeof n.type !== "string" || !FROZEN.has(n.type)) return `type not frozen: ${String(n.type)}`;
    if (typeof n.id !== "string" || !/^n[0-9]+$/.test(n.id) || ids.has(n.id)) return "id format/dup";
    ids.add(n.id);
    const spec = NODE_SCHEMA[n.type as IrNodeType];
    if (n.props !== undefined) {
      if (!isPlain(n.props) || !onlyKeys(n.props, Object.keys(spec.props ?? {}))) return `props off-schema for ${n.type}`;
      for (const [k, v] of Object.entries(n.props)) if (!propType(v, (spec.props as PropSpec)[k])) return `prop ${k} wrong type on ${n.type}`;
    }
    for (const req of spec.required ?? []) if (!n.props || !(req in (n.props as object))) return `missing prop ${req} on ${n.type}`;
    if (n.bind !== undefined) {
      if (spec.noBind) return `${n.type} must not bind`;
      if (!isPlain(n.bind) || !onlyKeys(n.bind, ["path", "select", "query", "pollMs", "sse", "schema"])) return "bind shape";
      if (typeof n.bind.path !== "string" || !isReadPath(n.bind.path)) return "bind.path";
      if (spec.bindSchema && (n.bind as Record<string, unknown>).schema !== spec.bindSchema) return `bind schema mismatch on ${n.type}`;
    } else if (spec.bindSchema) return `${n.type} requires trust bind`;
    if (spec.prose && n.untrusted !== true) return `prose ${n.type} not untrusted`;
    if (!spec.prose && n.untrusted !== undefined) return `non-prose ${n.type} marked untrusted`;
    if (n.children !== undefined) {
      if (!Array.isArray(n.children)) return "children not array";
      for (const c of n.children) {
        if (spec.parentOf && (!isPlain(c) || !spec.parentOf.includes((c as Record<string, unknown>).type as IrNodeType))) return `illegal child under ${n.type}`;
        const e = walk(c, depth + 1); if (e) return e;
      }
    }
    return null;
  };
  const e1 = walk(doc.title, 0); if (e1) return { ok: false, reason: `title: ${e1}` };
  const e2 = walk(doc.root, 0); return e2 ? { ok: false, reason: e2 } : { ok: true };
}
