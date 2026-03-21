/**
 * IPP (Internet Printing Protocol) adapter for standard 2D printers.
 *
 * Connects to any IPP-capable printer (Canon, HP, Brother, Epson) over the
 * network using the standard IPP protocol (RFC 8011).
 *
 * IPP URI format: ipp://192.168.1.50/ipp/print
 *
 * In production: set IPP_URI environment variable and install the `ipp` npm
 * package for real IPP communication.
 * In development: built-in mock mode simulating a Canon PIXMA TR8620a.
 *
 * IMPORTANT: The `ipp` package is an optional dependency. This adapter falls
 * back to mock mode automatically when the package is not available.
 */

import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";
import type { MachineAdapter, MachineCommand, MachineCommandResult, MachineStatus } from "./types.js";

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

  // Real IPP client (loaded dynamically)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ippClient: any = null;
  private ippAvailable = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private activeRealJobId: number | null = null;

  constructor(id: string, config: IppAdapterConfig) {
    this.id = id;
    this.config = config;
    this.source = {
      deviceId: id,
      deviceType: "controller",
      kernelId: config.kernelId,
      firmwareVersion: "IPP-Adapter-1.0.0",
    };

    // Attempt to load real IPP library unless mockMode is forced
    if (!config.mockMode) {
      this.tryLoadIpp();
    }
  }

  // ---------------------------------------------------------------------------
  // MachineAdapter interface
  // ---------------------------------------------------------------------------

  async getStatus(): Promise<MachineStatus> {
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
    if (this.config.mockMode || !this.ippAvailable) {
      return this.mockProgress;
    }

    if (this.activeRealJobId === null) return 0;

    try {
      const attrs = await this.realGetJobAttributes(this.activeRealJobId);
      return attrs.completedSheets ?? 0;
    } catch {
      return 0;
    }
  }

  async execute(command: MachineCommand): Promise<MachineCommandResult> {
    if (this.config.mockMode || !this.ippAvailable) {
      return this.executeMock(command);
    }
    return this.executeReal(command);
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.listeners.push(callback);
  }

  async dispose(): Promise<void> {
    this.stopPolling();
    this.clearMockTimer();
    this.mockStatus = "idle";
    this.mockProgress = 0;
    this.mockJobState = null;
    this.listeners = [];
  }

  // ---------------------------------------------------------------------------
  // IPP-specific public methods
  // ---------------------------------------------------------------------------

  async getCapabilities(): Promise<IppCapabilities> {
    if (this.config.mockMode || !this.ippAvailable) {
      return { ...this.mockCapabilities };
    }

    try {
      return await this.realGetPrinterAttributes();
    } catch {
      return { ...this.mockCapabilities };
    }
  }

  async cancelJob(jobId: number): Promise<void> {
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
        const jobId = this.currentJobId++;

        this.mockStatus = "busy";
        this.mockProgress = 0;

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
          payload: { jobId, jobName, totalPages, mock: true },
        });

        // Simulate print job: each page takes ~1200ms, job completes in 3-5 seconds
        this.simulatePrintJob(jobId, jobName, totalPages);

        return { success: true, message: `Print job ${jobId} submitted (mock)` };
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
          jobId,
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
            jobId,
            jobName,
            totalPages: totalJobPages,
            durationMs: Date.now() - (this.mockJobState?.startedAt ?? Date.now()),
            mock: true,
          },
        });

        this.mockJobState = null;
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
  }

  private clearMockTimer(): void {
    if (this.mockJobTimer) {
      clearTimeout(this.mockJobTimer);
      this.mockJobTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Real IPP implementation (via optional `ipp` package)
  // ---------------------------------------------------------------------------

  private tryLoadIpp(): void {
    // Dynamic import — if the `ipp` package isn't installed this is a no-op
    import("ipp").then((mod) => {
      this.ippClient = mod;
      this.ippAvailable = true;
    }).catch(() => {
      // ipp not available — fall back to mock
      this.ippAvailable = false;
    });
  }

  private async executeReal(command: MachineCommand): Promise<MachineCommandResult> {
    switch (command.type) {
      case "start": {
        const documentData = command.payload?.documentData as Buffer | string | undefined;
        const jobName = (command.payload?.jobName as string | undefined) ?? "pcc-job";

        if (!documentData) {
          return { success: false, message: "No documentData provided for IPP print job" };
        }

        try {
          const jobId = await this.realPrintJob(jobName, documentData);
          this.activeRealJobId = jobId;

          this.emit({
            type: "execution_started",
            timestamp: new Date().toISOString(),
            source: this.source,
            payload: { jobId, jobName },
          });

          this.startPolling();

          return { success: true, message: `IPP job ${jobId} submitted`, data: { jobId } };
        } catch (err) {
          return {
            success: false,
            message: `IPP print failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      case "stop": {
        if (this.activeRealJobId !== null) {
          await this.cancelJob(this.activeRealJobId);
          this.activeRealJobId = null;
          this.stopPolling();
        }
        return { success: true, message: "IPP job cancelled" };
      }

      case "status": {
        try {
          const caps = await this.realGetPrinterAttributes();
          return {
            success: true,
            data: {
              printerState: caps.printerState,
              makeModel: caps.makeModel,
              jobId: this.activeRealJobId,
            },
          };
        } catch (err) {
          return {
            success: false,
            message: `Status check failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      default:
        return { success: true, message: `${command.type} acknowledged` };
    }
  }

  private async realPrintJob(
    jobName: string,
    data: Buffer | string,
  ): Promise<number> {
    if (!this.ippClient) throw new Error("IPP client not loaded");

    const printer = new this.ippClient.Printer(this.config.uri);

    return new Promise<number>((resolve, reject) => {
      const msg = {
        "operation-attributes-tag": {
          "requesting-user-name": "pcc-kernel",
          "job-name": jobName,
          "document-format": "application/pdf",
        },
      };

      const documentBuffer = typeof data === "string" ? Buffer.from(data) : data;

      printer.execute("Print-Job", msg, documentBuffer, (err: Error | null, res: Record<string, unknown>) => {
        if (err) {
          reject(err);
          return;
        }
        // Extract job ID from response
        const jobAttrs = res?.["job-attributes-tag"] as Record<string, unknown> | undefined;
        const jobId = jobAttrs?.["job-id"] as number | undefined;
        resolve(jobId ?? 0);
      });
    });
  }

  private async realGetPrinterAttributes(): Promise<IppCapabilities> {
    if (!this.ippClient) throw new Error("IPP client not loaded");

    const printer = new this.ippClient.Printer(this.config.uri);

    return new Promise<IppCapabilities>((resolve, reject) => {
      const msg = {
        "operation-attributes-tag": {
          "requesting-user-name": "pcc-kernel",
          "requested-attributes": [
            "printer-state",
            "printer-make-and-model",
            "color-supported",
            "sides-supported",
            "media-supported",
            "printer-resolution-supported",
            "media-type-supported",
            "copies-supported",
            "pages-per-minute",
            "pages-per-minute-color",
          ],
        },
      };

      printer.execute(
        "Get-Printer-Attributes",
        msg,
        null,
        (err: Error | null, res: Record<string, unknown>) => {
          if (err) {
            reject(err);
            return;
          }

          const attrs = res?.["printer-attributes-tag"] as Record<string, unknown> | undefined;
          if (!attrs) {
            reject(new Error("No printer-attributes-tag in response"));
            return;
          }

          const stateValue = attrs["printer-state"] as number | undefined;
          const printerState: IppPrinterState =
            stateValue === 3 ? "idle" :
            stateValue === 4 ? "processing" :
            stateValue === 5 ? "stopped" :
            "idle";

          const sidesSupported = attrs["sides-supported"] as string | string[] | undefined;
          const sidesArr = Array.isArray(sidesSupported) ? sidesSupported : [sidesSupported ?? ""];
          const duplex = sidesArr.some((s) => s.includes("two-sided"));

          const resolutions = attrs["printer-resolution-supported"] as Array<{ crossFeedRes: number; feedRes: number }> | undefined;
          const resolutionDpis = resolutions
            ? resolutions.map((r) => r.crossFeedRes ?? r.feedRes ?? 300)
            : [300];

          const copies = attrs["copies-supported"] as { lower?: number; upper?: number } | undefined;

          resolve({
            makeModel: (attrs["printer-make-and-model"] as string | undefined) ?? "Unknown Printer",
            printerState,
            color: (attrs["color-supported"] as boolean | undefined) ?? false,
            duplex,
            mediaSizes: (attrs["media-supported"] as string[] | undefined) ?? [],
            resolutions: resolutionDpis,
            mediaTypes: (attrs["media-type-supported"] as string[] | undefined) ?? [],
            copiesSupported: { min: copies?.lower ?? 1, max: copies?.upper ?? 1 },
            pagesPerMinute: (attrs["pages-per-minute"] as number | undefined) ?? 10,
            pagesPerMinuteColor: attrs["pages-per-minute-color"] as number | undefined,
          });
        },
      );
    });
  }

  private async realGetJobAttributes(jobId: number): Promise<{ completedSheets?: number; jobState?: IppJobState }> {
    if (!this.ippClient) throw new Error("IPP client not loaded");

    const printer = new this.ippClient.Printer(this.config.uri);

    return new Promise((resolve, reject) => {
      const msg = {
        "operation-attributes-tag": {
          "requesting-user-name": "pcc-kernel",
          "job-id": jobId,
          "requested-attributes": ["job-state", "job-impressions-completed"],
        },
      };

      printer.execute(
        "Get-Job-Attributes",
        msg,
        null,
        (err: Error | null, res: Record<string, unknown>) => {
          if (err) {
            reject(err);
            return;
          }

          const attrs = res?.["job-attributes-tag"] as Record<string, unknown> | undefined;
          const stateMap: Record<number, IppJobState> = {
            3: "pending",
            4: "pending-held",
            5: "processing",
            6: "processing-stopped",
            7: "canceled",
            8: "aborted",
            9: "completed",
          };
          const stateVal = attrs?.["job-state"] as number | undefined;

          resolve({
            completedSheets: attrs?.["job-impressions-completed"] as number | undefined,
            jobState: stateVal ? stateMap[stateVal] : undefined,
          });
        },
      );
    });
  }

  private async realCancelJob(jobId: number): Promise<void> {
    if (!this.ippClient) throw new Error("IPP client not loaded");

    const printer = new this.ippClient.Printer(this.config.uri);

    return new Promise<void>((resolve, reject) => {
      const msg = {
        "operation-attributes-tag": {
          "requesting-user-name": "pcc-kernel",
          "job-id": jobId,
        },
      };

      printer.execute("Cancel-Job", msg, null, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Polling (real mode)
  // ---------------------------------------------------------------------------

  private startPolling(): void {
    this.stopPolling();
    const interval = this.config.pollIntervalMs ?? 2000;

    this.pollTimer = setInterval(async () => {
      if (this.activeRealJobId === null) {
        this.stopPolling();
        return;
      }

      try {
        const attrs = await this.realGetJobAttributes(this.activeRealJobId);

        if (attrs.jobState === "completed") {
          this.emit({
            type: "execution_completed",
            timestamp: new Date().toISOString(),
            source: this.source,
            payload: { jobId: this.activeRealJobId },
          });
          this.activeRealJobId = null;
          this.stopPolling();
        } else if (attrs.jobState === "aborted" || attrs.jobState === "canceled") {
          this.emit({
            type: "execution_failed",
            timestamp: new Date().toISOString(),
            source: this.source,
            payload: { jobId: this.activeRealJobId, state: attrs.jobState },
          });
          this.activeRealJobId = null;
          this.stopPolling();
        } else if (attrs.completedSheets !== undefined) {
          this.emit({
            type: "execution_progress",
            timestamp: new Date().toISOString(),
            source: this.source,
            payload: {
              jobId: this.activeRealJobId,
              completedSheets: attrs.completedSheets,
            },
          });
        }
      } catch {
        // Silently ignore transient poll failures
      }
    }, interval);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

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
