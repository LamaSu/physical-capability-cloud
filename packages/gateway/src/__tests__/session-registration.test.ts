/**
 * Unit tests for the W10 session-registration helpers in
 * `packages/gateway/src/routes/centralized-settle.ts`:
 *
 *   - `buildSettleableSessionFromCapability` — snapshots the W2 + W7 B
 *     capability fields onto a SettleableSession at session-creation.
 *   - `registerSettleableSession` — production-grade equivalent of
 *     `seedSettleableSessionForTests`, with explicit invariants.
 *
 * These tests exercise the helpers in isolation, without the
 * negotiate-commit route. Integration coverage (commit → settle gate
 * fires correctly) lives in negotiate-commit-settle-e2e.test.ts.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  buildSettleableSessionFromCapability,
  registerSettleableSession,
  resetCentralizedSettleStateForTests,
  SessionAlreadyRegisteredError,
  InvalidSettleableSessionError,
  type SettleableSession,
} from "../routes/centralized-settle.js";

const baseInputs = {
  negotiateSessionId: "sess-w10-helper-001",
  user: { id: "user-alice", kind: "user" as const },
  operator: { id: "operator-bob", kind: "operator" as const },
  amountCents: 12500,
  actorsHashed: { user: "11".repeat(32), operator: "22".repeat(32) },
};

describe("buildSettleableSessionFromCapability (W10)", () => {
  it("snapshots capability.requiresApproval onto session.capabilityRequiresApproval", () => {
    const session = buildSettleableSessionFromCapability({
      ...baseInputs,
      capability: {
        type: "fdm",
        requiresApproval: true,
      },
    });

    expect(session.capabilityRequiresApproval).toBe(true);
    // session.requiresApproval is intentionally undefined — that lever
    // is the per-session opt-in, separate from the per-capability default.
    expect(session.requiresApproval).toBeUndefined();
  });

  it("snapshots capability.approvalThresholdUsd onto session.capabilityApprovalThresholdUsd", () => {
    const session = buildSettleableSessionFromCapability({
      ...baseInputs,
      capability: {
        type: "cnc-3axis",
        approvalThresholdUsd: 75,
      },
    });

    expect(session.capabilityApprovalThresholdUsd).toBe(75);
  });

  it("resolves settlementMode via the W2 helper (defaults to 'centralized' when capability has no mode)", () => {
    const sessionDefault = buildSettleableSessionFromCapability({
      ...baseInputs,
      capability: { type: "fdm" }, // no settlementMode field
    });
    expect(sessionDefault.settlementMode).toBe("centralized");

    const sessionOnchain = buildSettleableSessionFromCapability({
      ...baseInputs,
      capability: { type: "cnc-5axis", settlementMode: "onchain" },
    });
    expect(sessionOnchain.settlementMode).toBe("onchain");

    const sessionExplicitCentralized = buildSettleableSessionFromCapability({
      ...baseInputs,
      capability: { type: "fdm", settlementMode: "centralized" },
    });
    expect(sessionExplicitCentralized.settlementMode).toBe("centralized");
  });

  it("passes through the basic per-session inputs (id, parties, amount, capability)", () => {
    const session = buildSettleableSessionFromCapability({
      ...baseInputs,
      capability: { type: "hplc" },
      operatorName: "Bob's Lab",
    });

    expect(session.id).toBe(baseInputs.negotiateSessionId);
    expect(session.state).toBe("committed");
    expect(session.user).toEqual(baseInputs.user);
    expect(session.operator).toEqual(baseInputs.operator);
    expect(session.amountCents).toBe(baseInputs.amountCents);
    expect(session.capability).toBe("hplc");
    expect(session.actorsHashed).toEqual(baseInputs.actorsHashed);
    expect(session.operatorName).toBe("Bob's Lab");
  });

  it("snapshots undefined capability fields as undefined (gate hierarchy treats this as 'do not fire')", () => {
    const session = buildSettleableSessionFromCapability({
      ...baseInputs,
      capability: { type: "fdm" }, // no requiresApproval / approvalThresholdUsd
    });

    expect(session.capabilityRequiresApproval).toBeUndefined();
    expect(session.capabilityApprovalThresholdUsd).toBeUndefined();
  });
});

describe("registerSettleableSession (W10)", () => {
  beforeEach(() => {
    resetCentralizedSettleStateForTests();
  });

  it("adds a built session to state.sessions (round-trips through the settle path lookup)", async () => {
    // We don't have a public "get session" API on centralized-settle,
    // so we exercise the round-trip indirectly through the settle route.
    // Just confirming the call doesn't throw is enough at the unit level
    // — the e2e integration test asserts settle actually finds it.
    const session = buildSettleableSessionFromCapability({
      ...baseInputs,
      negotiateSessionId: "sess-w10-register-ok",
      capability: { type: "fdm" },
    });

    expect(() => registerSettleableSession(session)).not.toThrow();
  });

  it("throws SessionAlreadyRegisteredError on duplicate id", () => {
    const session = buildSettleableSessionFromCapability({
      ...baseInputs,
      negotiateSessionId: "sess-w10-dup",
      capability: { type: "fdm" },
    });
    registerSettleableSession(session);

    expect(() => registerSettleableSession(session)).toThrow(
      SessionAlreadyRegisteredError,
    );
    // And the error includes the duplicated id for diagnostics.
    try {
      registerSettleableSession(session);
    } catch (err) {
      if (err instanceof SessionAlreadyRegisteredError) {
        expect(err.sessionId).toBe("sess-w10-dup");
      } else {
        throw err;
      }
    }
  });

  it("throws InvalidSettleableSessionError when id is empty", () => {
    const session: SettleableSession = {
      ...buildSettleableSessionFromCapability({
        ...baseInputs,
        capability: { type: "fdm" },
      }),
      id: "",
    };
    expect(() => registerSettleableSession(session)).toThrow(
      InvalidSettleableSessionError,
    );
  });

  it("throws InvalidSettleableSessionError when state is not 'committed'", () => {
    const session: SettleableSession = {
      ...buildSettleableSessionFromCapability({
        ...baseInputs,
        negotiateSessionId: "sess-w10-bad-state",
        capability: { type: "fdm" },
      }),
      state: "settled",
    };
    expect(() => registerSettleableSession(session)).toThrow(
      InvalidSettleableSessionError,
    );
  });

  it("throws InvalidSettleableSessionError when amountCents <= 0", () => {
    const sessionZero = buildSettleableSessionFromCapability({
      ...baseInputs,
      negotiateSessionId: "sess-w10-zero",
      capability: { type: "fdm" },
      amountCents: 0,
    });
    expect(() => registerSettleableSession(sessionZero)).toThrow(
      InvalidSettleableSessionError,
    );

    const sessionNegative = buildSettleableSessionFromCapability({
      ...baseInputs,
      negotiateSessionId: "sess-w10-negative",
      capability: { type: "fdm" },
      amountCents: -100,
    });
    expect(() => registerSettleableSession(sessionNegative)).toThrow(
      InvalidSettleableSessionError,
    );
  });

  it("throws InvalidSettleableSessionError when capability is empty", () => {
    const session: SettleableSession = {
      ...buildSettleableSessionFromCapability({
        ...baseInputs,
        negotiateSessionId: "sess-w10-empty-cap",
        capability: { type: "fdm" },
      }),
      capability: "",
    };
    expect(() => registerSettleableSession(session)).toThrow(
      InvalidSettleableSessionError,
    );
  });
});
