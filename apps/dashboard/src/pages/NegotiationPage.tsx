import React from "react";
import {
  GlassPanel, GlowBadge, AmountDisplay, DataCell, TierBadge, EmptyState,
} from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { SplitEditor } from "../components/SplitEditor.js";
import type { SplitEntry } from "../components/SplitEditor.js";
import { NotLiveState, DemoBanner } from "../components/DemoState.js";
import { isDemoMode } from "../lib/demo-mode.js";
import {
  DEMO_PROPOSALS,
  DEMO_PRICE_FLOORS,
  DEMO_NEGOTIATIONS,
  DEMO_SPLIT_PREVIEW_PRICE,
  type DemoProposal,
  type DemoProposalStatus,
} from "../demo/NegotiationPage.fixtures.js";

/**
 * Negotiations.
 *
 * Not live. No gateway route serves any section of this page:
 *   - Proposals: nothing lists proposals sent to an operator's kernels, or
 *     accepts, counters or rejects one. routes/negotiation.ts serves
 *     buyer-side sessions by ID, and its state machine has no counter-offer
 *     step.
 *   - Revenue Splits: nothing stores a default split for new contracts.
 *   - Pricing Floors: OperatorPolicy has no floor settings; the policy route
 *     stores discount and surcharge rules only.
 *   - History: sessions are stored with their timelines, but every read of
 *     them is by session ID or job ID; nothing lists them.
 * The prototype showed invented proposals, floors and timelines as the
 * operator's own, and its Accept, Counter, Reject, split and floor controls
 * changed only local state, so a click looked like it had taken effect.
 *
 * Outside demo mode each tab says what is missing, offers no action and
 * makes no request. In demo mode (lib/demo-mode.ts) the prototype renders its
 * sample values under a DemoBanner, and every control that would change PCC
 * state is disabled and says so.
 */

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
// Tabs, and what the gateway doesn't serve (shown outside demo mode)
// ---------------------------------------------------------------------------

type Tab = "proposals" | "splits" | "floors" | "history";

const TAB_ORDER: Tab[] = ["proposals", "splits", "floors", "history"];

const TAB_LABELS: Record<Tab, string> = {
  proposals: "Proposals",
  splits:    "Revenue Splits",
  floors:    "Pricing Floors",
  history:   "History",
};

const NOT_LIVE: Record<Tab, { what: string; detail: string }> = {
  proposals: {
    what: "The proposal inbox",
    detail:
      "No gateway route lists proposals sent to your kernels, or accepts, counters or rejects one. " +
      "Negotiation sessions go from quote to commit with no counter-offer step. " +
      "Nothing is shown here and no action is offered.",
  },
  splits: {
    what: "Your default revenue split",
    detail:
      "No gateway route stores a default revenue split for new contracts, so an edit made here " +
      "would not apply to any contract.",
  },
  floors: {
    what: "Price-floor configuration",
    detail:
      "No gateway route stores price floors. Your operator policy (/api/operator/policy/:kernelId) " +
      "holds discount and surcharge rules, not minimum prices, discount caps or surge multipliers.",
  },
  history: {
    what: "Negotiation history",
    detail:
      "Negotiation sessions are stored with their timelines, but no gateway route lists them: " +
      "GET /api/negotiate/session/:id reads one session by its ID.",
  },
};

function TabBar({ active, onChange, labels }: {
  active: Tab;
  onChange: (tab: Tab) => void;
  labels: Record<Tab, string>;
}) {
  return (
    <div className="flex gap-1 border-b border-white/[0.06] pb-1">
      {TAB_ORDER.map((id) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={`px-4 py-2 rounded-t-lg text-xs transition-all ${
            active === id
              ? "bg-white/[0.04] text-green-400 border-b-2 border-green-400/30"
              : "text-white/30 hover:text-white/50"
          }`}
        >
          {labels[id]}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function NegotiationPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  React.useEffect(() => {
    setPageMeta("Negotiations", "Manage incoming proposals, revenue splits, and pricing floors");
  }, [setPageMeta]);

  // Sample proposals, floors and timelines render only when the viewer asked
  // for a demo (lib/demo-mode.ts).
  return isDemoMode() ? <NegotiationDemo /> : <NegotiationNotLive />;
}

function NegotiationNotLive() {
  const [activeTab, setActiveTab] = React.useState<Tab>("proposals");

  return (
    <div className="space-y-6">
      <TabBar active={activeTab} onChange={setActiveTab} labels={TAB_LABELS} />
      <GlassPanel padding="lg">
        <NotLiveState what={NOT_LIVE[activeTab].what} detail={NOT_LIVE[activeTab].detail} hasDemo />
      </GlassPanel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Demo: the prototype with sample values, under a DemoBanner
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<DemoProposalStatus, "green" | "gold" | "gray" | "red"> = {
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

const DISABLED_ACTION =
  "px-3 py-1 rounded text-[10px] bg-white/[0.02] border border-white/[0.06] text-white/25 cursor-not-allowed";

function DemoNote({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-violet-200/60">{children}</p>;
}

// ── Counter modal ──
// The form can be filled in; Send Counter is disabled because no gateway
// route sends a counter-offer.

interface CounterModalProps {
  proposal: DemoProposal;
  onClose: () => void;
}

function CounterModal({ proposal, onClose }: CounterModalProps) {
  const [price, setPrice] = React.useState<number>(proposal.proposedPrice * 1.1);
  const [splits, setSplits] = React.useState<SplitEntry[]>(SPLIT_PRESETS["Single-Step"].map((s) => ({ ...s })));

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

        <div className="space-y-2 pt-2">
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 py-2 rounded-lg border border-white/[0.08] text-xs text-white/40 hover:text-white/60 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled
              title="No gateway route sends a counter-offer"
              className="flex-1 py-2 rounded-lg text-xs font-medium bg-white/[0.02] border border-white/[0.06] text-white/20 cursor-not-allowed"
            >
              Send Counter
            </button>
          </div>
          <DemoNote>Demo: Send Counter doesn't send anything. No gateway route sends a counter-offer.</DemoNote>
        </div>
      </GlassPanel>
    </div>
  );
}

function NegotiationDemo() {
  const proposals = DEMO_PROPOSALS;
  const floors = DEMO_PRICE_FLOORS;
  // Shown read-only: no gateway route stores a default revenue split.
  const [globalSplits, setGlobalSplits] = React.useState<SplitEntry[]>(
    SPLIT_PRESETS["Single-Step"].map((s) => ({ ...s })),
  );
  const [counterTarget, setCounterTarget] = React.useState<DemoProposal | null>(null);
  const [activeTab, setActiveTab] = React.useState<Tab>("proposals");

  const pendingCount = proposals.filter((p) => p.status === "pending" || p.status === "countered").length;

  const labels: Record<Tab, string> = {
    ...TAB_LABELS,
    proposals: `Proposals${pendingCount > 0 ? ` (${pendingCount})` : ""}`,
  };

  return (
    <div className="space-y-6">
      <DemoBanner what="Negotiations" />

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
      <TabBar active={activeTab} onChange={setActiveTab} labels={labels} />

      {/* ── Pending Proposals ── */}
      {activeTab === "proposals" && (
        <div className="space-y-3">
          <DemoNote>
            Demo: Accept and Reject are disabled, and Send Counter sends nothing. No gateway route
            accepts, counters or rejects a proposal.
          </DemoNote>
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

                {/* Actions: nothing here reaches the gateway */}
                {(proposal.status === "pending" || proposal.status === "countered") && (
                  <div className="flex flex-col gap-2 flex-shrink-0">
                    <button
                      type="button"
                      disabled
                      title="No gateway route accepts a proposal"
                      className={DISABLED_ACTION}
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
                      type="button"
                      disabled
                      title="No gateway route rejects a proposal"
                      className={DISABLED_ACTION}
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
          <DemoNote>
            Demo: this split can't be changed here. No gateway route stores a default revenue split.
          </DemoNote>
          <GlassPanel padding="lg">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider">
                Global Revenue Split
              </h3>
              <span className="text-[10px] text-white/25">Would apply to new contracts unless overridden</span>
            </div>
            <SplitEditor
              splits={globalSplits}
              onChange={setGlobalSplits}
              presets={SPLIT_PRESETS}
              readOnly
              totalPrice={DEMO_SPLIT_PREVIEW_PRICE}
            />
          </GlassPanel>

          <GlassPanel padding="md">
            <div className="text-[10px] text-white/30 uppercase tracking-wider mb-3">Quick Apply</div>
            <div className="flex gap-2 flex-wrap">
              <button type="button" disabled className={DISABLED_ACTION}>
                Single-Step (10/70/10/10)
              </button>
              <button type="button" disabled className={DISABLED_ACTION}>
                Multi-Step (5/75/10/10)
              </button>
              <button type="button" disabled className={DISABLED_ACTION}>
                Community (20/60/5/5/10)
              </button>
            </div>
          </GlassPanel>
        </div>
      )}

      {/* ── Pricing Floors ── */}
      {activeTab === "floors" && (
        <div className="space-y-3">
          <DemoNote>Demo: floors can't be changed here. No gateway route stores price floors.</DemoNote>
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
                            disabled
                            value={floor.minPrice}
                            readOnly
                            className="w-20 bg-white/[0.03] border border-white/[0.06] rounded px-2 py-1 font-mono text-white/60 text-right outline-none cursor-not-allowed"
                          />
                        </div>
                      </td>
                      <td className="py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <input
                            type="number"
                            disabled
                            value={floor.maxDiscount}
                            readOnly
                            className="w-16 bg-white/[0.03] border border-white/[0.06] rounded px-2 py-1 font-mono text-white/60 text-right outline-none cursor-not-allowed"
                          />
                          <span className="text-white/30">%</span>
                        </div>
                      </td>
                      <td className="py-3 text-right">
                        <input
                          type="number"
                          disabled
                          value={floor.surgeMultiplier}
                          readOnly
                          className="w-16 bg-white/[0.03] border border-white/[0.06] rounded px-2 py-1 font-mono text-white/60 text-right outline-none cursor-not-allowed"
                        />
                      </td>
                      <td className="py-3 text-center">
                        <button
                          type="button"
                          disabled
                          className={`w-10 h-5 rounded-full transition-all relative cursor-not-allowed ${
                            floor.autoReject ? "bg-green-500/40" : "bg-white/[0.06]"
                          }`}
                          title={floor.autoReject ? "Auto-reject on (sample)" : "Auto-reject off (sample)"}
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
          {DEMO_NEGOTIATIONS.length === 0 && (
            <GlassPanel padding="lg">
              <EmptyState title="No negotiations yet" description="Completed negotiation timelines appear here." />
            </GlassPanel>
          )}
          {DEMO_NEGOTIATIONS.map((neg) => (
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
        />
      )}
    </div>
  );
}
