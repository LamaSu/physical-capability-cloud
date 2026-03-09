import React from "react";
import { cn } from "../utils.js";

export interface ConfidenceIndicatorProps {
  value: number; // 0-1
  showLabel?: boolean;
  className?: string;
}

export function ConfidenceIndicator({ value, showLabel = true, className }: ConfidenceIndicatorProps) {
  const pct = Math.round(value * 100);
  const color = pct >= 80 ? "#7CB342" : pct >= 50 ? "#FFB300" : "#E53935";

  return (
    <div className={cn("inline-flex items-center gap-1.5", className)}>
      <div className="w-2 h-2 rounded-full" style={{ background: color, boxShadow: `0 0 4px ${color}60` }} />
      <div className="w-16 h-1 rounded-full bg-white/[0.06] overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      {showLabel && <span className="text-[10px] font-mono text-white/30">{pct}%</span>}
    </div>
  );
}
