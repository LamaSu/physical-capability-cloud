/**
 * LO-EV-9 — evidence subject binding (`pcc.evidence.subject-binding.v1`).
 *
 * A valid signature over a bundle digest proves who signed which digest. It
 * does not say which job, node or output that digest is evidence FOR. The
 * bundle-level `jobId`, `stepId` and `kernelId` fields are not inputs to
 * `hashBundle`, so they are unsigned labels a relay can rewrite. Checking the
 * signature alone, a genuine bundle from job A stored against job B settles
 * job B, and any other tagged digest the node key signs (a log-chain
 * `entryHash`, for one) passes as a bundle digest.
 *
 * The subject is bound only when the verifier opens the signed digest back to
 * its events and reads the subject out of their hashed content. That is what
 * `verifyEvidenceSubjectBinding` does. It fails closed, in this order:
 *
 *   1. the subject names a job and a kernel;
 *   2. `bundleHash` is a canonical tagged digest (LO-EV-1);
 *   3. there is at least one event, and every event is well-formed and
 *      reproduces its own `hash` (`hashEvent`);
 *   4. the events reproduce `bundleHash` (`hashBundle`);
 *   5. job: EVERY event commits `payload.jobId`, equal to the subject's job.
 *      The kernel signs event by event, and a session delegated for several
 *      jobs could not attribute a jobless event, so one event naming the job
 *      is not enough (the oracle enforces the same rule at /settle);
 *   6. node: every event's `source.kernelId`, and every `payload.kernelId`,
 *      equals the kernel that accepted the job;
 *   7. output, only when the subject names one: at least one event commits
 *      `payload.outputHash`, and every `payload.outputHash` equals it;
 *   8. settlement unit: the subject and the evidence must agree exactly. When
 *      the subject names a unit, EVERY event commits `payload.settlementUnitId`,
 *      equal to it. When the subject names none, NO event may commit one
 *      (`unit-not-in-subject`, E11 F1). A job settles unit by unit
 *      (milestones), and `jobId` alone would let evidence signed for milestone
 *      3 settle milestone 4 of the same job. So a consumer that cannot name
 *      the unit it settles cannot accept evidence scoped to one. Today that is
 *      the legacy /complete and /resume-settlement, which drive milestone 0 of
 *      a per-job escrow that has no unit id. Such a consumer still accepts
 *      unit-less evidence for that job;
 *   9. challenge: the same, for `payload.challengeNonce` and the
 *      gateway-issued per-unit nonce the package carries as
 *      `challengeBinding.nonce`. Evidence made before the nonce was issued
 *      cannot contain it. Evidence that carries a nonce the subject does not
 *      name is refused (`challenge-not-in-subject`).
 * Both unit fields are `0x` + 64 lowercase hex, byte-equal to the settlement
 * package's `unitBinding.settlementUnitId` and `challengeBinding.nonce`. The
 * output is different. It is content, not authorization scope, so evidence
 * may commit an output the subject does not name.
 *
 * ONE READ, AND NO CALLER CODE RUNS (E11 F2, F3). Every input value is read
 * exactly once, before any check:
 *   - the input's `subject`, `bundleHash` and `events`, the subject's five
 *     fields, and each event's `type`, `timestamp`, `source`, `payload`,
 *     `hash` and `id` are each read through their own data descriptor;
 *   - each event's `source` and `payload` go through `plainDataCopy`
 *     (util/plain-data.ts), a one-pass plain-data copy.
 * A Proxy at any level, an accessor (getter or setter) on any field read, a
 * hole in the events array, and anything that is not JSON data inside
 * `source` or `payload` are refused WITHOUT being run. Every check, the hashes
 * included, then reads only those copies. So no getter can answer the checks
 * one way and the bundle hash another, nothing supplied with the input runs
 * while it is verified, and nothing outside the hashed fields is read. The
 * copies have null prototypes, so a property the hash never covered cannot
 * bind a subject. That covers an inherited property, and a non-enumerable one,
 * which the copy leaves out as `canonicalize` does. The result returns the
 * copies, deep-frozen. A consumer that evaluates the events further (levels,
 * admission) must evaluate them, not its own objects.
 *
 * NOTHING REPLACED AFTER LOAD CHANGES AN ANSWER (the realm-mutation residual
 * sensors reproduced against this file, bus #5381).
 *   - The checks call only intrinsics captured when the modules load: those
 *     in util/primordials.ts, `canonicalize` (which is built on them), and
 *     node:crypto's SHA-256 methods, captured below. Beyond that, they use
 *     plain loops and operators.
 *   - So nothing is looked up on a prototype or a global at call time. There
 *     is no iterator protocol, no RegExp, no JSON.parse, no
 *     Array.prototype.sort and no await.
 *   - The result objects have null prototypes, so a `then` written on
 *     Object.prototype cannot turn the returned refusal into anything else.
 *
 * The boundary, named honestly:
 *   - a realm whose intrinsics were replaced BEFORE @pcc/spec loaded hands it
 *     the replaced ones;
 *   - a consumer's own `await` of the returned promise runs in that
 *     consumer's realm;
 *   - where the runtime offers no trap-free Proxy check, or no SHA-256 (a
 *     browser bundle without node:util), every call refuses with
 *     `unsupported-runtime`.
 *
 * NEVER THROWS. Every input gets a result. An engine error while reading (a
 * stack overflow on a deeply nested payload, say) is refused as malformation
 * of the part being read.
 *
 * The subject fields are the ones the incumbent producers already hash:
 * kernel-sdk's `execution_started` / `execution_completed` commit
 * `payload.jobId`, `payload.kernelId` and `payload.outputHash`, and every event
 * carries `source.kernelId`. A producer whose events commit none of them cannot
 * bind a subject, so its bundles never verify here.
 *
 * This is the binding leg only. It never looks at the signature. A consumer
 * must also verify the signature over `signingPreimage(bundleHash)` against the
 * node's registered key (gateway `verifyDeviceSignedEvidence`, the oracle's #47
 * registered-key check). Neither leg is sufficient alone.
 */
import { createHash } from "node:crypto";
import { canonicalize } from "../util/canonical.js";
import { isProxy, plainDataCopy } from "../util/plain-data.js";
import {
  ArrayIsArray,
  ArrayPrototype,
  ObjectCreate,
  ObjectFreeze,
  ObjectGetOwnPropertyDescriptor,
  ObjectGetPrototypeOf,
  ObjectPrototype,
  deepFreeze,
  defineIndex,
  hasOwn,
  isHex256Digest,
  newList,
  sortedStrings,
  uncurryThis,
} from "../util/primordials.js";
import type { EvidenceEvent } from "../types/evidence.js";

export const EVIDENCE_SUBJECT_BINDING_CONTRACT = "pcc.evidence.subject-binding.v1";

/** The accepted execution unit a bundle must be evidence for. */
export interface EvidenceSubject {
  /** The job the evidence must substantiate. */
  jobId: string;
  /** The kernel (node) that accepted the job: the job record's `kernelId`,
   *  never an id supplied alongside the evidence. */
  kernelId: string;
  /** Digest of the delivered output, when the consumer holds one. */
  outputHash?: string;
  /** The escrow settlement unit (milestone) being settled: `0x` + 64 lowercase
   *  hex, from the unit record, never from the evidence. Omitted only by a
   *  consumer that settles no unit; that consumer then refuses evidence which
   *  commits one. */
  settlementUnitId?: string;
  /** The gateway-issued challenge nonce for that unit: `0x` + 64 lowercase
   *  hex. Omitted, evidence that commits a nonce is refused. */
  challengeNonce?: string;
}

export type EvidenceSubjectBindingErrorCode =
  | "malformed-subject"
  | "malformed-bundle-hash"
  | "missing-events"
  | "malformed-event"
  | "event-hash-mismatch"
  | "bundle-hash-mismatch"
  | "job-not-committed"
  | "job-mismatch"
  | "kernel-mismatch"
  | "output-not-committed"
  | "output-mismatch"
  | "unit-not-committed"
  | "unit-mismatch"
  | "unit-not-in-subject"
  | "challenge-not-committed"
  | "challenge-mismatch"
  | "challenge-not-in-subject"
  | "unsupported-runtime";

export type EvidenceSubjectBindingResult =
  /** `events`: the verified copies, in input order, deep-frozen (see the header). */
  | { ok: true; events: EvidenceEvent[] }
  | { ok: false; reason: EvidenceSubjectBindingErrorCode; eventIndex?: number };

export interface EvidenceSubjectBindingInput {
  /** The digest the signature covers. */
  bundleHash: string;
  /** The events presented as the preimage of `bundleHash`, as stored or relayed. */
  events: readonly unknown[];
  subject: EvidenceSubject;
}

// ── Captured at load ─────────────────────────────────────────────────────────

const StringCharCodeAt = uncurryThis(String.prototype.charCodeAt) as (text: string, index: number) => number;

/**
 * SHA-256 of `text` as UTF-8, written `sha256:` + lowercase hex (what
 * canonical.ts's `sha256` writes), through node:crypto's `createHash` and the
 * Hash prototype's `update` and `digest`, all captured here. It is synchronous,
 * so no promise is awaited inside a check. It is null when the runtime cannot
 * give them, and then every call refuses (`unsupported-runtime`). Capturing
 * never throws, so the module always loads.
 */
const taggedSha256: ((text: string) => string) | null = (() => {
  try {
    const create = createHash;
    const proto: unknown = ObjectGetPrototypeOf(create("sha256"));
    if (proto === null || typeof proto !== "object") return null;
    const update = ObjectGetOwnPropertyDescriptor(proto, "update");
    const digest = ObjectGetOwnPropertyDescriptor(proto, "digest");
    if (update === undefined || !hasOwn(update, "value") || typeof update.value !== "function") return null;
    if (digest === undefined || !hasOwn(digest, "value") || typeof digest.value !== "function") return null;
    const callUpdate = uncurryThis(update.value as (data: string, encoding: string) => unknown);
    const callDigest = uncurryThis(digest.value as (encoding: string) => unknown);
    return (text: string): string => {
      const hash = create("sha256");
      callUpdate(hash, text, "utf8");
      return `sha256:${callDigest(hash, "hex") as string}`;
    };
  } catch {
    return null;
  }
})();

// ── Reading input: own data descriptors only ─────────────────────────────────

const SHA256_TAG = "sha256:";

/** LO-EV-1's tagged digest, `sha256:` + exactly 64 lowercase hex digits, checked code unit by code unit (no RegExp). */
function isTaggedSha256(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 71) return false;
  for (let i = 0; i < 7; i++) {
    if (StringCharCodeAt(value, i) !== StringCharCodeAt(SHA256_TAG, i)) return false;
  }
  for (let i = 7; i < 71; i++) {
    const unit = StringCharCodeAt(value, i);
    if (!((unit >= 0x30 && unit <= 0x39) || (unit >= 0x61 && unit <= 0x66))) return false;
  }
  return true;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** A copied (null-prototype) object, as opposed to an array or a primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !ArrayIsArray(value);
}

/**
 * Whether a caller's value is an object this module may read field by field:
 * not a Proxy (asked of the trap-free `isProxy`, which runs no trap), not an
 * array, and with Object.prototype or no prototype (no class instance, no
 * object whose prototype could serve a field). Only `isProxy` and
 * `getPrototypeOf` touch it, and neither runs caller code on a non-Proxy.
 */
function isReadableObject(value: unknown, proxyCheck: (value: object) => boolean): value is object {
  if (value === null || typeof value !== "object") return false;
  if (proxyCheck(value) || ArrayIsArray(value)) return false;
  const proto: unknown = ObjectGetPrototypeOf(value);
  return proto === ObjectPrototype || proto === null;
}

const ABSENT = "absent";
const ACCESSOR = "accessor";
type Field = { value: unknown } | typeof ABSENT | typeof ACCESSOR;

/**
 * `owner`'s own data property `key`, read once through its descriptor: never a
 * [[Get]], so no getter runs, and never an inherited value. The descriptor is a
 * fresh object the engine builds, and its `value` is taken only when it is the
 * descriptor's OWN property (a `value` written on Object.prototype is not).
 * `owner` must have passed `isReadableObject`.
 */
function ownField(owner: object, key: string): Field {
  const descriptor = ObjectGetOwnPropertyDescriptor(owner, key);
  if (descriptor === undefined) return ABSENT;
  if (!hasOwn(descriptor, "value")) return ACCESSOR;
  const field = ObjectCreate(null) as { value: unknown };
  field.value = descriptor.value;
  return field;
}

/** A frozen, null-prototype refusal: no `then` can be found on it. */
function refuse(reason: EvidenceSubjectBindingErrorCode, eventIndex?: number): EvidenceSubjectBindingResult {
  const result = ObjectCreate(null) as { ok: false; reason: EvidenceSubjectBindingErrorCode; eventIndex?: number };
  result.ok = false;
  result.reason = reason;
  if (eventIndex !== undefined) result.eventIndex = eventIndex;
  return ObjectFreeze(result);
}

/**
 * Settlement unit and challenge: the subject and the evidence agree exactly
 * (header, steps 8 and 9). Named, every event commits the value. Not named, no
 * event commits one. Null when they agree.
 */
function scopeEveryEvent(
  snapshots: readonly Record<string, unknown>[],
  field: "settlementUnitId" | "challengeNonce",
  expected: string | undefined,
  notCommitted: EvidenceSubjectBindingErrorCode,
  mismatch: EvidenceSubjectBindingErrorCode,
  notInSubject: EvidenceSubjectBindingErrorCode,
): EvidenceSubjectBindingResult | null {
  for (let i = 0; i < snapshots.length; i++) {
    const payload = snapshots[i]!.payload as Record<string, unknown>;
    const committed = hasOwn(payload, field);
    if (expected === undefined) {
      if (committed) return refuse(notInSubject, i);
      continue;
    }
    if (!committed) return refuse(notCommitted, i);
    if (payload[field] !== expected) return refuse(mismatch, i);
  }
  return null;
}

/**
 * Check that `bundleHash` opens to `events` and that those events commit the
 * subject. Never throws; returns the first failure.
 */
export async function verifyEvidenceSubjectBinding(
  input: EvidenceSubjectBindingInput,
): Promise<EvidenceSubjectBindingResult> {
  // What an engine error is refused as: the part being read when it happened.
  let reading: EvidenceSubjectBindingErrorCode = "malformed-subject";
  let readingIndex: number | undefined;
  try {
    const sha256Text = taggedSha256;
    const proxyCheck = isProxy;
    if (sha256Text === null || proxyCheck === null) return refuse("unsupported-runtime");

    // ── 1. The subject: the input's field, then its own five fields, each read once.
    const wrapper: unknown = input;
    if (!isReadableObject(wrapper, proxyCheck)) return refuse("malformed-subject");
    const subjectField = ownField(wrapper, "subject");
    if (subjectField === ABSENT || subjectField === ACCESSOR) return refuse("malformed-subject");
    const subject = subjectField.value;
    if (!isReadableObject(subject, proxyCheck)) return refuse("malformed-subject");
    const subjectFields = ["jobId", "kernelId", "outputHash", "settlementUnitId", "challengeNonce"] as const;
    const named = ObjectCreate(null) as Record<(typeof subjectFields)[number], unknown>;
    for (let k = 0; k < subjectFields.length; k++) {
      const key = subjectFields[k]!;
      const field = ownField(subject, key);
      if (field === ACCESSOR) return refuse("malformed-subject");
      named[key] = field === ABSENT ? undefined : field.value;
    }
    const jobId = named.jobId;
    const kernelId = named.kernelId;
    const outputHash = named.outputHash;
    const settlementUnitId = named.settlementUnitId;
    const challengeNonce = named.challengeNonce;
    if (
      !isNonEmptyString(jobId) ||
      !isNonEmptyString(kernelId) ||
      (outputHash !== undefined && !isNonEmptyString(outputHash)) ||
      (settlementUnitId !== undefined && !isHex256Digest(settlementUnitId)) ||
      (challengeNonce !== undefined && !isHex256Digest(challengeNonce))
    ) {
      return refuse("malformed-subject");
    }

    // ── 2. The digest.
    reading = "malformed-bundle-hash";
    const hashField = ownField(wrapper, "bundleHash");
    if (hashField === ABSENT || hashField === ACCESSOR || !isTaggedSha256(hashField.value)) {
      return refuse("malformed-bundle-hash");
    }
    const bundleHash = hashField.value;

    // ── 3. The events: each element read once, its hashed fields copied, its hash recomputed.
    reading = "malformed-event";
    const eventsField = ownField(wrapper, "events");
    if (eventsField === ABSENT) return refuse("missing-events");
    if (eventsField === ACCESSOR) return refuse("malformed-event");
    const list: unknown = eventsField.value;
    if (list === null || typeof list !== "object") return refuse("missing-events");
    if (proxyCheck(list)) return refuse("malformed-event");
    if (!ArrayIsArray(list)) return refuse("missing-events");
    if (ObjectGetPrototypeOf(list) !== ArrayPrototype) return refuse("malformed-event");
    const count = (list as unknown[]).length;
    if (count === 0) return refuse("missing-events");

    const snapshots = newList<Record<string, unknown>>(count);
    const eventHashes = newList<string>(count);
    for (let i = 0; i < count; i++) {
      readingIndex = i;
      const element = ObjectGetOwnPropertyDescriptor(list, i);
      if (element === undefined || !hasOwn(element, "value")) return refuse("malformed-event", i);
      const event: unknown = element.value;
      if (!isReadableObject(event, proxyCheck)) return refuse("malformed-event", i);
      const type = ownField(event, "type");
      const timestamp = ownField(event, "timestamp");
      const source = ownField(event, "source");
      const payload = ownField(event, "payload");
      const hash = ownField(event, "hash");
      const id = ownField(event, "id");
      if (
        type === ABSENT || type === ACCESSOR || !isNonEmptyString(type.value) ||
        timestamp === ABSENT || timestamp === ACCESSOR || typeof timestamp.value !== "string" ||
        source === ABSENT || source === ACCESSOR ||
        payload === ABSENT || payload === ACCESSOR ||
        hash === ABSENT || hash === ACCESSOR || !isTaggedSha256(hash.value) ||
        id === ACCESSOR
      ) {
        return refuse("malformed-event", i);
      }
      const sourceCopy = plainDataCopy(source.value);
      const payloadCopy = plainDataCopy(payload.value);
      if (!sourceCopy.ok || !payloadCopy.ok || !isRecord(sourceCopy.value) || !isRecord(payloadCopy.value)) {
        return refuse("malformed-event", i);
      }
      // Hash exactly what hashEvent hashes: the canonical JSON of these four fields.
      const hashed = ObjectCreate(null) as Record<string, unknown>;
      hashed.type = type.value;
      hashed.timestamp = timestamp.value;
      hashed.source = sourceCopy.value;
      hashed.payload = payloadCopy.value;
      if (sha256Text(canonicalize(hashed)) !== hash.value) return refuse("event-hash-mismatch", i);
      const snapshot = ObjectCreate(null) as Record<string, unknown>;
      snapshot.type = type.value;
      snapshot.timestamp = timestamp.value;
      snapshot.source = sourceCopy.value;
      snapshot.payload = payloadCopy.value;
      if (id !== ABSENT && typeof id.value === "string") snapshot.id = id.value;
      snapshot.hash = hash.value;
      defineIndex(snapshots, i, snapshot);
      defineIndex(eventHashes, i, hash.value);
    }
    readingIndex = undefined;

    // ── 4. The digest opens to exactly these events: hashBundle over the sorted event hashes.
    if (sha256Text(canonicalize(sortedStrings(eventHashes))) !== bundleHash) return refuse("bundle-hash-mismatch");

    // ── 5. Job: every event commits it.
    for (let i = 0; i < count; i++) {
      const committed = snapshots[i]!.payload as Record<string, unknown>;
      if (!hasOwn(committed, "jobId")) return refuse("job-not-committed", i);
      if (committed.jobId !== jobId) return refuse("job-mismatch", i);
    }

    // ── 6. Node: every event's source, and any payload kernel.
    for (let i = 0; i < count; i++) {
      const eventSource = snapshots[i]!.source as Record<string, unknown>;
      if (!hasOwn(eventSource, "kernelId") || eventSource.kernelId !== kernelId) return refuse("kernel-mismatch", i);
      const committed = snapshots[i]!.payload as Record<string, unknown>;
      if (hasOwn(committed, "kernelId") && committed.kernelId !== kernelId) return refuse("kernel-mismatch", i);
    }

    // ── 7. Output, when the subject names one: the completion event commits it, so one event suffices.
    if (outputHash !== undefined) {
      let committedOnce = false;
      for (let i = 0; i < count; i++) {
        const committed = snapshots[i]!.payload as Record<string, unknown>;
        if (!hasOwn(committed, "outputHash")) continue;
        if (committed.outputHash !== outputHash) return refuse("output-mismatch", i);
        committedOnce = true;
      }
      if (!committedOnce) return refuse("output-not-committed");
    }

    // ── 8, 9. Settlement unit and challenge: exact agreement, every event.
    const unit = scopeEveryEvent(
      snapshots, "settlementUnitId", settlementUnitId, "unit-not-committed", "unit-mismatch", "unit-not-in-subject",
    );
    if (unit !== null) return unit;
    const challenge = scopeEveryEvent(
      snapshots, "challengeNonce", challengeNonce, "challenge-not-committed", "challenge-mismatch", "challenge-not-in-subject",
    );
    if (challenge !== null) return challenge;

    deepFreeze(snapshots);
    const verified = ObjectCreate(null) as { ok: true; events: EvidenceEvent[] };
    verified.ok = true;
    verified.events = snapshots as unknown as EvidenceEvent[];
    return ObjectFreeze(verified);
  } catch {
    // Nothing supplied with the input runs, so only an engine error can arrive here.
    return refuse(reading, readingIndex);
  }
}
