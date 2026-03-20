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
import type { KernelConfig } from "@pcc/kernel";
import type { MachineAdapter } from "@pcc/kernel";
import type { EvidenceBundle } from "@pcc/spec";
import { getRepos } from "../db.js";
import { getSettlementService } from "./settlement-service.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubmitJobParams {
  jobId: string;
  stepId: string;
  deviceId?: string;
  gcodeHash?: string;
  assuranceTier?: number;
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

  constructor(config?: KernelConfig) {
    this.config = config ?? loadKernelConfig();
    this.emitter = new EvidenceEmitter(this.config.kernelId);
    this.initAdapters();
    // Cache finalized bundles so we can pass them to the settlement service
    this.emitter.onBundle((bundle) => {
      this.completedBundles.set(bundle.jobId, bundle);
    });
  }

  private initAdapters(): void {
    const adapters = createAdaptersFromConfig(this.config);
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
   */
  async submitJob(params: SubmitJobParams): Promise<{ jobId: string; deviceId: string; status: "accepted" }> {
    const { jobId, stepId, gcodeHash, assuranceTier = 0 } = params;

    const deviceId = this.selectDevice(params.deviceId);
    if (!deviceId) {
      throw new Error("no_devices_available");
    }

    const runner = this.runners.get(deviceId)!;

    // Track in-memory
    this.runningJobs.set(jobId, { jobId, deviceId, startedAt: Date.now() });

    // Update DB status to "executing"
    try {
      const repos = getRepos();
      repos.jobs.updateStatus(jobId, "executing", 0);
    } catch {
      // DB may not have this job yet — that's okay, the route layer inserts first
    }

    // Fire-and-forget execution
    runner
      .run({
        jobId,
        stepId,
        gcodeHash: (gcodeHash ?? `hash_${jobId}`) as `0x${string}`,
        assuranceTier: assuranceTier as 0 | 1 | 2 | 3,
      })
      .then(async (result) => {
        this.runningJobs.delete(jobId);
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
            try {
              const settlementService = getSettlementService();
              await settlementService.processEvidence(bundle, jobId, {
                // For tier 0 jobs, auto-release immediately (no challenge window)
                autoRelease: assuranceTier === 0,
              });
            } catch (err) {
              // Settlement pipeline is non-fatal — the job itself succeeded
              console.warn("[kernel-service] Settlement pipeline failed:", err instanceof Error ? err.message : err);
            }
            this.completedBundles.delete(jobId);
          }
        }
      })
      .catch(() => {
        this.runningJobs.delete(jobId);
        try {
          const repos = getRepos();
          repos.jobs.updateStatus(jobId, "failed");
        } catch {
          // DB update failure is non-fatal
        }
      });

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
   * List all devices that have been initialised from the kernel config.
   */
  async listDevices(): Promise<DeviceInfo[]> {
    return this.config.devices.map((d) => ({
      id: d.id,
      type: d.type,
      adapterType: d.adapterType,
      healthStatus: "healthy",
    }));
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
