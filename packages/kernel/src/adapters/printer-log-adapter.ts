/**
 * PrinterLogAdapter — SensorAdapter that monitors a printer's job log
 * and produces a tamper-evident hash-chained evidence stream.
 *
 * Each poll cycle:
 *   1. Calls logProvider(jobId) to fetch the next log line.
 *   2. Feeds the line into LogCaptureService.captureEntry() which hash-chains
 *      and kernel-signs it.
 *   3. Emits a `log_hash_chain_entry` evidence event for downstream consumers.
 *
 * On stopRecording():
 *   - Stops polling.
 *   - Resets the LogCaptureService chain so the service is ready for a new job.
 *   - Returns a `printer_job_verified` summary evidence event with chain stats.
 *
 * Start, stop and dispose form one serialized lifecycle: see Lifecycle below.
 *
 * Log providers are swappable:
 *   - Default: generates simulated printer log lines (useful in tests / CI).
 *   - Real: pass a `logProvider` in config that reads from CUPS / IPP spool / OS.
 */

import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";
import type { SensorAdapter } from "./types.js";
import { OutstandingWork } from "./outstanding-work.js";
import type { LogCaptureService } from "../log-capture-service.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LogProvider = (jobId: string) => Promise<string | null>;

export interface PrinterLogAdapterConfig {
  /** Source URI reported in log entries, e.g. "cups://job-123" */
  logSource?: string;
  /** Milliseconds between log polls */
  pollIntervalMs?: number;
  /**
   * Async function that returns the next log line for a job, or null when
   * there is nothing new to capture.  Defaults to the simulated log provider.
   */
  logProvider?: LogProvider;
}

// ---------------------------------------------------------------------------
// Simulated log provider
// ---------------------------------------------------------------------------

/** Generates a deterministic but realistic sequence of printer log lines. */
function makeSimulatedLogProvider(): LogProvider {
  const scriptByJob: Map<string, string[]> = new Map();

  return async (jobId: string): Promise<string | null> => {
    if (!scriptByJob.has(jobId)) {
      const ts = new Date().toISOString();
      scriptByJob.set(jobId, [
        `[${ts}] Job started: pages=1 printer=default job=${jobId}`,
        `[${new Date().toISOString()}] Page 1 rendered: format=Letter dpi=600`,
        `[${new Date().toISOString()}] Page 1 printed: status=ok`,
        `[${new Date().toISOString()}] Job completed: status=ok job=${jobId}`,
      ]);
    }

    const lines = scriptByJob.get(jobId)!;
    if (lines.length === 0) {
      return null;
    }
    // Shift returns undefined when empty but we guard above
    return lines.shift() ?? null;
  };
}

// ---------------------------------------------------------------------------
// PrinterLogAdapter
// ---------------------------------------------------------------------------

/**
 * Where the adapter's recording is (astra pack 196). One state at a time:
 *
 *   idle        No recording: none was started, its start failed, or its stop succeeded.
 *   starting    startRecording's first poll is in flight.
 *   recording   The first poll succeeded, and the timer polls the log, one poll at a time.
 *   stopping    A stop is in flight, from the moment it is accepted, including a stop
 *               accepted while starting, which first waits for the start to settle.
 *   stopFailed  A stop failed and emitted no summary. Nothing polls. A retried stop can
 *               still emit the job's last entry and its summary, unless a timer poll
 *               failed: then the retry refuses too.
 *   disposed    Final: nothing leaves it.
 *
 * Transitions. Each is single-flight, so one recording's polls and summary never overlap
 * another's:
 *   startRecording(jobId)
 *     idle, stopFailed     -> starting: a new recording. The chain, the counters and the
 *                             failed-poll latch are reset; a stopFailed recording is
 *                             discarded unsummarized. The start, its first poll included, is
 *                             outstanding work until it settles. Then:
 *                               first poll succeeds -> recording: the timer is installed;
 *                               first poll fails    -> idle: startRecording rejects with its error.
 *     starting, same job   -> that start: the same promise.
 *     recording, same job  -> resolves at once: idempotent.
 *     starting or recording another job -> refused: the adapter is busy with a job.
 *     stopping             -> refused, not queued (why below).
 *     disposed             -> refused.
 *   stopRecording()
 *     stopping             -> that stop.
 *     starting             -> stopping: the stop waits for the start to settle. If the
 *                             first poll succeeded, the start installs no timer and the stop
 *                             goes on as from recording; if it failed, the stop refuses
 *                             ("no recording to stop") and the state is idle.
 *     recording, stopFailed -> stopping: it waits for the timer's poll in flight, checks the
 *                             latch, makes the final poll and emits the summary -> idle; or
 *                             fails, emitting no summary -> stopFailed.
 *     idle                 -> refused: there is no summary without a recording.
 *     disposed             -> refused.
 *   dispose()
 *     any state            -> disposed. The timer and the listeners are cleared, and the
 *                             recording's own work ends. A start, poll or stop still in
 *                             flight stays outstanding work until it settles. Each sees
 *                             disposed when it resumes: a poll captures and emits nothing, a
 *                             start installs no timer and rejects, and a stop makes no final
 *                             poll, emits no summary and rejects.
 *
 * A start while a stop is in flight is refused rather than made to wait for the stop:
 *   - JobRunner never makes one: a device is free for a new job only once its adapter's
 *     quiesceEvidence() has resolved (evidence-session.ts), and a stop in flight is this
 *     adapter's outstanding work. Its own calls (start at step 2, stop at step 6, and the
 *     stop its failure path retries) never overlap on one adapter;
 *   - a start that waited would discard a recording whose stop failed, which a retried stop
 *     could still summarize;
 *   - a stop waits on the log source for as long as its final poll takes, and a waiting
 *     start would hang with it.
 */
type Lifecycle = "idle" | "starting" | "recording" | "stopping" | "stopFailed" | "disposed";

export class PrinterLogAdapter implements SensorAdapter {
  readonly id: string;
  /** Use "power_monitor" as the closest existing SensorAdapter type. */
  readonly type = "power_monitor" as const;
  readonly source: EvidenceSource;

  private readonly logCaptureService: LogCaptureService;
  private readonly logSource: string;
  private readonly pollIntervalMs: number;
  private readonly logProvider: LogProvider;

  /** Where the recording is: see Lifecycle. */
  private state: Lifecycle = "idle";
  /** The job being recorded, from its start until its stop emits the summary or its first poll fails. */
  private jobId: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];
  private chainLength = 0;
  private latestEntryHash: string | null = null;
  /**
   * What can still emit, for quiesceEvidence(): a start in flight, its first poll included;
   * the recording, from its first poll's success until its stop has emitted the summary or
   * failed, or dispose; each timer poll in flight; and each stop in flight.
   */
  private readonly work = new OutstandingWork();
  /** Ends the recording's own piece of `work`. */
  private endRecording: (() => void) | null = null;
  /** Polls the timer started that have not finished: stopRecording waits for them. At most one. */
  private readonly polls = new Set<Promise<void>>();
  /** The first timer poll of this recording that failed: its chain may lack lines. */
  private pollFailure: string | null = null;
  /** The start in flight: a start of the same job meanwhile is the same start, and a stop waits for it. */
  private starting: Promise<void> | null = null;
  /** The stop in flight: a second stop meanwhile is the same stop. */
  private stopping: Promise<Omit<EvidenceEvent, "id" | "hash">> | null = null;

  /** True when no logProvider was supplied and the simulated script is used. */
  private readonly usingSimulatedProvider: boolean;

  constructor(
    id: string,
    kernelId: string,
    logCaptureService: LogCaptureService,
    config?: PrinterLogAdapterConfig,
  ) {
    this.id = id;
    this.logCaptureService = logCaptureService;
    this.logSource = config?.logSource ?? `cups://${id}`;
    this.pollIntervalMs = config?.pollIntervalMs ?? 1000;
    this.usingSimulatedProvider = !config?.logProvider;
    this.logProvider = config?.logProvider ?? makeSimulatedLogProvider();

    if (this.usingSimulatedProvider) {
      // Surface the default loudly: without an explicit logProvider this
      // adapter emits a hash-chained "printer job" evidence stream from a
      // 4-line SIMULATED script. Tagged below so it can never pass as real.
      console.warn(
        `[printer-log-adapter] device "${id}" constructed WITHOUT a logProvider — using the ` +
          `simulated log script. All log_hash_chain_entry / printer_job_verified evidence will ` +
          `be simulation (payload.mock:true, source.simulated:true). Pass config.logProvider ` +
          `to capture real printer logs.`,
      );
    }

    this.source = {
      deviceId: id,
      deviceType: "controller",
      kernelId,
      firmwareVersion: "PrinterLogAdapter-1.0.0",
      // Honesty marker: simulated default provider => simulation evidence.
      ...(this.usingSimulatedProvider ? { simulated: true } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // SensorAdapter implementation
  // ---------------------------------------------------------------------------

  /**
   * Start polling the log provider and emitting hash-chained evidence events for `jobId`.
   * Resolves once the first poll has succeeded. Refused, starting nothing, while a stop is in
   * flight, while another job is starting or recording, and after dispose (see Lifecycle).
   */
  startRecording(jobId: string): Promise<void> {
    if (this.state === "disposed") {
      return Promise.reject(new Error(`[printer-log-adapter] ${this.id}: disposed, so job ${jobId} cannot start`));
    }
    if (this.state === "stopping") {
      return Promise.reject(new Error(`[printer-log-adapter] ${this.id}: a stop is in flight, so job ${jobId} cannot start`));
    }
    if (this.state === "starting" || this.state === "recording") {
      if (jobId !== this.jobId) {
        return Promise.reject(
          new Error(`[printer-log-adapter] ${this.id}: busy with job ${this.jobId ?? "unknown"}, so job ${jobId} cannot start`),
        );
      }
      return this.starting ?? Promise.resolve(); // the same job: idempotent
    }
    // idle or stopFailed: a new recording, outstanding work until the start settles.
    const start = this.work.track(this.startOnce(jobId));
    this.starting = start;
    const clear = () => {
      if (this.starting === start) this.starting = null;
    };
    start.then(clear, clear);
    return start;
  }

  private async startOnce(jobId: string): Promise<void> {
    this.state = "starting";
    this.jobId = jobId;
    this.pollFailure = null;
    this.chainLength = 0;
    this.latestEntryHash = null;

    // Reset the chain so each job starts fresh
    this.logCaptureService.reset();

    // Poll immediately, then on interval. A first poll that fails starts nothing (astra
    // pack 186); a stop that waited for it refuses, and leaves the state idle itself.
    try {
      await this.poll(jobId);
    } catch (err) {
      if (this.now() === "starting") {
        this.state = "idle";
        this.jobId = null;
      }
      throw err;
    }
    // Disposed while the first poll was in flight: nothing is installed (astra pack 196).
    if (this.now() === "disposed") {
      throw new Error(`[printer-log-adapter] ${this.id}: disposed while job ${jobId} was starting`);
    }
    // A stop accepted while starting takes over now: it stops this recording, so no timer.
    if (this.now() === "stopping") return;

    this.state = "recording";
    this.endRecording = this.work.begin();
    this.pollTimer = setInterval(() => {
      // One poll at a time: a tick that finds one in flight is skipped, so a slow poll is
      // never overtaken and the chain keeps the log's order (astra pack 190).
      if (this.polls.size > 0) return;
      const poll = this.poll(jobId).catch((err: unknown) => {
        // The chain may now lack the lines this poll would have read: latched, so the
        // stop refuses to vouch for it (astra pack 190).
        this.pollFailure ??= err instanceof Error ? err.message : String(err);
      });
      this.polls.add(poll);
      void this.work.track(poll).then(() => this.polls.delete(poll));
    }, this.pollIntervalMs);
  }

  /**
   * Stop polling, finalize the chain, and return a summary evidence event.
   * The summary event type is `printer_job_verified`.
   *
   * Refused, emitting nothing, with no recording to stop (none started, its start failed, or
   * its stop already succeeded), and after dispose: a summary needs a recording (astra pack
   * 190). A stop while the recording is starting waits for the start to settle, its first
   * poll included, then stops the recording, or refuses if the start failed (astra pack 196).
   * Single-flight: a stop while one is in flight is that stop. Each stop is the adapter's
   * outstanding work, so quiesceEvidence() waits for one in flight, including a retry after a
   * failed stop, which still emits the job's last entry and its summary.
   */
  stopRecording(): Promise<Omit<EvidenceEvent, "id" | "hash">> {
    if (this.stopping !== null) return this.stopping;
    let stopped: Promise<Omit<EvidenceEvent, "id" | "hash">>;
    if (this.state === "starting" && this.starting !== null) {
      const start = this.starting;
      this.state = "stopping";
      stopped = this.stopAfterStart(start);
    } else if (this.state === "recording" || this.state === "stopFailed") {
      this.state = "stopping";
      stopped = this.stopOnce();
    } else {
      return Promise.reject(
        new Error(
          this.state === "disposed"
            ? `[printer-log-adapter] ${this.id}: disposed, so there is no recording to stop`
            : `[printer-log-adapter] ${this.id}: no recording to stop`,
        ),
      );
    }
    const stop = this.work.track(stopped);
    this.stopping = stop;
    const clear = () => {
      if (this.stopping === stop) this.stopping = null;
    };
    stop.then(clear, clear);
    return stop;
  }

  /** A stop accepted while starting: it waits for the start, its first poll included, to settle. */
  private async stopAfterStart(start: Promise<void>): Promise<Omit<EvidenceEvent, "id" | "hash">> {
    try {
      await start;
    } catch {
      // The first poll failed, or dispose came first: there is no recording to stop.
      if (this.now() === "stopping") {
        this.state = "idle";
        this.jobId = null;
      }
      throw new Error(
        this.now() === "disposed"
          ? `[printer-log-adapter] ${this.id}: disposed, so there is no recording to stop`
          : `[printer-log-adapter] ${this.id}: no recording to stop: its start failed`,
      );
    }
    return this.stopOnce();
  }

  /** The stop, in state stopping: to idle once the summary is emitted, or to stopFailed. */
  private async stopOnce(): Promise<Omit<EvidenceEvent, "id" | "hash">> {
    try {
      const summary = await this.finishRecording();
      if (this.now() === "stopping") this.state = "idle";
      return summary;
    } catch (err) {
      if (this.now() === "stopping") this.state = "stopFailed";
      throw err;
    } finally {
      // Ended once the summary is emitted, or once stopping failed: nothing more is
      // scheduled either way. A poll still in flight is counted on its own, and so is a
      // stop retried later.
      this.endRecording?.();
      this.endRecording = null;
    }
  }

  private async finishRecording(): Promise<Omit<EvidenceEvent, "id" | "hash">> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // A poll the timer started before this stop is the job's: wait for it first, so each
    // entry is captured under this job, in the log's order, and the summary covers it
    // (astra pack 186). Like the final poll, it waits on the log source.
    await Promise.all([...this.polls]);

    // Disposed meanwhile: the recording is over, with no final poll and no summary.
    if (this.now() === "disposed") {
      throw new Error(`[printer-log-adapter] ${this.id}: disposed while job ${this.jobId ?? "unknown"} was stopping, so it has no summary`);
    }

    // A timer poll that failed may have lost lines, so a summary would vouch for a chain that
    // could be incomplete: refused, emitting nothing (astra pack 190). A retry refuses too.
    if (this.pollFailure !== null) {
      throw new Error(
        `[printer-log-adapter] ${this.id}: a log poll failed during the recording (${this.pollFailure}), so its chain may be incomplete`,
      );
    }

    // Do a final poll to capture any remaining lines
    if (this.jobId) {
      await this.poll(this.jobId);
    }

    // Disposed during the final poll: no summary (astra pack 196).
    if (this.now() === "disposed") {
      throw new Error(`[printer-log-adapter] ${this.id}: disposed while job ${this.jobId ?? "unknown"} was stopping, so it has no summary`);
    }

    const chain = this.logCaptureService.getChain();
    const chainLength = chain.length;
    const headHash = chain.length > 0 ? chain[chain.length - 1]!.entryHash : null;
    const tailHash = chain.length > 0 ? chain[0]!.previousHash : null;

    const summaryEvent: Omit<EvidenceEvent, "id" | "hash"> = {
      type: "printer_job_verified" as EvidenceEvent["type"],
      timestamp: new Date().toISOString(),
      source: this.source,
      payload: {
        jobId: this.jobId,
        chainLength,
        headHash,
        tailHash,
        logSource: this.logSource,
        summary: `Printer job ${this.jobId ?? "unknown"} completed with ${chainLength} hash-chained log entries`,
        // Honesty marker: a "verified" printer job from the simulated script
        // must be machine-detectable as simulation.
        ...(this.usingSimulatedProvider ? { mock: true } : {}),
      },
    };

    this.emit(summaryEvent);

    // Reset state
    this.logCaptureService.reset();
    this.chainLength = 0;
    this.latestEntryHash = null;
    this.jobId = null;

    return summaryEvent;
  }

  /**
   * Return the latest log entry hash and chain length as the "current reading".
   */
  async getCurrentReading(): Promise<Record<string, unknown>> {
    return {
      latestEntryHash: this.latestEntryHash,
      chainLength: this.chainLength,
      recording: this.state === "starting" || this.state === "recording",
      jobId: this.jobId,
      logSource: this.logSource,
    };
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.listeners.push(callback);
  }

  /**
   * Resolves once nothing that can emit is outstanding (`work`): no start in flight, its
   * first poll included; no recording, which lasts from its first poll's success until its
   * stop has emitted the summary or failed, or dispose; no timer poll in flight; and no stop
   * in flight, including one waiting for a start. So nothing is emitted after it resolves
   * until the next start. At once when nothing is outstanding.
   */
  quiesceEvidence(): Promise<void> {
    return this.work.idle();
  }

  /**
   * Final (see Lifecycle). Clears the timer and the listeners, and ends the recording's own
   * work. A start, poll or stop still in flight stays outstanding work until it settles; when
   * it resumes it sees the adapter disposed, and captures, installs and emits nothing.
   */
  async dispose(): Promise<void> {
    this.state = "disposed";
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.listeners = [];
    this.endRecording?.();
    this.endRecording = null;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Single poll cycle of `jobId`'s recording: fetch one log line and, if present, capture it
   * and emit it, labelled with that job. A poll that resumes after dispose captures and
   * emits nothing (astra pack 196).
   */
  private async poll(jobId: string): Promise<void> {
    const line = await this.logProvider(jobId);
    if (line === null) return; // nothing new
    if (this.now() === "disposed") return;

    const entry = await this.logCaptureService.captureEntry(line, this.logSource);
    if (this.now() === "disposed") return;

    this.chainLength++;
    this.latestEntryHash = entry.entryHash;

    const event: Omit<EvidenceEvent, "id" | "hash"> = {
      type: "log_hash_chain_entry" as EvidenceEvent["type"],
      timestamp: entry.capturedAt,
      source: {
        deviceId: this.logSource,
        deviceType: "gateway_bridge",
        kernelId: this.source.kernelId,
        // Honesty marker: entries from the simulated script are simulation.
        ...(this.usingSimulatedProvider ? { simulated: true } : {}),
      },
      payload: {
        jobId,
        entryId: entry.entryId,
        entryHash: entry.entryHash,
        previousHash: entry.previousHash,
        rawContent: entry.rawContent,
        capturedAt: entry.capturedAt,
        kernelSignature: entry.kernelSignature,
        ...(this.usingSimulatedProvider ? { mock: true } : {}),
      },
    };

    this.emit(event);
  }

  /**
   * The state as it is now: every read after an await goes through here. Dispose or a stop
   * may have changed it meanwhile, though TypeScript keeps `this.state` narrowed to what the
   * same function last saw.
   */
  private now(): Lifecycle {
    return this.state;
  }

  private emit(event: Omit<EvidenceEvent, "id" | "hash">): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
