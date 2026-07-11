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
import { getStore, getRepos } from "../db.js";
import { pipelineTelemetry } from "../telemetry.js";
import { schema, eq } from "@pcc/store";
import { getTemplate } from "@pcc/contract-builder";
import { TemplateResolver } from "@pcc/contract-builder";
import { PricingCalculator } from "@pcc/contract-builder";
import { applyPricingRules, sanitizeText } from "@pcc/kernel";
import { ChallengeService } from "@pcc/verifier";
import type {
  OperatorPolicy,
  NegotiationSession,
  SessionStatus,
  SessionTransition,
  CreateSessionRequest,
  WorkflowChallenge,
  DemandEnvelope,
} from "@pcc/spec";
import { DEFAULT_OPERATOR_POLICY, SESSION_TTL_MS, computeCompositionSignature, budgetToBand } from "@pcc/spec";
import { createJobFromSession, isMockSettlement } from "./paid-job-flow.js";
import { getEventBus } from "../services/event-bus.js";
import {
  getCapabilityDescriptor,
  checkKernelOffersCapability,
} from "../services/ad-hoc-pricing.js";
// Liveness gate lives in one shared module so the A2A commit path (a2a-tasks.ts)
// enforces the identical rule — see session-liveness.ts (N1).
import { assertSessionLive as assertLive } from "./session-liveness.js";

/**
 * Serialize a WorkflowChallenge for the wire — converts the BigInt
 * blockNumber + timestamp inside `anchor` to decimal strings so
 * Fastify's default JSON serializer doesn't throw
 * "Do not know how to serialize a BigInt".
 *
 * The receiver can BigInt() the strings back when verifying.
 */
function serializeChallenge(
  c: WorkflowChallenge | null,
): Record<string, unknown> | null {
  if (!c) return null;
  return {
    ...c,
    anchor: {
      ...c.anchor,
      blockNumber: c.anchor.blockNumber.toString(),
      timestamp: c.anchor.timestamp.toString(),
    },
  };
}

const challengeService = new ChallengeService();

const { negotiationSessions, operatorPolicies } = schema;

const resolver = new TemplateResolver();

// ── settlement_failed recovery: classification + double-mint guard ──────────
//
// A REAL-settlement commit that fails to mint a usable on-chain escrow moves the
// session to "settlement_failed" (instead of #242's silently-left "committed").
// The transition carries a machine-readable class so /retry-settlement can tell a
// PROVABLY-no-escrow failure (safe to re-mint) from an ambiguous one (an escrow may
// have been minted before the throw → fail closed). Money-path default is the
// unsafe class — anything not provably pre-flight is treated as "escrow may exist".

/** Failure happened before ANY on-chain call — no escrow can exist, retry may mint. */
const SETTLEMENT_FAILED_PREFLIGHT = "settlement_failed:preflight_no_escrow";
/** Failure may have minted an on-chain escrow before throwing — fail closed. */
const SETTLEMENT_FAILED_AMBIGUOUS = "settlement_failed:onchain_maybe_minted";

/**
 * Classify a real-settlement commit failure. createJobFromSession's real path throws
 * at its very first step — `if (!pk) throw "PCC_GATEWAY_PRIVATE_KEY required..."` —
 * BEFORE any wallet/public client is built or any tx is sent. So an unset gateway key
 * at failure time proves no on-chain escrow could exist, and a fresh mint on retry is
 * safe. EVERY other failure (key present → a chain write may have landed before the
 * throw; or a completed-but-no-address result) is treated as "an escrow may exist".
 */
function settlementFailureClass(settlementError: string | null): string {
  if (settlementError && !process.env.PCC_GATEWAY_PRIVATE_KEY) {
    return SETTLEMENT_FAILED_PREFLIGHT;
  }
  return SETTLEMENT_FAILED_AMBIGUOUS;
}

/** Was the session's most recent settlement_failed transition the provably-safe
 *  pre-flight class? No marker / any other class → false (fail closed). */
function latestFailureWasPreflight(
  row: typeof negotiationSessions.$inferSelect,
): boolean {
  const transitions = (row.transitions as unknown as SessionTransition[]) ?? [];
  for (let i = transitions.length - 1; i >= 0; i--) {
    if (transitions[i].to === "settlement_failed") {
      return transitions[i].reason === SETTLEMENT_FAILED_PREFLIGHT;
    }
  }
  return false;
}

/**
 * Fail-closed double-mint guard. Returns the REAL on-chain escrow address already
 * recorded for this session (from the session row or the escrows table by cwmId),
 * or null if none. A synthetic "mock-…" address is not a real on-chain escrow.
 * If a real escrow exists, /retry-settlement MUST resume from it, never re-mint.
 */
function findRecordedEscrowAddress(
  row: typeof negotiationSessions.$inferSelect,
): string | null {
  const isReal = (a: string | null | undefined): a is string =>
    !!a && a.startsWith("0x") && !a.startsWith("mock");
  if (isReal(row.escrowAddress)) return row.escrowAddress;
  try {
    if (row.cwmId) {
      const esc = getRepos().escrows.findByCwm(row.cwmId);
      if (esc && isReal(esc.contractAddress)) return esc.contractAddress;
    }
  } catch {
    // No recorded escrow discoverable — fall through to null.
  }
  return null;
}

// assertLive is imported from ./session-liveness.js (shared with a2a-tasks.ts).

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

    // ── Up-front validation (4xx, not 500) ─────────────────────────
    // Wrong-kernel check: refuse if the chosen kernel doesn't actually
    // offer this capability type. Today the only signal we had was a
    // foreign-key constraint blowing up downstream in 500. Now the
    // buyer gets a clear 404 with which capability types the kernel
    // does offer.
    const kernelMismatch = checkKernelOffersCapability(
      body.kernelId,
      body.capabilityType,
    );
    if (kernelMismatch) {
      return reply.status(404).send({
        error: "kernel_capability_mismatch",
        message: kernelMismatch,
      });
    }

    // Capability-resolution check: either there's a built-in template
    // for the type, or a registered capability row of that type. If
    // neither: 404. (We still allow session creation in this case —
    // wrong-kernel above is the harder gate.) This second check exists
    // to surface "you can't get a quote for this" early.
    const desc = getCapabilityDescriptor(
      body.capabilityType,
      body.capabilityId ?? undefined,
    );
    if (desc.kind === "missing") {
      return reply.status(404).send({
        error: "capability_not_buildable",
        message: desc.reason,
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

      // Load capability template (built-in only; ad-hoc handled via desc)
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

      // Resolve template options for the user. Built-in templates go
      // through the resolver as before; ad-hoc capability types get a
      // synthesized view model from the descriptor so the configurator
      // UI still has groups to render.
      const resolvedOptions = template
        ? resolver.resolve(template, session.selections)
        : desc.kind === "ad-hoc"
          ? desc.descriptor.resolved
          : null;

      // Issue a WorkflowChallenge anchored to a mock block (no live RPC in gateway by default).
      // This proves the session was created after a specific block, preventing replay attacks.
      let challenge: WorkflowChallenge | null = null;
      try {
        const mockBlockNumber = BigInt(Math.floor(Date.now() / 12_000)); // ~12s block time
        challenge = await challengeService.issueChallenge({
          issuedBy: "pcc-gateway",
          scope: `negotiation:${sessionId}`,
          blockNumber: mockBlockNumber,
          blockHash: `0x${crypto.createHash("sha256").update(sessionId).digest("hex")}`,
          blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
        });
      } catch {
        // Challenge issuance is best-effort — session creation should not fail
      }

      pipelineTelemetry.emit(sessionId, "negotiation", "started", { metadata: { kernelId: body.kernelId, capabilityType: body.capabilityType } });

      // ── Demand-intel capture point B — atomic session intent ───────
      // Single-capabilityType, atomic intent. Emit best-effort; failures
      // must never break session creation.
      try {
        const compositionSignature = computeCompositionSignature(
          [body.capabilityType],
          [],
        );
        const envelope: DemandEnvelope = {
          id: `intent-${sessionId}`,
          source: "negotiate_api",
          compositionSignature,
          capabilityTypes: [body.capabilityType],
          summary: `Negotiate atomic session for ${body.capabilityType}`.slice(0, 200),
          budgetBand: budgetToBand(0),
          urgencyBand: "standard",
          originAgentId: body.userAgentId,
          createdAt: now.toISOString(),
        };
        getEventBus().publish({
          eventType: "intent.atomic_session",
          category: "intent",
          actorId: body.userAgentId,
          actorType: "agent",
          resourceType: "intent",
          resourceId: envelope.id,
          payload: envelope as unknown as Record<string, unknown>,
        });
      } catch {
        // best-effort
      }

      return {
        session,
        resolvedOptions,
        // Serialize the challenge so the BigInt anchor fields don't
        // throw "Do not know how to serialize a BigInt" in Fastify's
        // default JSON serializer (the production 500 root cause).
        challenge: serializeChallenge(challenge),
        template: template ? {
          capabilityType: template.capabilityType,
          name: template.name,
          description: template.description,
          paramCount: template.params.length,
          groups: [...new Set(template.params.map((p) => p.group))],
        } : desc.kind === "ad-hoc" ? {
          capabilityType: desc.descriptor.capabilityType,
          name: desc.descriptor.name,
          description: "Ad-hoc capability — pricing from operator's pricingModel.",
          paramCount: desc.descriptor.resolved.allParams.length,
          groups: desc.descriptor.resolved.groups.map((g) => g.name),
          kind: "ad-hoc",
        } : null,
      };
    } catch (err) {
      // Log the underlying error so future regressions are visible in
      // the gateway logs instead of opaque 500s. We still return a
      // generic body to the caller (don't leak stack/internals).
      req.log.error(
        { err: err instanceof Error ? err.message : String(err), kernelId: body.kernelId, capabilityType: body.capabilityType },
        "[negotiation] session create failed",
      );
      return reply.status(500).send({
        error: "session_create_failed",
        message: err instanceof Error ? err.message : "Failed to create session",
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
            // Changing selections invalidates any prior quote + contract terms.
            // Forcing a re-quote stops /commit from locking escrow at a stale
            // price while the job runs the new parameters (N2).
            quote: null,
            contractTerms: null,
            transitions: transitions as any,
          })
          .where(eq(negotiationSessions.id, req.params.id))
          .run();

        // Resolve options with new selections
        const template = getTemplate(row.capabilityType);
        const resolvedOptions = template ? resolver.resolve(template, merged) : null;

        return {
          session: { ...row, selections: merged, status: "configuring", quote: null, contractTerms: null, transitions },
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
        const violation = assertLive(db, row);
        if (violation) return reply.status(violation.status).send(violation.body);

        // Load operator policy for pricing rules
        const policyRow = db.select().from(operatorPolicies)
          .where(eq(operatorPolicies.kernelId, row.kernelId))
          .get();
        const policy = (policyRow?.policy ?? DEFAULT_OPERATOR_POLICY) as unknown as OperatorPolicy;

        // Compute base price. Built-in templates use basePricingHints;
        // ad-hoc capabilities derive baseCost from the capability row's
        // pricingModel (the operator's own pricing) — falling back to 10
        // only when neither source has a number.
        const template = getTemplate(row.capabilityType);
        let basePrice: number;
        let quoteCurrency = "USDC";
        if (template?.basePricingHints?.basePrice) {
          basePrice = parseFloat(template.basePricingHints.basePrice);
          quoteCurrency = template.basePricingHints.currency ?? "USDC";
        } else {
          // Ad-hoc path. Look up the capability row to find pricing.
          const adHoc = getCapabilityDescriptor(
            row.capabilityType,
            row.capabilityId ?? undefined,
          );
          if (adHoc.kind === "ad-hoc") {
            basePrice = parseFloat(adHoc.descriptor.basePrice);
            quoteCurrency = adHoc.descriptor.currency;
          } else {
            basePrice = 10;
          }
        }

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
          currency: quoteCurrency,
          bondAmount: ((adjustedPrice * bondPercent) / 100).toFixed(2),
          challengeWindowSeconds,
          // Persist the agreed assurance tier (derived from evidenceTier above)
          // so /review copies it verbatim instead of re-deriving it from the
          // bond dollar amount — the wrong tier otherwise propagates on-chain
          // as the milestone's requiredTier (N3).
          assuranceTier,
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
        const violation = assertLive(db, row);
        if (violation) return reply.status(violation.status).send(violation.body);
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
          // Copy the tier the buyer agreed to at /quote — never re-derive it
          // from the bond dollar amount (that decouples the on-chain
          // requiredTier from the agreed evidence tier). Fall back to 0 only
          // for legacy quotes created before the tier was persisted (N3).
          assuranceTier: typeof quote.assuranceTier === "number" ? quote.assuranceTier : 0,
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
        const violation = assertLive(db, row);
        if (violation) return reply.status(violation.status).send(violation.body);
        if (!row.contractTerms) return reply.status(400).send({ error: "Must review contract terms first" });
        // Honor the quote's own validity window: don't lock escrow against a
        // stale quote. The committed price must still be within validUntil (N1).
        const commitQuote = row.quote as { validUntil?: string } | null;
        if (commitQuote?.validUntil && new Date(commitQuote.validUntil) < new Date()) {
          return reply.status(410).send({ error: "Quote expired — re-quote before commit" });
        }

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

        // ── Wire: COMMITTED -> create escrow + job + scope ────────────
        let paidJobResult: {
          jobId: string;
          scopeId: string;
          escrowId: string;
          escrowAddress: string;
          escrowStatus: string;
        } | null = null;
        let settlementError: string | null = null;

        try {
          const committedRow = db.select().from(negotiationSessions)
            .where(eq(negotiationSessions.id, req.params.id))
            .get();
          if (committedRow) {
            paidJobResult = await createJobFromSession(committedRow);
          }
        } catch (err) {
          settlementError = err instanceof Error ? err.message : String(err);
          console.warn("[negotiation] Paid job flow wiring failed:", settlementError);
        }

        // ── Money-path guard: never return a false 200 in REAL settlement ──
        // Mock/dev mode: escrow is synthetic, so a wiring miss is genuinely
        // best-effort — keep the existing 200 (behavior unchanged).
        // REAL settlement mode: a throw (e.g. "PCC_GATEWAY_PRIVATE_KEY required
        // for real settlement") or a result with no on-chain escrowAddress means
        // NO escrow exists. Returning 200 here would tell the buyer the deal is
        // funded when it is not — the exact false-success this fix removes. Fail
        // loud with 502 so the caller knows the commit did not produce escrow.
        //
        // #242 deliberately LEFT status="committed" so assertSessionLive() 409-blocked
        // a /commit retry — its only guard against a second createJobFromSession
        // deploying a DUPLICATE on-chain escrow. We keep that block but move the session
        // to a first-class, recoverable "settlement_failed" state: assertSessionLive()
        // now 409s "settlement_failed" too (so /commit / /quote / /review / the A2A path
        // still refuse it — the double-mint block is preserved), while a dedicated,
        // guarded POST /retry-settlement (never double-mints) and DELETE (cancel) provide
        // the recovery path this state was missing. On the money path, blocking a double
        // escrow still outranks un-sticking the session.
        if (!isMockSettlement() && (settlementError || !paidJobResult?.escrowAddress)) {
          // Stamp the failure class so the retry can distinguish a provably-no-escrow
          // pre-flight failure (safe to re-mint) from an ambiguous one (fail closed).
          const failTransitions = [
            ...transitions,
            {
              from: "committed" as SessionStatus,
              to: "settlement_failed" as SessionStatus,
              timestamp: new Date().toISOString(),
              actor: "system",
              reason: settlementFailureClass(settlementError),
            },
          ];
          db.update(negotiationSessions)
            .set({ status: "settlement_failed", transitions: failTransitions as any })
            .where(eq(negotiationSessions.id, req.params.id))
            .run();

          return reply.status(502).send({
            error: "settlement_failed",
            message:
              settlementError ??
              "Real settlement completed without an on-chain escrow address",
            sessionId: req.params.id,
            jobId,
          });
        }

        return {
          session: { ...row, status: "committed", jobId: paidJobResult?.jobId ?? jobId, cwmId, committedAt: now, transitions },
          jobId: paidJobResult?.jobId ?? jobId,
          cwmId,
          scopeId: paidJobResult?.scopeId ?? null,
          escrowId: paidJobResult?.escrowId ?? null,
          escrowAddress: paidJobResult?.escrowAddress ?? null,
          escrowStatus: paidJobResult?.escrowStatus ?? null,
          message: paidJobResult
            ? "Session committed. Job, escrow, and execution scope created."
            : "Session committed. Job created and ready for operator processing.",
        };
      } catch {
        return reply.status(500).send({ error: "Failed to commit session" });
      }
    },
  );

  /**
   * POST /api/negotiate/session/:id/retry-settlement — recover a stuck
   * "settlement_failed" session WITHOUT ever minting a duplicate on-chain escrow.
   *
   * Money-path order of operations (fail closed at every ambiguity):
   *   1. If a REAL on-chain escrow is already recorded for this session, a prior
   *      attempt minted it — RESUME from it, never re-mint.
   *   2. Otherwise, in REAL mode, only re-mint when the prior failure was PROVABLY
   *      pre-flight (no chain write possible). If an escrow MAY have been minted but
   *      isn't recorded, refuse — a duplicate escrow is worse than a stuck session.
   *   3. When safe (pre-flight real failure, or mock mode), re-run the full wiring.
   */
  app.post<{ Params: { id: string } }>(
    "/api/negotiate/session/:id/retry-settlement",
    async (req, reply) => {
      try {
        const { db } = getStore();
        const row = db.select().from(negotiationSessions)
          .where(eq(negotiationSessions.id, req.params.id))
          .get();

        if (!row) return reply.status(404).send({ error: "Session not found" });
        if (row.status !== "settlement_failed") {
          return reply.status(409).send({
            error: `Session is ${row.status}, not settlement_failed — nothing to retry`,
          });
        }

        // ── 1. Double-mint guard: is a REAL escrow already recorded? ──────────
        const existingEscrow = findRecordedEscrowAddress(row);
        if (existingEscrow) {
          const now = new Date().toISOString();
          const jobId = row.jobId ?? `job-${crypto.randomUUID().slice(0, 12)}`;
          const transitions = [...(row.transitions as unknown as SessionTransition[]), {
            from: "settlement_failed" as SessionStatus,
            to: "committed" as SessionStatus,
            timestamp: now,
            actor: "system",
            reason: `Resumed from existing escrow ${existingEscrow} (no re-mint)`,
          }];
          db.update(negotiationSessions)
            .set({
              status: "committed",
              jobId,
              escrowAddress: existingEscrow,
              committedAt: row.committedAt ?? now,
              transitions: transitions as any,
            })
            .where(eq(negotiationSessions.id, req.params.id))
            .run();
          return {
            resumed: true,
            sessionId: req.params.id,
            jobId,
            escrowAddress: existingEscrow,
            message:
              "Recovered from the existing on-chain escrow. No new escrow was minted.",
          };
        }

        // ── 2. No recorded escrow. In REAL mode, only re-mint when PROVABLY safe. ─
        if (!isMockSettlement() && !latestFailureWasPreflight(row)) {
          return reply.status(409).send({
            error: "settlement_unrecoverable_ambiguous",
            message:
              "Cannot safely retry: a prior attempt may have minted an on-chain escrow " +
              "that is not recorded, and re-minting would risk a duplicate escrow. Verify " +
              "on-chain state, or DELETE this session to cancel and start a new negotiation.",
            sessionId: req.params.id,
          });
        }

        // ── 3. Safe to (re-)mint. Mirror /commit: mark committed, then wire. ─────
        const now = new Date().toISOString();
        const jobId = row.jobId ?? `job-${crypto.randomUUID().slice(0, 12)}`;
        const cwmId = row.cwmId ?? `cwm-${crypto.randomUUID().slice(0, 12)}`;
        const retryTransitions = [...(row.transitions as unknown as SessionTransition[]), {
          from: "settlement_failed" as SessionStatus,
          to: "committed" as SessionStatus,
          timestamp: now,
          actor: row.userAgentId,
          reason: `Retry settlement with job ${jobId}`,
        }];
        db.update(negotiationSessions)
          .set({ status: "committed", jobId, cwmId, committedAt: now, transitions: retryTransitions as any })
          .where(eq(negotiationSessions.id, req.params.id))
          .run();

        let paidJobResult: Awaited<ReturnType<typeof createJobFromSession>> | null = null;
        let settlementError: string | null = null;
        try {
          const committedRow = db.select().from(negotiationSessions)
            .where(eq(negotiationSessions.id, req.params.id))
            .get();
          if (committedRow) paidJobResult = await createJobFromSession(committedRow);
        } catch (err) {
          settlementError = err instanceof Error ? err.message : String(err);
          console.warn("[negotiation] retry-settlement wiring failed:", settlementError);
        }

        // Same money-path guard as /commit: no false success in REAL mode.
        if (!isMockSettlement() && (settlementError || !paidJobResult?.escrowAddress)) {
          const failTransitions = [...retryTransitions, {
            from: "committed" as SessionStatus,
            to: "settlement_failed" as SessionStatus,
            timestamp: new Date().toISOString(),
            actor: "system",
            reason: settlementFailureClass(settlementError),
          }];
          db.update(negotiationSessions)
            .set({ status: "settlement_failed", transitions: failTransitions as any })
            .where(eq(negotiationSessions.id, req.params.id))
            .run();
          return reply.status(502).send({
            error: "settlement_failed",
            message:
              settlementError ??
              "Real settlement completed without an on-chain escrow address",
            sessionId: req.params.id,
            jobId,
          });
        }

        return {
          retried: true,
          sessionId: req.params.id,
          jobId: paidJobResult?.jobId ?? jobId,
          cwmId,
          scopeId: paidJobResult?.scopeId ?? null,
          escrowId: paidJobResult?.escrowId ?? null,
          escrowAddress: paidJobResult?.escrowAddress ?? null,
          escrowStatus: paidJobResult?.escrowStatus ?? null,
          message: "Settlement retried. Job, escrow, and execution scope created.",
        };
      } catch {
        return reply.status(500).send({ error: "Failed to retry settlement" });
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
        // A "committed" session is an active funded deal — never cancellable here.
        // A "settlement_failed" session is NOT committed: cancel cleanly closes the
        // negotiation record (the recovery exit besides /retry-settlement). Cancel
        // only closes the session; it makes no claim to refund or rescind any escrow.
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
