import React from "react";
import { useNavigate } from "react-router-dom";
import {
  GlassPanel, GlowBadge,
  DemandSupplyChart, GeoDemandMap, CapabilityTrendBars, PriceHistoryChart,
} from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useMarketplaceStore } from "../stores/marketplace-store.js";
import {
  mockEquipmentClasses, mockMarketSnapshots,
  mockDemandSupplyTimeline, mockGeoMarkers,
  mockCapabilityTrends, mockPriceHistory,
} from "../api/mock-onboarding-data.js";

const demandColors = { high: "green" as const, medium: "gold" as const, low: "gray" as const };

export function MarketplacePage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const { selectedCategory, demandFilter, setCategory, setDemandFilter } = useMarketplaceStore();

  React.useEffect(() => {
    setPageMeta("Equipment Marketplace", "Demand, supply, and pricing insights");
  }, [setPageMeta]);

  const filtered = mockEquipmentClasses.filter((ec) => {
    if (selectedCategory !== "all" && ec.category !== selectedCategory) return false;
    if (demandFilter !== "all") {
      const snap = mockMarketSnapshots.find((s) => s.equipmentClassId === ec.id);
      if (snap && snap.demandLevel !== demandFilter) return false;
    }
    return true;
  });

  const categories = ["all", ...new Set(mockEquipmentClasses.map((ec) => ec.category))];

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        {categories.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c as typeof selectedCategory)}
            className={`px-3 py-1 rounded-lg text-xs transition-all ${
              selectedCategory === c
                ? "bg-green-500/15 border border-green-500/20 text-green-400"
                : "text-white/30 hover:text-white/50"
            }`}
          >
            {c === "all" ? "All" : c}
          </button>
        ))}
        <div className="ml-auto flex gap-1">
          {(["all", "high", "medium", "low"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setDemandFilter(f)}
              className={`px-2 py-0.5 rounded text-[10px] font-mono ${
                demandFilter === f ? "bg-white/[0.06] text-white/50" : "text-white/20"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <DemandSupplyChart data={mockDemandSupplyTimeline} />
        <GeoDemandMap markers={mockGeoMarkers} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <CapabilityTrendBars trends={mockCapabilityTrends} />
        <PriceHistoryChart data={mockPriceHistory} currentPrice={28.5} />
      </div>

      {/* Equipment class cards */}
      <div className="space-y-2">
        <span className="text-xs text-white/30">Equipment Classes ({filtered.length})</span>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((ec) => {
            const snap = mockMarketSnapshots.find((s) => s.equipmentClassId === ec.id);
            return (
              <GlassPanel
                key={ec.id}
                hover
                padding="md"
                className="space-y-2 cursor-pointer"
                onClick={() => navigate(`/marketplace/${ec.id}`)}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-white/70">{ec.name}</span>
                  {snap && <GlowBadge color={(demandColors as any)[snap.demandLevel] ?? "gray"}>{snap.demandLevel}</GlowBadge>}
                </div>
                <p className="text-xs text-white/30">{ec.description}</p>
                {snap && (
                  <div className="grid grid-cols-3 gap-2 pt-1 text-center">
                    <div>
                      <div className="text-[10px] text-white/20">Machines</div>
                      <div className="text-xs font-mono text-white/50">{snap.networkMachineCount}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-white/20">Util.</div>
                      <div className="text-xs font-mono text-white/50">{snap.averageUtilization}%</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-white/20">Avg Job</div>
                      <div className="text-xs font-mono text-green-400">${snap.averageJobValue}</div>
                    </div>
                  </div>
                )}
              </GlassPanel>
            );
          })}
        </div>
      </div>

      {/* ROI link */}
      <div className="text-center">
        <button
          onClick={() => navigate("/marketplace/roi")}
          className="px-4 py-2 rounded-lg text-xs font-medium bg-green-500/10 border border-green-500/20 text-green-400/70 hover:bg-green-500/20 transition-all"
        >
          ROI Calculator &rarr;
        </button>
      </div>
    </div>
  );
}
