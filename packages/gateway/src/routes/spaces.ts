import type { FastifyInstance } from "fastify";
import type { HostingSpace } from "@pcc/spec";

const mockSpaces: HostingSpace[] = [
  {
    id: "space-bk",
    name: "Brooklyn Maker Hub",
    operatorAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    location: { lat: 40.6892, lng: -73.9857 },
    address: "45 Industrial Rd, Brooklyn, NY 11222",
    dimensions: { width: 30, depth: 40, height: 14, unit: "ft" },
    power: { voltage: 208, amperage: 200, phase: 3, circuitCount: 8 },
    amenities: ["WiFi", "Loading dock", "Break room", "Parking"],
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
    amenities: ["WiFi", "Conference room", "Shipping desk"],
    environmentalSystems: ["HVAC", "Cleanroom zone", "Compressed air"],
    safetyFeatures: ["Fire suppression", "Gas detection"],
    access: { schedule: "business-hours", loadingDock: true, forklift: false },
    pricingPhase: "free",
    monthlyPrice: "0",
    sqft: 875,
    currency: "USDC",
    availableSlots: 1,
    totalSlots: 6,
    rating: 4.5,
  },
];

export async function spaceRoutes(app: FastifyInstance) {
  // List hosting spaces with optional filters
  app.get("/api/spaces", async (req) => {
    const query = req.query as Record<string, string>;
    let spaces = [...mockSpaces];

    if (query.maxSqft) {
      const max = parseFloat(query.maxSqft);
      spaces = spaces.filter((s) => !s.sqft || s.sqft <= max);
    }
    if (query.access && query.access !== "all") {
      spaces = spaces.filter((s) => s.access.schedule === query.access);
    }

    return { spaces };
  });

  // Space detail
  app.get<{ Params: { id: string } }>("/api/spaces/:id", async (req) => {
    const space = mockSpaces.find((s) => s.id === req.params.id);
    if (!space) return { error: "not_found" };
    return { space };
  });

  // Match machine requirements to compatible spaces
  app.post("/api/spaces/match", async (req) => {
    const body = (req.body ?? {}) as { voltage?: number; minArea?: number };
    const matched = mockSpaces
      .filter((s) => {
        if (body.voltage && s.power.voltage < body.voltage) return false;
        if (body.minArea && s.dimensions.width * s.dimensions.depth < body.minArea) return false;
        return s.availableSlots > 0;
      })
      .map((s) => ({
        ...s,
        matchScore: Math.round(70 + Math.random() * 25),
      }))
      .sort((a, b) => b.matchScore - a.matchScore);

    return { matches: matched };
  });
}
