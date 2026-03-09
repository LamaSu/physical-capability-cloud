import React from "react";
import { cn } from "../utils.js";
import { GlassPanel } from "../primitives/GlassPanel.js";

export interface CapabilityTrend {
  type: string;
  label: string;
  demand: number; // 0-100
}

export interface CapabilityTrendBarsProps {
  trends: CapabilityTrend[];
  title?: string;
  className?: string;
}

export function CapabilityTrendBars({ trends, title = "Trending Capabilities", className }: CapabilityTrendBarsProps) {
  const sorted = [...trends].sort((a, b) => b.demand - a.demand);

  return (
    <GlassPanel padding="md" className={cn("space-y-3", className)}>
      <span className="text-xs font-medium text-white/50">{title}</span>
      <div className="space-y-2">
        {sorted.map((t) => {
          const color = t.demand > 70 ? "#7CB342" : t.demand > 40 ? "#C0CA33" : "#FFB300";
          return (
            <div key={t.type} className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-white/50">{t.label}</span>
                <span className="text-[10px] font-mono text-white/30">{t.demand}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-white/[0.04] overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${t.demand}%`, background: color, boxShadow: `0 0 6px ${color}40` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </GlassPanel>
  );
}
