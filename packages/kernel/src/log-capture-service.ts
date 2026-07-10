/**
 * LogCaptureService — captures machine/printer logs with a tamper-evident hash chain.
 *
 * Each log entry is:
 *   1. Content-addressed (SHA-256 of raw content + source + timestamp)
 *   2. Linked to previous entry (hash chain — each entry references the previous hash)
 *   3. Signed by the kernel key (not the agent key)
 *
 * The agent routes the signed envelopes but cannot modify the content
 * or forge the kernel signature.
 *
 * Chain structure:
 *   Genesis: previousHash = sha256:0000...0000 (64 zeros)
 *   Entry N: previousHash = entryHash of entry N-1
 */

import { verifyLogChain, computeLogEntryHash } from "@pcc/spec";
import type { SHA256, Signature, Timestamp, EvidenceEvent, EvidenceEventType } from "@pcc/spec";
import { ids } from "@pcc/spec";
import type { KernelKeychain } from "./kernel-keychain.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Genesis sentinel: the previousHash for the first entry in a chain */
const GENESIS_HASH: SHA256 = `sha256:${"0".repeat(64)}` as SHA256;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LogEntry {
  /** Unique identifier for this log entry */
  entryId: string;
  /** SHA-256 of the canonical serialization of (rawContent + source + capturedAt) */
  entryHash: SHA256;
  /** Hash of the previous entry (GENESIS_HASH for the first entry) */
  previousHash: SHA256;
  /** The raw log content as captured from the machine/printer */
  rawContent: string;
  /** Source URI, e.g. "cups://job-123", "ipp://printer/job-456", "os://print-queue" */
  source: string;
  /** ISO 8601 timestamp when the entry was captured */
  capturedAt: Timestamp;
  /** Kernel signature over entryHash — proves the kernel (not the agent) captured this */
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

// ---------------------------------------------------------------------------
// LogCaptureService
// ---------------------------------------------------------------------------

export class LogCaptureService {
  private entries: LogEntry[] = [];

  constructor(private kernelKeychain: KernelKeychain) {}

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Compute the hash for a log entry's content fields.
   *  Delegates to the shared, extracted formula (single source of truth shared
   *  with the oracle's #52 machine.execution_log verifier). */
  private async computeEntryHash(
    rawContent: string,
    source: string,
    capturedAt: Timestamp,
  ): Promise<SHA256> {
    return computeLogEntryHash(rawContent, source, capturedAt);
  }

  /** Get the hash of the last entry, or GENESIS_HASH if chain is empty */
  private getPreviousHash(): SHA256 {
    if (this.entries.length === 0) {
      return GENESIS_HASH;
    }
    return this.entries[this.entries.length - 1]!.entryHash;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Capture a single log entry, hash-chain it, and sign with the kernel key.
   *
   * @param rawContent - The raw log line or block from the machine/printer
   * @param source - Source URI identifying where this log came from
   * @returns The sealed LogEntry with hash, chain link, and kernel signature
   */
  async captureEntry(rawContent: string, source: string): Promise<LogEntry> {
    const capturedAt: Timestamp = new Date().toISOString();
    const entryId = ids.evidence(); // reuse evidence ID space

    const entryHash = await this.computeEntryHash(rawContent, source, capturedAt);
    const previousHash = this.getPreviousHash();

    // Sign the entryHash — the kernel attests "I captured this content at this time"
    const kernelSignature = await this.kernelKeychain.signEvidence(entryHash);

    const entry: LogEntry = {
      entryId,
      entryHash,
      previousHash,
      rawContent,
      source,
      capturedAt,
      kernelSignature,
    };

    this.entries.push(entry);
    return entry;
  }

  /**
   * Get the current chain (defensive copy).
   */
  getChain(): LogEntry[] {
    return [...this.entries];
  }

  /**
   * Verify the entire hash chain is intact.
   *
   * Checks:
   *   1. Each entry's entryHash matches a fresh recomputation of its content fields
   *   2. Each entry's previousHash correctly references the prior entry's entryHash
   *   3. The first entry's previousHash is GENESIS_HASH
   *   4. Each entry's kernel signature is valid
   */
  async verifyChain(): Promise<LogChainVerification> {
    // Delegates to the shared, extracted verifier (evidence-vocab #52
    // machine.execution_log). The kernel injects its own keychain as the
    // signature check; the oracle injects a registered-key (#47) check instead.
    // Behavior — hash recompute, chain-link continuity, genesis check, error
    // strings and brokenAt — is byte-identical to the prior inline version.
    return verifyLogChain(this.entries, (entryHash, signature) =>
      this.kernelKeychain.verifySignature(entryHash, signature),
    );
  }

  /**
   * Convert the chain to evidence events for the EvidenceEmitter.
   *
   * Each LogEntry becomes a `log_hash_chain_entry` evidence event.
   * The payload contains the full chain entry (minus rawContent which may be large —
   * only the hash is needed for the bundle).
   */
  toEvidenceEvents(): Array<Omit<EvidenceEvent, "id" | "hash">> {
    return this.entries.map((entry) => ({
      type: "log_hash_chain_entry" as EvidenceEventType,
      timestamp: entry.capturedAt,
      source: {
        deviceId: entry.source,
        deviceType: "gateway_bridge" as const,
        kernelId: entry.kernelSignature.signer,
      },
      payload: {
        entryId: entry.entryId,
        entryHash: entry.entryHash,
        previousHash: entry.previousHash,
        source: entry.source,
        capturedAt: entry.capturedAt,
        kernelSignature: entry.kernelSignature,
      },
    }));
  }

  /**
   * Reset the chain (call this when starting a new job).
   * Clears all entries so the next captureEntry() starts a fresh genesis.
   */
  reset(): void {
    this.entries = [];
  }
}
