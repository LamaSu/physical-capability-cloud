import React from "react";
import { cn } from "../utils.js";

export interface AmountDisplayProps {
  amount: string;
  currency?: string;
  size?: "sm" | "md" | "lg" | "xl";
  glow?: boolean;
  className?: string;
}

const sizeMap = {
  sm: "text-sm",
  md: "text-lg",
  lg: "text-2xl",
  xl: "text-4xl",
};

export function AmountDisplay({
  amount,
  currency = "USDC",
  size = "md",
  glow = false,
  className,
}: AmountDisplayProps) {
  const num = parseFloat(amount);
  const formatted = isNaN(num) ? "0.00" : num.toFixed(2);

  return (
    <span
      className={cn(
        "font-mono font-semibold text-green-400",
        sizeMap[size],
        glow && "glow-text-green",
        className,
      )}
    >
      <span className="text-white/40 mr-0.5">$</span>
      {formatted}
      <span className="text-white/30 text-xs ml-1.5">{currency}</span>
    </span>
  );
}
