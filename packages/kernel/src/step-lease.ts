/**
 * Step leases: one run at a time for each (jobId, stepId) on an evidence emitter.
 *
 * EvidenceEmitter.registerStep overwrites the step under an active key, so two runs of one
 * step on disjoint adapters would read and finalize each other's events (astra pack 172).
 * So a run checks its key (isStepLeased) before it registers the step, and takes it
 * (leaseStep) in the same synchronous block; a run whose key is held is refused. It releases
 * the key on every exit, last, so a later run of the step registers a fresh record.
 *
 * JobRunner (job-runner.ts) and the print-job path (printer-job.ts) share this one map, so a
 * job step and a print on one emitter cannot run under the same key either.
 */

import type { EvidenceEmitter } from "./evidence-emitter.js";

/** The (jobId, stepId) keys running on each emitter, each mapped to the run that holds it. */
const activeSteps = new WeakMap<EvidenceEmitter, Map<string, string>>();
let runs = 0;

/** The emitter's own key for a step. */
function stepKeyOf(jobId: string, stepId: string): string {
  return `${jobId}:${stepId}`;
}

/** True while a run holds (jobId, stepId) on this emitter. */
export function isStepLeased(emitter: EvidenceEmitter, jobId: string, stepId: string): boolean {
  return activeSteps.get(emitter)?.has(stepKeyOf(jobId, stepId)) === true;
}

/**
 * Take (jobId, stepId) on this emitter, in the same synchronous block as the isStepLeased
 * check that found it free. Returns the release, which frees the key only while this lease
 * still holds it.
 */
export function leaseStep(emitter: EvidenceEmitter, jobId: string, stepId: string): () => void {
  let leases = activeSteps.get(emitter);
  if (leases === undefined) {
    leases = new Map();
    activeSteps.set(emitter, leases);
  }
  const held = leases;
  const stepKey = stepKeyOf(jobId, stepId);
  const lease = `${jobId}#${++runs}`;
  held.set(stepKey, lease);
  return () => {
    if (held.get(stepKey) === lease) held.delete(stepKey);
  };
}
