import { parseEther, parseUnits } from "viem";
import { TESTNET_FUNDING } from "../wallet-links/consent.js";

export interface FaucetPlanClaim {
  readonly token: "eth" | "usdc";
  readonly seq: number;
  readonly amount: "0.0001" | "1";
}

function claims(token: FaucetPlanClaim["token"], promised: string): readonly FaucetPlanClaim[] {
  const amount = token === "eth" ? "0.0001" : "1";
  const total = token === "eth" ? parseEther(promised) : parseUnits(promised, 6);
  const perClaim = token === "eth" ? parseEther(amount) : parseUnits(amount, 6);
  if (total <= 0n || total % perClaim !== 0n || total / perClaim > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("invalid_faucet_plan");
  }
  return Array.from({ length: Number(total / perClaim) }, (_, index) => Object.freeze({
    token, seq: index + 1, amount,
  }));
}

function derivePlan(): Readonly<Record<"agent" | "device", readonly FaucetPlanClaim[]>> {
  const plan = {} as Record<"agent" | "device", readonly FaucetPlanClaim[]>;
  for (const role of ["agent", "device"] as const) {
    const promised = TESTNET_FUNDING[role];
    plan[role] = Object.freeze([
      ...claims("eth", promised.eth),
      ...(promised.usdc === null ? [] : claims("usdc", promised.usdc)),
    ]);
  }
  return Object.freeze(plan);
}

export const FAUCET_PLAN = derivePlan();
