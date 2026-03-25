/**
 * Tests for anomaly detection A2A intent types and MessageBus anomaly broadcast.
 *
 * Covers:
 *   - All 4 anomaly intent types can be constructed and type-narrow correctly
 *   - AnomalyDetectedIntent broadcasts to all anomaly listeners via onAnomaly()
 *   - ProtocolFailureIntent broadcasts to all anomaly listeners
 *   - SystemAlertIntent with autoResolves=true broadcasts correctly
 *   - TrustDowngradeIntent is delivered point-to-point to the target agent
 *   - Multiple anomaly listeners all receive the same event
 *   - Normal (non-anomaly) intents do NOT trigger anomaly listeners
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MessageBus } from "../message-bus.js";
import type {
  AgentCard,
  A2AMessage,
  Intent,
  AnomalyDetectedIntent,
  ProtocolFailureIntent,
  TrustDowngradeIntent,
  SystemAlertIntent,
} from "../types.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeCard(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    id: `agent_${Math.random().toString(36).slice(2, 8)}`,
    name: "Test Agent",
    role: "user",
    walletAddress: "0x0000000000000000000000000000000000000001",
    capabilities: [],
    endpoint: "agent://test",
    description: "test agent",
    supportedIntents: [],
    publicKey: "0xpub",
    ...overrides,
  };
}

function makeMessage(
  intent: Intent,
  overrides: Partial<A2AMessage> = {},
): A2AMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 8)}`,
    conversationId: `conv_${Math.random().toString(36).slice(2, 8)}`,
    from: "agent_monitor",
    to: "agent_arbiter",
    intent,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ── Type guard helpers ────────────────────────────────────────────

function isAnomalyDetected(intent: Intent): intent is AnomalyDetectedIntent {
  return intent.type === "anomaly_detected";
}

function isProtocolFailure(intent: Intent): intent is ProtocolFailureIntent {
  return intent.type === "protocol_failure";
}

function isTrustDowngrade(intent: Intent): intent is TrustDowngradeIntent {
  return intent.type === "trust_downgrade";
}

function isSystemAlert(intent: Intent): intent is SystemAlertIntent {
  return intent.type === "system_alert";
}

// ── Intent Construction Tests ─────────────────────────────────────

describe("Anomaly Intent Types — construction", () => {
  // anomaly_detected

  it("constructs anomaly_detected with required fields", () => {
    const intent: AnomalyDetectedIntent = {
      type: "anomaly_detected",
      severity: "critical",
      category: "evidence_mismatch",
      sourceAgentId: "agent_verifier_001",
      description: "Evidence bundle hash mismatch detected",
      evidence: {
        jobId: "job_abc123",
        bundleHash: "sha256:deadbeef",
        expectedValue: "0xexpected",
        actualValue: "0xactual",
        timestamp: "2026-03-24T10:00:00Z",
      },
    };

    expect(intent.type).toBe("anomaly_detected");
    expect(intent.severity).toBe("critical");
    expect(intent.category).toBe("evidence_mismatch");
    expect(intent.sourceAgentId).toBe("agent_verifier_001");
    expect(intent.targetAgentId).toBeUndefined();
    expect(intent.evidence.jobId).toBe("job_abc123");
    expect(intent.evidence.bundleHash).toBe("sha256:deadbeef");
  });

  it("constructs anomaly_detected with optional targetAgentId", () => {
    const intent: AnomalyDetectedIntent = {
      type: "anomaly_detected",
      severity: "warning",
      category: "trust_violation",
      sourceAgentId: "agent_monitor_001",
      targetAgentId: "agent_kernel_suspect",
      description: "Kernel agent exceeded rate limit",
      evidence: {
        timestamp: "2026-03-24T10:05:00Z",
      },
    };

    expect(intent.targetAgentId).toBe("agent_kernel_suspect");
    expect(intent.severity).toBe("warning");
  });

  it("constructs anomaly_detected with all severity levels", () => {
    const levels: Array<AnomalyDetectedIntent["severity"]> = ["info", "warning", "critical"];
    for (const severity of levels) {
      const intent: AnomalyDetectedIntent = {
        type: "anomaly_detected",
        severity,
        category: "timeout",
        sourceAgentId: "agent_watchdog",
        description: `Severity ${severity} test`,
        evidence: { timestamp: new Date().toISOString() },
      };
      expect(intent.severity).toBe(severity);
    }
  });

  it("constructs anomaly_detected with all category values", () => {
    const categories: Array<AnomalyDetectedIntent["category"]> = [
      "protocol_failure",
      "evidence_mismatch",
      "consensus_failure",
      "timeout",
      "rate_anomaly",
      "trust_violation",
    ];
    for (const category of categories) {
      const intent: AnomalyDetectedIntent = {
        type: "anomaly_detected",
        severity: "info",
        category,
        sourceAgentId: "agent_watchdog",
        description: `Category ${category}`,
        evidence: { timestamp: new Date().toISOString() },
      };
      expect(intent.category).toBe(category);
    }
  });

  it("narrows anomaly_detected from Intent union", () => {
    const intent: Intent = {
      type: "anomaly_detected",
      severity: "warning",
      category: "rate_anomaly",
      sourceAgentId: "agent_sentinel",
      description: "Unusual rate spike detected",
      evidence: { timestamp: "2026-03-24T11:00:00Z" },
    };
    expect(isAnomalyDetected(intent)).toBe(true);
    if (isAnomalyDetected(intent)) {
      expect(intent.category).toBe("rate_anomaly");
    }
  });

  // protocol_failure

  it("constructs protocol_failure with required fields", () => {
    const intent: ProtocolFailureIntent = {
      type: "protocol_failure",
      failedProtocol: "evidence_submission",
      errorCode: "EVIDENCE_MISSING",
      errorMessage: "No evidence bundle submitted within deadline",
      involvedAgents: ["agent_kernel_001", "agent_verifier_001"],
      jobId: "job_xyz789",
      recoveryAction: "escalate",
    };

    expect(intent.type).toBe("protocol_failure");
    expect(intent.failedProtocol).toBe("evidence_submission");
    expect(intent.errorCode).toBe("EVIDENCE_MISSING");
    expect(intent.involvedAgents).toHaveLength(2);
    expect(intent.jobId).toBe("job_xyz789");
    expect(intent.recoveryAction).toBe("escalate");
  });

  it("constructs protocol_failure without optional fields", () => {
    const intent: ProtocolFailureIntent = {
      type: "protocol_failure",
      failedProtocol: "escrow_release",
      errorCode: "TIMEOUT",
      errorMessage: "Escrow release timed out",
      involvedAgents: ["agent_scheduler"],
    };

    expect(intent.jobId).toBeUndefined();
    expect(intent.recoveryAction).toBeUndefined();
    expect(intent.involvedAgents).toHaveLength(1);
  });

  it("constructs protocol_failure with all recovery actions", () => {
    const actions: Array<ProtocolFailureIntent["recoveryAction"]> = [
      "retry",
      "escalate",
      "rollback",
      "ignore",
    ];
    for (const action of actions) {
      const intent: ProtocolFailureIntent = {
        type: "protocol_failure",
        failedProtocol: "verification_consensus",
        errorCode: "CONSENSUS_FAILED",
        errorMessage: `Recovery test: ${action}`,
        involvedAgents: [],
        recoveryAction: action,
      };
      expect(intent.recoveryAction).toBe(action);
    }
  });

  it("narrows protocol_failure from Intent union", () => {
    const intent: Intent = {
      type: "protocol_failure",
      failedProtocol: "verification_consensus",
      errorCode: "QUORUM_NOT_REACHED",
      errorMessage: "Verifiers failed to reach consensus",
      involvedAgents: ["agent_v1", "agent_v2"],
    };
    expect(isProtocolFailure(intent)).toBe(true);
    if (isProtocolFailure(intent)) {
      expect(intent.failedProtocol).toBe("verification_consensus");
    }
  });

  // trust_downgrade

  it("constructs trust_downgrade with all required fields", () => {
    const intent: TrustDowngradeIntent = {
      type: "trust_downgrade",
      targetAgentId: "agent_kernel_bad",
      previousTrustScore: 0.85,
      newTrustScore: 0.40,
      reason: "Repeated evidence mismatch over 3 jobs",
      evidence: ["anomaly_001", "anomaly_002", "anomaly_003"],
    };

    expect(intent.type).toBe("trust_downgrade");
    expect(intent.targetAgentId).toBe("agent_kernel_bad");
    expect(intent.previousTrustScore).toBe(0.85);
    expect(intent.newTrustScore).toBe(0.40);
    expect(intent.evidence).toHaveLength(3);
  });

  it("constructs trust_downgrade with empty evidence list", () => {
    const intent: TrustDowngradeIntent = {
      type: "trust_downgrade",
      targetAgentId: "agent_kernel_003",
      previousTrustScore: 0.9,
      newTrustScore: 0.7,
      reason: "Manual admin downgrade",
      evidence: [],
    };

    expect(intent.evidence).toHaveLength(0);
    expect(intent.newTrustScore).toBeLessThan(intent.previousTrustScore);
  });

  it("narrows trust_downgrade from Intent union", () => {
    const intent: Intent = {
      type: "trust_downgrade",
      targetAgentId: "agent_x",
      previousTrustScore: 1.0,
      newTrustScore: 0.5,
      reason: "Test downgrade",
      evidence: ["anom_1"],
    };
    expect(isTrustDowngrade(intent)).toBe(true);
    if (isTrustDowngrade(intent)) {
      expect(intent.targetAgentId).toBe("agent_x");
    }
  });

  // system_alert

  it("constructs system_alert with autoResolves=true and resolveTimeoutMs", () => {
    const intent: SystemAlertIntent = {
      type: "system_alert",
      alertType: "stuck_job",
      severity: "warning",
      message: "Job job_stuck_001 has not progressed in 30 minutes",
      metadata: { jobId: "job_stuck_001", stuckSinceMs: 1800000 },
      autoResolves: true,
      resolveTimeoutMs: 3600000,
    };

    expect(intent.type).toBe("system_alert");
    expect(intent.alertType).toBe("stuck_job");
    expect(intent.autoResolves).toBe(true);
    expect(intent.resolveTimeoutMs).toBe(3600000);
    expect(intent.metadata.jobId).toBe("job_stuck_001");
  });

  it("constructs system_alert with autoResolves=false", () => {
    const intent: SystemAlertIntent = {
      type: "system_alert",
      alertType: "evidence_tampering",
      severity: "critical",
      message: "Evidence bundle hash was altered after submission",
      metadata: { bundleId: "bundle_tampered_001" },
      autoResolves: false,
    };

    expect(intent.autoResolves).toBe(false);
    expect(intent.resolveTimeoutMs).toBeUndefined();
    expect(intent.severity).toBe("critical");
  });

  it("constructs system_alert with all alertType values", () => {
    const alertTypes: Array<SystemAlertIntent["alertType"]> = [
      "stuck_job",
      "consensus_timeout",
      "escrow_expiry",
      "evidence_tampering",
      "rate_spike",
      "node_offline",
    ];
    for (const alertType of alertTypes) {
      const intent: SystemAlertIntent = {
        type: "system_alert",
        alertType,
        severity: "info",
        message: `Alert: ${alertType}`,
        metadata: {},
        autoResolves: true,
      };
      expect(intent.alertType).toBe(alertType);
    }
  });

  it("narrows system_alert from Intent union", () => {
    const intent: Intent = {
      type: "system_alert",
      alertType: "node_offline",
      severity: "critical",
      message: "Kernel node went offline unexpectedly",
      metadata: { kernelId: "kernel_prod_001" },
      autoResolves: false,
    };
    expect(isSystemAlert(intent)).toBe(true);
    if (isSystemAlert(intent)) {
      expect(intent.alertType).toBe("node_offline");
      expect(intent.autoResolves).toBe(false);
    }
  });
});

// ── MessageBus Anomaly Broadcast Tests ────────────────────────────

describe("MessageBus anomaly broadcast via onAnomaly()", () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = new MessageBus();
  });

  it("anomaly_detected broadcasts to all anomaly listeners", async () => {
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    bus.onAnomaly(listener1);
    bus.onAnomaly(listener2);

    const arbiter = makeCard({ id: "agent_arbiter" });
    bus.register(arbiter);

    const intent: AnomalyDetectedIntent = {
      type: "anomaly_detected",
      severity: "critical",
      category: "evidence_mismatch",
      sourceAgentId: "agent_monitor",
      description: "Hash mismatch",
      evidence: { timestamp: "2026-03-24T10:00:00Z" },
    };

    await bus.send(makeMessage(intent, { to: "agent_arbiter" }));

    expect(listener1).toHaveBeenCalledOnce();
    expect(listener1).toHaveBeenCalledWith(intent);
    expect(listener2).toHaveBeenCalledOnce();
    expect(listener2).toHaveBeenCalledWith(intent);
  });

  it("protocol_failure broadcasts to all anomaly listeners", async () => {
    const listener = vi.fn();
    bus.onAnomaly(listener);

    const arbiter = makeCard({ id: "agent_arbiter" });
    bus.register(arbiter);

    const intent: ProtocolFailureIntent = {
      type: "protocol_failure",
      failedProtocol: "escrow_release",
      errorCode: "TIMEOUT",
      errorMessage: "Release timed out",
      involvedAgents: ["agent_scheduler", "agent_kernel"],
      recoveryAction: "retry",
    };

    await bus.send(makeMessage(intent, { to: "agent_arbiter" }));

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(intent);
  });

  it("system_alert with autoResolves=true broadcasts to anomaly listeners", async () => {
    const listener = vi.fn();
    bus.onAnomaly(listener);

    const arbiter = makeCard({ id: "agent_arbiter" });
    bus.register(arbiter);

    const intent: SystemAlertIntent = {
      type: "system_alert",
      alertType: "stuck_job",
      severity: "warning",
      message: "Job is stuck",
      metadata: { jobId: "job_stuck_007" },
      autoResolves: true,
      resolveTimeoutMs: 60000,
    };

    await bus.send(makeMessage(intent, { to: "agent_arbiter" }));

    expect(listener).toHaveBeenCalledOnce();
    const received = listener.mock.calls[0][0] as SystemAlertIntent;
    expect(received.type).toBe("system_alert");
    expect(received.autoResolves).toBe(true);
    expect(received.resolveTimeoutMs).toBe(60000);
  });

  it("trust_downgrade is delivered point-to-point to the target agent", async () => {
    const anomalyListener = vi.fn();
    bus.onAnomaly(anomalyListener);

    const targetAgent = makeCard({ id: "agent_trust_target" });
    bus.register(targetAgent);

    const agentHandler = vi.fn();
    bus.subscribe("agent_trust_target", agentHandler);

    const intent: TrustDowngradeIntent = {
      type: "trust_downgrade",
      targetAgentId: "agent_trust_target",
      previousTrustScore: 0.9,
      newTrustScore: 0.3,
      reason: "Repeated protocol violations",
      evidence: ["anomaly_aaa", "anomaly_bbb"],
    };

    await bus.send(makeMessage(intent, { to: "agent_trust_target" }));

    // Point-to-point delivery should work
    expect(agentHandler).toHaveBeenCalledOnce();
    const msg = agentHandler.mock.calls[0][0] as A2AMessage;
    expect(msg.intent.type).toBe("trust_downgrade");
    if (isTrustDowngrade(msg.intent)) {
      expect(msg.intent.targetAgentId).toBe("agent_trust_target");
      expect(msg.intent.newTrustScore).toBe(0.3);
    }

    // trust_downgrade is NOT an anomaly broadcast type — anomaly listeners should NOT be called
    expect(anomalyListener).not.toHaveBeenCalled();
  });

  it("multiple anomaly listeners all receive the same event object", async () => {
    const listeners = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    for (const l of listeners) bus.onAnomaly(l);

    const arbiter = makeCard({ id: "agent_arbiter" });
    bus.register(arbiter);

    const intent: AnomalyDetectedIntent = {
      type: "anomaly_detected",
      severity: "info",
      category: "timeout",
      sourceAgentId: "agent_watchdog",
      description: "Soft timeout exceeded",
      evidence: { jobId: "job_slow_001", timestamp: "2026-03-24T12:00:00Z" },
    };

    await bus.send(makeMessage(intent, { to: "agent_arbiter" }));

    for (const l of listeners) {
      expect(l).toHaveBeenCalledOnce();
      // All listeners receive the same intent object reference
      expect(l).toHaveBeenCalledWith(intent);
    }
  });

  it("normal (non-anomaly) intents do NOT trigger anomaly listeners", async () => {
    const anomalyListener = vi.fn();
    bus.onAnomaly(anomalyListener);

    const receiver = makeCard({ id: "agent_receiver" });
    bus.register(receiver);

    // Send several non-anomaly intent types
    const nonAnomalyIntents: Intent[] = [
      { type: "text_message", text: "hello" },
      { type: "job_completed", jobId: "job_1", stepId: "step_1", evidenceBundleHash: "0xhash", summary: "done" },
      { type: "error", code: "NOT_FOUND", message: "Resource not found", retryable: false },
    ];

    for (const intent of nonAnomalyIntents) {
      await bus.send(makeMessage(intent, { to: "agent_receiver" }));
    }

    expect(anomalyListener).not.toHaveBeenCalled();
  });

  it("anomaly broadcast also delivers to point-to-point recipient (both paths fire)", async () => {
    const anomalyListener = vi.fn();
    bus.onAnomaly(anomalyListener);

    const arbiter = makeCard({ id: "agent_arbiter" });
    bus.register(arbiter);

    const directHandler = vi.fn();
    bus.subscribe("agent_arbiter", directHandler);

    const intent: ProtocolFailureIntent = {
      type: "protocol_failure",
      failedProtocol: "evidence_submission",
      errorCode: "DEADLINE_EXCEEDED",
      errorMessage: "Submission window closed",
      involvedAgents: ["agent_kernel_prod"],
      recoveryAction: "rollback",
    };

    await bus.send(makeMessage(intent, { to: "agent_arbiter" }));

    // Direct recipient gets it
    expect(directHandler).toHaveBeenCalledOnce();
    // Anomaly listener ALSO gets it
    expect(anomalyListener).toHaveBeenCalledOnce();
    expect(anomalyListener).toHaveBeenCalledWith(intent);
  });

  it("anomaly broadcast fires even when target agent has no handlers", async () => {
    const anomalyListener = vi.fn();
    bus.onAnomaly(anomalyListener);

    // Do NOT register a handler for agent_arbiter — no direct recipient

    const intent: SystemAlertIntent = {
      type: "system_alert",
      alertType: "node_offline",
      severity: "critical",
      message: "Node went offline",
      metadata: { nodeId: "kernel_001" },
      autoResolves: false,
    };

    // Send to an unregistered agent — should not throw
    await expect(
      bus.send(makeMessage(intent, { to: "agent_nobody" })),
    ).resolves.toBeUndefined();

    // Anomaly listener still fires
    expect(anomalyListener).toHaveBeenCalledOnce();
  });

  it("anomaly listener errors do not interrupt other listeners", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const badListener = vi.fn().mockImplementation(() => {
      throw new Error("listener boom");
    });
    const goodListener = vi.fn();

    bus.onAnomaly(badListener);
    bus.onAnomaly(goodListener);

    const arbiter = makeCard({ id: "agent_arbiter" });
    bus.register(arbiter);

    const intent: AnomalyDetectedIntent = {
      type: "anomaly_detected",
      severity: "warning",
      category: "consensus_failure",
      sourceAgentId: "agent_v1",
      description: "Consensus could not be reached",
      evidence: { timestamp: "2026-03-24T13:00:00Z" },
    };

    // Should not throw even though badListener throws
    await expect(
      bus.send(makeMessage(intent, { to: "agent_arbiter" })),
    ).resolves.toBeUndefined();

    expect(badListener).toHaveBeenCalledOnce();
    expect(goodListener).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalled();

    errSpy.mockRestore();
  });

  it("onAnomaly listeners accumulate across multiple registrations", async () => {
    const listeners = Array.from({ length: 5 }, () => vi.fn());
    for (const l of listeners) bus.onAnomaly(l);

    const arbiter = makeCard({ id: "agent_arbiter" });
    bus.register(arbiter);

    const intent: ProtocolFailureIntent = {
      type: "protocol_failure",
      failedProtocol: "verification_consensus",
      errorCode: "QUORUM_FAIL",
      errorMessage: "Not enough verifiers responded",
      involvedAgents: [],
    };

    await bus.send(makeMessage(intent, { to: "agent_arbiter" }));

    for (const l of listeners) {
      expect(l).toHaveBeenCalledOnce();
    }
  });
});
