import { describe, it, expect } from "vitest";
import { PricingCalculator } from "../pricing.js";
import { TemplateResolver } from "../resolver.js";
import { cncTurningTemplate } from "../templates/cnc-turning.js";
import { cncSwissTemplate } from "../templates/cnc-swiss.js";
import { getTemplate } from "../templates/index.js";

const resolver = new TemplateResolver();
const pricing = new PricingCalculator();

describe("cncTurningTemplate — structure", () => {
  it("is registered under 'cnc-turning'", () => {
    expect(getTemplate("cnc-turning")).toBeDefined();
    expect(getTemplate("cnc-turning")?.name).toBe("CNC Turning (Lathe)");
  });

  it("declares the cylindrical material catalog (no sheet stock)", () => {
    const mat = cncTurningTemplate.params.find((p) => p.key === "material");
    const opts = (mat as any).options as Array<{ value: string }>;
    const vals = opts.map((o) => o.value);
    // round-bar materials present
    expect(vals).toContain("aluminum-6061-t6");
    expect(vals).toContain("stainless-303");
    expect(vals).toContain("brass-360");
    expect(vals).toContain("titanium-grade-5");
    expect(vals).toContain("peek");
    // sheet-stock-only materials absent (galvanized, 3003-H14)
    expect(vals).not.toContain("steel-galvanized");
    expect(vals).not.toContain("aluminum-3003-h14");
  });

  it("declares OD + length envelope params", () => {
    const od = cncTurningTemplate.params.find((p) => p.key === "outerDiameterMm");
    const len = cncTurningTemplate.params.find((p) => p.key === "lengthMm");
    expect(od?.type).toBe("number");
    expect(len?.type).toBe("number");
    expect((od as any).max).toBe(431);  // 17in chuck = 431mm
    expect((len as any).max).toBe(990); // ~39in
  });

  it("declares structured OD threading enum (UNC/UNF/ISO-M/NPT)", () => {
    const t = cncTurningTemplate.params.find((p) => p.key === "threadingOD");
    const opts = (t as any).options as Array<{ value: string }>;
    const vals = opts.map((o) => o.value);
    expect(vals).toContain("unc");
    expect(vals).toContain("unf");
    expect(vals).toContain("iso-m");
    expect(vals).toContain("iso-mf");
    expect(vals).toContain("npt");
  });

  it("declares tolerance class with standard/fine/precision", () => {
    const t = cncTurningTemplate.params.find((p) => p.key === "toleranceClass");
    const opts = (t as any).options as Array<{ value: string }>;
    const vals = opts.map((o) => o.value);
    expect(vals).toEqual(["standard", "fine", "precision"]);
  });

  it("declares profile-feature multi-select", () => {
    const p = cncTurningTemplate.params.find((p) => p.key === "profileFeatures");
    expect((p as any).multi).toBe(true);
    const opts = (p as any).options as Array<{ value: string }>;
    const vals = opts.map((o) => o.value);
    expect(vals).toEqual(expect.arrayContaining(["straight", "taper", "contour", "groove", "knurl", "face", "bore"]));
  });

  it("declares chuckClass envelope enum", () => {
    const c = cncTurningTemplate.params.find((p) => p.key === "chuckClass");
    const opts = (c as any).options as Array<{ value: string }>;
    const vals = opts.map((o) => o.value);
    expect(vals).toEqual(["swiss-32mm", "small-1in", "standard-3in", "large-8in", "vtl-17in"]);
  });
});

describe("cncTurningTemplate — pricing", () => {
  it("returns $85 base for a 6061 part with no extras", () => {
    const sel = {
      material: "aluminum-6061-t6",
      outerDiameterMm: 25,
      lengthMm: 100,
      chuckClass: "standard-3in",
      toleranceClass: "standard",
      quantity: 1,
    };
    const options = resolver.resolve(cncTurningTemplate, sel);
    const result = pricing.calculate(options, sel);
    expect(result.basePrice).toBe(85);
    expect(result.totalPrice).toBe(85);
  });

  it("applies titanium +150% premium", () => {
    const sel = {
      material: "titanium-grade-5",
      outerDiameterMm: 20,
      lengthMm: 50,
      chuckClass: "standard-3in",
      toleranceClass: "standard",
      quantity: 1,
    };
    const options = resolver.resolve(cncTurningTemplate, sel);
    const result = pricing.calculate(options, sel);
    // Ti +150% of $85 = +$127.50
    const matLine = result.breakdown.find((b) => b.paramKey === "material");
    expect(parseFloat(matLine!.amount)).toBeCloseTo(127.5, 2);
    expect(result.totalPrice).toBeCloseTo(85 + 127.5, 2);
  });

  it("applies precision tolerance +50% premium", () => {
    const sel = {
      material: "aluminum-6061-t6",
      outerDiameterMm: 20,
      lengthMm: 50,
      chuckClass: "standard-3in",
      toleranceClass: "precision",
      quantity: 1,
    };
    const options = resolver.resolve(cncTurningTemplate, sel);
    const result = pricing.calculate(options, sel);
    // precision tolerance +50% of $85 = +$42.50
    const tolLine = result.breakdown.find((b) => b.paramKey === "toleranceClass");
    expect(parseFloat(tolLine!.amount)).toBeCloseTo(42.5, 2);
  });

  it("applies OD threading + ID threading flat fees", () => {
    const sel = {
      material: "stainless-303",
      outerDiameterMm: 25,
      lengthMm: 75,
      chuckClass: "standard-3in",
      toleranceClass: "fine",
      threadingOD: "unc",
      threadingID: "unf",
      quantity: 1,
    };
    const options = resolver.resolve(cncTurningTemplate, sel);
    const result = pricing.calculate(options, sel);
    const odLine = result.breakdown.find((b) => b.paramKey === "threadingOD");
    const idLine = result.breakdown.find((b) => b.paramKey === "threadingID");
    expect(parseFloat(odLine!.amount)).toBeCloseTo(8, 2); // UNC = +$8
    expect(parseFloat(idLine!.amount)).toBeCloseTo(12, 2); // UNF tap = +$12
  });

  it("realistic shaft: 4140, fine tolerance, OD thread, polish, AS9100D, qty 25", () => {
    const sel = {
      material: "steel-4140",
      outerDiameterMm: 30,
      lengthMm: 200,
      chuckClass: "standard-3in",
      toleranceClass: "fine",
      profileFeatures: ["straight", "taper", "groove"],
      threadingOD: "unc",
      surfaceFinish: "polish-mirror",
      certifications: ["as9100d"],
      quantity: 25,
    };
    const options = resolver.resolve(cncTurningTemplate, sel);
    const result = pricing.calculate(options, sel);
    // Per unit:
    //   $85 base
    //   +4140 +35% = +$29.75
    //   +fine +25% = +$21.25
    //   +taper +$5
    //   +groove +$3
    //   +OD UNC +$8
    //   +mirror +25% = +$21.25
    //   +AS9100D +15% = +$12.75
    // Per unit ≈ $186.00; × 25 ≈ $4650
    expect(result.totalPrice).toBeCloseTo(186.0 * 25, 0);
  });
});

describe("cncTurningTemplate — constraints", () => {
  it("non-aluminum excludes anodize Type II/III and chem-film", () => {
    const options = resolver.resolve(cncTurningTemplate, { material: "stainless-304" });
    const sf = options.allParams.find((p) => p.def.key === "surfaceFinish");
    const opts = (sf!.def as any).options as Array<{ value: string }>;
    const vals = opts.map((o) => o.value);
    expect(vals).not.toContain("anodize-type-ii");
    expect(vals).not.toContain("anodize-type-iii");
    expect(vals).not.toContain("chromate-conversion");
  });

  it("non-titanium excludes Ti anodize", () => {
    const options = resolver.resolve(cncTurningTemplate, { material: "aluminum-6061-t6" });
    const sf = options.allParams.find((p) => p.def.key === "surfaceFinish");
    const opts = (sf!.def as any).options as Array<{ value: string }>;
    const vals = opts.map((o) => o.value);
    expect(vals).not.toContain("ti-anodize");
  });

  it("titanium keeps Ti anodize", () => {
    const options = resolver.resolve(cncTurningTemplate, { material: "titanium-grade-5" });
    const sf = options.allParams.find((p) => p.def.key === "surfaceFinish");
    const opts = (sf!.def as any).options as Array<{ value: string }>;
    const vals = opts.map((o) => o.value);
    expect(vals).toContain("ti-anodize");
  });

  it("plastics restrict surface finish to a minimal set", () => {
    const options = resolver.resolve(cncTurningTemplate, { material: "peek" });
    const sf = options.allParams.find((p) => p.def.key === "surfaceFinish");
    const opts = (sf!.def as any).options as Array<{ value: string }>;
    const vals = opts.map((o) => o.value);
    expect(vals).toEqual(["as-machined", "edges-broken", "polish-mirror", "laser-engrave"]);
  });

  it("precision tolerance restricts chuckClass to small/swiss", () => {
    const options = resolver.resolve(cncTurningTemplate, { toleranceClass: "precision" });
    const c = options.allParams.find((p) => p.def.key === "chuckClass");
    const opts = (c!.def as any).options as Array<{ value: string }>;
    const vals = opts.map((o) => o.value);
    expect(vals).toEqual(["swiss-32mm", "small-1in", "standard-3in"]);
  });

  it("large OD (>200mm) forces large or VTL chuck", () => {
    const options = resolver.resolve(cncTurningTemplate, { outerDiameterMm: 250 });
    const c = options.allParams.find((p) => p.def.key === "chuckClass");
    const opts = (c!.def as any).options as Array<{ value: string }>;
    const vals = opts.map((o) => o.value);
    expect(vals).toEqual(["large-8in", "vtl-17in"]);
  });
});

describe("cncSwissTemplate — scaffold", () => {
  it("is registered under 'cnc-swiss' with v0.1", () => {
    const t = getTemplate("cnc-swiss");
    expect(t).toBeDefined();
    expect(t?.version).toBe("0.1");
  });

  it("caps OD at 32mm (Swiss guide-bushing limit)", () => {
    const od = cncSwissTemplate.params.find((p) => p.key === "outerDiameterMm");
    expect((od as any).max).toBe(32);
  });

  it("defaults tolerance class to precision (Swiss baseline)", () => {
    const t = cncSwissTemplate.params.find((p) => p.key === "toleranceClass");
    expect((t as any).defaultValue).toBe("precision");
    const opts = (t as any).options as Array<{ value: string }>;
    const vals = opts.map((o) => o.value);
    expect(vals).toEqual(["precision", "ultra-precision"]);
  });

  it("base price reflects Swiss premium ($120)", () => {
    expect(cncSwissTemplate.basePricingHints?.basePrice).toBe("120.00");
  });

  it("scaffold renders without exceptions and prices basic config", () => {
    const sel = {
      material: "stainless-303",
      outerDiameterMm: 8,
      lengthMm: 30,
      toleranceClass: "precision",
      quantity: 100,
    };
    const options = resolver.resolve(cncSwissTemplate, sel);
    const result = pricing.calculate(options, sel);
    expect(result.basePrice).toBe(120);
    // Per unit $120 × 100 = $12,000
    expect(result.totalPrice).toBe(12000);
  });
});
