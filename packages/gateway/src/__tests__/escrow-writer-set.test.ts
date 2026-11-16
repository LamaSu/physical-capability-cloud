/** Inventory all local escrow writers. The reviewed multiset is literal and never learned at test time. */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const MARKER = "vnext-buyer";
const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
type Table = "escrows" | "escrow_milestones";
type Ref = { table: Table | "schema" | "store"; alias: boolean };
type Binding = { name: string; declaration: ts.Node; scope: ts.Node; direct?: Ref; initializer?: ts.Expression; property?: string };
interface Writer { file: string; call: string; table: Table; kind: string; alias: boolean; fn: string; statuses: string[]; versions: string[]; updatesVersion: boolean }
interface Scan { writes: Writer[]; violations: string[] }
const tableName = (name: string): Table | undefined => name === "escrows" ? "escrows" : name === "escrowMilestones" || name === "escrow_milestones" ? "escrow_milestones" : undefined;
function parentScope(node: ts.Node): ts.Node {
  let current = node.parent;
  while (current && !ts.isSourceFile(current) && !ts.isBlock(current) && !ts.isFunctionLike(current)) current = current.parent;
  return current;
}
function within(node: ts.Node, ancestor: ts.Node): boolean {
  for (let n: ts.Node | undefined = node; n; n = n.parent) if (n === ancestor) return true;
  return false;
}
function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) if (ts.isFunctionLike(n)) return n as ts.FunctionLikeDeclaration;
  return undefined;
}
function unparen(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  return node;
}
function fullCall(node: ts.CallExpression): ts.CallExpression {
  while (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && ts.isCallExpression(node.parent.parent)
    && node.parent.parent.expression === node.parent) node = node.parent.parent;
  return node;
}

/** Per-file lexical bindings keep aliases separate from similarly named locals in another scope. */
export function scanEscrowWriters(file: string, text: string): Scan {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const bindings: Binding[] = [], writes: Writer[] = [], violations: string[] = [];
  function collect(node: ts.Node) {
    if (ts.isImportSpecifier(node)) {
      const imported = node.propertyName?.text ?? node.name.text;
      const table = tableName(imported);
      if (table || imported === "schema") bindings.push({ name: node.name.text, declaration: node, scope: source,
        direct: { table: table ?? "schema", alias: node.name.text !== imported } });
    } else if (ts.isNamespaceImport(node)) {
      const declaration = node.parent.parent;
      if (ts.isImportDeclaration(declaration) && ts.isStringLiteral(declaration.moduleSpecifier) && declaration.moduleSpecifier.text === "@pcc/store")
        bindings.push({ name: node.name.text, declaration: node, scope: source, direct: { table: "store", alias: false } });
      else if (ts.isImportDeclaration(declaration) && ts.isStringLiteral(declaration.moduleSpecifier) && /schema/.test(declaration.moduleSpecifier.text))
        bindings.push({ name: node.name.text, declaration: node, scope: source, direct: { table: "schema", alias: node.name.text !== "schema" } });
    } else if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name)) bindings.push({ name: node.name.text, declaration: node, scope: parentScope(node), initializer: node.initializer });
      else if (ts.isObjectBindingPattern(node.name)) for (const e of node.name.elements) {
        if (ts.isIdentifier(e.name)) bindings.push({ name: e.name.text, declaration: e, scope: parentScope(node), initializer: node.initializer,
          property: e.propertyName?.getText(source).replace(/["']/g, "") ?? e.name.text });
      }
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      bindings.push({ name: node.name.text, declaration: node, scope: node.parent });
    }
    ts.forEachChild(node, collect);
  }
  collect(source);
  function binding(name: string, at: ts.Node): Binding | undefined {
    const candidates = bindings.filter(b => b.name === name && within(at, b.scope));
    for (let scope: ts.Node | undefined = at; scope; scope = scope.parent) {
      const local = candidates.filter(b => b.scope === scope);
      if (local.length) return local[local.length - 1];
    }
    return undefined;
  }
  function ref(expression: ts.Expression, at: ts.Node, seen = new Set<ts.Node>()): Ref | undefined {
    const node = unparen(expression);
    if (ts.isIdentifier(node)) {
      const b = binding(node.text, at);
      if (!b || seen.has(b.declaration)) return undefined;
      if (b.direct) return b.direct;
      if (!b.initializer) return undefined;
      seen.add(b.declaration);
      const base = ref(b.initializer, b.declaration, seen);
      if (!base) return undefined;
      if (b.property) {
        const table = tableName(b.property);
        if (base.table === "store" && b.property === "schema") return { table: "schema", alias: b.name !== "schema" };
        return base.table === "schema" && table ? { table, alias: base.alias || b.name !== b.property } : undefined;
      }
      return { ...base, alias: true };
    }
    if (ts.isPropertyAccessExpression(node)) {
      const base = ref(node.expression, at, seen);
      const table = tableName(node.name.text);
      if (base?.table === "store" && node.name.text === "schema") return { table: "schema", alias: base.alias };
      return base?.table === "schema" && table ? { table, alias: base.alias } : undefined;
    }
    if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) {
      const base = ref(node.expression, at, seen), table = tableName(node.argumentExpression.text);
      return base?.table === "schema" && table ? { table, alias: base.alias } : undefined;
    }
    if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression)
      && node.expression.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.expression.arguments[0] && ts.isStringLiteral(node.expression.arguments[0])
      && node.expression.arguments[0].text === "@pcc/store") return { table: "store", alias: false };
    return undefined;
  }
  function repoReceiver(expression: ts.Expression, at: ts.Node, seen = new Set<ts.Node>()): boolean {
    const node = unparen(expression);
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "EscrowRepository") return true;
    if ((ts.isPropertyAccessExpression(node) && node.name.text === "escrows")
      || (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === "escrows")) return !ref(node, at);
    if (ts.isIdentifier(node)) {
      const b = binding(node.text, at);
      if (!b?.initializer || seen.has(b.declaration)) return false;
      seen.add(b.declaration);
      if (b.property) return b.property === "escrows" && !ref(b.initializer, b.declaration);
      return repoReceiver(b.initializer, b.declaration, seen);
    }
    return false;
  }
  function strings(expression: ts.Expression | undefined, at: ts.Node, seen = new Set<string>()): string[] {
    if (!expression) return [];
    const e = unparen(expression);
    if (ts.isStringLiteralLike(e)) return [e.text];
    if (ts.isConditionalExpression(e)) return [...strings(e.whenTrue, at, seen), ...strings(e.whenFalse, at, seen)];
    if (ts.isIdentifier(e)) {
      if (e.text === "BUYER_FUNDED_ESCROW_VERSION") return [MARKER];
      if (seen.has(e.text)) return [];
      seen.add(e.text);
      const b = binding(e.text, at), values = strings(b?.initializer, b?.declaration ?? at, seen);
      const scope = enclosingFunction(at) ?? source;
      function assignments(n: ts.Node) {
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && n.left.text === e.text)
          values.push(...strings(n.right, n, seen));
        ts.forEachChild(n, assignments);
      }
      assignments(scope); return values;
    }
    return [];
  }
  function details(node: ts.CallExpression, root: ts.CallExpression, kind: string, table: Table, alias: boolean): Writer {
    const statuses: string[] = [], versions: string[] = []; let updatesVersion = false;
    const fn = enclosingFunction(node);
    function objectFields(n: ts.Node) {
      if (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) {
        const name = n.name.getText(source).replace(/["']/g, "");
        const value = ts.isPropertyAssignment(n) ? n.initializer : n.name;
        if (name === "status") statuses.push(...strings(value, n));
        if (name === "version") { versions.push(...strings(value, n)); if (kind.includes("update")) updatesVersion = true; }
      }
      ts.forEachChild(n, objectFields);
    }
    objectFields(root);
    if (kind === "repo_updateStatus" || kind === "repo_updateMilestoneStatus") statuses.push(...strings(node.arguments[1], node));
    return { file, call: collapse(root.getText(source)), table, kind, alias, fn: fn?.name?.getText(source) ?? "", statuses: [...new Set(statuses)].sort(),
      versions: [...new Set(versions)].sort(), updatesVersion };
  }
  const rawPattern = /\b(insert\s+(?:or\s+\w+\s+)?into|replace\s+into|update|delete\s+from)\s+(?:["`\[]?main["`\]]?\.)?["`\[]?(escrows|escrow_milestones)\b/gi;
  function rawSql(node: ts.Node, sql: string) {
    for (const match of sql.matchAll(rawPattern)) {
      const operation = match[1]!.split(/\s/)[0]!.toLowerCase();
      const fn = enclosingFunction(node);
      writes.push({ file, call: collapse(node.getText(source)), table: match[2] as Table, kind: `raw_${operation}`, alias: false,
        fn: fn?.name?.getText(source) ?? "", statuses: /\bstatus\s*=\s*['"]funded['"]/i.test(sql) ? ["funded"] : [],
        versions: sql.includes(MARKER) ? [MARKER] : [], updatesVersion: operation === "update" && /\bversion\s*=/i.test(sql) });
    }
  }
  const aliasNames = new Set(bindings.filter(b => ref(ts.factory.createIdentifier(b.name), b.declaration)?.alias).map(b => b.name));
  function checkAliasUse(node: ts.Identifier) {
    if (!aliasNames.has(node.text)) return;
    const value = ref(node, node);
    if (!value?.alias || value.table === "schema" || value.table === "store") return;
    const parent = node.parent;
    if (ts.isImportSpecifier(parent) || ts.isBindingElement(parent) && parent.name === node
      || ts.isVariableDeclaration(parent) && parent.name === node
      || ts.isPropertyAccessExpression(parent) && parent.name === node) return;
    let operand: ts.Expression = node;
    while ((ts.isParenthesizedExpression(operand.parent) || ts.isAsExpression(operand.parent) || ts.isNonNullExpression(operand.parent))
      && operand.parent.expression === operand) operand = operand.parent;
    const owner = operand.parent;
    // A const alias may bind another alias; all later uses are checked as well.
    if (ts.isVariableDeclaration(owner) && owner.initializer === operand && ts.isIdentifier(owner.name)) return;
    if (ts.isCallExpression(owner) && owner.arguments[0] === operand && ts.isPropertyAccessExpression(owner.expression)
      && ["from", "innerJoin", "leftJoin", "insert", "update", "delete"].includes(owner.expression.name.text)) return;
    violations.push(`alias outside read: ${collapse(owner.getText(source))}`);
  }
  function sqlText(expression: ts.Expression): string | undefined {
    const e = unparen(expression);
    if (ts.isStringLiteralLike(e)) return e.text;
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = sqlText(e.left), right = sqlText(e.right);
      return left !== undefined && right !== undefined ? left + right : undefined;
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "concat") {
      const parts = [sqlText(e.expression.expression), ...e.arguments.map(sqlText)];
      return parts.every(p => p !== undefined) ? parts.join("") : undefined;
    }
    if (ts.isTemplateExpression(e)) {
      return e.head.text + e.templateSpans.map(s => {
        const table = ref(s.expression, s);
        return (table?.table === "escrows" || table?.table === "escrow_milestones" ? table.table : " ") + s.literal.text;
      }).join("");
    }
    if (ts.isTaggedTemplateExpression(e) && e.tag.getText(source) === "sql") return sqlText(e.template);
    return undefined;
  }
  function walk(node: ts.Node) {
    if (ts.isIdentifier(node)) checkAliasUse(node);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text, receiver = node.expression.expression;
      const table = node.arguments[0] && ref(node.arguments[0], node);
      if (["insert", "update", "delete"].includes(method) && table && table.table !== "schema" && table.table !== "store") {
        writes.push(details(node, fullCall(node), `drizzle_${method}`, table.table, table.alias));
        if (table.alias) violations.push(`alias write: ${collapse(node.getText(source))}`);
      } else if (["insert", "updateStatus", "insertMilestone", "updateMilestoneStatus"].includes(method)
        && repoReceiver(receiver, node)) {
        writes.push(details(node, node, `repo_${method}`, method.includes("Milestone") ? "escrow_milestones" : "escrows", false));
      }
    }
    if (ts.isExpressionNode(node)) {
      const sql = sqlText(node);
      const parent = node.parent;
      const combined = ts.isExpressionNode(parent) && sqlText(parent) !== undefined;
      if (sql !== undefined && !combined && !ts.isImportDeclaration(parent)) rawSql(node, sql);
    }
    ts.forEachChild(node, walk);
  }
  walk(source); return { writes, violations };
}
function productionFiles(root: string): string[] {
  const files: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", "__tests__"].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.|\.d\.ts$/.test(entry.name)) files.push(path);
    }
  }
  for (const group of ["packages", "apps"]) for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, group, entry.name, "src");
    try { walk(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return files.sort();
}
function realScan(): Scan {
  const scans = productionFiles(ROOT).map(file => scanEscrowWriters(relative(ROOT, file), readFileSync(file, "utf8")));
  return { writes: scans.flatMap(s => s.writes), violations: scans.flatMap(s => s.violations) };
}
const key = (w: Pick<Writer, "file" | "call">) => `${w.file}\n${w.call}`;
function multiset(writes: Array<Pick<Writer, "file" | "call">>) {
  const counts = new Map<string, number>();
  for (const w of writes) counts.set(key(w), (counts.get(key(w)) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b));
}
// REVIEWED_WRITERS is a literal multiset of the call text, including the two markBuyerFunded CAS calls.
const REVIEWED_WRITERS: Array<{ file: string; call: string; count: number }> = [
  {"file": "packages/gateway/src/services/buyer-funding-prepare.ts", "call": "tx.insert(schema.escrows).values({ id: escrowId, cwmId: session.cwmId!, contractAddress: getAddress(compiled.escrow), payer: scope.createdBy, totalAmount: quote!.totalPrice as string, currency: \"USDC\", status: \"created\", createdAt: new Date(nowMs).toISOString(), deadline: (terms?.deadline as string) ?? new Date(nowMs + 24 * 60 * 60_000).toISOString(), version: BUYER_FUNDED_ESCROW_VERSION, }).run()", "count": 1},
  {"file": "packages/gateway/src/services/buyer-funding-prepare.ts", "call": "tx.insert(schema.escrowMilestones).values({ id: `ms-${randomUUID().slice(0, 12)}`, escrowId, stepId: job.stepId, amount: \"1.00\", status: \"pending\", bondAmount: \"0.00\", }).run()", "count": 1},
  {
    "file": "packages/gateway/src/routes/paid-job-flow.ts",
    "call": "repos.escrows.insert({ id: escrowId, cwmId: session.cwmId ?? `cwm-${crypto.randomUUID().slice(0, 12)}`, contractAddress: escrowAddress, payer: session.userAgentId, totalAmount: totalPrice, currency, status: escrowStatus, createdAt: now, deadline, // V3 dispatch: settled-later routes/facades read this and pick the V3 // write helpers (submitAttestationV3 / releaseMilestoneV3) vs V2. version: useV3ModeA() ? \"v3\" : \"v2\", })",
    "count": 1
  },
  {
    "file": "packages/gateway/src/routes/paid-job-flow.ts",
    "call": "repos.escrows.insertMilestone({ id: `ms-${crypto.randomUUID().slice(0, 12)}`, escrowId, stepId: ms.stepId, amount: ms.amount, status: escrowStatus === \"funded\" ? \"funded\" : \"pending\", bondAmount: ms.bondAmount, })",
    "count": 1
  },
  {
    "file": "packages/gateway/src/routes/paid-job-flow.ts",
    "call": "repos.escrows.updateMilestoneStatus(milestones[0].id, \"evidence_submitted\")",
    "count": 1
  },
  {
    "file": "packages/gateway/src/routes/paid-job-flow.ts",
    "call": "repos.escrows.updateStatus(escrowId, \"completed\")",
    "count": 4
  },
  {
    "file": "packages/gateway/src/routes/paid-job-flow.ts",
    "call": "repos.escrows.updateMilestoneStatus(ms.id, \"released\")",
    "count": 4
  },
  {
    "file": "packages/gateway/src/services/settlement-keeper.ts",
    "call": "repos.escrows.updateStatus(escrow.id, \"completed\")",
    "count": 1
  },
  {
    "file": "packages/gateway/src/services/buyer-funding-verifier.ts",
    "call": "tx.update(escrows).set({ status: \"funded\" }).where(and( eq(escrows.id, escrowId), eq(escrows.status, \"created\"), eq(escrows.version, BUYER_FUNDED_ESCROW_VERSION), )).run()",
    "count": 1
  },
  {
    "file": "packages/gateway/src/services/buyer-funding-verifier.ts",
    "call": "tx.update(escrowMilestones).set({ status: \"funded\" }).where(and( eq(escrowMilestones.escrowId, escrowId), eq(escrowMilestones.status, \"pending\"), )).run()",
    "count": 1
  },
  {
    "file": "packages/db/src/seed/escrow.ts",
    "call": "db.insert(escrows) .values([ { id: \"esc-001\", cwmId: \"cwm-001\", contractAddress: \"0xESCROW_CONTRACT_001\", payer: \"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\", totalAmount: \"77.00\", currency: \"USDC\", status: \"active\", createdAt: \"2026-03-09T12:00:00Z\", deadline: \"2026-03-20T00:00:00Z\", }, { id: \"esc-002\", cwmId: \"cwm-002\", contractAddress: \"0xESCROW_CONTRACT_002\", payer: \"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\", totalAmount: \"245.00\", currency: \"USDC\", status: \"active\", createdAt: \"2026-03-10T06:00:00Z\", deadline: \"2026-03-25T00:00:00Z\", }, { id: \"esc-003\", cwmId: \"cwm-003\", contractAddress: \"0xESCROW_CONTRACT_003\", payer: \"0xcccccccccccccccccccccccccccccccccccccccc\", totalAmount: \"18.50\", currency: \"USDC\", status: \"funded\", createdAt: \"2026-03-10T09:00:00Z\", deadline: \"2026-03-22T00:00:00Z\", }, ]) .run()",
    "count": 1
  },
  {
    "file": "packages/db/src/seed/escrow.ts",
    "call": "db.insert(escrowMilestones) .values([ { id: \"mile-001-1\", escrowId: \"esc-001\", stepId: \"step_fdm_print_01\", amount: \"50.00\", status: \"released\", evidenceBundleHash: \"0xabc123...\", verifierAttestationHash: \"0xdef456...\", challengeWindowStart: \"2026-03-09T14:00:00Z\", challengeWindowEnd: \"2026-03-09T15:00:00Z\", bondAmount: \"5.00\", }, { id: \"mile-001-2\", escrowId: \"esc-001\", stepId: \"step_fdm_print_02\", amount: \"27.00\", status: \"releasing\", evidenceBundleHash: \"0x789abc...\", verifierAttestationHash: \"0x012def...\", challengeWindowStart: new Date().toISOString(), challengeWindowEnd: new Date(Date.now() + 3600000).toISOString(), bondAmount: \"2.70\", }, { id: \"mile-002-1\", escrowId: \"esc-002\", stepId: \"step_cnc_mill_01\", amount: \"245.00\", status: \"released\", evidenceBundleHash: \"0xabc123...\", verifierAttestationHash: \"0xdef456...\", challengeWindowStart: \"2026-03-10T08:00:00Z\", challengeWindowEnd: \"2026-03-10T09:00:00Z\", bondAmount: \"12.25\", }, ]) .run()",
    "count": 1
  },
  {
    "file": "packages/db/src/repositories/settlement.ts",
    "call": "this.db.insert(escrows).values(escrow).returning().get()",
    "count": 1
  },
  {
    "file": "packages/db/src/repositories/settlement.ts",
    "call": "this.db.update(escrows).set({ status }).where(eq(escrows.id, id)).returning().get()",
    "count": 1
  },
  {
    "file": "packages/db/src/repositories/settlement.ts",
    "call": "this.db.insert(escrowMilestones).values(milestone).returning().get()",
    "count": 1
  },
  {
    "file": "packages/db/src/repositories/settlement.ts",
    "call": "this.db.update(escrowMilestones).set({ status }).where(eq(escrowMilestones.id, id)).returning().get()",
    "count": 1
  }
];

describe("escrow writer set", () => {
  it("P1: the exact reviewed writer multiset is complete and has no alias writes", () => {
    const scan = realScan();
    const expected = REVIEWED_WRITERS.flatMap(w => Array.from({ length: w.count }, () => w));
    expect(multiset(scan.writes)).toEqual(multiset(expected)); expect(scan.violations).toEqual([]);
  });
  it("P2: only markBuyerFunded updates status to funded", () => {
    const funded = realScan().writes.filter(w => w.kind.includes("update") && w.statuses.includes("funded"));
    expect(funded).toHaveLength(2); expect(funded.every(w => w.file === "packages/gateway/src/services/buyer-funding-verifier.ts" && w.fn === "markBuyerFunded")).toBe(true);
  });
  it("P3: funded or active inserts cannot write the buyer marker", () => {
    const scan = realScan();
    for (const w of scan.writes.filter(w => w.kind.includes("insert") || w.kind.includes("replace")))
      if (w.statuses.some(s => s === "funded" || s === "active")) expect(w.versions, w.call).not.toContain(MARKER);
    const job = scan.writes.filter(w => w.file === "packages/gateway/src/routes/paid-job-flow.ts" && w.kind === "repo_insert");
    expect(job).toHaveLength(1); expect(job[0]!.statuses).toEqual(["created", "funded"]); expect(job[0]!.versions).toEqual(["v2", "v3"]);
    const milestones = scan.writes.find(w => w.file === "packages/gateway/src/routes/paid-job-flow.ts" && w.kind === "repo_insertMilestone")!;
    expect(milestones.statuses).toEqual(["funded", "pending"]);
    const seed = scan.writes.find(w => w.file === "packages/db/src/seed/escrow.ts" && w.table === "escrows")!;
    expect(seed.statuses).toEqual(["active", "funded"]);
    for (const match of seed.call.matchAll(/contractAddress:\s*"([^"]+)"/g)) expect(/^0x[0-9a-fA-F]{40}$/.test(match[1]!)).toBe(false);
  });
  it("P4: no writer updates escrows.version", () => expect(realScan().writes.filter(w => w.table === "escrows" && w.updatesVersion)).toEqual([]));
  it("P5: renamed imports, destructuring and chained aliases reject writes and allow reads", () => {
    for (const prefix of [
      'import { escrows as rows } from "@pcc/store";',
      'import { schema } from "@pcc/store"; const { escrows: rows } = schema;',
      'import { escrows } from "@pcc/store"; const first = escrows; const rows = first;',
    ]) {
      const write = scanEscrowWriters("probe.ts", prefix + 'db.update(rows).set({status:"funded"}).run();');
      expect(write.writes).toHaveLength(1); expect(write.violations).toHaveLength(1); expect(write.writes[0]!.alias).toBe(true);
      const read = scanEscrowWriters("probe.ts", prefix + 'db.select().from(rows).innerJoin(rows, predicate).leftJoin(rows, predicate);');
      expect(read).toEqual({ writes: [], violations: [] });
      for (const use of ["consume(rows);", "function leak() { return rows; }", "const box = { rows };"]) {
        const escaped = scanEscrowWriters("probe.ts", prefix + use);
        expect(escaped.writes).toEqual([]); expect(escaped.violations).toHaveLength(1);
      }
    }
    const scoped = scanEscrowWriters("probe.ts", 'import {escrows} from "@pcc/store"; const rows=escrows; function read(rows: string) { consume(rows); } db.select().from(rows);');
    expect(scoped).toEqual({ writes: [], violations: [] });
  });
  it("P6: every drizzle, repo, raw SQL and alias write is recognized exactly", () => {
    const probe = `import {escrows, escrowMilestones, schema} from "@pcc/store";
      db.insert(escrows).values({status:"created"}); db.update(schema.escrows).set({status:"funded"}); db.delete(escrowMilestones);
      repos.escrows.insert(row); repos.escrows.updateStatus(id,"completed"); repos.escrows.insertMilestone(ms); repos.escrows.updateMilestoneStatus(id,"released");
      db.run(sql\`UPDATE escrow_milestones SET status='funded'\`);
      const rows=escrows; db.update(rows).set({status:"funded"}); db.select().from(rows);`;
    const scan = scanEscrowWriters("probe.ts", probe);
    expect(scan.writes.map(w => w.kind)).toEqual(["drizzle_insert", "drizzle_update", "drizzle_delete", "repo_insert", "repo_updateStatus", "repo_insertMilestone", "repo_updateMilestoneStatus", "raw_update", "drizzle_update"]);
    expect(scan.violations).toHaveLength(1); expect(scan.writes[8]!.alias).toBe(true);
    for (const sql of ["INSERT INTO escrows (id) VALUES ('x')", "REPLACE INTO escrows (id) VALUES ('x')", "UPDATE escrows SET version='v9'", "DELETE FROM escrow_milestones"])
      expect(scanEscrowWriters("probe.ts", `db.run(sql\`${sql}\`);`).writes).toHaveLength(1);
  });
});

const ESCROW_MENTION_FILES = [
  "apps/dashboard/src/api/gateway.ts",
  "apps/dashboard/src/api/hooks/use-pcc-data.ts",
  "apps/dashboard/src/api/wire-vocabulary.ts",
  "apps/dashboard/src/components/ReadState.tsx",
  "apps/dashboard/src/lib/job-execution-view.ts",
  "apps/dashboard/src/pages/DashboardPage.tsx",
  "apps/dashboard/src/pages/EscrowPage.tsx",
  "apps/dashboard/src/pages/LandingPage.tsx",
  "apps/dashboard/src/pages/RevenueDashboardPage.tsx",
  "packages/bundler/src/paymaster.ts",
  "packages/db/src/index.ts",
  "packages/db/src/interfaces/IEscrowRepository.ts",
  "packages/db/src/interfaces/index.ts",
  "packages/db/src/migrate.ts",
  "packages/db/src/repositories/index.ts",
  "packages/db/src/repositories/settlement.ts",
  "packages/db/src/schema/settlement.ts",
  "packages/db/src/seed/escrow.ts",
  "packages/gateway/src/contracts/escrow-client.ts",
  "packages/gateway/src/facades/populators/settlement.populator.ts",
  "packages/gateway/src/facades/settlement.facade.ts",
  "packages/gateway/src/readmodels/job-execution.ts",
  "packages/gateway/src/readmodels/operator-work.ts",
  "packages/gateway/src/readmodels/product-home.ts",
  "packages/gateway/src/routes/a2a-tasks.ts",
  "packages/gateway/src/routes/commentary.ts",
  "packages/gateway/src/routes/context-pack.ts",
  "packages/gateway/src/routes/device-relay.ts",
  "packages/gateway/src/routes/escrow.ts",
  "packages/gateway/src/routes/negotiation.ts",
  "packages/gateway/src/routes/paid-job-flow.ts",
  "packages/gateway/src/routes/pcc-protocol.ts",
  "packages/gateway/src/routes/product-home.ts",
  "packages/gateway/src/services/buyer-funded-escrow.ts",
  "packages/gateway/src/services/buyer-funding-verifier.ts",
  "packages/gateway/src/services/commentary-narrator.ts",
  "packages/gateway/src/services/escrow-reclaim.ts",
  "packages/gateway/src/services/oracle-client.ts",
  "packages/gateway/src/services/scope-acceptance.ts",
  "packages/gateway/src/services/settlement-keeper.ts",
  "packages/gateway/src/services/settlement-owned-status.ts",
  "packages/spec/src/funding/index.ts",
  "packages/spec/src/readmodels/product-home.ts",
  "packages/spec/src/types/tool-catalog.ts",
  "packages/gateway/src/services/buyer-funding-prepare.ts",
];
describe("scanEscrowWriters additional forms", () => {
  for (const [id, probe] of [
    ["WS1", 'const r = getRepos().escrows; r.updateStatus(id, "funded")'],
    ["WS2", 'const { escrows } = getRepos(); escrows.updateStatus(id, "funded")'],
    ["WS3", 'getRepos()["escrows"].updateStatus(id, "funded")'],
    ["WS4", 'new EscrowRepository(db).updateStatus(id, "funded")'],
    ["WS5", 'import {schema} from "@pcc/store"; sql`UPDATE ${schema.escrows} SET status = \'funded\'`'],
    ["WS5 alias", 'import {schema} from "@pcc/store"; const rows = schema.escrows; sql`UPDATE ${rows} SET status = \'funded\'`'],
    ["WS6", 'const { schema } = await import("@pcc/store"); db.update(schema.escrows).set({status:"funded"}).run()'],
    ["WS6 namespace", 'const store = await import("@pcc/store"); db.update(store.schema.escrows).set({status:"funded"}).run()'],
    ["WS7", 'import * as store from "@pcc/store"; db.update(store.schema.escrows).set({status:"funded"}).run()'],
    ["WS8", 'db.run("UPDATE main.escrows SET status = \'funded\'")'],
    ["WS9", 'db.run("UPDATE " + "escrows" + " SET status = \'funded\'")'],
    ["WS9 concat", 'db.run("UPDATE ".concat("escrows", " SET status = \'funded\'"))'],
    ["control drizzle", 'import {schema} from "@pcc/store"; db.update(schema.escrows).set({status:"funded"}).run()'],
    ["control repo", 'repos.escrows.updateStatus(id,"funded")'],
    ["WS1 repos binding", 'const repos = getRepos(); const r = repos.escrows; r.updateStatus(id,"funded")'],
    ["WS1 destructured instance", 'const r = new EscrowRepository(db); r.updateStatus(id,"funded")'],
  ]) it(`${id}: scanEscrowWriters recognizes the receiver or SQL expression`, () => {
    const scan = scanEscrowWriters("probe.ts", probe!);
    expect(scan.writes).toHaveLength(1); expect(scan.writes[0]!.table).toBe("escrows"); expect(scan.writes[0]!.statuses).toEqual(["funded"]);
  });
  it("WS10: productionFiles escrow mentions match the written inventory", () => {
    expect(productionFiles(ROOT).filter(f => /\b(?:escrows|escrowMilestones|escrow_milestones|EscrowRepository)\b/.test(readFileSync(f, "utf8")))
      .map(f => relative(ROOT, f)).sort()).toEqual([...ESCROW_MENTION_FILES].sort());
  });
  it("WS11: prepareBuyerFunding inserts only a created marker and pending milestone", () => {
    const writes = realScan().writes.filter(w => w.file === "packages/gateway/src/services/buyer-funding-prepare.ts");
    expect(writes.map(({ table, kind, statuses, versions, alias }) => ({ table, kind, statuses, versions, alias }))).toEqual([
      { table: "escrows", kind: "drizzle_insert", statuses: ["created"], versions: [MARKER], alias: false },
      { table: "escrow_milestones", kind: "drizzle_insert", statuses: ["pending"], versions: [], alias: false },
    ]);
  });
  it("WS12: prepareBuyerFunding imports the marker and has no literal copy", () => {
    const source = ts.createSourceFile("prepare.ts", readFileSync(join(ROOT, "packages/gateway/src/services/buyer-funding-prepare.ts"), "utf8"), ts.ScriptTarget.Latest, true);
    const literals: string[] = []; const imports: string[] = [];
    function walk(node: ts.Node) {
      if (ts.isStringLiteralLike(node)) literals.push(node.text);
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "./buyer-funded-escrow.js") {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) imports.push(...bindings.elements.map(e => e.propertyName?.text ?? e.name.text));
      }
      ts.forEachChild(node, walk);
    }
    walk(source); expect(literals).not.toContain(MARKER); expect(imports).toContain("BUYER_FUNDED_ESCROW_VERSION");
  });
});
