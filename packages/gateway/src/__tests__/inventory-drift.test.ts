import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  // @ts-expect-error — JS audit tool, no d.ts
  PUBLIC_PREFIXES, PUBLIC_EXACT,
  PUBLIC_CAPABILITY_DETAIL_RE, PUBLIC_OPERATOR_RATINGS_RE, PUBLIC_KERNEL_AGENT_CARD_RE,
  PUBLIC_JOB_OFFERS_DETAIL_RE, PUBLIC_COURIER_JOBS_DETAIL_RE, PUBLIC_ARTIFACTS_READ_RE,
  // @ts-expect-error — JS audit tool, no d.ts
  DEFAULT_SCOPE_REQUIREMENTS, isPublicRoute,
} from "../../../../scripts/audit/route-policy-inventory.mjs";

/**
 * Inventory drift guard (audit P0, lane d749deff; review finding #7).
 *
 * The inventory copies api-gate's public-route definitions. If api-gate.ts adds a
 * public prefix and the copy is not updated, runtime would expose a route publicly
 * while CI still treats it as private+scoped. This asserts the snapshot EQUALS the
 * live api-gate.ts source — so any change to the public lists fails CI until the
 * snapshot is re-synced (much stronger than the old `policed_by_default === 11`).
 */
const MW = join(dirname(fileURLToPath(import.meta.url)), "..", "middleware");
const API_GATE = join(MW, "api-gate.ts");
const SCOPE_CHECKER = join(MW, "scope-checker.ts");

/** Normalize a rule to a comparable key: METHOD pattern [sorted,scopes]. */
const ruleKey = (r: { method: string; pattern: string; scopes: string[] }): string =>
  `${r.method} ${r.pattern} [${[...r.scopes].sort().join(",")}]`;

/** Extract a `const NAME = [ "..." , ... ]` string-array from source, minus comments. */
function extractArray(src: string, name: string): string[] {
  const noComments = src.replace(/\/\/[^\n]*/g, "");
  const m = noComments.match(new RegExp(`(?:export )?const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  if (!m) throw new Error(`${name} not found in api-gate.ts`);
  return [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1]);
}

describe("inventory drift guard — api-gate public snapshot == source (finding #7)", () => {
  const src = readFileSync(API_GATE, "utf8");

  it("PUBLIC_PREFIXES snapshot matches api-gate.ts (a new public prefix fails CI)", () => {
    expect([...PUBLIC_PREFIXES].sort()).toEqual(extractArray(src, "PUBLIC_PREFIXES").sort());
  });

  it("PUBLIC_EXACT snapshot matches api-gate.ts", () => {
    expect([...PUBLIC_EXACT].sort()).toEqual(extractArray(src, "PUBLIC_EXACT").sort());
  });

  it("public REGEX snapshots match api-gate.ts (R2 #6 — a new public regex fails CI)", () => {
    const RES: Array<[string, RegExp]> = [
      ["PUBLIC_CAPABILITY_DETAIL_RE", PUBLIC_CAPABILITY_DETAIL_RE],
      ["PUBLIC_OPERATOR_RATINGS_RE", PUBLIC_OPERATOR_RATINGS_RE],
      ["PUBLIC_KERNEL_AGENT_CARD_RE", PUBLIC_KERNEL_AGENT_CARD_RE],
      ["PUBLIC_JOB_OFFERS_DETAIL_RE", PUBLIC_JOB_OFFERS_DETAIL_RE],
      ["PUBLIC_COURIER_JOBS_DETAIL_RE", PUBLIC_COURIER_JOBS_DETAIL_RE],
      ["PUBLIC_ARTIFACTS_READ_RE", PUBLIC_ARTIFACTS_READ_RE],
    ];
    const literalOf = (name: string): string => {
      const line = src.split("\n").find((l) => l.includes(`const ${name} =`));
      if (!line) throw new Error(`${name} not found in api-gate.ts`);
      const m = line.match(/=\s*(.+);\s*$/);
      if (!m) throw new Error(`could not parse ${name}`);
      return m[1].trim();
    };
    for (const [name, re] of RES) {
      expect(literalOf(name), name).toBe(re.toString());
    }
  });

  it("DEFAULT_SCOPE_REQUIREMENTS snapshot matches scope-checker.ts source (R3 #8)", () => {
    // The inventory copies scope-checker's default scope rules. If scope-checker
    // changes a default (or adds one) and the copy is not updated, the coverage
    // gate would classify routes against a stale default set. Assert the snapshot
    // equals the live scope-checker.ts DEFAULT_SCOPE_REQUIREMENTS array.
    const checkerSrc = readFileSync(SCOPE_CHECKER, "utf8");
    const decl = checkerSrc.indexOf("DEFAULT_SCOPE_REQUIREMENTS");
    expect(decl, "DEFAULT_SCOPE_REQUIREMENTS not found in scope-checker.ts").toBeGreaterThan(-1);
    // Anchor on the array literal `= [` (not the type annotation, whose `string[];`
    // would otherwise truncate the slice), then take up to the array's `];`.
    const arrStart = checkerSrc.indexOf("= [", decl);
    expect(arrStart, "DEFAULT_SCOPE_REQUIREMENTS array literal not found").toBeGreaterThan(-1);
    // scope-checker uses `scopes: [AUTHENTICATED_SENTINEL]` (a const, not a string
    // literal). Resolve it to its value so the scope parser (which reads quoted
    // strings) sees "@authenticated" instead of an empty scope list.
    const block = checkerSrc
      .slice(arrStart, checkerSrc.indexOf("];", arrStart))
      .replace(/AUTHENTICATED_SENTINEL/g, '"@authenticated"');
    const srcRules = [...block.matchAll(/\{\s*method:\s*"([^"]+)",\s*pattern:\s*"([^"]+)",\s*scopes:\s*\[([^\]]*)\]/g)].map((m) => ({
      method: m[1],
      pattern: m[2],
      scopes: [...m[3].matchAll(/"([^"]+)"/g)].map((s) => s[1]),
    }));
    expect(srcRules.length, "parsed 0 default rules from scope-checker.ts").toBeGreaterThan(0);
    expect(
      (DEFAULT_SCOPE_REQUIREMENTS as Array<{ method: string; pattern: string; scopes: string[] }>).map(ruleKey).sort(),
      "inventory DEFAULT_SCOPE_REQUIREMENTS snapshot is stale vs scope-checker.ts — re-sync it",
    ).toEqual(srcRules.map(ruleKey).sort());
  });

  it("GET /api/kernels method-specific public rule is mirrored + present in api-gate (R3 #8)", () => {
    const src = readFileSync(API_GATE, "utf8");
    // api-gate has a method-specific public case coded outside the arrays/regexes.
    expect(
      /method\s*===\s*"GET"\s*&&\s*path\s*===\s*"\/api\/kernels"/.test(src.replace(/\s+/g, " ")),
      "api-gate.ts lost the GET /api/kernels method-specific public rule — re-sync the mirror",
    ).toBe(true);
    // The inventory's runtime mirror must match that behavior exactly.
    expect(isPublicRoute("/api/kernels", "GET"), "GET /api/kernels must be public in the mirror").toBe(true);
    expect(isPublicRoute("/api/kernels", "POST"), "POST /api/kernels must NOT be public").toBe(false);
  });
});
