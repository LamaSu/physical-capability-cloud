/**
 * Crawler Worker — long-running entrypoint that periodically polls MCP
 * registries and pushes the discovered tools through the 6-stage pipeline.
 *
 * Designed to run as a separate process from the gateway (not inside the
 * request loop) so a slow crawl never blocks an API call. Run it as a
 * systemd unit, a Railway service, or a sidecar container.
 *
 * Usage:
 *   node dist/crawler-worker.js              # default: 1h interval, all registries
 *   PCC_CRAWLER_INTERVAL_MS=900000 node dist/crawler-worker.js
 *   PCC_CRAWLER_REGISTRIES=smithery,glama node dist/crawler-worker.js
 *   PCC_CRAWLER_RUN_ONCE=1 node dist/crawler-worker.js   # one-shot mode for cron
 *
 * Environment variables:
 *   PCC_CRAWLER_INTERVAL_MS    Polling interval in ms (default 3_600_000 = 1h)
 *   PCC_CRAWLER_REGISTRIES     CSV of registries to crawl (default all 4)
 *   PCC_CRAWLER_QUERY          Optional search query (default empty = all)
 *   PCC_CRAWLER_MAX_SERVERS    Max servers contacted per registry (default 50)
 *   PCC_CRAWLER_RUN_ONCE       If set to "1"/"true", crawl once and exit
 *   PCC_SMITHERY_API_KEY       Smithery API key (optional, lower-res without)
 *
 * The worker:
 *   1. Constructs an MCPRegistryCrawler and an IndexedToolRegistry.
 *   2. Runs an initial crawl immediately.
 *   3. Schedules subsequent crawls every PCC_CRAWLER_INTERVAL_MS.
 *   4. Logs per-registry totals + errors to stdout (one JSON line per event).
 *   5. Handles SIGINT / SIGTERM gracefully — finishes the current crawl
 *      before exiting.
 *
 * Phase 1 scope: registry stays in-process. Phase 2 hands the published
 * tools off to the gateway via a POST to /api/aggregator/ingest so the
 * server-side registry stays in sync.
 *
 * See: ai/research/universal-tool-aggregator-2026-05-23.md §6 (operations)
 */

import { IndexedToolRegistry } from "./registry.js";
import { runPipeline } from "./pipeline.js";
import {
  MCPRegistryCrawler,
  type SupportedRegistry,
} from "./sources/mcp-registry-crawler.js";
import type { IndexedTool, ToolSourceType } from "@pcc/spec";
import type { SourceAdapter, AdapterInput } from "./types.js";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const ALL_REGISTRIES: SupportedRegistry[] = [
  "smithery",
  "glama",
  "mcp.directory",
  "mcp.so",
];

/** Resolved worker config (after env parsing). */
export interface CrawlerWorkerConfig {
  intervalMs: number;
  registries: SupportedRegistry[];
  query?: string;
  maxServers: number;
  runOnce: boolean;
}

/**
 * Parse the env-driven configuration. Exported so tests can drive the same
 * resolution logic without spawning the binary.
 */
export function parseCrawlerWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): CrawlerWorkerConfig {
  const intervalMsRaw = env.PCC_CRAWLER_INTERVAL_MS;
  const intervalMs =
    intervalMsRaw && !Number.isNaN(Number(intervalMsRaw))
      ? Math.max(60_000, Number(intervalMsRaw)) // floor at 1 minute
      : DEFAULT_INTERVAL_MS;

  const registriesRaw = env.PCC_CRAWLER_REGISTRIES;
  const registries: SupportedRegistry[] = registriesRaw
    ? registriesRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is SupportedRegistry =>
          (ALL_REGISTRIES as string[]).includes(s),
        )
    : ALL_REGISTRIES;

  const maxServers = env.PCC_CRAWLER_MAX_SERVERS
    ? Math.max(1, Number(env.PCC_CRAWLER_MAX_SERVERS))
    : 50;

  const runOnce = env.PCC_CRAWLER_RUN_ONCE === "1" || env.PCC_CRAWLER_RUN_ONCE === "true";

  return {
    intervalMs,
    registries: registries.length > 0 ? registries : ALL_REGISTRIES,
    query: env.PCC_CRAWLER_QUERY,
    maxServers,
    runOnce,
  };
}

/** Structured log line. */
function log(event: string, fields: Record<string, unknown> = {}): void {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      worker: "crawler-worker",
      event,
      ...fields,
    }),
  );
}

/**
 * Run one crawl across every configured registry, pushing each registry's
 * drafts through the 6-stage pipeline so they normalize + publish into the
 * registry. Returns per-registry totals.
 */
export async function runOneCrawl(
  crawler: MCPRegistryCrawler,
  registry: IndexedToolRegistry,
  config: CrawlerWorkerConfig,
): Promise<Record<SupportedRegistry, { published: number; errors: number }>> {
  const totals: Partial<
    Record<SupportedRegistry, { published: number; errors: number }>
  > = {};

  for (const reg of config.registries) {
    log("crawl_start", { registry: reg });
    const crawl = await crawler.crawl(reg);
    log("crawl_listing_done", {
      registry: reg,
      servers_contacted: crawl.serversContacted,
      drafts: crawl.drafts.length,
      errors: Object.keys(crawl.errors).length,
    });

    // Bypass adapter.fetch — feed pre-fetched drafts into a passthrough adapter
    // so we still get transform/enrich/publish behavior.
    const passthrough = makePassthroughAdapter(reg, crawl.drafts);
    const result = await runPipeline(
      passthrough,
      { url: `pcc-crawler://${reg}` },
      registry,
    );

    totals[reg] = {
      published: result.published.length,
      errors: result.errors.length,
    };
    log("crawl_pipeline_done", {
      registry: reg,
      published: result.published.length,
      pipeline_errors: result.errors,
    });
  }

  return totals as Record<
    SupportedRegistry,
    { published: number; errors: number }
  >;
}

/**
 * Wrap a pre-fetched IndexedTool[] in a SourceAdapter so we can reuse the
 * pipeline transform/enrich/verify/publish stages without re-hitting the
 * upstream.
 */
function makePassthroughAdapter(
  registry: SupportedRegistry,
  drafts: IndexedTool[],
): SourceAdapter {
  const sourceTypeMap: Record<SupportedRegistry, ToolSourceType> = {
    smithery: "smithery",
    glama: "glama",
    "mcp.directory": "mcp-directory",
    "mcp.so": "mcp-so",
  };
  return {
    id: `passthrough-${registry}`,
    sourceType: sourceTypeMap[registry],
    async fetch(_input: AdapterInput): Promise<IndexedTool[]> {
      return drafts;
    },
  };
}

/**
 * Main loop. Exported so external schedulers can call it; the file's bin
 * entrypoint also calls it when invoked directly.
 */
export async function main(
  envConfig: CrawlerWorkerConfig = parseCrawlerWorkerConfig(),
): Promise<void> {
  const config = envConfig;
  log("startup", {
    interval_ms: config.intervalMs,
    registries: config.registries,
    max_servers: config.maxServers,
    query: config.query,
    run_once: config.runOnce,
  });

  const registry = new IndexedToolRegistry();
  const crawler = new MCPRegistryCrawler({
    maxServers: config.maxServers,
    query: config.query,
  });

  let stopping = false;
  let timer: NodeJS.Timeout | undefined;

  const onSignal = (sig: string) => {
    log("shutdown_signal", { signal: sig });
    stopping = true;
    if (timer) clearTimeout(timer);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  const tick = async () => {
    try {
      const totals = await runOneCrawl(crawler, registry, config);
      log("crawl_complete", {
        registry_size: registry.count(),
        totals,
      });
    } catch (err) {
      log("crawl_error", {
        message: err instanceof Error ? err.message : String(err),
      });
    }

    if (stopping || config.runOnce) {
      log("exit", { reason: config.runOnce ? "run_once" : "shutdown_signal" });
      return;
    }

    timer = setTimeout(tick, config.intervalMs);
  };

  await tick();
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------
// Run the worker when this file is invoked directly (`node dist/crawler-worker.js`).
// Use the ESM-friendly check on import.meta.url rather than require.main.

const invokedDirectly =
  typeof import.meta !== "undefined" &&
  import.meta.url ===
    (typeof process !== "undefined" && process.argv[1]
      ? new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href
      : "");

if (invokedDirectly) {
  main().catch((err) => {
    log("fatal", {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  });
}
