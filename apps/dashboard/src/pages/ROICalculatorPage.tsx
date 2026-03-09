import React from "react";
import { useNavigate } from "react-router-dom";
import { GlassPanel, ROIProjectionChart } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useMarketplaceStore } from "../stores/marketplace-store.js";
import { generateROIProjection } from "../api/mock-onboarding-data.js";

const baseInput = "w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/70 focus:border-green-500/30 focus:outline-none transition-colors";

export function ROICalculatorPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const { roiInputs, updateROIInput } = useMarketplaceStore();

  React.useEffect(() => {
    setPageMeta("ROI Calculator", "Project your return on investment");
  }, [setPageMeta]);

  const roiData = generateROIProjection(roiInputs.monthlyCost, roiInputs.avgJobValue, roiInputs.estimatedUtilization);
  const breakEven = roiData.find((d) => d.netPosition >= 0)?.month;
  const totalProfit24 = roiData[roiData.length - 1]?.netPosition ?? 0;

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <button onClick={() => navigate("/marketplace")} className="text-xs text-white/30 hover:text-white/50 transition-colors">
        &larr; Back to Marketplace
      </button>

      {/* Inputs */}
      <GlassPanel padding="lg" className="space-y-4">
        <span className="text-xs font-medium text-white/50">Investment Parameters</span>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-[10px] text-white/30 mb-1 block">Equipment Cost ($)</label>
            <input
              className={baseInput}
              type="number"
              value={roiInputs.equipmentCost}
              onChange={(e) => updateROIInput("equipmentCost", +e.target.value)}
            />
          </div>
          <div>
            <label className="text-[10px] text-white/30 mb-1 block">Monthly Costs ($)</label>
            <input
              className={baseInput}
              type="number"
              value={roiInputs.monthlyCost}
              onChange={(e) => updateROIInput("monthlyCost", +e.target.value)}
            />
          </div>
          <div>
            <label className="text-[10px] text-white/30 mb-1 block">Avg Job Value ($)</label>
            <input
              className={baseInput}
              type="number"
              value={roiInputs.avgJobValue}
              onChange={(e) => updateROIInput("avgJobValue", +e.target.value)}
            />
          </div>
          <div>
            <label className="text-[10px] text-white/30 mb-1 block">Est. Utilization (%)</label>
            <input
              className={baseInput}
              type="number"
              min={0}
              max={100}
              value={roiInputs.estimatedUtilization}
              onChange={(e) => updateROIInput("estimatedUtilization", +e.target.value)}
            />
          </div>
        </div>
      </GlassPanel>

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-4">
        <GlassPanel padding="md" glow={breakEven != null && breakEven <= 12 ? "green" : "none"} className="text-center">
          <div className="text-[10px] text-white/20">Break-Even</div>
          <div className="text-lg font-mono text-green-400 mt-1">
            {breakEven != null ? `Month ${breakEven}` : "N/A"}
          </div>
        </GlassPanel>
        <GlassPanel padding="md" className="text-center">
          <div className="text-[10px] text-white/20">24-Month Profit</div>
          <div className={`text-lg font-mono mt-1 ${totalProfit24 >= 0 ? "text-green-400" : "text-red-400"}`}>
            ${totalProfit24.toLocaleString()}
          </div>
        </GlassPanel>
        <GlassPanel padding="md" className="text-center">
          <div className="text-[10px] text-white/20">Monthly Revenue</div>
          <div className="text-lg font-mono text-white/60 mt-1">
            ${Math.round(roiInputs.avgJobValue * (roiInputs.estimatedUtilization / 100) * 30 * 0.7).toLocaleString()}
          </div>
        </GlassPanel>
      </div>

      {/* Chart */}
      <ROIProjectionChart data={roiData} breakEvenMonth={breakEven} />
    </div>
  );
}
