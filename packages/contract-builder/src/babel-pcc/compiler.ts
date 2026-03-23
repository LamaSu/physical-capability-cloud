/**
 * BabelPCC — main compiler entry point.
 *
 * Compiles CSD (Capability StructureDefinition) documents to TypeScript code:
 *   - TypeScript interfaces for job parameters
 *   - Runtime validators with constraint checking
 *   - Pricing calculators from CSD pricing rules
 *   - Test data generators (random valid parameter sets)
 *
 * Inspired by BabelFHIR-TS which compiles FHIR StructureDefinitions to TypeScript.
 */

import type { CSD } from "@pcc/spec";
import type { CsdRegistry } from "@pcc/spec";
import { generateInterface, deriveTypeName } from "./interface-generator.js";
import { generateValidator } from "./validator-generator.js";
import { generatePricing } from "./pricing-generator.js";
import { generateTestData } from "./test-data-generator.js";

// ── Public types ──────────────────────────────────────────────────────

export interface CompileOptions {
  /** Directory to write generated files (optional) */
  outputDir?: string;
  /** Generate TypeScript interfaces (default: true) */
  generateInterfaces?: boolean;
  /** Generate runtime validator function (default: true) */
  generateValidator?: boolean;
  /** Generate pricing calculator function (default: true) */
  generatePricing?: boolean;
  /** Generate random test data generator function (default: true) */
  generateTestData?: boolean;
}

export interface CompileResult {
  /** TypeScript interfaces code */
  interfaceCode: string;
  /** Runtime validation function code */
  validatorCode: string;
  /** Pricing calculator function code */
  pricingCode: string;
  /** Random test data generator code */
  testDataCode: string;
  /** Derived TypeScript type name (e.g., "FdmParams", "Print2DParams") */
  typeName: string;
  /** The source CSD URL */
  csdUrl: string;
  /** The source CSD name */
  csdName: string;
}

// ── Compiler ──────────────────────────────────────────────────────────

export class BabelPCC {
  /**
   * Compile a single CSD to TypeScript code artifacts.
   *
   * @param csd - The CSD to compile
   * @param options - Compile options (all generators enabled by default)
   * @returns CompileResult with all generated code strings
   */
  compile(csd: CSD, options?: CompileOptions): CompileResult {
    const opts = {
      generateInterfaces: true,
      generateValidator: true,
      generatePricing: true,
      generateTestData: true,
      ...options,
    };

    const typeName = deriveTypeName(csd.name);

    const interfaceCode = opts.generateInterfaces ? generateInterface(csd) : "";
    const validatorCode = opts.generateValidator ? generateValidator(csd) : "";
    const pricingCode = opts.generatePricing ? generatePricing(csd) : "";
    const testDataCode = opts.generateTestData ? generateTestData(csd) : "";

    return {
      interfaceCode,
      validatorCode,
      pricingCode,
      testDataCode,
      typeName,
      csdUrl: csd.url,
      csdName: csd.name,
    };
  }

  /**
   * Compile all CSDs in a registry.
   *
   * @param registry - A CsdRegistry with registered CSDs
   * @param options - Compile options applied to all CSDs
   * @returns Map from CSD URL to CompileResult
   */
  compileAll(registry: CsdRegistry, options?: CompileOptions): Map<string, CompileResult> {
    const results = new Map<string, CompileResult>();

    for (const csd of registry.list()) {
      const result = this.compile(csd, options);
      results.set(csd.url, result);
    }

    return results;
  }

  /**
   * Write compiled output to disk.
   * Creates files: <typeName>.ts, <typeName>.validator.ts, <typeName>.pricing.ts, <typeName>.test.ts
   *
   * @param result - The CompileResult to write
   * @param outputDir - Directory to write files to
   * @returns Array of file paths written
   */
  async writeOutput(result: CompileResult, outputDir: string): Promise<string[]> {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");

    await mkdir(outputDir, { recursive: true });

    const baseName = result.typeName.toLowerCase().replace(/params$/, "");
    const written: string[] = [];

    if (result.interfaceCode) {
      const path = join(outputDir, `${baseName}.ts`);
      await writeFile(path, result.interfaceCode, "utf-8");
      written.push(path);
    }

    if (result.validatorCode) {
      const path = join(outputDir, `${baseName}.validator.ts`);
      await writeFile(path, result.validatorCode, "utf-8");
      written.push(path);
    }

    if (result.pricingCode) {
      const path = join(outputDir, `${baseName}.pricing.ts`);
      await writeFile(path, result.pricingCode, "utf-8");
      written.push(path);
    }

    if (result.testDataCode) {
      const path = join(outputDir, `${baseName}.test.ts`);
      await writeFile(path, result.testDataCode, "utf-8");
      written.push(path);
    }

    return written;
  }
}
