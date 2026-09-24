/**
 * Adapters: PCC's existing economic primitives in, the same agreement IR out (docs §8).
 *
 * None of these computes a payout. Each only translates an existing structure into clauses and splits,
 * and `compileEconomics` does the arithmetic once, for everything. That is what keeps the optional
 * contribution graph "a template, never a second engine", and what fixes the two known defects in the
 * old walkers by construction:
 *   - co-authors of one role share ONE allocation (buildPayoutMap paid each the full rate);
 *   - a model's lineage SUBDIVIDES the model allocation (getRoyaltyDistributionRich paid it twice).
 */

import { z } from "zod";
import type { CompositionManifest } from "../types/composition-manifest.js";
import { computeManifestHash } from "../types/composition-manifest.js";
import type { TrainingManifest } from "../types/training-manifest.js";
import { computeTrainingManifestHash } from "../types/training-manifest.js";
import { cmpStr } from "./hash.js";
import {
  ID_PATTERN,
  IdSchema,
  LabelSchema,
  MAX_SPLIT_DEPTH,
  RoleSchema,
  type AppliesTo,
  type Clause,
  type RateSource,
  type Split,
  type SplitMember,
} from "./types.js";

export type AdapterRefusalCode =
  | "MANIFEST_HASH_MISMATCH"
  | "RATE_NOT_PINNED"
  | "UNKNOWN_CONTRIBUTOR"
  | "GROUP_WEIGHTS_INVALID"
  | "MIXED_GROUP_WEIGHTS"
  | "EXPANSION_SHARE_UNDECLARED"
  | "LINEAGE_CYCLE"
  | "LINEAGE_TOO_DEEP"
  | "GRAPH_INVALID"
  | "GRAPH_CYCLE"
  | "GRAPH_TOO_DEEP"
  | "GRAPH_EMPTY"
  | "ID_TOO_LONG";

export interface AdapterRefusal {
  code: AdapterRefusalCode;
  message: string;
  path: string[];
}

export type AdapterResult<T> = ({ ok: true } & T) | { ok: false; refusals: AdapterRefusal[] };

function composedId(...parts: string[]): string | null {
  const id = parts.join("/");
  return ID_PATTERN.test(id) ? id : null;
}

/** CompositionRole → contributor role. `pilot` is the documented alias of `dataset-contributor`. */
function compositionRole(role: string): Clause["role"] {
  return (role === "pilot" ? "dataset-contributor" : role) as Clause["role"];
}

// ── CompositionManifest ──────────────────────────────────────────────────────

export interface ManifestAdapterInput {
  manifest: CompositionManifest;
  /** The rate each schedule gave when the deal was quoted. A manifest pins schedules, not numbers. */
  pinnedRates: ReadonlyArray<{ bps: number; rateSource: RateSource }>;
  /** Lowercase contributor address → agreement party id. */
  partyByAddress: Readonly<Record<string, string>>;
  /** Which units the contributor royalties apply in (usually `{ usingComponent: <capability> }`). */
  appliesTo: AppliesTo;
  /** Prefix for the generated clause and split ids. */
  idPrefix: string;
}

/**
 * Entries that share (role, ipId, rateScheduleHash) are one allocation shared by co-authors: by their
 * `groupBps` when every entry carries one (they must total exactly 10000), or equally when none does.
 * The allocation is a `percent` of the unit's net at the pinned schedule rate, as MilestoneEscrow's
 * split payout computed it (bps of the distributable amount).
 */
export function clausesFromCompositionManifest(
  input: ManifestAdapterInput,
): AdapterResult<{ clauses: Clause[]; splits: Split[] }> {
  const refusals: AdapterRefusal[] = [];
  const m = input.manifest;
  if (computeManifestHash(m).toLowerCase() !== m.manifestHash.toLowerCase()) {
    return {
      ok: false,
      refusals: [{ code: "MANIFEST_HASH_MISMATCH", message: "the manifest body does not hash to its manifestHash", path: ["manifest"] }],
    };
  }
  const rateByHash = new Map(input.pinnedRates.map((r) => [r.rateSource.scheduleHash.toLowerCase(), r] as const));

  const groups = new Map<string, typeof m.entries>();
  for (const e of m.entries) {
    const key = `${compositionRole(e.role)}\u0000${e.ipId}\u0000${e.rateScheduleHash.toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const clauses: Clause[] = [];
  const splits: Split[] = [];
  const keys = [...groups.keys()].sort(cmpStr);
  keys.forEach((key, index) => {
    const entries = groups.get(key)!;
    const first = entries[0]!;
    const role = compositionRole(first.role);
    const at = ["manifest", first.ipId, role];
    const pinned = rateByHash.get(first.rateScheduleHash.toLowerCase());
    if (pinned === undefined) {
      refusals.push({ code: "RATE_NOT_PINNED", message: `no pinned rate for schedule ${first.rateScheduleHash}`, path: at });
      return;
    }
    const parties: string[] = [];
    for (const e of entries) {
      const party = input.partyByAddress[e.contributorAddress.toLowerCase()];
      if (party === undefined) {
        refusals.push({ code: "UNKNOWN_CONTRIBUTOR", message: `contributor ${e.contributorAddress} is not an agreement party`, path: [...at, e.contributorAddress] });
      } else {
        parties.push(party);
      }
    }
    const withWeight = entries.filter((e) => e.groupBps !== undefined).length;
    if (withWeight !== 0 && withWeight !== entries.length) {
      refusals.push({ code: "MIXED_GROUP_WEIGHTS", message: "some co-authors carry groupBps and some do not", path: at });
      return;
    }
    if (withWeight > 0 && entries.reduce((s, e) => s + (e.groupBps ?? 0), 0) !== 10000) {
      refusals.push({ code: "GROUP_WEIGHTS_INVALID", message: "co-author groupBps must total exactly 10000", path: at });
      return;
    }
    if (parties.length !== entries.length) return;

    const clauseId = composedId(input.idPrefix, `c${index}`);
    const splitId = composedId(input.idPrefix, `s${index}`);
    if (clauseId === null || splitId === null) {
      refusals.push({ code: "ID_TOO_LONG", message: "idPrefix makes an invalid id", path: ["idPrefix"] });
      return;
    }
    let to: Clause["to"];
    if (entries.length === 1) {
      to = { party: parties[0]! };
    } else {
      const members: SplitMember[] = entries.map((e, i) => ({
        to: { party: parties[i]! },
        weight: e.groupBps ?? 1,
        role: null,
        subject: null,
      }));
      splits.push({ splitId, label: `Co-authors of ${role} for ${first.ipId}`.slice(0, 200), members });
      to = { split: splitId };
    }
    clauses.push({
      clauseId,
      label: `${role} share for ${first.ipId}`.slice(0, 200),
      role,
      to,
      subject: first.ipId,
      appliesTo: input.appliesTo,
      underLicense: null,
      rule: { kind: "percent", bps: pinned.bps, of: "net", min: null, max: null, rateSource: pinned.rateSource },
    });
  });
  return refusals.length > 0 ? { ok: false, refusals } : { ok: true, clauses, splits };
}

// ── TrainingManifest ─────────────────────────────────────────────────────────

export interface LineageInput {
  manifest: TrainingManifest;
  /** Party that receives the model author's retained part. */
  modelAuthorParty: string;
  /** Share (of 10000) of the model's allocation passed to its training inputs. Explicit, never assumed. */
  passThroughBps: number;
  /** datasetIpId → agreement party id. */
  datasetParty: Readonly<Record<string, string>>;
  /** Required exactly when the manifest declares a base model. */
  baseModel?: { weightBps: number; lineage: LineageInput };
}

/**
 * The model allocation becomes a split: the author keeps `10000 − passThroughBps`, and the training
 * inputs share `passThroughBps` (datasets by their `weightBps`, and the base model's own lineage with
 * an explicit `baseModelWeightBps`, recursively). Every level subdivides the level above; nothing is
 * added, so the total is always exactly the model allocation.
 */
export function splitsFromTrainingManifest(
  input: LineageInput,
  idPrefix: string,
): AdapterResult<{ splits: Split[]; rootSplitId: string }> {
  const splits: Split[] = [];
  const refusals: AdapterRefusal[] = [];

  const build = (li: LineageInput, depth: number, seen: ReadonlySet<string>): string | null => {
    const m = li.manifest;
    const at = ["lineage", m.modelIpId];
    if (seen.has(m.modelIpId)) {
      refusals.push({ code: "LINEAGE_CYCLE", message: `model ${m.modelIpId} is its own ancestor`, path: at });
      return null;
    }
    if (depth > 5) {
      refusals.push({ code: "LINEAGE_TOO_DEEP", message: "model lineage deeper than 5", path: at });
      return null;
    }
    if (computeTrainingManifestHash(m).toLowerCase() !== m.manifestHash.toLowerCase()) {
      refusals.push({ code: "MANIFEST_HASH_MISMATCH", message: "training manifest does not hash to its manifestHash", path: at });
      return null;
    }
    if (!Number.isInteger(li.passThroughBps) || li.passThroughBps < 0 || li.passThroughBps > 10000) {
      refusals.push({ code: "EXPANSION_SHARE_UNDECLARED", message: "passThroughBps must be an integer in 0..10000", path: at });
      return null;
    }
    if ((m.baseModelIpId !== undefined) !== (li.baseModel !== undefined)) {
      refusals.push({
        code: "EXPANSION_SHARE_UNDECLARED",
        message: "a declared base model needs an explicit weight and lineage, and only then",
        path: at,
      });
      return null;
    }
    const idx = splits.length;
    const rootId = composedId(idPrefix, `m${idx}`);
    const inputsId = composedId(idPrefix, `m${idx}i`);
    const dataId = composedId(idPrefix, `m${idx}d`);
    if (rootId === null || inputsId === null || dataId === null) {
      refusals.push({ code: "ID_TOO_LONG", message: "idPrefix makes an invalid id", path: ["idPrefix"] });
      return null;
    }
    splits.push({ splitId: rootId, label: `Model ${m.modelIpId}`.slice(0, 200), members: [] });

    const datasetMembers: SplitMember[] = [];
    for (const d of m.datasets) {
      const party = li.datasetParty[d.datasetIpId];
      if (party === undefined) {
        refusals.push({ code: "UNKNOWN_CONTRIBUTOR", message: `dataset ${d.datasetIpId} has no party`, path: [...at, d.datasetIpId] });
        continue;
      }
      if (d.weightBps > 0) {
        datasetMembers.push({ to: { party }, weight: d.weightBps, role: "dataset-contributor", subject: d.datasetIpId });
      }
    }
    const inputMembers: SplitMember[] = [];
    if (li.baseModel !== undefined) {
      const bw = li.baseModel.weightBps;
      if (!Number.isInteger(bw) || bw < 0 || bw > 10000) {
        refusals.push({ code: "EXPANSION_SHARE_UNDECLARED", message: "baseModel.weightBps must be an integer in 0..10000", path: at });
        return null;
      }
      const baseRoot = build(li.baseModel.lineage, depth + 1, new Set([...seen, m.modelIpId]));
      if (baseRoot === null) return null;
      if (bw > 0) inputMembers.push({ to: { split: baseRoot }, weight: bw, role: null, subject: null });
      if (bw < 10000 && datasetMembers.length > 0) {
        splits.push({ splitId: dataId, label: `Datasets of ${m.modelIpId}`.slice(0, 200), members: datasetMembers });
        inputMembers.push({ to: { split: dataId }, weight: 10000 - bw, role: null, subject: null });
      }
    } else {
      inputMembers.push(...datasetMembers);
    }

    const root = splits[idx]!;
    if (li.passThroughBps < 10000) {
      root.members.push({ to: { party: li.modelAuthorParty }, weight: 10000 - li.passThroughBps, role: "model-author", subject: m.modelIpId });
    }
    if (li.passThroughBps > 0 && inputMembers.length > 0) {
      splits.push({ splitId: inputsId, label: `Training inputs of ${m.modelIpId}`.slice(0, 200), members: inputMembers });
      root.members.push({ to: { split: inputsId }, weight: li.passThroughBps, role: null, subject: null });
    }
    if (root.members.length === 0) {
      refusals.push({ code: "EXPANSION_SHARE_UNDECLARED", message: "the model allocation would go nowhere", path: at });
      return null;
    }
    return rootId;
  };

  const rootSplitId = build(input, 0, new Set());
  if (rootSplitId === null || refusals.length > 0) return { ok: false, refusals };
  return { ok: true, splits, rootSplitId };
}

// ── ContributionGraphV1 (optional template) ──────────────────────────────────

export const ContributionGraphSchema = z
  .object({
    schema: z.literal("pcc.contribution-graph.v1"),
    graphId: IdSchema,
    root: IdSchema,
    nodes: z
      .array(
        z
          .object({
            nodeId: IdSchema,
            label: LabelSchema,
            /** null: a pure routing node that keeps nothing (retainWeight must be 0). */
            party: IdSchema.nullable(),
            role: RoleSchema,
            subject: IdSchema.nullable(),
            /** When set with participationRequired, the node is owed only where this component runs. */
            componentRef: IdSchema.nullable(),
            participationRequired: z.boolean(),
            retainWeight: z.number().int().min(0).max(1_000_000),
          })
          .strict()
          .refine((n) => n.party !== null || n.retainWeight === 0, "a node with no party cannot retain a share")
          .refine((n) => !n.participationRequired || n.componentRef !== null, "participation needs a componentRef"),
      )
      .min(1)
      .max(64),
    edges: z
      .array(
        z
          .object({
            from: IdSchema,
            to: IdSchema,
            weight: z.number().int().min(1).max(1_000_000),
            /** Only an accepted relationship can become an obligation. */
            accepted: z.boolean(),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
export type ContributionGraph = z.infer<typeof ContributionGraphSchema>;

/**
 * Turn a contribution graph into splits for one unit. Each node's incoming share is divided between
 * its own retain weight and its outgoing edges. An edge is dropped, and its weight returns to its
 * source node's retain, when it is not accepted, when its target requires participation and its
 * component does not run in this unit, or when its target ends up with nothing to pay. A routing node
 * (no party) with nothing left is dropped the same way. The root must end up payable.
 */
export function splitsFromContributionGraph(
  graphInput: unknown,
  usedComponents: ReadonlySet<string>,
  idPrefix: string,
): AdapterResult<{ splits: Split[]; rootPayee: { split: string } }> {
  const parsed = ContributionGraphSchema.safeParse(graphInput);
  if (!parsed.success) {
    return {
      ok: false,
      refusals: parsed.error.issues.map((i) => ({ code: "GRAPH_INVALID" as const, message: i.message, path: i.path.map(String) })),
    };
  }
  const g = parsed.data;
  const nodes = new Map(g.nodes.map((n) => [n.nodeId, n] as const));
  if (nodes.size !== g.nodes.length) {
    return { ok: false, refusals: [{ code: "GRAPH_INVALID", message: "duplicate nodeId", path: ["nodes"] }] };
  }
  const bad = g.edges.find((e) => !nodes.has(e.from) || !nodes.has(e.to)) ?? (!nodes.has(g.root) ? { from: g.root, to: g.root } : undefined);
  if (bad !== undefined) {
    return { ok: false, refusals: [{ code: "GRAPH_INVALID", message: "an edge or the root names an unknown node", path: [bad.from, bad.to] }] };
  }
  const edgeKeys = g.edges.map((e) => `${e.from}\u0000${e.to}`);
  if (new Set(edgeKeys).size !== edgeKeys.length) {
    return { ok: false, refusals: [{ code: "GRAPH_INVALID", message: "duplicate edge", path: ["edges"] }] };
  }
  const outgoing = (id: string) => g.edges.filter((e) => e.from === id).sort((a, b) => cmpStr(a.to, b.to));

  // Cycle + depth check over the whole graph reachable from the root.
  const depthOf = new Map<string, number>();
  const onStack = new Set<string>();
  let failure: AdapterRefusal | null = null;
  const measure = (id: string): number => {
    const known = depthOf.get(id);
    if (known !== undefined) return known;
    if (onStack.has(id)) {
      failure ??= { code: "GRAPH_CYCLE", message: `node ${id} contributes to itself`, path: [id] };
      return 0;
    }
    onStack.add(id);
    const d = 1 + Math.max(0, ...outgoing(id).map((e) => measure(e.to)));
    onStack.delete(id);
    depthOf.set(id, d);
    return d;
  };
  if (measure(g.root) > MAX_SPLIT_DEPTH && failure === null) {
    failure = { code: "GRAPH_TOO_DEEP", message: `graph is deeper than ${MAX_SPLIT_DEPTH}`, path: [g.root] };
  }
  if (failure !== null) return { ok: false, refusals: [failure] };

  // Bottom-up: which nodes can be paid in this unit, and each node's split.
  const members = new Map<string, SplitMember[] | null>();
  const splitIdOf = (id: string) => composedId(idPrefix, id);
  const resolve = (id: string): SplitMember[] | null => {
    if (members.has(id)) return members.get(id)!;
    const n = nodes.get(id)!;
    let retain = n.retainWeight;
    const kept: SplitMember[] = [];
    for (const e of outgoing(id)) {
      const target = nodes.get(e.to)!;
      const eligible = !target.participationRequired || usedComponents.has(target.componentRef!);
      const payable = e.accepted && eligible && resolve(e.to) !== null;
      if (payable) kept.push({ to: { split: splitIdOf(e.to)! }, weight: e.weight, role: null, subject: null });
      else if (n.party !== null) retain += e.weight; // dropped share stays with the node that would have passed it on
    }
    const out: SplitMember[] = [];
    if (retain > 0 && n.party !== null) out.push({ to: { party: n.party }, weight: retain, role: n.role, subject: n.subject });
    out.push(...kept);
    const result = out.length > 0 ? out : null;
    members.set(id, result);
    return result;
  };

  for (const n of g.nodes) {
    if (splitIdOf(n.nodeId) === null) {
      return { ok: false, refusals: [{ code: "ID_TOO_LONG", message: "idPrefix + nodeId is not a valid id", path: [n.nodeId] }] };
    }
  }
  const rootMembers = resolve(g.root);
  if (rootMembers === null) {
    return { ok: false, refusals: [{ code: "GRAPH_EMPTY", message: "nothing in the graph is payable in this unit", path: [g.root] }] };
  }
  const reachable = new Set<string>();
  const walk = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const m of members.get(id) ?? []) if ("split" in m.to) walk(m.to.split.slice(idPrefix.length + 1));
  };
  walk(g.root);
  const splits: Split[] = [...reachable]
    .sort(cmpStr)
    .map((id) => ({ splitId: splitIdOf(id)!, label: nodes.get(id)!.label, members: members.get(id)! }));
  return { ok: true, splits, rootPayee: { split: splitIdOf(g.root)! } };
}

