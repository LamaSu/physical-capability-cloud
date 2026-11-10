export const BUYER_STATUS_TEXTS = Object.freeze({
  S01: "active",
  S02: "awaiting funding",
  S03: "test network",
  S04: "mainnet",
  S05: "couldn't confirm the network",
  S06: "verified at block {N}",
  S07: " against the configured deployment",
  S08: " against the recorded deployment",
  S09: "Test-network funds are not real money.",
  S10: "A verification is a past check at that block, not a live balance.",
  S11: "The gateway reports no paid scope for this job.",
});

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pure projection. A malformed envelope or scope has no funding view. */
export function orderStatusView(jobId: string, reply: unknown) {
  if (!object(reply) || reply.jobId !== jobId || !Array.isArray(reply.scopes)
    || !reply.scopes.every(dto => object(dto) && typeof dto.scopeId === "string")) return null;

  const scopes = reply.scopes.map(dto => {
    const scope = object(dto.scope) ? dto.scope : undefined;
    const status = dto.state === "funded_verified" && scope?.sourceStatus === "active"
      ? BUYER_STATUS_TEXTS.S01
      : dto.state === "awaiting_funding" ? BUYER_STATUS_TEXTS.S02
      : ["prepared", "funded_verified", "expired", "cancelled", "unknown"].includes(dto.state as string)
        ? dto.state as string : "unknown";
    const deployment = Object.hasOwn(dto, "deployment") && object(dto.deployment) ? dto.deployment : undefined;
    const network = deployment?.chainClass === "mainnet" ? BUYER_STATUS_TEXTS.S04
      : deployment?.chainClass === "testnet" || deployment?.chainClass === "local" ? BUYER_STATUS_TEXTS.S03
      : BUYER_STATUS_TEXTS.S05;
    const block = object(dto.verification) ? dto.verification.blockNumber : undefined;
    const verification = typeof block === "string" && /^\d{1,30}$/.test(block)
      ? BUYER_STATUS_TEXTS.S06.replace("{N}", block)
        + (deployment?.basis === "configured" ? BUYER_STATUS_TEXTS.S07
          : deployment?.basis === "recorded" ? BUYER_STATUS_TEXTS.S08 : "")
      : null;
    const notes: string[] = [];
    if (network === BUYER_STATUS_TEXTS.S03) notes.push(BUYER_STATUS_TEXTS.S09);
    if (verification !== null) notes.push(BUYER_STATUS_TEXTS.S10);
    return { scopeId: dto.scopeId, status, network, verification, notes, record: dto };
  });
  return { jobId, scopes, ...(scopes.length === 0 ? { note: BUYER_STATUS_TEXTS.S11 } : {}) };
}
