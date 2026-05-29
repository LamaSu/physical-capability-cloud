/**
 * InvocationReceipt — per-invocation provenance record for an indexed tool.
 *
 * This is THE load-bearing innovation of the universal aggregator: every other
 * catalog (Glama, Smithery, AGNTCY, NANDA, AgentHub, RapidAPI, mcp.directory)
 * ranks and routes. None witness calls. PCC issues a receipt for every
 * invocation that passes through the gateway, so a consumer can prove, years
 * later, exactly which version of which tool was called with exactly which
 * inputs and returned exactly which outputs — with cryptographic evidence at
 * the chosen DCC class.
 *
 * See: ai/research/universal-tool-aggregator-2026-05-23.md §3.2 + §3.3
 *
 * Composed from three influences:
 *
 *   1. Tool Receipts paper (arXiv 2603.10060) — HMAC-signed request/response
 *      binding as a ZK alternative for DCC1.
 *   2. AEX (arXiv 2603.14283) — request-projection / response-projection
 *      attestation for non-intrusive multi-hop LLM API observation (DCC2).
 *   3. PCC's existing evidence bundle (`packages/spec/src/types/evidence.ts`)
 *      — hash-chained event log + Ed25519 signature + on-chain hash anchor.
 *
 * Pure types + Zod schema. No runtime crypto — the receipt-signer module
 * (`packages/aggregator/src/receipt-signer.ts`) does the HMAC / Ed25519 work.
 */

import { z } from "zod";
import type { Id, Timestamp, SHA256 } from "./common.js";
import { DigitalCaptureClass } from "./dcc.js";
import type { TeeVendor, ZkSystem } from "./indexed-tool.js";

// ---------------------------------------------------------------------------
// Request / response projections
// ---------------------------------------------------------------------------

/**
 * Post-PCC-middleware view of an outbound request to the upstream tool.
 *
 * `headersHash` and `bodyHash` are sha256 of the canonical (sorted-key) JSON
 * AFTER PCC redacts caller auth headers and applies any middleware
 * transforms. `middlewareRedactions` lists the dotted field paths that were
 * redacted so a downstream auditor can confirm policy was applied.
 *
 * Hash-only by default — full body is NOT stored unless caller opts in
 * (§10.7 privacy mitigation).
 */
export interface RequestProjection {
  /** HTTP method (GET / POST / PUT / DELETE / PATCH ...). MCP calls use "MCP". */
  method: string;
  /** Full upstream URL the request was forwarded to. */
  url: string;
  /** sha256 over canonical-JSON of the redacted headers map. */
  headersHash: SHA256;
  /** sha256 over canonical-JSON of the redacted body. */
  bodyHash: SHA256;
  /** Dotted paths PCC redacted from headers + body (audit-friendly). */
  middlewareRedactions: string[];
  /** ISO 8601 timestamp at the moment PCC forwarded the request. */
  timestamp: Timestamp;
}

/**
 * Post-PCC-middleware view of the upstream tool's response.
 *
 * `streamCommit` is set for SSE / streaming responses — it's the sha256 of
 * the full committed output once the stream closes, so streamed responses
 * still bind cryptographically.
 */
export interface ResponseProjection {
  /** HTTP status code. MCP responses surface 200 with method-level errors in body. */
  status: number;
  /** sha256 of canonical-JSON of redacted response headers. */
  headersHash: SHA256;
  /** sha256 of canonical-JSON of redacted response body. */
  bodyHash: SHA256;
  /** Dotted paths PCC redacted from response. */
  middlewareRedactions: string[];
  /** ISO 8601 timestamp when PCC received the response. */
  timestamp: Timestamp;
  /** For streaming responses: sha256 over the FULL committed output. */
  streamCommit?: SHA256;
}

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DCC4 — parsed TEE measurements (alongside raw teeQuote)
// ---------------------------------------------------------------------------

/**
 * Parsed view of a TEE remote-attestation quote (DCC4).
 *
 * The raw `teeQuote` bytes stay as the auditable artifact; this struct is the
 * decoded view downstream consumers use without re-parsing. PCC writes both
 * when DCC4 verification succeeds. See scope doc §2.4.
 */
export interface TeeMeasurements {
  /** Vendor — matches IndexedTool.teeProfile.vendor at call time. */
  vendor: TeeVendor;
  /** MRTD / MRENCLAVE / imageId actually observed in the quote. */
  observedMeasurement: string;
  /** RTMR0..3 actually observed (TDX only). */
  observedRtmr?: [string, string, string, string];
  /** Quote format version observed (e.g. "tdx-v4"). */
  quoteFormat: string;
  /** report_data bytes (64 bytes). */
  reportData: string;
  /** Recomputed expected report_data — equal to reportData on success. */
  expectedReportData: string;
  /** True iff observed measurement matched IndexedTool.teeProfile. */
  measurementMatch: boolean;
  /** True iff Intel / AMD / AWS root cert chain validated. */
  certChainValid: boolean;
}

// ---------------------------------------------------------------------------
// DCC5 — parsed zk-proof metadata (alongside raw zkProof)
// ---------------------------------------------------------------------------

/**
 * Parsed metadata for a DCC5 zk-proof. See scope doc §3.5.
 *
 * `statement` discriminates the S1 vs S2 path:
 *   - "tee-wrap" (S2, default): proof asserts a DCC4 TDX quote verifies under
 *     Intel's PKI. Automatically generated once DCC4 is claimed.
 *   - "faithful-execution" (S1, opt-in): proof asserts O = L(I) for the tool's
 *     declared logic L. Requires operator to register `executionProof`.
 */
export interface ZkProofMetadata {
  zkSystem: ZkSystem;
  /** Statement under proof: "tee-wrap" (S2) or "faithful-execution" (S1). */
  statement: "tee-wrap" | "faithful-execution";
  /** Reference to the program / circuit CID used. */
  programCid: string;
  /** Public inputs hash (commits to what was proven). */
  publicInputsHash: string;
  /** Public outputs hash. */
  publicOutputsHash: string;
  /** Verifier-key digest. */
  verificationKeyHash: string;
  /** On-chain verifier address if applicable. */
  onchainVerifier?: { chainId: number; address: string };
  /** Proving cost in USDC (operator pays the prover network). */
  provingCostUsdc?: string;
  /** Time to prove in seconds (observed). */
  provingSeconds?: number;
}

/**
 * One InvocationReceipt per call.
 *
 * The receipt's own canonical-JSON sha256 is `receiptCID`. PCC's Ed25519
 * signature covers everything except `receiptCID` itself (which is computed
 * AFTER signing; the CID is hash-over-signature, signature is hash-over-body).
 *
 * For DCC2+: the upstream tool MUST return its own attestation. PCC stores
 * it in `upstreamSignature` (+ `upstreamKeyId`). DCC3 additionally requires
 * `sigstoreBundleRef`; DCC4 requires `teeQuote`; DCC5 requires `zkProof`.
 *
 * The receipt records both `requestedDccClass` and `effectiveDccClass` so the
 * caller (and an auditor) can see whether the request was auto-downgraded per
 * the min-of-three rule (see `applyDccDowngrade` in `./dcc.ts`).
 */
export interface InvocationReceipt {
  // ----- Identity -------------------------------------------------------
  receiptId: Id;
  receiptCID: SHA256;
  schemaVersion: "1.0";

  // ----- Binding to the indexed tool ------------------------------------
  /** Internal IndexedTool id at call time. */
  indexedToolId: Id;
  /** IndexedTool CID at call time (proves which catalog version was used). */
  toolCID: SHA256;
  /** Latest entry of IndexedTool.schemaHashHistory at call time. */
  toolSchemaHashAtCall: SHA256;

  // ----- Binding to the request/response --------------------------------
  requestProjection: RequestProjection;
  responseProjection: ResponseProjection;

  // ----- DCC + cryptographic proofs -------------------------------------
  /** What the caller asked for. */
  requestedDccClass: DigitalCaptureClass;
  /** What was actually achieved (after min-of-three downgrade). */
  effectiveDccClass: DigitalCaptureClass;
  /** Set iff effectiveDccClass < requestedDccClass. Mirrors CVP autoDowngrade. */
  downgradeReason?: string;

  /** PCC's Ed25519 signature over the canonical pre-CID body. */
  pccSignature: string;
  /** Key id from the PCC operator-node BIP-32 chain. */
  pccKeyId: string;
  /** DCC2+: upstream tool's signature over its response. */
  upstreamSignature?: string;
  /** DCC2+: upstream's key id (usually a fingerprint or DID). */
  upstreamKeyId?: string;
  /** DCC3+: OCI referrer ref to the Sigstore bundle. */
  sigstoreBundleRef?: string;
  /** DCC4: opaque TEE remote-attestation quote (raw bytes, base64url). */
  teeQuote?: string;
  /** DCC4: parsed view of `teeQuote` (vendor, MRTD/RTMR, report_data). */
  teeMeasurements?: TeeMeasurements;
  /** DCC5: base64url-encoded zkSNARK proof bytes. */
  zkProof?: string;
  /** DCC5: parsed metadata for `zkProof` (system, statement, vk hash, ...). */
  zkProofMetadata?: ZkProofMetadata;
  /**
   * DCC5: top-level convenience copy of `zkProofMetadata.zkSystem`. Allows
   * persistence/indexing to filter by system without parsing JSON metadata.
   */
  zkSystem?: ZkSystem;
  /**
   * DCC5: top-level on-chain verifier address (chainId + EVM addr) for the
   * `zkProof`. Convenience copy of `zkProofMetadata.onchainVerifier`.
   */
  zkProofVerifierAddress?: { chainId: number; address: string };

  // ----- Caller binding -------------------------------------------------
  /** PCC operator id that initiated the invocation. */
  callerAgentId: Id;
  /** Caller's session id. */
  callerSessionId: Id;
  /** Optional caller SIWE message (off-chain — full sig binding). */
  callerSiweMessage?: string;

  // ----- Economic -------------------------------------------------------
  /** Price the caller paid, USDC (decimal string). Undefined for free calls. */
  pricePaidUsdc?: string;
  /** On-chain tx hash if x402-billed. */
  paymentTxHash?: string;
  /** PCC's take in basis points (100 = 1.0%). */
  pccFeeBps: number;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const SHA256Schema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "Must be sha256:<64 hex chars>");

const RequestProjectionSchema = z.object({
  method: z.string().min(1),
  url: z.string().url(),
  headersHash: SHA256Schema,
  bodyHash: SHA256Schema,
  middlewareRedactions: z.array(z.string()),
  timestamp: z.string().datetime(),
});

const ResponseProjectionSchema = z.object({
  status: z.number().int(),
  headersHash: SHA256Schema,
  bodyHash: SHA256Schema,
  middlewareRedactions: z.array(z.string()),
  timestamp: z.string().datetime(),
  streamCommit: SHA256Schema.optional(),
});

const TeeVendorSchemaLocal = z.enum([
  "intel-tdx",
  "intel-sgx",
  "amd-sev-snp",
  "aws-nitro",
  "phala-cloud",
  "dstack",
]);

const TeeMeasurementsSchema = z.object({
  vendor: TeeVendorSchemaLocal,
  observedMeasurement: z.string().min(1),
  observedRtmr: z
    .tuple([z.string(), z.string(), z.string(), z.string()])
    .optional(),
  quoteFormat: z.string().min(1),
  reportData: z.string().min(1),
  expectedReportData: z.string().min(1),
  measurementMatch: z.boolean(),
  certChainValid: z.boolean(),
});

const ZkSystemSchemaLocal = z.enum([
  "sp1",
  "risc0",
  "noir",
  "halo2",
  "plonky3",
]);

const ZkProofMetadataSchema = z.object({
  zkSystem: ZkSystemSchemaLocal,
  statement: z.enum(["tee-wrap", "faithful-execution"]),
  programCid: z.string().min(1),
  publicInputsHash: z.string().min(1),
  publicOutputsHash: z.string().min(1),
  verificationKeyHash: z.string().min(1),
  onchainVerifier: z
    .object({
      chainId: z.number().int().nonnegative(),
      address: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/, "Must be 0x-prefixed 20-byte EVM address"),
    })
    .optional(),
  provingCostUsdc: z.string().optional(),
  provingSeconds: z.number().nonnegative().optional(),
});

/**
 * Zod schema for InvocationReceipt at API boundaries.
 *
 * Strict on required fields, optional on DCC2+ attestations (the receipt may
 * be issued at DCC0/DCC1 with no upstream signature).
 */
export const InvocationReceiptSchema: z.ZodType<InvocationReceipt> = z.object({
  receiptId: z.string().min(1),
  receiptCID: SHA256Schema,
  schemaVersion: z.literal("1.0"),
  indexedToolId: z.string().min(1),
  toolCID: SHA256Schema,
  toolSchemaHashAtCall: SHA256Schema,
  requestProjection: RequestProjectionSchema,
  responseProjection: ResponseProjectionSchema,
  requestedDccClass: z.nativeEnum(DigitalCaptureClass),
  effectiveDccClass: z.nativeEnum(DigitalCaptureClass),
  downgradeReason: z.string().optional(),
  pccSignature: z.string().min(1),
  pccKeyId: z.string().min(1),
  upstreamSignature: z.string().optional(),
  upstreamKeyId: z.string().optional(),
  sigstoreBundleRef: z.string().optional(),
  teeQuote: z.string().optional(),
  teeMeasurements: TeeMeasurementsSchema.optional(),
  zkProof: z.string().optional(),
  zkProofMetadata: ZkProofMetadataSchema.optional(),
  zkSystem: ZkSystemSchemaLocal.optional(),
  zkProofVerifierAddress: z
    .object({
      chainId: z.number().int().nonnegative(),
      address: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/, "Must be 0x-prefixed 20-byte EVM address"),
    })
    .optional(),
  callerAgentId: z.string().min(1),
  callerSessionId: z.string().min(1),
  callerSiweMessage: z.string().optional(),
  pricePaidUsdc: z.string().optional(),
  paymentTxHash: z.string().optional(),
  pccFeeBps: z.number().int().min(0).max(10000),
}) as unknown as z.ZodType<InvocationReceipt>;
