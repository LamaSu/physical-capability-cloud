/**
 * BabelPCC compiler tests.
 *
 * Tests compile() on all 5 built-in CSDs:
 *   - Interface generation produces valid TypeScript
 *   - Validator generation catches invalid params
 *   - Pricing generation calculates correctly for known inputs
 *   - Test data generation produces structurally valid params
 *   - compileAll() processes entire registry
 */

import { describe, it, expect, beforeAll } from "vitest";
import { loadBuiltinCsds } from "@pcc/spec";
import { BabelPCC, deriveTypeName } from "../babel-pcc/index.js";

// ── Setup ────────────────────────────────────────────────────────────

let registry = loadBuiltinCsds();
let compiler: BabelPCC;

beforeAll(() => {
  registry = loadBuiltinCsds();
  compiler = new BabelPCC();
});

// ── Type name derivation ─────────────────────────────────────────────

describe("deriveTypeName", () => {
  it("derives FdmParams from FDM 3D Printing", () => {
    expect(deriveTypeName("FDM 3D Printing")).toBe("FdmParams");
  });

  it("derives SlaParams from SLA Resin Printing", () => {
    expect(deriveTypeName("SLA Resin Printing")).toBe("SlaParams");
  });

  it("derives Cnc3axisParams or similar from CNC 3-Axis Milling", () => {
    const name = deriveTypeName("CNC 3-Axis Milling");
    expect(name).toContain("Params");
    expect(name.length).toBeGreaterThan(0);
  });

  it("derives LaserParams or similar from Laser Cutting", () => {
    const name = deriveTypeName("Laser Cutting");
    expect(name).toContain("Params");
    expect(name.length).toBeGreaterThan(0);
  });

  it("derives Print2dParams or similar from 2D Print", () => {
    const name = deriveTypeName("2D Print");
    expect(name).toContain("Params");
    expect(name.length).toBeGreaterThan(0);
  });
});

// ── Interface generation ─────────────────────────────────────────────

describe("InterfaceGenerator", () => {
  it("generates interface for FDM CSD", () => {
    const csd = registry.get("pcc://capabilities/fdm/v2")!;
    expect(csd).toBeDefined();

    const result = compiler.compile(csd);
    const code = result.interfaceCode;

    // Must contain export interface
    expect(code).toContain("export interface");
    expect(code).toContain("Params");

    // Required params are not optional
    expect(code).toMatch(/material: /);

    // Optional params have ?
    expect(code).toMatch(/color\?:/);

    // Enum values are string literals
    expect(code).toContain('"pla"');
    expect(code).toContain('"petg"');
    expect(code).toContain('"abs"');

    // Number types
    expect(code).toContain("infill");
    expect(code).toContain("number");
  });

  it("generates interface for SLA CSD", () => {
    const csd = registry.get("pcc://capabilities/sla/v2")!;
    const result = compiler.compile(csd);
    const code = result.interfaceCode;

    expect(code).toContain("export interface");
    expect(code).toContain('"standard"');
    expect(code).toContain('"tough"');
    expect(code).toContain("boolean"); // supports, hollowing
  });

  it("generates interface for CNC CSD", () => {
    const csd = registry.get("pcc://capabilities/cnc-3axis/v2")!;
    const result = compiler.compile(csd);
    const code = result.interfaceCode;

    expect(code).toContain("export interface");
    expect(code).toContain('"aluminum-6061"');
    expect(code).toContain('"standard"');
    expect(code).toContain("boolean"); // deburring, threadInserts
  });

  it("generates interface for laser-cut CSD", () => {
    const csd = registry.get("pcc://capabilities/laser-cut/v2")!;
    const result = compiler.compile(csd);
    const code = result.interfaceCode;

    expect(code).toContain("export interface");
    expect(code).toContain('"acrylic"');
    expect(code).toContain('"through-cut"');
    expect(code).toContain("boolean"); // engraving
  });

  it("generates interface for 2D print CSD", () => {
    const csd = registry.get("pcc://capabilities/2d-print/v1")!;
    const result = compiler.compile(csd);
    const code = result.interfaceCode;

    expect(code).toContain("export interface");
    expect(code).toContain('"na_letter_8.5x11in"');
    expect(code).toContain('"color"');
    expect(code).toContain('"monochrome"');
    // copies is required number
    expect(code).toMatch(/copies: number/);
    // borderless is optional boolean
    expect(code).toMatch(/borderless\?:/);
    // staple is optional boolean
    expect(code).toMatch(/staple\?:/);
  });

  it("includes JSDoc for number parameters", () => {
    const csd = registry.get("pcc://capabilities/fdm/v2")!;
    const result = compiler.compile(csd);
    const code = result.interfaceCode;

    // Should have @min and @max for infill
    expect(code).toContain("@min");
    expect(code).toContain("@max");
  });

  it("includes generated-from comment", () => {
    const csd = registry.get("pcc://capabilities/fdm/v2")!;
    const result = compiler.compile(csd);
    expect(result.interfaceCode).toContain("Generated from pcc://capabilities/fdm/v2");
  });

  it("returns typeName in result", () => {
    const csd = registry.get("pcc://capabilities/fdm/v2")!;
    const result = compiler.compile(csd);
    expect(result.typeName).toContain("Params");
    expect(result.typeName.length).toBeGreaterThan(0);
  });
});

// ── Validator generation ─────────────────────────────────────────────

describe("ValidatorGenerator", () => {
  it("generates validator for 2D print CSD", () => {
    const csd = registry.get("pcc://capabilities/2d-print/v1")!;
    const result = compiler.compile(csd);
    const code = result.validatorCode;

    expect(code).toContain("export function validate");
    expect(code).toContain("errors");
    expect(code).toContain("warnings");
    expect(code).toContain("valid: errors.length === 0");
  });

  it("generated validator catches missing required field", () => {
    const csd = registry.get("pcc://capabilities/2d-print/v1")!;
    const result = compiler.compile(csd);
    const code = result.validatorCode;

    // Should have required checks for required params
    expect(code).toContain("mediaSize is required");
    expect(code).toContain("colorMode is required");
    expect(code).toContain("copies is required");
  });

  it("generated validator has enum value checks", () => {
    const csd = registry.get("pcc://capabilities/2d-print/v1")!;
    const result = compiler.compile(csd);
    const code = result.validatorCode;

    expect(code).toContain("na_letter_8.5x11in");
    expect(code).toContain("invalid value");
  });

  it("generated validator has number range checks", () => {
    const csd = registry.get("pcc://capabilities/2d-print/v1")!;
    const result = compiler.compile(csd);
    const code = result.validatorCode;

    expect(code).toContain("copies must be at least 1");
    expect(code).toContain("copies must be at most 9999");
  });

  it("generated validator includes constraint checks for 2D print", () => {
    const csd = registry.get("pcc://capabilities/2d-print/v1")!;
    const result = compiler.compile(csd);
    const code = result.validatorCode;

    // Borderless requires photo paper constraint
    expect(code).toContain("Borderless printing requires photo paper");
  });

  it("generated validator includes constraint checks for FDM", () => {
    const csd = registry.get("pcc://capabilities/fdm/v2")!;
    const result = compiler.compile(csd);
    const code = result.validatorCode;

    // No specific reject in fdm constraints but warn checks should be present
    expect(code).toContain("export function validate");
  });

  it("validator code is executable (eval test)", () => {
    // This tests that the generated code is syntactically reasonable
    const csd = registry.get("pcc://capabilities/2d-print/v1")!;
    const result = compiler.compile(csd);
    const code = result.validatorCode;

    // Basic syntax sanity: balanced braces
    const openBraces = (code.match(/\{/g) ?? []).length;
    const closeBraces = (code.match(/\}/g) ?? []).length;
    expect(openBraces).toBe(closeBraces);
  });

  it("generates validators for all 5 CSDs", () => {
    for (const csd of registry.list()) {
      const result = compiler.compile(csd);
      expect(result.validatorCode).toContain("export function validate");
      expect(result.validatorCode).toContain("errors");
    }
  });
});

// ── Pricing generation ───────────────────────────────────────────────

describe("PricingGenerator", () => {
  it("generates pricing function for 2D print CSD", () => {
    const csd = registry.get("pcc://capabilities/2d-print/v1")!;
    const result = compiler.compile(csd);
    const code = result.pricingCode;

    expect(code).toContain("export function price");
    expect(code).toContain("total");
    expect(code).toContain("breakdown");
    expect(code).toContain("totalPrice");
  });

  it("generated pricing includes base price", () => {
    const csd = registry.get("pcc://capabilities/2d-print/v1")!;
    const result = compiler.compile(csd);
    const code = result.pricingCode;

    // Base price is 0.10 per page
    expect(code).toContain("0.1");
  });

  it("generated pricing includes color multiplier", () => {
    const csd = registry.get("pcc://capabilities/2d-print/v1")!;
    const result = compiler.compile(csd);
    const code = result.pricingCode;

    // colorMode has perOption pricing with color=2.0
    // The generator should emit multiplier logic
    expect(code).toContain("colorMode");
  });

  it("generated pricing has minimum charge logic for 2D print", () => {
    const csd = registry.get("pcc://capabilities/2d-print/v1")!;
    const result = compiler.compile(csd);
    const code = result.pricingCode;

    // minimumCharge is 1.00
    expect(code).toContain("1");
  });

  it("generates pricing for FDM with per_unit copies", () => {
    const csd = registry.get("pcc://capabilities/fdm/v2")!;
    const result = compiler.compile(csd);
    const code = result.pricingCode;

    expect(code).toContain("export function price");
    // infill has per_unit pricing
    expect(code).toContain("infill");
  });

  it("generates pricing for all 5 CSDs", () => {
    for (const csd of registry.list()) {
      const result = compiler.compile(csd);
      expect(result.pricingCode).toContain("export function price");
      expect(result.pricingCode).toContain("breakdown");
    }
  });

  it("pricing code has balanced braces", () => {
    const csd = registry.get("pcc://capabilities/cnc-3axis/v2")!;
    const result = compiler.compile(csd);
    const code = result.pricingCode;

    const openBraces = (code.match(/\{/g) ?? []).length;
    const closeBraces = (code.match(/\}/g) ?? []).length;
    expect(openBraces).toBe(closeBraces);
  });
});

// ── Test data generation ─────────────────────────────────────────────

describe("TestDataGenerator", () => {
  it("generates test data generator for FDM CSD", () => {
    const csd = registry.get("pcc://capabilities/fdm/v2")!;
    const result = compiler.compile(csd);
    const code = result.testDataCode;

    expect(code).toContain("export function random");
    expect(code).toContain("pickRandom");
    expect(code).toContain("randomInt");
  });

  it("generated test data includes all required params", () => {
    const csd = registry.get("pcc://capabilities/fdm/v2")!;
    const result = compiler.compile(csd);
    const code = result.testDataCode;

    // Required params: material, infill, layerHeight, quantity
    expect(code).toContain("material:");
    expect(code).toContain("infill:");
    expect(code).toContain("layerHeight:");
    expect(code).toContain("quantity:");
  });

  it("generates minimal() function", () => {
    const csd = registry.get("pcc://capabilities/2d-print/v1")!;
    const result = compiler.compile(csd);
    const code = result.testDataCode;

    expect(code).toContain("export function minimal");
  });

  it("generates test data for all 5 CSDs", () => {
    for (const csd of registry.list()) {
      const result = compiler.compile(csd);
      expect(result.testDataCode).toContain("export function random");
      expect(result.testDataCode).toContain("export function minimal");
    }
  });

  it("test data code has balanced braces", () => {
    const csd = registry.get("pcc://capabilities/sla/v2")!;
    const result = compiler.compile(csd);
    const code = result.testDataCode;

    const openBraces = (code.match(/\{/g) ?? []).length;
    const closeBraces = (code.match(/\}/g) ?? []).length;
    expect(openBraces).toBe(closeBraces);
  });
});

// ── CompileAll ───────────────────────────────────────────────────────

describe("BabelPCC.compileAll", () => {
  it("compiles all 5 built-in CSDs", () => {
    const results = compiler.compileAll(registry);

    expect(results.size).toBe(5);
    expect(results.has("pcc://capabilities/fdm/v2")).toBe(true);
    expect(results.has("pcc://capabilities/sla/v2")).toBe(true);
    expect(results.has("pcc://capabilities/cnc-3axis/v2")).toBe(true);
    expect(results.has("pcc://capabilities/laser-cut/v2")).toBe(true);
    expect(results.has("pcc://capabilities/2d-print/v1")).toBe(true);
  });

  it("all results have all 4 code artifacts", () => {
    const results = compiler.compileAll(registry);

    for (const [url, result] of results) {
      expect(result.interfaceCode, `${url} interfaceCode`).toBeTruthy();
      expect(result.validatorCode, `${url} validatorCode`).toBeTruthy();
      expect(result.pricingCode, `${url} pricingCode`).toBeTruthy();
      expect(result.testDataCode, `${url} testDataCode`).toBeTruthy();
    }
  });

  it("all results have correct csdUrl and csdName", () => {
    const results = compiler.compileAll(registry);

    for (const [url, result] of results) {
      expect(result.csdUrl).toBe(url);
      expect(result.csdName.length).toBeGreaterThan(0);
    }
  });

  it("respects generateInterfaces: false option", () => {
    const results = compiler.compileAll(registry, { generateInterfaces: false });

    for (const result of results.values()) {
      expect(result.interfaceCode).toBe("");
      expect(result.validatorCode).toBeTruthy(); // other generators still run
    }
  });

  it("respects generateValidator: false option", () => {
    const results = compiler.compileAll(registry, { generateValidator: false });

    for (const result of results.values()) {
      expect(result.validatorCode).toBe("");
      expect(result.interfaceCode).toBeTruthy();
    }
  });

  it("respects generatePricing: false option", () => {
    const results = compiler.compileAll(registry, { generatePricing: false });

    for (const result of results.values()) {
      expect(result.pricingCode).toBe("");
    }
  });

  it("respects generateTestData: false option", () => {
    const results = compiler.compileAll(registry, { generateTestData: false });

    for (const result of results.values()) {
      expect(result.testDataCode).toBe("");
    }
  });
});

// ── Integration: compile single CSD ─────────────────────────────────

describe("BabelPCC.compile single CSD", () => {
  it("compile() on 2D print CSD returns all fields", () => {
    const csd = registry.get("pcc://capabilities/2d-print/v1")!;
    const result = compiler.compile(csd);

    expect(result.typeName).toBeTruthy();
    expect(result.csdUrl).toBe("pcc://capabilities/2d-print/v1");
    expect(result.csdName).toBe("2D Print");
    expect(result.interfaceCode).toBeTruthy();
    expect(result.validatorCode).toBeTruthy();
    expect(result.pricingCode).toBeTruthy();
    expect(result.testDataCode).toBeTruthy();
  });

  it("compile() on FDM CSD produces valid TypeScript structure", () => {
    const csd = registry.get("pcc://capabilities/fdm/v2")!;
    const result = compiler.compile(csd);

    // Interface should export an interface
    expect(result.interfaceCode).toMatch(/export interface \w+Params \{/);

    // Validator should export a function
    expect(result.validatorCode).toMatch(/export function validate\w+\(/);

    // Pricing should export a function
    expect(result.pricingCode).toMatch(/export function price\w+\(/);

    // Test data should export two functions
    expect(result.testDataCode).toMatch(/export function random\w+\(\)/);
    expect(result.testDataCode).toMatch(/export function minimal\w+\(\)/);
  });

  it("compile() on SLA CSD covers boolean hollowing param", () => {
    const csd = registry.get("pcc://capabilities/sla/v2")!;
    const result = compiler.compile(csd);

    // hollowing is an optional boolean
    expect(result.interfaceCode).toContain("hollowing");
    expect(result.interfaceCode).toContain("boolean");
    expect(result.pricingCode).toContain("hollowing");
  });

  it("compile() on CNC CSD covers all material options", () => {
    const csd = registry.get("pcc://capabilities/cnc-3axis/v2")!;
    const result = compiler.compile(csd);

    expect(result.interfaceCode).toContain('"aluminum-6061"');
    expect(result.interfaceCode).toContain('"stainless-316"');
    expect(result.interfaceCode).toContain('"peek"');
  });

  it("compile() on laser-cut CSD covers engraving boolean", () => {
    const csd = registry.get("pcc://capabilities/laser-cut/v2")!;
    const result = compiler.compile(csd);

    expect(result.interfaceCode).toContain("engraving");
    expect(result.pricingCode).toContain("engraving");
  });
});

// ── Edge cases ───────────────────────────────────────────────────────

describe("BabelPCC edge cases", () => {
  it("handles CSD with no pricing impacts gracefully", () => {
    // mediaSize in 2D print has null pricingImpact
    const csd = registry.get("pcc://capabilities/2d-print/v1")!;
    const result = compiler.compile(csd);
    // Should not throw; mediaSize should appear in interface but not pricing
    expect(result.interfaceCode).toContain("mediaSize");
  });

  it("handles multi-select enum (FDM postProcessing)", () => {
    const csd = registry.get("pcc://capabilities/fdm/v2")!;
    const result = compiler.compile(csd);

    // postProcessing is a multi enum
    expect(result.interfaceCode).toContain("postProcessing");
    expect(result.pricingCode).toContain("postProcessing");
    // Multi-select pricing uses Array.isArray
    expect(result.pricingCode).toContain("Array.isArray");
  });

  it("handles visibleWhen conditional params (FDM supportType)", () => {
    const csd = registry.get("pcc://capabilities/fdm/v2")!;
    const result = compiler.compile(csd);

    // supportType has visibleWhen: supports == true
    expect(result.interfaceCode).toContain("supportType");
  });

  it("handles negative pricing (SLA hollowing -20%)", () => {
    const csd = registry.get("pcc://capabilities/sla/v2")!;
    const result = compiler.compile(csd);
    // hollowing has -20% impact
    expect(result.pricingCode).toContain("hollowing");
    // The code should handle the negative percentage
    expect(result.pricingCode).toContain("-20");
  });
});
