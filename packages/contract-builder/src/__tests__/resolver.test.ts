import { describe, it, expect } from "vitest";
import { TemplateResolver } from "../resolver.js";
import { fdmTemplate } from "../templates/fdm.js";
import { prusaMk4Profile } from "../profiles/prusa-mk4.js";

const resolver = new TemplateResolver();

describe("TemplateResolver", () => {
  it("resolves a template without profile or selections", () => {
    const result = resolver.resolve(fdmTemplate, {});
    expect(result.capabilityType).toBe("fdm");
    expect(result.templateName).toBe("FDM 3D Printing");
    expect(result.allParams.length).toBe(9);
    expect(result.groups.length).toBeGreaterThan(0);
    expect(result.basePrice).toBe("15.00");
  });

  it("groups params correctly", () => {
    const result = resolver.resolve(fdmTemplate, {});
    const groupNames = result.groups.map((g) => g.name);
    expect(groupNames).toContain("Material");
    expect(groupNames).toContain("Print Settings");
    expect(groupNames).toContain("Post-Processing");
    expect(groupNames).toContain("Order");
  });

  it("hides supportType when supports=false", () => {
    const result = resolver.resolve(fdmTemplate, { supports: false });
    const supportType = result.allParams.find((p) => p.def.key === "supportType");
    expect(supportType).toBeDefined();
    expect(supportType!.visible).toBe(false);
  });

  it("shows supportType when supports=true", () => {
    const result = resolver.resolve(fdmTemplate, { supports: true });
    const supportType = result.allParams.find((p) => p.def.key === "supportType");
    expect(supportType!.visible).toBe(true);
  });

  it("applies profile overrides — restricts materials", () => {
    const result = resolver.resolve(fdmTemplate, {}, prusaMk4Profile);
    const material = result.allParams.find((p) => p.def.key === "material");
    expect(material).toBeDefined();
    const options = (material!.def as any).options;
    const values = options.map((o: any) => o.value);
    expect(values).toEqual(["pla", "petg", "abs", "tpu"]);
    // nylon, pc, asa, cf-nylon should be excluded
    expect(values).not.toContain("nylon");
    expect(values).not.toContain("pc");
  });

  it("applies profile base price override", () => {
    const result = resolver.resolve(fdmTemplate, {}, prusaMk4Profile);
    expect(result.basePrice).toBe("12.00");
  });

  it("applies constraint: PLA excludes vapor-smoothing", () => {
    const result = resolver.resolve(fdmTemplate, { material: "pla" });
    const postProcessing = result.allParams.find((p) => p.def.key === "postProcessing");
    const options = (postProcessing!.def as any).options;
    const values = options.map((o: any) => o.value);
    expect(values).not.toContain("vapor-smoothing");
    expect(values).toContain("sanding");
  });

  it("applies constraint: TPU restricts supportType to normal", () => {
    const result = resolver.resolve(fdmTemplate, { material: "tpu", supports: true });
    const supportType = result.allParams.find((p) => p.def.key === "supportType");
    const options = (supportType!.def as any).options;
    const values = options.map((o: any) => o.value);
    expect(values).toEqual(["normal"]);
  });

  it("applies constraint: high infill restricts layer heights", () => {
    const result = resolver.resolve(fdmTemplate, { infill: 90 });
    const layerHeight = result.allParams.find((p) => p.def.key === "layerHeight");
    const options = (layerHeight!.def as any).options;
    const values = options.map((o: any) => o.value);
    expect(values).toEqual(["0.20", "0.30"]);
    expect(values).not.toContain("0.10");
    expect(values).not.toContain("0.15");
  });

  it("does not apply high-infill constraint at infill=80", () => {
    const result = resolver.resolve(fdmTemplate, { infill: 80 });
    const layerHeight = result.allParams.find((p) => p.def.key === "layerHeight");
    const options = (layerHeight!.def as any).options;
    const values = options.map((o: any) => o.value);
    // gt: 80 means >80, so 80 should NOT trigger
    expect(values).toContain("0.10");
    expect(values).toContain("0.15");
  });

  it("includes machine info when profile is provided", () => {
    const result = resolver.resolve(fdmTemplate, {}, prusaMk4Profile);
    expect(result.machineInfo).toBeDefined();
    expect(result.machineInfo!.machineName).toBe("Prusa MK4");
    expect(result.machineInfo!.profileId).toBe("profile_prusa_mk4");
  });
});
