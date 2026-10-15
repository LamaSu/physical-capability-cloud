import type { MachineAdapter, PrintJobOptions, PrintJobResult } from "@pcc/kernel";
// The toolkit barrel starts a shop runtime at import time. Use the built leaf,
// as kernel-signer does, until the toolkit publishes a print-job subpath.
import { runPrintJob } from "../../kernel/dist/printer-job.js";
import { EvidenceEmitter } from "../../kernel/dist/evidence-emitter.js";
import { formatOperatorPrincipalId, isCompromisedDevicePublicKey, type EvidenceBundle } from "@pcc/spec";
import { getAddress, type Hex } from "viem";
import type { EvidenceBroadcaster, EvidenceBroadcastOutcome, EvidenceSubmission } from "./chain.js";
import type { HostConfig } from "./config.js";
import type { EStopDecision, GatewayClient, GwCode, GwResult, PollJobsValue, ReceiptEnvelope } from "./gateway-client.js";
import { hasPackageInputs, isUnitBinding, JOB_INPUT_CODES, type JobInputSource, type JobInputs } from "./job-inputs.js";
import { JournalError, SUBMIT_CODES, type JobJournal, type JournalCode, type JournalState, type PackageHashes } from "./journal.js";
import type { DeviceKey, OperatorKey } from "./keys.js";
import { buildMilestonePackage, computePackageBodyHash, computePackageDigest, signMilestonePackage } from "./package-builder.js";
import { makeKernelEd25519Signer } from "./kernel-signer.js";
import { derivePrinterJobName } from "./printer-job-name.js";
import { openUnitEvidenceSession, UnitSessionError, type UnitEvidenceSession } from "./unit-session.js";

const gatewayCodes = [
  "unauthenticated", "not_kernel_operator", "operator_proof_required", "job_has_no_kernel",
  "insufficient_scope", "blocked_by_policy", "forbidden", "kernel_not_found", "route_unavailable",
  "rate_limited", "bad_request", "unavailable", "server_error", "network", "timeout",
  "malformed_response", "job_not_found", "settlement_owned_status", "job_kernel_changed",
  "invalid_status", "payload_too_large", "bad_bundle", "stored_mismatch", "not_stored",
  "evidence_refused", "indeterminate", "kernel_emergency_stopped",
] as const satisfies readonly GwCode[];

/** No caller, server, document, or device text is passed to the host logger. */
export const HOST_LOG_CODES = [
  "heartbeat_ok", "poll_ok", "poll_only", "idle", "claimed", "in_progress_reported",
  "printing", "printed", "print_failed", "busy", "busy_retry_limit", "bundle_saved",
  "evidence_stored", "evidence_indeterminate", "evidence_refused", "abandoned",
  "interrupted", "simulated_refused", "no_bundle", "journal_failed", "host_shutdown",
  "reader_unavailable", "stopped", "absent", "malformed", "poll_failed", "session_failed",
  "package_built", "receipt_stored", "data_dir_locked", "receipt_exists", "receipt_signer_unavailable", "submit_attempted", "submitted", "already_committed", "conflict", "refused", "submit_indeterminate",
  "device_identity_mismatch", "compromised_device", "unit_already_used",
  ...gatewayCodes, ...JOB_INPUT_CODES, ...SUBMIT_CODES,
] as const;
export type HostLogCode = typeof HOST_LOG_CODES[number];
export type HostPrintOptions = PrintJobOptions;
export type HostIdentityCode = "device_identity_mismatch" | "compromised_device";
export class HostIdentityError extends Error {
  constructor(readonly code: HostIdentityCode) { super(code); this.name = "HostIdentityError"; }
}
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
  /** Public EOA used for the delegated evidence session. */
  operatorAddress?: string;
  /** Only the operator's package signer enters the host; the broadcaster owns its tx signer. */
  operatorKey?: Pick<OperatorKey, "address" | "signD1">;
  broadcaster?: EvidenceBroadcaster;
  print?: (options: HostPrintOptions) => Promise<PrintJobResult>;
  clock?: () => number;
  timers?: HostTimers;
  logger?: (code: HostLogCode) => void;
  /** The CLI always uses real mode; explicit false is for simulation rehearsals. */
  realMode?: boolean;
  pollOnly?: boolean;
  noSubmit?: boolean;
  stopSignal?: AbortSignal;
  timeoutMs?: number;
  cancelWindowMs?: number;
}
export interface HostTickResult {
  kind: "idle" | "blocked" | "backoff" | "job" | "halted";
  waitMs: number;
  jobId?: string;
  state?: JournalState;
  code?: "data_dir_locked" | "journal_failed" | HostIdentityCode;
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
  const sendEnabled = !deps.noSubmit && deps.realMode !== false && [config.chain.maxFeePerGasCap,
    config.chain.maxPriorityFeePerGasCap, config.chain.gasCap].every((cap) => cap !== undefined && BigInt(cap) > 0n);
  let initialized = false;
  let halted = false;
  let haltCode: NonNullable<HostTickResult["code"]> = "journal_failed";
  let parentAgentId: string | undefined;
  let identityFailure: HostIdentityCode | undefined;
  if (deps.deviceKey) {
    try {
      parentAgentId = formatOperatorPrincipalId(config.chain.chainId, deps.operatorAddress!);
      if (!deps.deviceKey.delegationParent || deps.deviceKey.delegationParent !== parentAgentId) {
        identityFailure = "device_identity_mismatch";
      }
      if (isCompromisedDevicePublicKey(deps.deviceKey.publicKeyHex)) identityFailure = "compromised_device";
    } catch { identityFailure = "device_identity_mismatch"; }
  }
  const retries = new Map<string, { failures: number; until: number }>();
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
  async function record(jobId: string, state: JournalState, code?: JournalCode, hashes?: PackageHashes | { transactionHash: string }): Promise<void> {
    await journal.append(jobId, state, code, hashes);
    log(state);
    if (code && (HOST_LOG_CODES as readonly string[]).includes(code)) log(code as HostLogCode);
  }
  async function append(state: JournalState, code?: HostGatewayCode | "busy_retry_limit" | "no_bundle"): Promise<void> {
    await record(pending!.jobId, state, code);
  }
  function skipSubmission(inputs: JobInputs): "package_inputs_missing" | "submit_disabled" | undefined {
    if (deps.noSubmit) return "submit_disabled";
    if (!hasPackageInputs(inputs)) return "package_inputs_missing";
    if (!sendEnabled || !deps.operatorKey || !deps.broadcaster || !deps.deviceKey) return "submit_disabled";
    return undefined;
  }
  function retry(jobId: string, code: HostLogCode, retryAfterS = 0): void {
    log(code);
    const failures = (retries.get(jobId)?.failures ?? 0) + 1;
    const waitMs = Math.min(60_000, Math.max(5_000 * 2 ** Math.min(failures - 1, 4), Number.isFinite(retryAfterS) ? Math.max(0, retryAfterS) * 1_000 : 0));
    retries.set(jobId, { failures, until: now() + waitMs });
  }
  function jobWait(jobId: string): number {
    return Math.max(5_000, (retries.get(jobId)?.until ?? now()) - now());
  }
  async function outcome(jobId: string, result: EvidenceBroadcastOutcome, readOnly: boolean): Promise<JournalState> {
    if (result.code === "already_committed" || result.code === "conflict" || (!readOnly && result.code === "submitted")) {
      retries.delete(jobId);
      await record(jobId, result.code);
      return result.code;
    }
    // After a durable attempt, absence cannot authorize another send. A node
    // may have accepted the transaction without mining it or returning a result.
    const state = readOnly || result.code === "indeterminate" || result.code === "rpc_unavailable"
      ? "submit_indeterminate" : "refused";
    const code = result.code === "rpc_unavailable" ? "submit_rpc_unavailable"
      : result.code === "caps_exceeded" ? "submit_caps_exceeded"
      : result.code === "refused" ? result.reason === "EvidenceNotCommitted" ? "submit_absent" : "submit_refused"
      : "submit_unknown";
    if (readOnly) {
      const previous = (await journal.read(jobId)).at(-1);
      if (previous?.state === state && previous.code === code) {
        log(state); log(code);
        return state;
      }
    }
    await record(jobId, state, code);
    return state;
  }
  function receiptBinds(value: ReceiptEnvelope, signed: NonNullable<Awaited<ReturnType<JobJournal["readPackage"]>>>): boolean {
    const unit = signed.body.unitBinding;
    return String(value.receipt.chainId) === unit.chainId
      && value.receipt.escrow.toLowerCase() === unit.escrow.toLowerCase()
      && value.receipt.settlementUnitId === unit.settlementUnitId
      && value.receipt.packageDigest === signed.packageDigest;
  }
  async function submitStored(jobId: string, inputs?: JobInputs, bundle?: EvidenceBundle): Promise<JournalState> {
    const entries = await journal.read(jobId);
    const last = entries.at(-1)!;
    // Relay evidence storage is a durable prerequisite, including on restart.
    if (!entries.some((entry) => entry.state === "evidence_stored")) throw new JournalError("journal_invalid");
    const readOnly = last.state === "submit_attempted" || last.state === "submit_indeterminate";
    let signed = await journal.readPackage(jobId);
    const builtRecord = entries.find((entry) => entry.state === "package_built");
    if ((builtRecord || readOnly) && !signed) throw new JournalError("journal_invalid");
    if (!signed) {
      if (!inputs) {
        let result;
        try { result = await deps.inputSource(jobId); }
        catch {
          retry(jobId, "job_inputs_unavailable");
          return last.state;
        }
        if (!result.ok) {
          retry(jobId, JOB_INPUT_CODES.includes(result.code) ? result.code : "job_inputs_unavailable");
          return last.state;
        }
        inputs = result.value;
      }
      const skip = skipSubmission(inputs);
      if (skip) {
        await record(jobId, "evidence_stored", skip);
        return "evidence_stored";
      }
      if (!hasPackageInputs(inputs)) throw new Error("package_inputs_missing");
      bundle ??= await journal.readBundle(jobId) as EvidenceBundle;
      try {
        if (inputs.unit.chainId !== config.chain.chainId) throw new Error("chain_mismatch");
        const { fundedAt: _fundedAt, reclaimAt: _reclaimAt, ...unit } = inputs.unit;
        const built = buildMilestonePackage(bundle, { ...unit, settlementUnitId: unit.settlementUnitId as Hex,
          challengeNonce: unit.challengeNonce as Hex, operator: deps.operatorKey!.address,
          kernelId: config.kernelId, devicePublicKey: `0x${deps.deviceKey!.publicKeyHex}` }, inputs.program);
        // The immutable builder reads only address/signD1. Its older full-key
        // type does not widen the two-field object passed by the CLI.
        signed = await signMilestonePackage(built, deps.operatorKey as OperatorKey, deps.deviceKey!);
      } catch {
        await record(jobId, "refused", "package_invalid");
        return "refused";
      }
      await journal.savePackage(jobId, signed);
    }
    let submission: EvidenceSubmission;
    try {
      const u = signed.body.unitBinding;
      if (u.chainId !== String(config.chain.chainId) || computePackageBodyHash(signed.body) !== signed.packageBodyHash
        || computePackageDigest(signed.body, signed.signatures) !== signed.packageDigest
        || signed.body.evidence.evidenceBlockHash !== signed.evidenceBlockHash
        || (builtRecord && (builtRecord.packageDigest !== signed.packageDigest || builtRecord.evidenceBlockHash !== signed.evidenceBlockHash))) {
        throw new JournalError("journal_invalid");
      }
      submission = { escrow: getAddress(u.escrow), unitId: u.settlementUnitId,
        packageDigest: signed.packageDigest, compositionSchemaVersion: Number(signed.body.compositionSchemaVersion) };
    } catch { throw new JournalError("journal_invalid"); }
    if (!builtRecord) await record(jobId, "package_built", undefined, {
      packageDigest: signed.packageDigest, evidenceBlockHash: signed.evidenceBlockHash,
    });
    if (readOnly) {
      let result: EvidenceBroadcastOutcome;
      try { result = deps.broadcaster ? await deps.broadcaster.readBack(submission) : { code: "rpc_unavailable" }; }
      catch { result = { code: "rpc_unavailable" }; }
      return outcome(jobId, result, true);
    }
    if (!sendEnabled || !deps.broadcaster) {
      log("submit_disabled");
      return entries.some((entry) => entry.state === "receipt_stored") ? "receipt_stored" : "package_built";
    }
    const storedRecord = entries.some((entry) => entry.state === "receipt_stored");
    if (storedRecord) {
      const receipt = await journal.readReceipt(jobId);
      if (!receipt || !receiptBinds(receipt, signed)) throw new JournalError("journal_invalid");
    } else {
      let result;
      try { result = await gateway.postReceipt(jobId, { body: signed.body, signatures: signed.signatures }); }
      catch { result = { ok: false as const, code: "network" as const, status: null }; }
      if (!result.ok) {
        if (result.status === 409 && result.code === "receipt_exists") {
          await record(jobId, "refused", "receipt_conflict");
          return "refused";
        }
        retry(jobId, result.code === "receipt_signer_unavailable" ? result.code : safeGwCode(result.code), result.retryAfterS);
        return "package_built";
      }
      if (!receiptBinds(result.value, signed)) {
        await record(jobId, "refused", "receipt_mismatch");
        return "refused";
      }
      // A successful POST may have survived a crash before its journal record.
      // Re-POST first; the gateway returns the same receipt for the same digest.
      const existing = await journal.readReceipt(jobId);
      if (existing) {
        if (!receiptBinds(existing, signed)) throw new JournalError("journal_invalid");
      } else await journal.saveReceipt(jobId, result.value);
      await record(jobId, "receipt_stored");
    }
    const durableReceipt = await journal.readReceipt(jobId);
    if (!durableReceipt || !receiptBinds(durableReceipt, signed)) throw new JournalError("journal_invalid");
    // The broadcaster signs first, then awaits this fsynced record immediately
    // before sendRawTransaction. Only crossing this boundary makes recovery
    // read-back-only; no preflight failure writes an attempt.
    let hookRan = false;
    let hookFailed = false;
    let result: EvidenceBroadcastOutcome;
    try {
      result = await deps.broadcaster.submit(submission, { beforeSend: async ({ transactionHash }) => {
        try { await record(jobId, "submit_attempted", undefined, { transactionHash }); }
        catch (error) { hookFailed = true; throw error; }
        hookRan = true;
      } });
    } catch (error) {
      if (hookFailed) throw error;
      result = hookRan ? { code: "indeterminate" } : { code: "rpc_unavailable" };
    }
    if (!hookRan && (result.code === "rpc_unavailable" || result.code === "caps_exceeded"
      || (result.code === "refused" && result.reason === "unreconciled_transaction"))) {
      retry(jobId, result.code === "rpc_unavailable" ? "submit_rpc_unavailable"
        : result.code === "caps_exceeded" ? "submit_caps_exceeded" : "submit_unreconciled");
      return "receipt_stored";
    }
    retries.delete(jobId);
    return outcome(jobId, result, false);
  }
  async function tick(): Promise<HostTickResult> {
    if (halted) return { kind: "halted", waitMs: 5_000, code: haltCode };
    if (identityFailure) {
      halted = true;
      haltCode = identityFailure;
      log(identityFailure);
      return { kind: "halted", waitMs: 5_000, code: identityFailure };
    }
    if (!initialized) {
      await journal.initialize();
      initialized = true;
      for (const record of await journal.list()) if (record.state === "interrupted") log("interrupted");
    }
    if (stopped) return { kind: "blocked", waitMs: 5_000 };
    await heartbeat();
    if (!deps.pollOnly) {
      // Settlement continues even if the gateway no longer lists this job.
      // Recovery never drives the printer or re-posts a relay bundle.
      const records = await journal.list();
      // A possibly pending transaction owns the operator's nonce stream.
      const recoverable = records.find((entry) => entry.state === "submit_attempted" || entry.state === "submit_indeterminate")
        ?? records.find((entry) => {
          if (entry.state !== "package_built" && entry.state !== "receipt_stored" && entry.state !== "evidence_stored") return false;
          if (!sendEnabled || !deps.broadcaster) {
            if (entry.state === "package_built" || entry.state === "receipt_stored") log("submit_disabled");
            return false;
          }
          return entry.state !== "evidence_stored" || entry.code === undefined;
        });
      if (recoverable) {
        const until = retries.get(recoverable.jobId)?.until;
        if (until !== undefined && now() < until) return { kind: "backoff", jobId: recoverable.jobId, waitMs: until - now() };
        const state = await submitStored(recoverable.jobId);
        return { kind: "job", jobId: recoverable.jobId, state, waitMs: jobWait(recoverable.jobId) };
      }
    }
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
        // The fsynced reservation consumes this funded unit even if the process
        // dies before recording or reporting the claim.
        if (!(await journal.reserveUnit(job.jobId, input.value.unit.settlementUnitId))) {
          log("unit_already_used");
          continue;
        }
        pending = { jobId: job.jobId, inputs: input.value, reported: false, reports: 0, prints: 0 };
        await append("claimed");
        break;
      }
    }
    if (!pending) { log("idle"); return { kind: "idle", waitMs: 5_000 }; }
    const jobId = pending.jobId;
    const done = (state: JournalState): HostTickResult => {
      pending = undefined;
      return { kind: "job", jobId, state, waitMs: jobWait(jobId) };
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
          parentAgentId: parentAgentId!,
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
          ...pending.inputs.unit, jobId, jobName: derivePrinterJobName(jobId),
          documentData: pending.inputs.documentData, totalPages: pending.inputs.totalPages,
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
    if (receipt.ok) {
      const skip = skipSubmission(pending.inputs);
      await record(jobId, "evidence_stored", skip);
      return done(skip ? "evidence_stored" : await submitStored(jobId, pending.inputs, bundle));
    }
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
    activeTick = tick().catch((error): HostTickResult => {
      // A partial local write must stop this process before another side effect.
      halted = true;
      haltCode = error instanceof JournalError && error.code === "data_dir_locked" ? "data_dir_locked" : "journal_failed";
      log(haltCode as HostLogCode);
      return { kind: "halted", waitMs: 5_000, code: haltCode };
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
          if (result.kind === "halted") {
            if (haltCode === "data_dir_locked") throw new JournalError("data_dir_locked");
            if (haltCode === "device_identity_mismatch" || haltCode === "compromised_device") throw new HostIdentityError(haltCode);
            throw new Error(haltCode);
          }
          // Backoff delays job polling, while heartbeat attempts retain their
          // thirty-second cadence even when the relay asks us to wait a minute.
          const waitMs = Math.min(Math.max(5_000, result.waitMs), Math.max(1, 30_000 - (now() - lastHeartbeat)));
          await wait(waitMs, stopSignal);
        }
        // runOnce can also have been started by a caller during the loop.
        await activeTick;
      } finally {
        stopSignal.removeEventListener("abort", requestStop);
        await journal.close();
        log("host_shutdown");
      }
    },
  };
}
