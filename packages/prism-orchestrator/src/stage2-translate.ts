/**
 * Stage 2 — StepDraft[] → MadsciWorkflow.
 *
 * Direct mapping. Each StepDraft becomes one MADSci step. Reagents go
 * into args.reagent, volumes into args.volume_ul, source/target into
 * action.locations.
 */

import type { MadsciWorkflow, MadsciStep } from "@pcc/adapter-madsci";
import type { StepDraft } from "./types.js";

export interface TranslateOptions {
  workflowName: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export function translateStepsToMadsci(
  steps: StepDraft[],
  opts: TranslateOptions,
): MadsciWorkflow {
  const madsciSteps: MadsciStep[] = steps.map((s, i) => {
    const args: Record<string, unknown> = {};
    if (s.reagent !== undefined) args.reagent = s.reagent;
    if (s.volumeUl !== undefined) args.volume_ul = s.volumeUl;
    if (s.notes) Object.assign(args, s.notes);

    const locations: Record<string, string> = {};
    if (s.source !== undefined) locations.source = s.source;
    if (s.target !== undefined) locations.target = s.target;

    return {
      name: `step-${i + 1}`,
      action: {
        node: s.instrument,
        action: s.action,
        ...(Object.keys(args).length > 0 ? { args } : {}),
        ...(Object.keys(locations).length > 0 ? { locations } : {}),
        name: s.name,
      },
    };
  });

  return {
    schema: "madsci/v1",
    name: opts.workflowName,
    description: opts.description,
    metadata: { source: "prism-orchestrator", ...(opts.metadata ?? {}) },
    steps: madsciSteps,
  };
}
