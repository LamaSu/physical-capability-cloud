import React from "react";
import { useNavigate } from "react-router-dom";
import {
  GlassPanel, GlowBadge, UtilizationGauge,
  EarningsChart, CertificationBadge, MaintenanceTimelineItem,
} from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useOperatorStore } from "../stores/operator-store.js";
import {
  mockOperatorProfile, mockEarningsData, mockMaintenanceEvents, mockCertifications,
} from "../api/mock-onboarding-data.js";

const tabs = ["overview", "earnings", "certifications", "maintenance"] as const;

export function OperatorDashboardPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const { activeTab, setActiveTab, earningsPeriod, setEarningsPeriod } = useOperatorStore();

  React.useEffect(() => {
    setPageMeta("Operator Dashboard", mockOperatorProfile.displayName);
  }, [setPageMeta]);

  const totalEarnings = mockEarningsData[mockEarningsData.length - 1]?.cumulative ?? 0;

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
