/**
 * A2A v1.0 Tasks JSON-RPC adapter.
 *
 * POST /a2a/tasks/send — entry point for any A2A v1.0 compliant agent.
 *
 * Wire envelope (JSON-RPC 2.0):
 *   { jsonrpc: "2.0", id: <string|number>, method: "tasks/send"|"tasks/get"|"tasks/cancel", params: {...} }
 *
 * Skills handled by tasks/send:
 *   pcc-discover  → CapabilityFacade.list(filters)
 *   pcc-quote     → create NegotiationSession, drive it to QUOTED, return quote artifact
 *   pcc-submit    → create + commit session in one shot
 *   pcc-verify    → return evidence bundle for a given jobId
 *   pcc-settle    → trigger milestone release for a given escrowId/milestoneIndex
 *
 * A2A Task state mapping (A2A v1.0 §4 Task lifecycle):
 *   PCC CREATED/CONFIGURING → A2A WORKING
 *   PCC QUOTED              → A2A INPUT_REQUIRED (quote in artifact)
 *   PCC REVIEWING           → A2A WORKING
 *   PCC COMMITTED           → A2A COMPLETED (escrow/job in artifact)
 *   PCC EXPIRED/CANCELLED   → A2A FAILED / CANCELED
 *
 * In-flight A2A tasks live in an in-memory map keyed by A2A task ID, with
 * a TTL matching the NegotiationSession TTL (30 min). Persistence is out
 * of scope for this branch — a NATS-backed task store will land later.
 *
 * Auth: A2A Bearer scheme reuses PCC's API-key middleware. Unauthed calls
 * return JSON-RPC error -32600 (Invalid Request).
 *
 * Telemetry: every tasks/send for pcc-quote/pcc-submit publishes an
 * `intent.atomic_session` event onto the gateway event bus (Phase 1
 * demand-intel hook).
 */

import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { getStore } from "../db.js";
import { schema, eq } from "@pcc/store";
import { getTemplate, TemplateResolver } from "@pcc/contract-builder";
import { applyPricingRules } from "@pcc/kernel";
import {
  DEFAULT_OPERATOR_POLICY,
  SESSION_TTL_MS,
  computeCompositionSignature,
  budgetToBand,
} from "@pcc/spec";
import type {
  OperatorPolicy,
  SessionStatus,
  SessionTransition,
  DemandEnvelope,
} from "@pcc/spec";
import { getCapabilityFacade, getKernelFacade } from "../facades/index.js";
import { getEventBus } from "../services/event-bus.js";
import { createJobFromSession } from "./paid-job-flow.js";
import { resolveApiKey } from "../auth/api-key-auth.js";
import { resolveSession } from "../auth/siwe-auth.js";
import {
  attachChannel,
  getChannelsByOperator,
  serializeAvailability,
  autoRegisterA2aChannel,
  type ChannelInput,
  type ChannelRecord,
  type AvailabilityRecord,
} from "./operator-channels.js";
import { getCsdRegistry } from "./csd.js";

const { negotiationSessions, operatorPolicies, evidenceBundles, jobs, escrows, escrowMilestones } = schema;

const resolver = new TemplateResolver();

// ── A2A v1.0 task state ──────────────────────────────────────────────────────

export type A2ATaskState =
  | "SUBMITTED"
  | "WORKING"
  | "INPUT_REQUIRED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELED";

export interface A2AArtifact {
  type: string;
  data: unknown;
  description?: string;
}

export interface A2ATask {
  id: string;
  state: A2ATaskState;
  artifacts: A2AArtifact[];
  pccSessionId?: string;
  pccJobId?: string;
  pccEscrowId?: string;
  skill: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  errorMessage?: string;
}

// ── In-memory task store (TTL = SESSION_TTL_MS) ──────────────────────────────

const a2aTasks = new Map<string, A2ATask>();

function pruneExpired(): void {
  const nowMs = Date.now();
  for (const [id, task] of a2aTasks.entries()) {
    if (new Date(task.expiresAt).getTime() < nowMs) {
      a2aTasks.delete(id);
    }
  }
}

function newTaskId(): string {
  return `a2a-task-${crypto.randomUUID()}`;
}

// ── PCC SessionStatus → A2A state mapping ────────────────────────────────────

function pccStatusToA2A(status: SessionStatus): A2ATaskState {
  switch (status) {
    case "created":
    case "configuring":
    case "reviewing":
      return "WORKING";
    case "quoted":
      return "INPUT_REQUIRED";
    case "committed":
      return "COMPLETED";
    case "expired":
      return "FAILED";
    case "cancelled":
      return "CANCELED";
    default:
      return "WORKING";
  }
}

// ── JSON-RPC 2.0 helpers ─────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

function rpcSuccess(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function isJsonRpcRequest(body: unknown): body is JsonRpcRequest {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return b.jsonrpc === "2.0" && typeof b.method === "string";
}

// ── Skill handlers ───────────────────────────────────────────────────────────

interface PccQuoteParams {
  userAgentId?: string;
  kernelId?: string;
  capabilityType?: string;
  capabilityId?: string;
  selections?: Record<string, unknown>;
  network?: string;
}

interface PccSubmitParams extends PccQuoteParams {}

interface PccDiscoverParams {
  capabilityType?: string;
  kernelId?: string;
  query?: string;
}

interface PccVerifyParams {
  jobId?: string;
}

interface PccSettleParams {
  escrowId?: string;
  milestoneIndex?: number;
}

async function handlePccDiscover(params: PccDiscoverParams): Promise<A2AArtifact[]> {
  const facade = getCapabilityFacade();
  if (params.query) {
    const r = await facade.search({ query: params.query });
    return [
      {
        type: "pcc.capability_list",
        description: `Search results for "${params.query}"`,
        data: r.success ? r.data : { error: r.error.message },
      },
    ];
  }
  if (params.capabilityType) {
    const r = await facade.listByType(params.capabilityType);
    return [
      {
        type: "pcc.capability_list",
        description: `Capabilities of type ${params.capabilityType}`,
        data: r.success ? r.data : { error: r.error.message },
      },
    ];
  }
  if (params.kernelId) {
    const r = await facade.listByKernel(params.kernelId);
    return [
      {
        type: "pcc.capability_list",
        description: `Capabilities offered by kernel ${params.kernelId}`,
        data: r.success ? r.data : { error: r.error.message },
      },
    ];
  }
  const r = await facade.list({}, { limit: 50 });
  return [
    {
      type: "pcc.capability_list",
      description: "All capabilities (first 50)",
      data: r.success ? r.data : { error: r.error.message },
    },
  ];
}

async function createPccQuote(
  params: PccQuoteParams,
): Promise<{ sessionId: string; status: SessionStatus; quote: unknown; artifacts: A2AArtifact[] }> {
  if (!params.userAgentId || !params.kernelId || !params.capabilityType) {
    throw new Error("userAgentId, kernelId, and capabilityType are required");
  }

  const { db } = getStore();
  const now = new Date();

  const policyRow = db
    .select()
    .from(operatorPolicies)
    .where(eq(operatorPolicies.kernelId, params.kernelId))
    .get();
  const policy = (policyRow?.policy ?? DEFAULT_OPERATOR_POLICY) as unknown as OperatorPolicy;
  if (policy.emergencyStop) {
    throw new Error("Operator has activated emergency stop");
  }

  const template = getTemplate(params.capabilityType);
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
  const selections = params.selections ?? {};

  db.insert(negotiationSessions).values({
    id: sessionId,
    status: "created" as SessionStatus,
    userAgentId: params.userAgentId,
    kernelId: params.kernelId,
    capabilityType: params.capabilityType,
    capabilityId: params.capabilityId ?? null,
    network: params.network ?? null,
    selections,
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
      actor: params.userAgentId,
      reason: "Session created via A2A tasks/send pcc-quote",
    }],
    createdAt: now.toISOString(),
    expiresAt,
    committedAt: null,
  } as any).run();

  const basePrice = template?.basePricingHints?.basePrice
    ? parseFloat(template.basePricingHints.basePrice)
    : 10;
  const quantity = (selections.quantity as number) ?? 1;
  const { adjustedPrice, adjustments } = applyPricingRules(
    basePrice * quantity,
    policy.pricingRules.filter((r) => r.enabled),
  );
  const evidenceTier = selections.evidenceTier;
  const assuranceTier =
    evidenceTier === "full" ? 2 : evidenceTier === "basic" ? 1 : 0;
  const bondPercent = policy.bondPercentOverride || [0, 5, 15, 25][assuranceTier] || 0;
  const challengeWindowSeconds =
    policy.challengeWindowOverride || [0, 3600, 7200, 14400][assuranceTier] || 3600;

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

  const resolvedOptions = template ? resolver.resolve(template, selections) : null;

  const quoteTransitions = [
    {
      from: "created" as const,
      to: "configuring" as const,
      timestamp: new Date().toISOString(),
      actor: "system",
      reason: "A2A tasks/send pcc-quote drove session to QUOTED",
    },
    {
      from: "configuring" as const,
      to: "quoted" as const,
      timestamp: new Date().toISOString(),
      actor: "system",
      reason: `Quote computed: ${quote.totalPrice} ${quote.currency}`,
    },
  ];

  db.update(negotiationSessions)
    .set({
      status: "quoted",
      quote: quote as any,
      scheduling: scheduling as any,
      transitions: quoteTransitions as any,
    })
    .where(eq(negotiationSessions.id, sessionId))
    .run();

  return {
    sessionId,
    status: "quoted",
    quote,
    artifacts: [
      {
        type: "pcc.quote",
        description: `Quote for ${params.capabilityType} on ${params.kernelId}`,
        data: { sessionId, quote, scheduling, resolvedOptions },
      },
    ],
  };
}

async function commitPccSession(
  sessionId: string,
): Promise<{ status: SessionStatus; artifacts: A2AArtifact[] }> {
  const { db } = getStore();
  const row = db
    .select()
    .from(negotiationSessions)
    .where(eq(negotiationSessions.id, sessionId))
    .get();
  if (!row) throw new Error(`Session ${sessionId} not found`);
  if (row.status === "committed") {
    return {
      status: "committed",
      artifacts: [
        {
          type: "pcc.commit",
          description: "Session was already committed",
          data: { sessionId, jobId: row.jobId, cwmId: row.cwmId, escrowAddress: row.escrowAddress },
        },
      ],
    };
  }
  if (!row.quote) throw new Error("Session has no quote; call pcc-quote first");

  const quote = row.quote as any;
  const stepId = `step-${crypto.randomUUID().slice(0, 8)}`;
  const contractTerms = {
    milestones: [
      {
        stepId,
        amount: quote.totalPrice,
        bondAmount: quote.bondAmount,
        challengeWindowSeconds: quote.challengeWindowSeconds,
      },
    ],
    deadline: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    assuranceTier: quote.bondAmount === "0.00" ? 0 : parseFloat(quote.bondAmount) > 5 ? 2 : 1,
    payer: "0x0000000000000000000000000000000000000000",
    operator: "0x0000000000000000000000000000000000000000",
    token: "0x6c7ce5d5decee9983feaa3e637ea3fe3e6945cdb",
  };

  const jobId = `job-${crypto.randomUUID().slice(0, 12)}`;
  const cwmId = `cwm-${crypto.randomUUID().slice(0, 12)}`;
  const now = new Date().toISOString();

  const transitions = [
    ...(row.transitions as unknown as SessionTransition[]),
    {
      from: row.status,
      to: "reviewing" as const,
      timestamp: now,
      actor: "system",
      reason: "A2A pcc-submit auto-generated contract terms",
    },
    {
      from: "reviewing" as const,
      to: "committed" as const,
      timestamp: now,
      actor: row.userAgentId,
      reason: `A2A pcc-submit committed with job ${jobId}`,
    },
  ];

  db.update(negotiationSessions)
    .set({
      status: "committed",
      contractTerms: contractTerms as any,
      jobId,
      cwmId,
      committedAt: now,
      transitions: transitions as any,
    })
    .where(eq(negotiationSessions.id, sessionId))
    .run();

  let paidJob: {
    jobId: string;
    scopeId: string;
    escrowId: string;
    escrowAddress: string;
    escrowStatus: string;
  } | null = null;
  try {
    const committedRow = db
      .select()
      .from(negotiationSessions)
      .where(eq(negotiationSessions.id, sessionId))
      .get();
    if (committedRow) paidJob = await createJobFromSession(committedRow);
  } catch {
    // best-effort
  }

  return {
    status: "committed",
    artifacts: [
      {
        type: "pcc.commit",
        description: "Session committed; job, escrow, and execution scope created",
        data: {
          sessionId,
          jobId: paidJob?.jobId ?? jobId,
          cwmId,
          scopeId: paidJob?.scopeId ?? null,
          escrowId: paidJob?.escrowId ?? null,
          escrowAddress: paidJob?.escrowAddress ?? null,
          escrowStatus: paidJob?.escrowStatus ?? null,
        },
      },
    ],
  };
}

async function handlePccVerify(params: PccVerifyParams): Promise<A2AArtifact[]> {
  if (!params.jobId) throw new Error("jobId required for pcc-verify");
  try {
    const { db } = getStore();
    const rows = db
      .select()
      .from(evidenceBundles)
      .where(eq(evidenceBundles.jobId, params.jobId))
      .all();
    const jobRow = db.select().from(jobs).where(eq(jobs.id, params.jobId)).get();
    return [
      {
        type: "pcc.evidence",
        description: `Evidence bundles for job ${params.jobId}`,
        data: {
          jobId: params.jobId,
          jobStatus: jobRow?.status ?? "unknown",
          bundleCount: rows.length,
          bundles: rows,
        },
      },
    ];
  } catch (err) {
    return [
      {
        type: "pcc.evidence",
        description: `Evidence lookup failed for job ${params.jobId}`,
        data: { error: err instanceof Error ? err.message : String(err) },
      },
    ];
  }
}

async function handlePccSettle(params: PccSettleParams): Promise<A2AArtifact[]> {
  if (!params.escrowId) throw new Error("escrowId required for pcc-settle");

  // Per Task 4 scope: post a settle intent. The real on-chain release
  // happens via the operator dashboard so the public A2A path never
  // touches a wallet directly. We DO look up the escrow + milestone so
  // the agent learns immediately whether the ID is valid and what state
  // the escrow is in (e.g. already funded vs already completed).
  const milestoneIndex = params.milestoneIndex ?? 0;
  let escrowState: string | null = null;
  let milestoneState: string | null = null;
  let escrowError: string | null = null;
  try {
    const { db } = getStore();
    const escrowRow = db
      .select()
      .from(escrows)
      .where(eq(escrows.id, params.escrowId))
      .get();
    if (!escrowRow) {
      // Try lookup by contract address too — agents commonly hold an
      // 0x… address from a prior pcc-submit artifact.
      const byAddr = db
        .select()
        .from(escrows)
        .where(eq(escrows.contractAddress, params.escrowId))
        .get();
      if (!byAddr) {
        escrowError = `escrow ${params.escrowId} not found`;
      } else {
        escrowState = byAddr.status;
      }
    } else {
      escrowState = escrowRow.status;
      const milestones = db
        .select()
        .from(escrowMilestones)
        .where(eq(escrowMilestones.escrowId, escrowRow.id))
        .all();
      milestoneState = milestones[milestoneIndex]?.status ?? null;
    }
  } catch (err) {
    escrowError = err instanceof Error ? err.message : String(err);
  }

  return [
    {
      type: "pcc.settle_intent",
      description: escrowError
        ? `Settle intent rejected — ${escrowError}`
        : "Settle intent posted — final on-chain release happens via the operator dashboard",
      data: {
        escrowId: params.escrowId,
        milestoneIndex,
        escrowState,
        milestoneState,
        status: escrowError ? "rejected" : "pending_operator_action",
        ...(escrowError ? { error: escrowError } : {}),
      },
    },
  ];
}

// ── tasks/send dispatch ──────────────────────────────────────────────────────

// ── pcc-author-integration: operator onboarding in one A2A skill ─────────────

interface PccAuthorIntegrationParams {
  lane?: "machine" | "human";
  name?: string;
  type?: string;
  description?: string;
  operatorAddress?: string;
  location?: { lat: number; lng: number };
  pricing?: { currency?: string; baseCost?: number | string };
  sla?: {
    acceptanceWindowSec: number;
    completionDeadlineSec: number;
    presence?: "available" | "busy" | "offline";
    mode?: "on-demand" | "scheduled" | "recurring";
    onTimeout?: string;
    onDeadlineMiss?: string;
  };
  /**
   * Optional channels — how PCC will notify the operator when a job lands.
   * The operator's onboarding agent fills these in from the setup conversation.
   * Empty/omitted = operator uses the SSE dashboard only ("manual" transport).
   */
  channels?: ChannelInput[];
  /**
   * Optional — the absolute http(s) URL where THIS operator's own agent
   * (the one calling pcc-author-integration, running the PCC agent package)
   * exposes its own A2A `tasks/send`-compatible handler. When present, an
   * "a2a" notification channel is auto-registered (additive alongside any
   * explicit `channels[]`, idempotent on repeat calls — see
   * `autoRegisterA2aChannel` in operator-channels.ts) so this operator
   * starts receiving signed job-offer pings over A2A with no separate
   * pcc-attach-channel call. The agent's PCC-network id is `operatorAddress`
   * (or "a2a-operator" if omitted) — the same identity already used for the
   * kernel registration above.
   */
  agentEndpoint?: string;
  /**
   * Optional availability — when this capability is reachable. Mirrors the
   * envelope pattern from sla: small enum + describe slot for the long tail.
   * Omitted = treated as "always" (24/7) by downstream agents.
   */
  availability?: AvailabilityRecord;
  /**
   * Optional operator slug — defaults to a sanitized form of name. The slug
   * is what scopes the channel records and is what other agents reference.
   */
  operatorSlug?: string;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "operator";
}

const PCC_AAI_GATEWAY_URL = process.env.PCC_GATEWAY_URL ?? "https://capability.network";

/**
 * Onboard an operator end-to-end from a description: register the kernel, publish
 * the capability (with the human-lane accept/deadline SLA), and return the live
 * A2A agent-card URL. Reuses KernelFacade.register + CapabilityFacade.create.
 */
async function handlePccAuthorIntegration(p: PccAuthorIntegrationParams): Promise<A2AArtifact[]> {
  if (!p.name || !p.type) {
    throw new Error("name and type are required for pcc-author-integration");
  }
  const lane = p.lane === "human" ? "human" : "machine";

  const kr = await getKernelFacade().register({
    name: p.name,
    operatorAddress: p.operatorAddress ?? "a2a-operator",
  });
  if (!kr.success) {
    return [{ type: "pcc.author_integration", description: "kernel register failed", data: { error: kr.error.message } }];
  }
  const kernelId = kr.data.kernel.id;

  const cr = await getCapabilityFacade().create({
    kernelId,
    type: p.type,
    name: p.name,
    description: p.description,
    location: p.location ?? { lat: 0, lng: 0 },
    pricing: {
      currency: p.pricing?.currency ?? "USDC",
      baseCost: String(p.pricing?.baseCost ?? 10),
      minimum: "0",
    },
    ...(lane === "human" && p.sla ? { sla: p.sla } : {}),
    ...(p.availability
      ? { availability: serializeAvailability(p.availability) }
      : {}),
  });
  if (!cr.success) {
    return [{ type: "pcc.author_integration", description: "capability publish failed", data: { error: cr.error.message } }];
  }

  // Record CSD adoption: if the capability `type` matches a registered CSD,
  // bump that CSD's usage counter so the marketplace data layer reflects
  // who's adopting which templates. Silent no-op if no CSD matches.
  const csdRegistry = getCsdRegistry();
  const adoptedCsdUrl = csdRegistry.findUrlByType(p.type);
  if (adoptedCsdUrl) {
    csdRegistry.recordUsage(adoptedCsdUrl, p.operatorAddress ?? "a2a-operator");
  }

  // Attach any channels the operator's onboarding agent passed in. This is
  // the wire-protocol slot — how PCC will ping the operator when a job lands.
  // Operator slug defaults to a sanitized form of name so the same agent can
  // attach more channels later without us having to mint a separate id.
  const operatorSlug = p.operatorSlug ?? slugify(p.name);
  const attached: ChannelRecord[] = [];
  const channelErrors: Array<{ index: number; error: string }> = [];
  if (Array.isArray(p.channels) && p.channels.length > 0) {
    for (let i = 0; i < p.channels.length; i++) {
      try {
        attached.push(attachChannel(operatorSlug, p.channels[i]!));
      } catch (e) {
        channelErrors.push({ index: i, error: (e as Error).message });
      }
    }
  }

  // Auto-register the A2A notification channel for this operator's OWN
  // agent (the one making this very call) — the "operator sets up their
  // hook" point in onboarding. Additive alongside any explicit channels[]
  // above and idempotent on repeat registrations (autoRegisterA2aChannel);
  // never blocks onboarding if agentEndpoint is malformed (returns null).
  const a2aChannel = p.agentEndpoint
    ? autoRegisterA2aChannel(operatorSlug, p.operatorAddress ?? "a2a-operator", p.agentEndpoint)
    : null;
  if (a2aChannel && !attached.some((c) => c.id === a2aChannel.id)) {
    attached.push(a2aChannel);
  }

  const agentCardUrl = `${PCC_AAI_GATEWAY_URL}/api/kernels/${kernelId}/agent-card.json`;
  return [{
    type: "pcc.author_integration",
    description: `Published "${p.type}" on kernel ${kernelId} — live as an A2A agent`,
    data: {
      lane,
      kernelId,
      operatorSlug,
      capability: cr.data.capability,
      created: cr.data.created,
      channelsAttached: attached.length,
      channels: attached,
      ...(channelErrors.length ? { channelErrors } : {}),
      a2aChannelRegistered: !!a2aChannel,
      availability: p.availability ?? null,
      agentCardUrl,
      proveNext: lane === "machine"
        ? "POST /api/setup/test-job { kernelId, deviceId, assuranceTier } to prove + auto-activate"
        : "POST /api/onboard/registrations/:id/prove { evidence: photo + GPS } to activate at Tier 1",
      attachMoreChannels: `tasks/send { skill: "pcc-attach-channel", params: { operatorSlug: "${operatorSlug}", ... } }`,
    },
  }];
}

// ── pcc-suggest-templates: bidirectional onboarding ─────────────────────────

interface PccSuggestTemplatesParams {
  /** Free-form description of what the user is trying to set up. */
  description?: string;
  /** Alias for description — accepts either, agents can use whichever feels natural. */
  query?: string;
  /** Max results. Default 5, clamped to [1, 20]. */
  limit?: number;
  /** Optional kind filter: base | profile | extension | workflow. */
  kind?: "base" | "profile" | "extension" | "workflow";
}

/**
 * The registry talks back. A user's agent says "I'm setting up a same-day
 * courier" or "I have an Opentrons OT-2 I want to publish" or "I want to
 * sell wood-fired Neapolitan pizza" — the registry returns N candidate CSD
 * templates the agent can then pass into pcc-author-integration.
 *
 * This is the opposite direction of pcc-author-integration: that one is the
 * user's agent pushing data INTO PCC; this one is the registry handing
 * candidate templates BACK to the user's agent. Together they make the
 * onboarding conversation conversational on both sides.
 *
 * Scoring is cheap keyword overlap today — name tokens (×3) + tag tokens
 * (×2) + description tokens (×1), tied broken by usage. Swap in graph search
 * or embeddings later without changing the skill surface.
 */
async function handlePccSuggestTemplates(p: PccSuggestTemplatesParams): Promise<A2AArtifact[]> {
  const query = p.description ?? p.query ?? "";
  const limit = Math.min(20, Math.max(1, p.limit ?? 5));
  const registry = getCsdRegistry();
  const suggestions = registry.suggest(query, {
    limit,
    kind: p.kind,
  });
  return [{
    type: "pcc.suggest_templates",
    description: suggestions.length === 0
      ? `No matching templates for "${query}" — the user's agent can register a new CSD via POST /api/csd or proceed without a template.`
      : `${suggestions.length} candidate template${suggestions.length === 1 ? "" : "s"} for "${query}"`,
    data: {
      query,
      kind: p.kind ?? null,
      suggestions: suggestions.map((s) => ({
        url: s.csd.url,
        name: s.csd.name,
        kind: s.csd.kind,
        description: s.csd.description,
        type: (s.csd as Record<string, unknown>).type,
        relevanceScore: s.score,
        usage: s.usage,
      })),
      nextStep: suggestions.length === 0
        ? "POST /a2a/tasks/send { skill: 'pcc-author-integration', params: { ... } } — no template; user's agent defines the capability inline"
        : "POST /a2a/tasks/send { skill: 'pcc-author-integration', params: { type: <pick a template's type>, ...overrides } } — pass the chosen template's type to adopt it (this bumps its usage counter)",
    },
  }];
}

// ── pcc-attach-channel: add a notification/dispatch channel to an operator ───

interface PccAttachChannelParams {
  operatorSlug?: string;
  channels?: ChannelInput[];
  /** Single-channel shorthand — same fields as one entry of channels[]. */
  label?: string;
  transport?: ChannelInput["transport"];
  direction?: ChannelInput["direction"];
  endpoint?: Record<string, unknown>;
  credentialRef?: string;
  describe?: string;
  replyContract?: string;
  enabled?: boolean;
}

/**
 * Attach one or more channels to an existing operator slug. Callable as a
 * standalone A2A skill so an operator's onboarding agent can add new
 * channels at any time without going back through pcc-author-integration.
 *
 * Two input shapes accepted:
 *   - { operatorSlug, channels: [ChannelInput, ...] }  (batch)
 *   - { operatorSlug, label, transport, describe, ... } (single, shorthand)
 */
async function handlePccAttachChannel(p: PccAttachChannelParams): Promise<A2AArtifact[]> {
  if (!p.operatorSlug) {
    throw new Error("operatorSlug is required for pcc-attach-channel");
  }
  const inputs: ChannelInput[] = Array.isArray(p.channels) && p.channels.length > 0
    ? p.channels
    : (p.transport && p.label && p.describe
        ? [{
            label: p.label,
            transport: p.transport,
            direction: p.direction,
            endpoint: p.endpoint,
            credentialRef: p.credentialRef,
            describe: p.describe,
            replyContract: p.replyContract,
            enabled: p.enabled,
          }]
        : []);
  if (inputs.length === 0) {
    throw new Error(
      "pcc-attach-channel needs either channels: [...] or single-channel shorthand (label, transport, describe required)",
    );
  }
  const attached: ChannelRecord[] = [];
  const errors: Array<{ index: number; error: string }> = [];
  for (let i = 0; i < inputs.length; i++) {
    try {
      attached.push(attachChannel(p.operatorSlug, inputs[i]!));
    } catch (e) {
      errors.push({ index: i, error: (e as Error).message });
    }
  }
  return [{
    type: "pcc.attach_channel",
    description: `Attached ${attached.length} channel(s) to operator ${p.operatorSlug}`,
    data: {
      operatorSlug: p.operatorSlug,
      attached,
      totalChannelsNow: getChannelsByOperator(p.operatorSlug).length,
      ...(errors.length ? { errors } : {}),
      testDispatch: `POST /api/operators/${p.operatorSlug}/channels/test — fire a synthetic job at every enabled channel to verify`,
    },
  }];
}

async function dispatchTasksSend(
  rpcId: string | number | null,
  params: Record<string, unknown>,
): Promise<JsonRpcSuccess | JsonRpcError> {
  pruneExpired();
  const skill = (params.skill ?? params.skillId) as string | undefined;
  const skillParams = (params.params ?? params.input ?? {}) as Record<string, unknown>;
  const userAgentId = (skillParams.userAgentId as string | undefined) ?? "a2a-anonymous";

  if (!skill) {
    return rpcError(rpcId, -32602, "Invalid params: 'skill' is required");
  }

  const taskId = newTaskId();
  const nowMs = Date.now();
  const baseTask: A2ATask = {
    id: taskId,
    state: "SUBMITTED",
    artifacts: [],
    skill,
    createdAt: new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + SESSION_TTL_MS).toISOString(),
  };

  try {
    switch (skill) {
      case "pcc-discover": {
        const artifacts = await handlePccDiscover(skillParams as PccDiscoverParams);
        const task: A2ATask = {
          ...baseTask,
          state: "COMPLETED",
          artifacts,
          updatedAt: new Date().toISOString(),
        };
        a2aTasks.set(taskId, task);
        return rpcSuccess(rpcId, task);
      }

      case "pcc-quote": {
        const result = await createPccQuote(skillParams as PccQuoteParams);
        emitAtomicSessionIntent(skillParams as PccQuoteParams, userAgentId);
        const task: A2ATask = {
          ...baseTask,
          state: pccStatusToA2A(result.status),
          artifacts: result.artifacts,
          pccSessionId: result.sessionId,
          updatedAt: new Date().toISOString(),
        };
        a2aTasks.set(taskId, task);
        return rpcSuccess(rpcId, task);
      }

      case "pcc-submit": {
        const quote = await createPccQuote(skillParams as PccSubmitParams);
        const commit = await commitPccSession(quote.sessionId);
        emitAtomicSessionIntent(skillParams as PccSubmitParams, userAgentId);
        const task: A2ATask = {
          ...baseTask,
          state: pccStatusToA2A(commit.status),
          artifacts: [...quote.artifacts, ...commit.artifacts],
          pccSessionId: quote.sessionId,
          updatedAt: new Date().toISOString(),
        };
        a2aTasks.set(taskId, task);
        return rpcSuccess(rpcId, task);
      }

      case "pcc-verify": {
        const artifacts = await handlePccVerify(skillParams as PccVerifyParams);
        const task: A2ATask = {
          ...baseTask,
          state: "COMPLETED",
          artifacts,
          pccJobId: (skillParams as PccVerifyParams).jobId,
          updatedAt: new Date().toISOString(),
        };
        a2aTasks.set(taskId, task);
        return rpcSuccess(rpcId, task);
      }

      case "pcc-settle": {
        const artifacts = await handlePccSettle(skillParams as PccSettleParams);
        // If the settle artifact carries a rejection, surface as FAILED so
        // the A2A caller doesn't keep polling tasks/get forever.
        const settleArtifact = artifacts[0]?.data as { status?: string } | undefined;
        const settleState: A2ATaskState =
          settleArtifact?.status === "rejected" ? "FAILED" : "WORKING";
        const task: A2ATask = {
          ...baseTask,
          state: settleState,
          artifacts,
          pccEscrowId: (skillParams as PccSettleParams).escrowId,
          updatedAt: new Date().toISOString(),
          ...(settleState === "FAILED"
            ? { errorMessage: "Escrow lookup failed; settlement not posted" }
            : {}),
        };
        a2aTasks.set(taskId, task);
        return rpcSuccess(rpcId, task);
      }

      case "pcc-author-integration": {
        const artifacts = await handlePccAuthorIntegration(skillParams as PccAuthorIntegrationParams);
        const task: A2ATask = {
          ...baseTask,
          state: "COMPLETED",
          artifacts,
          updatedAt: new Date().toISOString(),
        };
        a2aTasks.set(taskId, task);
        return rpcSuccess(rpcId, task);
      }

      case "pcc-attach-channel": {
        const artifacts = await handlePccAttachChannel(skillParams as PccAttachChannelParams);
        const task: A2ATask = {
          ...baseTask,
          state: "COMPLETED",
          artifacts,
          updatedAt: new Date().toISOString(),
        };
        a2aTasks.set(taskId, task);
        return rpcSuccess(rpcId, task);
      }

      case "pcc-suggest-templates": {
        const artifacts = await handlePccSuggestTemplates(skillParams as PccSuggestTemplatesParams);
        const task: A2ATask = {
          ...baseTask,
          state: "COMPLETED",
          artifacts,
          updatedAt: new Date().toISOString(),
        };
        a2aTasks.set(taskId, task);
        return rpcSuccess(rpcId, task);
      }

      default:
        return rpcError(rpcId, -32602, `Unknown skill: ${skill}`, { skill });
    }
  } catch (err) {
    return rpcError(
      rpcId,
      -32603,
      err instanceof Error ? err.message : "Internal error",
      { skill },
    );
  }
}

async function dispatchTasksGet(
  rpcId: string | number | null,
  params: Record<string, unknown>,
): Promise<JsonRpcSuccess | JsonRpcError> {
  pruneExpired();
  const taskId = params.id as string | undefined;
  if (!taskId) return rpcError(rpcId, -32602, "Invalid params: 'id' is required");
  const task = a2aTasks.get(taskId);
  if (!task) return rpcError(rpcId, -32001, `Task ${taskId} not found or expired`);

  if (task.pccSessionId) {
    try {
      const { db } = getStore();
      const row = db
        .select()
        .from(negotiationSessions)
        .where(eq(negotiationSessions.id, task.pccSessionId))
        .get();
      if (row) {
        task.state = pccStatusToA2A(row.status as SessionStatus);
        task.updatedAt = new Date().toISOString();
        a2aTasks.set(taskId, task);
      }
    } catch {
      // best-effort live update
    }
  }

  return rpcSuccess(rpcId, task);
}

async function dispatchTasksCancel(
  rpcId: string | number | null,
  params: Record<string, unknown>,
): Promise<JsonRpcSuccess | JsonRpcError> {
  pruneExpired();
  const taskId = params.id as string | undefined;
  if (!taskId) return rpcError(rpcId, -32602, "Invalid params: 'id' is required");
  const task = a2aTasks.get(taskId);
  if (!task) return rpcError(rpcId, -32001, `Task ${taskId} not found or expired`);
  if (task.state === "COMPLETED" || task.state === "FAILED" || task.state === "CANCELED") {
    return rpcSuccess(rpcId, task);
  }

  if (task.pccSessionId) {
    try {
      const { db } = getStore();
      const row = db
        .select()
        .from(negotiationSessions)
        .where(eq(negotiationSessions.id, task.pccSessionId))
        .get();
      if (row && row.status !== "committed") {
        const now = new Date().toISOString();
        const transitions = [
          ...(row.transitions as unknown as SessionTransition[]),
          {
            from: row.status as SessionStatus,
            to: "cancelled" as const,
            timestamp: now,
            actor: "a2a-client",
            reason: "A2A tasks/cancel",
          },
        ];
        db.update(negotiationSessions)
          .set({ status: "cancelled", transitions: transitions as any })
          .where(eq(negotiationSessions.id, task.pccSessionId))
          .run();
      }
    } catch {
      // best-effort
    }
  }

  task.state = "CANCELED";
  task.updatedAt = new Date().toISOString();
  a2aTasks.set(taskId, task);
  return rpcSuccess(rpcId, task);
}

// ── Demand-intel hook ────────────────────────────────────────────────────────

function emitAtomicSessionIntent(
  params: PccQuoteParams,
  userAgentId: string,
): void {
  try {
    if (!params.capabilityType) return;
    const compositionSignature = computeCompositionSignature(
      [params.capabilityType],
      [],
    );
    const envelope: DemandEnvelope = {
      id: `intent-a2a-${crypto.randomUUID()}`,
      source: "a2a_tasks_send",
      compositionSignature,
      capabilityTypes: [params.capabilityType],
      summary: `A2A atomic session for ${params.capabilityType}`.slice(0, 200),
      budgetBand: budgetToBand(0),
      urgencyBand: "standard",
      originAgentId: userAgentId,
      createdAt: new Date().toISOString(),
    };
    getEventBus().publish({
      eventType: "intent.atomic_session",
      category: "intent",
      actorId: userAgentId,
      actorType: "agent",
      resourceType: "intent",
      resourceId: envelope.id,
      payload: envelope as unknown as Record<string, unknown>,
    });
  } catch {
    // best-effort
  }
}

// ── Plugin entry point ───────────────────────────────────────────────────────

export async function a2aTasksRoutes(app: FastifyInstance) {
  app.post("/a2a/tasks/send", async (req, reply: FastifyReply) => {
    const body = req.body as unknown;

    if (!isJsonRpcRequest(body)) {
      return reply.status(200).send(
        rpcError(null, -32600, "Invalid JSON-RPC 2.0 request"),
      );
    }

    const rpcId = body.id ?? null;

    // /a2a/* is NOT under /api/, so apiGate didn't run. Resolve auth here
    // using the same primitives. Tests can opt out by setting
    // PCC_A2A_AUTH_DISABLED=true.
    if (process.env.PCC_A2A_AUTH_DISABLED !== "true") {
      const apiKey = resolveApiKey(req);
      const session = !apiKey ? resolveSession(req) : null;
      if (!apiKey && !session) {
        return reply.status(200).send(
          rpcError(
            rpcId,
            -32600,
            "Invalid Request: authentication required (Authorization: Bearer pcc_live_...)",
          ),
        );
      }
    }

    const method = body.method;
    const params = (body.params ?? {}) as Record<string, unknown>;

    let result: JsonRpcSuccess | JsonRpcError;
    switch (method) {
      case "tasks/send":
        result = await dispatchTasksSend(rpcId, params);
        break;
      case "tasks/get":
        result = await dispatchTasksGet(rpcId, params);
        break;
      case "tasks/cancel":
        result = await dispatchTasksCancel(rpcId, params);
        break;
      default:
        result = rpcError(rpcId, -32601, `Method not found: ${method}`);
    }

    return reply.status(200).send(result);
  });
}

// Test-only hook for the in-memory store
export function __resetA2ATasksForTest(): void {
  a2aTasks.clear();
}
