/**
 * @pcc/cypher-lims-bridge
 *
 * Public surface of the bridge package. Re-exports CypherClient, the type
 * definitions, the federation <-> capability mapper, the LIMS poller, and
 * the six MCP-style tool handlers.
 *
 * Importers should typically pull what they need from the named exports
 * below; the package keeps one barrel for stable consumption.
 */

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
export { CypherClient, CypherApiError } from './client.js';
export type { CypherClientOptions } from './client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type {
  CypherApiResponse,
  CypherFederationService,
  CypherFederationStats,
  CypherLimsMeasurementBatch,
  CypherLimsMeasurementDataPoint,
  CypherLimsRecordWorkPayload,
  CypherLimsRequest,
  CypherLimsStep,
  CypherLimsWorkflow,
  CypherPaginationParams,
  CypherPricing,
  CypherProvider,
  CypherSourceInstance,
  CypherTurnaround,
  JsonSchemaDraft07,
  McpToolDefinition,
  PccCapabilityShape,
} from './types.js';

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------
export {
  cypherFederationServiceToMcpToolDef,
  cypherServiceToPccCapability,
  pccCapabilityToCypherService,
} from './mapper.js';

// ---------------------------------------------------------------------------
// Poller
// ---------------------------------------------------------------------------
export { LimsPoller } from './poller.js';
export type { LimsPollerEvents, LimsPollerOptions } from './poller.js';

// ---------------------------------------------------------------------------
// Tools (MCP-style handlers + definitions array)
// ---------------------------------------------------------------------------
export {
  cypherAdvanceStep,
  cypherBrowseFederationCatalog,
  cypherGetLimsRequest,
  cypherListLimsRequests,
  cypherPostMeasurement,
  cypherRecordWork,
  cypherToolDefinitions,
  cypherToolHandlers,
} from './tools.js';
export type { CypherToolHandler } from './tools.js';
