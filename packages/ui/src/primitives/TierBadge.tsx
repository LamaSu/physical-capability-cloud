import React from "react";
import { cn } from "../utils.js";

export interface TierBadgeProps {
  tier: 0 | 1 | 2 | 3;
  className?: string;
}

const tierConfig = {
  0: { label: "T0 Basic", color: "bg-white/10 text-white/50 border-white/10" },
  1: { label: "T1 Standard", color: "bg-green-500/15 text-green-400 border-green-500/30" },
  2: { label: "T2 Verified", color: "bg-gold-400/15 text-gold-300 border-gold-400/30" },
  3: { label: "T3 Full", color: "bg-green-400/20 text-green-300 border-green-400/40" },
};

export function TierBadge({ tier, className }: TierBadgeProps) {
  const config = tierConfig[tier];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-mono font-medium",
        config.color,
        className,
      )}
    >
      {config.label}
    </span>
  );
}
