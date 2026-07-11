/**
 * Negotiation Session — the structured pre-lock-in protocol between
 * a user agent and an operator's kernel.
 *
 * A session is a short-lived stateful "shopping cart" that tracks the
 * conversation from capability selection through parameter configuration,
 * quoting, contract review, and final commitment.
 *
 * State machine:
 *   CREATED → CONFIGURING → QUOTED → REVIEWING → COMMITTED
 *                                               → SETTLEMENT_FAILED → COMMITTED (recovered)
 *                                               → SETTLEMENT_FAILED → CANCELLED
 *                                               → EXPIRED / CANCELLED
 *
 * Security:
 *   - Bound to specific userAgentId + kernelId at creation
 *   - Crypto-random session ID (uuid v4)
 *   - All param selections validated against CapabilityTemplate (Zod)
 *   - Free-text fields sanitized (max 1000 chars, no control chars)
 *   - Auto-expires after TTL (default 30 min)
 *   - Immutable after COMMITTED
 *   - Operator constraints frozen at session start (snapshot)
 *   - Rate limited: max sessions per agent per hour
 *
 * Traceability:
 *   - Every state transition logged with timestamp + actor
 *   - Session links to: job ID, escrow address, evidence bundle
 *   - Full provenance chain: session → job → escrow → evidence
 */

import type { Id, Amount, Currency, Timestamp, AssuranceTier, Address } from "./common.js";
import type { CapabilityType } from "./capability.js";
import type { ScheduleWindow } from "./operator-policy.js";

// ── Session Status ────────────────────────────────────────────────

export type SessionStatus =
  | "created"       // Session opened, no params selected yet
  | "configuring"   // User is selecting parameters
  | "quoted"        // Params locked, price computed
  | "reviewing"     // Both sides reviewing contract terms
  | "committed"     // Escrow funded, job locked in
  | "settlement_failed" // Locked in, but REAL-settlement wiring failed to mint a usable
                        // on-chain escrow. Non-terminal + recoverable: retry (safe — never
                        // double-mints) or cancel. Distinct from "committed" so a failed
                        // commit is never mistaken for a funded deal.
  | "expired"       // TTL elapsed
  | "cancelled";    // Cancelled by either party

// ── Audit Trail ───────────────────────────────────────────────────

export interface SessionTransition {
  from: SessionStatus;
  to: SessionStatus;
  timestamp: Timestamp;
  actor: string; // agent ID or "system"
  reason?: string;
}

// ── Scheduling ────────────────────────────────────────────────────

export interface SessionScheduling {
  /** User's requested start time (optional) */
  requestedStart?: Timestamp;
  /** Earliest available slot based on queue + operating hours */
  earliestAvailable: Timestamp;
  /** Estimated execution duration (ISO 8601 duration, e.g., "PT45M") */
  estimatedDuration: string;
  /** Current queue position (0 = next) */
  queuePosition: number;
  /** Estimated wait time in ms */
  estimatedWaitMs: number;
}

// ── Quote ─────────────────────────────────────────────────────────

export interface SessionQuote {
  /** Base price from capability template */
  basePrice: Amount;
  /** Applied pricing adjustments (from operator rules) */
  adjustments: Array<{
    ruleId: string;
    label: string;
    impact: Amount; // positive = surcharge, negative = discount
  }>;
  /** Final total price */
  totalPrice: Amount;
  currency: Currency;
  /** Operator bond amount */
  bondAmount: Amount;
  /** Challenge window in seconds */
  challengeWindowSeconds: number;
  /** Quote valid until this time */
  validUntil: Timestamp;
}

// ── Contract Terms ────────────────────────────────────────────────

export interface SessionContractTerms {
  /** Per-milestone terms (maps to MilestoneEscrow Milestone struct) */
  milestones: Array<{
    stepId: Id;
    amount: Amount;
    bondAmount: Amount;
    challengeWindowSeconds: number;
  }>;
  /** Workflow deadline */
  deadline: Timestamp;
  /** Assurance tier */
  assuranceTier: AssuranceTier;
  /** Arbiter address (for disputes) */
  arbiter?: Address;
  /** Payer address */
  payer: Address;
  /** Operator address */
  operator: Address;
  /** Token address (USDC) */
  token: Address;
}

// ── The Session ───────────────────────────────────────────────────

export interface NegotiationSession {
  /** Crypto-random session ID */
  id: Id;
  /** Current state */
  status: SessionStatus;

  // ── Parties ───────────────────────────────────────────────────
  /** User agent ID (bound at creation) */
  userAgentId: string;
  /** Operator kernel ID (bound at creation) */
  kernelId: Id;
  /** Network this session belongs to */
  network?: string;

  // ── Capability ────────────────────────────────────────────────
  /** What capability is being negotiated */
  capabilityType: CapabilityType;
  /** Capability ID (specific capability on this kernel) */
  capabilityId?: Id;

  // ── Parameters ────────────────────────────────────────────────
  /** User's current parameter selections (evolves during CONFIGURING) */
  selections: Record<string, unknown>;

  // ── Operator Constraints (frozen snapshot) ────────────────────
  /** Snapshot of operator constraints at session start */
  operatorConstraints: {
    allowedMaterials: string[];
    maxDurationMs: number;
    operatingHours: Record<number, ScheduleWindow[] | null>;
    timezone: string;
    requireEscrow: boolean;
    maxTemperatureCelsius: number;
  };

  // ── Computed State ────────────────────────────────────────────
  /** Scheduling information (computed during QUOTED) */
  scheduling?: SessionScheduling;
  /** Price quote (computed during QUOTED) */
  quote?: SessionQuote;
  /** Contract terms (computed during REVIEWING) */
  contractTerms?: SessionContractTerms;

  // ── Settlement Linkage ────────────────────────────────────────
  /** Job ID (set on COMMITTED) */
  jobId?: Id;
  /** Escrow contract address (set on COMMITTED) */
  escrowAddress?: Address;
  /** CWM ID (set on COMMITTED) */
  cwmId?: Id;

  // ── Lifecycle ─────────────────────────────────────────────────
  createdAt: Timestamp;
  expiresAt: Timestamp;
  committedAt?: Timestamp;

  // ── Audit Trail ───────────────────────────────────────────────
  transitions: SessionTransition[];
}

// ── Session Creation Request ──────────────────────────────────────

export interface CreateSessionRequest {
  /** User agent ID */
  userAgentId: string;
  /** Which kernel to negotiate with */
  kernelId: Id;
  /** Capability type */
  capabilityType: CapabilityType;
  /** Optional: specific capability ID */
  capabilityId?: Id;
  /** Optional: network context */
  network?: string;
  /** Optional: initial parameter selections */
  initialSelections?: Record<string, unknown>;
}

// ── Session Update Request ────────────────────────────────────────

export interface UpdateSelectionsRequest {
  /** Parameter selections to merge (partial update) */
  selections: Record<string, unknown>;
}

// ── Session Defaults ──────────────────────────────────────────────

/** Default session TTL: 30 minutes */
export const SESSION_TTL_MS = 30 * 60_000;

/** Max sessions per agent per hour */
export const MAX_SESSIONS_PER_AGENT_PER_HOUR = 10;

/** Max free-text field length (for sanitization) */
export const MAX_FREE_TEXT_LENGTH = 1000;
