import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { MachineRegistration } from "@pcc/spec";
import type { RegistrationRow } from "@pcc/store";
import { UnifiedKeychain } from "@pcc/agent-runtime";
import { auditService, type AuditEntry } from "../services/audit-service.js";
import { pipelineTelemetry } from "../telemetry.js";
import { trackServerEvent } from "../services/posthog-service.js";
import { Sentry } from "../sentry.js";
import { getRepos, getStore } from "../db.js";
import {
  PHOTO_MEDIA_TYPES,
  PROOF_RECORD_PREFIX,
  PROVE_BODY_LIMIT_BYTES,
  buildEvidenceRecord,
  checkEventTimestamps,
  eventsDigest,
  evidenceRecordDigest,
  fabricatedEventIndices,
  getEvidencePhotoStore,
  inspectPhoto,
  isPlainObject,
  isReservedDescription,
  summarizeEvidence,
  validateEvidenceShape,
  type EvidenceRejection,
  type InspectedPhoto,
} from "./onboard-evidence.js";
import {
  analyzeOnboardingText,
  coalesceAnalysisText,
  coalesceSourceDocumentId,
} from "./onboard-analysis.js";
// Wave 4.1 — TENANT_ENFORCE feature flag. Default OFF; when on, the listing
// route filters registrations by req.tenantId (from T1.9 tenantContext
// middleware). The /register handler always backfills tenant_id at insert
// time so once the flag flips, scoped listing yields correct rows without a
// data backfill.
import { tenantOpts } from "../config/tenant-enforce.js";

const GATECRAFT_URL = process.env.GATECRAFT_URL ?? "https://gatecraft-production.up.railway.app";

// Onboarding review authority. /approve, /activate and /reject decide which
// operators are live on the network, so they require the shared admin secret:
// an X-Admin-Key header matching PCC_ADMIN_KEY, the same credential that gates
// admin actions in routes/kernel-marketplace.ts. A caller's operatorId is not
// enough, because /api/auth/provision issues keys for any email or wallet
// without proving ownership, so an identity allowlist could be claimed by
// anyone who knows an admin's address. With PCC_ADMIN_KEY unset, these routes
// stay open only when NODE_ENV is "test" or "development"; anything else,
// including an unset NODE_ENV, fails closed.
function isOnboardAdmin(req: FastifyRequest): boolean {
  const expected = process.env.PCC_ADMIN_KEY;
  if (!expected) return process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development";
  const provided = req.headers["x-admin-key"];
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Audit identity for an admin-key action: "admin-key:" + the first 8 hex of
 * sha256(provided key). The key itself is never recorded. "admin-key:none"
 * only occurs where the routes are open (PCC_ADMIN_KEY unset, NODE_ENV test or
 * development) and no key was sent.
 */
function adminAuditIdentity(req: FastifyRequest): { actor: string; adminAuth: "admin-key" | "open-test-dev" } {
  const provided = req.headers["x-admin-key"];
  const actor =
    typeof provided === "string" && provided.length > 0
      ? `admin-key:${createHash("sha256").update(provided).digest("hex").slice(0, 8)}`
      : "admin-key:none";
  return { actor, adminAuth: process.env.PCC_ADMIN_KEY ? "admin-key" : "open-test-dev" };
}

/** The authenticated caller set by the auth middleware, for audit attribution only. */
function requestCaller(req: FastifyRequest): string | null {
  return authenticatedActor(req, ["operatorId", "userId"]);
}

// ── Ownership (steward rule 7: fail closed) ─────────────────────────────
// An owner check needs both an authenticated actor and a registration owner.
// A missing actor is 401 before any lookup; a missing owner (or the zero
// address /register writes when no operator is given) matches nobody.

const ZERO_ADDRESS_RE = /^0x0{40}$/i;

/**
 * The authenticated actor, taking the first non-null field in `fields` (the
 * same precedence as the original `a ?? b ?? ...` chains). An empty or
 * non-string value is not an actor.
 */
function authenticatedActor(req: FastifyRequest, fields: readonly string[]): string | null {
  const r = req as unknown as Record<string, unknown>;
  for (const field of fields) {
    const v = r[field];
    if (v === undefined || v === null) continue;
    return typeof v === "string" && v.length > 0 ? v : null;
  }
  return null;
}

/** The registration's owner identity, or null when it has none that can be matched. */
function registrationOwner(reg: unknown): string | null {
  const r = reg as {
    operator?: { walletAddress?: unknown; email?: unknown } | null;
    walletAddress?: unknown;
    email?: unknown;
    operatorId?: unknown;
  };
  const v = r.operator?.walletAddress ?? r.operator?.email ?? r.walletAddress ?? r.email ?? r.operatorId;
  if (typeof v !== "string" || v.length === 0 || ZERO_ADDRESS_RE.test(v)) return null;
  return v;
}

function sendEvidenceRejection(reply: FastifyReply, r: EvidenceRejection) {
  return reply.status(r.status).send({ error: r.error, message: r.message, ...(r.details ? { details: r.details } : {}) });
}

// ── Review transitions ──────────────────────────────────────────────────
// Allowed from-states per transition, as in #337 (reject: narrowed, see
// below). A handler validates the status it observed against its set, then
// applies the transition as a compare-and-swap pinned to exactly that status,
// inside one immediate transaction together with its audit record. So the
// audit's from -> to is exact, a transition that lost a race gets 409 instead
// of overwriting the winner, and a failed audit write rolls the transition
// back (auditService writes synchronously on the same SQLite connection).
const PROVE_FROM: readonly string[] = ["submitted", "reviewing"];
const APPROVE_FROM: readonly string[] = ["submitted", "reviewing"];
const ACTIVATE_FROM: readonly string[] = ["approved"];
// #337 allowed reject from every status except "rejected". "deleted" (and any
// unknown status) is left out: rejecting a soft-deleted registration would
// overwrite its GDPR deletion record and move it out of "deleted".
const REJECT_FROM: readonly string[] = ["draft", "submitted", "reviewing", "approved", "active", "suspended"];
const REJECT_REASON_MAX_CHARS = 2000;
// The owner may edit the description only before evidence is submitted; after
// that the column holds the server-written review record.
const DESCRIPTION_EDITABLE_STATUSES: readonly string[] = ["draft", "submitted"];

class AuditWriteError extends Error {
  constructor(readonly original: unknown) {
    super("audit write failed");
  }
}

type Repos = ReturnType<typeof getRepos>;

// ── The evidence a transition is bound to ───────────────────────────────
// The description column is operator-writable before review (/register,
// PATCH, the wizard), so a digest parsed out of it could be forged. The
// evidence of record is the latest operator.proof_submitted audit row for
// the registration instead: only /prove writes that event, and only for
// evidence that passed every screen. commitTransition reads it inside the
// transition's transaction, so no proof can land between the read and the
// write.

const PROOF_SUBMITTED_EVENT = "operator.proof_submitted";
const EVIDENCE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

interface LatestProof {
  /** evidenceDigest of the latest proof_submitted row; null when there is none. */
  evidenceDigest: string | null;
  /** audit_log id of that row; null when there is none. */
  auditId: number | null;
}

function latestProof(repos: Repos, registrationId: string): LatestProof {
  const [row] = repos.auditLog.query({
    eventType: PROOF_SUBMITTED_EVENT,
    resourceType: "registration",
    resourceId: registrationId,
    limit: 1,
  });
  if (!row) return { evidenceDigest: null, auditId: null };
  const digest = isPlainObject(row.metadata) ? row.metadata.evidenceDigest : undefined;
  return { evidenceDigest: typeof digest === "string" && EVIDENCE_DIGEST_RE.test(digest) ? digest : null, auditId: row.id };
}

/** What a transition's guard and audit record see, all read in its transaction. */
interface TransitionContext {
  /** The registration as the transaction read it (status === expectedFrom). */
  pre: RegistrationRow;
  /** The latest screened proof for it. */
  proof: LatestProof;
}

type TransitionFailure =
  | { ok: false; kind: "conflict"; currentStatus: string | null }
  | { ok: false; kind: "evidence_changed"; currentEvidenceDigest: string | null }
  | { ok: false; kind: "audit_failed" | "db_error"; error: unknown };
type TransitionOutcome = { ok: true; row: RegistrationRow; pre: RegistrationRow; proof: LatestProof } | TransitionFailure;

/**
 * Apply one status transition atomically with its audit record.
 * `expectedFrom` is the status the handler observed (and already checked
 * against its allowed set); the CAS matches only that status. `guard` runs in
 * the same transaction, after the status check and before the CAS; a failure
 * it returns aborts the transition with nothing written.
 */
function commitTransition(args: {
  id: string;
  expectedFrom: string;
  to: string;
  extra?: { approvedAt?: string; description?: string };
  guard?: (ctx: TransitionContext) => TransitionFailure | null;
  audit: (ctx: TransitionContext & { post: RegistrationRow }) => AuditEntry;
}): TransitionOutcome {
  try {
    return getStore().db.transaction(
      (): TransitionOutcome => {
        const repos = getRepos();
        const pre = repos.registrations.findById(args.id);
        if (!pre) return { ok: false, kind: "conflict", currentStatus: null };
        if (pre.status !== args.expectedFrom) return { ok: false, kind: "conflict", currentStatus: pre.status };
        const ctx: TransitionContext = { pre, proof: latestProof(repos, pre.id) };
        const refused = args.guard?.(ctx) ?? null;
        if (refused) return refused;
        // The CAS itself, kept even though the immediate transaction already
        // excludes every other writer.
        const post = repos.registrations.transitionStatus(args.id, [args.expectedFrom], args.to, args.extra);
        if (!post) return { ok: false, kind: "conflict", currentStatus: pre.status };
        try {
          auditService.logStrict(args.audit({ ...ctx, post }));
        } catch (err) {
          throw new AuditWriteError(err); // rolls the CAS back
        }
        return { ok: true, row: post, pre, proof: ctx.proof };
      },
      { behavior: "immediate" },
    );
  } catch (err) {
    if (err instanceof AuditWriteError) return { ok: false, kind: "audit_failed", error: err.original };
    return { ok: false, kind: "db_error", error: err };
  }
}

/** registrationId, from -> to and the timestamp, as every transition records them. */
function transitionAuditFields(ctx: TransitionContext & { post: RegistrationRow }, at: string): Record<string, unknown> {
  return { registrationId: ctx.pre.id, from: ctx.pre.status, to: ctx.post.status, at };
}

/**
 * The evidence an admin transition acted on: the latest screened proof, from
 * the audit log (never from the description). With no proof on record the
 * digest is null and evidenceVerified is false.
 */
function reviewedEvidenceFields(proof: LatestProof): Record<string, unknown> {
  return { evidenceDigest: proof.evidenceDigest, evidenceVerified: proof.evidenceDigest !== null, proofAuditId: proof.auditId };
}

/** What an admin sends as expectedEvidenceDigest for a registration with no proof on record. */
const NO_EVIDENCE = "none";

/**
 * True when `expected` (from the admin) names the latest screened proof:
 * its digest, or NO_EVIDENCE when no proof was ever recorded. A proof row
 * without a well-formed digest matches nothing, so it cannot be approved.
 */
function reviewedEvidenceMatches(proof: LatestProof, expected: string): boolean {
  if (proof.auditId === null) return expected === NO_EVIDENCE;
  return proof.evidenceDigest !== null && expected === proof.evidenceDigest;
}

/** Which transition failed, for messages: `verb` ("approve") and `noun` ("approval"). */
interface TransitionLabel {
  verb: string;
  noun: string;
}
const APPROVE_LABEL: TransitionLabel = { verb: "approve", noun: "approval" };
const REJECT_LABEL: TransitionLabel = { verb: "reject", noun: "rejection" };
const ACTIVATE_LABEL: TransitionLabel = { verb: "activate", noun: "activation" };
const PROVE_LABEL: TransitionLabel = { verb: "submit evidence for", noun: "evidence submission" };

function sendTransitionFailure(req: FastifyRequest, reply: FastifyReply, failure: TransitionFailure, label: TransitionLabel) {
  if (failure.kind === "conflict") {
    return reply.status(409).send({
      error: "invalid_transition",
      message: `Cannot ${label.verb} this registration from its current status (${failure.currentStatus ?? "missing"}).`,
      currentStatus: failure.currentStatus,
    });
  }
  if (failure.kind === "evidence_changed") {
    return reply.status(409).send({
      error: "evidence_changed",
      message:
        `The evidence on record is not the evidence you reviewed, so nothing was changed. ` +
        `Review the current evidence, then ${label.verb} with its evidenceDigest.`,
      currentEvidenceDigest: failure.currentEvidenceDigest,
    });
  }
  req.log.error({ err: failure.error }, `[onboard] ${label.noun} rolled back (${failure.kind})`);
  Sentry.captureException(failure.error, { extra: { transition: label.noun, failure: failure.kind, url: req.url } });
  if (failure.kind === "audit_failed") {
    return reply.status(500).send({
      error: "audit_write_failed",
      message: `The ${label.noun} was rolled back because its audit record could not be written.`,
    });
  }
  return reply.status(500).send({ error: "transition_failed", message: `The ${label.noun} could not be applied.` });
}

export async function onboardRoutes(app: FastifyInstance) {
  // Analyze an operator/machine description and return an input-derived
  // capability analysis. Routes through the same agentic path as the live v3
  // onboard-chat endpoint (an Anthropic model primed with PCC capability
  // context), with a deterministic keyword-classifier fallback when no
  // ANTHROPIC_API_KEY is set. See routes/onboard-analysis.ts.
  //
  // This replaced a stub that returned hardcoded FDM 3D-printer specs for
  // every input — a rideshare description now yields a rideshare analysis,
  // not build-volume + nozzle temps + PLA.
  app.post("/api/onboard/analyze", async (req, reply) => {
    const text = coalesceAnalysisText(req.body);
    if (!text) {
      return reply.status(400).send({
        error: "text_required",
        message:
          "Provide the operator or machine description to analyze. Send { text } " +
          "(also accepts description / content / documentText / documents[]).",
      });
    }

    try {
      const sourceDocumentId = coalesceSourceDocumentId(req.body);
      const { analysis, mode, warning } = await analyzeOnboardingText(text, { sourceDocumentId });
      trackServerEvent("document_analyzed", {
        mode,
        type: analysis.suggestedCapabilities[0]?.type ?? "unknown",
      });
      return { status: "ok", analysis, mode, ...(warning ? { warning } : {}) };
    } catch (e) {
      req.log.error(e, "[onboard] analyze failed");
      return reply.status(500).send({
        error: "analysis_failed",
        message: (e as Error).message,
      });
    }
  });

  // Submit machine registration
  app.post("/api/onboard/register", async (req, reply) => {
    const body = (req.body ?? {}) as Partial<MachineRegistration>;
    // A registration's description is operator text until evidence is
    // submitted; the "PROOF SUBMITTED:" record format is reserved for the
    // server, so a forged record can never reach an admin reviewing "submitted".
    if (isReservedDescription(body.description)) {
      return reply.status(400).send({
        error: "reserved_description",
        message: "Descriptions starting with \"PROOF SUBMITTED:\" or \"PROVED:\" are reserved for server-written review records.",
      });
    }
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
      // Wave 4.1 — backfill tenant_id from the authenticated principal at
      // write time. Anonymous registers (no auth, no tenant) get null, which
      // means "public-discovery" — these rows surface to anonymous callers
      // even after TENANT_ENFORCE flips on.
      const tenantIdAtWrite = (req as any).tenantId ?? null;
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
        tenantId: tenantIdAtWrite,
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
      // Wave 4.1 — when TENANT_ENFORCE is on, scope rows to req.tenantId
      // (set by T1.9 tenantContext middleware from API key operatorId or
      // SIWE wallet). When OFF (default), tenantOpts returns undefined and
      // the repo behaves as it does today (cross-tenant read, sanitised).
      const opts = tenantOpts(req);
      const registrations = repos.registrations.findAll(opts);
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

  // ── Approve a registration (admin key required) ──
  // The approval is bound to the evidence the admin reviewed (M2): the body
  // must carry expectedEvidenceDigest, the evidenceDigest of the review record
  // the admin looked at, or "none" for a registration with no submitted
  // evidence. It is compared with the latest screened proof inside the
  // transition's transaction, so an owner who re-proves between the admin's
  // read and this call gets 409 evidence_changed and nothing is approved.
  app.post<{ Params: { id: string } }>("/api/onboard/registrations/:id/approve", async (req, reply) => {
    // Checked before the lookup so a non-admin learns nothing about which ids exist.
    if (!isOnboardAdmin(req)) {
      return reply.status(403).send({ error: "forbidden", message: "Approving a registration requires the admin key" });
    }
    const expectedEvidenceDigest = isPlainObject(req.body) ? req.body.expectedEvidenceDigest : undefined;
    if (typeof expectedEvidenceDigest !== "string") {
      return reply.status(400).send({
        error: "expected_evidence_digest_required",
        message:
          `Send expectedEvidenceDigest: the evidenceDigest of the review record you approved, ` +
          `or "${NO_EVIDENCE}" for a registration with no submitted evidence.`,
      });
    }
    const reg = getRepos().registrations.findById(req.params.id);
    if (!reg) return reply.status(404).send({ error: "not_found" });
    if (!APPROVE_FROM.includes(reg.status)) {
      return sendTransitionFailure(req, reply, { ok: false, kind: "conflict", currentStatus: reg.status }, APPROVE_LABEL);
    }
    const at = new Date().toISOString();
    const admin = adminAuditIdentity(req);
    const outcome = commitTransition({
      id: reg.id,
      expectedFrom: reg.status,
      to: "approved",
      extra: { approvedAt: at },
      guard: ({ proof }) =>
        reviewedEvidenceMatches(proof, expectedEvidenceDigest)
          ? null
          : { ok: false, kind: "evidence_changed", currentEvidenceDigest: proof.evidenceDigest },
      audit: (ctx) => ({
        eventType: "operator.approved",
        actor: admin.actor,
        resourceType: "registration",
        resourceId: ctx.pre.id,
        action: "approve",
        metadata: {
          ...transitionAuditFields(ctx, at),
          ...reviewedEvidenceFields(ctx.proof),
          expectedEvidenceDigest,
          name: ctx.pre.name,
          adminAuth: admin.adminAuth,
          caller: requestCaller(req),
        },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      }),
    });
    if (!outcome.ok) return sendTransitionFailure(req, reply, outcome, APPROVE_LABEL);
    return { registration: outcome.row, approved: true };
  });

  // ── Reject a registration (admin key required) ──
  app.post<{ Params: { id: string } }>("/api/onboard/registrations/:id/reject", async (req, reply) => {
    if (!isOnboardAdmin(req)) {
      return reply.status(403).send({ error: "forbidden", message: "Rejecting a registration requires the admin key" });
    }
    const reg = getRepos().registrations.findById(req.params.id);
    if (!reg) return reply.status(404).send({ error: "not_found" });
    if (!REJECT_FROM.includes(reg.status)) {
      return sendTransitionFailure(req, reply, { ok: false, kind: "conflict", currentStatus: reg.status }, REJECT_LABEL);
    }
    const rawReason = (req.body as { reason?: unknown } | undefined)?.reason;
    if (rawReason !== undefined && rawReason !== null && (typeof rawReason !== "string" || rawReason.length > REJECT_REASON_MAX_CHARS)) {
      return reply.status(400).send({ error: "invalid_reason", message: `reason must be a string of at most ${REJECT_REASON_MAX_CHARS} characters.` });
    }
    const reason = typeof rawReason === "string" && rawReason.length > 0 ? rawReason : "No reason provided";
    const at = new Date().toISOString();
    const admin = adminAuditIdentity(req);
    const outcome = commitTransition({
      id: reg.id,
      expectedFrom: reg.status,
      to: "rejected",
      extra: { description: `REJECTED: ${reason}` },
      audit: (ctx) => ({
        eventType: "operator.rejected",
        actor: admin.actor,
        resourceType: "registration",
        resourceId: ctx.pre.id,
        action: "reject",
        metadata: {
          ...transitionAuditFields(ctx, at),
          ...reviewedEvidenceFields(ctx.proof),
          name: ctx.pre.name,
          reason,
          adminAuth: admin.adminAuth,
          caller: requestCaller(req),
        },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      }),
    });
    if (!outcome.ok) return sendTransitionFailure(req, reply, outcome, REJECT_LABEL);
    return { registration: outcome.row, rejected: true };
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
    // Caller must own the registration, and the check fails closed (rule 7):
    // no authenticated actor is 401 before any lookup; no owner matches nobody.
    const callerId = authenticatedActor(req, ["operatorId", "userId", "apiKeyId", "walletAddress"]);
    if (!callerId) {
      return reply.status(401).send({ error: "authentication_required", message: "Editing a registration requires an authenticated operator." });
    }
    const repos = getRepos();
    const reg = repos.registrations.findById(req.params.id);
    if (!reg) return reply.status(404).send({ error: "not_found" });
    const owner = registrationOwner(reg);
    if (!owner || owner !== callerId) {
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
    if (body.description !== undefined) {
      // Once evidence is submitted, the description column holds the
      // server-written review record (or an admin's rejection). The owner may
      // not rewrite what is under or after review, nor forge such a record.
      if (!DESCRIPTION_EDITABLE_STATUSES.includes(reg.status)) {
        return reply.status(409).send({
          error: "evidence_locked",
          message: `The description holds the review record once evidence is submitted; it can't be edited in "${reg.status}" status.`,
          currentStatus: reg.status,
        });
      }
      if (isReservedDescription(body.description)) {
        return reply.status(400).send({
          error: "reserved_description",
          message: "Descriptions starting with \"PROOF SUBMITTED:\" or \"PROVED:\" are reserved for server-written review records.",
        });
      }
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
      actor: callerId,
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
    // Owner-only, failing closed (rule 7), as for PATCH.
    const callerId = authenticatedActor(req, ["operatorId", "userId", "apiKeyId", "walletAddress"]);
    if (!callerId) {
      return reply.status(401).send({ error: "authentication_required", message: "Deleting a registration requires an authenticated operator." });
    }
    const repos = getRepos();
    const reg = repos.registrations.findById(req.params.id);
    if (!reg) return reply.status(404).send({ error: "not_found" });
    const owner = registrationOwner(reg);
    if (!owner || owner !== callerId) {
      return reply.status(403).send({ error: "forbidden", message: "You can only delete your own registration" });
    }
    if (reg.status === "deleted") {
      return { registration: reg, alreadyDeleted: true };
    }

    const deletedAt = new Date().toISOString();
    repos.registrations.updateStatus(req.params.id, "deleted", {
      description: `DELETED at ${deletedAt} by ${callerId} — original: ${reg.description ?? "(no description)"}`,
    });

    auditService.log({
      eventType: "operator.deleted",
      actor: callerId,
      resourceType: "registration",
      resourceId: reg.id,
      action: "delete",
      metadata: { soft: true, deletedAt },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    return { registration: { ...reg, status: "deleted" }, deletedAt, soft: true };
  });

  // ── Activate an approved registration (admin key required) ──
  app.post<{ Params: { id: string } }>("/api/onboard/registrations/:id/activate", async (req, reply) => {
    if (!isOnboardAdmin(req)) {
      return reply.status(403).send({ error: "forbidden", message: "Activating a registration requires the admin key" });
    }
    const reg = getRepos().registrations.findById(req.params.id);
    if (!reg) return reply.status(404).send({ error: "not_found" });
    if (!ACTIVATE_FROM.includes(reg.status)) {
      return sendTransitionFailure(req, reply, { ok: false, kind: "conflict", currentStatus: reg.status }, ACTIVATE_LABEL);
    }
    const at = new Date().toISOString();
    const admin = adminAuditIdentity(req);
    const outcome = commitTransition({
      id: reg.id,
      expectedFrom: reg.status,
      to: "active",
      audit: (ctx) => ({
        eventType: "operator.activated",
        actor: admin.actor,
        resourceType: "registration",
        resourceId: ctx.pre.id,
        action: "activate",
        metadata: {
          ...transitionAuditFields(ctx, at),
          ...reviewedEvidenceFields(ctx.proof),
          name: ctx.pre.name,
          adminAuth: admin.adminAuth,
          caller: requestCaller(req),
        },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      }),
    });
    if (!outcome.ok) return sendTransitionFailure(req, reply, outcome, ACTIVATE_LABEL);
    return { registration: outcome.row, activated: true };
  });

  // ── Submit proof-of-capability evidence for review ──
  // Operator submits evidence of a test job (photo, sensor data, device health).
  // The evidence is recorded and the registration moves to "reviewing". It is
  // never approved or activated here, at any tier: every field in the body is
  // self-asserted (nothing binds it to the device or to a server-issued
  // challenge), so it cannot establish that the machine is real. An onboarding
  // admin approves and activates through /approve and /activate.
  //
  // Order: authenticated actor (401) -> owner (403) -> status -> bounded shape
  // checks, no decode (400/413/422) -> fabrication screen (422, audited,
  // status unchanged) -> timestamps -> bounded photo decode + header checks
  // (422) -> retain the photo -> CAS to "reviewing" + audit record, atomically.
  // Only `evidence` is read from the body; a `status` field anywhere is ignored.
  app.post<{ Params: { id: string } }>(
    "/api/onboard/registrations/:id/prove",
    {
      bodyLimit: PROVE_BODY_LIMIT_BYTES,
      // The server's global handler reports an oversized body as a 400 about
      // Content-Length. Give /prove a distinct 413 and hand every other error
      // to the parent handler unchanged.
      errorHandler: (error, _req, reply) => {
        if ((error as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
          return reply.status(413).send({
            error: "body_too_large",
            message: `A /prove request body may be at most ${PROVE_BODY_LIMIT_BYTES} bytes.`,
          });
        }
        throw error;
      },
    },
    async (req, reply) => {
      return Sentry.startSpan(
        { name: "onboard.prove", op: "onboard", attributes: { "registration.id": req.params.id } },
        async () => {
          // Steward rule 7: no authenticated actor -> 401, before any lookup.
          const actor = authenticatedActor(req, ["operatorId", "userId"]);
          if (!actor) {
            return reply.status(401).send({
              error: "authentication_required",
              message: "Submitting evidence requires an authenticated operator (API key or wallet session).",
            });
          }

          const repos = getRepos();
          const reg = repos.registrations.findById(req.params.id);
          if (!reg) return reply.status(404).send({ error: "not_found" });

          // Only the registration's owner may submit its evidence. No owner (or
          // the zero-address placeholder) matches nobody.
          const owner = registrationOwner(reg);
          if (!owner || owner !== actor) {
            return reply.status(403).send({
              error: "forbidden",
              message: owner
                ? "You can only prove your own registration"
                : "This registration has no owner identity, so no operator can submit evidence for it",
            });
          }

          if (reg.status === "active") {
            return reply.status(400).send({ error: "already_active", message: "Registration is already active" });
          }
          if (reg.status === "rejected") {
            return reply.status(400).send({ error: "rejected", message: "Registration was rejected — submit a new one" });
          }
          if (reg.status === "deleted") {
            return reply.status(410).send({ error: "deleted", message: "Registration was soft-deleted" });
          }
          // Evidence is fixed once an admin approves, so what was reviewed is what stays on record.
          if (reg.status === "approved") {
            return reply.status(400).send({ error: "already_approved", message: "Registration is already approved; its evidence can't be changed after approval" });
          }
          if (!PROVE_FROM.includes(reg.status)) {
            return reply.status(400).send({ error: "invalid_status", message: `Cannot submit evidence for a registration in "${reg.status}" status` });
          }

          const body = req.body;
          const rawEvidence = isPlainObject(body) ? body.evidence : undefined;
          if (rawEvidence === undefined || rawEvidence === null) {
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

          // B2 — bounded shape checks. Nothing is decoded yet.
          const shape = validateEvidenceShape(rawEvidence);
          if (!shape.ok) return sendEvidenceRejection(reply, shape.rejection);
          const evidence = shape.value;

          // B1 — the canonical fabrication screen. A rejection rule only: the
          // registration is left exactly as it was and nothing is stored, but
          // the attempt is audited.
          const fabricated = fabricatedEventIndices(evidence.events);
          if (fabricated.length > 0) {
            try {
              auditService.logStrict({
                eventType: "operator.proof_rejected",
                actor,
                resourceType: "registration",
                resourceId: reg.id,
                action: "prove_rejected",
                metadata: {
                  registrationId: reg.id,
                  reason: "fabricated_evidence",
                  fabricatedEventIndices: fabricated,
                  eventCount: evidence.events.length,
                  eventsSha256: eventsDigest(evidence.events),
                  statusUnchanged: reg.status,
                  at: new Date().toISOString(),
                },
                ip: req.ip,
                userAgent: req.headers["user-agent"],
              });
            } catch (err) {
              // The rejection stands either way; surface the lost audit record.
              req.log.error({ err }, "[onboard] audit write for a rejected (fabricated) proof failed");
              Sentry.captureException(err, { extra: { action: "prove_rejected", registrationId: reg.id } });
            }
            return reply.status(422).send({
              error: "fabricated_evidence",
              message: "Evidence events marked as simulated or mock (source.simulated or payload.mock) cannot be submitted as proof of a real device.",
              fabricatedEvents: fabricated,
              currentStatus: reg.status,
            });
          }

          const timestampRejection = checkEventTimestamps(evidence.events, Date.now());
          if (timestampRejection) return sendEvidenceRejection(reply, timestampRejection);

          // Bounded decode (<= 5 MiB, checked above) + magic bytes + header dimensions.
          let photo: InspectedPhoto | undefined;
          if (evidence.photo) {
            const inspected = inspectPhoto(evidence.photo);
            if (!inspected.ok) return sendEvidenceRejection(reply, inspected.rejection);
            photo = inspected.value;
          }

          const summary = summarizeEvidence(evidence, photo);
          if (summary.proofs.length === 0) {
            return reply.status(422).send({
              error: "insufficient_evidence",
              message: "Evidence did not meet minimum requirements for review.",
              warnings: summary.warnings,
              hint: "Provide a bundleHash with completion events, a photo of test output, or a device health snapshot with model and status.",
            });
          }

          // Retain the decoded photo, content-addressed, before the transition,
          // so the record never references a photo that was not stored.
          let photoCid: string | null = null;
          if (photo) {
            try {
              photoCid = (await getEvidencePhotoStore().put(photo.bytes, PHOTO_MEDIA_TYPES[photo.format])).cid;
            } catch (err) {
              req.log.error({ err }, "[onboard] evidence photo retention failed");
              return reply.status(503).send({
                error: "evidence_store_unavailable",
                message: "The evidence photo could not be stored; nothing was recorded. Try again later.",
              });
            }
          }

          // B4 — the canonical evidence record, kept in the description column.
          const submittedAt = new Date().toISOString();
          const record = buildEvidenceRecord({
            registrationId: reg.id,
            submitterOperatorId: actor,
            submittedAt,
            evidence,
            photo,
            photoCid,
            evidenceTierClaim: summary.evidenceTierClaim,
          });
          const evidenceDigest = evidenceRecordDigest(record);
          const description = PROOF_RECORD_PREFIX + JSON.stringify({
            submittedAt,
            autoApproved: false,
            proofs: summary.proofs,
            evidenceBundleHash: record.bundleHash,
            evidenceIpfsCid: record.ipfsCid,
            evidenceTierClaim: summary.evidenceTierClaim,
            evidenceDigest,
            evidence: record,
          });

          // B3 — CAS to "reviewing" from exactly the status checked above, with
          // the audit record in the same transaction. Nothing here approves,
          // activates, or sets approvedAt.
          const outcome = commitTransition({
            id: reg.id,
            expectedFrom: reg.status,
            to: "reviewing",
            extra: { description },
            audit: (ctx) => ({
              eventType: PROOF_SUBMITTED_EVENT,
              actor,
              resourceType: "registration",
              resourceId: ctx.pre.id,
              action: "prove",
              metadata: {
                ...transitionAuditFields(ctx, submittedAt),
                evidenceDigest,
                // The proof this one replaces, from the audit log (M1).
                previousEvidenceDigest: ctx.proof.evidenceDigest,
                previousProofAuditId: ctx.proof.auditId,
                evidenceTierClaim: summary.evidenceTierClaim,
                proofCount: summary.proofs.length,
                proofs: summary.proofs,
                autoApproved: false,
                evidence: record,
              },
              ip: req.ip,
              userAgent: req.headers["user-agent"],
            }),
          });
          if (!outcome.ok) return sendTransitionFailure(req, reply, outcome, PROVE_LABEL);

          pipelineTelemetry.emit(reg.id, "operator_verify", "started", {
            metadata: { proofCount: summary.proofs.length, autoApproved: false, pendingReview: true, evidenceTierClaim: summary.evidenceTierClaim },
          });
          trackServerEvent("operator_proved", { proofCount: summary.proofs.length, evidenceTierClaim: summary.evidenceTierClaim, pendingReview: true });
          return {
            registration: outcome.row,
            autoApproved: false,
            activated: false,
            pendingReview: true,
            proofs: summary.proofs,
            // A claim about which self-asserted evidence was submitted. It grants
            // no assurance tier; the served tier comes from the kernel ceiling.
            evidenceTierClaim: summary.evidenceTierClaim,
            evidenceDigest,
            evidence: record,
            warning: summary.tierWarning,
            warnings: summary.warnings.length > 0 ? summary.warnings : undefined,
            message: "Evidence recorded. The registration is pending review; an onboarding admin approves and activates it.",
          };
        },
      );
    },
  );

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

      // Surface the trace_id so the agent can echo it on every subsequent
      // call via `x-pcc-trace-id`. Stamped by middleware/trace-id.ts.
      const trace_id = (req as unknown as { traceId?: string }).traceId;

      return reply.send({
        success: true,
        message: "Your agent is provisioned. Everything is ready.",

        // Identity
        token: gc.token,
        user_id: gc.userId,
        trace_id,
        trace_hint:
          "Echo `x-pcc-trace-id` on every subsequent request. Quote it when filing `pcc_report` feedback so PCC can replay your full onboarding journey.",

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
