import type { FastifyRequest } from "fastify";

export const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

type Actor = { kind: "siwe"; address: string } | { kind: "api-key" } | { kind: "none" };

/**
 * Who authenticated this request, as api-gate recorded it: an API key sets
 * apiKeyId (and copies the key's self-declared operatorId into userId); a SIWE
 * session sets only userId, the address the wallet signature proved.
 */
export function requestActor(req: FastifyRequest): Actor {
  const r = req as unknown as { apiKeyId?: unknown; userId?: unknown };
  if (typeof r.apiKeyId === "string" && r.apiKeyId !== "") return { kind: "api-key" };
  if (typeof r.userId === "string" && r.userId !== "") return { kind: "siwe", address: r.userId };
  return { kind: "none" };
}

/** Two EVM addresses are the same account: both well-formed, hex compared case-insensitively (ASCII only). */
export function sameEvmAddress(a: unknown, b: unknown): boolean {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    EVM_ADDRESS.test(a) &&
    EVM_ADDRESS.test(b) &&
    a.toLowerCase() === b.toLowerCase()
  );
}

export interface OperatorIdentity {
  principal: string;
  identityStatus: "proven" | "self_asserted";
}

/** Resolve the authenticated principal, preferring a proven wallet, then an API key, then SIWE. */
export function operatorIdentity(req: FastifyRequest): OperatorIdentity | null {
  const r = req as unknown as { provenWallet?: unknown; apiKeyId?: unknown; operatorId?: unknown; userId?: unknown };
  if (typeof r.provenWallet === "string" && EVM_ADDRESS.test(r.provenWallet)) {
    return { principal: r.provenWallet, identityStatus: "proven" };
  }
  if (typeof r.apiKeyId === "string" && r.apiKeyId !== "") {
    if (typeof r.operatorId !== "string" || r.operatorId.trim() === "") return null;
    return { principal: r.operatorId, identityStatus: "self_asserted" };
  }
  if (typeof r.userId === "string" && r.userId !== "") {
    return { principal: r.userId, identityStatus: "proven" };
  }
  return null;
}

/** Match a kernel's current non-empty, non-zero owner using the caller's identity tier. */
export function ownsKernel(identity: OperatorIdentity, kernel: { operatorAddress?: unknown }): boolean {
  if (typeof kernel.operatorAddress !== "string") return false;
  const owner = kernel.operatorAddress.trim();
  if (owner === "" || /^0x0{40}$/i.test(owner)) return false;
  return identity.identityStatus === "proven"
    ? sameEvmAddress(identity.principal, owner)
    : identity.principal.trim() === owner;
}
