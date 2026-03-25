import { describe, it, expect, beforeEach } from "vitest";
import { AnomalyDetector } from "../anomaly-detector.js";
import type { EvidenceBundle, SHA256, Address, Signature } from "@pcc/spec";
import { hashEvent, hashBundle } from "@pcc/spec";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeValidBundle(overrides?: Partial<EvidenceBundle>): Promise<EvidenceBundle> {
  const source = { deviceId: "dev_001", deviceType: "controller" as const, kernelId: "kernel_001" };

  const rawEvent1 = {
    id: "ev_001",
    type: "execution_completed" as const,
    timestamp: "2024-01-01T00:00:00.000Z",
    source,
    payload: { success: true, duration: 60 },
  };
  const rawEvent2 = {
    id: "ev_002",
    type: "power_profile_summary" as const,
    timestamp: "2024-01-01T00:00:01.000Z",
    source,
    payload: { avgWatts: 100 },
  };

  const hash1 = await hashEvent(rawEvent1);
  const hash2 = await hashEvent(rawEvent2);

  const events = [
    { ...rawEvent1, hash: hash1 },
    { ...rawEvent2, hash: hash2 },
  ];

  const bundleHash = await hashBundle(events);

  const base: EvidenceBundle = {
    id: "bun_001",
    jobId: "job_001",
    stepId: "step_001",
    kernelId: "kernel_001",
    assuranceTier: 1,
    events,
    bundleHash,
    kernelSignature: {
      signer: "0xDeadBeef00000000000000000000000000000000" as Address,
      algorithm: "secp256k1",
      value: "real_sig_abc123",
    } as Signature,
    createdAt: "2024-01-01T00:00:02.000Z",
  };

  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Evidence Integrity
// ---------------------------------------------------------------------------

describe("AnomalyDetector — evidence integrity", () => {
  it("returns null for a valid bundle", async () => {
    const detector = new AnomalyDetector();
    const bundle = await makeValidBundle();
    const result = await detector.checkEvidenceIntegrity(bundle);
    expect(result).toBeNull();
  });

  it("emits critical anomaly when bundleHash is tampered", async () => {
    const detector = new AnomalyDetector();
    const bundle = await makeValidBundle();
    const tampered: EvidenceBundle = {
      ...bundle,
      bundleHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000" as SHA256,
    };
    const report = await detector.checkEvidenceIntegrity(tampered);
    expect(report).not.toBeNull();
    expect(report!.severity).toBe("critical");
    expect(report!.category).toBe("evidence_mismatch");
  });

  it("emits critical anomaly when an event hash is tampered", async () => {
    const detector = new AnomalyDetector();
    const bundle = await makeValidBundle();
    // Tamper one event's hash but keep bundleHash consistent with the tampered state
    const tamperedEvents = bundle.events.map((e, i) =>
      i === 0
        ? { ...e, hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as SHA256 }
        : e
    );
    // Recompute bundleHash to match tampered events so bundle-level check passes
    const recomputedBundleHash = await hashBundle(tamperedEvents);
    const tampered: EvidenceBundle = {
      ...bundle,
      events: tamperedEvents,
      bundleHash: recomputedBundleHash,
    };
    const report = await detector.checkEvidenceIntegrity(tampered);
    expect(report).not.toBeNull();
    expect(report!.severity).toBe("critical");
    expect(report!.category).toBe("evidence_mismatch");
  });

  it("emits critical anomaly for test_sig_ kernel signature", async () => {
    const detector = new AnomalyDetector();
    const bundle = await makeValidBundle({
      kernelSignature: {
        signer: "0x0000000000000000000000000000000000000000" as Address,
        algorithm: "secp256k1",
        value: "test_sig_abcdef1234567890",
      } as Signature,
    });
    const report = await detector.checkEvidenceIntegrity(bundle);
    expect(report).not.toBeNull();
    expect(report!.severity).toBe("critical");
    expect(report!.category).toBe("evidence_mismatch");
  });
});

// ---------------------------------------------------------------------------
// Job Duration / Timeout
// ---------------------------------------------------------------------------

describe("AnomalyDetector — job timeout", () => {
  it("returns null for normal duration", () => {
    const detector = new AnomalyDetector({ jobTimeoutMs: 300_000 });
    const result = detector.recordJobDuration("job_001", "kernel_001", 60_000);
    expect(result).toBeNull();
  });

  it("returns null for duration at exact threshold", () => {
    const detector = new AnomalyDetector({ jobTimeoutMs: 300_000 });
    const result = detector.recordJobDuration("job_001", "kernel_001", 300_000);
    expect(result).toBeNull();
  });

  it("emits warning for duration slightly over timeout", () => {
    const detector = new AnomalyDetector({ jobTimeoutMs: 300_000 });
    const result = detector.recordJobDuration("job_001", "kernel_001", 300_001);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("warning");
    expect(result!.category).toBe("timeout");
  });

  it("emits critical for duration > 3x timeout", () => {
    const detector = new AnomalyDetector({ jobTimeoutMs: 300_000 });
    const result = detector.recordJobDuration("job_001", "kernel_001", 300_000 * 5);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("critical");
    expect(result!.category).toBe("timeout");
  });
});

// ---------------------------------------------------------------------------
// Protocol Failures
// ---------------------------------------------------------------------------

describe("AnomalyDetector — protocol failures", () => {
  it("returns null for a single failure (below threshold)", () => {
    const detector = new AnomalyDetector({ maxConsecutiveFailures: 3 });
    const result = detector.recordProtocolFailure("agent_001", "EVAL", "timeout");
    expect(result).toBeNull();
  });

  it("returns null for two consecutive failures (below threshold)", () => {
    const detector = new AnomalyDetector({ maxConsecutiveFailures: 3 });
    detector.recordProtocolFailure("agent_001", "EVAL", "timeout");
    const result = detector.recordProtocolFailure("agent_001", "EVAL", "timeout");
    expect(result).toBeNull();
  });

  it("emits critical on the 3rd consecutive failure", () => {
    const detector = new AnomalyDetector({ maxConsecutiveFailures: 3 });
    detector.recordProtocolFailure("agent_001", "EVAL", "err1");
    detector.recordProtocolFailure("agent_001", "EVAL", "err2");
    const result = detector.recordProtocolFailure("agent_001", "EVAL", "err3");
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("critical");
    expect(result!.category).toBe("protocol_failure");
  });

  it("tracks failures per agent independently", () => {
    const detector = new AnomalyDetector({ maxConsecutiveFailures: 3 });
    detector.recordProtocolFailure("agent_001", "EVAL", "err");
    detector.recordProtocolFailure("agent_001", "EVAL", "err");
    // agent_002 should not trigger on its 1st failure
    const result = detector.recordProtocolFailure("agent_002", "EVAL", "err");
    expect(result).toBeNull();
  });

  it("getTrustImpact shows shouldDowngrade after critical protocol failure", () => {
    const detector = new AnomalyDetector({ maxConsecutiveFailures: 3, trustDowngradeThreshold: 1 });
    detector.recordProtocolFailure("agent_001", "EVAL", "err1");
    detector.recordProtocolFailure("agent_001", "EVAL", "err2");
    detector.recordProtocolFailure("agent_001", "EVAL", "err3");
    const impact = detector.getTrustImpact("agent_001");
    expect(impact.shouldDowngrade).toBe(true);
    expect(impact.anomalyCount).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Consensus
// ---------------------------------------------------------------------------

describe("AnomalyDetector — consensus results", () => {
  it("returns null for 0.8 agreement ratio", () => {
    const detector = new AnomalyDetector({ minConsensusRatio: 0.6 });
    const result = detector.recordConsensusResult("req_001", 0.8, ["v1", "v2", "v3"]);
    expect(result).toBeNull();
  });

  it("returns null for ratio at exact threshold", () => {
    const detector = new AnomalyDetector({ minConsensusRatio: 0.6 });
    const result = detector.recordConsensusResult("req_001", 0.6, ["v1", "v2", "v3"]);
    expect(result).toBeNull();
  });

  it("emits warning for ratio below minConsensusRatio but above 0.4", () => {
    const detector = new AnomalyDetector({ minConsensusRatio: 0.6 });
    const result = detector.recordConsensusResult("req_001", 0.5, ["v1", "v2", "v3"]);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("warning");
    expect(result!.category).toBe("consensus_failure");
  });

  it("emits critical for ratio below 0.4", () => {
    const detector = new AnomalyDetector({ minConsensusRatio: 0.6 });
    const result = detector.recordConsensusResult("req_001", 0.3, ["v1", "v2", "v3"]);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("critical");
    expect(result!.category).toBe("consensus_failure");
  });
});

// ---------------------------------------------------------------------------
// Rate Limiting
// ---------------------------------------------------------------------------

describe("AnomalyDetector — evidence rate limiting", () => {
  it("returns null for 50 submissions within window", () => {
    const detector = new AnomalyDetector({ maxEvidenceRatePerWindow: 100 });
    let last: ReturnType<typeof detector.recordEvidenceSubmission> = null;
    for (let i = 0; i < 50; i++) {
      last = detector.recordEvidenceSubmission("src_001");
    }
    expect(last).toBeNull();
  });

  it("emits rate_anomaly warning after exceeding limit", () => {
    const detector = new AnomalyDetector({ maxEvidenceRatePerWindow: 100 });
    let result: ReturnType<typeof detector.recordEvidenceSubmission> = null;
    for (let i = 0; i < 150; i++) {
      result = detector.recordEvidenceSubmission("src_001");
    }
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("warning");
    expect(result!.category).toBe("rate_anomaly");
  });

  it("tracks rates per source independently", () => {
    const detector = new AnomalyDetector({ maxEvidenceRatePerWindow: 100 });
    // src_001 submits 150 — over limit
    for (let i = 0; i < 150; i++) {
      detector.recordEvidenceSubmission("src_001");
    }
    // src_002 submits 50 — under limit, should still be null
    let lastSrc2: ReturnType<typeof detector.recordEvidenceSubmission> = null;
    for (let i = 0; i < 50; i++) {
      lastSrc2 = detector.recordEvidenceSubmission("src_002");
    }
    expect(lastSrc2).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------

describe("AnomalyDetector — listeners", () => {
  it("listener receives all anomaly reports", () => {
    const detector = new AnomalyDetector({ maxConsecutiveFailures: 1 });
    const received: string[] = [];
    detector.onAnomaly((r) => received.push(r.id));

    detector.recordProtocolFailure("agent_001", "P", "err");
    detector.recordJobDuration("j1", "k1", 999_999_999);

    expect(received).toHaveLength(2);
  });

  it("multiple listeners all fire", () => {
    const detector = new AnomalyDetector({ maxConsecutiveFailures: 1 });
    const calls: number[] = [];
    detector.onAnomaly(() => calls.push(1));
    detector.onAnomaly(() => calls.push(2));

    detector.recordProtocolFailure("agent_001", "P", "err");
    expect(calls).toEqual([1, 2]);
  });

  it("a throwing listener does not crash the detector", () => {
    const detector = new AnomalyDetector({ maxConsecutiveFailures: 1 });
    detector.onAnomaly(() => { throw new Error("listener error"); });
    expect(() =>
      detector.recordProtocolFailure("agent_001", "P", "err")
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolve() and getUnresolved()
// ---------------------------------------------------------------------------

describe("AnomalyDetector — resolve", () => {
  it("getUnresolved returns all anomalies before any resolution", () => {
    const detector = new AnomalyDetector({ maxConsecutiveFailures: 1 });
    detector.recordProtocolFailure("agent_001", "P", "e1");
    detector.recordProtocolFailure("agent_002", "P", "e2");
    expect(detector.getUnresolved()).toHaveLength(2);
  });

  it("resolve() removes anomaly from unresolved list", () => {
    const detector = new AnomalyDetector({ maxConsecutiveFailures: 1 });
    const report = detector.recordProtocolFailure("agent_001", "P", "err")!;
    detector.resolve(report.id);
    expect(detector.getUnresolved()).toHaveLength(0);
  });

  it("resolve() sets resolvedAt timestamp", () => {
    const detector = new AnomalyDetector({ maxConsecutiveFailures: 1 });
    const report = detector.recordProtocolFailure("agent_001", "P", "err")!;
    detector.resolve(report.id);
    const all = detector.getByTarget("agent_001");
    expect(all[0].resolved).toBe(true);
    expect(all[0].resolvedAt).toBeDefined();
  });

  it("resolve() ignores unknown anomaly id", () => {
    const detector = new AnomalyDetector();
    expect(() => detector.resolve("nonexistent_id")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getTrustImpact
// ---------------------------------------------------------------------------

describe("AnomalyDetector — getTrustImpact", () => {
  it("returns zero impact for unknown agent", () => {
    const detector = new AnomalyDetector();
    const impact = detector.getTrustImpact("unknown_agent");
    expect(impact.anomalyCount).toBe(0);
    expect(impact.shouldDowngrade).toBe(false);
  });

  it("counts unresolved anomalies for agent", () => {
    const detector = new AnomalyDetector({ maxConsecutiveFailures: 1, trustDowngradeThreshold: 3 });
    detector.recordProtocolFailure("agent_001", "P", "e1");
    detector.recordProtocolFailure("agent_001", "P", "e2");
    const impact = detector.getTrustImpact("agent_001");
    expect(impact.anomalyCount).toBe(2);
    expect(impact.shouldDowngrade).toBe(false);
  });

  it("shouldDowngrade when anomaly count reaches threshold", () => {
    const detector = new AnomalyDetector({ maxConsecutiveFailures: 1, trustDowngradeThreshold: 3 });
    for (let i = 0; i < 3; i++) {
      detector.recordProtocolFailure("agent_001", "P", `err${i}`);
    }
    const impact = detector.getTrustImpact("agent_001");
    expect(impact.shouldDowngrade).toBe(true);
  });

  it("resolved anomalies do NOT count toward trust impact", () => {
    const detector = new AnomalyDetector({ maxConsecutiveFailures: 1, trustDowngradeThreshold: 1 });
    const report = detector.recordProtocolFailure("agent_001", "P", "err")!;
    detector.resolve(report.id);
    const impact = detector.getTrustImpact("agent_001");
    expect(impact.anomalyCount).toBe(0);
    expect(impact.shouldDowngrade).toBe(false);
  });
});
