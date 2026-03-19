/**
 * Test Chain Connection Script
 *
 * Connects to Ethereum Sepolia and reads on-chain state from the
 * deployed PCC contracts (MilestoneEscrow + MockUSDC).
 *
 * Usage:
 *   npx tsx scripts/test-chain-connection.ts
 */

import { createPublicClient, http, formatEther, formatUnits, type Address } from "viem";
import { sepolia } from "viem/chains";
import { MilestoneEscrowABI, MockUSDCABI } from "@pcc/contracts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
const DEPLOYER = "0x61B4e2a7347a529b8B19A2a3444Bd3500E693890" as Address;
const MOCK_USDC = "0x6c7ce5d5decee9983feaa3e637ea3fe3e6945cdb" as Address;
const MILESTONE_ESCROW = "0x9e81f5fd7cfa08e2a6a2a0a0128498bf8fd66454" as Address;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== PCC Chain Connection Test (Ethereum Sepolia) ===\n");

  const client = createPublicClient({
    chain: sepolia,
    transport: http(RPC_URL),
  });

  // 1. Read deployer ETH balance
  console.log("1. Reading deployer ETH balance...");
  try {
    const ethBalance = await client.getBalance({ address: DEPLOYER });
    console.log(`   Address: ${DEPLOYER}`);
    console.log(`   ETH Balance: ${formatEther(ethBalance)} ETH`);
    console.log(`   OK\n`);
  } catch (err) {
    console.error(`   FAILED: ${err instanceof Error ? err.message : err}\n`);
  }

  // 2. Read deployer MockUSDC balance
  console.log("2. Reading deployer MockUSDC balance...");
  try {
    const usdcBalance = await client.readContract({
      address: MOCK_USDC,
      abi: MockUSDCABI,
      functionName: "balanceOf",
      args: [DEPLOYER],
    }) as bigint;
    const usdcName = await client.readContract({
      address: MOCK_USDC,
      abi: MockUSDCABI,
      functionName: "name",
    }) as string;
    const usdcSymbol = await client.readContract({
      address: MOCK_USDC,
      abi: MockUSDCABI,
      functionName: "symbol",
    }) as string;
    const usdcDecimals = await client.readContract({
      address: MOCK_USDC,
      abi: MockUSDCABI,
      functionName: "decimals",
    }) as number;
    console.log(`   Token: ${usdcName} (${usdcSymbol}), ${usdcDecimals} decimals`);
    console.log(`   MockUSDC Address: ${MOCK_USDC}`);
    console.log(`   Deployer Balance: ${formatUnits(usdcBalance, usdcDecimals)} ${usdcSymbol}`);
    console.log(`   OK\n`);
  } catch (err) {
    console.error(`   FAILED: ${err instanceof Error ? err.message : err}\n`);
  }

  // 3. Read MilestoneEscrow contract state
  console.log("3. Reading MilestoneEscrow contract state...");
  try {
    const [payer, arbiter, token, cwmId, funded, totalAmount, milestoneCount] = await Promise.all([
      client.readContract({ address: MILESTONE_ESCROW, abi: MilestoneEscrowABI, functionName: "payer" }),
      client.readContract({ address: MILESTONE_ESCROW, abi: MilestoneEscrowABI, functionName: "arbiter" }),
      client.readContract({ address: MILESTONE_ESCROW, abi: MilestoneEscrowABI, functionName: "token" }),
      client.readContract({ address: MILESTONE_ESCROW, abi: MilestoneEscrowABI, functionName: "cwmId" }),
      client.readContract({ address: MILESTONE_ESCROW, abi: MilestoneEscrowABI, functionName: "funded" }),
      client.readContract({ address: MILESTONE_ESCROW, abi: MilestoneEscrowABI, functionName: "totalAmount" }),
      client.readContract({ address: MILESTONE_ESCROW, abi: MilestoneEscrowABI, functionName: "getMilestoneCount" }),
    ]);

    console.log(`   Escrow Address: ${MILESTONE_ESCROW}`);
    console.log(`   Payer: ${payer}`);
    console.log(`   Arbiter: ${arbiter}`);
    console.log(`   Token: ${token}`);
    console.log(`   CWM ID: ${cwmId}`);
    console.log(`   Funded: ${funded}`);
    console.log(`   Total Amount: ${formatUnits(totalAmount as bigint, 6)} USDC`);
    console.log(`   Milestone Count: ${Number(milestoneCount as bigint)}`);

    const count = Number(milestoneCount as bigint);
    if (count > 0) {
      console.log(`\n   Milestones:`);
      for (let i = 0; i < count; i++) {
        const m = (await client.readContract({
          address: MILESTONE_ESCROW,
          abi: MilestoneEscrowABI,
          functionName: "getMilestone",
          args: [BigInt(i)],
        })) as unknown as {
          stepId: string;
          operator: Address;
          amount: bigint;
          operatorBond: bigint;
          status: number;
        };
        console.log(`     [${i}] stepId=${m.stepId} operator=${m.operator} amount=${formatUnits(m.amount, 6)} status=${m.status}`);
      }
    }

    console.log(`   OK\n`);
  } catch (err) {
    console.error(`   FAILED: ${err instanceof Error ? err.message : err}\n`);
  }

  // 4. Read chain metadata
  console.log("4. Reading chain metadata...");
  try {
    const blockNumber = await client.getBlockNumber();
    const chainId = await client.getChainId();
    console.log(`   Chain ID: ${chainId} (Ethereum Sepolia)`);
    console.log(`   Latest Block: ${blockNumber}`);
    console.log(`   RPC: ${RPC_URL}`);
    console.log(`   Explorer: https://sepolia.etherscan.io/address/${MILESTONE_ESCROW}`);
    console.log(`   OK\n`);
  } catch (err) {
    console.error(`   FAILED: ${err instanceof Error ? err.message : err}\n`);
  }

  console.log("=== Chain connection test complete ===");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
