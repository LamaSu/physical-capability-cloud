import type { FundingClaim } from "../wallet/http.js";

// W2's grant, in claim order: five ETH claims, then USDC for uncapped agents.
export function realFundingClaims(role: "agent" | "device" = "agent", includeUsdc = true): FundingClaim[] {
  const claims: FundingClaim[] = Array.from({ length: 5 }, (_, index) => ({
    token: "eth", amount: "0.0001", status: "succeeded",
    txHash: `0x${(index + 1).toString(16).padStart(2, "0").repeat(32)}`,
  }));
  if (role === "agent" && includeUsdc) claims.push({ token: "usdc", amount: "1", status: "succeeded", txHash: `0x${"0e".repeat(32)}` });
  return claims;
}
