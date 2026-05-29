/**
 * LINQ ↔ MADSci translator.
 *
 * LINQ and MADSci describe the same shape (lab workflow as ordered actions
 * on named instruments). This file collapses LINQ workflows to the MADSci
 * dialect so the rest of the PCC pipeline only knows one schema.
 *
 * Reverse direction (MADSci → LINQ) is provided for the case where a PCC
 * agent authors in MADSci YAML and wants to deploy onto a LINQ lab.
 */

import type { MadsciWorkflow, MadsciStep } from "@pcc/adapter-madsci";
import type { LinqWorkflow, LinqTask } from "./types.js";

/**
 * Convert a LINQ Workflow into a MADSci Workflow. The LINQ
 * `task.instrument_id` becomes MADSci `step.action.node`; `task.action`
 * and `task.args` map directly. LINQ labware references go into the
 * MADSci `locations` map.
 */
export function linqWorkflowToMadsci(workflow: LinqWorkflow): MadsciWorkflow {
  const steps: MadsciStep[] = workflow.tasks.map((task: LinqTask) => ({
    name: task.id,
    action: {
      node: task.instrument_id,
      action: task.action,
      args: task.args,
      ...(task.labware
        ? {
            locations: Object.fromEntries(
              Object.entries(task.labware).filter(([, v]) => v !== undefined),
            ) as Record<string, string>,
          }
        : {}),
      name: task.name,
    },
  }));
  return {
    schema: "madsci/v1",
    name: workflow.name,
    description: workflow.description,
    metadata: {
      source: "automata-linq",
      linq_workflow_id: workflow.id,
      linq_workcell_id: workflow.workcell_id,
      ...(workflow.version ? { linq_version: workflow.version } : {}),
    },
    steps,
  };
}

/**
 * Convert a MADSci Workflow into a LINQ Workflow payload (shape suitable
 * for POST /v1/workflows). Round-trips the metadata so re-import is
 * lossless.
 */
export function madsciWorkflowToLinq(
  workflow: MadsciWorkflow,
  workcellId: string,
): Omit<LinqWorkflow, "id"> {
  const tasks: LinqTask[] = workflow.steps.map((step, index) => ({
    id: step.name ?? `task-${index}`,
    name: step.action.name ?? step.name,
    instrument_id: step.action.node,
    action: step.action.action,
    args: step.action.args,
    ...(step.action.locations
      ? {
          labware: {
            source: step.action.locations.source,
            target: step.action.locations.target,
          },
        }
      : {}),
  }));
  return {
    name: workflow.name,
    description: workflow.description,
    workcell_id: workcellId,
    tasks,
  };
}
