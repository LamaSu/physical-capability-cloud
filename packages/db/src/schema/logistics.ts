import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

/** A company or individual that provides logistics services */
export const logisticsProviders = sqliteTable("logistics_providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  serviceTypes: text("service_types", { mode: "json" }).notNull().$type<string[]>(),
  coverageArea: text("coverage_area", { mode: "json" }).notNull().$type<{
    regions: string[];
    maxDistanceKm?: number;
  }>(),
  fleetCapabilities: text("fleet_capabilities", { mode: "json" }).notNull().$type<{
    maxWeightKg: number;
    maxDimensionsCm: { width: number; depth: number; height: number };
    liftGate: boolean;
    climateControlled: boolean;
    hazmatCertified: boolean;
  }>(),
  contact: text("contact", { mode: "json" }).notNull().$type<{
    email: string;
    phone: string;
    website?: string;
  }>(),
  walletAddress: text("wallet_address"),
  rating: real("rating").notNull().default(0),
  completedJobs: integer("completed_jobs").notNull().default(0),
  insuranceCoverage: text("insurance_coverage").notNull(),
  insuranceCurrency: text("insurance_currency").notNull(),
  createdAt: text("created_at").notNull(),
});

/** A shipment tracking an equipment move */
export const shipments = sqliteTable("shipments", {
  id: text("id").primaryKey(),
  machineRegistrationId: text("machine_registration_id"),
  equipmentDescription: text("equipment_description").notNull(),
  providerId: text("provider_id").notNull().references(() => logisticsProviders.id),
  priority: text("priority").notNull(), // "standard" | "expedited" | "rush"
  status: text("status").notNull(), // ShipmentStatus

  origin: text("origin", { mode: "json" }).notNull().$type<{
    label: string;
    address: string;
    geo?: { lat: number; lng: number };
    contactName: string;
    contactPhone: string;
    accessNotes?: string;
  }>(),
  destination: text("destination", { mode: "json" }).notNull().$type<{
    label: string;
    address: string;
    geo?: { lat: number; lng: number };
    contactName: string;
    contactPhone: string;
    accessNotes?: string;
  }>(),
  currentLocation: text("current_location", { mode: "json" }).$type<{ lat: number; lng: number }>(),

  package: text("package", { mode: "json" }).notNull().$type<{
    weightKg: number;
    dimensionsCm: { width: number; depth: number; height: number };
    palletized: boolean;
    crateRequired: boolean;
    fragile: boolean;
    hazmat: boolean;
    itemCount: number;
    description?: string;
  }>(),
  quote: text("quote", { mode: "json" }).$type<{
    id: string;
    providerId: string;
    shipmentId: string;
    price: string;
    currency: string;
    transitDays: { min: number; max: number };
    validUntil: string;
    includesInsurance: boolean;
    insuranceValue?: string;
    notes?: string;
  }>(),

  pickupWindow: text("pickup_window", { mode: "json" }).notNull().$type<{ start: string; end: string }>(),
  estimatedDelivery: text("estimated_delivery"),
  actualPickup: text("actual_pickup"),
  actualDelivery: text("actual_delivery"),

  specialInstructions: text("special_instructions"),
  requiresLiftGate: integer("requires_lift_gate", { mode: "boolean" }).notNull(),
  requiresInsideDelivery: integer("requires_inside_delivery", { mode: "boolean" }).notNull(),

  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Shipment tracking event */
export const shipmentTrackingEvents = sqliteTable("shipment_tracking_events", {
  id: text("id").primaryKey(),
  shipmentId: text("shipment_id").notNull().references(() => shipments.id),
  timestamp: text("timestamp").notNull(),
  status: text("status").notNull(), // ShipmentStatus
  location: text("location", { mode: "json" }).$type<{ lat: number; lng: number }>(),
  locationLabel: text("location_label"),
  message: text("message").notNull(),
  evidencePhotos: text("evidence_photos", { mode: "json" }).$type<string[]>(),
  signedBy: text("signed_by"),
});

/** Condition reading from shipment sensors */
export const conditionReadings = sqliteTable("condition_readings", {
  id: text("id").primaryKey(),
  shipmentId: text("shipment_id").notNull().references(() => shipments.id),
  timestamp: text("timestamp").notNull(),
  temperature: real("temperature"),
  humidity: real("humidity"),
  shock: real("shock"),
  tilt: real("tilt"),
});

/** A reservation for a slot at a HostingSpace */
export const spaceBookings = sqliteTable("space_bookings", {
  id: text("id").primaryKey(),
  spaceId: text("space_id").notNull(),
  spaceName: text("space_name").notNull(),
  slotPosition: text("slot_position"),
  machineRegistrationId: text("machine_registration_id"),
  bookingContact: text("booking_contact").notNull(),

  status: text("status").notNull(), // BookingStatus
  period: text("period", { mode: "json" }).notNull().$type<{ start: string; end: string }>(),
  pricingPhase: text("pricing_phase").notNull().default("free"), // "free" | "assessed"
  monthlyRate: text("monthly_rate").notNull(),
  pricePerSqftMonth: text("price_per_sqft_month"),
  sqft: integer("sqft"),
  currency: text("currency").notNull(),
  depositAmount: text("deposit_amount"),

  requirements: text("requirements", { mode: "json" }).notNull().$type<{
    powerCircuits: number;
    compressedAir: boolean;
    networkPorts: number;
    floorProtection: boolean;
    additionalNotes?: string;
  }>(),

  moveInDate: text("move_in_date"),
  moveOutDate: text("move_out_date"),
  shipmentId: text("shipment_id"),
  installationOrderId: text("installation_order_id"),

  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** A work order for installing equipment at a space */
export const installationOrders = sqliteTable("installation_orders", {
  id: text("id").primaryKey(),
  bookingId: text("booking_id").notNull().references(() => spaceBookings.id),
  spaceId: text("space_id").notNull(),
  machineRegistrationId: text("machine_registration_id"),
  equipmentDescription: text("equipment_description").notNull(),

  status: text("status").notNull(), // InstallationStatus
  assignedTo: text("assigned_to", { mode: "json" }).notNull().$type<{
    type: string;
    name: string;
    contactEmail: string;
    contactPhone: string;
    companyName?: string;
    providerId?: string;
  }>(),
  scheduledDate: text("scheduled_date").notNull(),
  estimatedDurationHours: real("estimated_duration_hours").notNull(),
  actualStartedAt: text("actual_started_at"),
  actualCompletedAt: text("actual_completed_at"),

  kernelId: text("kernel_id"),

  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** A step in the installation checklist */
export const installationSteps = sqliteTable("installation_steps", {
  id: text("id").primaryKey(),
  installationOrderId: text("installation_order_id").notNull().references(() => installationOrders.id),
  type: text("type").notNull(), // InstallationStepType
  label: text("label").notNull(),
  description: text("description").notNull(),
  status: text("status").notNull(), // InstallationStepStatus
  order: integer("order").notNull(),
  estimatedMinutes: integer("estimated_minutes").notNull(),
  actualMinutes: integer("actual_minutes"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  completedBy: text("completed_by"),
  evidencePhotos: text("evidence_photos", { mode: "json" }).$type<string[]>(),
  notes: text("notes"),
  requiresSignoff: integer("requires_signoff", { mode: "boolean" }).notNull(),
  signedOffBy: text("signed_off_by"),
});

/** A note on an installation order */
export const installationNotes = sqliteTable("installation_notes", {
  id: text("id").primaryKey(),
  installationOrderId: text("installation_order_id").notNull().references(() => installationOrders.id),
  timestamp: text("timestamp").notNull(),
  author: text("author").notNull(),
  message: text("message").notNull(),
  type: text("type").notNull(), // "info" | "warning" | "issue" | "resolution"
});

/** Unified logistics timeline event */
export const logisticsTimelineEvents = sqliteTable("logistics_timeline_events", {
  id: text("id").primaryKey(),
  timestamp: text("timestamp").notNull(),
  type: text("type").notNull(), // LogisticsEventType
  title: text("title").notNull(),
  description: text("description").notNull(),
  relatedIds: text("related_ids", { mode: "json" }).notNull().$type<{
    shipmentId?: string;
    bookingId?: string;
    installationId?: string;
    machineRegistrationId?: string;
    kernelId?: string;
  }>(),
});
