/**
 * N34 / #2498: routes/ may not gain module-scope rows, JSON imports or
 * value-producing Math.random. Fixture and random allowlist entries only shrink:
 * remove an entry when its owner retires the data. A config entry may be added
 * in review with its reason.
 *
 * Known gaps: rows inline in handlers or module-scope function declarations;
 * numeric/string series; formulas (marketplace.ts:244-247, :252-260 and
 * logistics.ts:367-382); and fixtures imported from outside routes/. The demo
 * flag covers these gaps for the seven gated families.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROUTES_ROOT = fileURLToPath(new URL("../routes/", import.meta.url));
const NEW_HIT_MESSAGE = "new fixture rows or random values in routes/: serve real data, or answer 501 not_available outside PCC_DEMO_ROUTES";

interface Allowance {
  kind: "fixture" | "config" | "random";
  owner: string;
  row?: string;
  reason: string;
  count?: number;
}

const ALLOWLIST: Record<string, Allowance> = {
  "agents.ts::mockConversations": { kind: "fixture", owner: "shell", row: "N34 (#2527)", reason: "Built-in conversations, gated by N34." },
  "discover.ts::MOCK_IPP_PRINTERS": { kind: "fixture", owner: "adk (wire-or-retire later)", row: "N34 (#11065)", reason: "Built-in printers, gated by N34." },
  "logistics.ts::mockProviders": { kind: "fixture", owner: "carrier", row: "N34 (#2922)", reason: "Built-in providers, gated by N34." },
  "logistics.ts::mockShipments": { kind: "fixture", owner: "carrier", row: "N34 (#2922)", reason: "Built-in shipments, gated by N34." },
  "logistics.ts::mockBookings": { kind: "fixture", owner: "carrier", row: "N34 (#2922)", reason: "Built-in bookings, gated by N34." },
  "logistics.ts::defaultInstallSteps": { kind: "fixture", owner: "carrier", row: "N34 (#2922)", reason: "Built-in installation steps, gated by N34." },
  "logistics.ts::mockInstallations": { kind: "fixture", owner: "carrier", row: "N34 (#2922)", reason: "Built-in installations, gated by N34." },
  "logistics.ts::mockTimeline": { kind: "fixture", owner: "carrier", row: "N34 (#2922)", reason: "Built-in timeline, gated by N34." },
  "marketplace.ts::mockClasses": { kind: "fixture", owner: "kits", row: "N34 (#2523)", reason: "Built-in equipment classes, gated by N34." },
  "marketplace.ts::mockSnapshots": { kind: "fixture", owner: "kits", row: "N34 (#2523)", reason: "Built-in market snapshots, gated by N34." },
  "marketplace.ts::mockListings": { kind: "fixture", owner: "kits", row: "N34 (#2523)", reason: "Built-in listings; reads gated by N34, writes owned by N43." },
  "marketplace.ts::mockOrders": { kind: "fixture", owner: "kits", row: "N34 (#2523)", reason: "Built-in orders; reads gated by N34, writes owned by N43." },
  "orchestrator.ts::mockNodes": { kind: "fixture", owner: "refvertical", row: "N34 (#3743)", reason: "Built-in nodes, gated by N34." },
  "orchestrator.ts::mockEdges": { kind: "fixture", owner: "refvertical", row: "N34 (#3743)", reason: "Built-in edges, gated by N34." },
  "orchestrator.ts::mockSamples": { kind: "fixture", owner: "refvertical", row: "N34 (#3743)", reason: "Built-in samples, gated by N34." },
  "orchestrator.ts::mockWorkflowSteps": { kind: "fixture", owner: "refvertical", row: "N34 (#3743)", reason: "Built-in workflow steps, gated by N34." },
  "orchestrator.ts::mockWorkflows": { kind: "fixture", owner: "refvertical", row: "N34 (#3743)", reason: "Built-in workflows, gated by N34." },
  "orchestrator.ts::mockClaims": { kind: "fixture", owner: "refvertical", row: "N34 (#3743)", reason: "Built-in claims, gated by N34." },
  "protocols.ts::bioassayParameters": { kind: "fixture", owner: "refvertical", row: "N34 (#3743)", reason: "Built-in bioassay parameters, gated by N34." },
  "protocols.ts::bioassaySteps": { kind: "fixture", owner: "refvertical", row: "N34 (#3743)", reason: "Built-in bioassay steps, gated by N34." },
  "protocols.ts::bioassayTransfers": { kind: "fixture", owner: "refvertical", row: "N34 (#3743)", reason: "Built-in bioassay transfers, gated by N34." },
  "protocols.ts::mockTemplates": { kind: "fixture", owner: "refvertical", row: "N34 (#3743)", reason: "Built-in templates, gated by N34." },
  "protocols.ts::mockForks": { kind: "fixture", owner: "refvertical", row: "N34 (#3743)", reason: "Built-in forks, gated by N34." },
  "protocols.ts::mockRunSteps": { kind: "fixture", owner: "refvertical", row: "N34 (#3743)", reason: "Built-in run steps, gated by N34." },
  "protocols.ts::mockRunTransfers": { kind: "fixture", owner: "refvertical", row: "N34 (#3743)", reason: "Built-in run transfers, gated by N34." },
  "protocols.ts::mockRuns": { kind: "fixture", owner: "refvertical", row: "N34 (#3743)", reason: "Built-in runs, gated by N34." },
  "protocols.ts::mockAutomationStatuses": { kind: "fixture", owner: "refvertical", row: "N34 (#3743)", reason: "Built-in automation status, gated by N34." },
  "protocols.ts::mockTransferAgents": { kind: "fixture", owner: "refvertical", row: "N34 (#3743)", reason: "Built-in transfer agents, gated by N34." },
  "registry.ts::mockAttestations": { kind: "fixture", owner: "evidence", row: "N34 (#2498)", reason: "Built-in attestation, gated by N34." },
  "spaces.ts::mockSpaces": { kind: "fixture", owner: "kits", row: "N34 (#2523)", reason: "Built-in hosting spaces, gated by N34." },
  "pizza-demo.ts::blockCursor": { kind: "random", owner: "product-steward", row: "census 9/24 (explicit demo route)", reason: "Explicit pizza demo block cursor.", count: 1 },
  "pizza-demo.ts::nextBlock": { kind: "random", owner: "product-steward", row: "census 9/24 (explicit demo route)", reason: "Explicit pizza demo block increment.", count: 1 },
  "spaces.ts::spaceRoutes": { kind: "random", owner: "kits", row: "N34 (#2523)", reason: "Built-in matching score, gated by N34.", count: 1 },
  "agent-chat.ts::PCC_TOOLS": { kind: "config", owner: "gateway", reason: "The hosted chat's tool list." },
  "agent-introspection.ts::AGENT_OPERATIONS": { kind: "config", owner: "gateway", reason: "Operation catalog." },
  "capability-availability.ts::CRON_FIELDS": { kind: "config", owner: "gateway", reason: "Cron field spec." },
  "capture.ts::CAPTURE_CLASS_REGISTRY_ABI": { kind: "config", owner: "gateway", reason: "Contract ABI." },
  "capture.ts::CAPTURE_CLASS_REGISTRY_READ_ABI": { kind: "config", owner: "gateway", reason: "Contract ABI." },
  "nl-query.ts::DEFAULT_TEMPLATES": { kind: "config", owner: "gateway", reason: "Built-in query templates." },
  "onboard-analysis.ts::BUCKETS": { kind: "config", owner: "gateway", reason: "Classifier keyword buckets." },
  "orchestrator-templates.ts::TEMPLATE_DIRECTORY": { kind: "config", owner: "gateway", reason: "Directory of real template mounts." },
  "setup.ts::ENV_VAR_CHECKS": { kind: "config", owner: "gateway", reason: "Env checks." },
  "well-known-aeo.ts::PCC_MCP_ICONS": { kind: "config", owner: "gateway", reason: "Icon list." },
};

interface Hit {
  rule: "F" | "J" | "R";
  key: string;
  count: number;
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  ts.forEachChild(node, (child) => { visit(child, callback); });
}

function stripWrappers(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isNonNullExpression(node)) {
    node = node.expression;
  }
  return node;
}

function containsRows(initializer: ts.Expression): boolean {
  let found = false;
  visit(initializer, (node) => {
    if (ts.isArrayLiteralExpression(node) && node.elements.some((element) => {
      const value = stripWrappers(element);
      return ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value);
    })) found = true;
  });
  return found;
}

function isMathRandom(node: ts.Node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  if (!(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
    || !ts.isIdentifier(node.expression) || node.expression.text !== "Math") return false;
  return ts.isPropertyAccessExpression(node) ? node.name.text === "random"
    : ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === "random";
}

function isBase36Id(access: ts.Node): boolean {
  const randomCall = access.parent;
  if (!ts.isCallExpression(randomCall) || randomCall.expression !== access || randomCall.arguments.length !== 0) return false;
  const toString = randomCall.parent;
  if (!ts.isPropertyAccessExpression(toString) || toString.expression !== randomCall || toString.name.text !== "toString") return false;
  const convert = toString.parent;
  return ts.isCallExpression(convert) && convert.expression === toString && convert.arguments.length === 1
    && ts.isNumericLiteral(convert.arguments[0]) && convert.arguments[0].text === "36";
}

function topLevelName(node: ts.Node, file: ts.SourceFile): string {
  let statement = node;
  while (statement.parent !== file) statement = statement.parent;
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations[0].name.getText(file);
  if (ts.isFunctionDeclaration(statement) && statement.name) return statement.name.text;
  return `line ${file.getLineAndCharacterOfPosition(statement.getStart(file)).line + 1}`;
}

function scan(source: string, filename: string): Hit[] {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits = new Map<string, Hit>();
  function add(rule: Hit["rule"], name: string): void {
    const key = `${filename}::${name}`;
    const identity = `${rule}:${key}`;
    const existing = hits.get(identity);
    if (existing) existing.count++;
    else hits.set(identity, { rule, key, count: 1 });
  }
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer && containsRows(declaration.initializer)) add("F", declaration.name.getText(file));
      }
    } else if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text.endsWith(".json")) {
      add("J", `import:${statement.moduleSpecifier.text}`);
    }
  }
  visit(file, (node) => {
    if (isMathRandom(node) && !isBase36Id(node)) add("R", topLevelName(node, file));
  });
  return [...hits.values()];
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(filename)
      : entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") && !entry.name.endsWith(".test.ts") ? [filename] : [];
  }).sort();
}

const files = sourceFiles(ROUTES_ROOT);
const hits = files.flatMap((filename) => scan(readFileSync(filename, "utf8"), path.relative(ROUTES_ROOT, filename).split(path.sep).join("/")));

describe("N34 routes fabrication ratchet", () => {
  it("E1 every current hit is reviewed", () => {
    expect(files.length, "routes/ scan must read at least 100 source files").toBeGreaterThanOrEqual(100);
    const unreviewed = hits.filter((hit) => {
      const allowance = ALLOWLIST[hit.key];
      return !allowance || (hit.rule === "R" ? allowance.kind !== "random" : allowance.kind === "random");
    });
    expect(unreviewed, NEW_HIT_MESSAGE).toEqual([]);
  });

  it("E2 every allowlist entry has a current hit; remove stale entries", () => {
    const stale = Object.keys(ALLOWLIST).filter((key) => !hits.some((hit) => hit.key === key));
    expect(stale, "remove stale routes/ allowlist entries").toEqual([]);
  });

  it("E3 random counts neither grow nor become stale", () => {
    for (const [key, allowance] of Object.entries(ALLOWLIST)) {
      if (allowance.kind !== "random") continue;
      const count = hits.find((hit) => hit.key === key && hit.rule === "R")?.count ?? 0;
      expect(count, `${key}: ${count > (allowance.count ?? 0) ? NEW_HIT_MESSAGE : "stale random count: lower or remove the entry"}`).toBe(allowance.count);
    }
  });

  it("E4 every entry names an owner and its review or config reason", () => {
    for (const [key, allowance] of Object.entries(ALLOWLIST)) {
      expect(allowance.owner.trim(), `${key}: owner`).not.toBe("");
      if (allowance.kind === "config") expect(allowance.reason.trim(), `${key}: config reason`).not.toBe("");
      else expect(allowance.row?.trim() ?? "", `${key}: review row`).not.toBe("");
    }
  });

  const positiveProbes: Array<[string, string, Hit["rule"], string]> = [
    ["object rows", "const a = [{ id: 1 }];", "F", "a"],
    ["exported typed rows", "export const b: T[] = [{ x: 1 }] as T[];", "F", "b"],
    ["nested arrays", "let c = [[1, 2]];", "F", "c"],
    ["frozen rows", "const d = Object.freeze([{ x: 1 }]);", "F", "d"],
    ["map rows", 'const e = new Map([["k", { v: 1 }]]);', "F", "e"],
    ["nested object rows", "const f = { rows: [{ id: 1 }] };", "F", "f"],
    ["initializer function rows", "const g = () => [{ id: 1 }];", "F", "g"],
    ["JSON imports", 'import rows from "./rows.json";', "J", "import:./rows.json"],
    ["random scores", "const s = 70 + Math.random() * 25;", "R", "s"],
    ["computed random", 'const t = Math["random"]();', "R", "t"],
    ["random references", "const u = Math.random;", "R", "u"],
    ["non-base36 random", "const v = Math.random().toString(16);", "R", "v"],
    ["wrapped row elements", "const wrapped = [(({ x: 1 } as T) satisfies T)!, <T>{ x: 2 }];", "F", "wrapped"],
    ["second variable declaration", "const empty = [], second = [{ x: 1 }];", "F", "second"],
    ["top-level random expression", "Math.random();", "R", "line 1"],
    ["function random", "function f() { return Math.random(); }", "R", "f"],
    ["base36 with extra argument", "const v = Math.random().toString(36, 1);", "R", "v"],
    ["random with arguments", "const v = Math.random(1).toString(36);", "R", "v"],
  ];
  it.each(positiveProbes)("E5 detects %s", (_name, source, rule, name) => {
    expect(scan(source, "probe.ts")).toEqual([{ rule, key: `probe.ts::${name}`, count: 1 }]);
  });

  const negativeProbes = [
    'const a = ["x", "y"];',
    "const b = [1, 2];",
    "const c = [];",
    "function f() { return [{ id: 1 }]; }",
    'app.get("/x", async () => [{ id: 1 }]);',
    "const id = Math.random().toString(36).slice(2);",
    "// const m = [{ id: 1 }]; Math.random()",
    'const s = "[{ Math.random() }]";',
    'const id = Math["random"]().toString(36).slice(2);',
  ];
  it.each(negativeProbes)("E5 ignores %s", (source) => {
    expect(scan(source, "probe.ts")).toEqual([]);
  });

  it("E5 counts every random access under the enclosing top-level statement", () => {
    expect(scan("const a = Math.random() + Math.random();", "probe.ts"))
      .toEqual([{ rule: "R", key: "probe.ts::a", count: 2 }]);
    expect(scan("const a = 1, b = Math.random();", "probe.ts"))
      .toEqual([{ rule: "R", key: "probe.ts::a", count: 1 }]);
  });
});
