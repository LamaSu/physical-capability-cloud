import { describe, it, expect } from "vitest";
import { CsdRegistry } from "./registry.js";
import { buildContractRegistrySnapshot } from "./registry-contract-adapter.js";
import {
  KNOWN_UNITS,
  UnitSchema,
  QuantitySchema,
  PortTypeSchema,
  ParameterDefinitionSchema,
  type CompositionBlock,
} from "./composition.js";
import type { CSD } from "./schema.js";

/**
 * `KNOWN_UNITS` in composition.ts is a VERBATIM mirror of prism's unit-symbol list
 * (unit table `prism-plan-units-v2`): same symbols, same order. This file holds the pinned
 * copy of that list, so ANY drift -- a unit added, dropped or reordered on either side -- fails
 * here. The mirror and this pin are updated together, in lockstep with prism.
 */

/** The 36 symbols the mirror carried at `prism-plan-units-v1`, in order. v2 left them unchanged. */
const V1_SYMBOLS = [
  // length
  "m", "mm", "cm", "km",
  // mass
  "kg", "g", "mg", "ug",
  // time
  "s", "ms", "min", "h",
  // temperature
  "K", "degC", "degF",
  // amount-of-substance
  "mol", "mmol",
  // current
  "A", "mA",
  // luminosity
  "cd",
  // volume
  "L", "mL", "uL", "m3",
  // speed
  "m/s", "km/h",
  // concentration
  "mol/L", "mmol/L", "umol/L",
  // pressure
  "Pa", "kPa", "bar", "atm",
  // energy
  "J", "kJ", "cal",
] as const;

/** The 8 symbols `prism-plan-units-v2` appended after them, in prism's order. */
const V2_ADDED_SYMBOLS = ["L/s", "L/min", "L/h", "mL/s", "mL/min", "uL/s", "uL/min", "rpm"] as const;

describe("KNOWN_UNITS -- pinned mirror of prism-plan-units-v2", () => {
  it("is the 36 original symbols followed by the 8 v2 symbols: same symbols, same order", () => {
    expect([...KNOWN_UNITS]).toEqual([...V1_SYMBOLS, ...V2_ADDED_SYMBOLS]);
  });

  it("has 44 distinct symbols", () => {
    expect(KNOWN_UNITS).toHaveLength(44);
    expect(new Set(KNOWN_UNITS).size).toBe(44);
  });

  it("keeps the original 36 untouched and appends the 8 new ones after them, in prism's order", () => {
    expect(KNOWN_UNITS.slice(0, 36)).toEqual([...V1_SYMBOLS]);
    expect(KNOWN_UNITS.slice(36)).toEqual(["L/s", "L/min", "L/h", "mL/s", "mL/min", "uL/s", "uL/min", "rpm"]);
  });
});

describe("UnitSchema -- v2 units", () => {
  it("accepts every new unit", () => {
    for (const unit of V2_ADDED_SYMBOLS) {
      expect(UnitSchema.safeParse(unit).success, unit).toBe(true);
    }
  });

  it("still accepts every original unit", () => {
    for (const unit of V1_SYMBOLS) {
      expect(UnitSchema.safeParse(unit).success, unit).toBe(true);
    }
  });

  it("refuses an unknown unit (Hz) and near-miss spellings of the new ones", () => {
    for (const bad of ["Hz", "rad/s", "RPM", "ml/min", "l/min", "L/m", "uL/sec", "L/ s", ""]) {
      expect(UnitSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("the composition schemas accept the new units and refuse Hz", () => {
  it("QuantitySchema", () => {
    expect(QuantitySchema.safeParse({ value: 120, unit: "uL/min" }).success).toBe(true);
    expect(QuantitySchema.safeParse({ value: 1500, unit: "rpm", uncertainty: 10 }).success).toBe(true);
    expect(QuantitySchema.safeParse({ value: 50, unit: "Hz" }).success).toBe(false);
  });

  it("PortTypeSchema", () => {
    expect(PortTypeSchema.safeParse({ semanticType: "reagent-flow", unit: "mL/min", required: true }).success).toBe(true);
    expect(PortTypeSchema.safeParse({ semanticType: "stirrer-speed", unit: "rpm", required: false }).success).toBe(true);
    expect(PortTypeSchema.safeParse({ semanticType: "stirrer-speed", unit: "Hz", required: false }).success).toBe(false);
  });

  it("ParameterDefinitionSchema (unit plus minimum/maximum quantities)", () => {
    const flow = {
      name: "flowRate",
      semanticType: "volumetric-flow-rate",
      required: true,
      unit: "uL/s",
      minimum: { value: 0.5, unit: "uL/s" },
      maximum: { value: 120, unit: "uL/min" },
    };
    expect(ParameterDefinitionSchema.safeParse(flow).success).toBe(true);
    expect(ParameterDefinitionSchema.safeParse({ ...flow, unit: "Hz" }).success).toBe(false);
    expect(ParameterDefinitionSchema.safeParse({ ...flow, maximum: { value: 120, unit: "Hz" } }).success).toBe(false);
  });
});

/** A minimal schema-valid CSD (same shape the D2 adapter tests use); override any field via `over`. */
function csd(url: string, over: Partial<CSD> = {}): CSD {
  return {
    url,
    version: "1.0.0",
    status: "active",
    name: "Test cap",
    description: "a test capability",
    kind: "base",
    baseDefinition: null,
    parameters: [],
    constraints: [],
    pricing: { basePrice: "1.00", currency: "USDC" },
    ...over,
  };
}

/** A COMPLETE composition block whose ports and parameters use the v2 flow and rotation units. */
function flowComposition(over: Partial<CompositionBlock> = {}): CompositionBlock {
  return {
    inputPorts: { feed: { semanticType: "reagent-flow", unit: "uL/s", required: true } },
    outputPorts: { agitation: { semanticType: "stirrer-speed", unit: "rpm", required: true } },
    allowedEffectSignatures: [{ kind: "create-asset", semanticType: "physical-part" }],
    requiredEffects: [{ kind: "create-asset", semanticType: "physical-part" }],
    allowedPreconditionSignatures: [{ kind: "has-type", stateClass: "asset", semanticType: "mesh" }],
    requiredPreconditions: [{ kind: "exists", subject: { kind: "asset", id: "input-model" } }],
    parameters: [
      {
        name: "flowRate",
        semanticType: "volumetric-flow-rate",
        required: true,
        unit: "uL/s",
        minimum: { value: 0.5, unit: "uL/s" },
        maximum: { value: 120, unit: "uL/min" },
      },
      {
        name: "stirSpeed",
        semanticType: "rotational-speed",
        required: false,
        unit: "rpm",
        minimum: { value: 100, unit: "rpm" },
        maximum: { value: 1500, unit: "rpm" },
      },
    ],
    ...over,
  };
}

describe("the new units flow through a CSD composition block and the D2 adapter", () => {
  it("a CSD declaring flow and rotation units registers and projects into a contract with those units intact", async () => {
    const reg = new CsdRegistry();
    reg.register(csd("pcc://capabilities/syringe-pump/v1", { composition: flowComposition() }));

    const snap = await buildContractRegistrySnapshot(reg);

    const contract = snap.contracts["syringe-pump"]!;
    expect(contract.inputPorts["feed"]!.unit).toBe("uL/s");
    expect(contract.outputPorts["agitation"]!.unit).toBe("rpm");
    expect(contract.parameters.map((p) => p.unit)).toEqual(["uL/s", "rpm"]);
    expect(contract.parameters[0]!.maximum).toEqual({ value: 120, unit: "uL/min" });
  });

  it("a CSD declaring Hz is refused at registration, naming the offending unit field", () => {
    const reg = new CsdRegistry();
    const bad = {
      ...flowComposition(),
      parameters: [{ name: "stirSpeed", semanticType: "rotational-speed", required: true, unit: "Hz" }],
    } as unknown as CompositionBlock;

    expect(() => reg.register(csd("pcc://capabilities/syringe-pump/v1", { composition: bad }))).toThrow(
      /composition\.parameters\.0\.unit/,
    );
  });
});
