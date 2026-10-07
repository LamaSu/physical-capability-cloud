/**
 * PlanEditIntent (product pack section 5, item 10): safe user edits made against a PlanPresentation,
 * before acceptance, become new constraints/intents for the CALLER's OWN agent — never a mutation of
 * any plan. Dragging a graph does not mutate execution semantics (layout is never a constraint).
 *
 * This module never applies an edit to a plan: PCC is not the planner ("AGENTS SYNTHESIZE; PCC
 * ENFORCES"). It only turns a batch of untyped user edits into a typed, normalized request the
 * caller's agent can re-plan against. The UI is not authority: this function produces no plan, no
 * submission, no price, no payer, and no operator or tier ASSIGNMENT — only exclusions and bounds.
 *
 * `presentation` is the server's own read model (already validated by `presentPlan`): it is read
 * directly, trusting its type. `edits` is untrusted client input (`unknown`): every edit is read ONCE
 * into owned primitives inside one try/catch that never inspects the thrown value, mirroring the
 * read-once discipline of plan-presentation.ts's `listOf`/`need` (helpers are copied locally, never
 * imported, so #357 is never touched).
 */

import { SETTLEMENT_TOKEN_DECIMALS } from "@pcc/spec";
import type { Money, PlanPresentation, PlanState } from "./plan-presentation.js";

export type PlanEditOp =
  | { op: "exclude-capability"; nodeId: string; capabilityId: string } // do not use this capability for that node
  | { op: "exclude-operator"; operator: string } // never this operator (0x + 40 hex)
  | { op: "max-node-price"; nodeId: string; maxBaseUnits: string } // canonical positive base-unit decimal STRING
  | { op: "max-total"; maxBaseUnits: string }
  | { op: "min-tier"; nodeId: string; tier: number } // integer 0..3
  | { op: "remove-node"; nodeId: string } // ask the agent to drop a step
  | { op: "note"; nodeId?: string; text: string } // a preference in words; never authority
  | { op: "move-node"; nodeId: string; x: number; y: number } // LAYOUT ONLY
  | { op: "collapse"; nodeId: string; collapsed: boolean }; // LAYOUT ONLY

export type PlanConstraint =
  | { kind: "exclude-capability"; nodeId: string; capabilityId: string }
  | { kind: "exclude-operator"; operator: string } // lowercased
  | { kind: "max-node-price"; nodeId: string; max: Money } // currency and decimals FROM THE PRESENTATION, never the edit
  | { kind: "max-total"; max: Money }
  | { kind: "min-tier"; nodeId: string; tier: number }
  | { kind: "remove-node"; nodeId: string }
  | { kind: "note"; nodeId: string | null; text: string; authority: "none" };

export type LayoutPreference = { kind: "position"; nodeId: string; x: number; y: number } | { kind: "collapsed"; nodeId: string; collapsed: boolean };

export type EditRefusal = "unreadable" | "unknown-op" | "unknown-node" | "malformed-value" | "plan-sealed" | "presentation-invalid" | "no-money-context" | "too-many-edits";

export interface PlanEditIntent {
  schema: "pcc.plan-edit-intent.v1";
  /** The presentation the edits were made against (copied from it, never from the edits). */
  basis: { requestId: string | null; reservationId: string | null; planId: string | null; asOf: string; layer: "B" | "C"; state: PlanState };
  /** For the CALLER's agent to re-plan against. PCC never applies these to any plan. */
  constraints: PlanConstraint[];
  /** Layout only (layers D/E): never plan semantics. */
  layout: LayoutPreference[];
  /** Every edit that did not become a constraint or a layout preference, with a typed reason. */
  refused: Array<{ index: number; op: string | null; reason: EditRefusal }>;
}

const MAX_EDITS = 256;

// ── Read-once primitives, modeled on plan-presentation.ts's own (copied, not imported: #357 must not
//    change). Predicates never throw; they only inspect a value already read out of owned data. ─────

function isStr(x: unknown): x is string {
  return typeof x === "string";
}
function isFiniteNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}
function isTier(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 3;
}
function isBool(x: unknown): x is boolean {
  return typeof x === "boolean";
}
function isNonNegInt(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0;
}
function isNonEmptyStr(x: unknown): x is string {
  return typeof x === "string" && x.length > 0;
}
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const MAX_BASE_UNITS_RE = /^[1-9][0-9]{0,77}$/;
const OPERATOR_RE = /^0x[0-9a-fA-F]{40}$/;
const CAPABILITY_ID_RE = /^[\x21-\x7e]{1,128}$/;

/** A string of 1..500 UTF-16 units with no control characters below 0x20 except \n. */
function isValidNoteText(x: unknown): x is string {
  if (typeof x !== "string" || x.length < 1 || x.length > 500) return false;
  for (let i = 0; i < x.length; i++) {
    const code = x.charCodeAt(i);
    if (code < 0x20 && code !== 0x0a) return false;
  }
  return true;
}

const KNOWN_OPS = new Set(["exclude-capability", "exclude-operator", "max-node-price", "max-total", "min-tier", "remove-node", "note", "move-node", "collapse"]);
const LAYOUT_OPS = new Set(["move-node", "collapse"]);

/**
 * Money context for max-node-price/max-total. The CURRENCY comes only from the presentation: the
 * compiled preview's, or else the one live currency the server re-read for every node that has live
 * terms (two different live currencies mean the plan needs a requote: no context). The DECIMALS come
 * only from the server's own settlement-token table for that currency, never from the edit, and a
 * preview that disagrees with the table is not trusted. So price edits work before compilation too,
 * which is when a user most needs them.
 */
type MoneyContext = { currency: string; decimals: number };

function moneyContext(hasPreview: boolean, gross: unknown, liveCurrencies: ReadonlySet<string>): MoneyContext | null {
  const g = typeof gross === "object" && gross !== null ? (gross as { currency?: unknown; decimals?: unknown }) : null;
  let currency: string;
  if (hasPreview) {
    const c: unknown = g?.currency;
    if (!isNonEmptyStr(c)) return null;
    currency = c;
  } else {
    if (liveCurrencies.size !== 1) return null;
    currency = [...liveCurrencies][0]!;
  }
  if (!Object.prototype.hasOwnProperty.call(SETTLEMENT_TOKEN_DECIMALS, currency)) return null;
  const decimals = SETTLEMENT_TOKEN_DECIMALS[currency]!;
  if (hasPreview && g?.decimals !== decimals) return null;
  return { currency, decimals };
}

/**
 * Everything the edits are judged against, read from the presentation ONCE, into owned data, before
 * the untrusted edits are touched. Nothing after this reads the presentation again, so code that runs
 * while the edits are read (a getter on the array or on an edit) cannot change what was decided: the
 * gates (sealed, invalid), the node list, the money context and the basis all come from this one read.
 *
 * A node list that is not an array, or that holds anything but nodes with a string id, is not a
 * presentation to act on: it is invalid, so no semantic edit passes and no node is known. A
 * presentation that cannot be read at all is the same, and never throws.
 */
interface Facts {
  basis: PlanEditIntent["basis"];
  /** Layer B or state "sealed": the accepted deal, which no semantic edit may touch. */
  sealed: boolean;
  invalid: boolean;
  knownNodeIds: ReadonlySet<string>;
  money: MoneyContext | null;
}

function readFacts(presentation: PlanPresentation): Facts {
  try {
    const state = presentation.state;
    const layer = presentation.layer;
    const basis = {
      requestId: presentation.requestId,
      reservationId: presentation.reservationId,
      planId: presentation.planId ?? null,
      asOf: presentation.asOf,
      layer,
      state,
    };
    const preview = presentation.preview;
    const gross: unknown = preview ? preview.gross : undefined;
    const nodesRaw: unknown = presentation.nodes;
    const knownNodeIds = new Set<string>();
    const liveCurrencies = new Set<string>();
    let nodesReadable = Array.isArray(nodesRaw);
    if (Array.isArray(nodesRaw)) {
      for (const node of nodesRaw) {
        if (typeof node !== "object" || node === null) {
          nodesReadable = false;
          continue;
        }
        const id: unknown = (node as { nodeId?: unknown }).nodeId;
        if (isStr(id)) knownNodeIds.add(id);
        else nodesReadable = false;
        const live: unknown = (node as { live?: unknown }).live;
        if (typeof live === "object" && live !== null) {
          const currency: unknown = (live as { currency?: unknown }).currency;
          if (isNonEmptyStr(currency)) liveCurrencies.add(currency);
        }
      }
    }
    return {
      basis,
      sealed: state === "sealed" || layer === "B",
      invalid: state === "invalid" || !nodesReadable,
      knownNodeIds,
      money: moneyContext(Boolean(preview), gross, liveCurrencies),
    };
  } catch {
    return { basis: { requestId: null, reservationId: null, planId: null, asOf: "", layer: "C", state: "invalid" }, sealed: false, invalid: true, knownNodeIds: new Set(), money: null };
  }
}

type EditOutcome = { kind: "constraint"; constraint: PlanConstraint } | { kind: "layout"; pref: LayoutPreference } | { kind: "refused"; op: string | null; reason: EditRefusal };

/**
 * Read ONE edit (`editsArr[index]`) once into owned primitives inside a single try/catch that never
 * inspects the thrown value: any getter that throws, anywhere in the edit, makes it "unreadable". Once
 * a field is safely in hand, every further check below is a pure, non-throwing predicate.
 */
function processEdit(editsArr: unknown[], index: number, knownNodeIds: ReadonlySet<string>, sealed: boolean, invalidPresentation: boolean, money: MoneyContext | null): EditOutcome {
  let rawOp: unknown;
  try {
    const raw = editsArr[index] as Record<string, unknown>;
    rawOp = raw.op;
    if (!isStr(rawOp) || !KNOWN_OPS.has(rawOp)) {
      return { kind: "refused", op: isStr(rawOp) ? rawOp : null, reason: "unknown-op" };
    }
    const op = rawOp;

    // Layout ops: never gated by sealed/invalid ("dragging a graph does not mutate execution semantics").
    if (LAYOUT_OPS.has(op)) {
      const rawNodeId = raw.nodeId;
      if (!isStr(rawNodeId) || !knownNodeIds.has(rawNodeId)) return { kind: "refused", op, reason: "unknown-node" };
      if (op === "move-node") {
        const rawX = raw.x;
        const rawY = raw.y;
        if (!isFiniteNum(rawX) || !isFiniteNum(rawY)) return { kind: "refused", op, reason: "malformed-value" };
        return { kind: "layout", pref: { kind: "position", nodeId: rawNodeId, x: rawX, y: rawY } };
      }
      const rawCollapsed = raw.collapsed;
      if (!isBool(rawCollapsed)) return { kind: "refused", op, reason: "malformed-value" };
      return { kind: "layout", pref: { kind: "collapsed", nodeId: rawNodeId, collapsed: rawCollapsed } };
    }

    // Every SEMANTIC edit against a sealed (accepted) or invalid plan is refused, unconditionally.
    if (sealed) return { kind: "refused", op, reason: "plan-sealed" };
    if (invalidPresentation) return { kind: "refused", op, reason: "presentation-invalid" };

    if (op === "exclude-capability") {
      const rawNodeId = raw.nodeId;
      const rawCapabilityId = raw.capabilityId;
      if (!isStr(rawNodeId) || !knownNodeIds.has(rawNodeId)) return { kind: "refused", op, reason: "unknown-node" };
      if (!isStr(rawCapabilityId) || !CAPABILITY_ID_RE.test(rawCapabilityId)) return { kind: "refused", op, reason: "malformed-value" };
      return { kind: "constraint", constraint: { kind: "exclude-capability", nodeId: rawNodeId, capabilityId: rawCapabilityId } };
    }

    if (op === "exclude-operator") {
      const rawOperator = raw.operator;
      if (!isStr(rawOperator) || !OPERATOR_RE.test(rawOperator)) return { kind: "refused", op, reason: "malformed-value" };
      return { kind: "constraint", constraint: { kind: "exclude-operator", operator: rawOperator.toLowerCase() } };
    }

    if (op === "max-node-price") {
      const rawNodeId = raw.nodeId;
      const rawMax = raw.maxBaseUnits;
      if (!isStr(rawNodeId) || !knownNodeIds.has(rawNodeId)) return { kind: "refused", op, reason: "unknown-node" };
      if (!isStr(rawMax) || !MAX_BASE_UNITS_RE.test(rawMax)) return { kind: "refused", op, reason: "malformed-value" };
      if (!money) return { kind: "refused", op, reason: "no-money-context" };
      return { kind: "constraint", constraint: { kind: "max-node-price", nodeId: rawNodeId, max: { baseUnits: rawMax, currency: money.currency, decimals: money.decimals } } };
    }

    if (op === "max-total") {
      const rawMax = raw.maxBaseUnits;
      if (!isStr(rawMax) || !MAX_BASE_UNITS_RE.test(rawMax)) return { kind: "refused", op, reason: "malformed-value" };
      if (!money) return { kind: "refused", op, reason: "no-money-context" };
      return { kind: "constraint", constraint: { kind: "max-total", max: { baseUnits: rawMax, currency: money.currency, decimals: money.decimals } } };
    }

    if (op === "min-tier") {
      const rawNodeId = raw.nodeId;
      const rawTier = raw.tier;
      if (!isStr(rawNodeId) || !knownNodeIds.has(rawNodeId)) return { kind: "refused", op, reason: "unknown-node" };
      if (!isTier(rawTier)) return { kind: "refused", op, reason: "malformed-value" };
      return { kind: "constraint", constraint: { kind: "min-tier", nodeId: rawNodeId, tier: rawTier } };
    }

    if (op === "remove-node") {
      const rawNodeId = raw.nodeId;
      if (!isStr(rawNodeId) || !knownNodeIds.has(rawNodeId)) return { kind: "refused", op, reason: "unknown-node" };
      return { kind: "constraint", constraint: { kind: "remove-node", nodeId: rawNodeId } };
    }

    // note: nodeId is OPTIONAL — absent or null means a plan-wide note, never "unknown-node".
    const rawNodeId = raw.nodeId;
    const rawText = raw.text;
    let nodeId: string | null = null;
    if (rawNodeId !== undefined && rawNodeId !== null) {
      if (!isStr(rawNodeId) || !knownNodeIds.has(rawNodeId)) return { kind: "refused", op, reason: "unknown-node" };
      nodeId = rawNodeId;
    }
    if (!isValidNoteText(rawText)) return { kind: "refused", op, reason: "malformed-value" };
    return { kind: "constraint", constraint: { kind: "note", nodeId, text: rawText, authority: "none" } };
  } catch {
    return { kind: "refused", op: isStr(rawOp) ? rawOp : null, reason: "unreadable" };
  }
}

const KIND_RANK: Record<PlanConstraint["kind"], number> = {
  "exclude-capability": 0,
  "exclude-operator": 1,
  "max-node-price": 2,
  "max-total": 3,
  "min-tier": 4,
  "remove-node": 5,
  note: 6,
};

/**
 * Pure and total: never throws, never mutates `presentation` or `edits`, and never produces a plan, a
 * submission, a price, a payer, or an operator/tier ASSIGNMENT. Constraints are exclusions and bounds
 * only; layout is never a constraint.
 *
 * Order. The constraints and the layout depend on WHAT was edited, not on the order of the edits, with
 * exactly two exceptions: distinct notes keep their input order (an exact duplicate keeps the first),
 * and layout edits for the same node and kind are last-write-wins. `refused` carries each edit's input
 * index, so it follows the input order too.
 */
export function planEditsToIntent(presentation: PlanPresentation, edits: unknown): PlanEditIntent {
  // The presentation is read once, here, before the untrusted `edits` are touched (see `Facts`).
  const { basis, sealed, invalid: invalidPresentation, knownNodeIds, money } = readFacts(presentation);
  const schema = "pcc.plan-edit-intent.v1" as const;

  // `edits` may be a Proxy: Array.isArray throws on a revoked one, and a proxied `length` can throw or
  // lie. So both are read once, guarded, and the length must be a safe non-negative integer.
  const unreadable = (): PlanEditIntent => ({ schema, basis, constraints: [], layout: [], refused: [{ index: 0, op: null, reason: "unreadable" }] });
  let n: number;
  try {
    if (!Array.isArray(edits)) return unreadable();
    const len: unknown = edits.length;
    if (typeof len !== "number" || !Number.isSafeInteger(len) || len < 0) return unreadable();
    n = len;
  } catch {
    return unreadable();
  }
  // Over the limit, the batch is refused as a whole with ONE entry (at the first position past the
  // limit): the work never grows with a caller-chosen length (a sparse array can claim 2^32 - 1).
  if (n > MAX_EDITS) return { schema, basis, constraints: [], layout: [], refused: [{ index: MAX_EDITS, op: null, reason: "too-many-edits" }] };

  const refused: PlanEditIntent["refused"] = [];
  const excludeCapability = new Map<string, { nodeId: string; capabilityId: string }>();
  const excludeOperator = new Map<string, { operator: string }>();
  const maxNodePrice = new Map<string, bigint>();
  let maxTotal: bigint | null = null;
  const minTierByNode = new Map<string, number>();
  const removeNode = new Set<string>();
  const noteSeen = new Set<string>();
  const notesInOrder: Array<{ nodeId: string | null; text: string }> = [];
  const layoutPosition = new Map<string, { x: number; y: number }>();
  const layoutCollapsed = new Map<string, boolean>();

  for (let i = 0; i < n; i++) {
    const outcome = processEdit(edits, i, knownNodeIds, sealed, invalidPresentation, money);
    if (outcome.kind === "refused") {
      refused.push({ index: i, op: outcome.op, reason: outcome.reason });
      continue;
    }
    if (outcome.kind === "layout") {
      if (outcome.pref.kind === "position") layoutPosition.set(outcome.pref.nodeId, { x: outcome.pref.x, y: outcome.pref.y });
      else layoutCollapsed.set(outcome.pref.nodeId, outcome.pref.collapsed);
      continue;
    }
    const c = outcome.constraint;
    switch (c.kind) {
      case "exclude-capability":
        excludeCapability.set(`${c.nodeId}\u0000${c.capabilityId}`, { nodeId: c.nodeId, capabilityId: c.capabilityId });
        break;
      case "exclude-operator":
        excludeOperator.set(c.operator, { operator: c.operator });
        break;
      case "max-node-price": {
        const v = BigInt(c.max.baseUnits);
        const cur = maxNodePrice.get(c.nodeId);
        if (cur === undefined || v < cur) maxNodePrice.set(c.nodeId, v);
        break;
      }
      case "max-total": {
        const v = BigInt(c.max.baseUnits);
        if (maxTotal === null || v < maxTotal) maxTotal = v;
        break;
      }
      case "min-tier": {
        const cur = minTierByNode.get(c.nodeId);
        if (cur === undefined || c.tier > cur) minTierByNode.set(c.nodeId, c.tier);
        break;
      }
      case "remove-node":
        removeNode.add(c.nodeId);
        break;
      case "note": {
        // null (plan-wide) and "" (a node whose id is empty) are different scopes: the key is a tuple.
        const key = JSON.stringify([c.nodeId, c.text]);
        if (!noteSeen.has(key)) {
          noteSeen.add(key);
          notesInOrder.push({ nodeId: c.nodeId, text: c.text });
        }
        break;
      }
    }
  }

  // `money` is guaranteed non-null here whenever maxNodePrice/maxTotal has entries: processEdit only
  // ever produces those constraint kinds after itself checking `money` was non-null.
  const constraints: PlanConstraint[] = [];
  constraints.push(
    ...[...excludeCapability.values()].sort((a, b) => cmp(a.nodeId, b.nodeId) || cmp(a.capabilityId, b.capabilityId)).map((v): PlanConstraint => ({ kind: "exclude-capability", ...v })),
  );
  constraints.push(...[...excludeOperator.values()].sort((a, b) => cmp(a.operator, b.operator)).map((v): PlanConstraint => ({ kind: "exclude-operator", ...v })));
  constraints.push(
    ...[...maxNodePrice.entries()]
      .sort(([nodeA, valA], [nodeB, valB]) => cmp(nodeA, nodeB) || (valA < valB ? -1 : valA > valB ? 1 : 0))
      .map(([nodeId, v]): PlanConstraint => ({ kind: "max-node-price", nodeId, max: { baseUnits: v.toString(), currency: money!.currency, decimals: money!.decimals } })),
  );
  if (maxTotal !== null) constraints.push({ kind: "max-total", max: { baseUnits: maxTotal.toString(), currency: money!.currency, decimals: money!.decimals } });
  constraints.push(
    ...[...minTierByNode.entries()].sort(([nodeA, tierA], [nodeB, tierB]) => cmp(nodeA, nodeB) || tierA - tierB).map(([nodeId, tier]): PlanConstraint => ({ kind: "min-tier", nodeId, tier })),
  );
  constraints.push(...[...removeNode].sort(cmp).map((nodeId): PlanConstraint => ({ kind: "remove-node", nodeId })));
  constraints.push(...notesInOrder.map((v): PlanConstraint => ({ kind: "note", nodeId: v.nodeId, text: v.text, authority: "none" })));
  // Defensive: constraints are already appended in kind order above, but sort explicitly so the
  // invariant holds even if a future edit adds a kind out of place.
  constraints.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || 0);
  // Stable-sort would reorder equal-rank entries by insertion position, which is what we already built
  // above (already sorted within each kind); Array.prototype.sort in modern engines is stable, and
  // notes must stay in original relative order among themselves, which insertion order preserves.

  const layout: LayoutPreference[] = [];
  for (const [nodeId, p] of layoutPosition) layout.push({ kind: "position", nodeId, x: p.x, y: p.y });
  for (const [nodeId, collapsed] of layoutCollapsed) layout.push({ kind: "collapsed", nodeId, collapsed });
  layout.sort((a, b) => cmp(a.nodeId, b.nodeId) || (a.kind === b.kind ? 0 : a.kind === "position" ? -1 : 1));

  return { schema, basis, constraints, layout, refused };
}
