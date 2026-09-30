/**
 * EvidenceProvenanceDTO (@pcc/spec readmodels/evidence-provenance.ts): the loader and the builder.
 * Vocabulary per the evidence lane (#3346, #3680): evidence integrity has ONE model,
 * event_bundle_hash (hashEvent + hashBundle, what /settle recomputes), and only it is
 * `recomputed_match`. The /complete envelope hash is `storage_envelope_match` (model
 * gateway_envelope): the gateway's storage integrity, never evidence integrity. Neither
 * fabricated events, gateway-stamped events, nor events naming no device at all count toward
 * tier coverage, and the gateway's zero-address placeholder signature is no signature. Nothing
 * here reads "verified".
 */
import { createHash } from "node:crypto";
import {
  DEFAULT_TIER_REQUIREMENTS,
  EVIDENCE_PROVENANCE_SCHEMA_ID,
  hashBundle,
  hashEvent,
  isFabricated,
  type EvidenceEvent,
  type EvidenceIntegrity,
  type EvidenceProvenanceDTO,
  type ProvenanceBundle,
} from "@pcc/spec";
import { buildCanonicalEvidenceEnvelope } from "../services/evidence-envelope.js";
import { PLACEHOLDER_SIGNATURE_VALUES, ZERO_ADDRESS } from "../services/device-evidence-settlement.js";
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

/**
 * The deviceId the gateway stamps on events it writes itself (PUT /complete: its own
 * execution_completed and the caller's body events). No device reported such an event.
 * #345 names this GATEWAY_STAMPED_DEVICE_ID; the literal stands in until it lands.
 */
const GATEWAY_DEVICE = "gateway";
/** The kernel emitter's marker for a test signature: not a signature. */
const TEST_SIGNATURE_PREFIX = "test_sig_";

const gatewayStamped = (e: ProvenanceEventRow) => e.source?.deviceId === GATEWAY_DEVICE;

/**
 * True iff a device reported this event: it names a non-empty deviceId that is not the
 * gateway's own stamp. A missing source (source: null, or no deviceId at all) reports
 * nothing and does not count (evidence M3) — absence of the gateway's stamp is not
 * presence of a device.
 */
const deviceReported = (e: ProvenanceEventRow) => {
  const deviceId = e.source?.deviceId;
  return typeof deviceId === "string" && deviceId !== "" && deviceId !== GATEWAY_DEVICE;
};

function claimedTier(t: unknown): 0 | 1 | 2 | 3 | null {
  return t === 0 || t === 1 || t === 2 || t === 3 ? t : null;
}

/** Evidence integrity (LO-EV): every event hash, then the bundle hash over them. */
async function eventBundleHashMatches(b: ProvenanceBundleRow): Promise<boolean> {
  const events = b.events as unknown as EvidenceEvent[];
  const eventHashesOk = (await Promise.all(events.map(async (e) => (await hashEvent(e)) === e.hash))).every(Boolean);
  return eventHashesOk && (await hashBundle(events)) === b.bundleHash;
}

/** Gateway storage integrity: the envelope /complete hashes. */
function storageEnvelopeMatches(b: ProvenanceBundleRow): boolean {
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
  return `sha256:${createHash("sha256").update(envelope).digest("hex")}` === b.bundleHash;
}

/**
 * Recomputed integrity. A model that cannot even run on a stored bundle (a value the canonical
 * form refuses, e.g. an integer beyond 2^53-1 once #359 lands) does not reproduce: it is caught
 * for that bundle, so one old row never fails the whole read.
 */
async function integrityOf(b: ProvenanceBundleRow): Promise<EvidenceIntegrity> {
  if (b.events.length === 0) return { state: "not_recomputable", model: null };
  const safely = async (check: () => boolean | Promise<boolean>) => {
    try {
      return await check();
    } catch {
      return false;
    }
  };
  if (await safely(() => eventBundleHashMatches(b))) return { state: "recomputed_match", model: "event_bundle_hash" };
  if (await safely(() => storageEnvelopeMatches(b))) return { state: "storage_envelope_match", model: "gateway_envelope" };
  return { state: "no_model_reproduces", model: null };
}

function tierCoverageOf(tier: 0 | 1 | 2 | 3 | null, events: ProvenanceEventRow[]): ProvenanceBundle["tierCoverage"] {
  // Only what a device reported counts: not fabricated events, and only events that name a
  // non-empty deviceId other than the gateway's own stamp (evidence #3680 F1: /complete stamps
  // the caller's body events "gateway"; evidence M3: a source-less event names no device at all,
  // so it is excluded the same way, not counted by default).
  const counted = events.filter((e) => !isFabricated(e as unknown as EvidenceEvent) && deviceReported(e));
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
  // A placeholder is no signature: the gateway's zero-address signer (evidence #3680 F2), any
  // value the gateway writes when it has no device signature (PUT /complete's "gateway-auto-sign",
  // the operator relay's "operator-relay-auto": evidence #4088), or the emitter's test marker.
  // These are the non-signature checks isDeviceSignedSignature applies; the algorithm is not
  // required to be ed25519, since a secp256k1 kernel signature is still a signature to show.
  const placeholder =
    (typeof o.signer === "string" && o.signer.toLowerCase() === ZERO_ADDRESS) ||
    (typeof o.value === "string" && (PLACEHOLDER_SIGNATURE_VALUES.has(o.value) || o.value.startsWith(TEST_SIGNATURE_PREFIX)));
  if (placeholder) return { signer: null, algorithm: null, checked: false };
  return {
    signer: typeof o.signer === "string" && o.signer !== "" ? o.signer : null,
    algorithm: typeof o.algorithm === "string" && o.algorithm !== "" ? o.algorithm : null,
    checked: false,
  };
}

/**
 * The earliest and latest recorded timestamps, ordered by the time they parse to (a raw string
 * sort puts "...00.500Z" before "...00Z") and shown as recorded. Unparseable ones are skipped.
 */
function timeRange(events: ProvenanceEventRow[]): { firstAt: string | null; lastAt: string | null } {
  let first: { at: string; ms: number } | null = null;
  let last: { at: string; ms: number } | null = null;
  for (const e of events) {
    if (typeof e.timestamp !== "string" || e.timestamp === "") continue;
    const ms = Date.parse(e.timestamp);
    if (!Number.isFinite(ms)) continue;
    if (!first || ms < first.ms) first = { at: e.timestamp, ms };
    if (!last || ms > last.ms) last = { at: e.timestamp, ms };
  }
  return { firstAt: first?.at ?? null, lastAt: last?.at ?? null };
}

async function bundleOf(jobId: string, b: ProvenanceBundleRow): Promise<ProvenanceBundle> {
  const events = Array.isArray(b.events) ? b.events : [];
  const { firstAt, lastAt } = timeRange(events);
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
      gatewayAuthored: events.filter(gatewayStamped).length,
      firstAt,
      lastAt,
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
