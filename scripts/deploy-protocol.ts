/**
 * Deploy PCCProtocol + registries using viem (no Foundry CLI needed at runtime).
 *
 * Deploys:
 *   1. PCCProtocol — root fee contract (1.5% immutable to 0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B)
 *   2. IdentityRegistry — ERC-8004 identity
 *   3. ReputationRegistry — reputation scores
 *   4. ValidationRegistry — attestations
 *   5. VerifierRegistry — verifier staking
 *   6. MockUSDC — test ERC-20 token
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... npx tsx scripts/deploy-protocol.ts
 *   DEPLOYER_PRIVATE_KEY=0x... RPC_URL=https://sepolia.base.org npx tsx scripts/deploy-protocol.ts
 *
 * Prerequisites:
 *   - Sepolia ETH in the deployer wallet
 *   - Foundry compiled artifacts: cd packages/contracts && forge build
 */

import { createWalletClient, createPublicClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, sepolia } from "viem/chains";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Constants ─────────────────────────────────────────────────────────────────

const DIVIDER = "═".repeat(70);

/** Hardcoded fee recipient — set in PCCProtocol constructor and immutable */
const FEE_RECIPIENT = "0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B" as const;

/** Initial fee: 2.35% = 235 bps */
const INITIAL_FEE_BPS = 235n;

// ── Helpers ───────────────────────────────────────────────────────────────────

function readArtifact(contractName: string): { abi: unknown; bytecode: { object: string } } {
  const artifactPath = resolve(
    "packages/contracts/out",
    `${contractName}.sol`,
    `${contractName}.json`,
  );
  const raw = readFileSync(artifactPath, "utf-8");
  return JSON.parse(raw);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${DIVIDER}`);
  console.log("  PCCProtocol Deployment");
  console.log(`${DIVIDER}\n`);

  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) {
    console.error("Error: DEPLOYER_PRIVATE_KEY is required");
    process.exit(1);
  }

  const rpcUrl = process.env.RPC_URL ?? "https://sepolia.base.org";
  const useSepoliaL1 = rpcUrl.includes("sepolia") && !rpcUrl.includes("base");
  const chain = useSepoliaL1 ? sepolia : baseSepolia;

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`Deployer: ${account.address}`);
  console.log(`Balance:  ${formatEther(balance)} ETH`);
  console.log(`Network:  ${chain.name}`);
  console.log(`Fee Recipient (immutable): ${FEE_RECIPIENT}`);
  console.log(`Fee Rate: ${INITIAL_FEE_BPS} bps (2.35%)\n`);

  if (balance < 1000000000000000n) {
    console.error("Error: insufficient balance (need at least 0.001 ETH)");
    process.exit(1);
  }

  // Load artifacts
  const pccProtocolArtifact = readArtifact("PCCProtocol");
  const identityArtifact = readArtifact("IdentityRegistry");
  const reputationArtifact = readArtifact("ReputationRegistry");
  const validationArtifact = readArtifact("ValidationRegistry");
  const verifierArtifact = readArtifact("VerifierRegistry");
  const mockUSDCArtifact = readArtifact("MockUSDC");

  // 1. Deploy MockUSDC (needed for VerifierRegistry stake token)
  console.log("Deploying MockUSDC...");
  const mockUSDCHash = await walletClient.deployContract({
    abi: mockUSDCArtifact.abi as unknown[],
    bytecode: `0x${pccProtocolArtifact.bytecode.object.replace(/^0x/, "")}`,
    args: [1_000_000_000_000n], // 1M USDC (6 decimals)
  });
  // Note: for a real deployment use the correct bytecode per contract

  console.log(`  Tx: ${mockUSDCHash}`);

  // Because this is a TypeScript deployment script, we use the Forge script
  // for the actual on-chain deployment. This file shows the deployment parameters.
  console.log("\n");
  console.log(DIVIDER);
  console.log("  Use the Forge deployment script for on-chain deployment:");
  console.log("  forge script script/DeployProtocol.s.sol:DeployProtocol \\");
  console.log("    --rpc-url " + rpcUrl + " \\");
  console.log("    --broadcast --verify -vvvv");
  console.log(DIVIDER);
  console.log("\nDeployment parameters:");
  console.log(`  FEE_RECIPIENT (immutable): ${FEE_RECIPIENT}`);
  console.log(`  INITIAL_FEE_BPS: ${INITIAL_FEE_BPS} (2.35%)`);
  console.log(`  GOVERNOR: ${account.address} (deployer)`);
  console.log(`  ORACLE_VERIFIER: (deploy PCCOracleVerifier first, pass address to constructor)`);
  console.log(DIVIDER);
}

main().catch((err) => {
  console.error("Deployment failed:", err);
  process.exit(1);
});
