/**
 * CsdConstraintEvaluator — evaluates CSD-format constraints against user selections.
 *
 * Key differences from the legacy TemplateResolver:
 * - Conditions are compound: ALL when[] conditions must match (implicit AND)
 * - Operators: equals, notEquals, in, notIn, gt, lt, gte, lte
 * - Actions: restrictTo, exclude, setMin, setMax, reject, warn
 * - Results accumulate per-param restrictions + errors + warnings
 */

import type { CsdConstraint } from "@pcc/spec";

// Derive the element types from the CsdConstraint array fields
type CsdConstraintCondition = CsdConstraint["when"][number];
type CsdConstraintAction = CsdConstraint["then"][number];

// ── Public types ───────────────────────────────────────────────────

export interface ParamRestriction {
  /** If set, the param's options must be restricted to only these values */
  restrictTo?: string[];
  /** If set, these values must be removed from the param's options */
  exclude?: string[];
  /** If set, override numeric min */
  setMin?: number;
  /** If set, override numeric max */
  setMax?: number;
}

export interface EvaluationError {
  /** Constraint key */
  key: string;
  /** Human-readable constraint description */
  human: string;
  /** "error" fires on violation, "warning" is advisory */
  severity: "error" | "warning";
  /** The action's message field */
  message: string;
}

export interface EvaluationResult {
  /** Whether there are no hard errors */
  valid: boolean;
  /** Hard errors produced by "reject" actions */
  errors: EvaluationError[];
  /** Advisory messages produced by "warn" actions */
  warnings: EvaluationError[];
  /** Accumulated param-level restrictions (union of all fired constraints) */
  paramRestrictions: Map<string, ParamRestriction>;
}

// ── Evaluator ─────────────────────────────────────────────────────

export class CsdConstraintEvaluator {
  /**
   * Evaluate all CSD constraints against current selections.
   *
   * A constraint fires when ALL its when[] conditions are true (implicit AND).
   * When a constraint fires, all its then[] actions are applied.
   */
  evaluate(
    constraints: CsdConstraint[],
    selections: Record<string, unknown>,
  ): EvaluationResult {
    const result: EvaluationResult = {
      valid: true,
      errors: [],
      warnings: [],
      paramRestrictions: new Map(),
    };

    for (const constraint of constraints) {
      const fires = this.evaluateConditions(constraint.when, selections);
      if (!fires) continue;

      this.applyActions(constraint, result);
    }

    result.valid = result.errors.length === 0;
    return result;
  }

  /**
   * Evaluate a compound condition (AND of all when[] items).
   * Returns true only if every condition in the array matches.
   */
  private evaluateConditions(
    conditions: CsdConstraintCondition[],
    selections: Record<string, unknown>,
  ): boolean {
    for (const condition of conditions) {
      if (!this.evaluateCondition(condition, selections)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Evaluate a single CSD condition against the current selections.
   */
  private evaluateCondition(
    condition: CsdConstraintCondition,
    selections: Record<string, unknown>,
  ): boolean {
    const value = selections[condition.param];

    // If the param hasn't been set, most conditions evaluate to false
    // (we can't say the condition is violated by absence)
    if (value === undefined || value === null) return false;

    const condValue = condition.value;

    switch (condition.operator) {
      case "equals":
        return value === condValue;

      case "notEquals":
        return value !== condValue;

      case "in": {
        const arr = Array.isArray(condValue) ? condValue : [condValue];
        return arr.includes(value as string | number);
      }

      case "notIn": {
        const arr = Array.isArray(condValue) ? condValue : [condValue];
        return !arr.includes(value as string | number);
      }

      case "gt":
        return typeof value === "number" && typeof condValue === "number" && value > condValue;

      case "lt":
        return typeof value === "number" && typeof condValue === "number" && value < condValue;

      case "gte":
        return typeof value === "number" && typeof condValue === "number" && value >= condValue;

      case "lte":
        return typeof value === "number" && typeof condValue === "number" && value <= condValue;

      default:
        return false;
    }
  }

  /**
   * Apply all then[] actions from a fired constraint.
   * Accumulates restrictions into result.paramRestrictions.
   * Adds to result.errors or result.warnings based on action type.
   */
  private applyActions(constraint: CsdConstraint, result: EvaluationResult): void {
    for (const action of constraint.then) {
      this.applyAction(action, constraint, result);
    }
  }

  private applyAction(
    action: CsdConstraintAction,
    constraint: CsdConstraint,
    result: EvaluationResult,
  ): void {
    switch (action.action) {
      case "reject": {
        result.errors.push({
          key: constraint.key,
          human: constraint.human,
          severity: constraint.severity,
          message: action.message ?? constraint.human,
        });
        break;
      }

      case "warn": {
        result.warnings.push({
          key: constraint.key,
          human: constraint.human,
          severity: constraint.severity,
          message: action.message ?? constraint.human,
        });
        break;
      }

      case "restrictTo": {
        if (!action.param || !action.values) break;
        const existing = this.getOrCreate(result.paramRestrictions, action.param);
        // Intersect: if already restricted, take the intersection; otherwise set
        if (existing.restrictTo) {
          existing.restrictTo = existing.restrictTo.filter((v) =>
            action.values!.includes(v),
          );
        } else {
          existing.restrictTo = [...action.values];
        }
        break;
      }

      case "exclude": {
        if (!action.param || !action.values) break;
        const existing = this.getOrCreate(result.paramRestrictions, action.param);
        if (!existing.exclude) {
          existing.exclude = [];
        }
        // Union: accumulate all excluded values
        for (const v of action.values) {
          if (!existing.exclude.includes(v)) {
            existing.exclude.push(v);
          }
        }
        break;
      }

      case "setMin": {
        if (!action.param || action.value === undefined) break;
        const existing = this.getOrCreate(result.paramRestrictions, action.param);
        const newMin = typeof action.value === "number" ? action.value : parseFloat(action.value);
        // Take the maximum of all setMin constraints (most restrictive lower bound)
        existing.setMin =
          existing.setMin !== undefined ? Math.max(existing.setMin, newMin) : newMin;
        break;
      }

      case "setMax": {
        if (!action.param || action.value === undefined) break;
        const existing = this.getOrCreate(result.paramRestrictions, action.param);
        const newMax = typeof action.value === "number" ? action.value : parseFloat(action.value);
        // Take the minimum of all setMax constraints (most restrictive upper bound)
        existing.setMax =
          existing.setMax !== undefined ? Math.min(existing.setMax, newMax) : newMax;
        break;
      }
    }
  }

  private getOrCreate(map: Map<string, ParamRestriction>, key: string): ParamRestriction {
    let r = map.get(key);
    if (!r) {
      r = {};
      map.set(key, r);
    }
    return r;
  }
}
