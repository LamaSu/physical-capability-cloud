import { defineActivity, deriveOnchainOpKey } from "@pcc/workflow";
import type { Address } from "viem";
import { getWorkflowStore } from "../workflow-store.js";
import { getSettlementFacade } from "../facades/index.js";
import type { DisputeInput } from "../facades/index.js";

export class FacadeError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(err: { message: string; httpStatus: number; code: string; details?: unknown }) {
    super(err.message);
    this.name = "FacadeError";
    this.httpStatus = err.httpStatus;
    this.code = err.code;
    this.details = err.details;
  }
}

function throwFacadeError(err: { message: string; httpStatus: number; code: string; details?: unknown }): never {
  throw new FacadeError(err);
}

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
      "FacadeError",
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
    if (!result.success) throwFacadeError(result.error);
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
      "FacadeError",
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
    if (!result.success) throwFacadeError(result.error);
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
      "FacadeError",
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
    if (!result.success) throwFacadeError(result.error);
    return result.data;
  },
});
