/**
 * Operator Policy — guardrails for job execution on operator-owned equipment.
 *
 * Every kernel has one OperatorPolicy (stored as JSON in SQLite).
 * The policy controls: who can submit jobs, when, how much, and with
 * what approval flow. It also parameterizes the smart contract layer
 * (bond amounts, challenge windows) based on operator preferences.
 *
 * Design principles:
 *   - Schema-driven: bounded by CapabilityTemplate params, not arbitrary
 *   - Safe defaults: manual approval, conservative limits
 *   - Extensible: pricing rules stack, new rule types can be added
 *   - Pure evaluation: evaluatePolicy() is a side-effect-free function
 */

import type { Id, Timestamp } from "./common.js";
import type { CapabilityType } from "./capability.js";

// ── Approval ──────────────────────────────────────────────────────

/** How incoming jobs are handled */
export type ApprovalMode = "auto" | "manual" | "policy";

// ── Schedule ──────────────────────────────────────────────────────

export interface ScheduleWindow {
  /** Start time in HH:MM 24h format */
  start: string;
  /** End time in HH:MM 24h format */
  end: string;
}

export interface MaintenanceWindow {
  start: Timestamp;
  end: Timestamp;
  reason: string;
}

// ── Pricing Rules ─────────────────────────────────────────────────

/** A discount or surcharge rule that stacks on base pricing */
export type PricingRuleType =
  | "volume_discount"     // Order N+ units → % off
  | "batch_discount"      // Combine jobs → split setup cost
  | "rush_surcharge"      // Priority queue → +%
  | "offpeak_discount"    // Outside operating hours → -% (pre-approved overnight)
  | "material_markup"     // Specific material → +% or +flat
  | "loyalty_discount"    // Repeat agent (N+ completed jobs) → -%
  | (string & {});

export interface PricingRule {
  id: string;
  type: PricingRuleType;
  label: string;
  /** Whether this rule is active */
  enabled: boolean;
  /** Condition that activates this rule */
  condition: {
    /** Min quantity (for volume_discount) */
    minQuantity?: number;
    /** Min completed jobs from this agent (for loyalty) */
    minCompletedJobs?: number;
    /** Material name (for material_markup) */
    material?: string;
    /** Time window (for offpeak) */
    timeWindow?: ScheduleWindow;
    /** Max lead time in ms (for rush — job must start within this window) */
    maxLeadTimeMs?: number;
  };
  /** Impact on price */
  impact: {
    mode: "percent" | "flat";
    /** Positive = surcharge, negative = discount */
    value: string;
  };
}

// ── Notifications ─────────────────────────────────────────────────

export type NotificationChannel = "dashboard" | "email" | "webhook";

export type PolicyEvent =
  | "job_submitted"
  | "job_approved"
  | "job_rejected"
  | "job_started"
  | "job_completed"
  | "job_failed"
  | "emergency_stop"
  | "rate_limit_hit"
  | "policy_violation"
  | "session_created"
  | "session_committed";

// ── The Policy ────────────────────────────────────────────────────

/** Complete operator policy — one JSON object per kernel */
export interface OperatorPolicy {
  /** Schema version for forward compatibility */
  version: 1;

  // ── Approval ────────────────────────────────────────────────
  /** How incoming jobs are handled */
  approvalMode: ApprovalMode;
  /** Timeout for manual approval in ms (auto-reject after expiry) */
  approvalTimeoutMs: number;

  // ── Agent Trust ─────────────────────────────────────────────
  /** Trusted agent IDs (whitelist). In policy mode: auto-approve these. */
  trustedAgents: string[];
  /** Blocked agent IDs (blacklist). Always rejected. */
  blockedAgents: string[];
  /** Minimum reputation score (0-1000) for unknown agents. 0 = accept all. */
  minReputationScore: number;

  // ── Rate Limits ─────────────────────────────────────────────
  /** Max jobs per hour. 0 = unlimited */
  maxJobsPerHour: number;
  /** Max jobs per day. 0 = unlimited */
  maxJobsPerDay: number;
  /** Max cost (USDC) per day. "0" = unlimited */
  maxCostPerDay: string;
  /** Max concurrent sessions. 0 = unlimited */
  maxConcurrentSessions: number;

  // ── Execution Limits ────────────────────────────────────────
  /** Max job duration in ms. 0 = unlimited */
  maxDurationMs: number;
  /** Allowed materials (empty = all) */
  allowedMaterials: string[];
  /** Allowed capability types (empty = all) */
  allowedCapabilityTypes: CapabilityType[];
  /** Require funded escrow before execution */
  requireEscrow: boolean;

  // ── Schedule ────────────────────────────────────────────────
  /** Operating hours per day of week (0=Sunday). null = closed that day */
  operatingHours: Record<number, ScheduleWindow[] | null>;
  /** IANA timezone for operating hours */
  timezone: string;
  /** Maintenance/blackout windows */
  maintenanceWindows: MaintenanceWindow[];

  // ── Safety ──────────────────────────────────────────────────
  /** Emergency stop: when true, reject ALL jobs immediately */
  emergencyStop: boolean;
  /** Max hotend/bed temperature (°C). 0 = no limit */
  maxTemperatureCelsius: number;
  /** Sanitize G-code (strip dangerous commands) */
  gcodeSanitization: boolean;

  // ── Pricing ─────────────────────────────────────────────────
  /** Pricing rules that stack on base template pricing */
  pricingRules: PricingRule[];

  // ── Smart Contract Parameters ───────────────────────────────
  /** Challenge window in seconds (0 = use default per assurance tier) */
  challengeWindowOverride: number;
  /** Operator bond percentage override (0 = use default per assurance tier) */
  bondPercentOverride: number;

  // ── Capture Verification Protocol (CVP — Wave 4) ────────────
  /**
   * Minimum CaptureClass required for jobs on this kernel. Any inbound
   * job whose evidence resolves to a class below this threshold is
   * rejected at gateway submission time. `"CC0"` = accept everything,
   * `"CC5"` = only accept sovereign-grade evidence. Undefined means
   * "not enforced" and falls back to the assurance-tier implication.
   */
  minCaptureClass?: "CC0" | "CC1" | "CC2" | "CC3" | "CC4" | "CC5";
  /**
   * When true, operators refuse jobs whose capture verdict is not a PASS
   * with `anchorCandidate:true`. Useful for regulated contexts where the
   * on-chain audit trail is required.
   */
  requireAnchor?: boolean;

  // ── Notifications ───────────────────────────────────────────
  notifications: {
    channels: NotificationChannel[];
    email?: string;
    webhookUrl?: string;
    events: PolicyEvent[];
  };
}

// ── Policy Evaluation ─────────────────────────────────────────────

export interface PolicyViolation {
  rule: string;
  message: string;
  severity: "block" | "warn";
}

export interface PolicyEvaluation {
  /** Whether the job is allowed to proceed */
  allowed: boolean;
  /** Whether manual approval is required (not rejected, but deferred) */
  requiresApproval: boolean;
  /** Violations that caused rejection or warning */
  violations: PolicyViolation[];
  /** Pending approval ID (if requiresApproval) */
  pendingApprovalId?: string;
  /** Applied pricing rules (for the quote) */
  appliedPricingRules?: PricingRule[];
}

// ── Pending Approval ──────────────────────────────────────────────

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface PendingApproval {
  id: Id;
  kernelId: Id;
  jobId: Id;
  sessionId?: Id;
  submittedBy: string;
  jobSummary: {
    capabilityType?: string;
    material?: string;
    estimatedDurationMs?: number;
    estimatedCost?: string;
    agentId: string;
    agentReputation?: number;
  };
  status: ApprovalStatus;
  createdAt: Timestamp;
  decidedAt?: Timestamp;
  rejectionReason?: string;
  expiresAt: Timestamp;
}

// ── Default Policy ────────────────────────────────────────────────

/** Safe default policy for new operators */
export const DEFAULT_OPERATOR_POLICY: OperatorPolicy = {
  version: 1,

  approvalMode: "manual",
  approvalTimeoutMs: 15 * 60_000, // 15 minutes

  trustedAgents: [],
  blockedAgents: [],
  minReputationScore: 0,

  maxJobsPerHour: 5,
  maxJobsPerDay: 20,
  maxCostPerDay: "100.00",
  maxConcurrentSessions: 5,

  maxDurationMs: 4 * 60 * 60_000, // 4 hours
  allowedMaterials: [],
  allowedCapabilityTypes: [],
  requireEscrow: false, // testnet: don't require real escrow yet

  operatingHours: {
    0: null, // Sunday: closed
    1: [{ start: "09:00", end: "17:00" }],
    2: [{ start: "09:00", end: "17:00" }],
    3: [{ start: "09:00", end: "17:00" }],
    4: [{ start: "09:00", end: "17:00" }],
    5: [{ start: "09:00", end: "17:00" }],
    6: null, // Saturday: closed
  },
  timezone: "America/Los_Angeles",
  maintenanceWindows: [],

  emergencyStop: false,
  maxTemperatureCelsius: 260,
  gcodeSanitization: true,

  pricingRules: [
    {
      id: "volume-10",
      type: "volume_discount",
      label: "10+ units: 10% off",
      enabled: true,
      condition: { minQuantity: 10 },
      impact: { mode: "percent", value: "-10" },
    },
    {
      id: "rush",
      type: "rush_surcharge",
      label: "Rush order: +25%",
      enabled: true,
      condition: { maxLeadTimeMs: 30 * 60_000 }, // must start within 30 min
      impact: { mode: "percent", value: "25" },
    },
    {
      id: "loyalty-5",
      type: "loyalty_discount",
      label: "5+ completed jobs: 5% off",
      enabled: true,
      condition: { minCompletedJobs: 5 },
      impact: { mode: "percent", value: "-5" },
    },
  ],

  challengeWindowOverride: 0,
  bondPercentOverride: 0,

  notifications: {
    channels: ["dashboard"],
    events: [
      "job_submitted",
      "job_completed",
      "job_failed",
      "emergency_stop",
      "rate_limit_hit",
    ],
  },
};
