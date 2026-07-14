import { describe, it, expect } from "vitest";
import { compareSpecificity as tsCompare } from "../policy/route-policy-precedence.js";
// @ts-expect-error — JS audit tool, no d.ts
import { compareSpecificity as jsCompare } from "../../../../scripts/audit/route-policy-inventory.mjs";

/**
 * Comparator parity (audit P0, lane d749deff; review R2 #5). The canonical
 * precedence comparator lives in policy/route-policy-precedence.ts (which the
 * runtime scope-checker must adopt); the inventory keeps a JS mirror because it
 * must stay `node`-runnable. This proves the two can't silently diverge.
 */
const RULES = [
  { method: "POST", pattern: "/api/onboard/registrations/*/approve", scopes: ["admin"] },
  { method: "*", pattern: "/api/onboard/**", scopes: ["operator", "admin"] },
  { method: "POST", pattern: "/api/jobs/*/attestations/*", scopes: ["verifier", "admin"] },
  { method: "*", pattern: "/api/jobs/**", scopes: ["requestor", "operator", "agent", "admin"] },
  { method: "*", pattern: "/api/admin/*", scopes: ["admin"] },
  { method: "*", pattern: "/api/admin/**", scopes: ["admin"] },
  { method: "POST", pattern: "/api/escrow", scopes: ["admin"] },
  { method: "*", pattern: "/api/escrow/**", scopes: ["requestor", "operator", "admin"] },
];

describe("comparator parity — inventory JS mirror agrees with the canonical TS (R2 #5)", () => {
  it("produces the same ordering sign for every rule pair", () => {
    for (const a of RULES) {
      for (const b of RULES) {
        expect(Math.sign(jsCompare(a, b)), `${a.pattern} vs ${b.pattern}`).toBe(Math.sign(tsCompare(a, b)));
      }
    }
  });
});
