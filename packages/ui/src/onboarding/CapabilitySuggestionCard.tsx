import React from "react";
import { cn } from "../utils.js";
import { GlassPanel } from "../primitives/GlassPanel.js";
import { ProgressArc } from "../primitives/ProgressArc.js";
import { GlowBadge } from "../primitives/GlowBadge.js";

export interface CapabilitySuggestionCardProps {
  name: string;
  type: string;
  description: string;
  confidence: number;
  materials: string[];
  sourceReason: string;
  onAccept?: () => void;
  onEdit?: () => void;
  onReject?: () => void;
  className?: string;
}

export function CapabilitySuggestionCard({
  name,
  type,
  description,
  confidence,
  materials,
  sourceReason,
  onAccept,
  onEdit,
  onReject,
  className,
}: CapabilitySuggestionCardProps) {
  return (
    <GlassPanel padding="md" glow={confidence >= 0.8 ? "green" : "none"} className={cn("space-y-3", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-white/80">{name}</span>
            <GlowBadge color="green">{type}</GlowBadge>
          </div>
          <p className="text-xs text-white/40 mt-1">{description}</p>
        </div>
        <ProgressArc progress={confidence * 100} size={40} strokeWidth={2.5} />
      </div>

      {materials.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {materials.map((m) => (
            <span key={m} className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.04] border border-white/[0.06] text-white/30">
              {m}
            </span>
          ))}
        </div>
      )}

      <div className="text-[10px] text-white/20 italic">Source: {sourceReason}</div>

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onAccept}
          className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-green-500/15 border border-green-500/25 text-green-400 hover:bg-green-500/25 transition-all"
        >
          Accept
        </button>
        <button
          onClick={onEdit}
          className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-white/[0.04] border border-white/[0.08] text-white/40 hover:text-white/60 transition-all"
        >
          Edit
        </button>
        <button
          onClick={onReject}
          className="px-3 py-1.5 rounded-lg text-[11px] text-white/20 hover:text-red-400/60 transition-colors"
        >
          Reject
        </button>
      </div>
    </GlassPanel>
  );
}
