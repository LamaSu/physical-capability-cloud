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

// ---------------------------------------------------------------------------
// Publisher (outbound) — mirror of SourceAdapter on the push side
// ---------------------------------------------------------------------------

/**
 * Per-call input given to a publisher.
 *
 * Auth tokens, endpoint overrides, and the cosign injection seam live
 * here. The pipeline supplies these per-tool; tests inject stubs.
 */
export interface PublisherInput {
  /** Auth token (e.g. OIDC bearer for AGNTCY). */
  authToken?: string;
  /** Endpoint override (defaults to publisher's configured endpoint). */
  endpoint?: string;
  /** Whether to also announce on the DHT after pushing OCI. Default true. */
  announce?: boolean;
  /** Test injection seam — replaces global fetch in unit tests. */
  fetchImpl?: typeof fetch;
  /** Shell-out impl for cosign (Phase 1) — injectable for tests. */
  cosignSpawn?: CosignSpawn;
}

/**
 * Cosign shell-out shape — Phase 1 uses `cosign sign-blob --new-bundle-format`
 * via child_process; Phase 2 swaps in `@sigstore/sign` in-process.
 *
 * Returns the signature bundle as a string (typically a JSON blob with
 * Rekor inclusion proof + Fulcio cert chain).
 */
export interface CosignSpawn {
  (input: CosignInput): Promise<string>;
}

export interface CosignInput {
  /** Bytes to sign. Pass the canonical OASF record JSON. */
  payload: Uint8Array;
  /** Path to cosign binary (default: lookup on PATH). */
  cosignBinary?: string;
  /** OIDC issuer URL (default Sigstore public Fulcio). */
  oidcIssuer?: string;
  /** OIDC client id (default "sigstore"). */
  oidcClientId?: string;
  /** OIDC bearer token (allows non-interactive flow). */
  identityToken?: string;
}

/** Outcome of a single publish attempt. */
export interface PublishResult {
  /** External CID assigned by the target registry. Empty on hard failure. */
  externalCid: string;
  /** Whether the DHT-announce step succeeded. */
  announced: boolean;
  /** Sigstore bundle reference (e.g. "rekor:<index>"). */
  sigstoreBundle?: string;
  /** Errors collected during publish. Empty on full success. */
  errors: string[];
}

/**
 * A Publisher pushes one IndexedTool to an external registry. Mirror of
 * SourceAdapter on the outbound side.
 *
 * Publishers MUST be idempotent: republishing the same IndexedTool MUST
 * yield the same externalCid and MUST NOT create duplicate index entries
 * at the target. The pipeline relies on this for safe re-emit on
 * recovery.
 */
export interface Publisher {
  /** Stable publisher ID (e.g. "agntcy-ads"). */
  readonly id: string;
  /** Which IndexedTool.source.type the publisher writes to. */
  readonly targetType: ToolSourceType;
  /**
   * Push one IndexedTool. Returns the external CID/ID and any
   * non-fatal errors. Hard failures throw.
   */
  publish(tool: IndexedTool, opts: PublisherInput): Promise<PublishResult>;
}
