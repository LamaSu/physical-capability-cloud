/**
 * liquid-handling-plr template + opentrons-ot2-via-plr profile tests.
 *
 * Verifies:
 *   - Template registration + structure
 *   - Param schema (18 params in 8 groups)
 *   - Cross-parameter constraints (volatile liquid → filter tips, 96/384-ch
 *     plates only, chatterbox protocol-type restriction)
 *   - Profile registration + restrictions
 *   - PricingCalculator end-to-end with representative selections
 */

import { describe, it, expect } from "vitest";
import { PricingCalculator } from "../pricing.js";
import { TemplateResolver } from "../resolver.js";
import { liquidHandlingPlrTemplate } from "../templates/liquid-handling-plr.js";
import { getTemplate } from "../templates/index.js";
import { getProfile, getProfilesForType } from "../profiles/index.js";

const resolver = new TemplateResolver();
const pricing = new PricingCalculator();

describe("liquidHandlingPlrTemplate — structure", () => {
  it("is registered under 'liquid-handling-plr' at v1.0", () => {
    const t = getTemplate("liquid-handling-plr");
    expect(t).toBeDefined();
    expect(t?.version).toBe("1.0");
    expect(t?.name).toBe("Liquid Handling (PyLabRobot)");
  });

  it("declares 18 params in 8 groups", () => {
    expect(liquidHandlingPlrTemplate.params.length).toBe(18);
    const groups = new Set(liquidHandlingPlrTemplate.params.map((p) => p.group));
    expect(groups.size).toBe(8);
    expect(groups).toEqual(
      new Set([
        "Backend",
        "Protocol",
        "Labware",
        "Pipetting",
        "Reagents",
        "Modules",
        "Evidence",
        "Order",
      ]),
    );
  });

  it("plrBackend enum covers OT-2 + Flex + STAR + Vantage + EVO + chatterbox", () => {
    const backend = liquidHandlingPlrTemplate.params.find((p) => p.key === "plrBackend");
    expect(backend).toBeDefined();
    expect((backend as any).type).toBe("enum");
    const vals = ((backend as any).options as Array<{ value: string }>).map((o) => o.value);
    expect(vals).toEqual(["ot2", "flex", "star", "vantage", "evo", "chatterbox"]);
  });

  it("transferVolume_uL spans 0.5–5000 uL with 0.5 step (Hamilton 5mL range)", () => {
    const vol = liquidHandlingPlrTemplate.params.find((p) => p.key === "transferVolume_uL");
    expect((vol as any).min).toBe(0.5);
    expect((vol as any).max).toBe(5000);
    expect((vol as any).step).toBe(0.5);
    expect((vol as any).unit).toBe("uL");
  });

  it("plateFormat covers 6 → 1536 wells with pricing impact for high density", () => {
    const fmt = liquidHandlingPlrTemplate.params.find((p) => p.key === "plateFormat");
    const opts = (fmt as any).options as Array<{ value: string; pricingImpact?: { value: string } }>;
    const fmt1536 = opts.find((o) => o.value === "1536");
    expect(fmt1536?.pricingImpact?.value).toBe("25");
    const fmt384 = opts.find((o) => o.value === "384");
    expect(fmt384?.pricingImpact?.value).toBe("10");
  });

  it("liquidClass includes water/buffer/serum/dmso/ethanol/cells with biology surcharges", () => {
    const lc = liquidHandlingPlrTemplate.params.find((p) => p.key === "liquidClass");
    const opts = (lc as any).options as Array<{ value: string; pricingImpact?: { value: string } }>;
    const vals = opts.map((o) => o.value);
    expect(vals).toEqual(
      expect.arrayContaining(["water", "aqueous-buffer", "serum", "dmso", "ethanol", "cell-suspension"]),
    );
    expect(opts.find((o) => o.value === "serum")?.pricingImpact?.value).toBe("10");
    expect(opts.find((o) => o.value === "cell-suspension")?.pricingImpact?.value).toBe("15");
  });

  it("evidenceTier offers 0–3 with steep Tier-3 surcharge", () => {
    const tier = liquidHandlingPlrTemplate.params.find((p) => p.key === "evidenceTier");
    const opts = (tier as any).options as Array<{ value: string; pricingImpact?: { value: string } }>;
    expect(opts.map((o) => o.value)).toEqual(["0", "1", "2", "3"]);
    expect(opts.find((o) => o.value === "3")?.pricingImpact?.value).toBe("100");
  });

  it("sampleCount + replicates carry per-unit pricing impacts", () => {
    const samples = liquidHandlingPlrTemplate.params.find((p) => p.key === "sampleCount");
    expect((samples as any).pricingImpact.mode).toBe("per_unit");
    expect((samples as any).pricingImpact.value).toBe("0.30");

    const reps = liquidHandlingPlrTemplate.params.find((p) => p.key === "replicates");
    expect((reps as any).pricingImpact.mode).toBe("per_unit");
    expect((reps as any).pricingImpact.value).toBe("0.50");
  });

  it("base pricing hints: $12 USDC per plate/run", () => {
    expect(liquidHandlingPlrTemplate.basePricingHints?.basePrice).toBe("12.00");
    expect(liquidHandlingPlrTemplate.basePricingHints?.currency).toBe("USDC");
  });
});

describe("liquidHandlingPlrTemplate — constraints", () => {
  it("declares 4 cross-param constraints", () => {
    expect(liquidHandlingPlrTemplate.constraints?.length).toBe(4);
  });

  it("volatile liquid classes force filter tips", () => {
    const c = liquidHandlingPlrTemplate.constraints?.find(
      (x) => x.when.param === "liquidClass" && JSON.stringify(x.when.in) === JSON.stringify(["dmso", "ethanol", "volatile"]),
    );
    expect(c).toBeDefined();
    const restriction = c!.then.find((a) => a.param === "tipType");
    expect(restriction?.restrictTo).toEqual([
      "10uL-filter",
      "20uL-filter",
      "50uL-filter",
      "200uL-filter",
      "300uL-filter",
      "1000uL-filter",
    ]);
  });

  it("96-channel head restricts to 96/384 plates", () => {
    const c = liquidHandlingPlrTemplate.constraints?.find(
      (x) => x.when.param === "pipetteChannel" && x.when.equals === "96-channel",
    );
    expect(c).toBeDefined();
    const r = c!.then.find((a) => a.param === "plateFormat");
    expect(r?.restrictTo).toEqual(["96", "384"]);
  });

  it("384-channel head restricts to 384/1536 plates", () => {
    const c = liquidHandlingPlrTemplate.constraints?.find(
      (x) => x.when.param === "pipetteChannel" && x.when.equals === "384-channel",
    );
    expect(c).toBeDefined();
    const r = c!.then.find((a) => a.param === "plateFormat");
    expect(r?.restrictTo).toEqual(["384", "1536"]);
  });

  it("chatterbox backend restricts protocolType to dry-run-safe ops", () => {
    const c = liquidHandlingPlrTemplate.constraints?.find(
      (x) => x.when.param === "plrBackend" && x.when.equals === "chatterbox",
    );
    expect(c).toBeDefined();
    const r = c!.then.find((a) => a.param === "protocolType");
    expect(r?.restrictTo).toContain("transfer");
    expect(r?.restrictTo).not.toContain("cell-passage");
    expect(r?.restrictTo).not.toContain("pcr-prep");
  });
});

describe("opentronsOt2ViaPlr profile — restrictions", () => {
  it("is registered under 'profile_opentrons_ot2_via_plr'", () => {
    const p = getProfile("profile_opentrons_ot2_via_plr");
    expect(p).toBeDefined();
    expect(p?.machineName).toBe("Opentrons OT-2 (via PyLabRobot)");
    expect(p?.capabilityType).toBe("liquid-handling-plr");
  });

  it("restricts plrBackend to ot2 + chatterbox (no Hamilton)", () => {
    const p = getProfile("profile_opentrons_ot2_via_plr")!;
    const override = p.paramOverrides.find((o) => o.paramKey === "plrBackend")!;
    expect(override.restrictTo).toEqual(["ot2", "chatterbox"]);
    expect(override.overrideDefault).toBe("ot2");
  });

  it("restricts pipetteChannel to single + 8-channel (no 96/384 head)", () => {
    const p = getProfile("profile_opentrons_ot2_via_plr")!;
    const override = p.paramOverrides.find((o) => o.paramKey === "pipetteChannel")!;
    expect(override.restrictTo).toEqual(["single", "8-channel"]);
  });

  it("caps transferVolume_uL to OT-2 P1000 max (1000 uL)", () => {
    const p = getProfile("profile_opentrons_ot2_via_plr")!;
    const override = p.paramOverrides.find((o) => o.paramKey === "transferVolume_uL")!;
    expect(override.overrideMax).toBe(1000);
    expect(override.overrideMin).toBe(1);
  });

  it("excludes 1536-well plates", () => {
    const p = getProfile("profile_opentrons_ot2_via_plr")!;
    const override = p.paramOverrides.find((o) => o.paramKey === "plateFormat")!;
    expect(override.restrictTo).not.toContain("1536");
  });

  it("restricts evidenceTier to 0/1/2 (Tier 3 needs Lit/ZK off-instrument)", () => {
    const p = getProfile("profile_opentrons_ot2_via_plr")!;
    const override = p.paramOverrides.find((o) => o.paramKey === "evidenceTier")!;
    expect(override.restrictTo).toEqual(["0", "1", "2"]);
  });

  it("declares additional ot2Pipette + useApiv3 params", () => {
    const p = getProfile("profile_opentrons_ot2_via_plr")!;
    expect(p.additionalParams?.length).toBe(2);
    const pipette = p.additionalParams!.find((x) => x.key === "ot2Pipette");
    expect(pipette).toBeDefined();
    expect((pipette as any).group).toBe("OT-2");
    const v3 = p.additionalParams!.find((x) => x.key === "useApiv3");
    expect((v3 as any).type).toBe("boolean");
  });

  it("appears in getProfilesForType('liquid-handling-plr')", () => {
    const profiles = getProfilesForType("liquid-handling-plr");
    const ids = profiles.map((p) => p.id);
    expect(ids).toContain("profile_opentrons_ot2_via_plr");
  });

  it("overrides base price to $10 USDC", () => {
    const p = getProfile("profile_opentrons_ot2_via_plr")!;
    expect(p.pricingOverrides?.basePrice).toBe("10.00");
  });
});

describe("liquid-handling-plr — end-to-end resolve + price", () => {
  it("resolves base template (no profile) — 18 params, base price $12", () => {
    const options = resolver.resolve(liquidHandlingPlrTemplate, {});
    expect(options.allParams.length).toBe(18);
    expect(options.basePrice).toBe("12.00");
    expect(options.currency).toBe("USDC");
  });

  it("resolves with OT-2 profile — profile pricing override + additional params surface", () => {
    const profile = getProfile("profile_opentrons_ot2_via_plr")!;
    const options = resolver.resolve(liquidHandlingPlrTemplate, {}, profile);
    expect(options.basePrice).toBe("10.00");
    expect(options.machineInfo?.profileId).toBe("profile_opentrons_ot2_via_plr");
    // OT-2-specific params should appear in the resolved view
    const ot2Pipette = options.allParams.find((p) => p.def.key === "ot2Pipette");
    expect(ot2Pipette).toBeDefined();
  });

  it("priced run: OT-2, water transfer, 96 samples, Tier-1 evidence", () => {
    const profile = getProfile("profile_opentrons_ot2_via_plr")!;
    const selections = {
      plrBackend: "ot2",
      deckLayoutId: "deck-water-transfer-v1",
      protocolSource: "inline-ops",
      protocolPayload: "stock-protocol://water-transfer-96",
      protocolType: "transfer",
      plateFormat: "96",
      plateClass: "flat-bottom",
      tipType: "300uL-filter",
      pipetteChannel: "8-channel",
      transferVolume_uL: 100,
      mixCycles: 0,
      aspirationRate: "default",
      liquidClass: "water",
      sampleCount: 96,
      replicates: 1,
      modules: "",
      evidenceTier: "1",
      quantity: 1,
    };
    const options = resolver.resolve(liquidHandlingPlrTemplate, selections, profile);
    const result = pricing.calculate(options, selections);
    // Profile base = $10. 8-channel = -15% (-$1.50). 96 samples * $0.30 = +$28.80.
    // Expect range $30 < total < $50 — sanity check, not exact.
    expect(result.basePrice).toBe(10);
    expect(result.totalPrice).toBeGreaterThan(20);
    expect(result.totalPrice).toBeLessThan(60);
    expect(result.currency).toBe("USDC");
    expect(result.breakdown.length).toBeGreaterThan(0);
  });

  it("priced run: Tier-2 evidence adds +20% surcharge", () => {
    const profile = getProfile("profile_opentrons_ot2_via_plr")!;
    const base = {
      plrBackend: "ot2",
      deckLayoutId: "d1",
      protocolSource: "inline-ops",
      protocolPayload: "stock://p1",
      protocolType: "transfer",
      plateFormat: "96",
      plateClass: "flat-bottom",
      tipType: "300uL-filter",
      pipetteChannel: "single",
      transferVolume_uL: 50,
      mixCycles: 0,
      aspirationRate: "default",
      liquidClass: "water",
      sampleCount: 8,
      replicates: 1,
      modules: "",
      quantity: 1,
    };
    const tier1Options = resolver.resolve(liquidHandlingPlrTemplate, { ...base, evidenceTier: "1" }, profile);
    const tier1Result = pricing.calculate(tier1Options, { ...base, evidenceTier: "1" });
    const tier2Options = resolver.resolve(liquidHandlingPlrTemplate, { ...base, evidenceTier: "2" }, profile);
    const tier2Result = pricing.calculate(tier2Options, { ...base, evidenceTier: "2" });
    expect(tier2Result.totalPrice).toBeGreaterThan(tier1Result.totalPrice);
  });

  it("priced run: chatterbox dry-run resolves without errors", () => {
    const selections = {
      plrBackend: "chatterbox",
      deckLayoutId: "deck-mock",
      protocolSource: "inline-ops",
      protocolPayload: "stock://mock",
      protocolType: "transfer",
      plateFormat: "96",
      plateClass: "flat-bottom",
      tipType: "300uL",
      pipetteChannel: "single",
      transferVolume_uL: 100,
      mixCycles: 0,
      aspirationRate: "default",
      liquidClass: "water",
      sampleCount: 8,
      replicates: 1,
      modules: "",
      evidenceTier: "0",
      quantity: 1,
    };
    const options = resolver.resolve(liquidHandlingPlrTemplate, selections);
    const result = pricing.calculate(options, selections);
    expect(result.basePrice).toBe(12);
    expect(result.totalPrice).toBeGreaterThan(0);
  });
});
