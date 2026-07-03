/**
 * RPC transport builder — primary + fallback URLs with retry, backoff, and
 * per-request timeout.
 *
 * The gateway's chain reads/writes previously used a single `http(rpcUrl)` with
 * no retry and no timeout, hardcoded to sepolia.base.org. A rate-limited or
 * laggy primary endpoint then stalled (or dropped) settlement transactions. This
 * builds a viem `fallback([...])` transport so a failing/slow endpoint rotates to
 * the next URL, with each endpoint retrying transient errors on its own.
 *
 * Pure viem — the URL list comes from `getRpcUrls(network)` in @pcc/contracts
 * (the single source of truth for failover ordering); this module only turns a
 * list into a transport, so it stays trivially unit-testable.
 */

import { http, fallback, type Transport } from "viem";

export interface RpcTransportOptions {
  /** Per-request timeout in ms (default 10_000, env: PCC_RPC_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Per-endpoint retry attempts on transient errors (default 2, env: PCC_RPC_RETRY_COUNT). */
  retryCount?: number;
  /** Base retry backoff in ms — viem applies exponential backoff (default 150). */
  retryDelayMs?: number;
}

/** Last-resort URL if an empty list is passed (mirrors the historical hardcode). */
const DEFAULT_RPC_URL = "https://sepolia.base.org";

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

function resolveOptions(opts: RpcTransportOptions): Required<RpcTransportOptions> {
  return {
    timeoutMs: opts.timeoutMs ?? envInt("PCC_RPC_TIMEOUT_MS") ?? 10_000,
    retryCount: opts.retryCount ?? envInt("PCC_RPC_RETRY_COUNT") ?? 2,
    retryDelayMs: opts.retryDelayMs ?? envInt("PCC_RPC_RETRY_DELAY_MS") ?? 150,
  };
}

/**
 * Build a viem transport from an ordered URL list (primary first).
 *
 * - 1 URL  → a single `http` transport with retry + timeout.
 * - N URLs → a `fallback` over per-URL `http` transports. Each endpoint retries
 *   transient errors internally; the fallback rotates to the next URL when an
 *   endpoint fails outright. `rank: false` preserves the explicit primary-first
 *   order (we want the canonical RPC first, fallbacks only on failure — not a
 *   latency reshuffle that could prefer a flaky-but-fast endpoint).
 */
export function buildRpcTransport(urls: string[], opts: RpcTransportOptions = {}): Transport {
  const { timeoutMs, retryCount, retryDelayMs } = resolveOptions(opts);

  const cleaned = urls.map((u) => u?.trim()).filter((u): u is string => !!u);
  const list = cleaned.length > 0 ? cleaned : [DEFAULT_RPC_URL];

  const transports = list.map((url) =>
    http(url, { timeout: timeoutMs, retryCount, retryDelay: retryDelayMs }),
  );

  if (transports.length === 1) return transports[0];

  // retryCount: 0 on the fallback itself → a single pass through the URL list per
  // request (each URL already retries internally), rotating on per-endpoint
  // failure. This is failover, not duplicated retry storms.
  return fallback(transports, { rank: false, retryCount: 0 });
}

// ---------------------------------------------------------------------------
// chainId preflight (security review, PR #157 point 2)
// ---------------------------------------------------------------------------
//
// Reads can fail over across `PCC_RPC_URLS` freely. A PAID WRITE must not — a
// URL that silently serves a different chain (a misconfigured entry, or a
// provider that swapped networks) would otherwise be eligible for a settlement
// broadcast, and a wrong-chain broadcast is a lost tx at best. These helpers
// verify each endpoint's `eth_chainId` against the expected chain BEFORE it can
// carry a write; callers gate the write path on `assertRpcChainIds` (awaited
// once, cached). Reads never call this.

/**
 * Return the endpoint's chainId (via `eth_chainId`); throw if it doesn't match
 * `expectedChainId` or the endpoint is unreachable. `fetchImpl` is injectable
 * for unit tests.
 */
export async function assertRpcChainId(
  url: string,
  expectedChainId: number,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let chainId: number;
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: controller.signal,
    });
    const body = (await res.json()) as { result?: string };
    if (typeof body?.result !== "string") {
      throw new Error(`eth_chainId returned no result from ${url}`);
    }
    chainId = Number.parseInt(body.result, 16);
    if (!Number.isFinite(chainId)) {
      throw new Error(`eth_chainId returned an unparseable value from ${url}: ${body.result}`);
    }
  } finally {
    clearTimeout(timer);
  }
  if (chainId !== expectedChainId) {
    throw new Error(
      `RPC ${url} is on chain ${chainId}, expected ${expectedChainId} — refusing it for writes (wrong-chain broadcast risk)`,
    );
  }
  return chainId;
}

/**
 * Verify EVERY configured RPC URL is on the expected chain (parallel). Rejects
 * with the first mismatch/unreachable, so a bad `PCC_RPC_URLS` is caught at
 * write-client init rather than mid-settlement. Await once and cache the result.
 */
export async function assertRpcChainIds(
  urls: string[],
  expectedChainId: number,
  opts?: { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<void> {
  const cleaned = urls.map((u) => u?.trim()).filter((u): u is string => !!u);
  await Promise.all(cleaned.map((u) => assertRpcChainId(u, expectedChainId, opts)));
}
