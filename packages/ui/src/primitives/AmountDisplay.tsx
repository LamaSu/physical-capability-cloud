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

/**
 * Parse an amount string strictly: a plain decimal ("1234.5", "-3") or one
 * with correct thousands grouping ("1,234.56"). Anything else is null.
 * parseFloat was used before, and it read "1,234.56" as 1 and any garbage as
 * NaN, which then rendered as a plausible $0.00.
 */
export function parseAmount(amount: string | number | null | undefined): number | null {
  if (typeof amount === "number") return Number.isFinite(amount) ? amount : null;
  if (typeof amount !== "string") return null;
  const t = amount.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return Number(t.replace(/,/g, ""));
  return null;
}

export function AmountDisplay({
  amount,
  currency = "USDC",
  size = "md",
  glow = false,
  className,
}: AmountDisplayProps) {
  const num = parseAmount(amount);

  // An amount that can't be read is shown as unknown, never as $0.00.
  if (num === null) {
    return (
      <span className={cn("font-mono text-white/40", sizeMap[size], className)} title="Amount unavailable">
        —
      </span>
    );
  }
  const formatted = num.toFixed(2);

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
