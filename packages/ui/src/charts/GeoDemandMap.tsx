import React from "react";
import { cn } from "../utils.js";
import { GlassPanel } from "../primitives/GlassPanel.js";

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  label: string;
  demand: number; // 0-1
  supplyStatus: "surplus" | "balanced" | "deficit";
}

export interface GeoDemandMapProps {
  markers: MapMarker[];
  title?: string;
  className?: string;
}

const supplyColors = {
  surplus: "#7CB342",
  balanced: "#FFB300",
  deficit: "#E53935",
};

// Simple projection for US-centric view
function project(lat: number, lng: number, width: number, height: number): { x: number; y: number } {
  const x = ((lng + 130) / 65) * width;
  const y = ((50 - lat) / 25) * height;
  return { x: Math.max(10, Math.min(width - 10, x)), y: Math.max(10, Math.min(height - 10, y)) };
}

export function GeoDemandMap({ markers, title = "Network Demand", className }: GeoDemandMapProps) {
  const W = 400;
  const H = 200;

  return (
    <GlassPanel padding="md" className={cn("space-y-3", className)}>
      <span className="text-xs font-medium text-white/50">{title}</span>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-lg bg-white/[0.01]">
        {/* Simple outline dots for context */}
        <rect x={0} y={0} width={W} height={H} fill="none" />

        {markers.map((m) => {
          const { x, y } = project(m.lat, m.lng, W, H);
          const r = 4 + m.demand * 12;
          const color = supplyColors[m.supplyStatus];
          return (
            <g key={m.id}>
              <circle cx={x} cy={y} r={r + 4} fill={color} opacity={0.08} />
              <circle cx={x} cy={y} r={r} fill={color} opacity={0.3} stroke={color} strokeWidth={1} strokeOpacity={0.5} />
              <text x={x} y={y + r + 10} textAnchor="middle" fill="rgba(255,255,255,0.3)" fontSize={8} fontFamily="monospace">
                {m.label}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="flex items-center gap-4 text-[10px] text-white/20">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500/50" /> Surplus</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-500/50" /> Balanced</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500/50" /> Deficit</span>
      </div>
    </GlassPanel>
  );
}
