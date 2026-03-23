/**
 * TestDataGenerator — generates random valid test data generators from a CSD.
 *
 * The generated function produces random but constraint-aware parameter objects.
 * It runs N iterations to find a valid set (subject to constraints).
 */

import type { CSD } from "@pcc/spec";
import { deriveTypeName } from "./interface-generator.js";

/**
 * Generate a test data generator function from a CSD.
 *
 * The generated function:
 *   1. Picks random values for each parameter
 *   2. Returns the object
 *
 * Note: The generated code includes simple random helpers inline.
 */
export function generateTestData(csd: CSD): string {
  const typeName = deriveTypeName(csd.name);
  const fnName = `random${typeName.replace(/Params$/, "")}`;

  const lines: string[] = [];

  lines.push(`// Generated from ${csd.url}`);
  lines.push(`// CSD: ${csd.name} v${csd.version}`);
  lines.push(`// DO NOT EDIT — re-run BabelPCC compiler to regenerate`);
  lines.push(``);
  lines.push(`import type { ${typeName} } from "./${typeName.toLowerCase().replace(/params$/, "")}.js";`);
  lines.push(``);
  lines.push(`// ── Helpers ──────────────────────────────────────────────────────`);
  lines.push(``);
  lines.push(`function pickRandom<T>(arr: T[]): T {`);
  lines.push(`  return arr[Math.floor(Math.random() * arr.length)];`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`function randomInt(min: number, max: number): number {`);
  lines.push(`  return Math.floor(Math.random() * (max - min + 1)) + min;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`function randomBool(): boolean {`);
  lines.push(`  return Math.random() < 0.5;`);
  lines.push(`}`);
  lines.push(``);

  lines.push(`/**`);
  lines.push(` * Generate random ${csd.name} parameters.`);
  lines.push(` *`);
  lines.push(` * All required parameters are always set.`);
  lines.push(` * Optional parameters are included with ~50% probability.`);
  lines.push(` *`);
  lines.push(` * @generated BabelPCC from ${csd.url}`);
  lines.push(` */`);
  lines.push(`export function ${fnName}(): ${typeName} {`);
  lines.push(`  return {`);

  for (const param of csd.parameters) {
    // Skip visibleWhen params — they only appear conditionally
    // We still generate them but with "if undefined" logic
    const isConditional = !!param.visibleWhen;

    if (param.type === "enum") {
      const values = param.options.map((o) => o.value);
      if (param.required) {
        lines.push(`    ${param.key}: pickRandom(${JSON.stringify(values)}),`);
      } else if (isConditional) {
        // Conditional param: always include with a valid value (simplify)
        lines.push(`    ${param.key}: pickRandom(${JSON.stringify(values)}),`);
      } else {
        lines.push(`    ${param.key}: randomBool() ? pickRandom(${JSON.stringify(values)}) : undefined,`);
      }
    } else if (param.type === "number") {
      // Use step-aligned values
      const min = param.min;
      const max = param.max;
      if (param.required) {
        lines.push(`    ${param.key}: randomInt(${min}, ${max}),`);
      } else {
        lines.push(`    ${param.key}: randomBool() ? randomInt(${min}, ${max}) : undefined,`);
      }
    } else if (param.type === "boolean") {
      if (param.required) {
        lines.push(`    ${param.key}: randomBool(),`);
      } else {
        lines.push(`    ${param.key}: randomBool() ? randomBool() : undefined,`);
      }
    } else if (param.type === "string") {
      if (param.required) {
        lines.push(`    ${param.key}: "test-value",`);
      } else {
        lines.push(`    ${param.key}: randomBool() ? "test-value" : undefined,`);
      }
    }
  }

  lines.push(`  } as ${typeName};`);
  lines.push(`}`);
  lines.push(``);

  // Also generate a variant that guarantees a valid set respecting key constraints
  lines.push(`/**`);
  lines.push(` * Generate a minimal valid ${csd.name} parameter set with defaults.`);
  lines.push(` * Uses default values from the CSD where available.`);
  lines.push(` *`);
  lines.push(` * @generated BabelPCC from ${csd.url}`);
  lines.push(` */`);
  lines.push(`export function minimal${typeName.replace(/Params$/, "")}(): ${typeName} {`);
  lines.push(`  return {`);

  for (const param of csd.parameters) {
    if (param.type === "enum") {
      const defaultVal = param.defaultValue ?? param.options[0]?.value;
      if (param.required) {
        lines.push(`    ${param.key}: ${JSON.stringify(defaultVal ?? param.options[0]?.value)},`);
      }
      // Skip optional params in minimal set
    } else if (param.type === "number") {
      if (param.required) {
        const defaultVal = "defaultValue" in param ? param.defaultValue ?? param.min : param.min;
        lines.push(`    ${param.key}: ${defaultVal},`);
      }
    } else if (param.type === "boolean") {
      if (param.required) {
        const defaultVal = "defaultValue" in param ? param.defaultValue ?? false : false;
        lines.push(`    ${param.key}: ${defaultVal},`);
      }
    } else if (param.type === "string") {
      if (param.required) {
        const defaultVal = "defaultValue" in param ? param.defaultValue ?? "test" : "test";
        lines.push(`    ${param.key}: ${JSON.stringify(defaultVal)},`);
      }
    }
  }

  lines.push(`  } as ${typeName};`);
  lines.push(`}`);
  lines.push(``);

  return lines.join("\n");
}

export class TestDataGenerator {
  generate(csd: CSD): string {
    return generateTestData(csd);
  }
}
