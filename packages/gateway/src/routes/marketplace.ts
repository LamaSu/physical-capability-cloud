import type { FastifyInstance } from "fastify";
import type { EquipmentClass, MarketSnapshot, ROIProjection, MarketplaceListing, MarketplaceOrder, MarketplaceCategory } from "@pcc/spec";

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

// ── Supplies & Materials Marketplace Mock Data ──────────────────────────────

const now = new Date().toISOString();

const mockListings: MarketplaceListing[] = [
  {
    id: "lst-al6061-bar",
    sellerId: "supplier-metalcraft-us",
    category: "raw-metals",
    name: "Aluminum 6061 T6 Bar Stock, 1\" diameter",
    description: "Precision extruded 6061-T6 aluminum round bar. Excellent machinability, good corrosion resistance. 12\" lengths. Ideal for CNC turning and milling.",
    unit: "kg",
    pricePerUnit: 12.50,
    currency: "USDC",
    minOrder: 1,
    maxOrder: 500,
    inStock: true,
    leadTimeDays: 2,
    location: "US-Midwest",
    tags: ["aluminum", "6061", "T6", "bar", "CNC", "machining"],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "lst-pla-175mm",
    sellerId: "supplier-polyprint-de",
    category: "plastics-polymers",
    name: "PLA Filament 1.75mm, 1kg spool",
    description: "High-quality PLA filament with tight diameter tolerance (±0.02mm). Available in 20+ colors. Vacuum-sealed with desiccant. Compatible with all FDM printers.",
    unit: "each",
    pricePerUnit: 22.00,
    currency: "USDC",
    minOrder: 1,
    maxOrder: 100,
    inStock: true,
    leadTimeDays: 3,
    location: "EU-West",
    tags: ["PLA", "filament", "1.75mm", "FDM", "3D printing"],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "lst-purexpress",
    sellerId: "supplier-neb-us",
    category: "lab-reagents",
    name: "Cell-Free Protein Synthesis Kit (PURExpress)",
    description: "NEB PURExpress In Vitro Protein Synthesis Kit. Reconstituted E. coli transcription/translation system. 10 reactions, 25µL each. Ships on dry ice.",
    unit: "each",
    pricePerUnit: 485.00,
    currency: "USDC",
    minOrder: 1,
    maxOrder: 20,
    inStock: true,
    leadTimeDays: 5,
    location: "US-Northeast",
    tags: ["cell-free", "CFPS", "protein synthesis", "PURExpress", "NEB", "transcription", "translation"],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "lst-96well-pcr",
    sellerId: "supplier-labware-ca",
    category: "lab-consumables",
    name: "96-Well PCR Plates (50 pack)",
    description: "Skirted 96-well PCR plates, 0.2mL wells. Low-profile design. Compatible with most real-time PCR systems. DNase/RNase-free, individually wrapped.",
    unit: "box",
    pricePerUnit: 89.00,
    currency: "USDC",
    minOrder: 1,
    maxOrder: 50,
    inStock: true,
    leadTimeDays: 4,
    location: "US-West",
    tags: ["PCR", "96-well", "plates", "consumables", "qPCR", "thermocycler"],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "lst-fr4-pcb-blank",
    sellerId: "supplier-circuitworks-tw",
    category: "electronics",
    name: "FR4 PCB Blank, 100x100mm",
    description: "Standard FR4 double-sided copper-clad laminate. 1.6mm thickness, 1oz copper on both sides. Pre-cut 100x100mm panels. Great for rapid prototyping.",
    unit: "each",
    pricePerUnit: 3.50,
    currency: "USDC",
    minOrder: 10,
    maxOrder: 1000,
    inStock: true,
    leadTimeDays: 7,
    location: "Asia-Pacific",
    tags: ["FR4", "PCB", "blank", "copper clad", "electronics", "prototype"],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "lst-endmill-14-4fl",
    sellerId: "supplier-toolco-us",
    category: "tooling",
    name: "Carbide End Mill 1/4\" 4-flute",
    description: "Solid carbide 4-flute square end mill, 1/4\" diameter, 3/4\" LOC, 2.5\" OAL. TiAlN coating for extended tool life in ferrous and non-ferrous materials.",
    unit: "each",
    pricePerUnit: 28.00,
    currency: "USDC",
    minOrder: 1,
    maxOrder: 200,
    inStock: true,
    leadTimeDays: 3,
    location: "US-Southeast",
    tags: ["end mill", "carbide", "1/4 inch", "4-flute", "TiAlN", "CNC", "milling"],
    createdAt: now,
    updatedAt: now,
  },
];

const mockOrders: MarketplaceOrder[] = [
  {
    id: "ord-demo-001",
    listingId: "lst-al6061-bar",
    buyerId: "kernel-biopunk-lab",
    sellerId: "supplier-metalcraft-us",
    quantity: 5,
    totalPrice: 62.50,
    status: "delivered",
    createdAt: "2026-03-20T10:00:00Z",
    updatedAt: "2026-03-24T14:30:00Z",
  },
  {
    id: "ord-demo-002",
    listingId: "lst-purexpress",
    buyerId: "kernel-biopunk-lab",
    sellerId: "supplier-neb-us",
    quantity: 2,
    totalPrice: 970.00,
    status: "shipped",
    createdAt: "2026-03-26T09:00:00Z",
    updatedAt: "2026-03-27T11:00:00Z",
  },
];

const ALL_CATEGORIES: MarketplaceCategory[] = [
  "raw-metals", "plastics-polymers", "lab-reagents", "lab-consumables",
  "electronics", "chemicals", "biologicals", "tooling", "packaging",
  "calibration", "safety", "other",
];

// ── Equipment Marketplace Mock Data ─────────────────────────────────────────

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

  // ── Supplies & Materials Marketplace Routes ──────────────────────────────

  // GET /api/marketplace/categories — list all categories with listing counts
  app.get("/api/marketplace/categories", async () => {
    const counts = ALL_CATEGORIES.map((cat) => ({
      category: cat,
      count: mockListings.filter((l) => l.category === cat).length,
    }));
    return { categories: counts };
  });

  // GET /api/marketplace/listings — list/search listings
  app.get("/api/marketplace/listings", async (req) => {
    const q = req.query as Record<string, string>;
    let results = [...mockListings];

    if (q.category) {
      results = results.filter((l) => l.category === q.category);
    }
    if (q.inStock === "true") {
      results = results.filter((l) => l.inStock);
    }
    if (q.location) {
      results = results.filter((l) => l.location.toLowerCase().includes(q.location.toLowerCase()));
    }
    if (q.query) {
      const lower = q.query.toLowerCase();
      results = results.filter(
        (l) =>
          l.name.toLowerCase().includes(lower) ||
          l.description.toLowerCase().includes(lower) ||
          l.tags.some((t: string) => t.toLowerCase().includes(lower)),
      );
    }

    return { listings: results, count: results.length };
  });

  // GET /api/marketplace/listings/:id — listing details
  app.get<{ Params: { id: string } }>("/api/marketplace/listings/:id", async (req, reply) => {
    const listing = mockListings.find((l) => l.id === req.params.id);
    if (!listing) {
      return reply.status(404).send({ error: "listing_not_found" });
    }
    return { listing };
  });

  // POST /api/marketplace/listings — create listing (seller)
  app.post("/api/marketplace/listings", async (req, reply) => {
    const body = req.body as Partial<MarketplaceListing> | undefined;
    if (!body?.name || !body?.category || !body?.pricePerUnit || !body?.unit) {
      return reply.status(400).send({ error: "name, category, pricePerUnit, and unit are required" });
    }
    const ts = new Date().toISOString();
    const listing: MarketplaceListing = {
      id: `lst-${Date.now()}`,
      sellerId: body.sellerId ?? "unknown",
      category: body.category,
      name: body.name,
      description: body.description ?? "",
      unit: body.unit,
      pricePerUnit: body.pricePerUnit,
      currency: body.currency ?? "USDC",
      minOrder: body.minOrder ?? 1,
      maxOrder: body.maxOrder ?? 9999,
      inStock: body.inStock ?? true,
      leadTimeDays: body.leadTimeDays ?? 7,
      location: body.location ?? "Unknown",
      tags: body.tags ?? [],
      createdAt: ts,
      updatedAt: ts,
    };
    mockListings.push(listing);
    return reply.status(201).send({ listing });
  });

  // PUT /api/marketplace/listings/:id — update listing
  app.put<{ Params: { id: string } }>("/api/marketplace/listings/:id", async (req, reply) => {
    const idx = mockListings.findIndex((l) => l.id === req.params.id);
    if (idx === -1) {
      return reply.status(404).send({ error: "listing_not_found" });
    }
    const body = req.body as Partial<MarketplaceListing> | undefined;
    mockListings[idx] = {
      ...mockListings[idx],
      ...(body ?? {}),
      id: req.params.id,
      updatedAt: new Date().toISOString(),
    };
    return { listing: mockListings[idx] };
  });

  // DELETE /api/marketplace/listings/:id — remove listing
  app.delete<{ Params: { id: string } }>("/api/marketplace/listings/:id", async (req, reply) => {
    const idx = mockListings.findIndex((l) => l.id === req.params.id);
    if (idx === -1) {
      return reply.status(404).send({ error: "listing_not_found" });
    }
    mockListings.splice(idx, 1);
    return { deleted: true, id: req.params.id };
  });

  // POST /api/marketplace/orders — place order
  app.post("/api/marketplace/orders", async (req, reply) => {
    const body = req.body as Partial<MarketplaceOrder> & { listingId?: string; quantity?: number } | undefined;
    if (!body?.listingId || !body?.quantity) {
      return reply.status(400).send({ error: "listingId and quantity are required" });
    }
    const listing = mockListings.find((l) => l.id === body.listingId);
    if (!listing) {
      return reply.status(404).send({ error: "listing_not_found" });
    }
    if (!listing.inStock) {
      return reply.status(409).send({ error: "listing_out_of_stock" });
    }
    const ts = new Date().toISOString();
    const order: MarketplaceOrder = {
      id: `ord-${Date.now()}`,
      listingId: body.listingId,
      buyerId: body.buyerId ?? "unknown",
      sellerId: listing.sellerId,
      quantity: body.quantity,
      totalPrice: listing.pricePerUnit * body.quantity,
      status: "pending",
      escrowAddress: body.escrowAddress,
      createdAt: ts,
      updatedAt: ts,
    };
    mockOrders.push(order);
    return reply.status(201).send({ order });
  });

  // GET /api/marketplace/orders — list orders (by buyerId or sellerId query param)
  app.get("/api/marketplace/orders", async (req) => {
    const q = req.query as Record<string, string>;
    let results = [...mockOrders];
    if (q.buyerId) results = results.filter((o) => o.buyerId === q.buyerId);
    if (q.sellerId) results = results.filter((o) => o.sellerId === q.sellerId);
    if (q.status) results = results.filter((o) => o.status === q.status);
    return { orders: results, count: results.length };
  });

  // GET /api/marketplace/orders/:id — order details
  app.get<{ Params: { id: string } }>("/api/marketplace/orders/:id", async (req, reply) => {
    const order = mockOrders.find((o) => o.id === req.params.id);
    if (!order) {
      return reply.status(404).send({ error: "order_not_found" });
    }
    const listing = mockListings.find((l) => l.id === order.listingId);
    return { order, listing };
  });
}
