// @pcc/template-data-product — public API.
//
// The canonical entry point is the manifest (default export). Importers do:
//   import manifest from "@pcc/template-data-product";
//   import { templates } from "@pcc/orchestrator-sdk";
//   templates.register(manifest);

export { default as manifest, default } from "./manifest.js";
export { DATA_PRODUCT_SYSTEM_PROMPT, getDataProductSystemPrompt } from "./system-prompt.js";
export {
  ALL_STATES,
  canTransition,
  nextStates,
  type DataProductState,
  type DataProductSession,
} from "./flow.js";
