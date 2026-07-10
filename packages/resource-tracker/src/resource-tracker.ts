/**
 * Transactional, offline, in-memory resource tracker.
 *
 * Two-phase commit gates every consumption, mirroring PyLabRobot's
 * VolumeTracker (a reserve/consume gate that runs *before*
 * `backend.aspirate`, so hardware is never dispatched against a request
 * the tracker hasn't already validated):
 *
 *   1. reserve()  — validates the whole request against the calibrated
 *      CapacityModel AND currently-available capacity (available minus
 *      already-pending reservations). All-or-nothing: if any line item in
 *      the request fails, nothing is held and a typed error is thrown.
 *      On success, capacity is provisionally held (not yet consumed) and
 *      a reservation token is returned.
 *   2. commit()   — the job actually ran: permanently deduct the held
 *      amount from available capacity.
 *   3. rollback() — the job never ran / aborted before consuming
 *      anything: release the hold without touching available capacity.
 *
 * Pure in-memory ledger — no network, no disk, no third-party code.
 */

import { randomUUID } from "node:crypto";
import { CapacityModel, type ResourceBounds } from "./capacity-model.js";
import { InsufficientResourceError, ReservationNotFoundError } from "./errors.js";

export interface Reservation {
  readonly id: string;
  readonly items: ReadonlyMap<string, number>;
  readonly createdAt: string;
}

/** Requested amount per resource name, e.g. `{ filamentGrams: 42 }`. */
export type ReserveRequest = Record<string, number>;

export class ResourceTracker {
  private readonly model: CapacityModel;
  private readonly available = new Map<string, number>();
  private readonly pending = new Map<string, Reservation>();

  constructor(bounds: Record<string, ResourceBounds>, initialAvailable: Record<string, number>) {
    this.model = new CapacityModel(bounds);
    for (const resource of this.model.resources()) {
      this.available.set(resource, initialAvailable[resource] ?? 0);
    }
  }

  /** Total capacity currently on hand for `resource` (committed ledger, ignores pending holds). */
  totalFor(resource: string): number {
    this.model.boundsFor(resource); // throws UnknownResourceError if unregistered
    return this.available.get(resource) ?? 0;
  }

  /** Capacity free to reserve right now: total minus everything already held by pending reservations. */
  availableFor(resource: string): number {
    return this.totalFor(resource) - this.heldFor(resource);
  }

  private heldFor(resource: string): number {
    let held = 0;
    for (const reservation of this.pending.values()) {
      held += reservation.items.get(resource) ?? 0;
    }
    return held;
  }

  /** How many reservations are currently pending (neither committed nor rolled back). */
  pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Phase 1: validate the whole request, then hold it.
   *
   * Throws (and holds nothing) on the first failing line item:
   *   - OutOfCalibratedRangeError / UnknownResourceError from the capacity model
   *   - InsufficientResourceError if the amount is in-range but not currently available
   */
  reserve(request: ReserveRequest): Reservation {
    for (const [resource, amount] of Object.entries(request)) {
      this.model.assertInRange(resource, amount);
      const free = this.availableFor(resource);
      if (amount > free) {
        throw new InsufficientResourceError(resource, amount, free);
      }
    }

    const reservation: Reservation = {
      id: randomUUID(),
      items: new Map(Object.entries(request)),
      createdAt: new Date().toISOString(),
    };
    this.pending.set(reservation.id, reservation);
    return reservation;
  }

  /** Phase 2a: the job ran — permanently deduct the reservation from available capacity. */
  commit(reservationId: string): void {
    const reservation = this.pending.get(reservationId);
    if (!reservation) throw new ReservationNotFoundError(reservationId);
    for (const [resource, amount] of reservation.items) {
      this.available.set(resource, this.totalFor(resource) - amount);
    }
    this.pending.delete(reservationId);
  }

  /** Phase 2b: the job never ran / aborted — release the hold, consume nothing. */
  rollback(reservationId: string): void {
    if (!this.pending.has(reservationId)) throw new ReservationNotFoundError(reservationId);
    this.pending.delete(reservationId);
  }
}
