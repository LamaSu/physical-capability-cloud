import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * An amount read exactly: its sign and its digits, never a float. `whole` has no
 * leading zeros ("0" for zero); `fraction` holds the digits after the point.
 */
export interface ExactAmount {
  negative: boolean;
  whole: string;
  fraction: string;
}

const PLAIN_AMOUNT = /^([+-]?)(\d+)(?:\.(\d+))?$/;
const GROUPED_AMOUNT = /^([+-]?)(\d{1,3}(?:,\d{3})+)(?:\.(\d+))?$/;
const BASE_UNITS = /^([+-]?)(\d+)$/;

/**
 * Read an amount exactly, or return null when it can't be read. Accepts a decimal
 * string ("1234.5", "-3"), one with correct thousands grouping ("1,234.56"), a
 * finite number or a bigint. With `decimals`, `amount` is an integer count of base
 * units (USDC: 6), so "1500000" reads as 1.5. Missing, empty or anything else is
 * null: the caller shows the amount as unavailable, never as 0.
 */
export function parseAmountExact(amount: unknown, decimals?: number): ExactAmount | null {
  let s: string;
  if (typeof amount === "string") s = amount.trim();
  else if (typeof amount === "number") {
    if (!Number.isFinite(amount)) return null;
    s = String(amount);
  } else if (typeof amount === "bigint") s = amount.toString();
  else return null;

  if (decimals !== undefined) {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
    const m = BASE_UNITS.exec(s);
    if (!m) return null;
    const digits = m[2]!.padStart(decimals + 1, "0");
    const cut = digits.length - decimals;
    return exactAmount(m[1] === "-", digits.slice(0, cut), digits.slice(cut));
  }
  const m = PLAIN_AMOUNT.exec(s) ?? GROUPED_AMOUNT.exec(s);
  if (!m) return null;
  return exactAmount(m[1] === "-", m[2]!.replace(/,/g, ""), m[3] ?? "");
}

function exactAmount(negative: boolean, whole: string, fraction: string): ExactAmount {
  const w = whole.replace(/^0+(?=\d)/, "");
  const zero = /^0+$/.test(w) && /^0*$/.test(fraction);
  return { negative: negative && !zero, whole: w, fraction };
}

const WHOLE_GROUPING = new Intl.NumberFormat("en-US", { useGrouping: true });

/**
 * Print an exact amount: the whole part grouped ("1,234"), then every significant
 * fraction digit, at least `minFractionDigits`. It never rounds, so 0.004 prints
 * as 0.004 and a real non-zero amount is never shown as 0.00.
 */
export function formatAmountExact(amount: ExactAmount, minFractionDigits = 2): string {
  const whole = WHOLE_GROUPING.format(BigInt(amount.whole));
  const fraction = amount.fraction.replace(/0+$/, "").padEnd(minFractionDigits, "0");
  return `${amount.negative ? "-" : ""}${whole}${fraction ? "." + fraction : ""}`;
}

export function formatAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 2) return address;
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

export function formatHash(hash: string, chars = 6): string {
  if (hash.length <= chars * 2) return hash;
  return `${hash.slice(0, chars)}...${hash.slice(-chars)}`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
