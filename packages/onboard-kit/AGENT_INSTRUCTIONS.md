# PCC Onboard Kit — Instructions for AI Agents

You are being given this document so you can onboard your team's physical equipment (machines, instruments, sensors) onto the **Physical Capability Cloud Platform (PCCP)**. After completing these steps, your equipment will be discoverable by user agents across the network, able to receive and execute jobs, collect cryptographic evidence, and receive payments via on-chain milestone escrow.

This document is your complete technical reference. Follow it sequentially.

---

## Table of Contents

1. [What You're Building](#1-what-youre-building)
2. [Architecture Overview](#2-architecture-overview)
3. [Prerequisites](#3-prerequisites)
4. [Step 1: Define Your Capabilities](#step-1-define-your-capabilities)
5. [Step 2: Write Device Adapters](#step-2-write-device-adapters)
6. [Step 3: Configure Your Shop Kernel](#step-3-configure-your-shop-kernel)
7. [Step 4: Create a Kernel Agent](#step-4-create-a-kernel-agent)
8. [Step 5: Register Machine Profiles (Contract Builder)](#step-5-register-machine-profiles)
9. [Step 6: Connect to the Network](#step-6-connect-to-the-network)
10. [Step 7: Handle Jobs End-to-End](#step-7-handle-jobs-end-to-end)
11. [Step 8: Evidence Collection & Assurance Tiers](#step-8-evidence-collection)
12. [Step 9: Settlement & Payments](#step-9-settlement--payments)
13. [Step 10: Protocol Execution](#step-10-protocol-execution)
14. [Step 11: Testing & Validation](#step-11-testing--validation)
15. [Step 12: Go Live Checklist](#step-12-go-live-checklist)
16. [Appendix A: Complete Type Reference](#appendix-a-type-reference)
17. [Appendix B: Evidence Event Types](#appendix-b-evidence-event-types)
18. [Appendix C: Adapter Protocol Reference](#appendix-c-adapter-protocols)
19. [Appendix D: Troubleshooting](#appendix-d-troubleshooting)

---

## 1. What You're Building

You are creating a **Shop Kernel** — the PCC equivalent of an AWS Availability Zone, but for physical equipment. Your kernel:

- **Wraps** your device's API endpoints into PCC adapter interfaces
- **Advertises** capabilities (not machines — what machines can DO)
- **Accepts** jobs from the A2A (Agent-to-Agent) network via typed intents
- **Executes** work on your physical equipment
- **Collects** cryptographic evidence (sensor data, camera frames, power profiles)
- **Submits** content-addressed evidence bundles for verification
- **Receives** payment through milestone escrow when evidence passes verification

**Key concept**: PCC sells *capabilities*, not machine time. A capability like "fdm" (FDM 3D printing) is a billable unit that describes what your machine can do, including materials, tolerances, work envelope, and pricing.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        PCC Network                               │
│                                                                  │
│  User Agent ──→ Broker Agent ──→ YOUR Kernel Agent               │
│  (discovers)    (routes/quotes)  (accepts jobs)                  │
│                                                                  │
│                                  ↓                               │
│                           YOUR Shop Kernel                       │
│                           ┌──────────────┐                       │
│                           │ Device Adapters (your API wrappers) │
│                           │ Evidence Emitter (collects proof)   │
│                           │ Job Runner (orchestrates execution) │
│                           │ Sensor Pipeline (processes data)    │
│                           │ Batch Tracker (multi-sample runs)   │
│                           └──────────────┘                       │
│                                  ↓                               │
│                           Your Physical Equipment                │
│                           (CNC, printer, HPLC, robot, etc.)     │
└─────────────────────────────────────────────────────────────────┘
```

**Data flow for a job:**
1. User agent discovers your capability via broker
2. User agent requests a quote → broker routes to your kernel agent
3. User agent submits a workflow (CWM) → broker compiles execution plan
4. User funds escrow contract on-chain
5. Broker dispatches job to your kernel agent
6. Your kernel agent runs the job via adapters → collects evidence
7. Evidence bundle submitted on-chain → verifier attests
8. Challenge window expires → payment released to your wallet

---

## 3. Prerequisites

### Install PCC packages
```bash
pnpm add @pcc/spec @pcc/kernel @pcc/a2a @pcc/agent-runtime @pcc/agent-kernel @pcc/contract-builder @pcc/onboard-kit
```

### Environment
- Node.js >= 20
- TypeScript with `"module": "NodeNext"` and `"target": "ES2022"`
- An Ethereum wallet (private key) for your kernel agent — generates DID, signs messages, receives payment

### Your device must expose at least one of:
- HTTP/REST API
- WebSocket connection
- OPC-UA server
- Modbus TCP/RTU registers
- SiLA 2 gRPC endpoints
- Serial port / USB interface
- MQTT broker
- Any programmatic interface that can report status, accept commands, and emit sensor data

---

## Step 1: Define Your Capabilities

A **Capability** describes what your equipment can do. Import types from `@pcc/spec`:

```typescript
import type { Capability, BuiltinCapabilityType, PricingModel } from "@pcc/spec";
import { ids } from "@pcc/spec";
```

### 1.1 Choose your capability type

PCC defines 44 built-in capability types. Pick the ones your equipment supports:

**Manufacturing:**
`cnc-3axis` | `cnc-5axis` | `fdm` | `sla` | `sls` | `dmls` | `lathe` | `laser-cut` | `waterjet` | `edm-wire` | `edm-sinker` | `injection-mold` | `sheet-metal-bend` | `sheet-metal-punch` | `welding-mig` | `welding-tig` | `welding-laser` | `surface-grinding` | `cylindrical-grinding` | `polishing` | `anodizing` | `plating` | `heat-treat` | `cmm-inspection` | `surface-profilometry` | `xray-ct-inspection`

**Logistics:**
`courier-pickup` | `courier-delivery`

**Biotech/Lab:**
`hplc` | `gc-ms` | `lc-ms` | `pcr` | `qpcr` | `sequencing` | `mass-spec` | `spectrophotometer` | `cell-culture` | `bioreactor` | `flow-cytometry` | `centrifuge` | `autoclave` | `lyophilizer` | `liquid-handler` | `plate-reader` | `microscopy` | `balance`

### 1.2 Define the capability object

```typescript
const myCapability: Capability = {
  id: ids.capability(),                    // auto-generated "cap_xxxx"
  kernelId: "kernel_your_shop_001",        // your kernel's unique ID
  type: "cnc-3axis",                       // from the list above
  name: "Haas VF-2 3-Axis CNC Mill",      // human-readable name
  description: "Vertical machining center with 30x16x20 inch travel",

  // What materials can you work with?
  materials: ["aluminum-6061", "aluminum-7075", "steel-1018", "steel-4140",
              "stainless-304", "stainless-316", "brass", "delrin", "nylon"],

  // Dimensional limits
  tolerances: {
    linear: "0.001 inch",       // ±0.001"
    surface: "Ra 32 μin",       // surface finish
    positional: "0.0005 inch",  // position accuracy
  },

  // Maximum part dimensions
  workEnvelope: {
    x: 762,    // mm
    y: 406,    // mm
    z: 508,    // mm
    unit: "mm",
  },

  // What assurance tiers do you support? (0=no evidence, 1=sensors, 2=cameras, 3=ZK proofs)
  assuranceTiers: [0, 1, 2],

  // How much do you charge?
  pricing: {
    currency: "USDC",
    baseCost: "25.00",          // flat fee per job
    perMinute: "1.50",          // per minute of machine time
    perGram: "0.00",            // per gram of material (if applicable)
    minimum: "50.00",           // minimum charge
  },

  // Where is your equipment?
  location: { lat: 37.7749, lng: -122.4194 },

  // When are you available?
  availability: {
    schedule: "weekdays",       // "24/7" | "weekdays" | "custom"
    timezone: "America/Los_Angeles",
    // custom: [{ day: "monday", start: "08:00", end: "17:00" }, ...]
  },

  // Current queue depth (update dynamically)
  queueDepth: 0,

  // Your DID (generated in Step 4)
  did: "did:pcc:kernel:kernel_your_shop_001",
};
```

### 1.3 Multiple capabilities per kernel

Most shops have multiple machines. Define one capability per machine:

```typescript
const capabilities: Capability[] = [
  { ...cncCapability },
  { ...fdmCapability },
  { ...cmmInspectionCapability },
];
```

---

## Step 2: Write Device Adapters

Adapters wrap your device's API into PCC's standard interface. You implement **three adapter types** depending on your equipment:

### 2.1 MachineAdapter (required for any machine that runs jobs)

```typescript
import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";
import type { MachineAdapter, MachineCommand, MachineCommandResult, MachineStatus } from "@pcc/kernel/adapters";

export class YourMachineAdapter implements MachineAdapter {
  readonly id: string;
  readonly type = "cnc-3axis" as const;  // your capability type
  readonly source: EvidenceSource;

  private listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];

  constructor(id: string, kernelId: string, private config: YourDeviceConfig) {
    this.id = id;
    this.source = {
      deviceId: id,
      deviceType: "controller",    // "controller" | "sensor" | "camera" | "robot" | "tee"
      kernelId,
      firmwareVersion: "YourAdapter-1.0.0",
    };
  }

  /** Map your device's status to PCC status */
  async getStatus(): Promise<MachineStatus> {
    // Call YOUR device's API to get current state
    const response = await fetch(`${this.config.apiUrl}/status`);
    const data = await response.json();

    // Map to PCC status: "idle" | "busy" | "error" | "offline" | "maintenance"
    switch (data.state) {
      case "ready":     return "idle";
      case "running":   return "busy";
      case "fault":     return "error";
      case "off":       return "offline";
      case "servicing": return "maintenance";
      default:          return "idle";
    }
  }

  /** Get job progress 0-100 */
  async getProgress(): Promise<number> {
    const response = await fetch(`${this.config.apiUrl}/job/progress`);
    const data = await response.json();
    return data.percentComplete ?? 0;
  }

  /** Execute commands on your device */
  async execute(command: MachineCommand): Promise<MachineCommandResult> {
    switch (command.type) {
      case "load_gcode": {
        // Upload the file/program to your machine
        const result = await fetch(`${this.config.apiUrl}/programs/upload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: command.payload?.filename,
            gcodeHash: command.payload?.gcodeHash,
          }),
        });

        // IMPORTANT: Emit evidence event when G-code is loaded
        this.emit({
          type: "gcode_received",
          timestamp: new Date().toISOString(),
          source: this.source,
          payload: {
            filename: command.payload?.filename,
            gcodeHash: command.payload?.gcodeHash,
          },
        });

        return { success: result.ok, message: "Program loaded" };
      }

      case "start": {
        await fetch(`${this.config.apiUrl}/job/start`, { method: "POST" });

        this.emit({
          type: "execution_started",
          timestamp: new Date().toISOString(),
          source: this.source,
          payload: {},
        });

        // Start polling for progress updates
        this.startProgressPolling();

        return { success: true, message: "Job started" };
      }

      case "pause":
        await fetch(`${this.config.apiUrl}/job/pause`, { method: "POST" });
        return { success: true, message: "Paused" };

      case "resume":
        await fetch(`${this.config.apiUrl}/job/resume`, { method: "POST" });
        return { success: true, message: "Resumed" };

      case "stop":
        await fetch(`${this.config.apiUrl}/job/stop`, { method: "POST" });
        this.stopProgressPolling();
        return { success: true, message: "Stopped" };

      case "status": {
        const status = await this.getStatus();
        const progress = await this.getProgress();
        return { success: true, data: { status, progress } };
      }

      default:
        return { success: false, message: `Unknown command: ${command.type}` };
    }
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.listeners.push(callback);
  }

  async dispose(): Promise<void> {
    this.stopProgressPolling();
    this.listeners = [];
  }

  // ── Progress polling ──────────────────────────────────────────

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastProgress = 0;

  private startProgressPolling(): void {
    this.stopProgressPolling();
    this.pollTimer = setInterval(async () => {
      try {
        const progress = await this.getProgress();
        const status = await this.getStatus();

        // Emit progress at 25% intervals
        if (Math.floor(progress / 25) > Math.floor(this.lastProgress / 25)) {
          this.emit({
            type: "execution_progress",
            timestamp: new Date().toISOString(),
            source: this.source,
            payload: { progress },
          });
        }

        // Detect completion
        if (this.lastProgress < 100 && progress >= 100) {
          this.emit({
            type: "execution_completed",
            timestamp: new Date().toISOString(),
            source: this.source,
            payload: { progress: 100 },
          });
          this.stopProgressPolling();
        }

        this.lastProgress = progress;
      } catch {
        // Handle poll failure gracefully
      }
    }, this.config.pollIntervalMs ?? 2000);
  }

  private stopProgressPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private emit(event: Omit<EvidenceEvent, "id" | "hash">): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
```

### 2.2 SensorAdapter (required for Assurance Tier >= 1)

If your device has sensors (power, temperature, vibration, etc.), or if you have external monitoring equipment:

```typescript
import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";
import type { SensorAdapter } from "@pcc/kernel/adapters";

export class YourSensorAdapter implements SensorAdapter {
  readonly id: string;
  readonly type = "power_monitor" as const;  // or "vibration_sensor" | "acoustic_sensor" | "temperature_sensor"
  readonly source: EvidenceSource;

  private listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];
  private recording = false;
  private samples: Array<{ timestamp: string; value: number }> = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(id: string, kernelId: string, private config: YourSensorConfig) {
    this.id = id;
    this.source = {
      deviceId: id,
      deviceType: "sensor",
      kernelId,
      firmwareVersion: "YourSensor-1.0.0",
    };
  }

  async startRecording(jobId: string): Promise<void> {
    this.recording = true;
    this.samples = [];

    this.pollTimer = setInterval(async () => {
      // Read from YOUR sensor API
      const response = await fetch(`${this.config.sensorUrl}/reading`);
      const data = await response.json();

      const sample = {
        timestamp: new Date().toISOString(),
        value: data.watts ?? data.temperature ?? data.value,
      };
      this.samples.push(sample);

      // Emit live reading as evidence
      this.emit({
        type: "sensor_reading",
        timestamp: sample.timestamp,
        source: this.source,
        payload: {
          channel: this.config.channel,    // e.g., "spindle_power", "bed_temp"
          value: sample.value,
          unit: this.config.unit,          // e.g., "W", "degC"
          jobId,
        },
      });
    }, this.config.sampleIntervalMs ?? 1000);
  }

  async stopRecording(): Promise<Omit<EvidenceEvent, "id" | "hash">> {
    this.recording = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Compute summary statistics
    const values = this.samples.map(s => s.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;

    return {
      type: "power_profile_summary",    // or "sensor_data_summary"
      timestamp: new Date().toISOString(),
      source: this.source,
      payload: {
        channel: this.config.channel,
        unit: this.config.unit,
        sampleCount: values.length,
        durationMs: this.samples.length * (this.config.sampleIntervalMs ?? 1000),
        statistics: { min, max, mean },
        // Include raw samples for Tier 2+ (full audit trail)
        samples: this.samples,
      },
    };
  }

  async getCurrentReading(): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.config.sensorUrl}/reading`);
    return response.json();
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.listeners.push(callback);
  }

  async dispose(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.listeners = [];
  }

  private emit(event: Omit<EvidenceEvent, "id" | "hash">): void {
    for (const listener of this.listeners) listener(event);
  }
}
```

### 2.3 CameraAdapter (required for Assurance Tier >= 2)

If you have cameras for QC inspection:

```typescript
import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";
import type { CameraAdapter } from "@pcc/kernel/adapters";

export class YourCameraAdapter implements CameraAdapter {
  readonly id: string;
  readonly source: EvidenceSource;

  private listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];

  constructor(id: string, kernelId: string, private config: YourCameraConfig) {
    this.id = id;
    this.source = {
      deviceId: id,
      deviceType: "camera",
      kernelId,
      firmwareVersion: "YourCamera-1.0.0",
    };
  }

  async captureSnapshot(): Promise<{ imageHash: string; storageRef: string }> {
    // Call YOUR camera API to capture an image
    const response = await fetch(`${this.config.cameraUrl}/capture`, { method: "POST" });
    const data = await response.json();

    // Hash the image for content-addressing
    const imageBytes = await fetch(data.imageUrl).then(r => r.arrayBuffer());
    const hashBuffer = await crypto.subtle.digest("SHA-256", imageBytes);
    const imageHash = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, "0")).join("");

    this.emit({
      type: "camera_snapshot",
      timestamp: new Date().toISOString(),
      source: this.source,
      payload: { imageHash, storageRef: data.imageUrl },
    });

    return { imageHash, storageRef: data.imageUrl };
  }

  async runInspection(referenceHash?: string): Promise<{
    passed: boolean; confidence: number; findings: string[]; imageHash: string;
  }> {
    // Call YOUR vision/QC system
    const snapshot = await this.captureSnapshot();
    const response = await fetch(`${this.config.cameraUrl}/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageHash: snapshot.imageHash,
        referenceHash,           // compare against known-good reference
      }),
    });
    const result = await response.json();

    this.emit({
      type: "cv_inspection_result",
      timestamp: new Date().toISOString(),
      source: this.source,
      payload: {
        passed: result.passed,
        confidence: result.confidence,
        findings: result.findings,
        imageHash: snapshot.imageHash,
      },
    });

    return {
      passed: result.passed,
      confidence: result.confidence,
      findings: result.findings ?? [],
      imageHash: snapshot.imageHash,
    };
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.listeners.push(callback);
  }

  async dispose(): Promise<void> {
    this.listeners = [];
  }

  private emit(event: Omit<EvidenceEvent, "id" | "hash">): void {
    for (const listener of this.listeners) listener(event);
  }
}
```

### 2.4 Adapter selection by protocol

Use the reference adapters in `@pcc/kernel` as starting points:

| Your Device Protocol | Base Adapter | Import |
|---------------------|-------------|--------|
| HTTP/REST API | `OctoPrintAdapter` | `@pcc/kernel/adapters` |
| OPC-UA (CNC, PLC) | `OPCUAAdapter` | `@pcc/kernel/adapters` |
| Modbus TCP (sensors) | `ModbusSensorAdapter` | `@pcc/kernel/adapters` |
| SiLA 2 (lab instruments) | `SiLAAdapter` | `@pcc/kernel/adapters` |
| Custom protocol | Write from scratch using `MachineAdapter` interface | — |

---

## Step 3: Configure Your Shop Kernel

The Shop Kernel is the runtime that manages your adapters and serves capabilities.

### 3.1 Create the kernel server

```typescript
// kernel-server.ts
import { EvidenceEmitter, JobRunner, SensorPipeline, BatchTracker } from "@pcc/kernel";
import { YourMachineAdapter } from "./adapters/your-machine-adapter.js";
import { YourSensorAdapter } from "./adapters/your-sensor-adapter.js";
import { YourCameraAdapter } from "./adapters/your-camera-adapter.js";

const KERNEL_ID = "kernel_your_shop_001";  // unique across the network

// ── 1. Create your device adapters ────────────────────────────────
const machine = new YourMachineAdapter("dev_haas_001", KERNEL_ID, {
  apiUrl: "http://192.168.1.100:8080",       // your machine's API
  pollIntervalMs: 2000,
});

const powerSensor = new YourSensorAdapter("dev_power_001", KERNEL_ID, {
  sensorUrl: "http://192.168.1.101:502",     // your power meter
  channel: "spindle_power",
  unit: "W",
  sampleIntervalMs: 1000,
});

const camera = new YourCameraAdapter("dev_cam_001", KERNEL_ID, {
  cameraUrl: "http://192.168.1.102:8000",    // your QC camera
});

// ── 2. Create evidence emitter ────────────────────────────────────
const evidenceEmitter = new EvidenceEmitter(KERNEL_ID);

// Optional: Enable IPFS archival for immutable evidence storage
// import { EvidenceStorageService } from "@pcc/kernel/dist/evidence-storage.js";
// const ipfs = new EvidenceStorageService();
// await ipfs.init();
// evidenceEmitter.setStorageService(ipfs);

// ── 3. Create job runner ──────────────────────────────────────────
const jobRunner = new JobRunner(
  machine,                    // primary machine adapter
  [powerSensor],              // sensor adapters (array)
  camera,                     // camera adapter (or null if no camera)
  evidenceEmitter,            // evidence collection
);

// ── 4. Listen for completed bundles ───────────────────────────────
evidenceEmitter.onBundle((bundle) => {
  console.log(`Evidence bundle finalized: ${bundle.id}`);
  console.log(`  Hash: ${bundle.bundleHash}`);
  console.log(`  Events: ${bundle.events.length}`);
  // The kernel agent will auto-submit this to escrow
});
```

### 3.2 Kernel HTTP server (optional standalone mode)

If running standalone (not embedded in a kernel agent), expose an HTTP API:

```typescript
import Fastify from "fastify";

const app = Fastify();

// Health check
app.get("/health", async () => ({
  status: "ok",
  kernelId: KERNEL_ID,
  activeJobs: activeJobs.size,
}));

// List capabilities
app.get("/capabilities", async () => ({
  capabilities: myCapabilities,
}));

// Quote a job
app.post("/quote", async (req) => {
  const { capabilityId, assuranceTier, estimatedMinutes } = req.body as any;
  const cap = myCapabilities.find(c => c.id === capabilityId);
  if (!cap) return { error: "Capability not found" };

  const baseCost = parseFloat(cap.pricing.baseCost);
  const perMin = parseFloat(cap.pricing.perMinute);
  const total = Math.max(
    parseFloat(cap.pricing.minimum),
    baseCost + perMin * (estimatedMinutes ?? 30)
  );

  return { price: total.toFixed(2), currency: cap.pricing.currency };
});

// Execute a job
app.post("/execute", async (req) => {
  const { capabilityId, jobId, stepId, gcodeHash, assuranceTier } = req.body as any;

  // Run asynchronously
  jobRunner.run({ jobId, stepId, gcodeHash, assuranceTier })
    .then(result => console.log("Job completed:", result))
    .catch(err => console.error("Job failed:", err));

  return { jobId, status: "accepted" };
});

await app.listen({ port: 3100, host: "0.0.0.0" });
```

---

## Step 4: Create a Kernel Agent

The Kernel Agent wraps your Shop Kernel and connects it to the A2A network. This is how user agents discover and interact with your equipment.

### 4.1 Create the agent

```typescript
import { MessageBus } from "@pcc/a2a";
import { KernelAgent } from "@pcc/agent-kernel";
import type { Capability } from "@pcc/spec";

// The message bus — connects to the PCC network
const bus = new MessageBus();   // In-process for testing
// For production: use NetworkTransport (see Step 6)

const kernelAgent = new KernelAgent(bus, {
  kernelId: "kernel_your_shop_001",
  name: "Your Workshop Name",
  location: { lat: 37.7749, lng: -122.4194 },
  capabilities: myCapabilities,

  // How long mock jobs take (only for testing without real hardware)
  mockPrintDuration: 3000,

  // Machine profiles for the contract builder (see Step 5)
  machineProfiles: myProfiles,

  // Gateway URL for batch settlement
  gatewayUrl: "http://localhost:3200",
});

kernelAgent.start();
```

### 4.2 What the kernel agent handles automatically

Once started, the kernel agent automatically handles these A2A intents:

| Intent | What happens |
|--------|-------------|
| `request_quote` | Looks up matching capability, calculates price, returns quote |
| `execute_job` | Queues job, runs via JobRunner, collects evidence, auto-submits to escrow |
| `cancel_job` | Removes from queue or stops running job |
| `job_status_query` | Returns current status, progress %, evidence bundle ID |
| `request_handoff` | Records custody handoff for physical delivery |
| `text_message` | Returns capability list and queue depth |

### 4.3 Wallet setup

Your kernel agent needs a wallet for signing messages and receiving payment:

```typescript
import { KernelAgent } from "@pcc/agent-kernel";

const kernelAgent = new KernelAgent(bus, {
  // ... other config ...

  // Private key for your kernel's wallet
  // This wallet will:
  //   1. Sign all A2A messages
  //   2. Receive escrow milestone payments
  //   3. Deposit operator bonds (for Tier 1+)
  //   4. Claim DePIN rewards
  privateKey: process.env.KERNEL_PRIVATE_KEY,  // "0x..." hex string
});
```

**Security**: Never hardcode private keys. Use environment variables or a secure vault.

### 4.4 Register with the broker

The broker must know about your capabilities to route user requests to you:

```typescript
import { BrokerAgent } from "@pcc/agent-broker";

// The broker (usually running on the PCC network — you connect to it)
const brokerAgent = new BrokerAgent(bus);
brokerAgent.start();

// Register your kernel's capabilities with the broker
brokerAgent.registerKernelCapabilities(kernelAgent.id, {
  kernelId: "kernel_your_shop_001",
  capabilities: myCapabilities,
  reputation: 950,   // starts at 0, grows with successful jobs
});
```

In production, broker registration happens via the Gateway REST API or A2A network relay.

---

## Step 5: Register Machine Profiles

Machine profiles let the **Contract Builder** offer users a "car configurator" experience for your specific machines — with your exact parameter constraints and pricing.

### 5.1 Create a machine profile

```typescript
import type { MachineProfile, ParamDef } from "@pcc/spec";

const haasProfile: MachineProfile = {
  id: "profile-haas-vf2",
  profileName: "Haas VF-2 CNC Mill",
  kernelId: "kernel_your_shop_001",
  deviceId: "dev_haas_001",
  capabilityType: "cnc-3axis",

  // Override parameters from the base template
  paramOverrides: {
    // Restrict material options to what you actually stock
    material: {
      key: "material",
      label: "Material",
      type: "enum",
      options: [
        { value: "aluminum-6061", label: "Aluminum 6061", pricingImpact: { mode: "flat", value: "0.00" } },
        { value: "aluminum-7075", label: "Aluminum 7075", pricingImpact: { mode: "flat", value: "5.00" } },
        { value: "steel-1018", label: "Steel 1018", pricingImpact: { mode: "flat", value: "10.00" } },
        { value: "stainless-304", label: "Stainless 304", pricingImpact: { mode: "flat", value: "20.00" } },
      ],
      defaultValue: "aluminum-6061",
      required: true,
    } as ParamDef,

    // Override tolerance range to your machine's actual specs
    tolerance: {
      key: "tolerance",
      label: "Tolerance",
      type: "enum",
      options: [
        { value: "standard", label: "±0.005\"", pricingImpact: { mode: "flat", value: "0.00" } },
        { value: "precision", label: "±0.001\"", pricingImpact: { mode: "percent", value: "25" } },
        { value: "ultra", label: "±0.0005\"", pricingImpact: { mode: "percent", value: "50" } },
      ],
      defaultValue: "standard",
      required: true,
    } as ParamDef,
  },

  // Override base pricing
  pricingOverrides: {
    baseCost: "35.00",     // your setup cost
    perMinute: "2.00",     // your per-minute rate
    minimum: "75.00",      // your minimum charge
  },

  // Constraints (cross-parameter rules)
  constraints: [
    {
      // If material is stainless, minimum tolerance is "precision"
      condition: { param: "material", value: "stainless-304" },
      effect: { param: "tolerance", exclude: ["standard"] },
    },
  ],
};
```

### 5.2 Register profiles

Profiles are passed to the KernelAgent on construction:

```typescript
const kernelAgent = new KernelAgent(bus, {
  // ...
  machineProfiles: [haasProfile, prusaProfile, hplcProfile],
});
```

When a user agent sends `get_build_options` for your capability type, the broker returns your profile's parameters with pricing impacts. When they send `build_contract`, it validates against your constraints and returns an accurate price breakdown.

---

## Step 6: Connect to the Network

### 6.1 In-process (testing)

For testing, all agents share a single `MessageBus`:

```typescript
import { MessageBus } from "@pcc/a2a";

const bus = new MessageBus();
const userAgent = new UserAgent(bus, { privateKey: "0x..." });
const brokerAgent = new BrokerAgent(bus);
const kernelAgent = new KernelAgent(bus, { /* ... */ });

userAgent.start();
brokerAgent.start();
kernelAgent.start();
```

### 6.2 Networked (production)

For production, agents connect via the Gateway's WebSocket relay:

```typescript
import { NetworkTransport } from "@pcc/a2a";

const transport = new NetworkTransport({
  relayUrl: "http://gateway.pcc.network:3200",  // PCC Gateway URL
  agentId: kernelAgent.id,
  reconnectInterval: 3000,   // auto-reconnect every 3s
});

await transport.connect();

// Outbound: agent sends messages through transport
kernelAgent.setTransport(transport);

// Inbound: transport delivers messages to agent
transport.onMessage((message) => {
  kernelAgent.handleMessage(message);
});
```

**Gateway relay endpoints:**
- `POST /api/a2a/send` — agents POST messages here
- `GET /api/a2a/agents` — list connected agents
- `WS /ws/a2a?agentId=xxx` — agent WebSocket subscription

### 6.3 Agent card (your identity on the network)

Your agent card is what other agents see when they discover you:

```typescript
const card = kernelAgent.getCard();
// {
//   id: "agent_xxx",
//   role: "kernel",
//   walletAddress: "0x1234...",
//   capabilities: ["cnc-3axis", "fdm"],
//   endpoint: "agent://agent_xxx",
//   supportedIntents: ["request_quote", "execute_job", "cancel_job", ...],
//   publicKey: "0x1234...",
//   reputation: 950
// }
```

---

## Step 7: Handle Jobs End-to-End

### 7.1 Job lifecycle (what your kernel agent does)

When a user submits a workflow and funds escrow, the broker dispatches jobs to your kernel agent. Here's the complete flow:

```
1. Receive "execute_job" intent from broker
   └→ KernelAgent creates ActiveJob (status: "queued")
   └→ Adds to jobQueue

2. processQueue() dequeues next job
   └→ Sets status: "executing"
   └→ Calls JobRunner.run({
        jobId,
        stepId,
        gcodeHash,          // content hash of the program/file
        assuranceTier,      // 0, 1, 2, or 3
      })

3. JobRunner orchestrates:
   a. EvidenceEmitter.registerStep(jobId, stepId, tier)
   b. Wire evidence listeners (machine → emitter, sensors → emitter, camera → emitter)
   c. Machine: execute("load_gcode", { filename, gcodeHash })
   d. If tier >= 1: sensors.startRecording(jobId)
   e. If tier >= 2: camera.captureSnapshot()  // "before" image
   f. Machine: execute("start")
   g. Poll machine until progress >= 100 or status == "error"
   h. If tier >= 1: sensors.stopRecording()
   i. If tier >= 2: camera.runInspection()    // QC check
   j. EvidenceEmitter.finalizeBundle(jobId, stepId)

4. Evidence bundle finalized
   └→ Bundle hash computed (SHA-256 of canonical JSON)
   └→ Bundle signed by kernel wallet
   └→ Optional: archived to IPFS
   └→ Status: "completed"

5. Auto-submit evidence to escrow
   └→ settlement.submitEvidence(escrowAddress, milestoneIndex, bundleHash)
   └→ Batched via gateway for gas efficiency

6. Send "job_completed" intent to broker
   └→ Includes evidenceBundleHash, summary
```

### 7.2 Custom job execution

If the default JobRunner doesn't fit your workflow, override the kernel agent's job handler:

```typescript
// In your custom KernelAgent subclass:
class MyKernelAgent extends KernelAgent {
  protected async executeJob(job: ActiveJob): Promise<void> {
    // Your custom execution logic here
    const { jobId, stepId, params, assuranceTier } = job;

    // 1. Send commands to your machine
    await this.myCustomMachine.runProgram(params.programFile);

    // 2. Wait for completion (your logic)
    while (await this.myCustomMachine.isRunning()) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      job.progress = await this.myCustomMachine.getProgress();
    }

    // 3. Collect evidence manually if needed
    const evidenceEvents = await this.myCustomMachine.getEventLog();

    // 4. Build and finalize evidence bundle
    // ... (see Step 8)
  }
}
```

---

## Step 8: Evidence Collection

Evidence is the core of PCC's trust model. Every job produces a cryptographic **Evidence Bundle** — a content-addressed collection of events that proves the work was done correctly.

### 8.1 Assurance tiers

| Tier | Evidence Required | Use Case | Bond | Challenge Window |
|------|------------------|----------|------|-----------------|
| **0** | None | Quick prototypes, low-value jobs | 0% | 1 hour |
| **1** | Sensor data (power, temperature) | Standard manufacturing | 5% | 4 hours |
| **2** | Tier 1 + camera snapshots + CV inspection | Production quality | 15% | 24 hours |
| **3** | Tier 2 + encryption + ZK proofs + Bittensor consensus | Regulatory compliance | 25% | 72 hours |

### 8.2 Evidence events your adapters should emit

**From MachineAdapter:**
- `gcode_received` — when a program file is loaded
- `gcode_hash_verified` — when file integrity is confirmed
- `execution_started` — when the machine starts
- `execution_progress` — at 25% intervals
- `execution_completed` — when the job finishes
- `execution_error` — if something goes wrong

**From SensorAdapter:**
- `sensor_reading` — each data sample during the job
- `power_profile_summary` — summary statistics after recording stops
- `sensor_data_summary` — aggregated sensor data

**From CameraAdapter:**
- `camera_snapshot` — each image captured
- `cv_inspection_result` — QC pass/fail with confidence

### 8.3 Evidence bundle structure

```typescript
interface EvidenceBundle {
  id: string;                    // "bun_xxxx"
  jobId: string;
  stepId: string;
  kernelId: string;
  assuranceTier: 0 | 1 | 2 | 3;
  events: EvidenceEvent[];       // all collected events
  bundleHash: string;            // SHA-256 of canonical JSON
  kernelSignature: {
    signer: string;              // kernel wallet address
    algorithm: "secp256k1";
    value: string;               // signature bytes
  };
  ipfsCid?: string;              // IPFS CID if archived
  createdAt: string;             // ISO 8601
}
```

### 8.4 Tier requirements (what verifiers check)

**Tier 0**: Nothing required
**Tier 1**: Must include at least:
- 1 execution event (started + completed)
- 1 sensor event (power OR temperature OR vibration)

**Tier 2**: Must include at least:
- All Tier 1 requirements
- 1 camera snapshot
- 1 CV inspection result

**Tier 3**: Must include:
- All Tier 2 requirements
- Encrypted evidence bundle (AES-256-GCM + Lit Protocol)
- Merkle commitment on-chain
- ZK proof of evidence inclusion

---

## Step 9: Settlement & Payments

### 9.1 Milestone escrow (how you get paid)

Every job is backed by a **MilestoneEscrow** smart contract on Base/Base Sepolia:

```
User funds escrow → $X locked per milestone
  ↓
Your kernel completes job → submits evidenceBundleHash
  ↓
Verifier attests → challenge window opens
  ↓
No dispute? → Payment released to your wallet
  ↓
Dispute? → Arbiter decides → winner gets bonds
```

### 9.2 Settlement client

Your kernel agent includes a `SettlementClient` that auto-submits evidence:

```typescript
// Automatic: when kernel finishes a job and the escrow mapping is registered
kernelAgent.registerEscrowMapping("job_123", "0xEscrowAddress", 0);
// milestoneIndex ↑ — which milestone in the escrow this job maps to

// When the job completes, the kernel agent auto-calls:
// settlement.submitEvidence(escrowAddress, milestoneIndex, bundleHash)
```

### 9.3 Operator bonds

For Tier 1+, you must deposit an operator bond before the job starts:

| Tier | Bond % | Example (on $100 job) |
|------|--------|----------------------|
| 0 | 0% | $0 |
| 1 | 5% | $5 |
| 2 | 15% | $15 |
| 3 | 25% | $25 |

Bonds are returned after the challenge window expires without dispute. If evidence is invalid and a challenger wins, your bond is slashed.

### 9.4 DePIN rewards (optional)

If your kernel performs well, you earn DePIN rewards:

```
Score = (jobs × 0.4) + (quality × 0.25) + (uptime × 0.15)
      + (capDiversity × 0.1) + (scarcityBonus × 0.1)
```

Soulbound capability certificates (cNFTs) are minted as your track record grows.

---

## Step 10: Protocol Execution

For lab instruments and multi-step workflows, your kernel can execute **Protocols** — abstract recipes that orchestrate multiple capabilities.

### 10.1 Protocol templates

A protocol template defines abstract steps (not tied to specific instruments):

```typescript
const myProtocol: ProtocolTemplate = {
  id: "ptpl_your_assay",
  name: "Custom Serum Analysis",
  steps: [
    { id: "step-dilute", capabilityType: "liquid-handler", action: "serial_dilution", ... },
    { id: "step-separate", capabilityType: "centrifuge", action: "spin", ... },
    { id: "step-analyze", capabilityType: "hplc", action: "run_method", ... },
  ],
  transfers: [
    { fromStepId: "step-dilute", toStepId: "step-separate", labwareType: "plate" },
    { fromStepId: "step-separate", toStepId: "step-analyze", labwareType: "vial" },
  ],
  requiredCapabilities: ["liquid-handler", "centrifuge", "hplc"],
};
```

### 10.2 Protocol execution flow

1. User browses protocols → finds your published template
2. User validates against your kernel: `POST /api/protocols/:id/validate`
3. Protocol engine binds abstract steps to your physical instruments
4. User starts run: `POST /api/protocol-runs/:runId/start`
5. ProtocolRunner executes steps in dependency order:
   - Claims instruments (ResourcePool)
   - Executes each step via your adapters
   - Tracks sample movement through TransferGraph
   - Records episodes for automation learning
6. Evidence collected per step → bundles submitted

### 10.3 Automation levels

Sample transfers between instruments progress through automation levels:

```
manual → teleoperated → pilot_operated → vla_assisted → fully_autonomous
```

Each transfer pair tracks episode counts and success rates. When enough successful episodes accumulate, the system can advance the automation level.

---

## Step 11: Testing & Validation

### 11.1 Unit test your adapter

```typescript
import { describe, it, expect } from "vitest";

describe("YourMachineAdapter", () => {
  it("should report idle status when machine is ready", async () => {
    const adapter = new YourMachineAdapter("test-01", "kernel-test", {
      apiUrl: "http://mock:8080",
      mockMode: true,
    });
    const status = await adapter.getStatus();
    expect(status).toBe("idle");
  });

  it("should emit evidence events during execution", async () => {
    const adapter = new YourMachineAdapter("test-01", "kernel-test", {
      apiUrl: "http://mock:8080",
      mockMode: true,
    });

    const events: any[] = [];
    adapter.onEvidence((event) => events.push(event));

    await adapter.execute({ type: "load_gcode", payload: { filename: "test.nc" } });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("gcode_received");

    await adapter.execute({ type: "start" });
    expect(events.some(e => e.type === "execution_started")).toBe(true);
  });
});
```

### 11.2 Integration test with JobRunner

```typescript
import { EvidenceEmitter, JobRunner } from "@pcc/kernel";

describe("Integration", () => {
  it("should produce a valid evidence bundle", async () => {
    const machine = new YourMachineAdapter("dev-01", "kernel-test", { mockMode: true });
    const sensor = new YourSensorAdapter("sensor-01", "kernel-test", { mockMode: true });
    const camera = new YourCameraAdapter("cam-01", "kernel-test", { mockMode: true });
    const emitter = new EvidenceEmitter("kernel-test");

    const runner = new JobRunner(machine, [sensor], camera, emitter);

    let completedBundle: any = null;
    emitter.onBundle((bundle) => { completedBundle = bundle; });

    const result = await runner.run({
      jobId: "test-job-001",
      stepId: "step-1",
      gcodeHash: "sha256:abc123",
      assuranceTier: 1,
    });

    expect(result.success).toBe(true);
    expect(result.bundleHash).toBeDefined();
    expect(completedBundle).toBeDefined();
    expect(completedBundle.events.length).toBeGreaterThan(0);
  });
});
```

### 11.3 End-to-end test with agents

```typescript
import { MessageBus } from "@pcc/a2a";
import { UserAgent } from "@pcc/agent-user";
import { BrokerAgent } from "@pcc/agent-broker";
import { KernelAgent } from "@pcc/agent-kernel";

describe("E2E Agent Flow", () => {
  it("should discover → quote → submit → execute → complete", async () => {
    const bus = new MessageBus();

    const user = new UserAgent(bus, { privateKey: "0xtest..." });
    const broker = new BrokerAgent(bus);
    const kernel = new KernelAgent(bus, {
      kernelId: "kernel-e2e",
      name: "Test Workshop",
      location: { lat: 0, lng: 0 },
      capabilities: [myCapabilities[0]],
      mockPrintDuration: 500,
    });

    user.start();
    broker.start();
    kernel.start();

    broker.registerKernelCapabilities(kernel.id, {
      kernelId: "kernel-e2e",
      capabilities: [myCapabilities[0]],
      reputation: 500,
    });

    // Discover
    const notifications: any[] = [];
    user.onNotification((n) => notifications.push(n));

    await user.discoverCapabilities({ capabilityType: "cnc-3axis" });
    await new Promise(r => setTimeout(r, 200));
    expect(notifications.some(n => n.type === "capabilities_found")).toBe(true);

    // Quote
    await user.requestQuote({
      capabilityType: "cnc-3axis",
      params: { material: "aluminum-6061" },
      assuranceTier: 1,
    });
    await new Promise(r => setTimeout(r, 200));
    expect(notifications.some(n => n.type === "quote_received")).toBe(true);

    user.stop();
    broker.stop();
    kernel.stop();
  });
});
```

### 11.4 Run the validation suite

```bash
# Run the onboard-kit validation
npx pcc-onboard validate --kernel-config ./kernel-config.json

# This checks:
# ✓ All adapters implement required interfaces
# ✓ Capabilities have valid types, materials, pricing
# ✓ Evidence emitter produces valid bundles
# ✓ Bundle hashes are correct (canonical JSON SHA-256)
# ✓ Machine profiles match capability templates
# ✓ Wallet can sign messages
# ✓ Kernel agent registers and responds to intents
```

---

## Step 12: Go Live Checklist

Before your kernel goes live on the PCC network:

- [ ] **Adapters tested** — Each adapter connects to your real device API and can report status, execute commands, emit evidence
- [ ] **Capabilities defined** — Accurate materials, tolerances, work envelope, pricing
- [ ] **Evidence collection verified** — JobRunner produces valid bundles at your target assurance tier(s)
- [ ] **Machine profiles registered** — Contract builder correctly prices your capabilities
- [ ] **Wallet funded** — Your kernel wallet has ETH for gas + USDC for operator bonds
- [ ] **Gateway connected** — NetworkTransport connects to the PCC gateway relay
- [ ] **Broker registration confirmed** — Your capabilities appear in broker's search results
- [ ] **Job execution tested** — Full cycle: job received → executed → evidence submitted → bundle finalized
- [ ] **Settlement integration tested** — Evidence auto-submitted to escrow, payment received after challenge window
- [ ] **Health monitoring** — Your kernel reports `/health` status accurately
- [ ] **Error handling** — Graceful degradation when devices go offline or jobs fail
- [ ] **Security** — Private key stored securely, API authentication on device endpoints

---

## Appendix A: Type Reference

### Capability

```typescript
interface Capability {
  id: string;                           // "cap_xxxx"
  kernelId: string;                     // "kernel_xxx"
  type: BuiltinCapabilityType;          // "fdm" | "cnc-3axis" | ... (44 types)
  name: string;                         // Human-readable
  description?: string;
  materials: string[];                  // Accepted materials
  tolerances?: {
    linear?: string;
    surface?: string;
    positional?: string;
  };
  workEnvelope?: {
    x: number; y: number; z: number;
    unit: "mm" | "inch";
  };
  assuranceTiers: (0 | 1 | 2 | 3)[];   // Supported tiers
  pricing: PricingModel;
  location?: { lat: number; lng: number };
  availability?: {
    schedule: "24/7" | "weekdays" | "custom";
    timezone?: string;
  };
  queueDepth?: number;                  // Current jobs in queue
  did?: string;                         // W3C DID
}
```

### PricingModel

```typescript
interface PricingModel {
  currency: "USDC" | "ETH" | "DAI" | "SOL";
  baseCost: string;                     // Flat fee per job
  perMinute: string;                    // Per minute of machine time
  perGram?: string;                     // Per gram of material
  minimum: string;                      // Minimum charge
}
```

### EvidenceEvent

```typescript
interface EvidenceEvent {
  id: string;                           // Generated
  type: EvidenceEventType;              // 60+ types (see Appendix B)
  timestamp: string;                    // ISO 8601
  eventHash: string;                    // SHA-256 of canonical JSON
  source: EvidenceSource;
  payload: Record<string, unknown>;     // Event-specific data
}

interface EvidenceSource {
  deviceId: string;
  deviceType: "controller" | "sensor" | "camera" | "robot" | "tee";
  kernelId: string;
  firmwareVersion: string;
}
```

### CWM (Capability Workflow Manifest)

```typescript
interface CWM {
  id: string;                           // "cwm_xxxx"
  version: "1.0";
  submittedBy: string;                  // Wallet address
  steps: CWMStep[];
  settlement: {
    currency: "USDC";
    maxBudget: string;
    escrowAddress?: string;
  };
  metadata?: {
    name?: string;
    description?: string;
    tags?: string[];
  };
  createdAt: string;
}

interface CWMStep {
  id: string;                           // "step_xxxx"
  capability: BuiltinCapabilityType;
  params: Record<string, unknown>;
  assuranceTier: 0 | 1 | 2 | 3;
  estimatedDuration?: number;           // Minutes
  maxPrice?: string;
  preferredKernel?: string;
  dependsOn: string[];                  // Step IDs (DAG)
}
```

### A2A Message

```typescript
interface A2AMessage {
  id: string;
  conversationId: string;
  from: string;                         // Sender agent ID
  to: string;                           // Recipient agent ID
  intent: Intent;                       // Typed payload (32 intent types)
  timestamp: string;
  inReplyTo?: string;
  signature?: string;                   // EIP-191 wallet signature
}
```

---

## Appendix B: Evidence Event Types

60+ event types organized by category:

**G-code lifecycle**: `gcode_received`, `gcode_hash_verified`, `gcode_validated`, `gcode_simulation_complete`

**Execution**: `execution_started`, `execution_progress`, `execution_paused`, `execution_resumed`, `execution_completed`, `execution_error`, `execution_aborted`

**Power monitoring**: `power_reading`, `power_profile_summary`, `power_anomaly`

**Vibration**: `vibration_reading`, `vibration_spectrum`, `vibration_anomaly`

**Acoustic**: `acoustic_reading`, `acoustic_anomaly`

**Temperature**: `temperature_reading`, `temperature_profile_summary`, `temperature_anomaly`

**Camera/Vision**: `camera_snapshot`, `camera_timelapse_frame`, `cv_inspection_result`, `cv_defect_detected`

**TEE (Trusted Execution)**: `tee_attestation`, `tee_measurement`

**Custody**: `custody_handoff`, `custody_received`, `custody_verified`

**Batch tracking**: `batch_created`, `batch_sealed`, `sample_injection_start`, `sample_acquisition_start`, `sample_acquisition_end`, `sample_processing_complete`, `batch_completed`

**Sensor generic**: `sensor_reading`, `sensor_data_summary`, `sensor_calibration`, `sensor_anomaly`

**Device lifecycle**: `device_started`, `device_stopped`, `device_calibrated`, `device_maintenance`

**Encryption**: `evidence_encrypted`, `evidence_committed`, `evidence_archived`

---

## Appendix C: Adapter Protocol Reference

### HTTP/REST (OctoPrint-style)

```
GET  /api/printer          → { state, temperature, ... }
GET  /api/job              → { progress, file, ... }
POST /api/files/local/:file → { command: "select" }
POST /api/job              → { command: "start" | "pause" | "cancel" }
```

### OPC-UA (CNC/PLC)

```
Read nodes:
  ns=2;s=CNC.SpindleSpeed    → number (rpm)
  ns=2;s=CNC.FeedRate         → number (mm/min)
  ns=2;s=CNC.Position.X/Y/Z   → number (mm)
  ns=2;s=CNC.ProgramProgress  → number (0-100)
  ns=2;s=CNC.Status           → string

Write nodes:
  ns=2;s=CNC.ProgramName      → string (filename)
  ns=2;s=CNC.CycleStart       → boolean
  ns=2;s=CNC.CycleStop        → boolean
```

### Modbus TCP (Sensors)

```
Register map example (power meter):
  Address 0x0000  → Voltage L1       (float32, V)
  Address 0x0002  → Voltage L2       (float32, V)
  Address 0x0004  → Voltage L3       (float32, V)
  Address 0x0006  → Current L1       (float32, A)
  Address 0x000C  → Active Power     (float32, W)
  Address 0x0012  → Power Factor     (float32)
  Address 0x0018  → Frequency        (float32, Hz)
  Address 0x001E  → Total Energy     (float32, kWh)
```

### SiLA 2 (Lab Instruments)

```
gRPC services:
  SiLAService.GetServerInfo()
  Feature.RunAssay(config) → stream<Event>
  Feature.GetStatus() → Status
  Feature.Abort()
```

---

## Appendix D: Troubleshooting

### "Capability not found" when users search
- Verify your capability type matches a `BuiltinCapabilityType`
- Check broker registration: `brokerAgent.registerKernelCapabilities()` called
- Ensure kernel agent is started: `kernelAgent.start()`

### Evidence bundle hash mismatch
- Use canonical JSON (keys sorted lexicographically) — `EvidenceEmitter` handles this automatically
- Don't modify bundle contents after `finalizeBundle()`

### Job stuck in "executing"
- Check adapter polling: is `getProgress()` returning updated values?
- Verify adapter emits `execution_completed` when done
- Check for unhandled errors in `execute()` — wrap in try/catch

### Settlement not releasing funds
- Verify evidence was submitted: `settlement.submitEvidence()` returned successfully
- Check challenge window hasn't expired yet (check `milestones[i].challengeWindowEnd`)
- Ensure verifier attested: `settlement.submitAttestation()` for Tier 1+

### Device going offline during a job
- Your adapter's `getStatus()` should return `"offline"` or `"error"`
- JobRunner will timeout after 120s of no progress
- Failed jobs produce an error evidence event — the escrow can be disputed

### Network connectivity issues
- `NetworkTransport` auto-reconnects every 3s by default
- Messages queued while offline (max 100 per agent) are delivered on reconnect
- Use health checks: `GET /api/a2a/agents` to verify your agent is visible

---

## Quick Start Summary

```bash
# 1. Install
pnpm add @pcc/spec @pcc/kernel @pcc/a2a @pcc/agent-runtime @pcc/agent-kernel

# 2. Define capabilities (what your machine does)
# 3. Write adapters (wrap your device API)
# 4. Create kernel + kernel agent
# 5. Register with broker
# 6. Connect to network
# 7. Test end-to-end
# 8. Go live

# Minimum viable integration:
# - 1 MachineAdapter (your device API wrapper)
# - 1 Capability definition
# - 1 KernelAgent connected to the bus
# - Broker registration
#
# That's it. Users can now discover your equipment,
# request quotes, submit jobs, and pay you on-chain.
```
