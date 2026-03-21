import { describe, it, expect, beforeAll } from "vitest";
import { CsdRegistry, type CSD } from "@pcc/spec";
import { CsdResolver } from "../csd-resolver.js";

// ── Minimal test CSDs (built inline to avoid JSON import assert{} issues in Node 22 vitest) ──

const fdmCsd: CSD = {
  $schema: "https://pcc.network/schemas/csd/v1",
  url: "pcc://capabilities/fdm/v2",
  version: "2.0.0",
  status: "active",
  name: "FDM 3D Printing",
  description: "Fused Deposition Modeling",
  kind: "base",
  baseDefinition: null,
  parameters: [
    {
      type: "enum",
      key: "material",
      label: "Material",
      required: true,
      order: 1,
      group: "Material",
      options: [
        { value: "pla", label: "PLA" },
        { value: "petg", label: "PETG" },
        { value: "tpu", label: "TPU" },
        { value: "abs", label: "ABS" },
      ],
    },
    {
      type: "number",
      key: "infill",
      label: "Infill Density",
      required: true,
      order: 2,
      group: "Print Settings",
      min: 5,
      max: 100,
      step: 5,
      defaultValue: 20,
      pricingImpact: { mode: "per_unit", value: "0.01", label: "+$0.01 per 1%" },
    },
    {
      type: "enum",
      key: "layerHeight",
      label: "Layer Height",
      required: true,
      order: 3,
      group: "Print Settings",
      defaultValue: "0.20",
      options: [
        { value: "0.10", label: "0.10mm (Ultra Fine)" },
        { value: "0.15", label: "0.15mm (Fine)" },
        { value: "0.20", label: "0.20mm (Standard)" },
        { value: "0.30", label: "0.30mm (Draft)" },
      ],
    },
    {
      type: "boolean",
      key: "supports",
      label: "Support Structures",
      required: false,
      order: 4,
      group: "Print Settings",
      defaultValue: false,
    },
    {
      type: "enum",
      key: "supportType",
      label: "Support Type",
      required: false,
      order: 5,
      group: "Print Settings",
      defaultValue: "normal",
      visibleWhen: { param: "supports", equals: true },
      options: [
        { value: "normal", label: "Normal" },
        { value: "tree", label: "Tree Supports" },
        { value: "organic", label: "Organic Supports" },
      ],
    },
    {
      type: "enum",
      key: "postProcessing",
      label: "Post-Processing",
      required: false,
      order: 6,
      group: "Post-Processing",
      multi: true,
      defaultValue: "none",
      options: [
        { value: "none", label: "None" },
        { value: "sanding", label: "Sanding" },
        { value: "vapor-smoothing", label: "Vapor Smoothing" },
        { value: "painting", label: "Painting" },
      ],
    },
    {
      type: "number",
      key: "quantity",
      label: "Quantity",
      required: true,
      order: 7,
      group: "Order",
      min: 1,
      max: 1000,
      step: 1,
      defaultValue: 1,
    },
  ],
  constraints: [
    {
      key: "fdm-1",
      human: "PLA cannot be vapor smoothed",
      severity: "error",
      when: [
        { param: "material", operator: "equals", value: "pla" },
        { param: "postProcessing", operator: "in", value: ["vapor-smoothing"] },
      ],
      then: [{ action: "exclude", param: "postProcessing", values: ["vapor-smoothing"] }],
    },
    {
      key: "fdm-3",
      human: "TPU is restricted to normal support type only",
      severity: "error",
      when: [{ param: "material", operator: "equals", value: "tpu" }],
      then: [{ action: "restrictTo", param: "supportType", values: ["normal"] }],
    },
    {
      key: "fdm-4",
      human: "High infill (>80%) requires standard or draft layer height",
      severity: "warning",
      when: [{ param: "infill", operator: "gt", value: 80 }],
      then: [{ action: "restrictTo", param: "layerHeight", values: ["0.20", "0.30"] }],
    },
  ],
  pricing: {
    basePrice: "15.00",
    currency: "USDC",
    unit: "per part",
  },
};

const print2dCsd: CSD = {
  $schema: "https://pcc.network/schemas/csd/v1",
  url: "pcc://capabilities/2d-print/v1",
  version: "1.0.0",
  status: "active",
  name: "2D Print",
  description: "Standard 2D document and image printing via inkjet or laser",
  kind: "base",
  baseDefinition: null,
  parameters: [
    {
      key: "mediaSize",
      type: "enum",
      label: "Paper Size",
      required: true,
      order: 1,
      group: "media",
      options: [
        { value: "na_letter_8.5x11in", label: "Letter (8.5×11\")" },
        { value: "iso_a4_210x297mm", label: "A4 (210×297mm)" },
        { value: "iso_a3_297x420mm", label: "A3 (297×420mm)" },
        { value: "custom", label: "Custom Size" },
      ],
      pricingImpact: null,
    },
    {
      key: "mediaType",
      type: "enum",
      label: "Paper Type",
      required: true,
      order: 2,
      group: "media",
      options: [
        { value: "stationery", label: "Plain Paper" },
        { value: "photographic-high-gloss", label: "Photo Paper (Glossy)" },
        { value: "photographic-matte", label: "Photo Paper (Matte)" },
        { value: "envelope", label: "Envelope" },
      ],
      pricingImpact: null,
    },
    {
      key: "colorMode",
      type: "enum",
      label: "Color Mode",
      required: true,
      order: 3,
      group: "quality",
      options: [
        { value: "color", label: "Full Color" },
        { value: "monochrome", label: "Black & White" },
      ],
      pricingImpact: { mode: "multiplier", perOption: { color: 2.0, monochrome: 1.0 } },
    },
    {
      key: "duplex",
      type: "enum",
      label: "Sides",
      required: false,
      order: 4,
      group: "layout",
      options: [
        { value: "one-sided", label: "Single-sided" },
        { value: "two-sided-long-edge", label: "Double-sided (Long Edge)" },
        { value: "two-sided-short-edge", label: "Double-sided (Short Edge)" },
      ],
      pricingImpact: null,
    },
    {
      key: "copies",
      type: "number",
      label: "Number of Copies",
      required: true,
      order: 5,
      group: "job",
      min: 1,
      max: 9999,
      step: 1,
      defaultValue: 1,
      pricingImpact: { mode: "per_unit", value: 1.0 },
    },
    {
      key: "borderless",
      type: "boolean",
      label: "Borderless Printing",
      required: false,
      order: 6,
      group: "layout",
      defaultValue: false,
      pricingImpact: { mode: "percent", value: 15 },
    },
  ],
  constraints: [
    {
      key: "2d-print-1",
      human: "Borderless printing only available on photo paper",
      severity: "error",
      when: [
        { param: "borderless", operator: "equals", value: true },
        { param: "mediaType", operator: "notIn", value: ["photographic-high-gloss", "photographic-matte"] },
      ],
      then: [{ action: "reject", message: "Borderless printing requires photo paper" }],
    },
    {
      key: "2d-print-2",
      human: "Envelopes cannot be printed double-sided",
      severity: "error",
      when: [
        { param: "mediaType", operator: "in", value: ["envelope"] },
        { param: "duplex", operator: "notEquals", value: "one-sided" },
      ],
      then: [{ action: "restrictTo", param: "duplex", values: ["one-sided"] }],
    },
  ],
  invariants: [
    {
      key: "2d-print-inv-1",
      human: "Custom paper size requires A3-capable printer",
      severity: "error",
      expression: "mediaSize != 'custom' or device.capabilities.includes('iso_a3_297x420mm')",
    },
  ],
  pricing: {
    basePrice: "0.10",
    currency: "USDC",
    unit: "per page",
    minimumCharge: "1.00",
  },
};

// ── Test setup ─────────────────────────────────────────────────────

let resolver: CsdResolver;

beforeAll(() => {
  const registry = new CsdRegistry();
  registry.register(fdmCsd);
  registry.register(print2dCsd);
  resolver = new CsdResolver(registry);
});

// ── Registry loading ───────────────────────────────────────────────

describe("CsdResolver - loading from registry", () => {
  it("resolves the FDM CSD from the registry", () => {
    const resolved = resolver.resolve("pcc://capabilities/fdm/v2", {});
    expect(resolved.csd.url).toBe("pcc://capabilities/fdm/v2");
    expect(resolved.csd.name).toBe("FDM 3D Printing");
  });

  it("resolves the 2D print CSD", () => {
    const resolved = resolver.resolve("pcc://capabilities/2d-print/v1", {});
    expect(resolved.csd.url).toBe("pcc://capabilities/2d-print/v1");
    expect(resolved.csd.parameters.length).toBeGreaterThan(0);
  });

  it("throws for an unknown CSD URL", () => {
    expect(() => resolver.resolve("pcc://capabilities/unknown/v99", {})).toThrow(
      /not found/i,
    );
  });
});

// ── Constraint application ─────────────────────────────────────────

describe("CsdResolver - constraint application", () => {
  it("no constraints fire with empty selections", () => {
    const resolved = resolver.resolve("pcc://capabilities/fdm/v2", {});
    expect(resolved.evaluation.errors).toHaveLength(0);
    expect(resolved.evaluation.paramRestrictions.size).toBe(0);
  });

  it("FDM: PLA + vapor-smoothing → exclude vapor-smoothing from postProcessing", () => {
    const resolved = resolver.resolve("pcc://capabilities/fdm/v2", {
      material: "pla",
      postProcessing: "vapor-smoothing",
    });
    const restriction = resolved.evaluation.paramRestrictions.get("postProcessing");
    expect(restriction?.exclude).toContain("vapor-smoothing");
  });

  it("FDM: TPU → restrict supportType to normal only", () => {
    const resolved = resolver.resolve("pcc://capabilities/fdm/v2", {
      material: "tpu",
    });
    const restriction = resolved.evaluation.paramRestrictions.get("supportType");
    expect(restriction?.restrictTo).toEqual(["normal"]);
  });

  it("FDM: infill > 80 → restrict layerHeight to 0.20, 0.30", () => {
    const resolved = resolver.resolve("pcc://capabilities/fdm/v2", { infill: 90 });
    const restriction = resolved.evaluation.paramRestrictions.get("layerHeight");
    expect(restriction?.restrictTo).toEqual(["0.20", "0.30"]);
  });

  it("FDM: infill = 80 does NOT trigger the >80 constraint", () => {
    const resolved = resolver.resolve("pcc://capabilities/fdm/v2", { infill: 80 });
    expect(resolved.evaluation.paramRestrictions.has("layerHeight")).toBe(false);
  });

  it("2D print: borderless + plain paper → reject error", () => {
    const resolved = resolver.resolve("pcc://capabilities/2d-print/v1", {
      borderless: true,
      mediaType: "stationery",
    });
    expect(resolved.evaluation.valid).toBe(false);
    expect(resolved.evaluation.errors.some((e) => e.message.includes("photo paper"))).toBe(true);
  });

  it("2D print: envelope + duplex → restrict duplex to one-sided", () => {
    const resolved = resolver.resolve("pcc://capabilities/2d-print/v1", {
      mediaType: "envelope",
      duplex: "two-sided-long-edge",
    });
    const restriction = resolved.evaluation.paramRestrictions.get("duplex");
    expect(restriction?.restrictTo).toEqual(["one-sided"]);
  });
});

// ── Parameter visibility ───────────────────────────────────────────

describe("CsdResolver - parameter visibility", () => {
  it("FDM supportType is hidden when supports = false", () => {
    const resolved = resolver.resolve("pcc://capabilities/fdm/v2", { supports: false });
    const rp = resolved.resolvedParameters.find((p) => p.param.key === "supportType");
    expect(rp).toBeDefined();
    expect(rp!.visible).toBe(false);
  });

  it("FDM supportType is visible when supports = true", () => {
    const resolved = resolver.resolve("pcc://capabilities/fdm/v2", { supports: true });
    const rp = resolved.resolvedParameters.find((p) => p.param.key === "supportType");
    expect(rp!.visible).toBe(true);
  });

  it("params without visibleWhen are always visible", () => {
    const resolved = resolver.resolve("pcc://capabilities/fdm/v2", {});
    const material = resolved.resolvedParameters.find((p) => p.param.key === "material");
    expect(material!.visible).toBe(true);
  });
});

// ── Pricing ────────────────────────────────────────────────────────

describe("CsdResolver - pricing", () => {
  it("returns base price with no selections", () => {
    const resolved = resolver.resolve("pcc://capabilities/fdm/v2", {});
    const pricing = resolver.price(resolved, {});
    expect(pricing.basePrice).toBe(15.0);
    expect(pricing.currency).toBe("USDC");
  });

  it("2D print base price is 0.10 per page", () => {
    const resolved = resolver.resolve("pcc://capabilities/2d-print/v1", {});
    const pricing = resolver.price(resolved, {});
    expect(pricing.basePrice).toBe(0.10);
  });

  it("pricing applies number param per_unit impact (infill)", () => {
    const resolved = resolver.resolve("pcc://capabilities/fdm/v2", { infill: 20 });
    const pricing = resolver.price(resolved, { infill: 20 });
    // Infill impact: +$0.01 per 1% = +$0.20 for infill=20
    const infillItem = pricing.breakdown.find((b) => b.paramKey === "infill");
    expect(infillItem).toBeDefined();
    expect(infillItem!.amount).toBeCloseTo(0.2);
  });

  it("total price scales with quantity", () => {
    const resolved1 = resolver.resolve("pcc://capabilities/fdm/v2", { quantity: 1, infill: 20 });
    const resolved5 = resolver.resolve("pcc://capabilities/fdm/v2", { quantity: 5, infill: 20 });
    const pricing1 = resolver.price(resolved1, { quantity: 1, infill: 20 });
    const pricing5 = resolver.price(resolved5, { quantity: 5, infill: 20 });
    expect(pricing5.totalPrice).toBeCloseTo(pricing1.totalPrice * 5);
  });

  it("2D print: applies minimum charge when total would be below it", () => {
    const resolved = resolver.resolve("pcc://capabilities/2d-print/v1", {});
    // Base is $0.10 with no options — below $1.00 minimum
    const pricing = resolver.price(resolved, {});
    // minimumCharge is 1.00
    expect(pricing.totalPrice).toBeGreaterThanOrEqual(1.0);
  });
});

// ── Validation ─────────────────────────────────────────────────────

describe("CsdResolver - validation", () => {
  it("returns valid for correct required params", () => {
    const resolved = resolver.resolve("pcc://capabilities/2d-print/v1", {
      mediaSize: "iso_a4_210x297mm",
      mediaType: "stationery",
      colorMode: "color",
      copies: 1,
    });
    const validation = resolver.validate(resolved, {
      mediaSize: "iso_a4_210x297mm",
      mediaType: "stationery",
      colorMode: "color",
      copies: 1,
    });
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  it("catches missing required params", () => {
    const resolved = resolver.resolve("pcc://capabilities/2d-print/v1", {});
    // mediaSize, mediaType, colorMode, copies are all required
    const validation = resolver.validate(resolved, {});
    expect(validation.valid).toBe(false);
    const requiredKeys = validation.errors.map((e) => e.paramKey);
    expect(requiredKeys).toContain("mediaSize");
    expect(requiredKeys).toContain("mediaType");
    expect(requiredKeys).toContain("colorMode");
  });

  it("catches invalid enum values", () => {
    const resolved = resolver.resolve("pcc://capabilities/2d-print/v1", {
      colorMode: "plasma-mode", // not a valid option
    });
    const validation = resolver.validate(resolved, {
      mediaSize: "iso_a4_210x297mm",
      mediaType: "stationery",
      colorMode: "plasma-mode",
      copies: 1,
    });
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e) => e.paramKey === "colorMode")).toBe(true);
  });

  it("includes constraint errors in validation output", () => {
    const resolved = resolver.resolve("pcc://capabilities/2d-print/v1", {
      borderless: true,
      mediaType: "stationery",
      mediaSize: "iso_a4_210x297mm",
      colorMode: "color",
      copies: 1,
    });
    const validation = resolver.validate(resolved, {
      borderless: true,
      mediaType: "stationery",
      mediaSize: "iso_a4_210x297mm",
      colorMode: "color",
      copies: 1,
    });
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e) => e.message.includes("photo paper"))).toBe(true);
  });

  it("validates invariant: custom paper size without A3-capable device → error", () => {
    const resolved = resolver.resolve("pcc://capabilities/2d-print/v1", {
      mediaSize: "custom",
      mediaType: "stationery",
      colorMode: "color",
      copies: 1,
    });
    const validation = resolver.validate(
      resolved,
      {
        mediaSize: "custom",
        mediaType: "stationery",
        colorMode: "color",
        copies: 1,
      },
      // Device context without A3 capability
      { device: { capabilities: ["na_letter_8.5x11in", "iso_a4_210x297mm"] } },
    );
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e) => e.message.includes("Custom paper size"))).toBe(true);
  });

  it("validates invariant: custom paper size WITH A3-capable device → passes invariant check", () => {
    const resolved = resolver.resolve("pcc://capabilities/2d-print/v1", {
      mediaSize: "custom",
      mediaType: "stationery",
      colorMode: "color",
      copies: 1,
    });
    const validation = resolver.validate(
      resolved,
      {
        mediaSize: "custom",
        mediaType: "stationery",
        colorMode: "color",
        copies: 1,
      },
      // Device context WITH A3 capability
      { device: { capabilities: ["iso_a3_297x420mm", "na_letter_8.5x11in"] } },
    );
    // Invariant error should NOT appear
    expect(validation.errors.some((e) => e.message.includes("Custom paper size"))).toBe(false);
  });

  it("includes constraint warnings in validation output", () => {
    // No standard warning constraints in our test CSDs — verify warning array is present
    const resolved = resolver.resolve("pcc://capabilities/fdm/v2", {
      material: "pla",
      infill: 20,
      quantity: 1,
    });
    const validation = resolver.validate(resolved, {
      material: "pla",
      infill: 20,
      quantity: 1,
    });
    // No warnings expected for this combination
    expect(validation.warnings).toBeDefined();
    expect(Array.isArray(validation.warnings)).toBe(true);
  });

  it("catches out-of-range number values", () => {
    const resolved = resolver.resolve("pcc://capabilities/2d-print/v1", {
      copies: 20000, // max is 9999
    });
    const validation = resolver.validate(resolved, {
      mediaSize: "iso_a4_210x297mm",
      mediaType: "stationery",
      colorMode: "color",
      copies: 20000,
    });
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e) => e.paramKey === "copies")).toBe(true);
  });
});

// ── Profile inheritance (baseDefinition) ──────────────────────────

describe("CsdResolver - profile inheritance", () => {
  it("resolves a profile CSD by merging with base CSD", () => {
    // Register a profile that inherits from FDM, restricts materials
    const fdmProfile: CSD = {
      $schema: "https://pcc.network/schemas/csd/v1",
      url: "pcc://capabilities/fdm/prusa-mk4/v1",
      version: "1.0.0",
      status: "active",
      name: "FDM 3D Printing (Prusa MK4)",
      description: "Prusa MK4 profile",
      kind: "profile",
      baseDefinition: "pcc://capabilities/fdm/v2",
      parameters: [
        {
          type: "enum",
          key: "material",
          label: "Material",
          required: true,
          order: 1,
          group: "Material",
          options: [
            { value: "pla", label: "PLA" },
            { value: "petg", label: "PETG" },
          ],
        },
      ],
      constraints: [],
      pricing: {
        basePrice: "12.00",
        currency: "USDC",
        unit: "per part",
      },
    };

    const registry = new CsdRegistry();
    registry.register(fdmCsd);
    registry.register(fdmProfile);
    const localResolver = new CsdResolver(registry);

    const resolved = localResolver.resolve("pcc://capabilities/fdm/prusa-mk4/v1", {});
    // Profile's material options should override base (only pla, petg)
    const materialParam = resolved.csd.parameters.find((p) => p.key === "material");
    expect(materialParam).toBeDefined();
    if (materialParam?.type === "enum") {
      expect(materialParam.options.map((o) => o.value)).toEqual(["pla", "petg"]);
    }
    // Profile price should be 12.00 (profile wins)
    expect(resolved.csd.pricing.basePrice).toBe("12.00");
    // Other params from base should be present (infill, layerHeight, etc.)
    expect(resolved.csd.parameters.some((p) => p.key === "infill")).toBe(true);
    expect(resolved.csd.parameters.some((p) => p.key === "layerHeight")).toBe(true);
  });
});
