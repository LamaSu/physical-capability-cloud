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
 *
 * Nothing that runs after this module loads can change a level, a
 * contradiction or a verdict it returns (#363 round 9, steward #5186; the
 * realm-mutation class of astra packs 162-171). It calls only intrinsics
 * captured at load (util/primordials.ts), plain loops and operators: never a
 * method looked up on a prototype or a global at the time of the call, never
 * the iterator protocol, never `in` or a RegExp. Its exported lists are frozen
 * where they are defined, and its sets are null-prototype records built from
 * them at load. It reads an event's own data properties only, so a value
 * written on Object.prototype (a `passed`, a `deviceId`, a `simulated`) is
 * never taken for the event's, and an accessor is never run. `isFabricated`,
 * the one canonical predicate, is asked about the event's own data: a null-
 * prototype view of its source and payload. A Set passed in or returned
 * (`executingDeviceIds`, `evidenceLevelOf`) is read and built with
 * Set.prototype's methods as they were at load, so it must be a native Set.
 * The boundary: a realm whose intrinsics were replaced before @pcc/spec
 * loaded is out of scope, since no in-process check can tell.
 */

import type { EvidenceEvent, EvidenceEventType } from "../types/evidence.js";
import { isFabricated } from "./is-fabricated.js";
import {
  append,
  hasOwn,
  inSet,
  newList,
  ObjectCreate,
  ObjectFreeze,
  ObjectGetOwnPropertyDescriptor,
  ownDataValue,
  ReflectOwnKeys,
  SetCtor,
  SetPrototypeAdd,
  SetPrototypeHas,
  SetPrototypeSize,
  stringSet,
} from "../util/primordials.js";

/** Frozen: profile validation reads it (as ACCEPTANCE_LEVELS), so nothing may add a level after load (astra pack 170). */
export const EVIDENCE_LEVELS = ObjectFreeze(["submitted", "device_reported", "inspected_output"] as const);

export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

/** The device took the work; its outcome is not observed. */
export const SUBMITTED_EVENT_TYPES = ObjectFreeze([
  "gcode_received",
  "gcode_loaded",
  "method_loaded",
  "execution_progress",
  "courier_pickup_confirmed",
] as const satisfies readonly EvidenceEventType[]);

/** The device that did the work reports it finished. */
export const DEVICE_REPORTED_EVENT_TYPES = ObjectFreeze([
  "execution_completed",
  "digital_task_completed",
  "batch_session_completed",
  "courier_delivery_confirmed",
] as const satisfies readonly EvidenceEventType[]);

/**
 * An observation or measurement of the output. It is inspected_output only
 * when the events name the devices that executed the job and the observing
 * device is not one of them. A device measuring its own output is reporting,
 * and so is an observation whose independence cannot be shown (no executing
 * device in the events): both are device_reported.
 */
export const INSPECTION_EVENT_TYPES = ObjectFreeze([
  "cv_inspection_result",
  "photo_comparison_result",
  "instrument_result",
  "batch_sample_result",
] as const satisfies readonly EvidenceEventType[]);

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
export const NO_OUTCOME_LEVEL_EVENT_TYPES = ObjectFreeze([
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
] as const satisfies readonly EvidenceEventType[]);

/**
 * Event types whose source device is doing the job. An inspection from one of
 * these devices is that device reporting on its own output.
 */
export const EXECUTION_EVENT_TYPES = ObjectFreeze([
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
] as const satisfies readonly EvidenceEventType[]);

/** The lists as null-prototype records, built when this module loads: membership consults no prototype and no Set method. */
const SUBMITTED = stringSet(SUBMITTED_EVENT_TYPES);
const DEVICE_REPORTED = stringSet(DEVICE_REPORTED_EVENT_TYPES);
const INSPECTION = stringSet(INSPECTION_EVENT_TYPES);
const EXECUTION = stringSet(EXECUTION_EVENT_TYPES);

/** Position in EVIDENCE_LEVELS; higher is stronger. -1 for anything else, as `indexOf` answered. */
export function evidenceLevelRank(level: EvidenceLevel): number {
  for (let i = 0; i < EVIDENCE_LEVELS.length; i++) if (EVIDENCE_LEVELS[i] === level) return i;
  return -1;
}

/** True when `reached` is at least as strong as `required`. Null meets nothing. */
export function meetsEvidenceLevel(reached: EvidenceLevel | null, required: EvidenceLevel): boolean {
  return reached !== null && evidenceLevelRank(reached) >= evidenceLevelRank(required);
}

/** A null-prototype copy of `o`'s own string-keyed data properties, one level deep; undefined when `o` is not an object. */
function ownView(o: unknown): Record<string, unknown> | undefined {
  if (typeof o !== "object" || o === null) return undefined;
  const view = ObjectCreate(null) as Record<string, unknown>;
  const keys = ReflectOwnKeys(o);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if (typeof key !== "string") continue;
    const descriptor = ObjectGetOwnPropertyDescriptor(o, key);
    if (descriptor !== undefined && hasOwn(descriptor, "value")) view[key] = descriptor.value;
  }
  return view;
}

/**
 * `isFabricated` (is-fabricated.ts, the one canonical predicate), asked about
 * the event's own data only: a view of its source and payload with no
 * prototype, so Object.prototype.simulated or .mock, written after load,
 * neither fabricates a genuine event nor hides a contradiction.
 */
function fabricated(event: unknown): boolean {
  const view = ObjectCreate(null) as Record<string, unknown>;
  view.source = ownView(ownDataValue(event, "source"));
  view.payload = ownView(ownDataValue(event, "payload"));
  return isFabricated(view as unknown as EvidenceEvent);
}

function deviceIdOf(event: unknown): string | null {
  const source = ownDataValue(event, "source");
  if (typeof source !== "object" || source === null) return null;
  const id = ownDataValue(source, "deviceId");
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** The devices that executed the job, read from a bundle's own events. A native Set, built with Set.prototype.add as it was at load. */
export function executingDeviceIds(events: readonly EvidenceEvent[]): ReadonlySet<string> {
  const ids = new SetCtor<string>();
  for (let i = 0; i < events.length; i++) {
    const event = ownDataValue(events, i);
    if (!inSet(EXECUTION, ownDataValue(event, "type")) || fabricated(event)) continue;
    const id = deviceIdOf(event);
    if (id !== null) SetPrototypeAdd(ids, id);
  }
  return ids;
}

/**
 * The level one event proves, or null. `executing` is the set of devices that
 * executed the job (`executingDeviceIds` of the same bundle), a native Set:
 * it is read with Set.prototype's methods as they were at load.
 */
export function evidenceLevelOf(
  event: EvidenceEvent,
  executing: ReadonlySet<string>,
): EvidenceLevel | null {
  if (fabricated(event)) return null;
  const deviceId = deviceIdOf(event);
  if (deviceId === null) return null;
  const type = ownDataValue(event, "type");
  if (inSet(SUBMITTED, type)) return "submitted";
  if (inSet(DEVICE_REPORTED, type)) return "device_reported";
  if (inSet(INSPECTION, type)) {
    return SetPrototypeSize(executing) > 0 && !SetPrototypeHas(executing, deviceId) ? "inspected_output" : "device_reported";
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
  for (let i = 0; i < events.length; i++) {
    const level = evidenceLevelOf(ownDataValue(events, i) as EvidenceEvent, executing);
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
  if (!inSet(INSPECTION, ownDataValue(event, "type"))) return false;
  const passed = ownDataValue(ownDataValue(event, "payload"), "passed");
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
  let completed = false;
  let failed = false;
  let failedInspection = false;
  for (let i = 0; i < events.length; i++) {
    const event = ownDataValue(events, i);
    if (fabricated(event)) continue;
    const type = ownDataValue(event, "type");
    if (inSet(DEVICE_REPORTED, type)) completed = true;
    if (type === "execution_failed") failed = true;
    if (inspectionFailed(event as EvidenceEvent)) failedInspection = true;
  }
  const kinds = newList<ContradictionKind>(0);
  if (!completed) return kinds;
  if (failed) append(kinds, "completion-and-failure");
  if (failedInspection) append(kinds, "completion-and-failed-inspection");
  return kinds;
}
