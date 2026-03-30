import type { FastifyInstance } from "fastify";
import type { EquipmentClass, MarketSnapshot, ROIProjection } from "@pcc/spec";

const mockClasses: EquipmentClass[] = [
  {
    id: "ec-fdm",
    name: "FDM 3D Printer",
    category: "additive-manufacturing",
    description: "Desktop and industrial FDM printers",
    commonMaterials: ["PLA", "PETG", "ABS"],
    typicalTolerances: ["±0.2mm"],
    typicalPriceRange: { min: "5.00", max: "50.00", currency: "USDC" },
    spaceRequirementsRange: { minFootprint: { width: 2, depth: 2, unit: "ft" }, maxFootprint: { width: 4, depth: 4, unit: "ft" } },
  },
  {
    id: "ec-cnc",
    name: "CNC Mill",
    category: "subtractive-manufacturing",
    description: "3-axis to 5-axis CNC milling centers",
    commonMaterials: ["Aluminum", "Steel", "Delrin"],
    typicalTolerances: ["±0.05mm"],
    typicalPriceRange: { min: "50.00", max: "500.00", currency: "USDC" },
    spaceRequirementsRange: { minFootprint: { width: 6, depth: 6, unit: "ft" }, maxFootprint: { width: 12, depth: 10, unit: "ft" } },
  },
  {
    id: "ec-document-printer",
    name: "Document Printer",
    category: "document-services",
    description: "Inkjet and laser printers for document, photo, and label printing",
    commonMaterials: ["Plain Paper", "Photo Paper", "Card Stock", "Labels", "Envelopes"],
    typicalTolerances: ["600dpi", "1200dpi"],
    typicalPriceRange: { min: "0.05", max: "1.00", currency: "USDC" },
    spaceRequirementsRange: { minFootprint: { width: 1, depth: 1, unit: "ft" }, maxFootprint: { width: 3, depth: 2, unit: "ft" } },
  },
  {
    id: "ec-large-format",
    name: "Large Format Printer",
    category: "document-services",
    description: "Wide-format inkjet printers for posters, banners, blueprints, and signage",
    commonMaterials: ["Roll Paper", "Canvas", "Vinyl", "Blueprint Paper"],
    typicalTolerances: ["2400dpi"],
    typicalPriceRange: { min: "2.00", max: "25.00", currency: "USDC" },
    spaceRequirementsRange: { minFootprint: { width: 4, depth: 2, unit: "ft" }, maxFootprint: { width: 8, depth: 4, unit: "ft" } },
  },
  {
    id: "ec-laser-cutter",
    name: "Laser Cutter / Engraver",
    category: "subtractive-manufacturing",
    description: "CO2 and fiber laser cutters for cutting and engraving flat materials",
    commonMaterials: ["Acrylic", "Wood", "Leather", "Fabric", "Thin Metal"],
    typicalTolerances: ["±0.1mm"],
    typicalPriceRange: { min: "5.00", max: "100.00", currency: "USDC" },
    spaceRequirementsRange: { minFootprint: { width: 3, depth: 2, unit: "ft" }, maxFootprint: { width: 6, depth: 4, unit: "ft" } },
  },
  {
    id: "ec-liquid-handler",
    name: "Liquid Handler",
    category: "laboratory",
    description: "Automated pipetting systems for sample preparation and assay workflows",
    commonMaterials: ["Reagents", "Buffers", "Samples"],
    typicalTolerances: ["±1µL"],
    typicalPriceRange: { min: "10.00", max: "200.00", currency: "USDC" },
    spaceRequirementsRange: { minFootprint: { width: 2, depth: 2, unit: "ft" }, maxFootprint: { width: 4, depth: 3, unit: "ft" } },
  },
];

const mockSnapshots: MarketSnapshot[] = [
  { equipmentClassId: "ec-fdm", timestamp: new Date().toISOString(), networkMachineCount: 47, averageUtilization: 72, averageJobValue: "28.50", demandLevel: "high", trendDirection: "up", trendPercent: 12, queueDepthAverage: 2.3 },
  { equipmentClassId: "ec-cnc", timestamp: new Date().toISOString(), networkMachineCount: 18, averageUtilization: 85, averageJobValue: "187.00", demandLevel: "high", trendDirection: "up", trendPercent: 8, queueDepthAverage: 3.1 },
  { equipmentClassId: "ec-document-printer", timestamp: new Date().toISOString(), networkMachineCount: 4, averageUtilization: 35, averageJobValue: "0.50", demandLevel: "medium", trendDirection: "up", trendPercent: 45, queueDepthAverage: 0.8 },
  { equipmentClassId: "ec-large-format", timestamp: new Date().toISOString(), networkMachineCount: 2, averageUtilization: 40, averageJobValue: "12.00", demandLevel: "medium", trendDirection: "up", trendPercent: 20, queueDepthAverage: 1.2 },
  { equipmentClassId: "ec-laser-cutter", timestamp: new Date().toISOString(), networkMachineCount: 12, averageUtilization: 60, averageJobValue: "35.00", demandLevel: "high", trendDirection: "up", trendPercent: 18, queueDepthAverage: 1.8 },
  { equipmentClassId: "ec-liquid-handler", timestamp: new Date().toISOString(), networkMachineCount: 3, averageUtilization: 50, averageJobValue: "75.00", demandLevel: "medium", trendDirection: "up", trendPercent: 30, queueDepthAverage: 1.5 },
];

export async function marketplaceRoutes(app: FastifyInstance) {
  // List equipment classes with market snapshots
  app.get("/api/marketplace/classes", async () => {
    return {
      classes: mockClasses.map((c) => ({
        ...c,
        snapshot: mockSnapshots.find((s) => s.equipmentClassId === c.id),
      })),
    };
  });

  // Equipment class detail
  app.get<{ Params: { id: string } }>("/api/marketplace/classes/:id", async (req) => {
    const cls = mockClasses.find((c) => c.id === req.params.id);
    if (!cls) return { error: "not_found" };
    return {
      class: cls,
      snapshot: mockSnapshots.find((s) => s.equipmentClassId === cls.id),
      priceHistory: Array.from({ length: 30 }, (_, i) => ({
        date: `2026-03-${String(i + 1).padStart(2, "0")}`,
        price: 28.5 + Math.sin(i * 0.3) * 5,
      })),
    };
  });

  // Network demand/supply timeline
  app.get("/api/marketplace/demand-supply", async () => {
    return {
      timeline: Array.from({ length: 12 }, (_, i) => ({
        month: i + 1,
        demand: 100 + Math.round(Math.sin(i * 0.5) * 30 + i * 8),
        supply: 80 + Math.round(i * 6),
      })),
    };
  });

  // Calculate ROI projection
  app.post("/api/marketplace/roi", async (req) => {
    const { monthlyCost = 200, avgJobValue = 30, utilization = 65 } = (req.body ?? {}) as Record<string, number>;
    const points: ROIProjection[] = [];
    let cumRev = 0;
    let cumCost = 0;
    for (let m = 0; m <= 24; m++) {
      const jobsPerMonth = Math.round((utilization / 100) * 30 * 0.7);
      cumRev += m === 0 ? 0 : jobsPerMonth * avgJobValue;
      cumCost += m === 0 ? monthlyCost * 3 : monthlyCost;
      points.push({ month: m, cumulativeRevenue: cumRev, cumulativeCost: cumCost, netPosition: cumRev - cumCost, utilization });
    }
    return { projection: points, breakEvenMonth: points.find((p) => p.netPosition >= 0)?.month };
  });
}
