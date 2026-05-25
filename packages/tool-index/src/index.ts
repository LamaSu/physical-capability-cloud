/**
 * @pcc/tool-index — public surface
 *
 * Phase 1 of the BigTool-style retrieval substrate for PCC's 218-tool
 * agent-package.json catalog. Phase 3 will add loaders for external MCP
 * servers, OpenAPI specs, and skills — the IndexedTool shape is designed
 * to be source-agnostic for that future work.
 */

export type {
  IndexedTool,
  ToolEndpoint,
  ToolSearchHit,
  ToolSource,
} from "./types.js";

export type { EmbeddingProvider } from "./embeddings.js";
export {
  HashFallbackProvider,
  OpenAIEmbeddingProvider,
  maskSecrets,
  selectEmbeddingProvider,
} from "./embeddings.js";

export { ToolIndex } from "./index-store.js";
export type { SearchOptions } from "./index-store.js";

export {
  loadAgentPackage,
  indexAgentPackage,
  mapAgentPackageTool,
} from "./loaders/agent-package.js";
