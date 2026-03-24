/**
 * Deploy Oracle Contracts to Base Sepolia.
 *
 * Deploys:
 *   ChainlinkEvidenceVerifier — Chainlink Functions consumer for evidence verification
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... npx tsx scripts/deploy-oracle-contracts.ts
 *
 * Optional env vars:
 *   CHAINLINK_ROUTER     — Chainlink router (default: Base Sepolia)
 *   CHAINLINK_DON_ID     — DON identifier string (default: fun-base-sepolia-1)
 *   CHAINLINK_SUB_ID     — Funded subscription ID (required for live requests)
 *   BASE_RPC_URL         — RPC endpoint (default: https://sepolia.base.org)
 *
 * After deployment:
 *   1. Copy the deployed address to CHAINLINK_CONSUMER_ADDRESS in .env
 *   2. Add the contract as a consumer to your Chainlink subscription at:
 *      https://functions.chain.link/base-sepolia
 */

import { createWalletClient, createPublicClient, http, parseAbi, toHex, pad } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const DIVIDER = "═".repeat(70);
const SUB_DIVIDER = "─".repeat(50);

// ── Chainlink Functions DON source (same as in chainlink-adapter.ts) ─────────

const DON_JS_SOURCE = `
// PCC Evidence Verification — Chainlink Functions DON script
// args[0] = bundleHash (hex string)
// args[1] = requiredTier (number as string)
// Returns: uint256 score (0-100) encoded as bytes

const bundleHash = args[0];
const requiredTier = parseInt(args[1]);

// Validate inputs
if (!bundleHash || bundleHash.length < 8) {
  return Functions.encodeUint256(0);
}

// Tier 0: any hash is acceptable
// Tier 1: hash must be 66+ chars (0x + 64 hex)
// Tier 2+: hash must be 70+ chars (sha256: prefix)
let score = 100;

if (requiredTier >= 1 && bundleHash.length < 66) {
  score = Math.max(0, score - 40);
}

if (requiredTier >= 2 && !bundleHash.startsWith("sha256:") && !bundleHash.startsWith("0x")) {
  score = Math.max(0, score - 30);
}

// Return score as uint256
return Functions.encodeUint256(score);
`.trim();

// ── Minimal ABI for deployment ────────────────────────────────────────────────

const VERIFIER_ABI = parseAbi([
  "constructor(address router, bytes32 donId, uint64 subscriptionId, string jsSource)",
  "function sendEvidenceRequest(bytes32 bundleHash, uint8 requiredTier) returns (bytes32)",
  "function getLastResponse() view returns (bytes)",
  "function owner() view returns (address)",
]);

// ── Bytecode placeholder — in production this comes from forge build ─────────
// To get real bytecode: cd packages/contracts && forge build
// Then read from packages/contracts/out/ChainlinkEvidenceVerifier.sol/ChainlinkEvidenceVerifier.json

async function loadBytecode(): Promise<`0x${string}`> {
  try {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const artifactPath = resolve(
      "packages/contracts/out/ChainlinkEvidenceVerifier.sol/ChainlinkEvidenceVerifier.json",
    );
    const artifact = JSON.parse(readFileSync(artifactPath, "utf-8")) as {
      bytecode: { object: string };
    };
    return artifact.bytecode.object as `0x${string}`;
  } catch {
    throw new Error(
      "Compiled bytecode not found. Run: cd packages/contracts && forge build\n" +
      "Then retry: DEPLOYER_PRIVATE_KEY=0x... npx tsx scripts/deploy-oracle-contracts.ts",
    );
  }
}

async function main() {
  console.log(`\n${DIVIDER}`);
  console.log("  PCC Oracle Contract Deployment — Base Sepolia");
  console.log(`${DIVIDER}\n`);

  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) {
    console.error("Error: DEPLOYER_PRIVATE_KEY is required");
    console.error("  DEPLOYER_PRIVATE_KEY=0x... npx tsx scripts/deploy-oracle-contracts.ts");
    process.exit(1);
  }

  const rpcUrl = process.env.BASE_RPC_URL ?? "https://sepolia.base.org";
  const chainlinkRouter =
    process.env.CHAINLINK_ROUTER ?? "0xf9B8fc078197181C841c296C876945aaa425B278";
  const donIdString = process.env.CHAINLINK_DON_ID ?? "fun-base-sepolia-1";
  const subId = process.env.CHAINLINK_SUB_ID
    ? BigInt(process.env.CHAINLINK_SUB_ID)
    : BigInt(0);

  // Encode DON ID as bytes32 (right-pad the ASCII string)
  const donIdBytes32 = pad(
    toHex(new TextEncoder().encode(donIdString)),
    { size: 32, dir: "right" },
  ) as `0x${string}`;

  console.log("Configuration:");
  console.log(`  RPC URL:           ${rpcUrl}`);
  console.log(`  Chainlink Router:  ${chainlinkRouter}`);
  console.log(`  DON ID:            ${donIdString} (${donIdBytes32})`);
  console.log(`  Subscription ID:   ${subId === BigInt(0) ? "(not set — update after deployment)" : subId}`);
  console.log();

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(rpcUrl),
  });
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`Deployer:  ${account.address}`);
  console.log(`Balance:   ${(Number(balance) / 1e18).toFixed(6)} ETH`);
  console.log();

  if (balance === BigInt(0)) {
    console.error("Error: Deployer has no ETH. Get Base Sepolia ETH from:");
    console.error("  https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet");
    process.exit(1);
  }

  // Load compiled bytecode
  console.log("Loading compiled bytecode...");
  const bytecode = await loadBytecode();
  console.log(`  Bytecode loaded (${bytecode.length / 2 - 1} bytes)\n`);

  // Deploy ChainlinkEvidenceVerifier
  console.log(`${SUB_DIVIDER}`);
  console.log("Deploying ChainlinkEvidenceVerifier...");

  const deployHash = await walletClient.deployContract({
    abi: VERIFIER_ABI,
    bytecode,
    args: [
      chainlinkRouter as `0x${string}`,
      donIdBytes32,
      subId,
      DON_JS_SOURCE,
    ],
  });

  console.log(`  Tx hash: ${deployHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: deployHash,
  });

  const contractAddress = receipt.contractAddress;
  if (!contractAddress) {
    throw new Error("Deployment failed — no contract address in receipt");
  }

  console.log(`  Deployed: ${contractAddress}`);
  console.log(`  Gas used: ${receipt.gasUsed}`);

  // Summary
  console.log(`\n${DIVIDER}`);
  console.log("Deployment Complete!");
  console.log(`${DIVIDER}`);
  console.log("\nAdd these to your .env:");
  console.log(`  CHAINLINK_CONSUMER_ADDRESS=${contractAddress}`);
  if (subId === BigInt(0)) {
    console.log("  CHAINLINK_SUB_ID=<your-subscription-id>");
    console.log("\nNext steps:");
    console.log("  1. Create a subscription at https://functions.chain.link/base-sepolia");
    console.log("  2. Fund it with LINK");
    console.log(`  3. Add ${contractAddress} as a consumer`);
    console.log("  4. Set CHAINLINK_SUB_ID in .env");
  }
  console.log("\nTo activate live Chainlink mode:");
  console.log("  ORACLE_MOCK=false in .env");
  console.log(`${DIVIDER}\n`);
}

main().catch((err) => {
  console.error("\nDeployment failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
