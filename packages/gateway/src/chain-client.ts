/**
 * Viem public client for gateway on-chain reads.
 *
 * Reads escrow state, token balances, and event logs.
 * Write operations go through agent wallets — the gateway only reads.
 */
import { createPublicClient, http, type Address, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";
import {
  MilestoneEscrowABI,
  MockUSDCABI,
  MilestoneStatus,
  milestoneStatusName,
} from "@pcc/contracts";

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

const PCC_RPC_URL = process.env.PCC_RPC_URL ?? "https://sepolia.base.org";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _client: any;

export function getPublicClient() {
  if (!_client) {
    _client = createPublicClient({
      chain: baseSepolia,
      transport: http(PCC_RPC_URL),
    });
  }
  return _client as ReturnType<typeof createPublicClient>;
}

// ---------------------------------------------------------------------------
// Escrow reads
// ---------------------------------------------------------------------------

export interface OnChainMilestone {
  stepId: string;
  operator: Address;
  amount: string;
  operatorBond: string;
  status: number;
  statusName: string;
  evidenceBundleHash: string;
  verifierAttestationHash: string;
  challengeWindowEnd: number;
  challengeWindowSeconds: number;
}

export interface OnChainEscrow {
  address: Address;
  payer: Address;
  arbiter: Address;
  token: Address;
  cwmId: string;
  funded: boolean;
  totalAmount: string;
  milestoneCount: number;
  milestones: OnChainMilestone[];
}

export async function readEscrow(escrowAddress: Address): Promise<OnChainEscrow> {
  const client = getPublicClient();

  const [payer, arbiter, token, cwmId, funded, totalAmount, milestoneCount] = await Promise.all([
    client.readContract({ address: escrowAddress, abi: MilestoneEscrowABI, functionName: "payer" }),
    client.readContract({ address: escrowAddress, abi: MilestoneEscrowABI, functionName: "arbiter" }),
    client.readContract({ address: escrowAddress, abi: MilestoneEscrowABI, functionName: "token" }),
    client.readContract({ address: escrowAddress, abi: MilestoneEscrowABI, functionName: "cwmId" }),
    client.readContract({ address: escrowAddress, abi: MilestoneEscrowABI, functionName: "funded" }),
    client.readContract({ address: escrowAddress, abi: MilestoneEscrowABI, functionName: "totalAmount" }),
    client.readContract({ address: escrowAddress, abi: MilestoneEscrowABI, functionName: "getMilestoneCount" }),
  ]);

  const count = Number(milestoneCount as bigint);
  const milestones: OnChainMilestone[] = [];

  for (let i = 0; i < count; i++) {
    const m = (await client.readContract({
      address: escrowAddress,
      abi: MilestoneEscrowABI,
      functionName: "getMilestone",
      args: [BigInt(i)],
    })) as unknown as {
      stepId: string;
      operator: Address;
      amount: bigint;
      operatorBond: bigint;
      status: number;
      evidenceBundleHash: string;
      verifierAttestationHash: string;
      challengeWindowEnd: bigint;
      challengeWindowSeconds: bigint;
    };

    milestones.push({
      stepId: m.stepId,
      operator: m.operator,
      amount: formatUnits(m.amount, 6),
      operatorBond: formatUnits(m.operatorBond, 6),
      status: m.status,
      statusName: milestoneStatusName(m.status),
      evidenceBundleHash: m.evidenceBundleHash,
      verifierAttestationHash: m.verifierAttestationHash,
      challengeWindowEnd: Number(m.challengeWindowEnd),
      challengeWindowSeconds: Number(m.challengeWindowSeconds),
    });
  }

  return {
    address: escrowAddress,
    payer: payer as Address,
    arbiter: arbiter as Address,
    token: token as Address,
    cwmId: cwmId as string,
    funded: funded as boolean,
    totalAmount: formatUnits(totalAmount as bigint, 6),
    milestoneCount: count,
    milestones,
  };
}

// ---------------------------------------------------------------------------
// Token reads
// ---------------------------------------------------------------------------

export async function readTokenBalance(tokenAddress: Address, account: Address): Promise<string> {
  const client = getPublicClient();
  const balance = await client.readContract({
    address: tokenAddress,
    abi: MockUSDCABI,
    functionName: "balanceOf",
    args: [account],
  });
  return formatUnits(balance as bigint, 6);
}

export async function readTokenAllowance(
  tokenAddress: Address,
  owner: Address,
  spender: Address,
): Promise<string> {
  const client = getPublicClient();
  const allowance = await client.readContract({
    address: tokenAddress,
    abi: MockUSDCABI,
    functionName: "allowance",
    args: [owner, spender],
  });
  return formatUnits(allowance as bigint, 6);
}

// ---------------------------------------------------------------------------
// Event log reads
// ---------------------------------------------------------------------------

export async function getEscrowEvents(
  escrowAddress: Address,
  fromBlock?: bigint,
) {
  const client = getPublicClient();
  const logs = await client.getContractEvents({
    address: escrowAddress,
    abi: MilestoneEscrowABI,
    fromBlock: fromBlock ?? 0n,
  });
  return logs.map((log) => ({
    eventName: log.eventName,
    args: log.args,
    blockNumber: Number(log.blockNumber),
    transactionHash: log.transactionHash,
  }));
}

export { MilestoneStatus, milestoneStatusName };
