import type { MachineAdapter, PrintJobOptions, PrintJobResult } from "@pcc/kernel";
// The toolkit barrel starts a shop runtime at import time. Use the built leaf,
// as kernel-signer does, until the toolkit publishes a print-job subpath.
import { runPrintJob } from "../../kernel/dist/printer-job.js";
import { EvidenceEmitter } from "../../kernel/dist/evidence-emitter.js";
import type { HostConfig } from "./config.js";
import type { EStopDecision, GatewayClient, GwCode, GwResult, PollJobsValue } from "./gateway-client.js";
import { isUnitBinding, JOB_INPUT_CODES, type JobInputSource, type JobInputs } from "./job-inputs.js";
import type { JobJournal, JournalState } from "./journal.js";
import type { DeviceKey } from "./keys.js";
import { makeKernelEd25519Signer } from "./kernel-signer.js";
import { openUnitEvidenceSession, UnitSessionError, type UnitEvidenceSession } from "./unit-session.js";

const gatewayCodes = [
  "unauthenticated", "not_kernel_operator", "operator_proof_required", "job_has_no_kernel",
  "insufficient_scope", "blocked_by_policy", "forbidden", "kernel_not_found", "route_unavailable",
  "rate_limited", "bad_request", "unavailable", "server_error", "network", "timeout",
  "malformed_response", "job_not_found", "settlement_owned_status", "job_kernel_changed",
  "invalid_status", "payload_too_large", "bad_bundle", "stored_mismatch", "not_stored",
  "evidence_refused", "indeterminate",
] as const satisfies readonly GwCode[];

/** No caller, server, document, or device text is passed to the host logger. */
export const HOST_LOG_CODES = [
  "heartbeat_ok", "poll_ok", "poll_only", "idle", "claimed", "in_progress_reported",
  "printing", "printed", "print_failed", "busy", "busy_retry_limit", "bundle_saved",
  "evidence_stored", "evidence_indeterminate", "evidence_refused", "abandoned",
  "interrupted", "simulated_refused", "no_bundle", "journal_failed", "host_shutdown",
  "reader_unavailable", "stopped", "absent", "malformed", "poll_failed", "session_failed",
  ...gatewayCodes, ...JOB_INPUT_CODES,
] as const;
export type HostLogCode = typeof HOST_LOG_CODES[number];
export type HostPrintOptions = PrintJobOptions;
export interface HostTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface HostDeps {
  config: HostConfig;
  gateway: GatewayClient;
  inputSource: JobInputSource;
  journal: JobJournal;
  adapter?: MachineAdapter;
  deviceKey?: DeviceKey;
  /** Public EOA read from the operator key file; no operator signer enters the host. */
  operatorAddress?: string;
  print?: (options: HostPrintOptions) => Promise<PrintJobResult>;
  clock?: () => number;
  timers?: HostTimers;
  logger?: (code: HostLogCode) => void;
  /** The CLI always uses real mode; explicit false is for simulation rehearsals. */
  realMode?: boolean;
  pollOnly?: boolean;
  stopSignal?: AbortSignal;
  timeoutMs?: number;
  cancelWindowMs?: number;
}
export interface HostTickResult {
  kind: "idle" | "blocked" | "backoff" | "job" | "halted";
  waitMs: number;
  jobId?: string;
  state?: JournalState;
}

const terminalReportCodes = new Set<GwCode>([
  "job_not_found", "settlement_owned_status", "job_kernel_changed", "invalid_status",
]);
const transientReportCodes = new Set<GwCode>([
  "network", "timeout", "unavailable", "server_error", "rate_limited", "malformed_response",
]);
const timerDefaults: HostTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
type HostGatewayCode = typeof gatewayCodes[number];
function safeGwCode(code: GwCode): HostGatewayCode {
  for (const allowed of gatewayCodes) if (code === allowed) return allowed;
  return "malformed_response";
}

/** One tick owns the printer, including cancellation and relay receipt journaling. */
export function createHost(deps: HostDeps): {
  runOnce(): Promise<HostTickResult>;
  run(stopSignal: AbortSignal): Promise<void>;
} {
  const { config, gateway, journal } = deps;
  const now = deps.clock ?? Date.now;
  const timers = deps.timers ?? timerDefaults;
  const log = (code: HostLogCode) => { deps.logger?.(code); };
  const interval = config.eStopPollIntervalMs ?? 5_000;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 60_000) throw new Error("bad_host_interval");
  const print = deps.print ?? runPrintJob;
  let initialized = false;
  let halted = false;
  let stopped = deps.stopSignal?.aborted === true;
  let lastHeartbeat = -Infinity;
  let pollFailures = 0;
  let nextPollAt = -Infinity;
  let activeTick: Promise<HostTickResult> | undefined;
  let activePrint: AbortController | undefined;
  let pending: { jobId: string; inputs: JobInputs; reported: boolean; reports: number; prints: number;
    session?: UnitEvidenceSession } | undefined;
  const requestStop = () => {
    stopped = true;
    activePrint?.abort();
  };

  function backoff(result: Extract<GwResult<unknown>, { ok: false }>): number {
    const exponential = 5_000 * 2 ** Math.min(pollFailures++, 4);
    const retry = Number.isFinite(result.retryAfterS) ? Math.max(0, result.retryAfterS ?? 0) * 1_000 : 0;
    const waitMs = Math.min(60_000, Math.max(exponential, retry));
    nextPollAt = now() + waitMs;
    return waitMs;
  }
  async function heartbeat(): Promise<void> {
    if (now() - lastHeartbeat < 30_000) return;
    lastHeartbeat = now();
    try {
      const result = await gateway.heartbeat();
      log(result.ok ? "heartbeat_ok" : safeGwCode(result.code));
    } catch { log("network"); }
  }
  async function poll(): Promise<GwResult<PollJobsValue>> {
    try { return await gateway.pollJobs(); }
    catch { return { ok: false, code: "network", status: null }; }
  }
  function stopReason(stop: EStopDecision): void {
    if (stop.proceed === true) return;
    const why = ["reader_unavailable", "stopped", "unavailable", "absent", "malformed", "poll_failed"] as const;
    log(why.includes(stop.why) ? stop.why : "malformed");
  }
  async function append(state: JournalState, code?: HostGatewayCode | "busy_retry_limit" | "no_bundle"): Promise<void> {
    await journal.append(pending!.jobId, state, code);
    log(state);
    if (code) log(code);
  }
  async function tick(): Promise<HostTickResult> {
    if (halted) return { kind: "halted", waitMs: 5_000 };
    if (!initialized) {
      await journal.initialize();
      initialized = true;
      for (const record of await journal.list()) if (record.state === "interrupted") log("interrupted");
    }
    if (stopped) return { kind: "blocked", waitMs: 5_000 };
    await heartbeat();
    if (now() < nextPollAt) return { kind: "backoff", waitMs: nextPollAt - now() };
    const initial = await poll();
    if (!initial.ok) {
      log(safeGwCode(initial.code));
      return { kind: "backoff", waitMs: backoff(initial) };
    }
    nextPollAt = -Infinity;
    pollFailures = 0;
    log("poll_ok");
    if (initial.value.stop.proceed !== true) {
      stopReason(initial.value.stop);
      return { kind: "blocked", waitMs: 5_000 };
    }
    if (deps.pollOnly) { log("poll_only"); return { kind: "idle", waitMs: 5_000 }; }
    if (stopped) return { kind: "blocked", waitMs: 5_000 };
    if (!pending) {
      for (const job of initial.value.jobs) {
        if (job.status !== "queued" || await journal.has(job.jobId)) continue;
        let input;
        try { input = await deps.inputSource(job.jobId); }
        catch { log("job_inputs_unavailable"); return { kind: "idle", waitMs: 5_000 }; }
        if (!input.ok) {
          log(JOB_INPUT_CODES.includes(input.code) ? input.code : "job_inputs_unavailable");
          return { kind: "idle", waitMs: 5_000 };
        }
        // Custom sources must obey the same binding contract as file manifests.
        // Missing funding/unit information never claims a real job.
        if (!isUnitBinding(input.value?.unit)) {
          log("job_inputs_bad_schema");
          return { kind: "idle", waitMs: 5_000 };
        }
        if (stopped) return { kind: "blocked", waitMs: 5_000 };
        pending = { jobId: job.jobId, inputs: input.value, reported: false, reports: 0, prints: 0 };
        await append("claimed");
        break;
      }
    }
    if (!pending) { log("idle"); return { kind: "idle", waitMs: 5_000 }; }
    const jobId = pending.jobId;
    const done = (state: JournalState): HostTickResult => {
      pending = undefined;
      return { kind: "job", jobId, state, waitMs: 5_000 };
    };
    if (!pending.reported) {
      pending.reports++;
      let reported;
      try { reported = await gateway.reportInProgress(jobId); }
      catch { reported = { ok: false as const, code: "network" as const, status: null }; }
      if (!reported.ok) {
        const code = safeGwCode(reported.code);
        if (terminalReportCodes.has(code) || !transientReportCodes.has(code) || pending.reports >= 3) {
          await append("abandoned", code);
          return done("abandoned");
        }
        log(code);
        return { kind: "job", jobId, state: "claimed", waitMs: backoff(reported) };
      }
      pending.reported = true;
      await append("in_progress_reported");
    }
    if (!pending.session) {
      if (!deps.deviceKey || !deps.operatorAddress || !deps.adapter) {
        log("session_failed");
        await append("abandoned");
        return done("abandoned");
      }
      try {
        const { settlementUnitId, challengeNonce, fundedAt, reclaimAt } = pending.inputs.unit;
        pending.session = await openUnitEvidenceSession({
          settlementUnitId, challengeNonce, jobId,
          parentAgentId: `eip155:${config.chain.chainId}:${deps.operatorAddress.toLowerCase()}`,
          fundedAt, expiresAt: reclaimAt, deviceKey: deps.deviceKey,
          journalDir: journal.sessionDirectory(jobId), now: () => Math.floor(now() / 1_000),
        });
      } catch (error) {
        if (error instanceof UnitSessionError && error.code === "journal_exists") {
          await append("interrupted");
          return done("interrupted");
        }
        log("session_failed");
        // Halt on a possibly partial session write, just as for the job journal.
        throw new Error("session_failed");
      }
    }
    // A clear grants permission for only this poll. Claiming/reporting consumed
    // time, so even a retry must get a fresh clear before driving the printer.
    const beforePrint = await poll();
    if (!beforePrint.ok) {
      log(safeGwCode(beforePrint.code));
      return { kind: "backoff", jobId, waitMs: backoff(beforePrint) };
    }
    if (beforePrint.value.stop.proceed !== true) {
      stopReason(beforePrint.value.stop);
      return { kind: "blocked", jobId, waitMs: 5_000 };
    }
    if (stopped) return { kind: "blocked", jobId, waitMs: 5_000 };
    // Busy retries, e-stop blocks, and the poll itself can outlive the unit.
    // Check after the fresh poll so expired evidence authority never starts work.
    if (Math.floor(now() / 1_000) >= pending.inputs.unit.reclaimAt) {
      log("session_failed");
      await append("abandoned");
      return done("abandoned");
    }
    const controller = new AbortController();
    activePrint = controller;
    let watcherOpen = true;
    let watcherTimer: unknown;
    let heartbeatTimer: unknown;
    function scheduleHeartbeat(): void {
      if (watcherOpen) heartbeatTimer = timers.setTimeout(() => {
        void heartbeat().then(scheduleHeartbeat);
      }, Math.max(1, 30_000 - (now() - lastHeartbeat)));
    }
    function scheduleWatcher(): void {
      if (watcherOpen && !controller.signal.aborted) {
        watcherTimer = timers.setTimeout(() => { void watch(); }, interval);
      }
    }
    async function watch(): Promise<void> {
      const decision = await poll();
      if (!watcherOpen) return;
      if (!decision.ok) {
        log(safeGwCode(decision.code));
        backoff(decision);
        controller.abort();
      } else if (decision.value.stop.proceed !== true) {
        stopReason(decision.value.stop);
        controller.abort();
      } else {
        await heartbeat();
        scheduleWatcher();
      }
    }
    let result: PrintJobResult;
    let throwaway: ReturnType<typeof makeKernelEd25519Signer> | undefined;
    try {
      await append("printing");
      pending.prints++;
      if (stopped) controller.abort();
      scheduleWatcher();
      scheduleHeartbeat();
      try {
        // runPrintJob requires a signer. GAP-7 consumes print events, never the
        // print's success/failure bundle: this fresh throwaway signature has no
        // authority, and its bundle is discarded without saving or posting it.
        throwaway = makeKernelEd25519Signer();
        result = await print({
          jobId, ...pending.inputs, ...pending.inputs.unit,
          adapter: deps.adapter!, emitter: new EvidenceEmitter(config.kernelId, throwaway.signFn),
          signal: controller.signal, timeoutMs: deps.timeoutMs, cancelWindowMs: deps.cancelWindowMs,
        });
      } catch { result = { success: false, events: [], durationMs: 0 }; }
    } finally {
      throwaway?.secretKey.fill(0);
      watcherOpen = false;
      timers.clearTimeout(watcherTimer);
      timers.clearTimeout(heartbeatTimer);
      activePrint = undefined;
    }
    if (deps.realMode !== false && [...result.events, ...(result.bundle?.events ?? [])]
      .some((event) => event.source.simulated === true)) {
      await append("simulated_refused");
      return done("simulated_refused");
    }
    if (result.busy) {
      await append("busy");
      if (pending.prints >= 3) {
        await append("abandoned", "busy_retry_limit");
        return done("abandoned");
      }
      return { kind: "job", jobId, state: "busy", waitMs: 5_000 };
    }
    if (result.events.length === 0) {
      await append("print_failed", "no_bundle");
      return done("print_failed");
    }
    // Include the complete event sequence in either outcome, including the
    // negative control's execution_failed evidence. Never use result.bundle.
    for (const event of result.events) await pending.session.addEvent(event);
    const bundle = await pending.session.finalize();
    await append(result.success ? "printed" : "print_failed");
    await journal.saveBundle(jobId, bundle);
    await append("bundle_saved");
    let receipt;
    try { receipt = await gateway.postRelayEvidence(jobId, bundle); }
    catch { receipt = { ok: false as const, code: "indeterminate" as const, status: null }; }
    if (receipt.ok) { await append("evidence_stored"); return done("evidence_stored"); }
    const code = safeGwCode(receipt.code);
    if (code === "indeterminate") {
      await append("evidence_indeterminate");
      return done("evidence_indeterminate");
    }
    await append("evidence_refused", code);
    return done("evidence_refused");
  }

  function runOnce(): Promise<HostTickResult> {
    if (activeTick) return activeTick;
    if (deps.stopSignal?.aborted) requestStop();
    deps.stopSignal?.addEventListener("abort", requestStop, { once: true });
    activeTick = tick().catch((): HostTickResult => {
      // A partial local write must stop this process before another side effect.
      halted = true;
      log("journal_failed");
      return { kind: "halted", waitMs: 5_000 };
    }).finally(() => {
      deps.stopSignal?.removeEventListener("abort", requestStop);
      activeTick = undefined;
    });
    return activeTick;
  }
  async function wait(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || stopped) return;
    await new Promise<void>((resolve) => {
      let handle: unknown;
      const finish = () => {
        timers.clearTimeout(handle);
        signal.removeEventListener("abort", finish);
        deps.stopSignal?.removeEventListener("abort", finish);
        resolve();
      };
      handle = timers.setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });
      deps.stopSignal?.addEventListener("abort", finish, { once: true });
      if (signal.aborted || deps.stopSignal?.aborted) finish();
    });
  }
  return {
    runOnce,
    async run(stopSignal): Promise<void> {
      stopSignal.addEventListener("abort", requestStop, { once: true });
      if (stopSignal.aborted) requestStop();
      try {
        while (!stopped) {
          const result = await runOnce();
          if (result.kind === "halted") throw new Error("journal_failed");
          // Backoff delays job polling, while heartbeat attempts retain their
          // thirty-second cadence even when the relay asks us to wait a minute.
          const waitMs = Math.min(Math.max(5_000, result.waitMs), Math.max(1, 30_000 - (now() - lastHeartbeat)));
          await wait(waitMs, stopSignal);
        }
        // runOnce can also have been started by a caller during the loop.
        await activeTick;
      } finally {
        stopSignal.removeEventListener("abort", requestStop);
        log("host_shutdown");
      }
    },
  };
}
