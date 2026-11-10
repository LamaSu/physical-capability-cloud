/** The row marker for escrows funded and controlled by their buyer. */
import { getAddress, isAddress } from "viem";
import { getRepos } from "../db.js";

export const BUYER_FUNDED_ESCROW_VERSION = "vnext-buyer";
export const ESCROW_BUYER_FUNDED = "escrow_buyer_funded";

export function isBuyerFundedEscrowRow(row: { version?: string | null } | null | undefined): boolean {
  return row?.version === BUYER_FUNDED_ESCROW_VERSION;
}

export function findEscrowRowByAddress(contractAddress: string) {
  const escrows = getRepos().escrows;
  const candidates = new Set<string>([contractAddress]);
  if (isAddress(contractAddress)) candidates.add(getAddress(contractAddress));
  candidates.add(contractAddress.toLowerCase());
  for (const candidate of candidates) {
    const row = escrows.findByContractAddress(candidate);
    if (row) return row;
  }
  return undefined;
}

export function buyerFundedEscrowRefusal(address: string): typeof ESCROW_BUYER_FUNDED | "escrow_lookup_unavailable" | null {
  try {
    return isBuyerFundedEscrowRow(findEscrowRowByAddress(address)) ? ESCROW_BUYER_FUNDED : null;
  } catch {
    return "escrow_lookup_unavailable";
  }
}
