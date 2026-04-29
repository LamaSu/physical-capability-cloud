/**
 * LicensingEngine — automatic IP licensing brain for PCC.
 *
 * Pure logic (no chain calls). Responsibilities:
 *   1. Store licensing terms per IP Asset
 *   2. Evaluate whether a derivative request meets auto-license conditions
 *   3. Calculate effective revenue shares with decay for nested derivatives
 *   4. Issue license grants
 *   5. Track the full derivative tree for royalty distribution
 *
 * Revenue decay example (decayRate=0.5, base revShare=5%):
 *   Level 1 → 5% to original
 *   Level 2 → 5%*0.5=2.5% to original, 5% to level-1
 *   Level 3 → 5%*0.25=1.25% to original, 2.5% to level-1, 5% to level-2
 */

import { randomUUID } from "node:crypto";
import type {
  LicensingTerms,
  LicenseGrant,
  StandingOffer,
  RateSchedule,
  RateScheduleEvaluationContext,
  TrainingManifest,
  CompositionManifest,
  CompositionEntry,
  CompositionRole,
} from "@pcc/spec";
import {
  evaluateRateSchedule,
  computeScheduleHash,
  computeTrainingManifestHash,
  assertScheduleIsWellFormed,
  assertTrainingManifestIsWellFormed,
} from "@pcc/spec";

// ── Public interfaces ─────────────────────────────────────────────────

export interface LicenseEvaluation {
  approved: boolean;
  autoApproved: boolean;
  /** True when the similarity score puts this in derivative range — license required */
  requiresLicense: boolean;
  matchedOffer?: string;           // standing offer name
  revSharePercent: number;
  effectiveRevShare: number;
  derivativeDepth: number;
  reasons: string[];               // why approved/rejected
  requiresManualReview: boolean;
}

export interface EffectiveRevShareChain {
  /** The IP Asset being evaluated */
  ipId: string;
  /** Each ancestor IP with its effective cut from a derivative job */
  chain: Array<{
    ipId: string;
    depth: number;
    baseRevShare: number;
    effectiveRevShare: number;
    recipientAddress: string;
  }>;
  /** Total rev share consumed by the ancestor chain (sum of effective shares) */
  totalAncestorShare: number;
}

export interface RoyaltyDistribution {
  recipientAddress: string;
  ipId: string;
  depth: number;
  sharePercent: number;
  effectivePercent: number;        // after decay
  amount: string;                  // calculated from jobRevenue
  /**
   * Optional role tag from CompositionManifest / TrainingManifest paths.
   * Populated only by `getRoyaltyDistributionRich`; legacy
   * `getRoyaltyDistribution` always omits this.
   */
  role?: CompositionRole;
}

// ── Internal tree node ────────────────────────────────────────────────

interface DerivativeNode {
  childIpId: string;
  parentIpId: string;
  grant: LicenseGrant;
}

// ── LicensingEngine ───────────────────────────────────────────────────

export class LicensingEngine {
  /** Licensing terms keyed by ipId */
  private readonly terms = new Map<string, LicensingTerms>();

  /** Grants keyed by child IP Asset ID */
  private readonly grants = new Map<string, LicenseGrant>();

  /** Parent→children adjacency for the derivative tree */
  private readonly children = new Map<string, string[]>();

  /** Child→parent mapping */
  private readonly parents = new Map<string, string>();

  // ── Wave 3c — RateSchedule + TrainingManifest registries ─────────────

  /**
   * Per-IP RateSchedule registry. In-memory cache; the canonical source of
   * truth is the on-chain ContributorNFT metadata hash. Populated by the
   * gateway layer at startup or on first lookup.
   */
  private readonly rateSchedules = new Map<string, RateSchedule>();

  /**
   * Per-model TrainingManifest registry. In-memory cache. Walked by
   * `getRoyaltyDistributionRich` to recursively distribute model-author
   * shares to dataset contributors.
   */
  private readonly trainingManifests = new Map<string, TrainingManifest>();

  // ── Terms storage ────────────────────────────────────────────────────

  setTerms(ipId: string, terms: LicensingTerms): void {
    this.terms.set(ipId, terms);
  }

  getTerms(ipId: string): LicensingTerms | undefined {
    return this.terms.get(ipId);
  }

  // ── License evaluation ───────────────────────────────────────────────

  /**
   * Evaluate whether a derivative request should be auto-approved.
   *
   * Logic:
   *   1. If similarity < derivativeThreshold → original, no license needed
   *   2. If similarity >= cloneThreshold → clone, reject
   *   3. Otherwise → check auto-license conditions and standing offers
   */
  evaluateLicense(request: {
    parentIpId: string;
    childCsd: { type: string; kind: string; tier: number };
    similarityScore: number;
    similarityVerdict: "original" | "derivative" | "clone";
    requestorAddress: string;
    proposedRevShare?: number;
  }): LicenseEvaluation {
    const reasons: string[] = [];

    const terms = this.terms.get(request.parentIpId);
    if (!terms) {
      // No terms set → open, no license required
      return {
        approved: true,
        autoApproved: true,
        requiresLicense: false,
        revSharePercent: 0,
        effectiveRevShare: 0,
        derivativeDepth: this.computeDepth(request.parentIpId),
        reasons: ["No licensing terms set — open use"],
        requiresManualReview: false,
      };
    }

    const { autoLicense } = terms;
    const depth = this.computeDepth(request.parentIpId);

    // Clone detection — hard reject
    if (
      request.similarityVerdict === "clone" ||
      request.similarityScore >= autoLicense.cloneThreshold
    ) {
      reasons.push(
        `Similarity score ${request.similarityScore.toFixed(3)} >= clone threshold ${autoLicense.cloneThreshold} — rejected as clone`,
      );
      return {
        approved: false,
        autoApproved: false,
        requiresLicense: false, // clone = rejection, not licensing issue
        revSharePercent: 0,
        effectiveRevShare: 0,
        derivativeDepth: depth,
        reasons,
        requiresManualReview: false,
      };
    }

    // Below derivative threshold → original, no license needed
    if (
      request.similarityVerdict === "original" ||
      request.similarityScore < autoLicense.derivativeThreshold
    ) {
      reasons.push(
        `Similarity score ${request.similarityScore.toFixed(3)} < derivative threshold ${autoLicense.derivativeThreshold} — original, no license required`,
      );
      return {
        approved: true,
        autoApproved: true,
        requiresLicense: false,
        revSharePercent: 0,
        effectiveRevShare: 0,
        derivativeDepth: depth,
        reasons,
        requiresManualReview: false,
      };
    }

    // From here on, the similarity is in the derivative range → requires license
    // Sub-derivatives check
    if (!terms.allowSubDerivatives && depth > 1) {
      reasons.push(
        `Parent IP disallows sub-derivatives (depth would be ${depth})`,
      );
      return {
        approved: false,
        autoApproved: false,
        requiresLicense: true,
        revSharePercent: 0,
        effectiveRevShare: 0,
        derivativeDepth: depth,
        reasons,
        requiresManualReview: true,
      };
    }

    // Commercial use check
    if (!autoLicense.commercialUse) {
      reasons.push("Parent IP does not allow commercial use");
      return {
        approved: false,
        autoApproved: false,
        requiresLicense: true,
        revSharePercent: 0,
        effectiveRevShare: 0,
        derivativeDepth: depth,
        reasons,
        requiresManualReview: true,
      };
    }

    // Try standing offers first (best match = highest autoAccept + lowest cost to requestor)
    const matchedOffer = this.matchStandingOffer(terms.standingOffers, request);
    if (matchedOffer) {
      const revShare = matchedOffer.revSharePercent;
      const effective = this.applyDecay(revShare, terms.derivativeDecayRate, depth);
      reasons.push(`Matched standing offer: "${matchedOffer.name}"`);
      if (matchedOffer.autoAccept) {
        reasons.push("Auto-accepted via standing offer");
        return {
          approved: true,
          autoApproved: true,
          requiresLicense: true,
          matchedOffer: matchedOffer.name,
          revSharePercent: revShare,
          effectiveRevShare: effective,
          derivativeDepth: depth,
          reasons,
          requiresManualReview: false,
        };
      } else {
        reasons.push("Standing offer requires manual approval");
        return {
          approved: false,
          autoApproved: false,
          requiresLicense: true,
          matchedOffer: matchedOffer.name,
          revSharePercent: revShare,
          effectiveRevShare: effective,
          derivativeDepth: depth,
          reasons,
          requiresManualReview: true,
        };
      }
    }

    // Check auto-license conditions directly
    const proposedRevShare = request.proposedRevShare ?? terms.defaultRevShare;
    const conditionFailures = this.checkAutoLicenseConditions(
      autoLicense,
      request.childCsd,
      proposedRevShare,
    );

    if (conditionFailures.length === 0) {
      const effective = this.applyDecay(proposedRevShare, terms.derivativeDecayRate, depth);
      reasons.push("All auto-license conditions met");
      return {
        approved: true,
        autoApproved: true,
        requiresLicense: true,
        revSharePercent: proposedRevShare,
        effectiveRevShare: effective,
        derivativeDepth: depth,
        reasons,
        requiresManualReview: false,
      };
    }

    reasons.push(...conditionFailures);
    const effective = this.applyDecay(proposedRevShare, terms.derivativeDecayRate, depth);
    return {
      approved: false,
      autoApproved: false,
      requiresLicense: true,
      revSharePercent: proposedRevShare,
      effectiveRevShare: effective,
      derivativeDepth: depth,
      reasons,
      requiresManualReview: true,
    };
  }

  // ── Grant issuance ───────────────────────────────────────────────────

  /**
   * Issue a license grant from a successful evaluation.
   * Registers the child→parent relationship in the derivative tree.
   */
  grantLicense(
    evaluation: LicenseEvaluation,
    params: {
      parentIpId: string;
      childIpId: string;
      licensingTermsId: string;
      recipientAddress: string;
    },
  ): LicenseGrant {
    const grant: LicenseGrant = {
      id: randomUUID(),
      licensingTermsId: params.licensingTermsId,
      parentIpId: params.parentIpId,
      childIpId: params.childIpId,
      standingOfferId: evaluation.matchedOffer,
      revSharePercent: evaluation.revSharePercent,
      derivativeDepth: evaluation.derivativeDepth,
      effectiveRevShare: evaluation.effectiveRevShare,
      status: "active",
      recipientAddress: params.recipientAddress,
      grantedAt: new Date().toISOString(),
    };

    // Register in grant store and derivative tree
    this.grants.set(params.childIpId, grant);
    this.parents.set(params.childIpId, params.parentIpId);

    const existing = this.children.get(params.parentIpId) ?? [];
    if (!existing.includes(params.childIpId)) {
      existing.push(params.childIpId);
      this.children.set(params.parentIpId, existing);
    }

    return grant;
  }

  // ── Revenue chain calculation ─────────────────────────────────────────

  /**
   * Walk up the ancestor chain from a given IP Asset and compute the
   * effective revenue share for each ancestor (with decay applied).
   */
  calculateEffectiveRevShare(ipId: string): EffectiveRevShareChain {
    const chain: EffectiveRevShareChain["chain"] = [];
    let cursor = ipId;
    let totalShare = 0;

    while (this.parents.has(cursor)) {
      const parentId = this.parents.get(cursor)!;
      const grant = this.grants.get(cursor);
      if (!grant) break;

      const parentTerms = this.terms.get(parentId);
      const recipientAddress = parentTerms?.designerAddress ?? grant.recipientAddress;

      chain.push({
        ipId: parentId,
        depth: grant.derivativeDepth,
        baseRevShare: grant.revSharePercent,
        effectiveRevShare: grant.effectiveRevShare,
        recipientAddress,
      });

      totalShare += grant.effectiveRevShare;
      cursor = parentId;
    }

    return { ipId, chain, totalAncestorShare: totalShare };
  }

  /**
   * Get the full royalty distribution for a job running on a given child IP.
   * Walks the ancestor tree and computes each ancestor's cut from jobRevenue.
   *
   * Uses relative depth from child outward (1 = direct parent, 2 = grandparent, etc.)
   * Each ancestor's terms define the base rev share and decay rate.
   */
  getRoyaltyDistribution(childIpId: string, jobRevenue: string): RoyaltyDistribution[] {
    const revenueBig = BigInt(jobRevenue);
    const distributions: RoyaltyDistribution[] = [];

    // Walk up the ancestor chain, tracking relative depth from child
    let cursor = childIpId;
    let relativeDepth = 0;

    while (this.parents.has(cursor)) {
      relativeDepth++;
      const parentId = this.parents.get(cursor)!;
      const grant = this.grants.get(cursor);
      if (!grant) break;

      const parentTerms = this.terms.get(parentId);
      const recipientAddress = parentTerms?.designerAddress ?? grant.recipientAddress;
      const baseRevShare = grant.revSharePercent;
      const decayRate = parentTerms?.derivativeDecayRate ?? 0.5;

      // Effective share: apply decay based on relative depth from child
      // relativeDepth=1 (direct parent) → no decay (decay^0 = 1)
      // relativeDepth=2 (grandparent) → decay^1
      const effectivePercent = relativeDepth === 1
        ? baseRevShare
        : baseRevShare * Math.pow(decayRate, relativeDepth - 1);

      const roundedEffective = Math.round(effectivePercent * 10000) / 10000;
      const amountBig = (revenueBig * BigInt(Math.round(roundedEffective * 100))) / 10000n;

      distributions.push({
        recipientAddress,
        ipId: parentId,
        depth: relativeDepth,
        sharePercent: baseRevShare,
        effectivePercent: roundedEffective,
        amount: String(amountBig),
      });

      cursor = parentId;
    }

    return distributions;
  }

  // ── Accessors ─────────────────────────────────────────────────────────

  getGrant(childIpId: string): LicenseGrant | undefined {
    return this.grants.get(childIpId);
  }

  getChildren(parentIpId: string): string[] {
    return this.children.get(parentIpId) ?? [];
  }

  // ── Wave 3c — RateSchedule registry ──────────────────────────────────

  /**
   * Register an immutable RateSchedule for an IP Asset. Validates the
   * schedule's well-formedness and that the supplied scheduleHash actually
   * matches the canonical hash of the schedule body.
   *
   * Schedules are immutable — the on-chain `RateScheduleRegistry` enforces
   * this for canonical truth. This in-memory cache mirrors that invariant:
   * re-registering with the SAME hash is idempotent; re-registering with a
   * DIFFERENT hash for the same `ipId` throws. To genuinely replace a
   * schedule (e.g., re-syncing a cache after a chain reorg or after a
   * contributor explicitly published v2 with a new ContributorNFT), call
   * `unsafeReplaceRateSchedule()` explicitly. That extra friction matches
   * the on-chain semantics and prevents silent off-chain/on-chain drift.
   */
  setRateSchedule(ipId: string, schedule: RateSchedule): void {
    if (!ipId) throw new Error("setRateSchedule: ipId is required");
    assertScheduleIsWellFormed(schedule);

    const expected = computeScheduleHash({
      version: schedule.version,
      segments: schedule.segments,
      publishedAt: schedule.publishedAt,
    });
    if (schedule.scheduleHash.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(
        `setRateSchedule: scheduleHash mismatch. Provided ${schedule.scheduleHash}, computed ${expected}`,
      );
    }

    const existing = this.rateSchedules.get(ipId);
    if (
      existing &&
      existing.scheduleHash.toLowerCase() !== schedule.scheduleHash.toLowerCase()
    ) {
      throw new Error(
        `setRateSchedule: ipId "${ipId}" already has schedule ${existing.scheduleHash} ` +
          `(v${existing.version}) — refusing to replace with ${schedule.scheduleHash} ` +
          `(v${schedule.version}). Use unsafeReplaceRateSchedule() if you really mean ` +
          `to replace the cached schedule (e.g., after a chain reorg or v2 publish).`,
      );
    }

    this.rateSchedules.set(ipId, schedule);
  }

  /**
   * Replace the cached RateSchedule for an `ipId` even if the hash differs.
   *
   * The deliberate friction in `setRateSchedule` exists to match the on-chain
   * `RateScheduleRegistry`'s immutability guarantee. Use this method only
   * when you genuinely need to overwrite the cache:
   *   - Re-syncing after a chain reorg invalidated the previously-cached schedule
   *   - A contributor published a v2 schedule (new ContributorNFT, new hash)
   *   - Test setup explicitly resetting state
   *
   * Validates the supplied scheduleHash matches the canonical hash. The
   * absence of an immutability check is the ONLY behavioural difference vs.
   * `setRateSchedule`.
   */
  unsafeReplaceRateSchedule(ipId: string, schedule: RateSchedule): void {
    if (!ipId) throw new Error("unsafeReplaceRateSchedule: ipId is required");
    assertScheduleIsWellFormed(schedule);

    const expected = computeScheduleHash({
      version: schedule.version,
      segments: schedule.segments,
      publishedAt: schedule.publishedAt,
    });
    if (schedule.scheduleHash.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(
        `unsafeReplaceRateSchedule: scheduleHash mismatch. Provided ${schedule.scheduleHash}, computed ${expected}`,
      );
    }

    this.rateSchedules.set(ipId, schedule);
  }

  getRateSchedule(ipId: string): RateSchedule | undefined {
    return this.rateSchedules.get(ipId);
  }

  /**
   * Evaluate the current bps for an IP's registered rate schedule against
   * an evaluation context. Returns 0 if no schedule is registered.
   */
  evaluateRateScheduleForIp(
    ipId: string,
    context: RateScheduleEvaluationContext,
  ): number {
    const s = this.rateSchedules.get(ipId);
    if (!s) return 0;
    return evaluateRateSchedule(s, context).bps;
  }

  // ── Wave 3c — TrainingManifest registry ──────────────────────────────

  /**
   * Link a ModelNFT to its TrainingManifest. Validates:
   *   - manifest.modelIpId matches the supplied modelIpId
   *   - dataset weightBps sum to 10000
   *   - manifestHash matches the computed canonical hash
   */
  linkModel(modelIpId: string, manifest: TrainingManifest): void {
    if (!modelIpId) throw new Error("linkModel: modelIpId is required");

    if (manifest.modelIpId !== modelIpId) {
      throw new Error(
        `linkModel: manifest.modelIpId (${manifest.modelIpId}) does not match argument modelIpId (${modelIpId})`,
      );
    }

    assertTrainingManifestIsWellFormed({ datasets: manifest.datasets });

    const expected = computeTrainingManifestHash({
      modelIpId: manifest.modelIpId,
      datasets: manifest.datasets,
      baseModelIpId: manifest.baseModelIpId,
      methodologyHash: manifest.methodologyHash,
      trainedAt: manifest.trainedAt,
    });
    if (manifest.manifestHash.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(
        `linkModel: manifestHash mismatch. Provided ${manifest.manifestHash}, computed ${expected}`,
      );
    }

    this.trainingManifests.set(modelIpId, manifest);
  }

  getTrainingManifest(modelIpId: string): TrainingManifest | undefined {
    return this.trainingManifests.get(modelIpId);
  }

  // ── Wave 3c — Rich royalty distribution ──────────────────────────────

  /**
   * Walk a CompositionManifest + TrainingManifest DAG to produce the full
   * per-recipient royalty distribution at the moment described by `context`.
   *
   * Behavior:
   *   1. If manifest is provided, walk its entries:
   *      - For each entry, evaluate the registered RateSchedule for entry.ipId
   *        at `context`. The resulting bps is the entry's share of jobRevenue.
   *      - For entries with role="model-author", additionally walk the
   *        TrainingManifest registered for entry.ipId. The model-author's
   *        bps share is reproduced for the dataset contributors recursively
   *        (their share = modelBps * weightBps / 10000). Each dataset
   *        contributor is emitted as its own RoyaltyDistribution row with
   *        role="dataset-contributor".
   *      - If the TrainingManifest has a baseModelIpId, recurse one level
   *        further (depth-capped at 5 to prevent runaway loops).
   *   2. If manifest is NOT provided, fall back to the legacy
   *      `getRoyaltyDistribution` (capability ancestor-chain only).
   */
  getRoyaltyDistributionRich(input: {
    childIpId: string;
    jobRevenue: bigint;
    context: RateScheduleEvaluationContext;
    manifest?: CompositionManifest;
  }): RoyaltyDistribution[] {
    const { childIpId, jobRevenue, context, manifest } = input;

    // Fallback to legacy traversal when no composition manifest is supplied.
    if (!manifest) {
      return this.getRoyaltyDistribution(childIpId, String(jobRevenue));
    }

    const distributions: RoyaltyDistribution[] = [];

    for (const entry of manifest.entries) {
      const bps = this.evaluateRateScheduleForIp(entry.ipId, context);
      if (bps === 0) continue;

      // Apply optional groupBps weighting (to split a role across co-authors).
      // groupBps is a fraction of 10000 of THE ENTRY'S share, not of the job.
      const effectiveBps =
        entry.groupBps !== undefined && entry.groupBps !== 10000
          ? Math.round((bps * entry.groupBps) / 10000)
          : bps;

      if (effectiveBps === 0) continue;

      this.pushDistribution(
        distributions,
        entry.contributorAddress,
        entry.ipId,
        entry.role,
        effectiveBps,
        jobRevenue,
      );

      // For model-author entries, recursively expand training manifest.
      if (entry.role === "model-author") {
        this.expandTrainingManifest({
          modelIpId: entry.ipId,
          modelBps: effectiveBps,
          jobRevenue,
          context,
          distributions,
          depth: 0,
          visited: new Set([entry.ipId]),
        });
      }
    }

    return distributions;
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private pushDistribution(
    out: RoyaltyDistribution[],
    recipient: string,
    ipId: string,
    role: CompositionRole | "dataset-contributor",
    bps: number,
    jobRevenue: bigint,
  ): void {
    const sharePercent = bps / 100;
    const amountBig = (jobRevenue * BigInt(bps)) / 10000n;
    out.push({
      recipientAddress: recipient,
      ipId,
      depth: 0,
      sharePercent,
      effectivePercent: sharePercent,
      amount: String(amountBig),
      role: role as CompositionRole,
    });
  }

  /**
   * Recursively distribute a model author's bps share across its training
   * manifest's datasets (and, if present, its baseModel's manifest). Caps
   * depth at 5 and tracks visited modelIpIds to prevent cycles.
   */
  private expandTrainingManifest(args: {
    modelIpId: string;
    modelBps: number;
    jobRevenue: bigint;
    context: RateScheduleEvaluationContext;
    distributions: RoyaltyDistribution[];
    depth: number;
    visited: Set<string>;
  }): void {
    const MAX_DEPTH = 5;
    if (args.depth >= MAX_DEPTH) return;

    const tm = this.trainingManifests.get(args.modelIpId);
    if (!tm) return;

    for (const ds of tm.datasets) {
      // Each dataset's share = modelBps * weightBps / 10000
      const dsBps = Math.round((args.modelBps * ds.weightBps) / 10000);
      if (dsBps === 0) continue;

      const datasetSchedule = this.rateSchedules.get(ds.datasetIpId);
      if (!datasetSchedule) {
        // No schedule registered for this dataset — we still emit a row at
        // the manifest-implied bps so the dataset contributor can be wired
        // off-chain. The address has to come from somewhere — without a
        // ContributorProfile we can't resolve it; emit with empty address
        // and let the gateway reject or pre-fill. Skip entirely here to
        // avoid emitting an unaddressable Payout. This mirrors the
        // "no schedule = no payout" rule from evaluateRateScheduleForIp.
        continue;
      }

      // Dataset's recipient address is sourced from the schedule's IP terms
      // (designerAddress on the LicensingTerms for that ipId), or from a
      // ContributorProfile if separately registered. For Wave 3c this lives
      // in the LicensingTerms.designerAddress slot, which the existing
      // legacy traversal also uses. Fall back to "0x0" when missing — the
      // off-chain payout-builder is responsible for filtering those.
      const dsTerms = this.terms.get(ds.datasetIpId);
      const recipient =
        dsTerms?.designerAddress ?? "0x0000000000000000000000000000000000000000";

      this.pushDistribution(
        args.distributions,
        recipient,
        ds.datasetIpId,
        "dataset-contributor",
        dsBps,
        args.jobRevenue,
      );
    }

    // Recurse into baseModel lineage if declared (depth-capped).
    if (tm.baseModelIpId && !args.visited.has(tm.baseModelIpId)) {
      args.visited.add(tm.baseModelIpId);
      this.expandTrainingManifest({
        modelIpId: tm.baseModelIpId,
        // The base model gets its OWN scheduled bps (not the descendant
        // model's bps). If no schedule is registered for the base model,
        // the recursion contributes nothing.
        modelBps: this.evaluateRateScheduleForIp(tm.baseModelIpId, args.context),
        jobRevenue: args.jobRevenue,
        context: args.context,
        distributions: args.distributions,
        depth: args.depth + 1,
        visited: args.visited,
      });
    }
  }

  // ── Existing private helpers (unchanged) ─────────────────────────────

  /**
   * Compute the derivative depth of a new IP that would be a child of parentIpId.
   * Direct child of a root IP = depth 1.
   */
  private computeDepth(parentIpId: string): number {
    let depth = 0;
    let cursor: string | undefined = parentIpId;
    while (cursor !== undefined) {
      depth++;
      cursor = this.parents.get(cursor);
    }
    return depth;
  }

  /**
   * Apply decay to a base revenue share based on depth.
   * effectiveShare = baseShare * decayRate^(depth-1)
   */
  private applyDecay(baseShare: number, decayRate: number, depth: number): number {
    if (depth <= 1) return baseShare;
    const effective = baseShare * Math.pow(decayRate, depth - 1);
    // Round to 4 decimal places
    return Math.round(effective * 10000) / 10000;
  }

  /**
   * Try to match a standing offer for the derivative request.
   * Returns the first autoAccept offer that matches, or the first matching offer otherwise.
   */
  private matchStandingOffer(
    offers: StandingOffer[],
    request: {
      childCsd: { type: string; kind: string; tier: number };
      proposedRevShare?: number;
    },
  ): StandingOffer | undefined {
    let fallback: StandingOffer | undefined;

    for (const offer of offers) {
      const { conditions } = offer;

      // Check capability type constraint
      if (
        conditions.capabilityTypes.length > 0 &&
        !conditions.capabilityTypes.includes(request.childCsd.type)
      ) {
        continue;
      }

      // Check tier constraint
      if (request.childCsd.tier < conditions.minTier) {
        continue;
      }

      // Offer matches
      if (offer.autoAccept) {
        return offer; // return the first autoAccept match immediately
      }

      if (!fallback) {
        fallback = offer;
      }
    }

    return fallback;
  }

  /**
   * Check whether the child CSD and proposed rev share meet auto-license conditions.
   * Returns an array of failure reasons (empty = all conditions met).
   */
  private checkAutoLicenseConditions(
    conditions: LicensingTerms["autoLicense"],
    childCsd: { type: string; kind: string; tier: number },
    proposedRevShare: number,
  ): string[] {
    const failures: string[] = [];

    if (proposedRevShare < conditions.minRevSharePercent) {
      failures.push(
        `Proposed rev share ${proposedRevShare}% < minimum required ${conditions.minRevSharePercent}%`,
      );
    }

    if (childCsd.tier < conditions.minAssuranceTier) {
      failures.push(
        `Child CSD tier ${childCsd.tier} < minimum required tier ${conditions.minAssuranceTier}`,
      );
    }

    if (
      conditions.allowedCapabilityTypes.length > 0 &&
      !conditions.allowedCapabilityTypes.includes(childCsd.type)
    ) {
      failures.push(
        `Capability type "${childCsd.type}" not in allowed list: [${conditions.allowedCapabilityTypes.join(", ")}]`,
      );
    }

    if (
      conditions.allowedKinds.length > 0 &&
      !conditions.allowedKinds.includes(childCsd.kind as "base" | "profile" | "extension" | "workflow")
    ) {
      failures.push(
        `CSD kind "${childCsd.kind}" not in allowed list: [${conditions.allowedKinds.join(", ")}]`,
      );
    }

    return failures;
  }
}

// ── Singleton ─────────────────────────────────────────────────────────

let _engine: LicensingEngine | null = null;

export function getLicensingEngine(): LicensingEngine {
  if (!_engine) {
    _engine = new LicensingEngine();
  }
  return _engine;
}

export function resetLicensingEngine(): void {
  _engine = null;
}
