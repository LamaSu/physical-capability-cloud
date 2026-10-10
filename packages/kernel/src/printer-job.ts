/**
 * Print-job path — the PRINT leg of `document.print-and-mail`.
 *
 * Drives the EXISTING IPP 2D-printer adapter (`./adapters/ipp-adapter.ts`)
 * through one document print, collects the device's own evidence events, and
 * finalises a kernel-signed EvidenceBundle. Nothing here is a new adapter, a
 * new event type, or a new signing scheme — every moving part is reused:
 *
 *   - Device                 → IppAdapter (packages/kernel/src/adapters/ipp-adapter.ts)
 *   - Evidence bundling/sign  → EvidenceEmitter (packages/kernel/src/evidence-emitter.ts)
 *   - Event hashing           → hashEvent/hashBundle in @pcc/spec (canonical.ts)
 *   - Ed25519 signature       → tweetnacl `nacl.sign.detached`, byte-identical to
 *                               digital/accounting-kernel.ts + @pcc/kernel-sdk's
 *                               job-handler.ts. A bundle signed here verifies
 *                               under @pcc/kernel-sdk's `verifyBundleSignature`
 *                               and against a signing key registered via
 *                               POST /api/kernels {signingKeyAlgorithm:"ed25519"}.
 *
 * Completion vocabulary: the adapter already emits `execution_completed` — a
 * value in the FIXED EVIDENCE_EVENT_TYPES (packages/spec/src/types/evidence.ts).
 * There is no printer-specific completion type, so we use `execution_completed`
 * (same event the FDM/OctoPrint/digital kernels use). We NEVER mutate the
 * device's emitted payload before hashing it — the bundle hash must reflect what
 * the device actually said. The {jobId, pageCount, printerId} the caller usually
 * wants is surfaced as the returned `PrintCompletion` summary, derived from that
 * verbatim event (pageCount ← payload.totalPages, printerId ← source.deviceId).
 *
 * Mock mode: when the IppAdapter runs in mock mode (explicit `mockMode:true`, or
 * the optional `ipp` npm package is absent), every event carries
 * `payload.mock:true` and `source.simulated:true`, and `PrintCompletion.simulated`
 * is true. This leg fabricates NOTHING silently — a simulated print is always
 * labelled, exactly like the mail leg's `mock`→`source.simulated` convention
 * (packages/gateway/src/services/carrier-shipment-store.ts).
 *
 * Evidence binding (N106, steward #5205). A print records its own evidence and nothing
 * else, through the mechanism JobRunner uses (#502 round 3b), never a second one. A
 * listener per print could not be removed, so it went on recording later prints' events
 * (P1, and P3 after a refused start), and any execution_completed ended a print (P2):
 *   - Session: each print opens one evidence session (evidence-session.ts): the adapter
 *     object's one tap, and a lock on the printer, (kernelId, deviceId). A printer held by
 *     another print, or still quiescing after one, refuses the print as busy, before start
 *     and before registerStep.
 *   - Step lease: a print of a (jobId, stepId) already running on the emitter is refused
 *     as busy, "step" (step-lease.ts, shared with JobRunner).
 *   - Device job: start names the printer's own job (`data.jobId`). An event is bound to the
 *     print when its `payload.ippJobId` strictly equals that id: an event's payload.jobId is
 *     the PCC job's, which the emitter commits (LO-EV-9). It is bound before it is
 *     recorded, and only bound events are recorded (astra pack 192). An event that arrives
 *     before start returns (the IPP mock emits execution_started inside start) waits,
 *     unrecorded, until the id is known, and is then admitted in the order it arrived:
 *       - bound: recorded. The job's execution_completed or execution_failed ends the print;
 *       - it names another device job: something else is driving the printer. The event is
 *         never recorded; the print fails closed and finalizes nothing;
 *       - it names no device job (payload.ippJobId absent or null): it says nothing about this
 *         print, so it is excluded, with a warning. It is never recorded and never decides.
 *   - Recording: a bound event the print could not record (its hash or its addEvent failed)
 *     fails the print once its chain has settled, and nothing is finalized: the bundle would
 *     lack that event. The same rule as JobRunner's.
 *   - Quiesce, close, then finalize: once its device job has ended, the print waits, still
 *     recording, for the adapter's quiesceEvidence() (bounded), then stops accepting
 *     evidence, waits (bounded) for every bound event to be recorded, and finalizes.
 *   - Every exit quiesces (bounded) and closes the session. Device failures, contradictions,
 *     and cancel outcomes finalize signed failure evidence after settling; other failures
 *     finalize nothing. Every failed print seals its chain and detaches its step
 *     (emitter.cleanup); returned bundle events survive that detach. The step lease is
 *     released last. A printer whose hook is still pending stays quiescing until it answers.
 */

import nacl from "tweetnacl";
import type { Address, AssuranceTier, EvidenceBundle, EvidenceEvent, Signature } from "@pcc/spec";
import { EvidenceEmitter } from "./evidence-emitter.js";
import { openEvidenceSession, type EmittedEvidence } from "./evidence-session.js";
import type { JobResult } from "./job-runner.js";
import { isStepLeased, leaseStep } from "./step-lease.js";
import { IppAdapter, type IppAdapterConfig } from "./adapters/ipp-adapter.js";
import type { MachineAdapter } from "./adapters/types.js";
import { eventType, failureText } from "./failure-text.js";

// ---------------------------------------------------------------------------
// Ed25519 kernel signer (the way this repo signs any device evidence)
// ---------------------------------------------------------------------------

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * An Ed25519 signing function plus the public material needed to register and
 * verify it. The `signFn` is exactly the shape `EvidenceEmitter` expects
 * (`(bundleHash: string) => Promise<Signature>`).
 */
export interface KernelEd25519Signer {
  /** Pass to `new EvidenceEmitter(kernelId, signer.signFn)`. */
  signFn: (bundleHash: string) => Promise<Signature>;
  /** Raw 32-byte Ed25519 public key, hex (64 chars, no 0x). */
  publicKeyHex: string;
  /**
   * `"0x"+publicKeyHex` — the value to send as `signingPublicKey` on
   * POST /api/kernels (the ed25519 signing-key registration lane).
   */
  signingPublicKey: string;
  /** 64-byte tweetnacl secret key (keep private; never emit into evidence). */
  secretKey: Uint8Array;
}

/**
 * Build a kernel Ed25519 signer.
 *
 * The produced `kernelSignature` is byte-identical in construction to
 * `digital/accounting-kernel.ts` and `@pcc/kernel-sdk`'s job-handler:
 *   value  = hex( nacl.sign.detached( utf8(bundleHash), secretKey ) )
 *   signer = "0x" + publicKeyHex[..40]   (the repo's address-shaped label)
 *   algorithm = "ed25519"
 *
 * @param seed Optional 32-byte Ed25519 seed for a deterministic key (tests /
 *   reproducible kernel identity). Omit for a fresh random key.
 */
export function makeKernelEd25519Signer(seed?: Uint8Array): KernelEd25519Signer {
  const keyPair =
    seed && seed.length === 32 ? nacl.sign.keyPair.fromSeed(seed) : nacl.sign.keyPair();
  const publicKeyHex = toHex(keyPair.publicKey);
  const signer = `0x${publicKeyHex.slice(0, 40)}` as Address;

  const signFn = async (bundleHash: string): Promise<Signature> => ({
    signer,
    algorithm: "ed25519",
    value: toHex(nacl.sign.detached(new TextEncoder().encode(bundleHash), keyPair.secretKey)),
  });

  return {
    signFn,
    publicKeyHex,
    signingPublicKey: `0x${publicKeyHex}`,
    secretKey: keyPair.secretKey,
  };
}

// ---------------------------------------------------------------------------
// Print job
// ---------------------------------------------------------------------------

export interface PrintJobOptions {
  /**
   * The device to drive: an IppAdapter, or any MachineAdapter whose start names its device
   * job as `data.jobId`, and whose events of that job carry the same value, compared
   * strictly, as `payload.ippJobId` (payload.jobId is the PCC job's, LO-EV-9). Only those
   * events are recorded into the print's evidence.
   * An event that names another job is never recorded, and fails the print closed. One that
   * names no job is excluded, with a warning, and never ends the print. A start that names
   * no job fails the print.
   */
  adapter: MachineAdapter;
  /** Evidence collector; construct it with a real signFn to get real signatures. */
  emitter: EvidenceEmitter;
  /** PCC job id — correlates this print with the mail leg (courier record.jobId). */
  jobId: string;
  /** Evidence step id (defaults to jobId). */
  stepId?: string;
  /** Human-readable document name, e.g. "invoice.pdf". */
  jobName: string;
  /** Number of pages to print (mock mode paces one page ≈ 1.2s). */
  totalPages: number;
  /** Real-mode document bytes. Required for a real IPP Print-Job; ignored in mock. */
  documentData?: Buffer | string;
  /** Assurance tier for the bundle (default 0 — the printer CSD's tier-0 floor). */
  assuranceTier?: AssuranceTier;
  /** Guard timeout waiting for the device's completion event (default 120s). */
  timeoutMs?: number;
  /** Abort before start refuses the print; after start it requests cancelJob, retaining evidence. */
  signal?: AbortSignal;
  /** Wait for terminal evidence after cancelJob, before recording a kernel failure. Default 30 s. */
  cancelWindowMs?: number;
  /** Escrow settlement unit and challenge nonce: supply both, as 0x + 64 lowercase hex. */
  settlementUnitId?: string;
  challengeNonce?: string;
  /**
   * How long the print waits for the adapter's quiesceEvidence() once its device job has
   * ended, and on every failure, before it fails and finalizes nothing. Default 15 s, as
   * JobRunner's. A printer whose hook is still pending then refuses the next print as
   * "quiescing" until it resolves.
   */
  evidenceQuiesceTimeoutMs?: number;
  /**
   * How long the print waits, once it stops accepting evidence, for the events it accepted
   * to be recorded. Past that it fails: an addEvent may never settle. Default 30 s, as
   * JobRunner's.
   */
  evidenceSettleTimeoutMs?: number;
}

/**
 * Normalised completion summary. Derived from the device's verbatim
 * `execution_completed` event — NOT a second evidence event.
 */
export interface PrintCompletion {
  /** PCC job id (the one passed in) — use this to join with the mail leg. */
  jobId: string;
  /** The printer's own internal job id from the device event payload, if any. */
  printerJobId?: string | number;
  /** Pages printed (← execution_completed payload.totalPages). */
  pageCount: number;
  /** The printer device id (← source.deviceId). */
  printerId: string;
  /** True when the print was simulated (mock adapter / no reachable printer). */
  simulated: boolean;
  jobName: string;
}

/** Signed failure verdict; binding, recording or handshake failures have no verdict or bundle. */
export type PrintJobFailure =
  | { kind: "device_reported" | "contradiction"; origin: "device" }
  | { kind: "timeout" | "aborted"; origin: "device" | "kernel" };

/** A session/step refusal, or a device that refused start without accepting a job. */
export type PrintJobBusy = NonNullable<JobResult["busy"]> | { reason: "device"; adapterId: string; jobId: string };

export interface PrintJobResult {
  success: boolean;
  /** Kernel-signed evidence on success and on the failures described by `failure`. */
  bundle?: EvidenceBundle;
  /** Normalised {jobId, pageCount, printerId, simulated} completion. */
  completion?: PrintCompletion;
  /**
   * The bundle's events when a bundle exists; otherwise empty. A failed print's step is
   * detached even when it returns a bundle, so callers keep these events.
   */
  events: EvidenceEvent[];
  error?: string;
  failure?: PrintJobFailure;
  /**
   * Present on every result whose cancelJob path ran, including an eventless failure.
   * A completion that wins after cancel is ordinary success with this field retained.
   * Absent when no cancel was sent, including adapters without cancelJob.
   */
  cancelRequested?: "timeout" | "aborted";
  /**
   * Set when the print was refused before it started. Session and step refusals send no
   * command and register no step; a device refusal follows start and detaches its step.
   * Nothing is recorded, so a caller should queue or retry rather than count a device failure.
   *   - "adapter": the printer of adapter `adapterId` is recording job `jobId`'s evidence;
   *   - "quiescing": that adapter has not yet confirmed, through its quiesceEvidence(),
   *     that job `jobId`'s work is done, so what it emits now could still be that job's;
   *   - "step": this print's (jobId, stepId) is already running on this evidence emitter.
   *   - "device": the device refused start as busy and accepted no job; its step is detached.
   */
  busy?: PrintJobBusy;
  durationMs: number;
}

/**
 * Run one print job through a machine adapter and return a kernel-signed bundle.
 *
 * Event-driven: it waits for the device's own `execution_completed` (or
 * `execution_failed`) for this print's device job rather than fabricating a completion.
 * A success bundle requires completion without failure. Device failures and contradictions
 * also return signed bundles. Timeout or abort sends cancelJob once, keeps admitting evidence,
 * and signs a kernel failure only if no terminal evidence arrives within cancelWindowMs.
 * Completion after cancel is success carrying cancelRequested; every cancel result carries it.
 * The evidence binding (session, step lease, device job, recording, quiesce) is described at
 * the top of this file.
 */
export async function runPrintJob(opts: PrintJobOptions): Promise<PrintJobResult> {
  // It always resolves with a result, never rejects, whatever a collaborator throws: the caller's
  // options included, and the cleanup's own releases (astra packs 210 and 213, steward #5604).
  const startTime = Date.now();
  const cancellation: { requested?: "timeout" | "aborted"; error?: string } = {};
  try {
    return await printOnce(opts, startTime, cancellation);
  } catch (err) {
    return {
      success: false, events: [],
      error: [failureText(err), cancellation.error].filter(Boolean).join("; "),
      ...(cancellation.requested ? { cancelRequested: cancellation.requested } : {}),
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * A timer's delay in milliseconds: a number from 0 to 2^31 - 1 (so not NaN, nor infinite). Node
 * fires a longer one after 1 ms, and converting a value that is not a number can throw (astra
 * pack 216).
 */
function isTimerDelay(ms: unknown): ms is number {
  return typeof ms === "number" && ms >= 0 && ms <= 2_147_483_647;
}

/** One release of a print's cleanup: attempted, and logged if it throws, so the next is attempted too (astra pack 213). */
function release(jobId: string, what: string, step: () => void): void {
  try {
    step();
  } catch (err) {
    console.error(`[printer-job] print ${jobId}: ${what} failed: ${failureText(err)}`);
  }
}

async function printOnce(
  opts: PrintJobOptions,
  startTime: number,
  cancellation: { requested?: "timeout" | "aborted"; error?: string },
): Promise<PrintJobResult> {
  const {
    adapter,
    emitter,
    jobId,
    stepId = jobId,
    jobName,
    totalPages,
    documentData,
    assuranceTier = 0,
    timeoutMs = 120_000,
    signal,
    cancelWindowMs = 30_000,
    settlementUnitId,
    challengeNonce,
    evidenceQuiesceTimeoutMs = 15_000,
    evidenceSettleTimeoutMs = 30_000,
  } = opts;

  // Fail-closed results: no bundle, no events. Signed verdicts are returned only after finalization.
  const failure = (error: string, busy?: PrintJobResult["busy"]): PrintJobResult => ({
    success: false,
    events: [],
    error: [error, cancellation.error].filter(Boolean).join("; "),
    ...(cancellation.requested ? { cancelRequested: cancellation.requested } : {}),
    ...(busy ? { busy } : {}),
    durationMs: Date.now() - startTime,
  });
  // The ids key the step and its lease and name the print in every log line, the cleanup's
  // included: ids that are not text could throw from any of those, so they are refused before
  // anything is held (astra pack 213, as in JobRunner).
  if (typeof jobId !== "string" || typeof stepId !== "string") return failure("the print's job id and step id must be text");
  // Each timeout arms a timer, and a delay that cannot be one could make settle() reject in the
  // final release, after the step was registered: refused before anything is held (astra pack 216).
  for (const [name, ms] of [["timeoutMs", timeoutMs], ["evidenceQuiesceTimeoutMs", evidenceQuiesceTimeoutMs], ["evidenceSettleTimeoutMs", evidenceSettleTimeoutMs], ["cancelWindowMs", cancelWindowMs]] as const) {
    if (!isTimerDelay(ms)) return failure(`the print's ${name} must be a number of milliseconds from 0 to 2147483647`);
  }
  if ((settlementUnitId === undefined) !== (challengeNonce === undefined)) {
    return failure("the print's settlementUnitId and challengeNonce must be supplied together");
  }
  if (signal?.aborted) return failure(`print job ${jobId} aborted before start`);

  // Every refusal below comes before the start command, and before registerStep, which
  // would overwrite the step of a print already running under the same ids. The checks,
  // the session's claim and the step lease are one synchronous block, as in JobRunner.

  // Fail closed: without its quiesceEvidence() an adapter cannot say when a print's
  // evidence is complete (adapters/types.ts). An adapter that throws while it is checked, or
  // while the session opens (its onEvidence), fails the print with a result, never a
  // rejection: nothing is held yet (astra pack 210, as in JobRunner).
  try {
    if (typeof (adapter as { quiesceEvidence?: unknown }).quiesceEvidence !== "function") {
      return failure(`adapter ${adapter.id} has no quiesceEvidence(), so its evidence cannot be bound to a print`);
    }
  } catch (err) {
    return failure(`the print's adapter could not be checked: ${failureText(err)}`);
  }
  if (isStepLeased(emitter, jobId, stepId)) {
    return failure(`step ${stepId} of job ${jobId} is already running`, { reason: "step", jobId, stepId });
  }

  // Each event bound to the print's device job is recorded on one chain, in the order it
  // arrived, and the bundle waits for the chain. Set when the print fails, so an event still
  // queued is never written.
  let recorded: Promise<void> = Promise.resolve();
  let sealed = false;
  // The first event the print bound but could not record (its hash or its write failed). Its
  // chain then lacks that event, so once the chain has settled the print fails: success would
  // sign an incomplete record (astra pack 192). As JobRunner's.
  const unrecorded: { first: { type: string; error: string } | null } = { first: null };

  // This print's device job, and what the printer reported about it in the window. The id
  // is known once start returns it; what arrives before (inside start) waits in `early`,
  // unrecorded, and is admitted in the order it arrived once the id is known.
  const deviceJob: {
    id?: string | number;
    early: EmittedEvidence[];
    completed: EmittedEvidence | null;
    failed: EmittedEvidence | null;
    /** The first event that named another device job. */
    foreign: EmittedEvidence | null;
    /** totalPages from the job's latest execution_progress. */
    pages: number;
  } = { early: [], completed: null, failed: null, foreign: null, pages: totalPages };
  let decide!: () => void;
  // Resolves once the print's outcome is known: its device job ended, or another one showed.
  const decided = new Promise<void>((resolve) => {
    decide = resolve;
  });

  /** Record an event bound to the print's device job, on the chain. */
  const record = (event: EmittedEvidence): void => {
    // NEVER mutate device evidence — the bundle hash must reflect what the device said.
    // Store it as-is.
    recorded = recorded.then(async () => {
      if (sealed) return;
      try {
        await emitter.addEvent(jobId, stepId, event);
      } catch (err) {
        unrecorded.first ??= { type: eventType(event), error: failureText(err) };
        console.error(err);
      }
    });
  };

  /**
   * Admit an event of the window once the print's device job id is known. It is bound before
   * it is recorded: only an event whose payload.ippJobId strictly equals the id is recorded, and
   * only such an event can end the print (astra pack 192).
   */
  const admit = (event: EmittedEvidence): void => {
    const named = (event.payload as Record<string, unknown> | undefined)?.ippJobId;
    if (named === undefined || named === null) {
      // It names no device job, so it says nothing about this print: excluded, never recorded
      // and never deciding. Failing the print on it would fail every print on a printer that
      // emits device-level events. Not the payload: it is device evidence, not a log line.
      console.warn(
        `[printer-job] print ${jobId} excluded an event that names no device job (${event.type}, from adapter ${adapter.id}): ` +
          `it cannot be bound to device job ${String(deviceJob.id)}`,
      );
      return;
    }
    if (named !== deviceJob.id) {
      // Another device job in this print's window: something else is driving the printer.
      // Never recorded: the print fails closed.
      deviceJob.foreign ??= event;
      decide();
      return;
    }
    record(event);
    if (event.type === "execution_progress") {
      const tp = (event.payload as Record<string, unknown> | undefined)?.totalPages;
      if (typeof tp === "number") deviceJob.pages = tp;
    } else if (event.type === "execution_completed") {
      deviceJob.completed ??= event;
      decide();
    } else if (event.type === "execution_failed") {
      deviceJob.failed ??= event;
      decide();
    }
  };

  /** Why the print cannot be bound, once an event of another device job has shown. */
  const foreignJob = (): string | null => {
    const event = deviceJob.foreign;
    if (event === null) return null;
    const named = (event.payload as Record<string, unknown> | undefined)?.ippJobId;
    return (
      `the printer reported device job ${String(named)} (${event.type}) while print ${jobId} was its ` +
      `device job ${String(deviceJob.id)}: something else is driving the printer, so this print's evidence cannot be bound to it`
    );
  };

  // This print's evidence window: events reach the print only while it is open. A listener
  // per print could not be removed, so it went on recording later and overlapping prints'
  // events into this print's step (P1, P3). Nothing is recorded here: an event waits until
  // the device job is known, and is then admitted (bound, and recorded only if it is bound).
  let opened: ReturnType<typeof openEvidenceSession>;
  try {
    opened = openEvidenceSession([adapter], { jobId, stepId }, (event) => {
      if (deviceJob.id === undefined) deviceJob.early.push(event);
      else admit(event);
    });
  } catch (err) {
    return failure(`the print's evidence session could not open: ${failureText(err)}`);
  }
  if (!opened.ok) {
    const { reason, adapterId, jobId: holder } = opened.busy;
    return failure(
      reason === "adapter" ? `adapter ${adapterId} is in use by job ${holder}` : `adapter ${adapterId} is still quiescing after job ${holder}`,
      { reason, adapterId, jobId: holder },
    );
  }
  const session = opened.session;
  const releaseStep = leaseStep(emitter, jobId, stepId);
  try {
    emitter.registerStep(jobId, stepId, assuranceTier,
      settlementUnitId !== undefined && challengeNonce !== undefined ? { settlementUnitId, challengeNonce } : undefined);
  } catch (err) {
    // Nothing was sent to the printer: release what this print took, and fail with a result. Each
    // release is attempted even if another throws, and the lease is always released (astra pack
    // 213).
    release(jobId, "closing the evidence session", () => session.close());
    release(jobId, "detaching the step", () => emitter.cleanup(jobId, stepId));
    releaseStep();
    return failure(`the print's step could not be registered: ${failureText(err)}`);
  }

  // Wait for the chain, but not forever: an addEvent may never settle.
  // Resolves false when the timeout comes first.
  const settle = async (): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), evidenceSettleTimeoutMs);
    });
    try {
      return await Promise.race([recorded.then(() => true), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  let succeeded = false;
  let settleTimedOut = false;
  // Set once the print has asked its adapter to quiesce (after its device job ended, or in the finally).
  let quiesceAsked = false;
  let abortListenerAttached = false;
  let notifyAbort!: () => void;
  const aborted = new Promise<"aborted">((resolve) => {
    notifyAbort = () => resolve("aborted");
  });
  // Identity, not a device-controlled payload field, distinguishes our synthetic event.
  let kernelFailure: EmittedEvidence | null = null;

  const print = async (): Promise<PrintJobResult> => {
    if (signal) {
      // Mark first so even a collaborator throwing while installing the listener gets a removal attempt.
      abortListenerAttached = true;
      signal.addEventListener("abort", notifyAbort, { once: true });
      if (signal.aborted) return failure(`print job ${jobId} aborted before start`);
    }
    // Kick off the print. Mock mode uses {jobName, totalPages}; real IPP mode also
    // needs documentData (the adapter fails start() without it — we surface that
    // honestly rather than pretending a print happened).
    const startResult = await adapter.execute({
      type: "start",
      payload: {
        jobName,
        totalPages,
        ...(documentData !== undefined ? { documentData } : {}),
      },
    });
    if (!startResult.success) {
      return failure(startResult.message ?? "print start failed",
        startResult.busy === true ? { reason: "device", adapterId: adapter.id, jobId } : undefined);
    }

    // The printer's own id for this print's job. Without it no event can be bound to the
    // print, so it fails closed.
    const id = startResult.data?.jobId;
    if (typeof id !== "string" && typeof id !== "number") {
      return failure(`the printer accepted print ${jobId} but named no device job (data.jobId), so its evidence cannot be bound to it`);
    }
    deviceJob.id = id;
    for (const event of deviceJob.early.splice(0)) admit(event);

    // Wait for the device job's own terminal event, or another job's event. No polling —
    // the adapter drives it.
    let requested: "timeout" | "aborted" | "terminal";
    if (signal?.aborted) {
      // An abort during execute waits for its result and cancels the job it actually accepted.
      requested = "aborted";
    } else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
        (timer as unknown as { unref?: () => void })?.unref?.();
      });
      try {
        requested = await Promise.race([decided.then(() => "terminal" as const), timedOut, aborted]);
      } finally {
        clearTimeout(timer);
      }
    }
    if (requested !== "terminal") {
      const reason = requested;
      const error = reason === "timeout" ? `print job ${jobId} timed out after ${timeoutMs}ms` : `print job ${jobId} aborted`;
      const cancelJob = adapter.cancelJob;
      if (typeof cancelJob !== "function") {
        return failure(`${error}; adapter ${adapter.id} cannot cancel: it has no cancelJob()`);
      }
      cancellation.requested = reason;
      let cancelTimer: ReturnType<typeof setTimeout> | undefined;
      const cancelExpired = new Promise<void>((resolve) => {
        cancelTimer = setTimeout(resolve, cancelWindowMs);
        (cancelTimer as unknown as { unref?: () => void })?.unref?.();
      });
      try {
        // A rejected (or pending) cancel does not end the evidence wait: the printer can still report.
        const cancelFailed = (err: unknown): void => {
          cancellation.error = `cancelJob failed: ${failureText(err)}`;
        };
        try {
          void Promise.resolve(cancelJob.call(adapter, id)).catch(cancelFailed);
        } catch (err) {
          cancelFailed(err);
        }
        await Promise.race([decided, cancelExpired]);
        if (deviceJob.completed === null && deviceJob.failed === null && deviceJob.foreign === null) {
          kernelFailure = {
            type: "execution_failed",
            timestamp: new Date().toISOString(),
            source: { ...adapter.source },
            payload: { ippJobId: id, reason, origin: "kernel" },
          };
          // The same binding and recording chain commits jobId and the settlement unit.
          admit(kernelFailure);
        }
      } finally {
        clearTimeout(cancelTimer);
      }
    }
    const foreignBefore = foreignJob();
    if (foreignBefore !== null) return failure(foreignBefore);

    // Wait, still recording, until the adapter confirms (quiesceEvidence) that it has emitted
    // every event of the work it was given: the terminal event does not prove it is done (a
    // poll loop may still report). Bounded: no answer in time fails the print, and nothing is
    // finalized; the printer stays quiescing until the hook answers.
    quiesceAsked = true;
    if (!(await session.quiesce(evidenceQuiesceTimeoutMs))) {
      return failure(`evidence did not quiesce within ${evidenceQuiesceTimeoutMs} ms`);
    }

    // Then stop accepting evidence, so what the window holds is final. An event emitted
    // from here on is dropped, with a warning.
    session.close();
    const foreign = foreignJob();
    if (foreign !== null) return failure(foreign);
    if (!(await settle())) {
      settleTimedOut = true;
      return failure(`evidence recording did not settle within ${evidenceSettleTimeoutMs} ms`);
    }
    // The chain has settled. A bound event it could not record is missing from it, so the
    // print fails and nothing is finalized.
    const lost = unrecorded.first;
    if (lost !== null) {
      return failure(`a ${lost.type} event of this job could not be recorded (${lost.error}), so its evidence is incomplete`);
    }
    const completed = deviceJob.completed;
    const failed = deviceJob.failed;
    if (completed === null && failed === null) return failure("the printer reported no terminal event for this job");

    // Finalise + sign — the one and only signing step, identical to every other device
    // bundle in the kernel: hashBundle(events) → signFn → kernelSignature. The chain is
    // closed and settled, so the step cannot change while the bundle is hashed and signed.
    const bundle = await emitter.finalizeBundle(jobId, stepId);

    if (failed !== null) {
      const verdict: PrintJobFailure = completed !== null
        ? { kind: "contradiction", origin: "device" }
        : cancellation.requested
          ? { kind: cancellation.requested, origin: failed === kernelFailure ? "kernel" : "device" }
          : { kind: "device_reported", origin: "device" };
      const error = completed !== null
        ? `printer reported both completion and failure for device job ${String(id)}`
        : cancellation.requested === "timeout"
          ? `print job ${jobId} timed out after ${timeoutMs}ms`
          : cancellation.requested === "aborted"
            ? `print job ${jobId} aborted`
            : `printer reported failure: ${JSON.stringify(failed.payload ?? {})}`;
      return {
        ...failure(error), bundle, events: bundle.events, failure: verdict,
      };
    }
    // No failure, and the terminal check above ensures this device job completed.
    if (completed === null) return failure("the printer reported no completion for this job");

    const cp: Record<string, unknown> = (completed.payload as Record<string, unknown> | undefined) ?? {};
    const pageCount =
      typeof cp.totalPages === "number"
        ? cp.totalPages
        : typeof cp.pageCount === "number"
          ? cp.pageCount
          : deviceJob.pages;
    const printerId = completed.source.deviceId ?? adapter.source.deviceId;
    const simulated = completed.source.simulated === true || cp.mock === true || adapter.source.simulated === true;

    const completion: PrintCompletion = {
      jobId,
      // The printer's own job number: the IPP adapter reports it as ippJobId,
      // since payload.jobId is reserved for the PCC job (LO-EV-9).
      printerJobId:
        typeof cp.ippJobId === "string" || typeof cp.ippJobId === "number"
          ? (cp.ippJobId as string | number)
          : undefined,
      pageCount,
      printerId,
      simulated,
      jobName,
    };

    return {
      success: true,
      bundle,
      completion,
      events: bundle.events,
      ...(cancellation.requested ? { cancelRequested: cancellation.requested } : {}),
      ...(cancellation.error ? { error: cancellation.error } : {}),
      durationMs: Date.now() - startTime,
    };
  };

  try {
    const result = await print();
    succeeded = result.success;
    return result;
  } catch (err) {
    return failure(failureText(err));
  } finally {
    if (abortListenerAttached) {
      release(jobId, "removing the abort listener", () => signal!.removeEventListener("abort", notifyAbort));
    }
    // Every exit quiesces before it releases, as in JobRunner. A print that ended before its
    // device job did (a refused or failed start, a timeout, another job's event) waits,
    // bounded, for the adapter's word that its work is done; events of its device job that
    // arrive meanwhile still reach this print's (soon detached) step. A hook still pending at
    // the bound keeps the printer quiescing until it resolves.
    if (!quiesceAsked) {
      quiesceAsked = true;
      try {
        await session.quiesce(evidenceQuiesceTimeoutMs);
      } catch (err) {
        console.error(`[printer-job] print ${jobId}: the printer could not confirm its evidence is complete:`, err);
      }
    }
    // Every exit closes the window. A failed print also seals the chain, so an event still
    // queued is never written; waits, bounded, for the addEvent in flight; and then detaches
    // its step (cleanup), so getEvents() for it is empty from then on. An addEvent still
    // running at that bound appends to the detached record, which nothing reads.
    // Each release is attempted even if another throws, and the lease is always released
    // (astra pack 213). The step is detached even if settle() rejects (astra pack 216).
    try {
      release(jobId, "closing the evidence session", () => session.close());
      if (!succeeded) {
        sealed = true;
        try {
          if (!settleTimedOut) await settle();
        } finally {
          release(jobId, "detaching the step", () => emitter.cleanup(jobId, stepId));
        }
      }
    } finally {
      // Released last, so a later print of this step registers a fresh record.
      releaseStep();
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience: turnkey IPP print kernel
// ---------------------------------------------------------------------------

export interface IppPrintKernelOptions {
  /** Kernel id used on evidence sources + the bundle. */
  kernelId: string;
  /** Device id for the printer (becomes source.deviceId / printerId). */
  deviceId: string;
  /** IPP printer URI (default ipp://localhost:631/ipp/print). */
  uri?: string;
  /**
   * Mock mode. Defaults to true (safe — no reachable printer required), mirroring
   * the adapter-factory `buildIpp` default. Set false only with the optional
   * `ipp` npm package installed AND a reachable printer.
   */
  mockMode?: boolean;
  /** Deterministic 32-byte Ed25519 seed for the kernel signing key. */
  seed?: Uint8Array;
  /** Bring your own signer (overrides `seed`). */
  signer?: KernelEd25519Signer;
  /** Extra IppAdapter config passthrough. */
  adapterConfig?: Partial<IppAdapterConfig>;
}

export interface IppPrintKernel {
  adapter: IppAdapter;
  emitter: EvidenceEmitter;
  signer: KernelEd25519Signer;
  /** Run one print job. While another print holds the printer, a print is refused as busy. */
  print(job: Omit<PrintJobOptions, "adapter" | "emitter">): Promise<PrintJobResult>;
  /** Release adapter timers/listeners. */
  dispose(): Promise<void>;
}

/**
 * Wire the EXISTING IppAdapter + EvidenceEmitter + an Ed25519 kernel signer into
 * a ready-to-run print kernel. This is the turnkey entry point used by the
 * onboarding/e2e script and the tests.
 */
export function createIppPrintKernel(opts: IppPrintKernelOptions): IppPrintKernel {
  const signer = opts.signer ?? makeKernelEd25519Signer(opts.seed);
  const mockMode = opts.mockMode ?? true;

  const adapter = new IppAdapter(opts.deviceId, {
    uri: opts.uri ?? "ipp://localhost:631/ipp/print",
    kernelId: opts.kernelId,
    mockMode,
    ...opts.adapterConfig,
  });

  const emitter = new EvidenceEmitter(opts.kernelId, signer.signFn);

  return {
    adapter,
    emitter,
    signer,
    print: (job) => runPrintJob({ ...job, adapter, emitter }),
    dispose: () => adapter.dispose(),
  };
}
