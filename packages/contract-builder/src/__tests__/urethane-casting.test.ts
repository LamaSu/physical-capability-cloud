import { describe, it, expect } from "vitest";
import { PricingCalculator } from "../pricing.js";
import { TemplateResolver } from "../resolver.js";
import { urethaneCastingTemplate } from "../templates/urethane-casting.js";
import { getTemplate } from "../templates/index.js";

const resolver = new TemplateResolver();
const pricing = new PricingCalculator();

describe("urethaneCastingTemplate — structure", () => {
  it("is registered under 'urethane-casting' at v1.0", () => {
    const t = getTemplate("urethane-casting");
    expect(t).toBeDefined();
    expect(t?.version).toBe("1.0");
    expect(t?.name).toBe("Urethane Casting (RTV / Vacuum Casting)");
  });

  it("uses open-string capability type (no BuiltinCapabilityType enum bump)", () => {
    expect(urethaneCastingTemplate.capabilityType).toBe("urethane-casting");
  });

  it("declares 9 resin types incl. PolyJet PR48, Smooth-Cast series, TASK, Vytaflex, Mold-Star", () => {
    const r = urethaneCastingTemplate.params.find((p) => p.key === "resinType");
    expect(r).toBeDefined();
    const opts = (r as any).options as Array<{ value: string }>;
    expect(opts.length).toBe(9);
    const vals = opts.map((o) => o.value);
    expect(vals).toEqual(
      expect.arrayContaining([
        "polyjet-pr48-simulated-abs",
        "smooth-cast-326",
        "smooth-cast-65d",
        "smooth-cast-380",
        "task-series-high-perf",
        "task-medical-grade",
        "vytaflex-30",
        "vytaflex-60",
        "mold-star-30",
      ]),
    );
  });

  it("declares shoreHardness as number-input in 10-90 range", () => {
    const sh = urethaneCastingTemplate.params.find((p) => p.key === "shoreHardness");
    expect(sh).toBeDefined();
    expect((sh as any).type).toBe("number");
    expect((sh as any).min).toBe(10);
    expect((sh as any).max).toBe(90);
    expect((sh as any).defaultValue).toBe(65);
  });

  it("declares color enum with pantone-match (+30%) and custom-pigment", () => {
    const c = urethaneCastingTemplate.params.find((p) => p.key === "color");
    const opts = (c as any).options as Array<{ value: string; pricingImpact?: any }>;
    const vals = opts.map((o) => o.value);
    expect(vals).toEqual(
      expect.arrayContaining([
        "clear",
        "opaque-white",
        "opaque-black",
        "pantone-match",
        "custom-pigment",
      ]),
    );
    const pantone = opts.find((o) => o.value === "pantone-match")!;
    expect(pantone.pricingImpact?.value).toBe("30");
  });

  it("declares finishQuality enum with mirror-polish (+50%)", () => {
    const f = urethaneCastingTemplate.params.find((p) => p.key === "finishQuality");
    const opts = (f as any).options as Array<{ value: string; pricingImpact?: any }>;
    const vals = opts.map((o) => o.value);
    expect(vals).toEqual(["as-cast", "light-sand", "mirror-polish", "texture-matched"]);
    const mp = opts.find((o) => o.value === "mirror-polish")!;
    expect(mp.pricingImpact?.value).toBe("50");
  });

  it("declares masterModel sourcing options (customer / PCC prints / PCC CAD+prints)", () => {
    const mm = urethaneCastingTemplate.params.find((p) => p.key === "masterModel");
    const vals = ((mm as any).options as Array<{ value: string }>).map((o) => o.value);
    expect(vals).toEqual([
      "customer-provides",
      "pcc-3d-prints-from-cad",
      "pcc-cad-from-drawing",
    ]);
  });

  it("declares 3 tooling tiers (silicone 10-25 / epoxy 50-100 / aluminum 200+)", () => {
    const tt = urethaneCastingTemplate.params.find((p) => p.key === "toolingType");
    const vals = ((tt as any).options as Array<{ value: string }>).map((o) => o.value);
    expect(vals).toEqual(["silicone-mold", "epoxy-mold", "aluminum-tool"]);
    expect((tt as any).defaultValue).toBe("silicone-mold");
  });

  it("declares postProcessing multi-select for trim/gate/prep/primer/paint", () => {
    const pp = urethaneCastingTemplate.params.find((p) => p.key === "postProcessing");
    expect((pp as any).multi).toBe(true);
    const vals = ((pp as any).options as Array<{ value: string }>).map((o) => o.value);
    expect(vals).toEqual(
      expect.arrayContaining([
        "flash-trim",
        "gate-removal",
        "surface-prep-for-paint",
        "primer-coat",
        "masked-painting",
      ]),
    );
  });

  it("declares certifications multi-select for ISO 10993, USP Class VI, RoHS, REACH", () => {
    const certs = urethaneCastingTemplate.params.find((p) => p.key === "certifications");
    expect((certs as any).multi).toBe(true);
    const vals = ((certs as any).options as Array<{ value: string }>).map((o) => o.value);
    expect(vals).toEqual(
      expect.arrayContaining([
        "iso-10993-biocompat",
        "usp-class-vi",
        "rohs",
        "reach",
      ]),
    );
  });

  it("declares timelineUrgency enum (standard / expedited +25% / rush +75%)", () => {
    const tu = urethaneCastingTemplate.params.find((p) => p.key === "timelineUrgency");
    const opts = (tu as any).options as Array<{ value: string; pricingImpact?: any }>;
    const vals = opts.map((o) => o.value);
    expect(vals).toEqual(["standard", "expedited", "rush"]);
    const exp = opts.find((o) => o.value === "expedited")!;
    const rush = opts.find((o) => o.value === "rush")!;
    expect(exp.pricingImpact?.value).toBe("25");
    expect(rush.pricingImpact?.value).toBe("75");
  });
});

describe("urethaneCastingTemplate — pricing", () => {
  it("returns $30 base for a basic PolyJet PR48 part (qty 1, no extras)", () => {
    const sel = {
      resinType: "polyjet-pr48-simulated-abs",
      masterModel: "customer-provides",
      toolingType: "silicone-mold",
      quantity: 1,
    };
    const options = resolver.resolve(urethaneCastingTemplate, sel);
    const result = pricing.calculate(options, sel);
    expect(result.basePrice).toBe(30);
    expect(result.totalPrice).toBe(30);
  });

  it("applies Smooth-Cast 380 medical-grade +80% resin premium", () => {
    const sel = {
      resinType: "smooth-cast-380",
      masterModel: "customer-provides",
      toolingType: "silicone-mold",
      quantity: 1,
    };
    const options = resolver.resolve(urethaneCastingTemplate, sel);
    const result = pricing.calculate(options, sel);
    // Smooth-Cast 380 +80% of $30 = +$24
    const resinLine = result.breakdown.find((b) => b.paramKey === "resinType");
    expect(parseFloat(resinLine!.amount)).toBeCloseTo(24, 2);
    expect(result.totalPrice).toBeCloseTo(30 + 24, 2);
  });

  it("applies pantone-match color +30% premium", () => {
    const sel = {
      resinType: "polyjet-pr48-simulated-abs",
      color: "pantone-match",
      masterModel: "customer-provides",
      toolingType: "silicone-mold",
      quantity: 1,
    };
    const options = resolver.resolve(urethaneCastingTemplate, sel);
    const result = pricing.calculate(options, sel);
    // pantone-match +30% of $30 = +$9
    const colorLine = result.breakdown.find((b) => b.paramKey === "color");
    expect(parseFloat(colorLine!.amount)).toBeCloseTo(9, 2);
  });

  it("applies flat-fee tooling charges (epoxy $300, aluminum $1200)", () => {
    const sel = {
      resinType: "polyjet-pr48-simulated-abs",
      masterModel: "customer-provides",
      toolingType: "epoxy-mold",
      quantity: 75,
    };
    const options = resolver.resolve(urethaneCastingTemplate, sel);
    const result = pricing.calculate(options, sel);
    // tooling $300 flat -> 1 breakdown row under toolingType
    const ttLine = result.breakdown.find((b) => b.paramKey === "toolingType");
    expect(parseFloat(ttLine!.amount)).toBeCloseTo(300, 2);
    // Per unit: $30 + $300 = $330, ×75 = $24,750
    expect(result.totalPrice).toBeCloseTo(330 * 75, 0);
  });

  it("applies postProcessing multi-select as flat fees per selected op", () => {
    const sel = {
      resinType: "polyjet-pr48-simulated-abs",
      masterModel: "customer-provides",
      toolingType: "silicone-mold",
      postProcessing: ["flash-trim", "gate-removal", "primer-coat"],
      quantity: 1,
    };
    const options = resolver.resolve(urethaneCastingTemplate, sel);
    const result = pricing.calculate(options, sel);
    // 3 breakdown lines under postProcessing
    const ppLines = result.breakdown.filter((b) => b.paramKey === "postProcessing");
    expect(ppLines.length).toBe(3);
    const ppTotal = ppLines.reduce((a, b) => a + parseFloat(b.amount), 0);
    // flash-trim $2 + gate-removal $3 + primer-coat $10 = $15
    expect(ppTotal).toBeCloseTo(2 + 3 + 10, 2);
  });

  it("applies rush timeline +75% premium", () => {
    const sel = {
      resinType: "polyjet-pr48-simulated-abs",
      masterModel: "customer-provides",
      toolingType: "silicone-mold",
      timelineUrgency: "rush",
      quantity: 1,
    };
    const options = resolver.resolve(urethaneCastingTemplate, sel);
    const result = pricing.calculate(options, sel);
    // rush +75% of $30 = +$22.50
    const tuLine = result.breakdown.find((b) => b.paramKey === "timelineUrgency");
    expect(parseFloat(tuLine!.amount)).toBeCloseTo(22.5, 2);
    expect(result.totalPrice).toBeCloseTo(30 + 22.5, 2);
  });

  it("realistic medical mock-up: Smooth-Cast 380, ISO 10993, masked paint, qty 25", () => {
    const sel = {
      resinType: "smooth-cast-380",
      color: "opaque-white",
      finishQuality: "light-sand",
      masterModel: "customer-provides",
      toolingType: "silicone-mold",
      postProcessing: ["flash-trim", "gate-removal"],
      certifications: ["iso-10993-biocompat"],
      quantity: 25,
      timelineUrgency: "expedited",
    };
    const options = resolver.resolve(urethaneCastingTemplate, sel);
    const result = pricing.calculate(options, sel);
    // Per unit:
    //   $30 base
    //   + Smooth-Cast 380 +80% = $24
    //   + light-sand $8
    //   + flash-trim $2 + gate-removal $3 = $5
    //   + ISO 10993 +40% = $12
    //   + expedited +25% = $7.50
    //   = $86.50
    //   × 25 = $2162.50
    expect(result.totalPrice).toBeCloseTo(86.5 * 25, 2);

    const keys = result.breakdown.map((b) => b.paramKey);
    expect(keys).toContain("resinType");
    expect(keys).toContain("finishQuality");
    expect(keys).toContain("postProcessing");
    expect(keys).toContain("certifications");
    expect(keys).toContain("timelineUrgency");
  });
});

describe("urethaneCastingTemplate — constraints", () => {
  it("ISO 10993 cert restricts resin to medical-grade (Smooth-Cast 380, TASK medical)", () => {
    const options = resolver.resolve(urethaneCastingTemplate, {
      certifications: ["iso-10993-biocompat"],
    });
    const r = options.allParams.find((p) => p.def.key === "resinType");
    const vals = ((r!.def as any).options as Array<{ value: string }>).map((o) => o.value);
    expect(vals).toEqual(["smooth-cast-380", "task-medical-grade"]);
  });

  it("USP Class VI cert restricts resin to medical-grade (same as ISO 10993)", () => {
    const options = resolver.resolve(urethaneCastingTemplate, {
      certifications: ["usp-class-vi"],
    });
    const r = options.allParams.find((p) => p.def.key === "resinType");
    const vals = ((r!.def as any).options as Array<{ value: string }>).map((o) => o.value);
    expect(vals).toEqual(["smooth-cast-380", "task-medical-grade"]);
  });

  it("mirror-polish excluded when resin is rubber (Vytaflex 30/60, Mold-Star 30)", () => {
    for (const resinType of ["vytaflex-30", "vytaflex-60", "mold-star-30"]) {
      const options = resolver.resolve(urethaneCastingTemplate, { resinType });
      const fq = options.allParams.find((p) => p.def.key === "finishQuality");
      const vals = ((fq!.def as any).options as Array<{ value: string }>).map((o) => o.value);
      expect(vals).not.toContain("mirror-polish");
      expect(vals).toContain("as-cast");
    }
  });

  it("mirror-polish available when resin is rigid plastic (Smooth-Cast 65D)", () => {
    const options = resolver.resolve(urethaneCastingTemplate, { resinType: "smooth-cast-65d" });
    const fq = options.allParams.find((p) => p.def.key === "finishQuality");
    const vals = ((fq!.def as any).options as Array<{ value: string }>).map((o) => o.value);
    expect(vals).toContain("mirror-polish");
  });

  it("aluminum-tool excluded when quantity < 200 (only justified at volume)", () => {
    const options = resolver.resolve(urethaneCastingTemplate, { quantity: 50 });
    const tt = options.allParams.find((p) => p.def.key === "toolingType");
    const vals = ((tt!.def as any).options as Array<{ value: string }>).map((o) => o.value);
    expect(vals).not.toContain("aluminum-tool");
    expect(vals).toContain("silicone-mold");
    expect(vals).toContain("epoxy-mold");
  });

  it("silicone-mold excluded when quantity > 200 (forces epoxy or aluminum)", () => {
    const options = resolver.resolve(urethaneCastingTemplate, { quantity: 500 });
    const tt = options.allParams.find((p) => p.def.key === "toolingType");
    const vals = ((tt!.def as any).options as Array<{ value: string }>).map((o) => o.value);
    expect(vals).toEqual(expect.arrayContaining(["epoxy-mold", "aluminum-tool"]));
    expect(vals).not.toContain("silicone-mold");
  });

  it("quantity at boundary 200 retains all three tooling options (lt and gt strict)", () => {
    const options = resolver.resolve(urethaneCastingTemplate, { quantity: 200 });
    const tt = options.allParams.find((p) => p.def.key === "toolingType");
    const vals = ((tt!.def as any).options as Array<{ value: string }>).map((o) => o.value);
    // 200 is neither lt 200 nor gt 200, so both constraints skip
    expect(vals).toEqual(expect.arrayContaining(["silicone-mold", "epoxy-mold", "aluminum-tool"]));
  });
});

describe("urethaneCastingTemplate — registry", () => {
  it("getTemplate('urethane-casting') returns the urethane-casting template", () => {
    const t = getTemplate("urethane-casting");
    expect(t).toBe(urethaneCastingTemplate);
  });
});
