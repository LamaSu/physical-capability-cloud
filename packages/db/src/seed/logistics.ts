import type { StoreDB } from "../connection.js";
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

/**
 * Seeds logistics data: providers, shipments, bookings, installations, timeline.
 */
export function seedLogistics(db: StoreDB): void {
  // ── Logistics Providers ─────────────────────────────────────────

  db.insert(logisticsProviders)
    .values([
      {
        id: "prov-riggers",
        name: "Northeast Riggers & Movers",
        description: "Specializing in heavy industrial equipment transport and rigging across the Northeast corridor.",
        serviceTypes: ["freight_shipping", "white_glove_delivery", "rigging_heavy_lift", "equipment_installation"],
        coverageArea: { regions: ["Northeast US", "Mid-Atlantic"], maxDistanceKm: 800 },
        fleetCapabilities: {
          maxWeightKg: 20000,
          maxDimensionsCm: { width: 400, depth: 600, height: 350 },
          liftGate: true,
          climateControlled: false,
          hazmatCertified: false,
        },
        contact: { email: "dispatch@neriggers.com", phone: "+1-718-555-0142", website: "https://neriggers.example.com" },
        walletAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
        rating: 4.8,
        completedJobs: 312,
        insuranceCoverage: "2000000.00",
        insuranceCurrency: "USDC",
        createdAt: "2024-01-15T00:00:00Z",
      },
      {
        id: "prov-precision",
        name: "Precision Equipment Logistics",
        description: "White-glove delivery and calibration services for precision manufacturing equipment.",
        serviceTypes: ["white_glove_delivery", "calibration", "equipment_installation"],
        coverageArea: { regions: ["Bay Area", "Pacific Northwest"], maxDistanceKm: 500 },
        fleetCapabilities: {
          maxWeightKg: 5000,
          maxDimensionsCm: { width: 250, depth: 300, height: 250 },
          liftGate: true,
          climateControlled: true,
          hazmatCertified: false,
        },
        contact: { email: "ops@precisionlogistics.com", phone: "+1-415-555-0198" },
        walletAddress: "0xdddddddddddddddddddddddddddddddddddddd",
        rating: 4.9,
        completedJobs: 87,
        insuranceCoverage: "500000.00",
        insuranceCurrency: "USDC",
        createdAt: "2025-03-01T00:00:00Z",
      },
      {
        id: "prov-flatbed",
        name: "Industrial Flatbed Express",
        description: "Nationwide flatbed and oversized equipment shipping with real-time GPS tracking.",
        serviceTypes: ["freight_shipping", "storage_warehousing"],
        coverageArea: { regions: ["Continental US"], maxDistanceKm: 5000 },
        fleetCapabilities: {
          maxWeightKg: 40000,
          maxDimensionsCm: { width: 260, depth: 1460, height: 280 },
          liftGate: false,
          climateControlled: false,
          hazmatCertified: true,
        },
        contact: { email: "freight@flatbedexpress.com", phone: "+1-800-555-0177", website: "https://flatbedexpress.example.com" },
        rating: 4.3,
        completedJobs: 1240,
        insuranceCoverage: "5000000.00",
        insuranceCurrency: "USDC",
        createdAt: "2023-06-20T00:00:00Z",
      },
    ])
    .run();

  // ── Shipments ───────────────────────────────────────────────────

  db.insert(shipments)
    .values([
      {
        id: "shp-001",
        machineRegistrationId: "reg-001",
        equipmentDescription: "Prusa MK4 + MMU3 + Enclosure",
        providerId: "prov-precision",
        priority: "standard",
        status: "in_transit",
        origin: {
          label: "Prusa Research HQ",
          address: "Partyz\u00e1nsk\u00e1 188/7A, Prague, Czech Republic",
          geo: { lat: 50.101, lng: 14.451 },
          contactName: "Shipping Dept",
          contactPhone: "+420-222-555-100",
        },
        destination: {
          label: "Brooklyn Maker Hub",
          address: "45 Industrial Rd, Brooklyn, NY 11222",
          geo: { lat: 40.6892, lng: -73.9857 },
          contactName: "Ryan George",
          contactPhone: "+1-718-555-0101",
          accessNotes: "Loading dock B, ring bell",
        },
        currentLocation: { lat: 41.8781, lng: -87.6298 },
        package: {
          weightKg: 32,
          dimensionsCm: { width: 65, depth: 80, height: 75 },
          palletized: true,
          crateRequired: false,
          fragile: true,
          hazmat: false,
          itemCount: 3,
          description: "3D printer + multi-material unit + enclosure",
        },
        quote: {
          id: "quot-001",
          providerId: "prov-precision",
          shipmentId: "shp-001",
          price: "485.00",
          currency: "USDC",
          transitDays: { min: 5, max: 8 },
          validUntil: "2026-03-15T00:00:00Z",
          includesInsurance: true,
          insuranceValue: "3000.00",
        },
        pickupWindow: { start: "2026-03-02T08:00:00Z", end: "2026-03-02T17:00:00Z" },
        estimatedDelivery: "2026-03-12T00:00:00Z",
        actualPickup: "2026-03-02T10:30:00Z",
        requiresLiftGate: true,
        requiresInsideDelivery: true,
        createdAt: "2026-03-01T12:00:00Z",
        updatedAt: "2026-03-07T09:00:00Z",
      },
      {
        id: "shp-002",
        equipmentDescription: "Haas VF-2 CNC Vertical Mill",
        providerId: "prov-riggers",
        priority: "expedited",
        status: "pickup_scheduled",
        origin: {
          label: "Haas Factory Outlet - NJ",
          address: "100 Industrial Pkwy, Totowa, NJ 07512",
          geo: { lat: 40.9051, lng: -74.2256 },
          contactName: "Haas Sales",
          contactPhone: "+1-973-555-0200",
        },
        destination: {
          label: "Brooklyn Maker Hub",
          address: "45 Industrial Rd, Brooklyn, NY 11222",
          geo: { lat: 40.6892, lng: -73.9857 },
          contactName: "Ryan George",
          contactPhone: "+1-718-555-0101",
          accessNotes: "Requires forklift unload. Bay 5 reserved.",
        },
        package: {
          weightKg: 3100,
          dimensionsCm: { width: 198, depth: 254, height: 261 },
          palletized: false,
          crateRequired: true,
          fragile: false,
          hazmat: false,
          itemCount: 1,
          description: "CNC vertical machining center with tooling package",
        },
        pickupWindow: { start: "2026-03-15T06:00:00Z", end: "2026-03-15T12:00:00Z" },
        estimatedDelivery: "2026-03-16T00:00:00Z",
        requiresLiftGate: false,
        requiresInsideDelivery: false,
        specialInstructions: "Rigging crew on-site at destination. Forklift required for unload. Machine on skid, do not remove skid.",
        createdAt: "2026-03-08T16:00:00Z",
        updatedAt: "2026-03-09T10:00:00Z",
      },
    ])
    .run();

  // ── Shipment Tracking Events ────────────────────────────────────

  db.insert(shipmentTrackingEvents)
    .values([
      { id: "trk-001a", shipmentId: "shp-001", timestamp: "2026-03-02T10:30:00Z", status: "picked_up", locationLabel: "Prague, CZ", message: "Package picked up from Prusa HQ" },
      { id: "trk-001b", shipmentId: "shp-001", timestamp: "2026-03-04T14:00:00Z", status: "in_transit", locationLabel: "Frankfurt, DE", message: "Cleared customs at Frankfurt hub" },
      { id: "trk-001c", shipmentId: "shp-001", timestamp: "2026-03-07T09:00:00Z", status: "in_transit", location: { lat: 41.8781, lng: -87.6298 }, locationLabel: "Chicago, IL", message: "In transit via Chicago distribution center" },
      { id: "trk-002a", shipmentId: "shp-002", timestamp: "2026-03-08T16:00:00Z", status: "booked", message: "Shipment booked with Northeast Riggers" },
      { id: "trk-002b", shipmentId: "shp-002", timestamp: "2026-03-09T10:00:00Z", status: "pickup_scheduled", message: "Pickup confirmed for March 15" },
    ])
    .run();

  // ── Condition Readings ──────────────────────────────────────────

  db.insert(conditionReadings)
    .values([
      { id: "cond-001a", shipmentId: "shp-001", timestamp: "2026-03-07T09:00:00Z", temperature: 21.3, humidity: 45, shock: 0.2, tilt: 1.5 },
      { id: "cond-001b", shipmentId: "shp-001", timestamp: "2026-03-06T09:00:00Z", temperature: 19.8, humidity: 52, shock: 0.8, tilt: 2.1 },
    ])
    .run();

  // ── Space Bookings ──────────────────────────────────────────────

  db.insert(spaceBookings)
    .values([
      {
        id: "book-001",
        spaceId: "space-bk",
        spaceName: "Brooklyn Maker Hub",
        slotPosition: "Bay 3",
        machineRegistrationId: "reg-001",
        bookingContact: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: "equipment_arriving",
        period: { start: "2026-03-10T00:00:00Z", end: "2027-03-10T00:00:00Z" },
        pricingPhase: "free",
        monthlyRate: "0",
        sqft: 120,
        currency: "USDC",
        requirements: { powerCircuits: 1, compressedAir: false, networkPorts: 1, floorProtection: false },
        moveInDate: "2026-03-12T00:00:00Z",
        shipmentId: "shp-001",
        installationOrderId: "inst-001",
        createdAt: "2026-03-01T12:00:00Z",
        updatedAt: "2026-03-07T09:00:00Z",
      },
      {
        id: "book-002",
        spaceId: "space-bk",
        spaceName: "Brooklyn Maker Hub",
        slotPosition: "Bay 5",
        bookingContact: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: "confirmed",
        period: { start: "2026-03-16T00:00:00Z", end: "2027-03-16T00:00:00Z" },
        pricingPhase: "free",
        monthlyRate: "0",
        sqft: 200,
        currency: "USDC",
        requirements: {
          powerCircuits: 3,
          compressedAir: true,
          networkPorts: 2,
          floorProtection: true,
          additionalNotes: "Need 3-phase 480V, minimum 200A. Concrete floor pad for CNC.",
        },
        shipmentId: "shp-002",
        createdAt: "2026-03-08T16:00:00Z",
        updatedAt: "2026-03-08T16:00:00Z",
      },
    ])
    .run();

  // ── Installation Orders ─────────────────────────────────────────

  db.insert(installationOrders)
    .values([
      {
        id: "inst-001",
        bookingId: "book-001",
        spaceId: "space-bk",
        machineRegistrationId: "reg-001",
        equipmentDescription: "Prusa MK4 + MMU3 + Enclosure",
        status: "scheduled",
        assignedTo: {
          type: "operator",
          name: "Ryan George",
          contactEmail: "ryan@makerhub.example.com",
          contactPhone: "+1-718-555-0101",
        },
        scheduledDate: "2026-03-12T09:00:00Z",
        estimatedDurationHours: 4,
        createdAt: "2026-03-01T12:00:00Z",
        updatedAt: "2026-03-09T10:00:00Z",
      },
      {
        id: "inst-002",
        bookingId: "book-002",
        spaceId: "space-bk",
        equipmentDescription: "Haas VF-2 CNC Vertical Mill",
        status: "draft",
        assignedTo: {
          type: "vendor",
          name: "Haas Field Service",
          contactEmail: "service@haas.example.com",
          contactPhone: "+1-805-555-0300",
          companyName: "Haas Automation",
        },
        scheduledDate: "2026-03-17T07:00:00Z",
        estimatedDurationHours: 8,
        createdAt: "2026-03-08T16:00:00Z",
        updatedAt: "2026-03-09T11:00:00Z",
      },
    ])
    .run();

  // ── Installation Steps ──────────────────────────────────────────

  const stepTypes = [
    { type: "receive_delivery", label: "Receive Delivery", description: "Accept delivery, verify package count and condition", estimatedMinutes: 30, requiresSignoff: true },
    { type: "uncrate_inspect", label: "Uncrate & Inspect", description: "Remove packaging, inspect for shipping damage, photograph", estimatedMinutes: 45, requiresSignoff: true },
    { type: "position_anchor", label: "Position & Anchor", description: "Move equipment to designated slot, level, and anchor if required", estimatedMinutes: 60, requiresSignoff: false },
    { type: "connect_power", label: "Connect Power", description: "Wire to dedicated circuit, verify voltage and ground", estimatedMinutes: 30, requiresSignoff: true },
    { type: "connect_network", label: "Connect Network", description: "Ethernet/WiFi setup, verify connectivity to PCC gateway", estimatedMinutes: 20, requiresSignoff: false },
    { type: "connect_utilities", label: "Connect Utilities", description: "Compressed air, coolant, ventilation as required", estimatedMinutes: 30, requiresSignoff: false },
    { type: "safety_inspection", label: "Safety Inspection", description: "E-stop test, guard verification, fire suppression check", estimatedMinutes: 30, requiresSignoff: true },
    { type: "calibrate", label: "Calibrate", description: "Run manufacturer calibration routine, verify tolerances", estimatedMinutes: 60, requiresSignoff: true },
    { type: "test_run", label: "Test Run", description: "Execute test job, verify output quality and evidence capture", estimatedMinutes: 45, requiresSignoff: true },
    { type: "commission", label: "Commission Kernel", description: "Register as Shop Kernel, activate capabilities, go online", estimatedMinutes: 30, requiresSignoff: true },
  ];

  for (const prefix of ["inst-001", "inst-002"]) {
    db.insert(installationSteps)
      .values(
        stepTypes.map((s, i) => ({
          id: `${prefix}-s${i + 1}`,
          installationOrderId: prefix,
          type: s.type,
          label: s.label,
          description: s.description,
          status: "pending",
          order: i + 1,
          estimatedMinutes: s.estimatedMinutes,
          requiresSignoff: s.requiresSignoff,
        })),
      )
      .run();
  }

  // ── Installation Notes ──────────────────────────────────────────

  db.insert(installationNotes)
    .values([
      { id: "inote-001a", installationOrderId: "inst-001", timestamp: "2026-03-01T12:00:00Z", author: "System", message: "Installation order auto-created from space booking", type: "info" },
      { id: "inote-002a", installationOrderId: "inst-002", timestamp: "2026-03-08T16:00:00Z", author: "System", message: "Installation order created for CNC mill setup", type: "info" },
      { id: "inote-002b", installationOrderId: "inst-002", timestamp: "2026-03-09T11:00:00Z", author: "Ryan George", message: "Need rigging crew for unload \u2014 machine is 3100kg on skid", type: "warning" },
    ])
    .run();

  // ── Logistics Timeline Events ───────────────────────────────────

  db.insert(logisticsTimelineEvents)
    .values([
      { id: "tle-01", timestamp: "2026-03-01T12:00:00Z", type: "shipment_created", title: "Shipment Created", description: "Prusa MK4 shipment booked from Prague to Brooklyn", relatedIds: { shipmentId: "shp-001", bookingId: "book-001" } },
      { id: "tle-02", timestamp: "2026-03-02T10:30:00Z", type: "shipment_picked_up", title: "Equipment Picked Up", description: "Picked up from Prusa Research HQ, Prague", relatedIds: { shipmentId: "shp-001" } },
      { id: "tle-03", timestamp: "2026-03-07T09:00:00Z", type: "shipment_in_transit", title: "In Transit - Chicago", description: "Package cleared Chicago distribution center", relatedIds: { shipmentId: "shp-001" } },
      { id: "tle-04", timestamp: "2026-03-08T16:00:00Z", type: "booking_confirmed", title: "Space Booked - Bay 5", description: "Brooklyn Maker Hub Bay 5 confirmed for CNC mill", relatedIds: { bookingId: "book-002", shipmentId: "shp-002" } },
      { id: "tle-05", timestamp: "2026-03-09T10:00:00Z", type: "shipment_created", title: "CNC Shipment Scheduled", description: "Haas VF-2 pickup scheduled for March 15", relatedIds: { shipmentId: "shp-002", bookingId: "book-002" } },
    ])
    .run();
}
