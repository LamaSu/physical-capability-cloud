/**
 * Job-offer -> operator notification trigger.
 *
 * Gap identified in NOTIFICATION-NOTES.md (bug B5 follow-up): the real email
 * transport (services/email-transport.ts) and the dispatch path
 * (routes/operator-channels.ts -> dispatchToChannels) were wired, but nothing
 * called dispatchToChannels when a job actually landed. The only caller was
 * the manual `POST /api/operators/:slug/channels/test` delivery-test
 * endpoint. An operator who offers a capability got NO notification when a
 * real job for that capability was posted — they'd only find out by polling
 * `GET /api/job-offers/open?capabilityType=...`. This module is the missing
 * trigger.
 *
 * JobOffersStore.create() (services/job-offers-store.ts) calls the
 * OperatorNotifier below every time a NEW offer is posted (never on
 * idempotent replays — see the `created` guard at the call site). The
 * notifier:
 *
 *   1. Looks up which operators have a capability matching the offer's
 *      capabilityType. Match key: capabilities.type === offer.capabilityType
 *      — an exact match on the same dotted-namespace vocabulary documented in
 *      routes/capabilities.ts's `?type=` filter ("courier.dispatch",
 *      "pizza.order", "lab.hplc", ...). operatorSlug == kernel.operatorAddress,
 *      the same identity routes/operator-status.ts and routes/operator-channels.ts
 *      already use.
 *   2. For each matching operator (deduped — one operator can run several
 *      kernels/capabilities of the same type), calls dispatchToChannels so
 *      every enabled channel gets pinged (email today via the Resend
 *      transport; more transports as they land — see email-transport.ts).
 *
 * The DB lookup is injectable (OperatorLookup) so the matching logic is
 * unit-testable without a live DB — mirrors JobOffersStore's own injectable
 * CapabilitySchemaValidator / VerifyFn pattern. defaultOperatorLookup is the
 * real Drizzle-backed implementation, wired at boot in server.ts.
 *
 * Failure handling: this is best-effort notification, not the source of
 * truth (the job-offer feed is that). A DB error, a bad channel, or a
 * provider rejection here must never fail the job POST — every failure is
 * caught and logged, never re-thrown. (JobOffersStore.create() also wraps
 * the whole notifyOperators call in try/catch as a second net.)
 */

import { getStore } from "../db.js";
import { schema, eq } from "@pcc/store";
import { dispatchToChannels, getChannelsByOperator } from "../routes/operator-channels.js";
import type { ChannelTransport } from "../routes/operator-channels.js";
import type { JobOffer } from "./job-offers-store.js";

// dispatchToChannels' result type isn't exported (it's an internal detail of
// operator-channels.ts); reconstruct the shape locally for the outcome log.
// Kept structural (not imported) so this file doesn't need operator-channels.ts
// to widen its exports just for a logging type.
export interface DispatchOutcome {
  channelId: string;
  transport: ChannelTransport;
  delivered: boolean;
  ref?: string;
  error?: string;
  warning?: string;
}

/** Resolve which operator slugs offer a given capability type. Injectable for tests. */
export type OperatorLookup = (capabilityType: string) => Promise<string[]> | string[];

/**
 * Real lookup: capabilities.type === capabilityType, joined (loop-and-
 * accumulate, matching the SQLite-friendly style already used in
 * routes/operator-status.ts rather than a drizzle .in()) to
 * shopKernels.operatorAddress — the same operatorSlug identity the channels
 * substrate and GET /api/operators/:slug/status use.
 *
 * Graceful degrade: DB not initialised or query failure -> [] (no
 * notification attempted, never thrown). Mirrors operator-status.ts's own
 * try/catch around getStore().
 */
export const defaultOperatorLookup: OperatorLookup = (capabilityType) => {
  try {
    const { db } = getStore();
    const { shopKernels, capabilities } = schema;
    const capRows = db
      .select({ kernelId: capabilities.kernelId })
      .from(capabilities)
      .where(eq(capabilities.type, capabilityType))
      .all() as Array<{ kernelId: string }>;
    const kernelIds = Array.from(new Set(capRows.map((r) => r.kernelId)));
    const slugs = new Set<string>();
    for (const kernelId of kernelIds) {
      const kernelRows = db
        .select({ operatorAddress: shopKernels.operatorAddress })
        .from(shopKernels)
        .where(eq(shopKernels.id, kernelId))
        .all() as Array<{ operatorAddress: string | null }>;
      for (const r of kernelRows) {
        if (r.operatorAddress) slugs.add(r.operatorAddress);
      }
    }
    return Array.from(slugs);
  } catch {
    // DB not initialised (unit tests / a fresh boot race) — nobody to notify.
    return [];
  }
};

/** One operator's notification attempt, for logging/telemetry. */
export interface OperatorNotifyOutcome {
  operatorSlug: string;
  channelResults: DispatchOutcome[];
}

/**
 * Build the payload dispatchToChannels expects from a posted JobOffer.
 * Exported so tests (and any future caller) can assert the exact shape
 * without re-deriving it.
 */
export function offerToDispatchPayload(offer: JobOffer): {
  jobId: string;
  contextRef: string;
  summary: string;
  priceUSD?: number;
  deadlineSec?: number;
} {
  const priceUSD = offer.pricing.currency === "USD" ? offer.pricing.amount : undefined;
  const deadlineIso = offer.deadlineIso ?? offer.validUntil;
  const deadlineMs = deadlineIso ? Date.parse(deadlineIso) : NaN;
  const deadlineSec = Number.isFinite(deadlineMs)
    ? Math.max(0, Math.round((deadlineMs - Date.now()) / 1000))
    : undefined;
  const priceLabel = typeof priceUSD === "number" ? ` — $${priceUSD} USD` : "";

  const payload: {
    jobId: string;
    contextRef: string;
    summary: string;
    priceUSD?: number;
    deadlineSec?: number;
  } = {
    jobId: offer.id,
    contextRef: `/api/job-offers/${offer.id}`,
    summary: `New ${offer.capabilityType} job available${priceLabel}`,
  };
  if (priceUSD !== undefined) payload.priceUSD = priceUSD;
  if (deadlineSec !== undefined) payload.deadlineSec = deadlineSec;
  return payload;
}

/**
 * Factory — returns an OperatorNotifier (the shape
 * JobOffersStoreOptions.notifyOperators expects) closed over the given
 * lookup. server.ts wires createOperatorNotifier() (real lookup) into
 * initJobOffersStore(); tests wire createOperatorNotifier(fakeLookup) to
 * exercise the dispatch behaviour without a live DB.
 */
export function createOperatorNotifier(
  lookup: OperatorLookup = defaultOperatorLookup,
  log: { warn: (msg: string) => void } = console,
): (offer: JobOffer) => Promise<OperatorNotifyOutcome[]> {
  return async (offer: JobOffer): Promise<OperatorNotifyOutcome[]> => {
    const outcomes: OperatorNotifyOutcome[] = [];
    let slugs: string[];
    try {
      slugs = await lookup(offer.capabilityType);
    } catch (e) {
      log.warn(
        `[job-offer-notifier] operator lookup failed for capabilityType=${offer.capabilityType}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return outcomes;
    }
    if (slugs.length === 0) return outcomes;

    const payload = offerToDispatchPayload(offer);
    for (const slug of slugs) {
      try {
        // Skip operators with no attached channels — dispatchToChannels would
        // return a harmless "no-channels-attached" manual placeholder for
        // them; skipping keeps the outcome log meaningful (only operators who
        // were actually reachable show up).
        if (getChannelsByOperator(slug).length === 0) continue;
        const channelResults = (await dispatchToChannels(slug, payload)) as DispatchOutcome[];
        outcomes.push({ operatorSlug: slug, channelResults });
      } catch (e) {
        log.warn(
          `[job-offer-notifier] dispatch failed for operator=${slug} offer=${offer.id}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    return outcomes;
  };
}
