/**
 * Pure helpers for BatchBoardPage (status board row N49).
 *
 * The gateway's shared-batch routes take the claimant from the authenticated
 * caller, return claims as an array, and show a claimant's identity only to that
 * claimant. So the page counts claims itself and never sends an identity of its
 * own.
 */

export interface SharedBatchClaimView {
  /** The claimant, shown only when it is the viewer; null for everyone else's claims. */
  agentId: string | null;
  own: boolean;
  slotCount: number;
}

export interface SharedBatchView {
  id: string;
  kernelId: string;
  kernelName?: string;
  capabilityType: string;
  protocolType?: string;
  totalSlots: number;
  claimedSlots: number;
  /** NaN when the server sent no usable price: the page shows "—", never an invented number. */
  pricePerSlot: number;
  status: string;
  claims: SharedBatchClaimView[];
}

interface ServerClaim {
  agentId?: unknown;
  own?: unknown;
  slotIndices?: unknown;
}

export interface ServerSharedBatch {
  id: string;
  kernelId: string;
  kernelName?: string;
  capabilityType: string;
  protocolType?: string;
  totalSlots: number;
  claimedSlots?: unknown;
  pricePerSlot?: unknown;
  status: string;
}

function toPrice(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return Number.NaN;
}

/** Map one server batch (claims as an array) to the page's view (a claimed-slot count). */
export function toSharedBatchView(raw: ServerSharedBatch): SharedBatchView {
  const serverClaims: ServerClaim[] = Array.isArray(raw.claimedSlots) ? raw.claimedSlots : [];
  const claims = serverClaims.map((c) => ({
    agentId: typeof c.agentId === "string" ? c.agentId : null,
    own: c.own === true,
    slotCount: Array.isArray(c.slotIndices) ? c.slotIndices.length : 0,
  }));
  return {
    id: raw.id,
    kernelId: raw.kernelId,
    kernelName: raw.kernelName,
    capabilityType: raw.capabilityType,
    protocolType: raw.protocolType,
    totalSlots: raw.totalSlots,
    claimedSlots: claims.reduce((n, c) => n + c.slotCount, 0),
    pricePerSlot: toPrice(raw.pricePerSlot),
    status: raw.status,
    claims,
  };
}

/** Accepts `{ batches: [...] }` or a bare array; anything else is an empty list. */
export function toSharedBatchViews(data: unknown): SharedBatchView[] {
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { batches?: unknown }).batches)
      ? (data as { batches: unknown[] }).batches
      : [];
  return (list as ServerSharedBatch[]).map(toSharedBatchView);
}

/** A claim request never names a claimant: the gateway takes it from the authenticated caller. */
export function claimRequestBody(slotCount: number): { slotCount: number } {
  return { slotCount };
}

/** "$1.50" for a known price, "—" for an unknown one. */
export function formatSlotPrice(value: number): string {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : "—";
}
