/**
 * Tests for ProtocolCompiler — abstract PCC steps → Opentrons Python code.
 */
import { describe, it, expect } from "vitest";
import { ProtocolCompiler } from "../opentrons/compiler.js";
import type { ProtocolTemplate, ProtocolStep } from "@pcc/spec";
import type { DeckLayout } from "../opentrons/types.js";

const MOCK_DECK: DeckLayout = {
  slots: {
    "1": {
      loadName: "opentrons_96_tiprack_300ul",
      displayName: "300µL Tip Rack",
      namespace: "opentrons",
      version: 1,
      slot: "1",
    },
    "2": {
      loadName: "corning_96_wellplate_360ul_flat",
      displayName: "96-Well Plate",
      namespace: "corning",
      version: 1,
      slot: "2",
    },
    "3": {
      loadName: "nest_12_reservoir_15ml",
      displayName: "12-Channel Reservoir",
      namespace: "nest",
      version: 1,
      slot: "3",
    },
  },
  modules: [],
};

function makeStep(overrides: Partial<ProtocolStep> & { id: string; action: string }): ProtocolStep {
  return {
    capabilityType: "liquid-handler",
    label: overrides.action,
    params: {},
    estimatedDurationMs: 5000,
    producesEvidence: true,
    dependsOn: [],
    ...overrides,
  };
}

function makeTemplate(steps: ProtocolStep[]): ProtocolTemplate {
  return {
    id: "tmpl-test",
    name: "Test Protocol",
    description: "A test protocol",
    version: "1.0",
    authorId: "test",
    authorName: "Test Author",
    status: "published",
    tags: ["test"],
    requiredCapabilities: ["liquid-handler"],
    steps,
    transfers: [],
    parameters: [],
    defaultValues: {},
    estimatedTotalDurationMs: steps.reduce((s, st) => s + st.estimatedDurationMs, 0),
    forkCount: 0,
    runCount: 0,
    createdAt: new Date().toISOString(),
  };
}

describe("ProtocolCompiler", () => {
  const compiler = new ProtocolCompiler("2.18");

  it("should compile a simple transfer protocol", () => {
    const steps = [
      makeStep({
        id: "s1",
        action: "transfer",
        label: "Transfer sample",
        params: { volume: 100, sourceWell: "A1", destWell: "B1", sourceSlot: "2", destSlot: "3" },
      }),
    ];

    const result = compiler.compile(makeTemplate(steps), {}, MOCK_DECK);

    expect(result.source).toContain("metadata =");
    expect(result.source).toContain("def run(protocol):");
    expect(result.source).toContain("transfer(100");
    expect(result.source).toContain("apiLevel': '2.18'");
    expect(result.warnings).toHaveLength(0);
  });

  it("should compile aspirate + dispense steps", () => {
    const steps = [
      makeStep({
        id: "s1",
        action: "aspirate",
        label: "Aspirate from plate",
        params: { volume: 50, well: "A1", slot: "2" },
      }),
      makeStep({
        id: "s2",
        action: "dispense",
        label: "Dispense to reservoir",
        params: { volume: 50, well: "A1", slot: "3" },
        dependsOn: ["s1"],
      }),
    ];

    const result = compiler.compile(makeTemplate(steps), {}, MOCK_DECK);

    expect(result.source).toContain("aspirate(50");
    expect(result.source).toContain("dispense(50");
    // Aspirate should come before dispense (DAG order)
    const aspirateIdx = result.source.indexOf("aspirate");
    const dispenseIdx = result.source.indexOf("dispense");
    expect(aspirateIdx).toBeLessThan(dispenseIdx);
  });

  it("should compile mix step", () => {
    const steps = [
      makeStep({
        id: "s1",
        action: "mix",
        label: "Mix sample",
        params: { repetitions: 5, volume: 100, well: "A1", slot: "2" },
      }),
    ];

    const result = compiler.compile(makeTemplate(steps), {}, MOCK_DECK);
    expect(result.source).toContain("mix(5, 100");
  });

  it("should compile distribute step", () => {
    const steps = [
      makeStep({
        id: "s1",
        action: "distribute",
        label: "Distribute reagent",
        params: {
          volume: 20,
          sourceWell: "A1",
          sourceSlot: "3",
          destSlot: "2",
          destWells: ["A1", "A2", "A3", "A4"],
        },
      }),
    ];

    const result = compiler.compile(makeTemplate(steps), {}, MOCK_DECK);
    expect(result.source).toContain("distribute(20");
    expect(result.source).toContain("'A1'");
    expect(result.source).toContain("'A4'");
  });

  it("should handle parameter bindings", () => {
    const steps = [
      makeStep({
        id: "s1",
        action: "aspirate",
        label: "Aspirate",
        params: { well: "A1", slot: "2" },
        parameterBindings: [
          { stepParamKey: "volume", protocolParamKey: "aspirate_volume" },
        ],
      }),
    ];

    const result = compiler.compile(
      makeTemplate(steps),
      { aspirate_volume: 75 },
      MOCK_DECK,
    );

    expect(result.source).toContain("aspirate(75");
  });

  it("should load labware from deck layout", () => {
    const steps = [
      makeStep({ id: "s1", action: "comment", params: { message: "hello" } }),
    ];

    const result = compiler.compile(makeTemplate(steps), {}, MOCK_DECK);

    expect(result.source).toContain("opentrons_96_tiprack_300ul");
    expect(result.source).toContain("corning_96_wellplate_360ul_flat");
    expect(result.source).toContain("nest_12_reservoir_15ml");
    expect(result.requiredLabware).toHaveLength(3);
  });

  it("should warn on unknown actions", () => {
    const steps = [
      makeStep({ id: "s1", action: "teleport_liquid", label: "Magic" }),
    ];

    const result = compiler.compile(makeTemplate(steps), {}, MOCK_DECK);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("teleport_liquid");
  });

  it("should respect DAG ordering via dependsOn", () => {
    const steps = [
      makeStep({ id: "s3", action: "comment", label: "Third", params: { message: "3" }, dependsOn: ["s2"] }),
      makeStep({ id: "s1", action: "comment", label: "First", params: { message: "1" }, dependsOn: [] }),
      makeStep({ id: "s2", action: "comment", label: "Second", params: { message: "2" }, dependsOn: ["s1"] }),
    ];

    const result = compiler.compile(makeTemplate(steps), {}, MOCK_DECK);

    const idx1 = result.source.indexOf("Step: First");
    const idx2 = result.source.indexOf("Step: Second");
    const idx3 = result.source.indexOf("Step: Third");

    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
  });

  it("should compile delay and pause steps", () => {
    const steps = [
      makeStep({ id: "s1", action: "delay", label: "Wait", params: { seconds: 120 } }),
      makeStep({ id: "s2", action: "pause", label: "Operator check", params: { message: "Check plate" }, dependsOn: ["s1"] }),
    ];

    const result = compiler.compile(makeTemplate(steps), {}, MOCK_DECK);
    expect(result.source).toContain("delay(seconds=120)");
    expect(result.source).toContain("pause('Check plate')");
  });

  it("should calculate total estimated duration", () => {
    const steps = [
      makeStep({ id: "s1", action: "transfer", label: "T1", estimatedDurationMs: 10000, params: {} }),
      makeStep({ id: "s2", action: "mix", label: "M1", estimatedDurationMs: 5000, params: {} }),
    ];

    const result = compiler.compile(makeTemplate(steps), {}, MOCK_DECK);
    expect(result.estimatedDurationMs).toBe(15000);
  });

  it("should include protocol metadata", () => {
    const steps = [makeStep({ id: "s1", action: "comment", params: { message: "hi" } })];
    const template = makeTemplate(steps);
    template.name = "My Custom Protocol";
    template.description = "Does something cool";

    const result = compiler.compile(template, {}, MOCK_DECK);
    expect(result.metadata.protocolName).toBe("My Custom Protocol");
    expect(result.metadata.apiLevel).toBe("2.18");
    expect(result.source).toContain("My Custom Protocol");
  });
});
