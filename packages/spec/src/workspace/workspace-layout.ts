/**
 * WorkspaceLayoutV1: Layer D, durable user presentation preferences.
 *
 * Product pack §3 items 9-10 and §2 "Adaptive workspace". The layout says
 * which trusted components a workspace shows, in what order and size, and a
 * few view options. It carries no protocol data: no amounts, statuses,
 * addresses, hashes or evidence. Customisation therefore cannot mutate truth.
 * In the render-provenance vocabulary (render-provenance.ts) it is
 * `sourceClass: "preference"` and never occupies an authoritative slot.
 *
 * Settled with product-steward (#2587), readmodels (#2731) and genui (#3156):
 * - The shape is closed. Unknown keys are rejected at every level, so no
 *   value can be smuggled in.
 * - `ref` must name a trusted COMPONENT in the catalog (e.g. "pcc.jobs.list",
 *   "pcc.run.summary", "pcc.approval"), never a closed-IR node kind. The
 *   catalog entry fixes the component's routes, fields, labels and source
 *   class; a layout supplies placement only. The catalog is an argument
 *   because genui owns its contents (TRUSTED_COMPONENTS, Wave 4). There is
 *   deliberately no escrow list: money state appears only in per-unit
 *   settlement components.
 * - A catalog component marked `mustShow` cannot be hidden or collapsed. A
 *   component in a must-show state (MUST_SHOW_STATES: a pending approval, an
 *   active e-stop, failed, disputed, refunded or UNKNOWN money, a required
 *   evidence action) is rendered whatever the layout says: mustShowNow().
 * - `view.emphasis` keys must be on some slot's catalog allowlist of optional
 *   fields. They reorder fields; they never change what a field says, and
 *   never move a component's must-show fields (status or tone, the
 *   provenance line, the withheld-prose marker, the "not confirmed by a
 *   settlement read" qualifier, the Approval surface's "This will send"
 *   block) out of view. validateWorkspaceCatalog() keeps the two lists apart.
 * - `focus` is an id the component re-reads from its A/B source. It is
 *   never content.
 * - Agent patches are Layer C until the user accepts them, and are capped
 *   in size (MAX_PATCH_OPS).
 * - `scope` is set by the server from the authenticated principal, never by
 *   a request body. v1 stores kind "user" only.
 *
 * The same pure validator runs in the browser and in the gateway's
 * PUT /api/me/workspaces/:workspace (readmodels), which answers 422 naming
 * the failed invariant.
 *
 * Browser-safe: no Node imports, no runtime dependencies.
 */

export const WORKSPACE_LAYOUT_SCHEMA = "pcc.workspace-layout/v1" as const;

/** The four intent workspaces. The ids are stable; their labels are launch's copy. Route: /app/<id>. */
export const WORKSPACE_IDS = ["get-work-done", "offer-capability", "operate-work", "build-improve"] as const;
export type WorkspaceId = (typeof WORKSPACE_IDS)[number];

export const SLOT_SIZES = ["s", "m", "l", "full"] as const;
export type SlotSize = (typeof SLOT_SIZES)[number];

export const DENSITIES = ["compact", "comfortable"] as const;
export const TECHNICAL_DETAILS = ["hidden", "on-failure", "shown"] as const;

/** At most this many slots in one workspace. */
export const MAX_SLOTS = 48;
/** At most this many operations in one agent-proposed patch. */
export const MAX_PATCH_OPS = 20;

export interface WorkspaceSlot {
  /** A trusted catalog component, e.g. "pcc.jobs.list". */
  ref: string;
  /** An id the component shows (e.g. a job id). Re-read from its source; never content. */
  focus?: string;
  order: number;
  size: SlotSize;
  visible: boolean;
  collapsed?: boolean;
}

export interface WorkspaceView {
  density: (typeof DENSITIES)[number];
  /**
   * "on-failure" shows technical detail only while a Layer A/B read model
   * reports a failure or unavailable state. It keys off typed read-model
   * state, never off UI inference, and never suppresses a failure notice.
   */
  technicalDetails: (typeof TECHNICAL_DETAILS)[number];
  /** Catalog field keys to bring forward, e.g. ["margin"]. */
  emphasis?: string[];
}

export interface WorkspaceScope {
  kind: "user" | "org" | "role" | "context";
  id: string;
}

export interface WorkspaceLayoutV1 {
  schema: typeof WORKSPACE_LAYOUT_SCHEMA;
  /** Assigned by the server from the authenticated principal. */
  scope: WorkspaceScope;
  workspace: WorkspaceId;
  slots: WorkspaceSlot[];
  view: WorkspaceView;
  /** Optimistic-concurrency version, bumped by the server on each accepted PUT. */
  version: number;
  /** ISO-8601: when this layout last changed (the provenance `changedAt`, not a read time). */
  updatedAt: string;
}

/** What a client may send: the server owns scope, version and updatedAt. */
export type WorkspaceLayoutInput = Omit<WorkspaceLayoutV1, "scope" | "version" | "updatedAt">;

/** What an agent may propose (Layer C) until the user accepts it. */
export type WorkspaceLayoutPatchOp =
  | { op: "show" | "hide" | "collapse" | "expand"; ref: string }
  | { op: "move"; ref: string; order: number }
  | { op: "resize"; ref: string; size: SlotSize }
  | { op: "focus"; ref: string; focus: string }
  | { op: "view"; set: Partial<WorkspaceView> };

export interface WorkspaceCatalogEntry {
  /** Can never be hidden or collapsed by a layout or an accepted patch. */
  mustShow?: boolean;
  /** The component's optional fields: the only ones `view.emphasis` may bring forward. */
  emphasis?: readonly string[];
  /**
   * Fields that stay in view whatever the layout or emphasis says: the status
   * or tone field, the provenance line, and markers such as "withheld" or
   * "not confirmed by a settlement read". Never emphasisable.
   */
  mustShowFields?: readonly string[];
}

/**
 * States in which a component is rendered whatever the layout says. Each is
 * read from the component's own A/B source, never inferred by the UI.
 * "money_unknown" is a settlement read the classifier could not verify
 * ("settlement fields disagree", "incomplete settlement record"): hiding "I
 * can't verify this payment" is as bad as hiding a failure (genui #3156).
 */
export const MUST_SHOW_STATES = [
  "approval_pending",
  "estop_active",
  "money_failed",
  "money_disputed",
  "money_refunded",
  "money_unknown",
  "evidence_action_required",
] as const;
export type MustShowState = (typeof MUST_SHOW_STATES)[number];

/**
 * True when a slot must be rendered, expanded, regardless of its `visible`
 * and `collapsed` settings: its component is always-shown, or it currently
 * reports a must-show state.
 */
export function mustShowNow(entry: WorkspaceCatalogEntry | undefined, activeStates: readonly MustShowState[]): boolean {
  return entry?.mustShow === true || activeStates.some((s) => (MUST_SHOW_STATES as readonly string[]).includes(s));
}

/** The trusted component catalog (genui owns its contents), keyed by ref. */
export type WorkspaceCatalog = Readonly<Record<string, WorkspaceCatalogEntry>>;

export type WorkspaceLayoutViolationCode =
  | "bad_shape"
  | "unknown_key"
  | "unknown_ref"
  | "duplicate_ref"
  | "must_show_hidden"
  | "emphasis_not_allowed"
  | "too_many_slots"
  | "patch_too_large"
  | "bad_catalog";

export interface WorkspaceLayoutViolation {
  code: WorkspaceLayoutViolationCode;
  /** JSON-pointer-ish location, e.g. "slots[2].visible". */
  path: string;
  message: string;
}

export type WorkspaceLayoutResult<T> =
  | { ok: true; value: T }
  | { ok: false; violations: WorkspaceLayoutViolation[] };

// ── helpers ──────────────────────────────────────────────────────────────────

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  out: WorkspaceLayoutViolation[],
): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) {
      out.push({ code: "unknown_key", path: path ? `${path}.${k}` : k, message: `"${k}" is not part of a workspace layout` });
    }
  }
}

function bad(path: string, message: string, out: WorkspaceLayoutViolation[]): void {
  out.push({ code: "bad_shape", path, message });
}

function oneOf<T extends string>(v: unknown, options: readonly T[]): v is T {
  return typeof v === "string" && (options as readonly string[]).includes(v);
}

// ── validation ───────────────────────────────────────────────────────────────

function validateSlot(
  raw: unknown,
  i: number,
  catalog: WorkspaceCatalog,
  seen: Set<string>,
  out: WorkspaceLayoutViolation[],
): WorkspaceSlot | null {
  const path = `slots[${i}]`;
  if (!isPlainObject(raw)) {
    bad(path, "a slot must be an object", out);
    return null;
  }
  checkKeys(raw, ["ref", "focus", "order", "size", "visible", "collapsed"], path, out);
  const { ref, focus, order, size, visible, collapsed } = raw;
  let okShape = true;
  if (typeof ref !== "string" || !ID_RE.test(ref)) {
    bad(`${path}.ref`, "ref must be a catalog id", out);
    okShape = false;
  } else if (!Object.prototype.hasOwnProperty.call(catalog, ref)) {
    out.push({ code: "unknown_ref", path: `${path}.ref`, message: `"${ref}" is not in the trusted component catalog` });
    okShape = false;
  } else if (seen.has(ref)) {
    out.push({ code: "duplicate_ref", path: `${path}.ref`, message: `"${ref}" appears more than once` });
    okShape = false;
  }
  if (focus !== undefined && (typeof focus !== "string" || !ID_RE.test(focus))) {
    bad(`${path}.focus`, "focus must be an id (it is re-read from its source, never content)", out);
    okShape = false;
  }
  if (typeof order !== "number" || !Number.isInteger(order) || order < 0) {
    bad(`${path}.order`, "order must be a non-negative integer", out);
    okShape = false;
  }
  if (!oneOf(size, SLOT_SIZES)) {
    bad(`${path}.size`, `size must be one of ${SLOT_SIZES.join(", ")}`, out);
    okShape = false;
  }
  if (typeof visible !== "boolean") {
    bad(`${path}.visible`, "visible must be a boolean", out);
    okShape = false;
  }
  if (collapsed !== undefined && typeof collapsed !== "boolean") {
    bad(`${path}.collapsed`, "collapsed must be a boolean", out);
    okShape = false;
  }
  if (!okShape) return null;
  seen.add(ref as string);
  if (catalog[ref as string]?.mustShow && (visible === false || collapsed === true)) {
    out.push({
      code: "must_show_hidden",
      path,
      message: `"${ref}" asks for a decision or reports a failure; a layout cannot hide or collapse it`,
    });
  }
  const slot: WorkspaceSlot = { ref: ref as string, order: order as number, size: size as SlotSize, visible: visible as boolean };
  if (focus !== undefined) slot.focus = focus as string;
  if (collapsed !== undefined) slot.collapsed = collapsed as boolean;
  return slot;
}

function validateView(
  raw: unknown,
  slots: WorkspaceSlot[],
  catalog: WorkspaceCatalog,
  out: WorkspaceLayoutViolation[],
): WorkspaceView | null {
  if (!isPlainObject(raw)) {
    bad("view", "view must be an object", out);
    return null;
  }
  checkKeys(raw, ["density", "technicalDetails", "emphasis"], "view", out);
  const { density, technicalDetails, emphasis } = raw;
  let ok = true;
  if (!oneOf(density, DENSITIES)) {
    bad("view.density", `density must be one of ${DENSITIES.join(", ")}`, out);
    ok = false;
  }
  if (!oneOf(technicalDetails, TECHNICAL_DETAILS)) {
    bad("view.technicalDetails", `technicalDetails must be one of ${TECHNICAL_DETAILS.join(", ")}`, out);
    ok = false;
  }
  if (emphasis !== undefined) {
    if (!Array.isArray(emphasis) || emphasis.some((k) => typeof k !== "string" || !ID_RE.test(k))) {
      bad("view.emphasis", "emphasis must be a list of field keys", out);
      ok = false;
    } else {
      const allowed = new Set(slots.flatMap((s) => catalog[s.ref]?.emphasis ?? []));
      emphasis.forEach((k, j) => {
        if (!allowed.has(k)) {
          out.push({
            code: "emphasis_not_allowed",
            path: `view.emphasis[${j}]`,
            message: `no component in this workspace lets "${k}" be emphasised`,
          });
        }
      });
    }
  }
  if (!ok) return null;
  const view: WorkspaceView = {
    density: density as WorkspaceView["density"],
    technicalDetails: technicalDetails as WorkspaceView["technicalDetails"],
  };
  if (emphasis !== undefined) view.emphasis = [...(emphasis as string[])];
  return view;
}

/**
 * Validate what a client sends (no scope, version or updatedAt: the server
 * owns those). Returns a normalised copy with slots sorted by order, or every
 * violation found.
 */
export function validateWorkspaceLayoutInput(
  input: unknown,
  catalog: WorkspaceCatalog,
): WorkspaceLayoutResult<WorkspaceLayoutInput> {
  const out: WorkspaceLayoutViolation[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, violations: [{ code: "bad_shape", path: "", message: "a layout must be an object" }] };
  }
  checkKeys(input, ["schema", "workspace", "slots", "view"], "", out);
  if (input.schema !== WORKSPACE_LAYOUT_SCHEMA) bad("schema", `schema must be "${WORKSPACE_LAYOUT_SCHEMA}"`, out);
  if (!oneOf(input.workspace, WORKSPACE_IDS)) bad("workspace", `workspace must be one of ${WORKSPACE_IDS.join(", ")}`, out);

  const slots: WorkspaceSlot[] = [];
  if (!Array.isArray(input.slots)) {
    bad("slots", "slots must be a list", out);
  } else {
    if (input.slots.length > MAX_SLOTS) {
      out.push({ code: "too_many_slots", path: "slots", message: `at most ${MAX_SLOTS} slots` });
    }
    const seen = new Set<string>();
    input.slots.forEach((raw, i) => {
      const s = validateSlot(raw, i, catalog, seen, out);
      if (s) slots.push(s);
    });
  }
  const view = validateView(input.view, slots, catalog, out);

  if (out.length > 0 || !view) return { ok: false, violations: out };
  return {
    ok: true,
    value: {
      schema: WORKSPACE_LAYOUT_SCHEMA,
      workspace: input.workspace as WorkspaceId,
      slots: [...slots].sort((a, b) => a.order - b.order),
      view,
    },
  };
}

/**
 * Checks the catalog itself (genui pins TRUSTED_COMPONENTS to this). Every
 * ref and field key must be an id, and no field may be both emphasisable
 * and must-show: that would let emphasis move a must-show field out of view.
 */
export function validateWorkspaceCatalog(catalog: WorkspaceCatalog): WorkspaceLayoutViolation[] {
  const out: WorkspaceLayoutViolation[] = [];
  for (const [ref, entry] of Object.entries(catalog)) {
    if (!ID_RE.test(ref)) out.push({ code: "bad_catalog", path: ref, message: `"${ref}" is not a component id` });
    for (const name of ["emphasis", "mustShowFields"] as const) {
      (entry[name] ?? []).forEach((k, n) => {
        if (typeof k !== "string" || !ID_RE.test(k)) {
          out.push({ code: "bad_catalog", path: `${ref}.${name}[${n}]`, message: `"${String(k)}" is not a field key` });
        }
      });
    }
    const mustShow = new Set(entry.mustShowFields ?? []);
    (entry.emphasis ?? []).forEach((k, n) => {
      if (mustShow.has(k)) {
        out.push({
          code: "bad_catalog",
          path: `${ref}.emphasis[${n}]`,
          message: `"${k}" is a must-show field of ${ref}; emphasis may reorder only optional fields`,
        });
      }
    });
  }
  return out;
}

/** Validate a stored layout, including the server-owned fields. */
export function validateWorkspaceLayout(input: unknown, catalog: WorkspaceCatalog): WorkspaceLayoutResult<WorkspaceLayoutV1> {
  if (!isPlainObject(input)) {
    return { ok: false, violations: [{ code: "bad_shape", path: "", message: "a layout must be an object" }] };
  }
  const { scope, version, updatedAt, ...rest } = input;
  const base = validateWorkspaceLayoutInput(rest, catalog);
  const out: WorkspaceLayoutViolation[] = base.ok ? [] : [...base.violations];
  if (!isPlainObject(scope) || !oneOf(scope.kind, ["user", "org", "role", "context"] as const) || typeof scope.id !== "string" || !scope.id) {
    bad("scope", "scope must be { kind, id }, assigned by the server", out);
  } else {
    checkKeys(scope, ["kind", "id"], "scope", out);
  }
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) bad("version", "version must be a non-negative integer", out);
  if (typeof updatedAt !== "string" || Number.isNaN(Date.parse(updatedAt))) bad("updatedAt", "updatedAt must be an ISO-8601 time", out);
  if (out.length > 0 || !base.ok) return { ok: false, violations: out };
  return {
    ok: true,
    value: {
      ...base.value,
      scope: { kind: (scope as WorkspaceScope).kind, id: (scope as WorkspaceScope).id },
      version: version as number,
      updatedAt: updatedAt as string,
    },
  };
}

// ── patches ──────────────────────────────────────────────────────────────────

/**
 * Apply an agent-proposed patch to a layout the user is looking at. The
 * result is validated as a whole, so a patch that would hide a mustShow
 * component or name an unknown ref is refused with the same violations the
 * server would return. Pure: the input is not modified.
 */
export function applyWorkspaceLayoutPatch(
  layout: WorkspaceLayoutInput,
  patch: readonly WorkspaceLayoutPatchOp[],
  catalog: WorkspaceCatalog,
): WorkspaceLayoutResult<WorkspaceLayoutInput> {
  if (!Array.isArray(patch)) {
    return { ok: false, violations: [{ code: "bad_shape", path: "patch", message: "a patch must be a list of operations" }] };
  }
  if (patch.length > MAX_PATCH_OPS) {
    return {
      ok: false,
      violations: [{ code: "patch_too_large", path: "patch", message: `at most ${MAX_PATCH_OPS} operations per patch` }],
    };
  }
  const slots = layout.slots.map((s) => ({ ...s }));
  let view: WorkspaceView = { ...layout.view, ...(layout.view.emphasis ? { emphasis: [...layout.view.emphasis] } : {}) };
  const violations: WorkspaceLayoutViolation[] = [];

  patch.forEach((op, i) => {
    if (!isPlainObject(op) || typeof op.op !== "string") {
      violations.push({ code: "bad_shape", path: `patch[${i}]`, message: "an operation must be { op, ... }" });
      return;
    }
    if (op.op === "view") {
      if (!isPlainObject(op.set)) {
        violations.push({ code: "bad_shape", path: `patch[${i}].set`, message: "view patches carry a set object" });
        return;
      }
      view = { ...view, ...(op.set as Partial<WorkspaceView>) };
      return;
    }
    const ref = (op as { ref?: unknown }).ref;
    if (typeof ref !== "string") {
      violations.push({ code: "bad_shape", path: `patch[${i}].ref`, message: "the operation needs a ref" });
      return;
    }
    let slot = slots.find((s) => s.ref === ref);
    if (!slot && op.op === "show") {
      slot = { ref, order: slots.length, size: "m", visible: true };
      slots.push(slot);
      return;
    }
    if (!slot) {
      violations.push({ code: "unknown_ref", path: `patch[${i}].ref`, message: `"${ref}" is not in this layout` });
      return;
    }
    switch (op.op) {
      case "show": slot.visible = true; break;
      case "hide": slot.visible = false; break;
      case "collapse": slot.collapsed = true; break;
      case "expand": slot.collapsed = false; break;
      case "move": slot.order = (op as { order: number }).order; break;
      case "resize": slot.size = (op as { size: SlotSize }).size; break;
      case "focus": slot.focus = (op as { focus: string }).focus; break;
      default:
        violations.push({ code: "bad_shape", path: `patch[${i}].op`, message: `unknown operation "${String(op.op)}"` });
    }
  });
  if (violations.length) return { ok: false, violations };
  return validateWorkspaceLayoutInput({ schema: layout.schema, workspace: layout.workspace, slots, view }, catalog);
}
