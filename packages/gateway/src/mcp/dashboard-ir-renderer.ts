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
import type { IrDoc, IrNode, IrNodeType } from "./dashboard-ir.ts";

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

const CLS: Record<IrNodeType | "untrusted" | "invalid" | "value" | "row" | "meta", string> = {
  root: "pcc-ir", section: "pcc-section", heading: "pcc-heading", text: "pcc-text",
  stat: "pcc-stat", card: "pcc-card", receipt: "pcc-receipt", list: "pcc-list",
  badge: "pcc-badge", grid: "pcc-grid", "approval-notice": "pcc-approval",
  plan: "pcc-plan", "form-summary": "pcc-form", "field-label": "pcc-field",
  untrusted: "pcc-untrusted", invalid: "pcc-invalid", value: "pcc-value", row: "pcc-row", meta: "pcc-meta",
};

/** own-property scalar read via a dotted selector (NO prototype traversal). Returns
 * "" for anything not a plain own scalar. The selector was already grammar-checked
 * by the adapter/validator; this re-guards proto segments defensively. */
function readSelector(obj: unknown, sel: string): string {
  let cur: unknown = obj;
  const segs = sel.split(".");
  for (const seg of segs) {
    if (seg === "__proto__" || seg === "constructor" || seg === "prototype") return "";
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return "";
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return "";
    cur = (cur as Record<string, unknown>)[seg];
  }
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

// ── Frozen painter dispatch — exactly the 14 catalog types, immutable ─────────────
type Painter = (doc: RDocument, node: IrNode) => RElement;
function paintChildren(doc: RDocument, node: IrNode, into: RElement): void {
  if (node.children) for (const c of node.children) into.appendChild(paintNode(doc, c));
}
const PAINTERS: Readonly<Record<IrNodeType, Painter>> = Object.freeze({
  root: (d, n) => { const e = el(d, CLS.root); paintChildren(d, n, e); return e; },
  section: (d, n) => { const e = el(d, CLS.section); paintChildren(d, n, e); return e; },
  heading: (d, n) => el(d, CLS.heading, String(n.props?.text ?? ""), n.untrusted),
  text: (d, n) => el(d, CLS.text, String(n.props?.text ?? ""), n.untrusted),
  stat: (d, n) => {
    const e = el(d, CLS.stat);
    e.appendChild(el(d, CLS.heading, String(n.props?.label ?? ""), true));
    e.appendChild(el(d, CLS.value, "", true)); // value slot filled by bindStat (fetched, untrusted)
    return e;
  },
  card: (d, n) => el(d, CLS.card + (n.props?.kind === "run" ? " pcc-card-run" : " pcc-card-cap")),
  receipt: (d) => { const e = el(d, CLS.receipt); e.appendChild(el(d, CLS.value, "", true)); return e; },
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

/** Fill a stat/receipt value slot from a fetched object via the node's `select`
 * (stat) — own-property, text-only. Returns the string written (for tests). */
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
