/**
 * N34 ratchet (steward #2498): gateway routes must not grow new fixtures or random values.
 *
 * For every file under src/routes it counts
 *   - mock DATA declarations: a `mock*`, `MOCK_*`, `fake*` or `FAKE_*` binding initialized
 *     with an array or object literal (or a new Map/Set), and
 *   - value-producing `Math.random()` calls (the `Math.random().toString(36)` id idiom is
 *     not a value a client sees as data, so it is not counted).
 *
 * A file may have them only as ALLOWLIST says, and every entry names an owner and why it may
 * stay for now (in most files: the data is served only with PCC_DEMO_ROUTES, and marked).
 * Shrink-only: a count above its allowance fails (new fabrication), and so does an allowance
 * above the count (lower it, to lock in the gain) or an entry for a file with none.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROUTES_DIR = fileURLToPath(new URL("../routes/", import.meta.url));

interface Allowance {
  mockData: number;
  random: number;
  owner: string;
  why: string;
}

const DEMO = "served only with PCC_DEMO_ROUTES (never in production), marked mock/demo; 501 not_available otherwise (N34)";

export const ALLOWLIST: Readonly<Record<string, Allowance>> = Object.freeze({
  "agents.ts": { mockData: 1, random: 0, owner: "readmodels", why: DEMO },
  "discover.ts": { mockData: 1, random: 0, owner: "readmodels", why: `${DEMO}; demo onboarding registers nothing` },
  "logistics.ts": { mockData: 5, random: 0, owner: "carrier", why: `${DEMO}; the family is retired (carrier #2922)` },
  "marketplace.ts": { mockData: 4, random: 0, owner: "readmodels", why: DEMO },
  "operator.ts": { mockData: 3, random: 1, owner: "readmodels", why: "answered 501 not_available by #362 (N32), which also removes them" },
  "orchestrator.ts": { mockData: 7, random: 0, owner: "refvertical", why: `${DEMO}; to wire or retire (steward #2498)` },
  "pizza-demo.ts": { mockData: 0, random: 2, owner: "product-steward", why: "an explicit demo route (census); to move behind the demo gate" },
  "protocols.ts": { mockData: 7, random: 0, owner: "refvertical", why: `${DEMO}; to wire or retire (steward #2498)` },
  "registry.ts": { mockData: 1, random: 0, owner: "readmodels", why: `${DEMO} (attestations)` },
  "rewards.ts": { mockData: 5, random: 0, owner: "readmodels", why: DEMO },
  "spaces.ts": { mockData: 1, random: 1, owner: "readmodels", why: `${DEMO}; the random match score is drawn only in demo mode` },
});

const DATA_DECL = /\b(?:const|let|var)\s+(mock[A-Z]\w*|MOCK_[A-Z0-9_]+|fake[A-Z]\w*|FAKE_[A-Z0-9_]+)\b\s*(?::[^=;]+)?=\s*(?:\[|\{|new Map\(|new Set\()/g;
const VALUE_RANDOM = /Math\.random\(\)(?!\.toString\(36\))/g;

/** Counts in one source text, ignoring comments. */
export function countFabrication(src: string): { mockData: number; random: number } {
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // A line comment, but not the `//` of a URL such as "https://" or "ipp://".
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  return {
    mockData: [...code.matchAll(DATA_DECL)].length,
    random: [...code.matchAll(VALUE_RANDOM)].length,
  };
}

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const actual = new Map<string, { mockData: number; random: number }>();
for (const file of routeFiles(ROUTES_DIR)) {
  const c = countFabrication(readFileSync(file, "utf8"));
  if (c.mockData > 0 || c.random > 0) actual.set(relative(ROUTES_DIR, file), c);
}

describe("N34 ratchet: gateway routes serve no new fixtures or random values", () => {
  it("no route file exceeds its allowance, and a file not listed has none", () => {
    const over: string[] = [];
    for (const [file, c] of actual) {
      const a = ALLOWLIST[file] ?? { mockData: 0, random: 0 };
      if (c.mockData > a.mockData) over.push(`${file}: ${c.mockData} mock data declarations (allowed ${a.mockData})`);
      if (c.random > a.random) over.push(`${file}: ${c.random} value-producing Math.random() calls (allowed ${a.random})`);
    }
    expect(over, "New fixture data or random values in a route. Serve real data, or refuse (501 not_available) outside PCC_DEMO_ROUTES.").toEqual([]);
  });

  it("the allowlist only shrinks: each allowance equals today's count", () => {
    const stale: string[] = [];
    for (const [file, a] of Object.entries(ALLOWLIST)) {
      const c = actual.get(file) ?? { mockData: 0, random: 0 };
      if (a.mockData > c.mockData || a.random > c.random) {
        stale.push(`${file}: allowed ${a.mockData}/${a.random}, found ${c.mockData}/${c.random}`);
      }
    }
    expect(stale, "Lower these allowances (or remove the entry) to lock in the gain.").toEqual([]);
  });

  it("every entry names an owner and a reason", () => {
    for (const [file, a] of Object.entries(ALLOWLIST)) {
      expect(a.owner.trim(), file).not.toBe("");
      expect(a.why.trim().length, file).toBeGreaterThan(10);
    }
  });
});

describe("the ratchet's detector", () => {
  it("counts mock data declarations and value-producing random calls", () => {
    expect(countFabrication("const mockThings = [1, 2];")).toEqual({ mockData: 1, random: 0 });
    expect(countFabrication("const MOCK_TABLE: Record<string, number> = { a: 1 };")).toEqual({ mockData: 1, random: 0 });
    expect(countFabrication("let fakeIndex = new Map();")).toEqual({ mockData: 1, random: 0 });
    expect(countFabrication("const score = 70 + Math.random() * 25;")).toEqual({ mockData: 0, random: 1 });
    expect(countFabrication("x = Math.random() > 0.5;")).toEqual({ mockData: 0, random: 1 });
  });

  it("does not count ids, strings, derived values or comments", () => {
    expect(countFabrication('const id = `offer-${Math.random().toString(36).slice(2)}`;')).toEqual({ mockData: 0, random: 0 });
    expect(countFabrication('const MOCK_NOTE = "a warning string";')).toEqual({ mockData: 0, random: 0 });
    expect(countFabrication("const mockAddress = `0x${hex}`;")).toEqual({ mockData: 0, random: 0 });
    expect(countFabrication("// const mockThings = [1];\n/* Math.random() */")).toEqual({ mockData: 0, random: 0 });
    expect(countFabrication('const url = "ipp://printer/ipp"; const mockX = [];')).toEqual({ mockData: 1, random: 0 });
  });
});
