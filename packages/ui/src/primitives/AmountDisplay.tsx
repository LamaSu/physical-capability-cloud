import React from "react";
import { cn, formatAmountExact, parseAmountExact } from "../utils.js";

export interface AmountDisplayProps {
  /**
   * A decimal string ("1234.5", "1,234.56"), a finite number, or, with `decimals`,
   * an integer count of base units. Missing or unreadable input renders as
   * unavailable (an em dash), never as $0.00.
   */
  amount?: string | number | bigint | null;
  /** When set, `amount` is an integer in base units with this many decimals (USDC: 6). */
  decimals?: number;
  currency?: string;
  size?: "sm" | "md" | "lg" | "xl";
  /**
   * @deprecated Ignored. An amount carries no payment-state colour or glow; the
   * money badge (MONEY_STATUS_MAP in @pcc/spec) shows whether it was paid.
   */
  glow?: boolean;
  className?: string;
}

const sizeMap = {
  sm: "text-sm",
  md: "text-lg",
  lg: "text-2xl",
  xl: "text-4xl",
};

/** Read by screen readers, never shown. Inline so it needs no utility class. */
const VISUALLY_HIDDEN: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

/** Digits line up in columns. */
const TABULAR: React.CSSProperties = { fontVariantNumeric: "tabular-nums" };

/** "$" and the currency code are quieter than the digits, in the same ink. */
const SECONDARY: React.CSSProperties = { opacity: 0.7 };

export function AmountDisplay({
  amount,
  decimals,
  currency = "USDC",
  size = "md",
  className,
}: AmountDisplayProps) {
  const exact = parseAmountExact(amount, decimals);

  // An amount that can't be read is unavailable. Showing $0.00 would state a
  // balance or price nobody reported.
  if (exact === null) {
    return (
      <span
        className={cn("font-mono", sizeMap[size], className)}
        title="Amount unavailable"
        data-amount="unavailable"
      >
        <span aria-hidden="true">—</span>
        <span style={VISUALLY_HIDDEN}>amount unavailable</span>
      </span>
    );
  }

  const formatted = formatAmountExact(exact);
  return (
    <span
      className={cn("font-mono font-semibold", sizeMap[size], className)}
      style={TABULAR}
      data-amount="value"
    >
      {exact.negative && "-"}
      <span className="mr-0.5" style={SECONDARY}>$</span>
      {exact.negative ? formatted.slice(1) : formatted}
      <span className="text-xs ml-1.5" style={SECONDARY}>{currency}</span>
    </span>
  );
}
