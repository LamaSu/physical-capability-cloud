import React from "react";
import { ESCROW_CURRENCIES, isCanonicalAmount } from "../api/wire-vocabulary.js";

const AMOUNT_SIZE = { sm: "text-sm", md: "text-lg" } as const;

/** Format a canonical decimal without passing its digits through a number. */
export function formatEscrowAmount(amount: string): string {
  const [integer = "", decimal = ""] = amount.split(".");
  return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${decimal.replace(/0+$/, "").padEnd(2, "0")}`;
}

/** Keep the escrow's own unit and preserve an unreadable amount as unavailable. */
export function EscrowAmount({ amount, currency, size = "sm" }: {
  amount: unknown;
  currency: unknown;
  size?: keyof typeof AMOUNT_SIZE;
}) {
  const readable = isCanonicalAmount(amount) && typeof currency === "string" && ESCROW_CURRENCIES.has(currency);
  if (!readable) {
    return (
      <span className={`font-mono text-white/40 ${AMOUNT_SIZE[size]}`} title="Amount unavailable" data-amount="unavailable">
        <span aria-hidden="true">—</span>
        <span className="sr-only">amount unavailable</span>
      </span>
    );
  }
  return (
    <span className={`font-mono font-semibold text-white/80 ${AMOUNT_SIZE[size]}`} style={{ fontVariantNumeric: "tabular-nums" }} data-amount="value">
      {currency === "USDC" && <span className="mr-0.5 text-white/40">$</span>}
      {formatEscrowAmount(amount)}
      <span className="text-xs ml-1.5 text-white/40">{currency}</span>
    </span>
  );
}
