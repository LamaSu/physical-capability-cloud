/**
 * LINQ → PCC kernel binding.
 *
 * Builds a DigitalKernelManifest that registers a LINQ lab as a PCC kernel.
 * The PCC kernel announces each LINQ workflow as a capability. Job
 * submissions arriving at the kernel are forwarded to LINQ Cloud via
 * LinqClient.startRun.
 */

import { buildManifest, type ManifestBuilderInput } from "@pcc/kernel-sdk";
import type { DigitalKernelManifest } from "@pcc/spec";
import { LinqClient } from "./client.js";
import { linqWorkflowToMadsci } from "./translator.js";
import type { LinqWorkcell, LinqWorkflow } from "./types.js";

export interface LinqKernelOptions {
  /** PCC kernel ID this LINQ binding registers under. */
  kernelId: string;
  /** Human-readable lab name (shown in PCC discovery). */
  name: string;
  /** Builder agent identity per @pcc/spec. */
  builder: ManifestBuilderInput["builder"];
  /** PCC capability type tag (e.g. "lab-automation/v1"). */
  capabilityType: string;
  /** HTTPS endpoint of the PCC-side kernel server (where PCC posts jobs). */
  endpointURL: string;
  /** Max assurance tier this kernel can offer (0..3). */
  maxAssuranceTier: 0 | 1 | 2 | 3;
  /** Touchstone library used for proof tasks. */
  touchstoneLibraryId: string;
  /** LINQ workcell to bind. */
  workcell: LinqWorkcell;
  /** Workflows to expose as capabilities. */
  workflows: LinqWorkflow[];
}

/**
 * Build a DigitalKernelManifest for a LINQ-backed PCC kernel.
 */
export function buildLinqKernelManifest(
  opts: LinqKernelOptions,
): DigitalKernelManifest {
  return buildManifest({
    kernelId: opts.kernelId,
    name: opts.name,
    description: `Automata LINQ workcell "${opts.workcell.name}" exposed as PCC kernel`,
    builder: opts.builder,
    capabilityType: opts.capabilityType,
    workflowSteps: opts.workflows.map((wf) => ({
      stepId: wf.id,
      stepType: "transform" as const,
      description: wf.description ?? wf.name,
      dependsOn: [],
    })),
    maxAssuranceTier: opts.maxAssuranceTier,
    touchstoneLibraryId: opts.touchstoneLibraryId,
    endpointURL: opts.endpointURL,
  });
}

export interface LinqKernelRunHandle {
  pccJobId: string;
  linqRunId: string;
}

/**
 * Forward a PCC job submission to LINQ. The job's params are expected to
 * carry either a `linq_workflow_id` (run an existing LINQ workflow) or
 * a `madsci_workflow` (compile to LINQ first — TODO once LINQ create-
 * workflow surface is documented).
 */
export async function forwardJobToLinq(
  client: LinqClient,
  job: { id: string; params: Record<string, unknown> },
): Promise<LinqKernelRunHandle> {
  const linqWorkflowId = job.params["linq_workflow_id"];
  if (typeof linqWorkflowId !== "string") {
    throw new Error(
      "forwardJobToLinq: params.linq_workflow_id is required (MADSci-source not yet supported on LINQ — needs LINQ create-workflow API)",
    );
  }
  const run = await client.startRun(linqWorkflowId);
  return { pccJobId: job.id, linqRunId: run.id };
}

/**
 * Pull all workflows from a workcell and translate them to MADSci. Useful
 * for an operator who wants to migrate their LINQ workflows to the open
 * MADSci dialect (e.g. for off-LINQ archival or cross-vendor execution).
 */
export async function exportLinqWorkflowsAsMadsci(
  client: LinqClient,
  workcellId: string,
) {
  const workflows = await client.listWorkflows(workcellId);
  return workflows.map(linqWorkflowToMadsci);
}
