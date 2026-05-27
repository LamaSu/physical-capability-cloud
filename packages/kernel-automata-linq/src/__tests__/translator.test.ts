import { describe, it, expect } from "vitest";
import {
  linqWorkflowToMadsci,
  madsciWorkflowToLinq,
} from "../translator.js";
import type { LinqWorkflow } from "../types.js";

const LINQ_WF: LinqWorkflow = {
  id: "wf-pcr-01",
  name: "PCR Amplification",
  description: "Luna qPCR 40 cycles",
  workcell_id: "wc-bench-01",
  version: "1.2.0",
  tasks: [
    {
      id: "task-1",
      name: "Load plate",
      instrument_id: "pf400-arm",
      action: "pick_and_place",
      args: { source: "deck.A1" },
      labware: { source: "plate-01", target: "thermocycler.slot1" },
    },
    {
      id: "task-2",
      name: "Run program",
      instrument_id: "thermocycler-01",
      action: "run_program",
      args: { program: "luna_qpcr_40cycles" },
    },
  ],
};

describe("linqWorkflowToMadsci", () => {
  it("translates resources cleanly", () => {
    const m = linqWorkflowToMadsci(LINQ_WF);
    expect(m.schema).toBe("madsci/v1");
    expect(m.name).toBe("PCR Amplification");
    expect(m.metadata?.source).toBe("automata-linq");
    expect(m.metadata?.linq_workflow_id).toBe("wf-pcr-01");
    expect(m.steps).toHaveLength(2);
    expect(m.steps[0].action.node).toBe("pf400-arm");
    expect(m.steps[0].action.action).toBe("pick_and_place");
    expect(m.steps[0].action.locations?.source).toBe("plate-01");
    expect(m.steps[1].action.args?.program).toBe("luna_qpcr_40cycles");
  });

  it("preserves LINQ version in metadata", () => {
    const m = linqWorkflowToMadsci(LINQ_WF);
    expect(m.metadata?.linq_version).toBe("1.2.0");
  });
});

describe("madsciWorkflowToLinq", () => {
  it("round-trips an LINQ → MADSci → LINQ shape", () => {
    const m = linqWorkflowToMadsci(LINQ_WF);
    const linq2 = madsciWorkflowToLinq(m, "wc-bench-01");
    expect(linq2.name).toBe("PCR Amplification");
    expect(linq2.workcell_id).toBe("wc-bench-01");
    expect(linq2.tasks).toHaveLength(2);
    expect(linq2.tasks[0].instrument_id).toBe("pf400-arm");
    expect(linq2.tasks[0].action).toBe("pick_and_place");
  });
});
