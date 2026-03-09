/**
 * ContractValidator — validates user selections against the resolved template
 * and produces a CWM step.
 */

import type {
  ResolvedBuildOptions,
  ContractValidationError,
  EnumParamDef,
  NumberParamDef,
  CapabilityType,
} from "@pcc/spec";

export interface ValidationResult {
  errors: ContractValidationError[];
  isValid: boolean;
  cwmStep: {
    capability: CapabilityType;
    params: Record<string, unknown>;
    assuranceTier: number;
  };
}

export class ContractValidator {
  /**
   * Validate selections against the resolved options and build a CWM step.
   */
  validate(
    options: ResolvedBuildOptions,
    selections: Record<string, unknown>,
    assuranceTier: number = 1,
  ): ValidationResult {
    const errors: ContractValidationError[] = [];

    for (const rp of options.allParams) {
      if (!rp.visible) continue;

      const def = rp.def;
      const value = selections[def.key];

      // Check required
      if (def.required && (value === undefined || value === null || value === "")) {
        errors.push({
          paramKey: def.key,
          message: `${def.label} is required`,
        });
        continue;
      }

      // Skip validation if not set and not required
      if (value === undefined || value === null) continue;

      switch (def.type) {
        case "enum": {
          const enumDef = def as EnumParamDef;
          const validValues = enumDef.options.map((o) => o.value);

          if (enumDef.multi && Array.isArray(value)) {
            for (const v of value) {
              if (v !== "none" && !validValues.includes(v)) {
                errors.push({
                  paramKey: def.key,
                  message: `${def.label}: "${v}" is not a valid option. Valid: ${validValues.join(", ")}`,
                });
              }
            }
          } else if (typeof value === "string") {
            if (!validValues.includes(value)) {
              errors.push({
                paramKey: def.key,
                message: `${def.label}: "${value}" is not a valid option. Valid: ${validValues.join(", ")}`,
              });
            }
          }
          break;
        }

        case "number": {
          const numDef = def as NumberParamDef;
          const numValue = value as number;
          if (typeof numValue !== "number" || isNaN(numValue)) {
            errors.push({ paramKey: def.key, message: `${def.label} must be a number` });
          } else {
            if (numValue < numDef.min) {
              errors.push({ paramKey: def.key, message: `${def.label} must be at least ${numDef.min}` });
            }
            if (numValue > numDef.max) {
              errors.push({ paramKey: def.key, message: `${def.label} must be at most ${numDef.max}` });
            }
          }
          break;
        }

        case "boolean": {
          if (typeof value !== "boolean") {
            errors.push({ paramKey: def.key, message: `${def.label} must be true or false` });
          }
          break;
        }

        case "string": {
          if (typeof value !== "string") {
            errors.push({ paramKey: def.key, message: `${def.label} must be a string` });
          }
          break;
        }
      }
    }

    // Build CWM step params from selections
    const params: Record<string, unknown> = {};
    for (const rp of options.allParams) {
      if (!rp.visible) continue;
      const value = selections[rp.def.key];
      if (value !== undefined && value !== null) {
        params[rp.def.key] = value;
      }
    }

    return {
      errors,
      isValid: errors.length === 0,
      cwmStep: {
        capability: options.capabilityType,
        params,
        assuranceTier,
      },
    };
  }
}
