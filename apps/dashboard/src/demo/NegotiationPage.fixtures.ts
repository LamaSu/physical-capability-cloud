/**
 * NegotiationPage demo fixtures: sample proposals, price floors and
 * negotiation timelines, not live PCC state.
 *
 * Rendered only in demo mode (lib/demo-mode.ts), under a DemoBanner. No
 * gateway route serves any of this:
 *   - proposals: nothing lists priced proposals sent to an operator's
 *     kernels, and nothing accepts, counters or rejects one.
 *     packages/gateway/src/routes/negotiation.ts serves buyer-side sessions
 *     by ID only, and the session state machine (quoted -> reviewing ->
 *     committed) has no counter-offer step. /api/operator/approvals
 *     (routes/operator.ts) holds approval requests with no price, and
 *     /api/job-offers/open (routes/job-offers.ts) is a public feed of open
 *     offers that operators claim rather than negotiate;
 *   - price floors: OperatorPolicy (packages/spec/src/types/operator-policy.ts)
 *     has no minimum price, discount cap, surge multiplier or auto-reject
 *     setting; the pricing settings /api/operator/policy/:kernelId stores
 *     are discount and surcharge rules;
 *   - history: negotiation sessions are stored with their transitions, but
 *     every gateway read of them is by session ID or job ID; nothing lists
 *     them;
 *   - the revenue-split preview price is a sample number.
 * pages/NegotiationPage.tsx says this on screen when demo mode is off.
 */

export type DemoProposalStatus = "pending" | "countered" | "accepted" | "rejected" | "expired";

export interface DemoProposal {
  id: string;
  capability: string;
  capabilityType: string;
  customerAgent: string;
  proposedPrice: number;
  assuranceTier: 0 | 1 | 2 | 3;
  status: DemoProposalStatus;
  receivedAt: string;
  counterPrice?: number;
  expiresIn: string;
}

export interface DemoPricingFloor {
  id: string;
  capability: string;
  capabilityType: string;
  minPrice: number;
  maxDiscount: number;
  surgeMultiplier: number;
  autoReject: boolean;
}

export interface DemoNegotiationEvent {
  type: "proposal" | "counter" | "accepted" | "rejected" | "expired";
  actor: string;
  price?: number;
  splitNote?: string;
  timestamp: string;
}

export interface DemoNegotiation {
  id: string;
  capability: string;
  customerAgent: string;
  status: DemoProposalStatus;
  timeline: DemoNegotiationEvent[];
}

export const DEMO_PROPOSALS: DemoProposal[] = [
  {
    id: "prop-001",
    capability: "FDM 3D Print — Prusa MK4",
    capabilityType: "fdm",
    customerAgent: "user-agent@alpha.pcc",
    proposedPrice: 18.50,
    assuranceTier: 1,
    status: "pending",
    receivedAt: "2 min ago",
    expiresIn: "58 min",
  },
  {
    id: "prop-002",
    capability: "Laser Cut — Epilog Fusion",
    capabilityType: "laser-cut",
    customerAgent: "broker-agent@beta.pcc",
    proposedPrice: 42.00,
    assuranceTier: 2,
    status: "pending",
    receivedAt: "14 min ago",
    expiresIn: "46 min",
  },
  {
    id: "prop-003",
    capability: "FDM 3D Print — Prusa MK4",
    capabilityType: "fdm",
    customerAgent: "user-agent@gamma.pcc",
    proposedPrice: 12.00,
    assuranceTier: 0,
    status: "countered",
    receivedAt: "1 hr ago",
    counterPrice: 19.00,
    expiresIn: "expired",
  },
];

export const DEMO_PRICE_FLOORS: DemoPricingFloor[] = [
  {
    id: "floor-001",
    capability: "FDM 3D Print",
    capabilityType: "fdm",
    minPrice: 15.00,
    maxDiscount: 10,
    surgeMultiplier: 1.5,
    autoReject: true,
  },
  {
    id: "floor-002",
    capability: "Laser Cut",
    capabilityType: "laser-cut",
    minPrice: 35.00,
    maxDiscount: 5,
    surgeMultiplier: 2.0,
    autoReject: false,
  },
  {
    id: "floor-003",
    capability: "CNC 3-Axis",
    capabilityType: "cnc-3axis",
    minPrice: 80.00,
    maxDiscount: 8,
    surgeMultiplier: 1.2,
    autoReject: true,
  },
];

export const DEMO_NEGOTIATIONS: DemoNegotiation[] = [
  {
    id: "neg-001",
    capability: "FDM 3D Print",
    customerAgent: "user-agent@delta.pcc",
    status: "accepted",
    timeline: [
      { type: "proposal", actor: "Customer", price: 16.00, timestamp: "2 hr ago" },
      { type: "counter",  actor: "You",      price: 20.00, timestamp: "1 hr 45 min ago" },
      { type: "counter",  actor: "Customer", price: 18.50, timestamp: "1 hr 20 min ago" },
      { type: "accepted", actor: "You",      timestamp: "1 hr ago" },
    ],
  },
  {
    id: "neg-002",
    capability: "Laser Cut",
    customerAgent: "broker-agent@epsilon.pcc",
    status: "rejected",
    timeline: [
      { type: "proposal", actor: "Customer", price: 20.00, timestamp: "3 hr ago" },
      { type: "counter",  actor: "You",      price: 40.00, timestamp: "2 hr 50 min ago" },
      { type: "rejected", actor: "Customer", timestamp: "2 hr ago" },
    ],
  },
];

/** Sample per-job price the global split editor previews earnings against. */
export const DEMO_SPLIT_PREVIEW_PRICE = 25.00;
