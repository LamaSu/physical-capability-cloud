import { describe, it, expect } from "vitest";
import { PricingCalculator } from "../pricing.js";
import { TemplateResolver } from "../resolver.js";
import { fdmTemplate } from "../templates/fdm.js";
import { cnc3AxisTemplate } from "../templates/cnc-3axis.js";

const resolver = new TemplateResolver();
const pricing = new PricingCalculator();

describe("PricingCalculator", () => {
  it("returns base price with no selections", () => {
    const options = resolver.resolve(fdmTemplate, {});
    const result = pricing.calculate(options, {});
    expect(result.basePrice).toBe(15);
    expect(result.totalPrice).toBe(15);
    expect(result.breakdown.length).toBe(0);
  });

  it("applies flat pricing impact (supports=true)", () => {
    const selections = { supports: true };
    const options = resolver.resolve(fdmTemplate, selections);
    const result = pricing.calculate(options, selections);
    // supports adds +15% of $15 = $2.25
    expect(result.totalPrice).toBeCloseTo(17.25, 2);
    expect(result.breakdown.length).toBe(1);
    expect(result.breakdown[0].paramKey).toBe("supports");
  });

  it("applies multiplier pricing (layer height 0.10mm = 1.8x)", () => {
    const selections = { layerHeight: "0.10" };
    const options = resolver.resolve(fdmTemplate, selections);
    const result = pricing.calculate(options, selections);
    // 1.8x multiplier: base $15 + delta $12 = $27
    const layerItem = result.breakdown.find((b) => b.paramKey === "layerHeight");
    expect(layerItem).toBeDefined();
    expect(parseFloat(layerItem!.amount)).toBeCloseTo(12, 0);
  });

  it("applies per_unit pricing (infill)", () => {
    const selections = { infill: 40 };
    const options = resolver.resolve(fdmTemplate, selections);
    const result = pricing.calculate(options, selections);
    // infill: $0.01 per 1% × 40 = $0.40
    const infillItem = result.breakdown.find((b) => b.paramKey === "infill");
    expect(infillItem).toBeDefined();
    expect(parseFloat(infillItem!.amount)).toBeCloseTo(0.40, 2);
  });

  it("applies multi-select pricing (post-processing)", () => {
    const selections = { postProcessing: ["sanding", "painting"] };
    const options = resolver.resolve(fdmTemplate, selections);
    const result = pricing.calculate(options, selections);
    // sanding: +$10, painting: +$25
    const ppItems = result.breakdown.filter((b) => b.paramKey === "postProcessing");
    expect(ppItems.length).toBe(2);
    const total = ppItems.reduce((s, b) => s + parseFloat(b.amount), 0);
    expect(total).toBeCloseTo(35, 2);
  });

  it("multiplies by quantity", () => {
    const selections = { quantity: 5 };
    const options = resolver.resolve(fdmTemplate, selections);
    const result = pricing.calculate(options, selections);
    // $15 base × 5 = $75
    expect(result.totalPrice).toBeCloseTo(75, 2);
  });

  it("combines multiple pricing impacts", () => {
    const selections = {
      material: "abs",           // +10% = +$1.50
      infill: 40,                // +$0.40
      layerHeight: "0.15",       // 1.4x = +$6.00
      supports: true,            // +15% = +$2.25
      supportType: "tree",       // +$2.00
      postProcessing: ["sanding"], // +$10.00
      quantity: 2,
    };
    const options = resolver.resolve(fdmTemplate, selections);
    const result = pricing.calculate(options, selections);
    // Per unit: $15 + $1.50 + $0.40 + $6.00 + $2.25 + $2.00 + $10.00 = $37.15
    // Total: $37.15 × 2 = $74.30
    expect(result.totalPrice).toBeCloseTo(74.30, 1);
    expect(result.breakdown.length).toBeGreaterThan(0);
  });

  it("calculates CNC pricing with material premium", () => {
    const selections = {
      material: "stainless-304",   // +40%
      tolerance: "precision",     // +25%
      quantity: 1,
    };
    const options = resolver.resolve(cnc3AxisTemplate, selections);
    const result = pricing.calculate(options, selections);
    // Base: $75. Stainless: +40% = +$30. Precision: +25% = +$18.75.
    // Total: $75 + $30 + $18.75 = $123.75
    expect(result.totalPrice).toBeCloseTo(123.75, 1);
  });
});
