/**
 * Evidence levels (technical pack §3, must-close 5): how strongly an event
 * shows that the work was done. Weakest first:
 *
 *   submitted         the device TOOK the work: a spooler queued the job, an
 *                     API answered 202, a machine loaded the program, a carrier
 *                     picked up the parcel. Proves a request was made, never
 *                     that the work happened.
 *   device_reported   the device that did the work reports it finished: its
 *                     own completion record or its own measurement result.
 *                     Proves the device said so.
 *   inspected_output  the output itself was observed or measured by something
 *                     other than the device that produced it.
 *
 * The three are never interchangeable. pcc-node reports a device's acceptance
 * as `execution_progress` at level `submitted`, never as `execution_completed`
 * (PR #343), so a consumer that needs device_reported cannot be satisfied by an
 * accepted-only job, and a profile that needs inspected_output cannot be
 * satisfied by a device's report about its own output.
 *
 * A level says how strong the evidence is, not what it says: a failed
 * inspection is still inspected_output evidence. Failure and contradiction are
 * separate checks (the committed program's `execution_failed` absence, a
 * profile's onContradiction policy). `deriveContradictions` below is the one
 * public rule for contradictions: the oracle signs a reject only for a
 * contradiction it derives this way, never for a producer's say-so (J4).
 *
 * Classify only authenticated events: a bundle whose signature verified and
 * whose digest opens to its events for this job and kernel
 * (`verifyEvidenceSubjectBinding`). Fabricated events (`isFabricated`) prove no
 * level, and an event without a device attribution proves no level.
 *
 * Every member of EVIDENCE_EVENT_TYPES is ruled on below, including the ones
 * that prove no outcome level, so a new event type cannot join the vocabulary
 * without someone deciding its level (a test enforces the partition).
 */

import type { EvidenceEvent, EvidenceEventType } from "../types/evidence.js";
import { isFabricated } from "./is-fabricated.js";

export const EVIDENCE_LEVELS = ["submitted", "device_reported", "inspected_output"] as const;

export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

/** The device took the work; its outcome is not observed. */
export const SUBMITTED_EVENT_TYPES = [
  "gcode_received",
  "gcode_loaded",
  "method_loaded",
  "execution_progress",
  "courier_pickup_confirmed",
] as const satisfies readonly EvidenceEventType[];

/** The device that did the work reports it finished. */
export const DEVICE_REPORTED_EVENT_TYPES = [
  "execution_completed",
  "digital_task_completed",
  "batch_session_completed",
  "courier_delivery_confirmed",
] as const satisfies readonly EvidenceEventType[];

/**
 * An observation or measurement of the output. It is inspected_output only
 * when the events name the devices that executed the job and the observing
 * device is not one of them. A device measuring its own output is reporting,
 * and so is an observation whose independence cannot be shown (no executing
 * device in the events): both are device_reported.
 */
export const INSPECTION_EVENT_TYPES = [
  "cv_inspection_result",
  "photo_comparison_result",
  "instrument_result",
  "batch_sample_result",
] as const satisfies readonly EvidenceEventType[];

/**
 * Event types that prove no outcome level on their own: input commitments,
 * starts, failures, process telemetry, raw captures, log-chain records,
 * integrity and lifecycle records, and types with no producer yet.
 *
 * `printer_job_verified` is here on purpose: it is a log-capture summary
 * emitted unconditionally, with no success field, so it shows the log stream
 * ended, not that the print succeeded (evidence vocabulary ruling, 2026-09-07).
 * The custody, capture-protocol and touchstone events are here until a CSD
 * needs one of them as outcome evidence and composition rules on its level.
 */
export const NO_OUTCOME_LEVEL_EVENT_TYPES = [
  "gcode_hash_verified",
  "execution_started",
  "execution_failed",
  "power_profile_sample",
  "power_profile_summary",
  "vibration_signature",
  "acoustic_signature",
  "temperature_log",
  "camera_snapshot",
  "tee_attestation",
  "custody_sealed",
  "custody_handoff_initiated",
  "custody_handoff_confirmed",
  "sensor_data_summary",
  "sensor_anomaly_detected",
  "process_log_summary",
  "batch_session_started",
  "evidence_committed",
  "evidence_encrypted",
  "zk_proof_generated",
  "zk_proof_verified",
  "device_birth",
  "device_death",
  "device_heartbeat",
  "calibration_record",
  "sequence_started",
  "photo_captured",
  "photo_reference_set",
  "photo_anti_spoof_check",
  "printer_log_captured",
  "printer_job_verified",
  "log_hash_chain_entry",
  "workflow_step_completed",
  "digital_task_started",
  "touchstone_dispatched",
  "touchstone_verified",
  "capture_class_declared",
  "capture_nonce_issued",
  "capture_submitted",
  "capture_signature_verified",
  "capture_liveness_result",
  "capture_multi_sensor_fusion",
  "capture_anchor_committed",
] as const satisfies readonly EvidenceEventType[];

/**
 * Event types whose source device is doing the job. An inspection from one of
 * these devices is that device reporting on its own output.
 */
export const EXECUTION_EVENT_TYPES = [
  "gcode_received",
  "gcode_hash_verified",
  "gcode_loaded",
  "method_loaded",
  "sequence_started",
  "execution_started",
  "execution_progress",
  "execution_completed",
  "execution_failed",
  "batch_session_started",
  "batch_session_completed",
  "digital_task_started",
  "digital_task_completed",
] as const satisfies readonly EvidenceEventType[];

const SUBMITTED = new Set<string>(SUBMITTED_EVENT_TYPES);
const DEVICE_REPORTED = new Set<string>(DEVICE_REPORTED_EVENT_TYPES);
const INSPECTION = new Set<string>(INSPECTION_EVENT_TYPES);
const EXECUTION = new Set<string>(EXECUTION_EVENT_TYPES);

/** Position in EVIDENCE_LEVELS; higher is stronger. */
export function evidenceLevelRank(level: EvidenceLevel): number {
  return EVIDENCE_LEVELS.indexOf(level);
}

/** True when `reached` is at least as strong as `required`. Null meets nothing. */
export function meetsEvidenceLevel(reached: EvidenceLevel | null, required: EvidenceLevel): boolean {
  return reached !== null && evidenceLevelRank(reached) >= evidenceLevelRank(required);
}

function deviceIdOf(event: EvidenceEvent): string | null {
  const source: unknown = event.source;
  if (typeof source !== "object" || source === null) return null;
  const id = (source as { deviceId?: unknown }).deviceId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** The devices that executed the job, read from a bundle's own events. */
export function executingDeviceIds(events: readonly EvidenceEvent[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (!EXECUTION.has(event.type) || isFabricated(event)) continue;
    const id = deviceIdOf(event);
    if (id !== null) ids.add(id);
  }
  return ids;
}

/**
 * The level one event proves, or null. `executing` is the set of devices that
 * executed the job (`executingDeviceIds` of the same bundle).
 */
export function evidenceLevelOf(
  event: EvidenceEvent,
  executing: ReadonlySet<string>,
): EvidenceLevel | null {
  if (isFabricated(event)) return null;
  const deviceId = deviceIdOf(event);
  if (deviceId === null) return null;
  if (SUBMITTED.has(event.type)) return "submitted";
  if (DEVICE_REPORTED.has(event.type)) return "device_reported";
  if (INSPECTION.has(event.type)) {
    return executing.size > 0 && !executing.has(deviceId) ? "inspected_output" : "device_reported";
  }
  return null;
}

/**
 * The strongest level any event proves, or null. Pass every authenticated
 * event for the job (all of its bound bundles), so an inspection is judged
 * against every device that executed the job.
 */
export function evidenceLevelOfBundle(events: readonly EvidenceEvent[]): EvidenceLevel | null {
  const executing = executingDeviceIds(events);
  let best: EvidenceLevel | null = null;
  for (const event of events) {
    const level = evidenceLevelOf(event, executing);
    if (level !== null && (best === null || evidenceLevelRank(level) > evidenceLevelRank(best))) {
      best = level;
    }
  }
  return best;
}

/** A contradiction derivable from authenticated events (J4). */
export type ContradictionKind = "completion-and-failure" | "completion-and-failed-inspection";

/**
 * An inspection that reports its own negative verdict: an INSPECTION_EVENT_TYPES
 * event whose payload.passed is present and not true. With no passed field it
 * claims no verdict (and a pass/fail on values belongs to a profile tolerance).
 */
export function inspectionFailed(event: EvidenceEvent): boolean {
  if (!INSPECTION.has(event.type)) return false;
  const passed = (event.payload as Record<string, unknown> | undefined)?.passed;
  return passed !== undefined && passed !== true;
}

/**
 * The contradictions a set of AUTHENTICATED events shows, in this fixed order:
 *   - "completion-and-failure": a device-reported completion and an
 *     execution_failed in the same set;
 *   - "completion-and-failed-inspection": a device-reported completion and an
 *     inspection that reports its own negative verdict.
 * A failure with no completion is a device failure, not a contradiction.
 * Fabricated events prove nothing here either, so they are ignored. This is
 * the public, deterministic rule: the oracle signs a reject only for what it
 * derives here (J4), and profile admission reads the same predicate.
 */
export function deriveContradictions(events: readonly EvidenceEvent[]): ContradictionKind[] {
  const genuine = events.filter((e) => !isFabricated(e));
  const completed = genuine.some((e) => DEVICE_REPORTED.has(e.type));
  if (!completed) return [];
  const kinds: ContradictionKind[] = [];
  if (genuine.some((e) => e.type === "execution_failed")) kinds.push("completion-and-failure");
  if (genuine.some(inspectionFailed)) kinds.push("completion-and-failed-inspection");
  return kinds;
}
