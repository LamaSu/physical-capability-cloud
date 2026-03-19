import { describe, it, expect, beforeEach } from "vitest";
import {
  SessionKeyManager,
  ESCROW_SELECTORS,
  kernelSessionConstraints,
  brokerSessionConstraints,
} from "../session-keys.js";
import type { Address, Hex } from "viem";

const ESCROW_1 = "0x1111111111111111111111111111111111111111" as Address;
const ESCROW_2 = "0x2222222222222222222222222222222222222222" as Address;
const AGENT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;

describe("SessionKeyManager", () => {
  let manager: SessionKeyManager;

  beforeEach(() => {
    manager = new SessionKeyManager();
  });

  it("creates a session key", () => {
    const session = manager.createSession(AGENT, {
      allowedContracts: [ESCROW_1],
      maxSpend: 100_000_000n,
      validUntil: Math.floor(Date.now() / 1000) + 3600,
    });

    expect(session.id).toMatch(/^session-/);
    expect(session.address).toMatch(/^0x/);
    expect(session.privateKey).toMatch(/^0x/);
    expect(session.agentAddress).toBe(AGENT);
    expect(session.revoked).toBe(false);
  });

  it("validates ops against allowed contracts", () => {
    const session = manager.createSession(AGENT, {
      allowedContracts: [ESCROW_1],
      maxSpend: 100_000_000n,
      validUntil: Math.floor(Date.now() / 1000) + 3600,
    });

    const valid = manager.validateOp(session.id, ESCROW_1, ESCROW_SELECTORS.submitEvidence, 0n);
    expect(valid.valid).toBe(true);

    const invalid = manager.validateOp(session.id, ESCROW_2, ESCROW_SELECTORS.submitEvidence, 0n);
    expect(invalid.valid).toBe(false);
    expect(invalid.reason).toBe("contract_not_allowed");
  });

  it("validates ops against allowed selectors", () => {
    const session = manager.createSession(AGENT, {
      allowedContracts: [ESCROW_1],
      allowedSelectors: [ESCROW_SELECTORS.submitEvidence],
      maxSpend: 100_000_000n,
      validUntil: Math.floor(Date.now() / 1000) + 3600,
    });

    const valid = manager.validateOp(session.id, ESCROW_1, ESCROW_SELECTORS.submitEvidence, 0n);
    expect(valid.valid).toBe(true);

    const invalid = manager.validateOp(session.id, ESCROW_1, ESCROW_SELECTORS.release, 0n);
    expect(invalid.valid).toBe(false);
    expect(invalid.reason).toBe("selector_not_allowed");
  });

  it("enforces spend limits", () => {
    const session = manager.createSession(AGENT, {
      allowedContracts: [ESCROW_1],
      maxSpend: 100_000_000n, // $100
      validUntil: Math.floor(Date.now() / 1000) + 3600,
    });

    // First op: $50 — should pass
    const r1 = manager.validateOp(session.id, ESCROW_1, ESCROW_SELECTORS.release, 50_000_000n);
    expect(r1.valid).toBe(true);
    manager.recordUsage(session.id, 50_000_000n);

    // Second op: $60 — should fail (50 + 60 > 100)
    const r2 = manager.validateOp(session.id, ESCROW_1, ESCROW_SELECTORS.release, 60_000_000n);
    expect(r2.valid).toBe(false);
    expect(r2.reason).toBe("spend_limit_exceeded");

    // Third op: $40 — should pass (50 + 40 = 90 < 100)
    const r3 = manager.validateOp(session.id, ESCROW_1, ESCROW_SELECTORS.release, 40_000_000n);
    expect(r3.valid).toBe(true);
  });

  it("enforces ops limit", () => {
    const session = manager.createSession(AGENT, {
      allowedContracts: [ESCROW_1],
      maxSpend: 1_000_000_000n,
      validUntil: Math.floor(Date.now() / 1000) + 3600,
      maxOps: 2,
    });

    manager.recordUsage(session.id, 0n);
    manager.recordUsage(session.id, 0n);

    const r = manager.validateOp(session.id, ESCROW_1, ESCROW_SELECTORS.submitEvidence, 0n);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("ops_limit_exceeded");
  });

  it("rejects expired sessions", () => {
    const session = manager.createSession(AGENT, {
      allowedContracts: [ESCROW_1],
      maxSpend: 100_000_000n,
      validUntil: Math.floor(Date.now() / 1000) - 1, // already expired
    });

    const r = manager.validateOp(session.id, ESCROW_1, ESCROW_SELECTORS.submitEvidence, 0n);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("session_expired");
  });

  it("revokes sessions", () => {
    const session = manager.createSession(AGENT, {
      allowedContracts: [ESCROW_1],
      maxSpend: 100_000_000n,
      validUntil: Math.floor(Date.now() / 1000) + 3600,
    });

    expect(manager.revoke(session.id)).toBe(true);

    const r = manager.validateOp(session.id, ESCROW_1, ESCROW_SELECTORS.submitEvidence, 0n);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("session_revoked");
  });

  it("lists active sessions", () => {
    manager.createSession(AGENT, {
      allowedContracts: [ESCROW_1],
      maxSpend: 100_000_000n,
      validUntil: Math.floor(Date.now() / 1000) + 3600,
    });
    const s2 = manager.createSession(AGENT, {
      allowedContracts: [ESCROW_2],
      maxSpend: 100_000_000n,
      validUntil: Math.floor(Date.now() / 1000) - 1, // expired
    });

    const active = manager.listActive();
    expect(active).toHaveLength(1);
    expect(active[0].constraints.allowedContracts[0]).toBe(ESCROW_1);
  });

  it("lists sessions by agent", () => {
    const other = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
    manager.createSession(AGENT, {
      allowedContracts: [ESCROW_1],
      maxSpend: 100_000_000n,
      validUntil: Math.floor(Date.now() / 1000) + 3600,
    });
    manager.createSession(other, {
      allowedContracts: [ESCROW_2],
      maxSpend: 100_000_000n,
      validUntil: Math.floor(Date.now() / 1000) + 3600,
    });

    expect(manager.listByAgent(AGENT)).toHaveLength(1);
    expect(manager.listByAgent(other)).toHaveLength(1);
  });

  it("prunes expired sessions", () => {
    manager.createSession(AGENT, {
      allowedContracts: [ESCROW_1],
      maxSpend: 100_000_000n,
      validUntil: Math.floor(Date.now() / 1000) - 100,
    });
    manager.createSession(AGENT, {
      allowedContracts: [ESCROW_2],
      maxSpend: 100_000_000n,
      validUntil: Math.floor(Date.now() / 1000) + 3600,
    });

    const pruned = manager.pruneExpired();
    expect(pruned).toBe(1);
    expect(manager.getStats().totalSessions).toBe(1);
  });

  it("tracks stats", () => {
    const s = manager.createSession(AGENT, {
      allowedContracts: [ESCROW_1],
      maxSpend: 100_000_000n,
      validUntil: Math.floor(Date.now() / 1000) + 3600,
    });

    manager.recordUsage(s.id, 50_000_000n);
    manager.recordUsage(s.id, 30_000_000n);

    const stats = manager.getStats();
    expect(stats.totalSessions).toBe(1);
    expect(stats.activeSessions).toBe(1);
    expect(stats.totalOps).toBe(2);
    expect(stats.totalSpent).toBe(80_000_000n);
  });

  it("returns undefined for nonexistent sessions", () => {
    expect(manager.getSession("nope")).toBeUndefined();
    expect(manager.getUsage("nope")).toBeUndefined();
    expect(manager.revoke("nope")).toBe(false);
  });
});

describe("constraint helpers", () => {
  it("creates kernel session constraints", () => {
    const c = kernelSessionConstraints([ESCROW_1, ESCROW_2]);
    expect(c.allowedContracts).toHaveLength(2);
    expect(c.allowedSelectors).toHaveLength(2);
    expect(c.allowedSelectors).toContain(ESCROW_SELECTORS.submitEvidence);
    expect(c.allowedSelectors).toContain(ESCROW_SELECTORS.depositBond);
    expect(c.maxSpend).toBe(100_000_000n);
    expect(c.maxOps).toBe(500);
  });

  it("creates broker session constraints", () => {
    const c = brokerSessionConstraints([ESCROW_1]);
    expect(c.allowedContracts).toHaveLength(1);
    expect(c.allowedSelectors).toHaveLength(2);
    expect(c.allowedSelectors).toContain(ESCROW_SELECTORS.release);
    expect(c.allowedSelectors).toContain(ESCROW_SELECTORS.fileDispute);
    expect(c.maxSpend).toBe(5_000_000_000n);
    expect(c.maxOps).toBe(200);
  });
});
