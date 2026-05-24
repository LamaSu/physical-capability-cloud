import { describe, it, expect } from "vitest";
import { PricingCalculator } from "../pricing.js";
import { TemplateResolver } from "../resolver.js";
import { cncSwissTemplate } from "../templates/cnc-swiss.js";
import { getTemplate } from "../templates/index.js";
import { getProfile, getProfilesForType } from "../profiles/index.js";

const resolver = new TemplateResolver();
const pricing = new PricingCalculator();

describe("cncSwissTemplate — structure", () => {
  it("is registered under 'cnc-swiss' at v1.0", () => {
    const t = getTemplate("cnc-swiss");
    expect(t).toBeDefined();
    expect(t?.version).toBe("1.0");
    expect(t?.name).toBe("CNC Swiss-Type Turning");
  });

  it("caps OD at 32mm (Swiss guide-bushing limit)", () => {
    const od = cncSwissTemplate.params.find((p) => p.key === "outerDiameterMm");
    expect((od as any).max).toBe(32);
    expect((od as any).min).toBe(0.5);
  });

  it("declares three tolerance classes (standard / precision / ultra-precision)", () => {
    const t = cncSwissTemplate.params.find((p) => p.key === "toleranceClass");
    const opts = (t as any).options as Array<{ value: string }>;
    const vals = opts.map((o) => o.value);
    expect(vals).toEqual(["standard", "precision", "ultra-precision"]);
    expect((t as any).defaultValue).toBe("standard");
  });

  it("gates liveToolOps off liveTooling boolean (visibleWhen pattern)", () => {
    const ops = cncSwissTemplate.params.find((p) => p.key === "liveToolOps");
    expect(ops).toBeDefined();
    expect((ops as any).multi).toBe(true);
    expect((ops as any).visibleWhen).toEqual({ param: "liveTooling", equals: true });
    const vals = ((ops as any).options as Array<{ value: string }>).map((o) => o.value);
    expect(vals).toEqual(
      expect.arrayContaining(["cross-drill", "cross-tap", "end-mill", "slot", "knurl-cross"]),
    );
  });

  it("gates subSpindleOps off subSpindle boolean (visibleWhen pattern)", () => {
    const ops = cncSwissTemplate.params.find((p) => p.key === "subSpindleOps");
    expect(ops).toBeDefined();
    expect((ops as any).multi).toBe(true);
    expect((ops as any).visibleWhen).toEqual({ param: "subSpindle", equals: true });
    const vals = ((ops as any).options as Array<{ value: string }>).map((o) => o.value);
    expect(vals).toEqual(expect.arrayContaining(["face", "drill", "tap", "part-off"]));
  });

  it("declares barFeeder enum (single-bar / multi-bar-loader / none)", () => {
    const bf = cncSwissTemplate.params.find((p) => p.key === "barFeeder");
    const vals = ((bf as any).options as Array<{ value: string }>).map((o) => o.value);
    expect(vals).toEqual(["none", "single-bar", "multi-bar-loader"]);
    expect((bf as any).defaultValue).toBe("single-bar");
  });

  it("caps barStockDiameter at 32mm (matches OD limit)", () => {
    const bsd = cncSwissTemplate.params.find((p) => p.key === "barStockDiameter");
    expect((bsd as any).max).toBe(32);
    expect((bsd as any).min).toBe(0.5);
  });

  it("declares runVolume (Swiss is high-volume; default 1000)", () => {
    const rv = cncSwissTemplate.params.find((p) => p.key === "runVolume");
    expect(rv).toBeDefined();
    expect((rv as any).defaultValue).toBe(1000);
    expect((rv as any).max).toBe(100000);
  });
});

describe("cncSwissTemplate — visibility resolution", () => {
  it("hides liveToolOps when liveTooling=false", () => {
    const options = resolver.resolve(cncSwissTemplate, { liveTooling: false });
    const lt = options.allParams.find((p) => p.def.key === "liveToolOps");
    expect(lt?.visible).toBe(false);
  });

  it("shows liveToolOps when liveTooling=true", () => {
    const options = resolver.resolve(cncSwissTemplate, { liveTooling: true });
    const lt = options.allParams.find((p) => p.def.key === "liveToolOps");
    expect(lt?.visible).toBe(true);
  });

  it("shows subSpindleOps only when subSpindle=true", () => {
    const off = resolver.resolve(cncSwissTemplate, { subSpindle: false });
    const offOps = off.allParams.find((p) => p.def.key === "subSpindleOps");
    expect(offOps?.visible).toBe(false);

    const on = resolver.resolve(cncSwissTemplate, { subSpindle: true });
    const onOps = on.allParams.find((p) => p.def.key === "subSpindleOps");
    expect(onOps?.visible).toBe(true);
  });
});

describe("cncSwissTemplate — pricing", () => {
  it("returns $120 base for a basic stainless-303 part (qty 1, no extras)", () => {
    const sel = {
      material: "stainless-303",
      outerDiameterMm: 8,
      lengthMm: 30,
      toleranceClass: "standard",
      quantity: 1,
    };
    const options = resolver.resolve(cncSwissTemplate, sel);
    const result = pricing.calculate(options, sel);
    expect(result.basePrice).toBe(120);
    expect(result.totalPrice).toBe(120);
  });

  it("applies titanium-grade-5 +150% premium", () => {
    const sel = {
      material: "titanium-grade-5",
      outerDiameterMm: 6,
      lengthMm: 25,
      toleranceClass: "standard",
      quantity: 1,
    };
    const options = resolver.resolve(cncSwissTemplate, sel);
    const result = pricing.calculate(options, sel);
    // Ti +150% of $120 = +$180
    const matLine = result.breakdown.find((b) => b.paramKey === "material");
    expect(parseFloat(matLine!.amount)).toBeCloseTo(180, 2);
    expect(result.totalPrice).toBeCloseTo(120 + 180, 2);
  });

  it("applies ultra-precision tolerance +75% premium", () => {
    const sel = {
      material: "stainless-316",
      outerDiameterMm: 5,
      lengthMm: 20,
      toleranceClass: "ultra-precision",
      quantity: 1,
    };
    const options = resolver.resolve(cncSwissTemplate, sel);
    const result = pricing.calculate(options, sel);
    // ultra-precision +75% of $120 = +$90
    const tolLine = result.breakdown.find((b) => b.paramKey === "toleranceClass");
    expect(parseFloat(tolLine!.amount)).toBeCloseTo(90, 2);
  });

  it("applies live-tool ops as flat fees per selected op", () => {
    const sel = {
      material: "stainless-303",
      outerDiameterMm: 10,
      lengthMm: 40,
      toleranceClass: "standard",
      liveTooling: true,
      liveToolOps: ["cross-drill", "cross-tap", "slot"],
      quantity: 1,
    };
    const options = resolver.resolve(cncSwissTemplate, sel);
    const result = pricing.calculate(options, sel);
    // cross-drill +$6, cross-tap +$10, slot +$8 → 3 breakdown rows for liveToolOps
    const opLines = result.breakdown.filter((b) => b.paramKey === "liveToolOps");
    expect(opLines.length).toBe(3);
    const opTotal = opLines.reduce((a, b) => a + parseFloat(b.amount), 0);
    expect(opTotal).toBeCloseTo(6 + 10 + 8, 2);
    // total per unit: $120 + $24 = $144
    expect(result.totalPrice).toBeCloseTo(144, 2);
  });

  it("multiplies per-unit cost by high-volume quantity (1000+)", () => {
    const sel = {
      material: "brass-360",
      outerDiameterMm: 4,
      lengthMm: 15,
      toleranceClass: "standard",
      quantity: 5000,
    };
    const options = resolver.resolve(cncSwissTemplate, sel);
    const result = pricing.calculate(options, sel);
    // brass-360 has no pricingImpact (free-machining baseline)
    // $120 × 5000 = $600,000
    expect(result.totalPrice).toBe(600000);
  });

  it("realistic medical-implant: 316L, ultra-precision, sub-spindle, ISO 13485, qty 2000", () => {
    const sel = {
      material: "stainless-316l",
      outerDiameterMm: 4.5,
      lengthMm: 22,
      toleranceClass: "ultra-precision",
      liveTooling: true,
      liveToolOps: ["cross-drill"],
      subSpindle: true,
      subSpindleOps: ["face", "drill", "part-off"],
      surfaceFinish: "electropolish",
      certifications: ["iso-13485", "fda-21-cfr-820"],
      quantity: 2000,
    };
    const options = resolver.resolve(cncSwissTemplate, sel);
    const result = pricing.calculate(options, sel);
    // Per unit:
    //   $120 base
    //   +316L +45% = $54
    //   +ultra-precision +75% = $90
    //   +cross-drill +$6
    //   +face +$4, drill +$6, part-off +$3 = +$13
    //   +electropolish +$18
    //   +ISO 13485 +25% = $30
    //   +FDA QSR +35% = $42
    //   per unit = $373
    //   × 2000 = $746,000
    expect(result.totalPrice).toBeCloseTo(373 * 2000, 0);
    const keys = result.breakdown.map((b) => b.paramKey);
    expect(keys).toContain("material");
    expect(keys).toContain("toleranceClass");
    expect(keys).toContain("liveToolOps");
    expect(keys).toContain("subSpindleOps");
    expect(keys).toContain("certifications");
  });
});

describe("cncSwissTemplate — constraints", () => {
  it("plastics restrict surface finish to a minimal set (no chemical treatments)", () => {
    const options = resolver.resolve(cncSwissTemplate, { material: "peek" });
    const sf = options.allParams.find((p) => p.def.key === "surfaceFinish");
    const opts = (sf!.def as any).options as Array<{ value: string }>;
    const vals = opts.map((o) => o.value);
    expect(vals).toEqual(["as-turned", "deburr-tumble", "polish-fine", "laser-engrave"]);
  });

  it("non-stainless excludes passivation and electropolish", () => {
    const options = resolver.resolve(cncSwissTemplate, { material: "brass-360" });
    const sf = options.allParams.find((p) => p.def.key === "surfaceFinish");
    const vals = ((sf!.def as any).options as Array<{ value: string }>).map((o) => o.value);
    expect(vals).not.toContain("passivation");
    expect(vals).not.toContain("electropolish");
  });

  it("non-titanium excludes Ti anodize", () => {
    const options = resolver.resolve(cncSwissTemplate, { material: "stainless-316" });
    const sf = options.allParams.find((p) => p.def.key === "surfaceFinish");
    const vals = ((sf!.def as any).options as Array<{ value: string }>).map((o) => o.value);
    expect(vals).not.toContain("ti-anodize");
  });

  it("titanium keeps Ti anodize", () => {
    const options = resolver.resolve(cncSwissTemplate, { material: "titanium-grade-5" });
    const sf = options.allParams.find((p) => p.def.key === "surfaceFinish");
    const vals = ((sf!.def as any).options as Array<{ value: string }>).map((o) => o.value);
    expect(vals).toContain("ti-anodize");
  });

  it("ultra-precision tolerance restricts material to stable fine-grain alloys", () => {
    const options = resolver.resolve(cncSwissTemplate, { toleranceClass: "ultra-precision" });
    const mat = options.allParams.find((p) => p.def.key === "material");
    const vals = ((mat!.def as any).options as Array<{ value: string }>).map((o) => o.value);
    // Plastics and aluminum 7075 dropped; stable alloys retained
    expect(vals).not.toContain("peek");
    expect(vals).not.toContain("pom-delrin");
    expect(vals).not.toContain("aluminum-7075-t6");
    expect(vals).toContain("stainless-303");
    expect(vals).toContain("stainless-316l");
    expect(vals).toContain("titanium-grade-5");
  });

  it("large OD (>20mm) raises barStockDiameter floor to 20mm", () => {
    const options = resolver.resolve(cncSwissTemplate, { outerDiameterMm: 28 });
    const bsd = options.allParams.find((p) => p.def.key === "barStockDiameter");
    expect((bsd!.def as any).min).toBe(20);
  });
});

describe("cncSwissTemplate — profiles", () => {
  it("registers tornos-deco / citizen-cincom / star-sb20 profiles for cnc-swiss", () => {
    const profiles = getProfilesForType("cnc-swiss");
    const ids = profiles.map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining(["profile_tornos_deco", "profile_citizen_cincom", "profile_star_sb20"]),
    );
  });

  it("Tornos DECO caps OD at 13mm and restricts to medical-friendly materials", () => {
    const profile = getProfile("profile_tornos_deco")!;
    const options = resolver.resolve(cncSwissTemplate, {}, profile);
    const od = options.allParams.find((p) => p.def.key === "outerDiameterMm");
    expect((od!.def as any).max).toBe(13);
    const mat = options.allParams.find((p) => p.def.key === "material");
    const vals = ((mat!.def as any).options as Array<{ value: string }>).map((o) => o.value);
    expect(vals).not.toContain("aluminum-7075-t6");
    expect(vals).not.toContain("pom-delrin");
    expect(vals).toContain("stainless-316l");
    expect(vals).toContain("titanium-grade-5");
  });

  it("Star SB-20 defaults barFeeder to multi-bar-loader (unattended runs)", () => {
    const profile = getProfile("profile_star_sb20")!;
    const options = resolver.resolve(cncSwissTemplate, {}, profile);
    const bf = options.allParams.find((p) => p.def.key === "barFeeder");
    expect((bf!.def as any).defaultValue).toBe("multi-bar-loader");
    const od = options.allParams.find((p) => p.def.key === "outerDiameterMm");
    expect((od!.def as any).max).toBe(20);
  });

  it("Citizen Cincom keeps full 32mm envelope and full material catalog", () => {
    const profile = getProfile("profile_citizen_cincom")!;
    const options = resolver.resolve(cncSwissTemplate, {}, profile);
    const od = options.allParams.find((p) => p.def.key === "outerDiameterMm");
    expect((od!.def as any).max).toBe(32);
    const mat = options.allParams.find((p) => p.def.key === "material");
    const vals = ((mat!.def as any).options as Array<{ value: string }>).map((o) => o.value);
    // Cincom doesn't restrict materials — full surface available
    expect(vals.length).toBeGreaterThanOrEqual(10);
  });
});
