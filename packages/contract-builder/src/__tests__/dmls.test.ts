import { describe, it, expect } from "vitest";
import { PricingCalculator } from "../pricing.js";
import { TemplateResolver } from "../resolver.js";
import { dmlsTemplate } from "../templates/dmls.js";
import { getTemplate } from "../templates/index.js";

const resolver = new TemplateResolver();
const pricing = new PricingCalculator();

describe("dmlsTemplate — structure", () => {
  it("is registered under 'dmls' at v1.0", () => {
    const t = getTemplate("dmls");
    expect(t).toBeDefined();
    expect(t?.version).toBe("1.0");
    expect(t?.name).toBe("DMLS (Direct Metal Laser Sintering)");
  });

  it("uses open-string capability type (no BuiltinCapabilityType enum bump)", () => {
    expect(dmlsTemplate.capabilityType).toBe("dmls");
  });

  it("declares 9 metal powders including Ti, Inconel, CoCrMo, AlSi10Mg", () => {
    const mat = dmlsTemplate.params.find((p) => p.key === "material");
    expect(mat).toBeDefined();
    const opts = (mat as any).options as Array<{ value: string }>;
    expect(opts.length).toBe(9);
    const vals = opts.map((o) => o.value);
    expect(vals).toEqual(
      expect.arrayContaining([
        "ti-6al-4v-grade-5",
        "ti-6al-4v-grade-23-eli",
        "inconel-625",
        "inconel-718",
        "alsi10mg",
        "stainless-316l",
        "stainless-17-4-ph",
        "cocrmo",
        "tool-steel-h13",
      ]),
    );
  });

  it("declares 3 layer thicknesses (20μm / 30μm / 60μm) with 30μm default", () => {
    const lt = dmlsTemplate.params.find((p) => p.key === "layerThickness");
    const opts = (lt as any).options as Array<{ value: string }>;
    const vals = opts.map((o) => o.value);
    expect(vals).toEqual(["20um", "30um", "60um"]);
    expect((lt as any).defaultValue).toBe("30um");
  });

  it("declares 4 support strategies (minimal / heavy / tree / breakaway)", () => {
    const ss = dmlsTemplate.params.find((p) => p.key === "supportStrategy");
    const opts = (ss as any).options as Array<{ value: string }>;
    const vals = opts.map((o) => o.value);
    expect(vals).toEqual(
      expect.arrayContaining([
        "minimal-support",
        "heavy-support",
        "tree-support",
        "breakaway-support",
      ]),
    );
  });

  it("declares multi-select postProcessing including HIP", () => {
    const pp = dmlsTemplate.params.find((p) => p.key === "postProcessing");
    expect((pp as any).multi).toBe(true);
    const vals = ((pp as any).options as Array<{ value: string }>).map((o) => o.value);
    expect(vals).toEqual(
      expect.arrayContaining([
        "stress-relief-anneal",
        "hip",
        "heat-treat-aging",
        "machining-critical-surfaces",
        "surface-finish-polish",
        "bead-blast",
        "shot-peen",
      ]),
    );
  });

  it("declares 3 tolerance tiers (standard ±0.1mm / precision ±0.05mm / high-precision ±0.025mm)", () => {
    const tol = dmlsTemplate.params.find((p) => p.key === "tolerance");
    const opts = (tol as any).options as Array<{ value: string }>;
    const vals = opts.map((o) => o.value);
    expect(vals).toEqual(["standard", "precision", "high-precision"]);
    expect((tol as any).defaultValue).toBe("standard");
  });

  it("declares certifications multi-select including AS9100, ISO 13485, Nadcap, ASTM F2924", () => {
    const certs = dmlsTemplate.params.find((p) => p.key === "certifications");
    expect((certs as any).multi).toBe(true);
    const vals = ((certs as any).options as Array<{ value: string }>).map((o) => o.value);
    expect(vals).toEqual(
      expect.arrayContaining([
        "as9100",
        "iso-13485",
        "nadcap",
        "astm-f2924",
        "traceable-material-cert",
      ]),
    );
  });

  it("includes buildVolume operator-side info (default 250mm, max 800mm)", () => {
    const bv = dmlsTemplate.params.find((p) => p.key === "buildVolume");
    expect(bv).toBeDefined();
    expect((bv as any).type).toBe("number");
    expect((bv as any).defaultValue).toBe(250);
    expect((bv as any).max).toBe(800);
    expect((bv as any).unit).toBe("mm");
  });

  it("declares quantity in 1-500 range", () => {
    const q = dmlsTemplate.params.find((p) => p.key === "quantity");
    expect((q as any).min).toBe(1);
    expect((q as any).max).toBe(500);
    expect((q as any).defaultValue).toBe(1);
  });
});

describe("dmlsTemplate — pricing", () => {
  it("returns $250 base for an AlSi10Mg part (qty 1, no extras)", () => {
    const sel = {
      material: "alsi10mg",
      layerThickness: "30um",
      tolerance: "standard",
      quantity: 1,
    };
    const options = resolver.resolve(dmlsTemplate, sel);
    const result = pricing.calculate(options, sel);
    expect(result.basePrice).toBe(250);
    expect(result.totalPrice).toBe(250);
  });

  it("applies Ti Grade 5 +200% material premium", () => {
    const sel = {
      material: "ti-6al-4v-grade-5",
      layerThickness: "30um",
      tolerance: "standard",
      quantity: 1,
    };
    const options = resolver.resolve(dmlsTemplate, sel);
    const result = pricing.calculate(options, sel);
    // Ti Grade 5 +200% of $250 = +$500
    const matLine = result.breakdown.find((b) => b.paramKey === "material");
    expect(parseFloat(matLine!.amount)).toBeCloseTo(500, 2);
    expect(result.totalPrice).toBeCloseTo(250 + 500, 2);
  });

  it("applies Inconel 718 +200%, 20μm layer +50%, high-precision +50% in stack", () => {
    const sel = {
      material: "inconel-718",
      layerThickness: "20um",
      tolerance: "high-precision",
      quantity: 1,
    };
    const options = resolver.resolve(dmlsTemplate, sel);
    const result = pricing.calculate(options, sel);
    // Per unit: $250 base
    //   + Inconel 718 +200% = +$500
    //   + 20um layer +50%  = +$125
    //   + high-precision +50% = +$125
    //   = $1000
    expect(result.totalPrice).toBeCloseTo(250 + 500 + 125 + 125, 2);
  });

  it("applies HIP + stress-relief + critical-surface machining as flat post-processing fees", () => {
    const sel = {
      material: "ti-6al-4v-grade-5",
      layerThickness: "30um",
      tolerance: "standard",
      postProcessing: ["stress-relief-anneal", "hip", "machining-critical-surfaces"],
      quantity: 1,
    };
    const options = resolver.resolve(dmlsTemplate, sel);
    const result = pricing.calculate(options, sel);
    // Three separate breakdown lines under postProcessing param
    const ppLines = result.breakdown.filter((b) => b.paramKey === "postProcessing");
    expect(ppLines.length).toBe(3);
    const ppTotal = ppLines.reduce((a, b) => a + parseFloat(b.amount), 0);
    // stress-relief $40 + HIP $150 + critical-surface $75 = $265
    expect(ppTotal).toBeCloseTo(40 + 150 + 75, 2);
  });

  it("multiplies per-unit cost by quantity for batch orders", () => {
    const sel = {
      material: "stainless-316l",
      layerThickness: "30um",
      tolerance: "standard",
      quantity: 50,
    };
    const options = resolver.resolve(dmlsTemplate, sel);
    const result = pricing.calculate(options, sel);
    // Per unit: $250 + 316L +60% = $400 (250 + 150)
    // × 50 = $20,000
    expect(result.totalPrice).toBeCloseTo(400 * 50, 0);
  });

  it("realistic aerospace bracket: Ti Grade 5, AS9100+Nadcap+F2924, 20μm, HIP, polish, qty 10", () => {
    const sel = {
      material: "ti-6al-4v-grade-5",
      layerThickness: "20um",
      tolerance: "precision",
      supportStrategy: "tree-support",
      postProcessing: ["stress-relief-anneal", "hip", "surface-finish-polish"],
      certifications: ["as9100", "nadcap", "astm-f2924"],
      quantity: 10,
    };
    const options = resolver.resolve(dmlsTemplate, sel);
    const result = pricing.calculate(options, sel);
    // Per unit:
    //   $250 base
    //   + Ti Grade 5 +200% = $500
    //   + 20um layer +50%  = $125
    //   + precision tol +25% = $62.50
    //   + tree-support +10% = $25
    //   + stress-relief $40 + HIP $150 + polish $50 = $240
    //   + AS9100 +15% = $37.50
    //   + Nadcap +20% = $50
    //   + ASTM F2924 +10% = $25
    //   = $1315
    //   × 10 = $13,150
    expect(result.totalPrice).toBeCloseTo(1315 * 10, 0);

    const keys = result.breakdown.map((b) => b.paramKey);
    expect(keys).toContain("material");
    expect(keys).toContain("layerThickness");
    expect(keys).toContain("tolerance");
    expect(keys).toContain("supportStrategy");
    expect(keys).toContain("postProcessing");
    expect(keys).toContain("certifications");
  });
});

describe("dmlsTemplate — constraints", () => {
  it("excludes HIP from postProcessing when material is AlSi10Mg (HIP only for Ti/Inconel)", () => {
    const options = resolver.resolve(dmlsTemplate, { material: "alsi10mg" });
    const pp = options.allParams.find((p) => p.def.key === "postProcessing");
    const vals = ((pp!.def as any).options as Array<{ value: string }>).map((o) => o.value);
    expect(vals).not.toContain("hip");
    expect(vals).toContain("stress-relief-anneal");
  });

  it("excludes HIP for non-Ti/Inconel materials (316L, CoCrMo, H13)", () => {
    for (const material of ["stainless-316l", "cocrmo", "tool-steel-h13", "stainless-17-4-ph"]) {
      const options = resolver.resolve(dmlsTemplate, { material });
      const pp = options.allParams.find((p) => p.def.key === "postProcessing");
      const vals = ((pp!.def as any).options as Array<{ value: string }>).map((o) => o.value);
      expect(vals).not.toContain("hip");
    }
  });

  it("keeps HIP available for Ti and Inconel materials", () => {
    for (const material of [
      "ti-6al-4v-grade-5",
      "ti-6al-4v-grade-23-eli",
      "inconel-625",
      "inconel-718",
    ]) {
      const options = resolver.resolve(dmlsTemplate, { material });
      const pp = options.allParams.find((p) => p.def.key === "postProcessing");
      const vals = ((pp!.def as any).options as Array<{ value: string }>).map((o) => o.value);
      expect(vals).toContain("hip");
    }
  });

  it("ISO 13485 (medical) restricts material to implant-grade Ti or CoCrMo", () => {
    const options = resolver.resolve(dmlsTemplate, { certifications: ["iso-13485"] });
    const mat = options.allParams.find((p) => p.def.key === "material");
    const vals = ((mat!.def as any).options as Array<{ value: string }>).map((o) => o.value);
    expect(vals).toEqual(expect.arrayContaining(["ti-6al-4v-grade-23-eli", "cocrmo"]));
    expect(vals).not.toContain("alsi10mg");
    expect(vals).not.toContain("inconel-625");
    expect(vals).not.toContain("stainless-316l");
  });

  it("AS9100 cert restricts material to aerospace alloy family", () => {
    const options = resolver.resolve(dmlsTemplate, { certifications: ["as9100"] });
    const mat = options.allParams.find((p) => p.def.key === "material");
    const vals = ((mat!.def as any).options as Array<{ value: string }>).map((o) => o.value);
    expect(vals).toEqual(
      expect.arrayContaining([
        "ti-6al-4v-grade-5",
        "ti-6al-4v-grade-23-eli",
        "inconel-625",
        "inconel-718",
      ]),
    );
    expect(vals).not.toContain("cocrmo");
    expect(vals).not.toContain("tool-steel-h13");
  });

  it("Nadcap cert restricts material the same way AS9100 does", () => {
    const options = resolver.resolve(dmlsTemplate, { certifications: ["nadcap"] });
    const mat = options.allParams.find((p) => p.def.key === "material");
    const vals = ((mat!.def as any).options as Array<{ value: string }>).map((o) => o.value);
    expect(vals).not.toContain("cocrmo");
    expect(vals).not.toContain("tool-steel-h13");
  });

  it("ASTM F2924 cert is Ti-only", () => {
    const options = resolver.resolve(dmlsTemplate, { certifications: ["astm-f2924"] });
    const mat = options.allParams.find((p) => p.def.key === "material");
    const vals = ((mat!.def as any).options as Array<{ value: string }>).map((o) => o.value);
    expect(vals).toEqual(["ti-6al-4v-grade-5", "ti-6al-4v-grade-23-eli"]);
  });

  it("AlSi10Mg cannot select high-precision tolerance (as-built impractical)", () => {
    const options = resolver.resolve(dmlsTemplate, { material: "alsi10mg" });
    const tol = options.allParams.find((p) => p.def.key === "tolerance");
    const vals = ((tol!.def as any).options as Array<{ value: string }>).map((o) => o.value);
    expect(vals).toEqual(["standard", "precision"]);
    expect(vals).not.toContain("high-precision");
  });
});

describe("dmlsTemplate — registry", () => {
  it("getTemplate('dmls') returns the dmls template", () => {
    const t = getTemplate("dmls");
    expect(t).toBe(dmlsTemplate);
  });
});
