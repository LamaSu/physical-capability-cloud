import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { enclosingName, isRuntimeFile, listRepoFiles, parseSource, printNode, resolveBinding, unwrap, type Finding } from "./helpers/negative-proof-scan.js";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const AGENT_PACKAGE = "apps/dashboard/public/agent-package.json";
const FIXTURE = fileURLToPath(new URL("./fixtures/llm-money-address-tools.json", import.meta.url));
const TIMEOUT = 60_000;
type Source = "agent-package" | "mcp";
interface Parameter { source: Source; tool: string; path: string; name: string; description: string; file: string; enclosing: string; expression: string }
interface AddressTool { source: Source; tool: string; params: string[] }
interface ReviewedTool extends AddressTool { class: "money" | "other"; why: string }
interface Review { schema: string; entries: ReviewedTool[] }
interface ToolScan { findings: Finding[]; addresses: AddressTool[]; parameters: Parameter[]; agentToolCount: number; mcpToolCount: number; mcpPlainCallCount: number }
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const normalize = (name: string) => name.toLowerCase().replace(/[_-]/g, "");
const FORBIDDEN = new Set(["calldata", "bytecode", "initcode", "deploydata", "rawtx", "rawtransaction", "signedtx", "signedtransaction", "serializedtx", "serializedtransaction", "txdata", "transactiondata"]);
const FORBIDDEN_DESCRIPTION = /\b(call ?data|bytecode|init ?code|raw transaction|signed transaction|serialized transaction)\b/i;
const ADDRESS_DESCRIPTION = /\bEVM address\b|\baddress \(0x|\(0x\.\.\.\)|\b20-byte\b|\b(?:token|contract) address\b/i;
function addressLike(parameter: Parameter): boolean {
  return ["address", "recipient", "payto", "payee", "payer", "beneficiary", "receiver", "arbiter"].some(suffix => normalize(parameter.name).endsWith(suffix)) || ADDRESS_DESCRIPTION.test(parameter.description);
}
function finding(rule: string, parameter: Parameter, detail: string): Finding {
  return { rule, file: parameter.file, enclosing: parameter.enclosing, expression: parameter.expression, detail: `${parameter.source}:${parameter.tool}:${parameter.path}: ${detail}` };
}
function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : ts.isComputedPropertyName(name) && ts.isStringLiteralLike(unwrap(name.expression)) ? (unwrap(name.expression) as ts.StringLiteralLike).text : undefined;
}

/** Independent lexical count: comments and string contents are single tokens, never source-code regex matches. */
function plainToolCount(text: string): number {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const tokens: { kind: ts.SyntaxKind; text: string }[] = [];
  const templates: number[] = [];
  let braceDepth = 0;
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.CloseBraceToken && templates.at(-1) === braceDepth) {
      kind = scanner.reScanTemplateToken(false);
      if (kind === ts.SyntaxKind.TemplateTail) templates.pop();
    } else if (kind === ts.SyntaxKind.OpenBraceToken) braceDepth++;
    else if (kind === ts.SyntaxKind.CloseBraceToken) braceDepth--;
    if (kind === ts.SyntaxKind.TemplateHead) templates.push(braceDepth);
    tokens.push({ kind, text: kind === ts.SyntaxKind.Identifier ? scanner.getTokenValue() : scanner.getTokenText() });
  }
  let count = 0;
  for (let i = 0; i + 3 < tokens.length; i++) if (tokens[i].kind === ts.SyntaxKind.DotToken && tokens[i + 1].text === "tool" && tokens[i + 2].kind === ts.SyntaxKind.OpenParenToken && [ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral].includes(tokens[i + 3].kind)) count++;
  return count;
}

/** Pure in (root, file list): parse data schemas and TS ASTs; never load or execute an MCP handler. */
export function scanToolReach(root: string, files: string[]): ToolScan {
  const parameters: Parameter[] = [], findings: Finding[] = [];
  let agentToolCount = 0, mcpToolCount = 0, mcpPlainCallCount = 0;
  if (!files.includes(AGENT_PACKAGE)) throw new Error(`E4b-R1: file list is missing ${AGENT_PACKAGE}`);
  const pkg: unknown = JSON.parse(readFileSync(join(root, AGENT_PACKAGE), "utf8"));
  if (!object(pkg) || !Array.isArray(pkg.tools)) throw new Error("E4b-R1: agent package tools must be an array");
  for (const tool of pkg.tools) {
    if (!object(tool) || typeof tool.name !== "string" || !object(tool.input_schema)) throw new Error("E4b-R1: every agent tool needs a name and input_schema");
    agentToolCount++;
    const walk = (schema: unknown, path: string, name: string) => {
      if (path) parameters.push({ source: "agent-package", tool: tool.name as string, path, name, description: object(schema) && typeof schema.description === "string" ? schema.description : "", file: AGENT_PACKAGE, enclosing: tool.name as string, expression: JSON.stringify(schema) });
      // JSON Schema boolean schemas still declare a parameter name.
      if (!object(schema)) return;
      if (object(schema.properties)) for (const [key, child] of Object.entries(schema.properties)) walk(child, path ? `${path}.${key}` : key, key);
      if (object(schema.items)) walk(schema.items, `${path}[]`, name);
      if (Array.isArray(schema.items)) for (const child of schema.items) if (object(child)) walk(child, `${path}[]`, name);
      for (const key of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(schema[key])) for (const child of schema[key]) if (object(child)) walk(child, path, name);
      if (object(schema.additionalProperties)) walk(schema.additionalProperties, path ? `${path}.*` : "*", name);
    };
    walk(tool.input_schema, "", "");
  }
  if (typeof pkg.toolCount === "number" && pkg.toolCount !== agentToolCount) findings.push({ rule: "E4b-R1", file: AGENT_PACKAGE, enclosing: "<module>", expression: `toolCount: ${pkg.toolCount}`, detail: `walked ${agentToolCount} tools` });

  const sourceCache = new Map<string, ts.SourceFile>();
  const sourceFor = (file: string): ts.SourceFile => {
    let source = sourceCache.get(file);
    if (!source) { source = parseSource(file, readFileSync(join(root, file), "utf8")); sourceCache.set(file, source); }
    return source;
  };
  const resolve = (identifier: ts.Identifier): ts.Expression | undefined => {
    const source = identifier.getSourceFile();
    const value = resolveBinding(identifier.text, identifier).expression;
    if (value) return value;
    // The MCP capture tool uses an imported Zod object. Inspect its declaration too,
    // so nested schema keys are covered without importing code or invoking getters.
    for (const statement of source.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
      const imported = statement.importClause.namedBindings.elements.find(element => element.name.text === identifier.text);
      if (!imported || !statement.moduleSpecifier.text.startsWith("@pcc/")) continue;
      const packageName = statement.moduleSpecifier.text.slice("@pcc/".length).split("/")[0];
      const exportedName = (imported.propertyName ?? imported.name).text;
      for (const file of files) if (file.startsWith(`packages/${packageName}/src/`) && isRuntimeFile(file)) {
        const text = readFileSync(join(root, file), "utf8");
        if (!text.includes(exportedName)) continue;
        const declarations = sourceFor(file);
        for (const declaration of declarations.statements) if (ts.isVariableStatement(declaration) && declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) for (const item of declaration.declarationList.declarations) if (ts.isIdentifier(item.name) && item.name.text === exportedName && item.initializer) return item.initializer;
      }
    }
    return undefined;
  };
  for (const file of files.filter(file => file.startsWith("packages/mcp-server/src/") && isRuntimeFile(file))) {
    const text = readFileSync(join(root, file), "utf8");
    if (!text.includes("tool") && !text.includes("\\")) continue;
    mcpPlainCallCount += plainToolCount(text);
    const source = sourceFor(file);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(unwrap(node.expression)) && (unwrap(node.expression) as ts.PropertyAccessExpression).name.text === "tool" && node.arguments[0] && ts.isStringLiteralLike(unwrap(node.arguments[0]))) {
        mcpToolCount++;
        const tool = (unwrap(node.arguments[0]) as ts.StringLiteralLike).text;
        const shape = node.arguments[2];
        if (!shape) throw new Error(`E4b-R1: ${file}:${tool} has no shape`);
        const seen = new Set<ts.Node>();
        const opaque = (expression: ts.Expression, path: string, why: string) => findings.push({ rule: "E4b-R1", file, enclosing: enclosingName(node), expression: printNode(expression, source), detail: `${tool}:${path || "<shape>"}: ${why}` });
        const walkShape = (expression: ts.Expression, path: string, name: string, descriptions: string[] = []) => {
          expression = unwrap(expression);
          if (seen.has(expression)) { opaque(expression, path, "cyclic schema alias cannot be inspected"); return; }
          seen.add(expression);
          try {
            if (ts.isIdentifier(expression)) {
              const initializer = resolve(expression);
              if (initializer) { walkShape(initializer, path, name, descriptions); return; }
              opaque(expression, path, "unresolved schema alias cannot be inspected");
            }
            if (ts.isPropertyAccessExpression(expression) && expression.name.text === "shape") {
              walkShape(expression.expression, path, name, descriptions);
              return;
            }
            if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(unwrap(expression.expression))) {
              const callee = unwrap(expression.expression) as ts.PropertyAccessExpression;
              if (callee.name.text === "describe") {
                const description = expression.arguments[0];
                if (!description || !ts.isStringLiteralLike(unwrap(description))) opaque(expression, path, "nonliteral schema description cannot be inspected");
                walkShape(callee.expression, path, name, description && ts.isStringLiteralLike(unwrap(description)) ? [...descriptions, (unwrap(description) as ts.StringLiteralLike).text] : descriptions);
                return;
              }
              const constructor = ts.isIdentifier(unwrap(callee.expression)) && (unwrap(callee.expression) as ts.Identifier).text === "z";
              if (constructor && ["object", "array", "record", "union", "discriminatedUnion", "intersection", "tuple"].includes(callee.name.text)) {
                if (path) parameters.push({ source: "mcp", tool, path, name, description: descriptions.join(" "), file, enclosing: enclosingName(node), expression: printNode(expression) });
                if (!expression.arguments.length) opaque(expression, path, "schema container has no inspectable argument");
                if (callee.name.text === "object" && expression.arguments[0]) walkShape(expression.arguments[0], path, name);
                if (callee.name.text === "array" && expression.arguments[0]) walkShape(expression.arguments[0], `${path}[]`, name);
                if (callee.name.text === "record" && expression.arguments.length) walkShape(expression.arguments[expression.arguments.length - 1], `${path}.*`, name);
                if (["union", "discriminatedUnion"].includes(callee.name.text)) {
                  const variants = expression.arguments[callee.name.text === "union" ? 0 : 1];
                  if (variants && ts.isArrayLiteralExpression(unwrap(variants))) for (const variant of (unwrap(variants) as ts.ArrayLiteralExpression).elements) walkShape(variant, path, name);
                  else opaque(expression, path, "schema variants are not an inspectable array");
                }
                if (callee.name.text === "intersection") for (const variant of expression.arguments) walkShape(variant, path, name);
                if (callee.name.text === "tuple" && expression.arguments[0] && ts.isArrayLiteralExpression(unwrap(expression.arguments[0]))) for (const item of (unwrap(expression.arguments[0]) as ts.ArrayLiteralExpression).elements) walkShape(item, `${path}[]`, name);
                return;
              }
              if (!constructor && ["optional", "nullable", "nullish", "default", "catch", "readonly", "brand", "min", "max", "length", "int", "positive", "nonnegative", "negative", "nonpositive", "finite", "safe", "multipleOf", "gt", "gte", "lt", "lte", "uuid", "url", "email", "datetime", "date", "time", "duration", "regex", "trim", "toLowerCase", "toUpperCase", "startsWith", "endsWith", "includes", "nonempty", "strict", "strip", "passthrough"].includes(callee.name.text)) { walkShape(callee.expression, path, name, descriptions); return; }
              if (!constructor || !["string", "number", "boolean", "bigint", "date", "symbol", "undefined", "null", "void", "any", "unknown", "never", "nan", "literal", "enum", "nativeEnum"].includes(callee.name.text)) opaque(expression, path, "unsupported schema expression cannot be inspected");
            }
            if (ts.isObjectLiteralExpression(expression)) {
              for (const property of expression.properties) {
                if (ts.isSpreadAssignment(property)) { walkShape(property.expression, path, name); continue; }
                if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
                  const key = propertyName(property.name);
                  if (key === undefined) throw new Error(`E4b-R1: unresolvable MCP property ${file}: ${printNode(property)}`);
                  walkShape(ts.isPropertyAssignment(property) ? property.initializer : property.name, path ? `${path}.${key}` : key, key);
                }
              }
              return;
            }
            if (ts.isCallExpression(expression) && !ts.isPropertyAccessExpression(unwrap(expression.expression))) opaque(expression, path, "opaque schema factory cannot be inspected");
            if (!ts.isIdentifier(expression) && !ts.isCallExpression(expression)) opaque(expression, path, "opaque schema expression cannot be inspected");
            if (path) parameters.push({ source: "mcp", tool, path, name, description: descriptions.join(" "), file, enclosing: enclosingName(node), expression: printNode(expression) });
          } finally { seen.delete(expression); }
        };
        walkShape(shape, "", "");
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  if (mcpToolCount !== mcpPlainCallCount) findings.push({ rule: "E4b-R1", file: "packages/mcp-server/src/**", enclosing: "<module>", expression: `.tool(<literal>): AST=${mcpToolCount}, lexical=${mcpPlainCallCount}`, detail: "MCP registration counts must agree" });
  for (const parameter of parameters) if (FORBIDDEN.has(normalize(parameter.name)) || FORBIDDEN_DESCRIPTION.test(parameter.description)) findings.push(finding("E4b-R1", parameter, `forbidden name or description ${JSON.stringify(parameter.description)}`));
  const grouped = new Map<string, AddressTool>();
  for (const parameter of parameters.filter(addressLike)) {
    const key = `${parameter.source}:${parameter.tool}`;
    const entry = grouped.get(key) ?? { source: parameter.source, tool: parameter.tool, params: [] };
    if (!entry.params.includes(parameter.path)) entry.params.push(parameter.path);
    grouped.set(key, entry);
  }
  const addresses = [...grouped.values()].map(entry => ({ ...entry, params: entry.params.sort() })).sort((a, b) => `${a.source}:${a.tool}`.localeCompare(`${b.source}:${b.tool}`));
  return { parameters, addresses, findings, agentToolCount, mcpToolCount, mcpPlainCallCount };
}

/** Fixture path is a parameter so self-mutants use copies, never change the committed review. */
export function compareAddressReview(scan: ToolScan, fixturePath: string): Finding[] {
  const review = JSON.parse(readFileSync(fixturePath, "utf8")) as Review;
  const findings: Finding[] = [];
  const fail = (expression: string, detail: string) => findings.push({ rule: "E4b-R2", file: fixturePath, enclosing: "<module>", expression, detail: `${detail}; detected=${JSON.stringify(scan.addresses)}` });
  if (review.schema !== "pcc-llm-money-address-tools/1" || !Array.isArray(review.entries)) { fail(JSON.stringify(review), "invalid review schema"); return findings; }
  const identity = (entry: AddressTool) => JSON.stringify({ source: entry.source, tool: entry.tool, params: [...entry.params].sort() });
  const expected = new Map(scan.addresses.map(entry => [identity(entry), entry]));
  const seen = new Set<string>();
  for (const entry of review.entries) {
    const key = identity(entry);
    if (seen.has(key)) fail(key, "duplicate reviewed tool");
    seen.add(key);
    if (!expected.delete(key)) fail(key, "stale or changed reviewed tool");
    if (!["money", "other"].includes(entry.class) || !entry.why?.trim() || entry.why.trim().toUpperCase() === "REVIEW") fail(key, "class and reviewed explanation are required");
    if (["near_quote", "near_intent"].includes(entry.tool) && entry.class !== "money") fail(key, "payment routing must be money");
  }
  for (const key of expected.keys()) fail(key, "unreviewed address tool");
  return findings;
}

const temporaryRoots: string[] = [];
afterAll(() => { for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true }); });
function synthetic(agentTools: unknown[], mcpText: string): { root: string; files: string[] } {
  const root = mkdtempSync(join(tmpdir(), "pcc-e4b-")); temporaryRoots.push(root);
  const files = [AGENT_PACKAGE, "packages/mcp-server/src/control.ts"];
  for (const file of files) mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, AGENT_PACKAGE), JSON.stringify({ tools: agentTools }));
  writeFileSync(join(root, files[1]), mcpText);
  return { root, files };
}
function fixtureCopy(review: Review): string {
  const root = mkdtempSync(join(tmpdir(), "pcc-e4b-review-")); temporaryRoots.push(root);
  const path = join(root, "review.json"); writeFileSync(path, JSON.stringify(review)); return path;
}
const formatFindings = (findings: Finding[]) => findings.map(hit => `${hit.rule} ${hit.file} :: ${hit.enclosing} :: ${hit.expression} :: ${hit.detail ?? ""}`).join("\n");
let cachedReal: ToolScan | undefined;
const realScan = () => cachedReal ??= scanToolReach(ROOT, listRepoFiles(ROOT));

describe("E4b: LLM tool parameter boundary", () => {
  it("E4b-R1: real agent and MCP schemas expose no calldata or bytecode parameters; MCP AST and lexical counts agree", () => {
    const scan = realScan();
    expect(scan.agentToolCount).toBeGreaterThan(0);
    expect(scan.mcpToolCount).toBeGreaterThan(0);
    expect(scan.mcpToolCount).toBe(scan.mcpPlainCallCount);
    expect(scan.findings, formatFindings(scan.findings)).toEqual([]);
    console.info(`E4b tools: agent=${scan.agentToolCount}, MCP AST=${scan.mcpToolCount}, MCP lexical=${scan.mcpPlainCallCount}; parameter schema nodes=${scan.parameters.length}`);
  }, TIMEOUT);

  it("E4b-R1 positive controls: forbidden names and descriptions in nested JSON and Zod schema branches are reported", () => {
    const { root, files } = synthetic([{ name: "planted", input_schema: { properties: { nested: { anyOf: [{ properties: { call_data: { type: "string" } } }] }, rows: { items: { oneOf: [{ properties: { item: { description: "signed transaction" } } }] } }, dictionary: { additionalProperties: { allOf: [{ properties: { initCode: {} } }] } } } } }], `server.tool("planted_mcp", "test", { groups: z.array(z.object({ raw_tx: z.string(), child: z.object({ blob: z.string().describe("call data") }).optional() })).optional().describe("group") }, handler);`);
    const hits = scanToolReach(root, files).findings;
    for (const path of ["nested.call_data", "rows[].item", "dictionary.*.initCode", "groups[].raw_tx", "groups[].child.blob"]) expect(hits.some(hit => hit.rule === "E4b-R1" && hit.detail?.includes(path)), formatFindings(hits)).toBe(true);
  }, TIMEOUT);

  it("E4b-R1 near misses: descriptions about ordinary data, comments, strings and handler locals are clean", () => {
    const { root, files } = synthetic([{ name: "safe", input_schema: { properties: { data: { description: "Evidence data" }, transactionId: { type: "string" } } } }], `// server.tool("comment", "", { bytecode: z.string() }, h)\nconst text = 'server.tool("string", "", { rawTx: z.string() }, h)';\nserver.tool("safe", "", { code: z.string().optional().describe("Machine code identifier"), records: z.array(z.object({ id: z.string() })) }, () => { const bytecode = "local"; });`);
    const escaped = "packages/mcp-server/src/escaped.ts";
    writeFileSync(join(root, escaped), `server.to\\u006fl("escaped", "", {safe:z.string()}, h);`);
    files.push(escaped);
    const scan = scanToolReach(root, files);
    expect(scan.findings, formatFindings(scan.findings)).toEqual([]);
    expect(scan.mcpToolCount).toBe(2); expect(scan.mcpPlainCallCount).toBe(2);
  }, TIMEOUT);

  it("E4b-R1 positive control: a Zod object shape projection exposes its forbidden key", () => {
    const { root, files } = synthetic([], `server.tool("projection", "", z.object({ calldata: z.string() }).shape, h);`);
    const scan = scanToolReach(root, files);
    expect(scan.mcpToolCount).toBe(1);
    expect(scan.parameters.some(parameter => parameter.path === "calldata")).toBe(true);
    expect(scan.findings.some(hit => hit.rule === "E4b-R1" && hit.detail?.includes("calldata")), formatFindings(scan.findings)).toBe(true);
  }, TIMEOUT);

  it("E4b-R1 near miss: a safe Zod object shape projection is fully inspected", () => {
    const { root, files } = synthetic([], `const schema = z.object({ safe: z.string() }); server.tool("projection", "", schema.shape, h);`);
    const scan = scanToolReach(root, files);
    expect(scan.parameters.map(parameter => parameter.path)).toEqual(["safe"]);
    expect(scan.findings, formatFindings(scan.findings)).toEqual([]);
  }, TIMEOUT);

  it("E4b-R1 positive control: opaque imported root and nested schema aliases fail inspection", () => {
    const { root, files } = synthetic([], `import { Shape } from "./opaque.js"; server.tool("root", "", Shape, h); server.tool("nested", "", { value: Shape.optional() }, h);`);
    const scan = scanToolReach(root, files);
    for (const tool of ["root", "nested"]) expect(scan.findings.some(hit => hit.rule === "E4b-R1" && hit.detail?.includes(tool) && hit.detail.includes("unresolved schema alias")), formatFindings(scan.findings)).toBe(true);
  }, TIMEOUT);

  it("E4b-R1 near miss: resolvable imported root and nested schema aliases are inspected", () => {
    const { root, files } = synthetic([], `import { Shape } from "@pcc/control"; server.tool("root", "", Shape.shape, h); server.tool("nested", "", { value: Shape.optional() }, h);`);
    const file = "packages/control/src/schema.ts";
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), `export const Shape = z.object({ safe: z.string() });`);
    files.push(file);
    const scan = scanToolReach(root, files);
    expect(scan.parameters.some(parameter => parameter.path === "safe")).toBe(true);
    expect(scan.parameters.some(parameter => parameter.path === "value.safe")).toBe(true);
    expect(scan.findings, formatFindings(scan.findings)).toEqual([]);
  }, TIMEOUT);

  it("E4b-R1 positive control: a sibling function cannot replace the enclosing forbidden shape binding", () => {
    const { root, files } = synthetic([], `const shape = { calldata: z.string() }; function unused() { const shape = { safe: z.string() }; } server.tool("scope", "", shape, h);`);
    const scan = scanToolReach(root, files);
    expect(scan.parameters.map(parameter => parameter.path)).toEqual(["calldata"]);
    expect(scan.findings.some(hit => hit.rule === "E4b-R1" && hit.detail?.includes("calldata")), formatFindings(scan.findings)).toBe(true);
  }, TIMEOUT);

  it("E4b-R1 near miss: a forbidden sibling binding cannot replace the enclosing safe shape", () => {
    const { root, files } = synthetic([], `const shape = { safe: z.string() }; function unused() { const shape = { calldata: z.string() }; } server.tool("scope", "", shape, h);`);
    const scan = scanToolReach(root, files);
    expect(scan.parameters.map(parameter => parameter.path)).toEqual(["safe"]);
    expect(scan.findings, formatFindings(scan.findings)).toEqual([]);
  }, TIMEOUT);

  it("E4b-R1/R2 positive control: boolean JSON schemas still expose forbidden and payment parameter names", () => {
    const { root, files } = synthetic([{ name: "boolean_schema", input_schema: { properties: { calldata: true, recipient: true } } }], "");
    const scan = scanToolReach(root, files);
    expect(scan.findings.some(hit => hit.rule === "E4b-R1" && hit.detail?.includes("calldata")), formatFindings(scan.findings)).toBe(true);
    expect(scan.addresses).toEqual([{ source: "agent-package", tool: "boolean_schema", params: ["recipient"] }]);
    const hits = compareAddressReview(scan, fixtureCopy({ schema: "pcc-llm-money-address-tools/1", entries: [] }));
    expect(hits).toHaveLength(1); expect(hits[0].rule).toBe("E4b-R2");
  }, TIMEOUT);

  it("E4b-R1/R2 near miss: ordinary boolean-schema names are inspected without findings", () => {
    const { root, files } = synthetic([{ name: "boolean_schema", input_schema: { properties: { ordinary: true, optionalThing: false } } }], "");
    const scan = scanToolReach(root, files);
    expect(scan.parameters.map(parameter => parameter.path)).toEqual(["ordinary", "optionalThing"]);
    expect(scan.findings, formatFindings(scan.findings)).toEqual([]);
    expect(compareAddressReview(scan, fixtureCopy({ schema: "pcc-llm-money-address-tools/1", entries: [] }))).toEqual([]);
  }, TIMEOUT);

  it("E4b-R2: every detected address tool and parameter path exactly matches the reviewed money/other list", () => {
    const scan = realScan(), hits = compareAddressReview(scan, FIXTURE);
    expect(hits, formatFindings(hits)).toEqual([]);
    const entries = (JSON.parse(readFileSync(FIXTURE, "utf8")) as Review).entries;
    console.info(`E4b address tools=${entries.length}; money=${entries.filter(entry => entry.class === "money").length}; other=${entries.filter(entry => entry.class === "other").length}`);
  }, TIMEOUT);

  it("E4b-R2 positive control: an unreviewed nested payment address fails the list comparison", () => {
    const { root, files } = synthetic([{ name: "pay", input_schema: { properties: { splits: { items: { properties: { pay_to: {} } } } } } }], `server.tool("read", "", { destination: z.string().describe("20-byte target") }, h);`);
    const scan = scanToolReach(root, files), hits = compareAddressReview(scan, fixtureCopy({ schema: "pcc-llm-money-address-tools/1", entries: [] }));
    expect(scan.addresses).toEqual([{ source: "agent-package", tool: "pay", params: ["splits[].pay_to"] }, { source: "mcp", tool: "read", params: ["destination"] }]);
    expect(hits).toHaveLength(2); expect(hits.every(hit => hit.rule === "E4b-R2")).toBe(true);
  }, TIMEOUT);

  it("E4b-R2 near misses: ordinary names are ignored, and reviewed address paths compare cleanly", () => {
    const { root, files } = synthetic([{ name: "identity", input_schema: { properties: { email: { description: "Email address" }, addressBookId: {}, walletAddress: {} } } }], `server.tool("read", "", { deliveryNotes: z.string(), addressesCount: z.number() }, h);`);
    const scan = scanToolReach(root, files);
    expect(scan.addresses).toEqual([{ source: "agent-package", tool: "identity", params: ["walletAddress"] }]);
    const path = fixtureCopy({ schema: "pcc-llm-money-address-tools/1", entries: [{ ...scan.addresses[0], class: "other", why: "Identity lookup control." }] });
    expect(compareAddressReview(scan, path)).toEqual([]);
  }, TIMEOUT);

  it("E4b-R2 controls: designated payment routing tools require money classification", () => {
    for (const tool of ["near_quote", "near_intent"]) {
      const { root, files } = synthetic([{ name: tool, input_schema: { properties: { recipient: { type: "string" } } } }], "");
      const scan = scanToolReach(root, files);
      const entry: ReviewedTool = { ...scan.addresses[0], class: "other", why: "Synthetic payment routing control." };
      expect(compareAddressReview(scan, fixtureCopy({ schema: "pcc-llm-money-address-tools/1", entries: [entry] })).some(hit => hit.rule === "E4b-R2")).toBe(true);
      entry.class = "money";
      expect(compareAddressReview(scan, fixtureCopy({ schema: "pcc-llm-money-address-tools/1", entries: [entry] }))).toEqual([]);
    }
  }, TIMEOUT);

  it("E4b-R2 self-mutant: removing near_quote from a fixture copy fails the real-tree comparison", () => {
    const review = JSON.parse(readFileSync(FIXTURE, "utf8")) as Review;
    expect(review.entries.some(entry => entry.tool === "near_quote")).toBe(true);
    review.entries = review.entries.filter(entry => entry.tool !== "near_quote");
    const hits = compareAddressReview(realScan(), fixtureCopy(review));
    expect(hits.some(hit => hit.rule === "E4b-R2" && hit.detail?.includes("unreviewed address tool") && hit.expression.includes("near_quote")), formatFindings(hits)).toBe(true);
    console.info("self-mutant remove near_quote: rejected E4b-R2");
  }, TIMEOUT);

  it("E4b-R2 self-mutant: adding a fake tool to a fixture copy fails the real-tree comparison", () => {
    const review = JSON.parse(readFileSync(FIXTURE, "utf8")) as Review;
    review.entries.push({ source: "agent-package", tool: "planted_fake_tool", params: ["recipient"], class: "money", why: "Self-mutant control." });
    const hits = compareAddressReview(realScan(), fixtureCopy(review));
    expect(hits.some(hit => hit.rule === "E4b-R2" && hit.detail?.includes("stale or changed") && hit.expression.includes("planted_fake_tool")), formatFindings(hits)).toBe(true);
    console.info("self-mutant add fake tool: rejected E4b-R2");
  }, TIMEOUT);
});
