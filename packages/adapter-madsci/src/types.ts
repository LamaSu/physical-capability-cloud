/**
 * MADSci type mirror. Targets the AD-SDL/MADSci framework workflow.yaml schema.
 * Source of truth: github.com/AD-SDL/MADSci — madsci.common.types.workflow_types.
 *
 * The schema is conservative: required fields tracked here; the rest passes
 * through as `args: Record<string, unknown>` to avoid coupling to a moving
 * upstream surface. If MADSci v1 freezes specific fields, tighten here.
 */

import { z } from "zod";

export const MadsciActionSchema = z.object({
  /** Robot or node identifier — must match a node registered in the lab config. */
  node: z.string().min(1),
  /** Action name as advertised by the node's /info endpoint. */
  action: z.string().min(1),
  /** Action arguments — opaque key/value bag, validated by the node. */
  args: z.record(z.unknown()).optional(),
  /** Optional locations (source/target) for transfer-style actions. */
  locations: z.record(z.string()).optional(),
  /** Optional step name for logs / dashboards. */
  name: z.string().optional(),
});

export const MadsciStepSchema = z.object({
  /** Step identifier (unique within a workflow). */
  name: z.string().min(1),
  /** The action this step performs. */
  action: MadsciActionSchema,
  /** Optional pre-conditions referencing prior step outputs (e.g. "after: step-1"). */
  after: z.array(z.string()).optional(),
});

export const MadsciWorkflowSchema = z.object({
  /** Schema version — defaults to "madsci/v1" if absent. */
  schema: z.string().default("madsci/v1"),
  /** Workflow identifier (file-name-style slug). */
  name: z.string().min(1),
  /** Human description. */
  description: z.string().optional(),
  /** Top-level metadata bag (lab id, experimenter, etc.). */
  metadata: z.record(z.unknown()).optional(),
  /** Ordered list of steps. */
  steps: z.array(MadsciStepSchema).min(1),
});

export type MadsciAction = z.infer<typeof MadsciActionSchema>;
export type MadsciStep = z.infer<typeof MadsciStepSchema>;
export type MadsciWorkflow = z.infer<typeof MadsciWorkflowSchema>;

/** A MADSci node as returned by Workcell Manager's GET /nodes endpoint. */
export interface MadsciNode {
  /** Node identifier (matches `action.node` in steps). */
  node_id: string;
  /** Node-class label (RestNode, etc). */
  module_type: string;
  /** Base URL (host:port) the node accepts REST calls on. */
  url: string;
  /** Action names this node advertises. */
  actions: string[];
  /** Last-known health: "ready" | "busy" | "offline" | "error". */
  status?: string;
}

/** Default MADSci microservice ports per README. */
export const MADSCI_DEFAULT_PORTS = {
  event_manager: 8001,
  experiment_manager: 8002,
  resource_manager: 8003,
  data_manager: 8004,
  workcell_manager: 8005,
  location_manager: 8006,
} as const;
