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
  Publisher,
  PublisherInput,
  PublishResult,
  CosignSpawn,
  CosignInput,
} from "./types.js";
export * from "./sources/index.js";
export * from "./publishers/index.js";
export { signReceipt, verifyReceiptSignature, signAndAnchorReceipt } from "./receipt-signer.js";
export type { ReceiptSignerKey } from "./receipt-signer.js";
export {
  ReceiptAnchorClient,
  createReceiptAnchorClient,
  buildAnchorRequest,
} from "./receipt-anchor-client.js";
export type {
  AnchorOutcome,
  AnchorRequest,
  BatchFlushResult,
  BatchManifest,
  BatchManifestStorage,
  ChainBackend,
  ReceiptAnchorClientConfig,
} from "./receipt-anchor-client.js";
export {
  buildMerkleTree,
  getMerkleProof,
  verifyMerkleProof,
  cidToBytes32,
  hashPairSorted,
} from "./merkle.js";
export type { Bytes32Hex, MerkleTree } from "./merkle.js";
export {
  toAtomicUsdc,
  decimalUsdc,
  isPaidPrice,
  priceTagHmac,
  verifyPriceTag,
} from "./pricing.js";
export type { PriceTagFields } from "./pricing.js";
export {
  verifyWithFacilitator,
  settleWithFacilitator,
  FacilitatorNetworkError,
} from "./x402-facilitator.js";
export type { X402FacilitatorConfig } from "./x402-facilitator.js";
export { NonceCache } from "./x402-nonce-cache.js";
export type { NonceCacheEntry, NonceCacheOptions } from "./x402-nonce-cache.js";
export { requirePayment, recordSettlement } from "./x402-gate.js";
export type {
  X402GateConfig,
  GateRequestContext,
  GateVerdict,
  SettleOutcome,
} from "./x402-gate.js";
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
export {
  RegistryRankerBridge,
  createRegistryRanker,
} from "./ranking-bridge.js";
