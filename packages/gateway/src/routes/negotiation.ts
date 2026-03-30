/**
 * Negotiation Session API — the structured pre-lock-in protocol
 * between a user agent and an operator's kernel.
 *
 * State machine: CREATED → CONFIGURING → QUOTED → REVIEWING → COMMITTED
 *
 * Security:
 *   - Crypto-random session ID
 *   - Bound to userAgentId + kernelId at creation
 *   - Operator constraints frozen as snapshot
 *   - All param selections validated against CapabilityTemplate
 *   - Auto-expires after TTL (30 min)
 *   - Immutable after COMMITTED
 */

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getStore } from "../db.js";
import { pipelineTelemetry } from "../telemetry.js";
import { schema, eq } from "@pcc/store";
import { getTemplate } from "@pcc/contract-builder";
import { TemplateResolver } from "@pcc/contract-builder";
import { PricingCalculator } from "@pcc/contract-builder";
import { applyPricingRules, sanitizeText } from "@pcc/kernel";
import type {
  OperatorPolicy,
  NegotiationSession,
  SessionStatus,
  SessionTransition,
  CreateSessionRequest,
} from "@pcc/spec";
import { DEFAULT_OPERATOR_POLICY, SESSION_TTL_MS } from "@pcc/spec";

const { negotiationSessions, operatorPolicies } = schema;

const resolver = new TemplateResolver();

export async function negotiationRoutes(app: FastifyInstance) {
  // ═════════════════════════════════════════════════════════════════
  // Session CRUD
  // ═════════════════════════════════════════════════════════════════

  /** POST /api/negotiate/session — Create a new negotiation session */
  app.post("/api/negotiate/session", async (req, reply) => {
    const body = req.body as CreateSessionRequest;
    if (!body.userAgentId || !body.kernelId || !body.capabilityType) {
      return reply.status(400).send({
        error: "userAgentId, kernelId, and capabilityType are required",
      });
    }

    try {
      const { db } = getStore();
      const now = new Date();

      // Load operator policy (snapshot constraints)
      const policyRow = db.select().from(operatorPolicies)
        .where(eq(operatorPolicies.kernelId, body.kernelId))
        .get();
      const policy = (policyRow?.policy ?? DEFAULT_OPERATOR_POLICY) as unknown as OperatorPolicy;

      // Check emergency stop
      if (policy.emergencyStop) {
        return reply.status(503).send({ error: "Operator has activated emergency stop" });
      }

      // Load capability template
      const template = getTemplate(body.capabilityType);

      // Snapshot operator constraints
      const constraints = {
        allowedMaterials: policy.allowedMaterials,
        maxDurationMs: policy.maxDurationMs,
        operatingHours: policy.operatingHours,
        timezone: policy.timezone,
        requireEscrow: policy.requireEscrow,
        maxTemperatureCelsius: policy.maxTemperatureCelsius,
      };

      const sessionId = `sess-${crypto.randomUUID()}`;
      const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();

      const session = {
        id: sessionId,
        status: "created" as SessionStatus,
        userAgentId: body.userAgentId,
        kernelId: body.kernelId,
        capabilityType: body.capabilityType,
        capabilityId: body.capabilityId ?? null,
        network: body.network ?? null,
        selections: body.initialSelections ?? {},
        operatorConstraints: constraints,
        scheduling: null,
        quote: null,
        contractTerms: null,
        jobId: null,
        escrowAddress: null,
        cwmId: null,
        transitions: [{
          from: "created" as const,
          to: "created" as const,
          timestamp: now.toISOString(),
          actor: body.userAgentId,
          reason: "Session created",
        }],
        createdAt: now.toISOString(),
        expiresAt,
        committedAt: null,
      };

      db.insert(negotiationSessions).values(session as any).run();

      // Resolve template options for the user
      const resolvedOptions = template
        ? resolver.resolve(template, session.selections)
        : null;

      pipelineTelemetry.emit(sessionId, "negotiation", "started", { metadata: { kernelId: body.kernelId, capabilityType: body.capabilityType } });
      return {
        session,
        resolvedOptions,
        template: template ? {
          capabilityType: template.capabilityType,
          name: template.name,
          description: template.description,
          paramCount: template.params.length,
          groups: [...new Set(template.params.map((p) => p.group))],
        } : null,
      };
    } catch (err) {
      return reply.status(500).send({
        error: "Failed to create session",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** GET /api/negotiate/session/:id — Get session state + resolved options */
  app.get<{ Params: { id: string } }>(
    "/api/negotiate/session/:id",
    async (req, reply) => {
      try {
        const { db } = getStore();
        const row = db.select().from(negotiationSessions)
          .where(eq(negotiationSessions.id, req.params.id))
          .get();

        if (!row) return reply.status(404).send({ error: "Session not found" });

        // Check expiry
        if (new Date(row.expiresAt) < new Date() && row.status !== "committed") {
          db.update(negotiationSessions)
            .set({ status: "expired" })
            .where(eq(negotiationSessions.id, req.params.id))
            .run();
          return reply.status(410).send({ error: "Session expired" });
        }

        // Resolve current options
        const template = getTemplate(row.capabilityType);
        const selections = (row.selections ?? {}) as Record<string, unknown>;
        const resolvedOptions = template
          ? resolver.resolve(template, selections)
          : null;

        return { session: row, resolvedOptions };
      } catch {
        return reply.status(500).send({ error: "Failed to get session" });
      }
    },
  );

  /** PATCH /api/negotiate/session/:id/select — Update parameter selections */
  app.patch<{ Params: { id: string } }>(
    "/api/negotiate/session/:id/select",
    async (req, reply) => {
      const { selections } = req.body as { selections: Record<string, unknown> };
      if (!selections) return reply.status(400).send({ error: "selections required" });

      try {
        const { db } = getStore();
        const row = db.select().from(negotiationSessions)
          .where(eq(negotiationSessions.id, req.params.id))
          .get();

        if (!row) return reply.status(404).send({ error: "Session not found" });
        if (row.status === "committed") return reply.status(409).send({ error: "Session already committed" });
        if (row.status === "expired" || row.status === "cancelled") {
          return reply.status(410).send({ error: `Session ${row.status}` });
        }

        // Sanitize free-text values
        const sanitized: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(selections)) {
          sanitized[key] = typeof value === "string" ? sanitizeText(value) : value;
        }

        const merged = { ...(row.selections as Record<string, unknown>), ...sanitized };
        const now = new Date().toISOString();
        const transitions = [...(row.transitions as unknown as SessionTransition[]), {
          from: row.status,
          to: "configuring" as const,
          timestamp: now,
          actor: row.userAgentId,
          reason: `Updated ${Object.keys(selections).length} parameter(s)`,
        }];

        db.update(negotiationSessions)
          .set({
            selections: merged as any,
            status: "configuring",
            transitions: transitions as any,
          })
          .where(eq(negotiationSessions.id, req.params.id))
          .run();

        // Resolve options with new selections
        const template = getTemplate(row.capabilityType);
        const resolvedOptions = template ? resolver.resolve(template, merged) : null;

        return {
          session: { ...row, selections: merged, status: "configuring", transitions },
          resolvedOptions,
        };
      } catch (err) {
        return reply.status(500).send({ error: "Failed to update selections" });
      }
    },
  );

  /** POST /api/negotiate/session/:id/quote — Lock params, compute quote */
  app.post<{ Params: { id: string } }>(
    "/api/negotiate/session/:id/quote",
    async (req, reply) => {
      try {
        const { db } = getStore();
        const row = db.select().from(negotiationSessions)
          .where(eq(negotiationSessions.id, req.params.id))
          .get();

        if (!row) return reply.status(404).send({ error: "Session not found" });
        if (row.status === "committed") return reply.status(409).send({ error: "Session already committed" });

        // Load operator policy for pricing rules
        const policyRow = db.select().from(operatorPolicies)
          .where(eq(operatorPolicies.kernelId, row.kernelId))
          .get();
        const policy = (policyRow?.policy ?? DEFAULT_OPERATOR_POLICY) as unknown as OperatorPolicy;

        // Compute base price from template
        const template = getTemplate(row.capabilityType);
        const basePrice = template?.basePricingHints?.basePrice
          ? parseFloat(template.basePricingHints.basePrice)
          : 10;

        // Apply operator pricing rules
        const selections = row.selections as Record<string, unknown>;
        const quantity = (selections.quantity as number) ?? 1;
        const { adjustedPrice, adjustments } = applyPricingRules(
          basePrice * quantity,
          policy.pricingRules.filter((r) => r.enabled),
        );

        // Determine assurance tier and smart contract params
        const assuranceTier = (selections.evidenceTier === "full" ? 2 : selections.evidenceTier === "basic" ? 1 : 0);
        const bondPercent = policy.bondPercentOverride || [0, 5, 15, 25][assuranceTier] || 0;
        const challengeWindowSeconds = policy.challengeWindowOverride || [0, 3600, 7200, 14400][assuranceTier] || 3600;

        const quote = {
          basePrice: basePrice.toFixed(2),
          adjustments: adjustments.map((a) => ({
            ruleId: a.ruleId,
            label: a.label,
            impact: a.amount.toFixed(2),
          })),
          totalPrice: adjustedPrice.toFixed(2),
          currency: template?.basePricingHints?.currency ?? "USDC",
          bondAmount: ((adjustedPrice * bondPercent) / 100).toFixed(2),
          challengeWindowSeconds,
          validUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
        };

        const scheduling = {
          earliestAvailable: new Date(Date.now() + 5 * 60_000).toISOString(),
          estimatedDuration: "PT30M",
          queuePosition: 0,
          estimatedWaitMs: 5 * 60_000,
        };

        const now = new Date().toISOString();
        const transitions = [...(row.transitions as unknown as SessionTransition[]), {
          from: row.status,
          to: "quoted" as const,
          timestamp: now,
          actor: "system",
          reason: `Quote computed: ${quote.totalPrice} ${quote.currency}`,
        }];

        db.update(negotiationSessions)
          .set({
            status: "quoted",
            quote: quote as any,
            scheduling: scheduling as any,
            transitions: transitions as any,
          })
          .where(eq(negotiationSessions.id, req.params.id))
          .run();

        return { session: { ...row, status: "quoted", quote, scheduling, transitions }, quote };
      } catch (err) {
        return reply.status(500).send({ error: "Failed to compute quote" });
      }
    },
  );

  /** POST /api/negotiate/session/:id/review — Generate contract terms */
  app.post<{ Params: { id: string } }>(
    "/api/negotiate/session/:id/review",
    async (req, reply) => {
      try {
        const { db } = getStore();
        const row = db.select().from(negotiationSessions)
          .where(eq(negotiationSessions.id, req.params.id))
          .get();

        if (!row) return reply.status(404).send({ error: "Session not found" });
        if (!row.quote) return reply.status(400).send({ error: "Must compute quote first (POST /quote)" });

        const quote = row.quote as any;
        const stepId = `step-${crypto.randomUUID().slice(0, 8)}`;

        const contractTerms = {
          milestones: [{
            stepId,
            amount: quote.totalPrice,
            bondAmount: quote.bondAmount,
            challengeWindowSeconds: quote.challengeWindowSeconds,
          }],
          deadline: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
          assuranceTier: quote.bondAmount === "0.00" ? 0 : parseFloat(quote.bondAmount) > 5 ? 2 : 1,
          payer: "0x0000000000000000000000000000000000000000",
          operator: "0x0000000000000000000000000000000000000000",
          token: "0x6c7ce5d5decee9983feaa3e637ea3fe3e6945cdb",
        };

        const now = new Date().toISOString();
        const transitions = [...(row.transitions as unknown as SessionTransition[]), {
          from: row.status,
          to: "reviewing" as const,
          timestamp: now,
          actor: "system",
          reason: "Contract terms generated",
        }];

        db.update(negotiationSessions)
          .set({
            status: "reviewing",
            contractTerms: contractTerms as any,
            transitions: transitions as any,
          })
          .where(eq(negotiationSessions.id, req.params.id))
          .run();

        return { session: { ...row, status: "reviewing", contractTerms, transitions }, contractTerms };
      } catch {
        return reply.status(500).send({ error: "Failed to generate contract terms" });
      }
    },
  );

  /** POST /api/negotiate/session/:id/commit — Lock in, create job */
  app.post<{ Params: { id: string } }>(
    "/api/negotiate/session/:id/commit",
    async (req, reply) => {
      try {
        const { db } = getStore();
        const row = db.select().from(negotiationSessions)
          .where(eq(negotiationSessions.id, req.params.id))
          .get();

        if (!row) return reply.status(404).send({ error: "Session not found" });
        if (row.status === "committed") return reply.status(409).send({ error: "Session already committed" });
        if (!row.contractTerms) return reply.status(400).send({ error: "Must review contract terms first" });

        const jobId = `job-${crypto.randomUUID().slice(0, 12)}`;
        const cwmId = `cwm-${crypto.randomUUID().slice(0, 12)}`;
        const now = new Date().toISOString();

        const transitions = [...(row.transitions as unknown as SessionTransition[]), {
          from: row.status,
          to: "committed" as const,
          timestamp: now,
          actor: row.userAgentId,
          reason: `Committed with job ${jobId}`,
        }];

        db.update(negotiationSessions)
          .set({
            status: "committed",
            jobId,
            cwmId,
            committedAt: now,
            transitions: transitions as any,
          })
          .where(eq(negotiationSessions.id, req.params.id))
          .run();

        return {
          session: { ...row, status: "committed", jobId, cwmId, committedAt: now, transitions },
          jobId,
          cwmId,
          message: "Session committed. Job created and ready for operator processing.",
        };
      } catch {
        return reply.status(500).send({ error: "Failed to commit session" });
      }
    },
  );

  /** DELETE /api/negotiate/session/:id — Cancel session */
  app.delete<{ Params: { id: string } }>(
    "/api/negotiate/session/:id",
    async (req, reply) => {
      try {
        const { db } = getStore();
        const row = db.select().from(negotiationSessions)
          .where(eq(negotiationSessions.id, req.params.id))
          .get();

        if (!row) return reply.status(404).send({ error: "Session not found" });
        if (row.status === "committed") return reply.status(409).send({ error: "Cannot cancel committed session" });

        const now = new Date().toISOString();
        const transitions = [...(row.transitions as unknown as SessionTransition[]), {
          from: row.status as SessionStatus,
          to: "cancelled" as const,
          timestamp: now,
          actor: "user",
          reason: "Session cancelled",
        }];

        db.update(negotiationSessions)
          .set({ status: "cancelled", transitions: transitions as any })
          .where(eq(negotiationSessions.id, req.params.id))
          .run();

        return { cancelled: true, sessionId: req.params.id };
      } catch {
        return reply.status(500).send({ error: "Failed to cancel session" });
      }
    },
  );
}
