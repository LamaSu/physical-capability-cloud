/**
 * N343 sets who may send each job-offer event kind and how each kind may move
 * an offer's status. Both route files use these rules through JobOffersStore.
 */
import { createHash } from "node:crypto";
import type { JobOfferStatus } from "./job-offers-store.js";
import { BUYER_PROOF_SOURCES } from "../auth/buyer-identity.js";

/** Kinds only the offer's claimer may send. */
export const CLAIMER_EVENT_KINDS: ReadonlySet<string> = new Set(["in_progress", "pickup", "delivered"]);

/** Kinds only the offer's poster may send. */
export const POSTER_EVENT_KINDS: ReadonlySet<string> = new Set(["cancelled"]);

/** Kinds only the server records. No caller may send them. */
export const SERVER_EVENT_KINDS: ReadonlySet<string> = new Set(["posted", "claimed", "patched", "heartbeat", "expired", "deleted_by_poster", "settled", "disputed", "open"]);

/** A status-changing kind: the statuses it may move an offer from, and the status it moves the offer to. */
export interface EventTransition { readonly from: ReadonlySet<JobOfferStatus>; readonly to: JobOfferStatus }

/** The status-changing kinds. Every other kind leaves the status alone. */
export const EVENT_TRANSITIONS: ReadonlyMap<string, EventTransition> = new Map<string, EventTransition>([
  ["in_progress", { from: new Set<JobOfferStatus>(["claimed", "in_progress"]), to: "in_progress" }],
  ["pickup", { from: new Set<JobOfferStatus>(["claimed", "in_progress"]), to: "in_progress" }],
  ["delivered", { from: new Set<JobOfferStatus>(["claimed", "in_progress"]), to: "delivered" }],
  ["cancelled", { from: new Set<JobOfferStatus>(["open", "claimed", "in_progress"]), to: "cancelled" }],
]);

/** The keys under which a job_offers row's data JSON keeps the private digests. Neither is ever on a served offer. */
export const CLAIMER_DIGEST_KEY = "_claimerDigest";
export const POSTER_DIGEST_KEY = "_posterDigest";

export interface OfferCaller { readonly identity: string; readonly wallet: string | null }

/** Use only an identity the gateway proved; a proven wallet survives session-key rotation. */
export function offerCaller(req: { provenWallet?: unknown; provenWalletVia?: unknown; apiKeyId?: unknown }): OfferCaller | null {
  if (
    typeof req.provenWallet === "string" && /^0x[0-9a-fA-F]{40}$/.test(req.provenWallet) &&
    typeof req.provenWalletVia === "string" && BUYER_PROOF_SOURCES.has(req.provenWalletVia)
  ) {
    const wallet = req.provenWallet.toLowerCase();
    return { identity: "wallet:" + wallet, wallet };
  }
  if (typeof req.apiKeyId === "string" && req.apiKeyId.length > 0) {
    return { identity: "key:" + req.apiKeyId, wallet: null };
  }
  return null;
}

export function identityDigest(identity: string): string {
  return createHash("sha256").update(identity, "utf8").digest("hex");
}
