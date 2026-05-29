/**
 * @pcc/kernel-automata-linq — Automata LINQ → PCC kernel binding.
 *
 * ENTERPRISE GATED. LINQ Cloud configuration values (`api_domain`,
 * `auth0_domain`, `client_id`) are provided only by an Automata
 * Customer Success Manager. The method surface here mirrors the
 * documented Python SDK (`linq.client.Linq`) verb methods.
 *
 * Public surface:
 *   LinqClient                       — Auth0 client-credentials client
 *   linqWorkflowToMadsci(wf)         — LINQ → MADSci (one-way collapse)
 *   madsciWorkflowToLinq(wf, wc)     — MADSci → LINQ (round-trip)
 *   buildLinqKernelManifest(opts)    — DigitalKernelManifest for PCC
 *   forwardJobToLinq(client, job)    — PCC job → LINQ run
 *   exportLinqWorkflowsAsMadsci(...) — bulk LINQ → MADSci dump
 *   RunStateChangeHook,
 *   TaskStateChangeHook,
 *   SafetyStateChangeHook,
 *   LabwareMovementHook,
 *   NewPlanHook,
 *   parseHook(event, payload)        — typed webhook dispatch
 */

export { LinqClient, LinqAuthError } from "./client.js";
export type { LinqClientOptions } from "./client.js";
export { linqWorkflowToMadsci, madsciWorkflowToLinq } from "./translator.js";
export {
  buildLinqKernelManifest,
  forwardJobToLinq,
  exportLinqWorkflowsAsMadsci,
} from "./kernel.js";
export type { LinqKernelOptions, LinqKernelRunHandle } from "./kernel.js";
export {
  LinqWorkcellSchema,
  LinqInstrumentSchema,
  LinqWorkflowSchema,
  LinqTaskSchema,
  LinqLabwareSchema,
  LinqRunSchema,
} from "./types.js";
export type {
  LinqWorkcell,
  LinqInstrument,
  LinqWorkflow,
  LinqTask,
  LinqLabware,
  LinqRun,
} from "./types.js";
export {
  RunStateChangeHook,
  TaskStateChangeHook,
  SafetyStateChangeHook,
  LabwareMovementHook,
  NewPlanHook,
  RunStateChangeHookSchema,
  TaskStateChangeHookSchema,
  SafetyStateChangeHookSchema,
  LabwareMovementHookSchema,
  NewPlanHookSchema,
  parseHook,
} from "./hooks.js";
export type { LinqHook, LinqHookEventType } from "./hooks.js";

/**
 * Status of this package's coupling to the upstream LINQ API. Verified
 * against the Automata dossier (2026-05-28) — auth + method surface
 * now match the documented Python SDK contract. REST paths underneath
 * the verb methods remain unverified against a live sandbox.
 */
export const LINQ_COUPLING_STATUS = {
  resourceModel: "verified-against-dossier",
  methodSurface: "verified-against-dossier (snake_case verb methods)",
  endpointPaths: "unverified (REST layer not authoritative; SDK is the contract)",
  authScheme: "verified-against-dossier (Auth0 client-credentials)",
  webhookSurface: "verified-against-dossier (5 per-Workflow Hook classes)",
  sandboxAccess: "needs enterprise contact",
  contact: "hello@automata.tech",
} as const;
