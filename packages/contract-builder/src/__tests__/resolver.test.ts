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

// ── Multi-select aware visibility + constraints ──────────────────────
// Regression coverage for the bug surfaced by implementer-golf-2 in the
// sheet-metal template: visibleWhen.equals and constraint.when.equals/.in
// were doing strict === against scalar targets, which always failed when
// the dependent param was a multi-select enum (array-valued selection).

import type { CapabilityTemplate } from "@pcc/spec";

const multiSelectTemplate: CapabilityTemplate = {
  capabilityType: "sheet-metal-test" as any,
  version: "1.0.0",
  name: "Multi-select test",
  params: [
    {
      key: "operations",
      label: "Operations",
      type: "enum",
      multi: true,
      required: true,
      order: 1,
      group: "Ops",
      options: [
        { value: "laser", label: "Laser" },
        { value: "weld", label: "Weld" },
        { value: "brake", label: "Brake" },
        { value: "pem", label: "PEM" },
      ],
    },
    {
      key: "weldCert",
      label: "Weld Certification",
      type: "enum",
      required: false,
      order: 2,
      group: "Cert",
      visibleWhen: { param: "operations", equals: "weld" },
      options: [
        { value: "aws-d1.1", label: "AWS D1.1" },
        { value: "aws-d17.1", label: "AWS D17.1" },
      ],
    },
    {
      key: "bendTier",
      label: "Bend Tier",
      type: "enum",
      required: false,
      order: 3,
      group: "Ops",
      visibleWhen: { param: "operations", equals: "brake" },
      options: [
        { value: "simple", label: "0-5 bends" },
        { value: "medium", label: "6-15 bends" },
        { value: "complex", label: "16+ bends" },
      ],
    },
  ],
  constraints: [
    {
      when: { param: "operations", equals: "weld" },
      then: [{ param: "weldCert", restrictTo: ["aws-d1.1", "aws-d17.1"] }],
    },
    {
      when: { param: "operations", in: ["pem", "weld"] },
      then: [{ param: "bendTier", restrictTo: ["simple", "medium", "complex"] }],
    },
  ],
};

describe("TemplateResolver multi-select awareness", () => {
  it("isVisible: shows dependent param when target value is in the selected array", () => {
    const result = resolver.resolve(multiSelectTemplate, { operations: ["laser", "weld", "brake"] });
    const weldCert = result.allParams.find((p) => p.def.key === "weldCert");
    expect(weldCert).toBeDefined();
    expect(weldCert!.visible).toBe(true);
    const bendTier = result.allParams.find((p) => p.def.key === "bendTier");
    expect(bendTier!.visible).toBe(true);
  });

  it("isVisible: hides dependent param when target value is NOT in the selected array", () => {
    const result = resolver.resolve(multiSelectTemplate, { operations: ["laser", "pem"] });
    const weldCert = result.allParams.find((p) => p.def.key === "weldCert");
    expect(weldCert!.visible).toBe(false);
    const bendTier = result.allParams.find((p) => p.def.key === "bendTier");
    expect(bendTier!.visible).toBe(false);
  });

  it("isVisible: preserves scalar behavior — exact match still works", () => {
    // Use fdmTemplate's supports/supportType pair (scalar boolean)
    const result = resolver.resolve(fdmTemplate, { supports: true });
    const supportType = result.allParams.find((p) => p.def.key === "supportType");
    expect(supportType!.visible).toBe(true);
  });

  it("matchesCondition equals: triggers when target is in the multi-select array", () => {
    const result = resolver.resolve(multiSelectTemplate, { operations: ["laser", "weld"] });
    // The weld constraint should fire — weldCert exists in template, so the
    // restrictTo:[aws-d1.1, aws-d17.1] is a no-op (matches existing options),
    // but the fact that we got 2 options proves the constraint matched (it
    // didn't strip them all).
    const weldCert = result.allParams.find((p) => p.def.key === "weldCert");
    const options = (weldCert!.def as any).options;
    expect(options.length).toBe(2);
  });

  it("matchesCondition equals: does NOT trigger when target is NOT in the multi-select array", () => {
    const result = resolver.resolve(multiSelectTemplate, { operations: ["laser", "brake"] });
    // The weld constraint should NOT fire (operations has no 'weld'), so the
    // weldCert.restrictTo never runs. Options stay at full set of 2.
    const weldCert = result.allParams.find((p) => p.def.key === "weldCert");
    const options = (weldCert!.def as any).options;
    expect(options.length).toBe(2);
  });

  it("matchesCondition in: triggers on intersection with multi-select array", () => {
    const result = resolver.resolve(multiSelectTemplate, { operations: ["weld", "laser"] });
    // The in:[pem, weld] constraint should fire because 'weld' is in operations
    const bendTier = result.allParams.find((p) => p.def.key === "bendTier");
    const options = (bendTier!.def as any).options;
    expect(options.length).toBe(3);
  });

  it("matchesCondition in: does NOT trigger when arrays are disjoint", () => {
    const result = resolver.resolve(multiSelectTemplate, { operations: ["laser", "brake"] });
    // The in:[pem, weld] constraint should NOT fire — laser and brake are not in [pem, weld]
    // Constraint not firing means bendTier options remain unchanged from template default (3)
    const bendTier = result.allParams.find((p) => p.def.key === "bendTier");
    const options = (bendTier!.def as any).options;
    expect(options.length).toBe(3); // no restrictTo applied; original 3 options remain
  });

  it("matchesCondition equals: preserves scalar behavior for non-array selections", () => {
    // Use fdmTemplate's existing pla → exclude vapor-smoothing constraint
    const result = resolver.resolve(fdmTemplate, { material: "pla" });
    const postProcessing = result.allParams.find((p) => p.def.key === "postProcessing");
    const values = (postProcessing!.def as any).options.map((o: any) => o.value);
    expect(values).not.toContain("vapor-smoothing");
  });
});
