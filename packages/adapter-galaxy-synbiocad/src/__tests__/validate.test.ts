import { describe, it, expect } from "vitest";

import { getTool, validateParams } from "../index.js";

describe("validateParams", () => {
  const retropath2 = getTool("retropath2")!;

  it("accepts a valid param set", () => {
    const r = validateParams(retropath2, {
      rulesfile: "hda-1",
      source_inchi: "InChI=1S/CH4/h1H4",
      max_steps: 3,
    });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("flags missing required params", () => {
    const r = validateParams(retropath2, { max_steps: 3 });
    expect(r.valid).toBe(false);
    const paths = r.errors.map((e) => e.path);
    expect(paths).toContain("rulesfile");
    expect(paths).toContain("source_inchi");
  });

  it("flags out-of-range integers (max_steps max=10)", () => {
    const r = validateParams(retropath2, {
      rulesfile: "hda-1",
      source_inchi: "x",
      max_steps: 99,
    });
    expect(r.valid).toBe(false);
    expect(r.errors.find((e) => e.path === "max_steps")?.message).toMatch(/<=/);
  });

  it("flags enum violations on a conditional selector", () => {
    const r = validateParams(retropath2, {
      rulesfile: "hda-1",
      source_inchi: "x",
      "sink.emptysink": "maybe",
    });
    expect(r.valid).toBe(false);
    expect(r.errors.find((e) => e.path === "sink.emptysink")).toBeTruthy();
  });

  it("flags unknown params (typo protection)", () => {
    const r = validateParams(retropath2, {
      rulesfile: "hda-1",
      source_inchi: "x",
      bogusParam: 1,
    });
    expect(r.errors.find((e) => e.path === "bogusParam")?.message).toMatch(/unknown parameter/);
  });

  it("accepts a dataset input as a string id OR a {src,...} ref", () => {
    const asString = validateParams(retropath2, { rulesfile: "hda-1", source_inchi: "x" });
    const asRef = validateParams(retropath2, {
      rulesfile: { src: "url", url: "https://example.org/rules.csv" },
      source_inchi: "x",
    });
    expect(asString.valid).toBe(true);
    expect(asRef.valid).toBe(true);
  });
});
