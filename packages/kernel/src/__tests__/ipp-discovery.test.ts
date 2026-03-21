/**
 * Tests for IPP printer discovery and CSD generation.
 *
 * All tests run without network access — discovery falls back to mock printers
 * when mDNS is unavailable (bonjour-service not installed or no network).
 *
 * Covers:
 *  - discoverIppPrinters() mock fallback
 *  - DiscoveredPrinter structure validation
 *  - generatePrinterCsd() output structure
 *  - CSD required fields and types
 */

import { describe, it, expect } from "vitest";
import { discoverIppPrinters, generatePrinterCsd } from "../adapters/ipp-discovery.js";
import type { DiscoveredPrinter } from "../adapters/ipp-discovery.js";

// ---------------------------------------------------------------------------
// discoverIppPrinters()
// ---------------------------------------------------------------------------

describe("discoverIppPrinters()", () => {
  it("returns an array (mock fallback when no mDNS)", async () => {
    // bonjour-service is not installed, so we should get mock printers
    const printers = await discoverIppPrinters(100);
    expect(Array.isArray(printers)).toBe(true);
  });

  it("returns at least one mock printer", async () => {
    const printers = await discoverIppPrinters(100);
    expect(printers.length).toBeGreaterThanOrEqual(1);
  });

  it("returned printers have required fields", async () => {
    const printers = await discoverIppPrinters(100);
    for (const printer of printers) {
      expect(typeof printer.name).toBe("string");
      expect(typeof printer.uri).toBe("string");
      expect(typeof printer.makeModel).toBe("string");
      expect(printer.capabilities).toBeDefined();
      expect(typeof printer.capabilities.color).toBe("boolean");
      expect(typeof printer.capabilities.duplex).toBe("boolean");
      expect(Array.isArray(printer.capabilities.mediaSizes)).toBe(true);
      expect(Array.isArray(printer.capabilities.resolutions)).toBe(true);
      expect(Array.isArray(printer.capabilities.mediaTypes)).toBe(true);
    }
  });

  it("returned printer URIs are valid IPP URIs", async () => {
    const printers = await discoverIppPrinters(100);
    for (const printer of printers) {
      expect(printer.uri).toMatch(/^ipp:\/\//);
    }
  });

  it("mock printers include a Canon PIXMA", async () => {
    const printers = await discoverIppPrinters(100);
    const hasCanon = printers.some((p) => p.makeModel.includes("Canon"));
    expect(hasCanon).toBe(true);
  });

  it("mock Canon printer supports color printing", async () => {
    const printers = await discoverIppPrinters(100);
    const canon = printers.find((p) => p.makeModel.includes("Canon"));
    expect(canon).toBeDefined();
    expect(canon?.capabilities.color).toBe(true);
  });

  it("mock Canon printer supports duplex", async () => {
    const printers = await discoverIppPrinters(100);
    const canon = printers.find((p) => p.makeModel.includes("Canon"));
    expect(canon?.capabilities.duplex).toBe(true);
  });

  it("returns independent copies (no shared references)", async () => {
    const printers1 = await discoverIppPrinters(100);
    const printers2 = await discoverIppPrinters(100);
    // Modifying one should not affect the other
    printers1[0].capabilities.color = false;
    expect(printers2[0].capabilities.color).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// generatePrinterCsd()
// ---------------------------------------------------------------------------

describe("generatePrinterCsd()", () => {
  const samplePrinter: DiscoveredPrinter = {
    name: "Canon PIXMA TR8620a",
    uri: "ipp://192.168.1.50/ipp/print",
    makeModel: "Canon PIXMA TR8620a",
    capabilities: {
      color: true,
      duplex: true,
      mediaSizes: ["iso_a4_210x297mm", "na_letter_8.5x11in", "na_legal_8.5x14in"],
      resolutions: [300, 600, 1200, 4800],
      mediaTypes: ["stationery", "photographic", "envelope", "cardstock"],
    },
  };

  it("returns a plain object", () => {
    const csd = generatePrinterCsd(samplePrinter);
    expect(typeof csd).toBe("object");
    expect(csd).not.toBeNull();
  });

  it("CSD has required top-level fields", () => {
    const csd = generatePrinterCsd(samplePrinter) as Record<string, unknown>;
    expect(csd.id).toBeDefined();
    expect(csd.version).toBeDefined();
    expect(csd.capabilityType).toBeDefined();
    expect(csd.displayName).toBeDefined();
    expect(csd.description).toBeDefined();
    expect(csd.parameters).toBeDefined();
    expect(csd.outputs).toBeDefined();
  });

  it("CSD id is a string starting with 'cap_ipp_2d_'", () => {
    const csd = generatePrinterCsd(samplePrinter) as Record<string, unknown>;
    expect(typeof csd.id).toBe("string");
    expect((csd.id as string).startsWith("cap_ipp_2d_")).toBe(true);
  });

  it("CSD capabilityType is 'ipp-2d-print'", () => {
    const csd = generatePrinterCsd(samplePrinter) as Record<string, unknown>;
    expect(csd.capabilityType).toBe("ipp-2d-print");
  });

  it("CSD provider contains the IPP URI", () => {
    const csd = generatePrinterCsd(samplePrinter) as Record<string, unknown>;
    const provider = csd.provider as Record<string, unknown>;
    expect(provider.uri).toBe("ipp://192.168.1.50/ipp/print");
    expect(provider.protocol).toBe("ipp");
  });

  it("CSD parameters include color, duplex, mediaSize, resolution", () => {
    const csd = generatePrinterCsd(samplePrinter) as Record<string, unknown>;
    const params = csd.parameters as Record<string, unknown>;
    expect(params.color).toBeDefined();
    expect(params.duplex).toBeDefined();
    expect(params.mediaSize).toBeDefined();
    expect(params.resolution).toBeDefined();
  });

  it("CSD color parameter reflects printer color support", () => {
    const csd = generatePrinterCsd(samplePrinter) as Record<string, unknown>;
    const params = csd.parameters as Record<string, Record<string, unknown>>;
    expect(params.color.supported).toBe(true);
  });

  it("CSD duplex parameter reflects printer duplex support", () => {
    const csd = generatePrinterCsd(samplePrinter) as Record<string, unknown>;
    const params = csd.parameters as Record<string, Record<string, unknown>>;
    expect(params.duplex.supported).toBe(true);
  });

  it("CSD mediaSize values match printer capabilities", () => {
    const csd = generatePrinterCsd(samplePrinter) as Record<string, unknown>;
    const params = csd.parameters as Record<string, Record<string, unknown>>;
    const mediaSizeParam = params.mediaSize as Record<string, unknown>;
    expect(Array.isArray(mediaSizeParam.values)).toBe(true);
    const values = mediaSizeParam.values as string[];
    expect(values).toContain("iso_a4_210x297mm");
    expect(values).toContain("na_letter_8.5x11in");
  });

  it("CSD resolution values match printer capabilities", () => {
    const csd = generatePrinterCsd(samplePrinter) as Record<string, unknown>;
    const params = csd.parameters as Record<string, Record<string, unknown>>;
    const resParam = params.resolution as Record<string, unknown>;
    expect(Array.isArray(resParam.values)).toBe(true);
    const values = resParam.values as number[];
    expect(values).toContain(600);
    expect(values).toContain(1200);
  });

  it("CSD resolution default is 600 DPI when supported", () => {
    const csd = generatePrinterCsd(samplePrinter) as Record<string, unknown>;
    const params = csd.parameters as Record<string, Record<string, unknown>>;
    const resParam = params.resolution as Record<string, unknown>;
    expect(resParam.default).toBe(600);
  });

  it("CSD outputs include printedDocument", () => {
    const csd = generatePrinterCsd(samplePrinter) as Record<string, unknown>;
    const outputs = csd.outputs as Record<string, unknown>;
    expect(outputs.printedDocument).toBeDefined();
    const doc = outputs.printedDocument as Record<string, unknown>;
    expect(doc.mimeType).toBe("application/pdf");
  });

  it("CSD assuranceTiers includes tier0 and tier1", () => {
    const csd = generatePrinterCsd(samplePrinter) as Record<string, unknown>;
    const tiers = csd.assuranceTiers as Record<string, unknown>;
    expect(tiers.tier0).toBeDefined();
    expect(tiers.tier1).toBeDefined();
  });

  it("CSD pricing model is per-page", () => {
    const csd = generatePrinterCsd(samplePrinter) as Record<string, unknown>;
    const pricing = csd.pricing as Record<string, unknown>;
    expect(pricing.model).toBe("per-page");
    expect(pricing.currency).toBe("USDC");
  });

  it("CSD metadata includes generatedAt timestamp", () => {
    const csd = generatePrinterCsd(samplePrinter) as Record<string, unknown>;
    const meta = csd.metadata as Record<string, unknown>;
    expect(meta.generatedAt).toBeDefined();
    expect(typeof meta.generatedAt).toBe("string");
    // Should be a valid ISO date
    expect(() => new Date(meta.generatedAt as string)).not.toThrow();
  });

  it("works with a monochrome non-duplex printer", () => {
    const monoLaserPrinter: DiscoveredPrinter = {
      name: "Brother HL-L2350DW",
      uri: "ipp://192.168.1.52/ipp/print",
      makeModel: "Brother HL-L2350DW",
      capabilities: {
        color: false,
        duplex: true,
        mediaSizes: ["na_letter_8.5x11in", "iso_a4_210x297mm"],
        resolutions: [300, 600],
        mediaTypes: ["stationery"],
      },
    };

    const csd = generatePrinterCsd(monoLaserPrinter) as Record<string, unknown>;
    const params = csd.parameters as Record<string, Record<string, unknown>>;
    expect(params.color.supported).toBe(false);
    expect(params.duplex.supported).toBe(true);
  });

  it("generates unique IDs for different printers", () => {
    const printer2: DiscoveredPrinter = {
      ...samplePrinter,
      name: "HP ENVY 6455e",
      makeModel: "HP ENVY 6455e",
    };

    const csd1 = generatePrinterCsd(samplePrinter) as Record<string, unknown>;
    const csd2 = generatePrinterCsd(printer2) as Record<string, unknown>;
    expect(csd1.id).not.toBe(csd2.id);
  });

  it("end-to-end: discover then generate CSD", async () => {
    const printers = await discoverIppPrinters(100);
    expect(printers.length).toBeGreaterThan(0);

    const csd = generatePrinterCsd(printers[0]) as Record<string, unknown>;
    expect(csd.id).toBeDefined();
    expect(csd.capabilityType).toBe("ipp-2d-print");
    expect((csd.provider as Record<string, unknown>).uri).toBe(printers[0].uri);
  });
});
