/**
 * @pcc/aggregator — universal tool aggregator engine.
 *
 * Phase 1 deliverables:
 *   - 6-stage pipeline (discover -> fetch -> transform -> enrich -> verify -> publish)
 *   - In-memory IndexedTool registry
 *   - MCP + OpenAPI source-adapters
 *   - Receipt signer (HMAC-SHA256 for DCC1)
 *
 * Consumers wire this into the gateway via /api/aggregator/* routes.
 *
 * Deferred to Phase 2+: x402 micropayments, Vespa hybrid ranking,
 * 4-level federation, on-chain receipt anchoring, AGNTCY ADS DHT,
 * DCC4/5 flow implementations.
 */

export {
  IndexedToolRegistry,
  type RegistryQuery,
  type RegistryRegionContext,
  type IndexedToolRegistryOpts,
} from "./registry.js";
export {
  NoOpReplicator,
  type ReplicatorAdapter,
} from "./replicator.js";
export {
  runPipeline,
  computeToolCid,
  computeJsonHash,
} from "./pipeline.js";
export type {
  SourceAdapter,
  AdapterInput,
  PipelineRunOptions,
  PipelineRunResult,
  PipelineStage,
  PipelineStageReport,
} from "./types.js";
export * from "./sources/index.js";
export { signReceipt, verifyReceiptSignature } from "./receipt-signer.js";
export type { ReceiptSignerKey } from "./receipt-signer.js";
export {
  assertSafeFetchUrl,
  assertSafeFetchUrlWithDns,
  SSRFRejected,
} from "./url-guard.js";
export type { HostResolver, UrlGuardOptions } from "./url-guard.js";
export {
  sanitizeToolDescription,
  sanitizeToolDescriptions,
  isExternalSourceType,
} from "./sanitize-descriptions.js";
export {
  main as runCrawlerWorker,
  parseCrawlerWorkerConfig,
  runOneCrawl,
  type CrawlerWorkerConfig,
} from "./crawler-worker.js";
