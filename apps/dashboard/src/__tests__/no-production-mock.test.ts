/**
 * No production mock: a ratchet.
 *
 * Product invariant 3: a production surface never silently substitutes mock
 * data for real data. Empty, error, stale and demo are valid states;
 * plausible fixtures are not. Fixtures belong under src/demo/ and may render
 * only in demo mode (lib/demo-mode.ts).
 *
 * This test scans every production module in apps/dashboard/src for the
 * fixture patterns this codebase actually uses. Tests, src/demo/ and the
 * empty api/mock-*.ts shims are skipped. Files that still contain fixtures
 * are listed in KNOWN_OFFENDERS, each with the lane that owns the fix. The
 * list only shrinks:
 *   - a new file with fixtures fails the test;
 *   - a listed file that no longer has fixtures fails too, until its entry
 *     is deleted.
 *
 * It is a guard, not a proof: a fallback written as a bare object literal
 * inside a catch block is invisible to it, which is why review still matters.
 * The demo-import check below only asks that a module importing src/demo/
 * also checks isDemoMode(); it cannot see which branch uses the values. The
 * per-page honesty tests are what prove each page renders no fixture outside
 * demo mode.
 * Server-side fabrication (a gateway route returning hard-coded data) is also
 * invisible here; SERVER_FABRICATED records the known cases so they are
 * not silently exempt.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, posix, relative, sep } from "node:path";
import ts from "typescript";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
/** @pcc/ui's source: shell chrome such as the StatusBar lives there. Its files are keyed "ui:<path>". */
const UI_SRC = join(SRC, "../../../packages/ui/src");

/** Patterns that mark fixture data or a fallback to it. */
const PATTERNS: Array<[name: string, rx: RegExp]> = [
  ["MOCK_* constant", /\bMOCK_[A-Z0-9_]+/g],
  ["mock* identifier", /\bmock[A-Z][A-Za-z0-9]*/g],
  ["fixture generator", /\b(makeMock\w*|generateMock\w*|makeFallbackData)\b/g],
  ["mock module import", /from\s+['"][./]+(?:api\/)?mock-(?:data|onboarding-data|revenue-data)(?:\.js)?['"]/g],
  ["fallback-to-mock comment", /(?:keep|fall ?back to|falls back to|fallback to|fall through to)\s+mock|(?<!\bno\s)mock\s+fallback/gi],
  ["mock/fallback flag", /\busing(?:Mock|Fallback)\b/g],
  // Onboarding that ends in a mock device is fabricated capability (product-steward #2373 gap 1).
  ["mock adapter registration", /\b(?:adapterType|adapterKind|adapter)\s*[:=]\s*["'`]mock["'`]/g],
  ["dev kernel id", /\bkernel_dev_\w+/g],
  // Authoritative values written as literals (gap 2; the StatusBar and Settings regressions #352 fixed).
  [
    "authoritative prop literal",
    /\s(?:kernelsOnline|activeJobs|networkStatus|blockNumber|balance|usdcBalance|walletBalance|walletAddress|address)=(?:\{\s*(?:-?\d|["'`]|true|false)|["'])/g,
  ],
  ["connected default", /\bnetworkStatus\s*=\s*["'`]connected/g],
  ["placeholder address", /0x1234567890abcdef/gi],
  // Fixture modules outside src/demo/ (gap 3: components/viewer/fixtures.ts).
  ["fixtures module import", /from\s+['"](?:\.{1,2}\/)+(?:(?!demo\/)[\w-]+\/)*fixtures(?:\.js)?['"]/g],
];

/** Identifiers that match a pattern but name real API fields, not fixtures. */
const IGNORED_IDENTIFIERS = new Set([
  "mockUSDC", // GET /api/status/integrations reports the deployed MockUSDC token address
  "mockMode", // a real field of POST /api/setup/generate-config
]);

/** Files that still contain fixtures, each keyed to the lane that owns the fix. */
const KNOWN_OFFENDERS: Record<string, string> = {
  // readmodels c255d7dc (PX-6 / PX-7)
  "pages/EvidenceExplorerPage.tsx": "readmodels c255d7dc: EvidenceSummary read model",
  "pages/SettlementPage.tsx": "readmodels c255d7dc: settlement read model, no mock fallback",
  // economics df42dbe5 (product s9: older IP/royalty pages)
  "pages/IPRevenuePage.tsx": "economics df42dbe5",
  "pages/IPDashboardPage.tsx": "economics df42dbe5",
  "pages/IPDetailPage.tsx": "economics df42dbe5",
  "pages/RevenueClaimsPage.tsx": "economics df42dbe5",
  // operator-ux f0734fab (product s8: remove silent mock fallbacks)
  "pages/OperatorDashboardPage.tsx": "operator-ux f0734fab",
  "pages/OperatorMachineDetailPage.tsx": "operator-ux f0734fab",
  "pages/OperatorMobilePage.tsx": "operator-ux f0734fab",
  // adk 4f6668ed (PX-10: onboarding becomes an ADK client; mock wizard retired)
  "pages/onboard/Step2_Documentation.tsx": "adk 4f6668ed",
  "pages/onboard/Step4_PhysicalSpace.tsx": "adk 4f6668ed",
  "pages/onboard/Step5_Pricing.tsx": "adk 4f6668ed",
  "pages/onboard/Step6_Operator.tsx": "adk 4f6668ed",
  "pages/SetupAgentPage.tsx": "adk 4f6668ed",
  "pages/onboard/Step7_Review.tsx": "adk 4f6668ed: registers adapterType 'mock' (the EXPERIENCE-COMPLETE blocker)",
  "pages/StartPage.tsx": "adk 4f6668ed: registers against kernel_dev_001 / adapter 'mock'",
  // logistics N-b: product-steward 61243bdd / readmodels, carrier af177c03 supplies the mapping (#2257, #2264)
  "pages/InstallationDetailPage.tsx": "logistics N-b (carrier #2264)",
  "pages/ShipmentDetailPage.tsx": "logistics N-b (carrier #2264)",
  "pages/SpaceBookingsPage.tsx": "logistics N-b (carrier #2264)",
  // product review #3985 (#408): RETIRE, left at master pending economics #394
  "pages/SWFDashboardPage.tsx": "RETIRE (PRODUCT-BOARD s4): economics #394 deletes the page",
  "pages/SWFGovernancePage.tsx": "RETIRE (PRODUCT-BOARD s4): economics #394 deletes the page",
  "pages/DePINDashboardPage.tsx": "RETIRE (PRODUCT-BOARD s4): economics #394 deletes the page",
};

/**
 * Pages whose fabricated data comes from the gateway, so no client scan can
 * see it. Listed so they are tracked, not exempt.
 */
const SERVER_FABRICATED: Record<string, string> = {
  "pages/LogisticsHubPage.tsx":
    "packages/gateway/src/routes/logistics.ts returns hard-coded providers, shipments and quotes (carrier #2264, steward N-b)",
};

/**
 * Pages no test renders yet (astra 408a). A fixture written as a bare object
 * literal matches no pattern above, so the per-page tests are the backstop:
 * every page module needs a test that imports it. These pages predate the
 * rule. The list only shrinks: a new page must come with its test, and a
 * listed page that gains one (or is deleted) must leave the list.
 */
const UNTESTED_PAGES: Record<string, string> = {
  "pages/AgentChatPage.tsx": "no page test yet",
  "pages/AgentPackagePage.tsx": "no page test yet",
  "pages/AnalyticsDashboardPage.tsx": "no page test yet",
  "pages/BatchBoardPage.tsx": "no page test yet",
  "pages/BatchTrackingPage.tsx": "no page test yet",
  "pages/BuilderPage.tsx": "no page test yet",
  "pages/DePINDashboardPage.tsx": "fixtures, owned by RETIRE (PRODUCT-BOARD s4): economics #394 deletes the page",
  "pages/DeviceBuilderPage.tsx": "no page test yet",
  "pages/EvidenceExplorerPage.tsx": "fixtures, owned by readmodels c255d7dc: EvidenceSummary read model",
  "pages/IPDashboardPage.tsx": "fixtures, owned by economics df42dbe5",
  "pages/IPDetailPage.tsx": "fixtures, owned by economics df42dbe5",
  "pages/IPRevenuePage.tsx": "fixtures, owned by economics df42dbe5",
  "pages/InstallationDetailPage.tsx": "fixtures, owned by logistics N-b (carrier #2264)",
  "pages/JobDetailPage.tsx": "no page test yet",
  "pages/LandingPage.tsx": "no page test yet",
  "pages/LoginPage.tsx": "no page test yet",
  "pages/LogisticsHubPage.tsx": "server-fabricated: see SERVER_FABRICATED",
  "pages/NegotiationSessionPage.tsx": "no page test yet",
  "pages/OnboardChatPage.tsx": "no page test yet",
  "pages/OnboardKitPage.tsx": "no page test yet",
  "pages/OnboardLandingPage.tsx": "no rendering test: OnboardLandingPage.test.tsx checks its source text only (astra 408d)",
  "pages/OnboardWizardPage.tsx": "no page test yet",
  "pages/OperatorDashboardPage.tsx": "fixtures, owned by operator-ux f0734fab",
  "pages/OperatorMachineDetailPage.tsx": "fixtures, owned by operator-ux f0734fab",
  "pages/OperatorMobilePage.tsx": "fixtures, owned by operator-ux f0734fab",
  "pages/OrchestratorDetailPage.tsx": "no page test yet",
  "pages/OrchestratorPage.tsx": "no page test yet",
  "pages/ProtocolBuilderPage.tsx": "no page test yet",
  "pages/ProtocolDetailPage.tsx": "no page test yet",
  "pages/ProtocolLibraryPage.tsx": "no page test yet",
  "pages/ProtocolRunPage.tsx": "no page test yet",
  "pages/RateSchedulePublishPage.tsx": "no page test yet",
  "pages/RateScheduleViewPage.tsx": "no page test yet",
  "pages/RevenueClaimsPage.tsx": "fixtures, owned by economics df42dbe5",
  "pages/SWFDashboardPage.tsx": "fixtures, owned by RETIRE (PRODUCT-BOARD s4): economics #394 deletes the page",
  "pages/SWFGovernancePage.tsx": "fixtures, owned by RETIRE (PRODUCT-BOARD s4): economics #394 deletes the page",
  "pages/SensorDashboardPage.tsx": "no page test yet",
  "pages/SettlementPage.tsx": "fixtures, owned by readmodels c255d7dc: settlement read model, no mock fallback",
  "pages/ShipmentDetailPage.tsx": "fixtures, owned by logistics N-b (carrier #2264)",
  "pages/SpaceBookingsPage.tsx": "fixtures, owned by logistics N-b (carrier #2264)",
  "pages/StartPage.tsx": "fixtures, owned by adk 4f6668ed: registers against kernel_dev_001 / adapter 'mock'",
  "pages/WhitepaperPage.tsx": "no page test yet",
  "pages/WorkflowPage.tsx": "no page test yet",
  "pages/onboard/Step1_MachineIdentity.tsx": "no page test yet",
  "pages/onboard/Step2_Documentation.tsx": "fixtures, owned by adk 4f6668ed",
  "pages/onboard/Step3_Capabilities.tsx": "no page test yet",
  "pages/onboard/Step4_PhysicalSpace.tsx": "fixtures, owned by adk 4f6668ed",
  "pages/onboard/Step5_Pricing.tsx": "fixtures, owned by adk 4f6668ed",
  "pages/onboard/Step6_Operator.tsx": "fixtures, owned by adk 4f6668ed",
  "pages/onboard/Step7_Review.tsx": "fixtures, owned by adk 4f6668ed: registers adapterType 'mock' (the EXPERIENCE-COMPLETE blocker)",
};

/** Every page module: the .tsx files under pages/, tests aside. */
function pageModules(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== "__tests__") walk(full);
      } else if (name.endsWith(".tsx") && !name.endsWith(".test.tsx")) {
        out.push(relPath(full));
      }
    }
  };
  walk(join(SRC, "pages"));
  return out.sort();
}

interface TestSource {
  /** The test file's path from src/, e.g. pages/__tests__/WalletPage.honesty.test.tsx. */
  path: string;
  text: string;
}

/** Every test in apps/dashboard/src, with its path. */
function testSources(): TestSource[] {
  const out: TestSource[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.test\.(ts|tsx)$/.test(name)) out.push({ path: relPath(full), text: readFileSync(full, "utf-8") });
    }
  };
  walk(SRC);
  return out;
}

/**
 * The pages a test renders and checks (astra 408d): it imports the page by a
 * relative path that resolves to that exact module, uses the imported
 * component (JSX, or createElement), and asserts something. A bare import,
 * an unused binding, or a file with no expect() renders nothing for anyone.
 */
function pagesRenderedBy(test: TestSource): string[] {
  if (!/\bexpect\s*\(/.test(test.text)) return [];
  const sf = ts.createSourceFile(test.path, test.text, ts.ScriptTarget.Latest, true, test.path.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.TSX);
  // Every name used as a component: <Name …>, <ns.Name …>, createElement(Name, …).
  const rendered = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      let tag: ts.Node = n.tagName;
      while (ts.isPropertyAccessExpression(tag)) tag = tag.expression;
      if (ts.isIdentifier(tag)) rendered.add(tag.text);
    }
    if (ts.isCallExpression(n) && n.arguments[0] && ts.isIdentifier(n.arguments[0])) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      if (name === "createElement") rendered.add(n.arguments[0].text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const out: string[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier) || !stmt.importClause) continue;
    const spec = stmt.moduleSpecifier.text;
    if (!spec.startsWith(".")) continue;
    const clause = stmt.importClause;
    const names = [
      ...(clause.name ? [clause.name.text] : []),
      ...(clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements.map((e) => e.name.text) : []),
      ...(clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? [clause.namedBindings.name.text] : []),
    ];
    if (!names.some((name) => rendered.has(name))) continue;
    out.push(posix.normalize(posix.join(posix.dirname(test.path), spec)).replace(/\.(js|jsx|ts|tsx)$/, "") + ".tsx");
  }
  return out;
}

/** The pages no test renders and checks. A test given as text alone sits in pages/__tests__/. */
function pagesWithoutHonestyTest(pages: string[], tests: Array<string | TestSource>): string[] {
  const covered = new Set(
    tests.flatMap((test) => pagesRenderedBy(typeof test === "string" ? { path: "pages/__tests__/probe.test.tsx", text: test } : test)),
  );
  return pages.filter((page) => !covered.has(page));
}

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "demo") continue;
      out.push(...productionFiles(full));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function relPath(full: string): string {
  if (full.startsWith(UI_SRC)) return "ui:" + relative(UI_SRC, full).split(sep).join("/");
  return relative(SRC, full).split(sep).join("/");
}

interface Hit {
  file: string;
  line: number;
  pattern: string;
  text: string;
}

function scan(): Map<string, Hit[]> {
  const hits = new Map<string, Hit[]>();
  for (const full of [...productionFiles(SRC), ...productionFiles(UI_SRC)]) {
    const file = relPath(full);
    if (/^api\/mock-(data|onboarding-data|revenue-data)\.ts$/.test(file)) continue;
    const lines = readFileSync(full, "utf-8").split("\n");
    lines.forEach((text, i) => {
      for (const [pattern, rx] of PATTERNS) {
        for (const m of text.matchAll(rx)) {
          if (IGNORED_IDENTIFIERS.has(m[0])) continue;
          const list = hits.get(file) ?? [];
          list.push({ file, line: i + 1, pattern, text: text.trim().slice(0, 120) });
          hits.set(file, list);
        }
      }
    });
  }
  return hits;
}

const hits = scan();

describe("no production mock (ratchet)", () => {
  it("no file outside the known list contains fixture data", () => {
    const unexpected = [...hits.entries()]
      .filter(([file]) => !(file in KNOWN_OFFENDERS))
      .map(([file, list]) => `${file}:${list[0]!.line} [${list[0]!.pattern}] ${list[0]!.text}`);
    expect(unexpected, "Put fixtures under src/demo/ behind isDemoMode(), or show an unavailable state").toEqual([]);
  });

  it("the known list only shrinks: every listed file still has fixtures", () => {
    const stale = Object.keys(KNOWN_OFFENDERS).filter((file) => !hits.has(file));
    expect(stale, "These files are clean now; delete their KNOWN_OFFENDERS entries").toEqual([]);
  });

  it("server-side fabrication cases still name existing pages", () => {
    for (const file of Object.keys(SERVER_FABRICATED)) {
      expect(existsSync(join(SRC, file)), file).toBe(true);
    }
  });

  it("the demo-import check also sees a dynamic import (self-test)", () => {
    const rx = /(?:from\s+|import\s*\(\s*)['"][./]+(?:\.\.\/)*demo\//;
    expect(rx.test('const m = await import("../demo/WalletPage.fixtures.js");')).toBe(true);
    expect(rx.test('import { DEMO_X } from "../demo/WalletPage.fixtures.js";')).toBe(true);
    expect(rx.test('import { x } from "../lib/demo-mode.js";')).toBe(false);
  });

  it("fixtures under src/demo/ are imported only by code that checks demo mode", () => {
    const leaks = productionFiles(SRC)
      .map((full) => ({ file: relPath(full), text: readFileSync(full, "utf-8") }))
      .filter(
        ({ text }) =>
          /(?:from\s+|import\s*\(\s*)['"][./]+(?:\.\.\/)*demo\//.test(text) && !text.includes("isDemoMode("),
      )
      .map(({ file }) => file);
    expect(leaks).toEqual([]);
  });

  it("a page with no honesty test is caught, so a fixture no pattern sees can't ship unchecked (astra 408a MEDIUM)", () => {
    // astra's example: a new page rendering const rows = [{ name: "Sample machine", price: 25 }] matches no pattern.
    expect(PATTERNS.some(([, rx]) => new RegExp(rx.source, rx.flags).test('const rows = [{ name: "Sample machine", price: 25 }];'))).toBe(false);
    // So every page must have an honesty test, or be listed, with a reason, as not yet tested.
    expect(pagesWithoutHonestyTest(["pages/NewSamplePage.tsx"], [])).toEqual(["pages/NewSamplePage.tsx"]);
  });

  it("every page has a test that renders it, or is listed as not yet tested (astra 408a)", () => {
    const missing = pagesWithoutHonestyTest(pageModules(), testSources()).filter((page) => !(page in UNTESTED_PAGES));
    expect(missing, "Add a page test (pages/__tests__/<Page>.honesty.test.tsx) that imports the page").toEqual([]);
  });

  it("the untested list only shrinks: every listed page still exists and still has no test", () => {
    const untested = new Set(pagesWithoutHonestyTest(pageModules(), testSources()));
    const stale = Object.keys(UNTESTED_PAGES).filter((page) => !untested.has(page));
    expect(stale, "These pages have a test now, or are gone: delete their UNTESTED_PAGES entries").toEqual([]);
  });

  it("an import of the page itself counts, and a page with a similar name doesn't (self-test)", () => {
    // Made-up pages: this file is itself a test, so naming a real page here would count as its test.
    const pages = ["pages/ProbePage.tsx", "pages/probe/ProbeStep.tsx"];
    const checks = (name: string, from: string) => `import { ${name} } from "${from}";\nit("x", () => {\n  render(<${name} />);\n  expect(text()).toContain("unavailable");\n});`;
    expect(pagesWithoutHonestyTest(pages, [checks("ProbePage", "../ProbePage.js"), checks("ProbeStep", "../../pages/probe/ProbeStep.js")])).toEqual([]);
    expect(pagesWithoutHonestyTest(pages, [checks("OtherProbePage", "../OtherProbePage.js")])).toEqual(pages);
  });

  it("an import that renders nothing, or a test that asserts nothing, doesn't count (astra 408d MEDIUM)", () => {
    for (const test of [
      'import "../ProbePage.js";',
      'import { ProbePage } from "../ProbePage.js";\nconst unused = ProbePage;',
      'import { ProbePage } from "../ProbePage.js";\nrender(<ProbePage />);',
      // It asserts, but never renders the page: only the render check decides this one.
      'import { ProbePage } from "../ProbePage.js";\nit("x", () => {\n  expect(ProbePage).toBeDefined();\n});',
    ]) {
      expect(pagesWithoutHonestyTest(["pages/ProbePage.tsx"], [test]), test).toEqual(["pages/ProbePage.tsx"]);
    }
  });

  it("one page's test doesn't cover a page with the same name in another directory (astra 408d MEDIUM)", () => {
    const test = 'import { ProbePage } from "../ProbePage.js";\nit("x", () => {\n  render(<ProbePage />);\n  expect(text()).toContain("unavailable");\n});';
    expect(pagesWithoutHonestyTest(["pages/ProbePage.tsx", "pages/probe/ProbePage.tsx"], [test])).toEqual(["pages/probe/ProbePage.tsx"]);
  });

  it("the scanner detects each pattern (self-test)", () => {
    const sample = [
      "const MOCK_TREASURY = {};",
      "setBundles(mockBundles);",
      "const data = query.data ?? makeFallbackData();",
      'import { mockJobs } from "../api/mock-data.js";',
      ".catch(() => {}); // keep mock",
      "const [usingMock, setUsingMock] = useState(false);",
      'adapterType: "mock",',
      "const kernelId = \"kernel_dev_001\";",
      "<StatusBar kernelsOnline={2} activeJobs={3} />",
      '<AddressDisplay address="0x1234567890abcdef1234567890abcdef12345678" />',
      'import { makeDemoPointMap3DTrace } from "../components/viewer/fixtures.js";',
    ];
    for (const line of sample) {
      expect(PATTERNS.some(([, rx]) => new RegExp(rx.source, rx.flags).test(line)), line).toBe(true);
    }
    expect(PATTERNS.some(([, rx]) => new RegExp(rx.source, rx.flags).test("data.contracts.mockUSDC")) &&
      IGNORED_IDENTIFIERS.has("mockUSDC")).toBe(true);
  });
});
