import { describe, it, expect } from "vitest";
import { applyHardFilters, evaluateHardGates } from "../filters.js";
import { TrustTier, DigitalCaptureClass } from "@pcc/spec";
import { makeTool } from "./fixtures.js";

describe("evaluateHardGates — always-on gates", () => {
  it("QUARANTINED is excluded", () => {
    const t = makeTool({ trustTier: TrustTier.QUARANTINED });
    const r = evaluateHardGates(t);
    expect(r.passed).toBe(false);
    expect(r.failedGate).toBe("no-quarantined");
  });
  it("critical CVE excludes", () => {
    const t = makeTool({ knownVulns: ["CVE-2026-1234 (critical)"] });
    const r = evaluateHardGates(t);
    expect(r.passed).toBe(false);
    expect(r.failedGate).toBe("no-critical-cve");
  });
  it("critical drift excludes", () => {
    const t = makeTool({
      driftAlerts: [
        {
          type: "schema_changed",
          severity: "critical",
          detectedAt: "2026-01-01T00:00:00.000Z",
          message: "broken",
        },
      ],
    });
    const r = evaluateHardGates(t);
    expect(r.passed).toBe(false);
    expect(r.failedGate).toBe("no-critical-drift");
  });
  it("clean tool passes always-on gates", () => {
    const r = evaluateHardGates(makeTool());
    expect(r.passed).toBe(true);
    expect(r.passedGates).toContain("no-quarantined");
    expect(r.passedGates).toContain("no-critical-cve");
    expect(r.passedGates).toContain("no-critical-drift");
  });
});

describe("evaluateHardGates — caller-specified gates", () => {
  it("trust floor excludes below-tier tools", () => {
    const t = makeTool({ trustTier: TrustTier.UNTRUSTED });
    const r = evaluateHardGates(t, { minTrustTier: TrustTier.VERIFIED_PUBLISHER });
    expect(r.passed).toBe(false);
    expect(r.failedGate).toBe("trust-floor");
  });
  it("DCC ceiling: caller can't request higher than tool ceiling", () => {
    const t = makeTool({ assuranceCeiling: DigitalCaptureClass.DCC1 });
    const r = evaluateHardGates(t, { requestedDccClass: DigitalCaptureClass.DCC3 });
    expect(r.passed).toBe(false);
    expect(r.failedGate).toBe("dcc-ceiling");
  });
  it("action-class allowlist filters", () => {
    const t = makeTool({ actionClass: "write" });
    const r = evaluateHardGates(t, { actionClassAllowlist: ["read"] });
    expect(r.passed).toBe(false);
    expect(r.failedGate).toBe("action-class");
  });
  it("skill filter requires exact match", () => {
    const t = makeTool({ skills: ["nlp.summarization"] });
    const okR = evaluateHardGates(t, { skill: "nlp.summarization" });
    expect(okR.passed).toBe(true);
    const noR = evaluateHardGates(t, { skill: "different.skill" });
    expect(noR.passed).toBe(false);
  });
  it("multiple filters AND-combine", () => {
    const t = makeTool({
      trustTier: TrustTier.VERIFIED_PUBLISHER,
      assuranceCeiling: DigitalCaptureClass.DCC3,
      actionClass: "read",
    });
    const r = evaluateHardGates(t, {
      minTrustTier: TrustTier.VERIFIED_PUBLISHER,
      requestedDccClass: DigitalCaptureClass.DCC2,
      actionClassAllowlist: ["read", "network"],
    });
    expect(r.passed).toBe(true);
  });
});

describe("applyHardFilters", () => {
  it("bulk-filters and returns only passing tools", () => {
    const tools = [
      makeTool({ id: "a", trustTier: TrustTier.PCC_NATIVE }),
      makeTool({ id: "b", trustTier: TrustTier.UNTRUSTED }),
      makeTool({ id: "c", trustTier: TrustTier.QUARANTINED }),
    ];
    const out = applyHardFilters(tools, { minTrustTier: TrustTier.AUTO_INDEXED });
    expect(out.map((t) => t.id)).toEqual(["a"]);
  });
});
