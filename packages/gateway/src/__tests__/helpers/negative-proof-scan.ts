import { execFileSync } from "node:child_process";
import { existsSync, statSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import ts from "typescript";

export const WRITE_METHODS = ["writeContract", "sendTransaction", "sendRawTransaction", "signTransaction", "prepareTransactionRequest", "deployContract", "encodeDeployData", "sendUserOp", "sendUserOperation", "sendCalls", "writeContracts"] as const;
export const WRITE_SCOPE = ["packages/*/src/**", "packages/contracts/ts/**", "apps/*/src/**"];
export interface Finding { rule: string; file: string; enclosing: string; expression: string; line?: number; detail?: string }
export interface WriteRecord { file: string; enclosing: string; method: string; args: string; functionName?: string; nonLiteralFunctionName?: boolean; abi?: string; bindings?: Record<string, string>; count: number }
export interface WriteEntry extends WriteRecord { signer: string; payload?: string; why: string }
export interface WriteAllowlist { schema: string; methods: string[]; scope: string[]; entries: WriteEntry[] }

/** Failure to enumerate git is fatal. Directories (including gitlinks) and removed files are dropped. */
export function listRepoFiles(root: string): string[] {
  let output: string;
  try {
    output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    // Fail loudly, without serializing git's entire (possibly partial) file list.
    throw new Error(`negative proof: git ls-files failed: ${(error as Error).message}`);
  }
  const files = [...new Set(output.split("\0").filter(Boolean))].filter(file => existsSync(join(root, file)) && statSync(join(root, file)).isFile()).sort();
  if (!files.length) throw new Error("negative proof: git returned no existing files");
  return files;
}
export function isTestPath(file: string): boolean {
  const parts = file.split("/");
  return parts.some(p => p === "__tests__" || p === "test" || p === "tests") || /\.(?:test|spec)\./.test(parts.at(-1)!) || file.endsWith(".t.sol");
}
export function isRuntimeFile(file: string): boolean {
  // Operator scripts scripts/**, packages/*/scripts/** and contracts/script/** are intentionally outside E2.
  return /^(?:packages\/[^/]+\/src\/|packages\/contracts\/ts\/|apps\/[^/]+\/src\/)/.test(file) && /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(file) && !file.endsWith(".d.ts") && !isTestPath(file);
}
export function parseSource(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
}
const printer = ts.createPrinter({ removeComments: true });
export function printNode(node: ts.Node, source: ts.SourceFile = node.getSourceFile()): string { return printer.printNode(ts.EmitHint.Unspecified, node, source).replace(/\s+/g, " ").trim(); }
export function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}
export function calleeName(expression: ts.Expression): string | undefined {
  expression = unwrap(expression);
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression && ts.isStringLiteralLike(expression.argumentExpression)) return expression.argumentExpression.text;
  return undefined;
}
function objectName(node: ts.Node): string | undefined {
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    return node.name?.text ?? (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) ? node.parent.name.text : undefined);
  }
  if (ts.isObjectLiteralExpression(node)) {
    const p = node.parent;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (ts.isPropertyAssignment(p)) {
      const parent = objectName(p.parent);
      return parent ? `${parent}.${p.name.getText()}` : p.name.getText();
    }
  }
  return undefined;
}
function functionLabel(node: ts.Node): string | undefined {
  if (!ts.isFunctionLike(node)) return undefined;
  let name: string | undefined;
  if ("name" in node && node.name) name = node.name.getText();
  if (!name && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
    if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) name = node.parent.name.text;
    else if (ts.isPropertyAssignment(node.parent)) name = node.parent.name.getText();
    else if (ts.isPropertyDeclaration(node.parent)) name = node.parent.name.getText();
  }
  if (!name) return undefined;
  const owner = objectName(node.parent) ?? (ts.isPropertyAssignment(node.parent) || ts.isPropertyDeclaration(node.parent) ? objectName(node.parent.parent) : undefined);
  return owner ? `${owner}.${name}` : name;
}
export function enclosingName(node: ts.Node): string {
  for (let p = node.parent; p; p = p.parent) if (ts.isFunctionLike(p)) {
    const label = functionLabel(p);
    return label ?? `<anonymous> in ${enclosingName(p)}`;
  }
  return "<module>";
}
interface Binding { expression?: ts.Expression; printed: string; declaration?: ts.Node }
const isScope = (node: ts.Node): boolean => ts.isSourceFile(node) || ts.isBlock(node)
  || ts.isModuleBlock(node) || ts.isFunctionLike(node) || ts.isCatchClause(node)
  || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node);

/** A destructuring projection is still one binding hop, e.g. { x } = req.body -> req.body.x. */
function projection(base: ts.Expression, key: ts.PropertyName | number): ts.Expression {
  const expression = unwrap(base);
  const staticKey = typeof key === "number" ? String(key) : ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : undefined;
  if (staticKey !== undefined && ts.isObjectLiteralExpression(expression)) {
    const value = property(expression, staticKey);
    if (value) return value;
  }
  if (typeof key === "number" && ts.isArrayLiteralExpression(expression) && expression.elements[key] && !ts.isOmittedExpression(expression.elements[key])) return expression.elements[key];
  if (typeof key === "number") return ts.factory.createElementAccessExpression(base, key);
  if (ts.isComputedPropertyName(key)) return ts.factory.createElementAccessExpression(base, key.expression);
  if (ts.isIdentifier(key)) return ts.factory.createPropertyAccessExpression(base, key.text);
  return ts.factory.createElementAccessExpression(base, ts.factory.createStringLiteral(key.text));
}
function destructured(name: string, pattern: ts.Node, base: ts.Expression): ts.Expression | undefined {
  if (ts.isIdentifier(pattern)) return pattern.text === name ? base : undefined;
  if (ts.isObjectBindingPattern(pattern)) {
    for (const element of pattern.elements) {
      const key = element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined);
      if (!key) continue;
      const result = destructured(name, element.name, element.dotDotDotToken ? base : projection(base, key));
      if (result) return result;
    }
  } else if (ts.isArrayBindingPattern(pattern)) {
    for (const [index, element] of pattern.elements.entries()) if (ts.isBindingElement(element)) {
      const result = destructured(name, element.name, element.dotDotDotToken ? base : projection(base, index));
      if (result) return result;
    }
  } else if (ts.isObjectLiteralExpression(pattern)) {
    // Assignment destructuring: ({ data: bytes } = req.body).
    for (const element of pattern.properties) {
      const result = ts.isShorthandPropertyAssignment(element) ? destructured(name, element.name, projection(base, element.name))
        : ts.isPropertyAssignment(element) ? destructured(name, element.initializer, projection(base, element.name))
        : ts.isSpreadAssignment(element) ? destructured(name, element.expression, base) : undefined;
      if (result) return result;
    }
  } else if (ts.isArrayLiteralExpression(pattern)) {
    for (const [index, element] of pattern.elements.entries()) {
      const result = destructured(name, element, projection(base, index));
      if (result) return result;
    }
  } else if (ts.isBinaryExpression(pattern) && pattern.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return destructured(name, pattern.left, base);
  }
  return undefined;
}
function declaresName(pattern: ts.Node, name: string): boolean {
  return !!destructured(name, pattern, ts.factory.createIdentifier("binding"));
}
function shadows(scope: ts.Node, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (node !== scope && isScope(node)) return;
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && declaresName(node.name, name)) found = true;
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

/** Nearest preceding binding/assignment in each lexical scope, outward through the module.
 * Closures can capture an outer binding; sibling blocks/functions cannot supply it.
 * Initializers are inspected once only: aliases in them are never resolved recursively.
 */
function binding(name: string, at: ts.Node): Binding {
  const source = at.getSourceFile();
  for (let scope: ts.Node | undefined = at.parent; scope; scope = scope.parent) {
    if (!isScope(scope)) continue;
    let found: { position: number; result: Binding } | undefined;
    const candidate = (pattern: ts.Node, initializer: ts.Expression | undefined, position: number): void => {
      const expression = initializer && destructured(name, pattern, initializer);
      const matches = expression || declaresName(pattern, name);
      if (matches && (!found || position > found.position)) found = {
        position, result: { ...(expression ? { expression } : {}), printed: expression ? printNode(expression, source) : "<unresolved>", declaration: pattern.parent ?? pattern },
      };
    };
    const walk = (node: ts.Node, nested = false): void => {
      if (node.pos >= at.pos) return;
      if (!nested && (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) candidate(node.name, undefined, node.pos);
      if (node !== scope && isScope(node)) {
        if (ts.isFunctionLike(node) || shadows(node, name)) return;
        // Completed if/try blocks may assign an outer variable. Only assignments
        // escape those scopes; their own local declarations never do.
        nested = true;
      }
      if (!nested && ts.isVariableDeclaration(node)) candidate(node.name, node.initializer, node.pos);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) candidate(unwrap(node.left), node.right, node.pos);
      ts.forEachChild(node, child => walk(child, nested));
    };
    walk(scope);
    if (found) return found.result;
    if (ts.isFunctionLike(scope)) {
      for (const parameter of scope.parameters) {
        if (ts.isIdentifier(parameter.name)) {
          if (parameter.name.text === name) return { printed: "param", declaration: parameter };
        } else {
          // Destructured request parameters have no source identifier. Preserve
          // their body/query/params/headers projection for the unallowlistable rule.
          const expression = destructured(name, parameter.name, ts.factory.createIdentifier("request"));
          if (expression) return { expression, printed: "param", declaration: parameter };
        }
      }
    }
  }
  return { printed: "<unresolved>" };
}
/** Shared lexical initializer lookup for schema inspection; still exactly one hop. */
export function resolveBinding(name: string, at: ts.Node): Binding { return binding(name, at); }
function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of object.properties) if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) && p.name.text === name) return ts.isShorthandPropertyAssignment(p) ? p.name : p.initializer;
  return undefined;
}
function literalName(expression: ts.Expression | undefined): string | undefined {
  if (!expression) return undefined;
  expression = unwrap(expression);
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isConditionalExpression(expression)) {
    const yes = literalName(expression.whenTrue), no = literalName(expression.whenFalse);
    if (yes !== undefined && no !== undefined) return `${yes}|${no}`;
  }
  return undefined;
}
function location(rule: string, file: string, node: ts.Node, detail?: string): Finding {
  return { rule, file, enclosing: enclosingName(node), expression: printNode(node), line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1, ...(detail ? { detail } : {}) };
}
function requestMember(node: ts.Node): boolean {
  let hit = false;
  const walk = (n: ts.Node) => {
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      const names: string[] = [];
      let cursor: ts.Expression = n;
      while (ts.isPropertyAccessExpression(cursor) || ts.isElementAccessExpression(cursor)) {
        const name = ts.isPropertyAccessExpression(cursor) ? cursor.name.text : cursor.argumentExpression && ts.isStringLiteralLike(cursor.argumentExpression) ? cursor.argumentExpression.text : "";
        names.unshift(name);
        cursor = unwrap(cursor.expression);
      }
      if (ts.isIdentifier(cursor) && ["req", "request", "reply", "ctx"].includes(cursor.text) && names.some(name => ["body", "query", "params", "headers"].includes(name))) hit = true;
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return hit;
}
function memberHasPayloadName(node: ts.Node): boolean {
  let hit = false;
  const walk = (n: ts.Node) => {
    if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && /calldata|callData|data|bytecode/.test(ts.isPropertyAccessExpression(n) ? n.name.text : n.argumentExpression ? printNode(n.argumentExpression) : "") && requestMember(n)) hit = true;
    ts.forEachChild(n, walk);
  };
  walk(node); return hit;
}
export function scanWrites(root: string, files: string[]): { records: WriteRecord[]; findings: Finding[] } {
  const records: WriteRecord[] = [], findings: Finding[] = [];
  for (const file of files.filter(isRuntimeFile)) {
    const text = readFileSync(join(root, file), "utf8");
    // Escaped identifiers/string element names must still reach the AST parser.
    if (!text.includes("\\") && !WRITE_METHODS.some(method => text.includes(method))) continue;
    const source = parseSource(file, text);
    const walk = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const method = calleeName(node.expression);
        if (method && (WRITE_METHODS as readonly string[]).includes(method)) {
          const bindings: Record<string, string> = {};
          const payloads: ts.Expression[] = [];
          const addBinding = (expr: ts.Expression, inspectPayload = true) => {
            expr = unwrap(expr);
            if (ts.isIdentifier(expr)) {
              const value = binding(expr.text, node);
              bindings[expr.text] = value.printed;
              if (inspectPayload && value.expression && requestMember(value.expression)) findings.push(location("E2-R4", file, node, `one-hop ${expr.text}: ${value.printed}`));
            }
          };
          const record: WriteRecord = { file, enclosing: enclosingName(node), method, args: node.arguments.map(a => printNode(a)).join(", "), count: 1 };
          const first = node.arguments[0] && unwrap(node.arguments[0]);
          if (method === "writeContract") {
            // Both wallet.writeContract({...}) and viem's bare writeContract(client, {...}).
            const object = node.arguments.map(unwrap).find(ts.isObjectLiteralExpression);
            let name = object && property(object, "functionName");
            if (name && ts.isIdentifier(unwrap(name))) {
              addBinding(name, false);
              const value = binding((unwrap(name) as ts.Identifier).text, node);
              if (value.expression) name = value.expression;
            }
            const literal = literalName(name);
            record.functionName = literal ?? (name ? printNode(name) : "<missing>");
            record.nonLiteralFunctionName = literal === undefined;
            record.abi = object && property(object, "abi") ? printNode(property(object, "abi")!) : "<missing>";
            const args = object && property(object, "args");
            if (args) {
              const list = unwrap(args);
              if (ts.isArrayLiteralExpression(list) && list.elements.some(memberHasPayloadName)) findings.push(location("E2-R4", file, node, "request member used as writeContract payload argument"));
            }
          } else {
            const collect = (n: ts.Node) => {
              if (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) {
                const name = ts.isIdentifier(n.name) || ts.isStringLiteralLike(n.name) ? n.name.text : "";
                if (["data", "callData", "calls", "serializedTransaction", "bytecode"].includes(name)) payloads.push(ts.isShorthandPropertyAssignment(n) ? n.name : n.initializer);
              }
              // A spread can supply every request field, including its raw bytes.
              if (ts.isSpreadAssignment(n)) payloads.push(n.expression);
              ts.forEachChild(n, collect);
            };
            for (const arg of node.arguments) collect(arg);
            if (first && !ts.isObjectLiteralExpression(first) && ["sendUserOp", "sendRawTransaction"].includes(method)) payloads.push(first);
            // Preparing/signing a named request still inspects its one-hop request object.
            if (first && ts.isIdentifier(first) && ["signTransaction", "prepareTransactionRequest", "sendTransaction"].includes(method)) {
              addBinding(first, false);
              const value = binding(first.text, node);
              if (value.expression) {
                collect(value.expression);
                const resolved = unwrap(value.expression);
                if ((ts.isPropertyAccessExpression(resolved) || ts.isElementAccessExpression(resolved)) && requestMember(resolved)) findings.push(location("E2-R4", file, node, `request object from ${value.printed}`));
              }
            }
            for (const payload of payloads) { addBinding(payload); if (requestMember(payload)) findings.push(location("E2-R4", file, node, `payload ${printNode(payload)}`)); }
          }
          if (Object.keys(bindings).length) record.bindings = Object.fromEntries(Object.entries(bindings).sort(([a], [b]) => a.localeCompare(b)));
          records.push(record);
        }
      }
      ts.forEachChild(node, walk);
    }; walk(source);
  }
  const merged = new Map<string, WriteRecord>();
  for (const record of records) { const key = JSON.stringify({ ...record, count: 0 }); const previous = merged.get(key); if (previous) previous.count++; else merged.set(key, record); }
  return { records: [...merged.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), findings };
}
export function readAllowlist(path: string): WriteAllowlist { return JSON.parse(readFileSync(path, "utf8")) as WriteAllowlist; }
function identity(record: WriteRecord): string {
  const { file, enclosing, method, args, functionName, abi, bindings } = record;
  return JSON.stringify({ file, enclosing, method, args, ...(functionName !== undefined ? { functionName } : {}), ...(abi !== undefined ? { abi } : {}), ...(bindings ? { bindings } : {}) });
}
export function compareWrites(records: WriteRecord[], allowlist: WriteAllowlist): Finding[] {
  const findings: Finding[] = [];
  const finding = (rule: string, entry: WriteRecord, detail: string): Finding => ({ rule, file: entry.file, enclosing: entry.enclosing, expression: `${entry.method}(${entry.args})`, detail });
  if (typeof allowlist.schema !== "string" || !allowlist.schema.trim()
    || JSON.stringify(allowlist.methods) !== JSON.stringify(WRITE_METHODS)
    || JSON.stringify(allowlist.scope) !== JSON.stringify(WRITE_SCOPE)) {
    findings.push({ rule: "E2-R3", file: "fixtures/money-path-write-allowlist.json", enclosing: "<allowlist>", expression: JSON.stringify({ schema: allowlist.schema, methods: allowlist.methods, scope: allowlist.scope }), detail: "schema, methods and scope must declare the complete scanned surface" });
  }
  const reviewed = (text: unknown): boolean => typeof text === "string" && text.trim().length > 0 && text.trim().toUpperCase() !== "REVIEW";
  for (const record of records) {
    const matching = allowlist.entries.filter(entry => identity(entry) === identity(record));
    const count = matching.reduce((sum, entry) => sum + entry.count, 0);
    if (count !== record.count) findings.push(finding("E2-R1", record, `expected ${record.count}, allowlisted ${count}; ready-to-paste: ${JSON.stringify({ ...record, signer: "REVIEW", ...(record.method === "writeContract" ? {} : { payload: "REVIEW" }), why: "REVIEW" })}`));
    for (const entry of matching) if (entry.nonLiteralFunctionName !== record.nonLiteralFunctionName) findings.push(finding("E2-R3", record, "nonLiteralFunctionName differs from the one-hop AST result"));
  }
  for (const entry of allowlist.entries) {
    if (!records.some(record => identity(entry) === identity(record))) findings.push(finding("E2-R2", entry, "stale allowlist entry"));
    else {
      const allowedCount = allowlist.entries.filter(other => identity(other) === identity(entry)).reduce((sum, other) => sum + other.count, 0);
      const scannedCount = records.filter(record => identity(entry) === identity(record)).reduce((sum, record) => sum + record.count, 0);
      if (allowedCount > scannedCount) findings.push(finding("E2-R2", entry, `stale multiplicity: allowlisted ${allowedCount}, scanned ${scannedCount}`));
    }
    if (!reviewed(entry.signer) || !reviewed(entry.why)) findings.push(finding("E2-R3", entry, "signer and why must be non-empty reviewed explanations"));
    if (entry.method !== "writeContract" && !reviewed(entry.payload)) findings.push(finding("E2-R3", entry, "raw payload requires a non-empty reviewed provenance line"));
    if (!Number.isSafeInteger(entry.count) || entry.count < 1) findings.push(finding("E2-R3", entry, "count must be a positive integer"));
    if (entry.method === "writeContract" && typeof entry.nonLiteralFunctionName !== "boolean") findings.push(finding("E2-R3", entry, "writeContract requires the exact nonLiteralFunctionName flag"));
  }
  return findings;
}
const deniedRPC = new Set(["eth_sendTransaction", "eth_sendRawTransaction", "eth_signTransaction", "eth_sendUserOperation", "wallet_sendCalls"]);
function moduleImport(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) return node.moduleSpecifier.text;
  if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) return node.moduleSpecifier.text;
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) return node.moduleReference.expression.text;
  if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || calleeName(node.expression) === "require") && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) return node.arguments[0].text;
  return undefined;
}
const subprocessMethods = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork", "execa"]);
const execaMethods = new Set(["default", "execa", "execaSync", "execaCommand", "execaCommandSync", "$", "sync", "command", "commandSync"]);
type SubprocessModule = "child_process" | "execa" | "util";
interface SubprocessBinding { module: SubprocessModule; member?: string }
function subprocessModule(name: string | undefined): SubprocessModule | undefined {
  if (name === "child_process" || name === "node:child_process") return "child_process";
  if (name === "util" || name === "node:util") return "util";
  return name === "execa" ? "execa" : undefined;
}
function subprocessExport(module: SubprocessModule, name: string): SubprocessBinding | undefined {
  if ((module === "child_process" || module === "util") && name === "default") return { module };
  if (module === "util") return name === "promisify" ? { module, member: name } : undefined;
  return (module === "child_process" ? subprocessMethods.has(name) && name !== "execa" : execaMethods.has(name)) ? { module, member: name } : undefined;
}
function subprocessNameShadowed(name: string, at: ts.Node): boolean {
  // A later local declaration still shadows an import (including hoisted functions).
  for (let scope: ts.Node | undefined = at.parent; scope; scope = scope.parent) {
    if (!isScope(scope)) continue;
    let found = false;
    const visit = (node: ts.Node): void => {
      if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name) found = true;
      if (node !== scope && isScope(node)) return;
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && declaresName(node.name, name)) found = true;
      ts.forEachChild(node, visit);
    };
    visit(scope);
    if (found) return true;
  }
  return false;
}

/** Resolve callable provenance with lexical bindings, preserving the location at
 * which an alias captured its initializer. This is separate from E2's one-hop rule.
 */
function subprocessBinding(expression: ts.Expression, at: ts.Node, seen = new Set<ts.Node>()): SubprocessBinding | undefined {
  expression = unwrap(expression);
  if (seen.has(expression)) return undefined;
  seen.add(expression);
  const reference = expression.parent && expression.pos >= 0 ? expression : at;
  try {
    if (ts.isIdentifier(expression)) {
      const value = binding(expression.text, reference);
      if (value.printed === "param") return undefined;
      if (value.expression) return subprocessBinding(value.expression, value.declaration ?? reference, seen);
      if (value.declaration || subprocessNameShadowed(expression.text, reference)) return undefined;
      for (const statement of reference.getSourceFile().statements) {
        if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
          const module = subprocessModule(statement.moduleSpecifier.text);
          const clause = statement.importClause;
          if (!module || !clause || clause.isTypeOnly) continue;
          if (clause.name?.text === expression.text) return module === "execa" ? { module, member: "default" } : { module };
          if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) && clause.namedBindings.name.text === expression.text) return { module };
          if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            const imported = clause.namedBindings.elements.find(item => !item.isTypeOnly && item.name.text === expression.text);
            if (imported) return subprocessExport(module, (imported.propertyName ?? imported.name).text);
          }
        }
        if (ts.isImportEqualsDeclaration(statement) && statement.name.text === expression.text) {
          const module = subprocessModule(moduleImport(statement));
          if (module && !statement.isTypeOnly) return { module };
        }
      }
    } else if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const owner = subprocessBinding(expression.expression, reference, seen);
      const member = calleeName(expression);
      if (owner && member && (!owner.member || owner.member === "default" || (owner.module === "execa" && owner.member === "$" && member === "sync"))) return subprocessExport(owner.module, member);
    } else if (ts.isCallExpression(expression)) {
      const module = subprocessModule(moduleImport(expression));
      if (module) return { module };
      const wrapper = subprocessBinding(expression.expression, reference, seen);
      if (wrapper?.module === "util" && wrapper.member === "promisify" && expression.arguments[0]) {
        const target = subprocessBinding(expression.arguments[0], reference, seen);
        if (target && (target.module === "execa" || (target.module === "child_process" && target.member))) return target;
        // Preserve the same bare subprocess-name compatibility as direct calls.
        const name = calleeName(expression.arguments[0]);
        if (name && subprocessMethods.has(name)) return { module: name === "execa" ? "execa" : "child_process", member: name };
      }
    } else if (ts.isAwaitExpression(expression)) {
      return subprocessBinding(expression.expression, reference, seen);
    }
    return undefined;
  } finally { seen.delete(expression); }
}
function isSubprocessCall(node: ts.CallExpression): boolean {
  if (subprocessMethods.has(calleeName(node.expression) ?? "")) return true;
  const target = subprocessBinding(node.expression, node);
  return !!target && (target.module === "execa" || (target.module === "child_process" && !!target.member));
}
// Does not resolve commands imported from other modules, returned from functions, held in object properties or joined from arrays.
function commandLiteralParts(expression: ts.Expression, at: ts.Node, seen = new Set<ts.Node>(), argvOnly = false): string[] {
  expression = unwrap(expression);
  if (seen.has(expression)) return [];
  seen.add(expression);
  const reference = expression.parent && expression.pos >= 0 ? expression : at;
  try {
    if (ts.isIdentifier(expression)) {
      const value = binding(expression.text, reference);
      return value.expression && value.printed !== "param" ? commandLiteralParts(value.expression, value.declaration ?? reference, seen, argvOnly) : [];
    }
    if (ts.isArrayLiteralExpression(expression)) return expression.elements.flatMap(element => commandLiteralParts(element, reference, seen));
    if (argvOnly) return [];
    if (ts.isStringLiteralLike(expression)) return [expression.text];
    if (ts.isTemplateExpression(expression)) return [expression.head.text, ...expression.templateSpans.map(span => span.literal.text)];
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) return [...commandLiteralParts(expression.left, reference, seen), ...commandLiteralParts(expression.right, reference, seen)];
    return [];
  } finally { seen.delete(expression); }
}
function solidityCommandWords(parts: string[]): string[] {
  const tools = new Set(["solc", "solcjs", "forge", "cast", "anvil", "chisel"]);
  // These are command values obtained through the AST, never source-code matches.
  return parts.flatMap(part => part.split(/\s+|&&|\|\||[;|`]|\$\(/))
    .map(word => basename(word.replace(/^["'`(]+|["'`)]+$/g, "")))
    .filter(word => tools.has(word));
}
export function scanForbiddenRuntime(root: string, files: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files.filter(isRuntimeFile)) {
    const text = readFileSync(join(root, file), "utf8");
    if (!text.includes("\\") && !["ethers", "web3", "getContract", "eth_", "wallet_sendCalls", "solc", "forge", "cast", "anvil", "chisel"].some(s => text.includes(s))) continue;
    const walk = (node: ts.Node) => {
      const imported = moduleImport(node);
      if (imported && (imported === "ethers" || imported.startsWith("@ethersproject/") || imported === "web3")) findings.push(location("E2-R5", file, node));
      if (ts.isCallExpression(node) && calleeName(node.expression) === "getContract") findings.push(location("E2-R5", file, node));
      if (ts.isStringLiteralLike(node) && deniedRPC.has(node.text)) findings.push(location("E2-R5", file, node));
      if (imported === "solc" || imported === "solc-js") findings.push(location("E3-R2", file, node));
      if (ts.isCallExpression(node)) {
        const parts = node.arguments[0] ? commandLiteralParts(node.arguments[0], node) : [];
        if (node.arguments[1]) parts.push(...commandLiteralParts(node.arguments[1], node, new Set(), true));
        const words = solidityCommandWords(parts);
        if (words.length && isSubprocessCall(node)) findings.push(location("E3-R2", file, node, `Solidity command words: ${words.join(", ")}`));
      }
      if (ts.isTaggedTemplateExpression(node)) {
        const words = solidityCommandWords(commandLiteralParts(node.template, node));
        if (words.length && subprocessBinding(node.tag, node)?.module === "execa") findings.push(location("E3-R2", file, node, `Solidity command words: ${words.join(", ")}`));
      }
      ts.forEachChild(node, walk);
    }; walk(parseSource(file, text));
  }
  return findings;
}
export function scanPythonWrites(root: string, files: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files.filter(file => file.startsWith("packages/") && file.endsWith(".py") && !isTestPath(file))) {
    // Python permits a token scan; remove comments and quoted strings before recognizing calls.
    const text = readFileSync(join(root, file), "utf8").replace(/'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|#[^\n]*/g, " ");
    const pattern = /\b(?:send_raw_transaction|send_transaction|sign_transaction|build_transaction)\s*\(|\.\s*transact\s*\(/g;
    for (const match of text.matchAll(pattern)) findings.push({ rule: "E2-R6", file, enclosing: "<python>", expression: match[0], line: text.slice(0, match.index).split("\n").length });
  }
  return findings;
}
export function scanBytecode(root: string, files: string[], includeTests = false): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if ((!includeTests && isTestPath(file)) || file.startsWith("packages/contracts/out/")) continue;
    const bytes = readFileSync(join(root, file));
    if (bytes.subarray(0, 8192).includes(0)) continue;
    const text = bytes.toString("utf8");
    const pattern = /(?:0x)?(?:60[0-9a-f]{2}|61[0-9a-f]{4})604052[0-9a-f]{16,}/gi;
    for (const match of text.matchAll(pattern)) findings.push({ rule: "E3-R1", file, enclosing: "<file>", expression: match[0], line: text.slice(0, match.index).split("\n").length });
  }
  return findings;
}
export function scanRuntimeSolcDependencies(root: string, files: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files.filter(file => /^(?:packages|apps)\/[^/]+\/package\.json$/.test(file))) {
    const json = JSON.parse(readFileSync(join(root, file), "utf8"));
    for (const group of ["dependencies", "optionalDependencies", "peerDependencies"]) if (Object.hasOwn(json[group] ?? {}, "solc")) findings.push({ rule: "E3-R3", file, enclosing: group, expression: `solc: ${JSON.stringify(json[group].solc)}` });
  }
  return findings;
}
export function formatFindings(findings: Finding[]): string { return findings.map(f => `${f.rule} ${f.file}${f.line ? `:${f.line}` : ""} [${f.enclosing}] ${f.expression}${f.detail ? `\n  ${f.detail}` : ""}`).join("\n"); }
