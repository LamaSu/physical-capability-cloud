import React from "react";
import { cn } from "../utils.js";

export interface PulseIndicatorProps {
  status: "online" | "executing" | "completed" | "failed" | "offline";
  size?: "sm" | "md" | "lg";
  className?: string;
}

const statusColors = {
  online: "bg-green-400",
  executing: "bg-gold-400",
  completed: "bg-green-500",
  failed: "bg-red-500",
  offline: "bg-white/30",
};

const pulseColors = {
  online: "bg-green-400/50",
  executing: "bg-gold-400/50",
  completed: "bg-green-500/50",
  failed: "bg-red-500/50",
  offline: "bg-white/10",
};

const sizeMap = { sm: "h-2 w-2", md: "h-3 w-3", lg: "h-4 w-4" };
const pulseSizeMap = { sm: "h-2 w-2", md: "h-3 w-3", lg: "h-4 w-4" };

export function PulseIndicator({ status, size = "md", className }: PulseIndicatorProps) {
  const shouldPulse = status === "online" || status === "executing";
  return (
    <span className={cn("relative inline-flex", className)}>
      {shouldPulse && (
        <span
          className={cn(
            "absolute inline-flex rounded-full opacity-75 animate-ping",
            pulseSizeMap[size],
            pulseColors[status],
          )}
        />
      )}
      <span className={cn("relative inline-flex rounded-full", sizeMap[size], statusColors[status])} />
    </span>
  );
}
