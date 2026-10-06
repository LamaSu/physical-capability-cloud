/**
 * Closed, type-aware guard for the four IR kit sources. Only the browser entry
 * should use the DOM allowlist. The other three also compile with tsconfig.json,
 * which inherits the target's default full lib, including DOM. The domFiles check
 * fails if any DOM symbol resolves outside the browser entry. The syntactic
 * text-sink lint separately limits textContent writes to the typed sinks,
 * including the renderer's wrapped nodes.
 *
 * One browser Program is built in beforeAll. Mutation Programs reuse its parsed
 * sources through oldProgram and an overriding compiler host; none touches disk.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { LIST_PROFILES } from "../mcp/dashboard-ir.js";
import { listFieldLabel, UNAVAILABLE } from "../mcp/dashboard-ir-renderer.js";

const gateway = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const src = join(gateway, "src");
const IR_FILES = ["dashboard-ir.ts", "dashboard-ir-renderer.ts", "dashboard-ir-browser-entry.ts", "dashboard-ir-binder.ts"] as const;
const irPaths = IR_FILES.map((file) => join(src, "mcp", file));
const permittedImporters = new Set([...irPaths, join(src, "mcp/dashboard-ir-text.type-test.ts")]);
const brands = ["__kitText", "__agentText"];
const protectedImports = new Set(["kitText", "KitText", "AgentText"]);

interface MintAllowance { file: typeof IR_FILES[number]; function: string; reason: string }
const MINTS: readonly MintAllowance[] = [
  { file: "dashboard-ir.ts", function: "kitText", reason: "PCC constants; calls outside approved mints must contain literal-only text." },
  { file: "dashboard-ir.ts", function: "joinKitText", reason: "Composition accepts only already branded KitText parts." },
  { file: "dashboard-ir.ts", function: "identifierText", reason: "boundValueText and identifier claim checks precede the reported attribution prefix." },
  { file: "dashboard-ir.ts", function: "recordValueText", reason: "Record status claims receive the fixed reported-by-record qualifier." },
  { file: "dashboard-ir.ts", function: "boundStatusText", reason: "Amount/notice checks, closed safe-status vocabulary, and reported qualifiers cover every branch." },
  { file: "dashboard-ir.ts", function: "boundValueText", reason: "Status treatment or money/withheld-notice content checks precede the cast." },
  { file: "dashboard-ir.ts", function: "reportedFieldText", reason: "boundValueText withholds claims; remaining free fields receive a reported attribution prefix." },
  { file: "dashboard-ir-binder.ts", function: "httpStatusText", reason: "Transport-owned numeric HTTP status, never response-body text, is formatted with PCC's fixed HTTP prefix." },
  { file: "dashboard-ir-renderer.ts", function: "stamp", reason: "The anchored ISO timestamp grammar extracts only date/time digits and separators." },
  { file: "dashboard-ir-renderer.ts", function: "readField", reason: "Schema-specific amount, currency, assurance-tier, boolean, count, identifier and text checks precede display." },
  { file: "dashboard-ir-renderer.ts", function: "readListField", reason: "Profile field kinds enforce round-tripping timestamps, versions and bounded counts; free values are attributed." },
  { file: "dashboard-ir-renderer.ts", function: "bindScalar", reason: "Allowlisted route/source kinds enforce status, numeric, timestamp and version grammars before display." },
  { file: "dashboard-ir-renderer.ts", function: "manifestProseText", reason: "validateIr checks prose provenance/content; AgentText is accepted only by the agent-authored untrusted sink." },
];

interface DomAllowance { name: string; reason: string }
const DOM: readonly DomAllowance[] = [
  { name: "window", reason: "Browser lifecycle, fixed-origin boot input and parent messaging." },
  { name: "document", reason: "Browser mount lookup, detached node creation and visibility lifecycle." },
  { name: "parent", reason: "window.parent is the fixed host peer for the MCP Apps lifecycle." },
  { name: "addEventListener", reason: "Window message, pagehide and pageshow lifecycle subscriptions." },
  { name: "Window.postMessage", reason: "Read-only MCP Apps initialization and teardown acknowledgments." },
  { name: "MessageEvent.source", reason: "Check that the event came from the fixed host parent." },
  { name: "MessageEvent.data", reason: "Read lifecycle payload as unknown before structural validation." },
  { name: "Document.addEventListener", reason: "Visibility changes stop or resume GET-only bindings." },
  { name: "Document.hidden", reason: "Read visibility state to stop or resume bindings." },
  { name: "Document.createElement", reason: "Create detached nodes through the renderer adapter and fixed browser scaffolding." },
  { name: "Document.getElementById", reason: "Lookup PCC's fixed root mount id." },
  { name: "Element.className", reason: "Apply PCC-owned presentation classes through the renderer adapter." },
  { name: "Element.setAttribute", reason: "Only data-tone, data-source and data-as-of writes; the syntactic lint checks the closed attribute list." },
  { name: "Element.removeAttribute", reason: "Remove provenance metadata when binding state changes." },
  { name: "Element.textContent", reason: "Reads are allowed anywhere; the syntactic lint permits writes only inside typed text sinks." },
  { name: "Node.textContent", reason: "Reads are allowed anywhere; the syntactic lint permits writes only inside typed text sinks." },
  { name: "Node.appendChild", reason: "The wrapped adapter appends wrapped Nodes, never strings." },
  { name: "ParentNode.replaceChildren", reason: "Four browser calls replace/clear with Nodes only; the syntactic lint checks their closed allowances." },
  { name: "Node.parentNode", reason: "Find the parent for a PCC-owned provenance metadata node." },
  { name: "Node.insertBefore", reason: "Insert a PCC-owned metadata Node next to its bound node." },
  { name: "Node.nextSibling", reason: "Locate the insertion point for the metadata Node." },
  { name: "ParentNode.querySelector", reason: "Locate the PCC-owned scalar value slot." },
  { name: "ParentNode.querySelectorAll", reason: "Locate PCC-owned stat/list/schema nodes and value slots." },
  { name: "Node.childNodes", reason: "Read staged Nodes for commits and structured read-only fingerprints." },
  { name: "Node.nodeType", reason: "Read-only fingerprint distinguishes text and element Nodes." },
  { name: "Element.attributes", reason: "Read-only fingerprint records existing element metadata." },
  { name: "Element.tagName", reason: "Read-only fingerprint records node shape." },
  { name: "Attr.name", reason: "Read-only fingerprint records existing attribute names." },
  { name: "Attr.value", reason: "Read-only fingerprint records existing attribute values." },
  { name: "AbortController", reason: "Bound request/generation lifetime and cancellation." },
  { name: "AbortController.abort", reason: "Cancel old generations and timed-out reads." },
  { name: "AbortController.signal", reason: "Pass generation/request cancellation into fetch and the concurrency gate." },
  { name: "AbortSignal.aborted", reason: "Reject cancelled queued or active GETs." },
  { name: "AbortSignal.addEventListener", reason: "Link cancellation to queued permits and requests." },
  { name: "AbortSignal.removeEventListener", reason: "Remove cancellation subscriptions when permits/requests settle." },
  { name: "DOMException", reason: "Fixed AbortError/TimeoutError cancellation reasons." },
  { name: "fetch", reason: "Fixed-origin GET-only JSON reads with omitted credentials and rejected redirects." },
  { name: "Response.redirected", reason: "Reject redirected responses before reading their bodies." },
  { name: "Response.status", reason: "Reject non-200 responses and format checked HTTP status reasons." },
  { name: "Response.headers", reason: "Check the exact JSON response content type." },
  { name: "Headers.get", reason: "Read the fixed content-type header." },
  { name: "Body.body", reason: "Read or cancel the GET response stream under the byte cap." },
  { name: "ReadableStream.cancel", reason: "Cancel non-clean responses without consuming content." },
  { name: "ReadableStream.getReader", reason: "Consume approved JSON bodies incrementally under the byte cap." },
  { name: "ReadableStreamDefaultReader.read", reason: "Read capped response byte chunks." },
  { name: "ReadableStreamGenericReader.cancel", reason: "Cancel an oversized response stream." },
  { name: "TextDecoder", reason: "Decode capped JSON response bytes; this is not a DOM text constructor." },
  { name: "TextDecoder.decode", reason: "Decode capped JSON response bytes before unknown-typed parsing." },
  { name: "setTimeout", reason: "Request deadlines, binder polling and source freshness expiry." },
  { name: "clearTimeout", reason: "Disarm settled request and freshness timers." },
];

interface Finding { rule: string; file: string; line: number; detail: string }
interface Audit { findings: Finding[]; minted: Set<string>; domUsed: Set<string>; domFiles: Set<string> }
let config: ts.ParsedCommandLine;
let program: ts.Program;
let baseAudit: Audit;
let mutationAudits: Map<string, Audit>;
let mutationLines: Map<string, { file: string; line: number; rule: string }>;

function readConfig(name: string): ts.ParsedCommandLine {
  const path = join(gateway, name);
  const read = ts.readConfigFile(path, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, gateway);
  if (parsed.errors.length) throw new Error(ts.formatDiagnostics(parsed.errors, diagnosticHost));
  return parsed;
}
const diagnosticHost: ts.FormatDiagnosticsHost = {
  getCanonicalFileName: (path) => path,
  getCurrentDirectory: () => gateway,
  getNewLine: () => "\n",
};
function domDeclaration(symbol: ts.Symbol | undefined): boolean {
  return !!symbol?.declarations?.some((d) => /[/\\]lib\.dom(?:\.iterable|\.asynciterable)?\.d\.ts$/.test(d.getSourceFile().fileName));
}
function libraryDeclaration(symbol: ts.Symbol | undefined): boolean {
  return !!symbol?.declarations?.some((d) => /[/\\]lib\.[^/\\]+\.d\.ts$/.test(d.getSourceFile().fileName));
}
function unalias(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}
function accessSymbol(checker: ts.TypeChecker, n: ts.Node): ts.Symbol | undefined {
  return unalias(checker, checker.getSymbolAtLocation(ts.isPropertyAccessExpression(n) ? n.name : n)
    ?? (ts.isElementAccessExpression(n) && (ts.isStringLiteral(n.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(n.argumentExpression)) ? checker.getSymbolAtLocation(n.argumentExpression) : undefined));
}
function inTypePosition(n: ts.Node): boolean {
  for (let p: ts.Node | undefined = n; p; p = p.parent) {
    if (ts.isExpressionWithTypeArguments(p) && ts.isHeritageClause(p.parent) && p.parent.token === ts.SyntaxKind.ExtendsKeyword
      && (ts.isClassDeclaration(p.parent.parent) || ts.isClassExpression(p.parent.parent))) continue;
    if (ts.isTypeNode(p)) return true;
  }
  return false;
}
function valueReference(n: ts.Node): boolean {
  if (inTypePosition(n)) return false;
  if (!ts.isIdentifier(n)) return ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n);
  const p = n.parent;
  if ((ts.isPropertyAccessExpression(p) && p.name === n) || ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)
    || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isBindingElement(p)) && p.name === n)) return false;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p)) return false;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p)) && p.name === n) return false;
  return true;
}
/** Inspect carried values as well as direct brands, so wrappers/callables cannot forge a mint. */
function carriedType(checker: ts.TypeChecker, type: ts.Type, matches: (t: ts.Type) => boolean, seen = new Set<ts.Type>()): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  if (matches(type)) return true;
  if (type.isUnionOrIntersection() && type.types.some((t) => carriedType(checker, t, matches, seen))) return true;
  if (type.aliasTypeArguments?.some((t) => carriedType(checker, t, matches, seen))) return true;
  if (!(type.flags & ts.TypeFlags.Object)) return false;
  const object = type as ts.ObjectType;
  if (object.objectFlags & ts.ObjectFlags.Reference) {
    if (checker.getTypeArguments(type as ts.TypeReference).some((t) => carriedType(checker, t, matches, seen))) return true;
  }
  // Library containers were checked through their type arguments. Avoid traversing
  // the DOM/String/Function library graphs; none can declare our source-owned brand.
  if (libraryDeclaration(type.getSymbol())) return false;
  if (checker.getIndexInfosOfType(type).some((i) => carriedType(checker, i.type, matches, seen))) return true;
  if ([...type.getCallSignatures(), ...type.getConstructSignatures()].some((sig) => carriedType(checker, checker.getReturnTypeOfSignature(sig), matches, seen))) return true;
  return type.getProperties().some((property) => {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    return !!declaration && carriedType(checker, checker.getTypeOfSymbolAtLocation(property, declaration), matches, seen);
  });
}
function branded(checker: ts.TypeChecker, type: ts.Type): boolean {
  return carriedType(checker, type, (t) => brands.some((name) => !!checker.getPropertyOfType(t, name)));
}
function unresolvedAssertion(checker: ts.TypeChecker, type: ts.Type): boolean {
  return carriedType(checker, type, (t) => !!(t.flags & (ts.TypeFlags.TypeParameter | ts.TypeFlags.IndexedAccess | ts.TypeFlags.Conditional)));
}
function literalOnly(n: ts.Expression): boolean {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return true;
  if (ts.isParenthesizedExpression(n)) return literalOnly(n.expression);
  return ts.isConditionalExpression(n) && literalOnly(n.whenTrue) && literalOnly(n.whenFalse);
}
function containingFunction(n: ts.Node): string {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p)) {
      if (p.name) return p.name.text;
      if (ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) return p.parent.name.text;
      return "<anonymous>";
    }
    if (ts.isArrowFunction(p)) return ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name) ? p.parent.name.text : "<anonymous>";
    if (ts.isMethodDeclaration(p)) return p.name && ts.isIdentifier(p.name) ? p.name.text : "<anonymous>";
    if (ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isConstructorDeclaration(p)) return "<anonymous>";
  }
  return "<top level>";
}
function runtimeExpression(n: ts.Node): boolean {
  if (!ts.isExpression(n) || inTypePosition(n)) return false;
  // Import/export module specifiers are syntax, not runtime expressions. Asking the
  // checker for their type yields Any even in a correctly resolved Program.
  if ((ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent)) && n.parent.moduleSpecifier === n) return false;
  return !ts.isIdentifier(n) || valueReference(n);
}
function isKitFactory(checker: ts.TypeChecker, n: ts.Expression, seen = new Set<ts.Symbol>()): boolean {
  if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || ts.isNonNullExpression(n)) return isKitFactory(checker, n.expression, seen);
  const declarationIsKitFactory = (d: ts.SignatureDeclaration | undefined): boolean => !!d && ts.isFunctionDeclaration(d) && d.name?.text === "kitText" && d.getSourceFile().fileName === irPaths[0];
  if (checker.getTypeAtLocation(n).getCallSignatures().some((sig) => declarationIsKitFactory(sig.declaration))) return true;
  const symbol = accessSymbol(checker, n);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  return !!symbol.declarations?.some((d) => ts.isVariableDeclaration(d) && d.initializer && isKitFactory(checker, d.initializer, seen));
}
function nonliteralKitCall(checker: ts.TypeChecker, n: ts.CallExpression): boolean {
  if (isKitFactory(checker, n.expression)) return n.arguments.length !== 1 || !literalOnly(n.arguments[0]!);
  if (ts.isPropertyAccessExpression(n.expression) || ts.isElementAccessExpression(n.expression)) {
    const key = keyOf(n.expression);
    if (isKitFactory(checker, n.expression.expression)) {
      if (key === "call") return n.arguments.length !== 2 || !literalOnly(n.arguments[1]!);
      if (key === "apply") {
        const args = n.arguments[1];
        return n.arguments.length !== 2 || !args || !ts.isArrayLiteralExpression(args) || args.elements.length !== 1 || !literalOnly(args.elements[0]!);
      }
      // Capturing a raw parameter in bind conveys the same mint authority as a call.
      if (key === "bind") return n.arguments.length > 1 && (n.arguments.length !== 2 || !literalOnly(n.arguments[1]!));
    }
  }
  return false;
}
function domReceiver(checker: ts.TypeChecker, type: ts.Type, seen = new Set<ts.Type>()): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  if (domDeclaration(type.getSymbol())) return true;
  if (type.isUnionOrIntersection()) return type.types.some((t) => domReceiver(checker, t, seen));
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type);
    if (constraint) return domReceiver(checker, constraint, seen);
  }
  if (type.flags & ts.TypeFlags.Object) {
    const object = type as ts.InterfaceType;
    if (object.objectFlags & (ts.ObjectFlags.Class | ts.ObjectFlags.Interface)) return checker.getBaseTypes(object).some((t) => domReceiver(checker, t, seen));
  }
  return false;
}
function keyOf(n: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  return ts.isStringLiteral(n.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(n.argumentExpression) ? n.argumentExpression.text : undefined;
}
function descriptorValue(checker: ts.TypeChecker, n: ts.Expression, seen = new Set<ts.Symbol>()): boolean {
  if (checker.getNonNullableType(checker.getTypeAtLocation(n)).getSymbol()?.name === "PropertyDescriptor") return true;
  if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n)) return descriptorValue(checker, n.expression, seen);
  const symbol = accessSymbol(checker, n);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  return !!symbol.declarations?.some((d) => ts.isVariableDeclaration(d) && d.initializer && descriptorValue(checker, d.initializer, seen));
}
function reflectionViolation(checker: ts.TypeChecker, n: ts.Node): string | undefined {
  const symbol = accessSymbol(checker, n);
  const name = symbol?.name;
  if (valueReference(n) && libraryDeclaration(symbol) && ["Proxy", "eval", "Function"].includes(name ?? "")) return `Forbidden reflection global ${name}`;
  if (valueReference(n) && libraryDeclaration(symbol) && name === "Object") {
    const p = n.parent;
    if (!((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === n)) return "Object must remain a named member receiver; aliases can conceal mutators";
  }
  if (valueReference(n) && libraryDeclaration(symbol) && name === "Reflect") {
    const p = n.parent;
    if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === n && keyOf(p) === "ownKeys") return;
    return "Reflect may expose only read-only ownKeys";
  }
  if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n))) {
    const key = keyOf(n);
    if (libraryDeclaration(symbol) && checker.getFullyQualifiedName(symbol!).startsWith("Reflect.") && key !== "ownKeys") return "Only read-only Reflect.ownKeys is permitted";
    if (descriptorValue(checker, n.expression) && (key === undefined || key === "get" || key === "set")) return "Descriptor accessor reads or computed members can conceal invocation";
    if (key === "__defineSetter__" || key === "__lookupSetter__") return `Forbidden setter reflection ${key}`;
    if (libraryDeclaration(symbol)) {
      const owner = symbol?.declarations?.find((d) => d.parent && "name" in d.parent)?.parent;
      const ownerName = owner && "name" in owner && owner.name && ts.isIdentifier(owner.name as ts.Node) ? (owner.name as ts.Identifier).text : "";
      if (ownerName === "ObjectConstructor" && ["assign", "defineProperty", "defineProperties", "setPrototypeOf"].includes(key ?? "")) return `Forbidden Object.${key} in any form`;
      // Forbid the accessor read itself, so extracting/binding it cannot hide a later invocation.
      // Read-only descriptor.enumerable checks in validateIr remain allowed.
      if (ownerName === "PropertyDescriptor" && (key === "get" || key === "set")) return `Forbidden property-descriptor accessor ${key}`;
    }
    if (ts.isElementAccessExpression(n) && key === undefined) {
      const receiver = checker.getNonNullableType(checker.getTypeAtLocation(n.expression)).getSymbol()?.name;
      if (["ObjectConstructor", "Reflect", "PropertyDescriptor"].includes(receiver ?? "")) return "Unresolved computed reflection member";
      const keyType = checker.getTypeAtLocation(n.argumentExpression);
      if (keyType.isStringLiteral() && ["__defineSetter__", "__lookupSetter__"].includes(keyType.value)) return "Forbidden computed setter reflection";
    }
  }
  if (ts.isBindingElement(n)) {
    const pattern = n.parent;
    if (ts.isObjectBindingPattern(pattern) && ts.isVariableDeclaration(pattern.parent) && pattern.parent.initializer) {
      const receiver = checker.getNonNullableType(checker.getTypeAtLocation(pattern.parent.initializer));
      const key = n.propertyName ?? n.name;
      if (ts.isComputedPropertyName(key)) {
        if (descriptorValue(checker, pattern.parent.initializer)) return "Forbidden computed descriptor destructuring";
        const keyType = checker.getTypeAtLocation(key.expression);
        if (["ObjectConstructor", "Reflect", "PropertyDescriptor"].includes(receiver.getSymbol()?.name ?? "")) return "Forbidden computed reflection destructuring";
        if (keyType.isStringLiteral() && ["__defineSetter__", "__lookupSetter__"].includes(keyType.value)) return "Forbidden computed setter destructuring";
      }
      if (ts.isIdentifier(key) || ts.isStringLiteral(key)) {
        const member = checker.getPropertyOfType(checker.getTypeAtLocation(pattern.parent.initializer), key.text);
        if (libraryDeclaration(member) && ["Reflect", "Proxy", "eval", "Function", "Object"].includes(key.text)) return `Forbidden destructured reflection global ${key.text}`;
        if (descriptorValue(checker, pattern.parent.initializer) && ["get", "set"].includes(key.text)) return "Forbidden destructured descriptor accessor";
        if (libraryDeclaration(member) && ["assign", "defineProperty", "defineProperties", "setPrototypeOf"].includes(key.text)) return `Forbidden destructured Object.${key.text}`;
        if (key.text === "__defineSetter__" || key.text === "__lookupSetter__") return `Forbidden destructured setter ${key.text}`;
        if (libraryDeclaration(member) && ["get", "set"].includes(key.text) && checker.getTypeAtLocation(pattern.parent.initializer).getSymbol()?.name === "PropertyDescriptor") return "Forbidden destructured descriptor accessor";
      }
    }
  }
}
function mintKey(file: string, fn: string): string { return `${file}:${fn}`; }
function audit(p: ts.Program, mints = MINTS, dom = DOM): Audit {
  const checker = p.getTypeChecker();
  const result: Audit = { findings: [], minted: new Set(), domUsed: new Set(), domFiles: new Set() };
  const add = (rule: string, n: ts.Node, detail: string): void => {
    const s = n.getSourceFile();
    result.findings.push({ rule, file: relative(src, s.fileName), line: s.getLineAndCharacterOfPosition(n.getStart(s)).line + 1, detail });
  };
  for (const path of irPaths) {
    const s = p.getSourceFile(path);
    if (!s) throw new Error(`Program omitted ${path}`);
    for (const d of [...p.getSyntacticDiagnostics(s), ...p.getSemanticDiagnostics(s)]) {
      result.findings.push({ rule: "diagnostic", file: relative(src, path), line: s.getLineAndCharacterOfPosition(d.start ?? 0).line + 1, detail: `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}` });
    }
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, s.text);
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      if ((token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) && /@ts-(?:ignore|expect-error|nocheck)\b/.test(scanner.getTokenText())) {
        result.findings.push({ rule: "directive", file: relative(src, path), line: s.getLineAndCharacterOfPosition(scanner.getTokenPos()).line + 1, detail: "Type-check suppression is forbidden in IR sources" });
      }
    }
    const walk = (n: ts.Node): void => {
      if (runtimeExpression(n) && checker.getTypeAtLocation(n).flags & ts.TypeFlags.Any) add("any", n, `Any-typed expression: ${n.getText(s)}`);
      if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) {
        const target = checker.getTypeAtLocation(n.type);
        if (target.flags & (ts.TypeFlags.Any | ts.TypeFlags.Never)) add("assertion", n, "Assertions to any or never are forbidden");
        if (unresolvedAssertion(checker, target)) add("assertion", n, "Generic/unevaluated assertion targets can instantiate a text brand and are forbidden");
        if (branded(checker, target)) mint(n, undefined, target);
      }
      if (ts.isCallExpression(n) && nonliteralKitCall(checker, n)) mint(n);
      if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) {
        const signature = checker.getSignatureFromDeclaration(n);
        if (signature) {
          const predicate = checker.getTypePredicateOfSignature(signature)?.type;
          if (n.type && ts.isTypePredicateNode(n.type) && predicate && (branded(checker, predicate) || unresolvedAssertion(checker, predicate))) mint(n, "Type predicates must not manufacture text brands", predicate);
          if (!n.body && branded(checker, checker.getReturnTypeOfSignature(signature))) mint(n, "Overload/ambient signatures must not manufacture text brands", checker.getReturnTypeOfSignature(signature));
        }
      }
      if (ts.isVariableDeclaration(n) && !n.initializer && n.type && branded(checker, checker.getTypeAtLocation(n.type))) {
        const statement = n.parent.parent;
        if (ts.isVariableStatement(statement) && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) mint(n, "Ambient values must not manufacture text brands", checker.getTypeAtLocation(n.type));
      }
      const reflection = reflectionViolation(checker, n);
      if (reflection) add("reflection", n, reflection);
      if (valueReference(n)) {
        const symbol = accessSymbol(checker, n);
        if (domDeclaration(symbol)) {
          const name = checker.getFullyQualifiedName(symbol!);
          result.domUsed.add(name); result.domFiles.add(relative(src, s.fileName));
          if (!dom.some((entry) => entry.name === name)) add("dom", n, `DOM value outside closed surface: ${name}`);
        } else if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && !symbol && domReceiver(checker, checker.getTypeAtLocation(n.expression))) {
          add("dom", n, `Unresolved member on a DOM receiver: ${n.getText(s)}`);
        }
      }
      ts.forEachChild(n, walk);
    };
    const mint = (n: ts.Node, context = "Text mint outside closed function list", target?: ts.Type): void => {
      const file = IR_FILES[irPaths.indexOf(path)]!;
      const fn = (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name && ts.isIdentifier(n.name) ? n.name.text : containingFunction(n);
      const key = mintKey(file, fn);
      result.minted.add(key);
      const agentMint = !!target && carriedType(checker, target, (t) => !!checker.getPropertyOfType(t, "__agentText"));
      const kitMint = !target || carriedType(checker, target, (t) => !!checker.getPropertyOfType(t, "__kitText"));
      const agentFunction = file === "dashboard-ir-renderer.ts" && fn === "manifestProseText";
      if (agentMint && !agentFunction) add("mint", n, "AgentText may be minted only by manifestProseText");
      if (kitMint && agentFunction) add("mint", n, "manifestProseText must preserve AgentText authorship and cannot mint KitText");
      if (!mints.some((entry) => mintKey(entry.file, entry.function) === key)) add("mint", n, `${context}: ${key}`);
    };
    walk(s);
  }
  for (const entry of mints) if (!result.minted.has(mintKey(entry.file, entry.function))) result.findings.push({ rule: "stale-mint", file: entry.file, line: 0, detail: `Stale mint allowance: ${entry.function}` });
  for (const entry of dom) if (!result.domUsed.has(entry.name)) result.findings.push({ rule: "stale-dom", file: "<allowlist>", line: 0, detail: `Stale DOM allowance: ${entry.name}` });
  return result;
}
function importedText(s: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  const add = (n: ts.Node, detail: string): void => { findings.push({ rule: "import", file: relative(src, s.fileName), line: s.getLineAndCharacterOfPosition(n.getStart(s)).line + 1, detail }); };
  if (permittedImporters.has(s.fileName)) return findings;
  const walk = (n: ts.Node): void => {
    if (ts.isImportSpecifier(n) || ts.isExportSpecifier(n)) {
      if (protectedImports.has((n.propertyName ?? n.name).text)) add(n, "Text brands and kitText are confined to the IR sources and type test");
    }
    const irModule = (text: string): boolean => /(?:^|\/)dashboard-ir(?:\.js)?$/.test(text);
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && irModule(n.moduleSpecifier.text)) {
      const binding = n.importClause?.namedBindings;
      if (n.importClause?.name || (binding && ts.isNamespaceImport(binding))) add(n, "Namespace/default IR imports could expose the text brands");
    }
    if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && irModule(n.moduleSpecifier.text)
      && (!n.exportClause || ts.isNamespaceExport(n.exportClause))) add(n, "Wildcard IR exports could expose the text brands");
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && n.moduleReference.expression
      && ts.isStringLiteral(n.moduleReference.expression) && irModule(n.moduleReference.expression.text)) add(n, "Import-equals IR aliases could expose the text brands");
    if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))
      && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && irModule(n.arguments[0].text)) {
      // A direct named destructure has the same closed import surface as a static
      // named import. Whole-module values and rest/nested patterns expose brands.
      const value = ts.isAwaitExpression(n.parent) ? n.parent : n;
      const parent = value.parent;
      const namedOnly = ts.isVariableDeclaration(parent) && parent.initializer === value && ts.isObjectBindingPattern(parent.name)
        && parent.name.elements.every((e) => !e.dotDotDotToken && ts.isIdentifier(e.name)
          && (ts.isIdentifier(e.propertyName ?? e.name) || ts.isStringLiteral(e.propertyName ?? e.name))
          && !protectedImports.has((e.propertyName ?? e.name).getText(s).replace(/^['"]|['"]$/g, "")));
      if (!namedOnly) add(n, "Dynamic/require IR imports could expose the text brands");
    }
    if (ts.isImportTypeNode(n) && n.qualifier && protectedImports.has(n.qualifier.getText(s))) add(n, "Import types cannot expose text brands outside the closed files");
    ts.forEachChild(n, walk);
  };
  walk(s);
  return findings;
}
function allTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? allTsFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);
}
function overriddenProgram(overrides: Map<string, string>): ts.Program {
  const host = ts.createCompilerHost(config.options);
  const sources = new Map<string, ts.SourceFile>();
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => {
    const replacement = overrides.get(path);
    if (replacement !== undefined) {
      if (!sources.has(path)) sources.set(path, ts.createSourceFile(path, replacement, languageVersion, true));
      return sources.get(path);
    }
    return program.getSourceFile(path) ?? original(path, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.readFile = (path) => overrides.get(path) ?? ts.sys.readFile(path);
  return ts.createProgram({ rootNames: config.fileNames, options: config.options, host, oldProgram: program });
}

const MUTATIONS = [
  { name: "AgentText mint in kitText", file: "dashboard-ir.ts", rule: "mint", needle: 'return s as KitText;', code: 'const prose = s as AgentText; void prose; return s as KitText;' },
  { name: "KitText mint in manifestProseText", file: "dashboard-ir-renderer.ts", rule: "mint", needle: 'return String(n.props?.[key] ?? "") as AgentText;', code: 'const own = String(n.props?.[key] ?? "") as KitText; void own; return String(n.props?.[key] ?? "") as AgentText;' },
  { name: "raw KitText assertion", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'function rawMint(raw: string) { return raw as KitText; }' },
  { name: "brand alias and intersection", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'type TextAlias = KitText; function aliasMint(raw: string) { return raw as TextAlias & { extra?: true }; }' },
  { name: "object-carried brand assertion", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'function objectMint(n: RElement, raw: string) { setText(n, ({ text: raw } as { text: KitText }).text); }' },
  { name: "array-carried brand assertion", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'function arrayMint(n: RElement, raw: string) { setText(n, ([raw] as KitText[])[0]!); }' },
  { name: "index-carried brand assertion", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'function indexMint(n: RElement, raw: string) { setText(n, ({ text: raw } as Record<string, KitText>)["text"]!); }' },
  { name: "callable-carried brand assertion", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'function callableMint(n: RElement, raw: string) { setText(n, ((() => raw) as () => KitText)()); }' },
  { name: "overloaded branded signature", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'function overloadMint(raw: string): KitText; function overloadMint(raw: string): string { return raw; }' },
  { name: "branded type predicate", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'function predicateMint(raw: string): raw is KitText { return true; }' },
  { name: "ambient branded value", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'declare const ambientText: KitText;' },
  { name: "angle bracket brand assertion", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'function angleMint(raw: string) { return <KitText>raw; }' },
  { name: "nonliteral kitText call", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'function callMint(raw: string) { return kitText(raw); }' },
  { name: "aliased kitText call", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'const mintAlias = kitText; function aliasCallMint(raw: string) { return mintAlias(raw); }' },
  { name: "annotated kitText alias", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'const annotatedMint: (s: string) => KitText = kitText; function annotatedCallMint(raw: string) { return annotatedMint(raw); }' },
  { name: "kitText via call", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'function viaCallMint(raw: string) { return kitText.call(undefined, raw); }' },
  { name: "kitText via apply", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'function viaApplyMint(raw: string) { return kitText.apply(undefined, [raw]); }' },
  { name: "kitText via bind", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'function viaBindMint(raw: string) { return kitText.bind(undefined)(raw); }' },
  { name: "kitText capturing raw in bind", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'function viaBoundMint(raw: string) { return kitText.bind(undefined, raw)(); }' },
  { name: "JSON.parse any into el", file: "dashboard-ir-renderer.ts", rule: "any", code: 'function anySink(doc: RDocument, raw: string) { el(doc, "pcc-value", JSON.parse(raw)); }' },
  { name: "Array.isArray any element", file: "dashboard-ir-renderer.ts", rule: "any", code: 'function arrayAny(doc: RDocument, raw: unknown) { if (Array.isArray(raw)) el(doc, "pcc-value", raw[0]); }' },
  { name: "explicit any assertion", file: "dashboard-ir-renderer.ts", rule: "assertion", code: 'function castAny(doc: RDocument, raw: string) { el(doc, "pcc-value", raw as any); }' },
  { name: "never assertion into setText", file: "dashboard-ir-renderer.ts", rule: "assertion", code: 'function neverSink(n: RElement, raw: string) { setText(n, raw as never); }' },
  { name: "generic assertion instantiated with KitText", file: "dashboard-ir-renderer.ts", rule: "assertion", code: 'function genericMint<T>(raw: unknown): T { return raw as T; } function genericSink(n: RElement, raw: string) { setText(n, genericMint<KitText>(raw)); }' },
  { name: "indexed assertion instantiated with KitText", file: "dashboard-ir-renderer.ts", rule: "assertion", code: 'function indexedMint<T, K extends keyof T>(raw: unknown): T[K] { return raw as T[K]; } function indexedSink(n: RElement, raw: string) { setText(n, indexedMint<{ text: KitText }, "text">(raw)); }' },
  { name: "ts-ignore comment", file: "dashboard-ir-renderer.ts", rule: "directive", code: '// @ts-ignore\nfunction ignoredLine() {}' },
  { name: "Reflect.set on wrapped renderer node", file: "dashboard-ir-renderer.ts", rule: "reflection", code: 'function reflectSink(el: RElement, raw: string) { Reflect.set(el, "textContent", raw); }' },
  { name: "destructured Reflect global", file: "dashboard-ir-renderer.ts", rule: "reflection", code: 'function destructuredReflect(el: RElement, raw: string) { const { Reflect: R } = globalThis; R.set(el, "textContent", raw); }' },
  { name: "Object constructor type erasure", file: "dashboard-ir-renderer.ts", rule: "reflection", code: 'function erasedObject(el: RElement, raw: string) { const O = Object as unknown as { assign: (dst: object, src: object) => object }; O.assign(el, { textContent: raw }); }' },
  { name: "Object.assign alias", file: "dashboard-ir-renderer.ts", rule: "reflection", code: 'function assignSink(el: RElement, raw: string) { const assign = Object.assign; assign(el, { textContent: raw }); }' },
  { name: "Object.assign destructuring", file: "dashboard-ir-renderer.ts", rule: "reflection", code: 'function destructuredAssign(el: RElement, raw: string) { const { assign } = Object; assign(el, { textContent: raw }); }' },
  { name: "Object.defineProperty alias", file: "dashboard-ir-renderer.ts", rule: "reflection", code: 'function defineSink(el: RElement, raw: string) { const define = Object.defineProperty; define(el, "textContent", { value: raw }); }' },
  { name: "Object.defineProperties", file: "dashboard-ir-renderer.ts", rule: "reflection", code: 'function definesSink(el: RElement, raw: string) { Object.defineProperties(el, { textContent: { value: raw } }); }' },
  { name: "Object.setPrototypeOf", file: "dashboard-ir-renderer.ts", rule: "reflection", code: 'function prototypeSink(el: RElement) { Object.setPrototypeOf(el, {}); }' },
  { name: "descriptor setter via call", file: "dashboard-ir-renderer.ts", rule: "reflection", code: 'function descriptorSink(el: RElement, raw: string) { const d = Object.getOwnPropertyDescriptor(el, "textContent"); d?.set?.call(el, raw); }' },
  { name: "descriptor getter alias", file: "dashboard-ir-renderer.ts", rule: "reflection", code: 'function getterSink(el: RElement) { const d = Object.getOwnPropertyDescriptor(el, "textContent"); const get = d?.get; get?.apply(el); }' },
  { name: "descriptor setter type erasure", file: "dashboard-ir-renderer.ts", rule: "reflection", code: 'function erasedDescriptor(el: RElement, raw: string) { const d = Object.getOwnPropertyDescriptor(el, "textContent") as { set: (v: string) => void }; d.set.call(el, raw); }' },
  { name: "descriptor computed setter", file: "dashboard-ir-renderer.ts", rule: "reflection", code: 'function computedDescriptorSink(el: RElement, raw: string) { const d = Object.getOwnPropertyDescriptor(el, "textContent")!; const key: "set" = "set"; d[key]?.call(el, raw); }' },
  { name: "descriptor computed destructuring", file: "dashboard-ir-renderer.ts", rule: "reflection", code: 'function destructuredDescriptorSink(el: RElement, raw: string) { const d = Object.getOwnPropertyDescriptor(el, "textContent")!; const key: "set" = "set"; const { [key]: setter } = d; setter?.call(el, raw); }' },
  { name: "descriptor setter destructuring", file: "dashboard-ir-renderer.ts", rule: "reflection", code: 'function namedDescriptorSink(el: RElement, raw: string) { const d = Object.getOwnPropertyDescriptor(el, "textContent")!; const { set } = d; set?.call(el, raw); }' },
  { name: "Proxy", file: "dashboard-ir-renderer.ts", rule: "reflection", code: 'function proxySink(el: RElement) { return new Proxy(el, {}); }' },
  { name: "eval", file: "dashboard-ir-renderer.ts", rule: "reflection", code: 'function evalSink(raw: string) { eval(raw); }' },
  { name: "Function constructor", file: "dashboard-ir-renderer.ts", rule: "reflection", code: 'function functionSink(raw: string) { return new Function(raw); }' },
  { name: "legacy setter", file: "dashboard-ir-renderer.ts", rule: "reflection", code: 'function legacySink(el: RElement, raw: string) { el.__defineSetter__("textContent", () => raw); }' },
  { name: "legacy setter lookup", file: "dashboard-ir-renderer.ts", rule: "reflection", code: 'function lookupSink(el: RElement) { el.__lookupSetter__("textContent"); }' },
  { name: "innerHTML DOM write", file: "dashboard-ir-browser-entry.ts", rule: "dom", code: 'function htmlSink(n: HTMLElement, raw: string) { n.innerHTML = raw; }' },
  { name: "DOM value in class extends", file: "dashboard-ir-browser-entry.ts", rule: "dom", code: 'class TextSink extends Text { constructor(raw: string) { super(raw); } }' },
  { name: "alert DOM dialog", file: "dashboard-ir-browser-entry.ts", rule: "dom", code: 'function alertSink(raw: string) { alert(raw); }' },
  { name: "unresolved dynamic DOM member", file: "dashboard-ir-browser-entry.ts", rule: "dom", code: 'function computedSink(n: HTMLElement, k: string, raw: string) { n[k] = raw; }' },
  { name: "broken Program diagnostic", file: "dashboard-ir-browser-entry.ts", rule: "diagnostic", code: 'import { brokenType } from "./nonexistent-ir-module.js";' },
] as const;

beforeAll(() => {
  config = readConfig("tsconfig.browser.json");
  program = ts.createProgram(config.fileNames, config.options);
  baseAudit = audit(program);
  mutationLines = new Map();
  mutationAudits = new Map();
  for (const mutation of MUTATIONS) {
    const path = join(src, "mcp", mutation.file);
    const text = readFileSync(path, "utf8");
    const index = "needle" in mutation ? text.indexOf(mutation.needle) : -1;
    if ("needle" in mutation && index < 0) throw new Error(`Mutation target missing: ${mutation.name}`);
    const line = index < 0 ? text.split("\n").length + 1 : text.slice(0, index).split("\n").length;
    const changed = "needle" in mutation ? text.replace(mutation.needle, mutation.code) : `${text}\n${mutation.code}\n`;
    mutationLines.set(mutation.name, { file: `mcp/${mutation.file}`, line, rule: mutation.rule });
    mutationAudits.set(mutation.name, audit(overriddenProgram(new Map([[path, changed]]))));
  }
}, 45_000);

describe("IR kit closed text brand and DOM surface", () => {
  it("type-checks every guarded source without semantic or syntactic diagnostics", () => {
    expect(baseAudit.findings.filter((f) => f.rule === "diagnostic")).toEqual([]);
  });
  it("has no any expressions, any/never assertions or type-check suppressions", () => {
    expect(baseAudit.findings.filter((f) => ["any", "assertion", "directive"].includes(f.rule))).toEqual([]);
  });
  it("mints only in the justified closed function list, without stale entries", () => {
    expect(baseAudit.findings.filter((f) => ["mint", "stale-mint"].includes(f.rule))).toEqual([]);
    expect(MINTS.every((entry) => entry.reason.length > 0)).toBe(true);
  });
  it("confines text imports to the four IR sources and their type test", () => {
    expect(allTsFiles(src).flatMap((path) => importedText(ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true)))).toEqual([]);
  });
  it("allows only reviewed DOM members, without stale entries, and only in the browser entry", () => {
    expect(baseAudit.findings.filter((f) => ["dom", "stale-dom"].includes(f.rule))).toEqual([]);
    expect([...baseAudit.domFiles]).toEqual(["mcp/dashboard-ir-browser-entry.ts"]);
    expect(DOM.every((entry) => entry.reason.length > 0)).toBe(true);
  });
  it("rejects write/call reflection while retaining read-only ownKeys and descriptor.enumerable", () => {
    expect(baseAudit.findings.filter((f) => f.rule === "reflection")).toEqual([]);
  });
  it("covers every list profile field with a PCC-owned label", () => {
    const fields = new Set(Object.values(LIST_PROFILES).flatMap((profile) => [...profile.title, ...profile.meta, ...profile.status]));
    expect(fields.size).toBeGreaterThan(0);
    for (const field of fields) expect(listFieldLabel(field), `Missing PCC label for profiled field ${field}`).not.toBe(UNAVAILABLE);
    expect(listFieldLabel("unprofiled-field")).toBe(UNAVAILABLE);
  });
  it.each(MUTATIONS)("reports injected $name on its own source line", ({ name }) => {
    const expected = mutationLines.get(name)!;
    expect(mutationAudits.get(name)!.findings.filter((f) => f.file === expected.file && f.line === expected.line && f.rule === expected.rule), name).not.toEqual([]);
  });
  it("reports stale mint and DOM allowances", () => {
    const stale = audit(program, [...MINTS, { file: "dashboard-ir.ts", function: "removedMint", reason: "Mutation proves stale mint allowances fail." }], [...DOM, { name: "Element.innerHTML", reason: "Mutation proves stale DOM allowances fail." }]);
    expect(stale.findings.filter((f) => f.rule === "stale-mint")).toEqual([expect.objectContaining({ detail: "Stale mint allowance: removedMint" })]);
    expect(stale.findings.filter((f) => f.rule === "stale-dom")).toEqual([expect.objectContaining({ detail: "Stale DOM allowance: Element.innerHTML" })]);
  });
  it("reports forbidden aliased, namespace and type imports outside the closed files", () => {
    const path = join(src, "unapproved-text-import.ts");
    for (const text of [
      'import { KitText as HiddenBrand } from "./mcp/dashboard-ir.js";',
      'import { kitText as hiddenMint } from "./mcp/dashboard-ir.js";',
      'import type { AgentText } from "./mcp/dashboard-ir.js";',
      'import * as ir from "./mcp/dashboard-ir.js";',
      'type Hidden = import("./mcp/dashboard-ir.js").KitText;',
      'export * from "./mcp/dashboard-ir.js";',
      'export * as ir from "./mcp/dashboard-ir.js";',
      'import ir = require("./mcp/dashboard-ir.js");',
      'const ir = await import("./mcp/dashboard-ir.js");',
      'const ir = require("./mcp/dashboard-ir.js");',
      'const { kitText: mint } = await import("./mcp/dashboard-ir.js");',
      'const { KitText: hidden } = require("./mcp/dashboard-ir.js");',
    ]) expect(importedText(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true))).toEqual([expect.objectContaining({ rule: "import", line: 1 })]);
  });
  it("permits immediate dynamic named imports of unprotected IR exports", () => {
    const path = join(src, "unapproved-text-import.ts");
    for (const text of [
      'const { listRowsOf, LIST_PROFILES } = await import("./mcp/dashboard-ir.js");',
      'const { validateIr: validate } = require("./mcp/dashboard-ir.js");',
    ]) expect(importedText(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true))).toEqual([]);
  });
  it("does not let an anonymous callback inherit a listed outer mint function", () => {
    const s = ts.createSourceFile("nested.ts", 'function stamp() { return (() => raw as KitText)(); }', ts.ScriptTarget.Latest, true);
    let assertion: ts.AsExpression | undefined;
    const find = (n: ts.Node): void => { if (ts.isAsExpression(n)) assertion = n; ts.forEachChild(n, find); };
    find(s);
    expect(containingFunction(assertion!)).toBe("<anonymous>");
  });
  it("recognizes literal-only conditional and parenthesized kitText compositions", () => {
    const s = ts.createSourceFile("literal.ts", 'kitText(flag ? ("Yes") : (`No`)); kitText(raw);', ts.ScriptTarget.Latest, true);
    const first = (s.statements[0] as ts.ExpressionStatement).expression as ts.CallExpression;
    const second = (s.statements[1] as ts.ExpressionStatement).expression as ts.CallExpression;
    expect(literalOnly(first.arguments[0]!)).toBe(true);
    expect(literalOnly(second.arguments[0]!)).toBe(false);
  });
});
