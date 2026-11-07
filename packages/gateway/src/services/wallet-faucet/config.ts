import { walletLinkConfig } from "../wallet-links/config.js";

const TEST_NETWORKS = new Set(["base-sepolia", "sepolia", "flow-evm-testnet", "localhost"]);

export function faucetRoutesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    if (!TEST_NETWORKS.has(env.PCC_NETWORK ?? "base-sepolia")) return false;
    if (env.CDP_NETWORK !== undefined && env.CDP_NETWORK !== "base-sepolia") return false;
    if (env.PCC_X402_CHAIN !== undefined && env.PCC_X402_CHAIN !== "base-sepolia") return false;
    const chains = walletLinkConfig().allowedChainIds;
    return chains.length === 1 && chains[0] === 84532;
  } catch {
    return false;
  }
}
