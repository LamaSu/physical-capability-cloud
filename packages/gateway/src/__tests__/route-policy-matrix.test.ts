import { describe, it, expect } from "vitest";
// @ts-expect-error — JS audit tool, no d.ts
import { resolvePolicy, buildInventory } from "../../../../scripts/audit/route-policy-inventory.mjs";

/**
 * Route-policy MATRIX (audit P0, lane d749deff; review finding #4, hardened R3 #1).
 *
 * The coverage gate proves every route matches SOME rule; this proves the WINNING
 * rule for security-sensitive routes yields the exact intended scopes.
 *
 * R3 #1 fix — every entry is a REAL registered route, asserted present in
 * buildInventory() BEFORE its policy is resolved. Previously the matrix resolved
 * arbitrary concrete paths against the manifest globs, so a NONEXISTENT path
 * (e.g. POST /api/settlement/finalize) matched a broad `/**` rule and produced the
 * "expected" scopes — a green test that proved nothing about the real app. Each
 * entry now carries: method, the registered TEMPLATE, a concrete instantiation,
 * the exact expected winning scopes, and explicitly-forbidden roles.
 *
 * This asserts the ENTRY-GATE policy only (what scope is needed to REACH the
 * handler). Resource ownership + state-transition authorization are a SEPARATE
 * layer the handler must enforce; a passing row here does NOT claim the broad role
 * set is "safe" to reach the resource, only that it is the intended gate.
 */

// Normalize `:param` path segments so template matching is independent of the
// exact param NAME the route file happens to use (:id vs :registrationId, etc).
const norm = (p: string): string => p.replace(/:[A-Za-z0-9_]+/g, ":p");
const concretize = (p: string): string => p.replace(/:[A-Za-z0-9_]+/g, "x");

const inv = buildInventory() as { routes: Array<{ method: string; path: string; bucket: string }> };
const REGISTERED = new Set(inv.routes.map((r) => `${r.method} ${norm(r.path)}`));

/** A matrix entry MUST correspond to a route the gateway actually registers. */
function assertRegistered(method: string, template: string): void {
  expect(
    REGISTERED.has(`${method} ${norm(template)}`),
    `${method} ${template} is NOT a registered route — fictional matrix entry (R3 #1). ` +
      `Every matrix row must be a real route from buildInventory().`,
  ).toBe(true);
}

interface MatrixEntry {
  method: string;
  template: string; // the registered route template (with :params)
  concrete: string; // a concrete instantiation to resolve
  scopes: string[]; // exact expected winning scopes
  forbidden: string[]; // roles that MUST NOT be able to satisfy this gate
}

const MATRIX: MatrixEntry[] = [
  // ── admin-only onboarding lifecycle ──
  { method: "POST", template: "/api/onboard/registrations/:id/approve", concrete: "/api/onboard/registrations/reg1/approve", scopes: ["admin"], forbidden: ["operator", "requestor", "agent", "verifier"] },
  { method: "POST", template: "/api/onboard/registrations/:id/reject", concrete: "/api/onboard/registrations/reg1/reject", scopes: ["admin"], forbidden: ["operator", "requestor", "agent", "verifier"] },
  { method: "POST", template: "/api/onboard/registrations/:id/activate", concrete: "/api/onboard/registrations/reg1/activate", scopes: ["admin"], forbidden: ["operator", "requestor", "agent", "verifier"] },
  // ── verifier/admin attestation ──
  { method: "POST", template: "/api/jobs/:jobId/attestations/aggregate", concrete: "/api/jobs/job1/attestations/aggregate", scopes: ["verifier", "admin"], forbidden: ["requestor", "operator", "agent"] },
  // ── money-path escrow (buyer/operator) ──
  { method: "POST", template: "/api/escrow/chain/:address/fund", concrete: "/api/escrow/chain/0xabc/fund", scopes: ["requestor", "operator", "admin"], forbidden: ["agent", "verifier"] },
  { method: "POST", template: "/api/escrow/chain/:address/release/:milestoneIndex", concrete: "/api/escrow/chain/0xabc/release/0", scopes: ["requestor", "operator", "admin"], forbidden: ["agent", "verifier"] },
  // ── settlement flush (R3 #2 tightened operator/admin — no requestor) ──
  { method: "POST", template: "/api/settlement/flush", concrete: "/api/settlement/flush", scopes: ["operator", "admin"], forbidden: ["requestor", "agent", "verifier"] },
  // ── SWF governance (operator/admin — no requestor) ──
  { method: "POST", template: "/api/swf/proposals", concrete: "/api/swf/proposals", scopes: ["operator", "admin"], forbidden: ["requestor", "agent", "verifier"] },
  { method: "POST", template: "/api/swf/epochs", concrete: "/api/swf/epochs", scopes: ["operator", "admin"], forbidden: ["requestor", "agent", "verifier"] },
  // ── investment pools (money-path) ──
  { method: "POST", template: "/api/pool/create", concrete: "/api/pool/create", scopes: ["requestor", "operator", "admin"], forbidden: ["agent", "verifier"] },
  { method: "POST", template: "/api/pool/close/:poolId", concrete: "/api/pool/close/p1", scopes: ["requestor", "operator", "admin"], forbidden: ["agent", "verifier"] },
  // ── dispute RESOLUTION (R3 #2 tightened verifier/admin — no requestor/operator) ──
  { method: "POST", template: "/api/disputes/:disputeId/resolve", concrete: "/api/disputes/d1/resolve", scopes: ["verifier", "admin"], forbidden: ["requestor", "operator", "agent"] },
  // ── DePIN rewards claim ──
  { method: "POST", template: "/api/rewards/claims", concrete: "/api/rewards/claims", scopes: ["operator", "admin"], forbidden: ["requestor", "agent", "verifier"] },
];

describe("route-policy matrix — WINNING policy for REAL sensitive routes (R3 #1)", () => {
  for (const e of MATRIX) {
    it(`${e.method} ${e.template} → [${e.scopes.join(", ")}]`, () => {
      // 1. the route must actually exist (no fictional entries).
      assertRegistered(e.method, e.template);
      // 2. resolve the concrete path and assert the exact winning scopes.
      const r = resolvePolicy(e.method, e.concrete);
      expect(r.winner, `no policy matches ${e.method} ${e.concrete}`).toBeTruthy();
      expect(r.ambiguous, `ambiguous top-specificity policies for ${e.method} ${e.concrete}`).toBe(false);
      expect([...r.scopes].sort()).toEqual([...e.scopes].sort());
      // 3. explicitly-forbidden roles must not be in the winning gate.
      for (const bad of e.forbidden) {
        expect(r.scopes, `${bad} must NOT satisfy the gate for ${e.template}`).not.toContain(bad);
      }
    });
  }

  it("METHODOLOGY: the assert-registered guard catches fictional routes (R3 #1)", () => {
    // These are the exact fictional paths the previous matrix asserted. They match
    // broad manifest globs (so they'd resolve to 'expected' scopes) but are NOT
    // registered — the guard must reject them. This proves green≠proof is closed.
    const fictions: Array<[string, string]> = [
      ["POST", "/api/settlement/finalize"],
      ["POST", "/api/gasless/relay"],
      ["POST", "/api/treasury/move"],
      ["POST", "/api/rewards/distribute"],
      ["POST", "/api/milestones/m1/release"],
      ["POST", "/api/jobs/j1/attestations/456"], // real route is /attestations/aggregate
    ];
    for (const [method, path] of fictions) {
      // each still resolves to SOME scopes via a broad glob …
      expect(resolvePolicy(method, concretize(path)).scopes, `${path} unexpectedly unmatched`).toBeTruthy();
      // … but is NOT a registered route, so assertRegistered would fail it.
      expect(REGISTERED.has(`${method} ${norm(path)}`), `${path} must be unregistered`).toBe(false);
    }
  });

  it("attestations: the verifier rule beats the broad /api/jobs/** rule (finding #5 tie broken)", () => {
    const r = resolvePolicy("POST", "/api/jobs/x/attestations/aggregate");
    expect([...r.scopes].sort()).toEqual(["admin", "verifier"]);
    expect(r.scopes).not.toContain("requestor"); // broad jobs rule must NOT win
  });

  it("GLOBAL: no private /api route resolves to an ambiguous policy (R2 #4)", () => {
    // Every non-public route the gateway registers must have an unambiguous winner —
    // else the runtime winner would depend on insertion order.
    const ambiguous = inv.routes
      .filter((r) => r.bucket !== "public" && r.bucket !== "cross_lane_pending")
      .filter((r) => resolvePolicy(r.method, concretize(r.path)).ambiguous)
      .map((r) => `${r.method} ${r.path}`);
    expect(ambiguous).toEqual([]);
  });
});
