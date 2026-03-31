/**
 * Paid Job Flow — end-to-end wiring from DHT discovery through settlement.
 *
 * This module connects the existing pieces:
 *   DHT discovery -> negotiation -> escrow -> scope -> execution -> evidence -> settlement
 *
 * Endpoints:
 *   POST /api/jobs/submit-from-discovery  — Fast-track: discovery straight to job+scope
 *   PUT  /api/jobs/:jobId/complete        — Job completion -> evidence -> settlement
 *   GET  /api/jobs/:jobId/settlement      — Settlement status for a job
 *
 * For testnet/demo: mock escrow (no real on-chain funding required).
 * Set MOCK_SETTLEMENT=false to require real escrow interactions.
 */

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getStore, getRepos } from "../db.js";
import { schema, eq } from "@pcc/store";
import { getTemplate } from "@pcc/contract-builder";
import { TemplateResolver } from "@pcc/contract-builder";
import { PricingCalculator } from "@pcc/contract-builder";
import { applyPricingRules, sanitizeText } from "@pcc/kernel";
import { pipelineTelemetry } from "../telemetry.js";
import { getSettlementService } from "../services/settlement-service.js";
import { verifyWithOracle } from "../services/oracle-client.js";
import type {
  OperatorPolicy,
  NegotiationSession,
  SessionStatus,
  SessionTransition,
} from "@pcc/spec";
import { DEFAULT_OPERATOR_POLICY, SESSION_TTL_MS } from "@pcc/spec";

const { negotiationSessions, operatorPolicies, executionScopes, toolCallRelay } = schema;

const resolver = new TemplateResolver();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Whether mock settlement is active (default: true for testnet) */
function isMockSettlement(): boolean {
  return process.env.MOCK_SETTLEMENT !== "false";
}

/** Default write tools for common device types */
const DEVICE_WRITE_TOOLS: Record<string, string[]> = {
  "liquid-handler": [
    "ot2_run_protocol",
    "ot2_aspirate",
    "ot2_dispense",
    "ot2_pick_up_tip",
    "ot2_drop_tip",
    "ot2_move_to",
    "ot2_mix",
    "ot2_blow_out",
    "ot2_touch_tip",
    "ot2_transfer",
  ],
  "fdm-printer": [
    "printer_start_job",
    "printer_pause",
    "printer_resume",
    "printer_cancel",
    "printer_set_temperature",
  ],
  "cnc-mill": [
    "cnc_start_program",
    "cnc_pause",
    "cnc_resume",
    "cnc_cancel",
    "cnc_set_speed",
  ],
};

/** Get write tools for a device type, falling back to a generic set */
function getWriteToolsForDeviceType(capabilityType: string): string[] {
  return DEVICE_WRITE_TOOLS[capabilityType] ?? [
    "device_start_job",
    "device_pause",
    "device_resume",
    "device_cancel",
  ];
}

/**
 * Create escrow + job + scope from a committed negotiation session.
 * This is the core wiring logic shared by the commit handler and the fast-track endpoint.
 */
export async function createJobFromSession(
  session: typeof negotiationSessions.$inferSelect,
): Promise<{
  jobId: string;
  scopeId: string;
  escrowId: string;
  escrowAddress: string;
  escrowStatus: string;
}> {
  const repos = getRepos();
  const { db } = getStore();
  const now = new Date().toISOString();

  const quote = session.quote as Record<string, unknown> | null;
  const contractTerms = session.contractTerms as Record<string, unknown> | null;
  const milestones = (contractTerms?.milestones ?? []) as Array<{
    stepId: string;
    amount: string;
    bondAmount: string;
    challengeWindowSeconds: number;
  }>;

  // ── 1. Create or reference escrow ──────────────────────────────────
  const escrowId = `esc-${crypto.randomUUID().slice(0, 12)}`;
  const escrowAddress = isMockSettlement()
    ? `mock-escrow-${Date.now().toString(36)}`
    : (contractTerms?.token as string) ?? "0x0000000000000000000000000000000000000000";

  const totalPrice = quote?.totalPrice as string ?? "10.00";
  const currency = quote?.currency as string ?? "USDC";
  const deadline = (contractTerms?.deadline as string) ?? new Date(Date.now() + 24 * 60 * 60_000).toISOString();

  repos.escrows.insert({
    id: escrowId,
    cwmId: session.cwmId ?? `cwm-${crypto.randomUUID().slice(0, 12)}`,
    contractAddress: escrowAddress,
    payer: session.userAgentId,
    totalAmount: totalPrice,
    currency,
    status: isMockSettlement() ? "funded" : "created",
    createdAt: now,
    deadline,
  });

  // Insert milestones
  for (const ms of milestones) {
    repos.escrows.insertMilestone({
      id: `ms-${crypto.randomUUID().slice(0, 12)}`,
      escrowId,
      stepId: ms.stepId,
      amount: ms.amount,
      status: isMockSettlement() ? "funded" : "pending",
      bondAmount: ms.bondAmount,
    });
  }

  // If no milestones were defined in contract terms, create a default one
  if (milestones.length === 0) {
    repos.escrows.insertMilestone({
      id: `ms-${crypto.randomUUID().slice(0, 12)}`,
      escrowId,
      stepId: `step-${crypto.randomUUID().slice(0, 8)}`,
      amount: totalPrice,
      status: isMockSettlement() ? "funded" : "pending",
      bondAmount: quote?.bondAmount as string ?? "0.00",
    });
  }

  // ── 2. Create the job ──────────────────────────────────────────────
  const jobId = session.jobId ?? `job-${crypto.randomUUID().slice(0, 12)}`;

  // Resolve capability ID for this kernel + type
  const caps = repos.capabilities.findByKernel(session.kernelId);
  const matchingCap = caps.find((c) => c.type === session.capabilityType) ?? caps[0];
  const capabilityId = matchingCap?.id ?? "cap-default";

  const stepId = milestones[0]?.stepId ?? `step-${crypto.randomUUID().slice(0, 8)}`;

  repos.jobs.insert({
    id: jobId,
    stepId,
    cwmId: session.cwmId ?? `cwm-${crypto.randomUUID().slice(0, 12)}`,
    capabilityId,
    kernelId: session.kernelId,
    status: isMockSettlement() ? "active" : "pending",
    assignedDevices: [],
    startedAt: isMockSettlement() ? now : undefined,
    progress: 0,
  });

  // ── 3. Create execution scope ──────────────────────────────────────
  const scopeId = `scope_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const allowedTools = getWriteToolsForDeviceType(session.capabilityType);
  const expiry = new Date(Date.now() + 60 * 60_000).toISOString(); // 1 hour

  db.insert(executionScopes).values({
    id: scopeId,
    kernelId: session.kernelId,
    jobId,
    createdBy: session.userAgentId,
    status: "active",
    allowedTools,
    maxCommands: 200,
    commandCount: 0,
    maxRetries: 5,
    retryCount: 0,
    createdAt: now,
    expiresAt: expiry,
  }).run();

  // ── 4. Update session with jobId, escrowAddress, scopeId ───────────
  db.update(negotiationSessions)
    .set({
      jobId,
      escrowAddress,
    })
    .where(eq(negotiationSessions.id, session.id))
    .run();

  pipelineTelemetry.emit(jobId, "job_submit", "completed", {
    metadata: {
      sessionId: session.id,
      escrowId,
      scopeId,
      kernelId: session.kernelId,
      capabilityType: session.capabilityType,
      mockSettlement: isMockSettlement(),
    },
  });

  return {
    jobId,
    scopeId,
    escrowId,
    escrowAddress,
    escrowStatus: isMockSettlement() ? "funded" : "created",
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function paidJobFlowRoutes(app: FastifyInstance) {
  // ═════════════════════════════════════════════════════════════════════
  // POST /api/jobs/submit-from-discovery — Fast-track from discovery to job
  // ═════════════════════════════════════════════════════════════════════

  app.post<{
    Body: {
      kernelId: string;
      capabilityType: string;
      parameters?: Record<string, unknown>;
      paymentMethod?: "escrow" | "testnet-mock";
      userAgentId: string;
    };
  }>("/api/jobs/submit-from-discovery", async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body) {
      return reply.status(400).send({ error: "Request body is required" });
    }

    const { kernelId, capabilityType, parameters, paymentMethod, userAgentId } = body as any;

    if (!kernelId || !capabilityType || !userAgentId) {
      return reply.status(400).send({
        error: "kernelId, capabilityType, and userAgentId are required",
      });
    }

    try {
      const { db } = getStore();
      const now = new Date();

      // Load operator policy
      const policyRow = db.select().from(operatorPolicies)
        .where(eq(operatorPolicies.kernelId, kernelId))
        .get();
      const policy = (policyRow?.policy ?? DEFAULT_OPERATOR_POLICY) as unknown as OperatorPolicy;

      if (policy.emergencyStop) {
        return reply.status(503).send({ error: "Operator has activated emergency stop" });
      }

      // ── Create fast-track session ───────────────────────────────────
      const sessionId = `sess-${crypto.randomUUID()}`;
      const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();

      const constraints = {
        allowedMaterials: policy.allowedMaterials,
        maxDurationMs: policy.maxDurationMs,
        operatingHours: policy.operatingHours,
        timezone: policy.timezone,
        requireEscrow: policy.requireEscrow,
        maxTemperatureCelsius: policy.maxTemperatureCelsius,
      };

      const selections = parameters ?? {};
      const sanitizedSelections: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(selections)) {
        sanitizedSelections[key] = typeof value === "string" ? sanitizeText(value) : value;
      }

      // Auto-compute quote
      const template = getTemplate(capabilityType);
      const basePrice = template?.basePricingHints?.basePrice
        ? parseFloat(template.basePricingHints.basePrice)
        : 10;
      const quantity = (sanitizedSelections.quantity as number) ?? 1;
      const { adjustedPrice, adjustments } = applyPricingRules(
        basePrice * quantity,
        policy.pricingRules.filter((r) => r.enabled),
      );

      const quote = {
        basePrice: basePrice.toFixed(2),
        adjustments: adjustments.map((a) => ({
          ruleId: a.ruleId,
          label: a.label,
          impact: a.amount.toFixed(2),
        })),
        totalPrice: adjustedPrice.toFixed(2),
        currency: template?.basePricingHints?.currency ?? "USDC",
        bondAmount: "0.00",
        challengeWindowSeconds: 0,
        validUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
      };

      const stepId = `step-${crypto.randomUUID().slice(0, 8)}`;

      const contractTerms = {
        milestones: [{
          stepId,
          amount: quote.totalPrice,
          bondAmount: quote.bondAmount,
          challengeWindowSeconds: quote.challengeWindowSeconds,
        }],
        deadline: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        assuranceTier: 0,
        payer: "0x0000000000000000000000000000000000000000",
        operator: "0x0000000000000000000000000000000000000000",
        token: "0x6c7ce5d5decee9983feaa3e637ea3fe3e6945cdb",
      };

      const jobId = `job-${crypto.randomUUID().slice(0, 12)}`;
      const cwmId = `cwm-${crypto.randomUUID().slice(0, 12)}`;

      const transitions: SessionTransition[] = [
        { from: "created", to: "created", timestamp: now.toISOString(), actor: userAgentId, reason: "Fast-track session created" },
        { from: "created", to: "configuring", timestamp: now.toISOString(), actor: userAgentId, reason: "Parameters auto-configured" },
        { from: "configuring", to: "quoted", timestamp: now.toISOString(), actor: "system", reason: `Quote computed: ${quote.totalPrice} ${quote.currency}` },
        { from: "quoted", to: "reviewing", timestamp: now.toISOString(), actor: "system", reason: "Contract terms auto-generated" },
        { from: "reviewing", to: "committed", timestamp: now.toISOString(), actor: userAgentId, reason: `Fast-track committed with job ${jobId}` },
      ];

      const session = {
        id: sessionId,
        status: "committed" as SessionStatus,
        userAgentId,
        kernelId,
        capabilityType,
        capabilityId: null,
        network: null,
        selections: sanitizedSelections,
        operatorConstraints: constraints,
        scheduling: {
          earliestAvailable: new Date(Date.now() + 60_000).toISOString(),
          estimatedDuration: "PT30M",
          queuePosition: 0,
          estimatedWaitMs: 60_000,
        },
        quote,
        contractTerms,
        jobId,
        escrowAddress: null as string | null,
        cwmId,
        transitions,
        createdAt: now.toISOString(),
        expiresAt,
        committedAt: now.toISOString(),
      };

      db.insert(negotiationSessions).values(session as any).run();

      // ── Wire: create escrow + job + scope ───────────────────────────
      // Reload from DB to get proper typed row
      const sessionRow = db.select().from(negotiationSessions)
        .where(eq(negotiationSessions.id, sessionId))
        .get();

      if (!sessionRow) {
        return reply.status(500).send({ error: "Failed to create session" });
      }

      const result = await createJobFromSession(sessionRow);

      pipelineTelemetry.emit(result.jobId, "job_accepted", "completed", {
        metadata: {
          sessionId,
          kernelId,
          capabilityType,
          paymentMethod: paymentMethod ?? "testnet-mock",
        },
      });

      return reply.status(201).send({
        sessionId,
        jobId: result.jobId,
        scopeId: result.scopeId,
        escrowId: result.escrowId,
        escrowAddress: result.escrowAddress,
        escrowStatus: result.escrowStatus,
        quote,
        contractTerms,
        message: "Fast-track job created. Scope is active — executor can start making tool calls.",
      });
    } catch (err) {
      return reply.status(500).send({
        error: "fast_track_failed",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ═════════════════════════════════════════════════════════════════════
  // PUT /api/jobs/:jobId/complete — Job completion -> evidence -> settlement
  // ═════════════════════════════════════════════════════════════════════

  app.put<{
    Params: { jobId: string };
    Body: {
      evidenceHash?: string;
      evidenceEvents?: Array<{
        type: string;
        payload?: Record<string, unknown>;
      }>;
    };
  }>("/api/jobs/:jobId/complete", async (req, reply) => {
    const { jobId } = req.params;
    const body = (req.body ?? {}) as Record<string, unknown>;

    try {
      const repos = getRepos();
      const { db } = getStore();

      // Look up the job
      const job = repos.jobs.findById(jobId);
      if (!job) {
        return reply.status(404).send({ error: "Job not found" });
      }

      if (job.status === "settled" || job.status === "completed") {
        return reply.status(409).send({
          error: "Job already completed",
          status: job.status,
        });
      }

      // ── 1. Gather evidence ─────────────────────────────────────────
      // Collect tool call results from the scope's audit trail
      const scopes = db.select().from(executionScopes)
        .where(eq(executionScopes.jobId, jobId))
        .all();

      const auditTrail: Array<Record<string, unknown>> = [];
      for (const scope of scopes) {
        const calls = db.select().from(toolCallRelay)
          .where(eq(toolCallRelay.scopeId, scope.id))
          .all();
        for (const call of calls) {
          auditTrail.push({
            toolName: call.toolName,
            args: call.toolArgs,
            status: call.status,
            result: call.result,
            createdAt: call.createdAt,
            completedAt: call.completedAt,
          });
        }
      }

      // Build evidence hash
      const evidencePayload = JSON.stringify({
        jobId,
        auditTrail,
        completedAt: new Date().toISOString(),
        customHash: body.evidenceHash,
      });

      // Use crypto for hashing
      const hashBuffer = crypto.createHash("sha256").update(evidencePayload).digest("hex");
      const bundleHash = `sha256:${hashBuffer}`;

      const now = new Date().toISOString();
      const bundleId = `bundle-${crypto.randomUUID().slice(0, 12)}`;

      // Build evidence events
      const customEvents = (body.evidenceEvents ?? []) as Array<{
        type: string;
        payload?: Record<string, unknown>;
      }>;

      const events = [
        {
          id: `ev-${crypto.randomUUID().slice(0, 8)}`,
          type: "execution_completed",
          timestamp: now,
          source: {
            deviceId: "gateway",
            deviceType: "controller",
            kernelId: job.kernelId,
          },
          payload: {
            toolCallCount: auditTrail.length,
            completedAt: now,
          } as Record<string, unknown>,
          hash: `sha256:${crypto.createHash("sha256").update(JSON.stringify({ type: "execution_completed", timestamp: now })).digest("hex")}`,
        },
        ...customEvents.map((ev) => ({
          id: `ev-${crypto.randomUUID().slice(0, 8)}`,
          type: ev.type,
          timestamp: now,
          source: {
            deviceId: "gateway",
            deviceType: "controller",
            kernelId: job.kernelId,
          },
          payload: ev.payload ?? {},
          hash: `sha256:${crypto.createHash("sha256").update(JSON.stringify(ev)).digest("hex")}`,
        })),
      ];

      // ── 2. Store evidence bundle ───────────────────────────────────
      repos.evidence.insert({
        id: bundleId,
        jobId,
        stepId: job.stepId,
        kernelId: job.kernelId,
        assuranceTier: 0,
        bundleHash,
        kernelSignature: {
          signer: "0x0000000000000000000000000000000000000000",
          algorithm: "sha256",
          value: "gateway-auto-sign",
        },
        createdAt: now,
      });

      if (events.length > 0) {
        repos.evidence.insertEvents(
          events.map((ev) => ({
            id: ev.id,
            bundleId,
            type: ev.type,
            timestamp: ev.timestamp,
            source: ev.source,
            payload: ev.payload as Record<string, unknown>,
            hash: ev.hash,
          })),
        );
      }

      // Update job with evidence bundle reference
      repos.jobs.update(jobId, {
        evidenceBundleId: bundleId,
        status: "evidence_submitted",
      });

      // ── 3. Revoke execution scopes ─────────────────────────────────
      for (const scope of scopes) {
        if (scope.status === "active") {
          db.update(executionScopes)
            .set({ status: "completed" })
            .where(eq(executionScopes.id, scope.id))
            .run();
        }
      }

      // ── 4. Find escrow and submit evidence hash ────────────────────
      // Look up the session that created this job to find the escrow
      const sessionRow = db.select().from(negotiationSessions)
        .where(eq(negotiationSessions.jobId, jobId))
        .get();

      let escrowAddress: string | null = sessionRow?.escrowAddress ?? null;
      let escrowId: string | null = null;

      // Also try to find the escrow by cwmId
      if (sessionRow?.cwmId) {
        const escrow = repos.escrows.findByCwm(sessionRow.cwmId);
        if (escrow) {
          escrowId = escrow.id;
          escrowAddress = escrow.contractAddress;

          // Update escrow milestone with evidence hash
          const milestones = repos.escrows.findMilestonesByEscrow(escrow.id);
          if (milestones.length > 0) {
            repos.escrows.updateMilestoneStatus(milestones[0].id, "evidence_submitted");
          }
        }
      }

      // ── 4b. Oracle verification ─────────────────────────────────────
      // Every settlement must pass through the PCC Verification Oracle.
      // If PCC_ORACLE_KEY is not set, falls back to mock (dev/test).
      const oracleResponse = await verifyWithOracle({
        escrowAddress: escrowAddress ?? "0x0000000000000000000000000000000000000000",
        jobId,
        kernelId: job.kernelId,
        evidenceHash: bundleHash,
        assuranceTier: 0,
        chainId: 84532, // Base Sepolia
      });

      if (!oracleResponse.result.verified) {
        return reply.status(422).send({
          error: "oracle_verification_failed",
          reason: oracleResponse.result.reason,
          checks: oracleResponse.result.checks,
        });
      }

      // Store the attestation for potential on-chain submission
      const oracleAttestation = oracleResponse.attestation;

      // ── 5. Settlement ──────────────────────────────────────────────
      let settlementStatus = "evidence_submitted";
      let settledAt: string | null = null;

      if (isMockSettlement()) {
        // Mock settlement: auto-settle after marking evidence
        repos.jobs.updateStatus(jobId, "settled");
        settledAt = now;
        settlementStatus = "settled";

        if (escrowId) {
          repos.escrows.updateStatus(escrowId, "completed");
          const milestones = repos.escrows.findMilestonesByEscrow(escrowId);
          for (const ms of milestones) {
            repos.escrows.updateMilestoneStatus(ms.id, "released");
          }
        }
      } else {
        // Real settlement: update status to evidence_submitted and wait for challenge window
        repos.jobs.updateStatus(jobId, "evidence_submitted");
        settlementStatus = "evidence_submitted";
      }

      pipelineTelemetry.emit(jobId, "settlement_complete", "completed", {
        metadata: {
          bundleId,
          bundleHash,
          escrowAddress,
          settlementStatus,
          mockSettlement: isMockSettlement(),
          toolCallCount: auditTrail.length,
          oracleVerified: oracleResponse.result.verified,
          oracleReason: oracleResponse.result.reason,
        },
      });

      return {
        jobId,
        status: settlementStatus,
        evidenceBundleId: bundleId,
        evidenceHash: bundleHash,
        escrowAddress,
        escrowId,
        settledAt,
        scopesRevoked: scopes.filter((s) => s.status === "active").length,
        toolCallsRecorded: auditTrail.length,
        oracleVerified: oracleResponse.result.verified,
        oracleAttestation: oracleAttestation ? {
          signature: oracleAttestation.signature,
          nonce: oracleAttestation.nonce,
          timestamp: oracleAttestation.timestamp,
        } : null,
        message: isMockSettlement()
          ? "Job completed and settled (mock settlement). Oracle verification passed."
          : "Job completed. Oracle verified. Evidence submitted. Awaiting challenge window expiry for settlement.",
      };
    } catch (err) {
      return reply.status(500).send({
        error: "completion_failed",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ═════════════════════════════════════════════════════════════════════
  // GET /api/jobs/:jobId/settlement — Settlement status
  // ═════════════════════════════════════════════════════════════════════

  app.get<{ Params: { jobId: string } }>("/api/jobs/:jobId/settlement", async (req, reply) => {
    const { jobId } = req.params;

    try {
      const repos = getRepos();
      const { db } = getStore();

      const job = repos.jobs.findById(jobId);
      if (!job) {
        return reply.status(404).send({ error: "Job not found" });
      }

      // Look up negotiation session for escrow info
      const sessionRow = db.select().from(negotiationSessions)
        .where(eq(negotiationSessions.jobId, jobId))
        .get();

      const escrowAddress = sessionRow?.escrowAddress ?? null;
      let escrowData: Record<string, unknown> | null = null;
      let milestoneData: Array<Record<string, unknown>> = [];

      // Look up escrow details
      if (sessionRow?.cwmId) {
        const escrow = repos.escrows.findByCwm(sessionRow.cwmId);
        if (escrow) {
          escrowData = {
            id: escrow.id,
            contractAddress: escrow.contractAddress,
            totalAmount: escrow.totalAmount,
            currency: escrow.currency,
            escrowStatus: escrow.status,
            deadline: escrow.deadline,
          };

          const milestones = repos.escrows.findMilestonesByEscrow(escrow.id);
          milestoneData = milestones.map((ms) => ({
            id: ms.id,
            stepId: ms.stepId,
            amount: ms.amount,
            bondAmount: ms.bondAmount,
            status: ms.status,
            evidenceBundleHash: ms.evidenceBundleHash,
            challengeWindowStart: ms.challengeWindowStart,
            challengeWindowEnd: ms.challengeWindowEnd,
          }));
        }
      }

      // Look up evidence
      const bundles = repos.evidence.findByJob(jobId);
      const latestBundle = bundles[bundles.length - 1] ?? null;

      // Map job status to settlement status
      let settlementStatus: string;
      switch (job.status) {
        case "pending":
          settlementStatus = "pending";
          break;
        case "active":
        case "executing":
        case "queued":
        case "preparing":
          settlementStatus = "executing";
          break;
        case "evidence_stored":
        case "evidence_submitted":
        case "collecting_evidence":
          settlementStatus = "evidence_submitted";
          break;
        case "settled":
          settlementStatus = "settled";
          break;
        case "completed":
          settlementStatus = "settled";
          break;
        case "failed":
        case "cancelled":
          settlementStatus = "cancelled";
          break;
        default:
          settlementStatus = job.status;
      }

      // Check if escrow is funded
      if (settlementStatus === "pending" && escrowData) {
        const eStatus = escrowData.escrowStatus as string;
        if (eStatus === "funded" || eStatus === "active") {
          settlementStatus = "funded";
        }
      }

      const quote = sessionRow?.quote as Record<string, unknown> | null;

      return {
        jobId: job.id,
        status: settlementStatus,
        escrowAddress,
        evidenceHash: latestBundle?.bundleHash ?? null,
        evidenceBundleId: latestBundle?.id ?? job.evidenceBundleId ?? null,
        milestones: milestoneData,
        paidAmount: (escrowData?.totalAmount as string) ?? quote?.totalPrice ?? null,
        currency: (escrowData?.currency as string) ?? (quote?.currency as string) ?? "USDC",
        escrow: escrowData,
        session: sessionRow ? {
          id: sessionRow.id,
          capabilityType: sessionRow.capabilityType,
          committedAt: sessionRow.committedAt,
        } : null,
      };
    } catch (err) {
      return reply.status(500).send({
        error: "query_failed",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
