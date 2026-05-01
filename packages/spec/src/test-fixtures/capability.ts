/**
 * Test-fixture builder for `Capability` (Week 9 D).
 *
 * Why this exists:
 *   The W7 B work added two new optional fields on `CapabilitySchema`:
 *   `requiresApproval` and `approvalThresholdUsd`. Tests that need to
 *   exercise the full lifecycle (capability → SettleableSession → settle
 *   path → progress events) repeat the same long literal capability
 *   objects across files; the boilerplate hides the field that matters.
 *
 *   This builder fills in sensible defaults for everything else and
 *   surfaces only the fields a given test cares about via `overrides`.
 *
 * Companion helper `buildTestSession` constructs a `SettleableSession`
 * snapshot from a `Capability`-shaped object plus per-session inputs.
 * It mirrors the snapshotting expectation documented in
 * `packages/gateway/src/routes/centralized-settle.ts` (W7 B comments) so
 * tests have a clear reference for "this is how the production
 * session-creation site MUST snapshot capability fields onto the
 * SettleableSession at session-creation time."
 *
 * Usage:
 *
 *   import { buildTestCapability, buildTestSession } from
 *     "@pcc/spec/test-fixtures/capability";
 *
 *   const cap = buildTestCapability({ requiresApproval: true });
 *   const session = buildTestSession({ capability: cap, amountCents: 12500 });
 *
 *   // Or with everything inline:
 *   const session2 = buildTestSession({
 *     id: "sess-x",
 *     capability: { id: "cap-x", approvalThresholdUsd: 50 },
 *     amountCents: 7500,
 *   });
 *
 * Both helpers are deeply-merge-friendly: nested objects (pricing,
 * availability, location, actorsHashed) merge field-by-field rather than
 * replace wholesale. That keeps test setups concise even when only one
 * sub-field needs a non-default value.
 */

import type { Capability } from "../types/capability.js";

// ── Capability builder ────────────────────────────────────────────────

/**
 * Construct a valid `Capability` with sensible defaults. Override any
 * field via `overrides`; nested objects merge shallowly so callers can
 * tweak a single sub-field without re-declaring the whole sub-object.
 *
 * The default capability:
 *   - is `fdm` 3D printing
 *   - supports tiers 0 + 1
 *   - prices in USDC
 *   - settles on the centralized substrate (W2 default)
 *   - does NOT require approval (W7 B `requiresApproval: false`,
 *     `approvalThresholdUsd: undefined`)
 *
 * Tests that exercise the approval gate should override one of:
 *   - `requiresApproval: true`
 *   - `approvalThresholdUsd: <number>` and a session amount above it
 */
export function buildTestCapability(
  overrides: Partial<Capability> = {},
): Capability {
  const base: Capability = {
    id: "cap-test-fdm-001",
    kernelId: "kernel-test-001",
    type: "fdm",
    name: "Test FDM Printer",
    description: "Test fixture capability — FDM 3D printing on PLA",
    materials: ["pla"],
    assuranceTiers: [0, 1],
    pricing: {
      currency: "USDC",
      baseCost: "5",
      minimum: "5",
    },
    availability: {
      timezone: "UTC",
      windows: {
        1: [{ start: "2026-04-27T09:00:00Z", end: "2026-04-27T17:00:00Z" }],
      },
    },
    location: { lat: 0, lng: 0 },
    queueDepth: 0,
    settlementMode: "centralized",
    // W7 B explicit defaults — false / undefined matches the gate's
    // expected "do not fire" case so tests opt-in to gating.
    requiresApproval: false,
    approvalThresholdUsd: undefined,
  };

  // Shallow-merge nested objects when overridden so tests can tweak
  // single sub-fields without re-declaring the parent.
  const pricing = overrides.pricing
    ? { ...base.pricing, ...overrides.pricing }
    : base.pricing;
  const availability = overrides.availability
    ? { ...base.availability, ...overrides.availability }
    : base.availability;
  const location = overrides.location
    ? { ...base.location, ...overrides.location }
    : base.location;

  return {
    ...base,
    ...overrides,
    pricing,
    availability,
    location,
  };
}

// ── SettleableSession builder ─────────────────────────────────────────

/**
 * Minimal SettleableSession shape the centralized-settle route operates
 * on. Mirrors the interface in
 * `packages/gateway/src/routes/centralized-settle.ts`. Re-declared here
 * so the spec package doesn't depend on gateway internals — keeps the
 * import graph from running circular.
 *
 * If the gateway's interface gains new fields, the test fixture should
 * mirror the additions. The two interfaces are intentionally kept in
 * sync by hand because the spec package is downstream of the gateway in
 * the import graph (gateway depends on spec, not the other way around).
 */
export interface SettleableSessionFixture {
  id: string;
  state:
    | "committed"
    | "executing"
    | "settled"
    | "cancelled"
    | "disputed";
  user: { id: string; kind: "user" };
  operator: { id: string; kind: "operator" };
  amountCents: number;
  capability: string;
  actorsHashed: { user: string; operator: string };
  settlementMode?: "centralized" | "onchain";
  operatorName?: string;
  requiresApproval?: boolean;
  capabilityRequiresApproval?: boolean;
  capabilityApprovalThresholdUsd?: number;
}

export interface BuildTestSessionInput {
  /** Logical session id. Defaults to "sess-test-001". */
  id?: string;
  /**
   * The capability whose fields snapshot onto the session. Pass a full
   * `Capability` (typically built via `buildTestCapability`) OR a partial
   * — the partial is filled in via `buildTestCapability(overrides)`.
   */
  capability?: Partial<Capability> | Capability;
  /** Amount in cents. Defaults to 12500 (= $125.00). */
  amountCents?: number;
  /** Arbitrary additional overrides on the session itself. */
  overrides?: Partial<SettleableSessionFixture>;
}

/**
 * Construct a `SettleableSession`-shaped object whose W7 B fields are
 * snapshotted from a `Capability`.
 *
 * The snapshot mapping is the contract that the production session-
 * creation site MUST honor (deferred work — see W8 Track B finding):
 *
 *   capability.requiresApproval        → session.capabilityRequiresApproval
 *   capability.approvalThresholdUsd    → session.capabilityApprovalThresholdUsd
 *   capability.settlementMode          → session.settlementMode
 *
 * `session.requiresApproval` is INTENTIONALLY left undefined here — the
 * per-session override is its own decision, separate from the per-
 * capability default. Tests can opt in via `overrides.requiresApproval`.
 */
export function buildTestSession(
  input: BuildTestSessionInput = {},
): SettleableSessionFixture {
  const capability =
    input.capability && isFullCapability(input.capability)
      ? input.capability
      : buildTestCapability((input.capability ?? {}) as Partial<Capability>);

  const id = input.id ?? "sess-test-001";
  const amountCents = input.amountCents ?? 12500;

  const base: SettleableSessionFixture = {
    id,
    state: "committed",
    user: { id: "user-test-alice", kind: "user" },
    operator: { id: "operator-test-bob", kind: "operator" },
    amountCents,
    capability: capability.type,
    actorsHashed: {
      user: "11".repeat(32),
      operator: "22".repeat(32),
    },
    settlementMode: capability.settlementMode ?? "centralized",
    operatorName: "Test Operator",
    // W7 B snapshot — capabilityRequiresApproval / capabilityApprovalThresholdUsd
    // come straight from the capability fields. session.requiresApproval is
    // left undefined so callers can opt-in via overrides.
    capabilityRequiresApproval: capability.requiresApproval,
    capabilityApprovalThresholdUsd: capability.approvalThresholdUsd,
  };

  // Shallow-merge nested objects when overridden.
  const overrides = input.overrides ?? {};
  const user = overrides.user ? { ...base.user, ...overrides.user } : base.user;
  const operator = overrides.operator
    ? { ...base.operator, ...overrides.operator }
    : base.operator;
  const actorsHashed = overrides.actorsHashed
    ? { ...base.actorsHashed, ...overrides.actorsHashed }
    : base.actorsHashed;

  return {
    ...base,
    ...overrides,
    user,
    operator,
    actorsHashed,
  };
}

/** Type guard: minimum-required fields for a "complete" Capability. */
function isFullCapability(c: Partial<Capability> | Capability): c is Capability {
  // Heuristic: if pricing/availability/location are present we treat it
  // as a complete capability; otherwise we treat it as a partial and run
  // it through buildTestCapability for defaults.
  return (
    typeof c === "object" &&
    c !== null &&
    "pricing" in c &&
    "availability" in c &&
    "location" in c
  );
}
