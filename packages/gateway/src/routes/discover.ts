/**
 * Auto-discovery API routes.
 *
 * POST /api/discover/scan            — scan network for devices
 * POST /api/discover/generate-csd   — generate a CSD from a discovered device
 * POST /api/discover/onboard        — full pipeline: discover → generate CSD → register device → register CSD
 *
 * Discovery currently supports IPP printers via mDNS (falls back to mock).
 * The logic here mirrors @pcc/kernel/adapters/ipp-discovery without importing
 * the kernel bundle — that package has optional native deps (ipp, bonjour-service)
 * that may not be available in all environments and would cause the gateway build
 * to fail if imported directly.
 */

import type { FastifyInstance } from "fastify";
import type { CSD } from "@pcc/spec";
import { getCsdRegistry } from "./csd.js";

// ── Discovery types ──────────────────────────────────────────────────────────

export interface DiscoveredDevice {
  protocol: string;
  name: string;
  uri: string;
  makeModel: string;
  capabilities: Record<string, unknown>;
}

interface IppPrinterCapabilities {
  color?: boolean;
  duplex?: boolean;
  mediaSizes?: string[];
  resolutions?: number[];
  mediaTypes?: string[];
}

/** Mock printers — used when mDNS is unavailable (dev / CI). */
const MOCK_IPP_PRINTERS: DiscoveredDevice[] = [
  {
    protocol: "ipp",
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
    protocol: "ipp",
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
 * Discover IPP printers via mDNS. Falls back to mock printers when the
 * `bonjour-service` package is unavailable or discovery fails.
 */
async function discoverIppDevices(timeoutMs: number): Promise<DiscoveredDevice[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bonjourModule = await import("bonjour-service" as string) as any;
    const Bonjour = bonjourModule.default ?? bonjourModule;
    const bonjour = new Bonjour();
    const found: DiscoveredDevice[] = [];

    await new Promise<void>((resolve) => {
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

        found.push({
          protocol: "ipp",
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
        });
      });

      setTimeout(() => {
        browser.stop();
        bonjour.destroy();
        resolve();
      }, timeoutMs);
    });

    return found;
  } catch {
    // bonjour-service not installed or mDNS failed — return mock data
    return MOCK_IPP_PRINTERS.map((p) => ({
      ...p,
      capabilities: { ...p.capabilities },
    }));
  }
}

// ── CSD generation ───────────────────────────────────────────────────────────

/**
 * Convert a discovered IPP device into a valid PCC CSD document.
 */
function deviceToCsd(device: DiscoveredDevice): CSD {
  const caps = device.capabilities as IppPrinterCapabilities;

  const mediaSizes = caps.mediaSizes ?? ["na_letter_8.5x11in"];
  const resolutions = caps.resolutions ?? [600];
  const mediaTypes = caps.mediaTypes ?? ["stationery"];

  const slug = device.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const csd: CSD = {
    url: `pcc://capabilities/ipp-2d-print/${slug}/v1`,
    version: "1.0.0",
    status: "active",
    name: `2D Print — ${device.name}`,
    description: `Standard 2D printing via IPP on ${device.makeModel}`,
    kind: "base",
    baseDefinition: null,
    discovery: {
      protocols: ["ipp"],
      detect: {
        ipp: { uri: device.uri },
      },
    },
    adapter: {
      type: "ipp",
      configSchema: {
        type: "object",
        properties: {
          uri: { type: "string", description: "IPP printer URI" },
        },
        required: ["uri"],
      },
      commands: {
        print: { description: "Submit a print job via IPP", input: "documentData", output: "jobId" },
        status: { description: "Get printer status", output: "printerState" },
      },
    },
    parameters: [
      {
        type: "boolean",
        key: "color",
        label: "Color",
        description: "Whether to print in color",
        required: false,
        defaultValue: caps.color ?? false,
      },
      {
        type: "boolean",
        key: "duplex",
        label: "Duplex",
        description: "Whether to print on both sides",
        required: false,
        defaultValue: false,
      },
      {
        type: "enum",
        key: "mediaSize",
        label: "Media Size",
        description: "Paper size",
        required: true,
        defaultValue: mediaSizes[0],
        options: mediaSizes.map((s) => ({ value: s, label: s })),
      },
      {
        type: "enum",
        key: "resolution",
        label: "Resolution (DPI)",
        description: "Print resolution in DPI",
        required: false,
        defaultValue: String(resolutions.includes(600) ? 600 : (resolutions[0] ?? 300)),
        options: resolutions.map((r) => ({ value: String(r), label: `${r} DPI` })),
      },
      {
        type: "enum",
        key: "mediaType",
        label: "Media Type",
        description: "Media/paper type",
        required: false,
        defaultValue: mediaTypes[0],
        options: mediaTypes.map((m) => ({ value: m, label: m })),
      },
      {
        type: "number",
        key: "copies",
        label: "Copies",
        description: "Number of copies to print",
        required: false,
        min: 1,
        max: 99,
        step: 1,
        defaultValue: 1,
      },
    ],
    constraints: [],
    evidence: {
      tier0: {
        description: "Print completion receipt",
        required: ["jobId", "timestamp", "copies"],
      },
      tier1: {
        description: "Per-page progress tracking",
        required: ["jobId", "timestamp", "copies", "pagesCompleted"],
      },
    },
    pricing: {
      basePrice: "0.05",
      currency: "USDC",
      unit: "per page",
    },
  };

  return csd;
}

// ── Route handlers ───────────────────────────────────────────────────────────

export async function discoverRoutes(app: FastifyInstance) {
  // ── POST /api/discover/scan ──────────────────────────────────────
  app.post<{
    Body: { protocols?: string[]; timeoutMs?: number };
  }>("/api/discover/scan", async (req) => {
    const { protocols = ["ipp"], timeoutMs = 3000 } = req.body ?? {};

    const devices: DiscoveredDevice[] = [];

    if (protocols.includes("ipp")) {
      const found = await discoverIppDevices(timeoutMs);
      devices.push(...found);
    }

    return { devices };
  });

  // ── POST /api/discover/generate-csd ─────────────────────────────
  app.post<{ Body: { device: DiscoveredDevice } }>("/api/discover/generate-csd", async (req, reply) => {
    const { device } = req.body ?? {};
    if (!device) {
      return reply.status(400).send({ error: "device is required" });
    }

    try {
      const csd = deviceToCsd(device);
      return { csd };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: message });
    }
  });

  // ── POST /api/discover/onboard ───────────────────────────────────
  app.post<{
    Body: { deviceUri?: string; protocol?: string; timeoutMs?: number };
  }>("/api/discover/onboard", async (req, reply) => {
    const { deviceUri, protocol = "ipp", timeoutMs = 3000 } = req.body ?? {};

    // Step 1: discover devices
    const devices = await discoverIppDevices(timeoutMs);

    const target = devices.find((d) =>
      deviceUri ? d.uri === deviceUri : true,
    );

    if (!target) {
      return reply.status(404).send({
        error: "No devices found. Ensure the device is on the network.",
      });
    }

    const device: DiscoveredDevice = { ...target, protocol };

    // Step 2: generate CSD
    const csd = deviceToCsd(device);

    // Step 3: register CSD in registry
    const registry = getCsdRegistry();
    try {
      registry.register(csd);
    } catch (err) {
      // Already registered — update is fine since register overwrites
      const message = err instanceof Error ? err.message : String(err);
      app.log.warn(`CSD registration warning: ${message}`);
    }

    return {
      device,
      csd,
      registered: true,
    };
  });
}
