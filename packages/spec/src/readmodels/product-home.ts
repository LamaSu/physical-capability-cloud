/**
 * ProductHomeDTO (PX-7, for the shell's StatusBar and Command Center): the few
 * platform-wide facts a home page shows, each from a named gateway source, so the UI
 * never counts a partial page or sums the wrong records (shell #2007, product-steward #2170).
 *
 *   kernels         online / stale / other, using the kernel read model's own staleness
 *                   rule (a heartbeat window, with a grace for kernels that list a capability)
 *   capabilities    listed capabilities, and how many sit on a kernel that is online by
 *                   that same rule, per type. A listing is not a promise of capacity.
 *   jobs            counts by execution phase, and `active` (phases not finished and known)
 *   settlementNetwork  the network this gateway is CONFIGURED for, labelled as such: it is
 *                   not proof that any escrow lives there
 *   escrowHeld      sums of MILESTONE amounts in held states, per currency, mock escrows
 *                   excluded. Escrow totals are never summed: an active escrow can hold
 *                   released milestones. A record, not a chain read.
 *
 * "Gateway reachable" is a client fact (this DTO arriving proves it), so it is not a field.
 * The served build commit is on GET /api/health (N5), which the StatusBar already reads.
 */
import type { ExecutionPhase } from "./job-execution.js";

export const PRODUCT_HOME_SCHEMA_ID = "pcc.product-home/v1" as const;

/**
 * Milestone words (the gateway's escrow_milestones.status and the V-next state names) whose
 * funds are still HELD in escrow: committed, not released and not refunded. Anything else,
 * including an unrecognized word, is not counted as held; unrecognized words are counted
 * apart (`unclassifiedMilestones`) rather than guessed.
 */
export const HELD_MILESTONE_STATUSES: readonly string[] = Object.freeze([
  "FUNDED",
  "LOCKED",
  "EVIDENCE_SUBMITTED",
  "RELEASING",
  "DISPUTED",
  "FUNDED_ACTIVE",
  "PRIMARY_ASSERTED",
  "CHALLENGED",
  "BACKUP_PENDING",
  "BACKUP_ASSERTED",
  "RELEASE_ALLOCATED",
  "REFUND_ALLOCATED",
]);

/**
 * Milestone words whose funds are known NOT to be held (never funded, paid out or returned).
 * PENDING is what the paid-job flow writes for the milestones of an escrow it did not fund.
 */
export const NOT_HELD_MILESTONE_STATUSES: readonly string[] = Object.freeze([
  "CREATED",
  "UNFUNDED",
  "PENDING",
  "RELEASED",
  "SETTLED_RELEASED",
  "REFUNDED",
  "SETTLED_REFUNDED",
  "SLASHED",
]);

/** Chain ids of the network names the gateway can be configured with. */
export const NETWORK_CHAIN_IDS: Readonly<Record<string, number>> = Object.freeze({
  "base-sepolia": 84532,
  base: 8453,
  sepolia: 11155111,
  mainnet: 1,
});

export interface ProductHomeSectionError {
  state: "unavailable";
  reason: string;
}

export interface ProductHomeKernels {
  state: "read";
  total: number;
  /** status "online" and not stale by the kernel read model's rule. */
  online: number;
  /** status "online" but its heartbeat is older than the rule allows. */
  stale: number;
  /** Any other status (offline, maintenance, suspended, expired, ...). */
  other: number;
  rule: string;
  source: "gateway_kernel_rows";
}

export interface ProductHomeCapabilityType {
  /** The capability's type; null for a row with no type. */
  type: string | null;
  total: number;
  onOnlineKernels: number;
}

export interface ProductHomeCapabilities {
  state: "read";
  total: number;
  /** Capabilities whose kernel is online and not stale by the kernels section's rule. */
  onOnlineKernels: number;
  /** Sorted by type, the null type last. */
  byType: ProductHomeCapabilityType[];
  source: "gateway_capability_rows";
}

export interface ProductHomeJobs {
  state: "read";
  total: number;
  /** Jobs whose phase is known and not finished (pending through paused). */
  active: number;
  byPhase: Record<ExecutionPhase, number>;
  source: "gateway_job_rows";
}

export interface ProductHomeHeldAmount {
  currency: string;
  decimals: number;
  /** Integer string in the currency's base units. */
  amountBaseUnits: string;
  milestones: number;
}

export interface ProductHomeEscrowHeld {
  state: "read";
  byCurrency: ProductHomeHeldAmount[];
  /** Held milestones whose amount or currency could not be counted exactly. */
  uncountedMilestones: number;
  /** Milestones whose status word is neither held nor known-not-held. */
  unclassifiedMilestones: number;
  /** Mock-settlement escrows left out entirely. */
  excludedSimulatedEscrows: number;
  heldStatuses: readonly string[];
  source: "gateway_escrow_record";
  /** No chain read confirms these sums. */
  confirmation: "record_only";
}

export interface ProductHomeDTO {
  schemaId: typeof PRODUCT_HOME_SCHEMA_ID;
  /** When the gateway read its records (ISO-8601). */
  asOf: string;
  kernels: ProductHomeKernels | ProductHomeSectionError;
  capabilities: ProductHomeCapabilities | ProductHomeSectionError;
  jobs: ProductHomeJobs | ProductHomeSectionError;
  settlementNetwork: {
    name: string | null;
    chainId: number | null;
    basis: "gateway_config";
  };
  escrowHeld: ProductHomeEscrowHeld | ProductHomeSectionError;
}
