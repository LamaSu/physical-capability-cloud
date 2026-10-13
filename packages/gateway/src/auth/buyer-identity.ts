/**
 * Board N133 (CRITICAL; the steward's DECISIONS 01:01, #6733): who a paid job's buyer is.
 *
 * Since f6359711 a PROVEN holder of the scope a write names may make that write, and a paid job's
 * buyer (its userAgentId) becomes the holder of the scope createJobFromSession mints. So the
 * buyer a request names must be the caller's PROVEN identity, or the admin acts for it. A claim
 * (an API key's identity: anyone can provision a key naming any wallet) or a mismatch is refused
 * before anything is created. Used by POST /api/jobs/submit-from-discovery, the negotiation
 * session's creation and commit, and the A2A pcc-quote/pcc-submit skills.
 */
import type { KernelAuthority } from "./kernel-authority.js";

const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

/** Equal strings, or the same 0x address in another letter case (a checksum is encoding, not identity). */
export function sameIdentity(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = a.trim();
  const y = b.trim();
  if (x.length === 0 || y.length === 0) return false;
  if (x === y) return true;
  return WALLET_RE.test(x) && WALLET_RE.test(y) && x.toLowerCase() === y.toLowerCase();
}

export const BUYER_PROOF_REQUIRED = {
  error: "forbidden",
  reason: "buyer_proof_required",
  message:
    "A paid job's buyer must be your proven wallet (wallet sign-in proof, WP-A), or the gateway admin acts for it. An API key's claimed identity is not proof.",
} as const;

export const BUYER_MISMATCH = {
  error: "forbidden",
  reason: "buyer_mismatch",
  message: "You may act only as your own proven wallet: the buyer named is not it.",
} as const;

export type BuyerBinding =
  | { ok: true; buyer: string }
  | { ok: false; status: 403; body: typeof BUYER_PROOF_REQUIRED | typeof BUYER_MISMATCH };

/**
 * The buyer this caller may act for, or the 403 to send. The admin may act for any buyer, named
 * as given. A proven wallet may act only for itself: the buyer is then the proven wallet's own
 * string, because the relay compares the minted scope's holder with it exactly. Anyone else, a
 * claimed key included, is refused.
 */
export function bindBuyer(authority: Pick<KernelAuthority, "admin" | "provenWallet">, named: unknown): BuyerBinding {
  if (authority.admin && typeof named === "string" && named.trim().length > 0) return { ok: true, buyer: named };
  if (authority.provenWallet === null) return { ok: false, status: 403, body: BUYER_PROOF_REQUIRED };
  if (!sameIdentity(named, authority.provenWallet)) return { ok: false, status: 403, body: BUYER_MISMATCH };
  return { ok: true, buyer: authority.provenWallet };
}
