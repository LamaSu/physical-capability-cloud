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
  DigitalWorkflowStep,
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

  /**
   * Validate digital workflow steps for structural correctness.
   * Checks:
   *   - stepIds are unique
   *   - dependsOn references valid stepIds
   *   - No circular dependencies (topological sort)
   */
  validateWorkflowSteps(steps: DigitalWorkflowStep[]): ContractValidationError[] {
    const errors: ContractValidationError[] = [];
    if (!steps || steps.length === 0) return errors;

    // Check unique stepIds
    const stepIds = new Set<string>();
    for (const step of steps) {
      if (stepIds.has(step.stepId)) {
        errors.push({
          paramKey: `workflowStep.${step.stepId}`,
          message: `Duplicate stepId: "${step.stepId}"`,
        });
      }
      stepIds.add(step.stepId);
    }

    // Check dependsOn references
    for (const step of steps) {
      for (const dep of step.dependsOn) {
        if (!stepIds.has(dep)) {
          errors.push({
            paramKey: `workflowStep.${step.stepId}`,
            message: `dependsOn references unknown stepId: "${dep}"`,
          });
        }
      }
    }

    // Check for circular dependencies via topological sort (Kahn's algorithm)
    const circularError = this.detectCycles(steps);
    if (circularError) {
      errors.push(circularError);
    }

    return errors;
  }

  /**
   * Detect cycles in the workflow step DAG using Kahn's algorithm.
   * Returns a validation error if a cycle is found, undefined otherwise.
   */
  private detectCycles(steps: DigitalWorkflowStep[]): ContractValidationError | undefined {
    // Build adjacency list and in-degree map
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const step of steps) {
      if (!inDegree.has(step.stepId)) {
        inDegree.set(step.stepId, 0);
      }
      if (!adjacency.has(step.stepId)) {
        adjacency.set(step.stepId, []);
      }
    }

    for (const step of steps) {
      for (const dep of step.dependsOn) {
        // dep -> step.stepId (dep must complete before step)
        if (!adjacency.has(dep)) continue; // skip invalid refs (caught above)
        adjacency.get(dep)!.push(step.stepId);
        inDegree.set(step.stepId, (inDegree.get(step.stepId) ?? 0) + 1);
      }
    }

    // Kahn's algorithm
    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id);
    }

    let processed = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      processed++;
      for (const neighbor of (adjacency.get(current) ?? [])) {
        const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) queue.push(neighbor);
      }
    }

    if (processed < steps.length) {
      // Find which steps are in the cycle
      const cycleSteps = steps
        .filter(s => (inDegree.get(s.stepId) ?? 0) > 0)
        .map(s => s.stepId);
      return {
        paramKey: "workflowSteps",
        message: `Circular dependency detected among steps: ${cycleSteps.join(", ")}`,
      };
    }

    return undefined;
  }
}
