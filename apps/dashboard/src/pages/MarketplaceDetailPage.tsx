import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import { GlassPanel, GlowBadge, PriceHistoryChart, UtilizationGauge } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { mockEquipmentClasses, mockMarketSnapshots, mockPriceHistory } from "../api/mock-onboarding-data.js";

export function MarketplaceDetailPage() {
  const { classId } = useParams<{ classId: string }>();
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  const ec = mockEquipmentClasses.find((e) => e.id === classId);
  const snap = mockMarketSnapshots.find((s) => s.equipmentClassId === classId);

  React.useEffect(() => {
    setPageMeta(ec?.name ?? "Equipment Class", "Market detail");
  }, [setPageMeta, ec]);

  if (!ec) {
    return (
      <div className="text-center py-12">
        <p className="text-white/30">Equipment class not found</p>
        <button onClick={() => navigate("/marketplace")} className="text-xs text-green-400/60 mt-2">
          &larr; Back to Marketplace
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <button onClick={() => navigate("/marketplace")} className="text-xs text-white/30 hover:text-white/50 transition-colors">
        &larr; Back to Marketplace
      </button>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white/90">{ec.name}</h2>
          <p className="text-sm text-white/40 mt-1">{ec.description}</p>
          <div className="flex items-center gap-2 mt-2">
            <GlowBadge color="green">{ec.category}</GlowBadge>
            {ec.subcategory && <span className="text-xs text-white/20">{ec.subcategory}</span>}
          </div>
        </div>
        {snap && <UtilizationGauge value={snap.averageUtilization} label="Network Util." />}
      </div>

      {/* Stats */}
      {snap && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "Network Machines", value: snap.networkMachineCount.toString() },
            { label: "Avg Job Value", value: `$${snap.averageJobValue}` },
            { label: "Queue Depth", value: snap.queueDepthAverage.toFixed(1) },
            { label: "Trend", value: `${snap.trendDirection === "up" ? "+" : ""}${snap.trendPercent}%` },
          ].map((s) => (
            <GlassPanel key={s.label} padding="md" className="text-center">
              <div className="text-[10px] text-white/20">{s.label}</div>
              <div className="text-lg font-mono text-white/70 mt-1">{s.value}</div>
            </GlassPanel>
          ))}
        </div>
      )}

      {/* Price History */}
      <PriceHistoryChart data={mockPriceHistory} currentPrice={parseFloat(snap?.averageJobValue ?? "0")} />

      {/* Materials & Tolerances */}
      <div className="grid grid-cols-2 gap-4">
        <GlassPanel padding="md" className="space-y-2">
          <span className="text-xs font-medium text-white/50">Common Materials</span>
          <div className="flex flex-wrap gap-1">
            {(ec.commonMaterials ?? []).map((m: any) => (
              <span key={m} className="text-[10px] px-2 py-0.5 rounded bg-white/[0.04] border border-white/[0.06] text-white/30">
                {m}
              </span>
            ))}
          </div>
        </GlassPanel>
        <GlassPanel padding="md" className="space-y-2">
          <span className="text-xs font-medium text-white/50">Typical Tolerances</span>
          <div className="space-y-1">
            {(ec.typicalTolerances ?? []).map((t: any) => (
              <div key={t} className="text-xs text-white/40 font-mono">{t}</div>
            ))}
          </div>
        </GlassPanel>
      </div>

      {/* CTA */}
      <div className="text-center">
        <button
          onClick={() => navigate("/onboard/wizard")}
          className="px-6 py-2.5 rounded-lg text-sm font-medium bg-green-500/20 border border-green-500/30 text-green-400 hover:bg-green-500/30 transition-all"
        >
          Register a {ec.name} &rarr;
        </button>
      </div>
    </div>
  );
}
