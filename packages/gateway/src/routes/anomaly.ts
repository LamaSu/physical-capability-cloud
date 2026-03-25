/**
 * Anomaly reporting routes.
 *
 * POST /api/anomaly/report              — Agents report detected anomalies
 * GET  /api/anomaly/unresolved          — List unresolved anomalies (filterable)
 * GET  /api/anomaly/by-agent/:agentId   — Anomalies involving a specific agent + trust impact
 * POST /api/anomaly/:anomalyId/resolve  — Mark an anomaly as resolved
 * GET  /api/anomaly/stats               — Aggregate anomaly statistics
 * POST /api/anomaly/protocol-failure    — Specialized endpoint for protocol failures
 */

import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AnomalySeverity = "info" | "warning" | "critical";

type AnomalyCategory =
  | "protocol_failure"
  | "evidence_mismatch"
  | "consensus_failure"
  | "timeout"
  | "rate_anomaly"
  | "trust_violation";

type RecoveryAction = "retry" | "escalate" | "rollback" | "ignore";

export interface AnomalyReport {
  anomalyId: string;
  severity: AnomalySeverity;
  category: AnomalyCategory;
  description: string;
  targetAgentId?: string;
  jobId?: string;
  evidence?: unknown;
  resolved: boolean;
  resolution?: string;
  createdAt: string;
  resolvedAt?: string;
  /** For protocol-failure reports */
  protocolFailureDetails?: {
    protocol: string;
    errorCode: string;
    errorMessage: string;
    involvedAgents: string[];
    recoveryAction?: RecoveryAction;
    autoRecovery: boolean;
  };
}

// ---------------------------------------------------------------------------
// In-memory store (same pattern as other gateway routes)
// ---------------------------------------------------------------------------

const anomalyStore = new Map<string, AnomalyReport>();

function generateAnomalyId(): string {
  return `anomaly_${randomBytes(10).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Determines whether a protocol failure can be auto-recovered. */
function canAutoRecover(
  protocol: string,
  recoveryAction?: RecoveryAction,
): boolean {
  if (recoveryAction === "retry") return true;
  if (recoveryAction === "rollback") return true;
  // Escrow releases and evidence submissions can be retried automatically
  if (protocol === "evidence_submission") return true;
  if (protocol === "escrow_release") return true;
  return false;
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export async function anomalyRoutes(app: FastifyInstance) {
  /**
   * POST /api/anomaly/report
   *
   * Body: { severity, category, description, targetAgentId?, jobId?, evidence? }
   *
   * Records an anomaly detected by any agent or kernel on the network.
   * Returns: { anomalyId, received: true }
   */
  app.post("/api/anomaly/report", async (req, reply) => {
    const body = req.body as {
      severity?: string;
      category?: string;
      description?: string;
      targetAgentId?: string;
      jobId?: string;
      evidence?: unknown;
    };

    if (!body?.severity || !body.category || !body.description) {
      return reply.status(400).send({
        error: "missing_required_fields",
        message: "severity, category, and description are required",
      });
    }

    const validSeverities: AnomalySeverity[] = ["info", "warning", "critical"];
    if (!validSeverities.includes(body.severity as AnomalySeverity)) {
      return reply.status(400).send({
        error: "invalid_severity",
        message: `severity must be one of: ${validSeverities.join(", ")}`,
      });
    }

    const validCategories: AnomalyCategory[] = [
      "protocol_failure",
      "evidence_mismatch",
      "consensus_failure",
      "timeout",
      "rate_anomaly",
      "trust_violation",
    ];
    if (!validCategories.includes(body.category as AnomalyCategory)) {
      return reply.status(400).send({
        error: "invalid_category",
        message: `category must be one of: ${validCategories.join(", ")}`,
      });
    }

    const anomalyId = generateAnomalyId();
    const now = new Date().toISOString();

    const report: AnomalyReport = {
      anomalyId,
      severity: body.severity as AnomalySeverity,
      category: body.category as AnomalyCategory,
      description: body.description,
      targetAgentId: body.targetAgentId,
      jobId: body.jobId,
      evidence: body.evidence,
      resolved: false,
      createdAt: now,
    };

    anomalyStore.set(anomalyId, report);

    return { anomalyId, received: true };
  });

  /**
   * GET /api/anomaly/unresolved
   *
   * Query: ?severity=critical&category=protocol_failure&targetId=xxx
   *
   * Lists all unresolved anomalies, with optional filters.
   * Returns: { anomalies: AnomalyReport[] }
   */
  app.get("/api/anomaly/unresolved", async (req) => {
    const query = req.query as Record<string, string>;
    const { severity, category, targetId } = query;

    const results: AnomalyReport[] = [];

    for (const report of anomalyStore.values()) {
      if (report.resolved) continue;
      if (severity && report.severity !== severity) continue;
      if (category && report.category !== category) continue;
      if (targetId && report.targetAgentId !== targetId) continue;
      results.push(report);
    }

    // Newest first
    results.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    return { anomalies: results, count: results.length };
  });

  /**
   * GET /api/anomaly/by-agent/:agentId
   *
   * Returns anomalies where targetAgentId matches, plus a trust impact assessment.
   * Returns: { anomalies: AnomalyReport[], trustImpact: { anomalyCount, shouldDowngrade } }
   */
  app.get<{ Params: { agentId: string } }>(
    "/api/anomaly/by-agent/:agentId",
    async (req) => {
      const { agentId } = req.params;

      const anomalies: AnomalyReport[] = [];

      for (const report of anomalyStore.values()) {
        if (report.targetAgentId === agentId) {
          anomalies.push(report);
        }
      }

      // Newest first
      anomalies.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );

      // Trust impact assessment
      const unresolvedCritical = anomalies.filter(
        (a) => !a.resolved && a.severity === "critical",
      ).length;
      const unresolvedWarning = anomalies.filter(
        (a) => !a.resolved && a.severity === "warning",
      ).length;

      const shouldDowngrade = unresolvedCritical >= 1 || unresolvedWarning >= 3;

      return {
        anomalies,
        trustImpact: {
          anomalyCount: anomalies.length,
          unresolvedCount: anomalies.filter((a) => !a.resolved).length,
          unresolvedCritical,
          unresolvedWarning,
          shouldDowngrade,
        },
      };
    },
  );

  /**
   * POST /api/anomaly/:anomalyId/resolve
   *
   * Body: { resolution: string }
   *
   * Marks an anomaly as resolved with a resolution note.
   * Returns: { resolved: true }
   */
  app.post<{ Params: { anomalyId: string } }>(
    "/api/anomaly/:anomalyId/resolve",
    async (req, reply) => {
      // Guard static routes
      if (
        req.params.anomalyId === "report" ||
        req.params.anomalyId === "stats" ||
        req.params.anomalyId === "unresolved" ||
        req.params.anomalyId === "protocol-failure" ||
        req.params.anomalyId === "by-agent"
      ) {
        return reply.status(404).send({ error: "not_found" });
      }

      const { anomalyId } = req.params;
      const body = req.body as { resolution?: string };

      if (!body?.resolution) {
        return reply.status(400).send({
          error: "missing_required_fields",
          message: "resolution is required",
        });
      }

      const report = anomalyStore.get(anomalyId);
      if (!report) {
        return reply.status(404).send({ error: "not_found", anomalyId });
      }

      if (report.resolved) {
        return reply.status(409).send({
          error: "already_resolved",
          message: `Anomaly ${anomalyId} is already resolved`,
          resolvedAt: report.resolvedAt,
        });
      }

      const now = new Date().toISOString();
      report.resolved = true;
      report.resolution = body.resolution;
      report.resolvedAt = now;
      anomalyStore.set(anomalyId, report);

      return { resolved: true, anomalyId, resolvedAt: now };
    },
  );

  /**
   * GET /api/anomaly/stats
   *
   * Returns aggregate anomaly statistics.
   * Returns: { total, unresolved, bySeverity, byCategory }
   */
  app.get("/api/anomaly/stats", async () => {
    const all = Array.from(anomalyStore.values());

    const bySeverity: Record<AnomalySeverity, number> = {
      info: 0,
      warning: 0,
      critical: 0,
    };

    const byCategory: Record<AnomalyCategory, number> = {
      protocol_failure: 0,
      evidence_mismatch: 0,
      consensus_failure: 0,
      timeout: 0,
      rate_anomaly: 0,
      trust_violation: 0,
    };

    let unresolved = 0;

    for (const report of all) {
      bySeverity[report.severity] = (bySeverity[report.severity] ?? 0) + 1;
      byCategory[report.category] = (byCategory[report.category] ?? 0) + 1;
      if (!report.resolved) unresolved++;
    }

    return {
      total: all.length,
      unresolved,
      resolved: all.length - unresolved,
      bySeverity,
      byCategory,
    };
  });

  /**
   * POST /api/anomaly/protocol-failure
   *
   * Body: { protocol, errorCode, errorMessage, involvedAgents, jobId?, recoveryAction? }
   *
   * Specialized endpoint for protocol-layer failures. Determines if auto-recovery
   * is possible and emits a structured anomaly report.
   * Returns: { anomalyId, autoRecovery: boolean }
   */
  app.post("/api/anomaly/protocol-failure", async (req, reply) => {
    const body = req.body as {
      protocol?: string;
      errorCode?: string;
      errorMessage?: string;
      involvedAgents?: string[];
      jobId?: string;
      recoveryAction?: string;
    };

    if (
      !body?.protocol ||
      !body.errorCode ||
      !body.errorMessage ||
      !body.involvedAgents
    ) {
      return reply.status(400).send({
        error: "missing_required_fields",
        message:
          "protocol, errorCode, errorMessage, and involvedAgents are required",
      });
    }

    const validProtocols = [
      "evidence_submission",
      "escrow_release",
      "verification_consensus",
      "settlement",
    ];
    if (!validProtocols.includes(body.protocol)) {
      return reply.status(400).send({
        error: "invalid_protocol",
        message: `protocol must be one of: ${validProtocols.join(", ")}`,
      });
    }

    const validRecoveryActions: RecoveryAction[] = [
      "retry",
      "escalate",
      "rollback",
      "ignore",
    ];
    if (
      body.recoveryAction &&
      !validRecoveryActions.includes(body.recoveryAction as RecoveryAction)
    ) {
      return reply.status(400).send({
        error: "invalid_recovery_action",
        message: `recoveryAction must be one of: ${validRecoveryActions.join(", ")}`,
      });
    }

    const autoRecovery = canAutoRecover(
      body.protocol,
      body.recoveryAction as RecoveryAction | undefined,
    );

    // Protocol failures are always at least "warning" severity;
    // settlement and verification consensus failures are "critical"
    const severity: AnomalySeverity =
      body.protocol === "settlement" ||
      body.protocol === "verification_consensus"
        ? "critical"
        : "warning";

    const anomalyId = generateAnomalyId();
    const now = new Date().toISOString();

    const description = `Protocol failure in ${body.protocol}: [${body.errorCode}] ${body.errorMessage}`;

    const report: AnomalyReport = {
      anomalyId,
      severity,
      category: "protocol_failure",
      description,
      targetAgentId: body.involvedAgents[0],
      jobId: body.jobId,
      resolved: false,
      createdAt: now,
      protocolFailureDetails: {
        protocol: body.protocol,
        errorCode: body.errorCode,
        errorMessage: body.errorMessage,
        involvedAgents: body.involvedAgents,
        recoveryAction: body.recoveryAction as RecoveryAction | undefined,
        autoRecovery,
      },
    };

    anomalyStore.set(anomalyId, report);

    return { anomalyId, autoRecovery, severity, createdAt: now };
  });
}
