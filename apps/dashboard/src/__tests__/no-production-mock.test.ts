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
 * Server-side fabrication (a gateway route returning hard-coded data) is also
 * invisible here; SERVER_FABRICATED records the known cases so they are
 * not silently exempt.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

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
  "pages/JobDetailPage.tsx": "readmodels c255d7dc: JobExecutionDTO (PX-6)",
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
  // pcc-shell 47b47970: this lane's remaining pages, in a follow-up PR (their implementer agents stopped at the account's weekly limit)
  "pages/AgentLogPage.tsx": "pcc-shell 47b47970: follow-up PR",
  "pages/NegotiationPage.tsx": "pcc-shell 47b47970: follow-up PR",
  "pages/MarketplaceDetailPage.tsx": "pcc-shell 47b47970: follow-up PR",
  "pages/ROICalculatorPage.tsx": "pcc-shell 47b47970: follow-up PR",
  "pages/SpaceFinderPage.tsx": "pcc-shell 47b47970: follow-up PR",
  "pages/SpaceDetailPage.tsx": "pcc-shell 47b47970: follow-up PR",
  // logistics N-b: product-steward 61243bdd / readmodels, carrier af177c03 supplies the mapping (#2257, #2264)
  "pages/InstallationDetailPage.tsx": "logistics N-b (carrier #2264)",
  "pages/ShipmentDetailPage.tsx": "logistics N-b (carrier #2264)",
  "pages/SpaceBookingsPage.tsx": "logistics N-b (carrier #2264)",
};

/**
 * Pages whose fabricated data comes from the gateway, so no client scan can
 * see it. Listed so they are tracked, not exempt.
 */
const SERVER_FABRICATED: Record<string, string> = {
  "pages/LogisticsHubPage.tsx":
    "packages/gateway/src/routes/logistics.ts returns hard-coded providers, shipments and quotes (carrier #2264, steward N-b)",
};

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

  it("fixtures under src/demo/ are imported only by code that checks demo mode", () => {
    const leaks = productionFiles(SRC)
      .map((full) => ({ file: relPath(full), text: readFileSync(full, "utf-8") }))
      .filter(({ text }) => /from\s+['"][./]+(?:\.\.\/)*demo\//.test(text) && !text.includes("isDemoMode("))
      .map(({ file }) => file);
    expect(leaks).toEqual([]);
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
