import React from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  GlassPanel, GlowBadge, UtilizationGauge,
  EarningsChart, CertificationBadge, MaintenanceTimelineItem,
  AmountDisplay,
} from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useOperatorStore } from "../stores/operator-store.js";
import { useAuthStore } from "../stores/auth-store.js";
import { authorizedFetch } from "../lib/authorized-fetch.js";
import { emergencyResume, emergencyStop, kernelsOf, machineLabel, type OperatorMachine } from "../lib/operator-api.js";
import { InboxPanel } from "../components/inbox/InboxPanel.js";
import {
  mockOperatorProfile, mockEarningsData, mockMaintenanceEvents, mockCertifications,
} from "../api/mock-onboarding-data.js";

const tabs = ["inbox", "overview", "approvals", "earnings", "certifications", "maintenance"] as const;

function EmergencyStopPanel({ kernels, loading }: { kernels: OperatorMachine[] | null; loading: boolean }) {
  const [outcomes, setOutcomes] = React.useState<Record<string, {
    stopped: boolean;
    pending: "stop" | "resume" | null;
    error: string | null;
  }>>({});
  const [busy, setBusy] = React.useState(false);
  const inFlight = React.useRef(false);

  async function stop(targets: OperatorMachine[]) {
    if (inFlight.current) return;
    const names = targets.map(machineLabel).join(", ");
    if (!window.confirm(`EMERGENCY STOP for ${names}: PCC will refuse new work and cancel queued commands. Work already running stops only with the machine's own emergency stop. Continue?`)) return;
    inFlight.current = true;
    setBusy(true);
    setOutcomes((prev) => ({
      ...prev,
      ...Object.fromEntries(targets.map((machine) => [machine.id, { stopped: prev[machine.id]?.stopped === true, pending: "stop", error: null }])),
    }));
    await Promise.all(targets.map(async (machine) => {
      const result = await emergencyStop(machine);
      setOutcomes((prev) => ({ ...prev, [machine.id]: { stopped: result.ok || prev[machine.id]?.stopped === true, pending: null, error: result.error } }));
    }));
    inFlight.current = false;
    setBusy(false);
  }

  async function resume(machine: OperatorMachine) {
    if (inFlight.current || !window.confirm(`Resume operations on ${machineLabel(machine)}?`)) return;
    inFlight.current = true;
    setBusy(true);
    setOutcomes((prev) => ({ ...prev, [machine.id]: { stopped: true, pending: "resume", error: null } }));
    const result = await emergencyResume(machine);
    setOutcomes((prev) => ({ ...prev, [machine.id]: { stopped: !result.ok, pending: null, error: result.error } }));
    inFlight.current = false;
    setBusy(false);
  }

  if (loading) {
    return <p role="status" className="text-sm text-white/50">Loading your machines. Use each machine's physical emergency stop.</p>;
  }
  if (kernels === null) {
    return <p role="alert" className="text-sm text-red-400">Your machines can't be read right now. Use each machine's physical emergency stop.</p>;
  }
  if (kernels.length === 0) {
    return <p className="text-sm text-white/50">No machines are registered to this key yet.</p>;
  }

  return (
    <div className="space-y-3">
      {kernels.length > 1 && (
        <button
          onClick={() => void stop(kernels)}
          disabled={busy}
          className="w-full rounded-lg border border-red-400/40 px-4 py-3 text-sm font-medium text-red-400 hover:bg-red-400/10 disabled:opacity-40"
        >
          EMERGENCY STOP: all of your machines
        </button>
      )}
      {kernels.map((machine) => {
        const label = machineLabel(machine);
        const outcome = outcomes[machine.id];
        return (
          <section key={machine.id} aria-label={`Emergency controls for ${label}`} className="rounded-lg border border-red-400/30 px-4 py-3 space-y-2">
            <div className="text-sm font-medium text-white/70">{label}</div>
            {outcome?.stopped ? (
              <span className="text-sm text-red-400 font-medium">
                EMERGENCY STOP ACTIVE for {label}: new work is refused and queued commands are cancelled. Work already running stops only with the machine's own emergency stop.
              </span>
            ) : (
              <p className="text-xs text-white/50">
                No stop confirmed for {label}. A confirmed stop makes PCC refuse new work and cancel queued commands. Work already running stops only with the machine's physical emergency stop.
              </p>
            )}
            <button
              onClick={() => void (outcome?.stopped ? resume(machine) : stop([machine]))}
              disabled={busy}
              className="rounded-lg border border-red-400/30 px-3 py-2 text-xs font-medium text-red-400 hover:bg-red-400/10 disabled:opacity-40"
            >
              {outcome?.pending === "stop" ? `Stopping ${label}...`
                : outcome?.pending === "resume" ? `Resuming ${label}...`
                  : outcome?.stopped ? `Resume Operations: ${label}` : `EMERGENCY STOP: ${label}`}
            </button>
            {outcome?.error && <p role="alert" className="text-sm text-red-400">{outcome.error}</p>}
          </section>
        );
      })}
    </div>
  );
}

/* ---------- Approval types ---------- */
interface Approval {
  id: string;
  agentId: string;
  capabilityType: string;
  estimatedCost: number;
  submittedAt: string;
  status: "pending" | "approved" | "rejected";
}

/* ---------- Time-ago helper ---------- */
function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function OperatorDashboardPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const { activeTab, setActiveTab, earningsPeriod, setEarningsPeriod } = useOperatorStore();

  React.useEffect(() => {
    setPageMeta("Operator Dashboard", mockOperatorProfile.displayName);
  }, [setPageMeta]);

  const totalEarnings = mockEarningsData[mockEarningsData.length - 1]?.cumulative ?? 0;

  const keyEpoch = useAuthStore((state) => state.keyEpoch);
  const sessionEpoch = useAuthStore((state) => state.sessionEpoch);
  const address = useAuthStore((state) => state.address);
  const identity = JSON.stringify([keyEpoch, sessionEpoch, address]);
  const machines = useQuery({
    queryKey: ["operator-machines", keyEpoch, sessionEpoch, address],
    queryFn: async ({ signal }) => {
      const res = await authorizedFetch("/api/agent/me", { cache: "no-store", signal });
      if (!res.ok) throw new Error("Machines unavailable");
      const kernels = kernelsOf(await res.json());
      if (kernels === null) throw new Error("Machines unavailable");
      return kernels;
    },
    enabled: activeTab === "overview",
    retry: false,
  });

  /* ---------- Approvals state ---------- */
  const [approvals, setApprovals] = React.useState<Approval[]>([]);
  const [approvalsLoading, setApprovalsLoading] = React.useState(false);
  const [approvalsError, setApprovalsError] = React.useState<string | null>(null);

  const fetchApprovals = React.useCallback(async () => {
    setApprovalsLoading(true);
    setApprovalsError(null);
    try {
      const res = await authorizedFetch("/api/operator/approvals?status=pending");
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = await res.json();
      setApprovals(data.approvals ?? []);
    } catch (err) {
      setApprovalsError(err instanceof Error ? err.message : "Failed to fetch approvals");
    } finally {
      setApprovalsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (activeTab !== "approvals") return;
    fetchApprovals();
    const interval = setInterval(fetchApprovals, 10_000);
    return () => clearInterval(interval);
  }, [activeTab, fetchApprovals]);

  async function handleApprovalAction(id: string, action: "approve" | "reject") {
    try {
      await authorizedFetch(`/api/operator/approvals/${id}/${action}`, {
        method: "POST",
      });
      setApprovals((prev) => prev.filter((a) => a.id !== id));
    } catch {
      // silently fail — next auto-refresh will reconcile
    }
  }

  return (
    <div className="space-y-6">
      {/* Tab bar */}
      <div className="flex gap-1 border-b border-white/[0.06] pb-1">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={`px-4 py-2 rounded-t-lg text-xs capitalize transition-all ${
              activeTab === t
                ? "bg-white/[0.04] text-green-400 border-b-2 border-green-400/30"
                : "text-white/30 hover:text-white/50"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {activeTab === "inbox" && <InboxPanel />}

      {/* Keep confirmed outcomes across tabs; a different identity gets a fresh panel. */}
      <div hidden={activeTab !== "overview"}>
        <EmergencyStopPanel key={identity} kernels={machines.isError ? null : machines.data ?? null} loading={machines.isPending} />
      </div>

      {/* Overview Tab */}
      {activeTab === "overview" && (
        <div className="space-y-6">
          {/* KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <GlassPanel padding="md" glow="green" className="text-center">
              <div className="text-[10px] text-white/20">Active Machines</div>
              <div className="text-2xl font-mono text-green-400 mt-1">2</div>
            </GlassPanel>
            <GlassPanel padding="md" className="text-center">
              <div className="text-[10px] text-white/20">Total Earnings</div>
              <div className="text-2xl font-mono text-white/70 mt-1">${totalEarnings}</div>
            </GlassPanel>
            <GlassPanel padding="md" className="text-center">
              <div className="text-[10px] text-white/20">Jobs Completed</div>
              <div className="text-2xl font-mono text-white/70 mt-1">142</div>
            </GlassPanel>
            <GlassPanel padding="md" className="text-center">
              <div className="text-[10px] text-white/20">Reputation</div>
              <div className="text-2xl font-mono text-yellow-400 mt-1">950</div>
            </GlassPanel>
          </div>

          {/* Machines */}
          <div className="space-y-2">
            <span className="text-xs text-white/30">Your Machines</span>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[
                { id: "reg-001", name: "Prusa MK4 Workshop", type: "fdm", utilization: 72, status: "active" },
                { id: "reg-002", name: "Epilog Fusion Pro", type: "laser-cut", utilization: 58, status: "active" },
              ].map((m) => (
                <GlassPanel
                  key={m.id}
                  hover
                  padding="md"
                  className="flex items-center justify-between cursor-pointer"
                  onClick={() => navigate(`/operator/${m.id}`)}
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-white/70">{m.name}</span>
                      <GlowBadge color="green">{m.type}</GlowBadge>
                    </div>
                    <span className="text-[10px] text-white/20">{m.status}</span>
                  </div>
                  <UtilizationGauge value={m.utilization} size={50} />
                </GlassPanel>
              ))}
            </div>
          </div>

          {/* IP Revenue summary card */}
          <div className="space-y-2">
            <span className="text-xs text-white/30">Story Protocol IP Revenue</span>
            <GlassPanel
              hover
              padding="md"
              glow="green"
              className="cursor-pointer"
              onClick={() => navigate("/ip")}
            >
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <div className="text-sm font-medium text-white/80">IP Revenue Dashboard</div>
                  <div className="text-xs text-white/40">3 IP assets &middot; 43 derivatives</div>
                  <div className="flex items-center gap-3 mt-2">
                    <div>
                      <div className="text-[10px] text-white/25">Total Revenue</div>
                      <AmountDisplay amount="6,119.50" currency="USD" size="sm" />
                    </div>
                    <div>
                      <div className="text-[10px] text-white/25">Unclaimed</div>
                      <div className="text-sm font-mono text-yellow-400/80">$429.50</div>
                    </div>
                  </div>
                </div>
                <div className="text-white/20 text-2xl leading-none">›</div>
              </div>
            </GlassPanel>
          </div>
        </div>
      )}

      {/* Approvals Tab */}
      {activeTab === "approvals" && (
        <div className="space-y-6">
          <span className="text-xs text-white/30">Pending Approvals</span>

          {approvalsLoading && approvals.length === 0 && (
            <GlassPanel padding="lg" className="text-center">
              <span className="text-xs text-white/30">Loading approvals...</span>
            </GlassPanel>
          )}

          {approvalsError && (
            <GlassPanel padding="md">
              <span className="text-xs text-red-400">Error: {approvalsError}</span>
            </GlassPanel>
          )}

          {!approvalsLoading && !approvalsError && approvals.length === 0 && (
            <GlassPanel padding="lg" className="text-center">
              <div className="text-sm text-white/30">No pending approvals.</div>
              <div className="text-xs text-white/20 mt-1">
                Jobs will appear here when agents request access.
              </div>
            </GlassPanel>
          )}

          <div className="space-y-4">
            {approvals.map((a) => (
              <GlassPanel key={a.id} padding="md">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-2 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <GlowBadge color="cyan">{a.capabilityType}</GlowBadge>
                      <span className="text-[10px] text-white/20">{timeAgo(a.submittedAt)}</span>
                    </div>
                    <div className="flex items-center gap-4 text-xs">
                      <span className="text-white/30">
                        Agent{" "}
                        <span className="font-mono text-white/50">
                          {a.agentId.length > 12 ? `${a.agentId.slice(0, 6)}...${a.agentId.slice(-4)}` : a.agentId}
                        </span>
                      </span>
                      <span className="text-white/30">
                        Est. cost{" "}
                        <span className="font-mono text-yellow-400/70">${a.estimatedCost.toFixed(2)}</span>
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => handleApprovalAction(a.id, "approve")}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium border border-green-400/30 text-green-400 hover:bg-green-400/10 transition-all"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => handleApprovalAction(a.id, "reject")}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium border border-red-400/30 text-red-400 hover:bg-red-400/10 transition-all"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              </GlassPanel>
            ))}
          </div>
        </div>
      )}

      {/* Earnings Tab */}
      {activeTab === "earnings" && (
        <EarningsChart
          data={mockEarningsData}
          period={earningsPeriod}
          onPeriodChange={setEarningsPeriod}
          totalEarnings={totalEarnings}
        />
      )}

      {/* Certifications Tab */}
      {activeTab === "certifications" && (
        <div className="space-y-2 max-w-lg">
          {mockCertifications.map((c) => (
            <CertificationBadge
              key={c.id}
              name={c.name}
              issuer={c.issuer}
              expiresAt={c.expiresAt}
              status={c.status}
            />
          ))}
        </div>
      )}

      {/* Maintenance Tab */}
      {activeTab === "maintenance" && (
        <div className="max-w-lg">
          {mockMaintenanceEvents.map((e) => (
            <MaintenanceTimelineItem
              key={e.id}
              description={e.description}
              type={e.type}
              scheduledAt={e.scheduledAt}
              completedAt={e.completedAt}
              status={e.status}
            />
          ))}
        </div>
      )}
    </div>
  );
}
