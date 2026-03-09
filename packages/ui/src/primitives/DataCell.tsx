import React from "react";
import { cn } from "../utils.js";

export interface DataCellProps {
  label: string;
  value: React.ReactNode;
  sub?: string;
  mono?: boolean;
  className?: string;
}

export function DataCell({ label, value, sub, mono = false, className }: DataCellProps) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <span className="text-xs text-white/40 uppercase tracking-wider font-medium">{label}</span>
      <span className={cn("text-lg font-semibold text-white/90", mono && "font-mono")}>{value}</span>
      {sub && <span className="text-xs text-white/30">{sub}</span>}
    </div>
  );
}
