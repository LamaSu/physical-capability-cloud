/**
 * @pcc/adapter-madsci — ingest, translate, run MADSci workflows on PCC.
 *
 * Public surface:
 *   parseMadsciWorkflow(yamlText)            — YAML → typed Workflow
 *   madsciWorkflowToPccJob(wf, ctx)          — Workflow → PCC job body
 *   madsciNodeToPccDevice(node, kernelId)    — Node → PCC device body
 *   MadsciClient                              — REST client for Workcell Mgr
 *   discoverMadsciLab(opts, kernelId)        — list nodes, emit PCC devices
 */

export { parseMadsciWorkflow, MadsciParseError } from "./parser.js";
export { MadsciClient } from "./client.js";
export type { MadsciClientOptions } from "./client.js";
export {
  madsciWorkflowToPccJob,
  madsciNodeToPccDevice,
} from "./translator.js";
export type {
  PccTranslationContext,
  PccJobSubmission,
  PccDeviceRegistration,
} from "./translator.js";
export { discoverMadsciLab } from "./discovery.js";
export type { DiscoveryResult } from "./discovery.js";
export {
  MadsciActionSchema,
  MadsciStepSchema,
  MadsciWorkflowSchema,
  MADSCI_DEFAULT_PORTS,
} from "./types.js";
export type {
  MadsciAction,
  MadsciStep,
  MadsciWorkflow,
  MadsciNode,
} from "./types.js";
