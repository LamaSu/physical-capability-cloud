import type {
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

export type ProviderRow = typeof logisticsProviders.$inferSelect;
export type ProviderInsert = typeof logisticsProviders.$inferInsert;
export type ShipmentRow = typeof shipments.$inferSelect;
export type ShipmentInsert = typeof shipments.$inferInsert;
export type TrackingEventRow = typeof shipmentTrackingEvents.$inferSelect;
export type TrackingEventInsert = typeof shipmentTrackingEvents.$inferInsert;
export type ConditionReadingRow = typeof conditionReadings.$inferSelect;
export type ConditionReadingInsert = typeof conditionReadings.$inferInsert;
export type BookingRow = typeof spaceBookings.$inferSelect;
export type BookingInsert = typeof spaceBookings.$inferInsert;
export type InstallationRow = typeof installationOrders.$inferSelect;
export type InstallationInsert = typeof installationOrders.$inferInsert;
export type InstallationStepRow = typeof installationSteps.$inferSelect;
export type InstallationStepInsert = typeof installationSteps.$inferInsert;
export type InstallationNoteRow = typeof installationNotes.$inferSelect;
export type InstallationNoteInsert = typeof installationNotes.$inferInsert;
export type TimelineEventRow = typeof logisticsTimelineEvents.$inferSelect;
export type TimelineEventInsert = typeof logisticsTimelineEvents.$inferInsert;

export interface ILogisticsRepository {
  // Providers
  findAllProviders(): ProviderRow[];
  findProviderById(id: string): ProviderRow | undefined;
  insertProvider(provider: ProviderInsert): ProviderRow | undefined;
  // Shipments
  findAllShipments(): ShipmentRow[];
  findShipmentById(id: string): ShipmentRow | undefined;
  findShipmentsByStatus(status: string): ShipmentRow[];
  insertShipment(shipment: ShipmentInsert): ShipmentRow | undefined;
  updateShipmentStatus(id: string, status: string): ShipmentRow | undefined;
  // Tracking Events
  findTrackingEvents(shipmentId: string): TrackingEventRow[];
  insertTrackingEvent(event: TrackingEventInsert): TrackingEventRow | undefined;
  // Condition Readings
  findConditionReadings(shipmentId: string): ConditionReadingRow[];
  insertConditionReading(reading: ConditionReadingInsert): ConditionReadingRow | undefined;
  // Bookings
  findAllBookings(): BookingRow[];
  findBookingById(id: string): BookingRow | undefined;
  findBookingsByStatus(status: string): BookingRow[];
  findBookingsBySpace(spaceId: string): BookingRow[];
  insertBooking(booking: BookingInsert): BookingRow | undefined;
  updateBookingStatus(id: string, status: string): BookingRow | undefined;
  // Installations
  findAllInstallations(): InstallationRow[];
  findInstallationById(id: string): InstallationRow | undefined;
  findInstallationsByStatus(status: string): InstallationRow[];
  insertInstallation(installation: InstallationInsert): InstallationRow | undefined;
  updateInstallationStatus(id: string, status: string): InstallationRow | undefined;
  // Installation Steps
  findInstallationSteps(installationOrderId: string): InstallationStepRow[];
  insertInstallationStep(step: InstallationStepInsert): InstallationStepRow | undefined;
  insertInstallationSteps(steps: InstallationStepInsert[]): InstallationStepRow[];
  updateInstallationStep(id: string, data: Partial<InstallationStepInsert>): InstallationStepRow | undefined;
  // Installation Notes
  findInstallationNotes(installationOrderId: string): InstallationNoteRow[];
  insertInstallationNote(note: InstallationNoteInsert): InstallationNoteRow | undefined;
  // Timeline Events
  findAllTimelineEvents(): TimelineEventRow[];
  insertTimelineEvent(event: TimelineEventInsert): TimelineEventRow | undefined;
}
