/**
 * TelemetryCollector — Gathers real-time state from kernel agents on the network.
 *
 * Periodically pings kernel agents via A2A text_message intents to collect
 * telemetry: adapter status, job counts, evidence bundles, error logs.
 */

import type { A2AMessage } from "@pcc/a2a";

export interface KernelTelemetry {
  kernelId: string;
  agentId: string;
  lastSeen: string;
  status: "online" | "degraded" | "offline";
  capabilities: string[];
  activeJobs: number;
  completedJobs: number;
  failedJobs: number;
  evidenceBundles: number;
  queueDepth: number;
  adapterStatuses: Array<{ id: string; type: string; status: string; errorCount: number }>;
  recentErrors: Array<{ timestamp: string; message: string; source: string }>;
  uptimeMs: number;
}

export interface TelemetrySnapshot {
  timestamp: string;
  kernels: KernelTelemetry[];
  totalOnline: number;
  totalDegraded: number;
  totalOffline: number;
  totalActiveJobs: number;
  networkHealth: "healthy" | "degraded" | "critical";
}

export class TelemetryCollector {
  private kernels: Map<string, KernelTelemetry> = new Map();
  private offlineThresholdMs: number;

  constructor(offlineThresholdMs = 60_000) {
    this.offlineThresholdMs = offlineThresholdMs;
  }

  /** Process a telemetry report from a kernel agent */
  ingest(agentId: string, data: Partial<KernelTelemetry>): void {
    const existing = this.kernels.get(agentId) ?? {
      kernelId: data.kernelId ?? agentId,
      agentId,
      lastSeen: new Date().toISOString(),
      status: "online" as const,
      capabilities: [],
      activeJobs: 0,
      completedJobs: 0,
      failedJobs: 0,
      evidenceBundles: 0,
      queueDepth: 0,
      adapterStatuses: [],
      recentErrors: [],
      uptimeMs: 0,
    };

    const updated: KernelTelemetry = {
      ...existing,
      ...data,
      agentId,
      lastSeen: new Date().toISOString(),
    };

    // Determine status based on adapter health
    const failedAdapters = updated.adapterStatuses.filter(
      a => a.status === "error" || a.status === "offline"
    );
    if (failedAdapters.length > 0 && failedAdapters.length < updated.adapterStatuses.length) {
      updated.status = "degraded";
    } else if (failedAdapters.length === updated.adapterStatuses.length && updated.adapterStatuses.length > 0) {
      updated.status = "offline";
    } else {
      updated.status = "online";
    }

    this.kernels.set(agentId, updated);
  }

  /** Process an A2A message that might contain telemetry */
  processMessage(message: A2AMessage): void {
    if (message.intent.type === "text_message") {
      const text = (message.intent as any).text as string;
      // Parse structured telemetry from kernel status responses
      if (text.includes("capabilities:") || text.includes("queue depth:")) {
        // Simple parsing — kernel agents send status as text
        this.ingest(message.from, {
          kernelId: message.from,
          lastSeen: message.timestamp,
        });
      }
    }

    if (message.intent.type === "job_completed") {
      const intent = message.intent as any;
      const existing = this.kernels.get(message.from);
      if (existing) {
        this.ingest(message.from, {
          completedJobs: existing.completedJobs + 1,
          evidenceBundles: existing.evidenceBundles + (intent.evidenceBundleHash ? 1 : 0),
        });
      }
    }

    if (message.intent.type === "error") {
      const intent = message.intent as any;
      const existing = this.kernels.get(message.from);
      if (existing) {
        const errors = [...existing.recentErrors.slice(-9), {
          timestamp: message.timestamp,
          message: intent.message ?? "Unknown error",
          source: message.from,
        }];
        this.ingest(message.from, { recentErrors: errors });
      }
    }
  }

  /** Mark kernels as offline if not seen recently */
  checkTimeouts(): void {
    const now = Date.now();
    for (const [id, kernel] of this.kernels) {
      const lastSeen = new Date(kernel.lastSeen).getTime();
      if (now - lastSeen > this.offlineThresholdMs && kernel.status !== "offline") {
        kernel.status = "offline";
      }
    }
  }

  /** Get current snapshot of all kernel telemetry */
  snapshot(): TelemetrySnapshot {
    this.checkTimeouts();

    const kernels = [...this.kernels.values()];
    const totalOnline = kernels.filter(k => k.status === "online").length;
    const totalDegraded = kernels.filter(k => k.status === "degraded").length;
    const totalOffline = kernels.filter(k => k.status === "offline").length;
    const totalActiveJobs = kernels.reduce((sum, k) => sum + k.activeJobs, 0);

    let networkHealth: "healthy" | "degraded" | "critical";
    if (totalOffline === 0 && totalDegraded === 0) {
      networkHealth = "healthy";
    } else if (totalOffline > kernels.length / 2) {
      networkHealth = "critical";
    } else {
      networkHealth = "degraded";
    }

    return {
      timestamp: new Date().toISOString(),
      kernels,
      totalOnline,
      totalDegraded,
      totalOffline,
      totalActiveJobs,
      networkHealth,
    };
  }

  /** Get telemetry for a specific kernel */
  getKernel(agentId: string): KernelTelemetry | undefined {
    return this.kernels.get(agentId);
  }

  /** Remove a kernel from tracking */
  removeKernel(agentId: string): void {
    this.kernels.delete(agentId);
  }
}
