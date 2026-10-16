import { EVIDENCE_EVENT_TYPES, isFabricated, type EvidenceEvent } from "@pcc/spec";
import { setTimeout as realSetTimeout, clearTimeout as realClearTimeout } from "node:timers";
import { performance } from "node:perf_hooks";
import type { MachineAdapter, MachineCommand, MachineCommandResult } from "../adapters/types.js";
import {
  CLAUSES, COMMAND_TYPES, type ClauseId, type ClauseStatus, type ConformanceContext,
  type ConformanceProfile, type ConformanceProfileFields, type MakeAdapter,
} from "./clauses.js";
import { conformanceReport, type ConformanceReport } from "./report.js";

type Event = Omit<EvidenceEvent, "id" | "hash">;
type Outcome = { status: ClauseStatus; reason: string };
const pass = (reason: string): Outcome => ({ status: "pass", reason });
const fail = (reason: string): Outcome => ({ status: "fail", reason });
const na = (reason: string): Outcome => ({ status: "n/a", reason });
const context: ConformanceContext = Object.freeze({ pccJobId: "pcc-conformance-job" });

class ClauseError extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate before invoking even the adapter factory; copy only serializable fields. */
function validate(profile: ConformanceProfile): ConformanceProfileFields {
  const bad = (field: string): never => { throw new TypeError(`Invalid conformance profile: ${field}`); };
  if (!record(profile)) bad("profile");
  for (const field of ["name", "bindingKey"] as const) {
    if (typeof profile[field] !== "string" || !profile[field].trim()) bad(field);
  }
  if (["jobId", "settlementUnitId", "challengeNonce", "mock", "origin"].includes(profile.bindingKey)) bad("bindingKey");
  if (!["physical", "digital"].includes(profile.kind)) bad("kind");
  if (!["real", "mock"].includes(profile.mode)) bad("mode");
  if (!["second-start", "none"].includes(profile.busy)) bad("busy");
  if (!Array.isArray(profile.declaredCommands) ||
    profile.declaredCommands.some((type) => !COMMAND_TYPES.includes(type)) ||
    new Set(profile.declaredCommands).size !== profile.declaredCommands.length ||
    !profile.declaredCommands.includes("start")) bad("declaredCommands");
  if (!record(profile.timing)) bad("timing");
  const timing = {} as ConformanceProfileFields["timing"];
  for (const field of ["cancelConfirmMs", "pollMs", "jobTimeoutMs", "quiesceTimeoutMs", "settleMs"] as const) {
    const value = profile.timing[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 2_147_483_647) bad(`timing.${field}`);
    timing[field] = value;
  }
  if (timing.cancelConfirmMs + timing.pollMs + timing.settleMs > 2_147_483_647) bad("timing.cancelWindow");
  if (typeof profile.startCommand !== "function") bad("startCommand");
  for (const field of ["prepareStart", "finish"] as const) {
    if (profile[field] !== undefined && typeof profile[field] !== "function") bad(field);
  }
  const terminal = profile.terminalEvents === undefined
    ? { completed: ["execution_completed"] as const, failed: ["execution_failed"] as const }
    : profile.terminalEvents;
  if (!record(terminal)) bad("terminalEvents");
  for (const field of ["completed", "failed"] as const) {
    if (!Array.isArray(terminal[field]) || terminal[field].length === 0 ||
      terminal[field].some((type) => !EVIDENCE_EVENT_TYPES.includes(type)) ||
      new Set(terminal[field]).size !== terminal[field].length) bad(`terminalEvents.${field}`);
  }
  if (terminal.completed.some((type) => terminal.failed.includes(type)) ||
    terminal.completed.includes("execution_failed") || terminal.failed.includes("execution_completed")) bad("terminalEvents overlap");
  return {
    name: profile.name, kind: profile.kind, mode: profile.mode, bindingKey: profile.bindingKey,
    declaredCommands: [...profile.declaredCommands],
    terminalEvents: { completed: [...terminal.completed], failed: [...terminal.failed] },
    timing, busy: profile.busy,
  };
}

/** Bound every asynchronous call; rejection text from adapters is never reported. */
function bounded<T>(operation: () => T | PromiseLike<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = realSetTimeout(() => reject(new ClauseError(`${label} timed out.`)), ms);
    Promise.resolve().then(operation).then(resolve, () => reject(new ClauseError(`${label} rejected.`)))
      .finally(() => realClearTimeout(timer));
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => realSetTimeout(resolve, ms));
const deviceId = (id: unknown): id is string | number =>
  (typeof id === "string" && id.length > 0) || (typeof id === "number" && Number.isFinite(id));

class Session {
  readonly events: Event[] = [];
  readonly allEvents: Event[] = [];
  collecting = false;
  closed = false;
  private disposal: Promise<void> | undefined;

  constructor(readonly adapter: MachineAdapter, readonly fields: ConformanceProfileFields, readonly hooks: ConformanceProfile) {
    adapter.onEvidence((event) => {
      // Snapshot at delivery: adapters are allowed to reuse their event objects.
      const snapshot = structuredClone(event);
      this.allEvents.push(snapshot);
      if (this.collecting && !this.closed) this.events.push(snapshot);
    });
  }

  isFailed = (event: Event): boolean =>
    event.type === "execution_failed" || this.fields.terminalEvents.failed.includes(event.type);
  isTerminal = (event: Event): boolean => this.isFailed(event) ||
    event.type === "execution_completed" || this.fields.terminalEvents.completed.includes(event.type);

  call<T>(operation: () => T | PromiseLike<T>, label: string): Promise<T> {
    return bounded(operation, this.fields.timing.jobTimeoutMs, label);
  }

  async start(): Promise<MachineCommandResult> {
    await this.call(() => this.hooks.prepareStart?.(this.adapter, context), "Preparation");
    const command = await this.call(() => this.hooks.startCommand(this.adapter, context), "Start command hook");
    if (command?.type !== "start") throw new ClauseError("Start command hook did not return start.");
    this.collecting = true;
    const result = await this.call(() => this.adapter.execute(command), "Start");
    if (!result.success) throw new ClauseError("Start was not accepted.");
    return result;
  }

  async finish(): Promise<void> {
    await this.call(() => this.hooks.finish?.(this.adapter, context), "Finish hook");
  }

  async terminal(ms = this.fields.timing.jobTimeoutMs): Promise<void> {
    // Poll only local observations, never an adapter's status or binding.
    const deadline = performance.now() + ms;
    while (!this.events.some(this.isTerminal)) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new ClauseError("Terminal event timed out.");
      await sleep(Math.min(this.fields.timing.pollMs, remaining));
    }
  }

  quiesce(): Promise<void> {
    return bounded(async () => {
      await this.adapter.quiesceEvidence();
      this.closed = true;
    }, this.fields.timing.quiesceTimeoutMs, "Quiesce");
  }

  async fullJob(): Promise<MachineCommandResult> {
    const result = await this.start();
    await this.finish();
    await this.terminal();
    // Only C1 judges honesty/liveness of quiesce. Other clauses retain evidence
    // through its first resolution and never consider events after that point.
    await this.quiesce().catch(() => undefined);
    this.closed = true;
    return result;
  }

  dispose(): Promise<void> {
    // Mark the ordinary observation window closed BEFORE cleanup; C7 uses allEvents.
    this.closed = true;
    return this.disposal ??= bounded(() => this.adapter.dispose(), this.fields.timing.quiesceTimeoutMs, "Dispose");
  }
}

/**
 * Local adapter-contract checks. The handshake is adapters/types.ts:8-23,79-84;
 * binding is printer-job.ts:35-66,144-153; busy is types.ts:37-43; cancellation
 * is types.ts:57-68; native terminal types are types.ts:73-77. Tag classification
 * delegates to spec/src/evidence/is-fabricated.ts:32. PCC/unit payload ownership
 * follows evidence-emitter.ts:186-205. No signing or registration is performed.
 */
async function check(id: ClauseId, s: Session): Promise<Outcome> {
  const { adapter: a, fields: p } = s;
  switch (id) {
    case "C1": {
      await s.quiesce();
      const atIdle = s.allEvents.length;
      await sleep(p.timing.settleMs);
      if (s.allEvents.length !== atIdle) return fail("Evidence arrived after quiesce resolved.");
      s.closed = false;
      await s.start();
      let early = false;
      let atResolution = 0;
      // Attach rejection handling immediately, even while the finish hook waits.
      const quiet = s.quiesce().then(() => {
        early = !s.events.some(s.isTerminal);
        atResolution = s.allEvents.length;
        return undefined;
      }, (error: unknown) => error);
      await sleep(p.timing.pollMs);
      await s.finish();
      const error = await quiet;
      if (error) throw error;
      await sleep(p.timing.settleMs);
      if (early) return fail("Quiesce resolved before terminal delivery.");
      if (s.allEvents.length !== atResolution) return fail("Evidence arrived after quiesce resolved.");
      return pass("Quiesce waits for terminal delivery and stays silent.");
    }
    case "C2": {
      const result = await s.fullJob();
      if (!deviceId(result.data?.jobId)) return fail("Accepted start did not return a device job id.");
      if (s.events.some((event) => event.payload[p.bindingKey] !== result.data?.jobId)) {
        return fail("Evidence did not strictly bind to the accepted device job id.");
      }
      return pass("Start and every job event share the device job id.");
    }
    case "C3": {
      await s.fullJob();
      const terminals = s.events.filter(s.isTerminal);
      if (terminals.length !== 1) return fail("Job did not emit exactly one terminal event.");
      if (terminals.some((event) => s.isFailed(event) && event.payload.origin !== "device")) {
        return fail("Failed terminal did not have device origin.");
      }
      return pass("Job emits one terminal with device origin on failure.");
    }
    case "C4": {
      if (typeof a.cancelJob !== "function") return na("Adapter has no cancelJob function.");
      const original = a.execute;
      let stopped = false;
      a.execute = function (command: MachineCommand) {
        if (command.type === "stop") stopped = true;
        return original.call(this, command);
      };
      try {
        const result = await s.start();
        // Binding is judged exclusively by C2; a missing result id can still
        // be recovered from evidence for this cancellation probe.
        const own = deviceId(result.data?.jobId) ? result.data.jobId
          : s.events.map((event) => event.payload[p.bindingKey]).find(deviceId);
        if (!deviceId(own)) throw new ClauseError("Cancellation probe could not identify its job.");
        const foreign = typeof own === "number" ? (own === 1 ? 2 : 1) : `${own}-foreign`;
        const window = p.timing.cancelConfirmMs + p.timing.pollMs + p.timing.settleMs;
        const beforeForeign = s.events.length;
        await bounded(() => a.cancelJob!(foreign), window, "Foreign cancellation");
        await sleep(p.timing.settleMs);
        if (s.events.slice(beforeForeign).some(s.isFailed)) return fail("Foreign cancellation emitted a failed terminal.");
        // A device may complete naturally during the foreign-id observation.
        // Only ask to cancel an own job that is still running.
        if (!s.events.some(s.isTerminal)) {
          await bounded(async () => {
            await a.cancelJob!(own);
            await s.terminal(window);
          }, window, "Own cancellation");
        }
        if (stopped) return fail("Cancellation executed stop.");
        if (s.events.some((event) => s.isFailed(event) && event.payload.origin !== "device")) {
          return fail("Cancellation failure did not have device origin.");
        }
        return pass("Cancellation preserves foreign jobs and confirms its own without stop.");
      } finally { a.execute = original; }
    }
    case "C5": {
      if (p.busy === "none") return na("Profile does not request a second-start busy probe.");
      const first = await s.start();
      const beforeSecond = s.events.length;
      const command = await s.call(() => s.hooks.startCommand(a, context), "Start command hook");
      const second = await s.call(() => a.execute(command), "Second start");
      await sleep(p.timing.settleMs);
      const newEvents = s.events.slice(beforeSecond);
      if (second.success !== false || second.busy !== true) return fail("Second start did not refuse with busy true.");
      if (second.data?.jobId !== undefined && second.data.jobId !== first.data?.jobId) {
        return fail("Busy refusal returned a new device job id.");
      }
      if (newEvents.some((event) => deviceId(event.payload[p.bindingKey]) &&
        deviceId(first.data?.jobId) && event.payload[p.bindingKey] !== first.data.jobId)) {
        return fail("Second start emitted evidence for a new device job.");
      }
      return pass("Second start refuses busy without creating another job.");
    }
    case "C6": {
      await s.fullJob();
      if (s.events.some((event) => isFabricated(event as EvidenceEvent) !== (p.mode === "mock"))) {
        return fail("Evidence fabrication tags disagree with profile mode.");
      }
      return pass("Every job event has the profile's fabrication classification.");
    }
    case "C7": {
      await s.start();
      if (s.events.some(s.isTerminal)) return fail("Job ended before the running-dispose probe.");
      await s.dispose();
      const atDispose = s.allEvents.length;
      await sleep(p.timing.settleMs);
      if (s.allEvents.length !== atDispose) return fail("Evidence arrived after dispose resolved.");
      return pass("Dispose stays silent with a job running.");
    }
    case "C8": {
      await s.fullJob();
      if (s.events.some((event) =>
        (Object.hasOwn(event.payload, "jobId") && event.payload.jobId !== context.pccJobId) ||
        Object.hasOwn(event.payload, "settlementUnitId") || Object.hasOwn(event.payload, "challengeNonce"))) {
        return fail("Evidence supplied a foreign PCC job id or a reserved unit field.");
      }
      return pass("Evidence respects PCC job and unit field ownership.");
    }
    case "C9": {
      if (p.kind === "digital") return na("Digital profiles do not require cancelJob.");
      if (typeof a.cancelJob !== "function") return fail("Physical adapter has no cancelJob function.");
      return pass("Physical adapter provides cancelJob.");
    }
    case "C10": {
      const type = COMMAND_TYPES.find((type) => !p.declaredCommands.includes(type));
      if (!type) return na("Profile declares every MachineCommand type.");
      const before = await s.call(() => a.getStatus(), "Status");
      const count = s.allEvents.length;
      const result = await s.call(() => a.execute({ type }), "Undeclared command");
      await sleep(p.timing.settleMs);
      const after = await s.call(() => a.getStatus(), "Status");
      if (result.success !== false) return fail("Undeclared command was not refused.");
      if (s.allEvents.length !== count) return fail("Undeclared command emitted evidence.");
      if (after !== before) return fail("Undeclared command changed device status.");
      return pass("Undeclared command refuses silently without changing status.");
    }
  }
}

/**
 * Run all clauses sequentially using fresh, locally trusted adapters. Factory,
 * hooks, commands, status, cancellation, quiesce and disposal are bounded. An
 * eventual adapter from a timed-out factory is also disposed when it arrives.
 * This cannot interrupt synchronous blocking code in the caller's process.
 */
export async function runAdapterConformance(makeAdapter: MakeAdapter, profile: ConformanceProfile): Promise<ConformanceReport> {
  const fields = validate(profile);
  if (typeof makeAdapter !== "function") throw new TypeError("makeAdapter must be a function");
  const rows = [];
  for (const clause of CLAUSES) {
    let session: Session | undefined;
    let adapter: MachineAdapter | undefined;
    let outcome: Outcome;
    let abandoned = false;
    try {
      adapter = await bounded(async () => {
        const made = await makeAdapter();
        if (abandoned) {
          await bounded(() => made.dispose(), fields.timing.quiesceTimeoutMs, "Dispose").catch(() => undefined);
        }
        return made;
      }, fields.timing.jobTimeoutMs, "Adapter factory");
      session = new Session(adapter, fields, profile);
      outcome = await check(clause.id, session);
    } catch (error) {
      outcome = fail(error instanceof ClauseError ? error.message : "Adapter contract probe rejected.");
    } finally {
      abandoned = true;
      if (adapter) {
        try {
          await (session ? session.dispose() : bounded(() => adapter!.dispose(), fields.timing.quiesceTimeoutMs, "Dispose"));
        } catch (error) {
          outcome = fail(error instanceof ClauseError ? error.message : "Dispose rejected.");
        }
      }
    }
    rows.push({ ...clause, ...outcome! });
  }
  return conformanceReport(fields, rows);
}
