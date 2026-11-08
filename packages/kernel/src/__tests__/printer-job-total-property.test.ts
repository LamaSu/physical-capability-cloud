/**
 * runPrintJob always resolves, and releases what it holds, whatever ONE collaborator throws, at
 * EVERY place the print touches one (steward #5604 (3), after astra packs 210 and 213 each found
 * a new site of the same class; the same property as job-runner-total-property.test.ts).
 *
 * A census print records every property read and every call the print makes on its
 * collaborators: the caller's options, the printer adapter and the evidence emitter. Then, for
 * each recorded site, a fresh print throws there once (a read that throws; a call that throws; a
 * promise-returning call that rejects), with a reason that has no text form. A successful print
 * never reaches the failure path's own sites (close(), cleanup()), so each of those prints records
 * the sites it touched after its fault, and a second pass throws at the first fault and then
 * again at each of those. Every injected print must resolve with a PrintJobResult, must not report
 * success without its device job's completion in its bundle, must keep every failure eventless
 * except an exact signed terminal failure, and must leave nothing unhandled;
 * then the same step must print again on the same collaborators and succeed (after at most two
 * "quiescing" refusals, which a rejected hook earns by design), so no lease, session or printer
 * is left held.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";

import type { MachineAdapter, MachineCommand, MachineCommandResult } from "../adapters/types.js";
import { EvidenceEmitter } from "../evidence-emitter.js";
import { runPrintJob } from "../printer-job.js";
import type { PrintJobOptions, PrintJobResult } from "../printer-job.js";

// Keep hash bytes real while removing libuv threadpool timing from the fault census.
const realDigest = globalThis.crypto.subtle.digest;
function installMicrotaskSha256(): void {
  vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
    const name = typeof algorithm === "string" ? algorithm : algorithm.name;
    if (name.toUpperCase() !== "SHA-256") return realDigest.call(globalThis.crypto.subtle, algorithm, data);
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    return Uint8Array.from(createHash("sha256").update(bytes).digest()).buffer;
  });
}

type Emitted = Omit<EvidenceEvent, "id" | "hash">;

const KERNEL_ID = "kernel-print-total-property";
/** Calls whose contract returns a promise: these are also made to reject. */
const ASYNC = new Set(["execute", "cancelJob", "getProgress", "getStatus", "quiesceEvidence", "dispose", "addEvent", "finalizeBundle"]);

/** A fault: the nth read of a property, or the nth call of a method, of a named collaborator, throws (or rejects). */
interface Fault {
  site: string;
  how: "throw" | "reject";
}

/** The faults of one print, each thrown once, in order; and every site the print touched. */
interface Injector {
  plan: Fault[];
  fired: number;
  seen: string[];
  /** The sites touched after the first fault fired, while `recording`. */
  afterFirst: string[];
  recording: boolean;
}

function injector(plan: Fault[]): Injector {
  return { plan, fired: 0, seen: [], afterFirst: [], recording: true };
}

function noText(): unknown {
  return Object.create(null);
}

/** Records `site`, and throws (or returns a rejection) if it is the next planned fault. */
function reach(inj: Injector, site: string): { reject: boolean } | null {
  if (!inj.recording) return null;
  inj.seen.push(site);
  if (inj.fired > 0) inj.afterFirst.push(site);
  const fault = inj.plan[inj.fired];
  if (fault === undefined || fault.site !== site) return null;
  inj.fired += 1;
  if (fault.how === "throw") throw noText();
  return { reject: true };
}

/** Every read and call the print makes on `target` is a site; a planned one throws (or rejects) once. */
function instrument<T extends object>(name: string, target: T, inj: Injector): T {
  const counts = new Map<string, number>();
  const next = (key: string) => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return `${key}#${n}`;
  };
  return new Proxy(target, {
    get(t, property) {
      const key = `${name}.${String(property)}`;
      reach(inj, next(`read ${key}`));
      const value: unknown = Reflect.get(t, property, t);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (reach(inj, next(`call ${key}`))) return Promise.reject(noText());
        return (value as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

/** The emitter is the real one (the step leases are keyed by it); its methods are spied, not proxied. */
function instrumentEmitter(emitter: EvidenceEmitter, inj: Injector): void {
  const counts = new Map<string, number>();
  for (const method of ["registerStep", "addEvent", "getEvents", "checkTierRequirements", "finalizeBundle", "cleanup"] as const) {
    const real = (emitter[method] as (...a: unknown[]) => unknown).bind(emitter);
    vi.spyOn(emitter, method).mockImplementation(((...args: unknown[]) => {
      const n = (counts.get(method) ?? 0) + 1;
      counts.set(method, n);
      if (reach(inj, `call emitter.${method}#${n}`)) return Promise.reject(noText());
      return real(...args);
    }) as never);
  }
}

/** A printer that accepts every start, and reports the device job started and completed inside it. */
function rig(caseId: string, inj: Injector) {
  const source: EvidenceSource = { deviceId: `p-${caseId}`, deviceType: "controller", kernelId: KERNEL_ID };
  const listeners: Array<(e: Emitted) => void> = [];
  const observed: Emitted[] = [];
  const emit = (type: Emitted["type"], payload: Record<string, unknown>) => {
    const e: Emitted = { type, timestamp: new Date().toISOString(), source, payload };
    observed.push(e);
    for (const l of [...listeners]) l(e);
  };
  let nextJob = 100;
  const printer: MachineAdapter = {
    id: `p-${caseId}`,
    type: "ipp-2d",
    source,
    async getStatus() {
      return "idle";
    },
    async getProgress() {
      return 100;
    },
    async execute(command: MachineCommand): Promise<MachineCommandResult> {
      if (command.type !== "start") return { success: true, message: "ok" };
      const job = nextJob++;
      emit("execution_started", { ippJobId: job });
      emit("execution_completed", { ippJobId: job, totalPages: 1 });
      return { success: true, message: `job ${job} accepted`, data: { jobId: job } };
    },
    onEvidence(callback) {
      listeners.push(callback);
    },
    async quiesceEvidence() {},
    async dispose() {},
  } as MachineAdapter;
  const emitter = new EvidenceEmitter(KERNEL_ID);
  instrumentEmitter(emitter, inj);
  const opts: PrintJobOptions = {
    adapter: instrument("adapter", printer, inj),
    emitter,
    jobId: `print-${caseId}`,
    jobName: "a.pdf",
    totalPages: 1,
    timeoutMs: 2_000,
    evidenceQuiesceTimeoutMs: 500,
    evidenceSettleTimeoutMs: 500,
  };
  // This rig has no cancelJob: neither a timeout nor an abort can qualify for a signed
  // cancellation failure. Check against the events actually emitted, never just the
  // result's claimed failure.kind (which would weaken the eventless-failure oracle).
  return { opts: instrument("opts", opts, inj), observed };
}

type CancelResponse = "device-failure" | "breaches-quiesce-contract-silent" | "no-cancel";

/**
 * A live job which aborts inside start and never completes. The device-failure variant
 * honours quiesce: a failed cancel leaves the job live and the hook pending. The explicitly
 * named silent variant breaches that contract, solely to census the kernel-failure defence
 * in depth. The no-cancel variant also reaches the adapter-id read in that refusal.
 */
function cancelRig(caseId: string, inj: Injector, response: CancelResponse, stallMs = 0, stalls: number[] = []) {
  const source: EvidenceSource = { deviceId: `p-${caseId}`, deviceType: "controller", kernelId: KERNEL_ID };
  const listeners: Array<(e: Emitted) => void> = [];
  const observed: Emitted[] = [];
  const controller = new AbortController();
  let completeOnStart = false;
  let live = false;
  let done: Promise<void> = Promise.resolve();
  let endWork = () => {};
  let nextJob = 100;
  const finish = () => {
    live = false;
    endWork();
  };
  const emit = (type: Emitted["type"], payload: Record<string, unknown>) => {
    const event: Emitted = { type, timestamp: new Date().toISOString(), source, payload };
    observed.push(event);
    for (const listener of [...listeners]) listener(event);
  };
  const printer: MachineAdapter = {
    id: `p-${caseId}`,
    type: "ipp-2d",
    source,
    async getStatus() { return live ? "busy" : "idle"; },
    async getProgress() { return 0; },
    async execute(command) {
      if (command.type !== "start") return { success: true, message: "ok" };
      const job = nextJob++;
      live = true;
      done = new Promise<void>((resolve) => { endWork = resolve; });
      emit("execution_started", { ippJobId: job });
      if (completeOnStart) {
        emit("execution_completed", { ippJobId: job, totalPages: 1 });
        finish();
      } else {
        controller.abort();
      }
      return { success: true, message: `job ${job} accepted`, data: { jobId: job } };
    },
    ...(response === "no-cancel" ? {} : {
      async cancelJob(job: string | number) {
        if (stallMs > 0) {
          const start = performance.now();
          while (performance.now() - start < stallMs) {}
          stalls.push(performance.now() - start);
        }
        if (response === "device-failure") {
          emit("execution_failed", { ippJobId: job, state: "canceled", origin: "device" });
          finish();
        }
      },
    }),
    onEvidence(callback) { listeners.push(callback); },
    async quiesceEvidence() {
      if (response === "breaches-quiesce-contract-silent") return;
      await done;
    },
    async dispose() { finish(); },
  };
  const emitter = new EvidenceEmitter(KERNEL_ID);
  instrumentEmitter(emitter, inj);
  const options: PrintJobOptions = {
    adapter: instrument("adapter", printer, inj),
    emitter,
    jobId: `print-${caseId}`,
    jobName: "a.pdf",
    totalPages: 1,
    signal: instrument("signal", controller.signal, inj),
    timeoutMs: 20,
    cancelWindowMs: 5,
    evidenceQuiesceTimeoutMs: 20,
    evidenceSettleTimeoutMs: 500,
  };
  return {
    opts: instrument("opts", options, inj),
    observed,
    prepareReprint() {
      // Finish any still-live test work before checking the handoff, including when a
      // fault prevented cancelJob from running. A reprint uses the same device and step.
      finish();
      completeOnStart = true;
      options.signal = undefined;
    },
  };
}

/** The exact signed-failure exceptions each rig can earn, based on the evidence it emitted. */
function exactSignedFailure(result: PrintJobResult, observed: readonly Emitted[], jobId: string, cancelResponse?: CancelResponse): boolean {
  const failure = result.failure;
  const bundle = result.bundle;
  if (result.success || failure === undefined || bundle === undefined) return false;
  const completed = observed.some((event) => event.type === "execution_completed" && event.payload.ippJobId === 100);
  const failed = observed.some((event) => event.type === "execution_failed" && event.payload.ippJobId === 100);
  let kernelEvent = false;
  if (cancelResponse === undefined) {
    // Timeout/abort require an actual cancelJob call. The completing rig has none.
    if (failure.origin !== "device" || result.cancelRequested !== undefined || !failed) return false;
    if (failure.kind !== (completed ? "contradiction" : "device_reported")) return false;
  } else {
    if (cancelResponse === "no-cancel" || completed || result.cancelRequested !== "aborted" || failure.kind !== "aborted") return false;
    kernelEvent = cancelResponse === "breaches-quiesce-contract-silent";
    // A fault that prevents cancel in the honest variant leaves live work, so cannot sign.
    if (failure.origin !== (kernelEvent ? "kernel" : "device") || failed === kernelEvent) return false;
  }
  if (bundle.jobId !== jobId || bundle.stepId !== jobId || bundle.kernelId !== KERNEL_ID) return false;
  if (result.events !== bundle.events || bundle.events.length !== observed.length + Number(kernelEvent)) return false;
  if (bundle.kernelSignature.algorithm !== "secp256k1"
    || bundle.kernelSignature.signer !== "0x0000000000000000000000000000000000000000"
    || bundle.kernelSignature.value !== `test_sig_${bundle.bundleHash.slice(0, 16)}`) return false;
  // Device events must correspond, in order, to evidence the adapter really emitted;
  // only the emitter's PCC job commitment is added. The breach-only synthetic exception
  // permits exactly one kernel event, with the expected identity, reason and source.
  return bundle.events.every((event, index) => {
    if (kernelEvent && index === observed.length) {
      return event.type === "execution_failed" && Number.isFinite(Date.parse(event.timestamp))
        && JSON.stringify(event.source) === JSON.stringify(observed[0]?.source)
        && JSON.stringify(event.payload) === JSON.stringify({ ippJobId: 100, reason: "aborted", origin: "kernel", jobId });
    }
    const original = observed[index];
    return original !== undefined && event.payload.ippJobId === 100 && event.payload.jobId === jobId
      && event.type === original.type && event.timestamp === original.timestamp
      && JSON.stringify(event.source) === JSON.stringify(original.source)
      && JSON.stringify(event.payload) === JSON.stringify({ ...original.payload, jobId });
  });
}

/** Runs `body`, and collects every rejection Node reports as unhandled meanwhile. */
async function catchingUnhandled<T>(body: () => Promise<T>): Promise<{ value?: T; rejected: boolean; unhandled: number }> {
  let unhandled = 0;
  const on = () => void (unhandled += 1);
  process.on("unhandledRejection", on);
  try {
    const value = await body();
    await new Promise((r) => setTimeout(r, 5));
    return { value, rejected: false, unhandled };
  } catch {
    await new Promise((r) => setTimeout(r, 5));
    return { rejected: true, unhandled };
  } finally {
    process.off("unhandledRejection", on);
  }
}

beforeEach(() => {
  installMicrotaskSha256();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("runPrintJob: whatever one collaborator throws, wherever, the print resolves and releases what it holds (steward #5604)", () => {
  /** The faults to try at `site`: a throw; and a rejection too, where the call returns a promise. */
  const faultsAt = (site: string): Fault[] => {
    const method = /^call [^.]+\.(\w+)#/.exec(site)?.[1];
    return method !== undefined && ASYNC.has(method) ? [{ site, how: "throw" }, { site, how: "reject" }] : [{ site, how: "throw" }];
  };

  /** Runs one plan; returns what went wrong (empty when nothing did), and the sites touched after its first fault. */
  async function check(plan: Fault[], caseId: string, cancelResponse?: CancelResponse, stallMs = 0, stalls: number[] = []): Promise<{ failures: string[]; afterFirst: string[] }> {
    const inj = injector(plan);
    const testRig = cancelResponse === undefined ? rig(caseId, inj) : cancelRig(caseId, inj, cancelResponse, stallMs, stalls);
    const { opts, observed } = testRig;
    const label = plan.map((f) => `${f.how} at ${f.site}`).join(", then ");
    const failures: string[] = [];
    const out = await catchingUnhandled(() => runPrintJob(opts));
    inj.recording = false;
    if (inj.fired !== plan.length) failures.push(`${label}: only ${inj.fired} of ${plan.length} faults were reached`);
    if (out.rejected) failures.push(`${label}: the print rejected`);
    const result = out.value;
    if (result !== undefined) {
      if (typeof result.success !== "boolean" || typeof result.durationMs !== "number" || !Array.isArray(result.events)) failures.push(`${label}: not a PrintJobResult`);
      if (!result.success && typeof result.error !== "string") failures.push(`${label}: a failure with no text`);
      if (!result.success && !exactSignedFailure(result, observed, `print-${caseId}`, cancelResponse)) {
        if (result.events.length > 0) failures.push(`${label}: an ineligible failure with events`);
        if (result.bundle !== undefined) failures.push(`${label}: an ineligible failure with a bundle`);
        if (result.failure !== undefined) failures.push(`${label}: an ineligible failure with a signed verdict`);
      }
      if (result.success && !result.events.some((e) => e.type === "execution_completed" && e.payload.ippJobId === result.completion?.printerJobId)) {
        failures.push(`${label}: success without its device job's completion`);
      }
      if (result.success && result.events.some((e) => e.type === "execution_failed")) failures.push(`${label}: success with a device job's failure`);
    }
    if (out.unhandled > 0) failures.push(`${label}: ${out.unhandled} unhandled rejection(s)`);
    if ("prepareReprint" in testRig && typeof testRig.prepareReprint === "function") testRig.prepareReprint();
    // Fault injection has ended; the same step prints again on the same collaborators.
    let again: { value?: PrintJobResult; rejected: boolean; unhandled: number } | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      again = await catchingUnhandled(() => runPrintJob(opts));
      if (again.value?.busy?.reason !== "quiescing") break;
    }
    if (again?.value?.success !== true) failures.push(`${label}: the same step, printed again: ${again?.rejected ? "rejected" : JSON.stringify(again?.value?.error ?? again?.value?.busy)}`);
    if ((again?.unhandled ?? 0) > 0) failures.push(`${label}: the reprint left ${again?.unhandled} unhandled rejection(s)`);
    return { failures, afterFirst: [...new Set(inj.afterFirst)] };
  }

  it("at every site the print touches, and then at every site its failure path touches", { timeout: 300_000 }, async () => {
    // The census: one print with nothing planned, which must succeed.
    const census = injector([]);
    expect(await runPrintJob(rig("census", census).opts), "the census print").toMatchObject({ success: true });
    const singles = [...new Set(census.seen)].flatMap(faultsAt);
    expect(singles.length, "single faults").toBeGreaterThan(20);

    const failures: string[] = [];
    let runs = 0;
    const doubles: Fault[][] = [];
    for (const first of singles) {
      const { failures: found, afterFirst } = await check([first], `p${++runs}`);
      failures.push(...found);
      for (const site of afterFirst) for (const second of faultsAt(site)) doubles.push([first, second]);
    }
    expect(doubles.length, "double faults").toBeGreaterThan(singles.length);
    for (const plan of doubles) failures.push(...(await check(plan, `p${++runs}`)).failures);
    expect(failures, `${singles.length} single and ${doubles.length} double faults`).toEqual([]);
  });

  for (const response of ["device-failure", "breaches-quiesce-contract-silent", "no-cancel"] as const) {
    it(`at every cancellation site and every failure-path site (${response})`, { timeout: 300_000 }, async () => {
      const census = injector([]);
      const censusRig = cancelRig(`cancel-census-${response}`, census, response);
      const result = await runPrintJob(censusRig.opts);
      expect(result.success, "the cancellation census print").toBe(false);
      if (response === "no-cancel") {
        expect(result).toMatchObject({ events: [], error: expect.stringContaining("cannot cancel") });
        expect(result.bundle).toBeUndefined();
      } else {
        expect(exactSignedFailure(result, censusRig.observed, `print-cancel-census-${response}`, response), "the census earns the exact signed-failure exception").toBe(true);
      }
      censusRig.prepareReprint();

      // All three reads are independent sites: before holding anything, after listener
      // installation, and after start. The source's third read builds the kernel event;
      // the no-cancel id read formats the refusal after start.
      expect(census.seen).toEqual(expect.arrayContaining([
        "read signal.aborted#1", "read signal.aborted#2", "read signal.aborted#3",
        "call signal.addEventListener#1", "call signal.removeEventListener#1",
        "read adapter.cancelJob#1",
        ...(response === "no-cancel" ? ["read adapter.id#1"] : ["call adapter.cancelJob#1"]),
        ...(response === "breaches-quiesce-contract-silent" ? ["read adapter.source#3"] : []),
      ]));
      if (response === "no-cancel") {
        expect(census.seen[census.seen.indexOf("read adapter.cancelJob#1") + 1], "the refusal reads the adapter id").toBe("read adapter.id#1");
      }
      const singles = [...new Set(census.seen)].flatMap(faultsAt);
      if (response !== "no-cancel") {
        expect(singles).toContainEqual({ site: "call adapter.cancelJob#1", how: "reject" });
      }
      const failures: string[] = [];
      const doubles: Fault[][] = [];
      let runs = 0;
      for (const first of singles) {
        const { failures: found, afterFirst } = await check([first], `cancel-${response}-${++runs}`, response);
        failures.push(...found);
        for (const site of afterFirst) for (const second of faultsAt(site)) doubles.push([first, second]);
      }
      for (const plan of doubles) failures.push(...(await check(plan, `cancel-${response}-${++runs}`, response)).failures);
      expect(failures, `${singles.length} cancellation single and ${doubles.length} double faults`).toEqual([]);
    });
  }

  it("the six quiesce-then-write plans survive a 10 ms cancellation stall", async () => {
    // Let pending work from the censuses drain before forcing the worker past cancel's bound.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const plans: Fault[][] = [
      [{ site: "read adapter.quiesceEvidence#2", how: "throw" }, { site: "call emitter.addEvent#2", how: "throw" }],
      [{ site: "read adapter.quiesceEvidence#2", how: "throw" }, { site: "call emitter.addEvent#2", how: "reject" }],
      [{ site: "call adapter.quiesceEvidence#1", how: "throw" }, { site: "call emitter.addEvent#2", how: "throw" }],
      [{ site: "call adapter.quiesceEvidence#1", how: "throw" }, { site: "call emitter.addEvent#2", how: "reject" }],
      [{ site: "call adapter.quiesceEvidence#1", how: "reject" }, { site: "call emitter.addEvent#2", how: "throw" }],
      [{ site: "call adapter.quiesceEvidence#1", how: "reject" }, { site: "call emitter.addEvent#2", how: "reject" }],
    ];
    const stalls: number[] = [];
    const failures: string[] = [];
    for (const [index, plan] of plans.entries()) {
      failures.push(...(await check(plan, `stall-${index}`, "breaches-quiesce-contract-silent", 10, stalls)).failures);
    }
    expect(stalls, "one cancellation stall per plan").toHaveLength(6);
    for (const elapsed of stalls) expect(elapsed, "worker blocked for at least 10 ms").toBeGreaterThanOrEqual(10);
    expect(failures).toEqual([]);
  });

  it("SHA-256 alone settles in microtasks, hashes exact source bytes, and restores WebCrypto", async () => {
    const backing = new Uint8Array([91, 12, 34, 56, 78, 92]);
    const view = backing.subarray(1, 5);
    const buffer = new Uint8Array([9, 8, 7, 6]).buffer;
    const expectedView = await realDigest.call(globalThis.crypto.subtle, "SHA-256", view);
    const expectedBuffer = await realDigest.call(globalThis.crypto.subtle, { name: "sha-256" }, buffer);
    const expected512 = await realDigest.call(globalThis.crypto.subtle, "SHA-512", view);
    let viewHash: ArrayBuffer | undefined;
    let bufferHash: ArrayBuffer | undefined;
    let hash512: ArrayBuffer | undefined;
    const viewDone = globalThis.crypto.subtle.digest("SHA-256", view).then((hash) => { viewHash = hash; });
    const bufferDone = globalThis.crypto.subtle.digest({ name: "sha-256" }, buffer).then((hash) => { bufferHash = hash; });
    const done512 = globalThis.crypto.subtle.digest("SHA-512", view).then((hash) => { hash512 = hash; });
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    expect(viewHash, "view SHA-256 settles before a macrotask").toBeDefined();
    expect(new Uint8Array(viewHash!)).toEqual(new Uint8Array(expectedView));
    expect(bufferHash, "ArrayBuffer SHA-256 settles before a macrotask").toBeDefined();
    expect(new Uint8Array(bufferHash!)).toEqual(new Uint8Array(expectedBuffer));
    expect(viewHash).not.toBe(bufferHash);
    expect(hash512, "SHA-512 still waits for WebCrypto").toBeUndefined();
    await Promise.all([viewDone, bufferDone, done512]);
    expect(new Uint8Array(hash512!)).toEqual(new Uint8Array(expected512));

    vi.restoreAllMocks();
    expect(globalThis.crypto.subtle.digest, "restoreAllMocks restores WebCrypto").toBe(realDigest);
    let restoredHash: ArrayBuffer | undefined;
    const restored = globalThis.crypto.subtle.digest("SHA-256", view).then((hash) => { restoredHash = hash; });
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    expect(restoredHash, "real SHA-256 waits for WebCrypto again").toBeUndefined();
    await restored;
    expect(new Uint8Array(restoredHash!)).toEqual(new Uint8Array(expectedView));
  });

  it("an unreached fault is reported once and cannot fire in the reprint", async () => {
    const { failures } = await check([{ site: "call emitter.addEvent#3", how: "throw" }], "unreached");
    expect(failures).toEqual(["throw at call emitter.addEvent#3: only 0 of 1 faults were reached"]);
  });
});
