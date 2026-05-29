/**
 * IndexedTool — canonical internal form for any tool the aggregator catalogues.
 *
 * Superset of OASF (AGNTCY), MCP `Tool` (Anthropic), and OpenAPI `Operation`
 * (OAS 3.x). One IndexedTool entry represents one callable surface — whether
 * that's an MCP tool, a REST endpoint, an A2A skill, or a registered Claude
 * skill — normalized so the search index, ranking expression, and provenance
 * layer all operate on a single shape.
 *
 * See: ai/research/universal-tool-aggregator-2026-05-23.md §2.3 + Appendix B
 *
 * Notes on field-set choices:
 *
 * - `cid` is sha256 of the canonical JSON projection of the IndexedTool's
 *   *stable* fields (id, source, upstreamUrl, inputSchema, outputSchema,
 *   description, skills, actionClass, schemaHashHistory[-1]). This is the
 *   content-addressed identifier that propagates cleanly to IPFS/AGNTCY DHT.
 *   Volatile fields like `lastInvokedAt` and `invocationCount` are deliberately
 *   NOT part of the CID — otherwise the CID would change on every call.
 *
 * - `actionClass` reuses PCC's existing 5-class taxonomy from
 *   `~/.claude/plugins/action-policy.json` so the per-agent allowlist
 *   machinery already gates which agents may invoke which tools.
 *
 * - `assuranceCeiling` is a HARD CAP. A tool indexed from anonymous Common
 *   Crawl can never be invoked above DCC1 even if the caller asks for DCC5.
 *   This mirrors CVP's "ceiling" concept (capture.ts DetectionResult.ceiling).
 *
 * - `trustTier` is determined at ingest by the source + verification result.
 *   Not user-configurable. Promotion path: claim via GitHub OAuth ->
 *   federation agreement -> partner.
 *
 * - `cpFiveMcpScore` (0..13) carries the CP.5.MCP Security Profile result so
 *   consumers can filter for "minimum 10/13 controls passed".
 *
 * - `schemaHashHistory` is APPEND-ONLY. Each successful re-fetch that yields
 *   a different schema hash appends one entry. Used to detect drift (§10) and
 *   to bind invocation receipts to the exact schema version that was live at
 *   call time (`toolSchemaHashAtCall` in InvocationReceipt).
 *
 * Pure types + Zod schema; no runtime crypto, no fetch / IO.
 */

import { z } from "zod";
import type { Id, Timestamp, SHA256 } from "./common.js";
import { DigitalCaptureClass } from "./dcc.js";

// ---------------------------------------------------------------------------
// Trust tiers
// ---------------------------------------------------------------------------

/**
 * Six trust tiers governing what an indexed tool may be invoked as.
 *
 * Numeric ordering matches spec §7 (-1 .. 4). `QUARANTINED` (-1) means the
 * tool failed a critical Gate A check — still indexed for visibility, never
 * callable.
 */
export enum TrustTier {
  QUARANTINED = "QUARANTINED",
  UNTRUSTED = "UNTRUSTED",
  AUTO_INDEXED = "AUTO_INDEXED",
  VERIFIED_PUBLISHER = "VERIFIED_PUBLISHER",
  VERIFIED_PARTNER = "VERIFIED_PARTNER",
  PCC_NATIVE = "PCC_NATIVE",
}

/** Numeric ordering: -1 (QUARANTINED) .. 4 (PCC_NATIVE) per spec §7. */
export const TRUST_TIER_NUMERIC: Record<TrustTier, -1 | 0 | 1 | 2 | 3 | 4> = {
  [TrustTier.QUARANTINED]: -1,
  [TrustTier.UNTRUSTED]: 0,
  [TrustTier.AUTO_INDEXED]: 1,
  [TrustTier.VERIFIED_PUBLISHER]: 2,
  [TrustTier.VERIFIED_PARTNER]: 3,
  [TrustTier.PCC_NATIVE]: 4,
};

/**
 * Max DCC class each tier is allowed to attest at. QUARANTINED maps to a
 * sentinel (never invokable; consumer must check trustTier !== QUARANTINED
 * before calling). UNTRUSTED is the lowest invokable tier and caps at DCC1.
 */
export const TRUST_TIER_DCC_CEILING: Record<TrustTier, DigitalCaptureClass> = {
  [TrustTier.QUARANTINED]: DigitalCaptureClass.DCC0,
  [TrustTier.UNTRUSTED]: DigitalCaptureClass.DCC1,
  [TrustTier.AUTO_INDEXED]: DigitalCaptureClass.DCC2,
  [TrustTier.VERIFIED_PUBLISHER]: DigitalCaptureClass.DCC3,
  [TrustTier.VERIFIED_PARTNER]: DigitalCaptureClass.DCC4,
  [TrustTier.PCC_NATIVE]: DigitalCaptureClass.DCC5,
};

// ---------------------------------------------------------------------------
// Action class — PCC's existing 5-class taxonomy
// ---------------------------------------------------------------------------

/** Aligned with `~/.claude/plugins/action-policy.json`. */
export type IndexedToolActionClass =
  | "read"
  | "write"
  | "exec"
  | "network"
  | "credential";

// ---------------------------------------------------------------------------
// Source attribution
// ---------------------------------------------------------------------------

/** Which directory/feed/crawl this tool was discovered from. */
export type ToolSourceType =
  | "anthropic-registry"
  | "glama"
  | "mcp-so"
  | "smithery"
  | "pulsemcp"
  | "mcp-directory"
  | "apis-guru"
  | "common-crawl"
  | "agntcy-dht"
  | "nanda-index"
  | "well-known"
  | "user-submission"
  | "pcc-native"
  | "openapi-doc";

/** Attribution + ingest snapshot for a single tool source. */
export interface ToolSource {
  type: ToolSourceType;
  /** URL the tool descriptor was fetched from. */
  url: string;
  /** ISO 8601 timestamp the descriptor was fetched. */
  fetchedAt: Timestamp;
  /** Source-specific signal snapshot (e.g. Glama scorecard) for reproducibility. */
  scoreSnapshot?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Schema fragments (loose JSONSchema view)
// ---------------------------------------------------------------------------

/**
 * A loose JSON Schema view. The aggregator does not validate JSONSchema
 * structurally — it stores whatever the upstream returned and hashes it for
 * drift detection. Downstream consumers use Ajv or similar to validate
 * invocation arguments.
 */
export type JSONSchemaLoose = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Verification / vetting subset
// ---------------------------------------------------------------------------

/** Compact view of a vetting outcome. Full report lives in `ai/supervisor/`. */
export interface VetReportSummary {
  /**
   * Overall verdict from `harness vet`.
   *
   * - `UNVETTED`: default placeholder. The aggregator's verify stage runs
   *   without a real Gate A scan yet, so we MUST NOT emit a PASS until a
   *   real scanner result is supplied. Consumers downstream should treat
   *   UNVETTED as "not yet attestable" (i.e. cap at QUARANTINED / UNTRUSTED).
   * - `PASS`/`WARN`/`FAIL`: emitted only when an actual Gate A scan completed.
   */
  verdict: "UNVETTED" | "PASS" | "WARN" | "FAIL";
  /** Path to the full report on disk, relative to project root. */
  reportPath?: string;
  /** Number of critical vulnerabilities found (0 ideal). */
  critical: number;
  /** Number of high vulnerabilities found. */
  high: number;
  /** Number of secret findings (0 ideal). */
  secrets: number;
  /** True iff malware scanner flagged the artifact. */
  malware: boolean;
  /** True iff prompt-injection scanner found suspicious patterns in description. */
  promptInjection: boolean;
}

/** A drift alert raised when a tool's schema hash changes between fetches. */
export interface DriftAlertSummary {
  /** Detected drift type. */
  type:
    | "schema_changed"
    | "endpoint_404"
    | "auth_changed"
    | "tools_list_changed";
  severity: "low" | "medium" | "high" | "critical";
  /** ISO 8601 detection timestamp. */
  detectedAt: Timestamp;
  /** Free-form context (e.g. "added 2 fields to inputSchema, removed 1"). */
  message: string;
  /** Schema hashes flanking the drift. */
  fromSchemaHash?: SHA256;
  toSchemaHash?: SHA256;
}

// ---------------------------------------------------------------------------
// Federation hint (Phase 5)
// ---------------------------------------------------------------------------

/** A peer that also carries this tool's index entry. Phase 5 federation. */
export interface IndexedToolPeerEndpoint {
  /** Identifier per the federation peer registry. */
  peerId: string;
  /** Public endpoint where the peer serves /api/aggregator/. */
  url: string;
  /** Last successful sync with this peer (ISO 8601). */
  lastSeenAt: Timestamp;
}

// ---------------------------------------------------------------------------
// OASF round-trip (AGNTCY ADS bridge)
// ---------------------------------------------------------------------------

/**
 * One OASF module fragment, preserved verbatim for AGNTCY round-trip.
 *
 * OASF's `modules[]` is its extension mechanism — each module is a
 * `{name, data}` pair where `name` is the module slug (e.g.
 * `physical-capability/v1`) and `data` is the module-specific payload.
 *
 * Consumers that don't know the module slug safely ignore the data.
 *
 * See: ai/scoping/agntcy-ads-oasf-bridge-2026-05-23.md §3.4
 */
export interface OasfModule {
  name: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Pricing hint (scraped or vendor-provided)
// ---------------------------------------------------------------------------

/** Compact pricing hint surfaced in search results. Vendor's source-of-truth lives upstream. */
export interface PricingHint {
  /** Per-call cost in USDC. May be 0 for free tiers. */
  perCallUsdc: string;
  /** Per-1k-token cost where applicable (LLM-style tools). */
  perKTokenUsdc?: string;
  /** Vendor tier label (e.g. "free", "basic", "pro"). */
  tierLabel?: string;
  /** Whether the vendor has set a fixed price or accepts auctions. */
  mode?: "fixed" | "auction";
}

// ---------------------------------------------------------------------------
// Phase 1 federation extension (optional, additive)
// ---------------------------------------------------------------------------

/**
 * Per-region content-addressed reference for volatile CRDT state.
 *
 * Phase 1 (this commit): optional field on IndexedTool. When present,
 * the federation runtime materialises the actual CRDT state from the
 * referenced CIDs and merges them on read.
 *
 * The four CRDT slots map 1:1 to the volatile-field set per scope §7.3:
 *
 *   - invocationCountCid → G-Counter (grow-only per region/mesh)
 *   - successRateCid     → Tagged-Fraction (success/total per replica)
 *   - meanLatencyMsCid   → Tagged-Fraction (latency sum/count)
 *   - lastInvokedAtCid   → LWW-Register (timestamp + replica)
 *
 * Phase 2 wires the CRDT cross-region pull; Phase 1 leaves these
 * undefined and the gateway falls back to the scalar fields on
 * IndexedTool (invocationCount, successRate, ...).
 */
export interface IndexedToolVolatileRefs {
  invocationCountCid?: SHA256;
  successRateCid?: SHA256;
  meanLatencyMsCid?: SHA256;
  lastInvokedAtCid?: SHA256;
// TEE profile (DCC4 capability declaration)
// ---------------------------------------------------------------------------

/**
 * TEE platform vendors PCC understands at DCC4. See scope doc §1.1.
 *
 * Phase 1 ships `intel-tdx` + `phala-cloud` (Dstack wraps TDX) + `dstack` (raw).
 * `intel-sgx` is kept for legacy. `amd-sev-snp` and `aws-nitro` are listed but
 * Phase 1 only provides verifier shims (full adapter is Phase 2 per scope §1.4).
 */
export type TeeVendor =
  | "intel-tdx"
  | "intel-sgx"
  | "amd-sev-snp"
  | "aws-nitro"
  | "phala-cloud"
  | "dstack";

/**
 * Expected TEE measurement set a tool advertises at registration time.
 *
 * Set by the operator via POST /api/aggregator/indexed-tools/:id/claim-tee.
 * Without a `teeProfile` an IndexedTool's `assuranceCeiling` cannot exceed
 * DCC3 (scope §2.3). The profile is the allowlist PCC checks every observed
 * quote against during invocation.
 */
export interface TeeProfile {
  /** Vendor — drives which verifier shim handles the quote. */
  vendor: TeeVendor;
  /** Expected MRTD (TDX) / MRENCLAVE (SGX) / image-id (Nitro), hex 48-byte. */
  expectedMeasurement: string;
  /** Optional RTMR0..3 (TDX runtime measurements) for finer match. */
  expectedRtmr?: [string, string, string, string];
  /** Optional MRSIGNER (SGX only). */
  expectedSigner?: string;
  /** Nitro: expected PCR0..PCR4 set, 48-byte SHA384 each. */
  expectedPcrs?: Record<string, string>;
  /** Quote format version expected (e.g. "tdx-v4", "tdx-v5", "nitro-v1"). */
  quoteFormat: string;
  /** Where the operator-registered measurement set is sourced (URL to manifest). */
  manifestUrl?: string;
}

// ---------------------------------------------------------------------------
// Execution proof profile (DCC5 S1 — faithful execution declaration)
// ---------------------------------------------------------------------------

/** Supported zkSNARK / zkVM proving systems. See scope doc §3.7. */
export type ZkSystem = "sp1" | "risc0" | "noir" | "halo2" | "plonky3";

/**
 * Operator-uploaded execution-proof profile (DCC5 Statement S1).
 *
 * S1 is "faithful proxy execution" — operator compiles their tool for a zkVM
 * and uploads the ELF + verification key. PCC then proves on-the-fly using
 * Boundless. S2 (TEE-wrap) does NOT use this profile — S2 is automatic once
 * DCC4 (`teeProfile`) is claimed. See scope §3.4.
 */
export interface ExecutionProofProfile {
  /** Proving system: "sp1" | "risc0" | "noir" | "halo2" | "plonky3". */
  zkSystem: ZkSystem;
  /** Content-addressed reference to the program (ELF for SP1/Risc0). */
  programCid: string;
  /** Verification key — published once at registration. */
  verificationKey: string;
  /** On-chain verifier address (EVM chain id + address). */
  onchainVerifier?: { chainId: number; address: string };
  /** Expected proving time at p50, in seconds (set by operator at registration). */
  expectedProvingSeconds?: number;
  /** Required input/output schema (must match IndexedTool's inputSchema/outputSchema). */
  publicInputSchema: unknown;
  publicOutputSchema: unknown;
}

// ---------------------------------------------------------------------------
// IndexedTool — the canonical record
// ---------------------------------------------------------------------------

/**
 * A single normalized, indexed tool record.
 *
 * One entry per callable surface. Aggregator pipelines write/update this;
 * `/api/aggregator/tools/search` returns this; the invoke proxy reads
 * this to enforce trust-tier ceilings before forwarding.
 */
export interface IndexedTool {
  // ----- Identity --------------------------------------------------------
  /** Internal id: `sha256:<canonical-name>`. Stable across re-fetches. */
  id: Id;
  /** Content-addressed identifier — sha256 over the stable-field canonical JSON. */
  cid: SHA256;
  /** Semver if available, else ingestion date in ISO 8601. */
  version: string;

  // ----- Source / provenance of the tool descriptor (not invocations) -----
  source: ToolSource;
  ingestedAt: Timestamp;
  ingestionMethod:
    | "mcp-list"
    | "openapi"
    | "a2a-card"
    | "oasf"
    | "manual"
    | "wellknown";
  /** OCI referrer ref if the upstream record is Sigstore-signed. */
  sigstoreBundle?: string;

  // ----- Upstream identity ----------------------------------------------
  /** Upstream's own name for this tool (may collide across sources). */
  upstreamId?: string;
  /** Canonical URL to invoke the tool. */
  upstreamUrl: string;
  /** Org / maintainer string. */
  upstreamVendor?: string;

  // ----- OASF-compatible classification ---------------------------------
  /** Dotted skill taxonomy: ["nlp.summarization.abstractive", ...]. */
  skills: string[];
  /** ["dev", "data", "creative", ...]. */
  domains: string[];
  /** Free-form capability descriptors. */
  features: string[];

  // ----- MCP-compatible tool shape ---------------------------------------
  /** Loose JSON Schema for the input args. */
  inputSchema: JSONSchemaLoose;
  /** Optional output schema. */
  outputSchema?: JSONSchemaLoose;
  /** Auto-generated 2-3-line summary (NOT verbatim upstream — see §10 copyright). */
  description: string;

  // ----- PCC-specific augmentation ---------------------------------------
  actionClass: IndexedToolActionClass;
  /** Max DCC class this tool can be invoked at (hard cap). */
  assuranceCeiling: DigitalCaptureClass;
  trustTier: TrustTier;
  pricing?: PricingHint;
  /**
   * DCC4: operator-registered TEE measurement profile. Required for
   * `assuranceCeiling >= DCC4`. Set via /claim-tee endpoint after a successful
   * test-quote verification. See scope doc §2.3.
   */
  teeProfile?: TeeProfile;
  /**
   * DCC5 S1 (faithful execution): operator-uploaded execution-proof profile.
   * Optional even for DCC5 — S2 (TEE-wrap) does not need this and is the
   * default. See scope doc §3.4.
   */
  executionProof?: ExecutionProofProfile;

  // ----- Verification ----------------------------------------------------
  vetReport?: VetReportSummary;
  /** 0..13 of CP.5.MCP controls passed (postmark-mcp style supply-chain checks). */
  cpFiveMcpScore?: number;
  /** Known CVEs from Trivy / npm audit / pip audit etc. (just the IDs). */
  knownVulns: string[];

  // ----- Liveness --------------------------------------------------------
  lastFetchedAt: Timestamp;
  lastInvokedAt?: Timestamp;
  invocationCount: number;
  /** Success rate over the last 100 invocations, in [0,1]. */
  successRate?: number;
  /** Rolling mean latency in ms. */
  meanLatencyMs?: number;

  // ----- Drift -----------------------------------------------------------
  driftAlerts: DriftAlertSummary[];
  /** Append-only sequence of schema hashes — latest at end. */
  schemaHashHistory: SHA256[];

  // ----- Federation ------------------------------------------------------
  /** Other peers carrying this tool's index entry. Phase 5 only. */
  hostingPeers: IndexedToolPeerEndpoint[];

  // ----- Phase 1 federation extension (optional, additive) ---------------
  /**
   * Region that ingested this record. Defaults to "us-east-1" when not
   * explicitly set; the federation runtime populates it on upsert.
   * Per scope §11.1. OPTIONAL — present only when the federation
   * runtime is engaged.
   */
  regionId?: string;
  /**
   * Mesh (within the region) that ingested this record. Defaults to
   * "us-east-1-mesh-a" when the federation runtime is single-region.
   * Per scope §11.1.
   */
  meshId?: string;
  /**
   * Namespace this tool belongs to. PCC's default is "pcc-public".
   * Per scope §3.4 + §11.4. OPTIONAL — when undefined, the aggregator
   * treats the tool as belonging to the default public namespace.
   */
  namespaceId?: string;
  /**
   * Phase 1 federation extension: per-region CRDT state refs for the
   * four volatile fields. Per scope §11.2. OPTIONAL — when undefined,
   * the gateway reads the scalar volatile fields above directly.
   */
  volatileRefs?: IndexedToolVolatileRefs;
  // ----- OASF round-trip (AGNTCY ADS bridge) ----------------------------
  /**
   * OASF locator mirror URLs (`locators[].urls` supports multiple mirrors
   * per locator type). Preserved on inbound for round-trip fidelity.
   * Phase 1 of the bridge — see ai/scoping/agntcy-ads-oasf-bridge-2026-05-23.md.
   */
  locatorUrls?: string[];
  /**
   * OASF modules preserved verbatim for AGNTCY round-trip. On inbound from
   * AGNTCY, the source-adapter populates this so the publisher can
   * re-emit the record losslessly. The PCC-specific module slugs
   * (`physical-capability/v1`, `tool-schema/v1`) ride here.
   */
  oasfModules?: OasfModule[];
  /**
   * If ingested from AGNTCY ADS, the AGNTCY-side CID for re-publish /
   * diff detection. Empty for tools sourced from non-AGNTCY adapters.
   */
  agntcyRecordCid?: string;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const TrustTierSchema = z.nativeEnum(TrustTier);

const IndexedToolActionClassSchema = z.enum([
  "read",
  "write",
  "exec",
  "network",
  "credential",
]);

const ToolSourceTypeSchema = z.enum([
  "anthropic-registry",
  "glama",
  "mcp-so",
  "smithery",
  "pulsemcp",
  "mcp-directory",
  "apis-guru",
  "common-crawl",
  "agntcy-dht",
  "nanda-index",
  "well-known",
  "user-submission",
  "pcc-native",
  "openapi-doc",
]);

const ToolSourceSchema = z.object({
  type: ToolSourceTypeSchema,
  url: z.string().url(),
  fetchedAt: z.string().datetime(),
  scoreSnapshot: z.record(z.string(), z.number()).optional(),
});

const SHA256Schema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "Must be sha256:<64 hex chars>");

const VetReportSummarySchema = z.object({
  verdict: z.enum(["UNVETTED", "PASS", "WARN", "FAIL"]),
  reportPath: z.string().optional(),
  critical: z.number().int().nonnegative(),
  high: z.number().int().nonnegative(),
  secrets: z.number().int().nonnegative(),
  malware: z.boolean(),
  promptInjection: z.boolean(),
});

const DriftAlertSummarySchema = z.object({
  type: z.enum([
    "schema_changed",
    "endpoint_404",
    "auth_changed",
    "tools_list_changed",
  ]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  detectedAt: z.string().datetime(),
  message: z.string().min(1),
  fromSchemaHash: SHA256Schema.optional(),
  toSchemaHash: SHA256Schema.optional(),
});

const IndexedToolPeerEndpointSchema = z.object({
  peerId: z.string().min(1),
  url: z.string().url(),
  lastSeenAt: z.string().datetime(),
});

/** OASF module Zod schema. */
const OasfModuleSchema = z.object({
  name: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
});

const PricingHintSchema = z.object({
  perCallUsdc: z.string(),
  perKTokenUsdc: z.string().optional(),
  tierLabel: z.string().optional(),
  mode: z.enum(["fixed", "auction"]).optional(),
});

const TeeVendorSchema = z.enum([
  "intel-tdx",
  "intel-sgx",
  "amd-sev-snp",
  "aws-nitro",
  "phala-cloud",
  "dstack",
]);

const TeeProfileSchema = z.object({
  vendor: TeeVendorSchema,
  expectedMeasurement: z.string().min(1),
  expectedRtmr: z
    .tuple([z.string(), z.string(), z.string(), z.string()])
    .optional(),
  expectedSigner: z.string().optional(),
  expectedPcrs: z.record(z.string(), z.string()).optional(),
  quoteFormat: z.string().min(1),
  manifestUrl: z.string().url().optional(),
});

const ZkSystemSchema = z.enum(["sp1", "risc0", "noir", "halo2", "plonky3"]);

const ExecutionProofProfileSchema = z.object({
  zkSystem: ZkSystemSchema,
  programCid: z.string().min(1),
  verificationKey: z.string().min(1),
  onchainVerifier: z
    .object({
      chainId: z.number().int().nonnegative(),
      address: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/, "Must be 0x-prefixed 20-byte EVM address"),
    })
    .optional(),
  expectedProvingSeconds: z.number().nonnegative().optional(),
  publicInputSchema: z.unknown(),
  publicOutputSchema: z.unknown(),
});

/**
 * Zod schema for IndexedTool at API boundaries.
 *
 * Loose on inputSchema/outputSchema (record of unknown) — full JSONSchema
 * validation happens at invocation time against the caller's args, not here.
 */
export const IndexedToolSchema: z.ZodType<IndexedTool> = z.object({
  id: z.string().min(1),
  cid: SHA256Schema,
  version: z.string().min(1),
  source: ToolSourceSchema,
  ingestedAt: z.string().datetime(),
  ingestionMethod: z.enum([
    "mcp-list",
    "openapi",
    "a2a-card",
    "oasf",
    "manual",
    "wellknown",
  ]),
  sigstoreBundle: z.string().optional(),
  upstreamId: z.string().optional(),
  upstreamUrl: z.string().url(),
  upstreamVendor: z.string().optional(),
  skills: z.array(z.string()),
  domains: z.array(z.string()),
  features: z.array(z.string()),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  description: z.string().min(1),
  actionClass: IndexedToolActionClassSchema,
  assuranceCeiling: z.nativeEnum(DigitalCaptureClass),
  trustTier: TrustTierSchema,
  pricing: PricingHintSchema.optional(),
  teeProfile: TeeProfileSchema.optional(),
  executionProof: ExecutionProofProfileSchema.optional(),
  vetReport: VetReportSummarySchema.optional(),
  cpFiveMcpScore: z.number().int().min(0).max(13).optional(),
  knownVulns: z.array(z.string()),
  lastFetchedAt: z.string().datetime(),
  lastInvokedAt: z.string().datetime().optional(),
  invocationCount: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1).optional(),
  meanLatencyMs: z.number().nonnegative().optional(),
  driftAlerts: z.array(DriftAlertSummarySchema),
  schemaHashHistory: z.array(SHA256Schema),
  hostingPeers: z.array(IndexedToolPeerEndpointSchema),
  // Phase 1 federation extension — optional, additive
  regionId: z.string().min(1).optional(),
  meshId: z.string().min(1).optional(),
  namespaceId: z.string().min(1).optional(),
  volatileRefs: z
    .object({
      invocationCountCid: SHA256Schema.optional(),
      successRateCid: SHA256Schema.optional(),
      meanLatencyMsCid: SHA256Schema.optional(),
      lastInvokedAtCid: SHA256Schema.optional(),
    })
    .optional(),
  // OASF round-trip fields (additive, optional, backward-compatible):
  locatorUrls: z.array(z.string()).optional(),
  oasfModules: z.array(OasfModuleSchema).optional(),
  agntcyRecordCid: z.string().optional(),
}) as unknown as z.ZodType<IndexedTool>;
