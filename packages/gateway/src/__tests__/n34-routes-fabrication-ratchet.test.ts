/**
 * N34 ratchet (steward #2498): gateway routes must not grow new fixtures or random values.
 *
 * For every file under src/routes it counts
 *   - fixture DATA declarations: a top-level binding whose name marks it as a fixture (a demo,
 *     mock, fake, sample, seed or fixture prefix or suffix, in any case style), whatever its
 *     initializer, except one that is only a string or template literal (a derived id, address
 *     or note) or exactly one regular-expression literal (a pattern); and every JSON import;
 *   - value-producing `Math.random()` calls (the `Math.random().toString(36)` id idiom is
 *     not a value a client sees as data, so it is not counted).
 *
 * A file may have them only as ALLOWLIST says, and every entry names an owner, why it may
 * stay for now (in most files: the data is served only with PCC_DEMO_ROUTES, and marked) and
 * the exact binding names it covers, so swapping one fixture for another fails too.
 * Shrink-only: a count above its allowance fails (new fabrication), and so does an allowance
 * above the count (lower it, to lock in the gain) or an entry for a file with none.
 *
 * It cannot see a literal written inline in a handler, an imported mock service (the SWF's was
 * one), or a NEW route that serves such a literal with a 200 (reviewer round 2, MEDIUM A —
 * reproduced via `app.get("/api/marketplace/new", async () => [{ id: "fixture" }])`, which
 * this ratchet does not catch). A new route that instead REFUSES (501) without being
 * documented is caught by the context pack's refused-is-documented check; a new LIVE GET
 * route in one of the ten N34 route families context-pack-availability.test.ts probes is
 * caught by its route-inventory check. Neither covers a new POST/PUT/PATCH/DELETE route, a
 * live GET added outside those ten families, or an existing route's handler rewritten in
 * place (same path, a real read swapped for a literal) — all still invisible to every check
 * in this file.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROUTES_DIR = fileURLToPath(new URL("../routes/", import.meta.url));

interface Allowance {
  mockData: number;
  random: number;
  /**
   * The exact binding (or `import:<path>` for a JSON import) names the allowance covers,
   * in source order. Pinning by NAME (not just count) closes the swap gap (reviewer-n34-b):
   * replacing one allowed fixture with a differently-named one of the same count used to
   * pass silently; now the name set itself must match exactly.
   */
  names: string[];
  owner: string;
  why: string;
}

const DEMO = "served only with PCC_DEMO_ROUTES (never in production), marked mock/demo; 501 not_available otherwise (N34)";

export const ALLOWLIST: Readonly<Record<string, Allowance>> = Object.freeze({
  "agents.ts": { mockData: 1, random: 0, names: ["mockConversations"], owner: "readmodels", why: DEMO },
  "context-pack.ts": {
    mockData: 1,
    random: 0,
    names: ["DEMO_ONLY_ENDPOINTS"],
    owner: "readmodels",
    why:
      "the agent context pack's own list of routes that refuse outside demo mode " +
      "(reviewer-n34-b F-E) — documentation of real refusals, never served as business data",
  },
  "discover.ts": { mockData: 1, random: 0, names: ["MOCK_IPP_PRINTERS"], owner: "readmodels", why: `${DEMO}; demo onboarding registers nothing` },
  "logistics.ts": {
    mockData: 5,
    random: 0,
    names: ["mockProviders", "mockShipments", "mockBookings", "mockInstallations", "mockTimeline"],
    owner: "carrier",
    why: `${DEMO}; the family is retired (carrier #2922)`,
  },
  "marketplace.ts": { mockData: 4, random: 0, names: ["mockClasses", "mockSnapshots", "mockListings", "mockOrders"], owner: "readmodels", why: DEMO },
  "operator.ts": {
    mockData: 3,
    random: 1,
    names: ["mockMachines", "mockCerts", "mockMaintenance"],
    owner: "readmodels",
    why: "answered 501 not_available by #362 (N32), which also removes them",
  },
  "orchestrator.ts": {
    mockData: 7,
    random: 0,
    names: ["mockNodes", "mockEdges", "mockGraph", "mockSamples", "mockWorkflowSteps", "mockWorkflows", "mockClaims"],
    owner: "refvertical",
    why: `${DEMO}; to wire or retire (steward #2498)`,
  },
  "pizza-demo.ts": { mockData: 0, random: 2, names: [], owner: "product-steward", why: "an explicit demo route (census); to move behind the demo gate" },
  "protocols.ts": {
    mockData: 7,
    random: 0,
    names: ["mockTemplates", "mockForks", "mockRunSteps", "mockRunTransfers", "mockRuns", "mockAutomationStatuses", "mockTransferAgents"],
    owner: "refvertical",
    why: `${DEMO}; to wire or retire (steward #2498)`,
  },
  "registry.ts": { mockData: 1, random: 0, names: ["mockAttestations"], owner: "readmodels", why: `${DEMO} (attestations)` },
  "rewards.ts": {
    mockData: 5,
    random: 0,
    names: ["mockCertificates", "mockKernelScores", "mockEpochs", "mockClaims", "mockTreasury"],
    owner: "readmodels",
    why: DEMO,
  },
  "spaces.ts": { mockData: 1, random: 1, names: ["mockSpaces"], owner: "readmodels", why: `${DEMO}; the random match score is drawn only in demo mode` },
});

const VALUE_RANDOM = /Math\.random\(\)(?!\.toString\(36\))/g;

/**
 * Fixture-like binding-name keywords (reviewer-n34-b, F-B). The old regex only recognized
 * a `mock`/`MOCK_`/`fake`/`FAKE_` PREFIX; `demoRows`, `sampleData`, `seedRows`,
 * `fixtureList` and suffix forms (`rowsDemo`) all evaded it.
 */
const FIXTURE_KEYWORDS = ["demo", "mock", "fake", "sample", "seed", "fixture"] as const;
const isUpperLetter = (ch: string | undefined): boolean =>
  ch !== undefined && ch === ch.toUpperCase() && ch !== ch.toLowerCase();

/**
 * True if `name` starts with a fixture keyword immediately followed by a camelCase
 * boundary (an uppercase letter), a digit, an underscore (`DEMO_ROWS`), or nothing at all
 * (the bare keyword). The boundary check is deliberately case-SENSITIVE — a naive
 * case-insensitive regex here would let `[A-Z]` match lowercase too, and "sampler" /
 * "downsamplePoints" would wrongly look like they start with the "sample" keyword at a
 * real boundary.
 */
function hasFixturePrefix(name: string): boolean {
  const lower = name.toLowerCase();
  for (const kw of FIXTURE_KEYWORDS) {
    if (!lower.startsWith(kw)) continue;
    const next = name[kw.length];
    if (next === undefined || next === "_" || /[0-9]/.test(next) || isUpperLetter(next)) return true;
  }
  return false;
}

/**
 * True if `name` ends with the Capitalized keyword right after a lower/digit char
 * (`rowsDemo`), or ends with `_KEYWORD` in ALL CAPS (`ROWS_DEMO`). Rules out
 * "currentSampler" (extra trailing letters after "Sampler" != "Sample").
 */
function hasFixtureSuffix(name: string): boolean {
  for (const kw of FIXTURE_KEYWORDS) {
    const cap = kw[0]!.toUpperCase() + kw.slice(1);
    if (name.endsWith(cap)) {
      const before = name[name.length - cap.length - 1];
      if (before === undefined || /[a-z0-9]/.test(before)) return true;
    }
    if (name.endsWith(`_${kw.toUpperCase()}`)) return true;
  }
  return false;
}

const isFixtureName = (name: string): boolean => hasFixturePrefix(name) || hasFixtureSuffix(name);

/** A `const|let|var <name>(: Type)? = ` declaration, name captured. Matched independently
 * of the initializer's shape — the old regex's fixed `[`/`{`/`new Map(`/`new Set(`
 * whitelist was itself a gap: `Array.from(...)`, `Object.assign(...)`, `structuredClone(...)`
 * all evaded it even on an already-recognized `mockRows`-style name. */
const DECL_RE = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=;\n]*)?=\s*/g;
/** A JSON import: the extension alone is the fixture signal, regardless of binding name. */
const JSON_IMPORT_RE = /\bimport\s+[^;\n]*?from\s*["']([^"']+\.json)["']/g;
/** An initializer that is ITSELF just a string/template literal is a DERIVED value (an id,
 * an address, a note) — not fixture data — even when the name matches (`mockAddress`,
 * `MOCK_NOTE`; literals joined by `+` count as one), but only when they end the statement:
 * `"a,b".split(",")` is a call and still counts. An initializer that is exactly one regular-expression literal is a pattern
 * that checks input (fiat-ramp.ts's `DEMO_WALLET_REF_RE`, #373), not data either. The literal
 * must end the statement: a regex that is called or combined, on the same line or a later one
 * (`/x/` then `.exec(rows)`), still counts. These are the only initializer shapes excluded;
 * arrays, objects, `new X()`, and any function call all count once the name matches. */
/** After a literal: spaces or tabs, then `;`, the end, or a newline whose next token does not continue
 * the expression (. [ ( ` ? a binary operator, in, instanceof). */
const STATEMENT_END = String.raw`[ \t]*(?:;|$|\r?\n(?![ \t\r\n]*(?:[.[(\x60?+\-*/%&|^<>=!,:]|in\b|instanceof\b)))`;
/** One string or template literal (a template may hold ${...}). */
const STRING_LITERAL = String.raw`(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\x60(?:\\.|[^\x60\\])*\x60)`;
/** String literals only, joined by `+` (a note split over lines), ending the statement. */
const STRING_INITIALIZER_RE = new RegExp(String.raw`^${STRING_LITERAL}(?:\s*\+\s*${STRING_LITERAL})*` + STATEMENT_END);
/** Exactly one regular-expression literal, ending the statement. */
const REGEX_LITERAL_INITIALIZER_RE = new RegExp(String.raw`^\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[a-z]*` + STATEMENT_END);

/** True if the match at `index` sits on a line with zero leading whitespace — a fixture is
 * a top-level (module-scope) declaration, not a handler-local variable derived from one
 * (`let samples = [...mockSamples]` inside a route handler must not double-count the
 * already-counted `mockSamples`). Checking the ENCLOSING LINE's first character (rather
 * than anchoring the match itself to `^`) still allows two declarations sharing one
 * zero-indent line (`const url = "..."; const mockX = [];`). */
function isTopLevel(code: string, index: number): boolean {
  const lineStart = code.lastIndexOf("\n", index - 1) + 1;
  const ch = code[lineStart];
  return ch !== " " && ch !== "\t";
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // A line comment, but not the `//` of a URL such as "https://" or "ipp://".
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function declaredFixtureNames(code: string): string[] {
  const names: string[] = [];
  for (const m of code.matchAll(DECL_RE)) {
    if (!isTopLevel(code, m.index!)) continue;
    const name = m[1]!;
    if (!isFixtureName(name)) continue;
    const rest = code.slice(m.index! + m[0].length, m.index! + m[0].length + 4000);
    if (STRING_INITIALIZER_RE.test(rest) || REGEX_LITERAL_INITIALIZER_RE.test(rest)) continue;
    names.push(name);
  }
  for (const m of code.matchAll(JSON_IMPORT_RE)) {
    if (!isTopLevel(code, m.index!)) continue;
    names.push(`import:${m[1]}`);
  }
  return names;
}

/** The binding (or JSON-import path) names a source's fixture-like declarations use — for
 * the allowlist's per-name pin (reviewer-n34-b: a plain count let one allowed fixture be
 * swapped for a new one of the same name-count). */
export function fixtureNames(src: string): string[] {
  return declaredFixtureNames(stripComments(src));
}

/** Counts in one source text, ignoring comments. */
export function countFabrication(src: string): { mockData: number; random: number } {
  const code = stripComments(src);
  return {
    mockData: declaredFixtureNames(code).length,
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
const actualNames = new Map<string, string[]>();
for (const file of routeFiles(ROUTES_DIR)) {
  const src = readFileSync(file, "utf8");
  const rel = relative(ROUTES_DIR, file);
  const c = countFabrication(src);
  if (c.mockData > 0 || c.random > 0) actual.set(rel, c);
  const names = fixtureNames(src);
  if (names.length > 0) actualNames.set(rel, names);
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

  it("NEGATIVE (F-B, reviewer r1a): the allowlist pins each fixture by NAME, not just count — swapping one allowed fixture for a new one of the same count fails", () => {
    const mismatches: string[] = [];
    const allFiles = new Set([...Object.keys(ALLOWLIST), ...actualNames.keys()]);
    for (const file of allFiles) {
      const allowed = [...(ALLOWLIST[file]?.names ?? [])].sort();
      const found = [...(actualNames.get(file) ?? [])].sort();
      if (JSON.stringify(allowed) !== JSON.stringify(found)) {
        mismatches.push(`${file}: allowlist names ${JSON.stringify(allowed)}, found ${JSON.stringify(found)}`);
      }
    }
    expect(mismatches, "A fixture's binding name changed (or was swapped for a new one) without updating the allowlist pin.").toEqual([]);
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
    // A bare regex literal is a pattern, not data (fiat-ramp.ts, #373)...
    expect(countFabrication("const DEMO_WALLET_REF_RE = /^demo-wallet-([0-9a-f]{16})$/;")).toEqual({ mockData: 0, random: 0 });
    expect(countFabrication("const MOCK_ID_RE = /^mock-[a-z/]+$/i\nconst x = 1;")).toEqual({ mockData: 0, random: 0 });
    // ...but a regex that is CALLED can produce data, so it still counts.
    expect(countFabrication("const mockMatch = /^(.*)$/.exec(rowsText);")).toEqual({ mockData: 1, random: 0 });
    expect(countFabrication("const demoRows = /,/[Symbol.split](text);")).toEqual({ mockData: 1, random: 0 });
    // A string that is called or combined is not a derived value either (packer review of 32f663cd).
    expect(countFabrication('const mockRows = "a,b".split(",");')).toEqual({ mockData: 1, random: 0 });
    expect(countFabrication("const demoCsv = `x,y`\n  .split(',');")).toEqual({ mockData: 1, random: 0 });
    expect(countFabrication("const MOCK_LABEL = 'pre' + suffix;")).toEqual({ mockData: 1, random: 0 });
    expect(countFabrication("const MOCK_ID = 'x';\nconst y = 1;")).toEqual({ mockData: 0, random: 0 });
    // String literals joined by + are one note (DEMO_ONLY_NOTE, MOCK_WALLET_NOTE); anything else joined in counts.
    expect(countFabrication('const MOCK_NOTE =\n  "a " +\n  "b";')).toEqual({ mockData: 0, random: 0 });
    expect(countFabrication('const MOCK_NOTE = "a " + rows.join(",");')).toEqual({ mockData: 1, random: 0 });
    // ...on a later line too: JavaScript continues the expression (packer review of afeda4b8).
    expect(countFabrication("const mockMatch = /^(.*)$/\n  .exec(rowsText);")).toEqual({ mockData: 1, random: 0 });
    expect(countFabrication("const demoRows = /,/\n\n  [Symbol.split](text);")).toEqual({ mockData: 1, random: 0 });
    expect(countFabrication("const mockRows = /x/g\n  || fallbackRows;")).toEqual({ mockData: 1, random: 0 });
    // A literal that ends its statement, with a comment or a new statement after it, is still a pattern.
    expect(countFabrication("const MOCK_RE = /^a$/ // the pattern\nconst y = 2;")).toEqual({ mockData: 0, random: 0 });
  });

  it("NEGATIVE (F-B, reviewer r1a): catches the three forms that evaded the old narrow regex", () => {
    // "demo" is now a recognized fixture-name prefix (previously only mock/fake).
    expect(countFabrication("const demoRows = [{id: 1}]")).toEqual({ mockData: 1, random: 0 });
    // A fixture-named binding initialized via a function call (Array.from), not just a
    // bare literal or new Map/Set — the old regex required one of a fixed set of
    // initializer heads.
    expect(countFabrication("const mockRows = Array.from({length: 2}, (_, i) => i)")).toEqual({ mockData: 1, random: 0 });
    // A JSON import bypasses "declaration with a data-shaped initializer" entirely.
    expect(countFabrication('import rows from "./fixture.json"')).toEqual({ mockData: 1, random: 0 });
  });

  it("F-B: other obvious fixture-name variants (sample/seed/fixture, suffix form, ALL_CAPS)", () => {
    expect(countFabrication("const sampleData = [1, 2];")).toEqual({ mockData: 1, random: 0 });
    expect(countFabrication("let seedRows = [1];")).toEqual({ mockData: 1, random: 0 });
    expect(countFabrication("const fixtureList = [1];")).toEqual({ mockData: 1, random: 0 });
    expect(countFabrication("const FAKE_ROWS = [1];")).toEqual({ mockData: 1, random: 0 });
    expect(countFabrication("const DEMO_ROWS = [1];")).toEqual({ mockData: 1, random: 0 });
    // suffix form: the fixture keyword doesn't have to lead.
    expect(countFabrication("const rowsDemo = [1];")).toEqual({ mockData: 1, random: 0 });
  });

  it("F-B: a swapped initializer shape (still not a string) is still caught — the gap was the fixed initializer list, not the concept", () => {
    expect(countFabrication("const mockObj = Object.assign({}, base);")).toEqual({ mockData: 1, random: 0 });
    expect(countFabrication("const mockCloned = structuredClone(base);")).toEqual({ mockData: 1, random: 0 });
  });
});
