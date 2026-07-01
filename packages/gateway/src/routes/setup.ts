/**
 * Setup agent endpoints.
 *
 * GET  /api/setup/detect          — auto-detect current config state
 * POST /api/setup/generate-config — generate KERNEL_CONFIG JSON from device descriptions
 * POST /api/setup/validate        — validate a kernel config
 * POST /api/setup/register-device — register a device via the DB
 * POST /api/setup/test-job        — submit a test job to verify the pipeline
 * GET  /api/setup/status          — comprehensive setup status
 */

import type { FastifyInstance } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { getRepos } from "../db.js";
import { getKernelFacade, getJobFacade } from "../facades/index.js";
import { getKernelService } from "../services/kernel-service.js";
import { trackServerEvent } from "../services/posthog-service.js";
import { auditService } from "../services/audit-service.js";
import type { KernelConfig, DeviceConfig, AdapterType, DeviceRole } from "@pcc/kernel";

// ---------------------------------------------------------------------------
// Valid adapter types and device roles
// ---------------------------------------------------------------------------

const VALID_ADAPTER_TYPES: AdapterType[] = [
  "octoprint",
  "modbus",
  "opcua",
  "sila",
  "ipp",
  "generic-http",
  "mock",
];

const VALID_DEVICE_ROLES: DeviceRole[] = ["machine", "sensor", "camera"];

// ---------------------------------------------------------------------------
// Environment variables that the detect endpoint checks
// ---------------------------------------------------------------------------

const ENV_VAR_CHECKS = [
  // Chain/Network
  { name: "PCC_NETWORK", category: "chain" },
  { name: "PCC_GATEWAY_PRIVATE_KEY", category: "chain", sensitive: true },
  { name: "ESCROW_CONTRACT_ADDRESS", category: "chain" },
  // ERC-4337
  { name: "ENTRY_POINT_ADDRESS", category: "chain" },
  { name: "KERNEL_FACTORY_ADDRESS", category: "chain" },
  { name: "PAYMASTER_ADDRESS", category: "chain" },
  // Gateway/Server
  { name: "PORT", category: "gateway" },
  { name: "NODE_ENV", category: "gateway" },
  { name: "PCC_DB_PATH", category: "database" },
  // Kernel Runtime
  { name: "KERNEL_CONFIG", category: "kernel" },
  { name: "KERNEL_CONFIG_FILE", category: "kernel" },
  { name: "KERNEL_ID", category: "kernel" },
  // Evidence Storage
  { name: "EVIDENCE_STORAGE", category: "storage" },
  { name: "STORACHA_PROOF", category: "storage", sensitive: true },
  { name: "STORACHA_SPACE_DID", category: "storage" },
  // Lit Protocol
  { name: "LIT_PROTOCOL_REAL", category: "lit" },
  // Starknet
  { name: "STARKNET_ACCOUNT_ADDRESS", category: "starknet" },
  { name: "STARKNET_PRIVATE_KEY", category: "starknet", sensitive: true },
  { name: "STARKNET_NETWORK", category: "starknet" },
  // x402
  { name: "X402_ENABLED", category: "payments" },
  { name: "X402_FACILITATOR_URL", category: "payments" },
  // Dashboard
  { name: "SERVE_DASHBOARD", category: "dashboard" },
];

// ---------------------------------------------------------------------------
// Body / Params interfaces
// ---------------------------------------------------------------------------

interface DeviceDescription {
  name: string;
  type: DeviceRole;
  adapterType: AdapterType;
  url?: string;
  apiKey?: string;
  host?: string;
  port?: number;
}

interface GenerateConfigBody {
  kernelId?: string;
  devices: DeviceDescription[];
  mockMode?: boolean;
}

interface ValidateBody {
  config?: string;
}

interface RegisterDeviceBody {
  kernelId: string;
  deviceId: string;
  type: string;
  model?: string;
  adapterType: string;
  adapterConfig?: Record<string, unknown>;
  capabilities?: string[];
}

interface TestJobBody {
  kernelId?: string;
  deviceId?: string;
  assuranceTier?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildDeviceConfig(desc: DeviceDescription, kernelId: string, index: number): DeviceConfig {
  const id = `dev_${slugify(desc.name)}_${String(index).padStart(3, "0")}`;
  const cfg: Record<string, unknown> = { kernelId };

  switch (desc.adapterType) {
    case "octoprint":
      if (desc.url) cfg.url = desc.url;
      if (desc.apiKey) cfg.apiKey = desc.apiKey;
      break;
    case "opcua":
      if (desc.url) cfg.endpoint = desc.url;
      if (desc.host) cfg.endpoint = `opc.tcp://${desc.host}:${desc.port ?? 4840}`;
      break;
    case "modbus":
      if (desc.host) cfg.host = desc.host;
      if (desc.port) cfg.port = desc.port;
      break;
    case "sila":
      if (desc.url) cfg.url = desc.url;
      break;
    case "ipp":
      if (desc.url) cfg.uri = desc.url;
      else if (desc.host) cfg.uri = `ipp://${desc.host}:${desc.port ?? 631}/ipp/print`;
      if (desc.name) cfg.name = desc.name;
      cfg.mockMode = false;
      break;
    case "generic-http":
      if (desc.url) cfg.url = desc.url;
      break;
    case "mock":
    default:
      cfg.jobDurationMs = 5000;
  }

  return { id, type: desc.type, adapterType: desc.adapterType, config: cfg };
}

function validateAdapterConfig(
  device: DeviceConfig,
): Array<{ name: string; status: "pass" | "warn" | "fail"; message: string }> {
  const checks: Array<{ name: string; status: "pass" | "warn" | "fail"; message: string }> = [];
  const cfg = device.config;

  switch (device.adapterType) {
    case "octoprint": {
      if (!cfg.url) {
        checks.push({
          name: `device:${device.id}:url`,
          status: "fail",
          message: `OctoPrint adapter "${device.id}" requires a url`,
        });
      } else {
        checks.push({
          name: `device:${device.id}:url`,
          status: "pass",
          message: `OctoPrint URL set: ${String(cfg.url)}`,
        });
      }
      if (!cfg.apiKey) {
        checks.push({
          name: `device:${device.id}:apiKey`,
          status: "warn",
          message: `OctoPrint adapter "${device.id}" has no apiKey set`,
        });
      }
      break;
    }
    case "modbus": {
      checks.push({
        name: `device:${device.id}:host`,
        status: cfg.host ? "pass" : "warn",
        message: cfg.host
          ? `Modbus host: ${String(cfg.host)}`
          : `Modbus adapter "${device.id}" has no host set (will default to localhost)`,
      });
      break;
    }
    case "opcua": {
      checks.push({
        name: `device:${device.id}:endpoint`,
        status: cfg.endpoint ? "pass" : "warn",
        message: cfg.endpoint
          ? `OPC-UA endpoint: ${String(cfg.endpoint)}`
          : `OPC-UA adapter "${device.id}" has no endpoint set`,
      });
      break;
    }
    case "sila": {
      checks.push({
        name: `device:${device.id}:url`,
        status: cfg.url ? "pass" : "warn",
        message: cfg.url
          ? `SiLA URL: ${String(cfg.url)}`
          : `SiLA adapter "${device.id}" has no url set (mock mode)`,
      });
      break;
    }
    case "ipp": {
      const uri = cfg.uri as string | undefined;
      if (!uri) {
        checks.push({
          name: `device:${device.id}:uri`,
          status: "fail",
          message: `IPP adapter "${device.id}" requires a uri (e.g. ipp://host:631/ipp/print)`,
        });
      } else if (!/^ipps?:\/\//.test(uri)) {
        checks.push({
          name: `device:${device.id}:uri`,
          status: "fail",
          message: `IPP adapter "${device.id}" uri must start with ipp:// or ipps://: ${uri}`,
        });
      } else {
        checks.push({
          name: `device:${device.id}:uri`,
          status: "pass",
          message: `IPP URI: ${uri}`,
        });
      }
      break;
    }
    default:
      checks.push({
        name: `device:${device.id}:adapter`,
        status: "pass",
        message: `Device "${device.id}" uses ${device.adapterType} adapter`,
      });
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export async function setupRoutes(app: FastifyInstance) {
  const kernelFacade = getKernelFacade();
  const jobFacade = getJobFacade();
  // ── GET /api/setup/detect ────────────────────────────────────────────────

  app.get("/api/setup/detect", async (_req, _reply) => {
    // Check env vars
    const envVars = ENV_VAR_CHECKS.map((v) => {
      const value = process.env[v.name];
      return {
        name: v.name,
        category: v.category,
        set: Boolean(value),
        // Don't expose sensitive values
        value: value && !v.sensitive ? value : undefined,
      };
    });

    // Check DB state — kernels + jobs via facades, devices stay inline (no facade method)
    let dbState = { kernels: 0, devices: 0, jobs: 0, initialized: false };
    const kernelResult = await kernelFacade.list();
    const jobResult = await jobFacade.list();
    if (kernelResult.success && jobResult.success) {
      const kernelList = kernelResult.data;
      const deviceCount = kernelList.reduce(
        (acc, k) => acc + (Array.isArray((k as any).devices) ? (k as any).devices.length : 0),
        0,
      );
      dbState = {
        kernels: kernelList.length,
        devices: deviceCount,
        jobs: jobResult.data.total,
        initialized: true,
      };
    }

    // Check KernelService
    let kernelServiceReady = false;
    let kernelServiceDevices: Array<{ id: string; type: string; adapterType: string; healthy: boolean }> = [];
    try {
      const svc = getKernelService();
      kernelServiceReady = true;
      const devices = await svc.listDevices();
      kernelServiceDevices = devices.map((d) => ({
        id: d.id,
        type: d.type,
        adapterType: d.adapterType,
        healthy: d.healthStatus === "healthy",
      }));
    } catch {
      // Not initialized
    }

    // Summarize chain config
    const chainConfigured =
      Boolean(process.env.PCC_NETWORK) && Boolean(process.env.PCC_GATEWAY_PRIVATE_KEY);

    // Summarize storage config
    const storageType = process.env.EVIDENCE_STORAGE ?? "local";
    const storageConfigured =
      storageType === "local" ||
      storageType === "helia" ||
      (storageType === "storacha" &&
        Boolean(process.env.STORACHA_PROOF) &&
        Boolean(process.env.STORACHA_SPACE_DID));

    // Summarize identity
    const identityConfigured = Boolean(process.env.STARKNET_ACCOUNT_ADDRESS);

    return {
      envVars,
      db: dbState,
      kernelService: {
        ready: kernelServiceReady,
        devices: kernelServiceDevices,
      },
      chain: {
        connected: chainConfigured,
        network: process.env.PCC_NETWORK ?? null,
      },
      storage: {
        type: storageType,
        configured: storageConfigured,
      },
      identity: {
        configured: identityConfigured,
        accountAddress: process.env.STARKNET_ACCOUNT_ADDRESS ?? null,
      },
      litProtocol: {
        real: process.env.LIT_PROTOCOL_REAL === "true",
      },
    };
  });

  // ── POST /api/setup/generate-config ──────────────────────────────────────

  app.post<{ Body: GenerateConfigBody }>(
    "/api/setup/generate-config",
    async (req, reply) => {
      const { kernelId, devices, mockMode } = req.body;

      if (!devices || !Array.isArray(devices) || devices.length === 0) {
        return reply.code(400).send({ error: "devices_required" });
      }

      // Validate device descriptions
      for (const d of devices) {
        if (!d.name || !d.type || !d.adapterType) {
          return reply.code(400).send({ error: "device_missing_required_fields" });
        }
        if (!VALID_DEVICE_ROLES.includes(d.type)) {
          return reply.code(400).send({
            error: "invalid_device_type",
            message: `Invalid type "${d.type}". Valid: ${VALID_DEVICE_ROLES.join(", ")}`,
          });
        }
        if (!VALID_ADAPTER_TYPES.includes(d.adapterType)) {
          return reply.code(400).send({
            error: "invalid_adapter_type",
            message: `Invalid adapterType "${d.adapterType}". Valid: ${VALID_ADAPTER_TYPES.join(", ")}`,
          });
        }
      }

      const resolvedKernelId =
        kernelId ?? `kernel_${slugify(process.env.KERNEL_ID ?? "shop")}_${Date.now()}`;

      const deviceConfigs: DeviceConfig[] = devices.map((desc, i) =>
        buildDeviceConfig(desc, resolvedKernelId, i),
      );

      const config: KernelConfig = {
        kernelId: resolvedKernelId,
        devices: deviceConfigs,
        ...(mockMode ? { mockMode: true } : {}),
      };

      const configJson = JSON.stringify(config, null, 2);
      const configInline = JSON.stringify(config);
      const envLine = `KERNEL_CONFIG='${configInline}'`;

      return { config, envLine, configJson };
    },
  );

  // ── POST /api/setup/validate ─────────────────────────────────────────────

  app.post<{ Body: ValidateBody }>("/api/setup/validate", async (req, reply) => {
    const checks: Array<{ name: string; status: "pass" | "warn" | "fail"; message: string }> = [];
    const errors: string[] = [];
    const warnings: string[] = [];

    // Parse config
    let config: KernelConfig | null = null;
    const source = req.body?.config ?? process.env.KERNEL_CONFIG;

    if (!source) {
      // Fall back to default mock config
      checks.push({
        name: "config_source",
        status: "warn",
        message:
          "No config provided and KERNEL_CONFIG env var not set. Using default mock config.",
      });
      config = {
        kernelId: process.env.KERNEL_ID ?? "kernel_dev_001",
        mockMode: true,
        devices: [],
      };
    } else {
      try {
        config = JSON.parse(source) as KernelConfig;
        checks.push({
          name: "config_parseable",
          status: "pass",
          message: "Config JSON is valid",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        checks.push({
          name: "config_parseable",
          status: "fail",
          message: `Config JSON parse error: ${msg}`,
        });
        errors.push(`JSON parse error: ${msg}`);
        return { valid: false, checks, errors, warnings };
      }
    }

    // Check kernelId
    if (!config.kernelId) {
      checks.push({ name: "kernel_id", status: "fail", message: "kernelId is required" });
      errors.push("Missing kernelId");
    } else {
      checks.push({
        name: "kernel_id",
        status: "pass",
        message: `kernelId: ${config.kernelId}`,
      });
    }

    // Check devices
    if (!config.devices || config.devices.length === 0) {
      checks.push({
        name: "devices_defined",
        status: "warn",
        message: "No devices defined in config",
      });
      warnings.push("No devices defined");
    } else {
      checks.push({
        name: "devices_defined",
        status: "pass",
        message: `${config.devices.length} device(s) defined`,
      });

      // Validate each device
      for (const device of config.devices) {
        // Required fields
        if (!device.id) {
          checks.push({
            name: `device:missing_id`,
            status: "fail",
            message: "A device is missing the required 'id' field",
          });
          errors.push("Device missing id");
          continue;
        }
        if (!VALID_DEVICE_ROLES.includes(device.type)) {
          checks.push({
            name: `device:${device.id}:type`,
            status: "fail",
            message: `Device "${device.id}" has invalid type "${device.type}"`,
          });
          errors.push(`Device ${device.id}: invalid type`);
          continue;
        }
        if (!VALID_ADAPTER_TYPES.includes(device.adapterType)) {
          checks.push({
            name: `device:${device.id}:adapterType`,
            status: "fail",
            message: `Device "${device.id}" has invalid adapterType "${device.adapterType}"`,
          });
          errors.push(`Device ${device.id}: invalid adapterType`);
          continue;
        }

        // Adapter-specific config checks
        const adapterChecks = validateAdapterConfig(device);
        checks.push(...adapterChecks);
        for (const c of adapterChecks) {
          if (c.status === "fail") errors.push(c.message);
          if (c.status === "warn") warnings.push(c.message);
        }
      }
    }

    // Check mockMode flag
    if (config.mockMode) {
      checks.push({
        name: "mock_mode",
        status: "warn",
        message:
          "mockMode is enabled — all adapters will use mock implementations regardless of adapterType",
      });
      warnings.push("mockMode is true");
    }

    const valid = errors.length === 0;
    return { valid, checks, errors, warnings };
  });

  // ── POST /api/setup/register-device ──────────────────────────────────────

  app.post<{ Body: RegisterDeviceBody }>(
    "/api/setup/register-device",
    async (req, reply) => {
      const { kernelId, deviceId, type, model, adapterType, adapterConfig, capabilities } =
        req.body;

      if (!kernelId || !deviceId || !type || !adapterType) {
        return reply.code(400).send({ error: "missing_required_fields" });
      }

      if (!VALID_ADAPTER_TYPES.includes(adapterType as AdapterType)) {
        return reply.code(400).send({
          error: "invalid_adapter_type",
          message: `Invalid adapterType. Valid: ${VALID_ADAPTER_TYPES.join(", ")}`,
        });
      }

      try {
        const repos = getRepos();

        // Verify kernel exists
        const kernel = repos.kernels.findById(kernelId);
        if (!kernel) {
          return reply.code(400).send({ error: "kernel_not_found" });
        }

        // Idempotent upsert — never 409 a re-registration. If the device
        // exists, update its mutable fields; otherwise insert.
        const existing = repos.kernels.findDeviceById(deviceId);
        const now = new Date().toISOString();
        let device: any;
        let action: "created" | "updated";
        if (existing) {
          device = repos.kernels.updateDevice(deviceId, {
            kernelId,
            type,
            model: model ?? existing.model ?? "unknown",
            status: existing.status ?? "idle",
            contributesToCapabilities: capabilities ?? existing.contributesToCapabilities ?? [],
            lastUpdated: now,
            adapterType,
            adapterConfig: adapterConfig
              ? JSON.stringify(adapterConfig)
              : existing.adapterConfig,
            capabilities: capabilities ?? existing.capabilities ?? [],
            healthStatus: existing.healthStatus ?? "healthy",
          });
          action = "updated";
        } else {
          device = repos.kernels.insertDevice({
            id: deviceId,
            kernelId,
            type,
            model: model ?? "unknown",
            firmware: "unknown",
            status: "idle",
            contributesToCapabilities: capabilities ?? [],
            lastUpdated: now,
            adapterType,
            adapterConfig: adapterConfig ? JSON.stringify(adapterConfig) : undefined,
            capabilities: capabilities ?? [],
            healthStatus: "healthy",
          });
          action = "created";
        }

        // Wire the device into the running KernelService runtime so the
        // very next test-job lands on THIS device, not a fallback mock.
        // Failure here is non-fatal — DB write already succeeded.
        try {
          getKernelService().refreshDeviceFromDb(deviceId);
        } catch (e) {
          // Service may not be initialized in some test paths; ignore.
          const msg = e instanceof Error ? e.message : String(e);
          (req as any).log?.warn?.({ err: msg, deviceId }, "kernel-service refresh failed");
        }

        // Auto-create capability rows for each capability the device contributes to
        if (capabilities && capabilities.length > 0) {
          for (const capType of capabilities) {
            const capId = `cap-${kernelId}-${capType}`;
            // Only insert if it doesn't already exist
            const existingCap = repos.capabilities.findById(capId);
            if (!existingCap) {
              try {
                repos.capabilities.insert({
                  id: capId,
                  kernelId,
                  type: capType,
                  name: `${model ?? "Device"} — ${capType}`,
                  description: `Auto-registered from device ${deviceId}`,
                  materials: [],
                  assuranceTiers: [0, 1],
                  pricing: { currency: "USDC", baseCost: "0", minimum: "0" },
                  availability: {},
                  location: { lat: 0, lng: 0 },
                } as any);
              } catch (_capErr) {
                // Non-fatal — capability may already exist from another device
              }
            }
          }
        }

        trackServerEvent("device_registered", {
          deviceId,
          kernelId,
          type,
          adapterType,
          model,
          action,
          capabilitiesRegistered: capabilities?.length ?? 0,
        }, (req as any).operatorId ?? (req as any).apiKeyId);
        auditService.log({
          eventType: action === "created" ? "device.registered" : "device.updated",
          actor: (req as any).operatorId ?? (req as any).apiKeyId,
          resourceType: "device",
          resourceId: deviceId,
          action: action === "created" ? "create" : "update",
          metadata: { kernelId, type, adapterType, model },
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        });
        return reply.code(action === "created" ? 201 : 200).send({
          device,
          registered: true,
          action,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return reply.code(500).send({ error: "upsert_failed", message });
      }
    },
  );

  // ── POST /api/setup/test-job ──────────────────────────────────────────────

  app.post<{ Body: TestJobBody }>("/api/setup/test-job", async (req, reply) => {
    const { kernelId, deviceId, assuranceTier = 0 } = req.body ?? {};

    let svc;
    try {
      svc = getKernelService();
    } catch {
      return reply.code(503).send({
        error: "kernel_service_not_ready",
        message: "KernelService is not initialized",
      });
    }

    const jobId = `test-job-${uuidv4()}`;
    const stepId = `setup-test-${Date.now()}`;
    const resolvedKernelId = kernelId ?? "kernel_dev_001";
    const startTime = Date.now();

    // Insert a job record into the DB so status polling works
    try {
      const repos = getRepos();
      let capabilityId: string | undefined;
      try {
        const caps = repos.capabilities.findByKernel(resolvedKernelId);
        capabilityId = caps[0]?.id;
      } catch {
        // No capability found — that's okay for a test job
      }
      if (capabilityId) {
        repos.jobs.insert({
          id: jobId,
          stepId,
          cwmId: `cwm-${uuidv4()}`,
          capabilityId,
          kernelId: resolvedKernelId,
          status: "queued",
          assignedDevices: deviceId ? [deviceId] : [],
          startedAt: new Date().toISOString(),
          progress: 0,
        });
      }
    } catch {
      // DB insert is best-effort for test jobs
    }

    // ── Deviceless branch (coord be246d92) ──────────────────────────────
    // If this kernel has no registered devices AND the caller didn't specify
    // a target deviceId (rideshare, wood-fired-pizza, courier, etc), don't
    // try to submit a job to a mock printer — generate a self-attested
    // evidence bundle directly and return a completed test-job. The old
    // behavior landed EVERY test-job on the KERNEL_CONFIG mock device
    // regardless of capability type, so a rideshare operator got a printer
    // job report. Now: for deviceless kernels, we self-attest. Explicit
    // deviceId requests bypass this branch (existing tests exercise that).
    let isDeviceless = false;
    if (!deviceId) {
      try {
        const devices = getRepos().kernels.findDevicesByKernel(resolvedKernelId);
        isDeviceless = devices.length === 0;
      } catch {
        // If the repo lookup fails, fall through to the existing submitJob path
        // (best-effort — same behavior as before).
      }
    }
    if (isDeviceless) {
      // Self-attested completion — no device to invoke. Persist a real
      // evidence bundle row so downstream consumers (compliance facade,
      // dashboard evidence list, /api/jobs/:id/evidence) see the same
      // shape as evidence from real devices — just with algorithm:"none"
      // + signer:"self-attest" on the kernelSignature JSON to make the
      // self-attest provenance explicit.
      const evidenceBundleId = `bundle-self-attest-${uuidv4().slice(0, 12)}`;
      const now = new Date().toISOString();
      const bundleHash = `sha256:self-attest:${stepId}`;
      try {
        getRepos().evidence.insert({
          id: evidenceBundleId,
          jobId,
          stepId,
          kernelId: resolvedKernelId,
          assuranceTier: assuranceTier as 0 | 1 | 2 | 3,
          bundleHash,
          kernelSignature: {
            signer: "self-attest",
            algorithm: "none",
            value: `self-attested by kernel ${resolvedKernelId} at ${now}`,
          },
          createdAt: now,
        });
      } catch {
        // Bundle persistence is best-effort. If it fails (e.g. the parent
        // job row was never inserted because the kernel has no capabilities),
        // the response still returns the id + status. A follow-up can add
        // the missing job row here + retry.
      }
      try {
        getRepos().jobs.updateStatus(jobId, "completed");
      } catch {
        // best-effort
      }
      return {
        jobId,
        deviceId: null,
        status: "completed",
        evidenceBundleId,
        evidencePath: "self-attested",
        duration: Date.now() - startTime,
      };
    }

    // Submit the job
    let submitResult: { jobId: string; deviceId: string; status: string };
    try {
      submitResult = await svc.submitJob({
        jobId,
        stepId,
        deviceId,
        assuranceTier: assuranceTier as 0 | 1 | 2 | 3,
      });
    } catch (err) {
      return reply.code(500).send({
        error: "job_submission_failed",
        message: err instanceof Error ? err.message : "Unknown error",
        jobId,
        duration: Date.now() - startTime,
      });
    }

    // Poll for completion (up to 10 seconds)
    const POLL_INTERVAL_MS = 250;
    const MAX_WAIT_MS = 10_000;
    const deadline = Date.now() + MAX_WAIT_MS;

    let finalStatus = submitResult.status;
    let evidenceBundleId: string | undefined;
    let consecutiveUnknown = 0;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      try {
        const statusResult = await svc.getJobStatus(jobId);
        finalStatus = statusResult.status;
        if (statusResult.evidenceBundleId) {
          evidenceBundleId = statusResult.evidenceBundleId;
        }
        if (finalStatus === "completed" || finalStatus === "failed") {
          break;
        }
        // "unknown" means the job ran without DB tracking (no capability found).
        // After 2 consecutive "unknown" responses, assume the job completed.
        if (finalStatus === "unknown") {
          consecutiveUnknown++;
          if (consecutiveUnknown >= 2) break;
        } else {
          consecutiveUnknown = 0;
        }
      } catch {
        // continue polling
      }
    }

    return {
      jobId,
      deviceId: submitResult.deviceId,
      status: finalStatus,
      evidenceBundleId: evidenceBundleId ?? null,
      duration: Date.now() - startTime,
    };
  });

  // ── GET /api/setup/status ────────────────────────────────────────────────

  app.get("/api/setup/status", async (_req, _reply) => {
    const categories: Array<{
      name: string;
      status: "ready" | "partial" | "unconfigured";
      details: string;
    }> = [];

    // Gateway category
    categories.push({
      name: "gateway",
      status: "ready",
      details: `Gateway running on port ${process.env.PORT ?? "3200"}`,
    });

    // Database category
    let dbStatus: "ready" | "partial" | "unconfigured" = "unconfigured";
    let dbDetails = "Database not initialized";
    const dbKernelResult = await kernelFacade.list();
    if (dbKernelResult.success) {
      const kernelCount = dbKernelResult.data.length;
      if (kernelCount > 0) {
        dbStatus = "ready";
        dbDetails = `${kernelCount} kernel(s) registered`;
      } else {
        dbStatus = "partial";
        dbDetails = "Database initialized but no kernels registered";
      }
    }
    categories.push({ name: "database", status: dbStatus, details: dbDetails });

    // Adapters category
    let adaptersStatus: "ready" | "partial" | "unconfigured" = "unconfigured";
    let adaptersDetails = "KernelService not initialized";
    try {
      const svc = getKernelService();
      const devices = await svc.listDevices();
      if (devices.length > 0) {
        const realAdapters = devices.filter((d) => d.adapterType !== "mock");
        if (realAdapters.length > 0) {
          adaptersStatus = "ready";
          adaptersDetails = `${devices.length} device(s) configured (${realAdapters.length} real)`;
        } else {
          adaptersStatus = "partial";
          adaptersDetails = `${devices.length} device(s) configured (all mock)`;
        }
      } else {
        adaptersStatus = "unconfigured";
        adaptersDetails = "No devices configured";
      }
    } catch {
      adaptersStatus = "unconfigured";
      adaptersDetails = "KernelService not initialized";
    }
    categories.push({ name: "adapters", status: adaptersStatus, details: adaptersDetails });

    // Chain category
    const hasNetwork = Boolean(process.env.PCC_NETWORK);
    const hasKey = Boolean(process.env.PCC_GATEWAY_PRIVATE_KEY);
    const hasEscrow = Boolean(process.env.ESCROW_CONTRACT_ADDRESS);
    let chainStatus: "ready" | "partial" | "unconfigured";
    let chainDetails: string;
    if (hasNetwork && hasKey && hasEscrow) {
      chainStatus = "ready";
      chainDetails = `Chain: ${process.env.PCC_NETWORK}, escrow configured`;
    } else if (hasNetwork || hasKey || hasEscrow) {
      chainStatus = "partial";
      const missing: string[] = [];
      if (!hasNetwork) missing.push("PCC_NETWORK");
      if (!hasKey) missing.push("PCC_GATEWAY_PRIVATE_KEY");
      if (!hasEscrow) missing.push("ESCROW_CONTRACT_ADDRESS");
      chainDetails = `Missing: ${missing.join(", ")}`;
    } else {
      chainStatus = "unconfigured";
      chainDetails = "No chain config set — running in mock settlement mode";
    }
    categories.push({ name: "chain", status: chainStatus, details: chainDetails });

    // Storage category
    const storageType = process.env.EVIDENCE_STORAGE ?? "local";
    let storageStatus: "ready" | "partial" | "unconfigured";
    let storageDetails: string;
    if (storageType === "local" || storageType === "helia") {
      storageStatus = "ready";
      storageDetails = `Evidence storage: ${storageType}`;
    } else if (storageType === "storacha") {
      const hasProof = Boolean(process.env.STORACHA_PROOF);
      const hasDid = Boolean(process.env.STORACHA_SPACE_DID);
      if (hasProof && hasDid) {
        storageStatus = "ready";
        storageDetails = "Storacha w3up configured";
      } else {
        storageStatus = "partial";
        const missing: string[] = [];
        if (!hasProof) missing.push("STORACHA_PROOF");
        if (!hasDid) missing.push("STORACHA_SPACE_DID");
        storageDetails = `Storacha missing: ${missing.join(", ")}`;
      }
    } else {
      storageStatus = "partial";
      storageDetails = `Unknown storage type: ${storageType}`;
    }
    categories.push({ name: "storage", status: storageStatus, details: storageDetails });

    // Identity category
    const hasStarknet = Boolean(process.env.STARKNET_ACCOUNT_ADDRESS);
    let identityStatus: "ready" | "partial" | "unconfigured";
    let identityDetails: string;
    if (hasStarknet) {
      identityStatus = "ready";
      identityDetails = `Starknet identity: ${process.env.STARKNET_ACCOUNT_ADDRESS}`;
    } else {
      identityStatus = "unconfigured";
      identityDetails = "No on-chain identity configured";
    }
    categories.push({ name: "identity", status: identityStatus, details: identityDetails });

    // Compute overall status
    const statuses = categories.map((c) => c.status);
    let overall: "ready" | "partial" | "unconfigured";
    if (statuses.every((s) => s === "ready")) {
      overall = "ready";
    } else if (statuses.every((s) => s === "unconfigured")) {
      overall = "unconfigured";
    } else {
      overall = "partial";
    }

    return { overall, categories };
  });
}
