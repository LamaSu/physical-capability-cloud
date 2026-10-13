/**
 * Evidence levels (technical pack §3, must-close 5): how strongly evidence
 * shows that the work was done. Weakest first:
 *
 *   submitted         the device TOOK the work: a spooler queued the job, an
 *                     API answered 202, a machine loaded the program, a carrier
 *                     picked up the parcel. Proves a request was made, never
 *                     that the work happened.
 *   device_reported   the device that did the work reports it finished: its
 *                     own completion record, or a result record that cannot be
 *                     shown to come from an independent party. Proves the
 *                     device said so.
 *   inspected_output  the output itself was observed or measured, with a valid
 *                     verdict, by a party in a different AUTHENTICATED trust
 *                     domain from every executor of the job.
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
 * THE CONTRACT. Nothing inside an event can vouch for itself, so this module
 * trusts only what the caller authenticated and refuses to guess the rest.
 *
 * 1. Authenticated bundles, ONE settlement unit. Callers pass
 *    `AuthenticatedBundle`s: bundles whose signature verified and whose digest
 *    opens to their events for this job and kernel
 *    (`verifyEvidenceSubjectBinding`), with `events` exactly as verified.
 *    Bundle boundaries are part of the input because fabrication (5) is a
 *    property of a bundle. SCOPE: one call covers the bundles of ONE
 *    settlement unit (one job step), the unit EvidenceBlockV2 commits ONE
 *    bundle for. Evidence-lane ruling (E5/F5): no PCC flow retries a job under
 *    the same job id (pcc-node has no retry, the gateway has none, a failed
 *    unit is refunded and a new attempt is a new job). So within a unit a
 *    completion plus a failure IS a contradiction, and refusing it is
 *    fail-closed. This module does not correlate attempts, steps or devices:
 *    never pass the bundles of different attempts, steps or jobs together, or a
 *    failed first attempt will contradict a successful later one.
 *
 * 2. Trust domains, never declared device ids. Independence is judged between
 *    AUTHENTICATED trust domains: the operator principal
 *    (`eip155:<chainId>:0x<40 lowercase hex>`, the pcc.evidence.principal-id.v1
 *    operator form) that owns the bundle's VERIFIED signer in the pinned
 *    registry (`AuthenticatedBundle.trustDomain`). `source.deviceId` is a
 *    string the signer chose: one device can be spelled two ways, a signer can
 *    invent a second id or name a decoy. It is never compared for independence;
 *    it only attributes an event to some device (6). A `trustDomain` or an
 *    `executorTrustDomains` entry that is present but not in the exact operator
 *    form throws `EvidenceLevelInputError`, and so does `bundles` not being an
 *    array or a bundle whose `events` is not an array.
 *
 * 3. Authoritative executors. The executor set E is `context.executorTrustDomains`
 *    (the operators the job was ASSIGNED to, from the accepted job or deal,
 *    never from events) plus the trust domain of every bundle, fabricated or
 *    not, that holds ANY `EXECUTION_EVENT_TYPES` event. If such a bundle has no
 *    trust domain, E is UNKNOWN. An inspection is `inspected_output` only if
 *    ALL of these hold: `executorTrustDomains` is non-empty; E is not unknown;
 *    the inspection's bundle has a trust domain; that domain is not in E.
 *    Otherwise an inspection with a valid verdict is `device_reported`.
 *    `evidenceLevelsOfEvents` returns the level each event proves (bundle index,
 *    event index, level; null for a fabricated bundle's events and for events
 *    that prove nothing) by these same rules, and `evidenceLevelOfBundles` is
 *    the maximum over it.
 *
 * 4. Verdict pinning. An inspection proves a level only if its payload carries
 *    a valid verdict. `inspectionVerdict` reads ONE pinned field per inspection
 *    type, in a closed value domain, and answers pass, fail, none or
 *    malformed. Only pass and fail prove a level (none and malformed prove NO
 *    level, not even device_reported). In contradictions a fail or a malformed
 *    verdict counts as a failed inspection (fail closed) and none does not.
 *    Keys are matched after an ASCII trim and ASCII lowercase (`Passed`,
 *    ` passed`, `PASS`, `Status` all count as present); a spelling of the pinned
 *    field that is not the exact key is malformed, not a pass, even beside the
 *    exact key. A DIFFERENT verdict-looking key beside a valid exact pinned
 *    field is malformed too (two claims; no real producer emits one).
 *    Pinned: instrument_result `pass` (boolean), cv_inspection_result
 *    `passed` (boolean) and batch_sample_result `status` ("PASS" or "FAIL").
 *    photo_comparison_result has no producer, so no pinned field. A cv
 *    payload with `pass` and no `passed` is malformed: `pass` is the types/dpp.ts
 *    reader's spelling, not what any producer emits.
 *
 * 5. Fabrication is bundle-wide. One fabricated event (`isFabricated`) makes the
 *    whole bundle non-authentic, as `bundleHasFabricatedEvents` defines it: it
 *    proves no level and `deriveContradictions` ignores it. Its trust domain (or
 *    UNKNOWN) still joins E when it carries an execution event, so independence
 *    fails closed.
 *
 * 6. Attribution. An event with no non-empty string `source.deviceId` proves no
 *    level. The gateway's own stamp (`GATEWAY_STAMPED_DEVICE_ID`, compared after
 *    an ASCII trim and ASCII lowercase) is not a device attribution: those
 *    events are the gateway's record of a completion call, and the caller chose
 *    their types. A read model that shows levels for recorded, unauthenticated
 *    events gets the same answer.
 *
 * 7. One read per call. Each call reads its input exactly once, into one frozen
 *    fact record per event: `bundles.length`, each bundle, its `events`,
 *    `trustDomain` and `events.length`, each event, and each event's `type`,
 *    `source`, `payload`, `source.deviceId`, `source.simulated`, `payload.mock`
 *    and the payload's verdict material. Levels and contradictions are computed
 *    from those facts only, so a Proxy array or an accessor that answers
 *    differently on each read cannot make two passes disagree about the same
 *    event: the one read decides. A getter that throws propagates its error; it
 *    can refuse a classification, never skew one.
 *
 * Every member of EVIDENCE_EVENT_TYPES is ruled on below, including the ones
 * that prove no outcome level, so a new event type cannot join the vocabulary
 * without someone deciding its level (a test enforces the partition).
 *
 * 8. Nothing that runs after this module loads can change a level, a verdict or
 *    a contradiction it returns (steward #5186, evidence #6440; the realm-
 *    mutation class of astra packs 162-171). It calls only intrinsics captured
 *    at load (util/primordials.ts), plain index loops and operators: never a
 *    method looked up on a prototype or a global at the time of the call, never
 *    the iterator protocol, spread, `in` or a RegExp. Its exported lists are
 *    frozen where they are defined, and its sets and the pinned-verdict table are
 *    frozen null-prototype records built from them at load. Rule 7's reads stay
 *    one read each, but of OWN properties only: an event's type, source and
 *    payload, source.deviceId and source.simulated, a bundle's events and
 *    trustDomain, payload.mock, the context's executorTrustDomains and every
 *    list element. A value or getter written on Object.prototype or
 *    Array.prototype is never taken for the input's (an own accessor still runs
 *    once), and a primitive source or payload is read as having no fields, never
 *    boxed. The boundary: a realm whose intrinsics were replaced before
 *    @pcc/spec loaded is out of scope, since no in-process check can tell.
 */

import type { EvidenceEvent, EvidenceEventType } from "../types/evidence.js";
import { isFabricated } from "./is-fabricated.js";
import {
  append,
  ArrayIsArray,
  charCodeAt,
  hasOwn,
  inSet,
  NumberIsInteger,
  ObjectCreate,
  ObjectFreeze,
  ObjectGetOwnPropertyDescriptor,
  ObjectGetPrototypeOf,
  ObjectPrototype,
  ReflectOwnKeys,
  stringSet,
} from "../util/primordials.js";

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
 * An observation or measurement of the output. It proves a level only when its
 * payload carries a valid verdict (`inspectionVerdict` is pass or fail). It is
 * then inspected_output only when the inspector's authenticated trust domain is
 * shown to be outside every executor's; a party measuring its own output is
 * reporting, and so is an observation whose independence cannot be shown (no
 * assigned executor, an unknown executor, no trust domain): all device_reported.
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
 * Event types that show a party is executing the job. A bundle that holds any
 * of them puts its trust domain in the executor set, so an inspection signed in
 * that domain is that party reporting on its own output.
 *
 * Every submitted and device-reported type is here: a party that took or
 * finished the work (a courier leg too) is executing it (cross-family E5b). So
 * are the executing party's own lifecycle records and logs, and the custody
 * chain: sealing, initiating and confirming a handoff are a physical leg's work
 * (E5c). In PCC the only producer of `custody_handoff_confirmed` and of
 * `photo_captured` is the print-and-mail driver handoff
 * (gateway/src/services/print-and-mail-handoff.ts), i.e. the party doing the
 * leg. A future flow where an inspector confirms receipt needs its own type and
 * ruling: until then a receiving party that confirms custody is part of the
 * chain, not independent (fail closed). Telemetry,
 * captures, custody, integrity and device-lifecycle records are NOT: an
 * independent observer (a sensor kit, a receiving lab) may emit them
 * (`NON_EXECUTOR_EVENT_TYPES`). Every vocabulary member is in exactly one of
 * the two lists, and a test fails if a new type is not ruled on.
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
  "courier_pickup_confirmed",
  "courier_delivery_confirmed",
  "workflow_step_completed",
  "printer_log_captured",
  "printer_job_verified",
  "process_log_summary",
  "log_hash_chain_entry",
  "custody_sealed",
  "custody_handoff_initiated",
  "custody_handoff_confirmed",
  "photo_captured",
] as const satisfies readonly EvidenceEventType[]);

/**
 * Event types that do not identify an executing party: inspections, and the
 * telemetry, captures, integrity and device-lifecycle records an independent
 * observer may also emit. The rulings are tied to the producers in this repo
 * (audit for cross-family E5c, 2026-10-01):
 *   - inspections: inspection cameras (kernel photo-camera-adapter,
 *     mock-camera, onboard-kit camera template), lab instruments (sila,
 *     pylabrobot), the chromatograph;
 *   - camera_snapshot: inspection cameras, and the driver handoff (which always
 *     also emits custody_handoff_confirmed, so the driver is an executor anyway);
 *   - power / temperature / sensor_data_summary: sensor kits and power monitors
 *     (modbus, onboard-kit sensor template), which can be independent observers;
 *   - calibration_record, device_birth/death/heartbeat: instrument and device
 *     lifecycle (sila, pylabrobot);
 *   - evidence_encrypted: the gateway's encrypted-evidence record;
 *   - the rest have no producer yet (vibration, acoustic, tee_attestation,
 *     sensor_anomaly_detected, evidence_committed, zk_*, photo_reference_set,
 *     photo_anti_spoof_check, touchstone_*, capture_*). A new producer of any of
 *     them must re-check this ruling.
 */
export const NON_EXECUTOR_EVENT_TYPES = ObjectFreeze([
  "cv_inspection_result",
  "photo_comparison_result",
  "instrument_result",
  "batch_sample_result",
  "power_profile_sample",
  "power_profile_summary",
  "vibration_signature",
  "acoustic_signature",
  "temperature_log",
  "camera_snapshot",
  "tee_attestation",
  "sensor_data_summary",
  "sensor_anomaly_detected",
  "evidence_committed",
  "evidence_encrypted",
  "zk_proof_generated",
  "zk_proof_verified",
  "device_birth",
  "device_death",
  "device_heartbeat",
  "calibration_record",
  "photo_reference_set",
  "photo_anti_spoof_check",
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

/** The members of three lists, in order, as one new list. */
function unionOf(a: readonly string[], b: readonly string[], c: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < a.length; i += 1) append(out, a[i]!);
  for (let i = 0; i < b.length; i += 1) append(out, b[i]!);
  for (let i = 0; i < c.length; i += 1) append(out, c[i]!);
  return out;
}

const SUBMITTED = stringSet(SUBMITTED_EVENT_TYPES);
const DEVICE_REPORTED = stringSet(DEVICE_REPORTED_EVENT_TYPES);
const INSPECTION = stringSet(INSPECTION_EVENT_TYPES);
// The union makes "took or finished the work identifies an executor" hold even if
// a list above is edited carelessly; a test also keeps EXECUTION_EVENT_TYPES complete.
const EXECUTION = stringSet(unionOf(EXECUTION_EVENT_TYPES, SUBMITTED_EVENT_TYPES, DEVICE_REPORTED_EVENT_TYPES));

/** Position in EVIDENCE_LEVELS; higher is stronger. -1 for anything else, as indexOf answered. */
export function evidenceLevelRank(level: EvidenceLevel): number {
  for (let i = 0; i < EVIDENCE_LEVELS.length; i += 1) if (EVIDENCE_LEVELS[i] === level) return i;
  return -1;
}

/** True when `reached` is at least as strong as `required`. Null meets nothing. */
export function meetsEvidenceLevel(reached: EvidenceLevel | null, required: EvidenceLevel): boolean {
  return reached !== null && evidenceLevelRank(reached) >= evidenceLevelRank(required);
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One bundle of an authenticated settlement unit, as the caller verified it. */
export interface AuthenticatedBundle {
  /** The bundle's events exactly as verified (signature + subject binding). */
  readonly events: readonly EvidenceEvent[];
  /**
   * Operator principal (`eip155:<chainId>:0x<40 lowercase hex>`, chainId 1+ with
   * no leading zero and a safe integer; the pcc.evidence.principal-id.v1
   * operator form) that owns the bundle's VERIFIED signer in the pinned
   * registry. Omit when unknown.
   */
  readonly trustDomain?: string;
}

export interface EvidenceLevelContext {
  /**
   * Operator principals the job was ASSIGNED to, from the accepted job or deal,
   * never from events. Independence cannot be shown without it.
   */
  readonly executorTrustDomains?: readonly string[];
}

/**
 * Thrown for input this module cannot classify: `bundles` not an array, a
 * bundle or an event that is not an object, a bundle whose `events` is not an
 * array, a length that is not a non-negative safe integer, or a `trustDomain` /
 * `executorTrustDomains` entry that is present but not in the exact operator
 * form. Never swallowed into a level or a verdict.
 */
export class EvidenceLevelInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceLevelInputError";
  }
}

// ---------------------------------------------------------------------------
// The gateway stamp
// ---------------------------------------------------------------------------

/**
 * The `source.deviceId` the gateway stamps on events it writes itself. Its
 * `PUT /api/jobs/:jobId/complete` writes its own `execution_completed` and the
 * caller's `evidenceEvents`, of any type, under this id. No device reported
 * them, so they prove no level. The comparison ignores ASCII whitespace around
 * the id and ASCII case ("Gateway", " gateway " are the stamp too).
 */
export const GATEWAY_STAMPED_DEVICE_ID = "gateway";

/** Space, TAB, LF, VT, FF, CR. */
function isAsciiSpace(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d);
}

/**
 * ASCII trim + ASCII lowercase of `text`, or null when the trimmed text is
 * longer than `maxLength` (so it cannot be a name we look for, and no folded
 * copy of an arbitrarily long string is built). No locale or Unicode case APIs:
 * only A-Z are lowered and only ASCII whitespace is trimmed, so any other
 * character, whatever Unicode lowercasing would make of it, is left alone and
 * never matches an ASCII name.
 */
function asciiFold(text: string, maxLength: number): string | null {
  let start = 0;
  let end = text.length;
  while (start < end && isAsciiSpace(charCodeAt(text, start))) start += 1;
  while (end > start && isAsciiSpace(charCodeAt(text, end - 1))) end -= 1;
  if (end - start > maxLength) return null;
  let folded = "";
  for (let i = start; i < end; i += 1) {
    const code = charCodeAt(text, i);
    // A string's own index reads its code unit; no String method is looked up.
    folded += code >= 0x41 && code <= 0x5a ? ASCII_LOWERCASE[code - 0x41]! : text[i]!;
  }
  return folded;
}

/** a-z, indexed by an uppercase letter's offset from "A". */
const ASCII_LOWERCASE = "abcdefghijklmnopqrstuvwxyz";

function isGatewayStamp(deviceId: string): boolean {
  return asciiFold(deviceId, GATEWAY_STAMPED_DEVICE_ID.length) === GATEWAY_STAMPED_DEVICE_ID;
}

// ---------------------------------------------------------------------------
// Inspection verdicts
// ---------------------------------------------------------------------------

/**
 * What an inspection event claims about the output:
 *   pass       a valid pinned verdict field says it passed;
 *   fail       a valid pinned verdict field says it failed;
 *   none       the payload claims no verdict (no pinned field, no verdict-looking key);
 *   malformed  the payload is not an object, the pinned field holds a value
 *              outside its domain, or a verdict-looking key is present without
 *              a valid pinned field.
 * Events that are not inspections claim none.
 */
export type InspectionVerdict = "pass" | "fail" | "none" | "malformed";

interface PinnedVerdict {
  /** The payload key that carries the verdict. */
  readonly field: string;
  /** The closed value domain of that key: pass or fail for a valid value, malformed otherwise. */
  readonly read: (value: unknown) => "pass" | "fail" | "malformed";
}

function readBooleanVerdict(value: unknown): "pass" | "fail" | "malformed" {
  return value === true ? "pass" : value === false ? "fail" : "malformed";
}

function readPassFailVerdict(value: unknown): "pass" | "fail" | "malformed" {
  return value === "PASS" ? "pass" : value === "FAIL" ? "fail" : "malformed";
}

/**
 * The pinned verdict field per inspection type (evidence-lane rulings E5/F2+F3
 * and D1):
 *   instrument_result     `pass`, a boolean
 *   cv_inspection_result  `passed`, a boolean
 *   batch_sample_result   `status`, exactly "PASS" or "FAIL"
 *
 * cv_inspection_result is `passed` because that is what every producer emits
 * (kernel PhotoCameraAdapter, MockCameraAdapter, the onboard-kit camera
 * templates) and what the oracle's J4 mirror reads. types/dpp.ts reads `pass`
 * for this type, so its qualityRecords see real camera output as FAIL; that
 * reader is wrong and is routed to its owner, not changed here.
 *
 * photo_comparison_result has NO pinned field: nothing in the repository
 * produces or reads it, so there is no verdict field to pin. Its verdict is
 * `none` (or `malformed` when the payload carries a verdict-looking key).
 */
const PINNED_VERDICTS: Readonly<Record<string, PinnedVerdict>> = pinnedVerdicts();

/** The table above, as a frozen null-prototype record of frozen entries. */
function pinnedVerdicts(): Readonly<Record<string, PinnedVerdict>> {
  const table = ObjectCreate(null) as Record<string, PinnedVerdict>;
  table.instrument_result = ObjectFreeze({ field: "pass", read: readBooleanVerdict });
  table.cv_inspection_result = ObjectFreeze({ field: "passed", read: readBooleanVerdict });
  table.batch_sample_result = ObjectFreeze({ field: "status", read: readPassFailVerdict });
  return ObjectFreeze(table);
}

/** The pinned verdict of an inspection type, if it has one. */
function pinnedVerdictOf(type: string): PinnedVerdict | undefined {
  return hasOwn(PINNED_VERDICTS, type) ? PINNED_VERDICTS[type] : undefined;
}

/**
 * Names that look like a verdict. A payload key is matched against them (and
 * against the pinned field's name) after an ASCII trim and ASCII lowercase, so
 * `Passed`, ` passed`, `PASS` and `Status` all count as present. When an
 * inspection's pinned field is absent (or the type has none) and the payload
 * still carries one of these, it is claiming something this module cannot read,
 * so the verdict is `malformed`.
 */
const VERDICT_LOOKING_KEYS = ObjectFreeze(["pass", "passed", "status", "result", "verdict", "ok", "success"] as const);
const VERDICT_LOOKING = stringSet(VERDICT_LOOKING_KEYS);

/** No folded key longer than this can be a verdict-looking name or a pinned field. */
const LONGEST_VERDICT_NAME = longestVerdictName();

function longestVerdictName(): number {
  let longest = 0;
  for (let i = 0; i < VERDICT_LOOKING_KEYS.length; i += 1) {
    if (VERDICT_LOOKING_KEYS[i]!.length > longest) longest = VERDICT_LOOKING_KEYS[i]!.length;
  }
  const types = ReflectOwnKeys(PINNED_VERDICTS);
  for (let i = 0; i < types.length; i += 1) {
    const field = PINNED_VERDICTS[types[i] as string]!.field;
    if (field.length > longest) longest = field.length;
  }
  return longest;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || ArrayIsArray(value)) return false;
  const prototype: unknown = ObjectGetPrototypeOf(value);
  return prototype === ObjectPrototype || prototype === null;
}

/**
 * The verdict of an inspection payload that has ALREADY been read. It touches
 * the payload three times, each once: its prototype, a snapshot of its own key
 * names, and the descriptor of the pinned field. Nothing is invoked: an accessor
 * is malformed, never called. Own key names are compared after an ASCII trim
 * and ASCII lowercase (`asciiFold`), whether or not the key is enumerable.
 *   - not a plain, non-null, non-array object: `malformed`;
 *   - some own key folds to the pinned field's name but is not that exact key
 *     (`Passed`, ` passed`, `PASSED`): `malformed`, even when the exact key is
 *     present too, because the payload then carries two readings;
 *   - the exact pinned field is an own key: a valid value gives `pass` or
 *     `fail`, any other value gives `malformed`;
 *   - the pinned field is absent: any own key that folds to one of {pass, passed,
 *     status, result, verdict, ok, success} gives `malformed`, otherwise `none`.
 * Any other verdict-looking key beside a valid pinned field gives `malformed`:
 * the payload carries two claims, and readers of the other key would disagree.
 */
function verdictOfPayload(type: string, payload: unknown): InspectionVerdict {
  if (!isPlainObject(payload)) return "malformed";
  const pinned = pinnedVerdictOf(type);
  let exactPinned = false;
  let pinnedSpelling = false;
  let verdictLooking = false;
  let otherVerdict = false;
  // Its own string keys, enumerable or not (what Object.getOwnPropertyNames listed).
  const keys = ReflectOwnKeys(payload);
  for (let k = 0; k < keys.length; k += 1) {
    const key = keys[k];
    if (typeof key !== "string") continue;
    const folded = asciiFold(key, LONGEST_VERDICT_NAME);
    if (folded === null) continue;
    if (inSet(VERDICT_LOOKING, folded)) {
      verdictLooking = true;
      if (pinned === undefined || folded !== pinned.field) otherVerdict = true;
    }
    if (pinned !== undefined && folded === pinned.field) {
      if (key === pinned.field) exactPinned = true;
      else pinnedSpelling = true;
    }
  }
  if (pinnedSpelling) return "malformed";
  if (pinned !== undefined && exactPinned) {
    // A second verdict-looking key is a conflicting claim: a reader of that key
    // (types/dpp.ts reads `pass` for cv) would answer differently. Fail closed.
    if (otherVerdict) return "malformed";
    const descriptor = ObjectGetOwnPropertyDescriptor(payload, pinned.field);
    // An own "value" only: a value written on Object.prototype never makes an accessor read as data.
    if (descriptor === undefined || !hasOwn(descriptor, "value")) return "malformed";
    const read = pinned.read;
    return read(descriptor.value);
  }
  return verdictLooking ? "malformed" : "none";
}

/**
 * The verdict an inspection event carries. One closed answer per inspection
 * type, from one shared extractor (`verdictOfPayload`):
 *   - not an inspection type: `none`;
 *   - otherwise the payload rules above.
 * It reads `event.type` and `event.payload` once each.
 */
export function inspectionVerdict(event: EvidenceEvent): InspectionVerdict {
  const type: unknown = own(event, "type");
  if (typeof type !== "string" || !inSet(INSPECTION, type)) return "none";
  return verdictOfPayload(type, own(event, "payload"));
}

/**
 * An inspection that reports its own negative verdict, or one whose verdict
 * cannot be read (fail closed): `inspectionVerdict` is `fail` or `malformed`.
 * An inspection that claims no verdict (`none`) did not fail.
 */
export function inspectionFailed(event: EvidenceEvent): boolean {
  const verdict = inspectionVerdict(event);
  return verdict === "fail" || verdict === "malformed";
}

// ---------------------------------------------------------------------------
// One read of the input
// ---------------------------------------------------------------------------

// Mirrors #399's OPERATOR_PRINCIPAL_ID_PATTERN (the pcc.evidence.principal-id.v1
// operator form), /^eip155:([1-9][0-9]*):0x[0-9a-f]{40}$/, as a code-unit
// predicate (no RegExp, see rule 8; a test holds it equal to the pattern). Kept
// local so this branch does not depend on #399. The chain id has no leading zero,
// is at least 1 and is a safe integer. Lowercase hex only, so equal principals
// are equal strings.
const OPERATOR_PRINCIPAL_PREFIX = "eip155:";
/** Number.MAX_SAFE_INTEGER as decimal digits: a longer chain id, or a 16-digit one above it, is not safe. */
const MAX_SAFE_INTEGER_DIGITS = "9007199254740991";

function isOperatorPrincipalId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const length = value.length;
  let i = 0;
  for (; i < OPERATOR_PRINCIPAL_PREFIX.length; i += 1) {
    if (i >= length || value[i] !== OPERATOR_PRINCIPAL_PREFIX[i]) return false;
  }
  // The chain id: [1-9][0-9]*, collected as it is read.
  if (i >= length || !(value[i]! >= "1" && value[i]! <= "9")) return false;
  let chainId = "";
  while (i < length && value[i]! >= "0" && value[i]! <= "9") {
    chainId += value[i]!;
    i += 1;
  }
  if (i + 3 + 40 !== length || value[i] !== ":" || value[i + 1] !== "0" || value[i + 2] !== "x") return false;
  for (i += 3; i < length; i += 1) {
    const c = value[i]!;
    if (!((c >= "0" && c <= "9") || (c >= "a" && c <= "f"))) return false;
  }
  // Number.isSafeInteger(Number(chainId)), without either: equal-length digit strings compare as numbers.
  return (
    chainId.length < MAX_SAFE_INTEGER_DIGITS.length ||
    (chainId.length === MAX_SAFE_INTEGER_DIGITS.length && chainId <= MAX_SAFE_INTEGER_DIGITS)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !ArrayIsArray(value);
}

/**
 * `object[key]` when `key` is the object's OWN property, read once (an own accessor
 * runs once, rule 7); undefined when it is inherited or absent, so nothing written
 * on Object.prototype or Array.prototype is taken for the input's (rule 8).
 */
function own(object: object, key: PropertyKey): unknown {
  return hasOwn(object, key) ? (object as Record<PropertyKey, unknown>)[key] : undefined;
}

/** `list.length`, read once, which must be a non-negative safe integer. */
function readLength(list: readonly unknown[], what: string): number {
  const length: unknown = list.length;
  // Number.isSafeInteger(length) && length >= 0, from the captured NumberIsInteger.
  if (typeof length !== "number" || !NumberIsInteger(length) || length < 0 || length > 9007199254740991) {
    throw new EvidenceLevelInputError(`${what} has no valid length`);
  }
  return length;
}

/**
 * Everything the levels and the contradiction rule need to know about ONE event,
 * derived from ONE read of it. Nothing downstream looks at the event again.
 */
interface EventFacts {
  /** `event.type` when it is a string, else null. */
  readonly type: string | null;
  /** `source.deviceId` is a non-empty string that is not the gateway's own stamp. */
  readonly deviceAttributed: boolean;
  /** `isFabricated` over the values read: `source.simulated === true` or `payload.mock === true`. */
  readonly fabricated: boolean;
  /** The inspection verdict of the payload read; `none` for a type that is not an inspection. */
  readonly verdict: InspectionVerdict;
}

interface PreparedBundle {
  readonly trustDomain: string | null;
  /** Any event of the bundle is fabricated. */
  readonly fabricated: boolean;
  /** Any event of the bundle has an EXECUTION_EVENT_TYPES type. */
  readonly holdsExecutionEvent: boolean;
  readonly events: readonly EventFacts[];
}

/**
 * A null-prototype snapshot holding only `key`, read once as an OWN property of `value`, and
 * undefined when `value` is not an object or `key` is inherited or absent. isFabricated reads
 * these, so no inherited value or getter and no boxed primitive can answer (astra pack 267).
 */
function ownFieldView(value: unknown, key: string): Record<string, unknown> {
  const view = ObjectCreate(null) as Record<string, unknown>;
  view[key] = typeof value === "object" && value !== null ? own(value, key) : undefined;
  return view;
}

/**
 * Read one event, once, into its frozen facts: `type`, `source` and `payload`
 * each once, then `source.deviceId`, `source.simulated`, `payload.mock` and the
 * payload's verdict material each once, all from those locals.
 */
function readEventFacts(event: Record<string, unknown>): EventFacts {
  const rawType: unknown = own(event, "type");
  const source: unknown = own(event, "source");
  const payload: unknown = own(event, "payload");
  const type = typeof rawType === "string" ? rawType : null;
  // The canonical predicate, over null-prototype snapshots of the two values it reads, each
  // read once as an OWN property: source.simulated and payload.mock. An inherited mock getter
  // could otherwise write source.deviceId before it is read, and a primitive source or
  // payload would box and consult its prototypes (astra pack 267).
  const fabricated = isFabricated({
    type,
    source: ownFieldView(source, "simulated"),
    payload: ownFieldView(payload, "mock"),
  } as unknown as EvidenceEvent);
  let deviceAttributed = false;
  if (typeof source === "object" && source !== null) {
    const deviceId: unknown = own(source, "deviceId");
    deviceAttributed = typeof deviceId === "string" && deviceId.length > 0 && !isGatewayStamp(deviceId);
  }
  const verdict: InspectionVerdict = type !== null && inSet(INSPECTION, type) ? verdictOfPayload(type, payload) : "none";
  return ObjectFreeze({ type, deviceAttributed, fabricated, verdict });
}

/**
 * Validate the whole input up front (no early exit) and read it ONCE into
 * frozen facts: `bundles.length` once, each bundle once, its `events`,
 * `trustDomain` and `events.length` once, each event once. Levels and
 * contradictions use only what this returns, so an input that answers
 * differently on each read (a Proxy array, an accessor) cannot make two passes
 * disagree: the one read decides.
 */
function prepareBundles(bundles: unknown): readonly PreparedBundle[] {
  if (!ArrayIsArray(bundles)) {
    throw new EvidenceLevelInputError("bundles must be an array of AuthenticatedBundle");
  }
  const bundleCount = readLength(bundles, "bundles");
  const prepared: PreparedBundle[] = [];
  for (let i = 0; i < bundleCount; i += 1) {
    const bundle: unknown = own(bundles, i);
    if (!isRecord(bundle)) {
      throw new EvidenceLevelInputError(`bundles[${i}] must be an object`);
    }
    const events: unknown = own(bundle, "events");
    if (!ArrayIsArray(events)) {
      throw new EvidenceLevelInputError(`bundles[${i}].events must be an array`);
    }
    const declared: unknown = own(bundle, "trustDomain");
    const eventCount = readLength(events, `bundles[${i}].events`);
    const facts: EventFacts[] = [];
    let fabricated = false;
    let holdsExecutionEvent = false;
    for (let j = 0; j < eventCount; j += 1) {
      const event: unknown = own(events, j);
      if (!isRecord(event)) {
        throw new EvidenceLevelInputError(`bundles[${i}].events[${j}] must be an object`);
      }
      const eventFacts = readEventFacts(event);
      append(facts, eventFacts);
      if (eventFacts.fabricated) fabricated = true;
      if (eventFacts.type !== null && inSet(EXECUTION, eventFacts.type)) holdsExecutionEvent = true;
    }
    let trustDomain: string | null = null;
    if (declared !== undefined) {
      if (!isOperatorPrincipalId(declared)) {
        throw new EvidenceLevelInputError(
          `bundles[${i}].trustDomain is not an operator principal id (eip155:<chainId>:0x<40 lowercase hex>)`,
        );
      }
      trustDomain = declared;
    }
    append(prepared, ObjectFreeze({ trustDomain, fabricated, holdsExecutionEvent, events: ObjectFreeze(facts) }));
  }
  return ObjectFreeze(prepared);
}

function assignedExecutorDomains(context: unknown): readonly string[] {
  if (context === undefined) return [];
  if (!isRecord(context)) {
    throw new EvidenceLevelInputError("context must be an object");
  }
  const assigned: unknown = own(context, "executorTrustDomains");
  if (assigned === undefined) return [];
  if (!ArrayIsArray(assigned)) {
    throw new EvidenceLevelInputError("context.executorTrustDomains must be an array of operator principal ids");
  }
  const count = readLength(assigned, "context.executorTrustDomains");
  const domains: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const domain: unknown = own(assigned, i);
    if (!isOperatorPrincipalId(domain)) {
      throw new EvidenceLevelInputError(
        `context.executorTrustDomains[${i}] is not an operator principal id (eip155:<chainId>:0x<40 lowercase hex>)`,
      );
    }
    append(domains, domain);
  }
  return domains;
}

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

/** The level one event proves inside a non-fabricated bundle, from its facts, or null. */
function eventLevel(facts: EventFacts, inspectorIndependent: boolean): EvidenceLevel | null {
  if (!facts.deviceAttributed || facts.type === null) return null;
  const type = facts.type;
  if (inSet(SUBMITTED, type)) return "submitted";
  if (inSet(DEVICE_REPORTED, type)) return "device_reported";
  if (inSet(INSPECTION, type)) {
    if (facts.verdict !== "pass" && facts.verdict !== "fail") return null;
    return inspectorIndependent ? "inspected_output" : "device_reported";
  }
  return null;
}

/** The level one event proves, with where it sits in the input. */
export interface EventLevel {
  /** Index into the `bundles` passed in. */
  readonly bundleIndex: number;
  /** Index into that bundle's `events`. */
  readonly eventIndex: number;
  /**
   * The level this event proves, or null: every event of a fabricated bundle,
   * an event with no device attribution (or the gateway's stamp), a type that
   * proves no outcome, an inspection whose verdict is none or malformed.
   */
  readonly level: EvidenceLevel | null;
}

/**
 * The level each event proves, in input order (bundle by bundle, event by
 * event), as a frozen array of frozen records. This is the one implementation of
 * the level rules; `evidenceLevelOfBundles` is the maximum over it.
 *
 * Bundles with any fabricated event prove nothing: level null for every one of
 * their events. An inspection is inspected_output only when
 * `context.executorTrustDomains` is non-empty, no bundle holding an execution
 * event lacks a trust domain, the inspection's bundle has a trust domain, and
 * that domain is not an executor (assigned, or the domain of any bundle holding
 * an execution event, fabricated or not); otherwise an inspection with a valid
 * verdict is device_reported. Throws `EvidenceLevelInputError` for input it
 * cannot classify.
 */
export function evidenceLevelsOfEvents(
  bundles: readonly AuthenticatedBundle[],
  context?: EvidenceLevelContext,
): readonly EventLevel[] {
  const assigned = assignedExecutorDomains(context);
  const prepared = prepareBundles(bundles);

  // The executor domains, as a null-prototype record: the assigned ones, then every
  // bundle's that holds an execution event.
  const executors = ObjectCreate(null) as Record<string, true>;
  for (let i = 0; i < assigned.length; i += 1) executors[assigned[i]!] = true;
  let executorsUnknown = false;
  for (let b = 0; b < prepared.length; b += 1) {
    const bundle = prepared[b]!;
    if (!bundle.holdsExecutionEvent) continue;
    if (bundle.trustDomain === null) executorsUnknown = true;
    else executors[bundle.trustDomain] = true;
  }
  const independenceProvable = assigned.length > 0 && !executorsUnknown;

  const levels: EventLevel[] = [];
  for (let bundleIndex = 0; bundleIndex < prepared.length; bundleIndex += 1) {
    const bundle = prepared[bundleIndex]!;
    const inspectorIndependent =
      independenceProvable && bundle.trustDomain !== null && !hasOwn(executors, bundle.trustDomain);
    for (let eventIndex = 0; eventIndex < bundle.events.length; eventIndex += 1) {
      const level = bundle.fabricated ? null : eventLevel(bundle.events[eventIndex]!, inspectorIndependent);
      append(levels, ObjectFreeze({ bundleIndex, eventIndex, level }));
    }
  }
  return ObjectFreeze(levels);
}

/**
 * The strongest level the bundles of one settlement unit prove, or null: the
 * maximum over `evidenceLevelsOfEvents`, so the two cannot disagree. Pass every
 * authenticated bundle of the unit (see the contract in the header). Throws
 * `EvidenceLevelInputError` for input it cannot classify.
 */
export function evidenceLevelOfBundles(
  bundles: readonly AuthenticatedBundle[],
  context?: EvidenceLevelContext,
): EvidenceLevel | null {
  let best: EvidenceLevel | null = null;
  const levels = evidenceLevelsOfEvents(bundles, context);
  for (let i = 0; i < levels.length; i += 1) {
    const level = levels[i]!.level;
    if (level !== null && (best === null || evidenceLevelRank(level) > evidenceLevelRank(best))) {
      best = level;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Contradictions
// ---------------------------------------------------------------------------

/** A contradiction derivable from authenticated events (J4). */
export type ContradictionKind = "completion-and-failure" | "completion-and-failed-inspection";

/**
 * The contradictions the bundles of ONE settlement unit show, in this fixed
 * order:
 *   - "completion-and-failure": a device-reported completion and an
 *     execution_failed in the same unit;
 *   - "completion-and-failed-inspection": a device-reported completion and an
 *     inspection that failed (`inspectionFailed`: a `fail` verdict, or a
 *     `malformed` one, which fails closed; `none` does not).
 * A failure with no completion is a device failure, not a contradiction.
 *
 * SCOPE (E5/F5): the caller passes the authenticated bundles of ONE settlement
 * unit (one job step). Evidence-lane ruling: no PCC flow retries a job under
 * the same job id, a failed unit is refunded and a new attempt is a new job, and
 * EvidenceBlockV2 commits ONE bundle per unit. Inside a unit a completion plus a
 * failure IS a contradiction, and refusing it is fail-closed. This function does
 * not correlate attempts, steps or devices: passing the bundles of different
 * units together makes a failed first attempt contradict a successful later one.
 *
 * Bundles with any fabricated event are ignored (they prove nothing). Event
 * types decide here, not who stamped them, so a gateway-stamped completion
 * still counts: a contradiction can only refuse. This is the public,
 * deterministic rule: the oracle signs a reject only for what it derives here
 * (J4), and profile admission reads the same predicate. Throws
 * `EvidenceLevelInputError` for input it cannot classify.
 */
export function deriveContradictions(bundles: readonly AuthenticatedBundle[]): ContradictionKind[] {
  let completed = false;
  let failed = false;
  let failedInspection = false;
  const prepared = prepareBundles(bundles);
  for (let b = 0; b < prepared.length; b += 1) {
    const bundle = prepared[b]!;
    if (bundle.fabricated) continue;
    for (let e = 0; e < bundle.events.length; e += 1) {
      const facts = bundle.events[e]!;
      if (facts.type !== null && inSet(DEVICE_REPORTED, facts.type)) completed = true;
      if (facts.type === "execution_failed") failed = true;
      if (facts.verdict === "fail" || facts.verdict === "malformed") failedInspection = true;
    }
  }
  if (!completed) return [];
  const kinds: ContradictionKind[] = [];
  if (failed) append(kinds, "completion-and-failure");
  if (failedInspection) append(kinds, "completion-and-failed-inspection");
  return kinds;
}
