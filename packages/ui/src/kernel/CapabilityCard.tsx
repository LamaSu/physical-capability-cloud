import React from "react";
import type { Capability } from "@pcc/spec";
import { GlassPanel } from "../primitives/GlassPanel.js";
import { TierBadge } from "../primitives/TierBadge.js";
import { GlowBadge } from "../primitives/GlowBadge.js";
import { cn } from "../utils.js";

export interface CapabilityCardProps {
  capability: Capability;
  onClick?: () => void;
  className?: string;
}

export function CapabilityCard({ capability, onClick, className }: CapabilityCardProps) {
  return (
    <GlassPanel hover={!!onClick} padding="lg" className={className} onClick={onClick}>
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="text-sm font-semibold text-white/80">{capability.name}</div>
          <div className="text-xs text-white/30 font-mono">{capability.type}</div>
        </div>
        <div className="flex gap-1">
          {capability.assuranceTiers.map((t) => (
            <TierBadge key={t} tier={t} />
          ))}
        </div>
      </div>

      {capability.description && (
        <p className="text-xs text-white/40 mb-3">{capability.description}</p>
      )}

      <div className="flex flex-wrap gap-1 mb-3">
        {capability.materials.slice(0, 5).map((m) => (
          <GlowBadge key={m} color="gray">{m}</GlowBadge>
        ))}
        {capability.materials.length > 5 && (
          <GlowBadge color="gray">+{capability.materials.length - 5}</GlowBadge>
        )}
      </div>

      <div className="flex items-center justify-between text-xs">
        <span className="text-white/30">
          Queue: <span className={cn("font-mono", capability.queueDepth === 0 ? "text-green-400/70" : "text-gold-300/70")}>
            {capability.queueDepth}
          </span>
        </span>
        <span className="font-mono text-green-400/70">
          ${capability.pricing.baseCost} {capability.pricing.currency}
        </span>
      </div>

      {capability.envelope && (
        <div className="mt-2 text-[10px] text-white/20 font-mono">
          {capability.envelope.x}×{capability.envelope.y}×{capability.envelope.z} {capability.envelope.unit}
        </div>
      )}
    </GlassPanel>
  );
}
