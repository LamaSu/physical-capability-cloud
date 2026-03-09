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
];

const mockSnapshots: MarketSnapshot[] = [
  { equipmentClassId: "ec-fdm", timestamp: new Date().toISOString(), networkMachineCount: 47, averageUtilization: 72, averageJobValue: "28.50", demandLevel: "high", trendDirection: "up", trendPercent: 12, queueDepthAverage: 2.3 },
  { equipmentClassId: "ec-cnc", timestamp: new Date().toISOString(), networkMachineCount: 18, averageUtilization: 85, averageJobValue: "187.00", demandLevel: "high", trendDirection: "up", trendPercent: 8, queueDepthAverage: 3.1 },
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
