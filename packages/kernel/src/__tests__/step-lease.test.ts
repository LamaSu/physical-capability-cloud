/**
 * The step lease (step-lease.ts), shared by JobRunner and the print-job path (N106). The
 * JobRunner suites pin how a run uses it (job-runner-evidence-scope, -handoff); the print
 * suites how a print does (printer-job-evidence-bound). This file pins the module's own
 * contract.
 */

import { describe, expect, it } from "vitest";

import { EvidenceEmitter } from "../evidence-emitter.js";
import { isStepLeased, leaseStep } from "../step-lease.js";

const signFn = async () => ({ signer: "0x0000000000000000000000000000000000000000" as const, algorithm: "secp256k1" as const, value: "sig" });

describe("step leases", () => {
  it("hold a (jobId, stepId) on one emitter from leaseStep until its release", () => {
    const emitter = new EvidenceEmitter("kernel-lease", signFn);
    expect.soft(isStepLeased(emitter, "job", "step"), "before the lease").toBe(false);
    const release = leaseStep(emitter, "job", "step");
    expect.soft(isStepLeased(emitter, "job", "step"), "while leased").toBe(true);
    release();
    expect(isStepLeased(emitter, "job", "step"), "after the release").toBe(false);
  });

  it("key on the emitter's own step key, jobId and stepId together", () => {
    const emitter = new EvidenceEmitter("kernel-lease", signFn);
    const release = leaseStep(emitter, "job", "step-1");
    expect.soft(isStepLeased(emitter, "job", "step-2"), "another step of the job").toBe(false);
    expect.soft(isStepLeased(emitter, "job-2", "step-1"), "the step of another job").toBe(false);
    expect(isStepLeased(emitter, "job", "step-1"), "the leased step").toBe(true);
    release();
  });

  it("are per emitter: a key held on one emitter is free on another", () => {
    const one = new EvidenceEmitter("kernel-lease", signFn);
    const two = new EvidenceEmitter("kernel-lease", signFn);
    const release = leaseStep(one, "job", "step");
    expect(isStepLeased(two, "job", "step")).toBe(false);
    release();
  });

  it("are released only by the lease that holds the key: a stale release leaves a later lease held", () => {
    const emitter = new EvidenceEmitter("kernel-lease", signFn);
    const releaseFirst = leaseStep(emitter, "job", "step");
    releaseFirst();
    const releaseSecond = leaseStep(emitter, "job", "step");
    releaseFirst(); // called again, after the key passed to the second lease
    expect.soft(isStepLeased(emitter, "job", "step"), "after the stale release").toBe(true);
    releaseSecond();
    expect(isStepLeased(emitter, "job", "step"), "after the holder's release").toBe(false);
  });
});
