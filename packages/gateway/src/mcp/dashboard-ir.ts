/**
 * Phase B — closed, PCC-owned render IR + adapter (read-only `/mcp/apps`).
 * Design + sol audits: ai/research/pcc-genui-b-closed-ir-design.md. Spec §6.
 *
 * The adapter turns a PROJECTED DashboardManifest into a CLOSED IR (a strict
 * subset of Atelier's UiTree). Hard rules (sol Round-1/2 audits folded):
 *   - PCC picks every node `type` from a FROZEN catalog; rebuilds every prop from
 *     a closed per-kind grammar; NEVER spreads a projected nested object.
 *   - STRICT REJECTION, never strip/clamp/truncate: over-limit, unknown keys, bad
 *     grammar, or a prototype key ANYWHERE (recursive) → the whole manifest fails.
 *   - Bindings are governed per kind: a path route-family + a selector grammar +
 *     a bounded query schema; trust-bearing kinds (receipt/approval) require a
 *     server response schema (the client refuses to render if it fails).
 *   - B emits NO actions/capability (inert ≠ safe — deceptive pixels); effecting
 *     kinds render neutral; ALL manifest prose is marked `untrusted`.
 * Runtime dependency-free (DashboardManifest is a type-only import).
 */
import type { DashboardManifest } from "@pcc/spec";

// ── Frozen catalog ──────────────────────────────────────────────────────────────
export const IR_NODE_TYPES = [
  "root", "section", "card", "grid", "text", "heading", "stat", "badge",
  "list", "table", "timeline", "progress", "divider",
  "receipt", "approval-notice", "plan", "form-summary", "field-label",
] as const;
export type IrNodeType = (typeof IR_NODE_TYPES)[number];
const FROZEN: ReadonlySet<string> = new Set(IR_NODE_TYPES);
export const TRUST_BEARING_TYPES: ReadonlySet<IrNodeType> = new Set(["receipt", "approval-notice"]);
export const BADGE_TONES = ["neutral", "info", "positive", "warning", "danger"] as const;

const LIM = {
  sections: 24, windowsPerSection: 32, nodesTotal: 2000, depth: 6,
  str: 2000, listRows: 200, fields: 64, metaItems: 12, queryKeys: 16,
  path: 512, select: 256, title: 400,
} as const;

// ── Governed binding policy — per-kind route family + grammars ────────────────────
// Path must be a root-relative /api read route (no scheme/host/`..`/query/fragment).
const PATH_GRAMMAR = /^\/api\/[A-Za-z0-9._~\-/{}]+$/;
const SELECT_GRAMMAR = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/; // dotted, no brackets/`..`
type BindSchema = "receipt" | "approval-state";
interface BindPolicy { routes: RegExp[]; schema?: BindSchema }
// Conservative per-kind allowlist of route families (the security-critical list — review before widening).
const BIND_POLICY: Record<string, BindPolicy> = {
  metric: { routes: [/^\/api\/(fiat-ramp|escrow|jobs|kernels|capabilities|settlement|pool|rewards)\b/] },
  capability: { routes: [/^\/api\/capabilities\/[^/]+$/] },
  receipt: { routes: [/^\/api\/(jobs\/[^/]+\/settlement|jobs\/[^/]+\/evidence|escrow\/[^/]+|compliance\/evidence\/[^/]+)$/], schema: "receipt" },
  list: { routes: [/^\/api\/(jobs|kernels|capabilities|escrow|evidence|protocols|marketplace\/listings|marketplace\/orders)\b/] },
  run: { routes: [/^\/api\/jobs\/[^/]+$/] },
  approval: { routes: [/^\/api\/(escrow|jobs)\/[^/]+$/], schema: "approval-state" },
};

// ── IR types ──────────────────────────────────────────────────────────────────
export interface IrBind { path: string; select?: string; query?: Record<string, string | number | boolean>; pollMs?: number; sse?: string; schema?: BindSchema }
export interface IrNode {
  type: IrNodeType;
  id: string;
  props?: Record<string, string | number | boolean | string[]>;
  bind?: IrBind;
  children?: IrNode[];
  /** true when any prop text originated from the manifest (renderer styles as narrative). */
  untrusted?: true;
}
export interface IrDoc { ir: "pcc-dashboard-ir/v1"; title: IrNode; root: IrNode }
export type IrResult = { ok: true; doc: IrDoc } | { ok: false; reason: string };

// ── Safe primitives (REJECT, never strip) ────────────────────────────────────────
const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** A string of bounded length, else null (→ REJECT). Never truncates. */
function strictStr(v: unknown, max = LIM.str): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}
/** Reject if `o` has any key not in `allowed`. */
function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  for (const k of Object.keys(o)) if (!set.has(k)) return false;
  return true;
}
/** Recursively reject __proto__/constructor/prototype ANYWHERE in accepted data.
 * Uses a deeper INPUT bound than the (shallow) IR-tree depth — the projected
 * manifest nests legitimately to ~manifest/sections/section/windows/window/item/meta/elem. */
const MAX_INPUT_DEPTH = 16;
function deepClean(v: unknown, depth = 0): boolean {
  if (depth > MAX_INPUT_DEPTH) return false;
  if (Array.isArray(v)) { for (const e of v) if (!deepClean(e, depth + 1)) return false; return true; }
  if (isObj(v)) {
    for (const k of Object.keys(v)) { if (PROTO_KEYS.has(k)) return false; if (!deepClean(v[k], depth + 1)) return false; }
  }
  return true;
}

// ── The adapter ─────────────────────────────────────────────────────────────────
export function dashboardManifestToIr(m: DashboardManifest | null | undefined): IrResult {
  if (!isObj(m)) return { ok: false, reason: "manifest not an object" };
  if (!deepClean(m)) return { ok: false, reason: "prototype key in manifest" };
  const mm = m as Record<string, unknown>;
  if (!onlyKeys(mm, ["csd", "title", "description", "theme", "sections"])) return { ok: false, reason: "unexpected top-level key" };

  const title = strictStr(mm.title, LIM.title);
  if (title === null) return { ok: false, reason: "title invalid" };
  const sections = mm.sections;
  if (!Array.isArray(sections)) return { ok: false, reason: "sections not array" };
  if (sections.length > LIM.sections) return { ok: false, reason: "too many sections" };

  let count = 0;
  const budget = (): boolean => ++count <= LIM.nodesTotal;
  const nextId = (() => { let n = 0; return () => `n${++n}`; })();

  const sectionNodes: IrNode[] = [];
  for (const secRaw of sections) {
    if (!budget()) return { ok: false, reason: "node budget" };
    if (!isObj(secRaw) || !onlyKeys(secRaw, ["title", "windows"])) return { ok: false, reason: "bad section" };
    const wins = secRaw.windows;
    if (!Array.isArray(wins)) return { ok: false, reason: "section.windows not array" };
    if (wins.length > LIM.windowsPerSection) return { ok: false, reason: "too many windows" };
    const children: IrNode[] = [];
    if (secRaw.title !== undefined) {
      const st = strictStr(secRaw.title, LIM.title);
      if (st === null) return { ok: false, reason: "section.title invalid" };
      if (!budget()) return { ok: false, reason: "node budget" };
      children.push({ type: "heading", id: nextId(), props: { level: 3, text: st }, untrusted: true });
    }
    for (const w of wins) {
      const r = mapWindow(w, nextId, budget);
      if (!r.ok) return r;
      children.push(r.node);
    }
    if (!budget()) return { ok: false, reason: "node budget" };
    sectionNodes.push({ type: "section", id: nextId(), children });
  }

  return {
    ok: true,
    doc: {
      ir: "pcc-dashboard-ir/v1",
      title: { type: "heading", id: nextId(), props: { level: 1, text: title }, untrusted: true },
      root: { type: "root", id: nextId(), children: sectionNodes },
    },
  };
}

type MapResult = { ok: true; node: IrNode } | { ok: false; reason: string };

function mapWindow(w: unknown, nextId: () => string, budget: () => boolean): MapResult {
  if (!budget()) return { ok: false, reason: "node budget" };
  if (!isObj(w)) return { ok: false, reason: "window not object" };
  const kind = w.kind;
  if (typeof kind !== "string") return { ok: false, reason: "window.kind missing" };
  const id = nextId();

  switch (kind) {
    case "note": {
      if (!onlyKeys(w, ["kind", "text"])) return { ok: false, reason: "note extra key" };
      const text = strictStr(w.text);
      if (text === null) return { ok: false, reason: "note.text invalid" };
      return { ok: true, node: { type: "text", id, props: { text }, untrusted: true } };
    }
    case "metric": {
      if (!onlyKeys(w, ["kind", "label", "binding", "select", "format"])) return { ok: false, reason: "metric extra key" };
      const label = strictStr(w.label, LIM.title);
      if (label === null) return { ok: false, reason: "metric.label invalid" };
      const b = mapBind(w.binding, "metric"); if (!b.ok) return b;
      // Locked correction: PCC pre-formats the value; no `format` prop emitted.
      return { ok: true, node: { type: "stat", id, props: { label }, bind: b.bind, untrusted: true } };
    }
    case "capability": {
      if (!onlyKeys(w, ["kind", "binding"])) return { ok: false, reason: "capability extra key" };
      const b = mapBind(w.binding, "capability"); if (!b.ok) return b;
      return { ok: true, node: { type: "card", id, props: { kind: "capability" }, bind: b.bind } };
    }
    case "receipt": {
      if (!onlyKeys(w, ["kind", "binding"])) return { ok: false, reason: "receipt extra key" };
      const b = mapBind(w.binding, "receipt"); if (!b.ok) return b; // policy forces schema:"receipt"
      return { ok: true, node: { type: "receipt", id, bind: b.bind } };
    }
    case "list": {
      if (!onlyKeys(w, ["kind", "binding", "item", "limit"])) return { ok: false, reason: "list extra key" };
      const b = mapBind(w.binding, "list"); if (!b.ok) return b;
      const item = w.item;
      if (!isObj(item) || !onlyKeys(item, ["title", "meta", "statusFrom"])) return { ok: false, reason: "list.item invalid" };
      const rowTitle = strictStr(item.title, LIM.title);
      if (rowTitle === null || !SELECT_GRAMMAR.test(rowTitle)) return { ok: false, reason: "list.item.title not a selector" };
      const rowMeta: string[] = [];
      if (item.meta !== undefined) {
        if (!Array.isArray(item.meta) || item.meta.length > LIM.metaItems) return { ok: false, reason: "list.item.meta invalid" };
        for (const mi of item.meta) { const s = strictStr(mi, LIM.select); if (s === null || !SELECT_GRAMMAR.test(s)) return { ok: false, reason: "list meta not selector" }; rowMeta.push(s); }
      }
      const props: IrNode["props"] = { rowTitle, rowMeta };
      if (item.statusFrom !== undefined) { const s = strictStr(item.statusFrom, LIM.select); if (s === null || !SELECT_GRAMMAR.test(s)) return { ok: false, reason: "list statusFrom not selector" }; props.statusFrom = s; }
      if (w.limit !== undefined) { if (typeof w.limit !== "number" || !Number.isInteger(w.limit) || w.limit <= 0 || w.limit > LIM.listRows) return { ok: false, reason: "list.limit invalid" }; props.limit = w.limit; }
      return { ok: true, node: { type: "list", id, bind: b.bind, props } };
    }
    case "run": {
      if (!onlyKeys(w, ["kind", "binding", "statusFrom", "latestFrom"])) return { ok: false, reason: "run extra key" };
      const b = mapBind(w.binding, "run"); if (!b.ok) return b;
      const statusFrom = strictStr(w.statusFrom, LIM.select), latestFrom = strictStr(w.latestFrom, LIM.select);
      if (statusFrom === null || latestFrom === null || !SELECT_GRAMMAR.test(statusFrom) || !SELECT_GRAMMAR.test(latestFrom)) return { ok: false, reason: "run selectors invalid" };
      return { ok: true, node: { type: "card", id, props: { kind: "run", statusFrom, latestFrom }, bind: b.bind } };
    }
    case "form": {
      if (!onlyKeys(w, ["kind", "schema", "submit"])) return { ok: false, reason: "form extra key" };
      const labels = fieldLabels(w.schema); if (!labels.ok) return labels;
      const children: IrNode[] = [];
      for (const l of labels.labels) { if (!budget()) return { ok: false, reason: "node budget" }; children.push({ type: "field-label", id: nextId(), props: { label: l }, untrusted: true }); }
      return { ok: true, node: { type: "form-summary", id, children } };
    }
    case "approval": {
      if (!onlyKeys(w, ["kind", "binding", "approve", "deny"])) return { ok: false, reason: "approval extra key" };
      const b = mapBind(w.binding, "approval"); if (!b.ok) return b; // REQUIRED + schema:"approval-state"
      return { ok: true, node: { type: "approval-notice", id, props: { notice: "This action is confirmed only on the authenticated PCC surface." }, bind: b.bind } };
    }
    case "chain": {
      if (!onlyKeys(w, ["kind", "composeRef", "execute"])) return { ok: false, reason: "chain extra key" };
      return { ok: true, node: { type: "plan", id, props: { kind: "composition" } } };
    }
    case "actions": {
      if (!onlyKeys(w, ["kind", "actions"])) return { ok: false, reason: "actions extra key" };
      const acts = w.actions;
      if (!Array.isArray(acts) || acts.length === 0 || acts.length > LIM.fields) return { ok: false, reason: "actions invalid" };
      const children: IrNode[] = [];
      for (const a of acts) {
        if (!budget()) return { ok: false, reason: "node budget" };
        if (!isObj(a)) return { ok: false, reason: "action not object" };
        const label = strictStr(a.label, LIM.title);
        if (label === null) return { ok: false, reason: "action.label invalid" };
        children.push({ type: "badge", id: nextId(), props: { text: label, tone: "neutral" }, untrusted: true });
      }
      return { ok: true, node: { type: "grid", id, props: { kind: "actions-readonly" }, children } };
    }
    default:
      return { ok: false, reason: `unknown window kind: ${kind}` };
  }
}

function mapBind(b: unknown, kind: string): { ok: true; bind: IrBind } | { ok: false; reason: string } {
  const policy = BIND_POLICY[kind];
  if (!policy) return { ok: false, reason: `no bind policy for ${kind}` };
  if (!isObj(b) || !onlyKeys(b, ["path", "select", "query", "pollMs", "sse"])) return { ok: false, reason: "binding invalid" };
  const path = strictStr(b.path, LIM.path);
  if (path === null || !PATH_GRAMMAR.test(path) || path.includes("..")) return { ok: false, reason: "binding.path grammar" };
  if (!policy.routes.some((re) => re.test(path))) return { ok: false, reason: `binding.path outside ${kind} route family` };
  const bind: IrBind = { path };
  if (b.select !== undefined) { const s = strictStr(b.select, LIM.select); if (s === null || !SELECT_GRAMMAR.test(s)) return { ok: false, reason: "binding.select grammar" }; bind.select = s; }
  if (b.sse !== undefined) { const s = strictStr(b.sse, LIM.path); if (s === null || !PATH_GRAMMAR.test(s) || s.includes("..")) return { ok: false, reason: "binding.sse grammar" }; bind.sse = s; }
  if (b.pollMs !== undefined) { if (typeof b.pollMs !== "number" || !Number.isFinite(b.pollMs) || b.pollMs < 250 || b.pollMs > 3_600_000) return { ok: false, reason: "binding.pollMs invalid" }; bind.pollMs = b.pollMs; }
  if (b.query !== undefined) {
    if (!isObj(b.query) || !deepClean(b.query) || Object.keys(b.query).length > LIM.queryKeys) return { ok: false, reason: "binding.query invalid" };
    const q: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(b.query)) {
      if (!SELECT_GRAMMAR.test(k)) return { ok: false, reason: "query key grammar" };
      if (typeof v === "string") { if (v.length > LIM.str) return { ok: false, reason: "query value too long" }; q[k] = v; }
      else if (typeof v === "number" || typeof v === "boolean") q[k] = v;
      else return { ok: false, reason: "query value type" };
    }
    bind.query = q;
  }
  if (policy.schema) bind.schema = policy.schema;
  return { ok: true, bind };
}

function fieldLabels(schema: unknown): { ok: true; labels: string[] } | { ok: false; reason: string } {
  if (!isObj(schema) || !deepClean(schema)) return { ok: false, reason: "form.schema invalid" };
  const props = isObj(schema.properties) ? schema.properties : null;
  if (!props) return { ok: false, reason: "form.schema.properties missing" };
  const keys = Object.keys(props);
  if (keys.length > LIM.fields) return { ok: false, reason: "too many fields" };
  const labels: string[] = [];
  for (const key of keys) {
    if (PROTO_KEYS.has(key)) return { ok: false, reason: "proto key in schema" };
    const def = (props as Record<string, unknown>)[key];
    const rawLabel = (isObj(def) && typeof def.title === "string" ? def.title : key);
    const s = strictStr(rawLabel, LIM.title);
    if (s === null) return { ok: false, reason: "field label invalid" };
    labels.push(s);
  }
  return { ok: true, labels };
}

// ── Independent whole-tree validator (the oracle) ────────────────────────────────
/** Per-type EXACT prop-key + bind schemas. */
const NODE_SCHEMA: Record<IrNodeType, { props?: readonly string[]; bindSchema?: BindSchema; bindRequired?: boolean; prose?: boolean }> = {
  root: {}, section: {},
  heading: { props: ["level", "text"], prose: true },
  text: { props: ["text"], prose: true },
  stat: { props: ["label"], prose: true },
  badge: { props: ["text", "tone"], prose: true },
  card: { props: ["kind", "statusFrom", "latestFrom"] },
  grid: { props: ["kind"] },
  list: { props: ["rowTitle", "rowMeta", "statusFrom", "limit"] },
  table: {}, timeline: {}, progress: {}, divider: {},
  receipt: { bindSchema: "receipt", bindRequired: true },
  "approval-notice": { props: ["notice"], bindSchema: "approval-state", bindRequired: true },
  plan: { props: ["kind"] },
  "form-summary": {},
  "field-label": { props: ["label"], prose: true },
};

export function validateIr(doc: unknown): { ok: true } | { ok: false; reason: string } {
  if (!isObj(doc) || doc.ir !== "pcc-dashboard-ir/v1") return { ok: false, reason: "not an IR doc" };
  if (!onlyKeys(doc, ["ir", "title", "root"])) return { ok: false, reason: "unexpected doc key" };
  if (!deepClean(doc)) return { ok: false, reason: "proto key in IR" };
  const ids = new Set<string>();
  let count = 0;
  const walk = (n: unknown, depth: number): string | null => {
    if (depth > LIM.depth) return "depth";
    if (++count > LIM.nodesTotal) return "node count";
    if (!isObj(n)) return "node not object";
    if (!onlyKeys(n, ["type", "id", "props", "bind", "children", "untrusted"])) return "unexpected node key";
    if (typeof n.type !== "string" || !FROZEN.has(n.type)) return `type not frozen: ${String(n.type)}`;
    if ("actions" in n || "capability" in n) return "action/capability forbidden";
    if (typeof n.id !== "string" || ids.has(n.id)) return "id dup/missing";
    ids.add(n.id);
    const spec = NODE_SCHEMA[n.type as IrNodeType];
    if (n.props !== undefined) {
      if (!isObj(n.props) || !onlyKeys(n.props, spec.props ?? [])) return `props off-schema for ${n.type}`;
    }
    if (n.bind !== undefined) {
      if (!isObj(n.bind)) return "bind not object";
      const bs = (n.bind as Record<string, unknown>).schema;
      if (spec.bindSchema && bs !== spec.bindSchema) return `trust bind schema mismatch for ${n.type}`;
    } else if (spec.bindRequired) return `${n.type} requires a trust-bearing bind`;
    if (spec.prose && n.untrusted !== true) return `prose node ${n.type} not marked untrusted`;
    if (n.children !== undefined) {
      if (!Array.isArray(n.children)) return "children not array";
      for (const c of n.children) { const e = walk(c, depth + 1); if (e) return e; }
    }
    return null;
  };
  const eTitle = walk(doc.title, 0);
  if (eTitle) return { ok: false, reason: `title: ${eTitle}` };
  const e = walk(doc.root, 0);
  return e ? { ok: false, reason: e } : { ok: true };
}
