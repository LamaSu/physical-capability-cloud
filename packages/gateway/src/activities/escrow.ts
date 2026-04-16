import { defineActivity, deriveOnchainOpKey } from "@pcc/workflow";
import type { Address } from "viem";
import { getWorkflowStore } from "../workflow-store.js";
import { getSettlementFacade } from "../facades/index.js";
import type { DisputeInput } from "../facades/index.js";

export const fundEscrowActivity = defineActivity<
  readonly [Address, string | undefined, string | undefined, string | undefined],
  unknown
>({
  name: "escrow.fund",
  get store() { return getWorkflowStore(); },
  retryPolicy: {
    initialIntervalMs: 2_000,
    maximumAttempts: 5,
    backoffCoefficient: 2,
    nonRetryableErrorPatterns: [
      "EscrowAlreadyFundedError",
      "InsufficientBalanceError",
      "BadRequestError",
    ],
  },
  deriveKey: (ctx) => {
    const [address] = ctx.args;
    return deriveOnchainOpKey({
      jobId: address as `0x${string}`,
      milestoneIdx: 0,
      action: "fund",
    });
  },
  async handler(input) {
    const [address, actorId, ip, userAgent] = input;
    const facade = getSettlementFacade();
    const result = await facade.fundEscrow(address, actorId, ip, userAgent);
    if (!result.success) throw new Error(result.error.message);
    return result.data;
  },
});

export const releaseMilestoneActivity = defineActivity<
  readonly [Address, number, string | undefined, string | undefined, string | undefined],
  unknown
>({
  name: "escrow.release",
  get store() { return getWorkflowStore(); },
  retryPolicy: {
    initialIntervalMs: 2_000,
    maximumAttempts: 5,
    backoffCoefficient: 2,
    nonRetryableErrorPatterns: [
      "ChallengeWindowActiveError",
      "MilestoneNotEvidencedError",
      "BadRequestError",
    ],
  },
  deriveKey: (ctx) => {
    const [address, milestoneIdx] = ctx.args;
    return deriveOnchainOpKey({
      jobId: address as `0x${string}`,
      milestoneIdx: Number(milestoneIdx),
      action: "release",
    });
  },
  async handler(input) {
    const [address, milestoneIndex, actorId, ip, userAgent] = input;
    const facade = getSettlementFacade();
    const result = await facade.releaseMilestone(address, milestoneIndex, actorId, ip, userAgent);
    if (!result.success) throw new Error(result.error.message);
    return result.data;
  },
});

export const fileDisputeActivity = defineActivity<
  readonly [Address, number, DisputeInput, string | undefined, string | undefined, string | undefined],
  unknown
>({
  name: "escrow.dispute",
  get store() { return getWorkflowStore(); },
  retryPolicy: {
    initialIntervalMs: 3_000,
    maximumAttempts: 3,
    backoffCoefficient: 2,
    nonRetryableErrorPatterns: [
      "DisputeAlreadyFiledError",
      "BadRequestError",
    ],
  },
  deriveKey: (ctx) => {
    const [address, milestoneIdx] = ctx.args;
    return deriveOnchainOpKey({
      jobId: address as `0x${string}`,
      milestoneIdx: Number(milestoneIdx),
      action: "dispute",
    });
  },
  async handler(input) {
    const [address, milestoneIndex, body, actorId, ip, userAgent] = input;
    const facade = getSettlementFacade();
    const result = await facade.fileDispute(address, milestoneIndex, body, actorId, ip, userAgent);
    if (!result.success) throw new Error(result.error.message);
    return result.data;
  },
});
