import type { FastifyInstance } from "fastify";
import type { HostingSpace } from "@pcc/spec";
import { isDemoRoutesOn, markDemo } from "../config/demo-routes.js";

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

// ── Demo gate (board N34, the server side of PX-3) ────────────────────
//
// Every route in this plugin answers from the two fixture spaces above (no route reads
// the hosting_spaces table), and /match scores them with Math.random(): a 70-95
// "matchScore" with no basis, different on every call. Served as live data, that is
// plausible fiction. So outside demo mode the WHOLE plugin fails closed: the onRequest
// hook in spaceRoutes answers 501 not_available before the body is parsed and before any
// handler runs. A route added to this plugin later is refused by default. Both hooks are
// encapsulated: server.ts registers this plugin with app.register and no fastify-plugin
// wrapper, so no other plugin sees them.
//
// With PCC_DEMO_ROUTES=true the fixtures are served as before, and every response says
// so: the x-pcc-demo: true header, plus mock: true, demo: true on object bodies.

const DEMO_HEADER = "x-pcc-demo";

const exampleOnly = (what: string) =>
  `${what} is not recorded on this gateway, so nothing is returned rather than an example.`;

/** The refusal for each route pattern. `see` lists real routes that exist on this gateway. */
const REFUSALS: Record<string, { message: string; see: string[] }> = {
  "/api/spaces": { message: exampleOnly("Hosting space data"), see: [] },
  "/api/spaces/:id": { message: exampleOnly("Hosting space data"), see: [] },
  "/api/spaces/match": { message: exampleOnly("Hosting space data"), see: [] },
};
const FALLBACK_REFUSAL = { message: exampleOnly("Hosting space data"), see: [] as string[] };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export async function spaceRoutes(app: FastifyInstance) {
  // Demo gate (see above). Refuses before parsing, so nothing below runs outside demo mode.
  app.addHook("onRequest", async (req, reply) => {
    if (isDemoRoutesOn()) {
      reply.header(DEMO_HEADER, "true");
      return;
    }
    const refusal = REFUSALS[req.routeOptions.url ?? ""] ?? FALLBACK_REFUSAL;
    return reply.code(501).send({ error: "not_available", message: refusal.message, see: refusal.see });
  });
  // A demo response's object body says so too; the header above covers any other shape.
  app.addHook("preSerialization", async (_req, reply, payload: unknown) =>
    reply.getHeader(DEMO_HEADER) === "true" && isPlainObject(payload) ? markDemo("demo", payload) : payload,
  );

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
