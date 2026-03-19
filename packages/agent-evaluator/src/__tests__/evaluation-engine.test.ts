import { describe, it, expect } from "vitest";
import { evaluate, type EvidenceData, type Requirement } from "../evaluation-engine.js";

describe("evaluate", () => {
  const baseEvidence: EvidenceData = {
    events: [
      { type: "sample_loaded", data: {}, timestamp: "2026-03-17T10:00:00Z" },
      { type: "run_started", data: {}, timestamp: "2026-03-17T10:01:00Z" },
      { type: "peak_detected", data: { area: 1500 }, timestamp: "2026-03-17T10:30:00Z" },
      { type: "purity_calculated", data: { purity: 98.5 }, timestamp: "2026-03-17T10:35:00Z" },
      { type: "run_completed", data: {}, timestamp: "2026-03-17T10:40:00Z" },
    ],
    measurements: {
      purity: 98.5,
      retention_time: 12.3,
    },
  };

  it("passes when all evidence is complete and measurements are in spec", () => {
    const requirements: Requirement[] = [
      { name: "purity", expectedValue: "98.0", tolerance: "2.0", unit: "%" },
      { name: "retention_time", expectedValue: "12.0", tolerance: "1.0", unit: "min" },
    ];

    const result = evaluate(baseEvidence, requirements, "hplc");

    expect(result.verdict).toBe("pass");
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.findings.filter(f => f.severity === "critical")).toHaveLength(0);
  });

  it("fails when a critical measurement is out of spec", () => {
    const evidence: EvidenceData = {
      ...baseEvidence,
      measurements: { purity: 50.0, retention_time: 12.3 },
    };

    const requirements: Requirement[] = [
      { name: "purity", expectedValue: "98.0", tolerance: "2.0", unit: "%" },
    ];

    const result = evaluate(evidence, requirements, "hplc");

    expect(result.verdict).toBe("fail");
    expect(result.findings.some(f => f.severity === "critical")).toBe(true);
    expect(result.findings.some(f => f.category === "dimensional")).toBe(true);
  });

  it("returns conditional when measurements are near tolerance", () => {
    const evidence: EvidenceData = {
      ...baseEvidence,
      measurements: { purity: 95.5 },
    };

    const requirements: Requirement[] = [
      { name: "purity", expectedValue: "98.0", tolerance: "2.0", unit: "%" },
    ];

    const result = evaluate(evidence, requirements, "hplc");

    // 95.5 is 2.5 away from 98.0, tolerance is 2.0 — so minor finding
    expect(result.findings.some(f => f.severity === "minor")).toBe(true);
  });

  it("reports missing measurements", () => {
    const evidence: EvidenceData = {
      ...baseEvidence,
      measurements: {},
    };

    const requirements: Requirement[] = [
      { name: "purity", expectedValue: "98.0", unit: "%" },
    ];

    const result = evaluate(evidence, requirements, "hplc");

    expect(result.findings.some(f =>
      f.description.includes("not found in evidence"),
    )).toBe(true);
  });

  it("reports missing expected events", () => {
    const evidence: EvidenceData = {
      events: [
        { type: "sample_loaded", data: {}, timestamp: "2026-03-17T10:00:00Z" },
        { type: "run_completed", data: {}, timestamp: "2026-03-17T10:40:00Z" },
        { type: "extra_event", data: {}, timestamp: "2026-03-17T10:45:00Z" },
      ],
      measurements: { purity: 98.5 },
    };

    const result = evaluate(evidence, [], "hplc");

    // Missing: run_started, peak_detected, purity_calculated
    const missingFindings = result.findings.filter(f =>
      f.description.includes("Missing required evidence event"),
    );
    expect(missingFindings.length).toBeGreaterThan(0);
  });

  it("reports insufficient evidence events", () => {
    const evidence: EvidenceData = {
      events: [
        { type: "started", data: {}, timestamp: "2026-03-17T10:00:00Z" },
      ],
    };

    const result = evaluate(evidence, [], "custom-process");

    expect(result.findings.some(f =>
      f.description.includes("Insufficient evidence events"),
    )).toBe(true);
  });

  it("detects sensor data gaps", () => {
    const evidence: EvidenceData = {
      events: [
        { type: "process_started", data: {}, timestamp: "2026-03-17T10:00:00Z" },
        { type: "measurement", data: {}, timestamp: "2026-03-17T10:05:00Z" },
        { type: "process_completed", data: {}, timestamp: "2026-03-17T10:30:00Z" },
      ],
      sensorReadings: [
        { channel: "temp", value: 25.0, unit: "C", timestamp: "2026-03-17T10:00:00Z" },
        { channel: "temp", value: 25.1, unit: "C", timestamp: "2026-03-17T10:00:30Z" },
        // 2-minute gap
        { channel: "temp", value: 25.2, unit: "C", timestamp: "2026-03-17T10:02:30Z" },
      ],
    };

    const result = evaluate(evidence, [], "custom-process");

    expect(result.findings.some(f =>
      f.description.includes("Sensor data gap"),
    )).toBe(true);
  });

  it("returns confidence based on evidence completeness", () => {
    const fullEvidence = evaluate(baseEvidence, [], "hplc");
    const sparseEvidence = evaluate({
      events: [
        { type: "started", data: {}, timestamp: "2026-03-17T10:00:00Z" },
        { type: "middle", data: {}, timestamp: "2026-03-17T10:05:00Z" },
        { type: "ended", data: {}, timestamp: "2026-03-17T10:10:00Z" },
      ],
    }, [], "hplc");

    // Full evidence should have higher confidence
    expect(fullEvidence.confidence).toBeGreaterThan(sparseEvidence.confidence);
  });
});
