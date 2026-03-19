import { describe, it, expect } from "vitest";
import {
  generateJobFeedback,
  generateAssuranceTierFeedback,
  generateUptimeFeedback,
} from "../reputation-bridge.js";
import { PCC_REPUTATION_TAGS } from "@pcc/spec";

describe("generateJobFeedback", () => {
  const baseData = {
    operatorAgentId: 42n,
    jobId: "job-001",
    capabilityType: "hplc",
    qualityScore: 92,
    completionTimeSeconds: 3600,
    slaTimeSeconds: 7200, // 2 hours SLA, completed in 1 hour
    evidenceCid: "bafkreifypph123",
    evidenceHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as `0x${string}`,
    endpoint: "https://lab.biopunk.io/api",
  };

  it("generates quality, responseTime, and completionRate feedback", () => {
    const feedbacks = generateJobFeedback(baseData);
    expect(feedbacks).toHaveLength(3);

    const quality = feedbacks.find(f => f.tag1 === PCC_REPUTATION_TAGS.QUALITY);
    expect(quality).toBeDefined();
    expect(quality!.value).toBe(92n);
    expect(quality!.tag2).toBe("hplc");
    expect(quality!.feedbackURI).toBe("ipfs://bafkreifypph123");

    const responseTime = feedbacks.find(f => f.tag1 === PCC_REPUTATION_TAGS.RESPONSE_TIME);
    expect(responseTime).toBeDefined();
    expect(responseTime!.value).toBe(3600000n); // 3600s * 1000 = ms

    const completion = feedbacks.find(f => f.tag1 === PCC_REPUTATION_TAGS.COMPLETION_RATE);
    expect(completion).toBeDefined();
    // Completed in half the SLA time → score should be high (capped at 100)
    expect(Number(completion!.value)).toBeGreaterThanOrEqual(100);
  });

  it("caps completion rate at 100", () => {
    const feedbacks = generateJobFeedback({
      ...baseData,
      completionTimeSeconds: 1800, // Much faster than SLA
    });

    const completion = feedbacks.find(f => f.tag1 === PCC_REPUTATION_TAGS.COMPLETION_RATE);
    expect(Number(completion!.value)).toBeLessThanOrEqual(100);
  });

  it("gives lower completion score when SLA is missed", () => {
    const feedbacks = generateJobFeedback({
      ...baseData,
      completionTimeSeconds: 14400, // Double the SLA
      slaTimeSeconds: 7200,
    });

    const completion = feedbacks.find(f => f.tag1 === PCC_REPUTATION_TAGS.COMPLETION_RATE);
    expect(Number(completion!.value)).toBeLessThan(100);
  });
});

describe("generateAssuranceTierFeedback", () => {
  it("generates correct feedback for each tier", () => {
    for (const tier of [0, 1, 2, 3] as const) {
      const feedback = generateAssuranceTierFeedback(42n, tier, "https://lab.io/api");
      expect(feedback.tag1).toBe("assurance");
      expect(feedback.tag2).toBe(`tier-${tier}`);
      expect(feedback.value).toBe(BigInt(tier * 25));
      expect(feedback.agentId).toBe(42n);
    }
  });
});

describe("generateUptimeFeedback", () => {
  it("stores uptime with 2 decimal places", () => {
    const feedback = generateUptimeFeedback(42n, 99.77, "https://lab.io/api");
    expect(feedback.value).toBe(9977n);
    expect(feedback.valueDecimals).toBe(2);
    expect(feedback.tag1).toBe(PCC_REPUTATION_TAGS.UPTIME);
  });

  it("rounds correctly", () => {
    const feedback = generateUptimeFeedback(42n, 99.999, "https://lab.io/api");
    expect(feedback.value).toBe(10000n); // rounds to 100.00%
  });
});
