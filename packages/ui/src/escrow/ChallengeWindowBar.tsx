import React from "react";
import { cn } from "../utils.js";

export interface ChallengeWindowBarProps {
  start: string;
  end: string;
  className?: string;
}

export function ChallengeWindowBar({ start, end, className }: ChallengeWindowBarProps) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const now = Date.now();
  const total = endMs - startMs;
  const elapsed = Math.max(0, Math.min(now - startMs, total));
  const progress = total > 0 ? (elapsed / total) * 100 : 0;
  const remaining = Math.max(0, endMs - now);
  const hours = Math.floor(remaining / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);

  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex justify-between text-[10px] text-white/30">
        <span>Challenge Window</span>
        <span className="font-mono text-gold-300/60">
          {remaining > 0 ? `${hours}h ${minutes}m remaining` : "Expired"}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
        <div
          className="h-full rounded-full bg-gold-400/50 transition-all duration-1000"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}
