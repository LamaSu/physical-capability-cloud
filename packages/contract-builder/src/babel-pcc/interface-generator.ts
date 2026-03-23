/**
 * InterfaceGenerator — generates TypeScript interface code from a CSD.
 *
 * Rules:
 *   - enum params → string literal unions
 *   - number params → `number` with JSDoc showing min/max/step
 *   - boolean params → `boolean`
 *   - string params → `string`
 *   - required params → not optional; optional params → `?`
 *   - type name derived from CSD name
 *   - JSDoc comments include labels and descriptions
 */

import type { CSD, CsdParameter } from "@pcc/spec";

/**
 * Derive a PascalCase TypeScript type name from a CSD name.
 * Examples:
 *   "2D Print"        → "Print2DParams"
 *   "FDM 3D Printing" → "FdmParams"
 *   "SLA Resin Printing" → "SlaParams"
 *   "CNC 3-Axis Milling" → "Cnc3AxisParams"
 *   "Laser Cutting"   → "LaserCutParams"
 */
export function deriveTypeName(csdName: string): string {
  // Remove non-alphanumeric chars (keep spaces and hyphens), split into words
  const words = csdName
    .replace(/[^\w\s-]/g, " ")
    .split(/[\s\-_]+/)
    .filter(Boolean);

  const pascalWords = words.map((word) => {
    // If the word is all digits, keep it as-is
    if (/^\d+$/.test(word)) return word;
    // If the word is all uppercase and short (like "FDM", "SLA", "CNC"), keep it capitalized
    if (/^[A-Z]+$/.test(word) && word.length <= 5) return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    // Otherwise, capitalize first char
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });

  // Filter out generic suffixes
  const genericSuffixes = new Set(["3d", "3D", "2d", "2D", "Printing", "Milling", "Cutting", "Resin"]);
  const filtered = pascalWords.filter((w) => !genericSuffixes.has(w));

  // Use filtered or fallback to full pascal words
  const base = (filtered.length > 0 ? filtered : pascalWords).join("");

  return `${base}Params`;
}

/**
 * Generate JSDoc for a parameter.
 */
function paramJsDoc(param: CsdParameter): string {
  const lines: string[] = [];

  if ("description" in param && param.description) {
    lines.push(` * ${param.description}`);
  }

  if (param.type === "number") {
    lines.push(` * @min ${param.min} @max ${param.max} @step ${param.step}${param.unit ? ` ${param.unit}` : ""}`);
  }

  if (param.type === "enum" && param.options.length > 0) {
    const optLabels = param.options.map((o) => `${o.value}: ${o.label}`).join(", ");
    lines.push(` * Options: ${optLabels}`);
  }

  if (lines.length === 0) return "";

  return `  /**\n   * ${param.label}\n${lines.map((l) => `  ${l}`).join("\n")}\n   */\n`;
}

/**
 * Generate the TypeScript type for a single parameter's value.
 */
function paramTypeSignature(param: CsdParameter): string {
  switch (param.type) {
    case "enum": {
      const values = param.options.map((o) => JSON.stringify(o.value)).join(" | ");
      return values || "string";
    }
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "string":
      return "string";
    default:
      return "unknown";
  }
}

/**
 * Generate a TypeScript interface from a CSD.
 *
 * @param csd - The CSD to generate from
 * @returns TypeScript interface code as a string
 */
export function generateInterface(csd: CSD): string {
  const typeName = deriveTypeName(csd.name);
  const lines: string[] = [];

  lines.push(`// Generated from ${csd.url}`);
  lines.push(`// CSD: ${csd.name} v${csd.version}`);
  lines.push(`// DO NOT EDIT — re-run BabelPCC compiler to regenerate`);
  lines.push(``);

  lines.push(`/**`);
  lines.push(` * ${csd.name}`);
  lines.push(` *`);
  lines.push(` * ${csd.description}`);
  lines.push(` *`);
  lines.push(` * @generated BabelPCC from ${csd.url}`);
  lines.push(` */`);
  lines.push(`export interface ${typeName} {`);

  for (const param of csd.parameters) {
    const doc = paramJsDoc(param);
    if (doc) {
      lines.push(doc.trimEnd());
    }

    const optional = !param.required ? "?" : "";
    const typeSig = paramTypeSignature(param);
    lines.push(`  ${param.key}${optional}: ${typeSig};`);
  }

  lines.push(`}`);
  lines.push(``);

  return lines.join("\n");
}

export class InterfaceGenerator {
  generate(csd: CSD): string {
    return generateInterface(csd);
  }

  deriveTypeName(csdName: string): string {
    return deriveTypeName(csdName);
  }
}
