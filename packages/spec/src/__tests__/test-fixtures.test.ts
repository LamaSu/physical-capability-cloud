/**
 * Tests for the W9 D test-fixture builder.
 *
 * Sanity-checks the helpers themselves, plus verifies that the W7 B
 * snapshot mapping (capability.requiresApproval →
 * session.capabilityRequiresApproval) works in both directions.
 */

import { describe, it, expect } from "vitest";
import {
  buildTestCapability,
  buildTestSession,
} from "../test-fixtures/capability.js";
import { CapabilitySchema } from "../schemas/index.js";

describe("buildTestCapability", () => {
  it("returns a Capability that passes CapabilitySchema.parse", () => {
    const cap = buildTestCapability();
    const parsed = CapabilitySchema.parse(cap);
    expect(parsed.id).toBe("cap-test-fdm-001");
    expect(parsed.type).toBe("fdm");
  });

  it("defaults requiresApproval=false and approvalThresholdUsd=undefined", () => {
    const cap = buildTestCapability();
    expect(cap.requiresApproval).toBe(false);
    expect(cap.approvalThresholdUsd).toBeUndefined();
  });

  it("defaults settlementMode='centralized' (W2)", () => {
    const cap = buildTestCapability();
    expect(cap.settlementMode).toBe("centralized");
  });

  it("override.requiresApproval=true is reflected on the returned capability", () => {
    const cap = buildTestCapability({ requiresApproval: true });
    expect(cap.requiresApproval).toBe(true);
  });

  it("override.approvalThresholdUsd=50 is reflected", () => {
    const cap = buildTestCapability({ approvalThresholdUsd: 50 });
    expect(cap.approvalThresholdUsd).toBe(50);
  });

  it("override.id replaces the default id", () => {
    const cap = buildTestCapability({ id: "cap-custom" });
    expect(cap.id).toBe("cap-custom");
  });

  it("override.pricing merges shallowly with defaults", () => {
    const cap = buildTestCapability({
      pricing: { currency: "USDC", baseCost: "10", minimum: "10", perMinute: "0.5" },
    });
    expect(cap.pricing.baseCost).toBe("10");
    expect(cap.pricing.perMinute).toBe("0.5");
  });
});

describe("buildTestSession", () => {
  it("returns a session with sensible defaults", () => {
    const sess = buildTestSession();
    expect(sess.id).toBe("sess-test-001");
    expect(sess.state).toBe("committed");
    expect(sess.amountCents).toBe(12500);
    expect(sess.user.kind).toBe("user");
    expect(sess.operator.kind).toBe("operator");
  });

  it("snapshots capability.requiresApproval onto session.capabilityRequiresApproval (W7 B)", () => {
    const cap = buildTestCapability({ requiresApproval: true });
    const sess = buildTestSession({ capability: cap });
    expect(sess.capabilityRequiresApproval).toBe(true);
  });

  it("snapshots capability.approvalThresholdUsd onto session.capabilityApprovalThresholdUsd (W7 B)", () => {
    const cap = buildTestCapability({ approvalThresholdUsd: 50 });
    const sess = buildTestSession({ capability: cap });
    expect(sess.capabilityApprovalThresholdUsd).toBe(50);
  });

  it("leaves session.requiresApproval undefined by default (per-session decision is separate)", () => {
    const cap = buildTestCapability({ requiresApproval: true });
    const sess = buildTestSession({ capability: cap });
    expect(sess.requiresApproval).toBeUndefined();
  });

  it("accepts a partial capability and fills in defaults", () => {
    const sess = buildTestSession({
      capability: { requiresApproval: true, approvalThresholdUsd: 50 },
    });
    expect(sess.capabilityRequiresApproval).toBe(true);
    expect(sess.capabilityApprovalThresholdUsd).toBe(50);
  });

  it("accepts a full capability without re-defaulting", () => {
    const cap = buildTestCapability({ id: "cap-X", requiresApproval: true });
    const sess = buildTestSession({ capability: cap });
    expect(sess.capabilityRequiresApproval).toBe(true);
  });

  it("override.requiresApproval=true sets per-session flag (separate from capability)", () => {
    const sess = buildTestSession({
      overrides: { requiresApproval: true },
    });
    expect(sess.requiresApproval).toBe(true);
  });

  it("override.amountCents replaces the default amount", () => {
    const sess = buildTestSession({ amountCents: 7500 });
    expect(sess.amountCents).toBe(7500);
  });

  it("override.id replaces the default session id", () => {
    const sess = buildTestSession({ id: "sess-XYZ" });
    expect(sess.id).toBe("sess-XYZ");
  });

  it("nested overrides merge shallowly (user.id replaceable without losing kind)", () => {
    const sess = buildTestSession({
      overrides: {
        user: { id: "user-custom", kind: "user" },
        actorsHashed: { user: "ff".repeat(32), operator: "ee".repeat(32) },
      },
    });
    expect(sess.user.id).toBe("user-custom");
    expect(sess.user.kind).toBe("user");
    expect(sess.actorsHashed.user).toBe("ff".repeat(32));
  });
});
