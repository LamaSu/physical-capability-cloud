import React from "react";
import { cn } from "../utils.js";

export interface DemandHeatmapCellProps {
  label: string;
  intensity: number; // 0-1
  value?: string;
  onClick?: () => void;
  className?: string;
}

export function DemandHeatmapCell({ label, intensity, value, onClick, className }: DemandHeatmapCellProps) {
  const green = Math.round(124 + (179 - 124) * (1 - intensity));
  const r = Math.round(124 * (1 - intensity) + 255 * intensity);
  const g = Math.round(179 * (1 - intensity) + 179 * intensity);
  const b = Math.round(66 * (1 - intensity));
  const bg = `rgba(${r}, ${g}, ${b}, ${0.05 + intensity * 0.15})`;
  const border = `rgba(${r}, ${g}, ${b}, ${0.1 + intensity * 0.2})`;

  return (
    <div
      onClick={onClick}
      className={cn(
        "rounded-lg p-3 text-center transition-all",
        onClick && "cursor-pointer hover:scale-[1.02]",
        className,
      )}
      style={{ background: bg, border: `1px solid ${border}` }}
    >
      <div className="text-xs text-white/50 truncate">{label}</div>
      {value && <div className="text-sm font-mono text-white/70 mt-0.5">{value}</div>}
    </div>
  );
}
