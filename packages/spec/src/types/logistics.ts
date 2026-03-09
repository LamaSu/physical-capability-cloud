/**
 * Physical Logistics & Space Operations types.
 *
 * Covers the full lifecycle: equipment purchased -> shipped -> space booked ->
 * delivered -> installation order -> setup steps -> kernel online.
 */

import type { Address, Amount, Currency, GeoLocation, Id, Timestamp, TimeWindow } from "./common.js";

// ---------------------------------------------------------------------------
// Logistics Provider
// ---------------------------------------------------------------------------

export type ProviderServiceType =
  | "freight_shipping"
  | "white_glove_delivery"
  | "rigging_heavy_lift"
  | "equipment_installation"
  | "calibration"
  | "decommission_removal"
  | "storage_warehousing"
  | (string & {});

/** A company or individual that provides logistics services */
export interface LogisticsProvider {
  id: Id;
  name: string;
  description: string;
  serviceTypes: ProviderServiceType[];
  coverageArea: {
    regions: string[];           // "Northeast US", "Bay Area", "Germany"
    maxDistanceKm?: number;
  };
  fleetCapabilities: {
    maxWeightKg: number;
    maxDimensionsCm: { width: number; depth: number; height: number };
    liftGate: boolean;
    climateControlled: boolean;
    hazmatCertified: boolean;
  };
  contact: {
    email: string;
    phone: string;
    website?: string;
  };
  walletAddress?: Address;
  rating: number;                // 0-5
  completedJobs: number;
  insuranceCoverage: Amount;
  insuranceCurrency: Currency;
  createdAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Shipment
// ---------------------------------------------------------------------------

export type ShipmentStatus =
  | "quote_requested"
  | "quoted"
  | "booked"
  | "pickup_scheduled"
  | "picked_up"
  | "in_transit"
  | "at_hub"
  | "out_for_delivery"
  | "delivered"
  | "inspected"
  | "failed"
  | "cancelled";

export type ShipmentPriority = "standard" | "expedited" | "rush";

/** A shipment tracking an equipment move from origin to destination */
export interface Shipment {
  id: Id;
  machineRegistrationId?: Id;    // Links to MachineRegistration if onboarding
  equipmentDescription: string;
  providerId: Id;
  priority: ShipmentPriority;
  status: ShipmentStatus;

  origin: ShipmentLocation;
  destination: ShipmentLocation;
  currentLocation?: GeoLocation;

  package: PackageSpec;
  quote?: DeliveryQuote;

  pickupWindow: TimeWindow;
  estimatedDelivery?: Timestamp;
  actualPickup?: Timestamp;
  actualDelivery?: Timestamp;

  trackingEvents: ShipmentTrackingEvent[];
  conditionReadings: ConditionReading[];

  specialInstructions?: string;
  requiresLiftGate: boolean;
  requiresInsideDelivery: boolean;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ShipmentLocation {
  label: string;                 // "Prusa HQ", "Brooklyn Maker Hub"
  address: string;
  geo?: GeoLocation;
  contactName: string;
  contactPhone: string;
  accessNotes?: string;          // "Ring bell at loading dock B"
}

export interface PackageSpec {
  weightKg: number;
  dimensionsCm: { width: number; depth: number; height: number };
  palletized: boolean;
  crateRequired: boolean;
  fragile: boolean;
  hazmat: boolean;
  itemCount: number;
  description?: string;
}

export interface DeliveryQuote {
  id: Id;
  providerId: Id;
  shipmentId: Id;
  price: Amount;
  currency: Currency;
  transitDays: { min: number; max: number };
  validUntil: Timestamp;
  includesInsurance: boolean;
  insuranceValue?: Amount;
  notes?: string;
}

export interface ShipmentTrackingEvent {
  id: Id;
  timestamp: Timestamp;
  status: ShipmentStatus;
  location?: GeoLocation;
  locationLabel?: string;
  message: string;
  evidencePhotos?: string[];
  signedBy?: string;
}

export interface ConditionReading {
  timestamp: Timestamp;
  temperature?: number;          // Celsius
  humidity?: number;             // 0-100%
  shock?: number;                // g-force
  tilt?: number;                 // degrees
}

// ---------------------------------------------------------------------------
// Space Booking
// ---------------------------------------------------------------------------

export type BookingStatus =
  | "requested"
  | "confirmed"
  | "preparing"
  | "equipment_arriving"
  | "active"
  | "completed"
  | "cancelled";

/** A reservation for a slot at a HostingSpace */
export interface SpaceBooking {
  id: Id;
  spaceId: Id;
  spaceName: string;
  slotPosition?: string;         // "Bay 3", "Zone A-7"
  machineRegistrationId?: Id;
  bookingContact: Address;

  status: BookingStatus;
  period: TimeWindow;            // Start/end of booking
  monthlyRate: Amount;
  currency: Currency;
  depositAmount?: Amount;

  requirements: {
    powerCircuits: number;
    compressedAir: boolean;
    networkPorts: number;
    floorProtection: boolean;
    additionalNotes?: string;
  };

  moveInDate?: Timestamp;
  moveOutDate?: Timestamp;
  shipmentId?: Id;               // Links to incoming Shipment
  installationOrderId?: Id;      // Links to InstallationOrder

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Installation Order
// ---------------------------------------------------------------------------

export type InstallationStatus =
  | "draft"
  | "scheduled"
  | "in_progress"
  | "blocked"
  | "completed"
  | "cancelled";

export type InstallationStepType =
  | "receive_delivery"
  | "uncrate_inspect"
  | "position_anchor"
  | "connect_power"
  | "connect_network"
  | "connect_utilities"
  | "safety_inspection"
  | "calibrate"
  | "test_run"
  | "commission"
  | (string & {});

export type InstallationStepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "skipped"
  | "failed"
  | "blocked";

/** A work order for installing equipment at a space */
export interface InstallationOrder {
  id: Id;
  bookingId: Id;
  spaceId: Id;
  machineRegistrationId?: Id;
  equipmentDescription: string;

  status: InstallationStatus;
  assignedTo: InstallationAssignee;
  scheduledDate: Timestamp;
  estimatedDurationHours: number;
  actualStartedAt?: Timestamp;
  actualCompletedAt?: Timestamp;

  steps: InstallationStep[];
  notes: InstallationNote[];

  kernelId?: Id;                 // Assigned kernel ID once commissioned

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface InstallationAssignee {
  type: "operator" | "vendor" | "contractor" | "provider";
  name: string;
  contactEmail: string;
  contactPhone: string;
  companyName?: string;
  providerId?: Id;               // Links to LogisticsProvider
}

export interface InstallationStep {
  id: Id;
  type: InstallationStepType;
  label: string;
  description: string;
  status: InstallationStepStatus;
  order: number;                 // Sequence position
  estimatedMinutes: number;
  actualMinutes?: number;
  startedAt?: Timestamp;
  completedAt?: Timestamp;
  completedBy?: string;
  evidencePhotos?: string[];
  notes?: string;
  requiresSignoff: boolean;
  signedOffBy?: string;
}

export interface InstallationNote {
  id: Id;
  timestamp: Timestamp;
  author: string;
  message: string;
  type: "info" | "warning" | "issue" | "resolution";
}

// ---------------------------------------------------------------------------
// Logistics Timeline (unified view across shipments, bookings, installations)
// ---------------------------------------------------------------------------

export type LogisticsEventType =
  | "shipment_created"
  | "shipment_picked_up"
  | "shipment_in_transit"
  | "shipment_delivered"
  | "booking_confirmed"
  | "booking_move_in"
  | "installation_started"
  | "installation_step_completed"
  | "installation_completed"
  | "kernel_commissioned"
  | (string & {});

export interface LogisticsTimelineEvent {
  id: Id;
  timestamp: Timestamp;
  type: LogisticsEventType;
  title: string;
  description: string;
  relatedIds: {
    shipmentId?: Id;
    bookingId?: Id;
    installationId?: Id;
    machineRegistrationId?: Id;
    kernelId?: Id;
  };
}
