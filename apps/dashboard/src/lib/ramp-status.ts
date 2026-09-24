import type { RampSessionStatus } from "@pcc/spec";

type Chip = { status: "executing" | "completed" | "failed" | "offline"; label: string };

/**
 * How a fiat ramp session's status reads on screen. Every RampSessionStatus
 * (packages/spec/src/types/fiat-ramp.ts) is mapped explicitly.
 *
 * Product-qa #3: the old mapping knew only "completed" and "pending", so every
 * session still in flight (created, pending_payment, processing) read "Failed".
 * That invites a second payment. Only "failed" reads as failed. An expired
 * session moved no money and reads as expired. A status this code doesn't know
 * reads as unknown, never as failed.
 */
const CHIPS: Record<RampSessionStatus, Chip> = {
  created: { status: "executing", label: "Started" },
  pending_payment: { status: "executing", label: "Awaiting payment" },
  processing: { status: "executing", label: "Processing" },
  completed: { status: "completed", label: "Completed" },
  failed: { status: "failed", label: "Failed" },
  expired: { status: "offline", label: "Expired" },
};

export function rampSessionChip(status: string): Chip {
  return Object.prototype.hasOwnProperty.call(CHIPS, status)
    ? CHIPS[status as RampSessionStatus]
    : { status: "offline", label: `Unknown status (${status})` };
}
