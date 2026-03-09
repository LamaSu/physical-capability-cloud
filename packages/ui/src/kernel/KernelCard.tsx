import React from "react";
import type { ShopKernel } from "@pcc/spec";
import { GlassPanel } from "../primitives/GlassPanel.js";
import { PulseIndicator } from "../primitives/PulseIndicator.js";
import { GlowBadge } from "../primitives/GlowBadge.js";
import { cn } from "../utils.js";

export interface KernelCardProps {
  kernel: ShopKernel;
  onClick?: () => void;
  className?: string;
}

const statusMap: Record<ShopKernel["status"], "online" | "offline" | "executing" | "failed"> = {
  online: "online",
  offline: "offline",
  maintenance: "executing",
  suspended: "failed",
};

export function KernelCard({ kernel, onClick, className }: KernelCardProps) {
  return (
    <GlassPanel hover={!!onClick} padding="lg" className={className} onClick={onClick}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <PulseIndicator status={statusMap[kernel.status]} />
          <div>
            <div className="text-sm font-semibold text-white/80">{kernel.name}</div>
            <div className="text-[10px] text-white/25 font-mono">{kernel.id}</div>
          </div>
        </div>
        <div className="text-xs font-mono text-white/30">
          Rep: <span className="text-green-400/60">{kernel.reputation}</span>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-3">
        {kernel.capabilities.map((cap) => (
          <GlowBadge key={cap.id} color="green">{cap.type}</GlowBadge>
        ))}
      </div>

      <div className="flex items-center justify-between text-xs text-white/30">
        <span>{kernel.totalJobsCompleted} jobs completed</span>
        <span className="font-mono">Tier {kernel.maxAssuranceTier}</span>
      </div>

      <div className="mt-2 text-[10px] text-white/20">{kernel.physicalAddress}</div>
    </GlassPanel>
  );
}
