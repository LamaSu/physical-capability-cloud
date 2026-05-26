/**
 * Source-adapter barrel.
 *
 * Each source-adapter exports a class (the adapter) plus a thin factory
 * function for tests. Additional adapters add a line here as they're
 * implemented.
 */

export { McpSourceAdapter, makeMcpSourceAdapter } from "./mcp.js";
export { OpenApiSourceAdapter, makeOpenApiSourceAdapter } from "./openapi.js";
export {
  MCPRegistryCrawler,
  makeMCPRegistryCrawler,
  type SupportedRegistry,
  type MCPRegistryCrawlerOptions,
  type CrawlResult,
} from "./mcp-registry-crawler.js";
export {
  AgntcyAdsSourceAdapter,
  makeAgntcyAdsSourceAdapter,
  oasfToIndexedTool,
  inferActionClassFromSkills,
  type AgntcyAdsAdapterOptions,
  type OasfRecord,
} from "./agntcy-ads.js";
