/**
 * Shared CLI plumbing — env loading, RPC client construction, simple
 * argv parsing without pulling in a CLI framework.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

import { PLRRegistryClient } from "../client.js";

const CHAIN_BY_NAME: Record<string, Chain> = {
  base,
  "base-sepolia": baseSepolia,
};

export interface CliEnv {
  registryAddress: `0x${string}`;
  chain: Chain;
  rpcUrl: string;
  privateKey?: `0x${string}`;
}

/**
 * Read env vars common to all CLIs. Fails fast if registryAddress / chain
 * aren't set; treats private key as optional (status command doesn't need it).
 */
export function loadEnv(): CliEnv {
  const registryAddress = process.env.PLR_BACKEND_REGISTRY_ADDRESS as
    | `0x${string}`
    | undefined;
  if (!registryAddress) {
    throw new Error(
      "PLR_BACKEND_REGISTRY_ADDRESS env var required (deployed PLRBackendRegistry contract address)",
    );
  }

  const chainName = (process.env.PLR_BACKEND_REGISTRY_CHAIN ?? "base") as string;
  const chain = CHAIN_BY_NAME[chainName];
  if (!chain) {
    throw new Error(
      `PLR_BACKEND_REGISTRY_CHAIN=${chainName} unsupported. Try: ${Object.keys(CHAIN_BY_NAME).join(", ")}`,
    );
  }

  const rpcUrl =
    process.env.PLR_BACKEND_REGISTRY_RPC_URL ??
    chain.rpcUrls.default.http[0];

  const privateKey = process.env.DEPLOYER_PRIVATE_KEY as
    | `0x${string}`
    | undefined;

  return { registryAddress, chain, rpcUrl, privateKey };
}

/**
 * Construct a read-only client (no signer). Used by `pcc-plr-status`.
 */
export function makeReadOnlyClient(env: CliEnv): PLRRegistryClient {
  const publicClient = createPublicClient({
    chain: env.chain,
    transport: http(env.rpcUrl),
  });
  return new PLRRegistryClient({
    registryAddress: env.registryAddress,
    publicClient,
  });
}

/**
 * Construct a writeable client. Requires DEPLOYER_PRIVATE_KEY in env.
 */
export function makeWritableClient(env: CliEnv): {
  client: PLRRegistryClient;
  address: `0x${string}`;
} {
  if (!env.privateKey) {
    throw new Error(
      "DEPLOYER_PRIVATE_KEY env var required for write operations",
    );
  }
  const account = privateKeyToAccount(env.privateKey);
  const publicClient = createPublicClient({
    chain: env.chain,
    transport: http(env.rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: env.chain,
    transport: http(env.rpcUrl),
  });
  return {
    client: new PLRRegistryClient({
      registryAddress: env.registryAddress,
      publicClient,
      walletClient,
    }),
    address: account.address,
  };
}

/**
 * Tiny argv-to-flags parser. Recognizes `--key value` and `--flag` shapes.
 * No dependencies; just enough for our 3 commands.
 */
export function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; ++i) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      ++i;
    }
  }
  return flags;
}

export function requireFlag(
  flags: Record<string, string | boolean>,
  key: string,
): string {
  const v = flags[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`--${key} required`);
  }
  return v;
}
