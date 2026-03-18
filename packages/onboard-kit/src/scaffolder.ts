/**
 * Scaffolder — generates a complete kernel project from an OnboardConfig.
 *
 * Given a configuration describing your devices, capabilities, and kernel settings,
 * this generates all the boilerplate code needed to run on the PCC network.
 */

import type { OnboardConfig, AdapterManifest } from "./types.js";

export interface ScaffoldOptions {
  /** The onboarding configuration */
  config: OnboardConfig;
  /** Output directory (default: current directory) */
  outputDir?: string;
  /** Whether to overwrite existing files */
  overwrite?: boolean;
}

export interface GeneratedFile {
  path: string;
  content: string;
  description: string;
}

export interface ScaffoldResult {
  files: GeneratedFile[];
  summary: string;
}

export function scaffold(options: ScaffoldOptions): ScaffoldResult {
  const { config } = options;
  const files: GeneratedFile[] = [];

  // 1. Generate package.json
  files.push({
    path: "package.json",
    content: generatePackageJson(config),
    description: "Node.js package configuration",
  });

  // 2. Generate tsconfig.json
  files.push({
    path: "tsconfig.json",
    content: generateTsConfig(),
    description: "TypeScript configuration",
  });

  // 3. Generate adapter files
  for (const adapter of config.adapters) {
    files.push({
      path: `src/adapters/${toKebabCase(adapter.className)}.ts`,
      content: generateAdapter(adapter, config.kernel.kernelId),
      description: `${adapter.adapterType} adapter for ${adapter.adapterId}`,
    });
  }

  // 4. Generate capabilities definition
  files.push({
    path: "src/capabilities.ts",
    content: generateCapabilities(config),
    description: "Capability definitions for the PCC network",
  });

  // 5. Generate kernel entry point
  files.push({
    path: "src/kernel.ts",
    content: generateKernelEntryPoint(config),
    description: "Shop Kernel entry point — starts adapters, evidence collection, HTTP server",
  });

  // 6. Generate agent entry point
  files.push({
    path: "src/agent.ts",
    content: generateAgentEntryPoint(config),
    description: "Kernel Agent entry point — connects to A2A network, handles intents",
  });

  // 7. Generate .env template
  files.push({
    path: ".env.example",
    content: generateEnvTemplate(config),
    description: "Environment variable template",
  });

  // 8. Generate machine profiles (if defined)
  if (config.profiles && config.profiles.length > 0) {
    files.push({
      path: "src/profiles.ts",
      content: generateProfiles(config),
      description: "Machine profiles for the contract builder",
    });
  }

  // 9. Generate test file
  files.push({
    path: "src/__tests__/adapters.test.ts",
    content: generateTests(config),
    description: "Adapter integration tests",
  });

  const summary = [
    `Scaffolded ${files.length} files for kernel "${config.kernel.name}"`,
    `  Kernel ID: ${config.kernel.kernelId}`,
    `  Adapters: ${config.adapters.length} (${config.adapters.map(a => a.className).join(", ")})`,
    `  Capabilities: ${config.capabilities.length} (${config.capabilities.map(c => c.type).join(", ")})`,
    `  Profiles: ${config.profiles?.length ?? 0}`,
    "",
    "Next steps:",
    "  1. Copy .env.example to .env and fill in your device credentials",
    "  2. Run: pnpm install",
    "  3. Run: pnpm build",
    "  4. Test mock mode: npx tsx src/kernel.ts",
    "  5. Test with agents: npx tsx src/agent.ts",
    "  6. Connect to live network: set GATEWAY_URL in .env",
  ].join("\n");

  return { files, summary };
}

// ── Code Generators ─────────────────────────────────────────────────

function generatePackageJson(config: OnboardConfig): string {
  return JSON.stringify({
    name: `@pcc/kernel-${toKebabCase(config.kernel.name)}`,
    version: "0.1.0",
    private: true,
    description: `PCC Shop Kernel: ${config.kernel.name}`,
    type: "module",
    scripts: {
      build: "tsc",
      test: "vitest run --passWithNoTests",
      start: "tsx src/kernel.ts",
      agent: "tsx src/agent.ts",
    },
    dependencies: {
      "@pcc/spec": "workspace:*",
      "@pcc/kernel": "workspace:*",
      "@pcc/a2a": "workspace:*",
      "@pcc/agent-runtime": "workspace:*",
      "@pcc/agent-kernel": "workspace:*",
      "@pcc/contract-builder": "workspace:*",
      fastify: "^4.0.0",
    },
    devDependencies: {
      vitest: "^1.6.0",
      tsx: "^4.11.0",
    },
  }, null, 2);
}

function generateTsConfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      declaration: true,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      outDir: "dist",
      rootDir: "src",
    },
    include: ["src/**/*"],
  }, null, 2);
}

function generateAdapter(adapter: AdapterManifest, kernelId: string): string {
  if (adapter.protocol === "http" && adapter.adapterType === "machine") {
    return generateHttpMachineAdapter(adapter, kernelId);
  }
  if (adapter.adapterType === "sensor") {
    return generateSensorAdapterCode(adapter, kernelId);
  }
  if (adapter.adapterType === "camera") {
    return generateCameraAdapterCode(adapter, kernelId);
  }
  return generateHttpMachineAdapter(adapter, kernelId);
}

function generateHttpMachineAdapter(adapter: AdapterManifest, kernelId: string): string {
  const statusEndpoint = adapter.endpoints?.find(e => e.purpose === "status");
  const startEndpoint = adapter.endpoints?.find(e => e.purpose === "start");
  const stopEndpoint = adapter.endpoints?.find(e => e.purpose === "stop");
  const progressEndpoint = adapter.endpoints?.find(e => e.purpose === "progress");
  const loadEndpoint = adapter.endpoints?.find(e => e.purpose === "load_program");

  return `/**
 * ${adapter.className} — PCC adapter for ${adapter.adapterId}
 * Protocol: ${adapter.protocol}
 * Generated by @pcc/onboard-kit scaffolder
 */

import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";

type MachineStatus = "idle" | "busy" | "error" | "offline" | "maintenance";

interface MachineCommand {
  type: "load_gcode" | "start" | "pause" | "resume" | "stop" | "status";
  payload?: Record<string, unknown>;
}

interface MachineCommandResult {
  success: boolean;
  message?: string;
  data?: Record<string, unknown>;
}

export interface ${adapter.className}Config {
  /** Base URL of the device API */
  baseUrl: string;
  /** API key or auth token */
  apiKey?: string;
  /** Poll interval in ms (default ${adapter.pollIntervalMs ?? 2000}) */
  pollIntervalMs?: number;
  /** Use mock mode (no real HTTP calls) */
  mockMode?: boolean;
}

export class ${adapter.className} {
  readonly id: string;
  readonly type = "${adapter.adapterType === "machine" ? "fdm" : adapter.adapterType}" as const;
  readonly source: EvidenceSource;

  private config: ${adapter.className}Config;
  private listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastProgress = 0;

  constructor(id: string, config: ${adapter.className}Config) {
    this.id = id;
    this.config = config;
    this.source = {
      deviceId: id,
      deviceType: "${adapter.deviceType}",
      kernelId: "${kernelId}",
      firmwareVersion: "${adapter.firmwareVersion}",
    };
  }

  async getStatus(): Promise<MachineStatus> {
    if (this.config.mockMode) return "idle";

    try {
      const res = await this.apiGet("${statusEndpoint?.path ?? "/api/status"}");
      // TODO: Map your device's status field to PCC status
      // Example: return res.state === "running" ? "busy" : "idle";
      return "idle";
    } catch {
      return "offline";
    }
  }

  async getProgress(): Promise<number> {
    if (this.config.mockMode) return 0;

    try {
      const res = await this.apiGet("${progressEndpoint?.path ?? "/api/progress"}");
      // TODO: Extract progress (0-100) from your device's response
      // Example: return res.percentComplete ?? 0;
      return 0;
    } catch {
      return 0;
    }
  }

  async execute(command: MachineCommand): Promise<MachineCommandResult> {
    switch (command.type) {
      case "load_gcode": {
        ${loadEndpoint
    ? `await this.apiPost("${loadEndpoint.path}", { filename: command.payload?.filename });`
    : '// TODO: Upload program to your device\n        // await this.apiPost("/api/programs/upload", { file: command.payload?.filename });'}

        this.emit({
          type: "gcode_received",
          timestamp: new Date().toISOString(),
          source: this.source,
          payload: { gcodeHash: command.payload?.gcodeHash },
        });
        return { success: true, message: "Program loaded" };
      }

      case "start": {
        ${startEndpoint
    ? `await this.apiPost("${startEndpoint.path}", {});`
    : '// TODO: Start your device\n        // await this.apiPost("/api/job/start", {});'}

        this.emit({
          type: "execution_started",
          timestamp: new Date().toISOString(),
          source: this.source,
          payload: {},
        });
        this.startPolling();
        return { success: true, message: "Started" };
      }

      case "stop": {
        ${stopEndpoint
    ? `await this.apiPost("${stopEndpoint.path}", {});`
    : '// TODO: Stop your device\n        // await this.apiPost("/api/job/stop", {});'}
        this.stopPolling();
        return { success: true, message: "Stopped" };
      }

      case "status": {
        const status = await this.getStatus();
        const progress = await this.getProgress();
        return { success: true, data: { status, progress } };
      }

      default:
        return { success: false, message: \`Unknown command: \${command.type}\` };
    }
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.listeners.push(callback);
  }

  async dispose(): Promise<void> {
    this.stopPolling();
    this.listeners = [];
  }

  // ── HTTP helpers ────────────────────────────────────────────────

  private async apiGet(path: string): Promise<Record<string, any>> {
    const headers: Record<string, string> = {};
    if (this.config.apiKey) headers["X-Api-Key"] = this.config.apiKey;

    const res = await fetch(\`\${this.config.baseUrl}\${path}\`, { headers });
    if (!res.ok) throw new Error(\`GET \${path}: \${res.status}\`);
    return res.json();
  }

  private async apiPost(path: string, body: Record<string, unknown>): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) headers["X-Api-Key"] = this.config.apiKey;

    const res = await fetch(\`\${this.config.baseUrl}\${path}\`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(\`POST \${path}: \${res.status}\`);
  }

  // ── Polling ─────────────────────────────────────────────────────

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(async () => {
      try {
        const progress = await this.getProgress();
        if (Math.floor(progress / 25) > Math.floor(this.lastProgress / 25)) {
          this.emit({
            type: "execution_progress",
            timestamp: new Date().toISOString(),
            source: this.source,
            payload: { progress },
          });
        }
        if (this.lastProgress < 100 && progress >= 100) {
          this.emit({
            type: "execution_completed",
            timestamp: new Date().toISOString(),
            source: this.source,
            payload: { progress: 100 },
          });
          this.stopPolling();
        }
        this.lastProgress = progress;
      } catch {}
    }, this.config.pollIntervalMs ?? ${adapter.pollIntervalMs ?? 2000});
  }

  private stopPolling(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  private emit(event: Omit<EvidenceEvent, "id" | "hash">): void {
    for (const listener of this.listeners) listener(event);
  }
}
`;
}

function generateSensorAdapterCode(adapter: AdapterManifest, kernelId: string): string {
  return `/**
 * ${adapter.className} — PCC sensor adapter for ${adapter.adapterId}
 * Generated by @pcc/onboard-kit scaffolder
 */

import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";

export interface ${adapter.className}Config {
  readingUrl: string;
  apiKey?: string;
  sampleIntervalMs?: number;
  mockMode?: boolean;
}

export class ${adapter.className} {
  readonly id: string;
  readonly type = "power_monitor" as const;
  readonly source: EvidenceSource;

  private config: ${adapter.className}Config;
  private listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private samples: Array<{ timestamp: string; value: number }> = [];

  constructor(id: string, config: ${adapter.className}Config) {
    this.id = id;
    this.config = config;
    this.source = {
      deviceId: id,
      deviceType: "sensor",
      kernelId: "${kernelId}",
      firmwareVersion: "${adapter.firmwareVersion}",
    };
  }

  async startRecording(jobId: string): Promise<void> {
    this.samples = [];
    this.pollTimer = setInterval(async () => {
      try {
        // TODO: Read from your sensor's API
        const value = this.config.mockMode
          ? Math.random() * 500 + 100
          : await this.readSensor();
        this.samples.push({ timestamp: new Date().toISOString(), value });
        this.emit({
          type: "sensor_reading",
          timestamp: new Date().toISOString(),
          source: this.source,
          payload: { value, jobId },
        });
      } catch {}
    }, this.config.sampleIntervalMs ?? 1000);
  }

  async stopRecording(): Promise<Omit<EvidenceEvent, "id" | "hash">> {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    const values = this.samples.map(s => s.value);
    return {
      type: "sensor_data_summary",
      timestamp: new Date().toISOString(),
      source: this.source,
      payload: {
        sampleCount: values.length,
        statistics: values.length > 0 ? {
          min: Math.min(...values),
          max: Math.max(...values),
          mean: values.reduce((a, b) => a + b, 0) / values.length,
        } : {},
        samples: this.samples,
      },
    };
  }

  async getCurrentReading(): Promise<Record<string, unknown>> {
    const value = this.config.mockMode ? Math.random() * 500 : await this.readSensor();
    return { value, timestamp: new Date().toISOString() };
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.listeners.push(callback);
  }

  async dispose(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.listeners = [];
  }

  private async readSensor(): Promise<number> {
    const res = await fetch(this.config.readingUrl);
    const data = await res.json();
    // TODO: Extract value from your sensor's response
    return Number(data.value ?? data.watts ?? 0);
  }

  private emit(event: Omit<EvidenceEvent, "id" | "hash">): void {
    for (const listener of this.listeners) listener(event);
  }
}
`;
}

function generateCameraAdapterCode(adapter: AdapterManifest, kernelId: string): string {
  return `/**
 * ${adapter.className} — PCC camera adapter for ${adapter.adapterId}
 * Generated by @pcc/onboard-kit scaffolder
 */

import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";

export interface ${adapter.className}Config {
  captureUrl: string;
  inspectUrl?: string;
  apiKey?: string;
  mockMode?: boolean;
}

export class ${adapter.className} {
  readonly id: string;
  readonly source: EvidenceSource;

  private config: ${adapter.className}Config;
  private listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];

  constructor(id: string, config: ${adapter.className}Config) {
    this.id = id;
    this.config = config;
    this.source = {
      deviceId: id,
      deviceType: "camera",
      kernelId: "${kernelId}",
      firmwareVersion: "${adapter.firmwareVersion}",
    };
  }

  async captureSnapshot(): Promise<{ imageHash: string; storageRef: string }> {
    if (this.config.mockMode) {
      const hash = \`mock_\${Date.now()}\`;
      this.emit({ type: "camera_snapshot", timestamp: new Date().toISOString(), source: this.source, payload: { imageHash: hash } });
      return { imageHash: hash, storageRef: \`mock://\${hash}\` };
    }
    // TODO: Call your camera's capture endpoint
    const res = await fetch(this.config.captureUrl, { method: "POST" });
    const data = await res.json();
    const imageHash = String(data.hash ?? data.imageHash ?? "");
    this.emit({ type: "camera_snapshot", timestamp: new Date().toISOString(), source: this.source, payload: { imageHash } });
    return { imageHash, storageRef: data.url ?? "" };
  }

  async runInspection(referenceHash?: string): Promise<{ passed: boolean; confidence: number; findings: string[]; imageHash: string }> {
    const snap = await this.captureSnapshot();
    if (this.config.mockMode) {
      const passed = Math.random() > 0.05;
      this.emit({ type: "cv_inspection_result", timestamp: new Date().toISOString(), source: this.source, payload: { passed, confidence: passed ? 0.95 : 0.3, findings: passed ? [] : ["defect"] } });
      return { passed, confidence: passed ? 0.95 : 0.3, findings: passed ? [] : ["defect"], imageHash: snap.imageHash };
    }
    // TODO: Call your inspection endpoint
    return { passed: true, confidence: 1.0, findings: [], imageHash: snap.imageHash };
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.listeners.push(callback);
  }

  async dispose(): Promise<void> { this.listeners = []; }

  private emit(event: Omit<EvidenceEvent, "id" | "hash">): void {
    for (const listener of this.listeners) listener(event);
  }
}
`;
}

function generateCapabilities(config: OnboardConfig): string {
  const caps = config.capabilities.map(cap => `  {
    id: ids.capability(),
    kernelId: "${config.kernel.kernelId}",
    type: "${cap.type}",
    name: "${cap.name}",
    description: ${cap.description ? `"${cap.description}"` : "undefined"},
    materials: ${JSON.stringify(cap.materials)},
    tolerances: ${JSON.stringify(cap.tolerances ?? {})},
    workEnvelope: ${JSON.stringify(cap.workEnvelope ?? {})},
    assuranceTiers: ${JSON.stringify(cap.assuranceTiers)},
    pricing: ${JSON.stringify(cap.pricing)},
    location: ${JSON.stringify(config.kernel.location)},
    queueDepth: 0,
  }`).join(",\n");

  return `import type { Capability } from "@pcc/spec";
import { ids } from "@pcc/spec";

export const capabilities: Capability[] = [
${caps}
];
`;
}

function generateKernelEntryPoint(config: OnboardConfig): string {
  const adapterImports = config.adapters.map(a =>
    `import { ${a.className} } from "./adapters/${toKebabCase(a.className)}.js";`
  ).join("\n");

  const adapterInits = config.adapters.map(a => {
    if (a.adapterType === "machine") {
      return `const ${toCamelCase(a.adapterId)} = new ${a.className}("${a.adapterId}", {
  baseUrl: process.env.${toEnvVar(a.adapterId)}_URL ?? "${a.connectionString}",
  apiKey: process.env.${toEnvVar(a.adapterId)}_API_KEY,
  mockMode: process.env.MOCK_MODE === "true",
});`;
    }
    if (a.adapterType === "sensor") {
      return `const ${toCamelCase(a.adapterId)} = new ${a.className}("${a.adapterId}", {
  readingUrl: process.env.${toEnvVar(a.adapterId)}_URL ?? "${a.connectionString}",
  mockMode: process.env.MOCK_MODE === "true",
});`;
    }
    return `const ${toCamelCase(a.adapterId)} = new ${a.className}("${a.adapterId}", {
  captureUrl: process.env.${toEnvVar(a.adapterId)}_URL ?? "${a.connectionString}",
  mockMode: process.env.MOCK_MODE === "true",
});`;
  }).join("\n\n");

  const machineAdapter = config.adapters.find(a => a.adapterType === "machine");
  const sensorAdapters = config.adapters.filter(a => a.adapterType === "sensor");
  const cameraAdapter = config.adapters.find(a => a.adapterType === "camera");

  return `/**
 * Shop Kernel entry point for ${config.kernel.name}
 * Generated by @pcc/onboard-kit scaffolder
 *
 * Start with: npx tsx src/kernel.ts
 * Environment: MOCK_MODE=true for testing without real hardware
 */

import { EvidenceEmitter, JobRunner } from "@pcc/kernel";
import { capabilities } from "./capabilities.js";
${adapterImports}

const KERNEL_ID = "${config.kernel.kernelId}";

// ── Initialize adapters ───────────────────────────────────────────

${adapterInits}

// ── Initialize evidence pipeline ──────────────────────────────────

const evidenceEmitter = new EvidenceEmitter(KERNEL_ID);

evidenceEmitter.onBundle((bundle) => {
  console.log(\`[EVIDENCE] Bundle finalized: \${bundle.id}\`);
  console.log(\`  Hash: \${bundle.bundleHash}\`);
  console.log(\`  Events: \${bundle.events.length}\`);
});

// ── Initialize job runner ─────────────────────────────────────────

const jobRunner = new JobRunner(
  ${machineAdapter ? toCamelCase(machineAdapter.adapterId) : "null /* TODO: add machine adapter */"},
  [${sensorAdapters.map(a => toCamelCase(a.adapterId)).join(", ")}],
  ${cameraAdapter ? toCamelCase(cameraAdapter.adapterId) : "null"},
  evidenceEmitter,
);

// ── Kernel ready ──────────────────────────────────────────────────

console.log(\`[KERNEL] \${KERNEL_ID} initialized\`);
console.log(\`  Capabilities: \${capabilities.map(c => c.type).join(", ")}\`);
console.log(\`  Mock mode: \${process.env.MOCK_MODE === "true"}\`);

export { KERNEL_ID, capabilities, jobRunner, evidenceEmitter };
`;
}

function generateAgentEntryPoint(config: OnboardConfig): string {
  return `/**
 * Kernel Agent entry point for ${config.kernel.name}
 * Generated by @pcc/onboard-kit scaffolder
 *
 * Start with: npx tsx src/agent.ts
 * This connects your kernel to the PCC A2A network.
 */

import { MessageBus } from "@pcc/a2a";
import { KernelAgent } from "@pcc/agent-kernel";
import { capabilities } from "./capabilities.js";
${config.profiles?.length ? 'import { profiles } from "./profiles.js";\n' : ""}

const KERNEL_ID = "${config.kernel.kernelId}";
const GATEWAY_URL = process.env.GATEWAY_URL ?? "${config.kernel.gatewayUrl}";

// ── Create message bus ────────────────────────────────────────────

const bus = new MessageBus();

// ── Create kernel agent ───────────────────────────────────────────

const kernelAgent = new KernelAgent(bus, {
  kernelId: KERNEL_ID,
  name: "${config.kernel.name}",
  location: ${JSON.stringify(config.kernel.location)},
  capabilities,
  mockPrintDuration: 3000,  // Fast mock for testing
  ${config.profiles?.length ? "machineProfiles: profiles," : "// machineProfiles: [],  // Add machine profiles for contract builder"}
  gatewayUrl: GATEWAY_URL,
});

// ── Start ─────────────────────────────────────────────────────────

kernelAgent.start();

console.log(\`[AGENT] Kernel agent started: \${kernelAgent.id}\`);
console.log(\`  Kernel: \${KERNEL_ID}\`);
console.log(\`  Capabilities: \${capabilities.map(c => c.type).join(", ")}\`);
console.log(\`  Gateway: \${GATEWAY_URL}\`);
console.log(\`  Wallet: \${kernelAgent.wallet?.address ?? "not configured"}\`);
console.log("");
console.log("Waiting for jobs from the PCC network...");

// ── Graceful shutdown ─────────────────────────────────────────────

process.on("SIGINT", () => {
  console.log("\\n[AGENT] Shutting down...");
  kernelAgent.stop();
  process.exit(0);
});

export { kernelAgent, bus };
`;
}

function generateEnvTemplate(config: OnboardConfig): string {
  const lines = [
    `# ${config.kernel.name} — Environment Variables`,
    `# Copy to .env and fill in real values`,
    "",
    "# Kernel wallet (for signing messages + receiving payment)",
    `${config.kernel.walletPrivateKeyEnvVar}=0x_YOUR_PRIVATE_KEY_HERE`,
    "",
    "# PCC Gateway URL",
    `GATEWAY_URL=${config.kernel.gatewayUrl}`,
    "",
    "# Set to true for testing without real hardware",
    "MOCK_MODE=true",
    "",
    "# Device connections",
  ];

  for (const adapter of config.adapters) {
    lines.push(`${toEnvVar(adapter.adapterId)}_URL=${adapter.connectionString}`);
    if (adapter.endpoints?.some(e => e.auth)) {
      lines.push(`${toEnvVar(adapter.adapterId)}_API_KEY=your_api_key_here`);
    }
  }

  return lines.join("\n") + "\n";
}

function generateProfiles(config: OnboardConfig): string {
  const profileDefs = (config.profiles ?? []).map(p => `  {
    id: "${p.profileId}",
    profileName: "${p.profileName}",
    kernelId: "${config.kernel.kernelId}",
    capabilityType: "${p.capabilityType}",
    paramOverrides: ${JSON.stringify(p.paramOverrides ?? {}, null, 4)},
    pricingOverrides: ${JSON.stringify(p.pricingOverrides ?? {}, null, 4)},
  }`).join(",\n");

  return `export const profiles = [
${profileDefs}
];
`;
}

function generateTests(config: OnboardConfig): string {
  const testCases = config.adapters.map(a => `
  describe("${a.className}", () => {
    it("should create adapter in mock mode", () => {
      const adapter = new ${a.className}("test-${a.adapterId}", {
        ${a.adapterType === "machine" ? 'baseUrl: "http://mock:8080"' :
    a.adapterType === "sensor" ? 'readingUrl: "http://mock:9090/reading"' :
      'captureUrl: "http://mock:8000/capture"'},
        mockMode: true,
      });
      expect(adapter.id).toBe("test-${a.adapterId}");
    });

    ${a.adapterType === "machine" ? `it("should emit evidence on execute", async () => {
      const adapter = new ${a.className}("test-${a.adapterId}", {
        baseUrl: "http://mock:8080",
        mockMode: true,
      });
      const events: any[] = [];
      adapter.onEvidence((e) => events.push(e));
      await adapter.execute({ type: "load_gcode", payload: { filename: "test.nc" } });
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe("gcode_received");
    });` : ""}
  });`).join("\n");

  const imports = config.adapters.map(a =>
    `import { ${a.className} } from "../adapters/${toKebabCase(a.className)}.js";`
  ).join("\n");

  return `import { describe, it, expect } from "vitest";
${imports}

${testCases}
`;
}

// ── Utility helpers ─────────────────────────────────────────────────

function toKebabCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

function toCamelCase(str: string): string {
  return str.replace(/[-_](.)/g, (_, c) => c.toUpperCase());
}

function toEnvVar(str: string): string {
  return str.replace(/[-]/g, "_").toUpperCase();
}
