/**
 * ValidatorGenerator — generates runtime validator functions from a CSD.
 *
 * The generated function validates parameter objects at runtime:
 *   - Required field checks
 *   - Enum value validation
 *   - Number range checks
 *   - Boolean type checks
 *   - Constraint condition checks (from CSD constraints with "reject" action)
 */

import type { CSD, CsdConstraint } from "@pcc/spec";
type CsdConstraintCondition = CsdConstraint["when"][number];
import { deriveTypeName } from "./interface-generator.js";

/**
 * Emit a constraint condition as a TypeScript expression.
 * Returns a JS expression string that evaluates to true when the condition is met.
 */
function emitConditionExpr(cond: CsdConstraintCondition): string {
  const paramRef = `params[${JSON.stringify(cond.param)}]`;

  switch (cond.operator) {
    case "equals":
      return `${paramRef} === ${JSON.stringify(cond.value)}`;

    case "notEquals":
      return `${paramRef} !== ${JSON.stringify(cond.value)}`;

    case "in": {
      const arr = Array.isArray(cond.value) ? cond.value : [cond.value];
      return `[${arr.map((v: unknown) => JSON.stringify(v)).join(", ")}].includes(${paramRef} as string | number)`;
    }

    case "notIn": {
      const arr = Array.isArray(cond.value) ? cond.value : [cond.value];
      return `![${arr.map((v: unknown) => JSON.stringify(v)).join(", ")}].includes(${paramRef} as string | number)`;
    }

    case "gt":
      return `(${paramRef} as number) > ${JSON.stringify(cond.value)}`;

    case "lt":
      return `(${paramRef} as number) < ${JSON.stringify(cond.value)}`;

    case "gte":
      return `(${paramRef} as number) >= ${JSON.stringify(cond.value)}`;

    case "lte":
      return `(${paramRef} as number) <= ${JSON.stringify(cond.value)}`;

    default:
      return "false";
  }
}

/**
 * Emit constraint check code for constraints that have "reject" actions.
 * Constraints with "warn" actions generate warnings.
 */
function emitConstraintChecks(constraints: CsdConstraint[]): string[] {
  const lines: string[] = [];

  for (const constraint of constraints) {
    const rejectActions = constraint.then.filter((a) => a.action === "reject");
    const warnActions = constraint.then.filter((a) => a.action === "warn");

    if (rejectActions.length === 0 && warnActions.length === 0) continue;

    // Build condition: ALL when[] conditions must be true (AND semantics)
    // We need to guard each condition: if the param is undefined, the constraint doesn't fire
    const conditionParts = constraint.when.map((cond) => {
      const guard = `params[${JSON.stringify(cond.param)}] !== undefined`;
      const expr = emitConditionExpr(cond);
      return `(${guard} && ${expr})`;
    });

    const fullCondition = conditionParts.join(" && ");

    lines.push(`  // ${constraint.key}: ${constraint.human}`);
    lines.push(`  if (${fullCondition}) {`);

    for (const action of rejectActions) {
      const msg = action.message ?? constraint.human;
      lines.push(`    errors.push(${JSON.stringify(msg)});`);
    }

    for (const action of warnActions) {
      const msg = action.message ?? constraint.human;
      lines.push(`    warnings.push(${JSON.stringify(msg)});`);
    }

    lines.push(`  }`);
    lines.push(``);
  }

  return lines;
}

/**
 * Generate a runtime validator function from a CSD.
 */
export function generateValidator(csd: CSD): string {
  const typeName = deriveTypeName(csd.name);
  const fnName = `validate${typeName.replace(/Params$/, "")}`;

  const lines: string[] = [];

  lines.push(`// Generated from ${csd.url}`);
  lines.push(`// CSD: ${csd.name} v${csd.version}`);
  lines.push(`// DO NOT EDIT — re-run BabelPCC compiler to regenerate`);
  lines.push(``);
  lines.push(`import type { ${typeName} } from "./${typeName.toLowerCase().replace(/params$/, "")}.js";`);
  lines.push(``);
  lines.push(`export interface ValidationResult {`);
  lines.push(`  valid: boolean;`);
  lines.push(`  errors: string[];`);
  lines.push(`  warnings: string[];`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`/**`);
  lines.push(` * Validate ${csd.name} parameters.`);
  lines.push(` *`);
  lines.push(` * Checks required fields, enum values, numeric ranges,`);
  lines.push(` * and CSD constraint rules.`);
  lines.push(` *`);
  lines.push(` * @generated BabelPCC from ${csd.url}`);
  lines.push(` */`);
  lines.push(`export function ${fnName}(params: Partial<${typeName}>): ValidationResult {`);
  lines.push(`  const errors: string[] = [];`);
  lines.push(`  const warnings: string[] = [];`);
  lines.push(``);

  for (const param of csd.parameters) {
    const key = JSON.stringify(param.key);

    lines.push(`  // ${param.label} (${param.key})`);

    if (param.required) {
      lines.push(`  if (params[${key}] === undefined || params[${key}] === null) {`);
      lines.push(`    errors.push(${JSON.stringify(`${param.key} is required`)});`);
      lines.push(`  } else {`);
    } else {
      lines.push(`  if (params[${key}] !== undefined && params[${key}] !== null) {`);
    }

    // Type-specific validation inside the if block
    switch (param.type) {
      case "enum": {
        const validValues = param.options.map((o) => o.value);
        lines.push(`    const validValues_${param.key} = ${JSON.stringify(validValues)};`);
        lines.push(`    if (!validValues_${param.key}.includes(params[${key}] as string)) {`);
        lines.push(`      errors.push(\`${param.key}: invalid value "\${params[${key}]}"\`);`);
        lines.push(`    }`);
        break;
      }

      case "number": {
        lines.push(`    const numVal_${param.key} = params[${key}] as number;`);
        lines.push(`    if (typeof numVal_${param.key} !== "number" || isNaN(numVal_${param.key})) {`);
        lines.push(`      errors.push(${JSON.stringify(`${param.key} must be a number`)});`);
        lines.push(`    } else {`);
        lines.push(`      if (numVal_${param.key} < ${param.min}) {`);
        lines.push(`        errors.push(${JSON.stringify(`${param.key} must be at least ${param.min}`)});`);
        lines.push(`      }`);
        lines.push(`      if (numVal_${param.key} > ${param.max}) {`);
        lines.push(`        errors.push(${JSON.stringify(`${param.key} must be at most ${param.max}`)});`);
        lines.push(`      }`);
        lines.push(`    }`);
        break;
      }

      case "boolean": {
        lines.push(`    if (typeof params[${key}] !== "boolean") {`);
        lines.push(`      errors.push(${JSON.stringify(`${param.key} must be a boolean`)});`);
        lines.push(`    }`);
        break;
      }

      case "string": {
        lines.push(`    if (typeof params[${key}] !== "string") {`);
        lines.push(`      errors.push(${JSON.stringify(`${param.key} must be a string`)});`);
        lines.push(`    }`);
        if (param.maxLength !== undefined) {
          lines.push(`    if ((params[${key}] as string).length > ${param.maxLength}) {`);
          lines.push(`      errors.push(${JSON.stringify(`${param.key} must be at most ${param.maxLength} characters`)});`);
          lines.push(`    }`);
        }
        break;
      }
    }

    lines.push(`  }`);
    lines.push(``);
  }

  // Emit constraint checks
  const constraintLines = emitConstraintChecks(csd.constraints);
  if (constraintLines.length > 0) {
    lines.push(`  // Constraint checks`);
    lines.push(...constraintLines);
  }

  lines.push(`  return { valid: errors.length === 0, errors, warnings };`);
  lines.push(`}`);
  lines.push(``);

  return lines.join("\n");
}

export class ValidatorGenerator {
  generate(csd: CSD): string {
    return generateValidator(csd);
  }
}
