import { getDeployment, readMilestoneRecipients, type MilestoneVersion } from "@pcc/contracts";
import { MilestoneEscrowV2ABI, MilestoneEscrowV3ABI } from "@pcc/contracts/abi";
import { keccak256, parseAbi, toBytes, type Address, type PublicClient } from "viem";
import { resolveChainConfig } from "../../contracts/escrow-client.js";
import { getStore } from "../../db.js";
import { resolveSettlement, type JobRow } from "../../readmodels/job-execution.js";
import { resolvePayoutBinding } from "./repository.js";

const PCC_NETWORK = process.env.PCC_NETWORK ?? "base-sepolia";
const FACTORY_ABI = parseAbi(["function isProtocolEscrow(address) view returns (bool)"]);

/** Report the configured operator recipient; this service never changes any payment. */
export async function checkJobPayout(job: JobRow, client: PublicClient) {
  const chainId = resolveChainConfig().chain.id;
  // Keep failed store reads distinct from an unbound wallet or an unlinked escrow.
  const binding = resolvePayoutBinding(job.kernelId, chainId);
  const { repos, db } = getStore();
  const settlement = resolveSettlement(job, repos, db);
  const response = {
    jobId: job.id,
    kernelId: job.kernelId,
    stepId: job.stepId,
    escrow: {
      link: settlement.link,
      address: settlement.link === "linked" ? settlement.escrow.contractAddress : null,
      recordedVersion: settlement.link === "linked" ? settlement.escrow.version ?? null : null,
      version: null as MilestoneVersion | null,
      chainId,
    },
    milestoneIndex: null as string | null,
    blockNumber: null as string | null,
    blockHash: null as string | null,
    recipients: null as {
      ok: boolean;
      outcome: Awaited<ReturnType<typeof readMilestoneRecipients>>["outcome"] | null;
      operator: { recipient: Address; role: "operator-residual"; residualBps: number; plusBond: string } | null;
      splits: Array<{ recipient: Address; role: "split"; bps: number; roleTag: string; ipId: string }>;
      checks: Awaited<ReturnType<typeof readMilestoneRecipients>>["checks"];
    } | null,
    binding,
    match: null as boolean | null,
    reasons: [] as string[],
  };
  if (settlement.link !== "linked") {
    response.reasons.push(`escrow_${settlement.link}`);
    return response;
  }

  try {
    const blockNumber = await client.getBlockNumber();
    response.blockNumber = blockNumber.toString();
    const block = await client.getBlock({ blockNumber });
    response.blockHash = block.hash;
    const escrow = settlement.escrow.contractAddress as Address;
    const contracts = getDeployment(PCC_NETWORK).contracts;
    const factories = [
      { address: contracts.milestoneEscrowFactoryV3, version: "v3" },
      { address: contracts.milestoneEscrowFactoryV2, version: "v2" },
      { address: contracts.pccProtocol, version: "v1" },
    ] as const;
    // Ask every configured factory, including after a true or a failed answer.
    const probes = await Promise.allSettled(factories.filter(factory => factory.address !== undefined)
      .map(async factory => ({
        version: factory.version,
        known: await client.readContract({
          address: factory.address!, abi: FACTORY_ABI, functionName: "isProtocolEscrow",
          args: [escrow], blockNumber,
        }),
      })));
    if (probes.some(probe => probe.status === "rejected")) {
      response.reasons.push("chain_read_failed");
      return response;
    }
    const claims = probes.flatMap(probe => probe.status === "fulfilled" && probe.value.known ? [probe.value.version] : []);
    if (claims.length > 1) {
      response.reasons.push("version_ambiguous");
      return response;
    }
    const version = claims[0];
    if (version !== "v2" && version !== "v3") {
      response.reasons.push("unsupported_version");
      return response;
    }
    response.escrow.version = version;
    if (version !== settlement.escrow.version) response.reasons.push("recorded_version_differs");

    const abi = version === "v3" ? MilestoneEscrowV3ABI : MilestoneEscrowV2ABI;
    const count = await client.readContract({ address: escrow, abi, functionName: "getMilestoneCount", blockNumber });
    if (count > 64n) {
      response.reasons.push("too_many_milestones");
      return response;
    }
    const milestones = await Promise.all(Array.from({ length: Number(count) }, (_, index) =>
      client.readContract({ address: escrow, abi, functionName: "getMilestone", args: [BigInt(index)], blockNumber })));
    const stepHash = keccak256(toBytes(job.stepId));
    const matches = milestones.flatMap((milestone, index) => milestone.stepId === stepHash ? [BigInt(index)] : []);
    if (matches.length !== 1) {
      response.reasons.push(matches.length === 0 ? "milestone_not_found" : "milestone_ambiguous");
      return response;
    }
    const milestoneIndex = matches[0]!;
    response.milestoneIndex = milestoneIndex.toString();
    if (settlement.stepClaimants > 1) {
      response.reasons.push("milestone_not_unique_to_job");
      return response;
    }
    const recipients = await readMilestoneRecipients({ client, escrow, version, milestoneIndex, blockNumber });
    response.blockHash = recipients.blockHash;
    const operator = recipients.legs?.find(leg => leg.role === "operator-residual");
    response.recipients = {
      ok: recipients.ok,
      outcome: recipients.outcome ?? null,
      operator: operator ? { ...operator, plusBond: operator.plusBond.toString() } : null,
      splits: recipients.legs?.filter(leg => leg.role === "split") ?? [],
      checks: recipients.checks,
    };
    if (!recipients.ok || !operator) {
      response.reasons.push("chain_read_failed");
      return response;
    }
  } catch {
    response.match = null;
    response.reasons.push("chain_read_failed");
    return response;
  }
  // Read again after the asynchronous chain reads: a concurrent revoke or transfer applies now.
  // This store read is outside the RPC catch so an outage is never reported as unbound.
  response.binding = resolvePayoutBinding(job.kernelId, chainId);
  if (!response.binding.bound) {
    response.match = false;
    response.reasons.push("payout_wallet_unbound");
  } else {
    response.match = response.recipients!.operator!.recipient.toLowerCase() === response.binding.payoutAddress;
    if (!response.match) response.reasons.push("recipient_is_not_the_bound_wallet");
  }
  return response;
}
