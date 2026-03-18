import { describe, it, expect, vi } from "vitest";
import { KnowledgeBase } from "../knowledge-base.js";
import { DiagnosticEngine, type KernelState } from "../diagnostic-engine.js";
import { TelemetryCollector } from "../telemetry-collector.js";
import { EscalationManager } from "../escalation-manager.js";

// ── KnowledgeBase ─────────────────────────────────────────────────

describe("KnowledgeBase", () => {
  const kb = new KnowledgeBase();

  it("should have entries loaded", () => {
    expect(kb.getTopics().length).toBeGreaterThan(0);
  });

  it("should search by keyword", () => {
    const results = kb.search("adapter http rest");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].topic).toBe("adapters");
  });

  it("should search by capability type", () => {
    const results = kb.search("fdm cnc capability types");
    expect(results.length).toBeGreaterThan(0);
  });

  it("should search for evidence tier info", () => {
    const results = kb.search("assurance tier evidence requirement");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].answer).toContain("Tier 0");
  });

  it("should search for settlement info", () => {
    const results = kb.search("escrow milestone payment release");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].topic).toBe("settlement");
  });

  it("should return empty for gibberish", () => {
    const results = kb.search("xyzzy qwerty foobarbaz");
    expect(results.length).toBe(0);
  });
});

// ── DiagnosticEngine ──────────────────────────────────────────────

describe("DiagnosticEngine", () => {
  const engine = new DiagnosticEngine();

  function makeHealthyState(): KernelState {
    return {
      kernelId: "kernel_test",
      agentStarted: true,
      agentRegistered: true,
      capabilities: [{
        type: "fdm",
        materials: ["pla"],
        assuranceTiers: [0, 1],
        pricing: { baseCost: "5.00", perMinute: "0.10", minimum: "10.00", currency: "USDC" },
      }],
      adapters: [
        { id: "dev-01", type: "machine", status: "idle", errorCount: 0 },
        { id: "dev-02", type: "sensor", status: "idle", errorCount: 0 },
      ],
      activeJobs: 0,
      completedJobs: 5,
      failedJobs: 0,
      evidenceBundles: 5,
      networkConnected: true,
      walletAddress: "0x1234",
      gatewayUrl: "http://localhost:3200",
      gatewayReachable: true,
      escrowMappings: 3,
      pendingSettlements: 0,
      errors: [],
    };
  }

  it("should pass all checks for healthy kernel", () => {
    const result = engine.diagnose(makeHealthyState());
    expect(result.failCount).toBe(0);
    expect(result.passCount).toBeGreaterThan(0);
  });

  it("should fail if agent not started", () => {
    const state = makeHealthyState();
    state.agentStarted = false;
    const result = engine.diagnose(state);
    expect(result.failCount).toBeGreaterThan(0);
    expect(result.checks.find(c => c.name === "Agent started")?.status).toBe("fail");
  });

  it("should fail for invalid capability type", () => {
    const state = makeHealthyState();
    state.capabilities[0].type = "invalid-type";
    const result = engine.diagnose(state);
    expect(result.checks.some(c => c.status === "fail" && c.name.includes("invalid-type"))).toBe(true);
  });

  it("should warn when tier 2 has no camera", () => {
    const state = makeHealthyState();
    state.capabilities[0].assuranceTiers = [0, 1, 2];
    const result = engine.diagnose(state);
    expect(result.checks.some(c => c.status === "warn" && c.message.includes("camera"))).toBe(true);
  });

  it("should fail when no evidence bundles for completed jobs", () => {
    const state = makeHealthyState();
    state.evidenceBundles = 0;
    const result = engine.diagnose(state);
    expect(result.checks.some(c => c.status === "fail" && c.name === "Evidence collection")).toBe(true);
  });

  it("should fail when network disconnected", () => {
    const state = makeHealthyState();
    state.networkConnected = false;
    const result = engine.diagnose(state);
    expect(result.checks.find(c => c.name === "Network connectivity")?.status).toBe("fail");
  });
});

// ── TelemetryCollector ────────────────────────────────────────────

describe("TelemetryCollector", () => {
  it("should ingest and retrieve kernel telemetry", () => {
    const collector = new TelemetryCollector();
    collector.ingest("agent-1", {
      kernelId: "kernel-1",
      capabilities: ["fdm"],
      activeJobs: 2,
      completedJobs: 10,
      adapterStatuses: [{ id: "dev-1", type: "machine", status: "idle", errorCount: 0 }],
    });

    const kernel = collector.getKernel("agent-1");
    expect(kernel).toBeDefined();
    expect(kernel!.kernelId).toBe("kernel-1");
    expect(kernel!.activeJobs).toBe(2);
    expect(kernel!.status).toBe("online");
  });

  it("should detect degraded status", () => {
    const collector = new TelemetryCollector();
    collector.ingest("agent-1", {
      adapterStatuses: [
        { id: "dev-1", type: "machine", status: "idle", errorCount: 0 },
        { id: "dev-2", type: "sensor", status: "error", errorCount: 5 },
      ],
    });

    expect(collector.getKernel("agent-1")!.status).toBe("degraded");
  });

  it("should generate snapshot", () => {
    const collector = new TelemetryCollector();
    collector.ingest("agent-1", { kernelId: "k1", adapterStatuses: [] });
    collector.ingest("agent-2", { kernelId: "k2", adapterStatuses: [] });

    const snapshot = collector.snapshot();
    expect(snapshot.kernels).toHaveLength(2);
    expect(snapshot.totalOnline).toBe(2);
    expect(snapshot.networkHealth).toBe("healthy");
  });
});

// ── EscalationManager ─────────────────────────────────────────────

describe("EscalationManager", () => {
  it("should create and retrieve escalations", () => {
    const mgr = new EscalationManager();
    const esc = mgr.escalate({
      severity: "high",
      kernelId: "kernel-1",
      agentId: "agent-1",
      category: "adapter_failure",
      title: "Device offline",
      details: "Haas VF-2 not responding",
    });

    expect(esc.id).toBeDefined();
    expect(esc.severity).toBe("high");
    expect(mgr.getOpen()).toHaveLength(1);
  });

  it("should deduplicate same kernel + category + title", () => {
    const mgr = new EscalationManager();
    mgr.escalate({ severity: "medium", kernelId: "k1", agentId: "a1", category: "network_issue", title: "Offline", details: "first" });
    mgr.escalate({ severity: "high", kernelId: "k1", agentId: "a1", category: "network_issue", title: "Offline", details: "second" });

    expect(mgr.getOpen()).toHaveLength(1);
    // Should upgrade severity
    expect(mgr.getOpen()[0].severity).toBe("high");
    expect(mgr.getOpen()[0].details).toBe("second");
  });

  it("should resolve escalations", () => {
    const mgr = new EscalationManager();
    const esc = mgr.escalate({ severity: "low", kernelId: "k1", agentId: "a1", category: "general", title: "Test", details: "" });
    mgr.resolve(esc.id);
    expect(mgr.getOpen()).toHaveLength(0);
  });

  it("should generate report", () => {
    const mgr = new EscalationManager();
    mgr.escalate({ severity: "critical", kernelId: "k1", agentId: "a1", category: "adapter_failure", title: "Crash", details: "Fatal" });
    mgr.escalate({ severity: "medium", kernelId: "k2", agentId: "a2", category: "network_issue", title: "Slow", details: "Latency" });

    const report = mgr.generateReport();
    expect(report.totalOpen).toBe(2);
    expect(report.bySeverity.critical).toBe(1);
    expect(report.bySeverity.medium).toBe(1);
    expect(report.critical).toHaveLength(1);
  });
});
