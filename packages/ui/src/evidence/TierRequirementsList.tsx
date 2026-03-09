import React from "react";
import type { TierEvidenceRequirements, EvidenceEvent } from "@pcc/spec";
import { cn } from "../utils.js";

export interface TierRequirementsListProps {
  requirements: TierEvidenceRequirements;
  events: EvidenceEvent[];
  className?: string;
}

export function TierRequirementsList({ requirements, events, className }: TierRequirementsListProps) {
  const eventTypes = new Set(events.map((e) => e.type));

  return (
    <div className={cn("space-y-2", className)}>
      <div className="text-[10px] text-white/30 uppercase tracking-wider">
        Tier {requirements.tier} Requirements
      </div>
      <p className="text-xs text-white/40">{requirements.description}</p>
      <div className="space-y-1.5">
        {requirements.requiredEventTypes.map((group, i) => {
          const satisfied = group.some((type) => eventTypes.has(type));
          return (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className={cn("w-4 h-4 rounded-full flex items-center justify-center text-[10px]", satisfied ? "bg-green-500/20 text-green-400" : "bg-white/[0.04] text-white/20")}>
                {satisfied ? "✓" : "○"}
              </span>
              <span className={cn("font-mono", satisfied ? "text-green-400/70" : "text-white/30")}>
                {group.join(" | ")}
              </span>
            </div>
          );
        })}
      </div>
      <div className="text-[10px] text-white/20 font-mono">
        {events.length}/{requirements.minimumEvents} minimum events
      </div>
    </div>
  );
}
