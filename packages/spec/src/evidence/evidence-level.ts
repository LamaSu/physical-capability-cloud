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
 *    field is ignored: the pinned field decides.
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
 * An observation or measurement of the output. It proves a level only when its
 * payload carries a valid verdict (`inspectionVerdict` is pass or fail). It is
 * then inspected_output only when the inspector's authenticated trust domain is
 * shown to be outside every executor's; a party measuring its own output is
 * reporting, and so is an observation whose independence cannot be shown (no
 * assigned executor, an unknown executor, no trust domain): all device_reported.
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
 * Event types that show a party is executing the job. A bundle that holds any
 * of them puts its trust domain in the executor set, so an inspection signed in
 * that domain is that party reporting on its own output.
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
  while (start < end && isAsciiSpace(text.charCodeAt(start))) start += 1;
  while (end > start && isAsciiSpace(text.charCodeAt(end - 1))) end -= 1;
  if (end - start > maxLength) return null;
  let folded = "";
  for (let i = start; i < end; i += 1) {
    const code = text.charCodeAt(i);
    folded += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : text.charAt(i);
  }
  return folded;
}

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
const PINNED_VERDICTS: ReadonlyMap<string, PinnedVerdict> = new Map<string, PinnedVerdict>([
  ["instrument_result", { field: "pass", read: readBooleanVerdict }],
  ["cv_inspection_result", { field: "passed", read: readBooleanVerdict }],
  ["batch_sample_result", { field: "status", read: readPassFailVerdict }],
]);

/**
 * Names that look like a verdict. A payload key is matched against them (and
 * against the pinned field's name) after an ASCII trim and ASCII lowercase, so
 * `Passed`, ` passed`, `PASS` and `Status` all count as present. When an
 * inspection's pinned field is absent (or the type has none) and the payload
 * still carries one of these, it is claiming something this module cannot read,
 * so the verdict is `malformed`.
 */
const VERDICT_LOOKING_KEYS = ["pass", "passed", "status", "result", "verdict", "ok", "success"] as const;
const VERDICT_LOOKING = new Set<string>(VERDICT_LOOKING_KEYS);

/** No folded key longer than this can be a verdict-looking name or a pinned field. */
const LONGEST_VERDICT_NAME = Math.max(
  ...VERDICT_LOOKING_KEYS.map((name) => name.length),
  ...[...PINNED_VERDICTS.values()].map((pinned) => pinned.field.length),
);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
 * Another verdict-looking key beside a valid pinned field is ignored: the pinned
 * field decides.
 */
function verdictOfPayload(type: string, payload: unknown): InspectionVerdict {
  if (!isPlainObject(payload)) return "malformed";
  const pinned = PINNED_VERDICTS.get(type);
  let exactPinned = false;
  let pinnedSpelling = false;
  let verdictLooking = false;
  for (const key of Object.getOwnPropertyNames(payload)) {
    const folded = asciiFold(key, LONGEST_VERDICT_NAME);
    if (folded === null) continue;
    if (VERDICT_LOOKING.has(folded)) verdictLooking = true;
    if (pinned !== undefined && folded === pinned.field) {
      if (key === pinned.field) exactPinned = true;
      else pinnedSpelling = true;
    }
  }
  if (pinnedSpelling) return "malformed";
  if (pinned !== undefined && exactPinned) {
    const descriptor = Object.getOwnPropertyDescriptor(payload, pinned.field);
    if (descriptor === undefined || !("value" in descriptor)) return "malformed";
    return pinned.read(descriptor.value);
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
  const type: unknown = event.type;
  if (typeof type !== "string" || !INSPECTION.has(type)) return "none";
  return verdictOfPayload(type, event.payload);
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
// operator form). Kept local so this branch does not depend on #399. The chain
// id has no leading zero and is at least 1; the safe-integer bound is checked
// separately. Lowercase hex only, so equal principals are equal strings.
const OPERATOR_PRINCIPAL_ID_PATTERN = /^eip155:([1-9][0-9]*):0x[0-9a-f]{40}$/;

function isOperatorPrincipalId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = OPERATOR_PRINCIPAL_ID_PATTERN.exec(value);
  return match !== null && Number.isSafeInteger(Number(match[1]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `list.length`, read once, which must be a non-negative safe integer. */
function readLength(list: readonly unknown[], what: string): number {
  const length: unknown = list.length;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
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
 * Read one event, once, into its frozen facts: `type`, `source` and `payload`
 * each once, then `source.deviceId`, `source.simulated`, `payload.mock` and the
 * payload's verdict material each once, all from those locals.
 */
function readEventFacts(event: Record<string, unknown>): EventFacts {
  const rawType: unknown = event.type;
  const source: unknown = event.source;
  const payload: unknown = event.payload;
  const type = typeof rawType === "string" ? rawType : null;
  // The canonical predicate, over a snapshot of the values read: it reads
  // source.simulated and payload.mock once each, so this cannot drift from it.
  const fabricated = isFabricated({ type, source, payload } as unknown as EvidenceEvent);
  let deviceAttributed = false;
  if (typeof source === "object" && source !== null) {
    const deviceId: unknown = (source as { deviceId?: unknown }).deviceId;
    deviceAttributed = typeof deviceId === "string" && deviceId.length > 0 && !isGatewayStamp(deviceId);
  }
  const verdict: InspectionVerdict = type !== null && INSPECTION.has(type) ? verdictOfPayload(type, payload) : "none";
  return Object.freeze({ type, deviceAttributed, fabricated, verdict });
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
  if (!Array.isArray(bundles)) {
    throw new EvidenceLevelInputError("bundles must be an array of AuthenticatedBundle");
  }
  const bundleCount = readLength(bundles, "bundles");
  const prepared: PreparedBundle[] = [];
  for (let i = 0; i < bundleCount; i += 1) {
    const bundle: unknown = bundles[i];
    if (!isRecord(bundle)) {
      throw new EvidenceLevelInputError(`bundles[${i}] must be an object`);
    }
    const events: unknown = bundle.events;
    if (!Array.isArray(events)) {
      throw new EvidenceLevelInputError(`bundles[${i}].events must be an array`);
    }
    const declared: unknown = bundle.trustDomain;
    const eventCount = readLength(events, `bundles[${i}].events`);
    const facts: EventFacts[] = [];
    let fabricated = false;
    let holdsExecutionEvent = false;
    for (let j = 0; j < eventCount; j += 1) {
      const event: unknown = events[j];
      if (!isRecord(event)) {
        throw new EvidenceLevelInputError(`bundles[${i}].events[${j}] must be an object`);
      }
      const eventFacts = readEventFacts(event);
      facts.push(eventFacts);
      if (eventFacts.fabricated) fabricated = true;
      if (eventFacts.type !== null && EXECUTION.has(eventFacts.type)) holdsExecutionEvent = true;
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
    prepared.push(Object.freeze({ trustDomain, fabricated, holdsExecutionEvent, events: Object.freeze(facts) }));
  }
  return Object.freeze(prepared);
}

function assignedExecutorDomains(context: unknown): readonly string[] {
  if (context === undefined) return [];
  if (!isRecord(context)) {
    throw new EvidenceLevelInputError("context must be an object");
  }
  const assigned: unknown = context.executorTrustDomains;
  if (assigned === undefined) return [];
  if (!Array.isArray(assigned)) {
    throw new EvidenceLevelInputError("context.executorTrustDomains must be an array of operator principal ids");
  }
  const count = readLength(assigned, "context.executorTrustDomains");
  const domains: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const domain: unknown = assigned[i];
    if (!isOperatorPrincipalId(domain)) {
      throw new EvidenceLevelInputError(
        `context.executorTrustDomains[${i}] is not an operator principal id (eip155:<chainId>:0x<40 lowercase hex>)`,
      );
    }
    domains.push(domain);
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
  if (SUBMITTED.has(type)) return "submitted";
  if (DEVICE_REPORTED.has(type)) return "device_reported";
  if (INSPECTION.has(type)) {
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

  const executors = new Set<string>(assigned);
  let executorsUnknown = false;
  for (const bundle of prepared) {
    if (!bundle.holdsExecutionEvent) continue;
    if (bundle.trustDomain === null) executorsUnknown = true;
    else executors.add(bundle.trustDomain);
  }
  const independenceProvable = assigned.length > 0 && !executorsUnknown;

  const levels: EventLevel[] = [];
  for (let bundleIndex = 0; bundleIndex < prepared.length; bundleIndex += 1) {
    const bundle = prepared[bundleIndex]!;
    const inspectorIndependent =
      independenceProvable && bundle.trustDomain !== null && !executors.has(bundle.trustDomain);
    for (let eventIndex = 0; eventIndex < bundle.events.length; eventIndex += 1) {
      const level = bundle.fabricated ? null : eventLevel(bundle.events[eventIndex]!, inspectorIndependent);
      levels.push(Object.freeze({ bundleIndex, eventIndex, level }));
    }
  }
  return Object.freeze(levels);
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
  for (const { level } of evidenceLevelsOfEvents(bundles, context)) {
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
  for (const bundle of prepareBundles(bundles)) {
    if (bundle.fabricated) continue;
    for (const facts of bundle.events) {
      if (facts.type !== null && DEVICE_REPORTED.has(facts.type)) completed = true;
      if (facts.type === "execution_failed") failed = true;
      if (facts.verdict === "fail" || facts.verdict === "malformed") failedInspection = true;
    }
  }
  if (!completed) return [];
  const kinds: ContradictionKind[] = [];
  if (failed) kinds.push("completion-and-failure");
  if (failedInspection) kinds.push("completion-and-failed-inspection");
  return kinds;
}
