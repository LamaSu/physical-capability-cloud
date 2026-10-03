/**
 * JobRunner always resolves, and releases what it holds, whatever ONE collaborator throws, at
 * EVERY place the run touches one (steward #5604 (3), after astra packs 209 and 212 each found a
 * new site of the same class).
 *
 * A census run records every property read and every call the run makes on its collaborators:
 * the caller's config and sensor list, the machine, the sensor, the camera, the evidence emitter
 * and the onPhase callback. Then, for each recorded site, a fresh run throws there once (a read
 * that throws; a call that throws; a promise-returning call that rejects), with a reason that has
 * no text form. A successful run never reaches the failure path's own sites (the stops, close(),
 * cleanup()), so each of those runs records the sites it touched after its fault, and a second
 * pass throws at the first fault and then again at each of those. Every injected run must resolve
 * with a JobResult, must not report success without the tier's evidence in its bundle, and must
 * leave nothing unhandled; then the same step must run again on the same collaborators and
 * succeed (after at most two "quiescing" refusals, which a rejected hook earns by design), so no
 * lease, session or device is left held.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceBundle, EvidenceEvent, EvidenceSource, SHA256 } from "@pcc/spec";

import type { CameraAdapter, MachineAdapter, MachineCommand, MachineCommandResult, SensorAdapter } from "../adapters/types.js";
import { EvidenceEmitter } from "../evidence-emitter.js";
import { JobRunner } from "../job-runner.js";
import type { JobConfig, JobResult } from "../job-runner.js";

// Plain functions, not vi.fn(), so vi.restoreAllMocks() cannot strip them.
vi.mock("@sentry/node", () => ({
  startSpan: (_opts: unknown, fn: () => unknown) => fn(),
  addBreadcrumb: () => {},
  captureException: () => {},
}));

type Emitted = Omit<EvidenceEvent, "id" | "hash">;

const KERNEL_ID = "kernel-total-property";
const TIER = 2;
const REQUIRED = ["gcode_hash_verified", "execution_completed", "power_profile_summary", "cv_inspection_result"];
/** Calls whose contract returns a promise: these are also made to reject. */
const ASYNC = new Set(["execute", "getProgress", "getStatus", "startRecording", "stopRecording", "getCurrentReading", "captureSnapshot", "runInspection", "quiesceEvidence", "dispose", "addEvent", "finalizeBundle"]);

/** A fault: the nth read of a property, or the nth call of a method, of a named collaborator, throws (or rejects). */
interface Fault {
  site: string;
  how: "throw" | "reject";
}

/** The faults of one run, each thrown once, in order; and every site the run touched. */
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

function noText(): unknown {
  return Object.create(null);
}

/** Every read and call the run makes on `target` is a site; the armed one throws (or rejects) once. */
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

function event(type: Emitted["type"], source: EvidenceSource, payload: Record<string, unknown> = {}): Emitted {
  return { type, timestamp: new Date().toISOString(), source, payload };
}

/** One run's collaborators, each instrumented, with fresh device ids. */
function rig(caseId: string, inj: Injector) {
  const machineSource: EvidenceSource = { deviceId: `m-${caseId}`, deviceType: "controller", kernelId: KERNEL_ID };
  const sensorSource: EvidenceSource = { deviceId: `s-${caseId}`, deviceType: "power_monitor", kernelId: KERNEL_ID };
  const cameraSource: EvidenceSource = { deviceId: `c-${caseId}`, deviceType: "camera", kernelId: KERNEL_ID };
  const machineListeners: Array<(e: Emitted) => void> = [];
  const machine: MachineAdapter = {
    id: `m-${caseId}`,
    type: "fdm",
    source: machineSource,
    async getStatus() {
      return "busy";
    },
    async getProgress() {
      return 100;
    },
    async execute(command: MachineCommand): Promise<MachineCommandResult> {
      if (command.type === "load_gcode") {
        const gcodeHash = String(command.payload?.gcodeHash);
        for (const l of [...machineListeners]) l(event("gcode_hash_verified", machineSource, { gcodeHash }));
        for (const l of [...machineListeners]) l(event("execution_completed", machineSource, { gcodeHash }));
      }
      return { success: true, message: "ok" };
    },
    onEvidence(callback) {
      machineListeners.push(callback);
    },
    async quiesceEvidence() {},
    async dispose() {},
  } as MachineAdapter;
  const sensorListeners: Array<(e: Emitted) => void> = [];
  const sensor: SensorAdapter = {
    id: `s-${caseId}`,
    type: "power_monitor",
    source: sensorSource,
    async startRecording() {},
    async stopRecording() {
      const summary = event("power_profile_summary", sensorSource, { joules: 1 });
      for (const l of [...sensorListeners]) l(summary);
      return summary;
    },
    async getCurrentReading() {
      return {};
    },
    onEvidence(callback) {
      sensorListeners.push(callback);
    },
    async quiesceEvidence() {},
    async dispose() {},
  };
  const cameraListeners: Array<(e: Emitted) => void> = [];
  const camera: CameraAdapter = {
    id: `c-${caseId}`,
    source: cameraSource,
    async captureSnapshot() {
      for (const l of [...cameraListeners]) l(event("camera_snapshot", cameraSource, { imageHash: "sha256:before" }));
      return { imageHash: "sha256:before", storageRef: "mem://before" };
    },
    async runInspection() {
      for (const l of [...cameraListeners]) l(event("cv_inspection_result", cameraSource, { passed: true }));
      return { passed: true, confidence: 1, findings: [], imageHash: "sha256:after" };
    },
    onEvidence(callback) {
      cameraListeners.push(callback);
    },
    async quiesceEvidence() {},
    async dispose() {},
  };
  const emitter = new EvidenceEmitter(KERNEL_ID);
  const bundles: EvidenceBundle[] = [];
  emitter.onBundle((bundle) => bundles.push(bundle));
  instrumentEmitter(emitter, inj);
  let phases = 0;
  const config: JobConfig = {
    jobId: `job-${caseId}`,
    stepId: "step-1",
    gcodeHash: `sha256:${"7".repeat(64)}` as SHA256,
    assuranceTier: TIER,
    onPhase: () => {
      reach(inj, `call onPhase#${++phases}`);
    },
  };
  const runner = new JobRunner(
    instrument("machine", machine, inj),
    instrument("sensors", [instrument("sensor", sensor, inj)], inj),
    instrument("camera", camera, inj),
    emitter,
    { evidenceQuiesceTimeoutMs: 500, evidenceSettleTimeoutMs: 500 },
  );
  return { runner, config: instrument("config", config, inj), bundles };
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

describe("JobRunner: whatever one collaborator throws, wherever, run() resolves and releases what it holds (steward #5604)", () => {
  /** The faults to try at `site`: a throw; and a rejection too, where the call returns a promise. */
  const faultsAt = (site: string): Fault[] => {
    const method = /^call [^.]+\.(\w+)#/.exec(site)?.[1];
    return method !== undefined && ASYNC.has(method) ? [{ site, how: "throw" }, { site, how: "reject" }] : [{ site, how: "throw" }];
  };

  /** Runs one plan; returns what went wrong (empty when nothing did), and the sites touched after its first fault. */
  async function check(plan: Fault[], caseId: string): Promise<{ failures: string[]; afterFirst: string[] }> {
    const inj = injector(plan);
    const { runner, config, bundles } = rig(caseId, inj);
    const label = plan.map((f) => `${f.how} at ${f.site}`).join(", then ");
    const failures: string[] = [];
    const out = await catchingUnhandled(() => runner.run(config));
    inj.recording = false;
    if (inj.fired !== plan.length) failures.push(`${label}: only ${inj.fired} of ${plan.length} faults were reached`);
    if (out.rejected) failures.push(`${label}: run() rejected`);
    const result = out.value;
    if (result !== undefined) {
      if (typeof result.success !== "boolean" || typeof result.durationMs !== "number") failures.push(`${label}: not a JobResult`);
      if (!result.success && typeof result.error !== "string") failures.push(`${label}: a failure with no text`);
      if (result.success) {
        const types = new Set((bundles.at(-1)?.events ?? []).map((e) => e.type));
        const missing = REQUIRED.filter((t) => !types.has(t as EvidenceEvent["type"]));
        if (missing.length > 0) failures.push(`${label}: success without ${missing.join(", ")}`);
      }
    }
    if (out.unhandled > 0) failures.push(`${label}: ${out.unhandled} unhandled rejection(s)`);
    // Every fault has fired once; the same step runs again on the same collaborators.
    let again: { value?: JobResult; rejected: boolean; unhandled: number } | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      again = await catchingUnhandled(() => runner.run(config));
      if (again.value?.busy?.reason !== "quiescing") break;
    }
    if (again?.value?.success !== true) failures.push(`${label}: the same step, run again: ${again?.rejected ? "rejected" : JSON.stringify(again?.value?.error ?? again?.value?.busy)}`);
    if ((again?.unhandled ?? 0) > 0) failures.push(`${label}: the rerun left ${again?.unhandled} unhandled rejection(s)`);
    return { failures, afterFirst: [...new Set(inj.afterFirst)] };
  }

  it("at every site the run touches, and then at every site its failure path touches", { timeout: 300_000 }, async () => {
    // The census: one run with nothing planned, which must succeed.
    const census = injector([]);
    const base = rig("census", census);
    expect(await base.runner.run(base.config), "the census run").toMatchObject({ success: true });
    const singles = [...new Set(census.seen)].flatMap(faultsAt);
    expect(singles.length, "single faults").toBeGreaterThan(40);

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
