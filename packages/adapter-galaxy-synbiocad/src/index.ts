/**
 * @pcc/adapter-galaxy-synbiocad — Galaxy-SynBioCAD digital-kernel adapter.
 *
 * Exposes the brsynth/galaxytools synthetic-biology & metabolic-engineering
 * tool suite (~50 stable tools) as a PCC digital kernel. Ships a JSON-Schema
 * capability catalog agents pick from, and one catalog-driven executor that
 * runs any tool over the Galaxy REST API (or a deterministic mock).
 *
 * Quick start (mock, no server):
 *
 *   import { GalaxySynBioCadKernel, listTools } from "@pcc/adapter-galaxy-synbiocad";
 *
 *   const kernel = new GalaxySynBioCadKernel({
 *     endpointURL: "https://my-kernel.example.com/run",
 *     builderAgentId: "eip155:84532:0xMyAgent",
 *     mockMode: true,
 *   });
 *   const tools = kernel.capabilities();            // the menu (w/ input/output schemas)
 *   const out = await kernel.execute({              // run one
 *     tool_id: "retropath2",
 *     params: { rulesfile: "hda:abc", source_inchi: "InChI=1S/...", max_steps: 3 },
 *   });
 *
 * Going live: pass `mockMode:false` + `galaxyUrl`/`galaxyApiKey` (or env
 * GALAXY_URL / GALAXY_API_KEY).
 */

// Catalog + selection
export {
  getCatalog,
  listTools,
  getTool,
  requireTool,
  toolsByStage,
  searchTools,
  toWorkflowStep,
  PIPELINE_STAGES,
} from "./catalog.js";
export type { ListToolsOptions } from "./catalog.js";

// Validation
export { validateParams } from "./validate.js";
export type { ValidationError, ValidationResult } from "./validate.js";

// Transports
export { MockGalaxyClient } from "./mock-galaxy-client.js";
export type { MockGalaxyClientOptions } from "./mock-galaxy-client.js";
export { GalaxyRestClient } from "./galaxy-client.js";
export type { GalaxyRestClientOptions } from "./galaxy-client.js";

// Adapter (manifest + executor + kernel)
export {
  GalaxySynBioCadKernel,
  buildGalaxySynBioCadManifest,
  buildStageWorkflowSteps,
  createGalaxyExecute,
  resolveGalaxyClient,
  GALAXY_SYNBIOCAD_CAPABILITY_TYPE,
} from "./adapter.js";
export type { GalaxyAdapterOptions, GalaxyJobInput } from "./adapter.js";

// Types
export type {
  GalaxyCatalog,
  GalaxyToolSpec,
  GalaxyParamSpec,
  GalaxyOption,
  GalaxyValidator,
  GalaxyOutputSpec,
  ToolStatus,
  JSONSchema,
  GalaxyClient,
  GalaxyDatasetRef,
  GalaxyParams,
  GalaxyRunInput,
  GalaxyRunResult,
  GalaxyRunState,
  GalaxyOutputArtifact,
} from "./types.js";
