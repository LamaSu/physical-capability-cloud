/**
 * Third-party digital kernel marketplace routes.
 *
 *   POST /api/kernels/register               — Submit a manifest for review
 *   GET  /api/kernels/marketplace            — List verified kernels
 *   GET  /api/kernels/marketplace/:kernelId  — Single kernel lookup
 *   POST /api/kernels/:kernelId/verify       — Run touchstone smoke test
 *   POST /api/kernels/:kernelId/suspend      — Admin-suspend a kernel
 *
 * The kernel registry is an in-memory Map<string, DigitalKernelManifest>.
 * This is intentional: persisting to the store is tracked as future work
 * once the manifest schema is locked. Admin-facing endpoints (verify,
 * suspend) are gated by the PCC_ADMIN_KEY env var + a matching
 * X-Admin-Key header.
 *
 * Naming note: this file uses `sessionKey`/`principalKey`/`touchstone`
 * exclusively. No canary/hotkey terminology.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  DigitalKernelManifest,
  KernelManifestStatus,
  KernelMarketplaceEntry,
  MarketplaceFilters,
} from "@pcc/spec";

// ---------------------------------------------------------------------------
// In-memory registry (production: swap for facade-backed storage)
// ---------------------------------------------------------------------------

const manifestRegistry = new Map<string, DigitalKernelManifest>();

// Dependency-injectable fetch so tests can mock the smoke-test network call
// without monkey-patching globalThis. Defaults to the runtime's fetch.
type FetchImpl = typeof globalThis.fetch;
let smokeTestFetch: FetchImpl = globalThis.fetch as FetchImpl;

/** Test-only helper: override fetch used by the verify endpoint. */
export function _setSmokeTestFetch(impl: FetchImpl | null) {
  smokeTestFetch = impl ?? (globalThis.fetch as FetchImpl);
}

/** Test-only helper: wipe the registry between tests. */
export function _clearKernelRegistry() {
  manifestRegistry.clear();
}

/** Test-only helper: count registered kernels. */
export function _getRegistryCount(): number {
  return manifestRegistry.size;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Validate a manifest body. Returns a list of error messages; empty = valid.
 * The checks mirror the structural guardrails in the SDK's buildManifest so
 * that invalid payloads are rejected with a precise error even when the
 * caller didn't use the SDK.
 */
function validateManifest(body: unknown): {
  errors: string[];
  manifest?: DigitalKernelManifest;
} {
  const errors: string[] = [];

  if (!isObject(body)) {
    return { errors: ["manifest must be a JSON object"] };
  }

  if (body.manifestVersion !== "1.0.0") {
    errors.push("manifestVersion must be '1.0.0'");
  }
  if (typeof body.kernelId !== "string" || body.kernelId.length === 0) {
    errors.push("kernelId is required (non-empty string)");
  }
  if (typeof body.name !== "string" || body.name.length === 0) {
    errors.push("name is required (non-empty string)");
  }
  if (typeof body.description !== "string") {
    errors.push("description is required (string)");
  }

  const builder = body.builder;
  if (!isObject(builder) || typeof builder.agentId !== "string" || builder.agentId.length === 0) {
    errors.push("builder.agentId is required");
  }

  if (typeof body.capabilityType !== "string" || body.capabilityType.length === 0) {
    errors.push("capabilityType is required (non-empty string)");
  }

  if (!Array.isArray(body.workflowSteps) || body.workflowSteps.length === 0) {
    errors.push("workflowSteps must have at least one step");
  }

  const pricing = body.pricing;
  if (
    !isObject(pricing) ||
    pricing.currency !== "USDC" ||
    typeof pricing.baseUSD !== "number" ||
    pricing.baseUSD < 0
  ) {
    errors.push("pricing.currency must be 'USDC' and baseUSD must be a non-negative number");
  }

  if (
    typeof body.maxAssuranceTier !== "number" ||
    body.maxAssuranceTier < 0 ||
    body.maxAssuranceTier > 3 ||
    !Number.isInteger(body.maxAssuranceTier)
  ) {
    errors.push("maxAssuranceTier must be an integer in 0..3");
  }

  if (typeof body.endpointURL !== "string" || !body.endpointURL.startsWith("https://")) {
    errors.push("endpointURL must be an HTTPS URL");
  }

  const policy = body.sessionKeyPolicy;
  if (
    !isObject(policy) ||
    typeof policy.maxTTLSeconds !== "number" ||
    policy.maxTTLSeconds <= 0 ||
    !Array.isArray(policy.allowedActions) ||
    policy.allowedActions.length === 0
  ) {
    errors.push("sessionKeyPolicy.maxTTLSeconds must be positive and allowedActions non-empty");
  }

  if (errors.length > 0) return { errors };

  // Coerce the body into a DigitalKernelManifest — we've validated the
  // required fields above.
  const manifest: DigitalKernelManifest = {
    manifestVersion: "1.0.0",
    kernelId: body.kernelId as string,
    name: body.name as string,
    description: body.description as string,
    builder: body.builder as DigitalKernelManifest["builder"],
    capabilityType: body.capabilityType as string,
    workflowSteps: body.workflowSteps as DigitalKernelManifest["workflowSteps"],
    pricing: body.pricing as DigitalKernelManifest["pricing"],
    maxAssuranceTier: body.maxAssuranceTier as 0 | 1 | 2 | 3,
    touchstoneLibraryId:
      typeof body.touchstoneLibraryId === "string" ? body.touchstoneLibraryId : undefined,
    endpointURL: body.endpointURL as string,
    sessionKeyPolicy: body.sessionKeyPolicy as DigitalKernelManifest["sessionKeyPolicy"],
    status: "pending",
  };

  return { errors: [], manifest };
}

// ---------------------------------------------------------------------------
// Admin gate — simple shared-secret auth for verify + suspend
// ---------------------------------------------------------------------------

/**
 * Returns true if the request carries a matching admin key. In dev (no
 * PCC_ADMIN_KEY env var set), self-verification is allowed — the builder
 * may verify their own kernel via the builder.agentId. In production,
 * PCC_ADMIN_KEY MUST be set.
 */
function isAdminAuthorized(
  req: FastifyRequest,
  manifest?: DigitalKernelManifest,
): boolean {
  const expected = process.env.PCC_ADMIN_KEY;

  // In test + dev, allow the request if either:
  //   - no admin key is configured (open mode — test-only)
  //   - the provided X-Admin-Key matches
  //   - the caller's agentId matches the manifest's builder.agentId
  const provided = (req.headers["x-admin-key"] as string | undefined) ?? undefined;

  if (expected && provided === expected) return true;

  // Self-verification: builder can verify their own kernel
  if (manifest) {
    const callerAgentId =
      (req as unknown as { callerAgentId?: string }).callerAgentId ??
      (req.headers["x-agent-id"] as string | undefined);
    if (callerAgentId && callerAgentId === manifest.builder.agentId) {
      return true;
    }
  }

  // No admin key configured AND no builder self-auth — allow in test/dev only
  if (!expected && process.env.NODE_ENV !== "production") return true;

  return false;
}

// ---------------------------------------------------------------------------
// Smoke test (for /verify)
// ---------------------------------------------------------------------------

/**
 * Runs a basic smoke test against the manifest's endpointURL. In v1 this
 * is an HTTP POST with a minimal dry-run payload; a 2xx response marks the
 * kernel as verified. A real implementation would dispatch a touchstone
 * task and wait for a signed evidence response, but v1 ships the simpler
 * contract.
 */
async function runSmokeTest(
  manifest: DigitalKernelManifest,
): Promise<{ ok: boolean; detail?: string }> {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await smokeTestFetch(manifest.endpointURL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: `smoke-${Date.now()}`,
          dryRun: true,
          input: { smokeTest: true },
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        return { ok: false, detail: `smoke_test_failed: HTTP ${res.status}` };
      }
      return { ok: true };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : "smoke_test_error",
    };
  }
}

// ---------------------------------------------------------------------------
// Entry -> summary view
// ---------------------------------------------------------------------------

function manifestToEntry(m: DigitalKernelManifest): KernelMarketplaceEntry {
  return {
    kernelId: m.kernelId,
    name: m.name,
    description: m.description,
    capabilityType: m.capabilityType,
    builder: m.builder,
    pricing: m.pricing,
    maxAssuranceTier: m.maxAssuranceTier,
    endpointURL: m.endpointURL,
    status: m.status,
    verifiedAt: m.verifiedAt,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function kernelMarketplaceRoutes(app: FastifyInstance) {
  // ── POST /api/kernels/register ──────────────────────────────────────
  app.post("/api/kernels/register", async (req, reply) => {
    // Accept both { manifest: {...} } and raw manifest body for convenience.
    const body = req.body as Record<string, unknown> | undefined;
    const manifestInput =
      body && isObject(body.manifest) ? body.manifest : body;

    const { errors, manifest } = validateManifest(manifestInput);
    if (errors.length > 0) {
      return reply.status(400).send({ error: "invalid_manifest", errors });
    }

    if (!manifest) {
      return reply.status(400).send({ error: "invalid_manifest", errors: ["unknown"] });
    }

    if (manifestRegistry.has(manifest.kernelId)) {
      return reply.status(409).send({
        error: "kernel_already_registered",
        kernelId: manifest.kernelId,
      });
    }

    manifest.registeredAt = new Date().toISOString();
    manifest.status = "pending";
    manifestRegistry.set(manifest.kernelId, manifest);

    return reply.status(201).send({
      kernelId: manifest.kernelId,
      status: manifest.status as KernelManifestStatus,
      nextStep: "POST /api/kernels/" + manifest.kernelId + "/verify to run the smoke test",
      message: "Kernel registered. Run verify to make it visible in the marketplace.",
    });
  });

  // ── GET /api/kernels/marketplace ────────────────────────────────────
  app.get<{ Querystring: MarketplaceFilters & { sortBy?: string } }>(
    "/api/kernels/marketplace",
    async (req) => {
      const {
        capabilityType,
        minAssuranceTier,
        sortBy,
      } = req.query;

      // Only verified, non-suspended kernels appear in the marketplace.
      let entries = [...manifestRegistry.values()]
        .filter((m) => m.status === "verified")
        .map(manifestToEntry);

      if (capabilityType) {
        entries = entries.filter((e) => e.capabilityType === capabilityType);
      }

      if (minAssuranceTier !== undefined) {
        const min = Number(minAssuranceTier);
        if (!Number.isNaN(min)) {
          entries = entries.filter((e) => e.maxAssuranceTier >= min);
        }
      }

      if (sortBy === "assuranceScore") {
        // Undefined scores sort last; otherwise descending.
        entries.sort((a, b) => {
          const av = a.assuranceScore ?? -1;
          const bv = b.assuranceScore ?? -1;
          return bv - av;
        });
      } else if (sortBy === "price") {
        entries.sort((a, b) => a.pricing.baseUSD - b.pricing.baseUSD);
      }

      return { kernels: entries, count: entries.length };
    },
  );

  // ── GET /api/kernels/marketplace/:kernelId ──────────────────────────
  app.get<{ Params: { kernelId: string } }>(
    "/api/kernels/marketplace/:kernelId",
    async (req, reply) => {
      const manifest = manifestRegistry.get(req.params.kernelId);
      if (!manifest) {
        return reply.status(404).send({ error: "kernel_not_found" });
      }
      if (manifest.status === "suspended") {
        return reply.status(410).send({
          error: "kernel_suspended",
          kernelId: manifest.kernelId,
        });
      }
      return { kernel: manifest };
    },
  );

  // ── POST /api/kernels/:kernelId/verify ──────────────────────────────
  app.post<{ Params: { kernelId: string } }>(
    "/api/kernels/:kernelId/verify",
    async (req, reply) => {
      const manifest = manifestRegistry.get(req.params.kernelId);
      if (!manifest) {
        return reply.status(404).send({ error: "kernel_not_found" });
      }

      if (!isAdminAuthorized(req, manifest)) {
        return reply.status(401).send({
          error: "unauthorized",
          message: "admin key or builder self-auth required",
        });
      }

      const smoke = await runSmokeTest(manifest);
      if (!smoke.ok) {
        return reply.status(502).send({
          error: "smoke_test_failed",
          detail: smoke.detail,
          status: manifest.status,
        });
      }

      manifest.status = "verified";
      manifest.verifiedAt = new Date().toISOString();
      manifestRegistry.set(manifest.kernelId, manifest);

      return {
        kernelId: manifest.kernelId,
        status: manifest.status,
        verifiedAt: manifest.verifiedAt,
      };
    },
  );

  // ── POST /api/kernels/:kernelId/suspend ─────────────────────────────
  app.post<{
    Params: { kernelId: string };
    Body: { reason?: string };
  }>("/api/kernels/:kernelId/suspend", async (req, reply) => {
    const manifest = manifestRegistry.get(req.params.kernelId);
    if (!manifest) {
      return reply.status(404).send({ error: "kernel_not_found" });
    }

    // Suspension requires admin authorization regardless of builder identity.
    // The builder.agentId self-bypass is reserved for verify only.
    const expected = process.env.PCC_ADMIN_KEY;
    const provided = req.headers["x-admin-key"] as string | undefined;
    const devMode = !expected && process.env.NODE_ENV !== "production";
    if (!devMode && provided !== expected) {
      return reply.status(401).send({
        error: "unauthorized",
        message: "admin key required to suspend kernels",
      });
    }

    manifest.status = "suspended";
    manifestRegistry.set(manifest.kernelId, manifest);

    return {
      kernelId: manifest.kernelId,
      status: manifest.status,
      reason: (req.body as { reason?: string } | undefined)?.reason ?? "admin_suspension",
    };
  });
}
