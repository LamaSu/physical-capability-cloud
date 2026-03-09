import React from "react";
import type { PriceBreakdownItem } from "@pcc/spec";
import { cn } from "../utils.js";

export interface PriceBreakdownChartProps {
  breakdown: PriceBreakdownItem[];
  basePrice: string;
  totalPrice: string;
  className?: string;
}

export function PriceBreakdownChart({ breakdown, basePrice, totalPrice, className }: PriceBreakdownChartProps) {
  const total = parseFloat(totalPrice) || 1;
  const base = parseFloat(basePrice) || 0;

  const items = [
    { label: "Base Price", amount: base, color: "bg-green-500/40" },
    ...breakdown
      .filter((b) => parseFloat(b.amount) !== 0 && b.impact.mode !== "multiplier")
      .map((b) => ({
        label: `${b.paramLabel}: ${b.selectedValue}`,
        amount: parseFloat(b.amount),
        color: parseFloat(b.amount) > 0 ? "bg-gold-400/40" : "bg-green-400/40",
      })),
  ];

  return (
    <div className={cn("space-y-3", className)}>
      <div className="text-[10px] text-white/30 uppercase tracking-wider">Price Composition</div>

      {/* Stacked bar */}
      <div className="flex h-3 rounded-full overflow-hidden bg-white/[0.04]">
        {items.map((item, i) => {
          const pct = Math.max((Math.abs(item.amount) / total) * 100, 2);
          return (
            <div
              key={i}
              className={cn("transition-all duration-500", item.color)}
              style={{ width: `${pct}%` }}
              title={`${item.label}: $${Math.abs(item.amount).toFixed(2)}`}
            />
          );
        })}
      </div>

      {/* Legend */}
      <div className="space-y-1">
        {items.map((item, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className={cn("w-2 h-2 rounded-full", item.color)} />
            <span className="text-white/40 flex-1 truncate">{item.label}</span>
            <span className="font-mono text-white/50">${Math.abs(item.amount).toFixed(2)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
