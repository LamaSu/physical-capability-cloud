import type { FastifyInstance } from "fastify";
import type {
  Shipment,
  SpaceBooking,
  InstallationOrder,
  LogisticsProvider,
  DeliveryQuote,
  LogisticsTimelineEvent,
} from "@pcc/spec";

// ---------------------------------------------------------------------------
// Mock Data
// ---------------------------------------------------------------------------

const mockProviders: LogisticsProvider[] = [
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
];

const mockShipments: Shipment[] = [
  {
    id: "shp-001",
    machineRegistrationId: "reg-001",
    equipmentDescription: "Prusa MK4 + MMU3 + Enclosure",
    providerId: "prov-precision",
    priority: "standard",
    status: "in_transit",
    origin: {
      label: "Prusa Research HQ",
      address: "Partyzánská 188/7A, Prague, Czech Republic",
      geo: { lat: 50.1010, lng: 14.4510 },
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
    trackingEvents: [
      { id: "trk-001a", timestamp: "2026-03-02T10:30:00Z", status: "picked_up", locationLabel: "Prague, CZ", message: "Package picked up from Prusa HQ" },
      { id: "trk-001b", timestamp: "2026-03-04T14:00:00Z", status: "in_transit", locationLabel: "Frankfurt, DE", message: "Cleared customs at Frankfurt hub" },
      { id: "trk-001c", timestamp: "2026-03-07T09:00:00Z", status: "in_transit", location: { lat: 41.8781, lng: -87.6298 }, locationLabel: "Chicago, IL", message: "In transit via Chicago distribution center" },
    ],
    conditionReadings: [
      { timestamp: "2026-03-07T09:00:00Z", temperature: 21.3, humidity: 45, shock: 0.2, tilt: 1.5 },
      { timestamp: "2026-03-06T09:00:00Z", temperature: 19.8, humidity: 52, shock: 0.8, tilt: 2.1 },
    ],
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
    trackingEvents: [
      { id: "trk-002a", timestamp: "2026-03-08T16:00:00Z", status: "booked", message: "Shipment booked with Northeast Riggers" },
      { id: "trk-002b", timestamp: "2026-03-09T10:00:00Z", status: "pickup_scheduled", message: "Pickup confirmed for March 15" },
    ],
    conditionReadings: [],
    createdAt: "2026-03-08T16:00:00Z",
    updatedAt: "2026-03-09T10:00:00Z",
  },
];

const mockBookings: SpaceBooking[] = [
  {
    id: "book-001",
    spaceId: "space-bk",
    spaceName: "Brooklyn Maker Hub",
    slotPosition: "Bay 3",
    machineRegistrationId: "reg-001",
    bookingContact: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    status: "equipment_arriving",
    period: { start: "2026-03-10T00:00:00Z", end: "2027-03-10T00:00:00Z" },
    monthlyRate: "1200.00",
    currency: "USDC",
    depositAmount: "2400.00",
    requirements: {
      powerCircuits: 1,
      compressedAir: false,
      networkPorts: 1,
      floorProtection: false,
    },
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
    monthlyRate: "1800.00",
    currency: "USDC",
    depositAmount: "3600.00",
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
];

const defaultInstallSteps = (prefix: string): InstallationOrder["steps"] => [
  { id: `${prefix}-s1`, type: "receive_delivery", label: "Receive Delivery", description: "Accept delivery, verify package count and condition", status: "pending", order: 1, estimatedMinutes: 30, requiresSignoff: true },
  { id: `${prefix}-s2`, type: "uncrate_inspect", label: "Uncrate & Inspect", description: "Remove packaging, inspect for shipping damage, photograph", status: "pending", order: 2, estimatedMinutes: 45, requiresSignoff: true },
  { id: `${prefix}-s3`, type: "position_anchor", label: "Position & Anchor", description: "Move equipment to designated slot, level, and anchor if required", status: "pending", order: 3, estimatedMinutes: 60, requiresSignoff: false },
  { id: `${prefix}-s4`, type: "connect_power", label: "Connect Power", description: "Wire to dedicated circuit, verify voltage and ground", status: "pending", order: 4, estimatedMinutes: 30, requiresSignoff: true },
  { id: `${prefix}-s5`, type: "connect_network", label: "Connect Network", description: "Ethernet/WiFi setup, verify connectivity to PCC gateway", status: "pending", order: 5, estimatedMinutes: 20, requiresSignoff: false },
  { id: `${prefix}-s6`, type: "connect_utilities", label: "Connect Utilities", description: "Compressed air, coolant, ventilation as required", status: "pending", order: 6, estimatedMinutes: 30, requiresSignoff: false },
  { id: `${prefix}-s7`, type: "safety_inspection", label: "Safety Inspection", description: "E-stop test, guard verification, fire suppression check", status: "pending", order: 7, estimatedMinutes: 30, requiresSignoff: true },
  { id: `${prefix}-s8`, type: "calibrate", label: "Calibrate", description: "Run manufacturer calibration routine, verify tolerances", status: "pending", order: 8, estimatedMinutes: 60, requiresSignoff: true },
  { id: `${prefix}-s9`, type: "test_run", label: "Test Run", description: "Execute test job, verify output quality and evidence capture", status: "pending", order: 9, estimatedMinutes: 45, requiresSignoff: true },
  { id: `${prefix}-s10`, type: "commission", label: "Commission Kernel", description: "Register as Shop Kernel, activate capabilities, go online", status: "pending", order: 10, estimatedMinutes: 30, requiresSignoff: true },
];

const mockInstallations: InstallationOrder[] = [
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
    steps: defaultInstallSteps("inst-001"),
    notes: [
      { id: "inote-001a", timestamp: "2026-03-01T12:00:00Z", author: "System", message: "Installation order auto-created from space booking", type: "info" },
    ],
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
    steps: defaultInstallSteps("inst-002"),
    notes: [
      { id: "inote-002a", timestamp: "2026-03-08T16:00:00Z", author: "System", message: "Installation order created for CNC mill setup", type: "info" },
      { id: "inote-002b", timestamp: "2026-03-09T11:00:00Z", author: "Ryan George", message: "Need rigging crew for unload — machine is 3100kg on skid", type: "warning" },
    ],
    createdAt: "2026-03-08T16:00:00Z",
    updatedAt: "2026-03-09T11:00:00Z",
  },
];

const mockTimeline: LogisticsTimelineEvent[] = [
  { id: "tle-01", timestamp: "2026-03-01T12:00:00Z", type: "shipment_created", title: "Shipment Created", description: "Prusa MK4 shipment booked from Prague to Brooklyn", relatedIds: { shipmentId: "shp-001", bookingId: "book-001" } },
  { id: "tle-02", timestamp: "2026-03-02T10:30:00Z", type: "shipment_picked_up", title: "Equipment Picked Up", description: "Picked up from Prusa Research HQ, Prague", relatedIds: { shipmentId: "shp-001" } },
  { id: "tle-03", timestamp: "2026-03-07T09:00:00Z", type: "shipment_in_transit", title: "In Transit - Chicago", description: "Package cleared Chicago distribution center", relatedIds: { shipmentId: "shp-001" } },
  { id: "tle-04", timestamp: "2026-03-08T16:00:00Z", type: "booking_confirmed", title: "Space Booked - Bay 5", description: "Brooklyn Maker Hub Bay 5 confirmed for CNC mill", relatedIds: { bookingId: "book-002", shipmentId: "shp-002" } },
  { id: "tle-05", timestamp: "2026-03-09T10:00:00Z", type: "shipment_created", title: "CNC Shipment Scheduled", description: "Haas VF-2 pickup scheduled for March 15", relatedIds: { shipmentId: "shp-002", bookingId: "book-002" } },
];

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function logisticsRoutes(app: FastifyInstance) {
  // --- Providers ---

  app.get("/api/logistics/providers", async (req) => {
    const query = req.query as Record<string, string>;
    let providers = [...mockProviders];

    if (query.service) {
      providers = providers.filter((p) =>
        p.serviceTypes.includes(query.service),
      );
    }
    if (query.region) {
      const region = query.region.toLowerCase();
      providers = providers.filter((p) =>
        p.coverageArea.regions.some((r) => r.toLowerCase().includes(region)),
      );
    }

    return { providers };
  });

  app.get<{ Params: { id: string } }>("/api/logistics/providers/:id", async (req) => {
    const provider = mockProviders.find((p) => p.id === req.params.id);
    if (!provider) return { error: "not_found" };
    return { provider };
  });

  // --- Shipments ---

  app.get("/api/logistics/shipments", async (req) => {
    const query = req.query as Record<string, string>;
    let shipments = [...mockShipments];

    if (query.status) {
      shipments = shipments.filter((s) => s.status === query.status);
    }

    return { shipments };
  });

  app.get<{ Params: { id: string } }>("/api/logistics/shipments/:id", async (req) => {
    const shipment = mockShipments.find((s) => s.id === req.params.id);
    if (!shipment) return { error: "not_found" };
    return { shipment };
  });

  app.post("/api/logistics/shipments/quote", async (req) => {
    const body = (req.body ?? {}) as {
      originZip?: string;
      destinationZip?: string;
      weightKg?: number;
      priority?: string;
    };

    const basePrice = (body.weightKg ?? 30) * 0.8 + 150;
    const priorityMultiplier = body.priority === "rush" ? 2.5 : body.priority === "expedited" ? 1.6 : 1.0;
    const price = Math.round(basePrice * priorityMultiplier * 100) / 100;

    const quotes: DeliveryQuote[] = mockProviders.slice(0, 2).map((p, i) => ({
      id: `quot-new-${i}`,
      providerId: p.id,
      shipmentId: "",
      price: (price * (1 + i * 0.15)).toFixed(2),
      currency: "USDC" as const,
      transitDays: { min: 3 + i * 2, max: 7 + i * 3 },
      validUntil: new Date(Date.now() + 7 * 86400000).toISOString(),
      includesInsurance: i === 0,
      insuranceValue: i === 0 ? "5000.00" : undefined,
      notes: p.name,
    }));

    return { quotes };
  });

  // --- Bookings ---

  app.get("/api/logistics/bookings", async (req) => {
    const query = req.query as Record<string, string>;
    let bookings = [...mockBookings];

    if (query.status) {
      bookings = bookings.filter((b) => b.status === query.status);
    }
    if (query.spaceId) {
      bookings = bookings.filter((b) => b.spaceId === query.spaceId);
    }

    return { bookings };
  });

  app.get<{ Params: { id: string } }>("/api/logistics/bookings/:id", async (req) => {
    const booking = mockBookings.find((b) => b.id === req.params.id);
    if (!booking) return { error: "not_found" };
    return { booking };
  });

  // --- Installations ---

  app.get("/api/logistics/installations", async (req) => {
    const query = req.query as Record<string, string>;
    let installations = [...mockInstallations];

    if (query.status) {
      installations = installations.filter((i) => i.status === query.status);
    }

    return { installations };
  });

  app.get<{ Params: { id: string } }>("/api/logistics/installations/:id", async (req) => {
    const inst = mockInstallations.find((i) => i.id === req.params.id);
    if (!inst) return { error: "not_found" };
    return { installation: inst };
  });

  app.patch<{ Params: { id: string; stepId: string } }>(
    "/api/logistics/installations/:id/steps/:stepId",
    async (req) => {
      const inst = mockInstallations.find((i) => i.id === req.params.id);
      if (!inst) return { error: "not_found" };

      const step = inst.steps.find((s) => s.id === req.params.stepId);
      if (!step) return { error: "step_not_found" };

      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.status) step.status = body.status as typeof step.status;
      if (body.completedBy) step.completedBy = body.completedBy as string;
      if (body.notes) step.notes = body.notes as string;
      if (step.status === "in_progress" && !step.startedAt) step.startedAt = new Date().toISOString();
      if (step.status === "completed" && !step.completedAt) step.completedAt = new Date().toISOString();

      return { step };
    },
  );

  // --- Timeline ---

  app.get("/api/logistics/timeline", async () => {
    const sorted = [...mockTimeline].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
    return { events: sorted };
  });

  // --- Summary (for hub overview) ---

  app.get("/api/logistics/summary", async () => {
    return {
      shipments: {
        total: mockShipments.length,
        inTransit: mockShipments.filter((s) => s.status === "in_transit").length,
        delivered: mockShipments.filter((s) => s.status === "delivered").length,
        pending: mockShipments.filter((s) => ["quote_requested", "quoted", "booked", "pickup_scheduled"].includes(s.status)).length,
      },
      bookings: {
        total: mockBookings.length,
        active: mockBookings.filter((b) => b.status === "active").length,
        upcoming: mockBookings.filter((b) => ["requested", "confirmed", "preparing", "equipment_arriving"].includes(b.status)).length,
      },
      installations: {
        total: mockInstallations.length,
        inProgress: mockInstallations.filter((i) => i.status === "in_progress").length,
        scheduled: mockInstallations.filter((i) => i.status === "scheduled").length,
        completed: mockInstallations.filter((i) => i.status === "completed").length,
      },
      providers: { total: mockProviders.length },
    };
  });
}
