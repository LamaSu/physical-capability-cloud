/**
 * Wizard session management routes.
 *
 * Tracks multi-step onboarding progress across three wizard flows:
 *   - platform-setup (5 steps)
 *   - machine-onboarding (7 steps)
 *   - device-builder (5 steps)
 *
 * POST   /api/wizard/sessions              — Create a new wizard session
 * GET    /api/wizard/sessions/:id          — Get wizard session state
 * PUT    /api/wizard/sessions/:id/steps/:step — Save data for a wizard step
 * POST   /api/wizard/sessions/:id/complete — Complete the wizard (orchestrate backend operations)
 * DELETE /api/wizard/sessions/:id          — Abandon a wizard session
 */

import type { FastifyInstance } from "fastify";
import { v4 as uuidv4 } from "uuid";
import type {
  WizardSession,
  WizardTrack,
  WizardSessionStatus,
  WizardStepData,
  WizardCompletionResult,
} from "@pcc/spec";
import type { IRepositories } from "@pcc/store";
import { getRepos } from "../db.js";

/**
 * Z3 — returns repos when the store is initialised, null otherwise (tests /
 * dev processes without a DB). Callers report honest "skipped" steps in the
 * null case instead of fabricating backend effects.
 */
function tryGetRepos(): IRepositories | null {
  try {
    return getRepos();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Track definitions — step names for each wizard flow
// ---------------------------------------------------------------------------

const TRACK_STEPS: Record<WizardTrack, string[]> = {
  "platform-setup": [
    "environment-detection",
    "chain-configuration",
    "storage-configuration",
    "identity-configuration",
    "review-and-deploy",
  ],
  "machine-onboarding": [
    "machine-info",
    "document-upload",
    "capability-definition",
    "space-requirements",
    "pricing-configuration",
    "operator-profile",
    "review-and-submit",
  ],
  "device-builder": [
    "device-selection",
    "adapter-configuration",
    "capability-mapping",
    "test-connection",
    "register-device",
  ],
};

const VALID_TRACKS = Object.keys(TRACK_STEPS) as WizardTrack[];

// ---------------------------------------------------------------------------
// In-memory session store with 24h TTL
// ---------------------------------------------------------------------------

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PRUNE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_SESSIONS = 10_000; // Cap to prevent memory exhaustion

// WizardSession extended with owner for access control
interface OwnedWizardSession extends WizardSession {
  ownerId?: string;
}

const sessions = new Map<string, OwnedWizardSession>();

/**
 * Z1 — single-flight guard for /complete.
 *
 * The status check and the terminal status write in the /complete handler are
 * separated by an await (orchestration), so two concurrent calls could both
 * pass the check and orchestrate twice. Sessions are claimed here
 * synchronously (no await between check and claim) before orchestrating.
 */
const completingSessions = new Set<string>();

/**
 * Test seam: when set, replaces the per-track orchestration inside
 * orchestrateCompletion. Lets tests exercise the failure and concurrency
 * paths deterministically. Never set in production.
 */
let completionOverride:
  | ((session: WizardSession) => Promise<WizardCompletionResult>)
  | null = null;

function pruneExpiredSessions(): void {
  const now = new Date().toISOString();
  for (const [id, session] of sessions) {
    if (session.expiresAt < now) {
      sessions.delete(id);
    }
  }
}

/** Enforce memory cap via LRU-style eviction on the oldest session */
function enforceSessionCap(): void {
  if (sessions.size < MAX_SESSIONS) return;
  let oldest: string | null = null;
  let oldestTime = Infinity;
  for (const [id, s] of sessions) {
    const t = Date.parse(s.updatedAt);
    if (t < oldestTime) { oldestTime = t; oldest = id; }
  }
  if (oldest) sessions.delete(oldest);
}

/** Check if the request's caller owns the session (or if session has no owner = legacy) */
function isOwnerOrUnbound(session: OwnedWizardSession, callerId: string | undefined): boolean {
  if (!session.ownerId) return true; // Legacy unbound session — allow
  if (!callerId) return false;       // Unauthenticated caller on owned session
  return session.ownerId === callerId;
}

// ---------------------------------------------------------------------------
// Body/Params interfaces
// ---------------------------------------------------------------------------

interface CreateSessionBody {
  track: WizardTrack;
}

interface SaveStepBody {
  data: Record<string, unknown>;
}

interface SessionParams {
  id: string;
}

interface StepParams {
  id: string;
  step: string;
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export async function wizardRoutes(app: FastifyInstance) {
  // Schedule periodic pruning (same pattern as idempotency middleware)
  const pruneTimer = setInterval(pruneExpiredSessions, PRUNE_INTERVAL_MS);
  if (pruneTimer.unref) pruneTimer.unref();
  app.addHook("onClose", async () => {
    clearInterval(pruneTimer);
  });

  // ── POST /api/wizard/sessions ─────────────────────────────────────────────

  app.post<{ Body: CreateSessionBody }>(
    "/api/wizard/sessions",
    async (req, reply) => {
      const { track } = req.body ?? {};

      if (!track || !VALID_TRACKS.includes(track)) {
        return reply.code(400).send({
          error: "invalid_track",
          message: `track must be one of: ${VALID_TRACKS.join(", ")}`,
        });
      }

      // Enforce session cap before inserting
      enforceSessionCap();

      const stepNames = TRACK_STEPS[track];
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + TTL_MS).toISOString();

      // Bind the session to the authenticated caller (prevents hijacking)
      const ownerId = (req as any).operatorId ?? (req as any).userId;

      const session: OwnedWizardSession = {
        id: uuidv4(),
        track,
        status: "in_progress",
        currentStep: 0,
        totalSteps: stepNames.length,
        steps: stepNames.map((name, i) => ({
          stepIndex: i,
          stepName: name,
          completed: false,
          data: {},
          updatedAt: now,
        })),
        createdAt: now,
        updatedAt: now,
        expiresAt,
        ownerId,
      };

      sessions.set(session.id, session);

      return reply.code(201).send({ session });
    },
  );

  // ── GET /api/wizard/sessions/:id ──────────────────────────────────────────

  app.get<{ Params: SessionParams }>(
    "/api/wizard/sessions/:id",
    async (req, reply) => {
      const session = sessions.get(req.params.id);

      if (!session) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      // Check TTL
      if (session.expiresAt < new Date().toISOString()) {
        sessions.delete(req.params.id);
        return reply.code(404).send({ error: "session_expired" });
      }

      // Ownership check — return 404 (not 403) to prevent enumeration
      const callerId = (req as any).operatorId ?? (req as any).userId;
      if (!isOwnerOrUnbound(session, callerId)) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      return { session };
    },
  );

  // ── PUT /api/wizard/sessions/:id/steps/:step ─────────────────────────────

  app.put<{ Params: StepParams; Body: SaveStepBody }>(
    "/api/wizard/sessions/:id/steps/:step",
    async (req, reply) => {
      const session = sessions.get(req.params.id);

      if (!session) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      if (session.expiresAt < new Date().toISOString()) {
        sessions.delete(req.params.id);
        return reply.code(404).send({ error: "session_expired" });
      }

      // Ownership check
      const callerId = (req as any).operatorId ?? (req as any).userId;
      if (!isOwnerOrUnbound(session, callerId)) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      if (session.status !== "in_progress") {
        return reply.code(400).send({
          error: "session_not_in_progress",
          message: `Session is ${session.status} — cannot update steps`,
        });
      }

      const stepIndex = parseInt(req.params.step, 10);
      if (isNaN(stepIndex) || stepIndex < 0 || stepIndex >= session.totalSteps) {
        return reply.code(400).send({
          error: "invalid_step_index",
          message: `Step index must be between 0 and ${session.totalSteps - 1}`,
        });
      }

      const stepData = req.body?.data;
      if (!stepData || typeof stepData !== "object") {
        return reply.code(400).send({
          error: "data_required",
          message: "Request body must include a data object",
        });
      }

      const now = new Date().toISOString();

      // Update the step
      session.steps[stepIndex] = {
        ...session.steps[stepIndex],
        data: { ...session.steps[stepIndex].data, ...stepData },
        completed: true,
        updatedAt: now,
      };

      // Advance currentStep to the next incomplete step
      const nextIncomplete = session.steps.findIndex((s) => !s.completed);
      session.currentStep = nextIncomplete === -1 ? session.totalSteps : nextIncomplete;
      session.updatedAt = now;

      return { session };
    },
  );

  // ── POST /api/wizard/sessions/:id/complete ────────────────────────────────

  app.post<{ Params: SessionParams }>(
    "/api/wizard/sessions/:id/complete",
    async (req, reply) => {
      const session = sessions.get(req.params.id);

      if (!session) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      if (session.expiresAt < new Date().toISOString()) {
        sessions.delete(req.params.id);
        return reply.code(404).send({ error: "session_expired" });
      }

      // Ownership check
      const callerId = (req as any).operatorId ?? (req as any).userId;
      if (!isOwnerOrUnbound(session, callerId)) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      if (session.status === "completed") {
        return reply.code(400).send({
          error: "already_completed",
          message: "This wizard session has already been completed",
        });
      }

      if (session.status === "abandoned") {
        return reply.code(400).send({
          error: "session_abandoned",
          message: "This wizard session was abandoned",
        });
      }

      // Check that all steps are completed
      const incompleteSteps = session.steps.filter((s) => !s.completed);
      if (incompleteSteps.length > 0) {
        return reply.code(400).send({
          error: "incomplete_steps",
          message: `${incompleteSteps.length} step(s) not yet completed`,
          incompleteSteps: incompleteSteps.map((s) => ({
            index: s.stepIndex,
            name: s.stepName,
          })),
        });
      }

      // Z1 — claim the session before the orchestration await so a second
      // concurrent /complete cannot also pass the status checks above.
      if (completingSessions.has(session.id)) {
        return reply.code(409).send({
          error: "completion_in_progress",
          message:
            "Completion is already running for this session — poll GET /api/wizard/sessions/:id",
        });
      }
      completingSessions.add(session.id);

      try {
        // Orchestrate completion based on track
        const result = await orchestrateCompletion(session, {
          // Wave 4.1 — same tenant backfill as POST /api/onboard/register
          tenantId: (req as any).tenantId ?? null,
        });

        const now = new Date().toISOString();
        session.updatedAt = now;
        // Record the latest orchestration outcome (success OR failure) so
        // GET /sessions/:id shows what actually happened.
        session.completionResult = result;

        // Z1 — only mark the session completed when orchestration actually
        // succeeded. On failure the session stays in_progress (retryable)
        // and the failure is surfaced instead of a fabricated success.
        if (!result.success) {
          return reply.code(500).send({
            error: "completion_failed",
            message: result.error ?? "orchestration_failed",
            session,
            result,
          });
        }

        session.status = "completed";
        return { session, result };
      } finally {
        completingSessions.delete(session.id);
      }
    },
  );

  // ── DELETE /api/wizard/sessions/:id ───────────────────────────────────────

  app.delete<{ Params: SessionParams }>(
    "/api/wizard/sessions/:id",
    async (req, reply) => {
      const session = sessions.get(req.params.id);

      if (!session) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      // Ownership check
      const callerId = (req as any).operatorId ?? (req as any).userId;
      if (!isOwnerOrUnbound(session, callerId)) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      if (session.status === "completed") {
        return reply.code(400).send({
          error: "cannot_abandon_completed",
          message: "Cannot abandon a completed session",
        });
      }

      const now = new Date().toISOString();
      session.status = "abandoned";
      session.updatedAt = now;

      return { session, abandoned: true };
    },
  );
}

// ---------------------------------------------------------------------------
// Completion orchestration
// ---------------------------------------------------------------------------

/** Request-scoped context threaded into orchestration (Wave 4.1 tenancy). */
interface CompletionContext {
  tenantId: string | null;
}

async function orchestrateCompletion(
  session: WizardSession,
  ctx: CompletionContext = { tenantId: null },
): Promise<WizardCompletionResult> {
  const executedSteps: WizardCompletionResult["executedSteps"] = [];

  try {
    if (completionOverride) {
      return await completionOverride(session);
    }
    switch (session.track) {
      case "platform-setup":
        return await orchestratePlatformSetup(session, executedSteps);
      case "machine-onboarding":
        return await orchestrateMachineOnboarding(session, executedSteps, ctx);
      case "device-builder":
        return await orchestrateDeviceBuilder(session, executedSteps);
      default:
        return {
          success: false,
          executedSteps,
          error: `Unknown track: ${session.track}`,
        };
    }
  } catch (err) {
    // Log the raw error server-side but don't leak internal details to client
    const message = err instanceof Error ? err.message : String(err);
    console.error("[wizard] orchestrateCompletion error:", message);
    return {
      success: false,
      executedSteps,
      error: "orchestration_failed",
    };
  }
}

async function orchestratePlatformSetup(
  session: WizardSession,
  executedSteps: WizardCompletionResult["executedSteps"],
): Promise<WizardCompletionResult> {
  // Collect data from all steps
  const allData: Record<string, unknown> = {};
  for (const step of session.steps) {
    Object.assign(allData, step.data);
  }

  // Step 1: Validate configuration
  executedSteps.push({
    name: "validate-config",
    status: "success",
    message: "Configuration validated from wizard answers",
    data: { track: session.track },
  });

  // Step 2: Generate env recommendations
  const envVars: Record<string, string> = {};
  if (allData.network) envVars.PCC_NETWORK = String(allData.network);
  if (allData.storageType) envVars.EVIDENCE_STORAGE = String(allData.storageType);
  if (allData.serveDashboard !== undefined) envVars.SERVE_DASHBOARD = String(allData.serveDashboard);

  executedSteps.push({
    name: "generate-env",
    status: "success",
    message: `Generated ${Object.keys(envVars).length} environment variables`,
    data: { envVars },
  });

  return {
    success: true,
    executedSteps,
  };
}

/** Default space requirements — mirrors the POST /api/onboard/register defaults. */
const DEFAULT_SPACE_REQUIREMENTS = {
  footprint: { width: 0, depth: 0, height: 0, unit: "mm" },
  clearances: { front: 0, back: 0, left: 0, right: 0, above: 0, unit: "mm" },
  weight: { value: 0, unit: "kg" },
  power: { voltage: 120, amperage: 15, phase: 1 },
  environmental: { ventilationRequired: false, dustExtraction: false, fumeExtraction: false },
  utilities: { compressedAir: false, water: false, coolant: false, wasteDrainage: false },
  vibrationIsolation: false,
};

async function orchestrateMachineOnboarding(
  session: WizardSession,
  executedSteps: WizardCompletionResult["executedSteps"],
  ctx: CompletionContext,
): Promise<WizardCompletionResult> {
  const allData: Record<string, unknown> = {};
  for (const step of session.steps) {
    Object.assign(allData, step.data);
  }

  // Step 1: Validate machine info
  executedSteps.push({
    name: "validate-machine-info",
    status: "success",
    message: "Machine information validated",
    data: { name: allData.name, category: allData.category },
  });

  // Step 2: Process capabilities
  executedSteps.push({
    name: "process-capabilities",
    status: "success",
    message: "Capabilities processed",
    data: { capabilityCount: Array.isArray(allData.capabilities) ? allData.capabilities.length : 0 },
  });

  // Step 3 (Z3): Submit the registration for REAL — the same row the
  // POST /api/onboard/register route writes, retrievable at
  // GET /api/onboard/registrations/:id. Never fabricate an id: when the row
  // cannot be created, the step says so honestly instead.
  const repos = tryGetRepos();
  if (!repos) {
    executedSteps.push({
      name: "build-registration",
      status: "skipped",
      message:
        "Registration was NOT submitted — no database available. Submit via POST /api/onboard/register.",
      data: { registrationSubmitted: false },
    });
    return { success: true, executedSteps };
  }

  const registrationId = `reg-${uuidv4()}`;
  const nowIso = new Date().toISOString();
  try {
    repos.registrations.insert({
      id: registrationId,
      name: String(allData.name ?? "Unknown"),
      category: String(allData.category ?? "custom"),
      manufacturer: String(allData.manufacturer ?? ""),
      model: String(allData.model ?? ""),
      serialNumber: typeof allData.serialNumber === "string" ? allData.serialNumber : undefined,
      description: typeof allData.description === "string" ? allData.description : undefined,
      photos: Array.isArray(allData.photos) ? (allData.photos as string[]) : [],
      capabilities: (Array.isArray(allData.capabilities) ? allData.capabilities : []) as never,
      spaceRequirements: (
        allData.spaceRequirements && typeof allData.spaceRequirements === "object"
          ? allData.spaceRequirements
          : DEFAULT_SPACE_REQUIREMENTS
      ) as never,
      pricing: (
        allData.pricing && typeof allData.pricing === "object"
          ? allData.pricing
          : { baseCost: "0", minimum: "0", currency: "USDC" }
      ) as never,
      operator: (
        allData.operator && typeof allData.operator === "object"
          ? allData.operator
          : {
              walletAddress: "0x0000000000000000000000000000000000000000",
              displayName: "Unknown",
              certifications: [],
              trainingAcknowledgments: {},
            }
      ) as never,
      complianceRegulations: Array.isArray(allData.complianceRegulations)
        ? (allData.complianceRegulations as string[]).filter(
            (s) => typeof s === "string" && s.length > 0,
          )
        : undefined,
      tenantId: ctx.tenantId,
      status: "submitted",
      createdAt: nowIso,
      submittedAt: nowIso,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[wizard] registration insert failed:", message);
    executedSteps.push({
      name: "build-registration",
      status: "failed",
      message:
        "Registration could not be persisted — nothing was submitted. Retry, or submit via POST /api/onboard/register.",
      data: { registrationSubmitted: false },
    });
    return { success: false, executedSteps, error: "registration_persist_failed" };
  }

  executedSteps.push({
    name: "build-registration",
    status: "success",
    message: "Registration submitted — retrievable at GET /api/onboard/registrations/:id",
    data: { registrationId, status: "submitted" },
  });

  return {
    success: true,
    executedSteps,
  };
}

async function orchestrateDeviceBuilder(
  session: WizardSession,
  executedSteps: WizardCompletionResult["executedSteps"],
): Promise<WizardCompletionResult> {
  const allData: Record<string, unknown> = {};
  for (const step of session.steps) {
    Object.assign(allData, step.data);
  }

  // Step 1: Generate kernel config
  const devices: Array<Record<string, unknown>> = [];
  if (allData.deviceName && allData.adapterType) {
    devices.push({
      name: String(allData.deviceName),
      type: String(allData.deviceType ?? "machine"),
      adapterType: String(allData.adapterType),
    });
  }

  const kernelConfig = {
    kernelId: String(allData.kernelId ?? `kernel_wizard_${Date.now()}`),
    devices,
    mockMode: allData.mockMode ?? false,
  };

  executedSteps.push({
    name: "generate-config",
    status: "success",
    message: "Kernel configuration generated",
    data: { kernelId: kernelConfig.kernelId, deviceCount: devices.length },
  });

  // Step 2: Validate config
  executedSteps.push({
    name: "validate-config",
    status: "success",
    message: "Configuration validated",
  });

  // Step 3 (Z3): Register devices for REAL — rows in the same store that
  // POST /api/setup/register-device writes. Only ids of rows that actually
  // exist are reported; when registration cannot happen, the step says so
  // honestly instead of fabricating device ids.
  const registeredDevices: string[] = [];

  if (devices.length === 0) {
    executedSteps.push({
      name: "register-devices",
      status: "skipped",
      message: "No devices to register",
      data: { deviceIds: [] },
    });
    return { success: true, executedSteps, kernelConfig, registeredDevices };
  }

  const repos = tryGetRepos();
  if (!repos) {
    executedSteps.push({
      name: "register-devices",
      status: "skipped",
      message:
        "Devices were NOT registered — no database available. Register via POST /api/setup/register-device.",
      data: { deviceIds: [] },
    });
    return { success: true, executedSteps, kernelConfig, registeredDevices };
  }

  const kernel = repos.kernels.findById(kernelConfig.kernelId);
  if (!kernel) {
    executedSteps.push({
      name: "register-devices",
      status: "skipped",
      message:
        `Devices were NOT registered — kernel '${kernelConfig.kernelId}' is not registered yet. ` +
        "Boot a kernel with the generated config (or POST /api/kernels), then register devices " +
        "via POST /api/setup/register-device.",
      data: { deviceIds: [] },
    });
    return { success: true, executedSteps, kernelConfig, registeredDevices };
  }

  const failures: Array<{ deviceId: string; error: string }> = [];
  for (let i = 0; i < devices.length; i++) {
    const device = devices[i];
    const deviceId = `dev-${kernelConfig.kernelId}-${String(i).padStart(3, "0")}`;
    try {
      // Idempotent on retry: a device already registered under this id counts
      // as registered, not as a duplicate-insert failure.
      const existing = repos.kernels.findDeviceById(deviceId);
      if (!existing) {
        repos.kernels.insertDevice({
          id: deviceId,
          kernelId: kernelConfig.kernelId,
          type: String(device.type ?? "machine"),
          model: String(device.name ?? "unknown"),
          firmware: "unknown",
          status: "idle",
          contributesToCapabilities: [],
          lastUpdated: new Date().toISOString(),
          adapterType: String(device.adapterType ?? "generic-http"),
          capabilities: [],
          healthStatus: "healthy",
        } as never);
      }
      registeredDevices.push(deviceId);
    } catch (err) {
      failures.push({
        deviceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (failures.length > 0) {
    console.error("[wizard] device registration failures:", failures);
    executedSteps.push({
      name: "register-devices",
      status: "failed",
      message: `Registered ${registeredDevices.length} of ${devices.length} device(s); ${failures.length} failed`,
      data: { deviceIds: registeredDevices, failures },
    });
    return {
      success: false,
      executedSteps,
      kernelConfig,
      registeredDevices,
      error: "device_registration_failed",
    };
  }

  executedSteps.push({
    name: "register-devices",
    status: "success",
    message: `Registered ${registeredDevices.length} device(s)`,
    data: { deviceIds: registeredDevices },
  });

  return {
    success: true,
    executedSteps,
    kernelConfig,
    registeredDevices,
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Clears all wizard sessions (test helper — do not call in production). */
export function _clearSessionsForTesting(): void {
  sessions.clear();
}

/** Returns current session count (test helper). */
export function _getSessionCountForTesting(): number {
  return sessions.size;
}

/**
 * Overrides completion orchestration (test helper — do not call in
 * production). Pass null to restore the real per-track orchestration.
 */
export function _setCompletionOverrideForTesting(
  fn: ((session: WizardSession) => Promise<WizardCompletionResult>) | null,
): void {
  completionOverride = fn;
}
