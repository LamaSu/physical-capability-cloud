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

// Neon glow styles for active states — applied inline for vivid color accuracy
const neonDotStyles: Record<string, React.CSSProperties> = {
  online: {
    backgroundColor: "#00ff88",
    boxShadow: "0 0 6px rgba(0, 255, 136, 0.9), 0 0 12px rgba(0, 255, 136, 0.5)",
  },
  executing: {
    backgroundColor: "#ffaa00",
    boxShadow: "0 0 6px rgba(255, 170, 0, 0.9), 0 0 12px rgba(255, 170, 0, 0.5)",
  },
  completed: {
    backgroundColor: "#10b981",
    boxShadow: "0 0 4px rgba(16, 185, 129, 0.6)",
  },
  failed: {
    backgroundColor: "#ff4444",
    boxShadow: "0 0 6px rgba(255, 68, 68, 0.8)",
  },
  offline: {
    backgroundColor: "rgba(255,255,255,0.25)",
  },
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
      <span
        className={cn("relative inline-flex rounded-full", sizeMap[size])}
        style={neonDotStyles[status]}
      />
    </span>
  );
}
