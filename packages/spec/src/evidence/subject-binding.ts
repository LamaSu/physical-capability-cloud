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
 *   5. job: at least one event commits `payload.jobId`, and every
 *      `payload.jobId` equals the subject's job;
 *   6. node: every event's `source.kernelId`, and every `payload.kernelId`,
 *      equals the kernel that accepted the job;
 *   7. output, only when the subject names one: at least one event commits
 *      `payload.outputHash`, and every `payload.outputHash` equals it.
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

import { hashBundle, hashEvent } from "../util/canonical.js";
import type { EvidenceEvent } from "../types/evidence.js";
import { isTaggedDigest } from "./signing-preimage.js";

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
  | "output-mismatch";

export type EvidenceSubjectBindingResult =
  | { ok: true }
  | { ok: false; reason: EvidenceSubjectBindingErrorCode; eventIndex?: number };

export interface EvidenceSubjectBindingInput {
  /** The digest the signature covers. */
  bundleHash: string;
  /** The events presented as the preimage of `bundleHash`, as stored or relayed. */
  events: readonly unknown[];
  subject: EvidenceSubject;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Check that `bundleHash` opens to `events` and that those events commit the
 * subject. Never throws; returns the first failure.
 */
export async function verifyEvidenceSubjectBinding(
  input: EvidenceSubjectBindingInput,
): Promise<EvidenceSubjectBindingResult> {
  const subject: unknown = input.subject;
  if (
    !isPlainObject(subject) ||
    !isNonEmptyString(subject.jobId) ||
    !isNonEmptyString(subject.kernelId) ||
    (subject.outputHash !== undefined && !isNonEmptyString(subject.outputHash))
  ) {
    return { ok: false, reason: "malformed-subject" };
  }
  if (!isTaggedDigest(input.bundleHash)) {
    return { ok: false, reason: "malformed-bundle-hash" };
  }
  if (!Array.isArray(input.events) || input.events.length === 0) {
    return { ok: false, reason: "missing-events" };
  }

  const events: EvidenceEvent[] = [];
  for (let i = 0; i < input.events.length; i++) {
    const e: unknown = input.events[i];
    if (
      !isPlainObject(e) ||
      !isNonEmptyString(e.type) ||
      typeof e.timestamp !== "string" ||
      !isPlainObject(e.source) ||
      !isPlainObject(e.payload) ||
      !isTaggedDigest(e.hash)
    ) {
      return { ok: false, reason: "malformed-event", eventIndex: i };
    }
    const event = e as unknown as EvidenceEvent;
    const recomputed = await hashEvent({
      type: event.type,
      timestamp: event.timestamp,
      source: event.source,
      payload: event.payload,
    });
    if (recomputed !== event.hash) {
      return { ok: false, reason: "event-hash-mismatch", eventIndex: i };
    }
    events.push(event);
  }
  if ((await hashBundle(events)) !== input.bundleHash) {
    return { ok: false, reason: "bundle-hash-mismatch" };
  }

  let jobCommitted = false;
  for (let i = 0; i < events.length; i++) {
    const committed = events[i]!.payload.jobId;
    if (committed === undefined) continue;
    if (committed !== subject.jobId) return { ok: false, reason: "job-mismatch", eventIndex: i };
    jobCommitted = true;
  }
  if (!jobCommitted) return { ok: false, reason: "job-not-committed" };

  for (let i = 0; i < events.length; i++) {
    const { source, payload } = events[i]!;
    if (source.kernelId !== subject.kernelId) {
      return { ok: false, reason: "kernel-mismatch", eventIndex: i };
    }
    if (payload.kernelId !== undefined && payload.kernelId !== subject.kernelId) {
      return { ok: false, reason: "kernel-mismatch", eventIndex: i };
    }
  }

  if (subject.outputHash !== undefined) {
    let outputCommitted = false;
    for (let i = 0; i < events.length; i++) {
      const committed = events[i]!.payload.outputHash;
      if (committed === undefined) continue;
      if (committed !== subject.outputHash) {
        return { ok: false, reason: "output-mismatch", eventIndex: i };
      }
      outputCommitted = true;
    }
    if (!outputCommitted) return { ok: false, reason: "output-not-committed" };
  }

  return { ok: true };
}
