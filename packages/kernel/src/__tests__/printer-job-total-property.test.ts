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
 * success without its device job's completion in its bundle, and must leave nothing unhandled;
 * then the same step must print again on the same collaborators and succeed (after at most two
 * "quiescing" refusals, which a rejected hook earns by design), so no lease, session or printer
 * is left held.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";

import type { MachineAdapter, MachineCommand, MachineCommandResult } from "../adapters/types.js";
import { EvidenceEmitter } from "../evidence-emitter.js";
import { runPrintJob } from "../printer-job.js";
import type { PrintJobOptions, PrintJobResult } from "../printer-job.js";

type Emitted = Omit<EvidenceEvent, "id" | "hash">;

const KERNEL_ID = "kernel-print-total-property";
/** Calls whose contract returns a promise: these are also made to reject. */
const ASYNC = new Set(["execute", "getProgress", "getStatus", "quiesceEvidence", "dispose", "addEvent", "finalizeBundle"]);

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
  if (inj.recording) {
    inj.seen.push(site);
    if (inj.fired > 0) inj.afterFirst.push(site);
  }
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
  const emit = (type: Emitted["type"], payload: Record<string, unknown>) => {
    const e: Emitted = { type, timestamp: new Date().toISOString(), source, payload };
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
  return { opts: instrument("opts", opts, inj) };
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
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("runPrintJob: whatever one collaborator throws, wherever, the print resolves and releases what it holds (steward #5604)", () => {
  /** The faults to try at `site`: a throw; and a rejection too, where the call returns a promise. */
  const faultsAt = (site: string): Fault[] => {
    const method = /^call [^.]+\.(\w+)#/.exec(site)?.[1];
    return method !== undefined && ASYNC.has(method) ? [{ site, how: "throw" }, { site, how: "reject" }] : [{ site, how: "throw" }];
  };

  /** Runs one plan; returns what went wrong (empty when nothing did), and the sites touched after its first fault. */
  async function check(plan: Fault[], caseId: string): Promise<{ failures: string[]; afterFirst: string[] }> {
    const inj = injector(plan);
    const { opts } = rig(caseId, inj);
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
      if (!result.success && result.events.length > 0) failures.push(`${label}: a failure with events`);
      if (result.success && !result.events.some((e) => e.type === "execution_completed" && e.payload.ippJobId === result.completion?.printerJobId)) {
        failures.push(`${label}: success without its device job's completion`);
      }
    }
    if (out.unhandled > 0) failures.push(`${label}: ${out.unhandled} unhandled rejection(s)`);
    // Every fault has fired once; the same step prints again on the same collaborators.
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
});
