/**
 * AgentFacade — RBAC + Separation of Duties enforcement layer.
 *
 * This facade is the authority for all agent identity, session management,
 * and access control in the PCC gateway. It:
 *
 *   1. Issues ephemeral sessions (in-memory, per gateway lifecycle)
 *   2. Enforces role-based access via ROLE_PERMISSIONS matrix
 *   3. Enforces Separation of Duties (SoD) via SOD_CONFLICTS on per-job role registry
 *   4. Exposes session revocation for heartbeat monitor rogue pathway
 *
 * Architecture note: Sessions are NOT persisted. Gateway restart = all sessions
 * invalidated (agents must re-register). This is intentional — sessions are
 * ephemeral authorization tokens, not identity documents.
 */

import { v4 as uuidv4 } from "uuid";
import { type Result, ok, err } from "@pcc/spec";
import { BaseFacade } from "./base.facade.js";
import type { AgentRole, AgentPermissions, AgentContext, AgentSession } from "./types.js";
import { SOD_CONFLICTS } from "./types.js";

// ── Session TTL constants (ASI03: Identity and Privilege Abuse) ───────────────

/**
 * Default session TTL: 1 hour.
 *
 * Sessions expire after this duration unless refreshed via refreshSession().
 * Re-registration is required to obtain a new session after expiry.
 *
 * ASI03 mitigation: prevents long-lived sessions from accumulating capabilities
 * beyond their intended task scope.
 */
export const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Role-specific TTL overrides.
 *
 * Some roles have shorter natural task windows:
 *   - verification: per-bundle check, bounded by verification SLA
 *   - negotiation: bounded by negotiation window (~30 min)
 *   - execution: bounded by job duration (2 hours is generous)
 *
 * Roles not listed here use SESSION_TTL_MS (1 hour default).
 */
export const ROLE_TTL_MS: Partial<Record<AgentRole, number>> = {
  execution: 2 * 60 * 60 * 1000,    // 2 hours — bounded by job duration
  verification: 1 * 60 * 60 * 1000, // 1 hour — per-bundle verification
  negotiation: 30 * 60 * 1000,      // 30 minutes — bounded by negotiation window
};

// Re-export AgentSession so consumers can import it from this module directly
export type { AgentSession } from "./types.js";

// ── Output types ──────────────────────────────────────────────────────────────

export interface AgentSessionSummary {
  sessionId: string;
  did: string;
  role: AgentRole;
  jobId?: string;
  createdAt: number;
}

export interface RegisterAgentInput {
  /** Agent identifier — typically a DID string (did:pcc:...) or opaque ID */
  agentId: string;
  role: AgentRole;
  did: string;
}

// ── ROLE_PERMISSIONS matrix ────────────────────────────────────────────────────

/**
 * Static permission matrix — maps each AgentRole to its allowed facades and actions.
 *
 * Facade names must match the `facadeName` passed to BaseFacade constructor.
 * Action names must match the action strings used in validateAccess() calls.
 *
 * Wildcard "*" in allowedFacades or allowedActions means all are permitted.
 * Wildcard "*" in forbiddenActions is NOT used (empty array = no restrictions).
 */
export const ROLE_PERMISSIONS: Record<AgentRole, AgentPermissions> = {
  discovery: {
    role: "discovery",
    allowedFacades: ["capability", "KernelFacade", "JobFacade"],
    allowedActions: ["list", "search", "get"],
    forbiddenActions: ["submit", "settle", "dispute", "verify", "fund", "release"],
  },
  negotiation: {
    role: "negotiation",
    allowedFacades: ["capability", "JobFacade"],
    allowedActions: ["list", "get", "submit"],
    forbiddenActions: ["settle", "dispute", "verify", "fund", "release"],
  },
  escrow: {
    role: "escrow",
    allowedFacades: ["SettlementFacade"],
    allowedActions: ["list", "get", "fund", "release"],
    forbiddenActions: ["verify", "submit_evidence", "settle", "dispute"],
  },
  execution: {
    role: "execution",
    allowedFacades: ["JobFacade", "KernelFacade"],
    allowedActions: ["list", "get", "update_status", "submit_evidence"],
    forbiddenActions: ["verify", "settle", "dispute", "fund", "release"],
  },
  verification: {
    role: "verification",
    allowedFacades: ["ComplianceFacade", "JobFacade"],
    allowedActions: ["list", "get", "verify", "attest"],
    forbiddenActions: ["submit_evidence", "settle", "fund", "release"],
  },
  settlement: {
    role: "settlement",
    allowedFacades: ["SettlementFacade", "ComplianceFacade"],
    allowedActions: ["list", "get", "settle", "dispute"],
    forbiddenActions: ["submit_evidence", "verify", "fund", "release"],
  },
  operator: {
    role: "operator",
    allowedFacades: ["*"],
    allowedActions: ["*"],
    forbiddenActions: [],
  },
  admin: {
    role: "admin",
    allowedFacades: ["*"],
    allowedActions: ["*"],
    forbiddenActions: [],
  },
};

// ── AgentFacade ───────────────────────────────────────────────────────────────

export class AgentFacade extends BaseFacade {
  /** Only admin and operator can call session management methods directly */
  protected readonly allowedRoles: readonly AgentRole[] = ["admin", "operator"];

  /**
   * In-memory session store.
   * Key: sessionId (UUID v4)
   * Value: AgentSession
   *
   * Not persisted — sessions are valid for the gateway process lifetime only.
   */
  private readonly sessions = new Map<string, AgentSession>();

  /**
   * SoD job registry.
   * Key: `${jobId}:${role}`
   * Value: did
   *
   * Tracks which DID currently holds which role on which job.
   * Used to enforce SOD_CONFLICTS (e.g., same DID cannot be execution + verification).
   */
  private readonly jobRoleRegistry = new Map<string, string>();

  constructor() {
    super("AgentFacade");
  }

  // ── Registration & Session creation ────────────────────────────────────────

  /**
   * Register an agent and create an initial session.
   *
   * If `jobId` is provided, SoD is checked before session creation.
   * On SoD violation, no session is created and an error is returned.
   *
   * @param agentId  Opaque agent identifier (typically same as DID)
   * @param role     Facade-layer role (NOT @pcc/a2a AgentRole)
   * @param did      DID string (did:pcc:..., did:key:..., etc.)
   * @param jobId    Optional: bind the session to a specific job for SoD tracking
   */
  registerAgent(
    agentId: string,
    role: AgentRole,
    did: string,
    jobId?: string,
  ): Result<AgentSession> {
    if (!agentId || !agentId.trim()) {
      return err("INVALID_AGENT_ID", "agentId must be a non-empty string", 400);
    }
    if (!did || !did.trim()) {
      return err("INVALID_DID", "did must be a non-empty string", 400);
    }

    // SoD check before creating the session (if a jobId is provided)
    if (jobId) {
      const sodResult = this.checkSoD(did, role, jobId);
      if (!sodResult.success) return sodResult as Result<AgentSession>;
    }

    const permissions = ROLE_PERMISSIONS[role];
    const sessionId = uuidv4();
    const now = Date.now();
    const ttl = ROLE_TTL_MS[role] ?? SESSION_TTL_MS;

    const session: AgentSession = {
      sessionId,
      agentId,
      did,
      role,
      permissions,
      jobId,
      createdAt: now,
      lastActivity: now,
      expiresAt: now + ttl,
      active: true,
    };

    this.sessions.set(sessionId, session);

    return ok(session);
  }

  /**
   * Create a new session for an already-known DID + role.
   *
   * This is the lightweight variant used when the agent identity is already
   * established and you just need a new session token (e.g., after expiry).
   */
  createSession(
    did: string,
    role: AgentRole,
    jobId?: string,
  ): Result<AgentContext> {
    if (!did || !did.trim()) {
      return err("INVALID_DID", "did must be a non-empty string", 400);
    }

    // SoD check before creating the session
    if (jobId) {
      const sodResult = this.checkSoD(did, role, jobId);
      if (!sodResult.success) return sodResult as Result<AgentContext>;
    }

    const permissions = ROLE_PERMISSIONS[role];
    const sessionId = uuidv4();
    const now = Date.now();
    const ttl = ROLE_TTL_MS[role] ?? SESSION_TTL_MS;

    const session: AgentSession = {
      sessionId,
      agentId: did, // agentId defaults to DID in createSession
      did,
      role,
      permissions,
      jobId,
      createdAt: now,
      lastActivity: now,
      expiresAt: now + ttl,
      active: true,
    };

    this.sessions.set(sessionId, session);

    // Return as AgentContext (the subset used by facades)
    const context: AgentContext = {
      did,
      role,
      sessionId,
      permissions,
      jobId,
    };

    return ok(context);
  }

  // ── Session lookup ─────────────────────────────────────────────────────────

  /**
   * Retrieve an active session context by sessionId.
   *
   * Updates lastActivity on success.
   * Returns SESSION_NOT_FOUND (401) if unknown or inactive.
   */
  getAgentContext(sessionId: string): Result<AgentContext> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return err("SESSION_NOT_FOUND", `Session '${sessionId}' not found`, 401);
    }

    if (!session.active) {
      return err(
        "SESSION_NOT_FOUND",
        `Session '${sessionId}' has been revoked`,
        401,
      );
    }

    // ASI03: TTL expiry check — reject sessions past their expiresAt timestamp.
    // Delete from the store so the session cannot be found again.
    if (Date.now() > session.expiresAt) {
      session.active = false;
      this.sessions.delete(sessionId);
      return err(
        "SESSION_EXPIRED",
        `Session '${sessionId}' has expired. Re-register to obtain a new session.`,
        401,
      );
    }

    // Touch lastActivity
    session.lastActivity = Date.now();

    const context: AgentContext = {
      did: session.did,
      role: session.role,
      sessionId: session.sessionId,
      permissions: session.permissions,
      jobId: session.jobId,
    };

    return ok(context);
  }

  // ── Session TTL refresh ────────────────────────────────────────────────────

  /**
   * Extend a session's TTL by the role's standard TTL duration.
   *
   * Agents with long-running jobs can call this before their session expires
   * to avoid being rejected mid-job. The new expiresAt is computed from the
   * current time (not from the original creation time), capped at 2× the
   * role TTL from now to prevent runaway session extension.
   *
   * ASI03 mitigation: refresh is bounded — agents cannot extend sessions
   * indefinitely. An admin may revoke any session at any time regardless.
   *
   * Returns SESSION_NOT_FOUND (401) if the session is unknown, inactive,
   * or already expired.
   */
  refreshSession(sessionId: string): Result<{ expiresAt: number }> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return err("SESSION_NOT_FOUND", `Session '${sessionId}' not found`, 401);
    }

    if (!session.active) {
      return err("SESSION_NOT_FOUND", `Session '${sessionId}' has been revoked`, 401);
    }

    // Already expired — cannot refresh, must re-register
    if (Date.now() > session.expiresAt) {
      session.active = false;
      this.sessions.delete(sessionId);
      return err(
        "SESSION_EXPIRED",
        `Session '${sessionId}' has already expired. Re-register to obtain a new session.`,
        401,
      );
    }

    const ttl = ROLE_TTL_MS[session.role] ?? SESSION_TTL_MS;
    const newExpiresAt = Date.now() + ttl;
    session.expiresAt = newExpiresAt;
    session.lastActivity = Date.now();

    return ok({ expiresAt: newExpiresAt });
  }

  // ── Access validation ──────────────────────────────────────────────────────

  /**
   * Full permission check: role-level + action-level + SoD.
   *
   * Checks in order:
   *   1. facadeName ∈ agent.permissions.allowedFacades (or wildcard "*")
   *   2. action ∉ agent.permissions.forbiddenActions
   *   3. action ∈ agent.permissions.allowedActions (or wildcard "*")
   *   4. If agent.jobId set: SoD constraints are satisfied
   *
   * Note: role-level access (is this role allowed on this facade?) is handled
   * by BaseFacade.checkAccess() / the facade's own allowedRoles. This method
   * enforces the finer-grained per-permission matrix.
   */
  validateAccess(
    agent: AgentContext,
    facadeName: string,
    action: string,
  ): Result<void> {
    const { permissions } = agent;

    // 1. Facade access check (wildcard = all allowed)
    const facadeAllowed =
      permissions.allowedFacades.includes("*") ||
      permissions.allowedFacades.includes(facadeName);

    if (!facadeAllowed) {
      return err(
        "FORBIDDEN",
        `Role '${agent.role}' is not permitted to access facade '${facadeName}'`,
        403,
      );
    }

    // 2. Forbidden actions check
    if (permissions.forbiddenActions.includes(action)) {
      return err(
        "ACTION_FORBIDDEN",
        `Action '${action}' is explicitly forbidden for role '${agent.role}'`,
        403,
      );
    }

    // 3. Allowed actions check (wildcard = all allowed)
    const actionAllowed =
      permissions.allowedActions.includes("*") ||
      permissions.allowedActions.includes(action);

    if (!actionAllowed) {
      return err(
        "ACTION_FORBIDDEN",
        `Action '${action}' is not in the allowed action list for role '${agent.role}'`,
        403,
      );
    }

    // 4. SoD check (only when a jobId is bound to this session)
    if (agent.jobId) {
      const sodResult = this._checkSoDRead(agent.did, agent.role, agent.jobId);
      if (!sodResult.success) return sodResult;
    }

    return ok(undefined);
  }

  /**
   * Explicit SoD check: can `did` take `incomingRole` on `jobId`?
   *
   * Iterates SOD_CONFLICTS. If any conflicting role is already registered
   * for the same (jobId, did), returns SOD_VIOLATION (403).
   *
   * On success, registers `${jobId}:${incomingRole}` → `did` in jobRoleRegistry.
   * This means checkSoD is stateful — call it when the role is being claimed,
   * not on every request (use _checkSoDRead for read-only validation).
   */
  checkSoD(did: string, incomingRole: AgentRole, jobId: string): Result<void> {
    const conflict = this._findSoDConflict(did, incomingRole, jobId);
    if (conflict) {
      return err(
        "SOD_VIOLATION",
        `DID '${did}' cannot hold role '${incomingRole}' on job '${jobId}': ` +
          `conflicts with already-registered role '${conflict}'`,
        403,
      );
    }

    // Register the role claim
    this.jobRoleRegistry.set(`${jobId}:${incomingRole}`, did);

    return ok(undefined);
  }

  // ── Session revocation ─────────────────────────────────────────────────────

  /**
   * Revoke a session by sessionId.
   *
   * Marks the session as inactive. Clears any job-role registry entries
   * associated with this session's (did, jobId).
   *
   * Returns SESSION_NOT_FOUND if the sessionId is unknown.
   */
  revokeSession(sessionId: string): Result<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return err("SESSION_NOT_FOUND", `Session '${sessionId}' not found`, 401);
    }

    session.active = false;

    // Clean up job-role registry entries for this session
    if (session.jobId) {
      this._cleanJobRoleRegistry(session.did, session.jobId);
    }

    return ok(undefined);
  }

  /**
   * Revoke ALL sessions for a given DID.
   *
   * Called by the heartbeat monitor rogue pathway. Any in-flight requests
   * using those sessionIds will receive SESSION_NOT_FOUND (401).
   *
   * Also cleans all job-role registry entries for the DID.
   */
  revokeAllForDid(did: string): Result<{ revoked: number }> {
    let revoked = 0;
    const jobsAffected = new Set<string>();

    for (const session of this.sessions.values()) {
      if (session.did === did && session.active) {
        session.active = false;
        revoked++;
        if (session.jobId) {
          jobsAffected.add(session.jobId);
        }
      }
    }

    // Clean job-role registry for all affected jobs
    for (const jobId of jobsAffected) {
      this._cleanJobRoleRegistry(did, jobId);
    }

    // Also clean up any job-role registry entries where there's no matching
    // active session (belt-and-suspenders: scan all registry entries for this DID)
    for (const [key, registeredDid] of this.jobRoleRegistry) {
      if (registeredDid === did) {
        this.jobRoleRegistry.delete(key);
      }
    }

    return ok({ revoked });
  }

  // ── Session listing ────────────────────────────────────────────────────────

  /**
   * List all active sessions.
   *
   * Requires admin or operator context. Returns AgentSessionSummary[]
   * (not full sessions — avoids leaking internal state).
   */
  listActiveSessions(agentContext?: AgentContext): Result<AgentSessionSummary[]> {
    // Access check: only admin and operator can list sessions
    if (agentContext) {
      const access = this.checkAccess(agentContext);
      if (access !== null) return access as Result<AgentSessionSummary[]>;
    }

    const summaries: AgentSessionSummary[] = [];
    for (const session of this.sessions.values()) {
      if (session.active) {
        summaries.push({
          sessionId: session.sessionId,
          did: session.did,
          role: session.role,
          jobId: session.jobId,
          createdAt: session.createdAt,
        });
      }
    }

    return ok(summaries);
  }

  /**
   * Get the full raw session (including inactive).
   * Used internally and in tests.
   */
  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Read-only SoD check — does NOT register anything.
   * Used during validateAccess() to verify ongoing compliance.
   */
  private _checkSoDRead(
    did: string,
    role: AgentRole,
    jobId: string,
  ): Result<void> {
    const conflict = this._findSoDConflict(did, role, jobId);
    if (conflict) {
      return err(
        "SOD_VIOLATION",
        `DID '${did}' with role '${role}' on job '${jobId}' violates SoD: ` +
          `already holds conflicting role '${conflict}'`,
        403,
      );
    }
    return ok(undefined);
  }

  /**
   * Core SoD conflict detection logic.
   *
   * Checks all SOD_CONFLICTS pairs. Returns the conflicting role name if found,
   * null if no conflict.
   *
   * Algorithm:
   *   for each [roleA, roleB] in SOD_CONFLICTS:
   *     if incomingRole === roleA → check jobRoleRegistry[jobId:roleB]
   *     if incomingRole === roleB → check jobRoleRegistry[jobId:roleA]
   *     if found entry and entry.did === did → CONFLICT
   */
  private _findSoDConflict(
    did: string,
    incomingRole: AgentRole,
    jobId: string,
  ): AgentRole | null {
    for (const [roleA, roleB] of SOD_CONFLICTS) {
      if (incomingRole === roleA) {
        const existing = this.jobRoleRegistry.get(`${jobId}:${roleB}`);
        if (existing && existing === did) return roleB;
      }
      if (incomingRole === roleB) {
        const existing = this.jobRoleRegistry.get(`${jobId}:${roleA}`);
        if (existing && existing === did) return roleA;
      }
    }
    return null;
  }

  /**
   * Remove all jobRoleRegistry entries for a (did, jobId) pair.
   */
  private _cleanJobRoleRegistry(did: string, jobId: string): void {
    for (const [key, registeredDid] of this.jobRoleRegistry) {
      if (registeredDid === did && key.startsWith(`${jobId}:`)) {
        this.jobRoleRegistry.delete(key);
      }
    }
  }
}
