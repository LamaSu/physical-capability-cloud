import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DocumentAnalysisResult, MachineRegistration } from "@pcc/spec";
import { UnifiedKeychain } from "@pcc/agent-runtime";
import { auditService } from "../services/audit-service.js";
import { pipelineTelemetry } from "../telemetry.js";
import { trackServerEvent } from "../services/posthog-service.js";
import { Sentry } from "../sentry.js";
import { getRepos } from "../db.js";

const GATECRAFT_URL = process.env.GATECRAFT_URL ?? "https://gatecraft-production.up.railway.app";

export async function onboardRoutes(app: FastifyInstance) {
  // Upload document and return mock AI analysis
  app.post("/api/onboard/analyze", async (req) => {
    const result: DocumentAnalysisResult = {
      suggestedCapabilities: [
        {
          id: `sug-${Date.now()}`,
          type: "fdm",
          name: "Standard FDM Printing",
          description: "Layer-by-layer extrusion with 0.4mm nozzle",
          materials: ["PLA", "PETG", "ABS", "TPU"],
          tolerances: { linear: "±0.2mm", surface: "Ra 12.5" },
          envelope: { x: 250, y: 210, z: 210, unit: "mm" },
          suggestedParams: [],
          confidence: 0.92,
          sourceReason: "Extracted from manufacturer datasheet",
        },
      ],
      extractedSpecs: {
        "build-volume": "250 x 210 x 210 mm",
        "layer-height": "0.05 - 0.30 mm",
        "nozzle-temp-max": "300°C",
        "bed-temp-max": "120°C",
      },
      extractedMaterials: ["PLA", "PETG", "ABS", "TPU", "ASA", "PC"],
      extractedTolerances: [{ linear: "±0.2mm", surface: "Ra 12.5" }],
      confidence: 0.89,
      sourceDocumentId: "doc-uploaded",
    };
    return { status: "ok", analysis: result };
  });

  // Submit machine registration
  app.post("/api/onboard/register", async (req) => {
    const body = req.body as Partial<MachineRegistration>;
    const registration: MachineRegistration = {
      id: `reg-${Date.now()}`,
      name: body.name ?? "Unknown",
      category: body.category ?? "custom",
      manufacturer: body.manufacturer ?? "",
      model: body.model ?? "",
      serialNumber: body.serialNumber,
      description: body.description,
      photos: body.photos ?? [],
      documents: body.documents ?? [],
      capabilities: body.capabilities ?? [],
      spaceRequirements: body.spaceRequirements ?? {
        footprint: { width: 0, depth: 0, height: 0, unit: "mm" },
        clearances: { front: 0, back: 0, left: 0, right: 0, above: 0, unit: "mm" },
        weight: { value: 0, unit: "kg" },
        power: { voltage: 120, amperage: 15, phase: 1 },
        environmental: { ventilationRequired: false, dustExtraction: false, fumeExtraction: false },
        utilities: { compressedAir: false, water: false, coolant: false, wasteDrainage: false },
        vibrationIsolation: false,
      },
      pricing: body.pricing ?? { baseCost: "0", minimum: "0", currency: "USDC" },
      operator: body.operator ?? {
        walletAddress: "0x0000000000000000000000000000000000000000",
        displayName: "Unknown",
        certifications: [],
        trainingAcknowledgments: {},
      },
      // T2.3 — persist compliance regulations the operator claims to meet
      complianceRegulations: Array.isArray(body.complianceRegulations)
        ? body.complianceRegulations.filter((s) => typeof s === "string" && s.length > 0)
        : undefined,
      status: "submitted",
      createdAt: new Date().toISOString(),
      submittedAt: new Date().toISOString(),
    };
    try {
      const repos = getRepos();
      repos.registrations.insert({
        id: registration.id,
        name: registration.name,
        category: registration.category,
        manufacturer: registration.manufacturer,
        model: registration.model,
        serialNumber: registration.serialNumber,
        description: registration.description,
        photos: registration.photos,
        capabilities: registration.capabilities as any,
        spaceRequirements: registration.spaceRequirements as any,
        pricing: registration.pricing as any,
        operator: registration.operator as any,
        complianceRegulations: registration.complianceRegulations,
        status: registration.status,
        createdAt: registration.createdAt,
        submittedAt: registration.submittedAt,
      });
    } catch (e) { console.warn("[onboard] DB insert failed, continuing:", (e as Error).message); }
    pipelineTelemetry.emit(registration.id, "operator_register", "completed", { metadata: { name: registration.name, category: registration.category } });
    trackServerEvent("operator_registered", { name: registration.name, category: registration.category });
    auditService.log({
      eventType: "operator.registered",
      actor: (req as any).operatorId ?? (req as any).apiKeyId ?? registration.operator?.walletAddress,
      resourceType: "registration",
      resourceId: registration.id,
      action: "create",
      metadata: { name: registration.name, category: registration.category },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    return { status: "ok", registration };
  });

  // List registrations (persistent — survives deploys)
  app.get("/api/onboard/registrations", async (req) => {
    try {
      const repos = getRepos();
      // TODO(wave-4 / T1.9 follow-up): scope to req.tenantId once
      // registrations.tenant_id column lands. Today this is the public
      // operator directory so the cross-tenant read is intentional, but
      // the response is sanitised to the public-safe field set.
      void req; // tenantId attached by tenantContext middleware
      const registrations = repos.registrations.findAll();
      // Return only non-sensitive fields publicly (strip addresses, GPS, device details)
      const sanitized = registrations.map((r: any) => ({
        id: r.id,
        status: r.status,
        name: r.name,
        capability: r.capability,
        createdAt: r.createdAt,
      }));
      return { registrations: sanitized };
    } catch { return { registrations: [] }; }
  });

  // Get registration detail
  app.get<{ Params: { id: string } }>("/api/onboard/registrations/:id", async (req) => {
    try {
      const repos = getRepos();
      const reg = repos.registrations.findById(req.params.id);
      if (!reg) return { error: "not_found" };
      return { registration: reg };
    } catch { return { error: "not_found" }; }
  });

  // ── Approve a registration ──
  app.post<{ Params: { id: string } }>("/api/onboard/registrations/:id/approve", async (req, reply) => {
    const repos = getRepos();
    const reg = repos.registrations.findById(req.params.id);
    if (!reg) return reply.status(404).send({ error: "not_found" });
    if (reg.status !== "submitted" && reg.status !== "reviewing") {
      return reply.status(400).send({ error: "invalid_status", message: `Cannot approve registration in "${reg.status}" status` });
    }
    repos.registrations.updateStatus(req.params.id, "approved", { approvedAt: new Date().toISOString() });
    auditService.log({
      eventType: "operator.approved",
      actor: (req as any).operatorId ?? (req as any).apiKeyId,
      resourceType: "registration",
      resourceId: reg.id,
      action: "approve",
      metadata: { name: reg.name },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    return { registration: reg, approved: true };
  });

  // ── Reject a registration ──
  app.post<{ Params: { id: string } }>("/api/onboard/registrations/:id/reject", async (req, reply) => {
    const repos = getRepos();
    const reg = repos.registrations.findById(req.params.id);
    if (!reg) return reply.status(404).send({ error: "not_found" });
    if (reg.status === "rejected") {
      return reply.status(400).send({ error: "already_rejected" });
    }
    const body = req.body as { reason?: string } | undefined;
    const reason = body?.reason ?? "No reason provided";
    repos.registrations.updateStatus(req.params.id, "rejected", { description: `REJECTED: ${reason}` });
    auditService.log({
      eventType: "operator.rejected",
      actor: (req as any).operatorId ?? (req as any).apiKeyId,
      resourceType: "registration",
      resourceId: reg.id,
      action: "reject",
      metadata: { name: reg.name, reason: body?.reason },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    return { registration: reg, rejected: true };
  });

  // ── T2.2 — Edit registration (PATCH, owner-only) ──
  app.patch<{
    Params: { id: string };
    Body: {
      description?: string | null;
      photos?: string[];
      capabilities?: unknown[];
      spaceRequirements?: Record<string, unknown>;
      pricing?: { baseCost: string; minimum: string; currency: string; perMinute?: string; perGram?: string; perCm3?: string };
      complianceRegulations?: string[];
      status?: string; // explicitly rejected
    };
  }>("/api/onboard/registrations/:id", async (req, reply) => {
    const repos = getRepos();
    const reg = repos.registrations.findById(req.params.id);
    if (!reg) return reply.status(404).send({ error: "not_found" });

    // Caller must own the registration. Mirror the /prove ownership check.
    const callerId = (req as any).operatorId
      ?? (req as any).userId
      ?? (req as any).apiKeyId
      ?? (req as any).walletAddress;
    const regOperator = (reg as any).operator?.walletAddress
      ?? (reg as any).operator?.email
      ?? (reg as any).walletAddress
      ?? (reg as any).email
      ?? (reg as any).operatorId;
    if (callerId && regOperator && callerId !== regOperator) {
      return reply.status(403).send({ error: "forbidden", message: "You can only edit your own registration" });
    }
    if (reg.status === "deleted") {
      return reply.status(410).send({ error: "deleted", message: "Registration was soft-deleted" });
    }

    const body = req.body ?? {};
    if (body.status !== undefined) {
      return reply.status(400).send({
        error: "status_immutable",
        message: "Status changes go through /approve, /reject, /activate — not PATCH.",
      });
    }

    const patch: any = {};
    if (body.description !== undefined) patch.description = body.description;
    if (body.photos !== undefined && Array.isArray(body.photos)) patch.photos = body.photos;
    if (body.capabilities !== undefined && Array.isArray(body.capabilities)) {
      patch.capabilities = body.capabilities;
    }
    if (body.spaceRequirements !== undefined) patch.spaceRequirements = body.spaceRequirements;
    if (body.pricing !== undefined) patch.pricing = body.pricing;
    if (body.complianceRegulations !== undefined && Array.isArray(body.complianceRegulations)) {
      patch.complianceRegulations = body.complianceRegulations;
    }

    const updated = repos.registrations.update(req.params.id, patch);
    if (!updated) return reply.status(500).send({ error: "update_failed" });

    auditService.log({
      eventType: "operator.edited",
      actor: callerId ?? "anonymous",
      resourceType: "registration",
      resourceId: reg.id,
      action: "update",
      metadata: { fields: Object.keys(patch) },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    return { registration: updated };
  });

  // ── T2.2 — Delete (soft) registration (owner-only, GDPR-required) ──
  app.delete<{ Params: { id: string } }>("/api/onboard/registrations/:id", async (req, reply) => {
    const repos = getRepos();
    const reg = repos.registrations.findById(req.params.id);
    if (!reg) return reply.status(404).send({ error: "not_found" });

    const callerId = (req as any).operatorId
      ?? (req as any).userId
      ?? (req as any).apiKeyId
      ?? (req as any).walletAddress;
    const regOperator = (reg as any).operator?.walletAddress
      ?? (reg as any).operator?.email
      ?? (reg as any).walletAddress
      ?? (reg as any).email
      ?? (reg as any).operatorId;
    if (callerId && regOperator && callerId !== regOperator) {
      return reply.status(403).send({ error: "forbidden", message: "You can only delete your own registration" });
    }
    if (reg.status === "deleted") {
      return { registration: reg, alreadyDeleted: true };
    }

    const deletedAt = new Date().toISOString();
    repos.registrations.updateStatus(req.params.id, "deleted", {
      description: `DELETED at ${deletedAt} by ${callerId ?? "anonymous"} — original: ${reg.description ?? "(no description)"}`,
    });

    auditService.log({
      eventType: "operator.deleted",
      actor: callerId ?? "anonymous",
      resourceType: "registration",
      resourceId: reg.id,
      action: "delete",
      metadata: { soft: true, deletedAt },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    return { registration: { ...reg, status: "deleted" }, deletedAt, soft: true };
  });

  // ── Activate an approved registration ──
  app.post<{ Params: { id: string } }>("/api/onboard/registrations/:id/activate", async (req, reply) => {
    const repos = getRepos();
    const reg = repos.registrations.findById(req.params.id);
    if (!reg) return reply.status(404).send({ error: "not_found" });
    if (reg.status !== "approved") {
      return reply.status(400).send({ error: "invalid_status", message: `Must be approved before activating (current: "${reg.status}")` });
    }
    repos.registrations.updateStatus(req.params.id, "active");
    return { registration: { ...reg, status: "active" }, activated: true };
  });

  // ── Prove capability and auto-approve ──
  // Operator submits evidence of a test job (photo, sensor data, device health).
  // If evidence meets minimum requirements, registration is auto-approved + activated.
  // Fast-track: no manual review needed if the machine can prove it works.
  app.post<{ Params: { id: string } }>("/api/onboard/registrations/:id/prove", async (req, reply) => {
    return Sentry.startSpan(
      { name: "onboard.prove", op: "onboard", attributes: { "registration.id": req.params.id } },
      async () => {
        const repos = getRepos();
        const reg = repos.registrations.findById(req.params.id);
        if (!reg) return reply.status(404).send({ error: "not_found" });

        // Verify the caller owns this registration (prevents self-approval by other operators)
        const callerId = (req as any).operatorId ?? (req as any).userId;
        const regOperator = (reg as any).operator?.walletAddress
          ?? (reg as any).operator?.email
          ?? (reg as any).walletAddress
          ?? (reg as any).email
          ?? (reg as any).operatorId;
        if (callerId && regOperator && callerId !== regOperator) {
          return reply.status(403).send({ error: "forbidden", message: "You can only prove your own registration" });
        }

        if (reg.status === "active") {
          return reply.status(400).send({ error: "already_active", message: "Registration is already active" });
        }
        if (reg.status === "rejected") {
          return reply.status(400).send({ error: "rejected", message: "Registration was rejected — submit a new one" });
        }

        const body = req.body as {
          evidence?: {
            /** SHA-256 bundle hash of the evidence */
            bundleHash?: string;
            /** Evidence events from the test job */
            events?: Array<{
              type: string;
              timestamp: string;
              payload: Record<string, unknown>;
            }>;
            /** Base64-encoded photo of test output (e.g. printed page, machined part) */
            photoBase64?: string;
            /** Device health snapshot */
            deviceHealth?: {
              status: string;
              firmware?: string;
              model?: string;
              uptime?: number;
              [key: string]: unknown;
            };
            /** IPFS CID if evidence was already uploaded */
            ipfsCid?: string;
          };
        } | undefined;

        const evidence = body?.evidence;
        if (!evidence) {
          return reply.status(400).send({
            error: "evidence_required",
            message: "Submit evidence to prove your device works. Include at least one of: bundleHash + events, photoBase64, or deviceHealth.",
            example: {
              evidence: {
                bundleHash: "sha256:abc123...",
                events: [
                  { type: "execution_completed", timestamp: new Date().toISOString(), payload: { jobType: "test", pagesCount: 1 } },
                  { type: "camera_snapshot", timestamp: new Date().toISOString(), payload: { description: "Photo of printed test page" } },
                ],
                deviceHealth: { status: "idle", model: "HP OfficeJet Pro 9010", firmware: "2409A" },
              },
            },
          });
        }

        // ── Validate bundleHash format ────────────────────────────────────
        if (evidence.bundleHash !== undefined) {
          if (!evidence.bundleHash.startsWith("sha256:") || evidence.bundleHash.length < 40) {
            return reply.status(400).send({
              error: "invalid_bundle_hash",
              message: "bundleHash must start with 'sha256:' and be at least 40 characters (e.g. sha256:abc123...).",
            });
          }
        }

        // ── Validate event timestamps ─────────────────────────────────────
        if (evidence.events && evidence.events.length > 0) {
          const now = Date.now();
          const oneHourMs = 60 * 60 * 1000;
          for (const ev of evidence.events) {
            const ts = Date.parse(ev.timestamp);
            if (isNaN(ts)) {
              return reply.status(400).send({
                error: "invalid_event_timestamp",
                message: `Event of type "${ev.type}" has an invalid ISO timestamp: "${ev.timestamp}"`,
              });
            }
            if (ts > now + 5000) {
              return reply.status(400).send({
                error: "future_event_timestamp",
                message: `Event of type "${ev.type}" has a timestamp in the future: "${ev.timestamp}"`,
              });
            }
            if (now - ts > oneHourMs) {
              return reply.status(400).send({
                error: "stale_event_timestamp",
                message: `Event of type "${ev.type}" is older than 1 hour: "${ev.timestamp}". Submit fresh evidence.`,
              });
            }
          }
        }

        // Validate evidence — need at least one substantial proof
        const proofs: string[] = [];
        const warnings: string[] = [];

        // 1. Evidence bundle with events
        if (evidence.bundleHash && evidence.events && evidence.events.length > 0) {
          const hasCompletion = evidence.events.some((e) =>
            ["execution_completed", "camera_snapshot", "power_profile_summary"].includes(e.type),
          );
          if (hasCompletion) {
            proofs.push(`evidence_bundle: ${evidence.events.length} events, hash=${evidence.bundleHash.slice(0, 20)}...`);
          } else {
            warnings.push("Evidence events present but no completion/snapshot event found");
          }
        }

        // 2. Photo of test output
        if (evidence.photoBase64) {
          const sizeBytes = Math.ceil((evidence.photoBase64.length * 3) / 4);
          if (sizeBytes > 1024) {
            proofs.push(`photo: ${(sizeBytes / 1024).toFixed(0)}KB image`);
          } else {
            warnings.push("Photo too small to be meaningful (< 1KB)");
          }
        }

        // 3. Device health check
        if (evidence.deviceHealth) {
          if (evidence.deviceHealth.status && evidence.deviceHealth.model) {
            proofs.push(`device_health: ${evidence.deviceHealth.model} status=${evidence.deviceHealth.status}`);
          } else {
            warnings.push("Device health missing status or model");
          }
        }

        // 4. IPFS CID (evidence already uploaded to decentralized storage)
        if (evidence.ipfsCid) {
          proofs.push(`ipfs: ${evidence.ipfsCid}`);
        }

        if (proofs.length === 0) {
          return reply.status(422).send({
            error: "insufficient_evidence",
            message: "Evidence did not meet minimum requirements for auto-approval.",
            warnings,
            hint: "Provide a bundleHash with completion events, a photo of test output, or a device health snapshot with model and status.",
          });
        }

        // ── Determine assurance tier ────────────────────────────────────────
        const hasEvents = evidence.events && evidence.events.length > 0;
        const hasCompletion = hasEvents && evidence.events!.some((e) =>
          ["execution_completed", "camera_snapshot", "power_profile_summary"].includes(e.type),
        );
        const hasPhoto = !!(evidence.photoBase64 && Math.ceil((evidence.photoBase64.length * 3) / 4) > 1024);
        const hasDeviceHealth = !!(evidence.deviceHealth?.status && evidence.deviceHealth?.model);
        const hasBundleHash = !!(evidence.bundleHash);

        let assuranceTier: 0 | 1 | 2;
        let tierWarning: string | undefined;

        if (hasPhoto && hasDeviceHealth && hasEvents) {
          // Tier 2: photo + device health + events
          assuranceTier = 2;
        } else if (hasBundleHash && hasEvents && hasCompletion) {
          // Tier 1: bundle hash + events with completion event
          assuranceTier = 1;
        } else {
          // Tier 0: self-attested only (deviceHealth only, no events or photo)
          assuranceTier = 0;
          tierWarning = "Self-attested only — no independent verification";
        }

        // Evidence passes — auto-approve and activate (PERSISTENT — survives deploys)
        const now = new Date().toISOString();
        const proveMetadata = JSON.stringify({ provedAt: now, autoApproved: true, proofs, evidenceBundleHash: evidence.bundleHash ?? null, evidenceIpfsCid: evidence.ipfsCid ?? null, assuranceTier });
        repos.registrations.updateStatus(req.params.id, "active", { approvedAt: now, description: `PROVED: ${proveMetadata}` });

        pipelineTelemetry.emit(reg.id, "operator_verify", "completed", { metadata: { proofCount: proofs.length, autoApproved: true, assuranceTier } });
        trackServerEvent("operator_proved", { proofCount: proofs.length, assuranceTier });
        auditService.log({
          eventType: "operator.proved",
          actor: (req as any).operatorId ?? (req as any).apiKeyId ?? reg.operator?.walletAddress,
          resourceType: "registration",
          resourceId: reg.id,
          action: "prove",
          metadata: { proofCount: proofs.length, assuranceTier, autoApproved: true, proofs },
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        });
        return {
          registration: { ...reg, status: "active", approvedAt: now },
          autoApproved: true,
          activated: true,
          proofs,
          assuranceTier,
          warning: tierWarning,
          warnings: warnings.length > 0 ? warnings : undefined,
          message: "Evidence accepted — registration auto-approved and activated. Your device is now live on the network.",
        };
      },
    );
  });

  // ═══════════════════════════════════════════════════════════════
  // Agent Onboarding — one invite code provisions everything
  // Uses Gatecraft as identity/wallet/credential layer
  // ═══════════════════════════════════════════════════════════════

  /**
   * POST /api/onboard/redeem — One-click agent onboarding
   *
   * 1. Redeems Gatecraft invite code → account + wallet + shared keys
   * 2. Returns unified config: PCC tools + LLM proxy + wallet + identity
   *
   * Result: agent has wallet, identity, LLM access, and PCC tools.
   * No manual key management, no provider selection, no wallet setup.
   */
  app.post("/api/onboard/redeem", async (req, reply) => {
    const body = req.body as {
      inviteCode: string;
      email: string;
      password: string;
      name?: string;
    };

    if (!body.inviteCode || !body.email || !body.password) {
      return reply.status(400).send({
        error: "inviteCode, email, and password are required",
      });
    }

    try {
      const gcRes = await fetch(`${GATECRAFT_URL}/v1/hackathon/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!gcRes.ok) {
        const err = await gcRes.json().catch(() => ({ error: "Identity service error" }));
        return reply.status(gcRes.status).send(err);
      }

      const gc = await gcRes.json() as {
        token: string;
        userId: string;
        walletBalance: number;
        providers: string[];
        message: string;
      };

      const baseUrl = `${req.protocol}://${req.hostname}`;

      // Generate unified keychain — one mnemonic derives all chain keys
      const kc = new UnifiedKeychain();
      const keys = kc.generate();

      return reply.send({
        success: true,
        message: "Your agent is provisioned. Everything is ready.",

        // Identity
        token: gc.token,
        user_id: gc.userId,

        // Wallet (microdollars)
        wallet_balance_usd: gc.walletBalance / 1_000_000,

        // Unified keys (generated client-side in production — here for demo)
        keys: {
          mnemonic: keys.mnemonic, // SENSITIVE — user must back this up
          evm: {
            address: keys.evm.address,
            // privateKey NOT exposed in API — only mnemonic
          },
          solana: {
            publicKey: keys.solana.publicKey,
          },
          did: keys.did,
          bittensor: {
            publicKeyHex: keys.bittensor.publicKeyHex,
          },
        },
        warning:
          "Back up your mnemonic. It derives all your keys. PCC never stores it.",

        // Agent configuration — feed this entire object to your agent
        agent_config: {
          pcc_tools: `${baseUrl}/agent-package.json`,
          pcc_api: `${baseUrl}/api`,
          llm_proxy: `${GATECRAFT_URL}/api/v2/proxy/call`,
          llm_auth: `Bearer ${gc.token}`,
          providers: gc.providers,
          unbrowse_skills: `${baseUrl}/unbrowse-skills.json`,
          unbrowse_api: `${baseUrl}/api/unbrowse`,
          wallet: `${GATECRAFT_URL}/api/v2/proxy/wallet`,
        },

        // Fiat on-ramp — fund agent wallet with credit card
        funding: {
          message: "Fund your agent wallet with a credit card or bank transfer",
          stripe: {
            endpoint: `${baseUrl}/api/fiat-ramp/onramp/session`,
            method: "POST",
            body: { walletAddress: keys.evm.address, amount: 50, currency: "USD" },
            description: "Visa/Mastercard/AMEX → USDC on Base",
          },
          yellowcard: {
            endpoint: `${baseUrl}/api/fiat-ramp/onramp/yellowcard`,
            method: "POST",
            description: "Mobile money in 34 emerging market countries → USDC",
          },
          wise: {
            endpoint: `${baseUrl}/api/fiat-ramp/payout`,
            method: "POST",
            description: "Enterprise bank payouts in 40+ currencies",
          },
        },
      });
    } catch (err) {
      app.log.error(err, "Onboard redeem failed");
      return reply.status(502).send({ error: "Identity service unreachable" });
    }
  });

  /** GET /api/onboard/check/:code — Validate invite code before redeeming */
  app.get<{ Params: { code: string } }>("/api/onboard/check/:code", async (req, reply) => {
    try {
      const res = await fetch(`${GATECRAFT_URL}/v1/hackathon/invite/${req.params.code}`);
      if (!res.ok) return reply.status(404).send({ valid: false });
      const data = await res.json();
      return reply.send({
        valid: true,
        event: data,
        includes: [
          "Wallet with credits for LLM calls",
          "Access to Claude, GPT-4o, Groq — no API keys needed",
          "73 PCC tools for physical capability discovery and orchestration",
          "Agent identity with trust scoring",
        ],
      });
    } catch {
      return reply.status(502).send({ valid: false, error: "Service unreachable" });
    }
  });

  /** GET /api/onboard/status — Check what the agent has provisioned */
  app.get("/api/onboard/status", async (req, reply) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Bearer token required (from /api/onboard/redeem)" });
    }

    try {
      const [meRes, walletRes, credsRes] = await Promise.all([
        fetch(`${GATECRAFT_URL}/v1/auth/me`, { headers: { Authorization: auth } }),
        fetch(`${GATECRAFT_URL}/api/v2/proxy/wallet`, { headers: { Authorization: auth } }),
        fetch(`${GATECRAFT_URL}/api/v2/proxy/credentials`, { headers: { Authorization: auth } }),
      ]);

      return reply.send({
        user: meRes.ok ? await meRes.json() : null,
        wallet: walletRes.ok ? await walletRes.json() : null,
        credentials: credsRes.ok ? await credsRes.json() : null,
        pcc_tools: `${req.protocol}://${req.hostname}/agent-package.json`,
        ready: meRes.ok,
      });
    } catch {
      return reply.status(502).send({ error: "Identity service unreachable" });
    }
  });
}
