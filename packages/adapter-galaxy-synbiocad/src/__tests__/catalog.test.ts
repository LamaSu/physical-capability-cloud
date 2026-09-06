import { describe, it, expect } from "vitest";

import {
  getCatalog,
  listTools,
  getTool,
  requireTool,
  toolsByStage,
  toWorkflowStep,
} from "../index.js";

describe("catalog", () => {
  const cat = getCatalog();

  it("loads with the expected top-level shape", () => {
    expect(cat.provider).toBe("galaxy-synbiocad");
    expect(cat.commit).toBeTruthy();
    expect(cat.tool_count).toBe(cat.tools.length);
    expect(cat.tool_count).toBeGreaterThan(50);
  });

  it("every tool carries a stage and JSON-Schema I/O contract", () => {
    for (const t of cat.tools) {
      expect(t.id, `missing id: ${t.source_xml}`).toBeTruthy();
      expect(t.stage, `missing stage: ${t.id}`).toBeTruthy();
      const inSchema = t.input_schema as { type?: string; properties?: unknown };
      const outSchema = t.output_schema as { type?: string; properties?: unknown };
      expect(inSchema.type).toBe("object");
      expect(typeof inSchema.properties).toBe("object");
      expect(outSchema.type).toBe("object");
    }
  });

  it("input_schema exposes every flattened leaf param as a property", () => {
    for (const t of cat.tools) {
      const props = Object.keys((t.input_schema as { properties: Record<string, unknown> }).properties);
      for (const p of t.inputs_flat) {
        if (p.role === "expand" || !p.path) continue;
        expect(props, `${t.id} missing prop ${p.path}`).toContain(p.path);
      }
    }
  });

  it("required[] is always a subset of properties", () => {
    for (const t of cat.tools) {
      const schema = t.input_schema as { properties: Record<string, unknown>; required?: string[] };
      const props = new Set(Object.keys(schema.properties));
      for (const r of schema.required ?? []) {
        expect(props.has(r), `${t.id} requires unknown prop ${r}`).toBe(true);
      }
    }
  });

  it("advertised list is stable-only and excludes deprecated/draft duplicates", () => {
    const adv = listTools();
    expect(adv.length).toBeGreaterThan(40);
    expect(adv.every((t) => t.status === "stable")).toBe(true);
    expect(adv.find((t) => t.id === "retropath2")).toBeTruthy();
    // the older standalone rpcompletion is deprecated, so not advertised
    expect(adv.find((t) => t.id === "rpcompletion" && t.category === "rpcompletion")).toBeFalsy();
  });

  it("groups tools by pipeline stage in canonical order", () => {
    const grouped = toolsByStage();
    const keys = Object.keys(grouped);
    expect(keys.indexOf("retrosynthesis")).toBeLessThan(keys.indexOf("dna-assembly"));
    expect(grouped["retrosynthesis"].some((t) => t.id === "retropath2")).toBe(true);
  });

  it("getTool + requireTool behave", () => {
    expect(getTool("retropath2")?.name).toBe("RetroPath2.0");
    expect(getTool("does-not-exist")).toBeUndefined();
    expect(() => requireTool("does-not-exist")).toThrow(/Unknown Galaxy-SynBioCAD tool/);
  });

  it("toWorkflowStep yields a composable DigitalWorkflowStep", () => {
    const step = toWorkflowStep("retropath2");
    expect(step.stepId).toBe("galaxy:retropath2");
    expect(step.stepType).toBe("api_call");
    expect(step.dependsOn).toEqual([]);
    const props = (step.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.source_inchi).toBeTruthy();
    // dependsOn lets it chain onto a physical step in a mixed DAG
    const chained = toWorkflowStep("dnabot", { dependsOn: ["galaxy:rpbasicdesign"] });
    expect(chained.dependsOn).toEqual(["galaxy:rpbasicdesign"]);
  });
});
