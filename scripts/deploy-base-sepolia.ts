/**
 * Deploy PCC contracts to Base Sepolia using viem (no Foundry CLI needed).
 *
 * Deploys:
 *   1. MockUSDC — test ERC-20 token
 *   2. MilestoneEscrow — escrow contract for workflows
 *
 * After deployment, updates chain-config.ts with the deployed addresses.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... npx tsx scripts/deploy-base-sepolia.ts
 *
 * Prerequisites:
 *   - Base Sepolia ETH in the deployer wallet (get from https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet)
 *   - Foundry compiled artifacts in packages/contracts/out/ (run `cd packages/contracts && forge build`)
 */

import { createWalletClient, createPublicClient, http, formatEther, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DIVIDER = "═".repeat(70);
const SUB_DIVIDER = "─".repeat(50);

async function main() {
  console.log(`\n${DIVIDER}`);
  console.log("  PCC Contract Deployment — Base Sepolia");
  console.log(`${DIVIDER}\n`);

  // ── Validate environment ──────────────────────────────────────────
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) {
    console.error("Error: DEPLOYER_PRIVATE_KEY is required");
    console.error("  DEPLOYER_PRIVATE_KEY=0x... npx tsx scripts/deploy-base-sepolia.ts");
    console.error("");
    console.error("To generate a new wallet:");
    console.error("  npx tsx scripts/generate-wallet.ts");
    process.exit(1);
  }

  const rpcUrl = process.env.RPC_URL ?? "https://sepolia.base.org";

  // ── Setup clients ─────────────────────────────────────────────────
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
  console.log(`Balance:   ${formatEther(balance)} ETH`);
  console.log(`Network:   Base Sepolia (${rpcUrl})`);
  console.log(`${SUB_DIVIDER}\n`);

  if (balance === 0n) {
    console.error("Error: Deployer has 0 ETH. Fund with Base Sepolia ETH first.");
    console.error("  Faucet: https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet");
    process.exit(1);
  }

  // ── Load compiled artifacts ───────────────────────────────────────
  const contractsDir = resolve(import.meta.dirname ?? ".", "../packages/contracts");
  const mockUsdcArtifact = JSON.parse(
    readFileSync(resolve(contractsDir, "out/MockUSDC.sol/MockUSDC.json"), "utf8"),
  );
  const escrowArtifact = JSON.parse(
    readFileSync(resolve(contractsDir, "out/MilestoneEscrow.sol/MilestoneEscrow.json"), "utf8"),
  );

  // ── Deploy MockUSDC ───────────────────────────────────────────────
  console.log("1. Deploying MockUSDC...");

  const mockUsdcHash = await walletClient.deployContract({
    abi: mockUsdcArtifact.abi,
    bytecode: mockUsdcArtifact.bytecode.object as `0x${string}`,
    args: [1_000_000n * 10n ** 6n], // 1M initial supply
  });
  console.log(`   TX: ${mockUsdcHash}`);

  const mockUsdcReceipt = await publicClient.waitForTransactionReceipt({ hash: mockUsdcHash });
  const mockUsdcAddress = mockUsdcReceipt.contractAddress!;
  console.log(`   MockUSDC deployed at: ${mockUsdcAddress}`);
  console.log(`   Gas used: ${mockUsdcReceipt.gasUsed}`);
  console.log("");

  // ── Mint test tokens ──────────────────────────────────────────────
  console.log("2. Minting 100,000 mUSDC to deployer...");

  const mintHash = await walletClient.writeContract({
    address: mockUsdcAddress,
    abi: mockUsdcArtifact.abi,
    functionName: "mint",
    args: [account.address, 100_000n * 10n ** 6n],
  });
  await publicClient.waitForTransactionReceipt({ hash: mintHash });
  console.log(`   Minted. TX: ${mintHash}`);
  console.log("");

  // ── Deploy MilestoneEscrow ────────────────────────────────────────
  console.log("3. Deploying MilestoneEscrow (demo workflow)...");

  // keccak256("demo-workflow-001") — same as Foundry script
  const cwmId = "0x" + Buffer.from(
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode("demo-workflow-001")),
      ),
    ),
  ).toString("hex") as `0x${string}`;

  const escrowHash = await walletClient.deployContract({
    abi: escrowArtifact.abi,
    bytecode: escrowArtifact.bytecode.object as `0x${string}`,
    args: [account.address, account.address, mockUsdcAddress, cwmId],
  });
  console.log(`   TX: ${escrowHash}`);

  const escrowReceipt = await publicClient.waitForTransactionReceipt({ hash: escrowHash });
  const escrowAddress = escrowReceipt.contractAddress!;
  console.log(`   MilestoneEscrow deployed at: ${escrowAddress}`);
  console.log(`   Gas used: ${escrowReceipt.gasUsed}`);
  console.log("");

  // ── Update chain-config.ts ────────────────────────────────────────
  console.log("4. Updating chain-config.ts...");

  const chainConfigPath = resolve(contractsDir, "ts/chain-config.ts");
  let chainConfig = readFileSync(chainConfigPath, "utf8");

  // Replace the base-sepolia section's undefined addresses
  chainConfig = chainConfig.replace(
    /("base-sepolia"[\s\S]*?milestoneEscrowFactory:\s*)undefined/,
    `$1"${escrowAddress}"`,
  );
  chainConfig = chainConfig.replace(
    /("base-sepolia"[\s\S]*?mockUSDC:\s*)undefined/,
    `$1"${mockUsdcAddress}"`,
  );

  writeFileSync(chainConfigPath, chainConfig);
  console.log(`   Updated ${chainConfigPath}`);
  console.log("");

  // ── Summary ───────────────────────────────────────────────────────
  console.log(`${DIVIDER}`);
  console.log("  Deployment Complete!");
  console.log(`${DIVIDER}`);
  console.log(`  Network:          Base Sepolia`);
  console.log(`  MockUSDC:         ${mockUsdcAddress}`);
  console.log(`  MilestoneEscrow:  ${escrowAddress}`);
  console.log(`  Explorer:         https://sepolia.basescan.org/address/${escrowAddress}`);
  console.log(`${DIVIDER}\n`);
}

main().catch((err) => {
  console.error("Deployment failed:", err);
  process.exit(1);
});
