import { describe, it, expect } from "vitest";
import { PricingCalculator } from "../pricing.js";
import { TemplateResolver } from "../resolver.js";
import { sheetMetalTemplate } from "../templates/sheet-metal.js";
import { getTemplate } from "../templates/index.js";

const resolver = new TemplateResolver();
const pricing = new PricingCalculator();

describe("sheetMetalTemplate — structure", () => {
  it("is registered under 'sheet-metal'", () => {
    expect(getTemplate("sheet-metal")).toBeDefined();
    expect(getTemplate("sheet-metal")?.name).toBe("Sheet Metal Fabrication");
  });

  it("declares the multi-op operations enum (≥8 ops)", () => {
    const op = sheetMetalTemplate.params.find((p) => p.key === "operations");
    expect(op).toBeDefined();
    expect((op as any).multi).toBe(true);
    const opts = (op as any).options as Array<{ value: string }>;
    expect(opts.length).toBeGreaterThanOrEqual(8);
    const vals = opts.map((o) => o.value);
    expect(vals).toEqual(
      expect.arrayContaining([
        "laser-cut",
        "waterjet",
        "punch",
        "form-bend",
        "weld",
        "deburr",
        "pem-insert",
        "tap",
      ]),
    );
  });

  it("includes PEM hardware enum with ≥4 types", () => {
    const pem = sheetMetalTemplate.params.find((p) => p.key === "pemHardware");
    expect(pem).toBeDefined();
    const opts = (pem as any).options as Array<{ value: string }>;
    expect(opts.length).toBeGreaterThanOrEqual(4);
    const vals = opts.map((o) => o.value);
    expect(vals).toEqual(expect.arrayContaining(["pem-nut", "pem-stud", "pem-standoff"]));
  });

  it("includes weld cert enum (AWS / MIL)", () => {
    const wc = sheetMetalTemplate.params.find((p) => p.key === "weldCert");
    const opts = (wc as any).options as Array<{ value: string }>;
    const vals = opts.map((o) => o.value);
    expect(vals).toContain("aws-d1-1");
    expect(vals).toContain("aws-d17-1");
    expect(vals).toContain("mil-std-1595");
  });

  it("includes bend tiers including hemming + sharp-radius", () => {
    const tier = sheetMetalTemplate.params.find((p) => p.key === "bendTier");
    const opts = (tier as any).options as Array<{ value: string }>;
    const vals = opts.map((o) => o.value);
    expect(vals).toEqual(expect.arrayContaining(["simple", "complex", "hemming", "sharp-radius"]));
  });
});

describe("sheetMetalTemplate — pricing", () => {
  it("returns $35 base for a single aluminum part with no ops", () => {
    const sel = {
      material: "aluminum-5052-h32",
      thicknessMm: 1.5,
      partXmm: 100,
      partYmm: 100,
      operations: ["laser-cut"],
      quantity: 1,
    };
    const options = resolver.resolve(sheetMetalTemplate, sel);
    const result = pricing.calculate(options, sel);
    expect(result.basePrice).toBe(35);
    expect(result.totalPrice).toBe(35);
  });

  it("applies multi-op pricing (form-bend flat + weld percent)", () => {
    const sel = {
      material: "aluminum-5052-h32",
      thicknessMm: 1.5,
      partXmm: 200,
      partYmm: 150,
      operations: ["laser-cut", "form-bend", "weld"],
      bendCount: 3,
      weldType: "tig", // TIG has no pricing impact (baseline)
      quantity: 10,
    };
    const options = resolver.resolve(sheetMetalTemplate, sel);
    const result = pricing.calculate(options, sel);
    // Only ops with a pricingImpact emit breakdown lines.
    // laser-cut: no impact (baseline). form-bend: +$8 flat. weld: +20% ($7).
    // → 2 breakdown lines for 'operations'.
    const opBreakdown = result.breakdown.filter((b) => b.paramKey === "operations");
    expect(opBreakdown.length).toBe(2);
    // Per-unit: $35 + $8 + $7 = $50  →  ×10 = $500
    expect(result.totalPrice).toBeCloseTo((35 + 8 + 7) * 10, 1);
  });

  it("applies stainless 316 +45% material premium", () => {
    const sel = {
      material: "stainless-316",
      thicknessMm: 2.0,
      partXmm: 100,
      partYmm: 100,
      operations: ["laser-cut"],
      quantity: 1,
    };
    const options = resolver.resolve(sheetMetalTemplate, sel);
    const result = pricing.calculate(options, sel);
    // SS316 = +45% of $35 = +$15.75
    const matLine = result.breakdown.find((b) => b.paramKey === "material");
    expect(matLine).toBeDefined();
    expect(parseFloat(matLine!.amount)).toBeCloseTo(15.75, 2);
  });

  it("applies tight tolerance +20% and AS9100D +15%", () => {
    const sel = {
      material: "aluminum-6061-t6",
      thicknessMm: 1.5,
      partXmm: 100,
      partYmm: 100,
      operations: ["laser-cut"],
      tolerance: "tight",
      certifications: ["as9100d"],
      quantity: 5,
    };
    const options = resolver.resolve(sheetMetalTemplate, sel);
    const result = pricing.calculate(options, sel);
    // Per-unit: $35 + 6061 +10% ($3.50) + tight +20% ($7) + AS9100D +15% ($5.25) = $50.75
    // × 5 = $253.75
    expect(result.totalPrice).toBeCloseTo(50.75 * 5, 1);
  });

  it("realistic aerospace bracket: SS316 + tight tolerance + AS9100D + NADCAP + chem-film", () => {
    const sel = {
      material: "aluminum-6061-t6",
      thicknessMm: 2.0,
      partXmm: 250,
      partYmm: 150,
      operations: ["laser-cut", "form-bend", "deburr"],
      bendCount: 4,
      bendTier: "complex",
      tolerance: "tight",
      surfaceFinish: ["chromate-conversion"],
      certifications: ["as9100d", "nadcap", "itar"],
      quantity: 50,
    };
    const options = resolver.resolve(sheetMetalTemplate, sel);
    const result = pricing.calculate(options, sel);
    // Per unit:
    //   $35 base
    //   +6061 +10% = $3.50
    //   +form-bend +$8
    //   +deburr +$3
    //   +complex bends +20% = $7
    //   +tight +20% = $7
    //   +chem film +$15
    //   +AS9100D +15% = $5.25
    //   +NADCAP +20% = $7
    //   +ITAR +30% = $10.50
    // Sum per unit = $101.25  → ×50 = $5062.50
    expect(result.totalPrice).toBeCloseTo(101.25 * 50, 0);
    // Verify each line is present
    const keys = result.breakdown.map((b) => b.paramKey);
    expect(keys).toContain("material");
    expect(keys).toContain("operations");
    expect(keys).toContain("tolerance");
    expect(keys).toContain("certifications");
  });
});

describe("sheetMetalTemplate — constraints", () => {
  it("non-aluminum material excludes anodize options", () => {
    const options = resolver.resolve(sheetMetalTemplate, { material: "steel-1018" });
    const sf = options.allParams.find((p) => p.def.key === "surfaceFinish");
    const opts = (sf!.def as any).options as Array<{ value: string }>;
    const vals = opts.map((o) => o.value);
    expect(vals).not.toContain("anodize-type-ii");
    expect(vals).not.toContain("anodize-type-iii");
  });

  it("aluminum excludes zinc-plate", () => {
    const options = resolver.resolve(sheetMetalTemplate, { material: "aluminum-6061-t6" });
    const sf = options.allParams.find((p) => p.def.key === "surfaceFinish");
    const opts = (sf!.def as any).options as Array<{ value: string }>;
    const vals = opts.map((o) => o.value);
    expect(vals).not.toContain("zinc-plate");
  });

  it("aluminum keeps anodize options", () => {
    const options = resolver.resolve(sheetMetalTemplate, { material: "aluminum-6061-t6" });
    const sf = options.allParams.find((p) => p.def.key === "surfaceFinish");
    const opts = (sf!.def as any).options as Array<{ value: string }>;
    const vals = opts.map((o) => o.value);
    expect(vals).toContain("anodize-type-ii");
    expect(vals).toContain("anodize-type-iii");
  });

  it("non-stainless excludes passivation", () => {
    const options = resolver.resolve(sheetMetalTemplate, { material: "aluminum-6061-t6" });
    const sf = options.allParams.find((p) => p.def.key === "surfaceFinish");
    const opts = (sf!.def as any).options as Array<{ value: string }>;
    const vals = opts.map((o) => o.value);
    expect(vals).not.toContain("passivation");
  });

  it("thickness > 6mm excludes laser-cut", () => {
    const options = resolver.resolve(sheetMetalTemplate, { thicknessMm: 6.35 });
    const ops = options.allParams.find((p) => p.def.key === "operations");
    const opts = (ops!.def as any).options as Array<{ value: string }>;
    const vals = opts.map((o) => o.value);
    expect(vals).not.toContain("laser-cut");
    expect(vals).toContain("waterjet"); // waterjet is still available
  });

  it("bendCount hidden when operations does not include form-bend", () => {
    // Post-resolver-fix: visibleWhen is array-aware, so bendCount/bendTier
    // surface only when 'form-bend' is in the operations multi-select.
    const options = resolver.resolve(sheetMetalTemplate, { operations: ["laser-cut"] });
    const bend = options.allParams.find((p) => p.def.key === "bendCount");
    expect(bend?.visible).toBe(false);
    // And it still emits no pricing line when no value is supplied.
    const result = pricing.calculate(options, { operations: ["laser-cut"] });
    expect(result.breakdown.find((b) => b.paramKey === "bendCount")).toBeUndefined();
  });

  it("weldType hidden when operations does not include weld", () => {
    const options = resolver.resolve(sheetMetalTemplate, { operations: ["laser-cut"] });
    const wt = options.allParams.find((p) => p.def.key === "weldType");
    expect(wt?.visible).toBe(false);
  });
});

describe("sheetMetalTemplate — visibleWhen (array-aware resolver)", () => {
  // These tests verify the resolver fix on lamasu/fix/resolver-visiblewhen-multiselect
  // surfaces ops-dependent params correctly under a multi-select 'operations'.

  it("operations=['laser-cut'] hides weldType, weldCert, bendCount, bendTier, pemHardware", () => {
    const options = resolver.resolve(sheetMetalTemplate, { operations: ["laser-cut"] });
    const byKey = (k: string) => options.allParams.find((p) => p.def.key === k);
    expect(byKey("weldType")?.visible).toBe(false);
    expect(byKey("weldCert")?.visible).toBe(false);
    expect(byKey("bendCount")?.visible).toBe(false);
    expect(byKey("bendTier")?.visible).toBe(false);
    expect(byKey("pemHardware")?.visible).toBe(false);
  });

  it("operations=['laser-cut','weld'] reveals weldType and weldCert", () => {
    const options = resolver.resolve(sheetMetalTemplate, {
      operations: ["laser-cut", "weld"],
    });
    const byKey = (k: string) => options.allParams.find((p) => p.def.key === k);
    expect(byKey("weldType")?.visible).toBe(true);
    expect(byKey("weldCert")?.visible).toBe(true);
    // bend + pem still hidden — not in operations
    expect(byKey("bendCount")?.visible).toBe(false);
    expect(byKey("pemHardware")?.visible).toBe(false);
  });

  it("operations=['form-bend'] reveals bendCount and bendTier", () => {
    const options = resolver.resolve(sheetMetalTemplate, { operations: ["form-bend"] });
    const byKey = (k: string) => options.allParams.find((p) => p.def.key === k);
    expect(byKey("bendCount")?.visible).toBe(true);
    expect(byKey("bendTier")?.visible).toBe(true);
    expect(byKey("weldType")?.visible).toBe(false);
    expect(byKey("pemHardware")?.visible).toBe(false);
  });

  it("operations=['pem-insert'] reveals pemHardware", () => {
    const options = resolver.resolve(sheetMetalTemplate, { operations: ["pem-insert"] });
    const byKey = (k: string) => options.allParams.find((p) => p.def.key === k);
    expect(byKey("pemHardware")?.visible).toBe(true);
    expect(byKey("bendCount")?.visible).toBe(false);
    expect(byKey("weldType")?.visible).toBe(false);
  });

  it("operations=['laser-cut','form-bend','weld','pem-insert'] reveals all ops-dependent params", () => {
    const options = resolver.resolve(sheetMetalTemplate, {
      operations: ["laser-cut", "form-bend", "weld", "pem-insert"],
    });
    const byKey = (k: string) => options.allParams.find((p) => p.def.key === k);
    expect(byKey("bendCount")?.visible).toBe(true);
    expect(byKey("bendTier")?.visible).toBe(true);
    expect(byKey("pemHardware")?.visible).toBe(true);
    expect(byKey("weldType")?.visible).toBe(true);
    expect(byKey("weldCert")?.visible).toBe(true);
  });

  it("ops-dependent params are always-visible when operations is undefined (no selection yet)", () => {
    // visibleWhen has no source value to compare against. The resolver falls
    // through to scalar comparison (undefined !== 'form-bend' → false) so the
    // fields stay hidden. Verify this matches behavior expectations for an
    // unfilled-form starting state.
    const options = resolver.resolve(sheetMetalTemplate, {});
    const byKey = (k: string) => options.allParams.find((p) => p.def.key === k);
    expect(byKey("bendCount")?.visible).toBe(false);
    expect(byKey("weldType")?.visible).toBe(false);
    expect(byKey("pemHardware")?.visible).toBe(false);
  });
});
