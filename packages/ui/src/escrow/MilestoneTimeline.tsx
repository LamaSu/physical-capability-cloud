import React from "react";
import type { EscrowMilestone } from "@pcc/spec";
import { AmountDisplay } from "../primitives/AmountDisplay.js";
import { GlowBadge } from "../primitives/GlowBadge.js";
import { cn } from "../utils.js";

export interface MilestoneTimelineProps {
  milestones: EscrowMilestone[];
  className?: string;
}

const statusColors: Record<string, "green" | "gold" | "red" | "gray"> = {
  unfunded: "gray",
  funded: "gray",
  locked: "gold",
  releasing: "gold",
  released: "green",
  disputed: "red",
  refunded: "gray",
  slashed: "red",
};

export function MilestoneTimeline({ milestones, className }: MilestoneTimelineProps) {
  return (
    <div className={cn("space-y-3", className)}>
      {milestones.map((milestone, i) => {
        const color = statusColors[milestone.status] ?? "gray";
        const hasChallenge = !!milestone.challengeWindowStart;

        return (
          <div key={milestone.stepId} className="flex gap-3">
            {/* Timeline dot + line */}
            <div className="flex flex-col items-center">
              <div className={cn(
                "w-3 h-3 rounded-full border-2 flex-shrink-0",
                milestone.status === "released" ? "bg-green-500 border-green-400" :
                milestone.status === "locked" ? "bg-gold-400 border-gold-300" :
                "bg-white/20 border-white/30",
              )} />
              {i < milestones.length - 1 && <div className="w-px flex-1 bg-white/[0.08] min-h-[40px]" />}
            </div>

            {/* Content */}
            <div className="flex-1 pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-white/70 font-mono">{milestone.stepId}</span>
                  <GlowBadge color={color}>{milestone.status}</GlowBadge>
                </div>
                <AmountDisplay amount={milestone.amount} size="sm" />
              </div>

              <div className="flex items-center gap-4 mt-1 text-xs text-white/30">
                <span>Bond: <span className="font-mono text-white/40">${parseFloat(milestone.bondAmount).toFixed(2)}</span></span>
                {hasChallenge && milestone.challengeWindowEnd && (
                  <span className="text-gold-300/60">
                    Challenge window ends {new Date(milestone.challengeWindowEnd).toLocaleTimeString()}
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
