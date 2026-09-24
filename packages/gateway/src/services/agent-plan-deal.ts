/**
 * The deal binding VCR seals into every money receipt (VCR #2475 and #2674; board N22, N25, N37),
 * built from an accepted deal and escrow's V-next settlement unit ids.
 *
 *   binding(node) = { digest:   the deal's acceptedDealDigest,
 *                     units:    every settlement unit id of the deal, in plan order (1..64, distinct),
 *                     nodeId:   the node this receipt settles,
 *                     requires: the unit ids of the node's DIRECT predecessors in the accepted DAG }
 *
 * `requires` is VCR's release gate. A unit is released only after every unit it requires has been
 * released. A refunded one refuses the release (dependency-failed); an open one defers it
 * (dependency-pending). For print -> mail, mail requires [unit(print)] and print requires [].
 *
 * Pure. The unit ids come from an injected encoder: escrow's canonical compiler (#367), bound to the
 * deployment and to oracle's termsHash/acceptedPolicyDigest, because a unit id derives from its escrow
 * clone's identity. The dependency order comes from the edges the accept seam evaluated, which the
 * compiler validated and committed in `compositionRoot`.
 *
 * The encoder is trusted server code, so if CALLING it throws, that is a server fault and propagates.
 * Its OUTPUT is read once into owned data and checked against the deal before anything is emitted:
 *   - the same jobs, in the same order;
 *   - one id per unit, and every id a bytes32;
 *   - all ids distinct.
 * A mismatch is an encoder fault: nothing is bound, and the route consumes no reservation. VCR's
 * 64-unit limit is checked BEFORE the encoder runs (a plan-size refusal, not an encoder fault).
 */

import type { CompiledAcceptedPlan } from "@pcc/spec";

/** VCR's deal-binding limit (#2475): a deal names at most 64 settlement units. */
export const MAX_UNITS_PER_DEAL = 64;

/** One job as escrow's compiler encoded it: the job id it was given, and its unit ids in unit order. */
export interface EncodedJob {
  jobId: string;
  unitIds: readonly string[];
}

/** Escrow's compiler, bound by the route to the deployment and oracle's hashes. One entry per plan job, in plan order. */
export type DealEncoder = (plan: CompiledAcceptedPlan) => readonly EncodedJob[];

export interface DealBinding {
  digest: `0x${string}`;
  units: `0x${string}`[];
  nodeId: string;
  requires: `0x${string}`[];
}

export type DealBindingResult =
  | { ok: true; unitIds: `0x${string}`[]; bindings: DealBinding[] }
  | { ok: false; reason: "too-many-units-for-deal"; units: number }
  | { ok: false; reason: "encoder-mismatch"; detail: string }
  | { ok: false; reason: "edge-mismatch"; detail: string };

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/** A plain array length, or null for one that is not a non-negative integer (a proxy can lie). */
function lengthOf(a: readonly unknown[]): number | null {
  const n: unknown = a.length;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * The encoder's answer, copied once into owned data: every property is read once, and so is every
 * array's length. Null for an answer that cannot be read as a list of jobs. Reading never throws.
 */
function snapshotEncoded(res: unknown, maxJobs: number): Array<{ jobId: unknown; unitIds: unknown[] | null }> | null {
  try {
    if (!Array.isArray(res)) return null;
    const count = lengthOf(res);
    if (count === null || count > maxJobs) return null;
    const out: Array<{ jobId: unknown; unitIds: unknown[] | null }> = [];
    for (let i = 0; i < count; i++) {
      const job: unknown = res[i];
      if (typeof job !== "object" || job === null) return null;
      const r = job as Record<string, unknown>;
      const jobId: unknown = r.jobId;
      const idsRaw: unknown = r.unitIds;
      let unitIds: unknown[] | null = null;
      if (Array.isArray(idsRaw)) {
        const n = lengthOf(idsRaw);
        if (n !== null && n <= MAX_UNITS_PER_DEAL) {
          unitIds = [];
          for (let k = 0; k < n; k++) unitIds.push(idsRaw[k]);
        }
      }
      out.push({ jobId, unitIds });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Bind every node of an accepted deal to escrow's unit ids and to its release dependencies.
 *
 * `plan` is the deal the server itself just compiled. `edges` are the submission's edges exactly as the
 * seam evaluated them (the route re-snapshots the body and matches the seam's `submissionDigest`
 * first). An edge that names no node of the deal, or loops on one node, is an `edge-mismatch`.
 */
export function bindDeal(
  plan: CompiledAcceptedPlan,
  edges: ReadonlyArray<{ from: unknown; to: unknown } | null>,
  encode: DealEncoder,
): DealBindingResult {
  const unitCount = plan.nodeToUnit.length;
  if (unitCount > MAX_UNITS_PER_DEAL) return { ok: false, reason: "too-many-units-for-deal", units: unitCount };
  const mismatch = (detail: string): DealBindingResult => ({ ok: false, reason: "encoder-mismatch", detail });
  if (unitCount === 0) return mismatch("empty-deal");

  // Dependencies first: an edge problem is caught before the encoder runs.
  const known = new Set(plan.nodeToUnit.map((b) => b.nodeId));
  const preds = new Map<string, Set<string>>();
  for (const [i, e] of edges.entries()) {
    const from = e?.from;
    const to = e?.to;
    if (typeof from !== "string" || typeof to !== "string" || !known.has(from) || !known.has(to) || from === to) {
      return { ok: false, reason: "edge-mismatch", detail: `edge:${i}` };
    }
    const set = preds.get(to) ?? new Set<string>();
    set.add(from);
    preds.set(to, set);
  }

  const encoded = snapshotEncoded(encode(plan), plan.jobs.length);
  if (encoded === null || encoded.length !== plan.jobs.length) return mismatch("jobs");
  const unitIds: `0x${string}`[] = [];
  const idsByJob: `0x${string}`[][] = [];
  for (const [j, job] of plan.jobs.entries()) {
    const e = encoded[j]!;
    if (e.jobId !== job.jobId) return mismatch(`job-id:${j}`);
    if (e.unitIds === null || e.unitIds.length !== job.units.length) return mismatch(`unit-count:${j}`);
    const ids: `0x${string}`[] = [];
    for (const [m, id] of e.unitIds.entries()) {
      if (typeof id !== "string" || !BYTES32.test(id)) return mismatch(`unit-id:${j}:${m}`);
      ids.push(id.toLowerCase() as `0x${string}`);
    }
    idsByJob.push(ids);
    unitIds.push(...ids);
  }
  if (new Set(unitIds).size !== unitIds.length) return mismatch("duplicate-unit-id");

  // Each node's unit, through the compiler's own node -> (job, milestone) binding.
  const unitOf = new Map<string, `0x${string}`>();
  for (const b of plan.nodeToUnit) {
    const id = idsByJob[b.jobIndex]?.[b.milestoneIndex];
    if (id === undefined || unitOf.has(b.nodeId)) return mismatch(`binding:${b.nodeId}`);
    unitOf.set(b.nodeId, id);
  }
  const position = new Map(unitIds.map((id, i) => [id, i]));
  const bindings = plan.nodeToUnit.map((b) => ({
    digest: plan.acceptedDealDigest,
    units: [...unitIds],
    nodeId: b.nodeId,
    requires: [...(preds.get(b.nodeId) ?? [])]
      .map((p) => unitOf.get(p)!)
      .sort((x, y) => position.get(x)! - position.get(y)!),
  }));
  return { ok: true, unitIds, bindings };
}
