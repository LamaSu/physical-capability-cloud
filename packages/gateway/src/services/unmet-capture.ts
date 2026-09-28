/**
 * Server-side unmet-demand capture (ledger R44, D2; steward ruling #2634;
 * gateway review #2975 applied).
 *
 * Adds two server-owned facts to first-party intent capture, behind
 * PCC_UNMET_CAPTURE_ENABLED (default OFF):
 *   1. who made the request, from the server-side auth context only, never a
 *      request body. Two strengths, recorded as distinct actor types:
 *        - "authenticated_operator": a PROVEN wallet: an /a2a SIWE session, or
 *          `req.provenWallet` once gateway's #326 follow-up binds it (nothing
 *          sets it yet, so /api routes record none). Only this counts as
 *          verified breadth in @pcc/demand-intel's UnmetDemandLens.
 *        - "authenticated_key": any API-key holder. The key's operatorId is
 *          self-asserted at /api/auth/provision, so it is volume, not breadth.
 *   2. which requested capability types no live supply could serve
 *      (`fulfillmentPath` + `unmet`), keyed by CSD URI when a CSD exists.
 *
 * Invariants: flag OFF emits exactly the previous events, synchronously; flag
 * ON computes off the response path, never throws into it, and is bounded
 * (at most MAX_MATCH_TYPES types per intent, supply reads cached for
 * SUPPLY_CACHE_TTL_MS). `price_exceeds_budget` / `region_unavailable` are not
 * computed (no reliable price or service-area supply data yet).
 */

import type { FastifyRequest } from "fastify";
import type { AnalyticsEvent, DemandEnvelope, UnmetCapability } from "@pcc/spec";
import type { CapabilityDTO } from "../facades/types.js";
import { getCapabilityFacade } from "../facades/index.js";
import { getCsdRegistry } from "../routes/csd.js";

/** A proven identity (read by UnmetDemandLens as verified breadth). */
export const VERIFIED_ACTOR_TYPE = "authenticated_operator" satisfies AnalyticsEvent["actorType"];
/** An API-key holder whose identity is self-asserted: counted as volume only. */
export const KEY_ACTOR_TYPE = "authenticated_key" satisfies AnalyticsEvent["actorType"];

/** At most this many distinct types are matched per intent (gateway review #2975). */
export const MAX_MATCH_TYPES = 16;
/** Supply reads are cached per type for this long (gateway review #2975). */
export const SUPPLY_CACHE_TTL_MS = 30_000;
/** Upper bound on cached types, so the cache cannot grow without limit. */
export const SUPPLY_CACHE_MAX_ENTRIES = 512;

export function isUnmetCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PCC_UNMET_CAPTURE_ENABLED === "true";
}

// ── Identity: the only place intent capture reads it ──────────────────────
// TODO(R28/N2): when gateway's #326 follow-up lands, req.provenWallet is its
// proven-identity binding. Keep this module the single extractor.

/** The principal behind an API key record the server resolved. */
export function principalFromApiKey(apiKey: { operatorId?: unknown } | null | undefined): string | null {
  const id = apiKey?.operatorId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** apiGate's key principal on /api routes (`req.operatorId`, set from the API key). */
export function authenticatedPrincipal(req: FastifyRequest): string | null {
  return principalFromApiKey(req as unknown as { operatorId?: unknown });
}

/** The proven wallet the gateway binds on the request (#326 follow-up), lower-cased. */
export function provenPrincipal(req: FastifyRequest): string | null {
  const w = (req as unknown as { provenWallet?: unknown }).provenWallet;
  return typeof w === "string" && w.length > 0 ? w.toLowerCase() : null;
}

export interface CapturePrincipal {
  /** A proven identity, or null */
  proven: string | null;
  /** An API-key holder's self-asserted identity, or null */
  key: string | null;
}

/** Both strengths of principal for an /api route. */
export function capturePrincipal(req: FastifyRequest): CapturePrincipal {
  return { proven: provenPrincipal(req), key: authenticatedPrincipal(req) };
}

/**
 * For /a2a, which authenticates outside apiGate: the key the route resolved,
 * or the SIWE session it resolved (a proven wallet).
 */
export function principalFromA2AAuth(
  apiKey: { operatorId?: unknown } | null | undefined,
  session: { address?: unknown } | null | undefined,
): CapturePrincipal {
  const address = session?.address;
  return {
    proven: typeof address === "string" && address.length > 0 ? address.toLowerCase() : null,
    key: principalFromApiKey(apiKey),
  };
}

export interface IntentActor {
  actorId: string;
  actorType: AnalyticsEvent["actorType"];
}

/**
 * The actor to record on an intent event. Flag OFF: the route's legacy actor.
 * Flag ON: a proven identity if there is one, else the key holder, else legacy.
 */
export function intentActor(
  principal: CapturePrincipal,
  legacy: IntentActor,
  env: NodeJS.ProcessEnv = process.env,
): IntentActor {
  if (!isUnmetCaptureEnabled(env)) return legacy;
  if (principal.proven !== null) return { actorId: principal.proven, actorType: VERIFIED_ACTOR_TYPE };
  if (principal.key !== null) return { actorId: principal.key, actorType: KEY_ACTOR_TYPE };
  return legacy;
}

// ── Supply reads ──────────────────────────────────────────────────────────

/** The supply fields the matcher reads. */
export type SupplyCapability = Pick<CapabilityDTO, "available" | "kernelStatus" | "assuranceTiers">;

/** Injected supply reads, so the matcher stays pure and testable. */
export interface SupplyReads {
  findUrlByType(type: string): string | undefined;
  listByType(type: string): Promise<SupplyCapability[]>;
}

/**
 * Wrap reads with a bounded per-type TTL cache for listByType. Staleness is at
 * most `ttlMs`: a capability registered moments ago may still read as absent,
 * which is acceptable for demand telemetry.
 */
export function cachedSupplyReads(
  inner: SupplyReads,
  opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
): SupplyReads {
  const ttl = opts.ttlMs ?? SUPPLY_CACHE_TTL_MS;
  const max = opts.maxEntries ?? SUPPLY_CACHE_MAX_ENTRIES;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; data: SupplyCapability[] }>();
  return {
    findUrlByType: (type) => inner.findUrlByType(type),
    listByType: async (type) => {
      const hit = cache.get(type);
      if (hit !== undefined && now() - hit.at < ttl) return hit.data;
      const data = await inner.listByType(type);
      if (cache.size >= max && !cache.has(type)) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(type, { at: now(), data });
      return data;
    },
  };
}

function facadeSupplyReads(): SupplyReads {
  return {
    findUrlByType: (type) => getCsdRegistry().findUrlByType(type),
    listByType: async (type) => {
      const res = await getCapabilityFacade().listByType(type);
      if (!res.success) throw new Error(`listByType(${type}) failed`);
      return res.data;
    },
  };
}

let sharedReads: SupplyReads | null = null;

/** Production reads: CSD registry plus CapabilityFacade.listByType, cached (process-wide). */
export function defaultSupplyReads(): SupplyReads {
  if (sharedReads === null) sharedReads = cachedSupplyReads(facadeSupplyReads());
  return sharedReads;
}

/** Test helper: drop the process-wide supply cache. */
export function _resetSupplyCacheForTests(): void {
  sharedReads = null;
}

// ── Matching ──────────────────────────────────────────────────────────────

/** Kebab-case slug for a type with no CSD, so the lens can key it as proposed:<slug>. */
function slugify(type: string): string {
  return type
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface UnmetResult {
  unmet: UnmetCapability[];
  /** True when the intent named more than MAX_MATCH_TYPES distinct types */
  truncated: boolean;
}

/**
 * Which requested types no live supply can serve. Live supply decides served
 * versus unmet; the CSD registry only decides the key (URI when a CSD exists,
 * else a kebab slug). At most `maxTypes` distinct types are matched. Returns
 * null when supply could not be read (so nothing is recorded). Never throws.
 */
export async function computeUnmet(
  types: readonly string[],
  opts: { reads: SupplyReads; assuranceTier?: number; maxTypes?: number },
): Promise<UnmetResult | null> {
  try {
    const maxTypes = opts.maxTypes ?? MAX_MATCH_TYPES;
    const distinct: string[] = [];
    const seen = new Set<string>();
    for (const raw of types) {
      const type = raw.trim();
      const dedupeKey = type.toLowerCase();
      if (type === "" || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      distinct.push(type);
    }
    const truncated = distinct.length > maxTypes;
    const out: UnmetCapability[] = [];
    for (const type of distinct.slice(0, maxTypes)) {
      const caps = await opts.reads.listByType(type);
      const url = opts.reads.findUrlByType(type);
      const key = url ?? slugify(type);
      if (key === "") continue;
      if (caps.length === 0) {
        out.push({ capabilityType: key, reason: url ? "no_kernel_offering" : "no_capability_type", supplyCount: 0 });
        continue;
      }
      const live = caps.filter((c) => c.available && (c.kernelStatus === undefined || c.kernelStatus === "online"));
      if (live.length === 0) {
        out.push({ capabilityType: key, reason: "no_capacity", supplyCount: caps.length });
        continue;
      }
      const tier = opts.assuranceTier;
      if (tier !== undefined && !live.some((c) => (c.assuranceTiers as number[]).includes(tier))) {
        out.push({ capabilityType: key, reason: "tier_too_high", supplyCount: live.length });
      }
    }
    return { unmet: out, truncated };
  } catch {
    return null;
  }
}

/**
 * Stamp the capture-time supply verdict on an envelope: "unfulfilled" with the
 * unmet list, "auto" when every matched type is served, unchanged when unknown.
 * A truncated match is recorded as `unmetTruncated: true`.
 */
export function withUnmet(envelope: DemandEnvelope, result: UnmetResult | null): DemandEnvelope {
  if (result === null) return envelope;
  const stamped: DemandEnvelope =
    result.unmet.length === 0
      ? { ...envelope, fulfillmentPath: "auto" }
      : { ...envelope, fulfillmentPath: "unfulfilled", unmet: result.unmet };
  return result.truncated ? { ...stamped, unmetTruncated: true } : stamped;
}

/**
 * Compute unmet types off the response path, then emit. Used by the capture
 * points when the flag is ON. It never rejects; on any failure the envelope is
 * emitted unstamped, which records nothing.
 */
export async function captureUnmetThenEmit(
  envelope: DemandEnvelope,
  emit: (envelope: DemandEnvelope) => void,
  opts: { reads?: SupplyReads; assuranceTier?: number } = {},
): Promise<void> {
  let stamped = envelope;
  try {
    stamped = withUnmet(
      envelope,
      await computeUnmet(envelope.capabilityTypes, { reads: opts.reads ?? defaultSupplyReads(), assuranceTier: opts.assuranceTier }),
    );
  } catch {
    stamped = envelope;
  }
  try {
    emit(stamped);
  } catch {
    // Event-bus failures never affect the request.
  }
}
