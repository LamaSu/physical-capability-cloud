/**
 * Tests for PCC security types in @pcc/spec
 */

import { describe, it, expect } from "vitest";
import type {
  ContentScanResult,
  AuditReceipt,
  SecurityViolation,
  DriftAlert,
} from "../types/security.js";
import type { SHA256 } from "../types/common.js";

const mockHash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as SHA256;

describe("Security types (structural)", () => {
  it("ContentScanResult can be constructed with required fields", () => {
    const result: ContentScanResult = {
      id: "job_scan1",
      decision: "PASS",
      confidence: 1,
      zone: "SAFE",
      triggeredLayers: [],
      latencyMs: 0.5,
      contentHash: mockHash,
      scannedAt: new Date().toISOString(),
    };
    expect(result.decision).toBe("PASS");
    expect(result.zone).toBe("SAFE");
  });

  it("ContentScanResult supports all decision values", () => {
    const decisions: ContentScanResult["decision"][] = ["BLOCK", "PASS", "REVIEW"];
    expect(decisions).toHaveLength(3);
  });

  it("ContentScanResult supports all zone values", () => {
    const zones: ContentScanResult["zone"][] = ["SAFE", "SUSPICIOUS", "DECEPTIVE", "MALICIOUS"];
    expect(zones).toHaveLength(4);
  });

  it("AuditReceipt has correct structure", () => {
    const receipt: AuditReceipt = {
      scanHash: mockHash,
      chainPosition: 0,
      layersTriggered: 3,
      timestamp: new Date().toISOString(),
    };
    expect(receipt.chainPosition).toBe(0);
    expect(receipt.layersTriggered).toBe(3);
  });

  it("SecurityViolation references a scan result", () => {
    const scanResult: ContentScanResult = {
      id: "job_scan2",
      decision: "BLOCK",
      confidence: 0.95,
      zone: "MALICIOUS",
      triggeredLayers: ["direct_injection"],
      latencyMs: 1.2,
      contentHash: mockHash,
      scannedAt: new Date().toISOString(),
    };
    const violation: SecurityViolation = {
      scanResult,
      message: "Blocked malicious content",
      intentType: "text_message",
      sourceAgentId: "agent_bad_1",
    };
    expect(violation.scanResult.decision).toBe("BLOCK");
    expect(violation.intentType).toBe("text_message");
  });

  it("DriftAlert supports all severity levels", () => {
    const severities: DriftAlert["severity"][] = ["info", "warning", "critical"];
    expect(severities).toHaveLength(3);
  });

  it("DriftAlert supports all recommendation values", () => {
    const recs: DriftAlert["recommendation"][] = ["CONTINUE", "REVIEW", "TERMINATE"];
    expect(recs).toHaveLength(3);
  });

  it("DriftAlert can be constructed", () => {
    const alert: DriftAlert = {
      conversationId: "conv_test_1",
      severity: "warning",
      driftScore: 0.7,
      recommendation: "REVIEW",
      trigger: "new intent type detected",
      detectedAt: new Date().toISOString(),
    };
    expect(alert.driftScore).toBeGreaterThan(0);
    expect(alert.recommendation).toBe("REVIEW");
  });

  it("ContentScanResult auditReceipt is optional", () => {
    const result: ContentScanResult = {
      id: "job_scan3",
      decision: "PASS",
      confidence: 1,
      zone: "SAFE",
      triggeredLayers: [],
      latencyMs: 0,
      contentHash: mockHash,
      scannedAt: new Date().toISOString(),
      // auditReceipt omitted — optional
    };
    expect(result.auditReceipt).toBeUndefined();
  });

  it("ContentScanResult with auditReceipt", () => {
    const result: ContentScanResult = {
      id: "job_scan4",
      decision: "BLOCK",
      confidence: 0.95,
      zone: "MALICIOUS",
      triggeredLayers: ["direct_injection"],
      latencyMs: 2.1,
      contentHash: mockHash,
      auditReceipt: {
        scanHash: mockHash,
        chainPosition: 1,
        layersTriggered: 1,
        timestamp: new Date().toISOString(),
      },
      scannedAt: new Date().toISOString(),
    };
    expect(result.auditReceipt!.chainPosition).toBe(1);
  });
});

// Verify these types are exported from the main spec package
describe("Security types re-exported from @pcc/spec index", () => {
  it("imports work from spec types index", async () => {
    const specTypes = await import("../types/index.js");
    // These won't be functions, but the import should not throw
    // The real test is that TypeScript compiled without errors
    expect(specTypes).toBeDefined();
  });
});
