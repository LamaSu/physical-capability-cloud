import React from "react";
import { cn } from "../utils.js";

export interface UtilizationGaugeProps {
  value: number; // 0-100
  size?: number;
  label?: string;
  className?: string;
}

export function UtilizationGauge({ value, size = 80, label, className }: UtilizationGaugeProps) {
  const strokeWidth = size * 0.08;
  const radius = (size - strokeWidth) / 2;
  const circumference = Math.PI * radius; // half circle
  const offset = circumference - (Math.min(value, 100) / 100) * circumference;

  // Green to gold gradient based on utilization
  const color = value > 85 ? "#FFB300" : value > 60 ? "#C0CA33" : "#7CB342";

  return (
    <div className={cn("inline-flex flex-col items-center", className)}>
      <svg width={size} height={size * 0.6} viewBox={`0 0 ${size} ${size * 0.6}`}>
        {/* Background arc */}
        <path
          d={`M ${strokeWidth / 2} ${size * 0.55} A ${radius} ${radius} 0 0 1 ${size - strokeWidth / 2} ${size * 0.55}`}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
        {/* Value arc */}
        <path
          d={`M ${strokeWidth / 2} ${size * 0.55} A ${radius} ${radius} 0 0 1 ${size - strokeWidth / 2} ${size * 0.55}`}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-all duration-700"
          style={{ filter: `drop-shadow(0 0 4px ${color}40)` }}
        />
      </svg>
      <span className="text-lg font-mono font-semibold text-white/80 -mt-2">{Math.round(value)}%</span>
      {label && <span className="text-[10px] text-white/25 mt-0.5">{label}</span>}
    </div>
  );
}
