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
 *  - NO WRITES, NO HOST BRIDGE: no fetch of non-GET, no __PCC_HOST_BRIDGE__/
 *    __PCC_HOST_OPERATIONS__, no host tools/call. Data binding is GET-only and injected (item 8
 *    wires it). GET reads are not effect-FREE, though: each carries the operational effects listed
 *    in EFFECT_REVIEWED_READS (dashboard-ir.ts) — a facade telemetry event, and, for capability
 *    reads with PCC_FUNNEL_ENABLED=true, a funnel audit row (astra r2 F3; astra r3 L5).
 *
 * Written self-contained (siblings-by-name only) so it can be inlined into the view
 * HTML via `.toString()` — the tested definition and the browser code are one source.
 */
import type { IrDoc, IrNode, IrNodeType, BindSchema, ListFieldKind, MetricFieldKind } from "./dashboard-ir.js";
import { LIST_ROW_CAP, WITHHELD_PROSE, WITHHELD_FIELD, boundValueText, boundStatusText, identifierText, isMoneyClaim, LIST_FIELD_KINDS, reportedFieldText, metricKindForSource } from "./dashboard-ir.js";

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

const CLS: Record<IrNodeType | "untrusted" | "agent" | "withheld" | "invalid" | "value" | "row" | "meta" | "note" | "schemaCard" | "field" | "fieldname", string> = {
  root: "pcc-ir", section: "pcc-section", heading: "pcc-heading", text: "pcc-text",
  stat: "pcc-stat", card: "pcc-card", receipt: "pcc-receipt", list: "pcc-list",
  badge: "pcc-badge", grid: "pcc-grid", "approval-notice": "pcc-approval",
  plan: "pcc-plan", "form-summary": "pcc-form", "field-label": "pcc-field",
  fieldname: "pcc-fieldname",
  untrusted: "pcc-untrusted", agent: "pcc-agent", withheld: "pcc-withheld",
  invalid: "pcc-invalid", value: "pcc-value", row: "pcc-row", meta: "pcc-meta",
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
export const UNAVAILABLE = "—"; // em dash — honest "not available", never a partial fake
// Every field has a `kind`: a closed, typed grammar (astra r3 M3 / #348 r2b F1). `money` STAYS only
// as documentation that a price field shows money as the card's own — it is no longer consulted to
// skip validation: the "amount"/"currency" kinds admit no prose at all, so the withheld notice can
// never be painted there, and a hostile shape (an object, a sentence, "verified" as a currency) is
// rejected like any other mistyped field, never silently displayed.
type FieldKind = "text" | "capType" | "amount" | "currency" | "tiers" | "bool" | "status" | "percent";
interface SchemaField { label: string; key: string | readonly string[]; kind: FieldKind; money?: boolean }
interface SchemaSpec { heading: string; note?: string; fields: readonly SchemaField[] }
// Only the DATA-BEARING cards have a schema (a public/known-shape GET). The settlement
// record is NOT here — it is a static pointer (see SETTLEMENT_NOTICE + the receipt painter).
export const SCHEMA_FIELDS: Readonly<Record<BindSchema, SchemaSpec>> = Object.freeze({
  "capability-summary-v1": Object.freeze({
    heading: "Capability",
    fields: Object.freeze([
      { label: "Name", key: "name", kind: "text" },
      { label: "Type", key: "type", kind: "capType" },
      { label: "Base cost", key: "pricing.baseCost", kind: "amount", money: true },
      { label: "Currency", key: "pricing.currency", kind: "currency", money: true },
      { label: "Assurance tiers", key: "assuranceTiers", kind: "tiers" },
      { label: "Available", key: "available", kind: "bool" },
    ]),
  }),
  "run-summary-v1": Object.freeze({
    heading: "Run",
    // Dual-shape: the /status route returns top-level status/progress; the /jobs/:id detail
    // route returns them under `job`. Both are the KNOWN server shapes — PCC-owned fixed
    // keys (NOT a manifest selector); first present wins.
    fields: Object.freeze([
      { label: "Status", key: ["status", "job.status"], kind: "status" },
      { label: "Progress", key: ["progress", "job.progress"], kind: "percent" },
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

// Grammars for the typed kinds (astra r3 M3 / #348 r2b F1). `amount` admits a finite non-negative
// number OR a canonical decimal string; `capType` is a closed identifier grammar (no spaces, no
// prose); `currency` is the exact spec enum (types/common.ts:27 `Currency`). None of these admit
// arbitrary text, so a hostile "paid 5 USDC" / "verified" / sentence value can never pass as one.
const CAP_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const AMOUNT_STR_RE = /^\d{1,15}(\.\d{1,18})?$/;
const CURRENCY_ENUM: ReadonlySet<string> = new Set(["USDC", "ETH", "DAI", "SOL"]);
type FieldRead = { ok: true; text: string } | { ok: false };

/** Read + type-validate ONE fixed schema field from fetched data. `key` is a fixed own-property
 * selector (or an ordered list of KNOWN server shapes — first PRESENT key wins); NEVER a manifest
 * selector. A key that resolves to no own-property on any candidate is MISSING → the honest
 * unavailable marker (not a type error). A present value that does not match its `kind`'s grammar
 * is MISTYPED → `{ok:false}` (the caller fails the WHOLE card closed, never a partial authoritative
 * card built from one mistyped field). A present, well-typed value is shown per its kind:
 * text/capType/status still pass through boundValueText (content-checked, same as any bound
 * value); amount/currency/tiers/bool/percent have no prose grammar, so they are shown as-is. */
function readField(data: unknown, f: SchemaField): FieldRead {
  const keys = Array.isArray(f.key) ? f.key : [f.key as string];
  let raw: unknown;
  let foundKey: string | null = null;
  for (const k of keys) {
    const v = readOwnPath(data, k);
    if (v !== undefined) { raw = v; foundKey = k; break; }
  }
  if (foundKey === null) return { ok: true, text: UNAVAILABLE };
  switch (f.kind) {
    case "text":
      // astra r5 F1: a free-text schema-card field is attributed ("reported: …"), never shown
      // as PCC's own bare fact — structural, on top of (not instead of) the lexical claim filter
      // reportedFieldText still calls through boundValueText.
      return typeof raw === "string" && raw.length > 0 && raw.length <= 200
        ? { ok: true, text: reportedFieldText(foundKey, raw) } : { ok: false };
    case "capType":
      return typeof raw === "string" && CAP_TYPE_RE.test(raw)
        ? { ok: true, text: identifierText(foundKey, raw) } : { ok: false };
    case "status":
      return typeof raw === "string" && raw.length > 0
        ? { ok: true, text: boundValueText(foundKey, raw) } : { ok: false };
    case "amount":
      // A number must ALSO satisfy the canonical string grammar (astra r4 finding 3): the public
      // Amount contract is a string (spec/types/common.ts), so a JS number is only accepted when
      // its String() form is one PCC itself could have produced. 1e100 stringifies to "1e+100",
      // which AMOUNT_STR_RE refuses — the whole card fails closed, never an off-contract value
      // displayed in a PCC-owned money card. Strings are unchanged (same grammar, directly).
      if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && AMOUNT_STR_RE.test(String(raw))) return { ok: true, text: String(raw) };
      if (typeof raw === "string" && AMOUNT_STR_RE.test(raw)) return { ok: true, text: raw };
      return { ok: false };
    case "currency":
      return typeof raw === "string" && CURRENCY_ENUM.has(raw) ? { ok: true, text: raw } : { ok: false };
    case "tiers":
      return Array.isArray(raw) && raw.every((x) => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 3)
        ? { ok: true, text: raw.join(", ") } : { ok: false };
    case "bool":
      return typeof raw === "boolean" ? { ok: true, text: raw ? "Yes" : "No" } : { ok: false };
    case "percent":
      // An integer 0..100 (astra r6 on #344): progress is the DB's integer column, uptime is 0/50/100.
      return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 100
        ? { ok: true, text: String(raw) } : { ok: false };
    default:
      return { ok: false };
  }
}

/** Fill a fixed-schema card's value slots from fetched data (text-only). PCC owns the field set +
 * order; slot[i] <- the i-th field's fixed key. If ANY present field is mistyped for its `kind`,
 * EVERY slot is set to UNAVAILABLE and this returns false — never a partial card built from one
 * off-type field (astra r3 M3 / #348 r2b F1). Otherwise every slot is filled and this returns
 * true. The caller (dashboard-ir-browser-entry.ts) may ignore the boolean. */
export function bindSchemaCard(schema: BindSchema, data: unknown, slots: Array<{ textContent: string }>): boolean {
  const spec = SCHEMA_FIELDS[schema];
  if (!spec) return false;
  const reads = spec.fields.map((f) => readField(data, f));
  const allOk = reads.every((r) => r.ok);
  reads.forEach((r, i) => {
    const slot = slots[i];
    if (!slot) return;
    slot.textContent = allOk && r.ok ? r.text : UNAVAILABLE;
  });
  return allOk;
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
/** A prose slot. Agent words render as untrusted, visibly agent-authored text (`pcc-agent`). A
 *  withheld slot is PCC's notice: the renderer paints its OWN constant, so the notice never comes
 *  from IR or manifest text, and it is not marked untrusted or agent-authored (astra r2 F4). */
function paintProse(doc: RDocument, cls: string, n: IrNode, key: "text" | "label"): RElement {
  if (n.props?.withheld === true) return el(doc, cls + " " + CLS.withheld, WITHHELD_PROSE);
  return el(doc, cls + " " + CLS.agent, String(n.props?.[key] ?? ""), true);
}
const PAINTERS: Readonly<Record<IrNodeType, Painter>> = Object.freeze({
  root: (d, n) => { const e = el(d, CLS.root); paintChildren(d, n, e); return e; },
  section: (d, n) => { const e = el(d, CLS.section); paintChildren(d, n, e); return e; },
  heading: (d, n) => paintProse(d, CLS.heading, n, "text"),
  text: (d, n) => paintProse(d, CLS.text, n, "text"),
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
  badge: (d, n) => { const e = paintProse(d, CLS.badge, n, "text"); e.setAttr("data-tone", String(n.props?.tone ?? "neutral")); return e; },
  grid: (d, n) => { const e = el(d, CLS.grid); paintChildren(d, n, e); return e; },
  "approval-notice": (d, n) => el(d, CLS["approval-notice"], String(n.props?.notice ?? "")),
  plan: (d) => el(d, CLS.plan, "Composition (view-only)"),
  "form-summary": (d, n) => { const e = el(d, CLS["form-summary"]); paintChildren(d, n, e); return e; },
  "field-label": (d, n) => paintProse(d, CLS["field-label"], n, "label"),
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

// ── PCC-owned list field labels (H2 fix: structural framing) ─────────────────────────────
// A trusted, PCC-authored label precedes every bound list value ("Name:", "Status:", ...), so a
// reader always sees which field a value came from instead of two untrusted values sitting bare
// next to each other with no attribution at all — the structural half of the H2 fix (the row-level
// backstop below is the content half). Closed map; an unknown field falls back to its own path.
const LIST_FIELD_LABELS: Readonly<Record<string, string>> = {
  id: "ID", name: "Name", capabilityId: "Capability", kernelId: "Kernel", status: "Status",
  createdAt: "Created", updatedAt: "Updated", version: "Version", capabilityCount: "Capabilities",
  type: "Type", available: "Available",
};
/** The PCC-owned label for a list field; an unknown field falls back to the field path itself. */
export function listFieldLabel(field: string): string { return LIST_FIELD_LABELS[field] ?? field; }

// Grammars for the list field kinds (astra r4 on #344, finding 1). Each is a closed identifier/
// timestamp/version shape — none admits arbitrary prose, so a hostile "Your payment" can never
// pass as an id, and a hostile "completed" can never pass as a bool.
const LIST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// astra r5 F4: the shape regex alone accepted impossible calendar values ("2026-99-99T99:99:99Z",
// "2026-02-30T00:00:00Z") — same digit COUNT, nonsense MEANING. Captured so timeRoundTrips can
// parse each component and round-trip it through Date.UTC: an out-of-range component can never
// read back equal via getUTC*, since Date's own field-overflow normalization (rolling hour 99
// into the next day, Feb 30 into March, …) always lands on an IN-range value that differs from
// the out-of-range input — no hand-written days-per-month table needed.
const LIST_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
/** The canonical-UTC shape AND a calendar round trip (astra r5 F4). The year is additionally
 *  bounded to 2000..2100: Date.UTC accepts (and round-trips) any year at all, so the shape+
 *  round-trip alone would not catch an out-of-era year. */
function timeRoundTrips(s: string): boolean {
  const m = LIST_TIME_RE.exec(s);
  if (!m) return false;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const hour = Number(m[4]), minute = Number(m[5]), second = Number(m[6]);
  const ms = m[7] ? Number(m[7].padEnd(3, "0")) : 0;
  if (year < 2000 || year > 2100) return false;
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day &&
    d.getUTCHours() === hour && d.getUTCMinutes() === minute && d.getUTCSeconds() === second &&
    d.getUTCMilliseconds() === ms;
}
// A version is a CLOSED, bounded numeric MAJOR.MINOR.PATCH (astra r6 on #344): no prerelease or build
// tag, because those admit words ("1.0.0-paymentreceived"), so a hostile version could carry a claim.
// No leading zeros, at most 9 digits per part, so the value is contract-bounded. Real kernels report
// "1.4.0", "1.3.2", "0.1.0" and "1.5.0" (packages/db/src/seed/kernels.ts), each a bare numeric triple.
const LIST_VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
type ListFieldRead = { ok: true; text: string; raw: unknown } | { ok: false };

/** Read + type-validate ONE list field from a fetched row, by its CLOSED kind (LIST_FIELD_KINDS,
 * dashboard-ir.ts) — never by the selector's name or its ROLE (title/meta/statusFrom; astra r4
 * finding 1: a `statusFrom` like "available" is validated as its OWN kind, bool, not waved through
 * as an ordinary string just because its name doesn't end in "status"). Modelled on readField
 * above. Absent or null is MISSING, not mistyped — the field is simply not shown ({ok:true,
 * text:""}). A PRESENT value that does not match its kind's grammar is MISTYPED → {ok:false}; the
 * caller (bindListRows) fails the WHOLE ROW closed, mirroring bindSchemaCard for cards — never a
 * partial row built from one off-kind value. A well-typed value's TEXT still passes through
 * boundValueText (id/text/capType) or boundStatusText (status) — content-checked, same as any
 * bound value — except bool/time/version/count, which carry no prose grammar and are shown as-is. */
function readListField(row: unknown, field: string): ListFieldRead {
  const raw = readOwnPath(row, field);
  if (raw === undefined || raw === null) return { ok: true, text: "", raw };
  const kind: ListFieldKind | undefined = LIST_FIELD_KINDS[field];
  switch (kind) {
    case "id":
      return typeof raw === "string" && LIST_ID_RE.test(raw) ? { ok: true, text: identifierText(field, raw), raw } : { ok: false };
    case "text":
      // astra r5 F1: attributed, not bare — see reportedFieldText (dashboard-ir.ts).
      return typeof raw === "string" && raw.length > 0 && raw.length <= 200 ? { ok: true, text: reportedFieldText(field, raw), raw } : { ok: false };
    case "status":
      return typeof raw === "string" && raw.length > 0 && raw.length <= 64 ? { ok: true, text: boundStatusText(raw), raw } : { ok: false };
    case "bool":
      return typeof raw === "boolean" ? { ok: true, text: raw ? "Yes" : "No", raw } : { ok: false };
    case "time":
      return typeof raw === "string" && timeRoundTrips(raw) ? { ok: true, text: raw, raw } : { ok: false };
    case "version":
      return typeof raw === "string" && LIST_VERSION_RE.test(raw) ? { ok: true, text: raw, raw } : { ok: false };
    case "count":
      return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 1_000_000 ? { ok: true, text: String(raw), raw } : { ok: false };
    case "capType":
      return typeof raw === "string" && CAP_TYPE_RE.test(raw) ? { ok: true, text: identifierText(field, raw), raw } : { ok: false };
    default:
      return { ok: false }; // not in the exhaustive kind map — listProfileViolation already refuses this field before render
  }
}

/** Schema-validated dynamic ROW rendering for a list node: every field a list profile allows has
 * exactly ONE closed KIND (LIST_FIELD_KINDS, dashboard-ir.ts), read and type-validated by
 * `readListField`, never by the selector's name or its role (title/meta/statusFrom — astra r4
 * finding 1). An ABSENT field (undefined/null) is simply not shown; a PRESENT but MISTYPED field
 * fails the WHOLE ROW closed — every displayed value becomes UNAVAILABLE, including the title,
 * though the row's PCC-owned labels still render (mirrors bindSchemaCard for cards: never a
 * partial row built from one off-kind value). Every value still reaches the DOM via textContent,
 * framed by its own trusted PCC label (title/meta/status keep their original heading/meta/badge
 * classes on the VALUE element; the label is a separate, trusted, untrusted-free sibling).
 * Row-level backstop (astra r3 H2; astra r4 finding 2, "without the escape"): a claim split across
 * this row's OWN bound fields ("$" as the title, "100" as a meta value) is caught by joining every
 * DISPLAYED value that is not already WITHHELD_FIELD and re-checking the joined text, even though
 * neither value alone was a claim. A status-kind value (by KIND, never by name or role) joins its
 * RAW value and is never itself withheld here — boundStatusText already qualifies it. There is no
 * row-wide `alreadyWithheld` escape: excluding an already-withheld FRAGMENT from the join is enough
 * on its own, so one individually-withheld value never disables the check for the rest of the row.
 * This is the structural boundary; the lexical claim/pair detectors it calls (isMoneyClaim,
 * boundStatusText's SAFE_STATUS_WORDS) remain defense in depth, not the only gate. */
export function bindListRows(doc: RDocument, listEl: RElement, node: IrNode, rows: unknown[]): void {
  const rowTitle = String(node.props?.rowTitle ?? "");
  const rowMeta = Array.isArray(node.props?.rowMeta) ? (node.props!.rowMeta as string[]) : [];
  const statusFrom = typeof node.props?.statusFrom === "string" ? node.props!.statusFrom : "";
  // Hard DOM-node cap whatever the manifest says: omitting `limit` must not lift it.
  const limit = Math.min(typeof node.props?.limit === "number" ? node.props!.limit : LIST_ROW_CAP, LIST_ROW_CAP);
  const isStatusKind = (field: string): boolean => LIST_FIELD_KINDS[field] === "status";
  type Cell = { field: string; read: ListFieldRead };
  let shown = 0;
  for (const row of rows) {
    if (shown >= limit) break;
    if (row === null || typeof row !== "object") continue;

    const titleRead = readListField(row, rowTitle);
    if (titleRead.ok && titleRead.text === "") continue; // drop row: title ABSENT (never a mistyped one)

    const metaCells: Cell[] = rowMeta
      .map((field) => ({ field, read: readListField(row, field) }))
      .filter((c) => !(c.read.ok && c.read.text === "")); // an absent meta field is simply not shown
    const statusReadRaw = statusFrom ? readListField(row, statusFrom) : null;
    const statusCell: Cell | null = statusReadRaw && !(statusReadRaw.ok && statusReadRaw.text === "") ? { field: statusFrom, read: statusReadRaw } : null;

    const titleCell: Cell = { field: rowTitle, read: titleRead };
    const allCells = statusCell ? [titleCell, ...metaCells, statusCell] : [titleCell, ...metaCells];
    // A mistyped field fails the WHOLE ROW closed (astra r4 finding 1), mirroring bindSchemaCard
    // for cards: never a partial row built from one off-kind value. The row's PCC labels still
    // render; every value shows UNAVAILABLE instead.
    const rowOk = allCells.every((c) => c.read.ok);
    const texts = new Map<Cell, string>(allCells.map((c) => [c, rowOk && c.read.ok ? c.read.text : UNAVAILABLE]));

    if (rowOk) {
      // The row backstop (astra r3 H2; astra r4 finding 2 "without the escape"; astra r5 finding
      // 1). A field is "status" OR "text" by its CLOSED KIND (LIST_FIELD_KINDS), never by role or
      // selector name: EACH joins its RAW value here, never its DISPLAY text (boundStatusText's
      // note, or reportedFieldText's "reported: " prefix) — so a claim split across fields is
      // still caught by the field's actual words, not by PCC's own added framing. Neither kind is
      // itself withheld BY THIS BACKSTOP: a status word is already qualified by boundStatusText,
      // and a text claim is already withheld by reportedFieldText/boundValueText individually. A
      // claim the statuses make on their own is already noted by boundStatusText, so it never
      // withholds an innocent title (the `!isMoneyClaim(statusRaw...)` guard on crossClaim,
      // unchanged from the prior design).
      const rawOf = (c: Cell): string | null => {
        const r = c.read.ok ? (c.read as { ok: true; raw: unknown }).raw : undefined;
        return typeof r === "string" ? r : null;
      };
      const nonStatusCells = allCells.filter((c) => !isStatusKind(c.field));
      const statusRaw = allCells.filter((c) => isStatusKind(c.field)).map(rawOf).filter((r): r is string => r !== null);
      const nonStatusDisplayed = nonStatusCells.filter((c) => texts.get(c) !== WITHHELD_FIELD);
      // Every ATTRIBUTED kind (text, id, capType) joins by its RAW value, never the "reported: " display,
      // so the inserted word cannot widen the pair window and hide a claim split across fields.
      const isAttributedKind = (field: string): boolean => { const k = LIST_FIELD_KINDS[field]; return k === "text" || k === "id" || k === "capType"; };
      const joinTextOf = (c: Cell): string => (isAttributedKind(c.field) ? rawOf(c) ?? texts.get(c)! : texts.get(c)!);
      const joined = [...nonStatusDisplayed.map(joinTextOf), ...statusRaw];
      const nonStatusClaim = nonStatusDisplayed.length > 1 && isMoneyClaim(nonStatusDisplayed.map(joinTextOf).join(" "));
      const crossClaim = statusRaw.length > 0 && isMoneyClaim(joined.join(" ")) && !isMoneyClaim(statusRaw.join(" "));
      if (nonStatusClaim || crossClaim) for (const c of nonStatusCells) texts.set(c, WITHHELD_FIELD);
    }

    const line = el(doc, CLS.row);
    line.appendChild(el(doc, CLS.fieldname, listFieldLabel(rowTitle) + ":"));
    line.appendChild(el(doc, CLS.heading, texts.get(titleCell)!, true));
    for (const c of metaCells) {
      line.appendChild(el(doc, CLS.fieldname, listFieldLabel(c.field) + ":"));
      line.appendChild(el(doc, CLS.meta, texts.get(c)!, true));
    }
    if (statusCell) {
      line.appendChild(el(doc, CLS.fieldname, listFieldLabel(statusFrom) + ":"));
      line.appendChild(el(doc, CLS.badge, texts.get(statusCell)!, true));
    }
    listEl.appendChild(line);
    shown++;
  }
}

/** Fill a STAT value slot from a fetched object via the node's `select` — own-property,
 * text-only, TYPE-VALIDATED by the field's closed kind (astra r5 F2: every METRIC_PROFILE field
 * now carries a `kind`, mirroring LIST_FIELD_KINDS's discipline for list rows). `select` is
 * always the REAL SOURCE path the adapter rewrote it to (e.g. "kernel.reputation"), so looking it
 * up against the SAME (route, source) → field map the validator mirrors is exact, not a guess.
 * off-kind (wrong JS type, or a value failing its kind's grammar) is UNAVAILABLE — never shown
 * merely because boundValueText didn't independently recognise it as a claim. (Cards/receipts
 * bind via the fixed PCC schema profiles in bindSchemaCard, NOT a manifest select.) */
export function bindScalar(node: IrNode, data: unknown): string {
  const sel = node.bind?.select;
  const path = node.bind?.path;
  if (typeof sel !== "string" || typeof path !== "string") return UNAVAILABLE;
  const kind: MetricFieldKind | null = metricKindForSource(path, sel);
  if (!kind) return UNAVAILABLE; // not an allowlisted (route, source) metric field — fail closed
  const raw = readOwnPath(data, sel);
  switch (kind) {
    case "status":
      // a status word is qualified, never shown bare unless on the closed safe list (#3013)
      return typeof raw === "string" && raw.length > 0 && raw.length <= 64 ? boundStatusText(raw) : UNAVAILABLE;
    case "text":
      // attributed, not bare (astra r5 F1) — on top of, not instead of, the lexical claim filter
      return typeof raw === "string" && raw.length > 0 && raw.length <= 200 ? reportedFieldText(sel, raw) : UNAVAILABLE;
    case "bool":
      return typeof raw === "boolean" ? (raw ? "Yes" : "No") : UNAVAILABLE;
    case "percent":
      // An integer 0..100 (astra r6 on #344): progress is the DB's integer column, uptime is 0/50/100.
      return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 100 ? String(raw) : UNAVAILABLE;
    case "count":
      return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? String(raw) : UNAVAILABLE;
    case "id":
      return typeof raw === "string" && LIST_ID_RE.test(raw) ? identifierText(sel, raw) : UNAVAILABLE;
    case "time":
      return typeof raw === "string" && timeRoundTrips(raw) ? raw : UNAVAILABLE;
    case "version":
      return typeof raw === "string" && LIST_VERSION_RE.test(raw) ? raw : UNAVAILABLE;
    default:
      return UNAVAILABLE; // exhaustive over MetricFieldKind; defensive fallback mirrors readField's
  }
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
