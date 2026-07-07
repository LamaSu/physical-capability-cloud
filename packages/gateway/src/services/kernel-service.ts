/**
 * KernelService — manages kernel adapter instances and routes jobs to devices.
 *
 * Lives in the gateway process (not a separate kernel server). Creates
 * JobRunner instances for each machine adapter declared in the KernelConfig,
 * then coordinates job submission, status tracking, and device health checks.
 */

import { JobRunner } from "@pcc/kernel";
import { EvidenceEmitter } from "@pcc/kernel";
import { createAdaptersFromConfig, loadKernelConfig } from "@pcc/kernel";
import { initSafetyGateway, getSafetyGateway } from "@pcc/kernel";
import type { KernelConfig } from "@pcc/kernel";
import type { MachineAdapter } from "@pcc/kernel";
import type { EvidenceBundle } from "@pcc/spec";
import { getRepos } from "../db.js";
import { getSettlementService } from "./settlement-service.js";
import { Sentry } from "../sentry.js";
import { startTrace, endTrace } from "../tracing.js";
import { pipelineTelemetry } from "../telemetry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubmitJobParams {
  jobId: string;
  stepId: string;
  deviceId?: string;
  gcodeHash?: string;
  assuranceTier?: number;
  /** DID of the requesting agent (for safety audit trail) */
  agentDid?: string;
  /** Execution scope ID (required for class-3 / scoped commands) */
  scopeId?: string;
}

export interface JobStatusResult {
  status: string;
  progress: number;
  deviceId?: string;
  evidenceBundleId?: string;
}

export interface DeviceInfo {
  id: string;
  type: string;
  adapterType: string;
  healthStatus: string;
}

// ---------------------------------------------------------------------------
// In-memory job tracking (augments the DB)
// ---------------------------------------------------------------------------

interface RunningJob {
  jobId: string;
  deviceId: string;
  startedAt: number;
}

// ---------------------------------------------------------------------------
// KernelService
// ---------------------------------------------------------------------------

export class KernelService {
  private runners: Map<string, JobRunner> = new Map();
  private machines: Map<string, MachineAdapter> = new Map();
  private emitter: EvidenceEmitter;
  private config: KernelConfig;
  private runningJobs: Map<string, RunningJob> = new Map();
  /** Cache of finalized evidence bundles, keyed by jobId */
  private completedBundles: Map<string, EvidenceBundle> = new Map();

  /** Sensors loaded from KERNEL_CONFIG; used when wiring DB-loaded machines. */
  private sensors: ReturnType<typeof createAdaptersFromConfig>["sensors"] = [];
  /** Cameras loaded from KERNEL_CONFIG; used when wiring DB-loaded machines. */
  private cameras: ReturnType<typeof createAdaptersFromConfig>["cameras"] = [];

  constructor(config?: KernelConfig) {
    this.config = config ?? loadKernelConfig();
    this.emitter = new EvidenceEmitter(this.config.kernelId);
    // Initialize the safety gateway before any adapters or runners are created.
    // This guarantees the singleton exists before submitJob can be called.
    initSafetyGateway();
    this.initAdapters();
    // Also load any DB-registered devices for this kernel so test-job lands
    // on the operator's REAL device, not the KERNEL_CONFIG mock fallback.
    this.loadDbDevicesIntoRuntime();
    // Cache finalized bundles so we can pass them to the settlement service
    this.emitter.onBundle((bundle) => {
      this.completedBundles.set(bundle.jobId, bundle);
    });
  }

  private initAdapters(): void {
    const adapters = createAdaptersFromConfig(this.config);
    this.sensors = adapters.sensors;
    this.cameras = adapters.cameras;
    for (const machine of adapters.machines) {
      this.machines.set(machine.id, machine);
      const runner = new JobRunner(
        machine,
        adapters.sensors,
        adapters.cameras[0] ?? null,
        this.emitter,
      );
      this.runners.set(machine.id, runner);
    }
  }

  /**
   * Build a single-device adapter from a DB row + add it to the running
   * machines/runners maps. Idempotent — calling twice on the same id
   * replaces the previous adapter (so register-device upsert flows
   * through cleanly).
   *
   * Failure here is non-fatal — invalid adapter configs are logged and
   * skipped. The DB row stays put for later retry / inspection.
   */
  private installMachineFromDbRow(row: {
    id: string;
    type: string;
    adapterType: string | null;
    adapterConfig: string | null;
  }): { installed: boolean; reason?: string } {
    if (row.type !== "machine") {
      // sensors + cameras don't need a runner of their own.
      return { installed: false, reason: "non_machine" };
    }
    if (!row.adapterType) {
      return { installed: false, reason: "missing_adapter_type" };
    }
    let cfg: Record<string, unknown> = {};
    if (row.adapterConfig) {
      try {
        const parsed = JSON.parse(row.adapterConfig);
        if (parsed && typeof parsed === "object") {
          cfg = parsed as Record<string, unknown>;
        }
      } catch {
        return { installed: false, reason: "invalid_adapter_config_json" };
      }
    }
    try {
      const tinyConfig: KernelConfig = {
        kernelId: this.config.kernelId,
        devices: [
          {
            id: row.id,
            type: "machine",
            adapterType: row.adapterType as any,
            config: cfg,
          },
        ],
      };
      const { machines } = createAdaptersFromConfig(tinyConfig);
      for (const m of machines) {
        this.machines.set(m.id, m);
        const runner = new JobRunner(
          m,
          this.sensors,
          this.cameras[0] ?? null,
          this.emitter,
        );
        this.runners.set(m.id, runner);
      }
      return { installed: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { installed: false, reason: `factory_error: ${msg}` };
    }
  }

  /**
   * Load every DB-registered device for this kernel into the running
   * runtime. Called once during construction; safe to re-call.
   */
  private loadDbDevicesIntoRuntime(): void {
    try {
      const rows = getRepos().kernels.findDevicesByKernel(this.config.kernelId);
      for (const row of rows) {
        this.installMachineFromDbRow(row);
      }
    } catch {
      // DB may not be initialized in test paths; ignore.
    }
  }

  /**
   * Public: re-read a single DB device row and install it into the running
   * runtime. Called by setup/register-device after a successful upsert so
   * the very next test-job uses the real device.
   */
  refreshDeviceFromDb(deviceId: string): { installed: boolean; reason?: string } {
    const row = getRepos().kernels.findDeviceById(deviceId);
    if (!row) return { installed: false, reason: "row_not_found" };
    return this.installMachineFromDbRow(row);
  }

  /**
   * Select a device for a job. Prefers the explicitly requested deviceId,
   * otherwise picks the first available machine adapter.
   */
  private selectDevice(deviceId?: string): string | null {
    if (deviceId && this.runners.has(deviceId)) {
      return deviceId;
    }
    // Auto-select: return the first machine id
    const first = this.runners.keys().next().value;
    return first ?? null;
  }

  /**
   * Submit a job to a device. The actual execution is fire-and-forget;
   * this method returns immediately with { jobId, deviceId, status }.
   *
   * Admission control runs synchronously first via SafetyGateway.validateOnly()
   * (circuit-breaker fast-fail + governor): if the governor denies the command
   * or the device's breaker is already open, an error is thrown immediately and
   * no job is accepted. The real runner.run() executes out-of-band below and
   * reports its true success/failure back to the breaker via
   * recordDeviceSuccess()/recordDeviceFailure() — so a device that keeps failing
   * actually trips the breaker and blocks subsequent jobs.
   */
  async submitJob(params: SubmitJobParams): Promise<{ jobId: string; deviceId: string; status: "accepted" }> {
    const { jobId, stepId, gcodeHash, assuranceTier = 0 } = params;

    const deviceId = this.selectDevice(params.deviceId);
    if (!deviceId) {
      throw new Error("no_devices_available");
    }

    const runner = this.runners.get(deviceId)!;

    // ── Safety gateway pre-flight ──────────────────────────────────────────
    // Build a PhysicalCommand descriptor for this job. Jobs submitted without
    // an explicit scopeId use class "safe" (operator-initiated or system jobs).
    // Jobs with a scopeId use class "scoped" (agent-initiated, requires scope).
    const gateway = getSafetyGateway();
    const cmdClass = params.scopeId ? "scoped" : "safe";

    // We validate synchronously before accepting the job (not fire-and-forget).
    // This is admission control ONLY — the circuit breaker's fast-fail plus the
    // governor's 5-check pipeline. The real runner.run() executes out-of-band
    // below; its true success/failure is fed back to the breaker via
    // recordDeviceSuccess()/recordDeviceFailure() so real device failures count.
    const preflightCmd = {
      commandId: `preflight:${jobId}`,
      deviceId,
      class: cmdClass as "safe" | "scoped",
      type: "submit_job",
      params: { jobId, stepId, gcodeHash: gcodeHash ?? `sha256:${jobId}`, assuranceTier },
      agentDid: params.agentDid ?? "kernel-service",
      scopeId: params.scopeId,
    };

    // Admission check with NO execution. (Previously this passed a no-op execute
    // to validateAndRelay, which recorded a phantom success on every job and
    // prevented the breaker from ever tripping on real device failures.)
    const preflight = await gateway.validateOnly(preflightCmd);
    if (!preflight.allowed) {
      throw new Error(
        `[safety-gateway] Job ${jobId} denied: ${preflight.verdict?.reason ?? preflight.reason ?? "unknown"}`,
      );
    }

    // Track in-memory
    this.runningJobs.set(jobId, { jobId, deviceId, startedAt: Date.now() });

    // Telemetry: job accepted by a device
    pipelineTelemetry.emit(jobId, "job_accepted", "completed", {
      metadata: { deviceId, kernelId: this.config.kernelId ?? "default" },
    });

    // Start a local trace (alongside Sentry) so the dashboard waterfall sees it
    const { traceId, spanId: lifecycleLocalSpanId } = startTrace(
      "job.lifecycle",
      "kernel",
      { "job.id": jobId, "job.type": stepId, "job.assurance_tier": assuranceTier },
    );
    // Store traceId on the running job so we can reference it in callbacks
    (this.runningJobs.get(jobId) as unknown as { traceId: string }).traceId = traceId;
    (this.runningJobs.get(jobId) as unknown as { lifecycleLocalSpanId: string }).lifecycleLocalSpanId = lifecycleLocalSpanId;

    // Update DB status to "executing"
    try {
      const repos = getRepos();
      repos.jobs.updateStatus(jobId, "executing", 0);
    } catch {
      // DB may not have this job yet — that's okay, the route layer inserts first
    }

    // Fire-and-forget execution — wrapped in a Sentry lifecycle span so the
    // async chain is visible as a waterfall in the Sentry trace view.
    try {
      Sentry.startSpanManual(
        {
          name: "job.lifecycle",
          op: "job.lifecycle",
          attributes: {
            "job.id": jobId,
            "job.type": stepId,
            "job.assurance_tier": assuranceTier,
          },
        },
        (lifecycleSpan) => {
          // Telemetry: job execution starting
          pipelineTelemetry.emit(jobId, "job_started", "completed", { metadata: { deviceId } });
          runner
            .run({
              jobId,
              stepId,
              gcodeHash: (gcodeHash ?? `sha256:${jobId}`) as `sha256:${string}`,
              assuranceTier: assuranceTier as 0 | 1 | 2 | 3,
              // Bridge job-runner phase events to gateway telemetry
              onPhase: (jid, phase, status, meta) => {
                pipelineTelemetry.emit(jid, phase, status, { metadata: meta });
              },
            })
            .then(async (result) => {
              this.runningJobs.delete(jobId);
              // Feed the REAL execution outcome into the safety breaker. Admission
              // used validateOnly (which records nothing), so this is the only
              // place a genuine device success/failure reaches the breaker.
              if (result.success) {
                gateway.recordDeviceSuccess(deviceId);
              } else {
                gateway.recordDeviceFailure(deviceId);
              }
              try {
                const repos = getRepos();
                if (result.success) {
                  repos.jobs.update(jobId, {
                    status: "completed",
                    progress: 100,
                    completedAt: new Date().toISOString(),
                    evidenceBundleId: result.bundleId,
                  });
                } else {
                  repos.jobs.updateStatus(jobId, "failed");
                }
              } catch {
                // DB update failure is non-fatal
              }

              // ── Evidence-to-settlement pipeline ──────────────────────────
              if (result.success) {
                const bundle = this.completedBundles.get(jobId);
                if (bundle) {
                  // Note: evidence_capture telemetry is already emitted via the
                  // onPhase callback wired into runner.run() above.
                  try {
                    const settlementService = getSettlementService();
                    const contractAddress = process.env.ESCROW_CONTRACT_ADDRESS;
                    await settlementService.processEvidence(bundle, jobId, {
                      // For tier 0 jobs, auto-release immediately (no challenge window)
                      autoRelease: assuranceTier === 0,
                      contractAddress,
                    });
                  } catch (err) {
                    // Settlement pipeline is non-fatal — the job itself succeeded
                    console.warn("[kernel-service] Settlement pipeline failed:", err instanceof Error ? err.message : err);
                  } finally {
                    // Clean up in-memory evidence data
                    this.emitter.cleanup(jobId, stepId);
                  }
                  this.completedBundles.delete(jobId);
                }
              }

              lifecycleSpan.setStatus({ code: result.success ? 1 : 2, message: result.error ?? "ok" });
              lifecycleSpan.end();
              // End local trace span
              endTrace(traceId, lifecycleLocalSpanId, result.success ? "ok" : "error");
            })
            .catch((err: unknown) => {
              this.runningJobs.delete(jobId);
              // A rejected runner.run() is a real device failure — record it.
              gateway.recordDeviceFailure(deviceId);
              try {
                const repos = getRepos();
                repos.jobs.updateStatus(jobId, "failed");
              } catch {
                // DB update failure is non-fatal
              }
              lifecycleSpan.setStatus({ code: 2, message: String(err) });
              lifecycleSpan.end();
              // End local trace span
              endTrace(traceId, lifecycleLocalSpanId, "error");
            });
        },
      );
    } catch {
      // Sentry not initialised — fall back to plain fire-and-forget
      // Telemetry: job execution starting (fallback path)
      pipelineTelemetry.emit(jobId, "job_started", "completed", { metadata: { deviceId } });
      runner
        .run({
          jobId,
          stepId,
          gcodeHash: (gcodeHash ?? `sha256:${jobId}`) as `sha256:${string}`,
          assuranceTier: assuranceTier as 0 | 1 | 2 | 3,
          // Bridge job-runner phase events to gateway telemetry (fallback path)
          onPhase: (jid, phase, status, meta) => {
            pipelineTelemetry.emit(jid, phase, status, { metadata: meta });
          },
        })
        .then(async (result) => {
          this.runningJobs.delete(jobId);
          // Feed the REAL execution outcome into the safety breaker (fallback path).
          if (result.success) {
            gateway.recordDeviceSuccess(deviceId);
          } else {
            gateway.recordDeviceFailure(deviceId);
          }
          try {
            const repos = getRepos();
            if (result.success) {
              repos.jobs.update(jobId, {
                status: "completed",
                progress: 100,
                completedAt: new Date().toISOString(),
                evidenceBundleId: result.bundleId,
              });
            } else {
              repos.jobs.updateStatus(jobId, "failed");
            }
          } catch {
            // DB update failure is non-fatal
          }

          if (result.success) {
            const bundle = this.completedBundles.get(jobId);
            if (bundle) {
              // Note: evidence_capture telemetry is already emitted via the
              // onPhase callback wired into runner.run() above.
              try {
                const settlementService = getSettlementService();
                const contractAddress = process.env.ESCROW_CONTRACT_ADDRESS;
                await settlementService.processEvidence(bundle, jobId, {
                  autoRelease: assuranceTier === 0,
                  contractAddress,
                });
              } catch (err) {
                console.warn("[kernel-service] Settlement pipeline failed:", err instanceof Error ? err.message : err);
              } finally {
                // Clean up in-memory evidence data
                this.emitter.cleanup(jobId, stepId);
              }
              this.completedBundles.delete(jobId);
            }
          }
          // End local trace span (fallback path)
          endTrace(traceId, lifecycleLocalSpanId, result.success ? "ok" : "error");
        })
        .catch(() => {
          this.runningJobs.delete(jobId);
          // A rejected runner.run() is a real device failure — record it (fallback path).
          gateway.recordDeviceFailure(deviceId);
          try {
            const repos = getRepos();
            repos.jobs.updateStatus(jobId, "failed");
          } catch {
            // DB update failure is non-fatal
          }
          // End local trace span on error (fallback path)
          endTrace(traceId, lifecycleLocalSpanId, "error");
        });
    }

    return { jobId, deviceId, status: "accepted" };
  }

  /**
   * Get the status of a job. Checks DB first, then falls back to in-memory.
   */
  async getJobStatus(jobId: string): Promise<JobStatusResult> {
    try {
      const repos = getRepos();
      const job = repos.jobs.findById(jobId);
      if (job) {
        const running = this.runningJobs.get(jobId);
        return {
          status: job.status,
          progress: job.progress,
          deviceId: running?.deviceId ?? (job.assignedDevices[0] as string | undefined),
          evidenceBundleId: job.evidenceBundleId ?? undefined,
        };
      }
    } catch {
      // fall through to in-memory
    }

    // Check in-memory only
    const running = this.runningJobs.get(jobId);
    if (running) {
      return { status: "executing", progress: 0, deviceId: running.deviceId };
    }

    return { status: "unknown", progress: 0 };
  }

  /**
   * List all devices from the kernel config with their REAL health status.
   *
   * Health is derived from the live machine adapter (getStatus()) and the
   * safety circuit-breaker state — never hardcoded. See deriveHealthStatus.
   */
  async listDevices(): Promise<DeviceInfo[]> {
    // Snapshot circuit-breaker state once (per-device command-path health).
    let circuits: Map<string, { state: string; failures: number }> | null = null;
    try {
      circuits = getSafetyGateway().getStatus().circuits as Map<
        string,
        { state: string; failures: number }
      >;
    } catch {
      // Gateway not initialised (some test paths) — fall back to adapter health.
      circuits = null;
    }

    return Promise.all(
      this.config.devices.map(async (d) => ({
        id: d.id,
        type: d.type,
        adapterType: d.adapterType,
        healthStatus: await this.deriveHealthStatus(d, circuits),
      })),
    );
  }

  /**
   * Derive a device's health from its live adapter status + circuit-breaker
   * state. Returns one of the DeviceStatusDTO healthStatus values:
   * "healthy" | "degraded" | "offline" | "unknown".
   *
   * - Machine with a running adapter: map its getStatus() (offline→offline,
   *   error/maintenance→degraded, idle/busy→healthy; a thrown/unreachable
   *   adapter→offline).
   * - Sensor/camera: "healthy" if a live adapter was constructed for the id,
   *   else "unknown".
   * - Configured machine with no running adapter: "unknown".
   *
   * A tripped (open) or recovering (half_open) breaker never reports "healthy",
   * because the gateway is refusing / tentatively testing commands to it.
   */
  private async deriveHealthStatus(
    device: { id: string; type: string },
    circuits: Map<string, { state: string; failures: number }> | null,
  ): Promise<string> {
    // 1. Physical / adapter signal.
    let adapterHealth = "unknown";
    const machine = this.machines.get(device.id);
    if (machine) {
      try {
        const status = await machine.getStatus();
        adapterHealth =
          status === "offline"
            ? "offline"
            : status === "error" || status === "maintenance"
              ? "degraded"
              : "healthy"; // idle | busy
      } catch {
        adapterHealth = "offline"; // adapter unreachable
      }
    } else if (device.type !== "machine") {
      // Sensor/camera: healthy if a live adapter was constructed for this id.
      const hasAdapter =
        this.sensors.some((s) => s.id === device.id) ||
        this.cameras.some((c) => c.id === device.id);
      adapterHealth = hasAdapter ? "healthy" : "unknown";
    }
    // else: configured machine with no running adapter → adapterHealth = "unknown".

    // 2. Circuit-breaker overlay — a tripped breaker after real failures means
    // the gateway is refusing to relay to this device; never report healthy.
    const breakerState = circuits?.get(device.id)?.state;
    if (breakerState === "open") {
      return adapterHealth === "offline" ? "offline" : "degraded";
    }
    if (breakerState === "half_open") {
      return adapterHealth === "healthy" ? "degraded" : adapterHealth;
    }

    return adapterHealth;
  }

  /**
   * Ping a device adapter for health.
   */
  async checkDeviceHealth(deviceId: string): Promise<{ healthy: boolean; details?: string }> {
    const machine = this.machines.get(deviceId);
    if (!machine) {
      return { healthy: false, details: "device_not_found" };
    }
    try {
      const status = await machine.getStatus();
      const healthy = status !== "error" && status !== "offline";
      return { healthy, details: status };
    } catch (err) {
      return {
        healthy: false,
        details: err instanceof Error ? err.message : "unknown_error",
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _kernelService: KernelService | null = null;

export function getKernelService(): KernelService {
  if (!_kernelService) {
    throw new Error("[kernel-service] Not initialised — call initKernelService() first");
  }
  return _kernelService;
}

export function initKernelService(config?: KernelConfig): KernelService {
  if (_kernelService) return _kernelService;
  _kernelService = new KernelService(config);
  return _kernelService;
}

/** Reset the singleton (for tests). */
export function resetKernelService(): void {
  _kernelService = null;
}
