/**
 * Automata TEE-quote-in-zk wrapper (DCC5 Statement S2).
 *
 * Per scope §3.2: S2 is "Faithful TEE wrapper" — wrap a DCC4 TDX quote in a
 * Risc0/SP1 proof so on-chain verification is cheap (~275 k gas) and the
 * trust anchor moves from Intel's PKI to math.
 *
 * This module ships:
 *
 *   1. `submitTeeWrapJob(quote, opts)` — submits the DCC4 quote to the
 *      Boundless market with the Automata wrap circuit. Returns a job id
 *      + pollable URL.
 *   2. `pollTeeWrapJob(jobId, opts)` — polls market status. Returns
 *      `{ status, proof? }` until proof bytes are available.
 *   3. `buildZkProofMetadata(quote, proof, opts)` — composes the
 *      ZkProofMetadata struct PCC writes onto the receipt after S2 finishes.
 *
 * The Boundless market itself is dependency-injected via `BoundlessClient`
 * so tests can mock the prover network without setting up actual SP1/Risc0
 * infrastructure. Production wires a real client (Automata SDK) at startup.
 *
 * Async by design: S2 proofs take 30-90s per scope §3.9; PCC's invoke
 * handler returns DCC4 immediately, then upgrades the receipt to DCC5 once
 * the worker completes. See ./dcc5-upgrade-worker.ts for the queue/runner.
 *
 * See ai/scoping/dcc4-dcc5-auto-flows-2026-05-23.md §3.2 + §3.6 + §3.9.
 */

import type { ZkProofMetadata, ZkSystem } from "@pcc/spec";

// ---------------------------------------------------------------------------
// Boundless client (DI surface)
// ---------------------------------------------------------------------------

export interface BoundlessClient {
  /** Submit a TEE-wrap proof job. Returns a job id. */
  submitTeeWrapJob: (
    quoteBytes: Uint8Array,
    opts: BoundlessSubmitOptions,
  ) => Promise<{ jobId: string; pollUrl?: string }>;
  /** Poll a job's status. */
  pollJob: (jobId: string) => Promise<BoundlessJobStatus>;
}

export interface BoundlessSubmitOptions {
  /** Preferred zkVM: "sp1" (default) or "risc0". */
  zkSystem: ZkSystem;
  /** Maximum USDC price the operator will pay. */
  maxCostUsdc?: string;
  /** Optional priority hint. */
  priority?: "low" | "normal" | "high";
}

export interface BoundlessJobStatus {
  jobId: string;
  status: "pending" | "proving" | "complete" | "failed";
  /** Available iff status === "complete". */
  proofBytesBase64?: string;
  /** Available iff status === "complete". */
  imageId?: string;
  /** Available iff status === "complete". */
  publicInputsHash?: string;
  /** Available iff status === "complete". */
  publicOutputsHash?: string;
  /** Observed proving time in seconds (S2 typical 30-90s per scope §3.9). */
  provingSeconds?: number;
  /** Observed proving cost in USDC. */
  provingCostUsdc?: string;
  /** Failure reason iff status === "failed". */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface TeeWrapSubmitOptions {
  zkSystem?: ZkSystem;
  maxCostUsdc?: string;
  priority?: "low" | "normal" | "high";
  /** Required: injected Boundless client. */
  client: BoundlessClient;
}

export interface TeeWrapPollOptions {
  client: BoundlessClient;
}

/**
 * Submit a TEE-wrap S2 proof job for a DCC4 TDX quote.
 *
 * Returns the Boundless job id + a pollable URL. The caller queues a
 * `dcc5-upgrade-worker` task with the job id; the worker polls until done
 * and rewrites the InvocationReceipt with the resulting zkProof bytes.
 */
export async function submitTeeWrapJob(
  quoteBytesBase64: string,
  options: TeeWrapSubmitOptions,
): Promise<{ jobId: string; pollUrl?: string }> {
  const quoteBytes = base64ToBytes(quoteBytesBase64);
  return options.client.submitTeeWrapJob(quoteBytes, {
    zkSystem: options.zkSystem ?? "sp1",
    maxCostUsdc: options.maxCostUsdc,
    priority: options.priority,
  });
}

export async function pollTeeWrapJob(
  jobId: string,
  options: TeeWrapPollOptions,
): Promise<BoundlessJobStatus> {
  return options.client.pollJob(jobId);
}

/**
 * Compose the ZkProofMetadata struct PCC writes onto the receipt once
 * Boundless finishes the S2 proof.
 *
 * Uses the Automata tdx-attestation-sdk image id as `programCid` so the
 * verifier knows which Risc0/SP1 ELF was used.
 */
export function buildTeeWrapMetadata(
  jobStatus: BoundlessJobStatus,
  opts: {
    /** Image id of the Automata wrap circuit. */
    automataImageId: string;
    /** Verification-key digest matching the image id. */
    verificationKeyHash: string;
    /** Optional on-chain verifier (SP1Verifier.sol or Risc0Verifier.sol). */
    onchainVerifier?: { chainId: number; address: string };
    /** "sp1" or "risc0" — the system Boundless used. */
    zkSystem: ZkSystem;
  },
): ZkProofMetadata {
  if (jobStatus.status !== "complete") {
    throw new Error(
      `buildTeeWrapMetadata: job not complete (status=${jobStatus.status})`,
    );
  }
  return {
    zkSystem: opts.zkSystem,
    statement: "tee-wrap",
    programCid: opts.automataImageId,
    publicInputsHash: jobStatus.publicInputsHash ?? "",
    publicOutputsHash: jobStatus.publicOutputsHash ?? "",
    verificationKeyHash: opts.verificationKeyHash,
    onchainVerifier: opts.onchainVerifier,
    provingCostUsdc: jobStatus.provingCostUsdc,
    provingSeconds: jobStatus.provingSeconds,
  };
}

// ---------------------------------------------------------------------------
// Mock Boundless client for tests + early development
// ---------------------------------------------------------------------------

/**
 * In-memory mock Boundless client. Synchronously "completes" jobs after a
 * configurable delay. Useful in tests + when developing against the
 * upgrade-worker without a live Boundless connection.
 *
 * NOT for production. Use the Automata SDK client at startup.
 */
export function createMockBoundlessClient(opts?: {
  /** Simulated proving time. Default 100ms. */
  proveDelayMs?: number;
  /** Force failure on submit (e.g. to test the upgrade-worker retry path). */
  failOnSubmit?: boolean;
  /** Force failure on poll. */
  failOnPoll?: boolean;
}): BoundlessClient {
  const jobs = new Map<string, { startedAt: number; quoteHash: string }>();
  const delayMs = opts?.proveDelayMs ?? 100;

  return {
    async submitTeeWrapJob(quoteBytes, _submitOpts) {
      if (opts?.failOnSubmit) throw new Error("mock boundless submit failure");
      const jobId = `mock-job-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      jobs.set(jobId, {
        startedAt: Date.now(),
        quoteHash: hashHex(quoteBytes),
      });
      return { jobId, pollUrl: `mock://boundless/jobs/${jobId}` };
    },
    async pollJob(jobId) {
      if (opts?.failOnPoll) {
        return {
          jobId,
          status: "failed",
          reason: "mock boundless poll failure",
        };
      }
      const job = jobs.get(jobId);
      if (!job) {
        return { jobId, status: "failed", reason: "unknown job id" };
      }
      const elapsed = Date.now() - job.startedAt;
      if (elapsed < delayMs) {
        return { jobId, status: "proving" };
      }
      // Synthesize a "completed" result that round-trips through the
      // mock SP1 verifier wired with acceptUnverifiedInTest.
      return {
        jobId,
        status: "complete",
        proofBytesBase64: bytesToBase64(
          new Uint8Array(64).map((_, i) => (i + job.quoteHash.charCodeAt(0)) & 0xff),
        ),
        imageId: `mock-image-${job.quoteHash.slice(0, 16)}`,
        publicInputsHash: `sha256:${job.quoteHash.padEnd(64, "0").slice(0, 64)}`,
        publicOutputsHash: `sha256:${"a".repeat(64)}`,
        provingSeconds: elapsed / 1000,
        provingCostUsdc: "0.05",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array {
  const std = b64.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  const bin = typeof atob === "function"
    ? atob(padded)
    : Buffer.from(padded, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return typeof btoa === "function"
    ? btoa(bin)
    : Buffer.from(bin, "binary").toString("base64");
}

function hashHex(bytes: Uint8Array): string {
  // Deterministic non-crypto hash for mock-job dedup. NOT for production use.
  let h = 5381;
  for (let i = 0; i < bytes.length; i++) {
    h = ((h << 5) + h + bytes[i]!) | 0;
  }
  // pad to 16 hex chars
  return (h >>> 0).toString(16).padStart(16, "0");
}
