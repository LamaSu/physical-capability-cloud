/**
 * Phase B — closed, PCC-owned render IR + adapter (read-only `/mcp/apps`).
 *
 * Design + Round-1 sol audit: ai/research/pcc-genui-b-closed-ir-design.md.
 * Standing spec: ai/research/pcc-genui-integration-architecture.md §6.
 *
 * The adapter turns a PROJECTED DashboardManifest (the output of
 * projectDashboardForMcpApp — already whitelisted at the top level) into a
 * CLOSED IR that Atelier paints. The IR is a strict subset of Atelier's UiTree:
 * PCC picks every node `type` from a FROZEN catalog and REBUILDS every prop from
 * a closed per-kind grammar — it never spreads a projected nested object
 * (projWindow's cloneData does NOT strip nested type/props/capability keys). B
 * emits NO actions/controls (inert is not enough — deceptive pixels), and
 * trust-bearing content (receipt/approval/status) is a server-authored bind, not
 * manifest prose. Fails CLOSED on anything unexpected. Depends on the
 * DashboardManifest TYPE only (import type) → runtime dependency-free.
 */
import type { DashboardManifest } from "@pcc/spec";

// ── Frozen catalog: the ONLY node types PCC emits (a subset of Atelier's) ──────
export const IR_NODE_TYPES = [
  "root", "section", "card", "grid", "text", "heading", "stat", "badge",
  "list", "list-row", "table", "timeline", "progress", "divider",
  "receipt", "approval-notice", "plan", "form-summary", "field-label",
] as const;
export type IrNodeType = (typeof IR_NODE_TYPES)[number];
const IR_NODE_TYPE_SET: ReadonlySet<string> = new Set(IR_NODE_TYPES);

/** Trust-bearing types: their content MUST come from a server-authored + schema-
 * validated bind at fetch time, never from manifest prose. The adapter only
 * emits the shell + the bind; the client refuses to render if the fetched data
 * fails the kind's schema. */
export const TRUST_BEARING_TYPES: ReadonlySet<IrNodeType> = new Set(["receipt", "approval-notice"]);

/** Status tones — a CLOSED server enum. A manifest cannot pick a tone; the
 * client maps a server status string → tone via a server-owned table. */
export const BADGE_TONES = ["neutral", "info", "positive", "warning", "danger"] as const;
export type BadgeTone = (typeof BADGE_TONES)[number];

// ── Limits (fail closed past these) ────────────────────────────────────────────
const LIM = {
  sections: 24, windowsPerSection: 32, nodesTotal: 2000, depth: 6,
  str: 2000, listRows: 200, tableCols: 24, tableRows: 500, fields: 64, metaItems: 12,
} as const;

// ── IR node + doc types ────────────────────────────────────────────────────────
/** A read-only data reference resolved by the client's poll/SSE layer. `path` is
 * a PCC route (the client validates it against the kind's allowed route family);
 * `select` is a dotted selector; `pollMs`/`sse` carry the refresh binding. */
export interface IrBind {
  path: string;
  select?: string;
  query?: Record<string, string | number | boolean>;
  pollMs?: number;
  sse?: string;
  /** For trust-bearing binds: the server schema the fetched data MUST validate against. */
  schema?: "receipt" | "approval-state";
}
export interface IrNode {
  type: IrNodeType;
  id: string;
  /** CLOSED per-type props — only primitives + closed enums, never a passthrough object. */
  props?: Record<string, string | number | boolean | string[] | null>;
  bind?: IrBind;
  children?: IrNode[];
  /** Untrusted, manifest-supplied free text is flagged so the renderer styles it as narrative. */
  untrusted?: true;
  // NOTE: deliberately NO `actions` / `capability` field — B paints, never dispatches.
}
export interface IrDoc {
  ir: "pcc-dashboard-ir/v1";
  title: string;
  description?: string;
  root: IrNode; // a "root" node whose children are "section" nodes
}

export type IrResult = { ok: true; doc: IrDoc } | { ok: false; reason: string };

// ── Safe helpers ────────────────────────────────────────────────────────────────
const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function safeStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return v.length > LIM.str ? v.slice(0, LIM.str) : v;
}
/** Reject any object carrying a prototype-poisoning key anywhere (shallow guard;
 * we never recurse into untrusted objects — we read named scalar fields only). */
function hasProtoKey(o: Record<string, unknown>): boolean {
  for (const k of Object.keys(o)) if (PROTO_KEYS.has(k)) return true;
  return false;
}

// ── The adapter ─────────────────────────────────────────────────────────────────
export function dashboardManifestToIr(m: DashboardManifest | null | undefined): IrResult {
  if (!isPlainObject(m)) return { ok: false, reason: "manifest is not an object" };
  if (hasProtoKey(m)) return { ok: false, reason: "prototype key in manifest" };

  const title = safeStr((m as Record<string, unknown>).title) ?? "";
  const description = safeStr((m as Record<string, unknown>).description) ?? undefined;
  const sectionsRaw = (m as Record<string, unknown>).sections;
  if (!Array.isArray(sectionsRaw)) return { ok: false, reason: "sections not an array" };
  if (sectionsRaw.length > LIM.sections) return { ok: false, reason: "too many sections" };

  let nodeCount = 0;
  const nextId = (() => { let n = 0; return () => `n${++n}`; })();
  const budget = (): boolean => ++nodeCount <= LIM.nodesTotal;

  const sectionNodes: IrNode[] = [];
  for (const secRaw of sectionsRaw) {
    if (!isPlainObject(secRaw) || hasProtoKey(secRaw)) return { ok: false, reason: "bad section" };
    const winsRaw = secRaw.windows;
    if (!Array.isArray(winsRaw)) return { ok: false, reason: "section.windows not an array" };
    if (winsRaw.length > LIM.windowsPerSection) return { ok: false, reason: "too many windows" };
    if (!budget()) return { ok: false, reason: "node budget exceeded" };

    const children: IrNode[] = [];
    for (const winRaw of winsRaw) {
      const node = mapWindow(winRaw, nextId, budget);
      if (!node.ok) return node; // fail closed on any bad window
      children.push(node.node);
    }
    const secTitle = safeStr(secRaw.title);
    sectionNodes.push({
      type: "section", id: nextId(),
      ...(secTitle ? { props: { title: secTitle } } : {}),
      children,
    });
  }

  return {
    ok: true,
    doc: {
      ir: "pcc-dashboard-ir/v1",
      title,
      ...(description ? { description } : {}),
      root: { type: "root", id: nextId(), children: sectionNodes },
    },
  };
}

type MapResult = { ok: true; node: IrNode } | { ok: false; reason: string };

/** Map one projected window (one of the 10 closed kinds) → one IR node, rebuilding
 * props from a closed grammar. NO actions are ever emitted. */
function mapWindow(w: unknown, nextId: () => string, budget: () => boolean): MapResult {
  if (!budget()) return { ok: false, reason: "node budget exceeded" };
  if (!isPlainObject(w) || hasProtoKey(w)) return { ok: false, reason: "window not an object" };
  const kind = w.kind;
  if (typeof kind !== "string") return { ok: false, reason: "window.kind missing" };
  const id = nextId();

  switch (kind) {
    case "note": {
      const text = safeStr(w.text);
      if (text === null) return { ok: false, reason: "note.text invalid" };
      // Manifest free text → rendered as UNTRUSTED narrative.
      return { ok: true, node: { type: "text", id, props: { text }, untrusted: true } };
    }
    case "metric": {
      const label = safeStr(w.label);
      if (!label) return { ok: false, reason: "metric.label invalid" };
      const bind = mapBind(w.binding);
      if (!bind.ok) return bind;
      const format = pickEnum(w.format, ["usd", "int", "pct", "ts"]);
      // PCC pre-formats the bound value at render; Atelier `stat` takes value/delta.
      return { ok: true, node: { type: "stat", id, props: { label, ...(format ? { format } : {}) }, bind: bind.bind } };
    }
    case "capability": {
      const bind = mapBind(w.binding);
      if (!bind.ok) return bind;
      return { ok: true, node: { type: "card", id, props: { kind: "capability" }, bind: bind.bind } };
    }
    case "receipt": {
      const bind = mapBind(w.binding);
      if (!bind.ok) return bind;
      // TRUST-BEARING: content only from a receipt endpoint validated against the
      // receipt schema; the client refuses to render a "receipt" if it fails.
      return { ok: true, node: { type: "receipt", id, bind: { ...bind.bind, schema: "receipt" } } };
    }
    case "list": {
      const bind = mapBind(w.binding);
      if (!bind.ok) return bind;
      const item = w.item;
      if (!isPlainObject(item) || hasProtoKey(item)) return { ok: false, reason: "list.item invalid" };
      const itemTitle = safeStr(item.title);
      if (!itemTitle) return { ok: false, reason: "list.item.title invalid" };
      const meta: string[] = [];
      if (Array.isArray(item.meta)) {
        for (const mi of item.meta.slice(0, LIM.metaItems)) { const s = safeStr(mi); if (s) meta.push(s); }
      }
      const statusFrom = safeStr(item.statusFrom) ?? undefined;
      const limit = typeof w.limit === "number" && isFinite(w.limit) && w.limit > 0
        ? Math.min(Math.floor(w.limit), LIM.listRows) : LIM.listRows;
      // A `list` shell; the client renders one `list-row` per fetched item, capped.
      return {
        ok: true,
        node: {
          type: "list", id, bind: bind.bind,
          props: { rowTitle: itemTitle, rowMeta: meta, ...(statusFrom ? { statusFrom } : {}), limit },
        },
      };
    }
    case "run": {
      const bind = mapBind(w.binding);
      if (!bind.ok) return bind;
      const statusFrom = safeStr(w.statusFrom);
      const latestFrom = safeStr(w.latestFrom);
      if (!statusFrom || !latestFrom) return { ok: false, reason: "run.statusFrom/latestFrom invalid" };
      return {
        ok: true,
        node: { type: "card", id, props: { kind: "run", statusFrom, latestFrom }, bind: bind.bind },
      };
    }
    case "form": {
      // Q3: NO inputs, NO submit. A read-only summary of the field labels only.
      const labels = fieldLabels(w.schema);
      if (!labels.ok) return labels;
      const children: IrNode[] = labels.labels.map((l) => ({ type: "field-label", id: nextId(), props: { label: l } }));
      return { ok: true, node: { type: "form-summary", id, children } };
    }
    case "approval": {
      // Q3: neutral NOTICE, never an approval control; state (if any) is a
      // trust-bearing bind to canonical PCC/VCR approval state, not manifest prose.
      const bind = mapBind(w.binding);
      const node: IrNode = {
        type: "approval-notice", id,
        props: { notice: "This action is confirmed only on the authenticated PCC surface." },
      };
      if (bind.ok) node.bind = { ...bind.bind, schema: "approval-state" };
      return { ok: true, node };
    }
    case "chain": {
      // Neutral read-only plan; NO execute.
      return { ok: true, node: { type: "plan", id, props: { kind: "composition" } } };
    }
    case "actions": {
      // Q3: read-only, visibly non-authoritative labels only — never buttons.
      const acts = w.actions;
      if (!Array.isArray(acts) || acts.length === 0) return { ok: false, reason: "actions empty" };
      const children: IrNode[] = [];
      for (const a of acts) {
        if (!budget()) return { ok: false, reason: "node budget exceeded" };
        if (!isPlainObject(a)) return { ok: false, reason: "action not object" };
        const label = safeStr(a.label);
        if (!label) return { ok: false, reason: "action.label invalid" };
        children.push({ type: "badge", id: nextId(), props: { text: label, tone: "neutral" } });
      }
      return { ok: true, node: { type: "grid", id, props: { kind: "actions-readonly" }, children } };
    }
    default:
      return { ok: false, reason: `unknown window kind: ${kind}` };
  }
}

/** Map a projected binding → a closed IrBind (read fields only). */
function mapBind(b: unknown): { ok: true; bind: IrBind } | { ok: false; reason: string } {
  if (!isPlainObject(b) || hasProtoKey(b)) return { ok: false, reason: "binding invalid" };
  const path = safeStr(b.path);
  if (!path) return { ok: false, reason: "binding.path invalid" };
  const bind: IrBind = { path };
  const select = safeStr(b.select); if (select) bind.select = select;
  const sse = safeStr(b.sse); if (sse) bind.sse = sse;
  if (typeof b.pollMs === "number" && isFinite(b.pollMs) && b.pollMs > 0) bind.pollMs = b.pollMs;
  if (isPlainObject(b.query) && !hasProtoKey(b.query)) {
    const q: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(b.query)) {
      if (typeof v === "string") q[k] = v.length > LIM.str ? v.slice(0, LIM.str) : v;
      else if (typeof v === "number" || typeof v === "boolean") q[k] = v;
    }
    if (Object.keys(q).length) bind.query = q;
  }
  return { ok: true, bind };
}

/** Read-only field LABELS from a projected form schema — no input types, no values. */
function fieldLabels(schema: unknown): { ok: true; labels: string[] } | { ok: false; reason: string } {
  if (!isPlainObject(schema) || hasProtoKey(schema)) return { ok: false, reason: "form.schema invalid" };
  const props = isPlainObject(schema.properties) ? schema.properties : schema;
  if (!isPlainObject(props)) return { ok: false, reason: "form.schema.properties invalid" };
  const labels: string[] = [];
  for (const key of Object.keys(props).slice(0, LIM.fields)) {
    if (PROTO_KEYS.has(key)) return { ok: false, reason: "proto key in form schema" };
    const def = (props as Record<string, unknown>)[key];
    const label = (isPlainObject(def) && safeStr(def.title)) || key;
    const s = safeStr(label);
    if (s) labels.push(s);
  }
  return { ok: true, labels };
}

function pickEnum<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

// ── Structural validator (the conformance oracle) ────────────────────────────────
/** Independently verify a produced IrDoc: every node type is in the frozen set,
 * NO node carries an action/capability, IDs are unique, depth/count within limits.
 * A second, structural check on the adapter's own output. */
export function validateIr(doc: unknown): { ok: true } | { ok: false; reason: string } {
  if (!isPlainObject(doc) || doc.ir !== "pcc-dashboard-ir/v1") return { ok: false, reason: "not an IR doc" };
  if (!isPlainObject(doc.root) || (doc.root as Record<string, unknown>).type !== "root") {
    return { ok: false, reason: "missing root" };
  }
  const ids = new Set<string>();
  let count = 0;
  const walk = (n: unknown, depth: number): string | null => {
    if (depth > LIM.depth) return "depth exceeded";
    if (++count > LIM.nodesTotal) return "node count exceeded";
    if (!isPlainObject(n)) return "node not object";
    if (typeof n.type !== "string" || !IR_NODE_TYPE_SET.has(n.type)) return `type not in frozen set: ${String(n.type)}`;
    if (typeof n.id !== "string" || ids.has(n.id)) return "id missing/duplicate";
    ids.add(n.id);
    // Hard invariant: B never emits actions or capabilities.
    if ("actions" in n || "capability" in n) return "node carries action/capability (forbidden in B)";
    if (n.children !== undefined) {
      if (!Array.isArray(n.children)) return "children not array";
      for (const c of n.children) { const e = walk(c, depth + 1); if (e) return e; }
    }
    return null;
  };
  const err = walk(doc.root, 0);
  return err ? { ok: false, reason: err } : { ok: true };
}
