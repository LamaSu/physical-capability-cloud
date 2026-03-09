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

export function StatusChip({ status, label, className }: StatusChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium",
        "bg-white/[0.04] border border-white/[0.06]",
        className,
      )}
    >
      <PulseIndicator status={status} size="sm" />
      <span className="text-white/70">{label ?? defaultLabels[status] ?? status}</span>
    </span>
  );
}
