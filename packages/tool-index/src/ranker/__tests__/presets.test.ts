import { describe, it, expect } from "vitest";
import {
  PRESET_AGENT_DEFAULT,
  PRESET_COMPLIANCE_STRICT,
  PRESET_DISCOVERY_EXPLORE,
  presetNames,
  resolveWeights,
} from "../presets.js";

describe("presets", () => {
  it("agent-default weights match scope doc §4.4", () => {
    expect(PRESET_AGENT_DEFAULT).toEqual({
      relevance: 1.0,
      trust: 2.0,
      provenance: 2.5,
      reputation: 1.0,
      freshness: 0.8,
      price: 0.5,
      geo: 1.5,
    });
  });

  it("compliance-strict weighs trust + provenance higher", () => {
    expect(PRESET_COMPLIANCE_STRICT.trust).toBeGreaterThan(PRESET_AGENT_DEFAULT.trust);
    expect(PRESET_COMPLIANCE_STRICT.provenance).toBeGreaterThan(
      PRESET_AGENT_DEFAULT.provenance,
    );
    expect(PRESET_COMPLIANCE_STRICT.reputation).toBeLessThan(
      PRESET_AGENT_DEFAULT.reputation,
    );
  });

  it("discovery-explore weighs relevance dominant + disables geo/price", () => {
    expect(PRESET_DISCOVERY_EXPLORE.relevance).toBeGreaterThan(
      PRESET_AGENT_DEFAULT.relevance,
    );
    expect(PRESET_DISCOVERY_EXPLORE.geo).toBe(0);
    expect(PRESET_DISCOVERY_EXPLORE.price).toBe(0);
  });

  it("resolveWeights merges overrides on top of preset", () => {
    const w = resolveWeights("agent-default", { provenance: 10 });
    expect(w.provenance).toBe(10);
    expect(w.trust).toBe(PRESET_AGENT_DEFAULT.trust); // unchanged
  });

  it("presetNames returns all three", () => {
    const names = presetNames();
    expect(names).toContain("agent-default");
    expect(names).toContain("compliance-strict");
    expect(names).toContain("discovery-explore");
  });
});
