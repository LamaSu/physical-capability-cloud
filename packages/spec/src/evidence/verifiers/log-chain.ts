/**
 * Machine-log hash-chain verification — the SHARED, extracted home of the
 * kernel-signed log chain verifier (evidence-vocabulary §5, primitive #52
 * machine.execution_log).
 *
 * The verification logic was extracted VERBATIM from
 * `packages/kernel/src/log-capture-service.ts` (`verifyChain` + the entry-hash
 * recompute) so BOTH the kernel capture path AND the oracle settlement lane can
 * call the exact same code. The kernel `LogCaptureService.verifyChain()` now
 * delegates here; the oracle mirrors-by-value with parity fixtures.
 *
 * The one intentional change vs the class method: the kernel-signature check is
 * INJECTED as a callback (`verifyKernelSignature`) rather than reaching into
 * `this.kernelKeychain`. This makes the verifier a pure function usable outside
 * the kernel (the oracle supplies a registered-key check — evidence-vocab #47
 * ident.registered_key — in place of the kernel's self-verify; design §4 #52
 * predicate (c)). Hash recompute, chain-link continuity, genesis check, error
 * strings and `brokenAt` semantics are byte-identical to the original, pinned by
 * `__tests__/verifier-parity.test.ts` and the kernel's own `log-capture.test.ts`.
 *
 * This file adds NO new verification logic — it is a relocation. The oracle-side
 * PrimitiveVerifier binding for #52 lives in the settlement lane and is only
 * STUBBED here (see `oracle-binding.ts`).
 */

import { sha256, canonicalize } from "../../util/canonical.js";
import type { SHA256, Signature, Timestamp } from "../../types/common.js";

/** Genesis sentinel: the previousHash for the first entry in a chain. */
export const GENESIS_HASH: SHA256 = `sha256:${"0".repeat(64)}` as SHA256;

/**
 * The subset of a captured log entry the chain verifier reads. Structurally a
 * superset-compatible view of the kernel's `LogEntry` (which is assignable to
 * this), so `verifyLogChain(service.getChain(), ...)` type-checks unchanged.
 */
export interface LogChainEntryView {
  entryId: string;
  entryHash: SHA256;
  previousHash: SHA256;
  rawContent: string;
  source: string;
  capturedAt: Timestamp;
  kernelSignature: Signature;
}

export interface LogChainVerification {
  /** Whether the entire chain is valid */
  valid: boolean;
  /** Total number of entries examined */
  entries: number;
  /** Index of the first broken link (undefined if chain is intact) */
  brokenAt?: number;
  /** Descriptions of all errors found */
  errors: string[];
}

/**
 * Injected signature check. In the kernel this wraps
 * `KernelKeychain.verifySignature`; in the oracle it resolves the signer against
 * the registered-key snapshot (#47). Returns true iff the signature over
 * `entryHash` is valid for the expected signer.
 */
export type VerifyKernelSignature = (
  entryHash: SHA256,
  signature: Signature,
) => Promise<boolean> | boolean;

/**
 * Compute the hash for a log entry's content fields:
 * sha256(canonicalize({ capturedAt, rawContent, source })).
 *
 * Byte-identical to `LogCaptureService.computeEntryHash` — the capture path and
 * the verify path share this one formula (single source of truth).
 */
export async function computeLogEntryHash(
  rawContent: string,
  source: string,
  capturedAt: Timestamp,
): Promise<SHA256> {
  const hashInput = { capturedAt, rawContent, source };
  return sha256(canonicalize(hashInput));
}

/**
 * Verify a kernel-signed hash chain. Checks, in order, for each entry:
 *   1. entryHash matches a fresh recomputation of its content fields
 *   2. previousHash correctly references the prior entry's entryHash
 *      (GENESIS_HASH for the first entry)
 *   3. the kernel signature over entryHash is valid
 *
 * Never throws. `brokenAt` is the index of the FIRST failing entry (any check).
 * Error strings are stable substrings ("entryHash mismatch", "chain link
 * broken", "kernel signature invalid") consumed by callers/tests.
 */
export async function verifyLogChain(
  entries: readonly LogChainEntryView[],
  verifyKernelSignature: VerifyKernelSignature,
): Promise<LogChainVerification> {
  const errors: string[] = [];
  let brokenAt: number | undefined;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;

    // 1. Recompute the hash and compare
    const expectedHash = await computeLogEntryHash(
      entry.rawContent,
      entry.source,
      entry.capturedAt,
    );
    if (expectedHash !== entry.entryHash) {
      if (brokenAt === undefined) brokenAt = i;
      errors.push(
        `Entry ${i} (${entry.entryId}): entryHash mismatch — expected ${expectedHash}, got ${entry.entryHash}`,
      );
    }

    // 2. Check hash chain link
    const expectedPrevious: SHA256 = i === 0 ? GENESIS_HASH : entries[i - 1]!.entryHash;

    if (entry.previousHash !== expectedPrevious) {
      if (brokenAt === undefined) brokenAt = i;
      errors.push(
        `Entry ${i} (${entry.entryId}): chain link broken — previousHash ${entry.previousHash} does not match expected ${expectedPrevious}`,
      );
    }

    // 3. Verify kernel signature
    const sigValid = await verifyKernelSignature(entry.entryHash, entry.kernelSignature);
    if (!sigValid) {
      if (brokenAt === undefined) brokenAt = i;
      errors.push(`Entry ${i} (${entry.entryId}): kernel signature invalid`);
    }
  }

  return {
    valid: errors.length === 0,
    entries: entries.length,
    brokenAt,
    errors,
  };
}
