import { describe, it, expect } from "vitest";
// @ts-expect-error — JS audit tool, no d.ts
import { resolvePolicy } from "../../../../scripts/audit/route-policy-inventory.mjs";

/**
 * Route-policy MATRIX (audit P0, lane d749deff; review finding #4).
 *
 * The coverage gate proves every route matches SOME rule; this proves the WINNING
 * rule for security-sensitive routes yields the exact intended scopes. If a specific
 * rule is deleted and a broad glob inherits the route, the winning scopes change and
 * these fail — so coverage now enforces CORRECT policy, not merely "policed".
 *
 * Uses the deterministic specificity comparator in route-policy-inventory.mjs.
 * NOTE: the runtime scope-checker (9de363c7) must adopt the same comparator, or its
 * star-count-only sort will diverge from these intended winners (flagged on coord).
 */
const MATRIX: Array<[string, string, string[]]> = [
  ["POST", "/api/onboard/registrations/abc/approve", ["admin"]],
  ["POST", "/api/onboard/registrations/abc/reject", ["admin"]],
  ["POST", "/api/onboard/registrations/abc/activate", ["admin"]],
  ["POST", "/api/jobs/123/attestations/456", ["verifier", "admin"]],
  ["POST", "/api/admin/anything", ["admin"]],
  ["POST", "/api/escrow/chain/0xabc/fund", ["requestor", "operator", "admin"]],
  ["POST", "/api/fiat-ramp/offramp/withdraw", ["operator", "requestor", "admin"]],
  ["POST", "/api/swf/proposals", ["operator", "admin"]],
];

describe("route-policy matrix — the WINNING policy for sensitive routes (finding #4)", () => {
  for (const [method, path, expected] of MATRIX) {
    it(`${method} ${path} → [${expected.join(", ")}]`, () => {
      const r = resolvePolicy(method, path);
      expect(r.winner, `no policy matches ${method} ${path}`).toBeTruthy();
      expect(r.ambiguous, `ambiguous top-specificity policies for ${method} ${path}`).toBe(false);
      expect([...r.scopes].sort()).toEqual([...expected].sort());
    });
  }

  it("negative: operator/requestor/agent do NOT win an admin-only onboarding route", () => {
    const r = resolvePolicy("POST", "/api/onboard/registrations/abc/approve");
    expect(r.scopes).toEqual(["admin"]);
    for (const s of ["operator", "requestor", "agent"]) expect(r.scopes).not.toContain(s);
  });

  it("attestations: the verifier rule beats the broad /api/jobs/** rule (finding #5 tie broken)", () => {
    const r = resolvePolicy("POST", "/api/jobs/123/attestations/456");
    expect([...r.scopes].sort()).toEqual(["admin", "verifier"]);
    expect(r.scopes).not.toContain("requestor"); // broad jobs rule must NOT win
  });

  it("no sensitive route resolves to an ambiguous (conflicting equal-specificity) policy", () => {
    for (const [method, path] of MATRIX) {
      expect(resolvePolicy(method, path).ambiguous, `${method} ${path} ambiguous`).toBe(false);
    }
  });
});
