/**
 * TemplateResolver — merges a CapabilityTemplate with a MachineProfile and current
 * user selections to produce a ResolvedBuildOptions view model.
 *
 * This handles:
 * 1. Profile overrides (restrict/exclude options, override min/max/defaults)
 * 2. Constraint resolution (cross-parameter rules based on current selections)
 * 3. Visibility conditions (show/hide params based on other selections)
 */

import type {
  CapabilityTemplate,
  MachineProfile,
  ParamDef,
  EnumParamDef,
  NumberParamDef,
  ParamConstraint,
  ParamOverride,
  ResolvedBuildOptions,
  ResolvedParam,
  ResolvedParamGroup,
} from "@pcc/spec";

export class TemplateResolver {
  /**
   * Resolve a template + optional profile + current selections into a view model.
   */
  resolve(
    template: CapabilityTemplate,
    selections: Record<string, unknown>,
    profile?: MachineProfile,
  ): ResolvedBuildOptions {
    // Step 1: Deep-clone the params so we can mutate
    let params = structuredClone(template.params);

    // Step 2: Apply profile overrides
    if (profile) {
      params = this.applyProfileOverrides(params, profile);
      // Add any additional params from the profile
      if (profile.additionalParams) {
        params.push(...structuredClone(profile.additionalParams));
      }
    }

    // Step 3: Apply constraint rules based on current selections
    if (template.constraints) {
      params = this.applyConstraints(params, template.constraints, selections);
    }

    // Step 4: Resolve visibility
    const resolvedParams = params
      .sort((a, b) => a.order - b.order)
      .map((def): ResolvedParam => {
        const visible = this.isVisible(def, selections);
        const restricted = this.isRestricted(def);
        return { def, visible, restricted };
      });

    // Step 5: Group params
    const groupMap = new Map<string, ResolvedParam[]>();
    for (const rp of resolvedParams) {
      const group = rp.def.group;
      if (!groupMap.has(group)) groupMap.set(group, []);
      groupMap.get(group)!.push(rp);
    }
    const groups: ResolvedParamGroup[] = [...groupMap.entries()].map(([name, params]) => ({
      name,
      params,
    }));

    // Step 6: Determine base price
    const basePrice = profile?.pricingOverrides?.basePrice
      ?? template.basePricingHints?.basePrice
      ?? "0.00";
    const currency = profile?.pricingOverrides?.currency
      ?? template.basePricingHints?.currency
      ?? "USDC";

    return {
      capabilityType: template.capabilityType,
      templateName: template.name,
      templateVersion: template.version,
      groups,
      allParams: resolvedParams,
      basePrice,
      currency,
      machineInfo: profile
        ? { profileId: profile.id, machineName: profile.machineName, kernelId: profile.kernelId }
        : undefined,
    };
  }

  private applyProfileOverrides(params: ParamDef[], profile: MachineProfile): ParamDef[] {
    const overrideMap = new Map<string, ParamOverride>();
    for (const ov of profile.paramOverrides) {
      overrideMap.set(ov.paramKey, ov);
    }

    return params.map((param) => {
      const override = overrideMap.get(param.key);
      if (!override) return param;

      if (param.type === "enum") {
        const enumParam = param as EnumParamDef;
        if (override.restrictTo) {
          enumParam.options = enumParam.options.filter((o) => override.restrictTo!.includes(o.value));
        }
        if (override.exclude) {
          enumParam.options = enumParam.options.filter((o) => !override.exclude!.includes(o.value));
        }
        if (override.overrideDefault !== undefined) {
          enumParam.defaultValue = String(override.overrideDefault);
        }
      } else if (param.type === "number") {
        const numParam = param as NumberParamDef;
        if (override.overrideMin !== undefined) numParam.min = override.overrideMin;
        if (override.overrideMax !== undefined) numParam.max = override.overrideMax;
        if (override.overrideDefault !== undefined) numParam.defaultValue = Number(override.overrideDefault);
      }

      return param;
    });
  }

  private applyConstraints(
    params: ParamDef[],
    constraints: ParamConstraint[],
    selections: Record<string, unknown>,
  ): ParamDef[] {
    for (const constraint of constraints) {
      if (!this.matchesCondition(constraint.when, selections)) continue;

      for (const action of constraint.then) {
        const param = params.find((p) => p.key === action.param);
        if (!param) continue;

        if (param.type === "enum") {
          const enumParam = param as EnumParamDef;
          if (action.restrictTo) {
            enumParam.options = enumParam.options.filter((o) => action.restrictTo!.includes(o.value));
          }
          if (action.exclude) {
            enumParam.options = enumParam.options.filter((o) => !action.exclude!.includes(o.value));
          }
        } else if (param.type === "number") {
          const numParam = param as NumberParamDef;
          if (action.setMin !== undefined) numParam.min = action.setMin;
          if (action.setMax !== undefined) numParam.max = action.setMax;
        }
      }
    }

    return params;
  }

  private matchesCondition(
    condition: ParamConstraint["when"],
    selections: Record<string, unknown>,
  ): boolean {
    const value = selections[condition.param];
    if (value === undefined) return false;

    if (condition.equals !== undefined) {
      // Multi-select on the selection side: membership check instead of strict eq
      if (Array.isArray(value)) return value.includes(condition.equals);
      return value === condition.equals;
    }
    if (condition.in !== undefined) {
      // Multi-select on the selection side: any-intersection with condition list
      if (Array.isArray(value)) {
        const allowed = new Set(condition.in as unknown[]);
        return value.some((v) => allowed.has(v));
      }
      return (condition.in as unknown[]).includes(value);
    }
    if (condition.gt !== undefined) return typeof value === "number" && value > condition.gt;
    if (condition.lt !== undefined) return typeof value === "number" && value < condition.lt;

    return false;
  }

  private isVisible(def: ParamDef, selections: Record<string, unknown>): boolean {
    if (!def.visibleWhen) return true;
    const value = selections[def.visibleWhen.param];
    const target = def.visibleWhen.equals;
    // Multi-select on the selection side: dependent param becomes visible when
    // the target value is among the selected array (e.g., weldCert visibleWhen
    // operations equals "weld", where operations is ["laser","weld","brake"]).
    if (Array.isArray(value)) return value.includes(target);
    return value === target;
  }

  private isRestricted(def: ParamDef): boolean {
    // An enum param is restricted if it has fewer options than expected
    // We mark it based on whether constraints were applied (heuristic: < 2 options)
    if (def.type === "enum" && def.options.length === 0) return true;
    return false;
  }
}
