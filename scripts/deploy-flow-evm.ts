/**
 * Deploy PCC contracts to Flow EVM Testnet using viem (no Foundry CLI needed).
 *
 * Deploys:
 *   1. MockUSDC — test ERC-20 token
 *   2. MilestoneEscrow — escrow contract for workflows
 *
 * After deployment, updates chain-config.ts with the deployed addresses.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... npx tsx scripts/deploy-flow-evm.ts
 *
 * Prerequisites:
 *   - FLOW testnet tokens in the deployer wallet
 *     Faucet: https://faucet.flow.com/fund-account
 *   - Foundry compiled artifacts in packages/contracts/out/
 *     Run: cd packages/contracts && forge build
 *
 * Network:
 *   Flow EVM Testnet (chain 545)
 *   RPC: https://testnet.evm.nodes.onflow.org
 *   Explorer: https://evm-testnet.flowscan.io
 */

import { createWalletClient, createPublicClient, http, formatEther, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Flow EVM Testnet chain definition (chain 545)
const flowEVMTestnet = defineChain({
  id: 545,
  name: "Flow EVM Testnet",
  nativeCurrency: { name: "Flow", symbol: "FLOW", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://testnet.evm.nodes.onflow.org"] },
    public: { http: ["https://testnet.evm.nodes.onflow.org"] },
  },
  blockExplorers: {
    default: { name: "FlowScan EVM Testnet", url: "https://evm-testnet.flowscan.io" },
  },
  testnet: true,
});

const DIVIDER = "═".repeat(70);
const SUB_DIVIDER = "─".repeat(50);

const RPC_URL = "https://testnet.evm.nodes.onflow.org";

async function main() {
  console.log(`\n${DIVIDER}`);
  console.log("  PCC Contract Deployment — Flow EVM Testnet");
  console.log(`${DIVIDER}\n`);

  // ── Validate environment ──────────────────────────────────────────
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) {
    console.error("Error: DEPLOYER_PRIVATE_KEY is required");
    console.error("  DEPLOYER_PRIVATE_KEY=0x... npx tsx scripts/deploy-flow-evm.ts");
    console.error("");
    console.error("To generate a new wallet:");
    console.error("  npx tsx scripts/generate-wallet.ts");
    process.exit(1);
  }

  // ── Setup clients ─────────────────────────────────────────────────
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: flowEVMTestnet,
    transport: http(RPC_URL),
  });
  const publicClient = createPublicClient({
    chain: flowEVMTestnet,
    transport: http(RPC_URL),
  });

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`Deployer:  ${account.address}`);
  console.log(`Balance:   ${formatEther(balance)} FLOW`);
  console.log(`Network:   Flow EVM Testnet (chain 545, ${RPC_URL})`);
  console.log(`Explorer:  https://evm-testnet.flowscan.io`);
  console.log(`${SUB_DIVIDER}\n`);

  if (balance === 0n) {
    console.error("Error: Deployer has 0 FLOW. Fund the wallet first.");
    console.error("  Faucet:  https://faucet.flow.com/fund-account");
    console.error(`  Wallet:  ${account.address}`);
    console.error("");
    console.error("After funding, re-run:");
    console.error("  DEPLOYER_PRIVATE_KEY=$DEPLOYER_PRIVATE_KEY npx tsx scripts/deploy-flow-evm.ts");
    process.exit(1);
  }

  // ── Load compiled artifacts ───────────────────────────────────────
  const contractsDir = resolve(process.cwd(), "packages/contracts");
  const mockUsdcArtifact = JSON.parse(
    readFileSync(resolve(contractsDir, "out/MockUSDC.sol/MockUSDC.json"), "utf8"),
  );
  const protocolArtifact = JSON.parse(
    readFileSync(resolve(contractsDir, "out/PCCProtocol.sol/PCCProtocol.json"), "utf8"),
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
  console.log(`   Explorer: https://evm-testnet.flowscan.io/tx/${mockUsdcHash}`);

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

  // ── Deploy PCCProtocol (fee factory) ──────────────────────────────
  console.log("3. Deploying PCCProtocol (fee factory, 2.35%)...");
  console.log(`   feeRecipient: ${account.address}`);
  console.log(`   feeBps: 235 (2.35%)`);
  console.log(`   governor: ${account.address}`);

  const protocolHash = await walletClient.deployContract({
    abi: protocolArtifact.abi,
    bytecode: protocolArtifact.bytecode.object as `0x${string}`,
    args: [account.address, 235n, account.address],
  });
  console.log(`   TX: ${protocolHash}`);
  console.log(`   Explorer: https://evm-testnet.flowscan.io/tx/${protocolHash}`);

  const protocolReceipt = await publicClient.waitForTransactionReceipt({ hash: protocolHash });
  const protocolAddress = protocolReceipt.contractAddress!;
  console.log(`   PCCProtocol deployed at: ${protocolAddress}`);
  console.log(`   Gas used: ${protocolReceipt.gasUsed}`);
  console.log("");

  // ── Create Escrow via PCCProtocol factory ───────────────────────
  console.log("4. Creating MilestoneEscrow via PCCProtocol.createEscrow()...");

  // SHA-256("demo-workflow-001") — same as other deploy scripts
  const cwmId = "0x" + Buffer.from(
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode("demo-workflow-001")),
      ),
    ),
  ).toString("hex") as `0x${string}`;

  const createEscrowHash = await walletClient.writeContract({
    address: protocolAddress,
    abi: protocolArtifact.abi,
    functionName: "createEscrow",
    args: [account.address, account.address, mockUsdcAddress, cwmId],
  });
  console.log(`   TX: ${createEscrowHash}`);
  console.log(`   Explorer: https://evm-testnet.flowscan.io/tx/${createEscrowHash}`);

  const createEscrowReceipt = await publicClient.waitForTransactionReceipt({ hash: createEscrowHash });
  // Extract escrow address from event log (topic[1] is the escrow address, padded to 32 bytes)
  const escrowLog = createEscrowReceipt.logs.find((l: any) => l.topics.length >= 2);
  const escrowAddress = ("0x" + (escrowLog?.topics[1]?.slice(26) ?? "")) as `0x${string}`;
  console.log(`   MilestoneEscrow created at: ${escrowAddress}`);
  console.log(`   Gas used: ${createEscrowReceipt.gasUsed}`);
  console.log("");

  // ── Update chain-config.ts ────────────────────────────────────────
  console.log("5. Updating chain-config.ts...");

  const chainConfigPath = resolve(contractsDir, "ts/chain-config.ts");
  let chainConfig = readFileSync(chainConfigPath, "utf8");

  // Replace the flow-evm-testnet section addresses (handles both undefined and quoted strings)
  chainConfig = chainConfig.replace(
    /("flow-evm-testnet"[\s\S]*?milestoneEscrowFactory:\s*)"[^"]*"/,
    `$1"${escrowAddress}"`,
  );
  chainConfig = chainConfig.replace(
    /("flow-evm-testnet"[\s\S]*?mockUSDC:\s*)"[^"]*"/,
    `$1"${mockUsdcAddress}"`,
  );
  chainConfig = chainConfig.replace(
    /("flow-evm-testnet"[\s\S]*?pccProtocol:\s*)undefined/,
    `$1"${protocolAddress}"`,
  );

  writeFileSync(chainConfigPath, chainConfig);
  console.log(`   Updated ${chainConfigPath}`);
  console.log("");

  // ── Summary ───────────────────────────────────────────────────────
  console.log(`${DIVIDER}`);
  console.log("  Deployment Complete!");
  console.log(`${DIVIDER}`);
  console.log(`  Network:          Flow EVM Testnet (chain 545)`);
  console.log(`  MockUSDC:         ${mockUsdcAddress}`);
  console.log(`  PCCProtocol:      ${protocolAddress}`);
  console.log(`  MilestoneEscrow:  ${escrowAddress} (created via factory)`);
  console.log(`  MockUSDC Exp:     https://evm-testnet.flowscan.io/address/${mockUsdcAddress}`);
  console.log(`  Protocol Exp:     https://evm-testnet.flowscan.io/address/${protocolAddress}`);
  console.log(`  Escrow Exp:       https://evm-testnet.flowscan.io/address/${escrowAddress}`);
  console.log(`${DIVIDER}\n`);
  console.log("Next steps:");
  console.log("  1. Set PCC_NETWORK=flow-evm-testnet in your .env to use this deployment");
  console.log("  2. Update BOUNTY_SUBMISSIONS.md with the deployed addresses");
  console.log(`${DIVIDER}\n`);
}

main().catch((err) => {
  console.error("Deployment failed:", err);
  process.exit(1);
});
