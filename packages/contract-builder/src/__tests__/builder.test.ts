import { describe, it, expect } from "vitest";
import { ContractBuilder } from "../builder.js";

const builder = new ContractBuilder();

describe("ContractBuilder", () => {
  describe("getBuildOptions", () => {
    it("returns resolved options for FDM", () => {
      const options = builder.getBuildOptions("fdm");
      expect(options.capabilityType).toBe("fdm");
      expect(options.templateName).toBe("FDM 3D Printing");
      expect(options.allParams.length).toBe(9);
      expect(options.groups.length).toBeGreaterThanOrEqual(3);
    });

    it("returns resolved options for CNC", () => {
      const options = builder.getBuildOptions("cnc-3axis");
      expect(options.capabilityType).toBe("cnc-3axis");
      expect(options.templateName).toBe("CNC 3-Axis Milling");
    });

    it("returns resolved options for SLA", () => {
      const options = builder.getBuildOptions("sla");
      expect(options.capabilityType).toBe("sla");
    });

    it("returns resolved options for laser cutting", () => {
      const options = builder.getBuildOptions("laser-cut");
      expect(options.capabilityType).toBe("laser-cut");
    });

    it("throws for unknown capability type", () => {
      expect(() => builder.getBuildOptions("unknown" as any)).toThrow("No template registered");
    });

    it("applies profile when specified", () => {
      const options = builder.getBuildOptions("fdm", {}, "profile_prusa_mk4");
      expect(options.machineInfo).toBeDefined();
      expect(options.machineInfo!.machineName).toBe("Prusa MK4");
      const materials = options.allParams.find((p) => p.def.key === "material");
      expect((materials!.def as any).options.length).toBe(4);
    });
  });

  describe("calculatePrice", () => {
    it("calculates base price for FDM", () => {
      const result = builder.calculatePrice("fdm", {});
      expect(result.totalPrice).toBe(15);
    });

    it("calculates price with options", () => {
      const result = builder.calculatePrice("fdm", {
        material: "abs",
        infill: 20,
        supports: true,
        quantity: 3,
      });
      expect(result.totalPrice).toBeGreaterThan(15);
      expect(result.breakdown.length).toBeGreaterThan(0);
    });
  });

  describe("buildContract", () => {
    it("builds a valid FDM contract", () => {
      const contract = builder.buildContract("fdm", {
        material: "pla",
        infill: 20,
        layerHeight: "0.20",
        quantity: 1,
      });
      expect(contract.isValid).toBe(true);
      expect(contract.validationErrors.length).toBe(0);
      expect(contract.cwmStep.capability).toBe("fdm");
      expect(contract.cwmStep.params.material).toBe("pla");
      expect(parseFloat(contract.totalPrice)).toBeGreaterThan(0);
    });

    it("fails validation for missing required params", () => {
      const contract = builder.buildContract("fdm", {});
      expect(contract.isValid).toBe(false);
      expect(contract.validationErrors.length).toBeGreaterThan(0);
      const missingMaterial = contract.validationErrors.find((e) => e.paramKey === "material");
      expect(missingMaterial).toBeDefined();
    });

    it("fails validation for invalid enum value", () => {
      const contract = builder.buildContract("fdm", {
        material: "unobtanium",
        infill: 20,
        layerHeight: "0.20",
        quantity: 1,
      });
      expect(contract.isValid).toBe(false);
      expect(contract.validationErrors.some((e) => e.paramKey === "material")).toBe(true);
    });

    it("fails validation for out-of-range number", () => {
      const contract = builder.buildContract("fdm", {
        material: "pla",
        infill: 200,  // max is 100
        layerHeight: "0.20",
        quantity: 1,
      });
      expect(contract.isValid).toBe(false);
      expect(contract.validationErrors.some((e) => e.paramKey === "infill")).toBe(true);
    });

    it("builds a valid CNC contract", () => {
      const contract = builder.buildContract("cnc-3axis", {
        material: "aluminum-6061",
        tolerance: "standard",
        quantity: 1,
      });
      expect(contract.isValid).toBe(true);
      expect(contract.cwmStep.capability).toBe("cnc-3axis");
    });

    it("includes price breakdown", () => {
      const contract = builder.buildContract("fdm", {
        material: "abs",
        infill: 40,
        layerHeight: "0.15",
        supports: true,
        supportType: "tree",
        postProcessing: ["sanding"],
        quantity: 2,
      });
      expect(contract.isValid).toBe(true);
      expect(contract.priceBreakdown.length).toBeGreaterThan(0);
      expect(parseFloat(contract.totalPrice)).toBeGreaterThan(30);
    });

    it("applies profile constraints in validation", () => {
      // Prusa MK4 only supports pla, petg, abs, tpu
      const contract = builder.buildContract("fdm", {
        material: "nylon",   // not available on MK4
        infill: 20,
        layerHeight: "0.20",
        quantity: 1,
      }, 1, "profile_prusa_mk4");
      expect(contract.isValid).toBe(false);
      expect(contract.validationErrors.some((e) => e.paramKey === "material")).toBe(true);
    });

    it("sets assurance tier in CWM step", () => {
      const contract = builder.buildContract("fdm", {
        material: "pla",
        infill: 20,
        layerHeight: "0.20",
        quantity: 1,
      }, 2);
      expect(contract.cwmStep.assuranceTier).toBe(2);
    });
  });
});
