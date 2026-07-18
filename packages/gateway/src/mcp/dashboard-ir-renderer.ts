/**
 * Phase B — closed IR RENDERER (item 7). Paints an IrDoc (from dashboardManifestToIr)
 * into the `/mcp/apps` view. Read-only surface, no writes, no host bridge.
 *
 * Security contract (mirrors the adapter's; the view treats the HOST as untrusted so
 * server validation is NOT assumed sufficient — §6.3 threat model):
 *  - IN-BROWSER re-validation: `bootIrView` runs the injected `validateIr` on the doc
 *    BEFORE painting; an invalid doc paints a fixed inert notice and nothing else.
 *  - FROZEN painter dispatch: node.type selects a painter from an Object.freeze'd map
 *    of exactly the 14 catalog types. A doc can never name a painter/handler/tag.
 *  - TEXT-ONLY SINKS: every string reaches the DOM through `textContent` only. This
 *    module never references `innerHTML`/`insertAdjacentHTML`/`outerHTML` — untrusted
 *    prose (all manifest text + fetched values) can only ever be inert text.
 *  - SCHEMA-VALIDATED DYNAMIC ROWS: fetched list rows/stat scalars are read ONLY via
 *    the doc's declared own-property selectors; anything else is dropped.
 *  - NO EFFECTS: no fetch of non-GET, no host tools/call, no __PCC_HOST_BRIDGE__/
 *    __PCC_HOST_OPERATIONS__. Data binding is GET-only and injected (item 8 wires it).
 *
 * Written self-contained (siblings-by-name only) so it can be inlined into the view
 * HTML via `.toString()` — the tested definition and the browser code are one source.
 */
import type { IrDoc, IrNode, IrNodeType, BindSchema } from "./dashboard-ir.js";

// Minimal structural DOM (the gateway tsconfig has no "dom" lib). The real browser
// `document`/element are structurally compatible; tests pass a plain-object fake.
// NOTE: intentionally NO innerHTML/insertAdjacentHTML member — a painter cannot set one.
export interface RElement {
  textContent: string;
  className: string;
  readonly children: RElement[];
  setAttr(name: string, value: string): void;
  appendChild(child: RElement): RElement;
}
export interface RDocument { createElement(tag: string): RElement; }

const CLS: Record<IrNodeType | "untrusted" | "invalid" | "value" | "row" | "meta" | "note" | "schemaCard" | "field", string> = {
  root: "pcc-ir", section: "pcc-section", heading: "pcc-heading", text: "pcc-text",
  stat: "pcc-stat", card: "pcc-card", receipt: "pcc-receipt", list: "pcc-list",
  badge: "pcc-badge", grid: "pcc-grid", "approval-notice": "pcc-approval",
  plan: "pcc-plan", "form-summary": "pcc-form", "field-label": "pcc-field",
  untrusted: "pcc-untrusted", invalid: "pcc-invalid", value: "pcc-value", row: "pcc-row", meta: "pcc-meta",
  note: "pcc-note", schemaCard: "pcc-schema-card", field: "pcc-fieldlabel",
};

/** own-property read via a dotted selector (NO prototype traversal, NO traversal THROUGH
 * an array). Returns the raw final value, or undefined for a proto segment / missing key
 * / non-object step. The selector was already grammar-checked by the adapter/validator;
 * this re-guards proto segments defensively. */
function readOwnPath(obj: unknown, sel: string): unknown {
  let cur: unknown = obj;
  for (const seg of sel.split(".")) {
    if (seg === "__proto__" || seg === "constructor" || seg === "prototype") return undefined;
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
/** Scalar coercion of an own-property read. "" for anything not a plain own scalar
 * (arrays/objects/null included) — identical behavior to the prior selector reader. */
function readSelector(obj: unknown, sel: string): string {
  const cur = readOwnPath(obj, sel);
  if (typeof cur === "string") return cur;
  if (typeof cur === "number" && Number.isFinite(cur)) return String(cur);
  if (typeof cur === "boolean") return String(cur);
  return "";
}

function el(doc: RDocument, cls: string, text?: string, untrusted?: boolean): RElement {
  const n = doc.createElement("div");
  n.className = untrusted ? cls + " " + CLS.untrusted : cls;
  if (text !== undefined) n.textContent = text; // TEXT-ONLY sink
  return n;
}

// ── PCC-owned fixed schema profiles (hollow-node binding) ─────────────────────────
// A manifest supplies a bind PATH only; PCC owns the HEADING, the FIELD SET, and the
// exact source KEY of each value. Labels are painted BEFORE any fetch; only value slots
// are dynamic, each read from ITS ONE fixed own-property key. A manifest can therefore
// never (a) relabel a field, (b) surface an off-schema response field (paid/verified/…),
// or (c) mint a privileged-looking "receipt" — the settlement record is always framed
// read-only with an explicit "not proof of payment" warning.
const UNAVAILABLE = "—"; // em dash — honest "not available", never a partial fake
interface SchemaField { label: string; key: string | readonly string[]; list?: boolean; bool?: boolean }
interface SchemaSpec { heading: string; note?: string; fields: readonly SchemaField[] }
// Only the DATA-BEARING cards have a schema (a public/known-shape GET). The settlement
// record is NOT here — it is a static pointer (see SETTLEMENT_NOTICE + the receipt painter).
export const SCHEMA_FIELDS: Readonly<Record<BindSchema, SchemaSpec>> = Object.freeze({
  "capability-summary-v1": Object.freeze({
    heading: "Capability",
    fields: Object.freeze([
      { label: "Name", key: "name" },
      { label: "Type", key: "type" },
      { label: "Base cost", key: "pricing.baseCost" },
      { label: "Currency", key: "pricing.currency" },
      { label: "Assurance tiers", key: "assuranceTiers", list: true },
      { label: "Available", key: "available", bool: true },
    ]),
  }),
  "run-summary-v1": Object.freeze({
    heading: "Run",
    // Dual-shape: the /status route returns top-level status/progress; the /jobs/:id detail
    // route returns them under `job`. Both are the KNOWN server shapes — PCC-owned fixed
    // keys (NOT a manifest selector); first present wins.
    fields: Object.freeze([
      { label: "Status", key: ["status", "job.status"] },
      { label: "Progress", key: ["progress", "job.progress"] },
    ]),
  }),
}) as Readonly<Record<BindSchema, SchemaSpec>>;

// The settlement record is a STATIC pointer — fixed PCC text, no fetch, no data labels.
// The endpoint reports `settled` for a merely-completed job and exposes the PHYSICAL
// completion time as `settledAt`, so any fetched "Settled at"/"Status" label under a
// settlement heading would affirmatively assert a settlement that may never have occurred.
// The authoritative receipt is the out-of-band Surface-B signed receipt; B only points.
const SETTLEMENT_NOTICE = Object.freeze({
  heading: "Settlement record (read-only)",
  note: "Not proof of payment; verify on the authenticated PCC surface.",
});

/** Read ONE fixed schema field from fetched data. `key` is a fixed own-property selector
 * (or an ordered list of KNOWN server shapes — first present wins); NEVER a manifest
 * selector. `list` joins a scalar array; `bool` normalizes to Yes/No. Missing / non-scalar
 * → the honest unavailable marker (never a partial authoritative card). */
function readField(data: unknown, f: SchemaField): string {
  const keys = Array.isArray(f.key) ? f.key : [f.key as string];
  if (f.list) {
    for (const k of keys) {
      const arr = readOwnPath(data, k);
      if (!Array.isArray(arr)) continue;
      const parts: string[] = [];
      for (const x of arr) {
        if (typeof x === "string" && x.length > 0) parts.push(x);
        else if (typeof x === "number" && Number.isFinite(x)) parts.push(String(x));
        else if (typeof x === "boolean") parts.push(String(x));
        // non-scalar array elements are skipped (never stringified)
      }
      if (parts.length) return parts.join(", ");
    }
    return UNAVAILABLE;
  }
  for (const k of keys) {
    const v = readSelector(data, k);
    if (v === "") continue;
    if (f.bool) return v === "true" ? "Yes" : v === "false" ? "No" : v;
    return v;
  }
  return UNAVAILABLE;
}

/** Fill a fixed-schema card's value slots from fetched data (text-only). PCC owns the
 * field set + order; slot[i] ← the i-th field's fixed key. Missing key → UNAVAILABLE. */
export function bindSchemaCard(schema: BindSchema, data: unknown, slots: Array<{ textContent: string }>): void {
  const spec = SCHEMA_FIELDS[schema];
  if (!spec) return;
  spec.fields.forEach((f, i) => { const slot = slots[i]; if (slot) slot.textContent = readField(data, f); });
}

// ── Frozen painter dispatch — exactly the 14 catalog types, immutable ─────────────
type Painter = (doc: RDocument, node: IrNode) => RElement;
function paintChildren(doc: RDocument, node: IrNode, into: RElement): void {
  if (node.children) for (const c of node.children) into.appendChild(paintNode(doc, c));
}
/** Paint a fixed-schema card: PCC-owned heading + (optional) read-only warning + one
 * (label, empty value slot) row per field. Heading and labels are FIXED PCC text (never
 * manifest prose → not marked untrusted); only the value slots (filled from the GET by
 * bindSchemaCard) are untrusted. The label set/order is known at paint time. */
function paintSchemaCard(doc: RDocument, rootCls: string, schema: BindSchema): RElement {
  const spec = SCHEMA_FIELDS[schema];
  const e = el(doc, rootCls + " " + CLS.schemaCard);
  e.appendChild(el(doc, CLS.heading, spec.heading));
  if (spec.note) e.appendChild(el(doc, CLS.note, spec.note));
  for (const f of spec.fields) {
    const row = el(doc, CLS.row);
    row.appendChild(el(doc, CLS.field, f.label));
    // Default to the unavailable marker: a card whose GET never lands (auth-gated route,
    // network failure, teardown-before-fetch) honestly shows "—", never an empty partial.
    // bindSchemaCard overwrites on a successful fetch.
    row.appendChild(el(doc, CLS.value, UNAVAILABLE, true));
    e.appendChild(row);
  }
  return e;
}
const PAINTERS: Readonly<Record<IrNodeType, Painter>> = Object.freeze({
  root: (d, n) => { const e = el(d, CLS.root); paintChildren(d, n, e); return e; },
  section: (d, n) => { const e = el(d, CLS.section); paintChildren(d, n, e); return e; },
  heading: (d, n) => el(d, CLS.heading, String(n.props?.text ?? ""), n.untrusted),
  text: (d, n) => el(d, CLS.text, String(n.props?.text ?? ""), n.untrusted),
  stat: (d, n) => {
    const e = el(d, CLS.stat);
    e.appendChild(el(d, CLS.heading, String(n.props?.label ?? ""))); // PCC-owned metric label (trusted)
    e.appendChild(el(d, CLS.value, UNAVAILABLE, true)); // default "—" until a clean GET lands; bindScalar overwrites (fetched, untrusted)
    return e;
  },
  card: (d, n) => {
    const rootCls = CLS.card + (n.props?.kind === "run" ? " pcc-card-run" : " pcc-card-cap");
    const schema = n.bind?.schema;
    if (schema === "capability-summary-v1" || schema === "run-summary-v1") return paintSchemaCard(d, rootCls, schema);
    return el(d, rootCls); // defensive: the adapter always tags a card bind with a schema now
  },
  receipt: (d) => { // STATIC settlement-record pointer — fixed PCC text only (no bind, no value slots, not collected)
    const e = el(d, CLS.receipt);
    e.appendChild(el(d, CLS.heading, SETTLEMENT_NOTICE.heading));
    e.appendChild(el(d, CLS.note, SETTLEMENT_NOTICE.note));
    return e;
  },
  list: (d) => { const e = el(d, CLS.list); return e; }, // rows appended by bindList
  badge: (d, n) => { const e = el(d, CLS.badge, String(n.props?.text ?? ""), true); e.setAttr("data-tone", String(n.props?.tone ?? "neutral")); return e; },
  grid: (d, n) => { const e = el(d, CLS.grid); paintChildren(d, n, e); return e; },
  "approval-notice": (d, n) => el(d, CLS["approval-notice"], String(n.props?.notice ?? "")),
  plan: (d) => el(d, CLS.plan, "Composition (view-only)"),
  "form-summary": (d, n) => { const e = el(d, CLS["form-summary"]); paintChildren(d, n, e); return e; },
  "field-label": (d, n) => el(d, CLS["field-label"], String(n.props?.label ?? ""), true),
});
function paintNode(doc: RDocument, node: IrNode): RElement {
  const p = PAINTERS[node.type];
  if (!p) { return el(doc, CLS.invalid, ""); } // frozen dispatch; unknown type → inert
  return p(doc, node);
}

/** Paint a validated IrDoc into `mount`. Clears mount, appends title then root. */
export function renderIrDoc(doc: RDocument, mount: RElement, ir: IrDoc): void {
  while (mount.children.length) mount.children.pop(); // clear (test fake); browser clears via replaceChildren wrapper in bootIrView
  mount.appendChild(paintNode(doc, ir.title));
  mount.appendChild(paintNode(doc, ir.root));
}

/** Schema-validated dynamic ROW rendering for a list node: read ONLY the declared
 * selectors from each fetched row via own-property traversal; drop rows that yield
 * no title. Every field reaches the DOM via textContent. */
export function bindListRows(doc: RDocument, listEl: RElement, node: IrNode, rows: unknown[]): void {
  const rowTitle = String(node.props?.rowTitle ?? "");
  const rowMeta = Array.isArray(node.props?.rowMeta) ? (node.props!.rowMeta as string[]) : [];
  const statusFrom = typeof node.props?.statusFrom === "string" ? node.props!.statusFrom : "";
  const limit = typeof node.props?.limit === "number" ? node.props!.limit : rows.length;
  let shown = 0;
  for (const row of rows) {
    if (shown >= limit) break;
    if (row === null || typeof row !== "object") continue;
    const title = readSelector(row, rowTitle);
    if (title === "") continue; // drop malformed row (no valid title)
    const line = el(doc, CLS.row);
    line.appendChild(el(doc, CLS.heading, title, true));
    for (const m of rowMeta) { const v = readSelector(row, m); if (v !== "") line.appendChild(el(doc, CLS.meta, v, true)); }
    if (statusFrom) { const s = readSelector(row, statusFrom); if (s !== "") line.appendChild(el(doc, CLS.badge, s, true)); }
    listEl.appendChild(line);
    shown++;
  }
}

/** Fill a STAT value slot from a fetched object via the node's `select` — own-property,
 * text-only. Returns the string written (for tests). (Cards/receipts bind via the fixed
 * PCC schema profiles in bindSchemaCard, NOT a manifest select.) */
export function bindScalar(node: IrNode, data: unknown): string {
  const sel = node.bind?.select;
  if (!sel) return "";
  return readSelector(data, sel);
}

/**
 * Boot: validate the doc IN-BROWSER, then paint. `validate` is the injected
 * `validateIr` (same oracle as the server). On failure, paint ONE inert notice and
 * stop — never partial-render an unvalidated tree.
 */
export function bootIrView(doc: RDocument, mount: RElement, rawDoc: unknown, validate: (d: unknown) => { ok: boolean }): boolean {
  if (!validate(rawDoc).ok) {
    while (mount.children.length) mount.children.pop();
    mount.appendChild(el(doc, CLS.invalid, "This dashboard could not be verified and was not rendered."));
    return false;
  }
  renderIrDoc(doc, mount, rawDoc as IrDoc);
  return true;
}
