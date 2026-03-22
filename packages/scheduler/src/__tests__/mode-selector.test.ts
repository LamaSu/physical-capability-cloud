import { describe, it, expect } from "vitest";
import { selectMode, getAvailableModes, type StepMetadata } from "../mode-selector.js";
import type { AssuranceTier, TMPMode } from "@pcc/spec";

describe("selectMode", () => {
  // ── Manufacturing Step Mappings ────────────────────────────────────

  describe("manufacturing step mappings", () => {
    const mappings: Array<{ capability: string; expected: TMPMode }> = [
      { capability: "cnc-3axis", expected: "benchmark" },
      { capability: "cnc-5axis", expected: "benchmark" },
      { capability: "fdm", expected: "benchmark" },
      { capability: "sla", expected: "benchmark" },
      { capability: "sls", expected: "benchmark" },
      { capability: "lathe", expected: "benchmark" },
      { capability: "inspection", expected: "bounty" },
      { capability: "assembly", expected: "claim" },
      { capability: "calibration", expected: "claim" },
      { capability: "courier-pickup", expected: "auction" },
      { capability: "courier-delivery", expected: "auction" },
      { capability: "surface-treatment", expected: "pitch" },
      { capability: "laser-cut", expected: "pitch" },
      { capability: "waterjet", expected: "pitch" },
      { capability: "sheet-metal", expected: "pitch" },
      { capability: "injection-mold", expected: "pitch" },
    ];

    for (const { capability, expected } of mappings) {
      it(`maps ${capability} to ${expected}`, () => {
        const result = selectMode(capability, 1);
        expect(result.recommendedMode).toBe(expected);
        expect(result.confidence).toBeGreaterThan(0);
        expect(result.reasoning).toBeTruthy();
      });
    }
  });

  // ── Default for Unknown Capabilities ───────────────────────────────

  it("defaults to bounty for unknown capability types", () => {
    const result = selectMode("exotic-unknown-process", 1);
    expect(result.recommendedMode).toBe("bounty");
    expect(result.confidence).toBeLessThan(0.7);
    expect(result.alternativeMode).toBe("pitch");
  });

  // ── Metadata Overrides ─────────────────────────────────────────────

  describe("metadata overrides", () => {
    it("overrides to benchmark when automatedVerification is true", () => {
      const result = selectMode("assembly", 0, { automatedVerification: true });
      expect(result.recommendedMode).toBe("benchmark");
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it("overrides to claim when workerPreAssigned is true", () => {
      const result = selectMode("fdm", 0, { workerPreAssigned: true });
      expect(result.recommendedMode).toBe("claim");
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it("overrides to pitch when requiresProposal is true", () => {
      const result = selectMode("fdm", 0, { requiresProposal: true });
      expect(result.recommendedMode).toBe("pitch");
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it("overrides to auction when priceCompetitive is true", () => {
      const result = selectMode("fdm", 0, { priceCompetitive: true });
      expect(result.recommendedMode).toBe("auction");
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });
  });

  // ── Assurance Tier Bias ────────────────────────────────────────────

  describe("assurance tier bias", () => {
    it("biases toward benchmark at tier 3", () => {
      const result = selectMode("custom", 3);
      expect(result.recommendedMode).toBe("benchmark");
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it("does not force benchmark at tier 1 for non-benchmark types", () => {
      const result = selectMode("inspection", 1);
      // inspection maps to bounty at tier 1
      expect(result.recommendedMode).toBe("bounty");
    });
  });

  // ── Result Structure ───────────────────────────────────────────────

  describe("result structure", () => {
    it("always returns confidence between 0 and 1", () => {
      const types = ["fdm", "inspection", "assembly", "courier-pickup", "surface-treatment", "unknown"];
      for (const t of types) {
        const result = selectMode(t, 1);
        expect(result.confidence).toBeGreaterThanOrEqual(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
      }
    });

    it("always includes reasoning", () => {
      const result = selectMode("fdm", 1);
      expect(typeof result.reasoning).toBe("string");
      expect(result.reasoning.length).toBeGreaterThan(10);
    });

    it("includes an alternative mode", () => {
      const result = selectMode("fdm", 1);
      expect(result.alternativeMode).toBeTruthy();
      expect(result.alternativeMode).not.toBe(result.recommendedMode);
    });
  });
});

describe("getAvailableModes", () => {
  it("returns all 5 TMP modes", () => {
    const modes = getAvailableModes();
    expect(modes).toHaveLength(5);
    const names = modes.map((m) => m.mode);
    expect(names).toContain("bounty");
    expect(names).toContain("claim");
    expect(names).toContain("pitch");
    expect(names).toContain("benchmark");
    expect(names).toContain("auction");
  });

  it("each mode has a description and selector", () => {
    const modes = getAvailableModes();
    for (const m of modes) {
      expect(m.description.length).toBeGreaterThan(10);
      expect(m.selector).toMatch(/^0x[0-9a-f]{8}$/);
    }
  });
});
