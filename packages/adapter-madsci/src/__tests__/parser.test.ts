import { describe, it, expect } from "vitest";
import { parseMadsciWorkflow, MadsciParseError } from "../parser.js";

const VALID_YAML = `
schema: madsci/v1
name: pcr-amplification
description: Luna qPCR run
metadata:
  lab: rpl
  experimenter: prism
steps:
  - name: load-plate
    action:
      node: pf400-arm
      action: pick_and_place
      args:
        source: deck.A1
        target: thermocycler.slot1
  - name: start-pcr
    action:
      node: thermocycler-01
      action: run_program
      args:
        program: luna_qpcr_40cycles
    after: [load-plate]
`;

describe("parseMadsciWorkflow", () => {
  it("parses a valid MADSci workflow", () => {
    const wf = parseMadsciWorkflow(VALID_YAML);
    expect(wf.name).toBe("pcr-amplification");
    expect(wf.steps).toHaveLength(2);
    expect(wf.steps[0].action.node).toBe("pf400-arm");
    expect(wf.steps[1].after).toEqual(["load-plate"]);
  });

  it("defaults schema when absent", () => {
    const minimal = `
name: minimal
steps:
  - name: noop
    action:
      node: n1
      action: a1
`;
    const wf = parseMadsciWorkflow(minimal);
    expect(wf.schema).toBe("madsci/v1");
  });

  it("throws MadsciParseError on missing required field", () => {
    const broken = `
name: oops
steps: []
`;
    expect(() => parseMadsciWorkflow(broken)).toThrow(MadsciParseError);
  });

  it("throws MadsciParseError on YAML syntax error", () => {
    expect(() => parseMadsciWorkflow("not: : yaml")).toThrow(MadsciParseError);
  });
});
