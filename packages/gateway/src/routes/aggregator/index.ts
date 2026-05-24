/**
 * Universal aggregator routes barrel.
 *
 * Registers all /api/aggregator/* routes on the gateway.
 * Wired into server.ts via `await app.register(aggregatorRoutes)`.
 *
 * Routes (Phase 1):
 *   POST  /api/aggregator/ingest/mcp        — admin-gated MCP source ingest
 *   POST  /api/aggregator/ingest/openapi    — admin-gated OpenAPI ingest
 *   GET   /api/aggregator/tools/search      — public registry query
 *   POST  /api/aggregator/invoke/:toolId    — public invoke proxy + receipt
 *   GET   /api/aggregator/receipts/:cid     — public receipt lookup
 *
 * The IndexedToolRegistry is process-singleton (Phase 1 in-memory).
 * Phase 2 swaps in a DB-backed registry while preserving these route shapes.
 */

import type { FastifyInstance } from "fastify";
import { IndexedToolRegistry } from "@pcc/aggregator";
import { ingestRoutes } from "./ingest.js";
import { searchRoutes } from "./search.js";
import { invokeRoutes } from "./invoke.js";
import { receiptsRoutes } from "./receipts.js";

/** Process-singleton registry used by every aggregator route. */
let _registry: IndexedToolRegistry | undefined;

export function getAggregatorRegistry(): IndexedToolRegistry {
  if (!_registry) _registry = new IndexedToolRegistry();
  return _registry;
}

/** For tests — reset the singleton between cases. */
export function _resetAggregatorRegistryForTests(): void {
  _registry = undefined;
}

export async function aggregatorRoutes(app: FastifyInstance): Promise<void> {
  await app.register(ingestRoutes);
  await app.register(searchRoutes);
  await app.register(invokeRoutes);
  await app.register(receiptsRoutes);
}
