import React from "react";
import { GlassPanel, GlowBadge, DataCell, EmptyState } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { getAuthHeaders } from "../stores/auth-store.js";

const API = import.meta.env.VITE_PCC_URL ?? "";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SessionStatus = "CREATED" | "CONFIGURING" | "QUOTED" | "REVIEWING" | "COMMITTED";

interface NegotiationSession {
  id: string;
  status: SessionStatus;
  userAgentId?: string;
  kernelId?: string;
  capabilityType?: string;
  parameters?: Record<string, unknown>;
  quote?: {
    basePrice?: number;
    adjustments?: Array<{ label: string; amount: number }>;
    total?: number;
    bond?: number;
    challengeWindow?: string;
  };
  contractTerms?: {
    milestones?: Array<{ name: string; amount: number; evidence: string }>;
    deadline?: string;
    assuranceTier?: number;
  };
  auditTrail?: Array<{
    from: string;
    to: string;
    timestamp: string;
    note?: string;
  }>;
  createdAt?: string;
}

// ---------------------------------------------------------------------------
// Status Pipeline
// ---------------------------------------------------------------------------

const STATUS_STEPS: SessionStatus[] = ["CREATED", "CONFIGURING", "QUOTED", "REVIEWING", "COMMITTED"];

function StatusPipeline({ current }: { current: SessionStatus }) {
  const currentIdx = STATUS_STEPS.indexOf(current);

  return (
    <div className="flex items-center gap-1">
      {STATUS_STEPS.map((step, i) => {
        const isPast = i < currentIdx;
        const isCurrent = i === currentIdx;
        const isFuture = i > currentIdx;

        return (
          <React.Fragment key={step}>
            {i > 0 && (
              <div className={`h-px flex-1 max-w-8 ${isPast ? "bg-green-500/40" : "bg-white/[0.08]"}`} />
            )}
            <div
              className={`px-3 py-1.5 rounded-lg text-[10px] font-medium uppercase tracking-wider border transition-all ${
                isCurrent
                  ? "bg-green-500/20 border-green-500/40 text-green-400"
                  : isPast
                  ? "bg-white/[0.06] border-white/[0.12] text-white/50"
                  : isFuture
                  ? "bg-white/[0.02] border-white/[0.06] text-white/15"
                  : ""
              }`}
            >
              {step}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create Session Form
// ---------------------------------------------------------------------------

interface CreateFormProps {
  onSubmit: (data: { userAgentId: string; kernelId: string; capabilityType: string }) => void;
  onCancel: () => void;
  submitting: boolean;
}

function CreateSessionForm({ onSubmit, onCancel, submitting }: CreateFormProps) {
  const [userAgentId, setUserAgentId] = React.useState("");
  const [kernelId, setKernelId] = React.useState("");
  const [capabilityType, setCapabilityType] = React.useState("");

  const canSubmit = userAgentId.trim() && kernelId.trim() && capabilityType.trim();

  return (
    <GlassPanel padding="lg" className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white/80">Create New Session</h3>
        <button onClick={onCancel} className="text-white/30 hover:text-white/60 text-lg leading-none">
          x
        </button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="text-[10px] text-white/30 uppercase tracking-wider block mb-1">User Agent ID</label>
          <input
            type="text"
            value={userAgentId}
            onChange={(e) => setUserAgentId(e.target.value)}
            placeholder="user-agent@alpha.pcc"
            className="w-full bg-white/[0.04] border border-white/[0.10] rounded px-3 py-2 text-sm font-mono text-white/80 outline-none focus:border-green-500/30"
          />
        </div>
        <div>
          <label className="text-[10px] text-white/30 uppercase tracking-wider block mb-1">Kernel ID</label>
          <input
            type="text"
            value={kernelId}
            onChange={(e) => setKernelId(e.target.value)}
            placeholder="kern-001"
            className="w-full bg-white/[0.04] border border-white/[0.10] rounded px-3 py-2 text-sm font-mono text-white/80 outline-none focus:border-green-500/30"
          />
        </div>
        <div>
          <label className="text-[10px] text-white/30 uppercase tracking-wider block mb-1">Capability Type</label>
          <input
            type="text"
            value={capabilityType}
            onChange={(e) => setCapabilityType(e.target.value)}
            placeholder="fdm"
            className="w-full bg-white/[0.04] border border-white/[0.10] rounded px-3 py-2 text-sm font-mono text-white/80 outline-none focus:border-green-500/30"
          />
        </div>
      </div>

      <div className="flex gap-3 pt-2">
        <button
          onClick={onCancel}
          className="flex-1 py-2 rounded-lg border border-white/[0.08] text-xs text-white/40 hover:text-white/60 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => canSubmit && onSubmit({ userAgentId, kernelId, capabilityType })}
          disabled={!canSubmit || submitting}
          className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${
            canSubmit && !submitting
              ? "bg-green-500/20 border border-green-500/30 text-green-400 hover:bg-green-500/30"
              : "bg-white/[0.02] border border-white/[0.06] text-white/20 cursor-not-allowed"
          }`}
        >
          {submitting ? "Creating..." : "Create Session"}
        </button>
      </div>
    </GlassPanel>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export function NegotiationSessionPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  const [sessionId, setSessionId] = React.useState("");
  const [session, setSession] = React.useState<NegotiationSession | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [showCreate, setShowCreate] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    setPageMeta("Negotiation Session", "View and manage capability negotiation sessions");
  }, [setPageMeta]);

  // Load session by ID
  function loadSession() {
    if (!sessionId.trim()) return;
    setLoading(true);
    setError(null);
    setSession(null);
    fetch(`${API}/api/negotiate/session/${sessionId.trim()}`, {
      headers: { ...getAuthHeaders() },
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        setSession(data.session ?? data);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  // Create new session
  function handleCreate(data: { userAgentId: string; kernelId: string; capabilityType: string }) {
    setSubmitting(true);
    setError(null);
    fetch(`${API}/api/negotiate/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify(data),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        const newSession = data.session ?? data;
        setSession(newSession);
        setSessionId(newSession.id ?? "");
        setShowCreate(false);
      })
      .catch((err) => setError(err.message))
      .finally(() => setSubmitting(false));
  }

  const statusColor = (status: SessionStatus): "green" | "gold" | "red" | "gray" => {
    switch (status) {
      case "COMMITTED": return "green";
      case "QUOTED":
      case "REVIEWING": return "gold";
      case "CREATED":
      case "CONFIGURING": return "gray";
      default: return "gray";
    }
  };

  return (
    <div className="space-y-6">
      {/* Search bar */}
      <GlassPanel padding="md">
        <div className="flex items-center gap-3">
          <label className="text-[10px] text-white/30 uppercase tracking-wider flex-shrink-0">Session ID</label>
          <input
            type="text"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && loadSession()}
            placeholder="Enter session ID to load..."
            className="flex-1 bg-white/[0.04] border border-white/[0.10] rounded px-3 py-2 text-sm font-mono text-white/80 outline-none focus:border-green-500/30"
          />
          <button
            onClick={loadSession}
            disabled={!sessionId.trim() || loading}
            className={`px-4 py-2 rounded-lg text-xs font-medium transition-all ${
              sessionId.trim() && !loading
                ? "bg-green-500/20 border border-green-500/30 text-green-400 hover:bg-green-500/30"
                : "bg-white/[0.02] border border-white/[0.06] text-white/20 cursor-not-allowed"
            }`}
          >
            {loading ? "Loading..." : "Load"}
          </button>
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="px-4 py-2 rounded-lg text-xs font-medium bg-white/[0.04] border border-white/[0.08] text-white/50 hover:text-white/70 hover:bg-white/[0.06] transition-all"
          >
            {showCreate ? "Cancel" : "Create New Session"}
          </button>
        </div>
      </GlassPanel>

      {/* Create form */}
      {showCreate && (
        <CreateSessionForm
          onSubmit={handleCreate}
          onCancel={() => setShowCreate(false)}
          submitting={submitting}
        />
      )}

      {/* Error */}
      {error && (
        <GlassPanel padding="md">
          <div className="text-xs text-red-400">Error: {error}</div>
        </GlassPanel>
      )}

      {/* Loading */}
      {loading && (
        <GlassPanel padding="lg">
          <div className="text-center py-8 text-white/30 text-sm animate-pulse">Loading session...</div>
        </GlassPanel>
      )}

      {/* Empty state */}
      {!loading && !session && !error && !showCreate && (
        <GlassPanel padding="lg">
          <EmptyState
            title="No session loaded"
            description="Enter a session ID above and click Load, or create a new negotiation session."
          />
        </GlassPanel>
      )}

      {/* Session view */}
      {session && (
        <div className="space-y-6">
          {/* Header */}
          <GlassPanel padding="md">
            <div className="flex items-center justify-between mb-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-white/80 font-mono">{session.id}</span>
                  <GlowBadge color={statusColor(session.status)}>{session.status}</GlowBadge>
                </div>
                {session.createdAt && (
                  <div className="text-[10px] text-white/25">Created: {session.createdAt}</div>
                )}
              </div>
            </div>

            {/* Status pipeline */}
            <StatusPipeline current={session.status} />
          </GlassPanel>

          {/* KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {session.userAgentId && (
              <GlassPanel padding="md">
                <DataCell label="User Agent" value={session.userAgentId} mono />
              </GlassPanel>
            )}
            {session.kernelId && (
              <GlassPanel padding="md">
                <DataCell label="Kernel" value={session.kernelId} mono />
              </GlassPanel>
            )}
            {session.capabilityType && (
              <GlassPanel padding="md">
                <DataCell label="Capability" value={session.capabilityType} mono />
              </GlassPanel>
            )}
            {session.quote?.total !== undefined && (
              <GlassPanel padding="md" glow="green">
                <DataCell label="Total Quote" value={`$${session.quote.total.toFixed(2)}`} mono />
              </GlassPanel>
            )}
          </div>

          {/* Parameters */}
          {session.parameters && Object.keys(session.parameters).length > 0 && (
            <GlassPanel padding="md">
              <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3">Parameters</h3>
              <div className="grid grid-cols-2 gap-3">
                {Object.entries(session.parameters).map(([key, value]) => (
                  <div key={key} className="flex items-center gap-2 text-xs">
                    <span className="text-white/30">{key}:</span>
                    <span className="text-white/70 font-mono">{String(value)}</span>
                  </div>
                ))}
              </div>
            </GlassPanel>
          )}

          {/* Quote */}
          {session.quote && (
            <GlassPanel padding="md">
              <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3">Price Quote</h3>
              <div className="space-y-3">
                {session.quote.basePrice !== undefined && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-white/40">Base Price</span>
                    <span className="font-mono text-white/70">${session.quote.basePrice.toFixed(2)}</span>
                  </div>
                )}
                {(session.quote.adjustments ?? []).map((adj, i) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span className="text-white/40">{adj.label}</span>
                    <span className={`font-mono ${adj.amount >= 0 ? "text-red-400/70" : "text-green-400/70"}`}>
                      {adj.amount >= 0 ? "+" : ""}${adj.amount.toFixed(2)}
                    </span>
                  </div>
                ))}
                <div className="border-t border-white/[0.06] pt-2 flex items-center justify-between text-xs">
                  <span className="text-white/60 font-medium">Total</span>
                  <span className="font-mono text-green-400 text-sm">
                    ${session.quote.total?.toFixed(2) ?? "0.00"}
                  </span>
                </div>
                <div className="flex gap-6 text-xs text-white/30 pt-1">
                  {session.quote.bond !== undefined && (
                    <span>Bond: <span className="font-mono text-white/50">${session.quote.bond.toFixed(2)}</span></span>
                  )}
                  {session.quote.challengeWindow && (
                    <span>Challenge Window: <span className="font-mono text-white/50">{session.quote.challengeWindow}</span></span>
                  )}
                </div>
              </div>
            </GlassPanel>
          )}

          {/* Contract Terms */}
          {session.contractTerms && (
            <GlassPanel padding="md">
              <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3">Contract Terms</h3>
              <div className="space-y-4">
                <div className="flex gap-6 text-xs text-white/40">
                  {session.contractTerms.deadline && (
                    <span>Deadline: <span className="font-mono text-white/60">{session.contractTerms.deadline}</span></span>
                  )}
                  {session.contractTerms.assuranceTier !== undefined && (
                    <span>Assurance Tier: <span className="font-mono text-white/60">T{session.contractTerms.assuranceTier}</span></span>
                  )}
                </div>

                {/* Milestones table */}
                {(session.contractTerms.milestones ?? []).length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-[10px] text-white/25 uppercase tracking-wider border-b border-white/[0.06]">
                          <th className="text-left pb-2">#</th>
                          <th className="text-left pb-2">Milestone</th>
                          <th className="text-right pb-2">Amount</th>
                          <th className="text-left pb-2">Evidence</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.04]">
                        {(session.contractTerms.milestones ?? []).map((ms, i) => (
                          <tr key={i}>
                            <td className="py-2 font-mono text-white/30">{i + 1}</td>
                            <td className="py-2 text-white/70">{ms.name}</td>
                            <td className="py-2 text-right font-mono text-white/60">${ms.amount.toFixed(2)}</td>
                            <td className="py-2 text-white/40">{ms.evidence}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </GlassPanel>
          )}

          {/* Audit Trail */}
          {(session.auditTrail ?? []).length > 0 && (
            <GlassPanel padding="md">
              <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3">Audit Trail</h3>
              <div className="relative pl-4 space-y-3">
                {/* Vertical line */}
                <div className="absolute left-1.5 top-2 bottom-2 w-px bg-white/[0.08]" />
                {(session.auditTrail ?? []).map((entry, i) => (
                  <div key={i} className="flex items-start gap-3 relative">
                    <div className="w-3 h-3 rounded-full flex-shrink-0 bg-white/[0.10] border border-white/[0.15] -ml-4 mt-0.5 z-10" />
                    <div className="flex-1">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-mono text-white/50">{entry.from}</span>
                        <span className="text-white/20">-&gt;</span>
                        <span className="font-mono text-green-400/70">{entry.to}</span>
                      </div>
                      <div className="text-[10px] text-white/20">{entry.timestamp}</div>
                      {entry.note && <div className="text-[10px] text-white/30 mt-0.5">{entry.note}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </GlassPanel>
          )}
        </div>
      )}
    </div>
  );
}
