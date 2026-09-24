/**
 * R13 over HTTP: issuing and reading one-use budget reservations (operator decision #2240, amended by
 * #2301/#2302). The accept route (#391) consumes them.
 *
 *   POST /api/settlement/reservations                  issue a reservation for the authenticated principal
 *   POST /api/settlement/reservations/:id/children     MC 9: a composite operator issues a CHILD reservation
 *                                                      carved from one unit of a sealed parent deal
 *   GET  /api/settlement/reservations/:id              read one of the principal's own reservations
 *
 * Authority. Every term that grants money authority is the server's; the body names only what the
 * principal asks for.
 *   - principal: the API gate's identity (`authenticatedPrincipal`), never a body field.
 *   - payer: the wallet bound to that principal (`payerFor`). A request's `requesterWallet` is caller
 *     data and is never used.
 *   - ceiling: the request's authorized ceiling, in EXACT base units of its currency
 *     (`requestCeiling`). It must be the principal's own request; another principal's request is a 404,
 *     exactly like a missing one.
 *   - id, issue time and expiry: server-generated; expiry is bounded.
 * A body `reservationId`, `principal`, `payer` or `ceiling` is ignored.
 *
 * Gating. `/api/settlement/` is a money-path prefix: the scope checker default-denies its writes (after
 * WP-A, #326, a `settlement` or `admin` scope is required). On top, issue answers 503 and writes nothing
 * until EVERY production piece exists:
 *   - the reservation store (its table is operator decision #2240, PR #402);
 *   - an exact request ceiling. #335's `authorizedCeiling` is a JS number that defaults to 1000, so it is
 *     not usable as money authority until it is exact base units with no default;
 *   - the payer-wallet binding (gateway N1/N21).
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { BudgetReservation, BudgetReservationStore, ParentUnitTerms } from "@pcc/store";
import { authenticatedPrincipal } from "./agent-plans.js";

/** The request's authorized ceiling, exact, for the principal who owns the request; null otherwise. */
export type RequestCeiling = (requestId: string, principal: string) => { currency: string; ceilingBaseUnits: bigint } | null;

export interface ReservationIssueWiring {
  store: BudgetReservationStore;
  requestCeiling: RequestCeiling;
  /** The paying wallet bound to the principal, or null when none is bound. */
  payerFor(principal: string): string | null;
  /** Unix seconds. */
  now(): number;
  /** A fresh server-side id. */
  newId(): string;
}

/**
 * MC 9: the terms of one unit of a SEALED parent deal, read by the server from where the sealed deal is
 * stored: its operator, its net n, and its reclaimAt. Null when the parent reservation or unit is unknown.
 * The sealed deal itself is not persisted yet (a proposed amendment to operator decision #2240), so
 * production answers 503.
 */
export type ParentUnitResolver = (parentReservationId: string, unit: string) => ParentUnitTerms | null;

export interface ReservationRouteOptions {
  /** Test injection. Production: `productionReservationWiring`. */
  wiring?: () => ReservationIssueWiring | { missing: string[] };
  /** Test injection for MC 9 child issuance. Production: missing (no sealed-deal store yet). */
  parentUnits?: () => ParentUnitResolver | { missing: string[] };
}

export const MIN_RESERVATION_TTL_SEC = 60;
export const MAX_RESERVATION_TTL_SEC = 7 * 24 * 3600;
const BASE_UNITS = /^[1-9][0-9]{0,77}$/;
const TEXT_ID = /^[\x21-\x7e]{1,128}$/;

export function productionReservationWiring(): { missing: string[] } {
  return {
    missing: [
      "reservation-store (R13; operator decision #2240, PR #402)",
      "request-ceiling in exact base units, no default (#335's authorizedCeiling is a JS number defaulting to 1000)",
      "payer-wallet binding (gateway N1/N21)",
    ],
  };
}

/** The unit reference a child names: `${jobId}#${milestoneIndex}` of the parent's sealed deal. */
const UNIT_REF = /^[\x21-\x7e]{1,300}#(0|[1-9][0-9]?)$/;

/** A reservation as JSON: exact amounts as decimal strings. */
function view(r: BudgetReservation) {
  return {
    reservationId: r.reservationId,
    requestId: r.requestId,
    currency: r.currency,
    maxAmountBaseUnits: r.maxAmountBaseUnits.toString(),
    purpose: r.purpose,
    minTier: r.minTier,
    payerAddress: r.payerAddress,
    parentReservationId: r.parentReservationId,
    parentUnit: r.parentUnit,
    expiresAt: r.expiresAt,
    state: r.state,
    consumedDealDigest: r.consumedDealDigest,
    createdAt: r.createdAt,
    consumedAt: r.consumedAt,
  };
}

/** The issue body, read once into owned primitives; null when it is not a well-formed request. */
function readIssueBody(body: unknown):
  | { requestId: string; currency: string; maxAmountBaseUnits: bigint; purpose: string; expiresInSec: number; minTier: number | null }
  | null {
  try {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
    const b = body as Record<string, unknown>;
    const requestId: unknown = b.requestId;
    const currency: unknown = b.currency;
    const amount: unknown = b.maxAmountBaseUnits;
    const purpose: unknown = b.purpose;
    const ttl: unknown = b.expiresInSec;
    const minTier: unknown = b.minTier;
    if (typeof requestId !== "string" || !TEXT_ID.test(requestId)) return null;
    if (typeof currency !== "string" || !TEXT_ID.test(currency)) return null;
    // Exact base units only: a canonical decimal STRING, never a JSON number (which would be a float).
    if (typeof amount !== "string" || !BASE_UNITS.test(amount)) return null;
    if (typeof purpose !== "string" || purpose.length === 0 || purpose.length > 256) return null;
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < MIN_RESERVATION_TTL_SEC || ttl > MAX_RESERVATION_TTL_SEC) return null;
    if (!(minTier === undefined || minTier === null || (typeof minTier === "number" && Number.isInteger(minTier) && minTier >= 0 && minTier <= 3))) return null;
    return { requestId, currency, maxAmountBaseUnits: BigInt(amount), purpose, expiresInSec: ttl, minTier: (minTier as number | null | undefined) ?? null };
  } catch {
    return null;
  }
}

export async function reservationRoutes(app: FastifyInstance, opts: ReservationRouteOptions = {}): Promise<void> {
  const wiringOf = opts.wiring ?? productionReservationWiring;
  const parentUnitsOf = opts.parentUnits ?? (() => ({ missing: ["sealed-deal store for parent unit terms (MC 9; proposed amendment to operator decision #2240)"] }));

  app.post("/api/settlement/reservations", async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = authenticatedPrincipal(req);
    if (principal === null) return reply.status(401).send({ error: "authentication-required" });
    try {
      const wiring = wiringOf();
      if ("missing" in wiring) return reply.status(503).send({ error: "issue-not-wired", missing: [...wiring.missing] });
      const body = readIssueBody(req.body);
      if (body === null) return reply.status(400).send({ error: "malformed-body" });
      const ceiling = wiring.requestCeiling(body.requestId, principal);
      if (ceiling === null) return reply.status(404).send({ error: "request-not-found" }); // missing, or not this principal's
      if (ceiling.currency !== body.currency) return reply.status(422).send({ error: "currency-mismatch" });
      const payer = wiring.payerFor(principal);
      if (payer === null) return reply.status(409).send({ error: "no-payer-wallet" });
      const now = Math.floor(wiring.now());
      const result = wiring.store.issue({
        reservationId: wiring.newId(),
        principal,
        payerAddress: payer,
        currency: body.currency,
        maxAmountBaseUnits: body.maxAmountBaseUnits,
        purpose: body.purpose,
        requestId: body.requestId,
        minTier: body.minTier,
        expiresAt: now + body.expiresInSec,
        now,
        requestCeilingBaseUnits: ceiling.ceilingBaseUnits,
      });
      if (!result.ok) {
        if (result.reason === "over-request-ceiling") return reply.status(409).send({ error: "over-request-ceiling" });
        if (result.reason === "invalid-input") return reply.status(400).send({ error: "malformed-body" });
        throw new Error(`reservation issue refused: ${result.reason}`); // duplicate id or a parent refusal: a server fault here
      }
      return reply.status(201).send({ reservation: view(result.reservation) });
    } catch (err) {
      req.log.error({ err }, "reservations issue: server fault");
      return reply.status(500).send({ error: "internal-error" });
    }
  });

  /**
   * MC 9 (#2301): a composite operator subcontracts part of a unit it was paid for. The child is funded
   * by its OWN wallet (never the parent payer's), is held by the parent unit's operator only, and all
   * children of one unit fit that unit's net n and expire by its reclaimAt. The store enforces every
   * bound in one immediate transaction. The child's request must be the operator's own, in the same
   * currency. A principal who is not the parent unit's operator gets the same 404 as a missing parent,
   * so the route is not an oracle for other principals' deals.
   */
  app.post("/api/settlement/reservations/:id/children", async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = authenticatedPrincipal(req);
    if (principal === null) return reply.status(401).send({ error: "authentication-required" });
    try {
      const wiring = wiringOf();
      const parentUnits = parentUnitsOf();
      const missing = [...("missing" in wiring ? wiring.missing : []), ...("missing" in parentUnits ? parentUnits.missing : [])];
      if (missing.length > 0 || "missing" in wiring || "missing" in parentUnits) return reply.status(503).send({ error: "issue-not-wired", missing });
      const parentId = (req.params as { id?: unknown }).id;
      const raw: unknown = req.body;
      const unit = typeof raw === "object" && raw !== null ? (raw as { unit?: unknown }).unit : undefined;
      const body = readIssueBody(raw);
      if (body === null || typeof parentId !== "string" || typeof unit !== "string" || !UNIT_REF.test(unit)) {
        return reply.status(400).send({ error: "malformed-body" });
      }
      const terms = parentUnits(parentId, unit);
      // Only the parent unit's operator may carve a child. Anyone else gets exactly the missing-parent
      // answer, BEFORE any other check, so no later answer can reveal that the parent exists. The store
      // re-checks it atomically.
      if (terms === null || terms.operator.toLowerCase() !== principal.toLowerCase()) {
        return reply.status(404).send({ error: "parent-unit-not-found" });
      }
      // The child's own request: the operator's, in the same currency. Its ceiling does not bound a child;
      // the parent unit does.
      const request = wiring.requestCeiling(body.requestId, principal);
      if (request === null) return reply.status(404).send({ error: "request-not-found" });
      if (request.currency !== body.currency) return reply.status(422).send({ error: "currency-mismatch" });
      const payer = wiring.payerFor(principal);
      if (payer === null) return reply.status(409).send({ error: "no-payer-wallet" });
      const now = Math.floor(wiring.now());
      const result = wiring.store.issue({
        reservationId: wiring.newId(),
        principal,
        payerAddress: payer,
        currency: body.currency,
        maxAmountBaseUnits: body.maxAmountBaseUnits,
        purpose: body.purpose,
        requestId: body.requestId,
        minTier: body.minTier,
        expiresAt: now + body.expiresInSec,
        now,
        requestCeilingBaseUnits: 0n,
        parent: terms,
      });
      if (!result.ok) {
        switch (result.reason) {
          case "parent-not-found":
          case "child-principal-not-parent-operator":
            return reply.status(404).send({ error: "parent-unit-not-found" });
          case "parent-not-consumed":
            return reply.status(409).send({ error: "parent-deal-not-sealed" });
          case "parent-currency-mismatch":
            return reply.status(422).send({ error: "currency-mismatch" });
          case "child-payer-is-parent-payer":
            return reply.status(409).send({ error: "child-payer-is-parent-payer" });
          case "over-parent-unit":
            return reply.status(409).send({ error: "over-parent-unit" });
          case "child-outlives-parent-unit":
            return reply.status(422).send({ error: "child-outlives-parent-unit" });
          case "invalid-input":
            return reply.status(400).send({ error: "malformed-body" });
          default:
            throw new Error(`child reservation refused: ${result.reason}`);
        }
      }
      return reply.status(201).send({ reservation: view(result.reservation) });
    } catch (err) {
      req.log.error({ err }, "reservations child issue: server fault");
      return reply.status(500).send({ error: "internal-error" });
    }
  });

  app.get("/api/settlement/reservations/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = authenticatedPrincipal(req);
    if (principal === null) return reply.status(401).send({ error: "authentication-required" });
    try {
      const wiring = wiringOf();
      if ("missing" in wiring) return reply.status(503).send({ error: "issue-not-wired", missing: [...wiring.missing] });
      const id = (req.params as { id?: unknown }).id;
      const r = typeof id === "string" ? wiring.store.findById(id) : null;
      // Another principal's reservation is answered exactly like a missing one.
      if (r === null || r.principal !== principal) return reply.status(404).send({ error: "reservation-not-found" });
      return reply.status(200).send({ reservation: view(r) });
    } catch (err) {
      req.log.error({ err }, "reservations read: server fault");
      return reply.status(500).send({ error: "internal-error" });
    }
  });
}

/** Server-generated reservation ids. */
export function newReservationId(): string {
  return `resv_${randomUUID()}`;
}
