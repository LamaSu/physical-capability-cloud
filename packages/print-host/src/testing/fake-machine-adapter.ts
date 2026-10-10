import type {
  MachineAdapter,
  MachineCommand,
  MachineCommandResult,
} from "@pcc/kernel";
import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";

type MachineStatus = Awaited<ReturnType<MachineAdapter["getStatus"]>>;

export type FakeStartOutcome =
  | { outcome: "success"; jobId: number }
  | { outcome: "busy" }
  | { outcome: "error"; message: string };

type PrintEventType =
  | "execution_started"
  | "execution_progress"
  | "execution_completed"
  | "execution_failed";

/** A scripted printer: tests drive evidence, and cancellation models the state-7 poll. */
export class FakeMachineAdapter implements MachineAdapter {
  readonly type = "ipp-2d";
  readonly source: EvidenceSource;
  readonly commands: MachineCommand[] = [];
  readonly cancels: number[] = [];

  private status: MachineStatus = "idle";
  private progress = 0;
  private active = false;
  private activeJobId: number | undefined;
  private disposed = false;
  private eventNumber = 0;
  private readonly starts: FakeStartOutcome[] = [];
  private readonly unobservedStarts: MachineCommand[] = [];
  private readonly startWaiters: Array<{
    resolve: (command: MachineCommand) => void;
    reject: (reason: Error) => void;
  }> = [];
  private readonly evidenceListeners = new Set<
    (event: Omit<EvidenceEvent, "id" | "hash">) => void
  >();
  private readonly quiesceWaiters: Array<() => void> = [];

  constructor(readonly id: string, kernelId: string) {
    this.source = {
      deviceId: id,
      deviceType: "controller",
      kernelId,
      simulated: true,
    };
  }

  scriptStart(outcome: FakeStartOutcome): void {
    this.starts.push(outcome);
  }

  /** Observe the next start command, including one not yet observed by the test. */
  started(): Promise<MachineCommand> {
    if (this.disposed) return Promise.reject(new Error("fake adapter disposed"));
    const command = this.unobservedStarts.shift();
    if (command) return Promise.resolve(command);
    return new Promise((resolve, reject) => this.startWaiters.push({ resolve, reject }));
  }

  async getStatus(): Promise<MachineStatus> {
    return this.status;
  }

  async getProgress(): Promise<number> {
    return this.progress;
  }

  async execute(command: MachineCommand): Promise<MachineCommandResult> {
    const recorded = {
      ...command,
      ...(command.payload ? { payload: { ...command.payload } } : {}),
    };
    this.commands.push(recorded);
    if (this.disposed) return { success: false, message: "fake adapter disposed" };

    if (command.type === "start") {
      const outcome = this.starts.shift();
      const waiter = this.startWaiters.shift();
      if (waiter) waiter.resolve(recorded);
      else this.unobservedStarts.push(recorded);

      if (!outcome) return { success: false, message: "no scripted start result" };
      if (outcome.outcome === "busy") {
        this.status = "busy";
        return { success: false, message: "device is busy", data: { busy: true, code: "busy" } };
      }
      if (outcome.outcome === "error") {
        this.status = "error";
        return { success: false, message: outcome.message };
      }

      this.status = "busy";
      this.progress = 0;
      this.active = true;
      this.activeJobId = outcome.jobId;
      return { success: true, data: { jobId: outcome.jobId, ippJobId: outcome.jobId } };
    }

    if (command.type === "stop") this.finishWork();
    return { success: true };
  }

  async cancelJob(jobId: number): Promise<void> {
    this.cancels.push(jobId);
    if (this.disposed || !this.active || this.activeJobId !== jobId) return;
    // The next IPP poll observes job-state 7; cancellation does not stop polling.
    await Promise.resolve().then(() => {
      if (!this.disposed && this.active && this.activeJobId === jobId) {
        this.emit("execution_failed", { ippJobId: jobId, state: "canceled" });
      }
    });
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.evidenceListeners.add(callback);
  }

  emit(type: PrintEventType, payload: Record<string, unknown>): void {
    if (this.disposed || !this.active) throw new Error("fake adapter has no active print");
    const event: Omit<EvidenceEvent, "id" | "hash"> = {
      type,
      timestamp: new Date(Date.UTC(2026, 9, 9) + this.eventNumber++).toISOString(),
      source: { ...this.source },
      payload: { ...payload },
    };
    if (typeof payload.progress === "number") this.progress = payload.progress;
    for (const callback of this.evidenceListeners) callback(event);
    if (type === "execution_completed" || type === "execution_failed") this.finishWork();
  }

  quiesceEvidence(): Promise<void> {
    if (!this.active) return Promise.resolve();
    return new Promise((resolve) => this.quiesceWaiters.push(resolve));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.finishWork();
    this.evidenceListeners.clear();
    this.starts.length = 0;
    this.unobservedStarts.length = 0;
    for (const waiter of this.startWaiters.splice(0)) {
      waiter.reject(new Error("fake adapter disposed"));
    }
  }

  private finishWork(): void {
    this.active = false;
    this.activeJobId = undefined;
    this.status = "idle";
    for (const resolve of this.quiesceWaiters.splice(0)) resolve();
  }
}
