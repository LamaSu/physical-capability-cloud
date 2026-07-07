/**
 * Bundler / Paymaster configuration resolver.
 *
 * PCC's ERC-4337 stack (`@pcc/bundler`) is provider-agnostic — it only needs a
 * bundler RPC URL and (optionally) a paymaster RPC URL. Historically the two
 * consumers read *different* env vars:
 *
 *   - routes/gasless.ts        → BUNDLER_URL / COINBASE_PAYMASTER_URL / CDP_API_KEY
 *   - contracts/batch-settlement.ts → PCC_BUNDLER_URL / PCC_PAYMASTER_URL
 *
 * and neither recognized ZeroDev. This module is the single source of truth:
 * it resolves a bundler + paymaster URL from the environment across every
 * supported provider (ZeroDev, Coinbase CDP, Pimlico/self-hosted, or a raw
 * custom URL), preserving the legacy var names so nothing breaks.
 *
 * Precedence (first non-empty wins), most specific → most legacy:
 *   bundler:   ZERODEV_BUNDLER_URL → ZeroDev(projectId) → PCC_BUNDLER_URL
 *              → BUNDLER_URL → COINBASE_PAYMASTER_URL → Coinbase(CDP key)
 *   paymaster: ZERODEV_PAYMASTER_URL → ZeroDev(projectId) → PCC_PAYMASTER_URL
 *              → COINBASE_PAYMASTER_URL → Coinbase(CDP key)
 *
 * Nothing here makes a network call. Missing config yields provider "none" and
 * the callers degrade gracefully (gasless reports unconfigured; batch
 * settlement stays disabled).
 */

export type BundlerProvider =
  | "zerodev"
  | "coinbase-cdp"
  | "pimlico"
  | "custom"
  | "none";

export type SupportedChain = "base" | "base-sepolia";

export interface ResolvedBundlerConfig {
  /** Bundler RPC URL, or undefined if nothing is configured. */
  bundlerUrl?: string;
  /** Paymaster RPC URL, or undefined if gas is self-paid. */
  paymasterUrl?: string;
  /** Which provider the config resolved to. */
  provider: BundlerProvider;
  /** Normalized chain name. */
  chain: SupportedChain;
  /** EVM chain id (base = 8453, base-sepolia = 84532). */
  chainId: number;
  /** True when a paymaster URL is present (gas is sponsored). */
  sponsored: boolean;
}

type Env = Record<string, string | undefined>;

const CHAIN_IDS: Record<SupportedChain, number> = {
  base: 8453,
  "base-sepolia": 84532,
};

const COINBASE_RPC_BASE = "https://api.developer.coinbase.com/rpc/v1";

/** Normalize any chain hint (env var, network name) to a supported chain. */
export function normalizeChain(value: string | undefined): SupportedChain {
  return value === "base" || value === "mainnet" ? "base" : "base-sepolia";
}

/**
 * Build a ZeroDev v3 meta-AA RPC URL from a project id.
 *
 * ZeroDev's v3 endpoint serves BOTH bundler and paymaster from one URL:
 *   https://rpc.zerodev.app/api/v3/<projectId>/chain/<chainId>
 *
 * Prefer pasting the exact URLs from your ZeroDev dashboard into
 * ZERODEV_BUNDLER_URL / ZERODEV_PAYMASTER_URL — this constructor is a
 * convenience for the common v3 case and the format may change across
 * ZeroDev API versions.
 */
export function zeroDevUrl(projectId: string, chainId: number): string {
  return `https://rpc.zerodev.app/api/v3/${projectId}/chain/${chainId}`;
}

/** Build a Coinbase CDP combined bundler+paymaster URL from an API key. */
export function coinbaseUrl(apiKey: string, chain: SupportedChain): string {
  return `${COINBASE_RPC_BASE}/${chain}/${apiKey}`;
}

const firstNonEmpty = (...vals: Array<string | undefined>): string | undefined => {
  for (const v of vals) {
    if (v && v.trim().length > 0) return v.trim();
  }
  return undefined;
};

/**
 * Resolve the bundler/paymaster configuration from the environment.
 *
 * @param env  Environment source (defaults to `process.env`; injectable for tests).
 */
export function resolveBundlerConfig(env: Env = process.env): ResolvedBundlerConfig {
  const chain = normalizeChain(
    firstNonEmpty(env.ZERODEV_CHAIN, env.BUNDLER_CHAIN, env.PCC_NETWORK),
  );
  const chainId = CHAIN_IDS[chain];

  const zdProject = firstNonEmpty(env.ZERODEV_PROJECT_ID);
  const zdBundler = firstNonEmpty(
    env.ZERODEV_BUNDLER_URL,
    zdProject ? zeroDevUrl(zdProject, chainId) : undefined,
  );
  const zdPaymaster = firstNonEmpty(
    env.ZERODEV_PAYMASTER_URL,
    zdProject ? zeroDevUrl(zdProject, chainId) : undefined,
  );

  const cdpKey = firstNonEmpty(env.CDP_API_KEY, env.COINBASE_API_KEY);
  const cdpUrl = firstNonEmpty(
    env.COINBASE_PAYMASTER_URL,
    cdpKey ? coinbaseUrl(cdpKey, chain) : undefined,
  );

  const bundlerUrl = firstNonEmpty(
    zdBundler,
    env.PCC_BUNDLER_URL,
    env.BUNDLER_URL,
    cdpUrl,
  );
  const paymasterUrl = firstNonEmpty(
    zdPaymaster,
    env.PCC_PAYMASTER_URL,
    cdpUrl,
  );

  const provider: BundlerProvider = zdBundler
    ? "zerodev"
    : cdpUrl && (bundlerUrl === cdpUrl || paymasterUrl === cdpUrl)
      ? "coinbase-cdp"
      : bundlerUrl
        ? bundlerUrl.includes("pimlico")
          ? "pimlico"
          : "custom"
        : "none";

  return {
    bundlerUrl,
    paymasterUrl,
    provider,
    chain,
    chainId,
    sponsored: !!paymasterUrl,
  };
}

// Path segments that are structural (not secrets) and should stay visible.
const REDACT_KEEP = new Set([
  "api", "rpc", "chain", "bundler", "paymaster",
  "base", "base-sepolia", "sepolia", "ethereum", "polygon",
  "v1", "v2", "v3",
]);

/**
 * Redact secrets from a bundler/paymaster URL for safe logging or API exposure.
 *
 * Drops the query string (Pimlico/Alchemy carry the API key as `?apikey=`) and
 * masks any long, opaque path segment — the ZeroDev project id sits *mid*-path
 * (`/v3/<projectId>/chain/<id>`), and the Coinbase CDP key is the tail segment,
 * so masking only one position is not enough. Short structural tokens
 * (`api`, `v3`, `chain`, `base-sepolia`, a numeric chain id) stay visible.
 * Never throws — returns "configured" on parse failure.
 */
export function redactBundlerUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const parts = u.pathname
      .split("/")
      .filter(Boolean)
      .map((seg) =>
        !REDACT_KEEP.has(seg.toLowerCase()) && seg.length >= 12 ? "***" : seg,
      );
    return `${u.origin}/${parts.join("/")}`;
  } catch {
    return "configured";
  }
}
