import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import { GlassPanel, GlowBadge, UtilizationGauge, EarningsChart, MaintenanceTimelineItem } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useOperatorStore } from "../stores/operator-store.js";
import { mockEarningsData, mockMaintenanceEvents } from "../api/mock-onboarding-data.js";
import { DiscoverabilityPanel } from "../components/operator/DiscoverabilityPanel.js";
import { RatingsPanel } from "../components/operator/RatingsPanel.js";
import { RateSubmitForm } from "../components/operator/RateSubmitForm.js";
import { EditDeleteBar } from "../components/operator/EditDeleteBar.js";

const machines: Record<string, { name: string; type: string; manufacturer: string; model: string; utilization: number; jobsCompleted: number; uptime: number }> = {
  "reg-001": { name: "Prusa MK4 Workshop", type: "fdm", manufacturer: "Prusa Research", model: "MK4", utilization: 72, jobsCompleted: 98, uptime: 99.2 },
  "reg-002": { name: "Epilog Fusion Pro", type: "laser-cut", manufacturer: "Epilog", model: "Fusion Pro 32", utilization: 58, jobsCompleted: 44, uptime: 97.8 },
};

export function OperatorMachineDetailPage() {
  const { machineId } = useParams<{ machineId: string }>();
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const { earningsPeriod, setEarningsPeriod } = useOperatorStore();

  const machine = machineId ? machines[machineId] : undefined;

  React.useEffect(() => {
    setPageMeta(machine?.name ?? "Machine Detail", "Machine management");
  }, [setPageMeta, machine]);

  if (!machine) {
    return (
      <div className="text-center py-12">
        <p className="text-white/30">Machine not found</p>
        <button onClick={() => navigate("/operator")} className="text-xs text-green-400/60 mt-2">&larr; Back</button>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <button onClick={() => navigate("/operator")} className="text-xs text-white/30 hover:text-white/50 transition-colors">
        &larr; Back to Operator Dashboard
      </button>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold text-white/90">{machine.name}</h2>
            <GlowBadge color="green">{machine.type}</GlowBadge>
          </div>
          <p className="text-sm text-white/40 mt-1">{machine.manufacturer} {machine.model}</p>
        </div>
        <UtilizationGauge value={machine.utilization} label="Utilization" />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <GlassPanel padding="md" className="text-center">
          <div className="text-[10px] text-white/20">Jobs Completed</div>
          <div className="text-lg font-mono text-white/60 mt-1">{machine.jobsCompleted}</div>
        </GlassPanel>
        <GlassPanel padding="md" className="text-center">
          <div className="text-[10px] text-white/20">Uptime</div>
          <div className="text-lg font-mono text-green-400 mt-1">{machine.uptime}%</div>
        </GlassPanel>
        <GlassPanel padding="md" className="text-center">
          <div className="text-[10px] text-white/20">Utilization</div>
          <div className="text-lg font-mono text-white/60 mt-1">{machine.utilization}%</div>
        </GlassPanel>
      </div>

      {/* T2.4 + T2.7 — discoverability + ratings (real API) */}
      {machineId && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <DiscoverabilityPanel operatorId={machineId} />
          <RatingsPanel operatorId={machineId} />
        </div>
      )}

      {/* T2.7 rate-submit + T2.2 edit/delete (real API, auth-gated) */}
      {machineId && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <RateSubmitForm operatorId={machineId} />
          <EditDeleteBar
            operatorId={machineId}
            initialDescription={`${machine.manufacturer} ${machine.model}`}
          />
        </div>
      )}

      {/* Earnings */}
      <EarningsChart
        data={mockEarningsData}
        period={earningsPeriod}
        onPeriodChange={setEarningsPeriod}
        totalEarnings={mockEarningsData[mockEarningsData.length - 1]?.cumulative}
      />

      {/* Maintenance */}
      <div className="space-y-2">
        <span className="text-xs text-white/30">Maintenance Timeline</span>
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
      </div>
    </div>
  );
}
