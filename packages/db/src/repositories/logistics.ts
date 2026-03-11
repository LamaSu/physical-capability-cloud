import { eq, and } from "drizzle-orm";
import {
  logisticsProviders,
  shipments,
  shipmentTrackingEvents,
  conditionReadings,
  spaceBookings,
  installationOrders,
  installationSteps,
  installationNotes,
  logisticsTimelineEvents,
} from "../schema/index.js";
import type { StoreDB } from "../connection.js";

export class LogisticsRepository {
  constructor(private db: StoreDB) {}

  // ── Providers ───────────────────────────────────────────────────

  findAllProviders() {
    return this.db.select().from(logisticsProviders).all();
  }

  findProviderById(id: string) {
    return this.db.select().from(logisticsProviders).where(eq(logisticsProviders.id, id)).get();
  }

  insertProvider(provider: typeof logisticsProviders.$inferInsert) {
    return this.db.insert(logisticsProviders).values(provider).returning().get();
  }

  // ── Shipments ───────────────────────────────────────────────────

  findAllShipments() {
    return this.db.select().from(shipments).all();
  }

  findShipmentById(id: string) {
    return this.db.select().from(shipments).where(eq(shipments.id, id)).get();
  }

  findShipmentsByStatus(status: string) {
    return this.db.select().from(shipments).where(eq(shipments.status, status)).all();
  }

  insertShipment(shipment: typeof shipments.$inferInsert) {
    return this.db.insert(shipments).values(shipment).returning().get();
  }

  updateShipmentStatus(id: string, status: string) {
    return this.db
      .update(shipments)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(shipments.id, id))
      .returning()
      .get();
  }

  // ── Tracking Events ─────────────────────────────────────────────

  findTrackingEvents(shipmentId: string) {
    return this.db
      .select()
      .from(shipmentTrackingEvents)
      .where(eq(shipmentTrackingEvents.shipmentId, shipmentId))
      .all();
  }

  insertTrackingEvent(event: typeof shipmentTrackingEvents.$inferInsert) {
    return this.db.insert(shipmentTrackingEvents).values(event).returning().get();
  }

  // ── Condition Readings ──────────────────────────────────────────

  findConditionReadings(shipmentId: string) {
    return this.db
      .select()
      .from(conditionReadings)
      .where(eq(conditionReadings.shipmentId, shipmentId))
      .all();
  }

  insertConditionReading(reading: typeof conditionReadings.$inferInsert) {
    return this.db.insert(conditionReadings).values(reading).returning().get();
  }

  // ── Bookings ────────────────────────────────────────────────────

  findAllBookings() {
    return this.db.select().from(spaceBookings).all();
  }

  findBookingById(id: string) {
    return this.db.select().from(spaceBookings).where(eq(spaceBookings.id, id)).get();
  }

  findBookingsByStatus(status: string) {
    return this.db.select().from(spaceBookings).where(eq(spaceBookings.status, status)).all();
  }

  findBookingsBySpace(spaceId: string) {
    return this.db.select().from(spaceBookings).where(eq(spaceBookings.spaceId, spaceId)).all();
  }

  insertBooking(booking: typeof spaceBookings.$inferInsert) {
    return this.db.insert(spaceBookings).values(booking).returning().get();
  }

  updateBookingStatus(id: string, status: string) {
    return this.db
      .update(spaceBookings)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(spaceBookings.id, id))
      .returning()
      .get();
  }

  // ── Installations ───────────────────────────────────────────────

  findAllInstallations() {
    return this.db.select().from(installationOrders).all();
  }

  findInstallationById(id: string) {
    return this.db.select().from(installationOrders).where(eq(installationOrders.id, id)).get();
  }

  findInstallationsByStatus(status: string) {
    return this.db.select().from(installationOrders).where(eq(installationOrders.status, status)).all();
  }

  insertInstallation(installation: typeof installationOrders.$inferInsert) {
    return this.db.insert(installationOrders).values(installation).returning().get();
  }

  updateInstallationStatus(id: string, status: string) {
    return this.db
      .update(installationOrders)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(installationOrders.id, id))
      .returning()
      .get();
  }

  // ── Installation Steps ──────────────────────────────────────────

  findInstallationSteps(installationOrderId: string) {
    return this.db
      .select()
      .from(installationSteps)
      .where(eq(installationSteps.installationOrderId, installationOrderId))
      .all();
  }

  insertInstallationStep(step: typeof installationSteps.$inferInsert) {
    return this.db.insert(installationSteps).values(step).returning().get();
  }

  insertInstallationSteps(steps: (typeof installationSteps.$inferInsert)[]) {
    if (steps.length === 0) return [];
    return this.db.insert(installationSteps).values(steps).returning().all();
  }

  updateInstallationStep(id: string, data: Partial<typeof installationSteps.$inferInsert>) {
    return this.db
      .update(installationSteps)
      .set(data)
      .where(eq(installationSteps.id, id))
      .returning()
      .get();
  }

  // ── Installation Notes ──────────────────────────────────────────

  findInstallationNotes(installationOrderId: string) {
    return this.db
      .select()
      .from(installationNotes)
      .where(eq(installationNotes.installationOrderId, installationOrderId))
      .all();
  }

  insertInstallationNote(note: typeof installationNotes.$inferInsert) {
    return this.db.insert(installationNotes).values(note).returning().get();
  }

  // ── Timeline Events ─────────────────────────────────────────────

  findAllTimelineEvents() {
    return this.db.select().from(logisticsTimelineEvents).all();
  }

  insertTimelineEvent(event: typeof logisticsTimelineEvents.$inferInsert) {
    return this.db.insert(logisticsTimelineEvents).values(event).returning().get();
  }
}
