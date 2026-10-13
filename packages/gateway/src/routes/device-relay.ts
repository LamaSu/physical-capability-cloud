/**
 * Generic Device Relay Routes
 *
 * Device-agnostic relay that replaces the OT-2-specific routes.
 * All routes are namespaced by :kernelId so any device type works.
 *
 * Tool calls:
 *   POST /api/relay/:kernelId/tool-call          -- Brain posts a tool call
 *   GET  /api/relay/:kernelId/tool-call/pending   -- Executor polls for pending calls
 *   POST /api/relay/:kernelId/tool-result         -- Executor posts result
 *   GET  /api/relay/:kernelId/tool-result/:id     -- Brain polls for a specific result
 *
 * Execution scopes:
 *   POST /api/relay/:kernelId/scope               -- Create an execution scope
 *   GET  /api/relay/:kernelId/scope/:scopeId      -- Get scope details
 *   POST /api/relay/:kernelId/scope/:scopeId/revoke -- Revoke a scope
 *   GET  /api/relay/:kernelId/scope/:scopeId/audit  -- Audit trail for a scope
 *
 * Camera:
 *   POST /api/relay/:kernelId/camera/frame        -- Agent pushes a frame
 *   GET  /api/relay/:kernelId/camera/latest        -- Get latest frame as JPEG
 *   GET  /api/relay/:kernelId/camera/snapshot      -- Get latest frame as JSON
 *   GET  /api/relay/:kernelId/camera/stream        -- SSE frame notifications
 *
 * Chat:
 *   POST /api/relay/:kernelId/chat                 -- User sends a message
 *   GET  /api/relay/:kernelId/chat/messages         -- Conversation history
 *   GET  /api/relay/:kernelId/chat/pending          -- Agent polls for user messages
 *   POST /api/relay/:kernelId/chat/respond          -- Agent posts response
 *
 * Manifest:
 *   GET  /api/relay/:kernelId/manifest              -- Get tool manifest for this kernel
 *
 * Access (N4b-gw item 4): default-deny, per kernel. Every route is listed in
 * RELAY_ROUTE_ACCESS below and a preHandler enforces it; a route missing from
 * the table is refused. The caller is the authenticated principal (req.userId,
 * set by apiGate for an API key or a SIWE session); with none the answer is
 * 401, never an "anonymous" pass.
 *   - kernel_operator: the device side (claim pending calls, report results,
 *     push camera frames, read and answer chat) and minting scopes. Only the
 *     principal recorded as the kernel's operatorAddress.
 *   - operator_or_grant: the operator, or a principal holding an active,
 *     unexpired execution scope on this kernel.
 *   - object_owner: routes addressing one scope or one call. The handler
 *     allows the kernel operator or the scope's creator, and the object must
 *     belong to the :kernelId in the path. The creator keeps these records
 *     after its scope ends; nothing here commands or observes the device.
 *
 * Authority is checked again where it is used later (astra r2 on #400):
 *   - GET /tool-call/pending re-checks every queued call before handing it
 *     to the device (dispatchRefusal), and closes a refused call as rejected.
 *   - A camera stream re-checks its caller before every frame and heartbeat,
 *     and a revoke ends the streams the scope was holding open.
 *
 * The kernel's emergency stop (N4b-gw r6) is read fail-closed on every route
 * that queues or hands out device work, as stopped / clear / unavailable
 * (emergencyStopState):
 *   - POST /tool-call and POST /scope answer 409 kernel_emergency_stopped while
 *     stopped, and 503 policy_unavailable when the policy cannot be read.
 *   - GET /tool-call/pending withholds while stopped (200, calls [], emergencyStop
 *     true) and rejects what is still queued; 503 policy_unavailable, claiming
 *     and changing nothing, when the policy cannot be read.
 *   - Scope revoke and reads, the audit, results and the camera stay open: a
 *     revoke is a safety action and a result is a device's report of what ran.
 * POST /api/operator/emergency-stop (routes/operator.ts) also rejects the calls
 * still queued at the stop, so a resume cannot restart them.
 *
 * Delivery is at-most-once (N4b-gw r6, F2): a call is claimed once, and a claim
 * the executor does not report within 120 s is closed by the next pending poll
 * as failed (claim_timeout), never handed out again. The caller resubmits. A
 * late report for such a call is still recorded, once.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getStore, getRepos } from "../db.js";
import { authorityOf, isAnonymous, refuseKernelAction, type KernelAuthority } from "../auth/kernel-authority.js";
import { resolveSession } from "../auth/siwe-auth.js";
import { schema, eq, and, sql } from "@pcc/store";
import { getManifest, warmManifestCache } from "../services/tool-manifest-service.js";
import { mockFundsWrites } from "../services/settlement-mode.js";
import { scopeExpiryMs } from "../services/scope-expiry.js";
import { getSafetyGateway, initSafetyGateway } from "@pcc/kernel";

const {
  toolCallRelay,
  executionScopes,
  ot2CameraFrames,
  ot2ChatMessages,
  shopKernels,
  negotiationSessions,
  operatorPolicies,
} = schema;

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Delivery is at-most-once (N4b-gw r6, F2). A call the executor claimed and
 * never reported within CLAIM_TIMEOUT_MS is closed by the next pending poll as
 * `failed` with the error CLAIM_TIMEOUT_ERROR. It is not requeued: the executor
 * may still be running the command, and handing a physical command out twice is
 * worse than failing it once. The caller resubmits if it still wants the work.
 */
const CLAIM_TIMEOUT_MS = 120_000;
const CLAIM_TIMEOUT_ERROR = "claim_timeout";

// ── The execution lease (N4b-gw r7, F3) ─────────────────────────────────────
// A claimed call is not yet a command the device may run. The executor must
// first take the call's lease, POST /tool-call/:callId/start with the claim
// token the poll gave it. That re-checks, in one synchronous step at the moment
// of actuation, everything that moves between the claim and the run (the
// emergency stop, the scope's status/expiry/budget, the breaker, the claim's
// age) and moves the row claimed -> executing exactly once. An executor runs a
// call only on that 200 (docs/EXECUTION_SCOPE_PROTOCOL.md; pcc-node ships no relay
// executor since #442, N66). This is the
// same wire shape as #471's job claim: claim, then start with the token, the
// token opaque to the node.
//
// An executor that does not send `X-PCC-Lease: 1` predates the lease. While
// RELAY_LEASE_ENFORCE is on (the default; anything but "off"), it is handed no
// calls: `{calls: [], count: 0, leaseRequired: true}` makes it idle, not unsafe.
// "off" is a transition window for installed nodes, an operator decision: such a
// poller is served as before, without a lease.

/** A claim older than this cannot be started: the executor sat on it too long. */
const LEASE_MAX_AGE_MS = 60_000;
/**
 * How long after the start a granted lease lets the executor BEGIN actuating
 * (r8, F3). The start's 200 says so (`leaseMs`). pcc-node anchors the window
 * before it sends the start request and re-checks it right before each adapter
 * call, so a slow answer can't stretch it. A stop or revoke after a grant can't
 * reach a call already granted, but every grant is dead within this window.
 */
const LEASE_VALIDITY_MS = 5_000;
const CLAIM_TOKEN_RE = /^[0-9a-f]{64}$/;

function leaseEnforced(): boolean {
  return (process.env.RELAY_LEASE_ENFORCE ?? "").trim().toLowerCase() !== "off";
}

/** An executor's report that it did NOT run the call (a lease refusal on the node). */
function isNotExecuted(error: unknown): boolean {
  return typeof error === "string" && error.startsWith("not_executed:");
}

function claimTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison of two SHA-256 hex digests. */
function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Resolve the device type for a kernel. Falls back to "generic". */
function resolveDeviceType(kernelId: string): string {
  const { db } = getStore();
  const kernel = db.select().from(shopKernels).where(eq(shopKernels.id, kernelId)).get();
  if (!kernel) return "generic";

  // Check if any device on this kernel has an adapterType that maps to a known device type
  const devices = db.select().from(schema.kernelDevices)
    .where(eq(schema.kernelDevices.kernelId, kernelId))
    .all();

  // Map adapter types to device types
  for (const device of devices) {
    if (device.adapterType === "opentrons") return "opentrons";
    if (device.adapterType === "octoprint") return "octoprint";
    if (device.adapterType === "ipp") return "ipp";
  }

  return "generic";
}

/**
 * #579 (astra r1 HIGH; the steward's #6771): every tool call names a scope whose allowedTools lists
 * the tool, and NOTHING bypasses that list, the command budget or escrow. A manifest's safeTools
 * (which also list physical controls: home, reset, lights, identify, connect, disconnect) is only a
 * hint for clients, never an authorization; so the device type, resolved or not, grants nothing.
 */
interface ScopeValidation {
  allowed: boolean;
  reason: string;
}

function validateToolCall(scope: typeof executionScopes.$inferSelect, toolName: string): ScopeValidation {
  const refusal = scopeWriteRefusal(scope, toolName);
  if (refusal) {
    return { allowed: false, reason: refusal };
  }

  // Check command count
  if (scope.commandCount >= scope.maxCommands) {
    return { allowed: false, reason: "max_commands_reached" };
  }

  return { allowed: true, reason: "scope_approved" };
}

/** Why `scope` does not authorize a write of `toolName` now, or null. */
function scopeWriteRefusal(scope: typeof executionScopes.$inferSelect, toolName: string): string | null {
  if (scope.status !== "active") return "scope_not_active";
  if (scopeExpiryMs(scope.expiresAt) < Date.now()) return "scope_expired"; // unreadable: expired (N133)
  if (!(scope.allowedTools as string[]).includes(toolName)) return "tool_not_allowed";
  return null;
}

// ── Access control (N4b-gw item 4) ──────────────────────────────────────────

export type RelayAccess = "kernel_operator" | "operator_or_grant" | "object_owner";

/**
 * The complete access table for this plugin, keyed "METHOD /route/pattern".
 * The preHandler refuses any route of this plugin that is not listed here, so
 * a new relay route stays closed until someone decides who may call it.
 */
export const RELAY_ROUTE_ACCESS: Readonly<Record<string, RelayAccess>> = {
  "GET /api/relay/:kernelId/manifest": "operator_or_grant",
  "POST /api/relay/:kernelId/tool-call": "operator_or_grant",
  "GET /api/relay/:kernelId/tool-call/pending": "kernel_operator",
  "POST /api/relay/:kernelId/tool-call/:callId/start": "kernel_operator",
  "POST /api/relay/:kernelId/tool-result": "kernel_operator",
  "GET /api/relay/:kernelId/tool-result/:id": "object_owner",
  "POST /api/relay/:kernelId/scope": "kernel_operator",
  "GET /api/relay/:kernelId/scope/:scopeId": "object_owner",
  "POST /api/relay/:kernelId/scope/:scopeId/revoke": "object_owner",
  "GET /api/relay/:kernelId/scope/:scopeId/audit": "object_owner",
  "POST /api/relay/:kernelId/camera/frame": "kernel_operator",
  "GET /api/relay/:kernelId/camera/latest": "operator_or_grant",
  "GET /api/relay/:kernelId/camera/snapshot": "operator_or_grant",
  "GET /api/relay/:kernelId/camera/stream": "operator_or_grant",
  "POST /api/relay/:kernelId/chat": "operator_or_grant",
  "GET /api/relay/:kernelId/chat/messages": "operator_or_grant",
  "GET /api/relay/:kernelId/chat/pending": "kernel_operator",
  "POST /api/relay/:kernelId/chat/respond": "kernel_operator",
};


/** The authenticated principal apiGate resolved (API key or SIWE), or null. */
function relayPrincipal(req: FastifyRequest): string | null {
  const id = req.userId ?? req.operatorId ?? null;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * True when the caller runs this kernel at the "operate" tier of auth/kernel-authority.ts: the
 * admin, a proven wallet that is its operator, or the kernel's own principal (its recorded
 * operatorAddress). N126: the relay's operator check is the shared guard's, not its own copy.
 */
function isRelayOperator(req: FastifyRequest, kernelId: string): boolean {
  return refuseKernelAction(req, authorityOf(req), kernelId, "operate") === null;
}

/** True when `principal` created an active, unexpired scope on `kernelId`. */
function holdsActiveScope(kernelId: string, principal: string): boolean {
  const { db } = getStore();
  const now = new Date();
  return db
    .select()
    .from(executionScopes)
    .where(
      and(
        eq(executionScopes.kernelId, kernelId),
        eq(executionScopes.createdBy, principal),
        eq(executionScopes.status, "active"),
      ),
    )
    .all()
    .some((scope) => new Date(scope.expiresAt) > now);
}

/** Operator of the kernel (any tier above), or the creator of this scope. */
function ownsScope(
  req: FastifyRequest,
  scope: typeof executionScopes.$inferSelect,
  kernelId: string,
  principal: string,
): boolean {
  return scope.createdBy === principal || isRelayOperator(req, kernelId);
}

// DECISIONS 00:53 (the steward's #6711): the relay's human- and agent-facing side needs a PROVEN
// principal or the admin, through either #400 branch. A kernel's operatorAddress is public (the
// kernel listing shows it), so a key that merely claims it may not watch the camera, read the
// chat, call a tool or read a result. The device's own side (its polling, starts, results, frame
// uploads and chat replies) stays claimed-or-admin (the steward's 20:16).

/** The admin, or a proven wallet that is the kernel's operator: what "decide" admits. */
function isProvenOperator(req: FastifyRequest, kernelId: string): boolean {
  return refuseKernelAction(req, authorityOf(req), kernelId, "decide") === null;
}

/** A proven wallet holding an active scope on the kernel. */
function isProvenScopeHolder(req: FastifyRequest, kernelId: string): boolean {
  const wallet = authorityOf(req).provenWallet;
  return wallet !== null && holdsActiveScope(kernelId, wallet);
}

/** The scope's owner, proven: the admin, the proven operator, or the proven wallet that created it. */
function provenOwnsScope(req: FastifyRequest, scope: typeof executionScopes.$inferSelect, kernelId: string): boolean {
  const wallet = authorityOf(req).provenWallet;
  return (wallet !== null && scope.createdBy === wallet) || isProvenOperator(req, kernelId);
}

/**
 * Load the scope a scope/:scopeId route addresses. Replies 404 unless the
 * scope is on :kernelId, and 403 unless the caller owns it: for a revoke at the
 * stop tier (#6677: the scope's creator, the kernel's claimed operator or the
 * admin), for a read with proof (DECISIONS 00:53).
 */
function ownedScopeOrReply(
  req: FastifyRequest<{ Params: { kernelId: string; scopeId: string } }>,
  reply: FastifyReply,
  tier: "stop" | "proof",
): typeof executionScopes.$inferSelect | null {
  const { kernelId, scopeId } = req.params;
  const { db } = getStore();
  const scope = db.select().from(executionScopes).where(eq(executionScopes.id, scopeId)).get();
  if (!scope || scope.kernelId !== kernelId) {
    reply.status(404).send({ error: "Scope not found", id: scopeId });
    return null;
  }
  const owns = tier === "stop" ? ownsScope(req, scope, kernelId, relayPrincipal(req) ?? "") : provenOwnsScope(req, scope, kernelId);
  if (!owns) {
    reply.status(403).send({
      error: "scope_not_yours",
      message:
        tier === "stop"
          ? "Only the kernel operator or the scope's creator may use this scope."
          : "Only the kernel's operator or the scope's creator, by a proven wallet, or the admin may read this scope.",
    });
    return null;
  }
  return scope;
}

/**
 * Routes that authorize or drive a device: a DECISION (the steward's #6508 (2), N126). Opening an
 * execution scope, and a chat instruction (the kernel's device agent reads and may act on it), need
 * the admin or a PROVEN wallet that is the kernel's operator. A write tool call is a decision too
 * (relayAccessGuard checks the tool). A scope grant is a claimed identity, so it never authorizes
 * actuation until WP-A proves identities (operator item 138 may loosen this).
 *
 * Revoking a scope is NOT a decision: it takes the stop tier (the steward's #6677 (2)). It only
 * removes authority, so the scope's creator, the kernel's claimed operator or the admin may revoke
 * (#400's object_owner check, ownsScope, whose operator test admits what "stop_or_submit" does).
 */
const RELAY_DECISION_ROUTES: ReadonlySet<string> = new Set([
  "POST /api/relay/:kernelId/scope",
  "POST /api/relay/:kernelId/chat",
]);

/**
 * DECISIONS 00:42 (the steward's #6690): #400's table decides WHO may write through the tool-call
 * route (the kernel's operator, or an active scope holder), and the decision tier requires that
 * WHO to be AUTHENTIC. So a wallet the caller PROVED may make a write under the scope the call
 * names when that scope is on this kernel, active, unexpired and created for that wallet. The same
 * address merely claimed through an API key may not. The handler still requires the caller to be
 * the scope's holder, and checks its tools, budget and escrow.
 */
function isProvenHolderOfNamedScope(req: FastifyRequest, authority: KernelAuthority, kernelId: string): boolean {
  const scopeId = (req.body as { scopeId?: unknown } | undefined)?.scopeId;
  if (authority.provenWallet === null || typeof scopeId !== "string") return false;
  const scope = getStore().db.select().from(executionScopes).where(eq(executionScopes.id, scopeId)).get();
  return (
    scope !== undefined &&
    scope.kernelId === kernelId &&
    scope.createdBy === authority.provenWallet &&
    scope.status === "active" &&
    new Date(scope.expiresAt) > new Date()
  );
}

/**
 * preHandler for every relay route: default-deny, per kernel, on the kernel-authority tiers
 * (N126). A route missing from RELAY_ROUTE_ACCESS is refused. Decisions take the "decide" tier;
 * every other route takes "operate" (the admin, the proven operator wallet, or the kernel's own
 * principal), and an operator_or_grant route also admits the holder of an active scope on the
 * kernel. object_owner routes are checked by their handler against the addressed object.
 */
const KERNEL_OPERATOR_ONLY = {
  error: "relay_access_denied",
  required: "kernel_operator",
  message: "Only this kernel's operator may use this relay route.",
};

async function relayAccessGuard(req: FastifyRequest, reply: FastifyReply) {
  const authority = authorityOf(req);
  if (isAnonymous(authority)) {
    return reply.status(401).send({
      error: "authentication_required",
      message: "The device relay requires the kernel operator's key or an execution scope holder's key.",
    });
  }

  const routeKey = `${req.method} ${req.routeOptions.url}`;
  const access = RELAY_ROUTE_ACCESS[routeKey];
  if (!access) {
    return reply.status(403).send({ error: "relay_route_not_allowed", route: routeKey });
  }

  const { kernelId } = req.params as { kernelId: string };
  // Every tool call drives the device, whatever a manifest calls it (#6771): a decision.
  const toolCall = routeKey === "POST /api/relay/:kernelId/tool-call";
  if (RELAY_DECISION_ROUTES.has(routeKey) || toolCall) {
    const decision = refuseKernelAction(req, authority, kernelId, "decide");
    if (decision && !(toolCall && decision.status === 403 && isProvenHolderOfNamedScope(req, authority, kernelId))) {
      return reply.status(decision.status).send(decision.body);
    }
    return;
  }
  // The handler checks the addressed object: a revoke at the stop tier, a read with proof.
  if (access === "object_owner") return;

  if (access === "kernel_operator") {
    // The device's own side (the steward's 20:16; DECISIONS 00:53): the kernel's executor polls,
    // starts, reports, uploads frames and replies with its own key, or the admin does.
    const refusal = refuseKernelAction(req, authority, kernelId, "operate");
    if (refusal) return reply.status(refusal.status).send(refusal.status === 403 ? KERNEL_OPERATOR_ONLY : refusal.body);
    return;
  }

  // operator_or_grant reads face people and agents (DECISIONS 00:53): the admin, the proven
  // operator wallet, or a proven wallet holding an active scope on this kernel.
  const proof = refuseKernelAction(req, authority, kernelId, "decide");
  if (!proof) return;
  if (proof.status !== 403) return reply.status(proof.status).send(proof.body);
  const provenGrant = authority.provenWallet !== null && holdsActiveScope(kernelId, authority.provenWallet);
  if (provenGrant) return;
  // The kernel's claimed operator, or a claimed scope holder, lacks only the proof. Anyone else is
  // #400's stranger.
  const principal = relayPrincipal(req);
  const claimsAccess =
    refuseKernelAction(req, authority, kernelId, "operate") === null || (principal !== null && holdsActiveScope(kernelId, principal));
  if (claimsAccess) return reply.status(403).send(proof.body);
  return reply.status(403).send({
    error: "relay_access_denied",
    required: "kernel_operator_or_active_scope",
    message: "Requires this kernel's operator or an active execution scope on this kernel.",
  });
}

/**
 * Parity with the retired /api/ot2/tool-call: a scoped write under a scope
 * bound to a job is refused while that job's escrow exists and is not funded.
 * Unlike the legacy route, a lookup error refuses the call instead of
 * letting it through. This is parity, not a funding gate: a job with no
 * session, CWM or escrow record, or a completed escrow, does not stop the
 * call. N4b-gw item 5 (gateway, R30) replaces this with the accepted, funded
 * job and committed-protocol check.
 * N133 r1 (astra, HIGH): a mock escrow funds nothing outside a test process (mockFundsWrites), so
 * a scope bound to a job with a mock escrow is refused there, at admission and at dispatch, even
 * if it went live earlier (under a flag since changed, or before N133).
 */
function escrowRefusal(scope: typeof executionScopes.$inferSelect): string | null {
  if (!scope.jobId) return null;
  const repos = getRepos();
  const job = repos.jobs.findById(scope.jobId);
  if (!job) return null;
  const { db } = getStore();
  const session = db
    .select()
    .from(negotiationSessions)
    .where(eq(negotiationSessions.jobId, scope.jobId))
    .get();
  if (!session?.cwmId) return null;
  const escrow = repos.escrows.findByCwm(session.cwmId);
  if (escrow && escrow.contractAddress.startsWith("mock-escrow-") && !mockFundsWrites()) return "mock_escrow";
  if (escrow && escrow.status !== "funded" && escrow.status !== "active" && escrow.status !== "completed") {
    return escrow.status;
  }
  return null;
}

/**
 * Where a kernel's emergency stop stands (N4b-gw r6). Callers must handle all
 * three answers:
 *   - "clear": the kernel has no operator_policies row, or its policy object's
 *     emergencyStop is falsy.
 *   - "stopped": its policy object's emergencyStop is truthy. Truthy, not
 *     `=== true`, the way the kernel's policy engine reads it, so that any
 *     value but a falsy one engages the stop.
 *   - "unavailable": the stop cannot be told, and the relay refuses rather than
 *     guess, because a policy it cannot read may hold a stop it cannot see. The
 *     read throws, the stored JSON does not parse (the column is a drizzle json
 *     column, which parses on read and throws), or the policy is not a plain
 *     object (null, an array, a string, a number, a boolean).
 * Synchronous (better-sqlite3), so a caller can read the state and act on it
 * with no await in between.
 */
export type EmergencyStopState = "stopped" | "clear" | "unavailable";

export function emergencyStopState(kernelId: string): EmergencyStopState {
  try {
    const { db } = getStore();
    const row = db.select().from(operatorPolicies).where(eq(operatorPolicies.kernelId, kernelId)).get();
    if (!row) return "clear";
    const policy: unknown = row.policy;
    if (typeof policy !== "object" || policy === null || Array.isArray(policy)) return "unavailable";
    return (policy as Record<string, unknown>).emergencyStop ? "stopped" : "clear";
  } catch {
    return "unavailable";
  }
}

/** The refusal for a kernel whose emergency stop is not "clear". N133: an operator's scope acceptance uses it too. */
export function stopRefusal(reply: FastifyReply, state: Exclude<EmergencyStopState, "clear">): FastifyReply {
  return state === "stopped"
    ? reply.status(409).send({ error: "kernel_emergency_stopped" })
    : reply.status(503).send({ error: "policy_unavailable" });
}

/**
 * Why a queued call may not be handed to the device now, or null when it may.
 * GET /tool-call/pending is where a call leaves the gateway, so it re-checks
 * what admission checked: a row can wait while its scope expires or is
 * revoked, and older writers stored rows that admission never saw.
 *   - A named scope must exist and be on the call's own kernel, for any tool.
 *   - A call with no scope must be a safe tool; admission lets only the
 *     operator queue one.
 *   - A SCOPED call — safe OR non-safe — needs its scope still active and
 *     unexpired at dispatch (finding F2: a holder's `home` moves the robot, so
 *     it must not dispatch after the scope expired; only an operator's
 *     scope-free safe call skips the scope).
 *   - A non-safe write must also be in the scope's allowed tools, be within the
 *     command budget re-derived from the rows (finding F3, so a legacy row
 *     admission never counted can't exceed maxCommands), and pass escrow parity.
 * Throws when the escrow lookup fails; the caller then leaves the call queued.
 * The poll runs this twice per call: before the safety governor is consulted,
 * and again, in the same synchronous section as the claim, after the governor
 * has answered, because the governor is async and everything here moves while
 * it is awaited. The governor/breaker and the emergency stop are checked
 * separately, at the dispatch site (finding F1).
 */
function dispatchRefusal(call: typeof toolCallRelay.$inferSelect): string | null {
  if (!call.scopeId) return "scope_required";
  const { db } = getStore();
  const scope = db.select().from(executionScopes).where(eq(executionScopes.id, call.scopeId)).get();
  if (!scope) return "scope_not_found";
  if (scope.kernelId !== call.kernelId) return "scope_kernel_mismatch";
  // F2: a call needs live scope authority (#6771: every call, whatever its tool).
  if (scope.status !== "active") return "scope_not_active";
  if (scopeExpiryMs(scope.expiresAt) < Date.now()) return "scope_expired"; // unreadable: expired (N133)
  if (!(scope.allowedTools as string[]).includes(call.toolName)) return "tool_not_allowed";
  // F3: re-derive the command budget from the rows. Admission increments
  // scope.commandCount, but a legacy row it never saw would not have been
  // counted; counting the scope's already-dispatched calls (claimed or terminal,
  // excluding this one) catches that. If the cap is already reached, this queued
  // call is beyond budget.
  const dispatched = db
    .select()
    .from(toolCallRelay)
    .where(and(eq(toolCallRelay.scopeId, scope.id), eq(toolCallRelay.kernelId, call.kernelId)))
    .all()
    .filter(
      (c) =>
        c.id !== call.id &&
        (c.status === "claimed" || c.status === "executing" || c.status === "completed" || c.status === "failed"),
    );
  if (dispatched.length >= scope.maxCommands) return "max_commands_reached";
  return escrowRefusal(scope) ? "escrow_not_funded" : null;
}

// ── Camera streams (per kernel) ─────────────────────────────────────────────
// The relay guard admits a stream once, when it opens. Each subscriber keeps
// how it was admitted, and before every frame and every heartbeat the stream
// checks again that its credential still stands and that its principal is
// still the kernel's operator or holds an active, unexpired scope there. A
// revoke ends the streams a scope was holding open. A stream that loses its
// authority is ended and never receives another frame.

interface CameraSubscriber {
  reply: FastifyReply;
  /** Still allowed to watch this kernel's camera? Fails closed on any error. */
  authorized: () => boolean;
  heartbeat?: ReturnType<typeof setInterval>;
}

const cameraStreamClients = new Map<string, Set<CameraSubscriber>>();

function getStreamClients(kernelId: string): Set<CameraSubscriber> {
  if (!cameraStreamClients.has(kernelId)) {
    cameraStreamClients.set(kernelId, new Set());
  }
  return cameraStreamClients.get(kernelId)!;
}

/**
 * Whether the credential apiGate resolved for `req` still stands for
 * `principal`: an API key neither revoked nor expired, or a live SIWE session.
 */
function credentialStands(req: FastifyRequest, principal: string): boolean {
  if (req.apiKeyId) {
    const key = getRepos().apiKeys.findById(req.apiKeyId);
    return (
      !!key &&
      !key.revokedAt &&
      (!key.expiresAt || new Date(key.expiresAt).getTime() > Date.now()) &&
      key.operatorId === principal
    );
  }
  return resolveSession(req)?.address === principal;
}

function closeCameraStream(kernelId: string, subscriber: CameraSubscriber, reason: string): void {
  getStreamClients(kernelId).delete(subscriber);
  clearInterval(subscriber.heartbeat);
  try {
    subscriber.reply.raw.end(`event: closed\ndata: ${JSON.stringify({ reason })}\n\n`);
  } catch {
    // The socket is already gone.
  }
}

/** End every stream on `kernelId` that is no longer authorized. */
function closeLapsedCameraStreams(kernelId: string, reason: string): void {
  for (const subscriber of [...getStreamClients(kernelId)]) {
    if (!subscriber.authorized()) closeCameraStream(kernelId, subscriber, reason);
  }
}

// ── Route Registration ──────────────────────────────────────────────────────

export async function deviceRelayRoutes(app: FastifyInstance) {
  // Ensure the safety gateway singleton is initialized. In production this is
  // a no-op (KernelService constructor calls initSafetyGateway first). In
  // test environments where KernelService is not running, this creates a
  // default gateway instance so relay validation can proceed.
  initSafetyGateway();

  // Pre-warm manifest cache so sync lookups work
  await warmManifestCache();

  // Default-deny, per kernel, for every route below (see RELAY_ROUTE_ACCESS).
  app.addHook("preHandler", relayAccessGuard);

  // Ensure tables exist (idempotent; packages/db/src/migrate.ts creates them too)
  const { db } = getStore();

  db.run(sql`CREATE TABLE IF NOT EXISTS tool_call_relay (
    id TEXT PRIMARY KEY,
    scope_id TEXT,
    kernel_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    tool_args TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    claimed_at TEXT,
    completed_at TEXT
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS execution_scopes (
    id TEXT PRIMARY KEY,
    kernel_id TEXT NOT NULL,
    job_id TEXT,
    created_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    allowed_tools TEXT NOT NULL,
    allowed_pipettes TEXT,
    allowed_slots TEXT,
    max_commands INTEGER NOT NULL DEFAULT 100,
    command_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS ot2_camera_frames (
    id TEXT PRIMARY KEY,
    kernel_id TEXT NOT NULL,
    frame_data TEXT NOT NULL,
    captured_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS ot2_chat_messages (
    id TEXT PRIMARY KEY,
    kernel_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_calls TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  )`);

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOL MANIFEST
  // ═══════════════════════════════════════════════════════════════════════════

  app.get<{
    Params: { kernelId: string };
  }>("/api/relay/:kernelId/manifest", async (req) => {
    const { kernelId } = req.params;
    const deviceType = resolveDeviceType(kernelId);
    const manifest = await getManifest(deviceType);
    return {
      kernelId,
      deviceType,
      manifest,
    };
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOL CALL RELAY
  // ═══════════════════════════════════════════════════════════════════════════

  // POST /api/relay/:kernelId/tool-call
  app.post<{
    Params: { kernelId: string };
    Body: {
      scopeId?: string;
      toolName?: string;
      args?: Record<string, unknown>;
    };
  }>("/api/relay/:kernelId/tool-call", async (req, reply) => {
    const { kernelId } = req.params;
    const { scopeId, toolName, args } = req.body ?? {};

    if (!toolName) {
      return reply.status(400).send({ error: "toolName is required" });
    }

    const { db } = getStore();
    // The guard admitted this caller as the admin, the proven operator, or the proven holder of
    // the scope it names (DECISIONS 00:53). The operator test here takes proof too: a key that
    // merely claims the kernel's public operatorAddress, sent with another wallet's proof, must
    // still be that scope's holder.
    const callerId = relayPrincipal(req) ?? "";
    const isOperator = isProvenOperator(req, kernelId);

    // Every call names a scope that allows its tool, the operator's included (#6771).
    if (!scopeId) {
      return reply.status(403).send({
        error: "scope_required",
        message: isOperator
          ? `Every tool call names an execution scope that allows the tool. Create one via POST /api/relay/${kernelId}/scope`
          : "Name the execution scope you were granted on this kernel (scopeId).",
      });
    }

    // The kernel's emergency stop (N4b-gw r6). Authentication, authorization
    // and validation have answered above; a stopped, or unreadable, kernel
    // takes nothing from here on: no row and no scope budget spent. This early
    // read only spares those side effects. The authoritative read is the one
    // just before the insert, below.
    const stopAtEntry = emergencyStopState(kernelId);
    if (stopAtEntry !== "clear") return stopRefusal(reply, stopAtEntry);

    // Validate scope if provided
    // A scoped non-safe call spends one command of its scope's budget, charged only
    // when the call is queued (r7 MEDIUM): a refusal after this point (the safety
    // governor, an unavailable governor, the stop read again before the insert)
    // spends nothing.
    let chargesBudget = false;
    if (scopeId) {
      const scope = db
        .select()
        .from(executionScopes)
        .where(eq(executionScopes.id, scopeId))
        .get();

      if (!scope) {
        return reply.status(404).send({ error: "Scope not found", scopeId });
      }

      // Verify scope belongs to this kernel
      if (scope.kernelId !== kernelId) {
        return reply.status(403).send({
          error: "scope_kernel_mismatch",
          message: "This scope belongs to a different kernel.",
        });
      }

      // Verify caller owns this scope (or is the kernel operator)
      if (scope.createdBy !== callerId && !isOperator) {
        return reply.status(403).send({
          error: "scope_not_yours",
          message: "This scope belongs to a different agent.",
        });
      }

      const validation = validateToolCall(scope, toolName);
      if (!validation.allowed) {
        const id = generateId("tc");
        const now = new Date().toISOString();

        db.insert(toolCallRelay).values({
          id,
          scopeId,
          kernelId,
          toolName,
          toolArgs: args ?? {},
          status: "rejected",
          error: validation.reason,
          createdAt: now,
        }).run();

        return reply.status(403).send({
          error: "Tool call rejected by execution scope",
          reason: validation.reason,
          callId: id,
          toolName,
          scopeId,
        });
      }

      {
        // Escrow gate carried over from the retired /api/ot2/tool-call; every scoped call (#6771).
        let unfundedStatus: string | null;
        try {
          unfundedStatus = escrowRefusal(scope);
        } catch (err) {
          return reply.status(503).send({
            error: "escrow_check_unavailable",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        if (unfundedStatus) {
          const id = generateId("tc");
          db.insert(toolCallRelay).values({
            id,
            scopeId,
            kernelId,
            toolName,
            toolArgs: args ?? {},
            status: "rejected",
            error: "escrow_not_funded",
            createdAt: new Date().toISOString(),
          }).run();
          return reply.status(402).send({
            error: "Escrow not funded",
            reason: "escrow_not_funded",
            escrowStatus: unfundedStatus,
            callId: id,
            toolName,
            scopeId,
          });
        }

        chargesBudget = true;
      }
    }

    // ── Safety gateway check ─────────────────────────────────────────────────
    // Scope validation above handles *authorization* (which tools are allowed).
    // The safety governor handles *physical safety* (envelope, rate, e-stop, class).
    // Both must pass in order: scope first, then governor.
    try {
      const gateway = getSafetyGateway();
      const agentDid =
        (req as any).operatorId ??
        (req.headers["x-agent-did"] as string | undefined) ??
        callerId;

      // Admission check only (no execution). The actual work happens on-device:
      // the executor polls tool_call_relay and later reports the outcome to
      // POST /tool-result, which records the real success/failure to the breaker.
      // (Passing a no-op execute to validateAndRelay here recorded a phantom
      // success on every relayed call and kept the breaker permanently closed.)
      const safetyVerdict = await gateway.validateOnly({
        commandId: generateId("cmd"),
        deviceId: kernelId,
        class: scopeId ? "scoped" : "safe",
        type: toolName,
        params: (args ?? {}) as Record<string, unknown>,
        agentDid,
        scopeId: scopeId ?? undefined,
      });

      if (!safetyVerdict.allowed) {
        return reply.status(403).send({
          error: "Tool call denied by safety governor",
          reason: safetyVerdict.verdict?.reason ?? safetyVerdict.reason ?? "governor_denied",
          checks: safetyVerdict.verdict?.checks ?? [],
          toolName,
          kernelId,
          scopeId: scopeId ?? null,
        });
      }
    } catch (err) {
      // getSafetyGateway() throws if not initialized — treat as a safety failure
      return reply.status(503).send({
        error: "Safety gateway not available",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    // ────────────────────────────────────────────────────────────────────────

    // The authoritative emergency-stop read (N4b-gw r6). The governor above was
    // awaited, so a stop may have landed since the read at entry. Read it again
    // and queue the call in the same synchronous section, with no await between
    // the two: better-sqlite3 is synchronous and Node is single-threaded, so no
    // stop request can run between this check and the insert. A stop after the
    // insert finds the row pending, and the stop route rejects it.
    const stop = emergencyStopState(kernelId);
    if (stop !== "clear") return stopRefusal(reply, stop);

    const id = generateId("tc");
    const now = new Date().toISOString();

    // The budget is charged and the call queued in ONE transaction (r8 MEDIUM): an
    // insert that fails rolls the charge back. The charge is conditional: the scope
    // is read again here (the governor was awaited since the early check) and must
    // still be active, unexpired, allow the tool and have a command left, and the
    // increment itself only applies below maxCommands, so two submits that both
    // passed the early check can't both spend the last command.
    let scopeRefusal: string | null = null;
    db.transaction((tx) => {
      if (chargesBudget && scopeId) {
        const current = tx.select().from(executionScopes).where(eq(executionScopes.id, scopeId)).get();
        scopeRefusal = !current
          ? "scope_not_found"
          : (scopeWriteRefusal(current, toolName) ??
            (current.commandCount >= current.maxCommands ? "max_commands_reached" : null));
        if (!scopeRefusal) {
          const charged = tx
            .update(executionScopes)
            .set({ commandCount: sql`${executionScopes.commandCount} + 1` })
            .where(
              and(
                eq(executionScopes.id, scopeId),
                sql`${executionScopes.commandCount} < ${executionScopes.maxCommands}`,
              ),
            )
            .run();
          if ((charged as { changes?: number }).changes !== 1) scopeRefusal = "max_commands_reached";
        }
      }
      tx.insert(toolCallRelay).values({
        id,
        scopeId: scopeId ?? null,
        kernelId,
        toolName,
        toolArgs: args ?? {},
        status: scopeRefusal ? "rejected" : "pending",
        ...(scopeRefusal ? { error: scopeRefusal } : {}),
        createdAt: now,
      }).run();
    });
    if (scopeRefusal) {
      return reply.status(403).send({
        error: "Tool call rejected by execution scope",
        reason: scopeRefusal,
        callId: id,
        toolName,
        scopeId,
      });
    }

    return reply.status(201).send({
      id,
      kernelId,
      scopeId: scopeId ?? null,
      toolName,
      status: "pending",
      createdAt: now,
    });
  });

  // GET /api/relay/:kernelId/tool-call/pending
  app.get<{
    Params: { kernelId: string };
  }>("/api/relay/:kernelId/tool-call/pending", async (req, reply) => {
    const { kernelId } = req.params;

    const { db } = getStore();

    // The kernel's emergency stop (N4b-gw r6), read before anything below
    // changes a row, so an unreadable policy leaves the queue exactly as it was.
    //   - unavailable: refuse. Nothing is reclaimed, claimed or rejected.
    //   - stopped: withhold. Every call still pending for this kernel is
    //     rejected (a compare-and-set on `pending`, so a row a concurrent poll
    //     claimed is left alone), and the executor is answered with no calls and
    //     `emergencyStop: true`. The list key and count stay as they were, so a
    //     poller that predates the flag reads it as "nothing to do".
    const stopAtEntry = emergencyStopState(kernelId);
    if (stopAtEntry === "unavailable") return stopRefusal(reply, stopAtEntry);
    if (stopAtEntry === "stopped") {
      db.update(toolCallRelay)
        .set({ status: "rejected", error: "emergency_stopped", completedAt: new Date().toISOString() })
        .where(and(eq(toolCallRelay.kernelId, kernelId), eq(toolCallRelay.status, "pending")))
        .run();
      return { calls: [], count: 0, emergencyStop: true };
    }

    // The execution lease (F3): a poller that cannot take one gets no calls
    // while it is enforced, and nothing is claimed for it.
    const leaseCapable = req.headers["x-pcc-lease"] === "1";
    if (!leaseCapable && leaseEnforced()) {
      return { calls: [], count: 0, leaseRequired: true };
    }

    // At-most-once delivery (N4b-gw r6, F2). A claim the executor has not
    // reported within CLAIM_TIMEOUT_MS is CLOSED as failed, never put back in
    // the queue: the executor may still be running the command, and handing a
    // physical command out twice is worse than failing it once. The row keeps
    // counting against its scope's command budget (dispatchRefusal counts failed
    // rows), no poll returns it again, and the caller resubmits if it still wants
    // the work. The update is a compare-and-set on `claimed`, so a result
    // reported in the same instant wins. An executor that reports late is still
    // recorded, once (POST /tool-result).
    const now = new Date().toISOString();
    const staleThreshold = new Date(Date.now() - CLAIM_TIMEOUT_MS).toISOString();
    const staleClaimed = db
      .select()
      .from(toolCallRelay)
      .where(
        and(
          eq(toolCallRelay.kernelId, kernelId),
          eq(toolCallRelay.status, "claimed"),
        ),
      )
      .all()
      .filter((c) => c.claimedAt && c.claimedAt < staleThreshold);

    for (const stale of staleClaimed) {
      db.update(toolCallRelay)
        .set({ status: "failed", error: CLAIM_TIMEOUT_ERROR, completedAt: now })
        .where(and(eq(toolCallRelay.id, stale.id), eq(toolCallRelay.status, "claimed")))
        .run();
    }

    const queued = db
      .select()
      .from(toolCallRelay)
      .where(
        and(
          eq(toolCallRelay.kernelId, kernelId),
          eq(toolCallRelay.status, "pending"),
        ),
      )
      .orderBy(toolCallRelay.createdAt)
      .all();

    // Hand out up to 5 calls, oldest first, each re-checked on the way out
    // (dispatchRefusal). A refused call is closed as rejected with its reason,
    // so no later poll can claim it and it does not hold back the calls behind
    // it. A call whose escrow lookup fails stays queued for the next poll.
    const pending: Array<{ call: typeof toolCallRelay.$inferSelect; claimToken: string | null }> = [];
    for (const call of queued) {
      if (pending.length === 5) break;
      let refusal: string | null;
      try {
        refusal = dispatchRefusal(call);
      } catch {
        continue;
      }
      if (refusal) {
        db.update(toolCallRelay)
          .set({ status: "rejected", error: refusal, completedAt: now })
          .where(and(eq(toolCallRelay.id, call.id), eq(toolCallRelay.status, "pending")))
          .run();
        continue;
      }
      // F1: re-establish the physical-safety boundary at the dispatch site. A
      // call admitted while the breaker was closed must not reach the device
      // after failures opened it. Fail closed: an open breaker or a governor
      // denial rejects the row; if the safety gateway can't be consulted, the
      // call is left queued (like an escrow-lookup failure) rather than
      // dispatched. The governor is async, so what it was asked is stale by the
      // time it answers: the use-time section after this block re-reads the
      // time-varying checks before the claim.
      try {
        const gateway = getSafetyGateway();
        const verdict = await gateway.validateOnly({
          commandId: generateId("cmd"),
          deviceId: kernelId,
          class: call.scopeId ? "scoped" : "safe",
          type: call.toolName,
          params: (call.toolArgs ?? {}) as Record<string, unknown>,
          agentDid: kernelId,
          scopeId: call.scopeId ?? undefined,
        });
        if (!verdict.allowed) {
          db.update(toolCallRelay)
            .set({
              // Prefer the top-level reason (e.g. "circuit_open") over the
              // verbose nested verdict, so the stored reason is stable.
              status: "rejected",
              error: verdict.reason ?? verdict.verdict?.reason ?? "safety_denied",
              completedAt: now,
            })
            .where(and(eq(toolCallRelay.id, call.id), eq(toolCallRelay.status, "pending")))
            .run();
          continue;
        }
      } catch {
        // The safety gateway is unavailable — do not dispatch a physical command
        // we cannot clear. Leave the call queued for the next poll.
        continue;
      }
      // ── Use time (N4b-gw r6, F1) ─────────────────────────────────────────
      // Everything checked above was checked before, or while we awaited, the
      // governor, and all of it moves in that window: a scope expires or is
      // revoked, the operator hits the emergency stop, the breaker opens on a
      // failure reported meanwhile, a concurrent poll claims the scope's last
      // command. So what can change is read again here, in ONE synchronous
      // section with no await between these reads and the claim below, and the
      // row is claimed only if every one still passes. Nothing can run between
      // the reads and the claim (better-sqlite3 is synchronous, Node is
      // single-threaded), so a command the world no longer allows is never
      // handed to the device.
      //   - the emergency stop: stopped rejects the row. Unavailable claims
      //     nothing more in this request: this row and every later one stay
      //     pending, and rows claimed earlier in the request are returned.
      //   - dispatchRefusal again: the scope's status, expiry and kernel, the
      //     allowed tool, the row-derived command budget and funding. If its
      //     escrow lookup throws, the row stays queued, as above.
      //   - the circuit breaker, by a look that moves nothing (isCircuitOpen,
      //     not canExecute): validateOnly consulted it before its await.
      // A refusal closes the row as rejected with its reason, guarded on
      // `pending` so a row some other path already closed keeps its own reason.
      const stop = emergencyStopState(kernelId);
      if (stop === "unavailable") break;
      let useRefusal: string | null;
      try {
        useRefusal =
          stop === "stopped"
            ? "emergency_stopped"
            : (dispatchRefusal(call) ??
              (getSafetyGateway().isCircuitOpen(kernelId) ? "circuit_open" : null));
      } catch {
        continue;
      }
      if (useRefusal) {
        db.update(toolCallRelay)
          .set({ status: "rejected", error: useRefusal, completedAt: now })
          .where(and(eq(toolCallRelay.id, call.id), eq(toolCallRelay.status, "pending")))
          .run();
        continue;
      }
      // Atomic, EXCLUSIVE claim (findings F1/F2): claim the row only if it is
      // still `pending`. This is a compare-and-set — SQLite runs it as one
      // statement — so (a) two concurrent polls cannot both take the same row
      // (no duplicate dispatch past the budget), and (b) a revoke, expiry or
      // e-stop that rejected the row while our async safety check awaited leaves
      // it non-`pending`, so this claim changes 0 rows and we do NOT return it.
      // The row is returned to the executor only if THIS poll won the claim.
      // A lease-capable executor gets a fresh claim token with the call; only
      // its hash is stored, so the row alone can't start the call (F3).
      const claimToken = leaseCapable ? randomBytes(32).toString("hex") : null;
      const claimed = db
        .update(toolCallRelay)
        .set({ status: "claimed", claimedAt: now, claimTokenHash: claimToken ? claimTokenHash(claimToken) : null })
        .where(and(eq(toolCallRelay.id, call.id), eq(toolCallRelay.status, "pending")))
        .run();
      if ((claimed as { changes?: number }).changes !== 1) continue;
      pending.push({ call, claimToken });
    }

    return {
      calls: pending.map(({ call: c, claimToken }) => ({
        id: c.id,
        scopeId: c.scopeId,
        kernelId: c.kernelId,
        toolName: c.toolName,
        args: c.toolArgs,
        createdAt: c.createdAt,
        ...(claimToken ? { claimToken } : {}),
      })),
      count: pending.length,
    };
  });

  // POST /api/relay/:kernelId/tool-call/:callId/start
  // The execution lease (F3; see LEASE_MAX_AGE_MS). 200 {started: true} once,
  // and the executor may run the call. 409 {error: "lease_refused", reason}: do
  // not run it; a refusal for a reason that closes the call (the emergency stop,
  // the scope, the budget, the breaker, a stale claim) has already closed it as
  // rejected. 503 policy_unavailable: do not run it; it stays claimed, and the
  // claim timeout closes it unless the executor reports first.
  app.post<{
    Params: { kernelId: string; callId: string };
    Body: { claimToken?: unknown };
  }>("/api/relay/:kernelId/tool-call/:callId/start", async (req, reply) => {
    const { kernelId, callId } = req.params;
    const token = (req.body ?? {}).claimToken;
    if (typeof token !== "string" || !CLAIM_TOKEN_RE.test(token)) {
      return reply.status(400).send({ error: "claim_token_required" });
    }
    const { db } = getStore();
    const call = db.select().from(toolCallRelay).where(eq(toolCallRelay.id, callId)).get();
    if (!call || call.kernelId !== kernelId) {
      return reply.status(404).send({ error: "not_found" });
    }
    const presented = claimTokenHash(token);
    if (!call.claimTokenHash || !sameHash(presented, call.claimTokenHash)) {
      return reply.status(409).send({ error: "lease_refused", reason: "token_mismatch" });
    }
    if (call.status !== "claimed") {
      return reply.status(409).send({ error: "lease_refused", reason: "not_claimed" });
    }

    // ── One synchronous section: re-check everything that moves, then start.
    // No await from here to the compare-and-set, so nothing can change between
    // the reads and the start (better-sqlite3 is synchronous).
    const stop = emergencyStopState(kernelId);
    if (stop === "unavailable") return reply.status(503).send({ error: "policy_unavailable" });
    let refusal: string | null;
    try {
      const claimedMs = call.claimedAt ? Date.parse(call.claimedAt) : NaN;
      refusal =
        stop === "stopped"
          ? "emergency_stopped"
          : !Number.isFinite(claimedMs) || Date.now() - claimedMs > LEASE_MAX_AGE_MS
            ? "stale_claim"
            : (dispatchRefusal(call) ??
              (getSafetyGateway().isCircuitOpen(kernelId) ? "circuit_open" : null));
    } catch {
      // An escrow lookup or the safety gateway failed: we can't clear it, so it
      // does not start. It stays claimed for the claim timeout.
      return reply.status(503).send({ error: "policy_unavailable" });
    }
    const now = new Date().toISOString();
    if (refusal) {
      db.update(toolCallRelay)
        .set({ status: "rejected", error: refusal, completedAt: now })
        .where(and(eq(toolCallRelay.id, callId), eq(toolCallRelay.status, "claimed")))
        .run();
      return reply.status(409).send({ error: "lease_refused", reason: refusal });
    }
    const started = db
      .update(toolCallRelay)
      .set({ status: "executing", startedAt: now })
      .where(
        and(
          eq(toolCallRelay.id, callId),
          eq(toolCallRelay.status, "claimed"),
          eq(toolCallRelay.claimTokenHash, presented),
        ),
      )
      .run();
    if ((started as { changes?: number }).changes !== 1) {
      return reply.status(409).send({ error: "lease_refused", reason: "not_claimed" });
    }
    return { started: true, callId, startedAt: now, leaseMs: LEASE_VALIDITY_MS };
  });

  // POST /api/relay/:kernelId/tool-result
  app.post<{
    Params: { kernelId: string };
    Body: {
      callId?: string;
      result?: unknown;
      error?: string;
    };
  }>("/api/relay/:kernelId/tool-result", async (req, reply) => {
    const { callId, result, error } = req.body ?? {};

    if (!callId) {
      return reply.status(400).send({ error: "callId is required" });
    }

    const { db } = getStore();

    const call = db
      .select()
      .from(toolCallRelay)
      .where(eq(toolCallRelay.id, callId))
      .get();

    if (!call) {
      return reply.status(404).send({ error: "Tool call not found", callId });
    }

    // ── Caller-ownership check (safety review S3 F2; N4b-gw) ────────────────
    // Reporting a result mutates the safety circuit breaker for call.kernelId
    // (recordDeviceFailure/Success below) and is the device's own outcome.
    // The guard admitted only the operator of :kernelId (the on-device
    // executor runs under the operator). The call must also belong to that
    // kernel, so an operator cannot report, trip or reset another kernel's
    // calls by naming their callId. A scope holder commands; it never reports.
    if (call.kernelId !== req.params.kernelId) {
      return reply.status(403).send({
        error: "tool_result_not_yours",
        message: "This tool call belongs to a different kernel.",
      });
    }

    // ── Idempotency / breaker-integrity guard (finding F2) ───────────────────
    // Only the FIRST terminal transition of a call records its outcome. A call
    // that is already completed/failed/rejected is treated as an idempotent
    // no-op ack: a poll-based executor retrying its POST after a dropped 200 —
    // or a replayed callId — must neither double-count a breaker trip nor
    // spuriously reset a tripped breaker.
    //
    // One exception (N4b-gw r6, F2): a call the pending poll closed as
    // failed/claim_timeout, because the executor never reported within the
    // claim timeout, is still the device's call. If the executor was running
    // it, its report is the first and only outcome the device gives, so it is
    // recorded, once: the row goes from one terminal status to another and is
    // never returned to the queue. A report that only echoes the timeout says
    // nothing new, and a replay of a recorded late report finds a row that no
    // longer says claim_timeout, so both stay idempotent acks.
    const lateReport =
      call.status === "failed" && call.error === CLAIM_TIMEOUT_ERROR && error !== CLAIM_TIMEOUT_ERROR;
    if (
      !lateReport &&
      (call.status === "completed" || call.status === "failed" || call.status === "rejected")
    ) {
      return reply.status(200).send({
        callId,
        status: call.status,
        completedAt: call.completedAt ?? null,
        idempotent: true,
      });
    }

    // The lease (F3): a call claimed with a token runs only after /start moved it
    // to executing. A success reported for one that was never started is not a
    // device outcome the gateway authorized, so it is refused and the row stays
    // claimed (an error still closes it, below).
    if (call.status === "claimed" && call.claimTokenHash && !error) {
      return reply.status(409).send({ error: "not_started", callId });
    }

    const now = new Date().toISOString();
    const newStatus = error ? "failed" : "completed";

    // Feed the executor's REAL outcome back into the safety circuit breaker.
    // The tool-call admission (validateOnly) keyed the breaker by kernelId, so
    // the outcome MUST be recorded under the same key — this is what lets a
    // device that keeps failing on the executor actually trip the breaker and
    // block subsequent relayed commands. (A relayed tool call is kernel-scoped;
    // the relay row carries no finer deviceId.) Non-fatal if gateway is absent.
    //
    // Guarded on 'claimed': only a call that was admitted AND picked up by an
    // executor carries a real device outcome, and so does a late report for a
    // claim the poll timed out (it was picked up too). The terminal-state guard
    // above already excluded replays, so this is the single first-transition
    // record.
    //
    // A report is a device outcome only if the device may have run the call:
    // it was started under the lease (executing), or it was claimed without a
    // token (a lease-less executor, RELAY_LEASE_ENFORCE=off) and so may have run
    // straight from the claim. A not_executed:* report, or any report on a
    // token-claimed call that never started, ran nothing: it closes the call,
    // but the breaker never counts it as a device failure (F3).
    const mayHaveRun =
      !isNotExecuted(error) &&
      (call.status === "executing" || ((call.status === "claimed" || lateReport) && !call.claimTokenHash));
    if (mayHaveRun) {
      try {
        const gateway = getSafetyGateway();
        if (error) {
          gateway.recordDeviceFailure(call.kernelId);
        } else {
          gateway.recordDeviceSuccess(call.kernelId);
        }
      } catch {
        // Gateway not initialised — result recording proceeds without the breaker.
      }
    }

    // If failed and scope has retries left, update retry count. Only a scope on
    // this call's own kernel counts: an old row can link a call to another kernel's scope.
    if (error && call.scopeId) {
      const scope = db
        .select()
        .from(executionScopes)
        .where(and(eq(executionScopes.id, call.scopeId), eq(executionScopes.kernelId, call.kernelId)))
        .get();

      if (scope && scope.retryCount < scope.maxRetries) {
        db.update(executionScopes)
          .set({ retryCount: scope.retryCount + 1 })
          .where(eq(executionScopes.id, call.scopeId))
          .run();
      }
    }

    db.update(toolCallRelay)
      .set({
        status: newStatus,
        result: result != null ? JSON.stringify(result) : null,
        error: error ?? null,
        completedAt: now,
      })
      .where(eq(toolCallRelay.id, callId))
      .run();

    return reply.status(200).send({
      callId,
      status: newStatus,
      completedAt: now,
    });
  });

  // GET /api/relay/:kernelId/tool-result/:id
  app.get<{
    Params: { kernelId: string; id: string };
  }>("/api/relay/:kernelId/tool-result/:id", async (req, reply) => {
    const { kernelId, id } = req.params;

    const { db } = getStore();
    const call = db
      .select()
      .from(toolCallRelay)
      .where(eq(toolCallRelay.id, id))
      .get();

    if (!call || call.kernelId !== kernelId) {
      return reply.status(404).send({ error: "Tool call not found", id });
    }

    // Object owner, proven (DECISIONS 00:53): the admin, the proven operator, or the
    // proven creator of the call's scope. The scope must be on this kernel too: the
    // retired /api/ot2 writer could link a call to another kernel's scope, and that
    // link grants nothing.
    const scope = call.scopeId
      ? db
          .select()
          .from(executionScopes)
          .where(and(eq(executionScopes.id, call.scopeId), eq(executionScopes.kernelId, kernelId)))
          .get()
      : undefined;
    const allowed = scope ? provenOwnsScope(req, scope, kernelId) : isProvenOperator(req, kernelId);
    if (!allowed) {
      return reply.status(403).send({
        error: "tool_result_not_yours",
        message: "Only the kernel operator or the owning execution scope may read this result.",
      });
    }

    let parsedResult = null;
    if (call.result) {
      try {
        parsedResult = JSON.parse(call.result);
      } catch {
        parsedResult = call.result;
      }
    }

    return {
      id: call.id,
      scopeId: call.scopeId,
      kernelId: call.kernelId,
      toolName: call.toolName,
      args: call.toolArgs,
      status: call.status,
      result: parsedResult,
      error: call.error,
      createdAt: call.createdAt,
      claimedAt: call.claimedAt,
      completedAt: call.completedAt,
    };
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // EXECUTION SCOPES
  // ═══════════════════════════════════════════════════════════════════════════

  // POST /api/relay/:kernelId/scope
  app.post<{
    Params: { kernelId: string };
    Body: {
      jobId?: string;
      createdBy?: string;
      allowedTools?: string[];
      allowedPipettes?: string[];
      allowedSlots?: number[];
      maxCommands?: number;
      maxRetries?: number;
      expiresInMinutes?: number;
    };
  }>("/api/relay/:kernelId/scope", async (req, reply) => {
    const { kernelId } = req.params;
    const {
      jobId,
      createdBy,
      allowedTools,
      allowedPipettes,
      allowedSlots,
      maxCommands,
      maxRetries,
      expiresInMinutes,
    } = req.body ?? {};

    if (!allowedTools) {
      return reply.status(400).send({
        error: "allowedTools is required",
      });
    }

    if (!Array.isArray(allowedTools) || allowedTools.length === 0) {
      return reply.status(400).send({
        error: "allowedTools must be a non-empty array of tool names",
      });
    }

    // Only the kernel operator reaches this handler (guard). The scope is the
    // operator's own unless the operator names the principal it delegates to.
    const holder = createdBy ?? relayPrincipal(req)!;

    // A scope may only be bound to a job on this kernel: its tool calls are
    // counted into that job's completion record.
    if (jobId) {
      const job = getRepos().jobs.findById(jobId);
      if (!job || job.kernelId !== kernelId) {
        return reply.status(400).send({
          error: "job_not_on_kernel",
          message: "jobId must name a job on this kernel.",
        });
      }
    }

    // The kernel's emergency stop (N4b-gw r6): no scope is minted while the stop
    // is engaged, or while it cannot be read. Nothing below awaits, so this read
    // and the insert are one synchronous section and no stop request can run
    // between them. Revoking a scope is a safety action and stays open.
    const stop = emergencyStopState(kernelId);
    if (stop !== "clear") return stopRefusal(reply, stop);

    const id = generateId("scope");
    const now = new Date().toISOString();
    const expiry = new Date(Date.now() + (expiresInMinutes ?? 30) * 60_000).toISOString();

    const { db } = getStore();
    db.insert(executionScopes).values({
      id,
      kernelId,
      jobId: jobId ?? null,
      createdBy: holder,
      status: "active",
      allowedTools,
      allowedPipettes: allowedPipettes ?? null,
      allowedSlots: allowedSlots ?? null,
      maxCommands: maxCommands ?? 100,
      commandCount: 0,
      maxRetries: maxRetries ?? 3,
      retryCount: 0,
      createdAt: now,
      expiresAt: expiry,
    }).run();

    return reply.status(201).send({
      id,
      kernelId,
      jobId: jobId ?? null,
      createdBy: holder,
      status: "active",
      allowedTools,
      allowedPipettes: allowedPipettes ?? null,
      allowedSlots: allowedSlots ?? null,
      maxCommands: maxCommands ?? 100,
      commandCount: 0,
      maxRetries: maxRetries ?? 3,
      retryCount: 0,
      createdAt: now,
      expiresAt: expiry,
    });
  });

  // GET /api/relay/:kernelId/scope/:scopeId
  app.get<{
    Params: { kernelId: string; scopeId: string };
  }>("/api/relay/:kernelId/scope/:scopeId", async (req, reply) => {
    const { scopeId } = req.params;

    const { db } = getStore();
    const scope = ownedScopeOrReply(req, reply, "proof");
    if (!scope) return reply;

    // Check if expired (an unreadable expiry included, N133) and auto-update status
    if (scope.status === "active" && scopeExpiryMs(scope.expiresAt) < Date.now()) {
      db.update(executionScopes)
        .set({ status: "expired" })
        .where(eq(executionScopes.id, scopeId))
        .run();
      scope.status = "expired";
    }

    return {
      ...scope,
      remainingCommands: scope.maxCommands - scope.commandCount,
      remainingRetries: scope.maxRetries - scope.retryCount,
    };
  });

  // POST /api/relay/:kernelId/scope/:scopeId/revoke
  app.post<{
    Params: { kernelId: string; scopeId: string };
  }>("/api/relay/:kernelId/scope/:scopeId/revoke", async (req, reply) => {
    const { kernelId, scopeId } = req.params;

    const { db } = getStore();
    const scope = ownedScopeOrReply(req, reply, "stop");
    if (!scope) return reply;

    if (scope.status === "revoked") {
      return reply.status(409).send({ error: "Scope already revoked", id: scopeId });
    }

    db.update(executionScopes)
      .set({ status: "revoked" })
      .where(eq(executionScopes.id, scopeId))
      .run();

    // Reject any pending tool calls under this scope, on this kernel only.
    const pendingCalls = db
      .select()
      .from(toolCallRelay)
      .where(and(eq(toolCallRelay.scopeId, scopeId), eq(toolCallRelay.kernelId, kernelId)))
      .all();

    const now = new Date().toISOString();
    let rejectedCount = 0;
    for (const call of pendingCalls) {
      if (call.status === "pending" || call.status === "claimed") {
        db.update(toolCallRelay)
          .set({
            status: "rejected",
            error: "scope_revoked",
            completedAt: now,
          })
          .where(eq(toolCallRelay.id, call.id))
          .run();
        rejectedCount++;
      }
    }

    // Streams this scope was holding open end now, not at their next frame.
    closeLapsedCameraStreams(kernelId, "scope_revoked");

    return {
      id: scopeId,
      status: "revoked",
      rejectedPendingCalls: rejectedCount,
    };
  });

  // GET /api/relay/:kernelId/scope/:scopeId/audit
  app.get<{
    Params: { kernelId: string; scopeId: string };
    Querystring: { limit?: string };
  }>("/api/relay/:kernelId/scope/:scopeId/audit", async (req, reply) => {
    const { kernelId, scopeId } = req.params;
    const limit = Math.min(parseInt(req.query.limit ?? "100", 10), 500);

    const { db } = getStore();

    const scope = ownedScopeOrReply(req, reply, "proof");
    if (!scope) return reply;

    // This kernel's calls only, whatever other rows name the scope.
    const calls = db
      .select()
      .from(toolCallRelay)
      .where(and(eq(toolCallRelay.scopeId, scopeId), eq(toolCallRelay.kernelId, kernelId)))
      .orderBy(toolCallRelay.createdAt)
      .limit(limit)
      .all();

    const parsed = calls.map((c) => {
      let parsedResult = null;
      if (c.result) {
        try {
          parsedResult = JSON.parse(c.result);
        } catch {
          parsedResult = c.result;
        }
      }
      return {
        id: c.id,
        toolName: c.toolName,
        args: c.toolArgs,
        status: c.status,
        result: parsedResult,
        error: c.error,
        createdAt: c.createdAt,
        claimedAt: c.claimedAt,
        completedAt: c.completedAt,
      };
    });

    const statusCounts: Record<string, number> = {};
    for (const c of calls) {
      statusCounts[c.status] = (statusCounts[c.status] ?? 0) + 1;
    }

    return {
      scopeId,
      scopeStatus: scope.status,
      commandCount: scope.commandCount,
      maxCommands: scope.maxCommands,
      retryCount: scope.retryCount,
      maxRetries: scope.maxRetries,
      calls: parsed,
      totalCalls: calls.length,
      statusCounts,
    };
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CAMERA RELAY
  // ═══════════════════════════════════════════════════════════════════════════

  // POST /api/relay/:kernelId/camera/frame
  app.post<{
    Params: { kernelId: string };
    Body: {
      frame?: string;
      capturedAt?: string;
    };
  }>("/api/relay/:kernelId/camera/frame", async (req, reply) => {
    const { kernelId } = req.params;
    const { frame, capturedAt } = req.body ?? {};

    if (!frame) {
      return reply.status(400).send({ error: "frame (base64 JPEG) is required" });
    }

    // Max ~5MB JPEG
    if (frame.length > 5 * 1024 * 1024 * 1.37) {
      return reply.status(400).send({ error: "Frame too large (max ~5MB JPEG)" });
    }

    const id = generateId("frame");
    const now = capturedAt ?? new Date().toISOString();

    const { db } = getStore();

    db.insert(ot2CameraFrames).values({
      id,
      kernelId,
      frameData: frame,
      capturedAt: now,
    }).run();

    // Keep only latest 5 frames per kernel
    const allFrames = db
      .select({ id: ot2CameraFrames.id })
      .from(ot2CameraFrames)
      .where(eq(ot2CameraFrames.kernelId, kernelId))
      .orderBy(sql`${ot2CameraFrames.capturedAt} DESC`)
      .all();

    if (allFrames.length > 5) {
      const toDelete = allFrames.slice(5);
      for (const old of toDelete) {
        db.delete(ot2CameraFrames).where(eq(ot2CameraFrames.id, old.id)).run();
      }
    }

    // Notify this kernel's stream subscribers that are still authorized.
    const ssePayload = `event: frame\ndata: ${JSON.stringify({ id, kernelId, capturedAt: now })}\n\n`;
    for (const subscriber of [...getStreamClients(kernelId)]) {
      if (!subscriber.authorized()) {
        closeCameraStream(kernelId, subscriber, "authorization_ended");
        continue;
      }
      try {
        subscriber.reply.raw.write(ssePayload);
      } catch {
        closeCameraStream(kernelId, subscriber, "write_failed");
      }
    }

    return reply.status(201).send({
      id,
      kernelId,
      capturedAt: now,
      framesKept: Math.min(allFrames.length, 5),
    });
  });

  // GET /api/relay/:kernelId/camera/latest
  app.get<{
    Params: { kernelId: string };
  }>("/api/relay/:kernelId/camera/latest", async (req, reply) => {
    // Camera auth (operator or active scope holder) is the relay guard's.
    const { kernelId } = req.params;

    const { db } = getStore();
    const latest = db
      .select()
      .from(ot2CameraFrames)
      .where(eq(ot2CameraFrames.kernelId, kernelId))
      .orderBy(sql`${ot2CameraFrames.capturedAt} DESC`)
      .limit(1)
      .get();

    if (!latest) {
      return reply.status(404).send({ error: "No frames available" });
    }

    const buffer = Buffer.from(latest.frameData, "base64");
    return reply
      .header("Content-Type", "image/jpeg")
      .header("X-Frame-Id", latest.id)
      .header("X-Captured-At", latest.capturedAt)
      .send(buffer);
  });

  // GET /api/relay/:kernelId/camera/snapshot
  app.get<{
    Params: { kernelId: string };
  }>("/api/relay/:kernelId/camera/snapshot", async (req, reply) => {
    // Camera auth (operator or active scope holder) is the relay guard's.
    const { kernelId } = req.params;

    const { db } = getStore();
    const latest = db
      .select()
      .from(ot2CameraFrames)
      .where(eq(ot2CameraFrames.kernelId, kernelId))
      .orderBy(sql`${ot2CameraFrames.capturedAt} DESC`)
      .limit(1)
      .get();

    if (!latest) {
      return reply.status(404).send({ error: "No frames available" });
    }

    return {
      id: latest.id,
      kernelId: latest.kernelId,
      frame: latest.frameData,
      capturedAt: latest.capturedAt,
    };
  });

  // GET /api/relay/:kernelId/camera/stream
  app.get<{
    Params: { kernelId: string };
  }>("/api/relay/:kernelId/camera/stream", async (req, reply) => {
    const { kernelId } = req.params;

    // Strict origin check — prevent subdomain spoofing (red team #47)
    const SSE_ALLOWED = new Set([
      "https://capability.network",
      "http://localhost:5173",
      "http://localhost:3200",
      "http://127.0.0.1:5173",
      "http://127.0.0.1:3200",
    ]);
    const origin = req.headers.origin as string | undefined;
    const allowOrigin = origin && SSE_ALLOWED.has(origin) ? origin : "https://capability.network";

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate, private",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Credentials": "true",
    });

    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ type: "connected", kernelId })}\n\n`);

    // The guard admitted this caller as the admin, the proven operator or a proven
    // active scope holder (DECISIONS 00:53); the stream keeps checking that it still is.
    const principal = relayPrincipal(req)!;
    const subscriber: CameraSubscriber = {
      reply,
      authorized: () => {
        try {
          return (
            credentialStands(req, principal) &&
            (isProvenOperator(req, kernelId) || isProvenScopeHolder(req, kernelId))
          );
        } catch {
          return false;
        }
      },
    };
    getStreamClients(kernelId).add(subscriber);

    subscriber.heartbeat = setInterval(() => {
      if (!subscriber.authorized()) {
        closeCameraStream(kernelId, subscriber, "authorization_ended");
        return;
      }
      try {
        reply.raw.write(": heartbeat\n\n");
      } catch {
        closeCameraStream(kernelId, subscriber, "write_failed");
      }
    }, 15_000);

    req.raw.on("close", () => {
      clearInterval(subscriber.heartbeat);
      getStreamClients(kernelId).delete(subscriber);
    });

    await new Promise<void>(() => {});
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAT RELAY
  // ═══════════════════════════════════════════════════════════════════════════

  // POST /api/relay/:kernelId/chat
  app.post<{
    Params: { kernelId: string };
    Body: {
      message?: string;
    };
  }>("/api/relay/:kernelId/chat", async (req, reply) => {
    const { kernelId } = req.params;
    const { message } = req.body ?? {};

    if (!message) {
      return reply.status(400).send({ error: "message is required" });
    }

    if (message.length > 10_000) {
      return reply.status(400).send({ error: "Message too long (max 10000 chars)" });
    }

    const id = generateId("msg");
    const now = new Date().toISOString();

    const { db } = getStore();
    db.insert(ot2ChatMessages).values({
      id,
      kernelId,
      role: "user",
      content: message,
      status: "pending",
      createdAt: now,
    }).run();

    return reply.status(201).send({
      id,
      kernelId,
      role: "user",
      content: message,
      status: "pending",
      createdAt: now,
    });
  });

  // GET /api/relay/:kernelId/chat/messages
  app.get<{
    Params: { kernelId: string };
    Querystring: { limit?: string };
  }>("/api/relay/:kernelId/chat/messages", async (req) => {
    const { kernelId } = req.params;
    const limit = Math.min(parseInt(req.query.limit ?? "50", 10), 200);

    const { db } = getStore();
    const messages = db
      .select()
      .from(ot2ChatMessages)
      .where(eq(ot2ChatMessages.kernelId, kernelId))
      .orderBy(ot2ChatMessages.createdAt)
      .limit(limit)
      .all();

    return { messages, count: messages.length };
  });

  // GET /api/relay/:kernelId/chat/pending
  app.get<{
    Params: { kernelId: string };
  }>("/api/relay/:kernelId/chat/pending", async (req) => {
    const { kernelId } = req.params;

    const { db } = getStore();
    const pending = db
      .select()
      .from(ot2ChatMessages)
      .where(
        and(
          eq(ot2ChatMessages.kernelId, kernelId),
          eq(ot2ChatMessages.role, "user"),
          eq(ot2ChatMessages.status, "pending"),
        ),
      )
      .orderBy(ot2ChatMessages.createdAt)
      .all();

    for (const msg of pending) {
      db.update(ot2ChatMessages)
        .set({ status: "processing" })
        .where(eq(ot2ChatMessages.id, msg.id))
        .run();
    }

    return { messages: pending, count: pending.length };
  });

  // POST /api/relay/:kernelId/chat/respond
  app.post<{
    Params: { kernelId: string };
    Body: {
      messageId?: string;
      response?: string;
      toolCalls?: unknown[];
    };
  }>("/api/relay/:kernelId/chat/respond", async (req, reply) => {
    const { kernelId } = req.params;
    const { messageId, response, toolCalls } = req.body ?? {};

    if (!response) {
      return reply.status(400).send({ error: "response is required" });
    }

    const { db } = getStore();

    // Mark original message as completed if provided (only this kernel's)
    if (messageId) {
      db.update(ot2ChatMessages)
        .set({ status: "completed" })
        .where(and(eq(ot2ChatMessages.id, messageId), eq(ot2ChatMessages.kernelId, kernelId)))
        .run();
    }

    const id = generateId("msg");
    const now = new Date().toISOString();

    db.insert(ot2ChatMessages).values({
      id,
      kernelId,
      role: "assistant",
      content: response,
      toolCalls: toolCalls ?? null,
      status: "completed",
      createdAt: now,
    }).run();

    return reply.status(201).send({
      id,
      kernelId,
      role: "assistant",
      content: response,
      toolCalls: toolCalls ?? null,
      status: "completed",
      createdAt: now,
    });
  });
}
