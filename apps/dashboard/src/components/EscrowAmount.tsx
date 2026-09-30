import React from "react";
import { ESCROW_CURRENCIES, isCanonicalAmount } from "../api/wire-vocabulary.js";

/**
 * Of the escrow currencies, the one a "$" may stand for. The rule matches
 * @pcc/ui's AmountDisplay as design #393 rewrites it: any other currency
 * shows no "$", so "10.00 ETH", never "$10.00 ETH".
 */
const DOLLAR_CURRENCIES: ReadonlySet<string> = new Set(["USDC"]);

const SIZES = { sm: "text-sm", md: "text-lg" } as const;

/** "1234.5" → "1,234.50": grouped, and at least two decimals, digit for digit. Takes a canonical amount (isCanonicalAmount). */
export function formatEscrowAmount(amount: string): string {
  const [whole, fraction = ""] = amount.split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${grouped}.${fraction.replace(/0+$/, "").padEnd(2, "0")}`;
}

/**
 * An escrow's total, in the escrow's own currency (astra 18b F1). The
 * shared AmountDisplay at master turns an unreadable amount into "$0.00" and
 * labels every amount USDC. Its fix belongs to design (#393), so escrow rows
 * use this instead: the amount is shown digit for digit, never through a
 * float; the currency is the escrow's; and anything unreadable is shown as
 * unavailable, never as a value. useEscrows already rejects such rows. This
 * repeats the check so the component can't be handed one.
 */
export function EscrowAmount({ amount, currency, size = "sm" }: { amount: unknown; currency: unknown; size?: keyof typeof SIZES }) {
  if (!isCanonicalAmount(amount) || typeof currency !== "string" || !ESCROW_CURRENCIES.has(currency)) {
    return (
      <span className={`font-mono text-white/40 ${SIZES[size]}`} title="Amount unavailable" data-amount="unavailable">
        <span aria-hidden="true">—</span>
        <span className="sr-only">amount unavailable</span>
      </span>
    );
  }
  return (
    <span className={`font-mono font-semibold text-white/80 ${SIZES[size]}`} style={{ fontVariantNumeric: "tabular-nums" }} data-amount="value">
      {DOLLAR_CURRENCIES.has(currency) && <span className="mr-0.5 text-white/40">$</span>}
      {formatEscrowAmount(amount)}
      <span className="text-xs ml-1.5 text-white/40">{currency}</span>
    </span>
  );
}
