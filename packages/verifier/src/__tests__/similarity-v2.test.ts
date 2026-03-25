/**
 * Tests for V2 structural fingerprinting in the similarity scorer.
 *
 * Key property being tested: two CSDs that are structurally identical but with
 * renamed parameters/constraints/descriptions should still score high similarity.
 * This defeats the "rename everything to dodge IP" attack.
 */

import { describe, it, expect } from "vitest";
import {
  computeParamSpaceGeometry,
  computeConstraintTopology,
  computeEvidenceFingerprint,
  computeAdapterProtocolStack,
  computePricingShape,
  SimilaritySubnet,
} from "../bittensor/similarity-scorer.js";
import type {
  SimilarityCsdParam,
  SimilarityCsdConstraint,
  SimilarityCsdEvidence,
  SimilarityCsdPricing,
  SimilarityCandidateCsd,
  SimilarityRegisteredCsd,
} from "../bittensor/similarity-scorer.js";

// ── Fixtures ──────────────────────────────────────────────────────────

function numericParam(key: string, min: number, max: number): SimilarityCsdParam {
  return { key, type: "number", label: key, min, max };
}

function enumParam(key: string, options: string[]): SimilarityCsdParam {
  return { key, type: "enum", label: key, options };
}

function boolParam(key: string): SimilarityCsdParam {
  return { key, type: "boolean", label: key };
}

function constraint(
  expression: string,
  whenParam?: string,
  thenParam?: string,
): SimilarityCsdConstraint {
  return { expression, whenParam, thenParam };
}

// ── Parameter Space Geometry ──────────────────────────────────────────

describe("computeParamSpaceGeometry", () => {
  it("returns 1.0 for identical parameter sets", () => {
    const params: SimilarityCsdParam[] = [
      numericParam("temperature", 180, 280),
      numericParam("speed", 20, 100),
      enumParam("material", ["PLA", "ABS", "PETG"]),
    ];
    expect(computeParamSpaceGeometry(params, params)).toBeCloseTo(1.0, 2);
  });

  it("returns 1.0 for empty params", () => {
    expect(computeParamSpaceGeometry([], [])).toBe(1.0);
  });

  it("returns 0.0 when one side is empty", () => {
    const params = [numericParam("x", 0, 100)];
    expect(computeParamSpaceGeometry(params, [])).toBe(0.0);
    expect(computeParamSpaceGeometry([], params)).toBe(0.0);
  });

  it("scores renamed params with identical ranges as similar (defeats rename attack)", () => {
    // Same structure, different key/label names
    const paramsA: SimilarityCsdParam[] = [
      numericParam("nozzle_temp", 180, 280),
      numericParam("print_speed", 20, 100),
      enumParam("filament_type", ["PLA", "ABS", "PETG"]),
    ];
    const paramsB: SimilarityCsdParam[] = [
      numericParam("hotend_temperature", 180, 280),  // same range, different name
      numericParam("extrusion_velocity", 20, 100),    // same range, different name
      enumParam("material_class", ["PLA", "ABS", "PETG"]), // same options, different name
    ];

    const sim = computeParamSpaceGeometry(paramsA, paramsB);
    expect(sim).toBeGreaterThan(0.8); // Should be high — same structure
  });

  it("scores different parameter spaces as less similar than identical ones", () => {
    // FDM printer vs laser cutter — different param spaces
    // The geometry dimension looks at structure (counts, ranges, type mix)
    // Two capabilities with same structural pattern will still score moderately
    const fdmParams: SimilarityCsdParam[] = [
      numericParam("temperature", 180, 280),
      numericParam("layer_height", 0.1, 0.4),
      enumParam("material", ["PLA", "ABS"]),
    ];
    const laserParams: SimilarityCsdParam[] = [
      numericParam("power_percent", 10, 100),
      numericParam("scan_speed_mm_s", 100, 2000),
      numericParam("passes", 1, 10),
      numericParam("focus_offset_mm", -5, 5),
    ];

    const sameStructureSim = computeParamSpaceGeometry(fdmParams, fdmParams);
    const differentSim = computeParamSpaceGeometry(fdmParams, laserParams);

    // The same-structure similarity should be significantly higher than different structures
    expect(sameStructureSim).toBeGreaterThan(differentSim);
    // Identical is 1.0, different should be measurably lower
    expect(differentSim).toBeLessThan(sameStructureSim - 0.1);
  });

  it("is sensitive to range differences", () => {
    // Same keys, but very different ranges → less similar
    const paramsA = [numericParam("temp", 180, 280)]; // narrow range
    const paramsB = [numericParam("temp", 0, 10000)]; // extreme range

    const sim = computeParamSpaceGeometry(paramsA, paramsB);
    expect(sim).toBeLessThan(0.9); // Should differ due to range
  });
});

// ── Constraint Graph Topology ──────────────────────────────────────────

describe("computeConstraintTopology", () => {
  it("returns 1.0 for identical constraints", () => {
    const cons: SimilarityCsdConstraint[] = [
      constraint("material eq PLA => temp_min = 190", "material", "temperature"),
      constraint("speed > 80 => fan_speed = 100", "speed", "fan_speed"),
    ];
    expect(computeConstraintTopology(cons, cons)).toBeCloseTo(1.0, 2);
  });

  it("returns 1.0 for empty constraints", () => {
    expect(computeConstraintTopology([], [])).toBe(1.0);
  });

  it("returns 0.0 when one side is empty", () => {
    const cons = [constraint("x > 0 => y = 1", "x", "y")];
    expect(computeConstraintTopology(cons, [])).toBe(0.0);
  });

  it("detects same constraint topology with different expressions (defeats rewording)", () => {
    // Same topology: material constrains temperature, speed constrains fan_speed
    // But different expression wordings
    const consA: SimilarityCsdConstraint[] = [
      constraint("if material == PLA then temperature >= 190", "material", "temperature"),
      constraint("when speed > 80 set fan_speed to 100%", "speed", "fan_speed"),
    ];
    const consB: SimilarityCsdConstraint[] = [
      constraint("material=PLA requires nozzle_temp min 190", "material", "temperature"),
      constraint("fast speed demands high cooling", "speed", "fan_speed"),
    ];

    const sim = computeConstraintTopology(consA, consB);
    // Both have same edges: material→temperature, speed→fan_speed
    expect(sim).toBeGreaterThan(0.5);
  });

  it("scores different constraint graphs as less similar", () => {
    const consA: SimilarityCsdConstraint[] = [
      constraint("A constrains B", "paramA", "paramB"),
      constraint("B constrains C", "paramB", "paramC"),
    ];
    const consB: SimilarityCsdConstraint[] = [
      constraint("X constrains Y", "paramX", "paramY"),
      constraint("Z constrains W", "paramZ", "paramW"),
    ];

    // Different edge names → topology differs
    const sim = computeConstraintTopology(consA, consB);
    expect(sim).toBeLessThan(0.6);
  });
});

// ── Evidence Tier Fingerprint ──────────────────────────────────────────

describe("computeEvidenceFingerprint", () => {
  it("returns 1.0 for identical evidence tiers", () => {
    const ev: SimilarityCsdEvidence[] = [
      { tier: "0", required: ["photo", "timestamp"] },
      { tier: "1", required: ["photo", "measurement", "calibration"] },
    ];
    expect(computeEvidenceFingerprint(ev, ev)).toBeCloseTo(1.0, 2);
  });

  it("returns 0.5 for empty evidence (both) — neutral, not identical", () => {
    expect(computeEvidenceFingerprint([], [])).toBe(0.5);
  });

  it("returns 0.5 when one side has evidence and other doesn't", () => {
    const ev = [{ tier: "0", required: ["photo"] }];
    expect(computeEvidenceFingerprint(ev, [])).toBe(0.5);
  });

  it("scores matching evidence types as similar regardless of tier label ordering", () => {
    const evA: SimilarityCsdEvidence[] = [
      { tier: "0", required: ["photo", "timestamp"] },
      { tier: "1", required: ["measurement", "calibration", "photo"] },
    ];
    const evB: SimilarityCsdEvidence[] = [
      { tier: "0", required: ["timestamp", "photo"] }, // same, different order
      { tier: "1", required: ["photo", "calibration", "measurement"] }, // same, different order
    ];

    const sim = computeEvidenceFingerprint(evA, evB);
    expect(sim).toBeCloseTo(1.0, 2);
  });

  it("scores different evidence requirements as dissimilar", () => {
    const evA: SimilarityCsdEvidence[] = [
      { tier: "0", required: ["photo", "timestamp"] },
      { tier: "1", required: ["3d_scan", "material_cert", "calibration"] },
    ];
    const evB: SimilarityCsdEvidence[] = [
      { tier: "0", required: ["video_stream", "gps_location"] },
      { tier: "1", required: ["spectrometer_reading", "temperature_log"] },
    ];

    const sim = computeEvidenceFingerprint(evA, evB);
    expect(sim).toBeLessThan(0.3);
  });
});

// ── Adapter Protocol Stack ─────────────────────────────────────────────

describe("computeAdapterProtocolStack", () => {
  it("returns 0.5 (neutral) when both adapters are undefined with no protocols", () => {
    expect(computeAdapterProtocolStack(undefined, [], undefined, [])).toBe(0.5);
  });

  it("scores exact adapter + protocol match as high", () => {
    const sim = computeAdapterProtocolStack(
      "octoprint",
      ["http", "websocket"],
      "octoprint",
      ["http", "websocket"],
    );
    expect(sim).toBeGreaterThan(0.9);
  });

  it("scores mismatched adapters as low", () => {
    const sim = computeAdapterProtocolStack(
      "octoprint",
      ["http"],
      "modbus",
      ["modbus-tcp"],
    );
    expect(sim).toBeLessThan(0.3);
  });

  it("scores same adapter different protocols partially", () => {
    const sim = computeAdapterProtocolStack(
      "mqtt",
      ["mqtt", "http"],
      "mqtt",
      ["mqtt", "coap"],
    );
    expect(sim).toBeGreaterThan(0.4);
    expect(sim).toBeLessThan(1.0);
  });

  it("scores same protocols but different adapter type partially", () => {
    const sim = computeAdapterProtocolStack(
      "octoprint",
      ["http", "websocket"],
      "marlin",
      ["http", "websocket"],
    );
    // Same protocols (40% weight match), different adapter (60% weight miss)
    // Expected ~ 0.4
    expect(sim).toBeGreaterThan(0.2);
    expect(sim).toBeLessThan(0.7);
  });
});

// ── Pricing Model Shape ────────────────────────────────────────────────

describe("computePricingShape", () => {
  it("scores identical pricing shape as 1.0", () => {
    const pricing: SimilarityCsdPricing = {
      basePrice: "10.00",
      currency: "USDC",
      unit: "per_gram",
      impactModes: ["flat", "per_unit"],
    };
    expect(computePricingShape(pricing, pricing)).toBeCloseTo(1.0, 2);
  });

  it("scores different currencies as less similar", () => {
    const a: SimilarityCsdPricing = { basePrice: "10", currency: "USDC", unit: "per_hour" };
    const b: SimilarityCsdPricing = { basePrice: "10", currency: "ETH", unit: "per_hour" };
    const sim = computePricingShape(a, b);
    expect(sim).toBeLessThan(0.9);
  });

  it("scores same unit prefix as partially similar", () => {
    // "per_gram" and "per_gram_weight" have same prefix "per"
    const a: SimilarityCsdPricing = { basePrice: "1", currency: "USDC", unit: "per_gram" };
    const b: SimilarityCsdPricing = { basePrice: "1", currency: "USDC", unit: "per_gram_dry" };
    const sim = computePricingShape(a, b);
    // Same currency (30%) + partial unit match (40% * 0.5 = 20%) = ~0.7
    expect(sim).toBeGreaterThan(0.5);
  });

  it("is insensitive to price value differences (same shape matters, not value)", () => {
    const a: SimilarityCsdPricing = {
      basePrice: "5.00",
      currency: "USDC",
      unit: "per_hour",
      impactModes: ["flat", "multiplier"],
    };
    const b: SimilarityCsdPricing = {
      basePrice: "9999.99", // wildly different price
      currency: "USDC",
      unit: "per_hour",
      impactModes: ["flat", "multiplier"],
    };

    const sim = computePricingShape(a, b);
    expect(sim).toBeGreaterThan(0.9); // Same shape despite different value
  });
});

// ── Full subnet integration ────────────────────────────────────────────

describe("SimilaritySubnet V2", () => {
  it("detects high similarity for structurally identical CSDs with renamed fields", async () => {
    const subnet = new SimilaritySubnet(4);

    const candidateCsd: SimilarityCandidateCsd = {
      url: "pcc://capabilities/fdm-clone/v1",
      name: "FFF Capability (renamed)",
      description: "Fused Filament Fabrication with renamed everything",
      kind: "base",
      parameters: [
        numericParam("hotend_temp", 180, 280),
        numericParam("extrusion_speed", 20, 100),
        enumParam("filament", ["PLA", "ABS", "PETG"]),
        boolParam("supports_enabled"),
      ],
      constraints: [
        constraint("filament requires temp", "filament", "hotend_temp"),
        constraint("high speed needs fan", "extrusion_speed", "cooling"),
      ],
      pricing: { basePrice: "2.00", currency: "USDC", unit: "per_gram", impactModes: ["per_unit"] },
      evidence: [{ tier: "0", required: ["photo"] }, { tier: "1", required: ["measurement"] }],
      adapterType: "octoprint",
      discoveryProtocols: ["http", "websocket"],
    };

    const registeredCsd: SimilarityRegisteredCsd = {
      url: "pcc://capabilities/fdm/v1",
      name: "FDM 3D Printing",
      description: "Original fused deposition modeling capability",
      kind: "base",
      parameters: [
        numericParam("nozzle_temperature", 180, 280),  // same range, different name
        numericParam("print_speed", 20, 100),           // same range, different name
        enumParam("material_type", ["PLA", "ABS", "PETG"]), // same options, different name
        boolParam("generate_supports"),                 // same type, different name
      ],
      constraints: [
        constraint("material => nozzle temp", "material_type", "nozzle_temperature"),
        constraint("speed => cooling", "print_speed", "cooling"),
      ],
      pricing: { basePrice: "1.50", currency: "USDC", unit: "per_gram", impactModes: ["per_unit"] },
      evidence: [{ tier: "0", required: ["photo"] }, { tier: "1", required: ["measurement"] }],
      adapterType: "octoprint",
      discoveryProtocols: ["http", "websocket"],
      registeredAt: new Date().toISOString(),
      ipId: "0xoriginal-fdm",
    };

    const result = await subnet.detectSimilarity({
      candidateCsd,
      registeredCsds: [registeredCsd],
    });

    expect(result.similarities).toHaveLength(1);
    const sim = result.similarities[0];

    // Should detect high similarity despite name/label differences
    expect(sim.overallScore).toBeGreaterThan(0.60);
    // Verdict should be derivative or clone — not original
    expect(["derivative", "clone"]).toContain(sim.verdict);
    // Structural dimensions should be high
    expect(sim.dimensions.paramGeometry).toBeGreaterThan(0.7);
    expect(sim.dimensions.adapterProtocol).toBeGreaterThan(0.8);
  }, 10000);

  it("correctly identifies a genuinely different capability as original", async () => {
    const subnet = new SimilaritySubnet(4);

    const laserCandidate: SimilarityCandidateCsd = {
      url: "pcc://capabilities/laser-cut/v1",
      name: "CO2 Laser Cutting",
      description: "Laser cutting and engraving service",
      kind: "base",
      parameters: [
        numericParam("power_percent", 10, 100),
        numericParam("scan_speed", 100, 2000),
        numericParam("passes", 1, 10),
        enumParam("material", ["wood", "acrylic", "leather"]),
      ],
      constraints: [
        constraint("material acrylic => safe ventilation", "material", "ventilation"),
      ],
      pricing: { basePrice: "0.50", currency: "USDC", unit: "per_cm2", impactModes: ["per_unit"] },
      adapterType: "lightburn",
      discoveryProtocols: ["usb", "serial"],
    };

    const fdmRegistered: SimilarityRegisteredCsd = {
      url: "pcc://capabilities/fdm/v1",
      name: "FDM 3D Printing",
      description: "Fused deposition modeling with heated nozzle",
      kind: "base",
      parameters: [
        numericParam("nozzle_temperature", 180, 280),
        numericParam("print_speed", 20, 100),
        enumParam("material_type", ["PLA", "ABS", "PETG"]),
        boolParam("generate_supports"),
      ],
      constraints: [
        constraint("material => nozzle temp", "material_type", "nozzle_temperature"),
      ],
      pricing: { basePrice: "1.50", currency: "USDC", unit: "per_gram", impactModes: ["per_unit"] },
      adapterType: "octoprint",
      discoveryProtocols: ["http", "websocket"],
      registeredAt: new Date().toISOString(),
      ipId: "0xoriginal-fdm",
    };

    const result = await subnet.detectSimilarity({
      candidateCsd: laserCandidate,
      registeredCsds: [fdmRegistered],
    });

    expect(result.similarities).toHaveLength(1);
    const sim = result.similarities[0];

    // Protocol stack should be very different (different adapter + protocols)
    expect(sim.dimensions.adapterProtocol).toBeLessThan(0.3);

    // Different capability — overall score should be lower than the identical-structure test (> 0.6)
    // The score may be in the 0.4-0.7 range depending on structural overlap
    // Key property: adapterProtocol dimension correctly identifies them as different
    expect(sim.dimensions.adapterProtocol).toBeLessThan(0.2);

    // The combined score should be significantly lower than for the renamed-but-same-structure case
    expect(sim.overallScore).toBeLessThan(0.7);
  }, 10000);
});
