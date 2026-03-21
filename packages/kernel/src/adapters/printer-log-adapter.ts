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
 * Log providers are swappable:
 *   - Default: generates simulated printer log lines (useful in tests / CI).
 *   - Real: pass a `logProvider` in config that reads from CUPS / IPP spool / OS.
 */

import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";
import type { SensorAdapter } from "./types.js";
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

export class PrinterLogAdapter implements SensorAdapter {
  readonly id: string;
  /** Use "power_monitor" as the closest existing SensorAdapter type. */
  readonly type = "power_monitor" as const;
  readonly source: EvidenceSource;

  private readonly logCaptureService: LogCaptureService;
  private readonly logSource: string;
  private readonly pollIntervalMs: number;
  private readonly logProvider: LogProvider;

  private recording = false;
  private jobId: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];
  private chainLength = 0;
  private latestEntryHash: string | null = null;

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
    this.logProvider = config?.logProvider ?? makeSimulatedLogProvider();

    this.source = {
      deviceId: id,
      deviceType: "controller",
      kernelId,
      firmwareVersion: "PrinterLogAdapter-1.0.0",
    };
  }

  // ---------------------------------------------------------------------------
  // SensorAdapter implementation
  // ---------------------------------------------------------------------------

  /** Start polling the log provider and emitting hash-chained evidence events. */
  async startRecording(jobId: string): Promise<void> {
    if (this.recording) {
      return; // already started — idempotent
    }

    this.recording = true;
    this.jobId = jobId;
    this.chainLength = 0;
    this.latestEntryHash = null;

    // Reset the chain so each job starts fresh
    this.logCaptureService.reset();

    // Poll immediately, then on interval
    await this.poll();

    this.pollTimer = setInterval(() => {
      this.poll().catch(() => {
        // Non-fatal poll errors are silently swallowed to avoid crashing the
        // adapter loop; real implementations would log here.
      });
    }, this.pollIntervalMs);
  }

  /**
   * Stop polling, finalize the chain, and return a summary evidence event.
   * The summary event type is `printer_job_verified`.
   */
  async stopRecording(): Promise<Omit<EvidenceEvent, "id" | "hash">> {
    this.recording = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Do a final poll to capture any remaining lines
    if (this.jobId) {
      await this.poll();
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
      recording: this.recording,
      jobId: this.jobId,
      logSource: this.logSource,
    };
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.listeners.push(callback);
  }

  async dispose(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.recording = false;
    this.listeners = [];
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Single poll cycle — fetch one log line and, if present, capture + emit it. */
  private async poll(): Promise<void> {
    if (!this.jobId) return;

    const line = await this.logProvider(this.jobId);
    if (line === null) return; // nothing new

    const entry = await this.logCaptureService.captureEntry(line, this.logSource);

    this.chainLength++;
    this.latestEntryHash = entry.entryHash;

    const event: Omit<EvidenceEvent, "id" | "hash"> = {
      type: "log_hash_chain_entry" as EvidenceEvent["type"],
      timestamp: entry.capturedAt,
      source: {
        deviceId: this.logSource,
        deviceType: "gateway_bridge",
        kernelId: this.source.kernelId,
      },
      payload: {
        jobId: this.jobId,
        entryId: entry.entryId,
        entryHash: entry.entryHash,
        previousHash: entry.previousHash,
        rawContent: entry.rawContent,
        capturedAt: entry.capturedAt,
        kernelSignature: entry.kernelSignature,
      },
    };

    this.emit(event);
  }

  private emit(event: Omit<EvidenceEvent, "id" | "hash">): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
