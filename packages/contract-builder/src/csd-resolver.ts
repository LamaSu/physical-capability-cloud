/**
 * CsdResolver — resolves CSD JSON documents into actionable view models.
 *
 * This is the CSD-native counterpart to TemplateResolver.
 * It works with CSD objects (from the registry) rather than TypeScript templates.
 *
 * Responsibilities:
 *   1. Load a CSD from the registry (resolving baseDefinition inheritance)
 *   2. Apply CSD constraints to compute paramRestrictions
 *   3. Compute pricing from CSD pricing + parameter pricingImpact
 *   4. Validate selections against parameter definitions
 */

import type { CSD, CsdParameter } from "@pcc/spec";
import { CsdRegistry } from "@pcc/spec";
import { CsdConstraintEvaluator, type EvaluationResult, type ParamRestriction } from "./csd-evaluator.js";
import { CsdInvariantEvaluator } from "./csd-invariant-evaluator.js";

// ── Output types ───────────────────────────────────────────────────

/** A fully resolved CSD with constraints applied for the current selections */
export interface ResolvedCsd {
  /** The resolved (inheritance-merged) CSD */
  csd: CSD;
  /** Constraint evaluation result for the current selections */
  evaluation: EvaluationResult;
  /** Parameters after restrictions are applied */
  resolvedParameters: ResolvedCsdParameter[];
}

/** A single parameter after constraint restrictions are applied */
export interface ResolvedCsdParameter {
  param: CsdParameter;
  /** Whether this param is visible given current selections */
  visible: boolean;
  /** Whether constraints narrowed this param's options */
  restricted: boolean;
  /** The applied restriction (if any) */
  restriction?: ParamRestriction;
}

/** Pricing result from a CSD */
export interface CsdPricingResult {
  basePrice: number;
  totalPrice: number;
  currency: string;
  breakdown: Array<{
    paramKey: string;
    paramLabel: string;
    selectedValue: string;
    mode: string;
    amount: number;
  }>;
}

/** Validation result for selections against a resolved CSD */
export interface CsdValidationResult {
  valid: boolean;
  errors: Array<{ paramKey: string; message: string }>;
  warnings: Array<{ paramKey: string; message: string }>;
}

// ── Resolver ───────────────────────────────────────────────────────

export class CsdResolver {
  private constraintEvaluator = new CsdConstraintEvaluator();
  private invariantEvaluator = new CsdInvariantEvaluator();

  constructor(private registry: CsdRegistry) {}

  /**
   * Resolve a CSD by URL.
   * Applies baseDefinition inheritance, then evaluates constraints for the given selections.
   *
   * @param csdUrl - The canonical CSD URI (e.g., "pcc://capabilities/fdm/v2")
   * @param selections - Current user selections
   */
  resolve(csdUrl: string, selections: Record<string, unknown>): ResolvedCsd {
    // Load + inherit from baseDefinition chain
    const csd = this.registry.resolve(csdUrl);

    // Evaluate constraints
    const evaluation = this.constraintEvaluator.evaluate(csd.constraints, selections);

    // Build resolved parameters
    const resolvedParameters = csd.parameters.map((param) =>
      this.resolveParameter(param, selections, evaluation),
    );

    return { csd, evaluation, resolvedParameters };
  }

  /**
   * Calculate pricing for a resolved CSD + selections.
   */
  price(resolved: ResolvedCsd, selections: Record<string, unknown>): CsdPricingResult {
    const basePrice = parseFloat(resolved.csd.pricing.basePrice);
    const currency = resolved.csd.pricing.currency;
    const breakdown: CsdPricingResult["breakdown"] = [];
    let runningTotal = basePrice;

    for (const rp of resolved.resolvedParameters) {
      if (!rp.visible) continue;

      const param = rp.param;
      const value = selections[param.key];
      if (value === undefined && param.type !== "boolean") continue;

      switch (param.type) {
        case "enum": {
          if (param.multi && Array.isArray(value)) {
            for (const v of value) {
              if (v === "none") continue;
              const opt = param.options.find((o) => o.value === v);
              if (opt?.pricingImpact) {
                const amount = this.computeImpact(opt.pricingImpact, basePrice, String(v));
                breakdown.push({ paramKey: param.key, paramLabel: param.label, selectedValue: String(v), mode: opt.pricingImpact.mode, amount });
                runningTotal += amount;
              }
            }
          } else if (typeof value === "string") {
            const opt = param.options.find((o) => o.value === value);
            if (opt?.pricingImpact) {
              const amount = this.computeImpact(opt.pricingImpact, basePrice, value);
              breakdown.push({ paramKey: param.key, paramLabel: param.label, selectedValue: value, mode: opt.pricingImpact.mode, amount });
              runningTotal += amount;
            }
            // Also check param-level pricing (e.g., perOption map)
            if (param.pricingImpact?.perOption && typeof value === "string") {
              const perOptionVal = param.pricingImpact.perOption[value];
              if (perOptionVal !== undefined) {
                const numVal = typeof perOptionVal === "number" ? perOptionVal : parseFloat(perOptionVal);
                const amount = this.computePerOptionImpact(param.pricingImpact.mode, basePrice, numVal);
                breakdown.push({ paramKey: param.key, paramLabel: param.label, selectedValue: value, mode: param.pricingImpact.mode, amount });
                runningTotal += amount;
              }
            }
          }
          break;
        }

        case "number": {
          if (typeof value === "number" && param.pricingImpact) {
            const amount = this.computeNumberImpact(param.pricingImpact, basePrice, value);
            breakdown.push({ paramKey: param.key, paramLabel: param.label, selectedValue: String(value), mode: param.pricingImpact.mode, amount });
            runningTotal += amount;
          }
          break;
        }

        case "boolean": {
          if (value === true && param.pricingImpact) {
            const impact = param.pricingImpact;
            const amount = this.computeImpact(impact, basePrice, "true");
            breakdown.push({ paramKey: param.key, paramLabel: param.label, selectedValue: "true", mode: impact.mode, amount });
            runningTotal += amount;
          }
          break;
        }
      }
    }

    // Apply quantity multiplier if present
    const quantity = typeof selections["quantity"] === "number" ? selections["quantity"] : 1;
    const totalPrice = Math.max(0, runningTotal * quantity);

    // Apply minimum charge if configured
    const minimumCharge = resolved.csd.pricing.minimumCharge
      ? parseFloat(resolved.csd.pricing.minimumCharge)
      : 0;

    return {
      basePrice,
      totalPrice: Math.max(totalPrice, minimumCharge > 0 ? minimumCharge : 0),
      currency,
      breakdown,
    };
  }

  /**
   * Validate user selections against a resolved CSD.
   * Checks: required params, enum valid values, number ranges, boolean type.
   * Also includes constraint errors/warnings and invariant violations.
   */
  validate(
    resolved: ResolvedCsd,
    selections: Record<string, unknown>,
    deviceContext?: Record<string, unknown>,
  ): CsdValidationResult {
    const errors: Array<{ paramKey: string; message: string }> = [];
    const warnings: Array<{ paramKey: string; message: string }> = [];

    // 1. Parameter-level validation
    for (const rp of resolved.resolvedParameters) {
      if (!rp.visible) continue;

      const param = rp.param;
      const value = selections[param.key];

      // Required check
      if (param.required && (value === undefined || value === null || value === "")) {
        errors.push({ paramKey: param.key, message: `${param.label} is required` });
        continue;
      }

      if (value === undefined || value === null) continue;

      switch (param.type) {
        case "enum": {
          // Determine valid values (after restrictions applied)
          let validOptions = param.options.map((o) => o.value);
          const restriction = rp.restriction;
          if (restriction?.restrictTo) {
            validOptions = validOptions.filter((v) => restriction.restrictTo!.includes(v));
          }
          if (restriction?.exclude) {
            validOptions = validOptions.filter((v) => !restriction.exclude!.includes(v));
          }

          if (param.multi && Array.isArray(value)) {
            for (const v of value) {
              if (v !== "none" && !validOptions.includes(v)) {
                errors.push({
                  paramKey: param.key,
                  message: `${param.label}: "${v}" is not a valid option`,
                });
              }
            }
          } else if (typeof value === "string") {
            if (!validOptions.includes(value)) {
              errors.push({
                paramKey: param.key,
                message: `${param.label}: "${value}" is not a valid option`,
              });
            }
          }
          break;
        }

        case "number": {
          if (typeof value !== "number" || isNaN(value)) {
            errors.push({ paramKey: param.key, message: `${param.label} must be a number` });
          } else {
            const restriction = rp.restriction;
            const effectiveMin = restriction?.setMin !== undefined ? restriction.setMin : param.min;
            const effectiveMax = restriction?.setMax !== undefined ? restriction.setMax : param.max;
            if (value < effectiveMin) {
              errors.push({ paramKey: param.key, message: `${param.label} must be at least ${effectiveMin}` });
            }
            if (value > effectiveMax) {
              errors.push({ paramKey: param.key, message: `${param.label} must be at most ${effectiveMax}` });
            }
          }
          break;
        }

        case "boolean": {
          if (typeof value !== "boolean") {
            errors.push({ paramKey: param.key, message: `${param.label} must be true or false` });
          }
          break;
        }

        case "string": {
          if (typeof value !== "string") {
            errors.push({ paramKey: param.key, message: `${param.label} must be a string` });
          } else if (param.maxLength !== undefined && value.length > param.maxLength) {
            errors.push({
              paramKey: param.key,
              message: `${param.label} must be at most ${param.maxLength} characters`,
            });
          }
          break;
        }
      }
    }

    // 2. Constraint errors/warnings from evaluation
    for (const err of resolved.evaluation.errors) {
      errors.push({ paramKey: err.key, message: err.message });
    }
    for (const warn of resolved.evaluation.warnings) {
      warnings.push({ paramKey: warn.key, message: warn.message });
    }

    // 3. Invariant evaluation
    if (resolved.csd.invariants) {
      const context = {
        ...selections,
        ...(deviceContext ?? {}),
      };
      for (const invariant of resolved.csd.invariants) {
        const holds = this.invariantEvaluator.evaluate(invariant.expression, context);
        if (!holds) {
          if (invariant.severity === "error") {
            errors.push({ paramKey: invariant.key, message: invariant.human });
          } else {
            warnings.push({ paramKey: invariant.key, message: invariant.human });
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────

  private resolveParameter(
    param: CsdParameter,
    selections: Record<string, unknown>,
    evaluation: EvaluationResult,
  ): ResolvedCsdParameter {
    const visible = this.isVisible(param, selections);
    const restriction = evaluation.paramRestrictions.get(param.key);
    const restricted = restriction !== undefined;

    return { param, visible, restricted, restriction };
  }

  private isVisible(param: CsdParameter, selections: Record<string, unknown>): boolean {
    if (!param.visibleWhen) return true;
    return selections[param.visibleWhen.param] === param.visibleWhen.equals;
  }

  private computeImpact(
    impact: { mode: string; value?: number | string; perOption?: Record<string, number | string> },
    basePrice: number,
    selectedValue: string,
  ): number {
    // Handle perOption pricing
    if (impact.perOption) {
      const optVal = impact.perOption[selectedValue];
      if (optVal !== undefined) {
        return this.computePerOptionImpact(impact.mode, basePrice, typeof optVal === "number" ? optVal : parseFloat(optVal));
      }
      return 0;
    }

    const val = typeof impact.value === "number" ? impact.value : parseFloat(String(impact.value ?? "0"));
    switch (impact.mode) {
      case "flat": return val;
      case "percent": return basePrice * (val / 100);
      case "multiplier": return basePrice * (val - 1);
      case "per_unit": return val;
      default: return 0;
    }
  }

  private computePerOptionImpact(mode: string, basePrice: number, optionValue: number): number {
    switch (mode) {
      case "flat": return optionValue;
      case "percent": return basePrice * (optionValue / 100);
      case "multiplier": return basePrice * (optionValue - 1);
      case "per_unit": return optionValue;
      default: return 0;
    }
  }

  private computeNumberImpact(
    impact: { mode: string; value?: number | string },
    basePrice: number,
    value: number,
  ): number {
    const unitCost = typeof impact.value === "number"
      ? impact.value
      : parseFloat(String(impact.value ?? "0"));

    switch (impact.mode) {
      case "per_unit": return unitCost * value;
      case "flat": return unitCost;
      case "percent": return basePrice * (unitCost / 100);
      case "multiplier": return basePrice * (unitCost - 1);
      default: return 0;
    }
  }
}
