/**
 * Aggregator-internal types.
 *
 * Pipeline interfaces, source-adapter contract, and engine-wide options.
 * The canonical IndexedTool / InvocationReceipt / DigitalCaptureClass
 * types live in @pcc/spec; this file only declares the engine-side
 * orchestration shapes that wire source-adapters into the 6-stage
 * pipeline.
 *
 * See: ai/research/universal-tool-aggregator-2026-05-23.md §2.2
 */

import type { IndexedTool, ToolSourceType } from "@pcc/spec";

/**
 * A source-adapter knows how to ingest tools from one upstream surface
 * (an MCP server, an OpenAPI doc, an A2A agent card, ...). The pipeline
 * iterates over registered adapters during the Discovery + Fetch stages.
 *
 * Each adapter is responsible for converting whatever upstream emits into
 * one or more IndexedTool records. The pipeline takes care of the rest
 * (transform normalization, enrich, verify, publish).
 *
 * The `id` is a short stable identifier used for logging + metrics.
 */
export interface SourceAdapter {
  /** Short stable identifier (e.g. "mcp", "openapi", "a2a-card"). */
  readonly id: string;
  /** Which IndexedTool.source.type the adapter produces. */
  readonly sourceType: ToolSourceType;
  /**
   * Fetch + transform the upstream surface into IndexedTool drafts.
   *
   * "Draft" means: fields the adapter can populate from upstream alone
   * (id, source, upstreamUrl, skills, inputSchema, description, ...).
   * The pipeline enrichment + verification stages fill in the rest
   * (trustTier, vetReport, cpFiveMcpScore, drift state, etc.).
   *
   * If the upstream is unreachable, the adapter should throw — the
   * pipeline catches and emits a per-adapter failure to telemetry.
   */
  fetch(input: AdapterInput): Promise<IndexedTool[]>;
}

/** Per-call input given to a source-adapter. */
export interface AdapterInput {
  /** The URL / endpoint the adapter is being pointed at. */
  url: string;
  /** Optional headers (e.g. API keys) the upstream needs. */
  headers?: Record<string, string>;
  /** Optional fetcher override for tests / mock harnesses. */
  fetchImpl?: typeof fetch;
}

/** Options the pipeline accepts per-run. */
export interface PipelineRunOptions {
  /**
   * If true, run the verify stage (Gate A style). Defaults to false in
   * Phase 1 because the full harness vet pipeline isn't wired into the
   * aggregator yet — the gateway routes carry the verification policy.
   */
  runVerify?: boolean;
  /**
   * Whether the publish stage should write to the in-process registry.
   * Defaults to true. Useful to set false in dry-run / preview modes.
   */
  publishToRegistry?: boolean;
}

/** Per-stage report emitted during a pipeline run (for observability). */
export interface PipelineStageReport {
  stage: PipelineStage;
  startedAt: string;
  endedAt: string;
  /** Number of IndexedTool drafts the stage processed. */
  processed: number;
  /** Number that succeeded the stage. */
  succeeded: number;
  /** Per-tool errors keyed by IndexedTool.id (or "" for source-wide). */
  errors: Record<string, string>;
}

/** The 6 ingestion stages, in order. */
export type PipelineStage =
  | "discover"
  | "fetch"
  | "transform"
  | "enrich"
  | "verify"
  | "publish";

/** Result of one full pipeline run. */
export interface PipelineRunResult {
  /** Adapter id that the run was pointed at. */
  adapterId: string;
  /** ISO 8601 start timestamp. */
  startedAt: string;
  /** ISO 8601 end timestamp. */
  endedAt: string;
  /** Per-stage breakdown. */
  stages: PipelineStageReport[];
  /** Final IndexedTool[] published (or that would have been). */
  published: IndexedTool[];
  /** Top-level errors not bound to any stage (e.g. adapter throw). */
  errors: string[];
}
