/**
 * PricingCalculator — computes a price breakdown from template pricing + user selections.
 *
 * Applies each parameter's PricingImpact to the base price.
 * Supports: flat, percent, per_unit, multiplier modes.
 */

import type {
  ResolvedBuildOptions,
  PricingImpact,
  PriceBreakdownItem,
  EnumParamDef,
  NumberParamDef,
  BooleanParamDef,
  Amount,
} from "@pcc/spec";

export interface PricingResult {
  basePrice: number;
  totalPrice: number;
  breakdown: PriceBreakdownItem[];
  currency: string;
}

export class PricingCalculator {
  /**
   * Calculate the total price given resolved options and current selections.
   */
  calculate(
    options: ResolvedBuildOptions,
    selections: Record<string, unknown>,
  ): PricingResult {
    let basePrice = parseFloat(options.basePrice);
    const breakdown: PriceBreakdownItem[] = [];
    let runningTotal = basePrice;

    // Collect all pricing impacts from selections
    for (const rp of options.allParams) {
      if (!rp.visible) continue;

      const def = rp.def;
      const value = selections[def.key];
      if (value === undefined && def.type !== "boolean") continue;

      switch (def.type) {
        case "enum": {
          const enumDef = def as EnumParamDef;
          if (enumDef.multi && Array.isArray(value)) {
            // Multi-select: apply pricing for each selected option
            for (const v of value) {
              if (v === "none") continue;
              const opt = enumDef.options.find((o) => o.value === v);
              if (opt?.pricingImpact) {
                const item = this.applyImpact(opt.pricingImpact, basePrice, def.key, def.label, String(v));
                breakdown.push(item);
                runningTotal += parseFloat(item.amount);
              }
            }
          } else if (typeof value === "string") {
            const opt = enumDef.options.find((o) => o.value === value);
            if (opt?.pricingImpact) {
              const item = this.applyImpact(opt.pricingImpact, basePrice, def.key, def.label, value);
              if (opt.pricingImpact.mode === "multiplier") {
                // Multiplier replaces the base price factor, handled specially
                const multiplier = parseFloat(opt.pricingImpact.value);
                const delta = basePrice * (multiplier - 1);
                breakdown.push({
                  paramKey: def.key,
                  paramLabel: def.label,
                  selectedValue: value,
                  impact: opt.pricingImpact,
                  amount: delta.toFixed(2),
                });
                runningTotal += delta;
              } else {
                breakdown.push(item);
                runningTotal += parseFloat(item.amount);
              }
            }
          }
          // Also check param-level pricing impact (for non-option-specific pricing)
          if (def.pricingImpact && value !== undefined) {
            const item = this.applyImpact(def.pricingImpact, basePrice, def.key, def.label, String(value));
            breakdown.push(item);
            runningTotal += parseFloat(item.amount);
          }
          break;
        }

        case "number": {
          const numDef = def as NumberParamDef;
          const numValue = value as number | undefined;
          if (numValue !== undefined && def.pricingImpact) {
            const item = this.applyNumberImpact(def.pricingImpact, basePrice, def.key, def.label, numValue, numDef.defaultValue);
            breakdown.push(item);
            runningTotal += parseFloat(item.amount);
          }
          break;
        }

        case "boolean": {
          const boolDef = def as BooleanParamDef;
          const boolValue = value as boolean | undefined;
          if (boolValue && boolDef.pricingImpact) {
            const item = this.applyImpact(boolDef.pricingImpact, basePrice, def.key, def.label, "true");
            breakdown.push(item);
            runningTotal += parseFloat(item.amount);
          }
          break;
        }
      }
    }

    // Apply quantity multiplier
    const quantity = (selections["quantity"] as number) ?? 1;
    const perUnitPrice = runningTotal;
    const totalPrice = perUnitPrice * quantity;

    return {
      basePrice,
      totalPrice: Math.max(0, totalPrice),
      breakdown,
      currency: options.currency,
    };
  }

  private applyImpact(
    impact: PricingImpact,
    basePrice: number,
    paramKey: string,
    paramLabel: string,
    selectedValue: string,
  ): PriceBreakdownItem {
    let amount: number;

    switch (impact.mode) {
      case "flat":
        amount = parseFloat(impact.value);
        break;
      case "percent":
        amount = basePrice * (parseFloat(impact.value) / 100);
        break;
      case "per_unit":
        // per_unit applied at the param level needs the actual value — handled in applyNumberImpact
        amount = parseFloat(impact.value);
        break;
      case "multiplier":
        amount = basePrice * (parseFloat(impact.value) - 1);
        break;
      default:
        amount = 0;
    }

    return {
      paramKey,
      paramLabel,
      selectedValue,
      impact,
      amount: amount.toFixed(2),
    };
  }

  private applyNumberImpact(
    impact: PricingImpact,
    basePrice: number,
    paramKey: string,
    paramLabel: string,
    value: number,
    defaultValue?: number,
  ): PriceBreakdownItem {
    let amount: number;

    switch (impact.mode) {
      case "per_unit": {
        // per_unit for numbers: cost per unit of the value (e.g., $0.01 per 1% infill)
        const perUnit = parseFloat(impact.value);
        amount = perUnit * value;
        break;
      }
      case "flat":
        amount = parseFloat(impact.value);
        break;
      case "percent":
        amount = basePrice * (parseFloat(impact.value) / 100);
        break;
      case "multiplier":
        amount = basePrice * (parseFloat(impact.value) - 1);
        break;
      default:
        amount = 0;
    }

    return {
      paramKey,
      paramLabel,
      selectedValue: String(value),
      impact,
      amount: amount.toFixed(2),
    };
  }
}
