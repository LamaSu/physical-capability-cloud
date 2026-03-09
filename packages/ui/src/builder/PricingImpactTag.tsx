import React from "react";
import type { PriceBreakdownItem } from "@pcc/spec";
import { cn } from "../utils.js";

export interface PricingImpactTagProps {
  item: PriceBreakdownItem;
  className?: string;
}

export function PricingImpactTag({ item, className }: PricingImpactTagProps) {
  const num = parseFloat(item.amount);
  const isPositive = num > 0;
  const isMultiplier = item.impact.mode === "multiplier";

  return (
    <div className={cn("flex items-center justify-between text-xs", className)}>
      <div className="flex items-center gap-2">
        <span className="text-white/50">{item.paramLabel}</span>
        <span className="text-white/25">{item.selectedValue}</span>
      </div>
      <span
        className={cn(
          "font-mono",
          isMultiplier ? "text-white/40" : isPositive ? "text-gold-300/70" : "text-green-400/70",
        )}
      >
        {isMultiplier
          ? `×${parseFloat(item.impact.value).toFixed(1)}`
          : `${isPositive ? "+" : ""}$${Math.abs(num).toFixed(2)}`}
      </span>
    </div>
  );
}
