import React from "react";
import { cn } from "../utils.js";
import { GlassPanel } from "../primitives/GlassPanel.js";

export interface MarketRateCardProps {
  yourRate: number;
  networkAvg: number;
  networkLow: number;
  networkHigh: number;
  currency?: string;
  demandLevel: "high" | "medium" | "low";
  onApplyRate?: (rate: number) => void;
  className?: string;
}

const demandColors = {
  high: { bg: "bg-green-500/10", text: "text-green-400", label: "High Demand" },
  medium: { bg: "bg-yellow-500/10", text: "text-yellow-400", label: "Moderate" },
  low: { bg: "bg-white/[0.04]", text: "text-white/40", label: "Low Demand" },
};

export function MarketRateCard({
  yourRate,
  networkAvg,
  networkLow,
  networkHigh,
  currency = "USDC",
  demandLevel,
  onApplyRate,
  className,
}: MarketRateCardProps) {
  const demand = demandColors[demandLevel];
  const range = networkHigh - networkLow || 1;
  const yourPct = Math.max(0, Math.min(100, ((yourRate - networkLow) / range) * 100));
  const avgPct = Math.max(0, Math.min(100, ((networkAvg - networkLow) / range) * 100));

  return (
    <GlassPanel padding="md" className={cn("space-y-4", className)}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-white/50">Market Pricing</span>
        <span className={cn("text-[10px] px-2 py-0.5 rounded-full", demand.bg, demand.text)}>
          {demand.label}
        </span>
      </div>

      {/* Rate bar */}
      <div className="space-y-2">
        <div className="relative h-2 rounded-full bg-white/[0.04]">
          {/* Network average marker */}
          <div className="absolute top-0 h-full w-0.5 bg-white/20" style={{ left: `${avgPct}%` }} />
          {/* Your rate marker */}
          <div
            className="absolute top-[-2px] w-3 h-3 rounded-full bg-green-500 border-2 border-forest-900 shadow-[0_0_6px_rgba(124,179,66,0.4)]"
            style={{ left: `${yourPct}%`, transform: "translateX(-50%)" }}
          />
        </div>
        <div className="flex justify-between text-[10px] font-mono text-white/20">
          <span>${networkLow.toFixed(2)}</span>
          <span>${networkHigh.toFixed(2)}</span>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-[10px] text-white/20">Your Rate</div>
          <div className="text-sm font-mono text-green-400">${yourRate.toFixed(2)}</div>
        </div>
        <div>
          <div className="text-[10px] text-white/20">Network Avg</div>
          <div className="text-sm font-mono text-white/50">${networkAvg.toFixed(2)}</div>
        </div>
        <div>
          <div className="text-[10px] text-white/20">Currency</div>
          <div className="text-sm font-mono text-white/50">{currency}</div>
        </div>
      </div>

      {onApplyRate && (
        <button
          onClick={() => onApplyRate(networkAvg)}
          className="w-full px-3 py-2 rounded-lg text-xs font-medium bg-green-500/10 border border-green-500/20 text-green-400/70 hover:bg-green-500/20 transition-all"
        >
          Apply Network Average
        </button>
      )}
    </GlassPanel>
  );
}
