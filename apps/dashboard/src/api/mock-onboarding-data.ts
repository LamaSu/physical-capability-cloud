import type {
  MachineRegistration,
  OnboardingDocument,
  DocumentAnalysisResult,
  AISuggestedCapability,
  PhysicalSpaceRequirements,
  OperatorProfile,
  OperatorCertification,
  PricingConfig,
  MachineCapabilityDef,
  EquipmentClass,
  MarketSnapshot,
  HostingSpace,
  ROIProjection,
  MaintenanceEvent,
} from "@pcc/spec";

// ── Equipment Classes ──

export const mockEquipmentClasses: EquipmentClass[] = [
  {
    id: "ec-fdm",
    name: "FDM 3D Printer",
    category: "additive-manufacturing",
    subcategory: "Fused Deposition Modeling",
    description: "Desktop and industrial FDM printers for prototyping and production",
    commonMaterials: ["PLA", "PETG", "ABS", "TPU", "Nylon"],
    typicalTolerances: ["±0.2mm linear", "Ra 12.5 surface"],
    typicalPriceRange: { min: "5.00", max: "50.00", currency: "USDC" },
    spaceRequirementsRange: {
      minFootprint: { width: 2, depth: 2, unit: "ft" },
      maxFootprint: { width: 4, depth: 4, unit: "ft" },
    },
  },
  {
    id: "ec-cnc",
    name: "CNC Mill",
    category: "subtractive-manufacturing",
    subcategory: "Milling",
    description: "3-axis to 5-axis CNC milling centers for metals and plastics",
    commonMaterials: ["Aluminum 6061", "Steel 1018", "Brass", "Delrin", "HDPE"],
    typicalTolerances: ["±0.05mm linear", "Ra 1.6 surface"],
    typicalPriceRange: { min: "50.00", max: "500.00", currency: "USDC" },
    spaceRequirementsRange: {
      minFootprint: { width: 6, depth: 6, unit: "ft" },
      maxFootprint: { width: 12, depth: 10, unit: "ft" },
    },
  },
  {
    id: "ec-laser",
    name: "Laser Cutter",
    category: "subtractive-manufacturing",
    subcategory: "Laser Cutting",
    description: "CO2 and fiber laser systems for cutting and engraving",
    commonMaterials: ["Acrylic", "Plywood", "MDF", "Steel", "Aluminum"],
    typicalTolerances: ["±0.1mm linear"],
    typicalPriceRange: { min: "8.00", max: "120.00", currency: "USDC" },
    spaceRequirementsRange: {
      minFootprint: { width: 4, depth: 3, unit: "ft" },
      maxFootprint: { width: 8, depth: 5, unit: "ft" },
    },
  },
  {
    id: "ec-bio",
    name: "Bio-Reactor",
    category: "bio-chemical",
    subcategory: "Fermentation",
    description: "Controlled bioreactors for fermentation, cell culture, and bioprocessing",
    commonMaterials: ["Growth media", "Buffers", "Cell lines"],
    typicalTolerances: ["±0.1°C temp", "±0.01 pH"],
    typicalPriceRange: { min: "100.00", max: "2000.00", currency: "USDC" },
    spaceRequirementsRange: {
      minFootprint: { width: 3, depth: 3, unit: "ft" },
      maxFootprint: { width: 8, depth: 8, unit: "ft" },
    },
  },
  {
    id: "ec-pcb",
    name: "PCB Assembly",
    category: "electronics",
    subcategory: "SMT Assembly",
    description: "Pick-and-place, reflow, and through-hole soldering for PCB production",
    commonMaterials: ["FR-4", "SMD components", "Solder paste"],
    typicalTolerances: ["±0.05mm placement"],
    typicalPriceRange: { min: "25.00", max: "300.00", currency: "USDC" },
    spaceRequirementsRange: {
      minFootprint: { width: 4, depth: 3, unit: "ft" },
      maxFootprint: { width: 10, depth: 6, unit: "ft" },
    },
  },
  {
    id: "ec-microfluidics",
    name: "Microfluidics Fabrication",
    category: "bio-chemical",
    subcategory: "Microfluidics",
    description: "Soft lithography and micro-milling for microfluidic chip production",
    commonMaterials: ["PDMS", "Glass", "Silicon", "PMMA"],
    typicalTolerances: ["±10μm feature size"],
    typicalPriceRange: { min: "50.00", max: "500.00", currency: "USDC" },
    spaceRequirementsRange: {
      minFootprint: { width: 3, depth: 2, unit: "ft" },
      maxFootprint: { width: 6, depth: 4, unit: "ft" },
    },
  },
];

// ── Market Snapshots ──

export const mockMarketSnapshots: MarketSnapshot[] = [
  { equipmentClassId: "ec-fdm", timestamp: "2026-03-05T00:00:00Z", networkMachineCount: 47, averageUtilization: 72, averageJobValue: "28.50", demandLevel: "high", trendDirection: "up", trendPercent: 12, queueDepthAverage: 2.3 },
  { equipmentClassId: "ec-cnc", timestamp: "2026-03-05T00:00:00Z", networkMachineCount: 18, averageUtilization: 85, averageJobValue: "187.00", demandLevel: "high", trendDirection: "up", trendPercent: 8, queueDepthAverage: 3.1 },
  { equipmentClassId: "ec-laser", timestamp: "2026-03-05T00:00:00Z", networkMachineCount: 23, averageUtilization: 58, averageJobValue: "42.00", demandLevel: "medium", trendDirection: "stable", trendPercent: 1, queueDepthAverage: 1.2 },
  { equipmentClassId: "ec-bio", timestamp: "2026-03-05T00:00:00Z", networkMachineCount: 5, averageUtilization: 91, averageJobValue: "450.00", demandLevel: "high", trendDirection: "up", trendPercent: 24, queueDepthAverage: 4.8 },
  { equipmentClassId: "ec-pcb", timestamp: "2026-03-05T00:00:00Z", networkMachineCount: 12, averageUtilization: 65, averageJobValue: "95.00", demandLevel: "medium", trendDirection: "up", trendPercent: 5, queueDepthAverage: 1.8 },
  { equipmentClassId: "ec-microfluidics", timestamp: "2026-03-05T00:00:00Z", networkMachineCount: 3, averageUtilization: 95, averageJobValue: "280.00", demandLevel: "high", trendDirection: "up", trendPercent: 35, queueDepthAverage: 6.2 },
];

// ── Hosting Spaces ──

export const mockHostingSpaces: HostingSpace[] = [
  {
    id: "space-bk",
    name: "Brooklyn Maker Hub",
    operatorAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    location: { lat: 40.6892, lng: -73.9857 },
    address: "45 Industrial Rd, Brooklyn, NY 11222",
    dimensions: { width: 30, depth: 40, height: 14, unit: "ft" },
    power: { voltage: 208, amperage: 200, phase: 3, circuitCount: 8 },
    amenities: ["WiFi", "Loading dock", "Break room", "Parking", "24/7 access", "Security cameras"],
    environmentalSystems: ["HVAC", "Dust extraction", "Fume hood"],
    safetyFeatures: ["Fire suppression", "Eye wash", "First aid"],
    access: { schedule: "24/7", loadingDock: true, forklift: true },
    pricingPhase: "free",
    monthlyPrice: "0",
    sqft: 1200,
    currency: "USDC",
    availableSlots: 3,
    totalSlots: 8,
    rating: 4.7,
  },
  {
    id: "space-sf",
    name: "SF Fabrication Center",
    operatorAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    location: { lat: 37.7599, lng: -122.4148 },
    address: "120 Townsend St, San Francisco, CA 94107",
    dimensions: { width: 25, depth: 35, height: 12, unit: "ft" },
    power: { voltage: 480, amperage: 400, phase: 3, circuitCount: 12 },
    amenities: ["WiFi", "Conference room", "Shipping desk", "Tool crib"],
    environmentalSystems: ["HVAC", "Cleanroom zone", "Compressed air"],
    safetyFeatures: ["Fire suppression", "Gas detection", "Emergency shower"],
    access: { schedule: "business-hours", loadingDock: true, forklift: false },
    pricingPhase: "free",
    monthlyPrice: "0",
    sqft: 875,
    currency: "USDC",
    availableSlots: 1,
    totalSlots: 6,
    rating: 4.5,
  },
  {
    id: "space-aus",
    name: "Austin Hardware Ranch",
    operatorAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
    location: { lat: 30.2672, lng: -97.7431 },
    address: "800 E 6th St, Austin, TX 78702",
    dimensions: { width: 50, depth: 60, height: 18, unit: "ft" },
    power: { voltage: 480, amperage: 600, phase: 3, circuitCount: 16 },
    amenities: ["WiFi", "Loading dock", "Forklift", "Kitchen", "Shower", "Parking lot"],
    environmentalSystems: ["HVAC", "Dust extraction", "Coolant recycling", "Compressed air"],
    safetyFeatures: ["Fire suppression", "Spill kits", "First aid", "AED"],
    access: { schedule: "24/7", loadingDock: true, forklift: true },
    pricingPhase: "free",
    monthlyPrice: "0",
    sqft: 3000,
    currency: "USDC",
    availableSlots: 7,
    totalSlots: 12,
    rating: 4.9,
  },
];

// ── ROI Projections ──

export function generateROIProjection(monthlyCost: number, avgJobValue: number, utilization: number): ROIProjection[] {
  const points: ROIProjection[] = [];
  let cumRev = 0;
  let cumCost = 0;
  for (let m = 0; m <= 24; m++) {
    const jobsPerMonth = Math.round((utilization / 100) * 30 * 0.7);
    cumRev += m === 0 ? 0 : jobsPerMonth * avgJobValue;
    cumCost += m === 0 ? monthlyCost * 3 : monthlyCost; // initial setup = 3x
    points.push({ month: m, cumulativeRevenue: cumRev, cumulativeCost: cumCost, netPosition: cumRev - cumCost, utilization });
  }
  return points;
}

// ── Demand/Supply Timeline ──

export const mockDemandSupplyTimeline = Array.from({ length: 12 }, (_, i) => ({
  date: `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][i]} '26`,
  demand: 100 + Math.round(Math.sin(i * 0.5) * 30 + i * 8),
  supply: 80 + Math.round(i * 6 + Math.random() * 10),
}));

// ── Price History ──

export const mockPriceHistory = Array.from({ length: 30 }, (_, i) => ({
  date: `Mar ${i + 1}`,
  price: 28.5 + Math.sin(i * 0.3) * 5 + Math.random() * 3,
}));

// ── Maintenance Events ──

export const mockMaintenanceEvents: MaintenanceEvent[] = [
  { id: "maint-1", machineId: "reg-001", type: "scheduled", description: "Replace nozzle and clean heatbreak", scheduledAt: "2026-03-10T09:00:00Z", status: "upcoming" },
  { id: "maint-2", machineId: "reg-001", type: "inspection", description: "Quarterly belt tension check", scheduledAt: "2026-03-20T14:00:00Z", status: "upcoming" },
  { id: "maint-3", machineId: "reg-001", type: "scheduled", description: "Firmware update v5.2.0", scheduledAt: "2026-03-01T10:00:00Z", completedAt: "2026-03-01T10:30:00Z", status: "completed" },
  { id: "maint-4", machineId: "reg-001", type: "unscheduled", description: "Thermistor replacement after fault", scheduledAt: "2026-02-25T16:00:00Z", completedAt: "2026-02-25T17:30:00Z", status: "completed" },
];

// ── AI Suggested Capabilities (from doc analysis) ──

export const mockAISuggestions: AISuggestedCapability[] = [
  {
    id: "sug-1",
    type: "fdm",
    name: "Standard FDM Printing",
    description: "Layer-by-layer extrusion with 0.4mm nozzle, PLA/PETG/ABS compatible",
    materials: ["PLA", "PETG", "ABS", "TPU"],
    tolerances: { linear: "±0.2mm", surface: "Ra 12.5" },
    envelope: { x: 250, y: 210, z: 210, unit: "mm" },
    suggestedParams: [],
    confidence: 0.94,
    sourceReason: "Extracted from manufacturer datasheet, section 3.1 — Print specifications",
  },
  {
    id: "sug-2",
    type: "fdm",
    name: "High-Temp FDM Printing",
    description: "Enclosed chamber printing for ABS, ASA, and Nylon with heated bed up to 120°C",
    materials: ["ABS", "ASA", "Nylon", "PC"],
    tolerances: { linear: "±0.3mm" },
    envelope: { x: 250, y: 210, z: 210, unit: "mm" },
    suggestedParams: [],
    confidence: 0.72,
    sourceReason: "Inferred from enclosure specs in user manual, page 12",
  },
];

// ── Operator Certifications ──

export const mockCertifications: OperatorCertification[] = [
  { id: "cert-1", name: "OSHA 10-Hour General Industry", issuer: "OSHA", issuedAt: "2025-06-15T00:00:00Z", expiresAt: "2028-06-15T00:00:00Z", status: "valid" },
  { id: "cert-2", name: "3D Printing Safety Training", issuer: "PCC Network", issuedAt: "2025-09-01T00:00:00Z", expiresAt: "2026-09-01T00:00:00Z", status: "valid" },
  { id: "cert-3", name: "CNC Operator Level 2", issuer: "NIMS", issuedAt: "2024-01-10T00:00:00Z", expiresAt: "2026-04-10T00:00:00Z", status: "expiring" },
];

// ── Earnings Data ──

export const mockEarningsData = Array.from({ length: 30 }, (_, i) => {
  const daily = 15 + Math.random() * 40;
  return {
    date: `Mar ${i + 1}`,
    earnings: Math.round(daily * 100) / 100,
    cumulative: 0, // filled below
  };
});
mockEarningsData.reduce((sum, d) => {
  d.cumulative = Math.round((sum + d.earnings) * 100) / 100;
  return d.cumulative;
}, 0);

// ── Geo Markers ──

export const mockGeoMarkers = [
  { id: "geo-nyc", lat: 40.7, lng: -74.0, label: "NYC", demand: 0.8, supplyStatus: "balanced" as const },
  { id: "geo-sf", lat: 37.8, lng: -122.4, label: "SF", demand: 0.9, supplyStatus: "deficit" as const },
  { id: "geo-la", lat: 34.1, lng: -118.2, label: "LA", demand: 0.6, supplyStatus: "surplus" as const },
  { id: "geo-chi", lat: 41.9, lng: -87.6, label: "CHI", demand: 0.5, supplyStatus: "deficit" as const },
  { id: "geo-aus", lat: 30.3, lng: -97.7, label: "AUS", demand: 0.7, supplyStatus: "balanced" as const },
  { id: "geo-sea", lat: 47.6, lng: -122.3, label: "SEA", demand: 0.4, supplyStatus: "surplus" as const },
];

// ── Capability Trends ──

export const mockCapabilityTrends = [
  { type: "bio-reactor", label: "Bio-Reactors", demand: 92 },
  { type: "microfluidics", label: "Microfluidics", demand: 88 },
  { type: "cnc-5axis", label: "5-Axis CNC", demand: 78 },
  { type: "fdm", label: "FDM Printing", demand: 72 },
  { type: "pcb-assembly", label: "PCB Assembly", demand: 65 },
  { type: "laser-cut", label: "Laser Cutting", demand: 55 },
  { type: "injection-mold", label: "Injection Molding", demand: 48 },
];

// ── Sample Registration ──

export const mockOperatorProfile: OperatorProfile = {
  walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
  displayName: "Alex Workshop",
  certifications: mockCertifications,
  trainingAcknowledgments: { "safety-basics": true, "fire-protocol": true, "evidence-collection": false },
  insurance: { provider: "Hartford", policyNumber: "WC-2026-1234", coverageAmount: "1000000.00" },
};

export const mockSpaceRequirements: PhysicalSpaceRequirements = {
  footprint: { width: 600, depth: 500, height: 500, unit: "mm" },
  clearances: { front: 600, back: 200, left: 300, right: 300, above: 400, unit: "mm" },
  weight: { value: 7, unit: "kg" },
  power: { voltage: 120, amperage: 5, phase: 1, frequency: 60 },
  environmental: {
    tempRange: { min: 15, max: 30, unit: "C" },
    humidityRange: { min: 20, max: 70 },
    ventilationRequired: true,
    dustExtraction: false,
    fumeExtraction: true,
    cleanRoomClass: undefined,
  },
  utilities: {
    compressedAir: false,
    water: false,
    coolant: false,
    wasteDrainage: false,
  },
  vibrationIsolation: false,
};

export const mockPricingConfig: PricingConfig = {
  baseCost: "12.00",
  perMinute: "0.05",
  perGram: "0.03",
  minimum: "5.00",
  currency: "USDC",
};
