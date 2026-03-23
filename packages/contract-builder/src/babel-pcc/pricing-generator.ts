/**
 * PricingGenerator — generates pricing calculator functions from a CSD.
 *
 * Supports all CSD pricing impact modes:
 *   - flat:       add a fixed amount
 *   - percent:    add a percentage of base price
 *   - per_unit:   multiply a unit cost by the numeric value
 *   - multiplier: multiply running total by a factor (perOption only, or by a fixed factor)
 *
 * Generated calculator:
 *   - Starts with the CSD base price
 *   - Applies parameter-level pricing impacts in order
 *   - Returns { totalPrice, breakdown }
 */

import type { CSD, CsdPricingImpact } from "@pcc/spec";
import { deriveTypeName } from "./interface-generator.js";

/**
 * Emit pricing impact computation code for a given mode and impact descriptor.
 * Returns lines of code that update `total` and push to `breakdown`.
 */
function emitPricingImpactCode(
  paramKey: string,
  paramLabel: string,
  impact: CsdPricingImpact,
  selectedValueExpr: string,
  lines: string[],
): void {
  if (impact.perOption) {
    // perOption map: look up by current value
    lines.push(`  {`);
    lines.push(`    const perOption: Record<string, number> = ${JSON.stringify(impact.perOption)};`);
    lines.push(`    const optVal = perOption[String(${selectedValueExpr})];`);
    lines.push(`    if (optVal !== undefined) {`);

    switch (impact.mode) {
      case "flat":
        lines.push(`      total += optVal;`);
        lines.push(`      breakdown.push({ param: ${JSON.stringify(paramKey)}, impact: \`+\${optVal.toFixed(2)}\` });`);
        break;
      case "percent":
        lines.push(`      const pct_${paramKey.replace(/-/g, "_")} = base * (optVal / 100);`);
        lines.push(`      total += pct_${paramKey.replace(/-/g, "_")};`);
        lines.push(`      breakdown.push({ param: ${JSON.stringify(paramKey)}, impact: \`+\${optVal}%\` });`);
        break;
      case "multiplier":
        lines.push(`      total *= optVal;`);
        lines.push(`      breakdown.push({ param: ${JSON.stringify(paramKey)}, impact: \`x\${optVal}\` });`);
        break;
      case "per_unit":
        lines.push(`      total += optVal;`);
        lines.push(`      breakdown.push({ param: ${JSON.stringify(paramKey)}, impact: \`+\${optVal.toFixed(2)}\` });`);
        break;
      default:
        lines.push(`      total += optVal;`);
    }

    lines.push(`    }`);
    lines.push(`  }`);
    return;
  }

  // Direct value
  const val = typeof impact.value === "number"
    ? impact.value
    : impact.value !== undefined
      ? parseFloat(String(impact.value))
      : 0;

  switch (impact.mode) {
    case "flat":
      lines.push(`  total += ${val};`);
      lines.push(`  breakdown.push({ param: ${JSON.stringify(paramKey)}, impact: ${JSON.stringify(`+${val.toFixed(2)}`)} });`);
      break;
    case "percent": {
      const labelStr = val >= 0 ? `+${val}%` : `${val}%`;
      lines.push(`  total += base * (${val} / 100);`);
      lines.push(`  breakdown.push({ param: ${JSON.stringify(paramKey)}, impact: ${JSON.stringify(labelStr)} });`);
      break;
    }
    case "per_unit":
      lines.push(`  if (typeof params[${JSON.stringify(paramKey)}] === "number") {`);
      lines.push(`    total += ${val} * (params[${JSON.stringify(paramKey)}] as number);`);
      lines.push(`    breakdown.push({ param: ${JSON.stringify(paramKey)}, impact: \`x\${params[${JSON.stringify(paramKey)}]}\` });`);
      lines.push(`  }`);
      break;
    case "multiplier":
      lines.push(`  total *= ${val};`);
      lines.push(`  breakdown.push({ param: ${JSON.stringify(paramKey)}, impact: ${JSON.stringify(`x${val}`)} });`);
      break;
  }
}

/**
 * Generate a pricing calculator function from a CSD.
 */
export function generatePricing(csd: CSD): string {
  const typeName = deriveTypeName(csd.name);
  const fnName = `price${typeName.replace(/Params$/, "")}`;
  const basePrice = parseFloat(csd.pricing.basePrice);

  const lines: string[] = [];

  lines.push(`// Generated from ${csd.url}`);
  lines.push(`// CSD: ${csd.name} v${csd.version}`);
  lines.push(`// DO NOT EDIT — re-run BabelPCC compiler to regenerate`);
  lines.push(``);
  lines.push(`import type { ${typeName} } from "./${typeName.toLowerCase().replace(/params$/, "")}.js";`);
  lines.push(``);
  lines.push(`export interface PricingBreakdownItem {`);
  lines.push(`  param: string;`);
  lines.push(`  impact: string;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`export interface PricingResult {`);
  lines.push(`  totalPrice: string;`);
  lines.push(`  breakdown: PricingBreakdownItem[];`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`/**`);
  lines.push(` * Calculate price for ${csd.name} parameters.`);
  lines.push(` *`);
  lines.push(` * Base price: ${csd.pricing.currency} ${csd.pricing.basePrice}${csd.pricing.unit ? ` ${csd.pricing.unit}` : ""}`);
  if (csd.pricing.minimumCharge) {
    lines.push(` * Minimum charge: ${csd.pricing.currency} ${csd.pricing.minimumCharge}`);
  }
  lines.push(` *`);
  lines.push(` * @generated BabelPCC from ${csd.url}`);
  lines.push(` */`);
  lines.push(`export function ${fnName}(params: Partial<${typeName}>): PricingResult {`);
  lines.push(`  const base = ${basePrice};`);
  lines.push(`  let total = base;`);
  lines.push(`  const breakdown: PricingBreakdownItem[] = [];`);
  lines.push(``);

  for (const param of csd.parameters) {
    if (param.type === "enum") {
      // Option-level pricing impact
      const optionsWithImpact = param.options.filter((o) => o.pricingImpact);

      // Also check param-level pricingImpact with perOption
      const hasParamLevelImpact = param.pricingImpact != null;

      if (!hasParamLevelImpact && optionsWithImpact.length === 0) continue;

      lines.push(`  // ${param.label} (${param.key})`);

      if (hasParamLevelImpact && param.pricingImpact) {
        lines.push(`  if (params[${JSON.stringify(param.key)}] !== undefined) {`);
        const innerLines: string[] = [];
        emitPricingImpactCode(param.key, param.label, param.pricingImpact, `params[${JSON.stringify(param.key)}]`, innerLines);
        lines.push(...innerLines.map((l) => `  ${l}`));
        lines.push(`  }`);
      } else if (optionsWithImpact.length > 0 && !param.multi) {
        // Build a switch on the selected value
        lines.push(`  switch (params[${JSON.stringify(param.key)}]) {`);
        for (const opt of param.options) {
          if (!opt.pricingImpact) continue;
          lines.push(`    case ${JSON.stringify(opt.value)}: {`);
          const impact = opt.pricingImpact;
          const val = typeof impact.value === "number" ? impact.value : parseFloat(String(impact.value ?? "0"));
          switch (impact.mode) {
            case "flat":
              lines.push(`      total += ${val};`);
              lines.push(`      breakdown.push({ param: ${JSON.stringify(param.key)}, impact: ${JSON.stringify(`+${val.toFixed(2)}`)} });`);
              break;
            case "percent": {
              const labelStr = val >= 0 ? `+${val}%` : `${val}%`;
              lines.push(`      total += base * (${val} / 100);`);
              lines.push(`      breakdown.push({ param: ${JSON.stringify(param.key)}, impact: ${JSON.stringify(labelStr)} });`);
              break;
            }
            case "multiplier":
              lines.push(`      total *= ${val};`);
              lines.push(`      breakdown.push({ param: ${JSON.stringify(param.key)}, impact: ${JSON.stringify(`x${val}`)} });`);
              break;
            case "per_unit":
              lines.push(`      total += ${val};`);
              lines.push(`      breakdown.push({ param: ${JSON.stringify(param.key)}, impact: ${JSON.stringify(`+${val.toFixed(2)}`)} });`);
              break;
          }
          lines.push(`      break;`);
          lines.push(`    }`);
        }
        lines.push(`  }`);
      } else if (param.multi) {
        // Multi-select enum: iterate array
        lines.push(`  if (Array.isArray(params[${JSON.stringify(param.key)}])) {`);
        lines.push(`    for (const v of params[${JSON.stringify(param.key)}] as string[]) {`);
        lines.push(`      switch (v) {`);
        for (const opt of param.options) {
          if (!opt.pricingImpact) continue;
          const impact = opt.pricingImpact;
          const val = typeof impact.value === "number" ? impact.value : parseFloat(String(impact.value ?? "0"));
          lines.push(`        case ${JSON.stringify(opt.value)}: {`);
          switch (impact.mode) {
            case "flat":
              lines.push(`          total += ${val};`);
              lines.push(`          breakdown.push({ param: ${JSON.stringify(param.key)}, impact: ${JSON.stringify(`+${val.toFixed(2)}`)} });`);
              break;
            case "percent":
              lines.push(`          total += base * (${val} / 100);`);
              lines.push(`          breakdown.push({ param: ${JSON.stringify(param.key)}, impact: \`+${val}%\` });`);
              break;
            case "multiplier":
              lines.push(`          total *= ${val};`);
              lines.push(`          breakdown.push({ param: ${JSON.stringify(param.key)}, impact: \`x${val}\` });`);
              break;
            case "per_unit":
              lines.push(`          total += ${val};`);
              lines.push(`          breakdown.push({ param: ${JSON.stringify(param.key)}, impact: ${JSON.stringify(`+${val.toFixed(2)}`)} });`);
              break;
          }
          lines.push(`          break;`);
          lines.push(`        }`);
        }
        lines.push(`      }`);
        lines.push(`    }`);
        lines.push(`  }`);
      }
      lines.push(``);
    } else if (param.type === "number" && param.pricingImpact) {
      lines.push(`  // ${param.label} (${param.key})`);
      const impact = param.pricingImpact;
      const val = typeof impact.value === "number" ? impact.value : parseFloat(String(impact.value ?? "0"));
      switch (impact.mode) {
        case "per_unit":
          lines.push(`  if (typeof params[${JSON.stringify(param.key)}] === "number") {`);
          lines.push(`    total += ${val} * (params[${JSON.stringify(param.key)}] as number);`);
          lines.push(`    breakdown.push({ param: ${JSON.stringify(param.key)}, impact: \`x\${params[${JSON.stringify(param.key)}]}\` });`);
          lines.push(`  }`);
          break;
        case "flat":
          lines.push(`  total += ${val};`);
          lines.push(`  breakdown.push({ param: ${JSON.stringify(param.key)}, impact: ${JSON.stringify(`+${val.toFixed(2)}`)} });`);
          break;
        case "percent": {
          const labelStr = val >= 0 ? `+${val}%` : `${val}%`;
          lines.push(`  if (typeof params[${JSON.stringify(param.key)}] === "number") {`);
          lines.push(`    total += base * (${val} / 100);`);
          lines.push(`    breakdown.push({ param: ${JSON.stringify(param.key)}, impact: ${JSON.stringify(labelStr)} });`);
          lines.push(`  }`);
          break;
        }
        case "multiplier":
          lines.push(`  if (typeof params[${JSON.stringify(param.key)}] === "number") {`);
          lines.push(`    total *= ${val};`);
          lines.push(`    breakdown.push({ param: ${JSON.stringify(param.key)}, impact: ${JSON.stringify(`x${val}`)} });`);
          lines.push(`  }`);
          break;
      }
      lines.push(``);
    } else if (param.type === "boolean" && param.pricingImpact) {
      lines.push(`  // ${param.label} (${param.key})`);
      const impact = param.pricingImpact;
      const val = typeof impact.value === "number" ? impact.value : parseFloat(String(impact.value ?? "0"));
      lines.push(`  if (params[${JSON.stringify(param.key)}] === true) {`);
      switch (impact.mode) {
        case "flat":
          lines.push(`    total += ${val};`);
          lines.push(`    breakdown.push({ param: ${JSON.stringify(param.key)}, impact: ${JSON.stringify(`+${val.toFixed(2)}`)} });`);
          break;
        case "percent": {
          const labelStr = val >= 0 ? `+${val}%` : `${val}%`;
          lines.push(`    total += base * (${val} / 100);`);
          lines.push(`    breakdown.push({ param: ${JSON.stringify(param.key)}, impact: ${JSON.stringify(labelStr)} });`);
          break;
        }
        case "multiplier":
          lines.push(`    total *= ${val};`);
          lines.push(`    breakdown.push({ param: ${JSON.stringify(param.key)}, impact: ${JSON.stringify(`x${val}`)} });`);
          break;
        case "per_unit":
          lines.push(`    total += ${val};`);
          lines.push(`    breakdown.push({ param: ${JSON.stringify(param.key)}, impact: ${JSON.stringify(`+${val.toFixed(2)}`)} });`);
          break;
      }
      lines.push(`  }`);
      lines.push(``);
    }
  }

  // Apply minimum charge
  if (csd.pricing.minimumCharge) {
    const minCharge = parseFloat(csd.pricing.minimumCharge);
    lines.push(`  // Apply minimum charge`);
    lines.push(`  if (total < ${minCharge}) total = ${minCharge};`);
    lines.push(``);
  }

  lines.push(`  return { totalPrice: total.toFixed(2), breakdown };`);
  lines.push(`}`);
  lines.push(``);

  return lines.join("\n");
}

export class PricingGenerator {
  generate(csd: CSD): string {
    return generatePricing(csd);
  }
}
