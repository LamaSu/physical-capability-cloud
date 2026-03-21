/**
 * IPP printer discovery via mDNS/DNS-SD.
 *
 * Discovers IPP printers on the local network by browsing for the
 * `_ipp._tcp` service type (RFC 7472).
 *
 * In production: uses the `bonjour-service` npm package (dynamic import).
 * Falls back to mock mode when no network discovery is available or when
 * the package is not installed.
 *
 * The generatePrinterCsd() function converts discovered printer capabilities
 * into a PCC Capability Specification Document (CSD).
 */

export interface DiscoveredPrinter {
  /** Human-readable printer name (from mDNS service name) */
  name: string;
  /** IPP URI (e.g., "ipp://192.168.1.50/ipp/print") */
  uri: string;
  /** Make and model string */
  makeModel: string;
  capabilities: {
    color: boolean;
    duplex: boolean;
    mediaSizes: string[];
    resolutions: number[];  // DPI values
    mediaTypes: string[];
  };
}

/** Mock printers returned when real discovery is unavailable */
const MOCK_PRINTERS: DiscoveredPrinter[] = [
  {
    name: "Canon PIXMA TR8620a",
    uri: "ipp://192.168.1.50/ipp/print",
    makeModel: "Canon PIXMA TR8620a",
    capabilities: {
      color: true,
      duplex: true,
      mediaSizes: ["iso_a4_210x297mm", "na_letter_8.5x11in", "na_legal_8.5x14in", "na_4x6_4x6in"],
      resolutions: [300, 600, 1200, 4800],
      mediaTypes: ["stationery", "photographic", "envelope", "cardstock"],
    },
  },
  {
    name: "HP ENVY 6455e",
    uri: "ipp://192.168.1.51/ipp/print",
    makeModel: "HP ENVY 6455e",
    capabilities: {
      color: true,
      duplex: false,
      mediaSizes: ["iso_a4_210x297mm", "na_letter_8.5x11in", "na_4x6_4x6in"],
      resolutions: [300, 600, 1200],
      mediaTypes: ["stationery", "photographic"],
    },
  },
];

/**
 * Discover IPP printers on the local network via mDNS/DNS-SD.
 *
 * When mDNS discovery is unavailable (no `bonjour-service` package or no
 * network), returns mock printers for development and testing.
 *
 * @param timeoutMs - How long to listen for mDNS responses (default 3000ms)
 * @returns Array of discovered printers
 */
export async function discoverIppPrinters(timeoutMs = 3000): Promise<DiscoveredPrinter[]> {
  try {
    return await realDiscoverIppPrinters(timeoutMs);
  } catch {
    // Fall back to mock discovery
    return mockDiscoverIppPrinters();
  }
}

/**
 * Attempt real mDNS discovery using the `bonjour-service` package.
 * Throws if the package is not installed or discovery fails.
 */
async function realDiscoverIppPrinters(timeoutMs: number): Promise<DiscoveredPrinter[]> {
  // Dynamic import — throws if bonjour-service is not installed
  const { default: Bonjour } = await import("bonjour-service");

  return new Promise<DiscoveredPrinter[]>((resolve) => {
    const bonjour = new Bonjour();
    const found: DiscoveredPrinter[] = [];

    const browser = bonjour.find({ type: "ipp" }, (service: {
      name: string;
      host: string;
      port: number;
      txt?: Record<string, string>;
    }) => {
      const host = service.host;
      const port = service.port ?? 631;
      const path = service.txt?.rp ?? "ipp/print";
      const uri = `ipp://${host}:${port}/${path}`;
      const makeModel = service.txt?.ty ?? service.name;

      const printer: DiscoveredPrinter = {
        name: service.name,
        uri,
        makeModel,
        capabilities: {
          color: service.txt?.Color === "T",
          duplex: service.txt?.Duplex === "T",
          mediaSizes: [],
          resolutions: [],
          mediaTypes: [],
        },
      };

      found.push(printer);
    });

    setTimeout(() => {
      browser.stop();
      bonjour.destroy();
      resolve(found);
    }, timeoutMs);
  });
}

/**
 * Return mock printers (used as fallback when mDNS is unavailable).
 */
function mockDiscoverIppPrinters(): DiscoveredPrinter[] {
  return MOCK_PRINTERS.map((p) => ({ ...p, capabilities: { ...p.capabilities } }));
}

/**
 * Generate a PCC Capability Specification Document (CSD) from a discovered
 * printer's capabilities.
 *
 * The CSD describes what this printer can do as a PCC capability — print
 * jobs with specific media, resolution, color, and duplex requirements.
 */
export function generatePrinterCsd(printer: DiscoveredPrinter): object {
  const capabilityId = `cap_ipp_2d_${slugify(printer.name)}`;

  return {
    id: capabilityId,
    version: "1.0.0",
    capabilityType: "ipp-2d-print",
    displayName: `2D Print — ${printer.name}`,
    description: `Standard 2D printing via IPP on ${printer.makeModel}`,
    provider: {
      deviceId: capabilityId,
      protocol: "ipp",
      uri: printer.uri,
      makeModel: printer.makeModel,
    },
    parameters: {
      color: {
        type: "boolean",
        description: "Whether to print in color",
        default: printer.capabilities.color,
        supported: printer.capabilities.color,
      },
      duplex: {
        type: "boolean",
        description: "Whether to print on both sides",
        default: false,
        supported: printer.capabilities.duplex,
      },
      mediaSize: {
        type: "enum",
        description: "Paper size",
        values: printer.capabilities.mediaSizes,
        default: printer.capabilities.mediaSizes[0] ?? "na_letter_8.5x11in",
      },
      resolution: {
        type: "enum",
        description: "Print resolution in DPI",
        values: printer.capabilities.resolutions,
        default: printer.capabilities.resolutions.includes(600)
          ? 600
          : (printer.capabilities.resolutions[0] ?? 300),
      },
      mediaType: {
        type: "enum",
        description: "Media/paper type",
        values: printer.capabilities.mediaTypes,
        default: printer.capabilities.mediaTypes[0] ?? "stationery",
      },
      copies: {
        type: "integer",
        description: "Number of copies to print",
        min: 1,
        max: 99,
        default: 1,
      },
    },
    outputs: {
      printedDocument: {
        type: "artifact",
        description: "Printed physical document",
        mimeType: "application/pdf",
      },
    },
    assuranceTiers: {
      tier0: {
        description: "Basic job completion signal",
        evidenceRequired: ["execution_started", "execution_completed"],
      },
      tier1: {
        description: "Per-page progress tracking",
        evidenceRequired: ["execution_started", "execution_progress", "execution_completed"],
      },
    },
    pricing: {
      model: "per-page",
      currency: "USDC",
      basePrice: "0.05",
      colorSurcharge: "0.03",
    },
    metadata: {
      generatedAt: new Date().toISOString(),
      source: "ipp-discovery",
      protocol: "ipp/1.1",
      rfc: "RFC 8011",
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}
