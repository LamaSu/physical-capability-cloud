/**
 * AgentFacade tests — RBAC + SoD enforcement
 *
 * The AgentFacade is fully in-memory (no DB), so no initStore() needed.
 * Each test uses a fresh facade instance to keep state isolated.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentFacade, ROLE_PERMISSIONS } from "../facades/agent.facade.js";

// Mock telemetry (used by BaseFacade.execute, not used by AgentFacade directly
// but mocked for safety in case BaseFacade.execute is called via inherited path)
vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: { emit: vi.fn() },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFacade(): AgentFacade {
  return new AgentFacade();
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("AgentFacade", () => {
  let facade: AgentFacade;

  beforeEach(() => {
    facade = makeFacade();
  });

  // ── registerAgent() ────────────────────────────────────────────────────────

  describe("registerAgent()", () => {
    it("creates a session and returns an AgentSession with correct fields", () => {
      const result = facade.registerAgent("agent-001", "execution", "did:pcc:0xABCD");

      expect(result.success).toBe(true);
      if (!result.success) return;

      const session = result.data;
      expect(session.sessionId).toBeTruthy();
      expect(typeof session.sessionId).toBe("string");
      expect(session.agentId).toBe("agent-001");
      expect(session.did).toBe("did:pcc:0xABCD");
      expect(session.role).toBe("execution");
      expect(session.active).toBe(true);
      expect(typeof session.createdAt).toBe("number");
      expect(typeof session.lastActivity).toBe("number");
    });

    it("assigns permissions from ROLE_PERMISSIONS for the given role", () => {
      const result = facade.registerAgent("agent-002", "verification", "did:pcc:0x1234");
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.permissions).toEqual(ROLE_PERMISSIONS.verification);
    });

    it("returns error on empty agentId", () => {
      const result = facade.registerAgent("", "execution", "did:pcc:0xABCD");
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.httpStatus).toBe(400);
      expect(result.error.code).toBe("INVALID_AGENT_ID");
    });

    it("returns error on empty DID", () => {
      const result = facade.registerAgent("agent-003", "execution", "");
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.httpStatus).toBe(400);
      expect(result.error.code).toBe("INVALID_DID");
    });

    it("each registration creates a unique sessionId", () => {
      const r1 = facade.registerAgent("agent-A", "execution", "did:pcc:0xAAAA");
      const r2 = facade.registerAgent("agent-B", "execution", "did:pcc:0xBBBB");
      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      if (!r1.success || !r2.success) return;
      expect(r1.data.sessionId).not.toBe(r2.data.sessionId);
    });
  });

  // ── createSession() ────────────────────────────────────────────────────────

  describe("createSession()", () => {
    it("returns valid AgentContext with correct permissions", () => {
      const result = facade.createSession("did:pcc:0xCAFE", "negotiation");

      expect(result.success).toBe(true);
      if (!result.success) return;

      const ctx = result.data;
      expect(ctx.did).toBe("did:pcc:0xCAFE");
      expect(ctx.role).toBe("negotiation");
      expect(ctx.sessionId).toBeTruthy();
      expect(ctx.permissions).toEqual(ROLE_PERMISSIONS.negotiation);
    });

    it("binds jobId to the returned context when provided", () => {
      const result = facade.createSession("did:pcc:0xDEAD", "escrow", "job_xyz");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.jobId).toBe("job_xyz");
    });

    it("returns error on empty DID", () => {
      const result = facade.createSession("", "execution");
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.httpStatus).toBe(400);
    });
  });

  // ── getAgentContext() ──────────────────────────────────────────────────────

  describe("getAgentContext()", () => {
    it("returns the context for a valid active sessionId", () => {
      const reg = facade.registerAgent("agent-ctx", "settlement", "did:pcc:0xSETTLE");
      expect(reg.success).toBe(true);
      if (!reg.success) return;

      const ctx = facade.getAgentContext(reg.data.sessionId);
      expect(ctx.success).toBe(true);
      if (!ctx.success) return;
      expect(ctx.data.did).toBe("did:pcc:0xSETTLE");
      expect(ctx.data.role).toBe("settlement");
    });

    it("returns SESSION_NOT_FOUND (401) for unknown sessionId", () => {
      const result = facade.getAgentContext("session-does-not-exist");
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe("SESSION_NOT_FOUND");
      expect(result.error.httpStatus).toBe(401);
    });

    it("returns SESSION_NOT_FOUND (401) after session is revoked", () => {
      const reg = facade.registerAgent("agent-rev", "discovery", "did:pcc:0xDISC");
      expect(reg.success).toBe(true);
      if (!reg.success) return;

      facade.revokeSession(reg.data.sessionId);

      const ctx = facade.getAgentContext(reg.data.sessionId);
      expect(ctx.success).toBe(false);
      if (ctx.success) return;
      expect(ctx.error.code).toBe("SESSION_NOT_FOUND");
      expect(ctx.error.httpStatus).toBe(401);
    });

    it("updates lastActivity on each call", () => {
      const reg = facade.registerAgent("agent-lact", "operator", "did:pcc:0xOP");
      expect(reg.success).toBe(true);
      if (!reg.success) return;

      const before = Date.now();
      facade.getAgentContext(reg.data.sessionId);
      const session = facade.getSession(reg.data.sessionId);
      expect(session?.lastActivity).toBeGreaterThanOrEqual(before);
    });
  });

  // ── validateAccess() ───────────────────────────────────────────────────────

  describe("validateAccess()", () => {
    it("allows access for correct facade + allowed action", () => {
      const reg = facade.createSession("did:pcc:0xEXEC", "execution");
      expect(reg.success).toBe(true);
      if (!reg.success) return;

      const result = facade.validateAccess(reg.data, "JobFacade", "submit_evidence");
      expect(result.success).toBe(true);
    });

    it("blocks access to a forbidden facade for the role", () => {
      // discovery role is NOT allowed to access SettlementFacade
      const reg = facade.createSession("did:pcc:0xDISC2", "discovery");
      expect(reg.success).toBe(true);
      if (!reg.success) return;

      const result = facade.validateAccess(reg.data, "SettlementFacade", "list");
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe("FORBIDDEN");
      expect(result.error.httpStatus).toBe(403);
    });

    it("blocks a forbidden action even if facade is allowed", () => {
      // execution role is allowed on JobFacade but 'verify' is in forbiddenActions
      const reg = facade.createSession("did:pcc:0xEXEC2", "execution");
      expect(reg.success).toBe(true);
      if (!reg.success) return;

      const result = facade.validateAccess(reg.data, "JobFacade", "verify");
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe("ACTION_FORBIDDEN");
      expect(result.error.httpStatus).toBe(403);
    });

    it("blocks an action not in allowedActions (not wildcard role)", () => {
      // verification role's allowedFacades includes JobFacade, but 'fund' is not allowed
      const reg = facade.createSession("did:pcc:0xVERIF", "verification");
      expect(reg.success).toBe(true);
      if (!reg.success) return;

      const result = facade.validateAccess(reg.data, "JobFacade", "fund");
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe("ACTION_FORBIDDEN");
    });

    it("operator role has wildcard access — allows any facade + action", () => {
      const reg = facade.createSession("did:pcc:0xOP2", "operator");
      expect(reg.success).toBe(true);
      if (!reg.success) return;

      const r1 = facade.validateAccess(reg.data, "SettlementFacade", "settle");
      const r2 = facade.validateAccess(reg.data, "ComplianceFacade", "verify");
      const r3 = facade.validateAccess(reg.data, "AgentFacade", "manage_sessions");
      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      expect(r3.success).toBe(true);
    });

    it("admin role has wildcard access — allows any facade + action", () => {
      const reg = facade.createSession("did:pcc:0xADMIN", "admin");
      expect(reg.success).toBe(true);
      if (!reg.success) return;

      const result = facade.validateAccess(reg.data, "any_facade", "any_action");
      expect(result.success).toBe(true);
    });
  });

  // ── checkSoD() ─────────────────────────────────────────────────────────────

  describe("checkSoD()", () => {
    it("allows first role registration for a job (no conflict possible)", () => {
      const result = facade.checkSoD("did:pcc:0xSOD1", "execution", "job_001");
      expect(result.success).toBe(true);
    });

    it("blocks: same DID as execution + verification on same job", () => {
      const did = "did:pcc:0xSOD_EXEC_VERIF";
      const jobId = "job_sod_test";

      // Register execution first
      const r1 = facade.checkSoD(did, "execution", jobId);
      expect(r1.success).toBe(true);

      // Attempt to register verification — should be blocked
      const r2 = facade.checkSoD(did, "verification", jobId);
      expect(r2.success).toBe(false);
      if (r2.success) return;
      expect(r2.error.code).toBe("SOD_VIOLATION");
      expect(r2.error.httpStatus).toBe(403);
    });

    it("blocks: same DID as escrow + verification on same job", () => {
      const did = "did:pcc:0xSOD_ESCROW_VERIF";
      const jobId = "job_sod_escrow";

      facade.checkSoD(did, "escrow", jobId);

      const result = facade.checkSoD(did, "verification", jobId);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe("SOD_VIOLATION");
    });

    it("blocks: same DID as execution + settlement on same job", () => {
      const did = "did:pcc:0xSOD_EXEC_SETTLE";
      const jobId = "job_sod_settle";

      facade.checkSoD(did, "execution", jobId);

      const result = facade.checkSoD(did, "settlement", jobId);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe("SOD_VIOLATION");
    });

    it("allows: different DIDs for execution + verification on same job", () => {
      const jobId = "job_different_dids";

      const r1 = facade.checkSoD("did:pcc:0xEXEC_DIFF", "execution", jobId);
      const r2 = facade.checkSoD("did:pcc:0xVERIF_DIFF", "verification", jobId);

      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
    });

    it("allows: same DID with conflicting roles on DIFFERENT jobs", () => {
      const did = "did:pcc:0xSAME_DID_DIFF_JOBS";

      // execution on job_A, verification on job_B — different jobs, no conflict
      const r1 = facade.checkSoD(did, "execution", "job_A");
      const r2 = facade.checkSoD(did, "verification", "job_B");

      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
    });

    it("is symmetric: blocks verification → execution just as execution → verification", () => {
      const did = "did:pcc:0xSYM_TEST";
      const jobId = "job_sym";

      // Register verification FIRST this time
      facade.checkSoD(did, "verification", jobId);

      // Now try execution — should still be blocked (symmetric conflict)
      const result = facade.checkSoD(did, "execution", jobId);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe("SOD_VIOLATION");
    });
  });

  // ── SoD via registerAgent() with jobId ────────────────────────────────────

  describe("SoD enforcement via registerAgent() with jobId", () => {
    it("blocks registration when SoD would be violated", () => {
      const did = "did:pcc:0xREG_SOD";
      const jobId = "job_reg_sod";

      // Register execution first
      const r1 = facade.registerAgent("agent-exec-sod", "execution", did, jobId);
      expect(r1.success).toBe(true);

      // Attempt verification on same job, same DID — should be blocked
      const r2 = facade.registerAgent("agent-verif-sod", "verification", did, jobId);
      expect(r2.success).toBe(false);
      if (r2.success) return;
      expect(r2.error.code).toBe("SOD_VIOLATION");
    });

    it("does not create a session when SoD check fails", () => {
      const did = "did:pcc:0xREG_SOD_NO_SESSION";
      const jobId = "job_no_session";

      facade.registerAgent("agent-exec-ns", "execution", did, jobId);

      const r2 = facade.registerAgent("agent-verif-ns", "verification", did, jobId);
      expect(r2.success).toBe(false);

      // No new session should have been created for the blocked registration
      const sessions = facade.listActiveSessions();
      if (!sessions.success) return;
      const sessionDids = sessions.data.map((s) => s.did);
      // Only one session should exist for this DID
      const didSessions = sessionDids.filter((d) => d === did);
      expect(didSessions).toHaveLength(1);
    });
  });

  // ── revokeSession() ────────────────────────────────────────────────────────

  describe("revokeSession()", () => {
    it("marks the session inactive and subsequent getAgentContext returns 401", () => {
      const reg = facade.registerAgent("agent-revoke", "discovery", "did:pcc:0xREVOKE");
      expect(reg.success).toBe(true);
      if (!reg.success) return;
      const sessionId = reg.data.sessionId;

      const revokeResult = facade.revokeSession(sessionId);
      expect(revokeResult.success).toBe(true);

      const ctx = facade.getAgentContext(sessionId);
      expect(ctx.success).toBe(false);
      if (ctx.success) return;
      expect(ctx.error.httpStatus).toBe(401);
    });

    it("returns SESSION_NOT_FOUND when revoking an unknown sessionId", () => {
      const result = facade.revokeSession("session-unknown-xyz");
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe("SESSION_NOT_FOUND");
    });

    it("cleans up job-role registry entries for the revoked session", () => {
      const did = "did:pcc:0xREVOKE_SOD";
      const jobId = "job_revoke_sod";

      // Register execution on a job
      const reg = facade.registerAgent("agent-revoke-sod", "execution", did, jobId);
      expect(reg.success).toBe(true);
      if (!reg.success) return;

      // Verify that another DID cannot take verification (execution is registered)
      // NOTE: we check the registry was populated by trying a conflicting registration
      const checkBefore = facade.checkSoD(did, "verification", jobId);
      expect(checkBefore.success).toBe(false); // conflict exists

      // Revoke the session — this should clear the job-role registry
      facade.revokeSession(reg.data.sessionId);

      // Now a fresh facade checkSoD should see nothing registered for execution
      // (We need a fresh facade since checkSoD is stateful — registry was cleared)
      // Actually, after revoke, registry is cleaned, so re-checking with same facade:
      // But note: checkSoD also registers on success, so we need to verify the entry was removed.
      // The _cleanJobRoleRegistry removes `${jobId}:execution` entry.
      // Now if we register the SAME did as verification, it shouldn't conflict anymore.
      const newReg = facade.createSession(did, "verification", jobId);
      expect(newReg.success).toBe(true); // no longer conflicts because execution was cleaned up
    });
  });

  // ── revokeAllForDid() ──────────────────────────────────────────────────────

  describe("revokeAllForDid()", () => {
    it("revokes all active sessions for the given DID", () => {
      const did = "did:pcc:0xREVOKE_ALL";

      const r1 = facade.registerAgent("agent-ra-1", "discovery", did);
      const r2 = facade.registerAgent("agent-ra-2", "negotiation", did);
      const r3 = facade.registerAgent("agent-ra-3", "execution", did);
      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      expect(r3.success).toBe(true);

      const revokeResult = facade.revokeAllForDid(did);
      expect(revokeResult.success).toBe(true);
      if (!revokeResult.success) return;
      expect(revokeResult.data.revoked).toBe(3);
    });

    it("makes all sessions for that DID return 401 on getAgentContext", () => {
      const did = "did:pcc:0xREVOKE_ALL_CTX";

      const r1 = facade.registerAgent("agent-raa-1", "discovery", did);
      const r2 = facade.registerAgent("agent-raa-2", "escrow", did);
      if (!r1.success || !r2.success) return;

      facade.revokeAllForDid(did);

      const ctx1 = facade.getAgentContext(r1.data.sessionId);
      const ctx2 = facade.getAgentContext(r2.data.sessionId);

      expect(ctx1.success).toBe(false);
      expect(ctx2.success).toBe(false);
    });

    it("does not affect sessions for other DIDs", () => {
      const did1 = "did:pcc:0xREVOKE_DID1";
      const did2 = "did:pcc:0xREVOKE_DID2";

      const r1 = facade.registerAgent("agent-did1", "discovery", did1);
      const r2 = facade.registerAgent("agent-did2", "execution", did2);
      if (!r1.success || !r2.success) return;

      facade.revokeAllForDid(did1);

      // did2's session should still be active
      const ctx2 = facade.getAgentContext(r2.data.sessionId);
      expect(ctx2.success).toBe(true);
    });

    it("returns revoked=0 when DID has no active sessions", () => {
      const result = facade.revokeAllForDid("did:pcc:0xNO_SESSIONS");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.revoked).toBe(0);
    });

    it("cleans up all job-role registry entries for the revoked DID", () => {
      const did = "did:pcc:0xREVOKE_JOB_REG";

      // Create sessions bound to different jobs
      const r1 = facade.createSession(did, "execution", "job_rr_1");
      const r2 = facade.createSession(did, "escrow", "job_rr_2");
      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);

      facade.revokeAllForDid(did);

      // After revoke, same DID should be able to re-register without SoD ghost conflicts
      const fresh = facade.createSession(did, "execution", "job_rr_1");
      expect(fresh.success).toBe(true); // no ghost execution entry blocking
    });
  });

  // ── listActiveSessions() ───────────────────────────────────────────────────

  describe("listActiveSessions()", () => {
    it("returns summaries of all active sessions", () => {
      facade.registerAgent("agent-list-1", "discovery", "did:pcc:0xLIST1");
      facade.registerAgent("agent-list-2", "execution", "did:pcc:0xLIST2");

      const result = facade.listActiveSessions();
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.length).toBeGreaterThanOrEqual(2);
    });

    it("does not include revoked sessions in the list", () => {
      const reg = facade.registerAgent("agent-list-rev", "discovery", "did:pcc:0xLISTREV");
      expect(reg.success).toBe(true);
      if (!reg.success) return;

      facade.revokeSession(reg.data.sessionId);

      const result = facade.listActiveSessions();
      if (!result.success) return;
      const found = result.data.find((s) => s.sessionId === reg.data.sessionId);
      expect(found).toBeUndefined();
    });

    it("summary has sessionId, did, role, createdAt fields", () => {
      facade.registerAgent("agent-summary", "settlement", "did:pcc:0xSUMMARY");

      const result = facade.listActiveSessions();
      if (!result.success || result.data.length === 0) return;

      const summary = result.data.find((s) => s.did === "did:pcc:0xSUMMARY");
      expect(summary).toBeDefined();
      if (!summary) return;
      expect(typeof summary.sessionId).toBe("string");
      expect(typeof summary.did).toBe("string");
      expect(typeof summary.role).toBe("string");
      expect(typeof summary.createdAt).toBe("number");
    });

    it("requires admin or operator context when agentContext is provided", () => {
      // A non-admin/operator context should be blocked
      const reg = facade.createSession("did:pcc:0xDISC3", "discovery");
      if (!reg.success) return;

      const result = facade.listActiveSessions(reg.data);
      // discovery role is not in allowedRoles (admin, operator), so should be blocked
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.httpStatus).toBe(403);
    });

    it("allows admin context to list sessions", () => {
      const reg = facade.createSession("did:pcc:0xADMIN2", "admin");
      if (!reg.success) return;

      const result = facade.listActiveSessions(reg.data);
      expect(result.success).toBe(true);
    });
  });

  // ── ROLE_PERMISSIONS matrix ────────────────────────────────────────────────

  describe("ROLE_PERMISSIONS", () => {
    it("every AgentRole has a permissions entry", () => {
      const roles = [
        "discovery", "negotiation", "escrow", "execution",
        "verification", "settlement", "operator", "admin",
      ] as const;
      for (const role of roles) {
        expect(ROLE_PERMISSIONS[role]).toBeDefined();
        expect(ROLE_PERMISSIONS[role].role).toBe(role);
      }
    });

    it("operator and admin have wildcard allowedFacades", () => {
      expect(ROLE_PERMISSIONS.operator.allowedFacades).toContain("*");
      expect(ROLE_PERMISSIONS.admin.allowedFacades).toContain("*");
    });

    it("operator and admin have wildcard allowedActions", () => {
      expect(ROLE_PERMISSIONS.operator.allowedActions).toContain("*");
      expect(ROLE_PERMISSIONS.admin.allowedActions).toContain("*");
    });

    it("execution role cannot verify (in forbiddenActions)", () => {
      expect(ROLE_PERMISSIONS.execution.forbiddenActions).toContain("verify");
    });

    it("verification role cannot settle", () => {
      expect(ROLE_PERMISSIONS.verification.forbiddenActions).toContain("settle");
    });

    it("escrow role cannot verify", () => {
      expect(ROLE_PERMISSIONS.escrow.forbiddenActions).toContain("verify");
    });
  });
});
