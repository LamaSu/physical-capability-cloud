/**
 * MADSci → PCC translator.
 *
 * Two directions:
 *   - madsciWorkflowToPccJob(workflow, ctx)
 *       MADSci YAML payload → PCC POST /api/jobs/submit body.
 *   - madsciNodeToPccDevice(node)
 *       MADSci node descriptor → PCC POST /api/setup/register-device body.
 *
 * The PCC side accepts opaque `params`; MADSci's step list is hashed and
 * carried verbatim so the kernel can replay it 1:1.
 */

import type { MadsciNode, MadsciWorkflow } from "./types.js";

export interface PccTranslationContext {
  /** PCC kernel that will execute this MADSci workflow. */
  kernelId: string;
  /** PCC capability ID this workflow binds to (e.g. "cap-madsci-pcr-001"). */
  capabilityId: string;
  /** Assurance tier requested (0..3). Defaults to 1. */
  assuranceTier?: 0 | 1 | 2 | 3;
}

export interface PccJobSubmission {
  kernelId: string;
  capabilityId: string;
  assuranceTier: 0 | 1 | 2 | 3;
  params: {
    schema: "madsci-workflow/v1";
    workflowName: string;
    workflow: MadsciWorkflow;
  };
}

/**
 * Translate a MADSci workflow into the body of POST /api/jobs/submit on the
 * PCC gateway. The original workflow is embedded under `params.workflow` so
 * the kernel (running MADSci itself) replays it verbatim.
 */
export function madsciWorkflowToPccJob(
  workflow: MadsciWorkflow,
  ctx: PccTranslationContext,
): PccJobSubmission {
  return {
    kernelId: ctx.kernelId,
    capabilityId: ctx.capabilityId,
    assuranceTier: ctx.assuranceTier ?? 1,
    params: {
      schema: "madsci-workflow/v1",
      workflowName: workflow.name,
      workflow,
    },
  };
}

export interface PccDeviceRegistration {
  kernelId: string;
  deviceId: string;
  type: "machine" | "sensor" | "camera";
  model: string;
  adapterType: "generic-http";
  adapterConfig: {
    url: string;
    protocol: "madsci-rest-node/v1";
  };
  capabilities: string[];
}

/**
 * Translate a MADSci node descriptor (from GET /nodes) into the body of
 * POST /api/setup/register-device on the PCC gateway. We bind to PCC's
 * `generic-http` adapter type and tag the protocol so the kernel knows
 * which client to instantiate.
 */
export function madsciNodeToPccDevice(
  node: MadsciNode,
  kernelId: string,
): PccDeviceRegistration {
  return {
    kernelId,
    deviceId: `madsci-${node.node_id}`,
    type: "machine",
    model: node.module_type,
    adapterType: "generic-http",
    adapterConfig: {
      url: node.url,
      protocol: "madsci-rest-node/v1",
    },
    capabilities: node.actions,
  };
}
