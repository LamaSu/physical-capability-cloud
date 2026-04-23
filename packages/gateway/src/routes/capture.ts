/**
 * Capture Verification Protocol (CVP) — Wave 4 gateway routes.
 *
 * Four endpoints under `/api/capture/*` that together implement the
 * nonce-challenge → verify → anchor → status lifecycle for every
 * CC0..CC5 capture submitted to PCC:
 *
 *   POST /api/capture/challenge         — issue block-anchored CaptureNonceChallenge
 *   POST /api/capture/upload            — run CaptureVerifier G1..G6, persist verdict
 *   POST /api/capture/anchor            — submit PASS verdict to CaptureClassRegistry
 *   GET  /api/capture/status/:verdictId — combined verdict + anchor view
 *
 * Source: ai/supervisor/wave4-spec.md §Endpoints to Add.
 *
 * Design notes:
 *   - The CaptureVerifier is pulled from a gateway-owned factory
 *     (packages/gateway/src/capture/verifier-factory.ts) that supports
 *     test injection. No adapter state leaks across requests.
 *   - /upload accepts JSON with inline base64-encoded capture bytes and an
 *     optional base64 c2paManifestBytes. We deliberately did NOT pull in
 *     @fastify/multipart for Wave 4 — it adds a runtime dependency, and
 *     the whole base64 flow keeps the route Zod-first.
 *   - If CaptureClassRegistry is not yet deployed
 *     (`CAPTURE_REGISTRY_ADDRESS` env missing) /anchor returns 202
 *     Accepted + `{status:"deferred"}` without writing a row. Wave 5
 *     smoke test is expected to catch this and re-run after deployment.
 *   - Telemetry: `PipelinePhase` is a closed enum in telemetry.ts and
 *     does NOT include capture-specific phases; we emit under
 *     `evidence_capture` with a metadata subphase so the pipeline
 *     visualizer still surfaces CVP events alongside the evidence
 *     pipeline.
 *
 * Author: gateway-golf (Wave 4)
 */

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CaptureClass,
  CaptureManifestSchema,
  type CaptureManifest,
  type CaptureNonceChallengePayload,
} from "@pcc/spec";
import { canonicalJSON } from "@pcc/verifier/dist/capture/verifier.js";
import type { CaptureVerifierResult } from "@pcc/verifier/dist/capture/verifier.js";
import type { CaptureNonceChallenge } from "@pcc/verifier";
import { schema, eq, desc } from "@pcc/store";
import { getStore } from "../db.js";
import { requireAuth } from "../auth/require-auth.js";
import { pipelineTelemetry } from "../telemetry.js";
import {
  getCaptureVerifier,
  getChallengeService,
} from "../capture/verifier-factory.js";

const { captureVerdicts, captureAnchors } = schema;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CAPTURE_NONCE_MAX_AGE_SECONDS = 120;
const CAPTURE_CLASS_VALUES = ["CC0", "CC1", "CC2", "CC3", "CC4", "CC5"] as const;

/**
 * Integer ordinal for a CaptureClass — matches the on-chain uint8 encoding
 * in `CaptureClassRegistry.sol` (`0..5`).
 */
function captureClassOrdinal(c: CaptureClass): number {
  return CAPTURE_CLASS_VALUES.indexOf(c);
}

/**
 * Ensure a string starts with `0x` prefix and is 32 bytes hex. Pads or
 * hashes input as needed so the on-chain `bytes32` fields always validate.
 */
function toBytes32(input: string): `0x${string}` {
  const cleaned = input.startsWith("0x") ? input.slice(2) : input;
  if (/^[0-9a-fA-F]{64}$/.test(cleaned)) {
    return (`0x${cleaned.toLowerCase()}`) as `0x${string}`;
  }
  // Hash variable-length strings (uuids, scope tags) to a stable bytes32.
  const h = crypto.createHash("sha256").update(input).digest("hex");
  return (`0x${h}`) as `0x${string}`;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const ChallengeBodySchema = z.object({
  jobId: z.string().min(1),
  declaredClass: z.enum(CAPTURE_CLASS_VALUES),
  requestedTtlSeconds: z.number().int().positive().optional(),
});

const UploadBodySchema = z.object({
  manifest: CaptureManifestSchema,
  captureBytesBase64: z.string().min(1),
  c2paManifestBase64: z.string().optional(),
  jobId: z.string().min(1).optional(),
  operatorId: z.string().min(1).optional(),
  /** Optional challenge echo — required for anti-replay on CC1+ */
  challengeId: z.string().min(1).optional(),
  visualNonceEcho: z.string().optional(),
  submittedAt: z.number().int().optional(),
});

const AnchorBodySchema = z.object({
  verdictId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Challenge cache (process-local)
// ---------------------------------------------------------------------------

/**
 * In-memory store of recently-issued CaptureNonceChallenges keyed by
 * challengeId. Used by /api/capture/upload to resolve a challenge echoed
 * in the request back to the full issued payload for the verifier's G3
 * freshness gate.
 *
 * Deliberately not persisted — capture challenges expire in ≤120s so a DB
 * row would churn constantly. In a multi-instance deploy these will go
 * to Redis; single-instance Railway is the supported Wave 4 target.
 */
const challengeCache = new Map<string, CaptureNonceChallenge>();

/** Evict challenges older than 10× the max TTL so the map doesn't leak. */
function pruneChallengeCache(): void {
  const cutoffMs = Date.now() - CAPTURE_NONCE_MAX_AGE_SECONDS * 10_000;
  for (const [id, c] of challengeCache.entries()) {
    const issuedMs = Date.parse(c.issuedAt);
    if (Number.isFinite(issuedMs) && issuedMs < cutoffMs) {
      challengeCache.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// CaptureClassRegistry ABI (minimal — only `anchor`)
// ---------------------------------------------------------------------------

/**
 * Inline ABI for CaptureClassRegistry.anchor(CaptureAnchor). Kept here
 * rather than in `@pcc/contracts` because contracts-foxtrot's TypeScript
 * export is still landing. Update this to import from @pcc/contracts once
 * the ABI is published.
 */
const CAPTURE_CLASS_REGISTRY_ABI = [
  {
    type: "function",
    name: "anchor",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "a",
        type: "tuple",
        components: [
          { name: "captureHash", type: "bytes32" },
          { name: "manifestHash", type: "bytes32" },
          { name: "declaredClass", type: "uint8" },
          { name: "verifiedClass", type: "uint8" },
          { name: "submittedBy", type: "address" },
          { name: "jobId", type: "bytes32" },
          { name: "challengeId", type: "bytes32" },
          { name: "blockAnchor", type: "uint32" },
          { name: "capturedAt", type: "uint64" },
          { name: "attestationsRoot", type: "bytes32" },
          { name: "attesterCount", type: "uint16" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

// ---------------------------------------------------------------------------
// Chain client — lazy, test-injectable
// ---------------------------------------------------------------------------

/**
 * Minimal chain-client surface the capture routes need. Tests inject a
 * fake via `setCaptureChainClientForTests` to assert write arguments and
 * skip real RPC.
 */
export interface CaptureChainClient {
  /** Fetch the latest block's number / hash / timestamp for challenge anchoring. */
  getLatestBlock(): Promise<{ number: number; hash: `0x${string}`; timestamp: number }>;
  /**
   * Submit an `anchor(CaptureAnchor)` write to CaptureClassRegistry.
   * Returns the tx hash + block + gas used. Throws on revert.
   */
  anchorCapture(params: {
    registryAddress: `0x${string}`;
    anchor: {
      captureHash: `0x${string}`;
      manifestHash: `0x${string}`;
      declaredClass: number;
      verifiedClass: number;
      submittedBy: `0x${string}`;
      jobId: `0x${string}`;
      challengeId: `0x${string}`;
      blockAnchor: number;
      capturedAt: bigint;
      attestationsRoot: `0x${string}`;
      attesterCount: number;
    };
  }): Promise<{ txHash: `0x${string}`; blockNumber: number; gasUsed: string }>;
  /** Active chain id (84532 for Base Sepolia by default). */
  getChainId(): number;
}

let _chainTestOverride: CaptureChainClient | null = null;
let _chainClient: CaptureChainClient | null = null;

export function setCaptureChainClientForTests(c: CaptureChainClient | null): void {
  _chainTestOverride = c;
  _chainClient = null;
}

async function getChainClient(): Promise<CaptureChainClient> {
  if (_chainTestOverride) return _chainTestOverride;
  if (_chainClient) return _chainClient;

  // Real viem-backed client. Imports are deferred so tests that override
  // never pay the module-load cost.
  const { createPublicClient, createWalletClient, http } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { baseSepolia } = await import("viem/chains");

  const rpcUrl = process.env.PCC_RPC_URL ?? "https://sepolia.base.org";
  const chainId = Number(process.env.PCC_CHAIN_ID ?? 84532);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const privKey = process.env.PCC_GATEWAY_PRIVATE_KEY as `0x${string}` | undefined;

  const client: CaptureChainClient = {
    getChainId: () => chainId,
    async getLatestBlock() {
      const block = await publicClient.getBlock({ blockTag: "latest" });
      return {
        number: Number(block.number),
        hash: block.hash as `0x${string}`,
        timestamp: Number(block.timestamp),
      };
    },
    async anchorCapture({ registryAddress, anchor }) {
      if (!privKey) {
        throw new Error("PCC_GATEWAY_PRIVATE_KEY not set — cannot anchor");
      }
      const account = privateKeyToAccount(privKey);
      const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
      const txHash = await wallet.writeContract({
        chain: baseSepolia,
        account,
        address: registryAddress,
        abi: CAPTURE_CLASS_REGISTRY_ABI,
        functionName: "anchor",
        args: [anchor],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      return {
        txHash,
        blockNumber: Number(receipt.blockNumber),
        gasUsed: receipt.gasUsed.toString(),
      };
    },
  };
  _chainClient = client;
  return _chainClient;
}

// ---------------------------------------------------------------------------
// DB helpers (drizzle ORM — captureVerdicts / captureAnchors in schema)
// ---------------------------------------------------------------------------

interface VerdictRow {
  id: string;
  jobId: string | null;
  operatorId: string;
  captureHash: string;
  manifestHash: string;
  declaredClass: number;
  verifiedClass: number;
  verdict: "PASS" | "PARTIAL" | "FAIL";
  gatesPassed: number[];
  gatesFailed: number[];
  warnings: string[];
  /** 0/1 boolean — stored as INTEGER in SQLite */
  anchorCandidate: number;
  resultJson: Record<string, unknown>;
  declaredClassStr: string;
  verifiedClassStr: string;
  createdAt: string;
}

interface AnchorRow {
  verdictId: string;
  txHash: string;
  blockNumber: number;
  gasUsed: string;
  anchoredAt: string;
}

function insertVerdict(row: VerdictRow): void {
  const { db } = getStore();
  db.insert(captureVerdicts)
    .values({
      id: row.id,
      jobId: row.jobId,
      operatorId: row.operatorId,
      captureHash: row.captureHash,
      manifestHash: row.manifestHash,
      declaredClass: row.declaredClass,
      verifiedClass: row.verifiedClass,
      verdict: row.verdict,
      gatesPassed: row.gatesPassed,
      gatesFailed: row.gatesFailed,
      warnings: row.warnings,
      anchorCandidate: row.anchorCandidate,
      resultJson: row.resultJson,
      declaredClassStr: row.declaredClassStr,
      verifiedClassStr: row.verifiedClassStr,
      createdAt: row.createdAt,
    })
    .run();
}

function selectVerdict(id: string): VerdictRow | undefined {
  const { db } = getStore();
  const row = db
    .select()
    .from(captureVerdicts)
    .where(eq(captureVerdicts.id, id))
    .get();
  if (!row) return undefined;
  return {
    id: row.id,
    jobId: row.jobId,
    operatorId: row.operatorId,
    captureHash: row.captureHash,
    manifestHash: row.manifestHash,
    declaredClass: row.declaredClass,
    verifiedClass: row.verifiedClass,
    verdict: row.verdict as "PASS" | "PARTIAL" | "FAIL",
    gatesPassed: (row.gatesPassed ?? []) as number[],
    gatesFailed: (row.gatesFailed ?? []) as number[],
    warnings: (row.warnings ?? []) as string[],
    anchorCandidate: row.anchorCandidate,
    resultJson: (row.resultJson ?? {}) as Record<string, unknown>,
    declaredClassStr: row.declaredClassStr,
    verifiedClassStr: row.verifiedClassStr,
    createdAt: row.createdAt,
  };
}

function insertAnchor(row: AnchorRow): void {
  const { db } = getStore();
  db.insert(captureAnchors)
    .values({
      verdictId: row.verdictId,
      txHash: row.txHash,
      blockNumber: row.blockNumber,
      gasUsed: row.gasUsed,
      anchoredAt: row.anchoredAt,
    })
    .run();
}

function selectAnchor(verdictId: string): AnchorRow | undefined {
  const { db } = getStore();
  const row = db
    .select()
    .from(captureAnchors)
    .where(eq(captureAnchors.verdictId, verdictId))
    .get();
  if (!row) return undefined;
  return {
    verdictId: row.verdictId,
    txHash: row.txHash,
    blockNumber: row.blockNumber,
    gasUsed: row.gasUsed,
    anchoredAt: row.anchoredAt,
  };
}

// ---------------------------------------------------------------------------
// Response shape helpers
// ---------------------------------------------------------------------------

interface CaptureNonceChallengeResponse {
  challengeId: string;
  blockHash: string;
  workOutputRoot: string;
  nonce: string;          // sha256(challengeId + blockHash + workOutputRoot)
  issuedAt: string;
  expiresAt: string;
  maxAgeSeconds: number;
  /** Embedded visual nonce the operator must show in-scene */
  visualNonce: CaptureNonceChallengePayload["visualNonce"];
  /** Block number used as the anchor — helpful for the detector's cross-check */
  blockNumber: number;
  /** Chain id the challenge is anchored on */
  chainId: number;
  /** Scope tag (jobId + declaredClass) echoed back for client correlation */
  scope: string;
}

function buildNonceFromChallenge(
  challenge: CaptureNonceChallenge,
  workOutputRoot: string,
): string {
  return crypto
    .createHash("sha256")
    .update(challenge.challengeId)
    .update(challenge.blockHash)
    .update(workOutputRoot)
    .digest("hex");
}

function expiresAtIso(challenge: CaptureNonceChallenge): string {
  const issuedMs = Date.parse(challenge.issuedAt);
  const expiresMs = issuedMs + challenge.maxAgeSeconds * 1000;
  return new Date(expiresMs).toISOString();
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export async function captureRoutes(app: FastifyInstance): Promise<void> {
  // ═════════════════════════════════════════════════════════════════
  // POST /api/capture/challenge — issue block-anchored nonce
  // ═════════════════════════════════════════════════════════════════

  app.post(
    "/api/capture/challenge",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const parsed = ChallengeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_body",
          message: "Invalid challenge request body",
          details: parsed.error.flatten(),
        });
      }

      const { jobId, declaredClass, requestedTtlSeconds } = parsed.data;
      const ttl = Math.min(
        requestedTtlSeconds ?? CAPTURE_NONCE_MAX_AGE_SECONDS,
        CAPTURE_NONCE_MAX_AGE_SECONDS,
      );

      try {
        const chain = await getChainClient();
        const block = await chain.getLatestBlock();
        const svc = getChallengeService();
        const challenge = svc.issueCaptureNonce({
          issuedBy: String(req.userId ?? "unknown"),
          scope: `${jobId}:${declaredClass}`,
          visualNonceType: "qr",
          blockNumber: block.number,
          blockHash: block.hash,
          blockTimestamp: block.timestamp,
          chainId: chain.getChainId(),
          maxAgeSeconds: ttl,
        });

        // Cache the challenge so /upload can resolve it back to the full
        // server-side object. In-memory — challenges expire fast (≤120s).
        pruneChallengeCache();
        challengeCache.set(challenge.challengeId, challenge);

        // Work output root = sha256(scope) — deterministic so the client
        // can reconstruct it when assembling its capture manifest.
        const workOutputRoot = crypto
          .createHash("sha256")
          .update(challenge.scope)
          .digest("hex");

        const nonce = buildNonceFromChallenge(challenge, workOutputRoot);

        pipelineTelemetry.emit(jobId, "evidence_capture", "completed", {
          metadata: {
            subphase: "capture_challenge",
            challengeId: challenge.challengeId,
            declaredClass,
            ttl,
          },
        });

        const response: CaptureNonceChallengeResponse = {
          challengeId: challenge.challengeId,
          blockHash: challenge.blockHash,
          workOutputRoot,
          nonce,
          issuedAt: challenge.issuedAt,
          expiresAt: expiresAtIso(challenge),
          maxAgeSeconds: challenge.maxAgeSeconds,
          visualNonce: challenge.visualNonce,
          blockNumber: challenge.blockNumber,
          chainId: challenge.chainId,
          scope: challenge.scope,
        };
        return response;
      } catch (err) {
        req.log.error({ err }, "capture_challenge failed");
        return reply.status(500).send({
          error: "challenge_failed",
          message: (err as Error).message,
        });
      }
    },
  );

  // ═════════════════════════════════════════════════════════════════
  // POST /api/capture/upload — run verifier G1..G6
  // ═════════════════════════════════════════════════════════════════

  app.post(
    "/api/capture/upload",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const parsed = UploadBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_body",
          message: "Invalid upload body",
          details: parsed.error.flatten(),
        });
      }

      const {
        manifest,
        captureBytesBase64,
        c2paManifestBase64,
        jobId,
        operatorId,
        challengeId,
        visualNonceEcho,
        submittedAt,
      } = parsed.data;

      // Decode the uploaded bytes once — all downstream gates need them.
      let captureBytes: Uint8Array;
      let c2paManifestBytes: Uint8Array | undefined;
      try {
        captureBytes = new Uint8Array(Buffer.from(captureBytesBase64, "base64"));
        if (c2paManifestBase64) {
          c2paManifestBytes = new Uint8Array(Buffer.from(c2paManifestBase64, "base64"));
        }
      } catch (err) {
        return reply.status(400).send({
          error: "invalid_bytes",
          message: "captureBytesBase64 failed to decode",
        });
      }

      // Verify operator-provided mediaHash matches the bytes we received
      // BEFORE handing to the verifier. This is the cheap pre-check — the
      // verifier's G1 will do the same, but we want a specific 400 here.
      const actualHash =
        "sha256:" + crypto.createHash("sha256").update(captureBytes).digest("hex");
      if (manifest.mediaHash.toLowerCase() !== actualHash.toLowerCase()) {
        return reply.status(400).send({
          error: "hash_mismatch",
          message:
            `manifest.mediaHash (${manifest.mediaHash}) does not match sha256(captureBytes)=${actualHash}`,
        });
      }

      // Resolve the CaptureNonceChallenge from cache if the client echoed
      // the id (required for G3 on CC1+). If the challenge isn't cached
      // the verifier G3 will fall through and fail for those classes.
      const challenge =
        challengeId && challengeCache.get(challengeId)
          ? challengeCache.get(challengeId)!
          : undefined;

      const verifier = getCaptureVerifier();
      let result: CaptureVerifierResult;
      try {
        result = await verifier.verify({
          manifest: manifest as CaptureManifest,
          captureBytes,
          c2paManifestBytes,
          challenge,
          visualNonceEcho,
          submittedAt,
          webAuthnPublicKey: undefined,
          webAuthnOrigin: undefined,
          webAuthnRpId: undefined,
          attestations: undefined,
        });
      } catch (err) {
        req.log.error({ err }, "capture_upload verifier threw");
        return reply.status(500).send({
          error: "verifier_threw",
          message: (err as Error).message,
        });
      }

      // Persist the verdict row.
      const verdictId = crypto.randomUUID();
      const row: VerdictRow = {
        id: verdictId,
        jobId: jobId ?? null,
        operatorId: operatorId ?? String(req.userId ?? "unknown"),
        captureHash: result.captureHash,
        manifestHash: result.manifestHash,
        declaredClass: captureClassOrdinal(result.declaredClass),
        verifiedClass: captureClassOrdinal(result.verifiedClass),
        verdict: result.verdict,
        gatesPassed: result.gatesPassed,
        gatesFailed: result.gatesFailed,
        warnings: result.warnings,
        anchorCandidate: result.anchorCandidate ? 1 : 0,
        resultJson: result as unknown as Record<string, unknown>,
        declaredClassStr: result.declaredClass,
        verifiedClassStr: result.verifiedClass,
        createdAt: new Date().toISOString(),
      };
      try {
        insertVerdict(row);
      } catch (err) {
        req.log.error({ err }, "capture_upload DB insert failed");
        return reply.status(500).send({
          error: "persist_failed",
          message: (err as Error).message,
        });
      }

      pipelineTelemetry.emit(jobId ?? verdictId, "evidence_capture", "completed", {
        metadata: {
          subphase: "capture_upload",
          verdictId,
          declaredClass: result.declaredClass,
          verifiedClass: result.verifiedClass,
          verdict: result.verdict,
          gatesPassed: result.gatesPassed,
          gatesFailed: result.gatesFailed,
          anchorCandidate: result.anchorCandidate,
        },
        level: result.verdict === "FAIL" ? "warn" : "info",
      });

      return {
        verdict: result.verdict,
        verifiedClass: result.verifiedClass,
        declaredClass: result.declaredClass,
        gatesPassed: result.gatesPassed,
        gatesFailed: result.gatesFailed,
        warnings: result.warnings,
        anchorCandidate: result.anchorCandidate,
        verdictId,
        captureHash: result.captureHash,
        manifestHash: result.manifestHash,
      };
    },
  );

  // ═════════════════════════════════════════════════════════════════
  // POST /api/capture/anchor — submit verdict on-chain
  // ═════════════════════════════════════════════════════════════════

  app.post(
    "/api/capture/anchor",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const parsed = AnchorBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_body",
          message: "verdictId required",
          details: parsed.error.flatten(),
        });
      }
      const { verdictId } = parsed.data;

      const verdict = selectVerdict(verdictId);
      if (!verdict) {
        return reply.status(404).send({
          error: "verdict_not_found",
          message: `No verdict with id=${verdictId}`,
        });
      }

      // Gate A: only PASS verdicts with anchorCandidate:true are eligible.
      if (verdict.verdict !== "PASS") {
        return reply.status(400).send({
          error: "verdict_not_pass",
          message: `verdict ${verdict.verdict} not eligible for anchoring`,
          verdictId,
        });
      }
      if (!verdict.anchorCandidate) {
        return reply.status(400).send({
          error: "not_anchor_candidate",
          message: "verdict anchorCandidate=false — verifier declined anchoring",
          verdictId,
        });
      }

      // Deduplicate — one anchor per verdict.
      const existingAnchor = selectAnchor(verdictId);
      if (existingAnchor) {
        return {
          txHash: existingAnchor.txHash,
          blockNumber: existingAnchor.blockNumber,
          gasUsed: existingAnchor.gasUsed,
          anchoredAt: existingAnchor.anchoredAt,
          status: "already_anchored" as const,
        };
      }

      // Gate B: contract must be deployed. If not, return 202 deferred.
      const registryAddress = process.env.CAPTURE_REGISTRY_ADDRESS as
        | `0x${string}`
        | undefined;
      if (!registryAddress) {
        pipelineTelemetry.emit(
          verdict.jobId ?? verdictId,
          "evidence_capture",
          "skipped",
          {
            metadata: {
              subphase: "capture_anchor",
              verdictId,
              reason: "registry_not_deployed",
            },
            level: "warn",
          },
        );
        return reply.status(202).send({
          status: "deferred" as const,
          reason: "CaptureClassRegistry contract not deployed",
          verdictId,
        });
      }

      // Pull the original verifier result to reconstruct blockAnchor +
      // attestationsRoot. The result is stored as JSON (drizzle JSON mode),
      // so it comes back as an object already — no re-parse needed.
      const parsedResult = verdict.resultJson as unknown as
        | CaptureVerifierResult
        | undefined;

      const submittedBy = (req.userId ?? "0x0000000000000000000000000000000000000000") as
        `0x${string}`;

      // Extract the challenge's block anchor if present in the stored result.
      // Fall back to 0 if absent (CC0 captures without a challenge).
      const blockAnchor = 0; // challenge.blockNumber not surfaced in the result;
      // wire later once verifier persists it on the result.
      const capturedAt = BigInt(Math.floor(Date.now() / 1000));

      const attestationsRoot = (
        "0x" + "0".repeat(64)
      ) as `0x${string}`;
      const attesterCount = 0;

      try {
        const chain = await getChainClient();
        const tx = await chain.anchorCapture({
          registryAddress,
          anchor: {
            captureHash: toBytes32(verdict.captureHash),
            manifestHash: toBytes32(verdict.manifestHash),
            declaredClass: verdict.declaredClass,
            verifiedClass: verdict.verifiedClass,
            submittedBy,
            jobId: toBytes32(verdict.jobId ?? verdictId),
            challengeId: toBytes32(verdictId),
            blockAnchor,
            capturedAt,
            attestationsRoot,
            attesterCount,
          },
        });

        const anchoredAt = new Date().toISOString();
        insertAnchor({
          verdictId,
          txHash: tx.txHash,
          blockNumber: tx.blockNumber,
          gasUsed: tx.gasUsed,
          anchoredAt,
        });

        pipelineTelemetry.emit(
          verdict.jobId ?? verdictId,
          "evidence_capture",
          "completed",
          {
            metadata: {
              subphase: "capture_anchor",
              verdictId,
              txHash: tx.txHash,
              gasUsed: tx.gasUsed,
              blockNumber: tx.blockNumber,
            },
          },
        );

        return {
          txHash: tx.txHash,
          blockNumber: tx.blockNumber,
          gasUsed: tx.gasUsed,
          anchoredAt,
        };
      } catch (err) {
        req.log.error({ err }, "capture_anchor failed");
        pipelineTelemetry.emit(
          verdict.jobId ?? verdictId,
          "evidence_capture",
          "failed",
          {
            metadata: {
              subphase: "capture_anchor",
              verdictId,
              error: (err as Error).message,
            },
            level: "error",
          },
        );
        return reply.status(500).send({
          error: "anchor_failed",
          message: (err as Error).message,
        });
      }
    },
  );

  // ═════════════════════════════════════════════════════════════════
  // GET /api/capture/status/:verdictId — combined status view
  // ═════════════════════════════════════════════════════════════════

  app.get<{ Params: { verdictId: string } }>(
    "/api/capture/status/:verdictId",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { verdictId } = req.params;
      const verdict = selectVerdict(verdictId);
      if (!verdict) {
        return reply.status(404).send({
          error: "verdict_not_found",
          message: `No verdict with id=${verdictId}`,
        });
      }
      const anchor = selectAnchor(verdictId);
      const network = process.env.PCC_NETWORK ?? "base-sepolia";
      const explorerBase =
        network === "sepolia"
          ? "https://sepolia.etherscan.io/tx/"
          : "https://sepolia.basescan.org/tx/";

      // Re-hydrate the stored CaptureVerifierResult for the dashboard.
      // drizzle JSON mode returns objects already — no parse step needed.
      const parsedResult = verdict.resultJson as unknown as
        | CaptureVerifierResult
        | undefined;

      return {
        verdictId,
        verdict: parsedResult ?? {
          verdict: verdict.verdict,
          verifiedClass: verdict.verifiedClassStr as CaptureClass,
          declaredClass: verdict.declaredClassStr as CaptureClass,
          gatesPassed: verdict.gatesPassed,
          gatesFailed: verdict.gatesFailed,
          warnings: verdict.warnings,
          anchorCandidate: verdict.anchorCandidate === 1,
          captureHash: verdict.captureHash,
          manifestHash: verdict.manifestHash,
          detectorEvidence: { ceiling: verdict.verifiedClassStr, evidence: [] },
        },
        jobId: verdict.jobId,
        operatorId: verdict.operatorId,
        createdAt: verdict.createdAt,
        anchor: anchor
          ? {
              txHash: anchor.txHash,
              blockNumber: anchor.blockNumber,
              gasUsed: anchor.gasUsed,
              anchoredAt: anchor.anchoredAt,
              explorerUrl: explorerBase + anchor.txHash,
            }
          : null,
      };
    },
  );

  // ═════════════════════════════════════════════════════════════════
  // GET /api/capture/verdicts — paginated list (thin query route for MCP)
  //
  // Added in Wave 6 to back the `pcc_list_verdicts` MCP tool. Pure read,
  // no side-effects. `jobId` filter is optional; `limit` defaults to 50
  // and is clamped to 200 per request.
  // ═════════════════════════════════════════════════════════════════

  const ListVerdictsQuerySchema = z.object({
    jobId: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  });

  app.get(
    "/api/capture/verdicts",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const parsed = ListVerdictsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_query",
          message: "Invalid query params",
          details: parsed.error.flatten(),
        });
      }
      const { jobId, limit } = parsed.data;
      const effectiveLimit = Math.min(limit ?? 50, 200);

      const { db } = getStore();
      const rows = jobId
        ? db
            .select()
            .from(captureVerdicts)
            .where(eq(captureVerdicts.jobId, jobId))
            .orderBy(desc(captureVerdicts.createdAt))
            .limit(effectiveLimit)
            .all()
        : db
            .select()
            .from(captureVerdicts)
            .orderBy(desc(captureVerdicts.createdAt))
            .limit(effectiveLimit)
            .all();

      pipelineTelemetry.emit(jobId ?? "capture-list", "evidence_capture", "completed", {
        metadata: {
          subphase: "list_verdicts",
          jobId: jobId ?? null,
          count: rows.length,
          limit: effectiveLimit,
        },
      });

      return {
        verdicts: rows.map((r) => ({
          id: r.id,
          jobId: r.jobId,
          operatorId: r.operatorId,
          captureHash: r.captureHash,
          manifestHash: r.manifestHash,
          declaredClass: r.declaredClassStr,
          verifiedClass: r.verifiedClassStr,
          verdict: r.verdict,
          gatesPassed: r.gatesPassed ?? [],
          gatesFailed: r.gatesFailed ?? [],
          warnings: r.warnings ?? [],
          anchorCandidate: r.anchorCandidate === 1,
          createdAt: r.createdAt,
        })),
        count: rows.length,
        limit: effectiveLimit,
        jobId: jobId ?? null,
      };
    },
  );

  // ═════════════════════════════════════════════════════════════════
  // GET /api/capture/registry/:captureHash — on-chain lookup (Wave 6)
  //
  // Read-only viem `readContract` against CaptureClassRegistry.getAnchor.
  // Returns null if the capture has not been anchored. Thin query route
  // backing the `pcc_capture_class_registry` MCP tool.
  // ═════════════════════════════════════════════════════════════════

  app.get<{ Params: { captureHash: string } }>(
    "/api/capture/registry/:captureHash",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { captureHash } = req.params;
      const registryAddress = process.env.CAPTURE_REGISTRY_ADDRESS as
        | `0x${string}`
        | undefined;
      if (!registryAddress) {
        return reply.status(202).send({
          status: "deferred" as const,
          reason: "CaptureClassRegistry contract not deployed",
          onchain: null,
        });
      }

      const hashBytes32 = toBytes32(captureHash);
      try {
        const { createPublicClient, http } = await import("viem");
        const { baseSepolia } = await import("viem/chains");
        const rpcUrl = process.env.PCC_RPC_URL ?? "https://sepolia.base.org";
        const publicClient = createPublicClient({
          chain: baseSepolia,
          transport: http(rpcUrl),
        });

        const exists = (await publicClient.readContract({
          address: registryAddress,
          abi: CAPTURE_CLASS_REGISTRY_READ_ABI,
          functionName: "getExists",
          args: [hashBytes32],
        })) as boolean;

        if (!exists) {
          return {
            address: registryAddress,
            captureHash: hashBytes32,
            onchain: null,
          };
        }

        const anchorTuple = (await publicClient.readContract({
          address: registryAddress,
          abi: CAPTURE_CLASS_REGISTRY_READ_ABI,
          functionName: "getAnchor",
          args: [hashBytes32],
        })) as {
          captureHash: `0x${string}`;
          manifestHash: `0x${string}`;
          declaredClass: number;
          verifiedClass: number;
          submittedBy: `0x${string}`;
          jobId: `0x${string}`;
          challengeId: `0x${string}`;
          blockAnchor: number;
          capturedAt: bigint;
          attestationsRoot: `0x${string}`;
          attesterCount: number;
        };

        return {
          address: registryAddress,
          captureHash: hashBytes32,
          onchain: {
            declaredClass: CAPTURE_CLASS_VALUES[anchorTuple.declaredClass] ?? `CC${anchorTuple.declaredClass}`,
            verifiedClass: CAPTURE_CLASS_VALUES[anchorTuple.verifiedClass] ?? `CC${anchorTuple.verifiedClass}`,
            manifestHash: anchorTuple.manifestHash,
            submittedBy: anchorTuple.submittedBy,
            jobId: anchorTuple.jobId,
            challengeId: anchorTuple.challengeId,
            blockAnchor: anchorTuple.blockAnchor,
            capturedAt: anchorTuple.capturedAt.toString(),
            attestationsRoot: anchorTuple.attestationsRoot,
            attesterCount: anchorTuple.attesterCount,
          },
        };
      } catch (err) {
        req.log.error({ err }, "capture_registry read failed");
        return reply.status(500).send({
          error: "registry_read_failed",
          message: (err as Error).message,
        });
      }
    },
  );

  // ═════════════════════════════════════════════════════════════════
  // GET /api/capture/verifier-health — adapter load + staleness (Wave 6)
  //
  // Thin query route for the `pcc_verifier_health` MCP tool. Reports
  // which CaptureVerifier adapters are loaded and their staleness.
  // Returns static "ok" unless PCC_VERIFIER_HEALTH is overridden in env.
  // ═════════════════════════════════════════════════════════════════

  app.get(
    "/api/capture/verifier-health",
    { preHandler: [requireAuth] },
    async (_req, _reply) => {
      // Static adapter list matches `buildProductionAdapters` in
      // packages/gateway/src/capture/verifier-factory.ts.
      const adaptersLoaded = [
        "c2pa",
        "webauthn",
        "appattest",
        "playintegrity",
      ] as const;

      const staleness: Record<string, string> = {};
      for (const a of adaptersLoaded) {
        staleness[a] = "ok";
      }

      // Optional env override: PCC_VERIFIER_HEALTH={"c2pa":"stale", ...}
      const override = process.env.PCC_VERIFIER_HEALTH;
      if (override) {
        try {
          const parsed = JSON.parse(override) as Record<string, string>;
          for (const [k, v] of Object.entries(parsed)) {
            staleness[k] = v;
          }
        } catch {
          // Ignore malformed override — leave defaults.
        }
      }

      return {
        adaptersLoaded: [...adaptersLoaded],
        staleness,
        challengeCacheSize: challengeCache.size,
        registryDeployed: Boolean(process.env.CAPTURE_REGISTRY_ADDRESS),
        network: process.env.PCC_NETWORK ?? "base-sepolia",
        checkedAt: new Date().toISOString(),
      };
    },
  );
}

// ---------------------------------------------------------------------------
// CaptureClassRegistry read ABI (Wave 6 — for `getAnchor` / `getExists`)
// ---------------------------------------------------------------------------

const CAPTURE_CLASS_REGISTRY_READ_ABI = [
  {
    type: "function",
    name: "getExists",
    stateMutability: "view",
    inputs: [{ name: "captureHash", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getAnchor",
    stateMutability: "view",
    inputs: [{ name: "captureHash", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "captureHash", type: "bytes32" },
          { name: "manifestHash", type: "bytes32" },
          { name: "declaredClass", type: "uint8" },
          { name: "verifiedClass", type: "uint8" },
          { name: "submittedBy", type: "address" },
          { name: "jobId", type: "bytes32" },
          { name: "challengeId", type: "bytes32" },
          { name: "blockAnchor", type: "uint32" },
          { name: "capturedAt", type: "uint64" },
          { name: "attestationsRoot", type: "bytes32" },
          { name: "attesterCount", type: "uint16" },
        ],
      },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// Test-only exports (kept in-module for single-import-surface)
// ---------------------------------------------------------------------------

/** Clear in-memory challenge cache. Test helper. */
export function _clearCaptureChallengeCacheForTests(): void {
  challengeCache.clear();
}

/** Preload a challenge into the in-memory cache. Test helper. */
export function _seedCaptureChallengeCacheForTests(
  challenge: CaptureNonceChallenge,
): void {
  challengeCache.set(challenge.challengeId, challenge);
}

/** Touch helper — kept so unused-but-desired exports don't get removed. */
export const _canonicalJSON = canonicalJSON;
