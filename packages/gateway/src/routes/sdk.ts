/**
 * Device SDK Integration Patterns — templates for integrating new device types.
 *
 * GET /api/sdk/integration-guide/:deviceType — Full integration guide
 * GET /api/sdk/adapter-template/:adapterType — TypeScript adapter template
 * GET /api/sdk/mcp-template/:deviceType — MCP server template
 */

import type { FastifyInstance } from "fastify";

export async function sdkRoutes(app: FastifyInstance) {
  /**
   * GET /api/sdk/integration-guide/:deviceType
   * Returns a structured guide for integrating a device type into PCC.
   */
  app.get<{ Params: { deviceType: string } }>(
    "/api/sdk/integration-guide/:deviceType",
    async (req, reply) => {
      const guide = INTEGRATION_GUIDES[req.params.deviceType];
      if (!guide) {
        return reply.status(404).send({
          error: `Unknown device type: ${req.params.deviceType}`,
          available: Object.keys(INTEGRATION_GUIDES),
        });
      }
      return guide;
    },
  );

  /**
   * GET /api/sdk/adapter-template/:adapterType
   * Returns a TypeScript adapter template implementing MachineAdapter.
   */
  app.get<{ Params: { adapterType: string } }>(
    "/api/sdk/adapter-template/:adapterType",
    async (req, reply) => {
      const template = ADAPTER_TEMPLATES[req.params.adapterType];
      if (!template) {
        return reply.status(404).send({
          error: `Unknown adapter type: ${req.params.adapterType}`,
          available: Object.keys(ADAPTER_TEMPLATES),
        });
      }
      return { adapterType: req.params.adapterType, template, language: "typescript" };
    },
  );

  /**
   * GET /api/sdk/mcp-template/:deviceType
   * Returns a minimal MCP server template wrapping a device.
   */
  app.get<{ Params: { deviceType: string } }>(
    "/api/sdk/mcp-template/:deviceType",
    async (req, reply) => {
      const deviceType = req.params.deviceType;
      const guide = INTEGRATION_GUIDES[deviceType];
      if (!guide) {
        return reply.status(404).send({
          error: `Unknown device type: ${deviceType}`,
          available: Object.keys(INTEGRATION_GUIDES),
        });
      }

      return {
        deviceType,
        template: buildMcpTemplate(deviceType, guide),
        language: "typescript",
        dependencies: ["@anthropic-ai/sdk", "zod"],
      };
    },
  );
}

// ── Integration Guides ────────────────────────────────────────────

interface IntegrationGuide {
  deviceType: string;
  displayName: string;
  description: string;
  adapterType: string;
  driverHints: {
    protocol: string;
    defaultPort: number | string;
    connectionPattern: string;
    sdkPackage?: string;
  };
  keyActions: string[];
  protocolFormat: string;
  capabilityTypes: string[];
  exampleBrands: string[];
  batchCapable: boolean;
}

const INTEGRATION_GUIDES: Record<string, IntegrationGuide> = {
  "liquid-handler": {
    deviceType: "liquid-handler",
    displayName: "Liquid Handler (Opentrons OT-2/Flex)",
    description: "Automated liquid handling — transfers, serial dilutions, plate formatting",
    adapterType: "opentrons",
    driverHints: {
      protocol: "HTTP REST",
      defaultPort: 31950,
      connectionPattern: "GET http://<ip>:31950/health → { status: 'running' }",
      sdkPackage: "opentrons-http-api (REST, no SDK needed)",
    },
    keyActions: ["aspirate", "dispense", "transfer", "mix", "distribute", "consolidate"],
    protocolFormat: "Opentrons Python (API level 2.18+)",
    capabilityTypes: ["liquid-handler"],
    exampleBrands: ["Opentrons OT-2", "Opentrons Flex", "Hamilton STAR"],
    batchCapable: true,
  },
  fdm: {
    deviceType: "fdm",
    displayName: "FDM 3D Printer",
    description: "Fused deposition modeling — layer-by-layer thermoplastic extrusion",
    adapterType: "octoprint",
    driverHints: {
      protocol: "HTTP REST + WebSocket",
      defaultPort: 80,
      connectionPattern: "GET http://<ip>/api/version?apikey=<key> → { server, api, text }",
      sdkPackage: "octoprint-client or raw REST (X-Api-Key header)",
    },
    keyActions: ["upload_gcode", "start_print", "pause", "resume", "cancel", "get_status", "get_temperature"],
    protocolFormat: "G-code (.gcode files)",
    capabilityTypes: ["fdm"],
    exampleBrands: ["Prusa MK4", "Ender 3", "Bambu Lab X1", "Voron 2.4"],
    batchCapable: false,
  },
  "cnc-3axis": {
    deviceType: "cnc-3axis",
    displayName: "CNC Milling Machine",
    description: "3-axis CNC milling for metals and plastics",
    adapterType: "opcua",
    driverHints: {
      protocol: "OPC-UA",
      defaultPort: 4840,
      connectionPattern: "opc.tcp://<ip>:4840 → browse for machine nodes",
      sdkPackage: "node-opcua (npm install node-opcua)",
    },
    keyActions: ["load_program", "start", "pause", "stop", "get_position", "tool_change", "get_spindle"],
    protocolFormat: "G-code (ISO 6983 / FANUC)",
    capabilityTypes: ["cnc-3axis", "cnc-5axis"],
    exampleBrands: ["Haas VF-2", "Tormach PCNC 440", "Datron neo"],
    batchCapable: false,
  },
  hplc: {
    deviceType: "hplc",
    displayName: "HPLC System",
    description: "High-performance liquid chromatography with UV/fluorescence detection",
    adapterType: "sila",
    driverHints: {
      protocol: "SiLA 2 (gRPC)",
      defaultPort: 50052,
      connectionPattern: "gRPC client to sila://<ip>:50052 → GetServerInfo",
      sdkPackage: "sila2-python or sila2-nodejs",
    },
    keyActions: ["start_run", "get_status", "get_results", "set_method", "inject_sample"],
    protocolFormat: "SiLA 2 commands + method files",
    capabilityTypes: ["hplc", "chromatography"],
    exampleBrands: ["Agilent 1260", "Waters ACQUITY", "Shimadzu Nexera"],
    batchCapable: true,
  },
  pcr: {
    deviceType: "pcr",
    displayName: "PCR Thermocycler",
    description: "Real-time quantitative PCR for DNA/RNA amplification",
    adapterType: "sila",
    driverHints: {
      protocol: "SiLA 2 or vendor REST API",
      defaultPort: 50052,
      connectionPattern: "Vendor-specific — check documentation",
      sdkPackage: "Bio-Rad CFX Manager API or SiLA 2",
    },
    keyActions: ["start_run", "get_status", "set_protocol", "get_results", "get_melt_curve"],
    protocolFormat: "Protocol files (vendor-specific) or SiLA 2",
    capabilityTypes: ["pcr"],
    exampleBrands: ["Bio-Rad CFX96", "Applied Biosystems QuantStudio", "Roche LightCycler"],
    batchCapable: true,
  },
  centrifuge: {
    deviceType: "centrifuge",
    displayName: "Centrifuge",
    description: "High-speed centrifugation for sample separation",
    adapterType: "sila",
    driverHints: {
      protocol: "Serial RS-232 or SiLA 2",
      defaultPort: "COM3 (serial) or 50052 (SiLA)",
      connectionPattern: "Serial: 9600 baud, 8N1 → send 'STATUS' command",
      sdkPackage: "pyserial (Python) or serialport (Node.js)",
    },
    keyActions: ["start_run", "stop", "set_speed", "set_duration", "set_temperature", "get_status"],
    protocolFormat: "Speed (RPM) + duration + temperature",
    capabilityTypes: ["centrifuge"],
    exampleBrands: ["Beckman Avanti J-26S", "Eppendorf 5424", "Thermo Sorvall"],
    batchCapable: true,
  },
};

// ── Adapter Templates ─────────────────────────────────────────────

const ADAPTER_TEMPLATES: Record<string, string> = {
  opentrons: `import type { MachineAdapter, MachineCommand, MachineCommandResult, MachineStatus } from "@pcc/kernel";
import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";

interface OpentronConfig {
  url: string;          // e.g., "http://192.168.1.100:31950"
  apiVersion?: string;  // default "2.18"
  mockMode?: boolean;
}

export class MyOpentronAdapter implements MachineAdapter {
  readonly id: string;
  readonly type = "liquid-handler" as any;
  readonly source: EvidenceSource;
  private config: OpentronConfig;
  private callbacks: Array<(e: Omit<EvidenceEvent, "id" | "hash">) => void> = [];

  constructor(id: string, config: OpentronConfig) {
    this.id = id;
    this.config = config;
    this.source = { deviceId: id, deviceType: "instrument", kernelId: id };
  }

  async getStatus(): Promise<MachineStatus> {
    try {
      const res = await fetch(\`\${this.config.url}/health\`);
      return res.ok ? "idle" : "error";
    } catch { return "offline"; }
  }

  async execute(cmd: MachineCommand): Promise<MachineCommandResult> {
    switch (cmd.type) {
      case "load_gcode": {
        // Upload protocol: POST /protocols with multipart form data
        const src = cmd.payload?.protocolSource as string;
        // ... upload logic
        return { success: true, message: "Protocol uploaded" };
      }
      case "start": {
        // Create run: POST /runs { protocolId: "..." }
        // Start run: POST /runs/{id}/actions { actionType: "play" }
        return { success: true, message: "Run started" };
      }
      case "stop": {
        // POST /runs/{id}/actions { actionType: "stop" }
        return { success: true, message: "Run stopped" };
      }
      default: return { success: false, message: "Unknown command" };
    }
  }

  async getProgress(): Promise<number> {
    // GET /runs/{id} → check completedCommandCount / totalCommandCount
    return 0;
  }

  onEvidence(cb: (e: Omit<EvidenceEvent, "id" | "hash">) => void) { this.callbacks.push(cb); }
  async dispose() { /* cleanup */ }
}`,

  octoprint: `import type { MachineAdapter, MachineCommand, MachineCommandResult, MachineStatus } from "@pcc/kernel";
import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";

interface OctoPrintConfig {
  url: string;      // e.g., "http://192.168.1.50"
  apiKey: string;    // OctoPrint API key
  mockMode?: boolean;
}

export class MyOctoPrintAdapter implements MachineAdapter {
  readonly id: string;
  readonly type = "fdm" as any;
  readonly source: EvidenceSource;
  private config: OctoPrintConfig;
  private callbacks: Array<(e: Omit<EvidenceEvent, "id" | "hash">) => void> = [];

  constructor(id: string, config: OctoPrintConfig) {
    this.id = id;
    this.config = config;
    this.source = { deviceId: id, deviceType: "printer", kernelId: id };
  }

  private headers() { return { "X-Api-Key": this.config.apiKey, "Content-Type": "application/json" }; }

  async getStatus(): Promise<MachineStatus> {
    try {
      const res = await fetch(\`\${this.config.url}/api/printer\`, { headers: this.headers() });
      if (!res.ok) return "offline";
      const data = await res.json() as any;
      return data.state?.flags?.printing ? "busy" : "idle";
    } catch { return "offline"; }
  }

  async execute(cmd: MachineCommand): Promise<MachineCommandResult> {
    switch (cmd.type) {
      case "load_gcode": {
        // Upload: POST /api/files/local (multipart)
        return { success: true, message: "G-code uploaded" };
      }
      case "start": {
        // POST /api/job { command: "start" }
        await fetch(\`\${this.config.url}/api/job\`, {
          method: "POST", headers: this.headers(),
          body: JSON.stringify({ command: "start" }),
        });
        return { success: true, message: "Print started" };
      }
      case "pause": {
        await fetch(\`\${this.config.url}/api/job\`, {
          method: "POST", headers: this.headers(),
          body: JSON.stringify({ command: "pause", action: "toggle" }),
        });
        return { success: true, message: "Paused" };
      }
      case "stop": {
        await fetch(\`\${this.config.url}/api/job\`, {
          method: "POST", headers: this.headers(),
          body: JSON.stringify({ command: "cancel" }),
        });
        return { success: true, message: "Cancelled" };
      }
      default: return { success: false, message: "Unknown command" };
    }
  }

  async getProgress(): Promise<number> {
    const res = await fetch(\`\${this.config.url}/api/job\`, { headers: this.headers() });
    const data = await res.json() as any;
    return data.progress?.completion ?? 0;
  }

  onEvidence(cb: (e: Omit<EvidenceEvent, "id" | "hash">) => void) { this.callbacks.push(cb); }
  async dispose() { /* cleanup */ }
}`,

  opcua: `import type { MachineAdapter, MachineCommand, MachineCommandResult, MachineStatus } from "@pcc/kernel";
import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";
// import { OPCUAClient, DataType } from "node-opcua";

interface OPCUAConfig {
  endpointUrl: string;  // e.g., "opc.tcp://192.168.1.10:4840"
  mockMode?: boolean;
}

export class MyOPCUAAdapter implements MachineAdapter {
  readonly id: string;
  readonly type = "cnc-3axis" as any;
  readonly source: EvidenceSource;
  private config: OPCUAConfig;
  private callbacks: Array<(e: Omit<EvidenceEvent, "id" | "hash">) => void> = [];

  constructor(id: string, config: OPCUAConfig) {
    this.id = id;
    this.config = config;
    this.source = { deviceId: id, deviceType: "machine", kernelId: id };
  }

  async getStatus(): Promise<MachineStatus> {
    // Connect OPC-UA client, read machine state node
    // const client = OPCUAClient.create({});
    // await client.connect(this.config.endpointUrl);
    return "idle"; // Replace with real OPC-UA read
  }

  async execute(cmd: MachineCommand): Promise<MachineCommandResult> {
    switch (cmd.type) {
      case "load_gcode": {
        // Write NC program to machine via OPC-UA
        return { success: true, message: "Program loaded" };
      }
      case "start": {
        // Write CycleStart node
        return { success: true, message: "Cycle started" };
      }
      case "stop": {
        // Write FeedHold node
        return { success: true, message: "Feed hold" };
      }
      default: return { success: false, message: "Unknown command" };
    }
  }

  async getProgress(): Promise<number> {
    // Read program progress from OPC-UA node
    return 0;
  }

  onEvidence(cb: (e: Omit<EvidenceEvent, "id" | "hash">) => void) { this.callbacks.push(cb); }
  async dispose() { /* Disconnect OPC-UA client */ }
}`,

  sila: `import type { MachineAdapter, MachineCommand, MachineCommandResult, MachineStatus } from "@pcc/kernel";
import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";

interface SiLAConfig {
  url: string;       // e.g., "http://192.168.1.20:50052"
  deviceType: string; // "hplc" | "pcr" | "centrifuge" | etc.
  mockMode?: boolean;
}

export class MySiLAAdapter implements MachineAdapter {
  readonly id: string;
  readonly type: string;
  readonly source: EvidenceSource;
  private config: SiLAConfig;
  private callbacks: Array<(e: Omit<EvidenceEvent, "id" | "hash">) => void> = [];

  constructor(id: string, config: SiLAConfig) {
    this.id = id;
    this.type = config.deviceType as any;
    this.config = config;
    this.source = { deviceId: id, deviceType: "instrument", kernelId: id };
  }

  async getStatus(): Promise<MachineStatus> {
    // SiLA 2: call GetServerInfo to check connectivity
    return "idle";
  }

  async execute(cmd: MachineCommand): Promise<MachineCommandResult> {
    switch (cmd.type) {
      case "start": return { success: true, message: "Run started" };
      case "stop": return { success: true, message: "Run stopped" };
      default: return { success: false, message: "Unknown command" };
    }
  }

  async getProgress(): Promise<number> { return 0; }
  onEvidence(cb: (e: Omit<EvidenceEvent, "id" | "hash">) => void) { this.callbacks.push(cb); }
  async dispose() { /* cleanup */ }
}`,

  "generic-http": `import type { MachineAdapter, MachineCommand, MachineCommandResult, MachineStatus } from "@pcc/kernel";
import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";

interface GenericHTTPConfig {
  baseUrl: string;
  endpoints: {
    status: string;   // GET → { status: "idle" | "busy" }
    start: string;    // POST → starts job
    stop: string;     // POST → stops job
    progress: string; // GET → { progress: 0-100 }
  };
  headers?: Record<string, string>;
  mockMode?: boolean;
}

export class MyGenericHTTPAdapter implements MachineAdapter {
  readonly id: string;
  readonly type = "custom" as any;
  readonly source: EvidenceSource;
  private config: GenericHTTPConfig;
  private callbacks: Array<(e: Omit<EvidenceEvent, "id" | "hash">) => void> = [];

  constructor(id: string, config: GenericHTTPConfig) {
    this.id = id;
    this.config = config;
    this.source = { deviceId: id, deviceType: "machine", kernelId: id };
  }

  async getStatus(): Promise<MachineStatus> {
    const res = await fetch(\`\${this.config.baseUrl}\${this.config.endpoints.status}\`, {
      headers: this.config.headers,
    });
    const data = await res.json() as any;
    return data.status ?? "offline";
  }

  async execute(cmd: MachineCommand): Promise<MachineCommandResult> {
    const endpoint = cmd.type === "start" ? this.config.endpoints.start
                   : cmd.type === "stop" ? this.config.endpoints.stop
                   : null;
    if (!endpoint) return { success: false, message: "Unknown command" };

    const res = await fetch(\`\${this.config.baseUrl}\${endpoint}\`, {
      method: "POST", headers: { ...this.config.headers, "Content-Type": "application/json" },
      body: JSON.stringify(cmd.payload ?? {}),
    });
    return { success: res.ok, message: res.ok ? "OK" : "Failed" };
  }

  async getProgress(): Promise<number> {
    const res = await fetch(\`\${this.config.baseUrl}\${this.config.endpoints.progress}\`, {
      headers: this.config.headers,
    });
    const data = await res.json() as any;
    return data.progress ?? 0;
  }

  onEvidence(cb: (e: Omit<EvidenceEvent, "id" | "hash">) => void) { this.callbacks.push(cb); }
  async dispose() { /* cleanup */ }
}`,
};

// ── MCP Template Builder ──────────────────────────────────────────

function buildMcpTemplate(deviceType: string, guide: IntegrationGuide): string {
  const tools = guide.keyActions.map((action) => {
    return `server.tool("${action}", "${action.replace(/_/g, " ")}", {
  // Add Zod parameters here
}, async (params) => {
  // Call your adapter method
  return { content: [{ type: "text", text: JSON.stringify({ action: "${action}", result: "ok" }) }] };
});`;
  }).join("\n\n");

  return `/**
 * MCP Server for ${guide.displayName}
 * Auto-generated template — customize for your specific device.
 *
 * Install: npm install @anthropic-ai/sdk zod
 * Run: node mcp-server.js
 * Configure in .mcp.json:
 *   "${deviceType}-mcp": { "command": "node", "args": ["mcp-server.js"] }
 */
import { McpServer } from "@anthropic-ai/sdk/mcp";
import { z } from "zod";

const server = new McpServer({
  name: "${deviceType}-mcp",
  version: "1.0.0",
});

// ── Device Connection ──
// Protocol: ${guide.driverHints.protocol}
// Default port: ${guide.driverHints.defaultPort}
// Test connection: ${guide.driverHints.connectionPattern}

const DEVICE_URL = process.env.DEVICE_URL ?? "http://localhost:${guide.driverHints.defaultPort}";

// ── Tools ──

server.tool("status", "Get device status", {}, async () => {
  // Replace with real device query
  return { content: [{ type: "text", text: JSON.stringify({ status: "idle", device: "${deviceType}" }) }] };
});

${tools}

// ── Start Server ──
server.run({ transport: "stdio" });
console.error("${guide.displayName} MCP server running on stdio");
`;
}
