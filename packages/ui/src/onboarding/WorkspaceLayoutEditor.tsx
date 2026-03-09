import React from "react";
import { cn } from "../utils.js";
import { GlassPanel } from "../primitives/GlassPanel.js";

export interface WorkspaceLayoutEditorProps {
  footprint: { width: number; depth: number; unit: string };
  clearances: { front: number; back: number; left: number; right: number };
  className?: string;
}

const GRID_SIZE = 20;
const SCALE = 0.5; // pixels per unit

export function WorkspaceLayoutEditor({ footprint, clearances, className }: WorkspaceLayoutEditorProps) {
  const machineW = footprint.width * SCALE;
  const machineD = footprint.depth * SCALE;
  const totalW = machineW + (clearances.left + clearances.right) * SCALE;
  const totalD = machineD + (clearances.front + clearances.back) * SCALE;
  const svgW = Math.max(totalW + 60, 300);
  const svgH = Math.max(totalD + 60, 200);
  const ox = (svgW - totalW) / 2;
  const oy = (svgH - totalD) / 2;
  const mx = ox + clearances.left * SCALE;
  const my = oy + clearances.back * SCALE;

  return (
    <GlassPanel padding="md" className={cn("space-y-3", className)}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-white/50">Workspace Layout</span>
        <span className="text-[10px] text-white/20 font-mono">
          Total: {(totalW / SCALE).toFixed(0)} x {(totalD / SCALE).toFixed(0)} {footprint.unit}
        </span>
      </div>

      <svg width="100%" viewBox={`0 0 ${svgW} ${svgH}`} className="rounded-lg bg-white/[0.02]">
        {/* Grid */}
        {Array.from({ length: Math.ceil(svgW / GRID_SIZE) + 1 }, (_, i) => (
          <line key={`gx-${i}`} x1={i * GRID_SIZE} y1={0} x2={i * GRID_SIZE} y2={svgH} stroke="rgba(255,255,255,0.03)" strokeWidth={0.5} />
        ))}
        {Array.from({ length: Math.ceil(svgH / GRID_SIZE) + 1 }, (_, i) => (
          <line key={`gy-${i}`} x1={0} y1={i * GRID_SIZE} x2={svgW} y2={i * GRID_SIZE} stroke="rgba(255,255,255,0.03)" strokeWidth={0.5} />
        ))}

        {/* Safety clearance zone */}
        <rect x={ox} y={oy} width={totalW} height={totalD} rx={4} fill="rgba(255,179,0,0.04)" stroke="rgba(255,179,0,0.15)" strokeWidth={1} strokeDasharray="4 2" />

        {/* Machine footprint */}
        <rect x={mx} y={my} width={machineW} height={machineD} rx={2} fill="rgba(124,179,66,0.1)" stroke="rgba(124,179,66,0.3)" strokeWidth={1.5} />

        {/* Machine label */}
        <text x={mx + machineW / 2} y={my + machineD / 2} textAnchor="middle" dominantBaseline="middle" fill="rgba(124,179,66,0.5)" fontSize={10} fontFamily="monospace">
          {footprint.width} x {footprint.depth}
        </text>

        {/* Power drop indicator */}
        <circle cx={ox + 8} cy={oy + totalD - 8} r={4} fill="rgba(255,179,0,0.3)" stroke="rgba(255,179,0,0.5)" strokeWidth={1} />
        <text x={ox + 16} y={oy + totalD - 4} fill="rgba(255,179,0,0.4)" fontSize={8} fontFamily="monospace">PWR</text>
      </svg>

      <div className="flex items-center gap-4 text-[10px] text-white/20">
        <span className="flex items-center gap-1">
          <span className="w-3 h-2 rounded-sm bg-green-500/20 border border-green-500/30" /> Machine
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-2 rounded-sm bg-yellow-500/10 border border-yellow-500/20" /> Clearance
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-yellow-500/30 border border-yellow-500/50" /> Power
        </span>
      </div>
    </GlassPanel>
  );
}
