import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { csdRoutes, resetCsdRegistry } from "../routes/csd.js";
import { discoverRoutes } from "../routes/discover.js";
import { computeCsdEligibility } from "@pcc/spec";

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // csdRoutes must be registered first (discover depends on getCsdRegistry)
  await app.register(csdRoutes);
  await app.register(discoverRoutes);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Auto-Discovery API", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    resetCsdRegistry();
  });

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    resetCsdRegistry();
  });

  // ── POST /api/discover/scan ──────────────────────────────────────

  describe("POST /api/discover/scan", () => {
    it("returns mock printers when no real mDNS devices are present", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/discover/scan",
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.devices)).toBe(true);
      // Should find at least one mock printer
      expect(body.devices.length).toBeGreaterThan(0);
    });

    it("each discovered device has protocol, name, uri, makeModel, capabilities", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/discover/scan",
        payload: { protocols: ["ipp"] },
      });
      const body = res.json();
      for (const device of body.devices) {
        expect(device.protocol).toBe("ipp");
        expect(typeof device.name).toBe("string");
        expect(typeof device.uri).toBe("string");
        expect(typeof device.makeModel).toBe("string");
        expect(device.capabilities).toBeDefined();
      }
    });

    it("returns empty devices array when no matching protocols are requested", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/discover/scan",
        payload: { protocols: [] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.devices).toHaveLength(0);
    });

    it("accepts default empty body", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/discover/scan",
        payload: {},
      });
      expect(res.statusCode).toBe(200);
    });

    it("accepts timeoutMs parameter", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/discover/scan",
        payload: { protocols: ["ipp"], timeoutMs: 100 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.devices)).toBe(true);
    });
  });

  // ── POST /api/discover/generate-csd ─────────────────────────────

  describe("POST /api/discover/generate-csd", () => {
    it("generates a valid CSD from a mock discovered device", async () => {
      const device = {
        protocol: "ipp",
        name: "Test Printer",
        uri: "ipp://192.168.1.100/ipp/print",
        makeModel: "Test Printer Model",
        capabilities: {
          color: true,
          duplex: false,
          mediaSizes: ["iso_a4_210x297mm", "na_letter_8.5x11in"],
          resolutions: [300, 600],
          mediaTypes: ["stationery", "photographic"],
        },
      };

      const res = await app.inject({
        method: "POST",
        url: "/api/discover/generate-csd",
        payload: { device },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.csd).toBeDefined();
      expect(typeof body.csd.url).toBe("string");
      expect(body.csd.url).toContain("pcc://capabilities/ipp-2d-print/");
    });

    it("generated CSD has required top-level fields", async () => {
      const device = {
        protocol: "ipp",
        name: "Canon PIXMA Test",
        uri: "ipp://192.168.1.50/ipp/print",
        makeModel: "Canon PIXMA Test",
        capabilities: {
          color: true,
          duplex: true,
          mediaSizes: ["iso_a4_210x297mm"],
          resolutions: [600, 1200],
          mediaTypes: ["stationery"],
        },
      };

      const res = await app.inject({
        method: "POST",
        url: "/api/discover/generate-csd",
        payload: { device },
      });
      const body = res.json();
      const csd = body.csd;

      // Must conform to CSD schema
      expect(csd.url).toBeDefined();
      expect(csd.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(["draft", "active", "retired"]).toContain(csd.status);
      expect(csd.name).toBeDefined();
      expect(csd.description).toBeDefined();
      expect(["base", "profile", "extension", "workflow"]).toContain(csd.kind);
      expect(Array.isArray(csd.parameters)).toBe(true);
      expect(Array.isArray(csd.constraints)).toBe(true);
      expect(csd.pricing).toBeDefined();
      expect(csd.pricing.basePrice).toBeDefined();
      expect(csd.pricing.currency).toBeDefined();
    });

    it("generated CSD parameters include mediaSize with discovered options", async () => {
      const device = {
        protocol: "ipp",
        name: "HP Test",
        uri: "ipp://192.168.1.51/ipp/print",
        makeModel: "HP Test",
        capabilities: {
          color: false,
          duplex: false,
          mediaSizes: ["na_letter_8.5x11in", "na_legal_8.5x14in"],
          resolutions: [600],
          mediaTypes: ["stationery"],
        },
      };

      const res = await app.inject({
        method: "POST",
        url: "/api/discover/generate-csd",
        payload: { device },
      });
      const body = res.json();
      const mediaSizeParam = body.csd.parameters.find(
        (p: { key: string }) => p.key === "mediaSize",
      );
      expect(mediaSizeParam).toBeDefined();
      expect(mediaSizeParam.options).toHaveLength(2);
      expect(mediaSizeParam.options.map((o: { value: string }) => o.value)).toContain("na_letter_8.5x11in");
    });

    it("returns 400 when device is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/discover/generate-csd",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBeDefined();
    });
  });

  // ── POST /api/discover/onboard ───────────────────────────────────

  describe("POST /api/discover/onboard", () => {
    it("runs full pipeline and returns device, csd, registered", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/discover/onboard",
        payload: { timeoutMs: 100 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.device).toBeDefined();
      expect(body.csd).toBeDefined();
      expect(body.registered).toBe(true);
    });

    it("returned device has expected shape", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/discover/onboard",
        payload: {},
      });
      const body = res.json();
      const { device } = body;
      expect(typeof device.protocol).toBe("string");
      expect(typeof device.name).toBe("string");
      expect(typeof device.uri).toBe("string");
      expect(typeof device.makeModel).toBe("string");
      expect(device.capabilities).toBeDefined();
    });

    it("returned CSD is valid (has url, version, pricing)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/discover/onboard",
        payload: {},
      });
      const body = res.json();
      const { csd } = body;
      expect(csd.url).toBeDefined();
      expect(csd.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(csd.pricing.basePrice).toBeDefined();
      expect(csd.pricing.currency).toBeDefined();
    });

    it("onboarded CSD appears in GET /api/csd after onboard", async () => {
      const onboardRes = await app.inject({
        method: "POST",
        url: "/api/discover/onboard",
        payload: {},
      });
      const { csd } = onboardRes.json();

      const listRes = await app.inject({ method: "GET", url: "/api/csd" });
      const listBody = listRes.json();
      const found = listBody.csds.find(
        (c: { url: string }) => c.url === csd.url,
      );
      expect(found).toBeDefined();
    });

    it("selecting a specific deviceUri onboards that device", async () => {
      // Mock printers include Canon and HP at these URIs
      const res = await app.inject({
        method: "POST",
        url: "/api/discover/onboard",
        payload: { deviceUri: "ipp://192.168.1.50/ipp/print" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.device.uri).toBe("ipp://192.168.1.50/ipp/print");
    });
  });
});

// ---------------------------------------------------------------------------
// Supply-side evidence — auto-discovered devices now declare structured
// primitives[] and lint as tier-N eligible (previously free-text → tier-0 cap).
// ---------------------------------------------------------------------------

describe("Auto-Discovery — evidence primitives + eligibility", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    resetCsdRegistry();
  });

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    resetCsdRegistry();
  });

  async function generateIppCsd() {
    const device = {
      protocol: "ipp",
      name: "Eligibility Test Printer",
      uri: "ipp://192.168.1.77/ipp/print",
      makeModel: "Eligibility Test Printer",
      capabilities: {
        color: true,
        duplex: true,
        mediaSizes: ["iso_a4_210x297mm"],
        resolutions: [600],
        mediaTypes: ["stationery"],
      },
    };
    const res = await app.inject({
      method: "POST",
      url: "/api/discover/generate-csd",
      payload: { device },
    });
    return res.json().csd;
  }

  it("generated CSD carries structured evidence.tierN.primitives[]", async () => {
    const csd = await generateIppCsd();
    expect(csd.evidence.tier0.primitives).toBeDefined();
    expect(csd.evidence.tier1.primitives).toBeDefined();
    const tier1Ids = csd.evidence.tier1.primitives.map((p: { id: string }) => p.id);
    expect(tier1Ids).toContain("receipt.kernel_signed");
    expect(tier1Ids).toContain("confirm.execution_mode");
  });

  it("lints as tier-1 eligible (NOT tier-0 capped, as the old free-text CSD was)", async () => {
    const csd = await generateIppCsd();
    const report = computeCsdEligibility(csd);
    expect(report.verdict).toBe("ELIGIBLE");
    expect(report.eligibleTier).toBe(1);

    // BEFORE — the free-text shape auto-discovery used to write. The eligibility
    // lint caps free-text-only evidence at tier 0 (the on-ramp for undeclared
    // devices is preserved: no structured primitives[] ⇒ tier 0).
    const legacyFreeText = {
      url: csd.url,
      evidence: {
        tier0: { description: "Print completion receipt", required: ["jobId", "timestamp", "copies"] },
        tier1: { description: "Per-page progress", required: ["jobId", "pagesCompleted"] },
      },
    };
    expect(computeCsdEligibility(legacyFreeText).eligibleTier).toBe(0);
  });

  it("onboarded CSD (full pipeline) is tier-1 eligible", async () => {
    const res = await app.inject({ method: "POST", url: "/api/discover/onboard", payload: {} });
    const { csd } = res.json();
    expect(computeCsdEligibility(csd).eligibleTier).toBe(1);
  });
});
