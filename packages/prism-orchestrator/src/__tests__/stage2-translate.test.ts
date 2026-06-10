import { describe, it, expect } from "vitest";
import { translateStepsToMadsci } from "../stage2-translate.js";
import type { StepDraft } from "../types.js";

const STEPS: StepDraft[] = [
  {
    name: "Aspirate",
    instrument: "ot2",
    action: "aspirate",
    reagent: "master_mix",
    volumeUl: 20,
    source: "reservoir.A1",
  },
  {
    name: "Dispense",
    instrument: "ot2",
    action: "dispense",
    volumeUl: 20,
    target: "plate.A1",
    notes: { rate: "default" },
  },
];

describe("translateStepsToMadsci", () => {
  it("maps reagent/volume into args and source/target into locations", () => {
    const wf = translateStepsToMadsci(STEPS, { workflowName: "wf1" });
    expect(wf.steps).toHaveLength(2);
    expect(wf.steps[0].name).toBe("step-1");
    expect(wf.steps[0].action.node).toBe("ot2");
    expect(wf.steps[0].action.args?.reagent).toBe("master_mix");
    expect(wf.steps[0].action.args?.volume_ul).toBe(20);
    expect(wf.steps[0].action.locations?.source).toBe("reservoir.A1");
    expect(wf.steps[1].action.locations?.target).toBe("plate.A1");
    expect(wf.steps[1].action.args?.rate).toBe("default");
  });

  it("stamps prism-orchestrator metadata.source", () => {
    const wf = translateStepsToMadsci(STEPS, {
      workflowName: "wf1",
      metadata: { lab: "rpl" },
    });
    expect(wf.metadata?.source).toBe("prism-orchestrator");
    expect(wf.metadata?.lab).toBe("rpl");
  });
});
