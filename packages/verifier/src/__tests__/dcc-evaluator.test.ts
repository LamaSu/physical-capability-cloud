/**
 * Tests for the DCC evaluator.
 *
 * Covers: schema check, signature check, projection completeness, per-DCC
 * attestation requirements, trust-tier ceiling, downgrade reason consistency,
 * score rollup math, and quarantined-tool gating.
 */

import { describe, it, expect } from "vitest";
import {
  type InvocationReceipt,
  type IndexedTool,
  DigitalCaptureClass,
  TrustTier,
  DCC_MULTIPLIERS,
} from "@pcc/spec";
import { evaluateReceipt } from "../dcc-evaluator.js";

const SHA = "sha256:" + "a".repeat(64);

function makeReceipt(overrides: Partial<InvocationReceipt> = {}): InvocationReceipt {
  return {
    receiptId: "rcpt-1",
    receiptCID: SHA,
    schemaVersion: "1.0",
    indexedToolId: "tool-1",
    toolCID: SHA,
    toolSchemaHashAtCall: SHA,
    requestProjection: {
      method: "POST",
      url: "https://example.com/api",
      headersHash: SHA,
      bodyHash: SHA,
      middlewareRedactions: ["authorization"],
      timestamp: "2026-05-23T00:00:00.000Z",
    },
    responseProjection: {
      status: 200,
      headersHash: SHA,
      bodyHash: SHA,
      middlewareRedactions: [],
      timestamp: "2026-05-23T00:00:01.000Z",
    },
    requestedDccClass: DigitalCaptureClass.DCC1,
    effectiveDccClass: DigitalCaptureClass.DCC1,
    pccSignature: "sig",
    pccKeyId: "pcc-key-1",
    callerAgentId: "agent-1",
    callerSessionId: "session-1",
    pccFeeBps: 100,
    ...overrides,
  };
}

function makeTool(overrides: Partial<IndexedTool> = {}): IndexedTool {
  return {
    id: "tool-1",
    cid: SHA,
    version: "1.0.0",
    source: {
      type: "mcp-directory",
      url: "https://mcp.directory/x",
      fetchedAt: "2026-05-23T00:00:00.000Z",
    },
    ingestedAt: "2026-05-23T00:00:00.000Z",
    ingestionMethod: "mcp-list",
    upstreamUrl: "https://example.com/api",
    skills: ["data.fetch"],
    domains: ["data"],
    features: [],
    inputSchema: {},
    description: "test tool",
    actionClass: "read",
    assuranceCeiling: DigitalCaptureClass.DCC3,
    trustTier: TrustTier.AUTO_INDEXED,
    knownVulns: [],
    lastFetchedAt: "2026-05-23T00:00:00.000Z",
    invocationCount: 0,
    driftAlerts: [],
    schemaHashHistory: [SHA],
    hostingPeers: [],
    ...overrides,
  };
}

describe("evaluateReceipt — happy path", () => {
  it("DCC1 receipt with PCC signature scores high", () => {
    const r = makeReceipt();
    const res = evaluateReceipt(r);
    expect(res.verdict).toBe("valid");
    expect(res.finalScore).toBeCloseTo(100 * DCC_MULTIPLIERS.DCC1, 2);
    expect(res.effectiveDccClass).toBe(DigitalCaptureClass.DCC1);
    expect(res.downgraded).toBe(false);
    expect(res.confidence).toBeGreaterThanOrEqual(90);
  });

  it("DCC0 unsigned acknowledged as valid", () => {
    const r = makeReceipt({
      requestedDccClass: DigitalCaptureClass.DCC0,
      effectiveDccClass: DigitalCaptureClass.DCC0,
    });
    const res = evaluateReceipt(r);
    expect(res.verdict).toBe("valid");
    expect(res.multiplier).toBe(DCC_MULTIPLIERS.DCC0);
  });

  it("DCC2 with upstream signature passes", () => {
    const r = makeReceipt({
      requestedDccClass: DigitalCaptureClass.DCC2,
      effectiveDccClass: DigitalCaptureClass.DCC2,
      upstreamSignature: "upstream-sig",
      upstreamKeyId: "upstream-key",
    });
    const res = evaluateReceipt(r);
    expect(res.verdict).toBe("valid");
    expect(res.finalScore).toBeCloseTo(100 * DCC_MULTIPLIERS.DCC2, 2);
  });

  it("DCC3 with Sigstore bundle passes", () => {
    const r = makeReceipt({
      requestedDccClass: DigitalCaptureClass.DCC3,
      effectiveDccClass: DigitalCaptureClass.DCC3,
      upstreamSignature: "u-sig",
      upstreamKeyId: "u-key",
      sigstoreBundleRef: "oci://ghcr.io/foo:bar",
    });
    const res = evaluateReceipt(r);
    expect(res.verdict).toBe("valid");
    expect(res.finalScore).toBe(100); // DCC3 = 1.00 multiplier
  });
});

describe("evaluateReceipt — failures", () => {
  it("missing PCC signature is critical", () => {
    const r = makeReceipt({ pccSignature: "", pccKeyId: "" });
    const res = evaluateReceipt(r);
    expect(res.verdict).toBe("invalid");
    expect(res.findings.find((f) => f.check === "pcc_signature_present")?.passed).toBe(false);
    expect(res.confidence).toBeLessThan(50);
  });

  it("DCC2 without upstream signature is invalid", () => {
    const r = makeReceipt({
      requestedDccClass: DigitalCaptureClass.DCC2,
      effectiveDccClass: DigitalCaptureClass.DCC2,
    });
    const res = evaluateReceipt(r);
    expect(res.verdict).toBe("invalid");
    expect(
      res.findings.find((f) => f.check === "dcc2_upstream_signature")?.passed,
    ).toBe(false);
  });

  it("DCC3 without sigstore bundle is invalid", () => {
    const r = makeReceipt({
      requestedDccClass: DigitalCaptureClass.DCC3,
      effectiveDccClass: DigitalCaptureClass.DCC3,
    });
    const res = evaluateReceipt(r);
    expect(res.verdict).toBe("invalid");
    expect(
      res.findings.find((f) => f.check === "dcc3_sigstore_bundle_ref")?.passed,
    ).toBe(false);
  });

  it("DCC4 requires TEE quote", () => {
    const r = makeReceipt({
      requestedDccClass: DigitalCaptureClass.DCC4,
      effectiveDccClass: DigitalCaptureClass.DCC4,
    });
    const res = evaluateReceipt(r);
    expect(
      res.findings.find((f) => f.check === "dcc4_tee_quote")?.passed,
    ).toBe(false);
  });

  it("DCC5 requires zkProof", () => {
    const r = makeReceipt({
      requestedDccClass: DigitalCaptureClass.DCC5,
      effectiveDccClass: DigitalCaptureClass.DCC5,
    });
    const res = evaluateReceipt(r);
    expect(
      res.findings.find((f) => f.check === "dcc5_zk_proof")?.passed,
    ).toBe(false);
  });

  it("missing request body hash is critical", () => {
    const r = makeReceipt({
      requestProjection: {
        method: "POST",
        url: "https://example.com",
        headersHash: "",
        bodyHash: "",
        middlewareRedactions: [],
        timestamp: "2026-05-23T00:00:00.000Z",
      },
    });
    const res = evaluateReceipt(r);
    expect(res.verdict).toBe("invalid");
  });
});

describe("evaluateReceipt — downgrade rules", () => {
  it("downgrade present and explained marks valid", () => {
    const r = makeReceipt({
      requestedDccClass: DigitalCaptureClass.DCC3,
      effectiveDccClass: DigitalCaptureClass.DCC1,
      downgradeReason: "trust tier ceiling AUTO_INDEXED",
    });
    const res = evaluateReceipt(r);
    expect(res.downgraded).toBe(true);
    expect(res.multiplier).toBe(DCC_MULTIPLIERS.DCC1);
    expect(res.verdict).toBe("valid");
  });

  it("downgrade without reason adds a warning", () => {
    const r = makeReceipt({
      requestedDccClass: DigitalCaptureClass.DCC3,
      effectiveDccClass: DigitalCaptureClass.DCC1,
    });
    const res = evaluateReceipt(r);
    expect(res.downgraded).toBe(true);
    const dr = res.findings.find((f) => f.check === "downgrade_reason_present");
    expect(dr?.passed).toBe(false);
    expect(dr?.severity).toBe("warning");
  });
});

describe("evaluateReceipt — with tool ceiling checks", () => {
  it("effective class within tool ceiling is valid", () => {
    const r = makeReceipt({
      requestedDccClass: DigitalCaptureClass.DCC2,
      effectiveDccClass: DigitalCaptureClass.DCC2,
      upstreamSignature: "u-sig",
      upstreamKeyId: "u-key",
    });
    const tool = makeTool({
      trustTier: TrustTier.AUTO_INDEXED,
      assuranceCeiling: DigitalCaptureClass.DCC3,
    });
    const res = evaluateReceipt(r, tool);
    expect(res.verdict).toBe("valid");
  });

  it("effective class above trust-tier ceiling is critical", () => {
    const r = makeReceipt({
      requestedDccClass: DigitalCaptureClass.DCC5,
      effectiveDccClass: DigitalCaptureClass.DCC5,
      zkProof: "zkp",
    });
    const tool = makeTool({
      trustTier: TrustTier.UNTRUSTED, // ceiling DCC1
      assuranceCeiling: DigitalCaptureClass.DCC5,
    });
    const res = evaluateReceipt(r, tool);
    expect(res.verdict).toBe("invalid");
    expect(
      res.findings.find((f) => f.check === "effective_dcc_within_ceilings")?.passed,
    ).toBe(false);
  });

  it("quarantined tool is rejected even with valid receipt", () => {
    const r = makeReceipt();
    const tool = makeTool({ trustTier: TrustTier.QUARANTINED });
    const res = evaluateReceipt(r, tool);
    expect(res.verdict).toBe("invalid");
    expect(
      res.findings.find((f) => f.check === "tool_not_quarantined")?.passed,
    ).toBe(false);
  });
});

describe("evaluateReceipt — score math", () => {
  it("final score = base * multiplier", () => {
    const r = makeReceipt({
      requestedDccClass: DigitalCaptureClass.DCC0,
      effectiveDccClass: DigitalCaptureClass.DCC0,
    });
    const res = evaluateReceipt(r);
    expect(res.finalScore).toBeCloseTo(res.baseScore * res.multiplier, 1);
  });

  it("each critical failure reduces base by 20", () => {
    const r = makeReceipt({ pccSignature: "", pccKeyId: "" });
    const res = evaluateReceipt(r);
    // baseScore should be 100 - 20*N where N is the count of criticals
    const criticals = res.findings.filter(
      (f) => !f.passed && f.severity === "critical",
    ).length;
    expect(res.baseScore).toBe(Math.max(0, 100 - 20 * criticals));
  });
});
