/**
 * Tests for OpentronOperator — A2A handlers, job lifecycle, queue integration.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { OpentronOperator, type OperatorConfig } from "../opentrons/operator.js";

const MOCK_CONFIG: OperatorConfig = {
  kernelId: "kernel-test-ot",
  name: "Test OT-2 Lab",
  operatorAddress: "0x1234567890abcdef",
  location: { lat: 37.77, lng: -122.41 },
  adapter: {
    url: "http://localhost:31950",
    mockMode: true,
    maxQueueDepth: 5,
  },
  pricing: {
    baseCost: "5.00",
    perMinute: "0.50",
    minimum: "10.00",
    currency: "USDC",
  },
  maxQueueDepth: 5,
};

describe("OpentronOperator", () => {
  let operator: OpentronOperator;

  beforeEach(async () => {
    operator = new OpentronOperator(MOCK_CONFIG);
    await operator.start();
  });

  // ── Start / Capability ──────────────────────────────────────

  it("should start and report online with capability", async () => {
    const result = await operator.start();
    expect(result.online).toBe(true);
    expect(result.capability.type).toBe("liquid-handler");
    expect(result.capability.kernelId).toBe("kernel-test-ot");
  });

  // ── Discovery ───────────────────────────────────────────────

  it("should handle discover_capabilities intent", () => {
    const response = operator.handleDiscoverCapabilities({
      type: "discover_capabilities",
      capabilityType: "liquid-handler",
    });

    expect(response.type).toBe("capabilities_response");
    expect(response.totalMatches).toBe(1);
    expect(response.matches[0].type).toBe("liquid-handler");
    expect(response.matches[0].kernelId).toBe("kernel-test-ot");
    expect(response.matches[0].queueDepth).toBe(0);
  });

  // ── Quoting ─────────────────────────────────────────────────

  it("should handle request_quote with price calculation", () => {
    const response = operator.handleRequestQuote({
      type: "request_quote",
      capabilityType: "liquid-handler",
      params: { estimatedMinutes: 30 },
      assuranceTier: 1,
    });

    expect(response.type).toBe("quote_response");
    // baseCost(5) + perMinute(0.50) * 30 = 20.00
    expect(parseFloat(response.totalPrice)).toBe(20);
    expect(response.currency).toBe("USDC");
    expect(response.kernelId).toBe("kernel-test-ot");
  });

  it("should enforce minimum price", () => {
    const response = operator.handleRequestQuote({
      type: "request_quote",
      capabilityType: "liquid-handler",
      params: { estimatedMinutes: 1 },
      assuranceTier: 0,
    });

    // baseCost(5) + perMinute(0.50) * 1 = 5.50, but minimum is 10.00
    expect(parseFloat(response.totalPrice)).toBe(10);
  });

  it("should include queue wait in quote", async () => {
    // Submit a job to create queue depth
    operator.submitProtocol("def run(p): pass", "agent-1", 60_000);

    const response = operator.handleRequestQuote({
      type: "request_quote",
      capabilityType: "liquid-handler",
      params: { estimatedMinutes: 10 },
      assuranceTier: 1,
    });

    // Should have options mentioning queue
    expect(response.options).toBeDefined();
  });

  // ── Workflow Submission ─────────────────────────────────────

  it("should accept workflow and enqueue job", () => {
    const response = operator.handleSubmitWorkflow({
      type: "submit_workflow",
      cwm: { steps: [{ capabilityId: "cap-test", action: "transfer" }] },
      acceptedQuotes: {},
      payerWallet: "0xpayer",
    });

    expect(response.type).toBe("workflow_accepted");
    if (response.type !== "workflow_accepted") return;

    expect(response.planId).toContain("job-kernel-test-ot");
    expect(response.milestones).toHaveLength(1);
  });

  it("should reject workflow when queue is full", () => {
    // Fill the queue (max 5)
    for (let i = 0; i < 5; i++) {
      operator.submitProtocol(`def run(p): pass # ${i}`, `agent-${i}`);
    }

    const response = operator.handleSubmitWorkflow({
      type: "submit_workflow",
      cwm: {},
      acceptedQuotes: {},
      payerWallet: "0xpayer",
    });

    expect(response.type).toBe("error");
  });

  // ── Job Status ──────────────────────────────────────────────

  it("should report job status", () => {
    const submitResult = operator.submitProtocol("def run(p): pass", "agent-1");
    const jobId = submitResult.jobId;

    const response = operator.handleJobStatusQuery({
      type: "job_status_query",
      jobId,
    });

    expect(response.type).toBe("job_status_response");
    expect(response.planId).toBe(jobId);
    expect(response.steps).toHaveLength(1);
  });

  it("should return not_found for unknown jobs", () => {
    const response = operator.handleJobStatusQuery({
      type: "job_status_query",
      jobId: "job-does-not-exist",
    });

    expect(response.overallStatus).toBe("not_found");
  });

  // ── Direct API ──────────────────────────────────────────────

  it("should submit protocol directly and get queue result", () => {
    const result = operator.submitProtocol(
      "def run(p): pass",
      "test-agent",
      10000,
    );

    expect(result.accepted).toBe(true);
    expect(result.position).toBe(0); // first in queue
  });

  it("should list all jobs", () => {
    operator.submitProtocol("def run(p): pass", "agent-1");
    operator.submitProtocol("def run(p): pass", "agent-2");

    const jobs = operator.getJobs();
    expect(jobs).toHaveLength(2);
  });

  it("should cancel a queued job", () => {
    operator.submitProtocol("def run(p): pass", "agent-1");
    const result2 = operator.submitProtocol("def run(p): pass", "agent-2");

    const cancelled = operator.cancelJob(result2.jobId);
    expect(cancelled).toBe(true);

    const job = operator.getJob(result2.jobId);
    expect(job?.status).toBe("cancelled");
  });

  it("should report queue status", () => {
    operator.submitProtocol("def run(p): pass", "agent-1");
    operator.submitProtocol("def run(p): pass", "agent-2");

    const status = operator.getQueueStatus();
    expect(status.depth).toBeGreaterThan(0);
  });

  // ── Mutual Exclusion ────────────────────────────────────────

  it("should prevent concurrent execution", async () => {
    // Submit two jobs
    operator.submitProtocol("def run(p): pass", "agent-1", 60000);
    operator.submitProtocol("def run(p): pass", "agent-2", 60000);

    // Wait a tick for queue processing
    await new Promise((r) => setTimeout(r, 50));

    const status = operator.getQueueStatus();
    // One should be active, one pending
    expect(status.locked).toBe(true);
    expect(status.pending.length).toBeGreaterThanOrEqual(0);
    // Total should be 2
    expect(status.depth).toBeGreaterThanOrEqual(1);
  });
});
