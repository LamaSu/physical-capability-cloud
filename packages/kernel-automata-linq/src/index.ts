/**
 * @pcc/kernel-automata-linq — Automata LINQ → PCC kernel binding.
 *
 * ENTERPRISE GATED. The LINQ REST surface is documented at a conceptual
 * level (docs.automata.tech) but the authoritative endpoint paths +
 * auth scheme require a LINQ Cloud account. Paths in this module follow
 * SaaS-CRUD conventions; verify before production.
 *
 * Public surface:
 *   LinqClient                       — REST client (auth: Bearer API key)
 *   linqWorkflowToMadsci(wf)         — LINQ → MADSci (one-way collapse)
 *   madsciWorkflowToLinq(wf, wc)     — MADSci → LINQ (round-trip)
 *   buildLinqKernelManifest(opts)    — DigitalKernelManifest for PCC
 *   forwardJobToLinq(client, job)    — PCC job → LINQ run
 *   exportLinqWorkflowsAsMadsci(...) — bulk LINQ → MADSci dump
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

/**
 * Status of this package's coupling to the upstream LINQ API.
 * Update once a sandbox account is obtained and live shapes are verified.
 */
export const LINQ_COUPLING_STATUS = {
  resourceModel: "documented",
  endpointPaths: "best-guess (SaaS-CRUD convention)",
  authScheme: "assumed Bearer API key",
  sandboxAccess: "needs enterprise contact",
  contact: "support@automata.tech",
} as const;
