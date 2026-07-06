/**
 * Per-signer nonce manager / sequential transaction queue.
 *
 * The gateway settles on-chain from a SINGLE hot signer. Multiple concurrent
 * settlements (or a create+addMilestone pair on a laggy public RPC) can hand
 * viem's auto-nonce the same value twice — the second tx is dropped/replaced and
 * a milestone (or a release) silently vanishes. PR #145 pinned nonces inline for
 * one route; this module consolidates that into a reusable primitive that ALL
 * on-chain writes route through:
 *
 *   - Submission is SERIALIZED per signer (a promise-chain tail), so two writes
 *     never race for a nonce regardless of RPC propagation lag.
 *   - Nonces are pinned MONOTONICALLY from a single `eth_getTransactionCount`
 *     ("pending") seed, then incremented locally per confirmed broadcast — no
 *     re-read between every tx (which is itself the race window).
 *   - On a nonce error ("nonce too low", "already known", …) the local cursor is
 *     invalidated and re-seeded from chain on the next write, so a desync
 *     self-heals instead of wedging the signer.
 *
 * The registry is process-wide and keyed by signer address, so independent code
 * paths writing from the same hot key (e.g. paid-job-flow create+addMilestone and
 * escrow-client release/attestation) share ONE serialization chain — that
 * cross-path collision is exactly the "concurrent settlements" hazard the queue
 * exists to remove.
 */

/**
 * RPC/error substrings that indicate a nonce desync (the local cursor must be
 * re-seeded from chain). Matched case-insensitively against the stringified
 * error — viem nests the provider message in `details`/`shortMessage`/`cause`.
 */
const NONCE_ERROR_SIGNALS = [
  "nonce too low",
  "nonce too high",
  "nonce has already been used",
  "invalid nonce",
  "already known",
  "replacement transaction underpriced",
  "oldnonce",
  "noncetoolow",
  "tx doesn't have the correct nonce",
] as const;

/**
 * RPC/error substrings that mean the IDENTICAL signed tx is ALREADY known to the
 * network (in the mempool / imported) — an idempotent result under RPC failover, NOT
 * a nonce desync. viem's `fallback` re-broadcasts the byte-identical raw tx on
 * failover, so a rotated retry that lands on a node which already saw the tx reports
 * one of these. This set is a SUBSET signal of NONCE_ERROR_SIGNALS' intent but is
 * treated differently by the write path (security review #157 point 1): an
 * "already known" resolves to the pre-computed hash (the tx will mine), whereas a
 * bare "nonce too low" is ambiguous and must be confirmed on-chain first.
 */
const ALREADY_KNOWN_SIGNALS = [
  "already known",
  "already imported",
  "alreadyknown",
  "transaction already exists",
  "known transaction",
  "duplicate transaction",
] as const;

/**
 * Flatten an error (including viem's nested `shortMessage`/`details`/`cause`) to one
 * lowercased string for substring matching. Shared by the error classifiers below.
 */
function errorBlob(err: unknown): string {
  try {
    const e = err as { message?: string; details?: string; shortMessage?: string; cause?: unknown };
    return [
      e?.shortMessage,
      e?.message,
      e?.details,
      typeof e?.cause === "object" ? JSON.stringify(e.cause) : String(e?.cause ?? ""),
      String(err),
    ]
      .filter(Boolean)
      .join(" | ")
      .toLowerCase();
  } catch {
    return String(err).toLowerCase();
  }
}

function matchErrorSignals(err: unknown, signals: readonly string[]): boolean {
  const blob = errorBlob(err);
  return signals.some((s) => blob.includes(s));
}

/** True if an error looks like a nonce desync (vs a revert / funds / RPC outage). */
export function isNonceError(err: unknown): boolean {
  return matchErrorSignals(err, NONCE_ERROR_SIGNALS);
}

/**
 * True if an error means the identical tx is already known/in-mempool — idempotent
 * under failover (the tx will mine), so the write path resolves with the known hash
 * instead of rethrowing. Distinct from (and narrower than) `isNonceError`.
 */
export function isAlreadyKnownError(err: unknown): boolean {
  return matchErrorSignals(err, ALREADY_KNOWN_SIGNALS);
}

/**
 * Escape hatch: set `PCC_NONCE_MANAGER_DISABLED=true` to bypass the queue and
 * fall back to viem's built-in auto-nonce (the pre-#145 behaviour). On-chain
 * effects are identical when the manager is enabled; this exists purely as a
 * reversible kill-switch if the explicit-nonce path ever misbehaves in prod —
 * no code change / redeploy needed to revert.
 */
export function isNonceManagerDisabled(): boolean {
  const v = process.env.PCC_NONCE_MANAGER_DISABLED;
  return v === "true" || v === "1" || v === "yes";
}

/** A function that reads the signer's next ("pending") nonce from chain. */
export type FetchPendingNonce = () => Promise<number>;

export class NonceManager {
  /** Local nonce cursor; null until first seeded (or after a desync). */
  private current: number | null = null;
  /** Serialization chain — every submit awaits the previous one's completion. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly fetchPending: FetchPendingNonce) {}

  /**
   * Submit one on-chain write under the queue. `send(nonce)` MUST perform the
   * actual broadcast (e.g. `walletClient.writeContract({ ..., nonce })`) and
   * resolve with its result (typically the tx hash). The assigned nonce is only
   * committed (cursor advanced) once `send` resolves — a throw leaves the nonce
   * reusable (the tx never entered the mempool), and a nonce-shaped throw forces
   * a chain re-seed on the next call.
   */
  submit<T>(send: (nonce: number) => Promise<T>): Promise<T> {
    const run = this.tail.then(() => this.run(send));
    // Keep the chain alive even if this run rejects, so a single failed write
    // does not wedge every subsequent submit on a rejected tail.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async run<T>(send: (nonce: number) => Promise<T>): Promise<T> {
    const nonce = await this.reserve();
    try {
      const result = await send(nonce);
      this.current = nonce + 1;
      return result;
    } catch (err) {
      if (isNonceError(err)) {
        // Desync: drop the local cursor so the next submit re-seeds from chain.
        this.current = null;
      }
      throw err;
    }
  }

  private async reserve(): Promise<number> {
    if (this.current === null) {
      this.current = await this.fetchPending();
    }
    return this.current;
  }

  /** Current local cursor (next nonce to hand out), or null if unseeded. Test/telemetry. */
  peek(): number | null {
    return this.current;
  }

  /** Force a re-seed from chain on the next submit. */
  reset(): void {
    this.current = null;
  }
}

// ---------------------------------------------------------------------------
// Process-wide registry (one manager per signer address)
// ---------------------------------------------------------------------------

const registry = new Map<string, NonceManager>();

/**
 * Resolve the shared NonceManager for a signer address, creating it on first
 * use. The `fetchPending` of the FIRST caller wins (any public client reading
 * the same address returns the same chain nonce, so this is safe even when
 * different code paths pass differently-configured clients).
 */
export function getNonceManager(address: string, fetchPending: FetchPendingNonce): NonceManager {
  const key = address.toLowerCase();
  let manager = registry.get(key);
  if (!manager) {
    manager = new NonceManager(fetchPending);
    registry.set(key, manager);
  }
  return manager;
}

/** Drop all managers. For tests (and a hard reset after a signer rotation). */
export function resetNonceManagers(): void {
  registry.clear();
}
