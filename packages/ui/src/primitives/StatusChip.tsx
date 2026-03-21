import React from "react";
import { cn } from "../utils.js";
import { PulseIndicator, type PulseIndicatorProps } from "./PulseIndicator.js";

export interface StatusChipProps {
  status: PulseIndicatorProps["status"];
  label?: string;
  className?: string;
}

const defaultLabels: Record<string, string> = {
  online: "Online",
  executing: "Executing",
  completed: "Completed",
  failed: "Failed",
  offline: "Offline",
};

const statusStyles: Record<string, React.CSSProperties> = {
  online: {
    background: "rgba(0, 255, 136, 0.08)",
    border: "1px solid rgba(0, 255, 136, 0.25)",
    boxShadow: "0 0 10px rgba(0, 255, 136, 0.08)",
  },
  executing: {
    background: "rgba(255, 170, 0, 0.08)",
    border: "1px solid rgba(255, 170, 0, 0.25)",
    boxShadow: "0 0 10px rgba(255, 170, 0, 0.08)",
  },
  completed: {
    background: "rgba(16, 185, 129, 0.08)",
    border: "1px solid rgba(16, 185, 129, 0.25)",
  },
  failed: {
    background: "rgba(255, 68, 68, 0.08)",
    border: "1px solid rgba(255, 68, 68, 0.25)",
    boxShadow: "0 0 10px rgba(255, 68, 68, 0.08)",
  },
  offline: {
    background: "rgba(255, 255, 255, 0.04)",
    border: "1px solid rgba(255, 255, 255, 0.08)",
  },
};

const statusTextColors: Record<string, string> = {
  online: "rgba(0, 255, 136, 0.9)",
  executing: "rgba(255, 170, 0, 0.9)",
  completed: "rgba(16, 185, 129, 0.9)",
  failed: "rgba(255, 68, 68, 0.9)",
  offline: "rgba(255, 255, 255, 0.4)",
};

export function StatusChip({ status, label, className }: StatusChipProps) {
  const chipStyle = statusStyles[status] ?? {
    background: "rgba(255, 255, 255, 0.04)",
    border: "1px solid rgba(255, 255, 255, 0.08)",
  };
  const textColor = statusTextColors[status] ?? "rgba(255,255,255,0.6)";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium",
        className,
      )}
      style={chipStyle}
    >
      <PulseIndicator status={status} size="sm" />
      <span style={{ color: textColor }}>{label ?? defaultLabels[status] ?? status}</span>
    </span>
  );
}
