/**
 * EvidenceProvenanceDTO (@pcc/spec readmodels/evidence-provenance.ts): the loader and the builder.
 * Vocabulary per the evidence lane (#3346): evidence integrity has ONE model, event_bundle_hash
 * (hashEvent + hashBundle, what /settle recomputes). The /complete envelope hash is reported as
 * gateway_envelope, the gateway's storage integrity, never as evidence integrity. Fabricated
 * events never count toward tier coverage. Nothing here reads "verified".
 */
import { createHash } from "node:crypto";
import {
  DEFAULT_TIER_REQUIREMENTS,
  EVIDENCE_PROVENANCE_SCHEMA_ID,
  hashBundle,
  hashEvent,
  isFabricated,
  type EvidenceEvent,
  type EvidenceIntegrityModel,
  type EvidenceIntegrityState,
  type EvidenceProvenanceDTO,
  type ProvenanceBundle,
} from "@pcc/spec";
import { buildCanonicalEvidenceEnvelope } from "../services/evidence-envelope.js";
import type { SourceRead } from "./job-execution.js";

export interface ProvenanceEventRow {
  id: string;
  type: string;
  timestamp: string;
  source: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
  hash: string;
}

export interface ProvenanceBundleRow {
  id: string;
  jobId: string;
  stepId: string;
  kernelId: string;
  assuranceTier: number;
  bundleHash: string;
  kernelSignature?: unknown;
  createdAt: string;
  events: ProvenanceEventRow[];
}

export interface EvidenceProvenanceRepos {
  evidence: {
    findByJob(jobId: string): unknown[];
    findEventsByBundle(bundleId: string): unknown[];
  };
}

/** Every bundle of the job, with its events. Scoped through the job, which the route gated. */
export function loadEvidenceProvenance(jobId: string, repos: EvidenceProvenanceRepos): SourceRead<ProvenanceBundleRow[]> {
  try {
    const bundles = repos.evidence.findByJob(jobId) as Array<Omit<ProvenanceBundleRow, "events">>;
    return {
      ok: true,
      value: bundles.map((b) => ({ ...b, events: repos.evidence.findEventsByBundle(b.id) as ProvenanceEventRow[] })),
    };
  } catch {
    return { ok: false };
  }
}

const GATEWAY_DEVICE = "gateway";

function claimedTier(t: unknown): 0 | 1 | 2 | 3 | null {
  return t === 0 || t === 1 || t === 2 || t === 3 ? t : null;
}

async function integrityOf(b: ProvenanceBundleRow): Promise<{ state: EvidenceIntegrityState; model: EvidenceIntegrityModel | null }> {
  if (b.events.length === 0) return { state: "not_recomputable", model: null };
  const events = b.events as unknown as EvidenceEvent[];
  // Evidence integrity (LO-EV): every event hash, then the bundle hash over them.
  const eventHashesOk = (await Promise.all(events.map(async (e) => (await hashEvent(e)) === e.hash))).every(Boolean);
  if (eventHashesOk && (await hashBundle(events)) === b.bundleHash) return { state: "recomputed_match", model: "event_bundle_hash" };
  // Gateway storage integrity: the envelope /complete hashes.
  const envelope = buildCanonicalEvidenceEnvelope(
    {
      id: b.id,
      jobId: b.jobId,
      stepId: b.stepId,
      kernelId: b.kernelId,
      assuranceTier: b.assuranceTier,
      createdAt: b.createdAt,
      kernelSignature: b.kernelSignature,
    },
    b.events,
  );
  if (`sha256:${createHash("sha256").update(envelope).digest("hex")}` === b.bundleHash) {
    return { state: "recomputed_match", model: "gateway_envelope" };
  }
  return { state: "no_model_reproduces", model: null };
}

function tierCoverageOf(tier: 0 | 1 | 2 | 3 | null, events: ProvenanceEventRow[]): ProvenanceBundle["tierCoverage"] {
  const counted = events.filter((e) => !isFabricated(e as unknown as EvidenceEvent));
  const req = tier === null ? undefined : DEFAULT_TIER_REQUIREMENTS.find((r) => r.tier === tier);
  if (!req) {
    return { state: "unknown_tier", required: [], missing: [], minimumEvents: null, countedEvents: counted.length, basis: "recorded_event_types" };
  }
  const types = new Set(counted.map((e) => e.type));
  const required = req.requiredEventTypes.map((group) => [...group]);
  const missing = required.filter((group) => !group.some((t) => types.has(t)));
  const covers = missing.length === 0 && counted.length >= req.minimumEvents;
  return {
    state: covers ? "covers" : "missing",
    required,
    missing,
    minimumEvents: req.minimumEvents,
    countedEvents: counted.length,
    basis: "recorded_event_types",
  };
}

function signatureOf(sig: unknown): ProvenanceBundle["signature"] {
  const o = sig !== null && typeof sig === "object" ? (sig as Record<string, unknown>) : {};
  return {
    signer: typeof o.signer === "string" && o.signer !== "" ? o.signer : null,
    algorithm: typeof o.algorithm === "string" && o.algorithm !== "" ? o.algorithm : null,
    checked: false,
  };
}

async function bundleOf(jobId: string, b: ProvenanceBundleRow): Promise<ProvenanceBundle> {
  const events = Array.isArray(b.events) ? b.events : [];
  const times = events.map((e) => e.timestamp).filter((t): t is string => typeof t === "string" && t !== "").sort();
  const tier = claimedTier(b.assuranceTier);
  return {
    bundleId: b.id,
    stepId: b.stepId,
    kernelId: b.kernelId,
    storedAt: b.createdAt,
    bundleHash: b.bundleHash,
    claimedTier: tier,
    events: {
      count: events.length,
      types: [...new Set(events.map((e) => e.type))].sort(),
      fabricated: events.filter((e) => isFabricated(e as unknown as EvidenceEvent)).length,
      gatewayAuthored: events.filter((e) => e.source?.deviceId === GATEWAY_DEVICE).length,
      firstAt: times[0] ?? null,
      lastAt: times[times.length - 1] ?? null,
    },
    signature: signatureOf(b.kernelSignature),
    integrity: await integrityOf({ ...b, events }),
    tierCoverage: tierCoverageOf(tier, events),
    archive: { state: "not_recorded" },
    inspect: {
      envelope: `GET /api/evidence/${encodeURIComponent(b.bundleHash)}`,
      events: `GET /api/evidence/${encodeURIComponent(jobId)}`,
    },
  };
}

const NO_VERDICT = {
  state: "no_verdict_recorded" as const,
  reason: "The gateway stores no verifier or oracle verdict for a bundle, so it cannot say this evidence was verified.",
};

export async function buildEvidenceProvenanceDTO(
  jobId: string,
  read: SourceRead<ProvenanceBundleRow[]>,
  asOf: string,
): Promise<EvidenceProvenanceDTO> {
  const base = { schemaId: EVIDENCE_PROVENANCE_SCHEMA_ID, asOf, jobId, verification: NO_VERDICT, source: "gateway_evidence_store" as const };
  if (!read.ok) {
    return { ...base, state: "unavailable", reason: "The evidence store could not be read.", bundles: [], counts: null };
  }
  const bundles = await Promise.all(read.value.map((b) => bundleOf(jobId, b)));
  bundles.sort((a, b) => (a.storedAt < b.storedAt ? 1 : a.storedAt > b.storedAt ? -1 : a.bundleId < b.bundleId ? -1 : 1));
  return {
    ...base,
    state: bundles.length === 0 ? "none" : "received",
    reason: null,
    bundles,
    counts: {
      bundles: bundles.length,
      events: bundles.reduce((n, b) => n + b.events.count, 0),
      fabricatedEvents: bundles.reduce((n, b) => n + b.events.fabricated, 0),
      gatewayAuthoredEvents: bundles.reduce((n, b) => n + b.events.gatewayAuthored, 0),
    },
  };
}
