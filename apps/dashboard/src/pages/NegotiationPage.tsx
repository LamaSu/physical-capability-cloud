import React from "react";
import {
  GlassPanel, GlowBadge, AmountDisplay, DataCell, TierBadge, EmptyState,
} from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { SplitEditor } from "../components/SplitEditor.js";
import type { SplitEntry } from "../components/SplitEditor.js";

// ---------------------------------------------------------------------------
// Split presets (mirrors story-defaults SPLIT_PROFILES)
//
// Legacy presets keep `designer`/`network` so older saved negotiations keep
// rendering. ADR-12 contributor-economics presets show the canonical 10-value
// ContributorRole taxonomy and match @pcc/contracts/ts/story-defaults.ts
// SPLIT_PROFILES.contributorEconomics{Minimal,WithAi}.
// ---------------------------------------------------------------------------

const SPLIT_PRESETS: Record<string, SplitEntry[]> = {
  "Single-Step": [
    { role: "designer",  percentage: 10, label: "CSD Author" },
    { role: "operator",  percentage: 70, label: "Machine Operator" },
    { role: "verifier",  percentage: 10, label: "Evidence Verifier" },
    { role: "network",   percentage: 10, label: "Protocol Treasury" },
  ],
  "Multi-Step": [
    { role: "designer",  percentage: 5,  label: "Workflow Designer" },
    { role: "operator",  percentage: 75, label: "Step Operators" },
    { role: "verifier",  percentage: 10, label: "Evidence Verifiers" },
    { role: "network",   percentage: 10, label: "Protocol Treasury" },
  ],
  "Community": [
    { role: "designer",  percentage: 20, label: "CSD Author" },
    { role: "operator",  percentage: 60, label: "Machine Operator" },
    { role: "curator",   percentage:  5, label: "Community Curator" },
    { role: "verifier",  percentage:  5, label: "Evidence Verifier" },
    { role: "network",   percentage: 10, label: "Protocol Treasury" },
  ],
  // ADR-12 contributor-economics presets
  "Contrib-Econ — Minimal": [
    { role: "operator",         percentage: 92, label: "Machine Operator" },
    { role: "verifier",         percentage:  3, label: "Evidence Verifier" },
    { role: "protocol-author",  percentage:  2, label: "CSD Author" },
    { role: "integrator",       percentage:  2, label: "Adapter Integrator" },
    { role: "network-treasury", percentage:  1, label: "Network Treasury" },
  ],
  "Contrib-Econ — With AI": [
    { role: "operator",         percentage: 87, label: "Machine Operator" },
    { role: "verifier",         percentage:  3, label: "Evidence Verifier" },
    { role: "protocol-author",  percentage:  2, label: "CSD Author" },
    { role: "integrator",       percentage:  2, label: "Adapter Integrator" },
    { role: "model-author",     percentage:  4, label: "Model Author" },
    { role: "network-treasury", percentage:  2, label: "Network Treasury" },
  ],
};

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

type ProposalStatus = "pending" | "countered" | "accepted" | "rejected" | "expired";

interface Proposal {
  id: string;
  capability: string;
  capabilityType: string;
  customerAgent: string;
  proposedPrice: number;
  assuranceTier: 0 | 1 | 2 | 3;
  status: ProposalStatus;
  receivedAt: string;
  counterPrice?: number;
  expiresIn: string;
}

interface PricingFloor {
  id: string;
  capability: string;
  capabilityType: string;
  minPrice: number;
  maxDiscount: number;
  surgeMultiplier: number;
  autoReject: boolean;
}

interface NegotiationEvent {
  type: "proposal" | "counter" | "accepted" | "rejected" | "expired";
  actor: string;
  price?: number;
  splitNote?: string;
  timestamp: string;
}

interface Negotiation {
  id: string;
  capability: string;
  customerAgent: string;
  status: ProposalStatus;
  timeline: NegotiationEvent[];
}

const MOCK_PROPOSALS: Proposal[] = [
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

const MOCK_FLOORS: PricingFloor[] = [
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

const MOCK_NEGOTIATIONS: Negotiation[] = [
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

// ---------------------------------------------------------------------------
// Status colors
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<ProposalStatus, "green" | "gold" | "gray" | "red"> = {
  pending:  "gold",
  countered: "gold",
  accepted: "green",
  rejected: "red",
  expired:  "gray",
};

const EVENT_ICONS: Record<string, string> = {
  proposal: "→",
  counter:  "↔",
  accepted: "✓",
  rejected: "✗",
  expired:  "⏰",
};

// ---------------------------------------------------------------------------
// Counter modal
// ---------------------------------------------------------------------------

interface CounterModalProps {
  proposal: Proposal;
  onClose: () => void;
  onSubmit: (price: number, splits: SplitEntry[]) => void;
}

function CounterModal({ proposal, onClose, onSubmit }: CounterModalProps) {
  const [price, setPrice] = React.useState<number>(proposal.proposedPrice * 1.1);
  const [splits, setSplits] = React.useState<SplitEntry[]>(SPLIT_PRESETS["Single-Step"].map((s) => ({ ...s })));

  const total = splits.reduce((acc, s) => acc + s.percentage, 0);
  const isValid = Math.round(total) === 100;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <GlassPanel padding="lg" className="w-full max-w-lg mx-4 space-y-6">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white/80">Counter Proposal</h3>
          <button onClick={onClose} className="text-white/30 hover:text-white/60 text-lg leading-none">×</button>
        </div>

        <div className="text-xs text-white/40 space-y-1">
          <div className="font-medium text-white/60">{proposal.capability}</div>
          <div>Customer: <span className="font-mono">{proposal.customerAgent}</span></div>
          <div>Original offer: <span className="text-yellow-400">${proposal.proposedPrice.toFixed(2)}</span></div>
        </div>

        {/* Counter price */}
        <div>
          <label className="text-[10px] text-white/30 uppercase tracking-wider block mb-2">Counter Price (USD)</label>
          <div className="flex items-center gap-2">
            <span className="text-white/40 text-sm">$</span>
            <input
              type="number"
              min={0}
              step={0.50}
              value={price}
              onChange={(e) => setPrice(parseFloat(e.target.value) || 0)}
              className="flex-1 bg-white/[0.04] border border-white/[0.10] rounded px-3 py-2 text-sm font-mono text-white/80 outline-none focus:border-green-500/30"
            />
          </div>
        </div>

        {/* Revenue split editor */}
        <div>
          <div className="text-[10px] text-white/30 uppercase tracking-wider mb-3">Revenue Split</div>
          <SplitEditor
            splits={splits}
            onChange={setSplits}
            presets={SPLIT_PRESETS}
            totalPrice={price}
          />
        </div>

        <div className="flex gap-3 pt-2">
          <button
            onClick={onClose}
            className="flex-1 py-2 rounded-lg border border-white/[0.08] text-xs text-white/40 hover:text-white/60 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => isValid && onSubmit(price, splits)}
            disabled={!isValid}
            className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${
              isValid
                ? "bg-green-500/20 border border-green-500/30 text-green-400 hover:bg-green-500/30"
                : "bg-white/[0.02] border border-white/[0.06] text-white/20 cursor-not-allowed"
            }`}
          >
            Send Counter
          </button>
        </div>
      </GlassPanel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function NegotiationPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  const [proposals, setProposals] = React.useState<Proposal[]>(MOCK_PROPOSALS);
  const [floors, setFloors] = React.useState<PricingFloor[]>(MOCK_FLOORS);
  const [globalSplits, setGlobalSplits] = React.useState<SplitEntry[]>(
    SPLIT_PRESETS["Single-Step"].map((s) => ({ ...s })),
  );
  const [counterTarget, setCounterTarget] = React.useState<Proposal | null>(null);
  const [activeTab, setActiveTab] = React.useState<"proposals" | "splits" | "floors" | "history">("proposals");

  React.useEffect(() => {
    setPageMeta("Negotiations", "Manage incoming proposals, revenue splits, and pricing floors");
  }, [setPageMeta]);

  function acceptProposal(id: string) {
    setProposals((prev) =>
      prev.map((p) => (p.id === id ? { ...p, status: "accepted" } : p)),
    );
  }

  function rejectProposal(id: string) {
    setProposals((prev) =>
      prev.map((p) => (p.id === id ? { ...p, status: "rejected" } : p)),
    );
  }

  function handleCounter(price: number, _splits: SplitEntry[]) {
    if (!counterTarget) return;
    setProposals((prev) =>
      prev.map((p) =>
        p.id === counterTarget.id
          ? { ...p, status: "countered", counterPrice: price }
          : p,
      ),
    );
    setCounterTarget(null);
  }

  function toggleFloorAutoReject(id: string) {
    setFloors((prev) =>
      prev.map((f) => (f.id === id ? { ...f, autoReject: !f.autoReject } : f)),
    );
  }

  function updateFloorField(id: string, field: keyof PricingFloor, value: number) {
    setFloors((prev) =>
      prev.map((f) => (f.id === id ? { ...f, [field]: value } : f)),
    );
  }

  const pendingCount = proposals.filter((p) => p.status === "pending" || p.status === "countered").length;

  const tabs = [
    { id: "proposals", label: `Proposals${pendingCount > 0 ? ` (${pendingCount})` : ""}` },
    { id: "splits",   label: "Revenue Splits" },
    { id: "floors",   label: "Pricing Floors" },
    { id: "history",  label: "History" },
  ] as const;

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <GlassPanel padding="md" glow="gold">
          <DataCell label="Pending" value={proposals.filter((p) => p.status === "pending").length} sub="awaiting response" mono />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Countered" value={proposals.filter((p) => p.status === "countered").length} sub="in negotiation" mono />
        </GlassPanel>
        <GlassPanel padding="md" glow="green">
          <DataCell
            label="Accepted"
            value={proposals.filter((p) => p.status === "accepted").length}
            sub="this session"
            mono
          />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Price Floors" value={floors.length} sub={`${floors.filter((f) => f.autoReject).length} auto-reject`} mono />
        </GlassPanel>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-white/[0.06] pb-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`px-4 py-2 rounded-t-lg text-xs transition-all ${
              activeTab === t.id
                ? "bg-white/[0.04] text-green-400 border-b-2 border-green-400/30"
                : "text-white/30 hover:text-white/50"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Pending Proposals ── */}
      {activeTab === "proposals" && (
        <div className="space-y-3">
          {proposals.length === 0 && (
            <GlassPanel padding="lg">
              <EmptyState
                title="No proposals"
                description="Incoming job proposals will appear here for your review."
              />
            </GlassPanel>
          )}
          {proposals.map((proposal) => (
            <GlassPanel key={proposal.id} padding="md" hover>
              <div className="flex items-start gap-4">
                {/* Left info */}
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-white/80">{proposal.capability}</span>
                    <GlowBadge color={STATUS_COLORS[proposal.status]}>{proposal.status}</GlowBadge>
                    <TierBadge tier={proposal.assuranceTier} />
                  </div>
                  <div className="text-xs text-white/40 font-mono truncate">
                    {proposal.customerAgent}
                  </div>
                  <div className="text-[10px] text-white/25">
                    Received {proposal.receivedAt} &middot; Expires in {proposal.expiresIn}
                  </div>
                </div>

                {/* Price column */}
                <div className="text-right flex-shrink-0">
                  <AmountDisplay amount={proposal.proposedPrice.toFixed(2)} size="md" />
                  {proposal.counterPrice !== undefined && (
                    <div className="text-[10px] text-yellow-400/70 mt-1">
                      Counter: ${proposal.counterPrice.toFixed(2)}
                    </div>
                  )}
                </div>

                {/* Actions */}
                {(proposal.status === "pending" || proposal.status === "countered") && (
                  <div className="flex flex-col gap-2 flex-shrink-0">
                    <button
                      onClick={() => acceptProposal(proposal.id)}
                      className="px-3 py-1 rounded text-[10px] bg-green-500/15 border border-green-500/25 text-green-400 hover:bg-green-500/25 transition-all"
                    >
                      Accept
                    </button>
                    <button
                      onClick={() => setCounterTarget(proposal)}
                      className="px-3 py-1 rounded text-[10px] bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 hover:bg-yellow-500/20 transition-all"
                    >
                      Counter
                    </button>
                    <button
                      onClick={() => rejectProposal(proposal.id)}
                      className="px-3 py-1 rounded text-[10px] bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-all"
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>
            </GlassPanel>
          ))}
        </div>
      )}

      {/* ── Revenue Splits ── */}
      {activeTab === "splits" && (
        <div className="space-y-4 max-w-2xl">
          <GlassPanel padding="lg">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider">
                Global Revenue Split
              </h3>
              <span className="text-[10px] text-white/25">Applies to all new contracts unless overridden</span>
            </div>
            <SplitEditor
              splits={globalSplits}
              onChange={setGlobalSplits}
              presets={SPLIT_PRESETS}
              totalPrice={25.00}
            />
          </GlassPanel>

          <GlassPanel padding="md">
            <div className="text-[10px] text-white/30 uppercase tracking-wider mb-3">Quick Apply</div>
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() => setGlobalSplits(SPLIT_PRESETS["Single-Step"].map((s) => ({ ...s })))}
                className="px-3 py-2 rounded-lg text-xs bg-white/[0.03] border border-white/[0.08] text-white/50 hover:bg-white/[0.06] transition-all"
              >
                Single-Step (10/70/10/10)
              </button>
              <button
                onClick={() => setGlobalSplits(SPLIT_PRESETS["Multi-Step"].map((s) => ({ ...s })))}
                className="px-3 py-2 rounded-lg text-xs bg-white/[0.03] border border-white/[0.08] text-white/50 hover:bg-white/[0.06] transition-all"
              >
                Multi-Step (5/75/10/10)
              </button>
              <button
                onClick={() => setGlobalSplits(SPLIT_PRESETS["Community"].map((s) => ({ ...s })))}
                className="px-3 py-2 rounded-lg text-xs bg-white/[0.03] border border-white/[0.08] text-white/50 hover:bg-white/[0.06] transition-all"
              >
                Community (20/60/5/5/10)
              </button>
            </div>
          </GlassPanel>
        </div>
      )}

      {/* ── Pricing Floors ── */}
      {activeTab === "floors" && (
        <div className="space-y-3">
          <GlassPanel padding="md">
            <div className="text-[10px] text-white/30 mb-3 leading-relaxed">
              Set minimum prices per capability. Jobs below the floor are auto-rejected (when enabled) or flagged for review.
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[10px] text-white/25 uppercase tracking-wider border-b border-white/[0.06]">
                    <th className="text-left pb-2">Capability</th>
                    <th className="text-right pb-2">Min Price</th>
                    <th className="text-right pb-2">Max Discount</th>
                    <th className="text-right pb-2">Surge ×</th>
                    <th className="text-center pb-2">Auto-Reject</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {floors.map((floor) => (
                    <tr key={floor.id} className="group">
                      <td className="py-3">
                        <div className="text-white/70">{floor.capability}</div>
                        <div className="text-white/25 font-mono">{floor.capabilityType}</div>
                      </td>
                      <td className="py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <span className="text-white/30">$</span>
                          <input
                            type="number"
                            min={0}
                            step={0.5}
                            value={floor.minPrice}
                            onChange={(e) =>
                              updateFloorField(floor.id, "minPrice", parseFloat(e.target.value) || 0)
                            }
                            className="w-20 bg-white/[0.03] border border-white/[0.06] rounded px-2 py-1 font-mono text-white/60 text-right outline-none focus:border-white/20"
                          />
                        </div>
                      </td>
                      <td className="py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <input
                            type="number"
                            min={0}
                            max={50}
                            value={floor.maxDiscount}
                            onChange={(e) =>
                              updateFloorField(floor.id, "maxDiscount", parseFloat(e.target.value) || 0)
                            }
                            className="w-16 bg-white/[0.03] border border-white/[0.06] rounded px-2 py-1 font-mono text-white/60 text-right outline-none focus:border-white/20"
                          />
                          <span className="text-white/30">%</span>
                        </div>
                      </td>
                      <td className="py-3 text-right">
                        <input
                          type="number"
                          min={1}
                          max={5}
                          step={0.1}
                          value={floor.surgeMultiplier}
                          onChange={(e) =>
                            updateFloorField(floor.id, "surgeMultiplier", parseFloat(e.target.value) || 1)
                          }
                          className="w-16 bg-white/[0.03] border border-white/[0.06] rounded px-2 py-1 font-mono text-white/60 text-right outline-none focus:border-white/20"
                        />
                      </td>
                      <td className="py-3 text-center">
                        <button
                          onClick={() => toggleFloorAutoReject(floor.id)}
                          className={`w-10 h-5 rounded-full transition-all relative ${
                            floor.autoReject ? "bg-green-500/40" : "bg-white/[0.06]"
                          }`}
                          title={floor.autoReject ? "Auto-reject enabled" : "Auto-reject disabled"}
                        >
                          <span
                            className={`absolute top-0.5 w-4 h-4 rounded-full bg-white/70 transition-all ${
                              floor.autoReject ? "left-5" : "left-0.5"
                            }`}
                          />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </GlassPanel>
        </div>
      )}

      {/* ── History / Active Negotiations ── */}
      {activeTab === "history" && (
        <div className="space-y-4 max-w-2xl">
          {MOCK_NEGOTIATIONS.length === 0 && (
            <GlassPanel padding="lg">
              <EmptyState title="No negotiations yet" description="Completed negotiation timelines appear here." />
            </GlassPanel>
          )}
          {MOCK_NEGOTIATIONS.map((neg) => (
            <GlassPanel key={neg.id} padding="md">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <span className="text-sm font-medium text-white/80">{neg.capability}</span>
                  <div className="text-[10px] text-white/30 font-mono">{neg.customerAgent}</div>
                </div>
                <GlowBadge color={STATUS_COLORS[neg.status]}>{neg.status}</GlowBadge>
              </div>
              <div className="relative pl-4 space-y-3">
                {/* Vertical line */}
                <div className="absolute left-1.5 top-2 bottom-2 w-px bg-white/[0.08]" />
                {neg.timeline.map((event, i) => (
                  <div key={i} className="flex items-start gap-3 relative">
                    {/* Dot */}
                    <div
                      className={`w-3 h-3 rounded-full flex-shrink-0 flex items-center justify-center text-[8px] -ml-4 mt-0.5 z-10 ${
                        event.type === "accepted"
                          ? "bg-green-500/40 border border-green-500/50"
                          : event.type === "rejected"
                          ? "bg-red-500/40 border border-red-500/50"
                          : "bg-white/[0.10] border border-white/[0.15]"
                      }`}
                    >
                      {EVENT_ICONS[event.type]}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-white/60">{event.actor}</span>
                        <span className="text-[10px] text-white/25 capitalize">{event.type}</span>
                        {event.price !== undefined && (
                          <span className="text-[10px] text-yellow-400/80 font-mono">
                            ${event.price.toFixed(2)}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-white/20">{event.timestamp}</div>
                    </div>
                  </div>
                ))}
              </div>
            </GlassPanel>
          ))}
        </div>
      )}

      {/* Counter modal */}
      {counterTarget && (
        <CounterModal
          proposal={counterTarget}
          onClose={() => setCounterTarget(null)}
          onSubmit={handleCounter}
        />
      )}
    </div>
  );
}
