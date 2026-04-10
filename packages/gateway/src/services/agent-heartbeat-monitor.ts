/**
 * AgentHeartbeatMonitor — OWASP ASI10 (Unbounded Agent Execution) Mitigation
 *
 * Tracks liveness of all registered agents in the gateway. Agents are expected
 * to call POST /api/agents/heartbeat periodically. If an agent goes silent:
 *
 *   - suspicious (>= suspiciousThreshold missed beats): severity "warning" broadcast
 *   - rogue      (>= rogueThreshold     missed beats): severity "critical" broadcast,
 *                                                       scope suspension, bus unregister
 *
 * This runs entirely at the gateway layer. Do NOT wire it into SafetyGovernor.
 * The governor hears about rogues via the anomaly broadcast (onAnomaly fan-out).
 */

import type { MessageBus } from "@pcc/a2a";
import type { AgentCard, AgentRole } from "@pcc/a2a";
import type { AnomalyDetectedIntent, SystemAlertIntent } from "@pcc/a2a";
import { auditService } from "./audit-service.js";
import { getStore } from "../db.js";
import { sql } from "@pcc/store";

// ── Exported constants ────────────────────────────────────────────────────────

/**
 * How often (ms) the monitor checks all agents.
 * Default: 30 000 ms (30 s) — half the expected heartbeat cadence.
 */
export const DEFAULT_CHECK_INTERVAL_MS = 30_000;

/**
 * Missed-beat count at which an agent is flagged suspicious.
 * Default: 3 (= 90 s silence at 30 s check interval)
 */
export const DEFAULT_SUSPICIOUS_THRESHOLD = 3;

/**
 * Missed-beat count at which an agent is flagged rogue.
 * Default: 5 (= 150 s silence)
 */
export const DEFAULT_ROGUE_THRESHOLD = 5;

// ── Types ─────────────────────────────────────────────────────────────────────

export type AgentHealthStatus = "healthy" | "suspicious" | "rogue" | "suspended";

export interface AgentHeartbeatRecord {
  agentId: string;
  agentName: string;
  agentRole: AgentRole;
  /** Date.now() ms — updated on every recordHeartbeat() call */
  lastHeartbeat: number;
  /** Consecutive missed beats since last heartbeat (recalculated each tick) */
  missedBeats: number;
  /** Current health state */
  status: AgentHealthStatus;
  /** When monitor.registerAgent() was called (ms) */
  registeredAt: number;
  /** How many active scopes were suspended on rogue designation (if any) */
  scopesSuspended?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function makeConversationId(): string {
  return `conv_hb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function makeMessageId(): string {
  return `msg_hb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// ── AgentHeartbeatMonitor ─────────────────────────────────────────────────────

export class AgentHeartbeatMonitor {
  private readonly records = new Map<string, AgentHeartbeatRecord>();
  private ticker: ReturnType<typeof setInterval> | null = null;

  /**
   * Optional callback fired when an agent is designated rogue.
   * Receives the agentId (DID string). Used by agent-bridge to revoke
   * all facade sessions for the rogue agent (RBAC cleanup).
   */
  onRogue?: (agentId: string) => void;

  constructor(
    private readonly bus: MessageBus,
    private readonly checkIntervalMs: number = DEFAULT_CHECK_INTERVAL_MS,
    private readonly suspiciousThreshold: number = DEFAULT_SUSPICIOUS_THRESHOLD,
    private readonly rogueThreshold: number = DEFAULT_ROGUE_THRESHOLD,
  ) {}

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Start the periodic liveness check loop.
   * Safe to call multiple times — subsequent calls are no-ops if already started.
   */
  start(): void {
    if (this.ticker !== null) return;
    this.ticker = setInterval(() => {
      try {
        this._check();
      } catch (err) {
        // Monitor failure must never crash the gateway
        console.error("[heartbeat-monitor] Tick error:", err);
      }
    }, this.checkIntervalMs);
    console.log(
      `[heartbeat-monitor] Started (interval=${this.checkIntervalMs}ms, ` +
      `suspicious>=${this.suspiciousThreshold}, rogue>=${this.rogueThreshold})`,
    );
  }

  /**
   * Stop the liveness check loop.
   */
  stop(): void {
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
      console.log("[heartbeat-monitor] Stopped");
    }
  }

  // ── Agent registry ──────────────────────────────────────────────────────────

  /**
   * Begin tracking an agent. Idempotent — re-registering resets the record.
   */
  registerAgent(card: AgentCard): void {
    const now = Date.now();
    this.records.set(card.id, {
      agentId: card.id,
      agentName: card.name,
      agentRole: card.role,
      lastHeartbeat: now,
      missedBeats: 0,
      status: "healthy",
      registeredAt: now,
    });
    console.log(`[heartbeat-monitor] Registered agent: ${card.id} (${card.name})`);
  }

  /**
   * Update the agent's last-seen timestamp. Called by the heartbeat route handler.
   * If the agent was suspended, refuse to reset (requires operator re-activation).
   */
  recordHeartbeat(agentId: string): boolean {
    const record = this.records.get(agentId);
    if (!record) return false;

    // Suspended agents cannot self-recover via heartbeat — operator must re-activate
    if (record.status === "suspended") return false;

    record.lastHeartbeat = Date.now();
    record.missedBeats = 0;

    // Allow recovery from suspicious → healthy
    if (record.status === "suspicious") {
      record.status = "healthy";
      console.log(`[heartbeat-monitor] Agent ${agentId} recovered (suspicious → healthy)`);
    }

    return true;
  }

  /**
   * Remove an agent from monitoring.
   */
  unregisterAgent(agentId: string): void {
    this.records.delete(agentId);
    console.log(`[heartbeat-monitor] Unregistered agent: ${agentId}`);
  }

  /**
   * Return a snapshot of all agent health records.
   * Returns a copy — callers cannot mutate internal state.
   */
  getStatus(): AgentHeartbeatRecord[] {
    return Array.from(this.records.values()).map((r) => ({ ...r }));
  }

  // ── Tick logic ──────────────────────────────────────────────────────────────

  /**
   * Periodic liveness check. Called every checkIntervalMs.
   * Classifies each agent, transitions states, and fires alerts.
   */
  private _check(): void {
    const now = Date.now();

    for (const [agentId, record] of this.records) {
      // Suspended agents stay suspended until operator action
      if (record.status === "suspended") continue;

      const silenceMs = now - record.lastHeartbeat;
      const missed = Math.floor(silenceMs / this.checkIntervalMs);
      record.missedBeats = missed;

      if (missed >= this.rogueThreshold && record.status !== "rogue") {
        // --- ROGUE ---
        record.status = "rogue";
        console.warn(`[heartbeat-monitor] Agent ${agentId} is ROGUE (missed=${missed})`);

        // Broadcast critical anomaly (fire-and-forget)
        this._broadcastAnomaly(record, "critical", "trust_violation");

        // Audit — rogue designation
        auditService.log({
          eventType: "agent_rogue_detected",
          actor: agentId,
          resourceType: "agent",
          resourceId: agentId,
          action: "rogue_detected",
          metadata: {
            missedBeats: missed,
            lastSeen: new Date(record.lastHeartbeat).toISOString(),
            silenceMs,
          },
        });

        // Revoke all facade sessions for this agent (RBAC cleanup)
        // Fire-and-forget — failure must not crash the monitor tick
        try {
          if (this.onRogue) this.onRogue(agentId);
        } catch (cbErr) {
          console.error(`[heartbeat-monitor] onRogue callback failed for ${agentId}:`, cbErr);
        }

        // Suspend active scopes (async, fire-and-forget — failure is non-fatal)
        this._suspendScopes(agentId).then((count) => {
          record.status = "suspended";
          record.scopesSuspended = count;
          console.log(`[heartbeat-monitor] Agent ${agentId} → suspended, ${count} scopes revoked`);

          auditService.log({
            eventType: "agent_scope_suspended",
            actor: "heartbeat-monitor",
            resourceType: "agent",
            resourceId: agentId,
            action: "scopes_suspended",
            metadata: { scopesSuspended: count, agentId },
          });
        }).catch((err) => {
          console.error(`[heartbeat-monitor] Scope suspension failed for ${agentId}:`, err);
          // Even if scope suspension fails, keep agent as rogue (not suspended)
          // The anomaly is already broadcast — downstream handlers can act
        });

        // Unregister from bus so rogue can't send more messages
        try {
          this.bus.unregister(agentId);
        } catch (err) {
          console.error(`[heartbeat-monitor] Bus unregister failed for ${agentId}:`, err);
        }

      } else if (missed >= this.suspiciousThreshold && record.status === "healthy") {
        // --- SUSPICIOUS ---
        record.status = "suspicious";
        console.warn(`[heartbeat-monitor] Agent ${agentId} is SUSPICIOUS (missed=${missed})`);

        // Broadcast warning-level system alert
        this._broadcastSystemAlert(record, missed);

        // Audit — heartbeat missed
        auditService.log({
          eventType: "agent_heartbeat_missed",
          actor: agentId,
          resourceType: "agent",
          resourceId: agentId,
          action: "heartbeat_missed",
          metadata: {
            missedBeats: missed,
            lastSeen: new Date(record.lastHeartbeat).toISOString(),
            silenceMs,
          },
        });

      } else if (missed < this.suspiciousThreshold && record.status === "suspicious") {
        // --- RECOVERED ---
        record.status = "healthy";
        console.log(`[heartbeat-monitor] Agent ${agentId} recovered (suspicious → healthy via tick)`);
      }
    }
  }

  // ── Broadcast helpers ───────────────────────────────────────────────────────

  private _broadcastAnomaly(
    record: AgentHeartbeatRecord,
    severity: "warning" | "critical",
    category: AnomalyDetectedIntent["category"],
  ): void {
    const intent: AnomalyDetectedIntent = {
      type: "anomaly_detected",
      severity,
      category,
      sourceAgentId: "heartbeat-monitor",
      targetAgentId: record.agentId,
      description:
        `Agent ${record.agentName} (${record.agentId}) has missed ${record.missedBeats} heartbeats ` +
        `and has been designated ROGUE. Execution scopes are being revoked.`,
      evidence: {
        timestamp: nowIso(),
        actualValue: `${record.missedBeats} missed beats`,
        expectedValue: `< ${this.rogueThreshold} missed beats`,
      },
    };

    // Send as a bus message so it hits the anomaly fan-out
    this.bus.broadcast(
      {
        id: makeMessageId(),
        conversationId: makeConversationId(),
        from: "heartbeat-monitor",
        to: "heartbeat-monitor", // broadcast ignores `to`
        intent,
        timestamp: nowIso(),
      },
    ).catch((err) => {
      console.error("[heartbeat-monitor] Anomaly broadcast failed:", err);
    });
  }

  private _broadcastSystemAlert(record: AgentHeartbeatRecord, missed: number): void {
    const intent: SystemAlertIntent = {
      type: "system_alert",
      alertType: "node_offline",
      severity: "warning",
      message:
        `Agent ${record.agentName} (${record.agentId}) has missed ${missed} heartbeats ` +
        `and is now considered SUSPICIOUS. Will escalate to ROGUE at ${this.rogueThreshold} missed beats.`,
      metadata: {
        agentId: record.agentId,
        agentName: record.agentName,
        agentRole: record.agentRole,
        missedBeats: missed,
        lastSeen: new Date(record.lastHeartbeat).toISOString(),
        suspiciousThreshold: this.suspiciousThreshold,
        rogueThreshold: this.rogueThreshold,
      },
      autoResolves: true,
      resolveTimeoutMs: this.rogueThreshold * this.checkIntervalMs,
    };

    this.bus.broadcast(
      {
        id: makeMessageId(),
        conversationId: makeConversationId(),
        from: "heartbeat-monitor",
        to: "heartbeat-monitor",
        intent,
        timestamp: nowIso(),
      },
    ).catch((err) => {
      console.error("[heartbeat-monitor] System alert broadcast failed:", err);
    });
  }

  // ── Scope suspension ────────────────────────────────────────────────────────

  /**
   * Bulk-revoke all active execution scopes created by a rogue agent.
   * Best-effort: logs and returns 0 on DB failure rather than throwing.
   */
  private async _suspendScopes(agentId: string): Promise<number> {
    try {
      const store = getStore();
      // Use raw SQL — execution_scopes is managed directly via DDL in ot2-scope.ts
      const result = store.db.run(
        sql`UPDATE execution_scopes
            SET status = 'suspended_rogue'
            WHERE created_by = ${agentId}
              AND status = 'active'`,
      );
      // Drizzle's run() returns a RunResult with changes count
      return (result as unknown as { changes: number }).changes ?? 0;
    } catch (err) {
      console.error(`[heartbeat-monitor] DB scope suspension failed for ${agentId}:`, err);
      return 0;
    }
  }
}
