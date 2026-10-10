/**
 * IPP/1.1 adapter for standard 2D printers, using a built-in RFC 8010 codec
 * and bounded HTTP transport. Real mode never falls back to simulation.
 * Mock mode is explicit; IPP over TLS is not supported yet.
 */

import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";
import type { MachineAdapter, MachineCommand, MachineCommandResult, MachineStatus } from "./types.js";
import { OutstandingWork } from "./outstanding-work.js";

import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { IppClient, ippCompletionVerdict, sanitizeIppMessage, type IppClientFailure } from "./ipp-client.js";
import { createHttpIppTransport, type IppTransport } from "./ipp-transport.js";
import { IPP_TAG, readBoolean, readEnum, readInteger, readKeyword, readRange, readResolution, readText, singleAttribute, type IppGroup, type IppValue } from "./ipp-codec.js";

export interface IppAdapterConfig {
  /** IPP printer URI (e.g., "ipp://192.168.1.50/ipp/print") */
  uri: string;
  /** Human-readable printer name */
  name?: string;
  /** Kernel ID this printer belongs to */
  kernelId: string;
  /** Use mock mode (no real IPP calls) */
  mockMode?: boolean;
  /** Poll interval in ms (default 2000) */
  pollIntervalMs?: number;
  requestDeadlineMs?: number;
  printJobDeadlineMs?: number;
  maxResponseBytes?: number;
  maxDocumentBytes?: number;
  documentFormat?: string;
  /** @internal Test seam; production code never sets this. */
  transport?: IppTransport;
}

/** Operational diagnostics are never evidence. */
export interface IppDiagnostic {
  kind: "poll_failed" | "poll_recovered" | "job_unreadable";
  adapterId: string;
  ippJobId: number;
  operation: "Get-Job-Attributes";
  at: string;
  consecutiveFailures: number;
  failure?: { kind: string; httpStatus?: number; statusCode?: number };
  message: string;
}

/** IPP printer state values (RFC 8011 §5.4.11) */
type IppPrinterState = "idle" | "processing" | "stopped";

/** IPP job state values (RFC 8011 §5.3.7) */
type IppJobState =
  | "pending"
  | "pending-held"
  | "processing"
  | "processing-stopped"
  | "canceled"
  | "aborted"
  | "completed";

/** Capabilities returned from IPP Get-Printer-Attributes */
export interface IppCapabilities {
  makeModel: string;
  printerState: IppPrinterState;
  color: boolean;
  duplex: boolean;
  mediaSizes: string[];
  resolutions: number[];  // DPI values
  mediaTypes: string[];
  copiesSupported: { min: number; max: number };
  pagesPerMinute: number;
  pagesPerMinuteColor?: number;
}

/** Internal state tracked during a print job */
interface PrintJobState {
  jobId: number;
  jobName: string;
  totalPages: number;
  currentPage: number;
  jobState: IppJobState;
  startedAt: number;
}

/** Mock Canon PIXMA TR8620a capabilities */
const MOCK_CANON_PIXMA_TR8620A: IppCapabilities = {
  makeModel: "Canon PIXMA TR8620a",
  printerState: "idle",
  color: true,
  duplex: true,
  mediaSizes: ["iso_a4_210x297mm", "na_letter_8.5x11in", "na_legal_8.5x14in", "iso_a5_148x210mm", "na_4x6_4x6in"],
  resolutions: [300, 600, 1200, 4800],
  mediaTypes: ["stationery", "photographic", "envelope", "cardstock"],
  copiesSupported: { min: 1, max: 99 },
  pagesPerMinute: 15,
  pagesPerMinuteColor: 10,
};

export class IppAdapter implements MachineAdapter {
  readonly id: string;
  readonly type = "ipp-2d" as const;
  readonly source: EvidenceSource;

  private config: IppAdapterConfig;
  private listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];
  private mockStatus: MachineStatus = "idle";
  private mockProgress = 0;
  private mockJobState: PrintJobState | null = null;
  private mockJobTimer: ReturnType<typeof setTimeout> | null = null;
  private mockCapabilities: IppCapabilities = { ...MOCK_CANON_PIXMA_TR8620A };
  private currentJobId = 1000;

  private ippClient: IppClient | null = null;
  // Retained for PR1's routing hunks: real construction sets availability true;
  // loading is always null. Remove both after the parallel changes merge.
  private ippAvailable = false;
  private ippLoading: Promise<void> | null = null;
  /** Disposal is final: no new real request is allowed after this fence. */
  private disposed = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private activeRealJobId: number | null = null;
  private pollGeneration = 0;
  private pollInFlight: Promise<void> | null = null;
  private consecutiveFailures = 0;
  private lastStoppedReasons: string | undefined;
  private diagnosticListeners = new Set<(diagnostic: IppDiagnostic) => void>();

  /**
   * What can still emit: a mock print job (from its start until it completes or is
   * cancelled; a paused one can be resumed), the real-mode poll loop, each poll and each
   * real command in flight, and each command waiting for `ipp` to load.
   */
  private readonly work = new OutstandingWork();
  private endMockJob: (() => void) | null = null;
  private endPolling: (() => void) | null = null;

  constructor(id: string, config: IppAdapterConfig) {
    this.id = id;
    this.config = config.mockMode ? config : this.validateRealConfig(config);
    this.source = {
      deviceId: id,
      deviceType: "controller",
      kernelId: config.kernelId,
      firmwareVersion: "IPP-Adapter-1.0.0",
      simulated: !!config.mockMode,
    };
    if (!config.mockMode) {
      this.ippClient = new IppClient({
        printerUri: this.config.uri,
        transport: this.config.transport ?? createHttpIppTransport(),
        requestDeadlineMs: this.config.requestDeadlineMs,
        printJobDeadlineMs: this.config.printJobDeadlineMs,
        maxResponseBytes: this.config.maxResponseBytes,
      });
      this.ippAvailable = true;
    }
  }

  // ---------------------------------------------------------------------------
  // MachineAdapter interface
  // ---------------------------------------------------------------------------

  async getStatus(): Promise<MachineStatus> {
    if (this.ippLoading) await this.ippLoading;
    if (this.config.mockMode || !this.ippAvailable) {
      return this.mockStatus;
    }

    try {
      const caps = await this.realGetPrinterAttributes();
      return this.mapIppState(caps.printerState);
    } catch {
      return "offline";
    }
  }

  async getProgress(): Promise<number> {
    if (this.ippLoading) await this.ippLoading;
    if (this.config.mockMode || !this.ippAvailable) {
      return this.mockProgress;
    }

    if (this.disposed || this.activeRealJobId === null) return 0;

    try {
      const attrs = await this.realGetJobAttributes(this.activeRealJobId);
      return attrs.ok ? attrs.impressionsCompleted ?? 0 : 0;
    } catch {
      return 0;
    }
  }

  async execute(command: MachineCommand): Promise<MachineCommandResult> {
    // Disposed is final: a command runs nothing, real or mock (astra pack 201).
    if (this.disposed) {
      return { success: false, message: `IPP adapter "${this.id}" is disposed: ${command.type} not run` };
    }
    // While `ipp` loads the adapter cannot route: the command waits for the import, as
    // outstanding work (it may still emit), then takes the real or the mock path. A
    // dispose meanwhile ends it there: it was accepted before, but runs nothing after.
    const loading = this.ippLoading;
    if (loading) {
      return this.work.track(
        loading.then(() =>
          this.disposed
            ? { success: false, message: `IPP adapter "${this.id}" was disposed while the 'ipp' package loaded: ${command.type} not run` }
            : this.route(command),
        ),
      );
    }
    return this.route(command);
  }

  /** Runs `command` on real IPP once `ipp` has loaded, or on the mock, marked simulated, otherwise. */
  private route(command: MachineCommand): MachineCommandResult | Promise<MachineCommandResult> {
    if (this.config.mockMode || !this.ippAvailable) {
      return this.executeMock(command);
    }
    return this.work.track(this.executeReal(command));
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.listeners.push(callback);
  }

  /**
   * Resolves once every print job has reported how it ended and nothing more can emit: a
   * mock job has emitted execution_completed or was cancelled; the real-mode poll loop has
   * reported execution_completed or execution_failed and stopped (or "stop" stopped it); and
   * no poll or command is in flight, including one waiting for `ipp` to load. At once when
   * none is. A paused mock job keeps it pending until it is resumed and completes, or is
   * cancelled.
   */
  quiesceEvidence(): Promise<void> {
    return this.work.idle();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopPolling();
    this.cancelMockJob();
    this.listeners = [];
    this.diagnosticListeners.clear();
  }

  // ---------------------------------------------------------------------------
  // IPP-specific public methods
  // ---------------------------------------------------------------------------

  async getCapabilities(): Promise<IppCapabilities> {
    if (this.ippLoading) await this.ippLoading;
    if (this.config.mockMode || !this.ippAvailable) {
      return { ...this.mockCapabilities };
    }

    try {
      return await this.realGetPrinterAttributes();
    } catch (err) {
      // Refused, never answered with the mock printer's capabilities: an adapter marked
      // real would pass a simulator's answer off as this printer's (astra pack 467).
      throw new Error(`IPP Get-Printer-Attributes failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Cancels `jobId` on the printer, or the mock job. Refused once disposed, including a cancel
   * that was waiting for `ipp` to load: a disposed adapter sends nothing (astra pack 201). Its
   * owner cancels before it disposes.
   */
  async cancelJob(jobId: number): Promise<void> {
    if (this.disposed) throw new Error(`IPP adapter "${this.id}" is disposed: cancel of job ${jobId} not sent`);
    if (this.ippLoading) {
      await this.ippLoading;
      if (this.disposed) {
        throw new Error(`IPP adapter "${this.id}" was disposed while the 'ipp' package loaded: cancel of job ${jobId} not sent`);
      }
    }
    if (this.config.mockMode || !this.ippAvailable) {
      this.cancelMockJob();
      return;
    }

    try {
      await this.realCancelJob(jobId);
    } catch (err) {
      throw new Error(`IPP cancel failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Mock mode implementation
  // ---------------------------------------------------------------------------

  private executeMock(command: MachineCommand): MachineCommandResult {
    switch (command.type) {
      case "start": {
        if (this.mockStatus === "busy") {
          return { success: false, message: "Printer already processing a job" };
        }

        const jobName = (command.payload?.jobName as string | undefined) ?? "document.pdf";
        const totalPages = (command.payload?.totalPages as number | undefined) ?? 3;
        // Refused before the job is accepted: with no page to print (0 or fewer) its work would
        // begin and never end, and with no last page (NaN, Infinity, or past 2^53, where
        // currentPage++ stops counting) it would print forever. Either holds quiesceEvidence().
        if (!Number.isSafeInteger(totalPages) || totalPages < 1) {
          return { success: false, message: `totalPages must be a positive integer (got ${String(totalPages)})` };
        }
        const jobId = this.currentJobId++;

        this.mockStatus = "busy";
        this.mockProgress = 0;

        // A paused job this one replaces can no longer emit: its timer is cleared below.
        this.endMockJob?.();
        this.endMockJob = this.work.begin();
        this.mockJobState = {
          jobId,
          jobName,
          totalPages,
          currentPage: 0,
          jobState: "processing",
          startedAt: Date.now(),
        };

        this.emit({
          type: "execution_started",
          timestamp: new Date().toISOString(),
          source: this.source,
          // ippJobId is the printer's own job number. payload.jobId is reserved for
          // the PCC job, which the kernel's emitter commits on every event (LO-EV-9).
          payload: { ippJobId: jobId, jobName, totalPages, mock: true },
        });

        // Simulate print job: each page takes ~1200ms, job completes in 3-5 seconds
        this.simulatePrintJob(jobId, jobName, totalPages);

        return { success: true, message: `Print job ${jobId} submitted (mock)`, data: { jobId } };
      }

      case "stop": {
        this.cancelMockJob();
        return { success: true, message: "Print job cancelled (mock)" };
      }

      case "pause": {
        this.clearMockTimer();
        this.mockStatus = "idle";
        return { success: true, message: "Print paused (mock)" };
      }

      case "resume": {
        if (this.mockJobState && this.mockJobState.jobState === "processing") {
          const remaining = this.mockJobState.totalPages - this.mockJobState.currentPage;
          this.simulatePrintJob(
            this.mockJobState.jobId,
            this.mockJobState.jobName,
            remaining,
            this.mockJobState.currentPage,
          );
          this.mockStatus = "busy";
        }
        return { success: true, message: "Print resumed (mock)" };
      }

      case "status": {
        return {
          success: true,
          data: {
            status: this.mockStatus,
            progress: this.mockProgress,
            jobId: this.mockJobState?.jobId ?? null,
            jobName: this.mockJobState?.jobName ?? null,
            mock: true,
          },
        };
      }

      default:
        return { success: true, message: `${command.type} acknowledged (mock)` };
    }
  }

  private simulatePrintJob(
    jobId: number,
    jobName: string,
    totalPages: number,
    startPage = 0,
  ): void {
    this.clearMockTimer();

    let currentPage = startPage;
    const pageIntervalMs = 1200; // ~1.2 seconds per page

    const printNextPage = (): void => {
      if (currentPage >= startPage + totalPages || !this.mockJobState) {
        return;
      }

      currentPage++;

      if (this.mockJobState) {
        this.mockJobState.currentPage = currentPage;
      }

      const totalJobPages = startPage + totalPages;
      this.mockProgress = Math.round((currentPage / totalJobPages) * 100);

      this.emit({
        type: "execution_progress",
        timestamp: new Date().toISOString(),
        source: this.source,
        payload: {
          ippJobId: jobId,
          jobName,
          currentPage,
          totalPages: totalJobPages,
          progress: this.mockProgress,
          mock: true,
        },
      });

      if (currentPage >= totalJobPages) {
        // Job complete
        this.mockProgress = 100;
        this.mockStatus = "idle";

        if (this.mockJobState) {
          this.mockJobState.jobState = "completed";
        }

        this.emit({
          type: "execution_completed",
          timestamp: new Date().toISOString(),
          source: this.source,
          payload: {
            ippJobId: jobId,
            jobName,
            totalPages: totalJobPages,
            durationMs: Date.now() - (this.mockJobState?.startedAt ?? Date.now()),
            mock: true,
          },
        });

        this.mockJobState = null;
        // Ended only after the completion is emitted.
        this.endMockJob?.();
        this.endMockJob = null;
      } else {
        this.mockJobTimer = setTimeout(printNextPage, pageIntervalMs);
      }
    };

    // First page starts after a brief spool delay
    this.mockJobTimer = setTimeout(printNextPage, 500);
  }

  private cancelMockJob(): void {
    this.clearMockTimer();
    this.mockStatus = "idle";
    this.mockProgress = 0;
    this.mockJobState = null;
    this.endMockJob?.();
    this.endMockJob = null;
  }

  private clearMockTimer(): void {
    if (this.mockJobTimer) {
      clearTimeout(this.mockJobTimer);
      this.mockJobTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Real IPP implementation
  // ---------------------------------------------------------------------------

  onDiagnostic(listener: (diagnostic: IppDiagnostic) => void): () => void {
    if (!this.disposed) this.diagnosticListeners.add(listener);
    return () => { this.diagnosticListeners.delete(listener); };
  }

  private async executeReal(command: MachineCommand): Promise<MachineCommandResult & { busy?: true }> {
    switch (command.type) {
      case "start": {
        const documentData = command.payload?.documentData;
        const jobName = command.payload?.jobName === undefined ? "pcc-job" : command.payload.jobName;
        if (!documentData) {
          return { success: false, message: "No documentData provided for IPP print job" };
        }
        if (typeof documentData !== "string" && !(documentData instanceof Uint8Array)) {
          return { success: false, message: "documentData must be a string or byte array" };
        }
        const document = typeof documentData === "string" ? Buffer.from(documentData) : documentData;
        if (document.byteLength > this.config.maxDocumentBytes!) {
          return { success: false, message: "documentData exceeds maxDocumentBytes" };
        }
        if (typeof jobName !== "string" || Buffer.byteLength(jobName) < 1 || Buffer.byteLength(jobName) > 255 || Buffer.from(jobName).toString("utf8") !== jobName || /[\p{Cc}]/u.test(jobName)) {
          return { success: false, message: "jobName must be 1-255 UTF-8 octets without control characters" };
        }
        if (command.payload && Object.prototype.hasOwnProperty.call(command.payload, "documentFormat")) {
          return { success: false, message: "documentFormat belongs in the adapter config; per-start overrides are refused" };
        }
        const ready = await this.checkReadiness();
        if (!ready.success) return ready;
        if (this.disposed) return { success: false, message: "IPP adapter was disposed during readiness check; Print-Job not sent" };
        const result = await this.realPrintJob(jobName, document);
        if (!result.ok) {
          if (result.kind === "ipp_status") {
            return {
              success: false,
              message: result.message,
              ...(result.statusCode === 0x0507 ? { busy: true as const } : {}),
              data: { ippStatusCode: result.statusCode },
            };
          }
          return { success: false, message: result.message, ...(result.sent ? { data: { deviceStateUnknown: true } } : {}) };
        }
        const jobId = result.jobId;
          // Disposed while the printer answered: the printer accepted the job, so the start
          // succeeded, and a failure here would invite a retry that prints it twice (astra
          // pack 205). But a disposed adapter follows nothing (astra pack 203): it records no
          // job and starts no polling, and says so (monitored: false) with the job's id, so its
          // owner can cancel it explicitly if it must not print.
          if (this.disposed) {
            return {
              success: true,
              message: `IPP job ${jobId} was submitted, but adapter "${this.id}" was disposed meanwhile, so the job is not monitored`,
              data: { jobId, monitored: false },
            };
          }
        this.activeRealJobId = jobId;
        this.emit({
          type: "execution_started",
          timestamp: new Date().toISOString(),
          source: this.source,
          payload: { ippJobId: jobId, jobName },
        });
        this.startPolling();
        return { success: true, message: `IPP job ${jobId} submitted`, data: { jobId } };
      }

      case "stop": {
        if (this.activeRealJobId !== null) {
          await this.cancelJob(this.activeRealJobId);
          this.activeRealJobId = null;
          this.stopPolling();
        }
        return { success: true, message: "IPP job cancelled" };
      }

      case "pause":
      case "resume": {
        const result = await this.work.track(command.type === "pause" ? this.ippClient!.pausePrinter() : this.ippClient!.resumePrinter());
        return {
          success: result.ok,
          message: result.ok ? `IPP printer ${command.type === "pause" ? "paused" : "resumed"}` : result.message,
          data: { ippStatusCode: result.statusCode },
        };
      }
      case "status": {
        try {
          const caps = await this.realGetPrinterAttributes();
          return { success: true, data: { printerState: caps.printerState, makeModel: caps.makeModel, jobId: this.activeRealJobId } };
        } catch (err) {
          return { success: false, message: `Status check failed: ${err instanceof Error ? err.message : "IPP query failed"}` };
        }
      }
      default:
        return { success: true, message: `${command.type} acknowledged` };
    }
  }

  private async checkReadiness(): Promise<MachineCommandResult & { busy?: true }> {
    const group = await this.printerAttributes(["printer-state", "printer-state-reasons", "printer-is-accepting-jobs"]);
    if (!group.ok) return { success: false, message: group.message };
    const state = this.oneValue(group.value, "printer-state", readEnum);
    const accepting = this.oneValue(group.value, "printer-is-accepting-jobs", readBoolean);
    const reasons = this.keywordList(group.value, "printer-state-reasons");
    if (state === undefined || accepting === undefined || reasons === null) return { success: false, message: "IPP readiness attributes are unreadable" };
    if (!accepting) return { success: false, message: "IPP printer is not accepting jobs" };
    if (state === 4) return { success: false, busy: true, message: "IPP printer is processing another job", data: { printerState: 4 } };
    if (state === 5) return { success: false, message: sanitizeIppMessage(`IPP printer is stopped: ${reasons.join(", ")}`) };
    if (state !== 3) return { success: false, message: "IPP printer readiness state is unknown" };
    return { success: true };
  }

  private realPrintJob(jobName: string, document: Uint8Array) {
    return this.work.track(this.ippClient!.printJob({ jobName, documentFormat: this.config.documentFormat!, document }));
  }

  private async printerAttributes(requested: string[]): Promise<{ ok: true; value: IppGroup } | { ok: false; message: string }> {
    if (this.disposed) return { ok: false, message: "IPP adapter is disposed; query not sent" };
    const result = await this.work.track(this.ippClient!.getPrinterAttributes(requested));
    if (!result.ok) return result;
    const groups = result.message.groups.filter((group) => group.tag === IPP_TAG.PRINTER_ATTRIBUTES);
    if (groups.length !== 1) return { ok: false, message: "IPP answer requires exactly one Printer Attributes group" };
    return { ok: true, value: groups[0] };
  }

  private async realGetPrinterAttributes(): Promise<IppCapabilities> {
    const result = await this.printerAttributes([
      "printer-state", "printer-make-and-model", "color-supported", "sides-supported", "media-supported",
      "printer-resolution-supported", "media-type-supported", "copies-supported", "pages-per-minute", "pages-per-minute-color",
    ]);
    if (!result.ok) throw new Error(result.message);
    const group = result.value;
    const state = this.oneValue(group, "printer-state", readEnum);
    if (state !== 3 && state !== 4 && state !== 5) throw new Error("IPP printer-state is unreadable");
    const resolutionAttr = singleAttribute(group, "printer-resolution-supported");
    const resolutions = "value" in resolutionAttr ? resolutionAttr.value.values.flatMap((value) => {
      const read = readResolution(value);
      return "value" in read ? [read.value.units === 3 ? read.value.x : Math.round(read.value.x * 2.54)] : [];
    }) : [300];
    const copies = this.oneValue(group, "copies-supported", readRange);
    return {
      makeModel: this.oneValue(group, "printer-make-and-model", readText) ?? "Unknown Printer",
      printerState: state === 3 ? "idle" : state === 4 ? "processing" : "stopped",
      color: this.oneValue(group, "color-supported", readBoolean) ?? false,
      duplex: (this.keywordList(group, "sides-supported") ?? []).some((side) => side.includes("two-sided")),
      mediaSizes: this.keywordList(group, "media-supported") ?? [],
      resolutions,
      mediaTypes: this.keywordList(group, "media-type-supported") ?? [],
      copiesSupported: { min: copies?.lower ?? 1, max: copies?.upper ?? 1 },
      pagesPerMinute: this.oneValue(group, "pages-per-minute", readInteger) ?? 10,
      pagesPerMinuteColor: this.oneValue(group, "pages-per-minute-color", readInteger),
    };
  }

  private realGetJobAttributes(jobId: number) {
    return this.work.track(this.ippClient!.getJobAttributes(jobId));
  }

  private async realCancelJob(jobId: number): Promise<void> {
    const result = await this.work.track(this.ippClient!.cancelJob(jobId));
    if (!result.ok) throw new Error(result.message);
  }

  // ---------------------------------------------------------------------------
  // Polling: schedule only after the previous poll settles.
  // ---------------------------------------------------------------------------

  private startPolling(): void {
    if (this.disposed) return;
    this.stopPolling();
    this.consecutiveFailures = 0;
    this.lastStoppedReasons = undefined;
    this.endPolling = this.work.begin();
    this.schedulePoll(this.pollGeneration, this.activeRealJobId!);
  }

  private schedulePoll(generation: number, jobId: number): void {
    if (this.disposed || generation !== this.pollGeneration || this.activeRealJobId !== jobId) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      // A replacement start also waits for the old job's pending poll to settle.
      if (this.pollInFlight) {
        void this.pollInFlight.then(() => this.schedulePoll(generation, jobId), () => this.schedulePoll(generation, jobId));
        return;
      }
      const pending = this.work.track(this.poll(jobId, generation));
      this.pollInFlight = pending;
      const settled = () => {
        if (this.pollInFlight === pending) this.pollInFlight = null;
        this.schedulePoll(generation, jobId);
      };
      void pending.then(settled, settled);
    }, this.config.pollIntervalMs);
  }

  private async poll(jobId: number, generation: number): Promise<void> {
    if (this.disposed || generation !== this.pollGeneration || this.activeRealJobId !== jobId) return;
    const attrs = await this.realGetJobAttributes(jobId);
    if (this.disposed || generation !== this.pollGeneration || this.activeRealJobId !== jobId) return;
    if (!attrs.ok) {
      this.pollProblem(jobId, "poll_failed", attrs.message, attrs);
      return;
    }
    if (attrs.jobState === null || attrs.jobState < 3 || attrs.jobState > 9) {
      this.pollProblem(jobId, "job_unreadable", attrs.jobStateProblem ?? "IPP job-state is unknown");
      return;
    }
    const verdict = ippCompletionVerdict(attrs.jobState, attrs.jobStateReasons);
    if (attrs.jobState === 9 && verdict.verdict === "waiting") {
      this.pollProblem(jobId, "job_unreadable", attrs.reasonsProblem ?? verdict.problem ?? "IPP completion reasons are unreadable");
      return;
    }
    if (this.consecutiveFailures) {
      this.consecutiveFailures = 0;
      this.diagnose(jobId, "poll_recovered", "IPP job polling recovered");
    }
    if (attrs.jobState === 7 || attrs.jobState === 8) {
      this.emit({ type: "execution_failed", timestamp: new Date().toISOString(), source: this.source, payload: { ippJobId: jobId, state: attrs.jobState === 7 ? "canceled" : "aborted" } });
    } else if (attrs.jobState === 9) {
      if (verdict.verdict === "completed") {
        this.emit({ type: "execution_completed", timestamp: new Date().toISOString(), source: this.source, payload: { ippJobId: jobId } });
      } else {
        this.emit({ type: "execution_failed", timestamp: new Date().toISOString(), source: this.source, payload: { ippJobId: jobId, state: "completed", completion: verdict.completion, jobStateReasons: attrs.jobStateReasons } });
      }
    } else if (attrs.jobState === 6) {
      const reasonsKey = JSON.stringify(attrs.jobStateReasons);
      if (reasonsKey !== this.lastStoppedReasons) {
        this.emit({ type: "execution_progress", timestamp: new Date().toISOString(), source: this.source, payload: { ippJobId: jobId, jobState: 6, jobStateReasons: attrs.jobStateReasons, ...(attrs.impressionsCompleted !== undefined ? { completedSheets: attrs.impressionsCompleted } : {}) } });
      }
      this.lastStoppedReasons = reasonsKey;
      return;
    } else {
      this.lastStoppedReasons = undefined;
      if (attrs.impressionsCompleted !== undefined) {
        this.emit({ type: "execution_progress", timestamp: new Date().toISOString(), source: this.source, payload: { ippJobId: jobId, completedSheets: attrs.impressionsCompleted } });
      }
      return;
    }
    this.activeRealJobId = null;
    this.stopPolling();
  }

  private pollProblem(jobId: number, kind: "poll_failed" | "job_unreadable", message: string, failure?: IppClientFailure): void {
    this.consecutiveFailures++;
    this.diagnose(jobId, kind, message, failure);
  }

  private diagnose(jobId: number, kind: IppDiagnostic["kind"], message: string, failure?: IppClientFailure): void {
    const diagnostic: IppDiagnostic = {
      kind, adapterId: this.id, ippJobId: jobId, operation: "Get-Job-Attributes",
      at: new Date().toISOString(), consecutiveFailures: this.consecutiveFailures,
      message: sanitizeIppMessage(message),
      ...(failure ? { failure: { kind: failure.kind, ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}), ...(failure.statusCode !== undefined ? { statusCode: failure.statusCode } : {}) } } : {}),
    };
    for (const listener of this.diagnosticListeners) {
      try { listener(diagnostic); } catch { /* Diagnostics cannot interrupt polling. */ }
    }
  }

  private stopPolling(): void {
    this.pollGeneration++;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.endPolling?.();
    this.endPolling = null;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Validate without reflecting an input URI, which may contain credentials. */
  private validateRealConfig(config: IppAdapterConfig): IppAdapterConfig {
    let uri: URL;
    try { uri = new URL(config.uri); } catch { throw new Error("Invalid IPP printer URI"); }
    if (uri.protocol === "ipps:") throw new Error("ipps:// (IPP over TLS) is not supported yet; no insecure TLS option is offered");
    if (uri.protocol !== "ipp:") throw new Error("Printer URI must use ipp://");
    if (uri.username || uri.password || /^ipp:\/\/[^/]*@/i.test(config.uri)) throw new Error("IPP printer URI must not contain userinfo");
    if (uri.search || uri.hash || config.uri.includes("?") || config.uri.includes("#")) throw new Error("IPP printer URI must not contain a query or fragment");
    if (!uri.hostname) throw new Error("IPP printer URI requires a host");
    const port = uri.port === "" ? 631 : Number(uri.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("IPP printer port must be 1-65535");
    if (!uri.pathname) uri.pathname = "/";
    if (!/^[\x00-\x7f]+$/.test(uri.href) || Buffer.byteLength(uri.href) > 1023) throw new Error("Canonical printer-uri must be ASCII and at most 1023 octets");
    const normalized = { ...config, uri: uri.href, pollIntervalMs: config.pollIntervalMs === undefined ? 2000 : config.pollIntervalMs, requestDeadlineMs: config.requestDeadlineMs === undefined ? 15000 : config.requestDeadlineMs, printJobDeadlineMs: config.printJobDeadlineMs === undefined ? 120000 : config.printJobDeadlineMs, maxResponseBytes: config.maxResponseBytes === undefined ? 1048576 : config.maxResponseBytes, maxDocumentBytes: config.maxDocumentBytes === undefined ? 33554432 : config.maxDocumentBytes, documentFormat: config.documentFormat === undefined ? "application/pdf" : config.documentFormat };
    for (const key of ["pollIntervalMs", "requestDeadlineMs", "printJobDeadlineMs", "maxResponseBytes", "maxDocumentBytes"] as const) {
      const value = normalized[key];
      const min = key === "pollIntervalMs" ? 50 : 1;
      const max = key === "pollIntervalMs" ? 600000 : 2147483647;
      if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer in ${min}-${max}`);
    }
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(normalized.documentFormat) || normalized.documentFormat.length > 255 || /[^\x20-\x7e]/.test(normalized.documentFormat)) throw new Error("documentFormat must be a 1-255 character ASCII MIME type/subtype");
    if (normalized.transport !== undefined && typeof normalized.transport !== "function") throw new Error("transport must be a function");
    return normalized;
  }

  private oneValue<T>(group: IppGroup, name: string, reader: (value: IppValue) => { value: T } | { problem: string }): T | undefined {
    const attribute = singleAttribute(group, name);
    if ("problem" in attribute || attribute.value.values.length !== 1) return undefined;
    const result = reader(attribute.value.values[0]);
    return "value" in result ? result.value : undefined;
  }

  private keywordList(group: IppGroup, name: string): string[] | null {
    const attribute = singleAttribute(group, name);
    if ("problem" in attribute || attribute.value.values.length === 0) return null;
    const values: string[] = [];
    for (const value of attribute.value.values) {
      const result = readKeyword(value);
      if ("problem" in result) return null;
      values.push(result.value);
    }
    return values;
  }

  private emit(event: Omit<EvidenceEvent, "id" | "hash">): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private mapIppState(state: IppPrinterState): MachineStatus {
    switch (state) {
      case "idle": return "idle";
      case "processing": return "busy";
      case "stopped": return "error";
      default: return "idle";
    }
  }
}
