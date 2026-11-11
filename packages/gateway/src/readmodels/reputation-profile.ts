import { isKernelStale } from "../facades/populators/staleness.js";

export const PROFILE_MIN_SAMPLE = 5;
export const PROFILE_WINDOW_DAYS = 30;
export const PROFILE_WINDOW_MS = PROFILE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
export const PROFILE_RULES = {
  compositionScore: "The composition reputation record: a 0-1000 score that starts at 500 and moves with finalized composition step outcomes and dispute rulings. GET /api/reputation/:agentId/deltas lists its recorded changes. This read never creates a record.",
  assuranceTier: "The maximum assurance tier stored on the kernel's record. This read reports that record and does not check it.",
  evidenceTiers: "This kernel's evidence bundles created in the window, counted by tier. These are stored records; this count does not check whether any was verified.",
  liveness: "Current liveness, not uptime: the kernel's status and last heartbeat. Only status online can be stale: its heartbeat age must exceed 5 minutes, or 24 hours if it lists at least one capability. A missing or invalid heartbeat is stale.",
  responseTime: "Seconds from an offer's posting to this kernel's claim, over offers posted in the window that this kernel claimed. Offers it did not claim count for nothing, so this is not a response rate. Offers this kernel posted are left out; self-posted offers the gateway cannot tie to the kernel, such as a DID poster's, are still counted.",
  evidenceCompleteness: "Of this kernel's jobs with status completed and a completion time in the window, how many have an evidence bundle stored for this kernel at or above the job's assurance tier (a job with no tier counts as tier 0). A completion is a recorded status, and this count does not check whether any bundle was verified. Jobs that finish through settlement (evidence_submitted, evidence_stored, settled) are not counted yet.",
};
export const PROFILE_QUALITY_SEE = "GET /api/registry/reputation/:entityId";

export interface ProfileKernel { id: string; status: string; lastHeartbeat: string | null; maxAssuranceTier: number }
export interface ProfileReputation { agentId: string; kind: string; score: number; positiveContributions: number; negativeContributions: number; disputesUpheld: number; disputesRejected: number; lastUpdatedAt: string }
export interface ProfileJob { id: string; kernelId: string | null; status: string; completedAt: string | null; assuranceTier: number | null }
export interface ProfileBundle { jobId: string; kernelId: string; assuranceTier: number; createdAt: string }
export interface ProfileClaimedOffer { postedAt: string; claimedAt: string | null; claimedByKernelId: string | null; posterKernelId: string | null }

export interface ReputationProfileSources {
  kernel(id: string): ProfileKernel | undefined;
  reputation(id: string): ProfileReputation | undefined;
  capabilityCount(kernelId: string): number;
  jobs(kernelId: string): ProfileJob[];
  bundles(kernelId: string): ProfileBundle[];
  claimedOffers(kernelId: string): ProfileClaimedOffer[];
  tenantEnforced: boolean;
}

type Unavailable<R extends string> = { state: "unavailable"; reason: R };
type RecordReason = "not_a_kernel" | "insufficient_sample" | "tenant_scoped" | "source_unreadable";

export interface ReputationProfileDTO {
  subject: { id: string; kind: string };
  asOf: string;
  window: { days: number; from: string; to: string };
  compositionScore:
    | { state: "measured"; score: number; positiveContributions: number; negativeContributions: number; disputesUpheld: number; disputesRejected: number; lastUpdatedAt: string; basis: "composition_deltas"; rule: string }
    | Unavailable<"no_record">;
  assuranceTier: { state: "declared"; tier: number; basis: "kernel_record"; rule: string } | Unavailable<"not_a_kernel">;
  evidenceTiers: { state: "measured"; byTier: Record<string, number>; total: number; basis: "stored_records"; rule: string } | Unavailable<RecordReason>;
  qualityRating: { state: "unavailable"; reason: "not_read"; see: string };
  uptime:
    | { state: "unavailable"; reason: "no_heartbeat_history"; liveness: { status: string; lastHeartbeat: string | null; isStale: boolean; rule: string } }
    | Unavailable<"not_a_kernel">;
  responseTime: { state: "measured"; medianSeconds: number; p90Seconds: number; sampleSize: number; basis: "job_offer_claims"; rule: string } | Unavailable<RecordReason>;
  evidenceCompleteness: { state: "measured"; completed: number; withEvidence: number; ratio: number; basis: "stored_records"; rule: string } | Unavailable<RecordReason>;
}

export function buildReputationProfile(subjectId: string, src: ReputationProfileSources, now: Date): ReputationProfileDTO | null {
  const k = src.kernel(subjectId);
  const r = src.reputation(subjectId);
  if (k === undefined && r === undefined) return null;
  const nowMs = now.getTime();
  const fromMs = nowMs - PROFILE_WINDOW_MS;
  const asOf = now.toISOString();
  const window = { days: PROFILE_WINDOW_DAYS, from: new Date(fromMs).toISOString(), to: asOf };
  const inWindow = (t: string | null | undefined): boolean => {
    if (typeof t !== "string") return false;
    const ms = Date.parse(t);
    return Number.isFinite(ms) && fromMs <= ms && ms <= nowMs;
  };
  const belowFloor = (n: number): boolean => n < PROFILE_MIN_SAMPLE;
  const qualityRating: ReputationProfileDTO["qualityRating"] = { state: "unavailable", reason: "not_read", see: PROFILE_QUALITY_SEE };
  const compositionScore: ReputationProfileDTO["compositionScore"] = r !== undefined
    ? { state: "measured", score: r.score, positiveContributions: r.positiveContributions, negativeContributions: r.negativeContributions, disputesUpheld: r.disputesUpheld, disputesRejected: r.disputesRejected, lastUpdatedAt: r.lastUpdatedAt, basis: "composition_deltas", rule: PROFILE_RULES.compositionScore }
    : { state: "unavailable", reason: "no_record" };
  if (k === undefined) {
    const subject = { id: subjectId, kind: (r as ProfileReputation).kind };
    return {
      subject,
      asOf,
      window,
      compositionScore,
      assuranceTier: { state: "unavailable", reason: "not_a_kernel" },
      evidenceTiers: { state: "unavailable", reason: "not_a_kernel" },
      qualityRating,
      uptime: { state: "unavailable", reason: "not_a_kernel" },
      responseTime: { state: "unavailable", reason: "not_a_kernel" },
      evidenceCompleteness: { state: "unavailable", reason: "not_a_kernel" },
    };
  }
  const subject = { id: subjectId, kind: "kernel" };
  const assuranceTier: ReputationProfileDTO["assuranceTier"] = { state: "declared", tier: k.maxAssuranceTier, basis: "kernel_record", rule: PROFILE_RULES.assuranceTier };
  const uptime: ReputationProfileDTO["uptime"] = { state: "unavailable", reason: "no_heartbeat_history", liveness: { status: k.status, lastHeartbeat: k.lastHeartbeat ?? null, isStale: isKernelStale(k.status, k.lastHeartbeat, src.capabilityCount(k.id) > 0, nowMs), rule: PROFILE_RULES.liveness } };
  let evidenceTiers: ReputationProfileDTO["evidenceTiers"];
  let responseTime: ReputationProfileDTO["responseTime"];
  let evidenceCompleteness: ReputationProfileDTO["evidenceCompleteness"];
  if (src.tenantEnforced) {
    evidenceTiers = { state: "unavailable", reason: "tenant_scoped" };
    responseTime = { state: "unavailable", reason: "tenant_scoped" };
    evidenceCompleteness = { state: "unavailable", reason: "tenant_scoped" };
  } else {
    let jobs: ProfileJob[] | undefined;
    let jobsUnreadable = false;
    try { jobs = src.jobs(k.id); } catch { jobsUnreadable = true; }
    let bundles: ProfileBundle[] | undefined;
    let bundlesUnreadable = false;
    try { bundles = src.bundles(k.id); } catch { bundlesUnreadable = true; }
    let claimedOffers: ProfileClaimedOffer[] | undefined;
    let claimedOffersUnreadable = false;
    try { claimedOffers = src.claimedOffers(k.id); } catch { claimedOffersUnreadable = true; }
    if (bundlesUnreadable) {
      evidenceTiers = { state: "unavailable", reason: "source_unreadable" };
    } else {
      const filtered = (bundles as ProfileBundle[]).filter((b) => b.kernelId === k.id && inWindow(b.createdAt));
      if (belowFloor(filtered.length)) {
        evidenceTiers = { state: "unavailable", reason: "insufficient_sample" };
      } else {
        const byTier: Record<string, number> = {};
        for (const b of filtered) {
          const key = String(b.assuranceTier);
          byTier[key] = (byTier[key] ?? 0) + 1;
        }
        evidenceTiers = { state: "measured", byTier, total: filtered.length, basis: "stored_records", rule: PROFILE_RULES.evidenceTiers };
      }
    }
    if (jobsUnreadable || bundlesUnreadable) {
      evidenceCompleteness = { state: "unavailable", reason: "source_unreadable" };
    } else {
      const done = (jobs as ProfileJob[]).filter((j) => j.kernelId === k.id && j.status === "completed" && inWindow(j.completedAt));
      if (belowFloor(done.length)) {
        evidenceCompleteness = { state: "unavailable", reason: "insufficient_sample" };
      } else {
        const allBundles = bundles as ProfileBundle[];
        let withEvidence = 0;
        for (const j of done) {
          const threshold = j.assuranceTier ?? 0;
          if (allBundles.some((b) => b.jobId === j.id && b.kernelId === k.id && b.assuranceTier >= threshold)) withEvidence += 1;
        }
        evidenceCompleteness = { state: "measured", completed: done.length, withEvidence, ratio: withEvidence / done.length, basis: "stored_records", rule: PROFILE_RULES.evidenceCompleteness };
      }
    }
    if (claimedOffersUnreadable) {
      responseTime = { state: "unavailable", reason: "source_unreadable" };
    } else {
      const durations: number[] = [];
      for (const o of (claimedOffers as ProfileClaimedOffer[])) {
        if (o.claimedByKernelId === k.id && o.claimedAt != null && o.posterKernelId !== k.id && inWindow(o.postedAt)) {
          const secs = (Date.parse(o.claimedAt) - Date.parse(o.postedAt)) / 1000;
          if (Number.isFinite(secs) && secs >= 0) durations.push(secs);
        }
      }
      if (belowFloor(durations.length)) {
        responseTime = { state: "unavailable", reason: "insufficient_sample" };
      } else {
        durations.sort((a, b) => a - b);
        const n = durations.length;
        const medianSeconds = n % 2 === 1 ? durations[(n - 1) / 2] : (durations[n / 2 - 1] + durations[n / 2]) / 2;
        const p90Seconds = durations[Math.ceil(0.9 * n) - 1];
        responseTime = { state: "measured", medianSeconds, p90Seconds, sampleSize: n, basis: "job_offer_claims", rule: PROFILE_RULES.responseTime };
      }
    }
  }
  return {
    subject,
    asOf,
    window,
    compositionScore,
    assuranceTier,
    evidenceTiers,
    qualityRating,
    uptime,
    responseTime,
    evidenceCompleteness,
  };
}
