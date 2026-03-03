/**
 * Workflow Compiler — takes a CWM and produces an ExecutionPlan.
 *
 * 1. Validates the CWM (schema + dependency graph)
 * 2. Topologically sorts steps
 * 3. Queries available capabilities from kernels
 * 4. Assigns steps to kernels using the router
 * 5. Produces a fully-specified ExecutionPlan
 */

import type {
  CWM,
  CWMStep,
  ExecutionPlan,
  StepAssignment,
  Capability,
  AssuranceTier,
} from "@pcc/spec";
import { ids } from "@pcc/spec";
import { CapabilityRouter, type KernelCapabilities } from "./router.js";

export class WorkflowCompiler {
  private router: CapabilityRouter;

  constructor(router: CapabilityRouter) {
    this.router = router;
  }

  /**
   * Compile a CWM into an ExecutionPlan.
   */
  async compile(cwm: CWM): Promise<ExecutionPlan> {
    // 1. Validate dependency graph (no cycles, all refs valid)
    this.validateDependencies(cwm.steps);

    // 2. Topological sort
    const sorted = this.topologicalSort(cwm.steps);

    // 3. Assign each step to a kernel
    const assignments: StepAssignment[] = [];
    let totalCost = 0;
    let latestEnd = new Date().toISOString();

    for (const step of sorted) {
      const match = await this.router.findBestMatch(step);
      if (!match) {
        throw new Error(`No kernel found for step ${step.id} (capability: ${step.capability})`);
      }

      const now = new Date();
      const startTime = new Date(Math.max(
        now.getTime(),
        ...step.dependsOn.map((depId) => {
          const depAssignment = assignments.find((a) => a.stepId === depId);
          return depAssignment
            ? new Date(depAssignment.scheduledWindow.end).getTime()
            : now.getTime();
        }),
      ));
      const durationMs = (step.estimatedDuration ?? 60) * 60 * 1000;
      const endTime = new Date(startTime.getTime() + durationMs);

      const assignment: StepAssignment = {
        stepId: step.id,
        kernelId: match.kernelId,
        capabilityId: match.capability.id,
        scheduledWindow: {
          start: startTime.toISOString(),
          end: endTime.toISOString(),
        },
        quotedPrice: match.quotedPrice,
        assuranceTier: step.assuranceTier,
      };

      assignments.push(assignment);
      totalCost += parseFloat(match.quotedPrice);
      if (endTime.toISOString() > latestEnd) {
        latestEnd = endTime.toISOString();
      }
    }

    // 4. Check budget
    if (totalCost > parseFloat(cwm.settlement.maxBudget)) {
      throw new Error(
        `Total cost ${totalCost.toFixed(2)} exceeds budget ${cwm.settlement.maxBudget}`,
      );
    }

    return {
      id: ids.job(),
      cwmId: cwm.id,
      assignments,
      totalCost: totalCost.toFixed(2),
      estimatedCompletion: latestEnd,
      createdAt: new Date().toISOString(),
    };
  }

  private validateDependencies(steps: CWMStep[]): void {
    const stepIds = new Set(steps.map((s) => s.id));
    for (const step of steps) {
      for (const dep of step.dependsOn) {
        if (!stepIds.has(dep)) {
          throw new Error(`Step ${step.id} depends on unknown step ${dep}`);
        }
      }
    }

    // Check for cycles via DFS
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const stepMap = new Map(steps.map((s) => [s.id, s]));

    const dfs = (id: string) => {
      if (inStack.has(id)) throw new Error(`Circular dependency detected at step ${id}`);
      if (visited.has(id)) return;
      inStack.add(id);
      const step = stepMap.get(id)!;
      for (const dep of step.dependsOn) {
        dfs(dep);
      }
      inStack.delete(id);
      visited.add(id);
    };

    for (const step of steps) {
      dfs(step.id);
    }
  }

  private topologicalSort(steps: CWMStep[]): CWMStep[] {
    const stepMap = new Map(steps.map((s) => [s.id, s]));
    const visited = new Set<string>();
    const result: CWMStep[] = [];

    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const step = stepMap.get(id)!;
      for (const dep of step.dependsOn) {
        visit(dep);
      }
      result.push(step);
    };

    for (const step of steps) {
      visit(step.id);
    }

    return result;
  }
}
