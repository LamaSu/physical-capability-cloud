import React from "react";
import { useQuery } from "@tanstack/react-query";
import { GlassPanel, GlowBadge } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useOperatorStore } from "../stores/operator-store.js";
import { useAgentMe } from "../api/hooks/use-pcc-data.js";
import type { AgentMeDTO } from "../types/dto.js";
import { UnavailableState } from "../components/LiveState.js";
import { NotRecordedState } from "../components/operator/NotRecordedState.js";
import {
  decideApproval,
  emergencyResume,
  emergencyStop,
  listPendingApprovals,
  readStopState,
  type PendingApproval,
  type ResumeOutcome,
  type StopOutcome,
} from "../lib/operator-api.js";

/**
 * Operator dashboard.
 *
 * Identity, machines and in-flight work come from GET /api/agent/me for the
 * signed-in key. The emergency stop acts on the operator's own machines and
 * shows a machine as stopped only when the gateway confirmed it. Earnings,
 * certifications and maintenance have no real source yet, so they say so
 * instead of showing sample values.
 */

const tabs = ["overview", "approvals", "earnings", "certifications", "maintenance"] as const;

type Kernel = AgentMeDTO["kernels"]["items"][number];

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return "unknown";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function kernelLabel(k: Kernel): string {
  return k.name || k.id;
}

// ── Emergency stop ─────────────────────────────────────────────────────────

function EmergencyStopPanel({ kernels }: { kernels: Kernel[] }) {
  const ids = kernels.map((k) => k.id);
  const states = useQuery({
    queryKey: ["operator-stop-states", ids],
    queryFn: async () => Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await readStopState(id)] as const))),
    enabled: ids.length > 0,
    refetchInterval: 15_000,
  });
  const [outcomes, setOutcomes] = React.useState<Record<string, StopOutcome | ResumeOutcome>>({});
  const [busy, setBusy] = React.useState(false);

  async function stop(target: Kernel[]) {
    const names = target.map((k) => `• ${kernelLabel(k)}`).join("\n");
    if (!window.confirm(
      `EMERGENCY STOP\n\nPCC will refuse new work for:\n${names}\n\n` +
      "This does not stop a job that is already running and does not cut power. " +
      "Use each machine's own emergency stop for that.\n\nContinue?",
    )) return;
    setBusy(true);
    const results = await Promise.all(target.map((k) => emergencyStop(k.id)));
    setOutcomes((prev) => ({ ...prev, ...Object.fromEntries(results.map((r) => [r.kernelId, r])) }));
    setBusy(false);
    void states.refetch();
  }

  async function resume(k: Kernel) {
    if (!window.confirm(`Let PCC send new work to ${kernelLabel(k)} again?`)) return;
    setBusy(true);
    const r = await emergencyResume(k.id);
    setOutcomes((prev) => ({ ...prev, [r.kernelId]: r }));
    setBusy(false);
    void states.refetch();
  }

  const failed = Object.values(outcomes).filter((o) => o.state === "not_stopped");

  return (
    <div className="space-y-3" data-testid="estop-panel">
      <button
        onClick={() => void stop(kernels)}
        disabled={busy || kernels.length === 0}
        className="w-full rounded-lg border border-red-400/40 px-4 py-3 text-sm font-semibold text-red-400 hover:bg-red-400/10 transition-all disabled:opacity-40"
        style={{ background: "rgba(248, 113, 113, 0.05)" }}
      >
        {busy ? "Sending…" : kernels.length > 1 ? `EMERGENCY STOP: all ${kernels.length} of your machines` : "EMERGENCY STOP"}
      </button>
      <p className="text-[11px] text-white/35">
        Stops PCC from sending or accepting new work for your machines. It does not stop a job that is already running and
        does not cut power: use the machine's own emergency stop for that.
      </p>

      {failed.length > 0 && (
        <div role="alert" data-testid="estop-failed" className="rounded-lg border border-red-500/60 bg-red-500/10 px-4 py-3 space-y-1">
          <div className="text-sm font-bold text-red-300">NOT STOPPED</div>
          {failed.map((o) => (
            <div key={o.kernelId} className="text-xs text-red-200/80">
              {kernelLabel(kernels.find((k) => k.id === o.kernelId) ?? { id: o.kernelId, name: "", status: "", last_heartbeat: null })}:{" "}
              {"reason" in o ? o.reason : ""}
            </div>
          ))}
          <div className="text-xs font-semibold text-red-200">Use the machine's physical emergency stop now.</div>
        </div>
      )}

      <div className="space-y-2">
        {kernels.map((k) => {
          const recorded = states.data?.[k.id];
          const outcome = outcomes[k.id];
          let stateText: React.ReactNode = <span className="text-white/30">stop state unknown</span>;
          if (outcome?.state === "stopped") {
            stateText = <span className="text-red-300 font-semibold">Stopped for new work (confirmed by PCC)</span>;
          } else if (recorded?.ok && recorded.data.stopped) {
            stateText = <span className="text-red-300 font-semibold">Stopped for new work</span>;
          } else if (recorded?.ok) {
            stateText = <span className="text-white/45">{recorded.data.recorded ? "Taking work" : "No stop recorded"}</span>;
          } else if (recorded && !recorded.ok) {
            stateText = <span className="text-amber-300/80">Stop state unavailable</span>;
          }
          const stopped = outcome?.state === "stopped" || (recorded?.ok === true && recorded.data.stopped);
          return (
            <GlassPanel key={k.id} padding="sm" className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-white/70 truncate">{kernelLabel(k)}</div>
                <div className="text-[10px] text-white/30">
                  {k.status} · heartbeat {timeAgo(k.last_heartbeat)}
                </div>
                <div className="text-[11px] mt-0.5">{stateText}</div>
                {outcome?.state === "not_resumed" && (
                  <div className="text-[11px] text-amber-300/80">Not resumed: {outcome.reason}</div>
                )}
              </div>
              {stopped ? (
                <button
                  onClick={() => void resume(k)}
                  disabled={busy}
                  className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium border border-green-400/30 text-green-400 hover:bg-green-400/10 disabled:opacity-40"
                >
                  Resume
                </button>
              ) : (
                <button
                  onClick={() => void stop([k])}
                  disabled={busy}
                  className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium border border-red-400/30 text-red-400 hover:bg-red-400/10 disabled:opacity-40"
                >
                  Stop
                </button>
              )}
            </GlassPanel>
          );
        })}
      </div>
    </div>
  );
}

// ── Approvals ──────────────────────────────────────────────────────────────

function ApprovalsTab({ kernels }: { kernels: Kernel[] }) {
  const ids = kernels.map((k) => k.id);
  const approvals = useQuery({
    queryKey: ["operator-approvals", ids],
    queryFn: async () => {
      const r = await listPendingApprovals(ids);
      if (!r.ok) throw new Error(r.reason);
      return r.data;
    },
    enabled: ids.length > 0,
    refetchInterval: 10_000,
    retry: 1,
  });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState<string | null>(null);

  async function act(a: PendingApproval, action: "approve" | "reject") {
    setPending(a.id);
    const r = await decideApproval(a.id, action);
    setPending(null);
    if (r.ok) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[a.id];
        return next;
      });
      void approvals.refetch();
    } else {
      setErrors((prev) => ({ ...prev, [a.id]: r.reason }));
    }
  }

  if (ids.length === 0) {
    return <GlassPanel padding="lg" className="text-center text-sm text-white/40">No machines are registered to this key, so nothing can wait for your approval.</GlassPanel>;
  }
  if (approvals.isLoading) return <GlassPanel padding="lg" className="text-center text-xs text-white/30">Loading approvals…</GlassPanel>;
  if (approvals.isError || !approvals.data) {
    return (
      <GlassPanel padding="lg">
        <UnavailableState what="your pending approvals" error={approvals.error} onRetry={() => void approvals.refetch()} />
      </GlassPanel>
    );
  }
  if (approvals.data.length === 0) {
    return (
      <GlassPanel padding="lg" className="text-center">
        <div className="text-sm text-white/40">No approvals are waiting for your machines.</div>
      </GlassPanel>
    );
  }
  return (
    <div className="space-y-4">
      {approvals.data.map((a) => (
        <GlassPanel key={a.id} padding="md">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <GlowBadge color="cyan">{a.capabilityType ?? "unspecified work"}</GlowBadge>
                <span className="text-[10px] text-white/30">{timeAgo(a.createdAt)}</span>
              </div>
              <div className="text-xs text-white/40">
                Machine <span className="font-mono text-white/60">{kernelLabel(kernels.find((k) => k.id === a.kernelId) ?? { id: a.kernelId, name: "", status: "", last_heartbeat: null })}</span>
                {a.requestedBy && <> · requested by <span className="font-mono text-white/60">{a.requestedBy}</span></>}
              </div>
              {a.expiresAt && <div className="text-[10px] text-white/30">Expires {new Date(a.expiresAt).toLocaleString()}</div>}
              {errors[a.id] && <div role="alert" className="text-xs text-red-300">Not done: {errors[a.id]}</div>}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => void act(a, "approve")}
                disabled={pending === a.id}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-green-400/30 text-green-400 hover:bg-green-400/10 disabled:opacity-40"
              >
                Approve
              </button>
              <button
                onClick={() => void act(a, "reject")}
                disabled={pending === a.id}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-red-400/30 text-red-400 hover:bg-red-400/10 disabled:opacity-40"
              >
                Reject
              </button>
            </div>
          </div>
        </GlassPanel>
      ))}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export function OperatorDashboardPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const { activeTab, setActiveTab } = useOperatorStore();
  const me = useAgentMe();

  React.useEffect(() => {
    setPageMeta("Operator Dashboard", me.data?.identity.operator ?? "");
  }, [setPageMeta, me.data?.identity.operator]);

  const kernels = me.data && !me.data.kernels.unavailable ? me.data.kernels.items : null;

  return (
    <div className="space-y-6">
      <div className="flex gap-1 border-b border-white/[0.06] pb-1">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={`px-4 py-2 rounded-t-lg text-xs capitalize transition-all ${
              activeTab === t ? "bg-white/[0.04] text-green-400 border-b-2 border-green-400/30" : "text-white/30 hover:text-white/50"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {(activeTab === "overview" || activeTab === "approvals") && me.isLoading && (
        <GlassPanel padding="lg" className="text-center text-xs text-white/30">Loading your account…</GlassPanel>
      )}
      {(activeTab === "overview" || activeTab === "approvals") && (me.isError || (me.data && me.data.kernels.unavailable)) && (
        <GlassPanel padding="lg">
          <UnavailableState what="your machines" error={me.error ?? me.data?.kernels.unavailable} onRetry={() => void me.refetch()} />
        </GlassPanel>
      )}

      {activeTab === "overview" && kernels && me.data && (
        <div className="space-y-6">
          <EmergencyStopPanel kernels={kernels} />

          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <GlassPanel padding="md" className="text-center">
              <div className="text-[10px] text-white/30">Your machines</div>
              <div className="text-2xl font-mono text-white/70 mt-1">{me.data.kernels.count ?? kernels.length}</div>
            </GlassPanel>
            <GlassPanel padding="md" className="text-center">
              <div className="text-[10px] text-white/30">Jobs in flight</div>
              <div className="text-2xl font-mono text-white/70 mt-1">
                {me.data.work.unavailable ? "—" : me.data.work.in_flight}
              </div>
              <div className="text-[10px] text-white/25">pending, queued, in progress or paused</div>
            </GlassPanel>
            <GlassPanel padding="md" className="text-center">
              <div className="text-[10px] text-white/30">Earnings</div>
              <div className="text-sm text-white/45 mt-2">Not recorded yet</div>
              <div className="text-[10px] text-white/25">each job's payment state is on its job page</div>
            </GlassPanel>
          </div>

          {kernels.length === 0 && (
            <GlassPanel padding="lg" className="text-center space-y-1">
              <div className="text-sm text-white/50">No machines are registered to this key yet.</div>
              {me.data.next.map((n) => <div key={n} className="text-xs text-white/30">{n}</div>)}
            </GlassPanel>
          )}
        </div>
      )}

      {activeTab === "approvals" && kernels && <ApprovalsTab kernels={kernels} />}

      {activeTab === "earnings" && (
        <GlassPanel padding="lg">
          <NotRecordedState
            what="operator earnings history"
            detail="Escrow records carry no per-operator payout history yet. A job's own payment state (paid, refunded or pending) is shown on its job page, from the escrow record."
          />
        </GlassPanel>
      )}
      {activeTab === "certifications" && (
        <GlassPanel padding="lg">
          <NotRecordedState what="operator certifications" detail="There is no certification store yet." />
        </GlassPanel>
      )}
      {activeTab === "maintenance" && (
        <GlassPanel padding="lg">
          <NotRecordedState what="maintenance windows" detail="Nothing records maintenance events yet." />
        </GlassPanel>
      )}
    </div>
  );
}
