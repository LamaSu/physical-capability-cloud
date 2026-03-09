import React from "react";
import { cn } from "../utils.js";

export interface MaintenanceTimelineItemProps {
  description: string;
  type: "scheduled" | "unscheduled" | "inspection";
  scheduledAt: string;
  completedAt?: string;
  status: "upcoming" | "in-progress" | "completed";
  className?: string;
}

const typeIcons: Record<string, string> = {
  scheduled: "S",
  unscheduled: "U",
  inspection: "I",
};

const statusStyles = {
  upcoming: { dot: "bg-yellow-500/50 border-yellow-500/30", text: "text-yellow-400/60" },
  "in-progress": { dot: "bg-green-500/50 border-green-500/30 animate-pulse", text: "text-green-400/60" },
  completed: { dot: "bg-white/10 border-white/10", text: "text-white/30" },
};

export function MaintenanceTimelineItem({ description, type, scheduledAt, completedAt, status, className }: MaintenanceTimelineItemProps) {
  const s = statusStyles[status];
  const date = new Date(scheduledAt);
  const now = new Date();
  const daysUntil = Math.ceil((date.getTime() - now.getTime()) / 86400000);

  return (
    <div className={cn("flex items-start gap-3", className)}>
      {/* Timeline dot */}
      <div className="flex flex-col items-center">
        <div className={cn("w-6 h-6 rounded-full border flex items-center justify-center text-[9px] font-mono text-white/30", s.dot)}>
          {typeIcons[type]}
        </div>
        <div className="w-px h-4 bg-white/[0.06]" />
      </div>

      <div className="flex-1 pb-3">
        <div className="text-xs text-white/60">{description}</div>
        <div className="flex items-center gap-3 mt-0.5">
          <span className="text-[10px] text-white/20 font-mono">{date.toLocaleDateString()}</span>
          {status === "upcoming" && daysUntil > 0 && (
            <span className={cn("text-[10px] font-mono", s.text)}>in {daysUntil}d</span>
          )}
          {status === "completed" && completedAt && (
            <span className="text-[10px] text-white/15 font-mono">Done</span>
          )}
          {status === "in-progress" && (
            <span className={cn("text-[10px] font-mono", s.text)}>In progress</span>
          )}
        </div>
      </div>
    </div>
  );
}
