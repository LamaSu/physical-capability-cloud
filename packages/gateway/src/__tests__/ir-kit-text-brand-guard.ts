/**
 * The runtime private identity-store brand is the security boundary. This type-aware guard
 * is a development aid and defense in depth for the four IR kit sources.
 * Only the browser entry
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
import { lintTextSinks } from "../../../spec/src/__tests__/ui-kit-text-sinks-lint.js";

export const gateway = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const src = join(gateway, "src");
export const IR_FILES = ["dashboard-ir.ts", "dashboard-ir-renderer.ts", "dashboard-ir-browser-entry.ts", "dashboard-ir-binder.ts"] as const;
export const TEXT_SINKS: Record<typeof IR_FILES[number], readonly string[]> = {
  "dashboard-ir.ts": [],
  "dashboard-ir-renderer.ts": ["el", "setText", "agentEl"],
  "dashboard-ir-browser-entry.ts": ["setText", "setAuthoredText"],
  "dashboard-ir-binder.ts": [],
};
export const irPaths = IR_FILES.map((file) => join(src, "mcp", file));
export const permittedImporters = new Set([...irPaths, join(src, "mcp/dashboard-ir-text.type-test.ts"),
  join(src, "mcp/dashboard-ir-runtime-brand.test.ts"), join(src, "mcp/dashboard-ir-runtime-ambient.type-test.ts"), join(src, "mcp/dashboard-ir-physical-text.type-test.ts"), join(src, "mcp/dashboard-ir-provenance.test.ts")]);
export const brands = ["__kitText", "__agentText"];
export const REGISTRARS = ["registerKitText", "registerAgentText"] as const;
export const protectedImports = new Set(["kitText", "KitText", "AgentText", ...REGISTRARS]);
export const REGISTRAR_IMPORTERS = new Map<string, readonly string[]>([
  [join(src, "mcp/dashboard-ir-renderer.ts"), REGISTRARS],
  [join(src, "mcp/dashboard-ir-binder.ts"), ["registerKitText"]],
]);
export const RUNTIME_BRAND_INTERNALS = ["registerKitText", "registerAgentText", "readText"] as const;
export const CAPTURES = new Map([
  ["TEXT_STORE_GET", "WeakMap.prototype.get"], ["TEXT_STORE_SET", "WeakMap.prototype.set"],
  ["TEXT_FREEZE", "Object.freeze"], ["TEXT_APPLY", "Reflect.apply"],
]);
export const BRAND_STORES = new Set(["TEXT_BRANDS", "AGENT_TEXT_BRANDS"]);
export const CAPTURE_DECLARATIONS = new Map([
  ["TEXT_STORE_GET", "TEXT_STORE_GET: (this: WeakMap<object, string>, key: object) => string | undefined = WeakMap.prototype.get"],
  ["TEXT_STORE_SET", "TEXT_STORE_SET: (this: WeakMap<object, string>, key: object, value: string) => WeakMap<object, string> = WeakMap.prototype.set"],
  ["TEXT_FREEZE", "TEXT_FREEZE = Object.freeze"],
  ["TEXT_APPLY", "TEXT_APPLY: <T, A extends unknown[], R>(target: (this: T, ...args: A) => R, receiver: T, args: A) => R = Reflect.apply"],
]);
// Exact owner declarations close leaks from inside the already-confined brand internals.
export const BRAND_OWNER_DECLARATIONS = new Map<string, readonly string[]>([
  ["registerKitText", ["export function registerKitText(t: string): KitText {\n  if (typeof t !== \"string\") { textViolation(); t = \"\u2014\"; }\n  const identity = { get t(): string { return TEXT_APPLY(TEXT_STORE_GET, TEXT_BRANDS, [identity]) ?? \"\u2014\"; } };\n  const text = TEXT_FREEZE(identity) as KitText;\n  TEXT_APPLY(TEXT_STORE_SET, TEXT_BRANDS, [identity, t]);\n  return text;\n}"]],
  ["registerAgentText", ["export function registerAgentText(t: string): AgentText {\n  if (typeof t !== \"string\") { textViolation(); t = \"\u2014\"; }\n  const identity = { get t(): string { return TEXT_APPLY(TEXT_STORE_GET, AGENT_TEXT_BRANDS, [identity]) ?? \"\u2014\"; } };\n  const text = TEXT_FREEZE(identity) as AgentText;\n  TEXT_APPLY(TEXT_STORE_SET, AGENT_TEXT_BRANDS, [identity, t]);\n  return text;\n}"]],
  ["isKitText", ["export function isKitText(value: unknown): boolean {\n  return value !== null && typeof value === \"object\" && typeof TEXT_APPLY(TEXT_STORE_GET, TEXT_BRANDS, [value]) === \"string\";\n}"]],
  ["readText", ["export function readText(value: unknown, tier?: \"kit\"): KitText;", "export function readText(value: unknown, tier: \"agent\" | \"authored\"): KitText | AgentText;", "export function readText(value: unknown, tier: \"kit\" | \"agent\" | \"authored\" = \"kit\"): KitText | AgentText {\n  if (value !== null && typeof value === \"object\" &&\n      ((tier !== \"agent\" && typeof TEXT_APPLY(TEXT_STORE_GET, TEXT_BRANDS, [value]) === \"string\") ||\n       (tier !== \"kit\" && typeof TEXT_APPLY(TEXT_STORE_GET, AGENT_TEXT_BRANDS, [value]) === \"string\"))) {\n    return value as KitText | AgentText;\n  }\n  textViolation();\n  return INVALID_TEXT;\n}"]],
  ["textViolation", ["function textViolation(): void {\n  textDiagnostics.__PCC_UI_TEXT_VIOLATIONS__ = (textDiagnostics.__PCC_UI_TEXT_VIOLATIONS__ ?? 0) + 1;\n}"]],
]);
// Only these exact top-level declarations can assert the opaque representation:
// constructors freeze/register it; readText authenticates identity before returning it.

export interface MintAllowance { file: typeof IR_FILES[number]; function: string; reason: string }
export const MINTS: readonly MintAllowance[] = [
  { file: "dashboard-ir.ts", function: "kitText", reason: "PCC constants; calls outside approved mints must contain literal-only text." },
  { file: "dashboard-ir.ts", function: "joinKitText", reason: "Composition accepts only already branded KitText parts." },
  { file: "dashboard-ir.ts", function: "identifierText", reason: "boundValueText and identifier claim checks precede the reported attribution prefix." },
  { file: "dashboard-ir.ts", function: "boundStatusText", reason: "Amount/notice checks, closed safe-status vocabulary, and reported qualifiers cover every branch." },
  { file: "dashboard-ir.ts", function: "boundValueText", reason: "Status treatment or claim checks plus reported attribution precede the cast." },
  { file: "dashboard-ir.ts", function: "reportedFieldText", reason: "boundValueText withholds claims; remaining free fields receive a reported attribution prefix." },
  { file: "dashboard-ir-binder.ts", function: "httpStatusText", reason: "Transport-owned numeric HTTP status, never response-body text, is formatted with PCC's fixed HTTP prefix." },
  { file: "dashboard-ir-renderer.ts", function: "stamp", reason: "The anchored ISO timestamp grammar extracts only date/time digits and separators." },
  { file: "dashboard-ir-renderer.ts", function: "readField", reason: "Schema-specific amount, currency, assurance-tier, boolean, count, identifier and text checks precede display." },
  { file: "dashboard-ir-renderer.ts", function: "readListField", reason: "Profile field kinds enforce round-tripping timestamps, versions and bounded counts; free values are attributed." },
  { file: "dashboard-ir-renderer.ts", function: "filterTerm", reason: "N110 window note: the key passed validateIr's bind policy (selector grammar plus the route's PCC-owned query allowlist); the value shows only inside WINDOW_FILTER_VALUE_RE, as a safe integer or a boolean, else '(value not shown)'." },
  { file: "dashboard-ir-renderer.ts", function: "countText", reason: "N110 window note: only a non-negative safe integer's decimal digits; anything else is UNAVAILABLE." },
  { file: "dashboard-ir-renderer.ts", function: "bindScalar", reason: "Allowlisted route/source kinds enforce status, numeric, timestamp and version grammars before display." },
  { file: "dashboard-ir-renderer.ts", function: "manifestProseText", reason: "validateIr checks prose provenance/content; AgentText is accepted only by the agent-authored untrusted sink." },
];

export interface DomAllowance { name: string; reason: string }
export const DOM: readonly DomAllowance[] = [
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

export interface Finding { rule: string; file: string; line: number; detail: string }
export interface Audit { findings: Finding[]; minted: Set<string>; domUsed: Set<string>; domFiles: Set<string> }
export let config: ts.ParsedCommandLine;
export let program: ts.Program;
export let baseAudit: Audit;
export let mutationAudits: Map<string, Audit>;
export let mutationLines: Map<string, { file: string; line: number; rule: string }>;

export function readConfig(name: string): ts.ParsedCommandLine {
  const path = join(gateway, name);
  const read = ts.readConfigFile(path, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, gateway);
  if (parsed.errors.length) throw new Error(ts.formatDiagnostics(parsed.errors, diagnosticHost));
  return parsed;
}
export const diagnosticHost: ts.FormatDiagnosticsHost = {
  getCanonicalFileName: (path) => path,
  getCurrentDirectory: () => gateway,
  getNewLine: () => "\n",
};
export function domDeclaration(symbol: ts.Symbol | undefined): boolean {
  return !!symbol?.declarations?.some((d) => /[/\\]lib\.dom(?:\.iterable|\.asynciterable)?\.d\.ts$/.test(d.getSourceFile().fileName));
}
export function libraryDeclaration(symbol: ts.Symbol | undefined): boolean {
  return !!symbol?.declarations?.some((d) => /[/\\]lib\.[^/\\]+\.d\.ts$/.test(d.getSourceFile().fileName));
}
export function nonDomLibraryDeclaration(symbol: ts.Symbol | undefined): boolean {
  return !!symbol?.declarations?.some((declaration) => {
    const file = declaration.getSourceFile().fileName;
    return /[/\\]lib\.[^/\\]+\.d\.ts$/.test(file) && !/[/\\]lib\.dom(?:\.iterable|\.asynciterable)?\.d\.ts$/.test(file);
  });
}
export function unalias(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}
export function accessSymbol(checker: ts.TypeChecker, n: ts.Node): ts.Symbol | undefined {
  return unalias(checker, (ts.isIdentifier(n) && ts.isShorthandPropertyAssignment(n.parent) ? checker.getShorthandAssignmentValueSymbol(n.parent) : undefined) ?? checker.getSymbolAtLocation(ts.isPropertyAccessExpression(n) ? n.name : n)
    ?? (ts.isElementAccessExpression(n) && (ts.isStringLiteral(n.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(n.argumentExpression)) ? checker.getSymbolAtLocation(n.argumentExpression) : undefined));
}
export function inTypePosition(n: ts.Node): boolean {
  for (let p: ts.Node | undefined = n; p; p = p.parent) {
    if (ts.isExpressionWithTypeArguments(p) && ts.isHeritageClause(p.parent) && p.parent.token === ts.SyntaxKind.ExtendsKeyword
      && (ts.isClassDeclaration(p.parent.parent) || ts.isClassExpression(p.parent.parent))) continue;
    if (ts.isTypeNode(p)) return true;
  }
  return false;
}
export function valueReference(n: ts.Node): boolean {
  if (inTypePosition(n)) return false;
  if (!ts.isIdentifier(n)) return ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n);
  const p = n.parent;
  if ((ts.isPropertyAccessExpression(p) && p.name === n) || ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)
    || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isBindingElement(p)) && p.name === n)) return false;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p)) return false;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p)) && p.name === n) return false;
  return true;
}
/** Inspect carried values as well as direct brands, so wrappers/callables cannot forge a mint. */
export function carriedType(checker: ts.TypeChecker, type: ts.Type, matches: (t: ts.Type) => boolean, seen = new Set<ts.Type>()): boolean {
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
    const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? type.getSymbol()?.declarations?.[0] ?? type.aliasSymbol?.declarations?.[0];
    return !!declaration && carriedType(checker, checker.getTypeOfSymbolAtLocation(property, declaration), matches, seen);
  });
}
export function branded(checker: ts.TypeChecker, type: ts.Type): boolean {
  return carriedType(checker, type, (t) => brands.some((name) => !!checker.getPropertyOfType(t, name)));
}
export function unresolvedAssertion(checker: ts.TypeChecker, type: ts.Type): boolean {
  return carriedType(checker, type, (t) => !!(t.flags & (ts.TypeFlags.TypeParameter | ts.TypeFlags.IndexedAccess | ts.TypeFlags.Conditional)));
}
/** Project logical parameters, including repeated tuple-rest tail elements. */
export function signatureParameter(checker: ts.TypeChecker, signature: ts.Signature, index: number): ts.Type | undefined {
  const last = signature.parameters.length - 1;
  const symbol = signature.parameters[Math.min(index, last)];
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!symbol || !declaration) return;
  let type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
  if (!ts.isParameter(declaration) || !declaration.dotDotDotToken || index < last) return index > last ? undefined : type;
  type = checker.getBaseConstraintOfType(type) ?? type;
  if (!checker.isTupleType(type)) return checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  const tuple = type as ts.TupleTypeReference;
  const elements = checker.getTypeArguments(tuple);
  const offset = index - last;
  const rest = tuple.target.elementFlags.findIndex((flags) => !!(flags & ts.ElementFlags.Variable));
  const element = elements[offset] ?? (rest >= 0 ? elements[rest] : undefined);
  if (!element) return;
  const flags = tuple.target.elementFlags[Math.min(offset, elements.length - 1)]!;
  return flags & ts.ElementFlags.Variadic ? checker.getIndexTypeOfType(checker.getBaseConstraintOfType(element) ?? element, ts.IndexKind.Number) : element;
}
/** Compare value flow, reversing parameter flow even for TS's bivariant methods. */
export function textRelation(checker: ts.TypeChecker, source: ts.Type, target: ts.Type, relevance: Map<ts.Type, boolean>, at: ts.Node, aliasWrites = true): string | undefined {
  const seen = new Map<ts.Type, Set<ts.Type>>();
  const constraint = (type: ts.Type): ts.Type => type.flags & ts.TypeFlags.TypeParameter ? checker.getBaseConstraintOfType(type) ?? type : type;
  const slots = (type: ts.Type, visited: Set<ts.Type>, unresolved = true): boolean => {
    if (visited.has(type)) return false;
    visited.add(type);
    if (brands.some((name) => !!checker.getPropertyOfType(type, name))) return true;
    if (type.flags & (ts.TypeFlags.TypeParameter | ts.TypeFlags.IndexedAccess | ts.TypeFlags.Conditional)) return unresolved || constraint(type) !== type && slots(constraint(type), visited, false);
    if (type.isUnionOrIntersection() && type.types.some((part) => slots(part, visited, unresolved))) return true;
    if (type.aliasTypeArguments?.some((part) => slots(part, visited, unresolved))) return true;
    if (!(type.flags & ts.TypeFlags.Object)) return false;
    if ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference && checker.getTypeArguments(type as ts.TypeReference).some((part) => slots(part, visited, unresolved))) return true;
    const library = libraryDeclaration(type.getSymbol()) || libraryDeclaration(type.aliasSymbol);
    if ([...type.getCallSignatures(), ...type.getConstructSignatures()].some((signature) => slots(checker.getReturnTypeOfSignature(signature), visited, unresolved && !library) || signature.parameters.some((parameter) => slots(symbolType(parameter), visited, unresolved && !library)) || !!signature.thisParameter && slots(symbolType(signature.thisParameter), visited, unresolved && !library))) return true;
    if (library) return false;
    if (checker.getIndexInfosOfType(type).some((index) => slots(index.type, visited, unresolved))) return true;
    return type.getProperties().some((property) => slots(symbolType(property), visited, unresolved) || slots(writeType(property, type), visited, unresolved));
  };
  const relevant = (type: ts.Type): boolean => {
    if (!relevance.has(type)) relevance.set(type, slots(type, new Set()));
    return relevance.get(type)!;
  };
  const requiresBrand = (type: ts.Type, name: string): boolean => {
    type = constraint(type);
    return type.isUnion() ? type.types.every((part) => requiresBrand(part, name)) : !!checker.getPropertyOfType(type, name);
  };
  const symbolType = (symbol: ts.Symbol): ts.Type => checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration ?? symbol.declarations?.[0] ?? at);
  const writeType = (symbol: ts.Symbol, owner?: ts.Type): ts.Type => {
    const setter = symbol.declarations?.find(ts.isSetAccessorDeclaration);
    if (!setter?.parameters[0]) return symbolType(symbol);
    const parameter = checker.getTypeAtLocation(setter.parameters[0]);
    if (owner && parameter.flags & ts.TypeFlags.TypeParameter) {
      if (owner.flags & ts.TypeFlags.Object && (owner as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
        const reference = owner as ts.TypeReference;
        const index = reference.target.typeParameters?.indexOf(parameter as ts.TypeParameter) ?? -1;
        if (index >= 0) return checker.getTypeArguments(reference)[index] ?? parameter;
      }
      const alias = owner.aliasSymbol?.declarations?.find(ts.isTypeAliasDeclaration);
      const index = alias?.typeParameters?.findIndex((formal) => checker.getTypeAtLocation(formal) === parameter) ?? -1;
      if (index >= 0 && owner.aliasTypeArguments?.[index]) return owner.aliasTypeArguments[index]!;
      // Inferred factory results are anonymous instantiated objects. Recover
      // a shared type parameter through their instantiated readable members.
      for (const property of owner.getProperties()) for (const declaration of property.declarations ?? []) {
        if (ts.isGetAccessorDeclaration(declaration) || ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration)) {
          const signature = checker.getSignatureFromDeclaration(declaration);
          if (signature && checker.getReturnTypeOfSignature(signature) === parameter) {
            if (ts.isGetAccessorDeclaration(declaration)) return symbolType(property);
            const actual = symbolType(property).getCallSignatures()[0];
            if (actual) return checker.getReturnTypeOfSignature(actual);
          }
        } else if ((ts.isPropertyDeclaration(declaration) || ts.isPropertySignature(declaration)) && declaration.type && checker.getTypeAtLocation(declaration.type) === parameter) return symbolType(property);
      }
    }
    return parameter;
  };
  const arity = (signature: ts.Signature): number => {
    const last = signature.parameters.at(-1);
    const declaration = last?.valueDeclaration ?? last?.declarations?.[0];
    const type = last && symbolType(last);
    return declaration && ts.isParameter(declaration) && declaration.dotDotDotToken && type && checker.isTupleType(type) ? signature.parameters.length - 1 + checker.getTypeArguments(type as ts.TypeReference).length : signature.parameters.length;
  };
  // TS readonly data/index annotations can be structurally erased. Only an
  // actual getter without a setter prevents writes at runtime. Spread copies
  // retain getter declarations, but their symbol becomes an ordinary Property.
  const getterOnly = (property: ts.Symbol): boolean => !!(property.flags & ts.SymbolFlags.GetAccessor)
    && !(property.flags & ts.SymbolFlags.SetAccessor)
    && !!property.declarations?.some((declaration) => ts.isGetAccessorDeclaration(declaration) && !!declaration.body);
  const compatible = (from: ts.Type, to: ts.Type): boolean => checker.isTypeAssignableTo(from, to) || checker.isTypeAssignableTo(to, from);
  const compare = (from: ts.Type, to: ts.Type): string | undefined => {
    from = constraint(from); to = constraint(to);
    if (from === to || from.flags & ts.TypeFlags.Never) return;
    if (!relevant(from) && !relevant(to)) return;
    if (seen.get(from)?.has(to)) return;
    if (!seen.has(from)) seen.set(from, new Set());
    seen.get(from)!.add(to);
    for (const name of brands) if (requiresBrand(to, name) && !requiresBrand(from, name)) return `Unbranded value reaches ${name} slot`;
    // Any can also mint through callable covariance or a generic return alias,
    // without an Any-typed expression at the assignment site.
    if (from.flags & ts.TypeFlags.Any) {
      if (branded(checker, to) || unresolvedAssertion(checker, to)) return "Any reaches a branded or unresolved text slot";
      return;
    }
    if (from.isUnion()) {
      for (const part of from.types) { const issue = compare(part, to); if (issue) return issue; }
      return;
    }
    if (to.isUnion()) {
      for (const part of to.types) {
        // KitText and AgentText are now distinct opaque objects. A union sink
        // accepts either identity; do not force a genuine tier (or another
        // accepted member, such as a commit callback) to satisfy both tiers.
        // Container/discriminated unions retain the all-object member walk.
        if (brands.some((name) => requiresBrand(part, name)) && !checker.isTypeAssignableTo(from, part) && checker.isTypeAssignableTo(from, to)) continue;
        if (compatible(from, part) || !!(from.flags & ts.TypeFlags.Object) && !!(part.flags & ts.TypeFlags.Object) || brands.some((name) => requiresBrand(part, name)) && !checker.isTypeAssignableTo(from, to)) { const issue = compare(from, part); if (issue) return issue; }
      }
      return;
    }
    for (const kind of [ts.SignatureKind.Call, ts.SignatureKind.Construct]) {
      for (const out of checker.getSignaturesOfType(to, kind)) for (const incoming of checker.getSignaturesOfType(from, kind)) {
        const parameters = Array.from({ length: Math.max(arity(incoming), arity(out)) }, (_, index) => [signatureParameter(checker, incoming, index), signatureParameter(checker, out, index)] as const);
        // Generic methods can use distinct callback type parameters while
        // relating structurally. Inspect their concrete branded slots too.
        const libraryGenerics = (incoming.typeParameters?.length || out.typeParameters?.length) && libraryDeclaration(from.getSymbol()) && libraryDeclaration(to.getSymbol());
        if (!libraryGenerics && parameters.some(([a, b]) => a && b && !compatible(a, b) && !branded(checker, a) && !branded(checker, b))) continue;
        if (incoming.thisParameter) {
          if (!out.thisParameter && branded(checker, symbolType(incoming.thisParameter))) return "Callable branded this parameter lost";
          if (out.thisParameter) { const issue = compare(symbolType(out.thisParameter), symbolType(incoming.thisParameter)); if (issue) return `Callable this parameter widening: ${issue}`; }
        }
        // Contextual generic identity retains the argument's opaque brand.
        // Instantiate only a direct declared type parameter bound by an input;
        // unbound or any-returning generics still undergo return comparison.
        const substitutions = new Map<ts.Type, ts.Type>();
        for (const [input, supplied] of parameters) if (input && supplied && incoming.typeParameters?.includes(input as ts.TypeParameter)
          && (!checker.getBaseConstraintOfType(input) || checker.isTypeAssignableTo(supplied, checker.getBaseConstraintOfType(input)!))) {
          const previous = substitutions.get(input);
          if (!previous || previous === supplied) substitutions.set(input, supplied);
        }
        const result = checker.getReturnTypeOfSignature(incoming);
        const returned = compare(substitutions.get(result) ?? result, checker.getReturnTypeOfSignature(out));
        if (returned) return `Callable return: ${returned}`;
        for (const [a, b] of parameters) if (a && b) {
          // An absent optional argument does not reach the callable's text
          // slot. Compare the supplied callback/value, retaining other unions.
          const issue = compare(checker.getNonNullableType(b), checker.getNonNullableType(substitutions.get(a) ?? a));
          if (issue) return `Callable parameter widening: ${issue}`;
        }
      }
    }
    if (!(from.flags & ts.TypeFlags.Object || from.isIntersection()) || !(to.flags & ts.TypeFlags.Object || to.isIntersection())) return;
    if ((from as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference && (to as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
      const inputs = checker.getTypeArguments(from as ts.TypeReference);
      const outputs = checker.getTypeArguments(to as ts.TypeReference);
      const arrayPair = (checker.isArrayType(from) || checker.isTupleType(from)) && (checker.isArrayType(to) || checker.isTupleType(to));
      const family = (type: ts.Type): string => (type.getSymbol()?.name ?? "").replace(/^Readonly(?=Map$|Set$)/, "");
      const containerPair = arrayPair || !!from.getSymbol() && family(from) === family(to);
      if (from.getSymbol() === to.getSymbol() || containerPair) for (const [index, input] of inputs.entries()) {
        const output = outputs[index];
        if (output) {
          const issue = compare(input, output);
          if (issue) return `Container member: ${issue}`;
          // Readonly arrays/sets and map keys also have consuming methods.
          // Their bivariant parameters can be overridden by a branded writer.
          const consumer = arrayPair || ["Map", "Set", "WeakMap", "WeakSet", "ReadonlySet"].includes(to.getSymbol()?.name ?? "") || to.getSymbol()?.name === "ReadonlyMap" && index === 0;
          if (consumer && aliasWrites) { const write = compare(output, input); if (write) return `Container parameter widening: ${write}`; }
        }
      }
      // Element relations cover array values and mutable method parameters. Do
      // not expand Array.map/concat's recursively instantiated library graph.
      if (arrayPair) return;
    }
    for (const output of checker.getIndexInfosOfType(to)) for (const input of checker.getIndexInfosOfType(from)) {
      if (compatible(input.keyType, output.keyType)) {
        const issue = compare(input.type, output.type);
        if (issue) return `Index member: ${issue}`;
        if (aliasWrites) {
          const write = compare(checker.getNonNullableType(output.type), checker.getNonNullableType(input.type));
          if (write) return `Writable index member: ${write}`;
        }
      }
    }
    // Object literals, mapped records and tuples also supply implicit index slots.
    for (const output of checker.getIndexInfosOfType(to)) for (const input of from.getProperties()) {
      const numeric = /^(?:0|[1-9]\d*)$/.test(input.name);
      if (!(output.keyType.flags & ts.TypeFlags.StringLike) && !(numeric && output.keyType.flags & ts.TypeFlags.NumberLike)) continue;
      if (output.keyType.isStringLiteral() && output.keyType.value !== input.name) continue;
      const issue = compare(symbolType(input), output.type);
      if (issue) return `Implicit index member ${input.name}: ${issue}`;
      if ((aliasWrites || !!input.declarations?.some(ts.isSetAccessorDeclaration)) && !getterOnly(input)) {
        const write = compare(checker.getNonNullableType(output.type), checker.getNonNullableType(writeType(input, from)));
        if (write) return `Writable implicit index member ${input.name}: ${write}`;
      }
    }
    // Distinct library interfaces relate structurally (for example Array ->
    // Iterable). Follow only shared members carrying an actual text brand, so
    // unresolved library generics cannot expand an unbounded type graph.
    const libraries = libraryDeclaration(from.getSymbol()) && libraryDeclaration(to.getSymbol());
    for (const property of to.getProperties()) {
      // getPropertyOfType escapes names again and loses computed-symbol keys.
      const input = checker.getPropertyOfType(from, property.name) ?? from.getProperties().find((candidate) => candidate.escapedName === property.escapedName);
      if (input) {
        if (libraries && !slots(symbolType(input), new Set(), false) && !slots(symbolType(property), new Set(), false)) continue;
        const issue = compare(symbolType(input), symbolType(property));
        if (issue) return `Member ${property.name}: ${issue}`;
        if ((aliasWrites || !!input.declarations?.some(ts.isSetAccessorDeclaration)) && !getterOnly(input)) {
          const incoming = checker.getNonNullableType(writeType(input, from));
          const outgoing = checker.getNonNullableType(writeType(property, to));
          if (input.declarations?.some(ts.isSetAccessorDeclaration) && incoming !== outgoing && unresolvedAssertion(checker, incoming)) return `Unresolved accessor writer widened: ${property.name}`;
          const write = compare(outgoing, incoming);
          if (write) return `Writable member ${property.name}: ${write}`;
        }
      }
    }
  };
  return compare(source, target);
}
/** Synthetic mapped/tuple members have no declaration; resolve them at the use. */
export function memberType(checker: ts.TypeChecker, owner: ts.Type, name: string, at: ts.Node): ts.Type | undefined {
  const symbol = checker.getPropertyOfType(owner, name) ?? owner.getProperties().find((p) => p.name === name);
  return symbol && checker.getTypeOfSymbolAtLocation(symbol, at);
}
export function iterableElements(checker: ts.TypeChecker, type: ts.Type, at: ts.Node, async = false): ts.Type[] {
  if (type.isUnion()) return type.types.flatMap((part) => iterableElements(checker, part, at, async));
  const indexed = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  if (indexed) return [indexed];
  const iterator = type.getProperties().find((property) => property.escapedName.toString().startsWith(async ? "__@asyncIterator" : "__@iterator"))
    ?? (async ? type.getProperties().find((property) => property.escapedName.toString().startsWith("__@iterator")) : undefined);
  const iteratorType = iterator && checker.getTypeOfSymbolAtLocation(iterator, at).getCallSignatures()[0];
  if (!iteratorType) return [];
  const result = checker.getReturnTypeOfSignature(iteratorType);
  if (result.flags & ts.TypeFlags.Object && (result as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
    const element = checker.getTypeArguments(result as ts.TypeReference)[0];
    if (element) return [async ? checker.getAwaitedType(element) ?? element : element];
  }
  const next = memberType(checker, result, "next", at)?.getCallSignatures()[0];
  if (!next) return [];
  const returned = checker.getReturnTypeOfSignature(next);
  const settled = async ? checker.getAwaitedType(returned) ?? returned : returned;
  return (settled.isUnion() ? settled.types : [settled]).flatMap((part) => {
    const done = memberType(checker, part, "done", at);
    if (done?.flags === ts.TypeFlags.BooleanLiteral && checker.typeToString(done) === "true") return [];
    const value = memberType(checker, part, "value", at);
    return value ? [value] : [];
  });
}
/** Only the parsed token boundaries determine comments, including template/regex trivia. */
export function comments(source: ts.SourceFile): ts.CommentRange[] {
  const ranges = new Map<number, ts.CommentRange>();
  const visit = (node: ts.Node): void => {
    for (const range of [...ts.getLeadingCommentRanges(source.text, node.pos) ?? [], ...ts.getTrailingCommentRanges(source.text, node.end) ?? []]) ranges.set(range.pos, range);
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return [...ranges.values()].sort((a, b) => a.pos - b.pos);
}
export const CALLABLE_PRESENCE = {
  file: "dashboard-ir-binder.ts", function: "startBind", parameters: ["onStale", "onEnded"],
  reason: "Optional callbacks are tested for presence in conditions before direct branded calls; no function value leaves the condition.",
} as const;
/** A callable needing branded input cannot escape to any wider or missing slot.
 * This follows source values, including containers; it never uses assignability
 * to select a permissive target overload or discriminated-union branch.
 */
export function narrowCallableGuard(checker: ts.TypeChecker, at: ts.Node): {
  carries: (type: ts.Type) => boolean;
  safe: (source: ts.Type, target: ts.Type) => boolean;
} {
  const cache = new Map<ts.Type, boolean>();
  const constraint = (type: ts.Type): ts.Type => checker.getBaseConstraintOfType(type) ?? type;
  const sigs = (type: ts.Type): ts.Signature[] => [...type.getCallSignatures(), ...type.getConstructSignatures()];
  const symbolType = (symbol: ts.Symbol): ts.Type => checker.getTypeOfSymbolAtLocation(symbol, at);
  const inputBrand = (type: ts.Type): boolean => branded(checker, constraint(type));
  const carries = (type: ts.Type, seen = new Set<ts.Type>()): boolean => {
    type = constraint(type);
    if (cache.has(type)) return cache.get(type)!;
    if (seen.has(type)) return false;
    const root = seen.size === 0;
    seen.add(type);
    let found = sigs(type).some((sig) => sig.parameters.some((p) => inputBrand(symbolType(p))) || !!sig.thisParameter && inputBrand(symbolType(sig.thisParameter)));
    if (type.isUnionOrIntersection()) found ||= type.types.some((part) => carries(part, seen));
    if (type.flags & ts.TypeFlags.Object) {
      if ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) found ||= checker.getTypeArguments(type as ts.TypeReference).some((part) => carries(part, seen));
      if (!libraryDeclaration(type.getSymbol())) found ||= type.getProperties().some((p) => carries(symbolType(p), seen)) || checker.getIndexInfosOfType(type).some((i) => carries(i.type, seen));
    }
    // A recursive back-edge may leave a child incomplete; cache false only
    // after a complete root walk so another root cannot inherit that false.
    if (found || root) cache.set(type, found);
    return found;
  };
  const seen = new Map<ts.Type, Set<ts.Type>>();
  const safe = (source: ts.Type, target: ts.Type): boolean => {
    source = constraint(source); target = constraint(target);
    if (!carries(source)) return true;
    if (target.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
    if (seen.get(source)?.has(target)) return true;
    if (!seen.has(source)) seen.set(source, new Set());
    seen.get(source)!.add(target);
    if (source.isUnion()) return source.types.every((part) => safe(part, target));
    if (target.isUnion()) return target.types.filter((part) => !(part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never))).every((part) => safe(source, part));
    for (const incoming of sigs(source)) {
      const brandedInputs = incoming.parameters.flatMap((p, index) => inputBrand(symbolType(p)) ? [index] : []);
      const brandedThis = !!incoming.thisParameter && inputBrand(symbolType(incoming.thisParameter));
      if (!brandedInputs.length && !brandedThis) continue;
      const outputs = sigs(target);
      if (!outputs.length) return false;
      for (const out of outputs) {
        if (brandedThis && (!out.thisParameter || textRelation(checker, symbolType(out.thisParameter), symbolType(incoming.thisParameter!), new Map(), at))) return false;
        for (const index of brandedInputs) {
          const from = signatureParameter(checker, incoming, index)!;
          const to = signatureParameter(checker, out, index);
          if (!to || textRelation(checker, checker.getNonNullableType(to), checker.getNonNullableType(from), new Map(), at)) return false;
        }
      }
    }
    if ((source.flags & ts.TypeFlags.Object) && (source as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
      const from = checker.getTypeArguments(source as ts.TypeReference);
      const to = target.flags & ts.TypeFlags.Object && (target as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference ? checker.getTypeArguments(target as ts.TypeReference) : [];
      for (const [index, input] of from.entries()) if (carries(input) && (!to[index] || !safe(input, to[index]!))) return false;
      if (libraryDeclaration(source.getSymbol())) return true;
    }
    for (const property of source.getProperties()) {
      const input = symbolType(property);
      if (!carries(input)) continue;
      const output = memberType(checker, target, property.name, at) ?? checker.getIndexTypeOfType(target, /^\d+$/.test(property.name) ? ts.IndexKind.Number : ts.IndexKind.String) ?? checker.getIndexTypeOfType(target, ts.IndexKind.String);
      if (!output || !safe(input, output)) return false;
    }
    for (const input of checker.getIndexInfosOfType(source)) if (carries(input.type)) {
      const output = checker.getIndexInfosOfType(target).find((i) => checker.isTypeAssignableTo(input.keyType, i.keyType));
      if (!output || !safe(input.type, output.type)) return false;
    }
    return true;
  };
  return { carries, safe: (source, target) => { seen.clear(); return safe(source, target); } };
}

export function literalOnly(n: ts.Expression): boolean {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return true;
  if (ts.isParenthesizedExpression(n)) return literalOnly(n.expression);
  return ts.isConditionalExpression(n) && literalOnly(n.whenTrue) && literalOnly(n.whenFalse);
}
export function enclosingFunctionNode(n: ts.Node): ts.Node | undefined {
  for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p;
  return undefined;
}
export function functionNames(n: ts.Node): string[] {
  if (!ts.isFunctionLike(n)) return [];
  const names: string[] = [];
  const addName = (name: ts.Node | undefined): void => {
    if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))) names.push(name.text);
    if (name && (ts.isComputedPropertyName(name) || ts.isParenthesizedExpression(name) || ts.isAsExpression(name) || ts.isTypeAssertionExpression(name) || ts.isNonNullExpression(name) || ts.isSatisfiesExpression(name))) addName(name.expression);
  };
  if ("name" in n) addName(n.name as ts.Node | undefined);
  if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
    let binding: ts.Node = n;
    while (ts.isParenthesizedExpression(binding.parent) || ts.isAsExpression(binding.parent) || ts.isTypeAssertionExpression(binding.parent) || ts.isNonNullExpression(binding.parent) || ts.isSatisfiesExpression(binding.parent)) binding = binding.parent;
    const parent = binding.parent;
    if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) addName(parent.name);
    if (ts.isBinaryExpression(parent) && parent.right === binding && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = parent.left;
      addName(ts.isPropertyAccessExpression(target) ? target.name : ts.isElementAccessExpression(target) ? target.argumentExpression : target);
    }
  }
  return [...new Set(names)];
}
export function topLevelMint(n: ts.Node, source: ts.SourceFile): boolean {
  return ts.isFunctionDeclaration(n) && n.parent === source && !!n.body;
}
export function containingFunction(n: ts.Node): string {
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
export function runtimeExpression(n: ts.Node): boolean {
  if (!ts.isExpression(n) || inTypePosition(n)) return false;
  // Import/export module specifiers are syntax, not runtime expressions. Asking the
  // checker for their type yields Any even in a correctly resolved Program.
  if ((ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent)) && n.parent.moduleSpecifier === n) return false;
  return !ts.isIdentifier(n) || valueReference(n);
}
export function isKitFactory(checker: ts.TypeChecker, n: ts.Expression, seen = new Set<ts.Symbol>()): boolean {
  if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || ts.isNonNullExpression(n)) return isKitFactory(checker, n.expression, seen);
  const declarationIsKitFactory = (d: ts.Node | undefined): boolean => !!d && ts.isFunctionDeclaration(d) && d.name?.text === "kitText" && ts.isSourceFile(d.parent) && d.getSourceFile().fileName === irPaths[0];
  if (checker.getTypeAtLocation(n).getCallSignatures().some((sig) => declarationIsKitFactory(sig.declaration))) return true;
  const symbol = accessSymbol(checker, n);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  return !!symbol.declarations?.some((d) => ts.isVariableDeclaration(d) && d.initializer && isKitFactory(checker, d.initializer, seen));
}
export function nonliteralKitCall(checker: ts.TypeChecker, n: ts.CallExpression): boolean {
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
export function domReceiver(checker: ts.TypeChecker, type: ts.Type, seen = new Set<ts.Type>()): boolean {
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
export function keyOf(n: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  return ts.isStringLiteral(n.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(n.argumentExpression) ? n.argumentExpression.text : undefined;
}
export function descriptorValue(checker: ts.TypeChecker, n: ts.Expression, seen = new Set<ts.Symbol>()): boolean {
  if (checker.getNonNullableType(checker.getTypeAtLocation(n)).getSymbol()?.name === "PropertyDescriptor") return true;
  if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n)) return descriptorValue(checker, n.expression, seen);
  const symbol = accessSymbol(checker, n);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  return !!symbol.declarations?.some((d) => ts.isVariableDeclaration(d) && d.initializer && descriptorValue(checker, d.initializer, seen));
}
export function reflectionViolation(checker: ts.TypeChecker, n: ts.Node): string | undefined {
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
    if (["__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"].includes(key ?? "")) return `Forbidden accessor reflection ${key}`;
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
      if (keyType.isStringLiteral() && ["__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"].includes(keyType.value)) return "Forbidden computed setter reflection";
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
        if (keyType.isStringLiteral() && ["__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"].includes(keyType.value)) return "Forbidden computed setter destructuring";
      }
      if (ts.isIdentifier(key) || ts.isStringLiteral(key)) {
        const member = checker.getPropertyOfType(checker.getTypeAtLocation(pattern.parent.initializer), key.text);
        if (libraryDeclaration(member) && ["Reflect", "Proxy", "eval", "Function", "Object"].includes(key.text)) return `Forbidden destructured reflection global ${key.text}`;
        if (descriptorValue(checker, pattern.parent.initializer) && ["get", "set"].includes(key.text)) return "Forbidden destructured descriptor accessor";
        if (libraryDeclaration(member) && ["assign", "defineProperty", "defineProperties", "setPrototypeOf"].includes(key.text)) return `Forbidden destructured Object.${key.text}`;
        if (["__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"].includes(key.text)) return `Forbidden destructured accessor ${key.text}`;
        if (libraryDeclaration(member) && ["get", "set"].includes(key.text) && checker.getTypeAtLocation(pattern.parent.initializer).getSymbol()?.name === "PropertyDescriptor") return "Forbidden destructured descriptor accessor";
      }
    }
  }
}
export function topLevelBindings(file: ts.SourceFile): Map<string, ts.Expression> {
  const bindings = new Map<string, ts.Expression>();
  for (const statement of file.statements) if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.initializer) {
      if (bindings.has(declaration.name.text)) throw new Error(`Duplicate top-level binding: ${declaration.name.text}`);
      bindings.set(declaration.name.text, declaration.initializer);
    }
  }
  return bindings;
}
export function buildInputs(): string[] {
  const source = readFileSync(join(gateway, "scripts/build-dashboard-ir-kit.mjs"), "utf8");
  const file = ts.createSourceFile("build.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const expected = topLevelBindings(file).get("expected");
  if (!expected || !ts.isArrayLiteralExpression(expected)) throw new Error("Missing literal build input allowlist");
  return expected.elements.map((element) => {
    if (!ts.isStringLiteral(element)) throw new Error("Build input allowlist must be literal");
    return element.text;
  });
}
export function lintTargets(source = readFileSync(join(gateway, "../spec/src/__tests__/ui-kit-text-sinks.lint.test.ts"), "utf8")): string[] {
  const file = ts.createSourceFile("lint.test.ts", source, ts.ScriptTarget.Latest, true);
  const bindings = topLevelBindings(file);
  const kits = bindings.get("kits");
  if (!kits || !ts.isArrayLiteralExpression(kits)) throw new Error("Missing actual lint kits array");
  return kits.elements.flatMap((element) => {
    const config = ts.isIdentifier(element) ? bindings.get(element.text) : element;
    if (!config || !ts.isObjectLiteralExpression(config)) throw new Error("Lint target config must be a top-level object");
    const field = config.properties.find((property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "file");
    if (!field || !ts.isPropertyAssignment(field)) throw new Error("Lint target missing file");
    const targets: string[] = [];
    const walk = (n: ts.Node): void => {
      if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "URL" && n.arguments && ts.isStringLiteral(n.arguments[0]) && /^dashboard-ir.*\.ts$/.test(n.arguments[0].text)) targets.push(n.arguments[0].text);
      ts.forEachChild(n, walk);
    };
    walk(field.initializer);
    return targets;
  });
}
export function mintKey(file: string, fn: string): string { return `${file}:${fn}`; }
export function audit(p: ts.Program, mints = MINTS, dom = DOM, bundled: readonly string[] = buildInputs(), targets: readonly string[] = lintTargets(), presence: { file: typeof IR_FILES[number]; function: string; parameters: readonly string[]; reason: string } = CALLABLE_PRESENCE): Audit {
  const checker = p.getTypeChecker();
  const relationTypes = new Map<ts.Type, boolean>();
  const presenceUsed = new Set<string>();
  const wrappedDomFiles = new Map<string, ts.Node | undefined>([["mcp/dashboard-ir-renderer.ts", undefined]]);
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
    for (const comment of comments(s)) if (/@ts-(?:ignore|expect-error|nocheck)\b/i.test(s.text.slice(comment.pos, comment.end))) {
      result.findings.push({ rule: "directive", file: relative(src, path), line: s.getLineAndCharacterOfPosition(comment.pos).line + 1, detail: "Type-check suppression is forbidden in IR sources" });
    }
    const pragma = (s as ts.SourceFile & { checkJsDirective?: { enabled: boolean; pos: number } }).checkJsDirective;
    if (pragma?.enabled === false && !result.findings.some((finding) => finding.rule === "directive" && finding.file === relative(src, path) && finding.line === s.getLineAndCharacterOfPosition(pragma.pos).line + 1)) {
      result.findings.push({ rule: "directive", file: relative(src, path), line: s.getLineAndCharacterOfPosition(pragma.pos).line + 1, detail: "TypeScript parsed this source as unchecked" });
    }
    const file = IR_FILES[irPaths.indexOf(path)]!;
    result.findings.push(...importedText(s));
    const expectedImportSpecifiers = file === "dashboard-ir.ts" ? ["@pcc/spec"] : file === "dashboard-ir-browser-entry.ts" ? ["./dashboard-ir.js", "./dashboard-ir-renderer.js", "./dashboard-ir-binder.js"] : ["./dashboard-ir.js"];
    for (const statement of s.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const reviewedTypeImport = file === "dashboard-ir.ts" && specifier === "@pcc/spec" && statement.importClause?.isTypeOnly;
      const resolved = ts.resolveModuleName(specifier, path, p.getCompilerOptions(), ts.sys).resolvedModule?.resolvedFileName;
      if (!expectedImportSpecifiers.includes(specifier) || !reviewedTypeImport && (!resolved || !irPaths.includes(resolved))) add("inventory", statement, "IR imports must match the exact reviewed four-file graph and the existing type-only spec dependency");
    }
    // Structural recipients can carry DOM setters without a DOM symbol or
    // RElement reference. Check text writes in every IR file, independent of
    // the recipient's type, while retaining the exact declared sink bodies.
    const captureStatements = new Map<string, ts.VariableStatement>();
    const diagnosticInitializers = s.statements.filter((statement) => ts.isExpressionStatement(statement) && statement.getText(s) === "textDiagnostics.__PCC_UI_TEXT_VIOLATIONS__ ??= 0;");
    if (file === "dashboard-ir.ts") {
      const executable = s.statements.filter((statement) => !ts.isImportDeclaration(statement) && !ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement));
      for (const [index, [name, initializer]] of [...CAPTURES].entries()) {
        const statement = executable[index];
        const declaration = statement && ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1 ? statement.declarationList.declarations[0] : undefined;
        if (statement && ts.isVariableStatement(statement) && !!(statement.declarationList.flags & ts.NodeFlags.Const) && !statement.modifiers?.length && declaration && ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer?.getText(s) === initializer && declaration.getText(s) === CAPTURE_DECLARATIONS.get(name)) captureStatements.set(name, statement);
        else add("captures-first", statement ?? s, `First executable captures must pin ${name} = ${initializer}`);
      }
      const diagnostic = executable[CAPTURES.size];
      if (!diagnostic || !ts.isVariableStatement(diagnostic) || diagnostic.getText(s) !== "const textDiagnostics = globalThis as typeof globalThis & { __PCC_UI_TEXT_VIOLATIONS__?: number };") add("captures-first", diagnostic ?? s, "The existing diagnostic global must be captured immediately after the four intrinsic functions");
      if (diagnosticInitializers.length !== 1) add("brand-confinement", diagnosticInitializers[1] ?? s, "The diagnostic counter requires its one exact top-level initialization");
    }
    const lintSource = file === "dashboard-ir.ts" ? [...captureStatements.values()].reduce((text, statement) => text.slice(0, statement.getStart(s)) + text.slice(statement.getStart(s), statement.end).replace(/[^\n\r]/g, " ") + text.slice(statement.end), s.text) : s.text;
    const textIssues = lintTextSinks(lintSource, {
      file: path, scriptKind: ts.ScriptKind.TS, sinks: TEXT_SINKS[file],
      allowedComputedWrites: file === "dashboard-ir.ts" ? [{
        function: "mapBind", target: "q", reason: "Copies validated query scalars into a fresh, unreassigned plain object; no DOM recipient",
      }] : [],
    }).filter((issue) => issue.rule.startsWith("text property write:") || issue.rule === "dynamic computed property write");
    for (const issue of textIssues) {
      result.findings.push({ rule: "text-sink", file: relative(src, path), line: issue.line, detail: issue.rule });
    }
    const functions: ts.Node[] = [];
    const collect = (n: ts.Node): void => { if (ts.isFunctionLike(n)) functions.push(n); ts.forEachChild(n, collect); };
    collect(s);
    if (file === "dashboard-ir.ts") for (const [name, expected] of BRAND_OWNER_DECLARATIONS) {
      const owners = functions.filter((fn) => ts.isFunctionDeclaration(fn) && fn.name?.text === name && fn.parent === s);
      if (owners.length !== expected.length) add("brand-confinement", owners[owners.length - 1] ?? s, `Runtime brand owner declarations are pinned exactly: ${name}`);
      for (const [index, owner] of owners.entries()) if (owner.getText(s) !== expected[index]) add("brand-confinement", owner, `Runtime brand owner text is pinned exactly: ${name}`);
    }
    const declarations = new Map<string, ts.Node>();
    const permittedNames = new Set(mints.map((entry) => entry.function));
    for (const entry of mints.filter((entry) => entry.file === file)) {
      const candidates = functions.filter((n) => functionNames(n).includes(entry.function) && topLevelMint(n, s));
      if (candidates.length === 1) declarations.set(entry.function, candidates[0]!);
      else add("mint", candidates[1] ?? s, `Mint requires exactly one top-level declaration: ${entry.function}`);
    }
    for (const fn of functions) for (const name of functionNames(fn)) {
      if (permittedNames.has(name) && declarations.get(name) !== fn) add("mint", fn, `Unapproved function-like node with permitted mint name: ${name}`);
    }
    const runtimeInternals = new Map<string, ts.Node>();
    if (file === "dashboard-ir.ts") for (const name of RUNTIME_BRAND_INTERNALS) {
      const candidates = functions.filter((n) => functionNames(n).includes(name) && topLevelMint(n, s));
      if (candidates.length === 1) runtimeInternals.set(name, candidates[0]!);
      else add("mint", candidates[1] ?? s, `Runtime brand internal requires exactly one declaration: ${name}`);
    }
    const brandOwners = new Set<ts.Node>([...runtimeInternals.values(), ...functions.filter((fn) => topLevelMint(fn, s) && functionNames(fn).includes("isKitText"))]);
    const ownedBrandReference = (node: ts.Node): boolean => {
      for (let owner: ts.Node | undefined = node.parent; owner && owner !== s; owner = owner.parent) if (brandOwners.has(owner)) return true;
      return false;
    };
    const diagnosticOwners = functions.filter((fn) => topLevelMint(fn, s) && functionNames(fn).includes("textViolation"));
    const ownedDiagnosticReference = (node: ts.Node): boolean => {
      if (file !== "dashboard-ir.ts") return false;
      // Retain the existing owner/initializer boundary, and permit only the
      // counter projection even inside its owner. The global itself cannot escape.
      const use = intrinsicUse(node);
      if (!(ts.isPropertyAccessExpression(use.parent) && use.parent.expression === use && use.parent.name.text === "__PCC_UI_TEXT_VIOLATIONS__")) return false;
      for (let owner: ts.Node | undefined = node.parent; owner && owner !== s; owner = owner.parent) {
        if (diagnosticInitializers.length === 1 && owner === diagnosticInitializers[0]) return true;
        if (diagnosticOwners.length === 1 && owner === diagnosticOwners[0]) return true;
      }
      return false;
    };
    const unwrapIntrinsic = (node: ts.Node): ts.Node => {
      while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
      return node;
    };
    const intrinsicUse = (node: ts.Node): ts.Node => {
      while ((ts.isParenthesizedExpression(node.parent) || ts.isAsExpression(node.parent) || ts.isTypeAssertionExpression(node.parent) || ts.isNonNullExpression(node.parent) || ts.isSatisfiesExpression(node.parent)) && node.parent.expression === node) node = node.parent;
      return node;
    };
    const memberKeys = (node: ts.PropertyAccessExpression | ts.ElementAccessExpression): readonly string[] | undefined => {
      if (ts.isPropertyAccessExpression(node)) return [node.name.text];
      const type = checker.getTypeAtLocation(node.argumentExpression);
      const parts = type.isUnion() ? type.types : [type];
      return parts.every((part) => part.isStringLiteral() || part.isNumberLiteral() || !!(part.flags & ts.TypeFlags.ESSymbolLike))
        ? parts.flatMap((part) => part.isStringLiteral() || part.isNumberLiteral() ? [String(part.value)] : []) : undefined;
    };
    const sourceOwned = (symbol: ts.Symbol | undefined): boolean => !!symbol?.declarations?.some((declaration) => irPaths.includes(declaration.getSourceFile().fileName));
    const globalNamespace = (node: ts.Node): boolean => {
      node = unwrapIntrinsic(node);
      if (ts.isIdentifier(node)) return ["globalThis", "window", "self"].includes(node.text) && !sourceOwned(accessSymbol(checker, node));
      return (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && globalNamespace(node.expression)
        && !!memberKeys(node)?.some((key) => ["globalThis", "window", "self"].includes(key));
    };
    const intrinsicGlobal = (node: ts.Node): ts.Symbol | undefined => {
      node = unwrapIntrinsic(node);
      if (ts.isIdentifier(node)) {
        const symbol = accessSymbol(checker, node);
        return nonDomLibraryDeclaration(symbol) && symbol?.declarations?.some((declaration) => ts.isFunctionDeclaration(declaration) || ts.isModuleDeclaration(declaration) || ts.isVariableDeclaration(declaration) && ts.isVariableStatement(declaration.parent.parent) && ts.isSourceFile(declaration.parent.parent.parent)) ? symbol : undefined;
      }
      if (!(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) return;
      const receiver = checker.getTypeAtLocation(unwrapIntrinsic(node.expression));
      return memberKeys(node)?.map((key) => checker.getPropertyOfType(receiver, key)).find((symbol) => {
        if (!nonDomLibraryDeclaration(symbol)) return false;
        if (globalNamespace(node.expression)) return true;
        // Namespaces such as Intl expose constructors as library members too.
        return !!symbol && checker.getTypeOfSymbolAtLocation(symbol, node).getConstructSignatures().length > 0;
      });
    };
    // Classify at the original expression, before an assertion/contextual slot
    // can erase its identity. Library instance methods alone are not intrinsics.
    const intrinsicObject = (node: ts.Node): boolean => {
      node = unwrapIntrinsic(node);
      if (globalNamespace(node) || intrinsicGlobal(node)) return true;
      if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && memberKeys(node)?.includes("prototype") && !!intrinsicGlobal(node.expression)) return true;
      if (ts.isCallExpression(node)) {
        const call = unwrapIntrinsic(node.expression);
        if (ts.isPropertyAccessExpression(call) || ts.isElementAccessExpression(call)) {
          const receiver = unwrapIntrinsic(call.expression);
          const prototype = (ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver)) && memberKeys(receiver)?.includes("prototype") && !!intrinsicGlobal(receiver.expression);
          // Prototype methods may return their receiver (reverse/valueOf), as
          // can inherited Object/Function methods on a constructor/namespace.
          const inherited = memberKeys(call)?.some((key) => ["valueOf", "bind", "call", "apply"].includes(key));
          if (intrinsicObject(receiver) && (prototype || inherited)) {
            const keys = memberKeys(call);
            const original = keys?.length === 1 ? checker.getPropertyOfType(checker.getTypeAtLocation(receiver), keys[0]!) : undefined;
            const signatures = original ? checker.getTypeOfSymbolAtLocation(original, call).getCallSignatures() : [];
            // Read the original method signature before a structural assertion
            // can claim that a receiver-returning method produces a primitive.
            return !signatures.length || signatures.some((signature) => carriedType(checker, checker.getReturnTypeOfSignature(signature), (type) => !!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive | ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter))));
          }
        }
      }
      return false;
    };
    const receiverOnly = (node: ts.Node): boolean => {
      const use = intrinsicUse(node), parent = use.parent;
      if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === use) return true;
      if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === use) return true;
      if (ts.isTypeOfExpression(parent)) return true;
      return ts.isBinaryExpression(parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.InKeyword, ts.SyntaxKind.InstanceOfKeyword].includes(parent.operatorToken.kind);
    };
    const prototypeGetter = (node: ts.Node, seen = new Set<ts.Symbol>()): boolean => {
      node = unwrapIntrinsic(node);
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        return !!memberKeys(node)?.includes("getPrototypeOf") && ["Object", "Reflect"].includes(intrinsicGlobal(node.expression)?.name ?? "");
      }
      if (!ts.isIdentifier(node)) return false;
      const symbol = accessSymbol(checker, node);
      if (!symbol || seen.has(symbol)) return false;
      seen.add(symbol);
      const declaration = symbol.valueDeclaration;
      return !!declaration && ts.isVariableDeclaration(declaration) && !!declaration.initializer && prototypeGetter(declaration.initializer, seen);
    };
    const unknownPrototypeResult = (node: ts.Node): boolean => {
      const use = intrinsicUse(node), parent = use.parent;
      if (ts.isCallExpression(parent) && parent.expression === use) return !!(checker.getTypeAtLocation(parent).flags & ts.TypeFlags.Unknown);
      if (!ts.isVariableDeclaration(parent) || parent.initializer !== use || !parent.type) return false;
      const signatures = checker.getTypeAtLocation(parent.type).getCallSignatures();
      return signatures.length > 0 && signatures.every((signature) => !!(checker.getReturnTypeOfSignature(signature).flags & ts.TypeFlags.Unknown));
    };
    const globalRoot = (node: ts.Node, seen = new Set<ts.Node>()): boolean => {
      while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) node = node.expression;
      if (!ts.isIdentifier(node) || seen.has(node)) return false;
      seen.add(node);
      const symbol = accessSymbol(checker, node);
      if (node.text === "globalThis" && !symbol?.declarations?.some((declaration) => irPaths.includes(declaration.getSourceFile().fileName))) return true;
      const declaration = symbol?.valueDeclaration;
      return !!declaration && ts.isVariableDeclaration(declaration) && !!declaration.initializer && !!(declaration.parent.flags & ts.NodeFlags.Const) && globalRoot(declaration.initializer, seen);
    };
    const builtinTarget = (node: ts.Node, seen = new Set<ts.Node>()): boolean => {
      if (intrinsicObject(node)) return true;
      while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
      if (seen.has(node)) return false;
      seen.add(node);
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        // Check the property's declaration, not the path used to reach its receiver:
        // parameters, mutable aliases, containers and call results retain lib symbols.
        const keyType = ts.isElementAccessExpression(node) ? checker.getTypeAtLocation(node.argumentExpression) : undefined;
        if (keyOf(node) === "__proto__" || keyType?.isStringLiteral() && keyType.value === "__proto__") return true;
        const property = accessSymbol(checker, node) ?? (keyType?.isStringLiteral() ? checker.getPropertyOfType(checker.getTypeAtLocation(node.expression), keyType.value) : undefined);
        if (nonDomLibraryDeclaration(property)) return true;
        if (globalRoot(node.expression)) return libraryDeclaration(accessSymbol(checker, node)) && !domDeclaration(accessSymbol(checker, node));
        return builtinTarget(node.expression, seen);
      }
      if (!ts.isIdentifier(node)) return false;
      const symbol = accessSymbol(checker, node);
      if (node.text === "globalThis" && !symbol?.declarations?.some((declaration) => irPaths.includes(declaration.getSourceFile().fileName))) return true;
      if (libraryDeclaration(symbol) && !domDeclaration(symbol)) return true;
      // Retain intrinsic origins through immutable aliases, even a widened structural annotation.
      const declaration = symbol?.valueDeclaration;
      return !!declaration && ts.isVariableDeclaration(declaration) && !!declaration.initializer && !!(declaration.parent.flags & ts.NodeFlags.Const) && builtinTarget(declaration.initializer, seen);
    };
    const styleTarget = (node: ts.Node): boolean => {
      while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) node = node.expression;
      if (!(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) return false;
      const name = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : "";
      return ["style", "cssText"].includes(name) || styleTarget(node.expression);
    };
    const originalWriteSlot = (node: ts.Node): ts.Type | undefined => {
      if (!(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) || !ts.isIdentifier(node.expression)) return;
      const receiver = checker.getTypeAtLocation(node.expression);
      const index = checker.getIndexTypeOfType(receiver, ts.IndexKind.String);
      if (!index || !(index.flags & ts.TypeFlags.Unknown)) return;
      const symbol = checker.getSymbolAtLocation(node.expression);
      const declaration = symbol?.valueDeclaration;
      if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer || !(declaration.parent.flags & ts.NodeFlags.Const)) return;
      const key = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
      if (key === undefined) return;
      return memberType(checker, checker.getTypeAtLocation(declaration.initializer), key, node);
    };
    const relation = (n: ts.Node, source: ts.Type, target: ts.Type | undefined): void => {
      if (!target) return;
      let value = ts.isReturnStatement(n) && n.expression ? n.expression : n;
      while (ts.isParenthesizedExpression(value)) value = value.expression;
      // Fresh literals have no retained narrow alias. Their nested expressions
      // are independently audited against their contextual writable slots.
      const aliasWrites = !ts.isObjectLiteralExpression(value) && !ts.isArrayLiteralExpression(value);
      const issue = textRelation(checker, source, target, relationTypes, n, aliasWrites);
      if (issue) mint(n, `Unsafe text type relation (${issue})`, branded(checker, target) ? target : undefined);
    };
    const callable = narrowCallableGuard(checker, s);
    const callableSlot = (n: ts.Expression): ts.Type | undefined => {
      const bindingInitializer = ts.isVariableDeclaration(n.parent) && n.parent.initializer === n && (ts.isObjectBindingPattern(n.parent.name) || ts.isArrayBindingPattern(n.parent.name));
      if (bindingInitializer) return checker.getTypeAtLocation(n.parent.name);
      const contextual = checker.getContextualType(n);
      if (contextual) return contextual;
      const parent = n.parent;
      if ((ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)) && parent.initializer === n) return checker.getTypeAtLocation(parent.name);
      if (ts.isPropertyAssignment(parent) && parent.initializer === n) return memberType(checker, checker.getTypeAtLocation(parent.parent), parent.name.getText(s).replace(/^['"]|['"]$/g, ""), n);
      if (ts.isShorthandPropertyAssignment(parent)) return memberType(checker, checker.getTypeAtLocation(parent.parent), parent.name.text, n);
      if (ts.isArrayLiteralExpression(parent)) return memberType(checker, checker.getTypeAtLocation(parent), String(parent.elements.indexOf(n)), n) ?? checker.getIndexTypeOfType(checker.getTypeAtLocation(parent), ts.IndexKind.Number);
      if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression !== n) {
        const signature = checker.getResolvedSignature(parent);
        if (signature) return signatureParameter(checker, signature, parent.arguments?.indexOf(n) ?? -1);
      }
      if (ts.isReturnStatement(parent) || ts.isArrowFunction(parent) && parent.body === n) {
        const owner = ts.isArrowFunction(parent) ? parent : enclosingFunctionNode(parent);
        const signature = owner && checker.getSignatureFromDeclaration(owner as ts.SignatureDeclaration);
        if (signature) return checker.getReturnTypeOfSignature(signature);
      }
      if (ts.isBinaryExpression(parent) && parent.right === n && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return checker.getTypeAtLocation(parent.left);
      if (ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent) || ts.isSatisfiesExpression(parent)) return checker.getTypeAtLocation(parent.type);
      if (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent) || ts.isConditionalExpression(parent) || ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent)) return checker.getTypeAtLocation(parent);
      return;
    };
    const approvedPresence = (n: ts.Node): boolean => {
      if (file !== presence.file) return false;
      let condition = n;
      while (ts.isParenthesizedExpression(condition.parent) || ts.isPrefixUnaryExpression(condition.parent) && condition.parent.operator === ts.SyntaxKind.ExclamationToken || ts.isBinaryExpression(condition.parent) && condition.parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) condition = condition.parent;
      if (!(ts.isIfStatement(condition.parent) && condition.parent.expression === condition || ts.isConditionalExpression(condition.parent) && condition.parent.condition === condition)) return false;
      const declaration = s.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === presence.function);
      const symbols = declaration?.parameters.filter((parameter) => presence.parameters.some((name) => parameter.name.getText(s) === name)).map((parameter) => checker.getSymbolAtLocation(parameter.name)) ?? [];
      const callback = (value: ts.Node): boolean => ts.isIdentifier(value) ? symbols.includes(checker.getSymbolAtLocation(value)) : ts.isParenthesizedExpression(value) ? callback(value.expression) : ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && callback(value.right);
      const allowed = callback(n);
      if (allowed) for (const parameter of declaration?.parameters ?? []) {
        if (ts.isIdentifier(n) && checker.getSymbolAtLocation(n) === checker.getSymbolAtLocation(parameter.name)) presenceUsed.add(parameter.name.getText(s));
      }
      return allowed;
    };
    const writeTarget = (n: ts.Node, source: ts.Type): void => {
      if (ts.isObjectLiteralExpression(n) || ts.isObjectBindingPattern(n)) {
        for (const property of ts.isObjectLiteralExpression(n) ? n.properties : n.elements) {
          if (ts.isSpreadAssignment(property) || ts.isBindingElement(property) && property.dotDotDotToken) { writeTarget(ts.isSpreadAssignment(property) ? property.expression : property.name, source); continue; }
          const key = ts.isBindingElement(property) ? property.propertyName ?? property.name : property.name;
          if (!key) continue;
          const name = key.getText(s).replace(/^['"]|['"]$/g, "");
          const value = memberType(checker, source, name, n) ?? checker.getIndexTypeOfType(source, ts.IndexKind.String);
          const target = ts.isPropertyAssignment(property) ? property.initializer : ts.isBindingElement(property) ? property.name : property.name;
          if (value && target) writeTarget(target, value);
        }
      } else if (ts.isArrayLiteralExpression(n) || ts.isArrayBindingPattern(n)) {
        for (const [index, element] of n.elements.entries()) {
          if (ts.isOmittedExpression(element)) continue;
          const value = memberType(checker, source, String(index), n) ?? checker.getIndexTypeOfType(source, ts.IndexKind.Number);
          if (value) writeTarget(ts.isBindingElement(element) ? element.name : ts.isSpreadElement(element) ? element.expression : element, value);
        }
      } else if (ts.isParenthesizedExpression(n)) writeTarget(n.expression, source);
      else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) writeTarget(n.left, source);
      else {
        const symbol = accessSymbol(checker, n);
        const setter = symbol?.declarations?.find(ts.isSetAccessorDeclaration)?.parameters[0];
        relation(n, source, setter ? checker.getTypeAtLocation(setter) : checker.getTypeAtLocation(n));
      }
    };
    const walk = (n: ts.Node): void => {
      if (ts.isVariableStatement(n) && [...captureStatements.values()].includes(n)) return;
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) add("inventory", n, "IR runtime dynamic imports are outside the reviewed four-file graph");
      if (runtimeExpression(n) && (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n))) {
        // The sole existing diagnostic capture is already pinned byte-for-byte;
        // it is subsequently subject to the stricter counter-only projection.
        const diagnosticCapture = file === "dashboard-ir.ts" && ts.isIdentifier(n) && n.text === "globalThis" && ts.isAsExpression(n.parent) && ts.isVariableDeclaration(n.parent.parent) && ts.isIdentifier(n.parent.parent.name) && n.parent.parent.name.text === "textDiagnostics" && n.parent.parent.parent.parent.parent === s && n.parent.getText(s) === "globalThis as typeof globalThis & { __PCC_UI_TEXT_VIOLATIONS__?: number }";
        if (intrinsicObject(n) && !receiverOnly(n) && !diagnosticCapture) add("intrinsic-escape", n, "Intrinsic globals, constructors and prototypes may only be direct receivers, callees or comparison operands");
        if (prototypeGetter(n) && !unknownPrototypeResult(n)) add("intrinsic-escape", n, "getPrototypeOf must be a direct unknown-result callee or initialize an explicitly unknown-returning function");
      }
      if (!inTypePosition(n) && (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n))) {
        const keys = memberKeys(n);
        if (keys?.includes("constructor")) add("builtin-write", n, "constructor is forbidden by name on every receiver");
        if (keys?.includes("__proto__")) add("builtin-write", n, "__proto__ is forbidden by name on every receiver");
        if (keys?.includes("compile")) add("builtin-write", n, "compile is forbidden by name on every receiver");
        if (keys?.includes("__defineGetter__")) add("builtin-write", n, "__defineGetter__ is forbidden by name on every receiver");
        if (keys?.includes("__defineSetter__")) add("builtin-write", n, "__defineSetter__ is forbidden by name on every receiver");
        if (keys?.includes("__lookupGetter__")) add("builtin-write", n, "__lookupGetter__ is forbidden by name on every receiver");
        if (keys?.includes("__lookupSetter__")) add("builtin-write", n, "__lookupSetter__ is forbidden by name on every receiver");
        // An arbitrary string key can name any forbidden method. Fail closed
        // for callable/opaque-object reads, even through a structural index or
        // assertion. Data lookups and finite safe key unions keep their types.
        if (!keys && [n, intrinsicUse(n)].some((use) => carriedType(checker, checker.getTypeAtLocation(use), (type) => !!(type.flags & ts.TypeFlags.NonPrimitive) || type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0))) add("builtin-write", n, "Unresolved callable or opaque-object member keys can conceal forbidden intrinsic methods");
        if (!keys && intrinsicObject(n.expression)) add("intrinsic-escape", n, "Unresolved intrinsic members can conceal constructor or prototype acquisition");
      }
      if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) {
        const key = n.propertyName ?? n.name;
        const type = ts.isComputedPropertyName(key) ? checker.getTypeAtLocation(key.expression) : undefined;
        const parts = type?.isUnion() ? type.types : type ? [type] : [];
        const finite = !type || parts.every((part) => part.isStringLiteral() || part.isNumberLiteral() || !!(part.flags & ts.TypeFlags.ESSymbolLike));
        const names = ts.isIdentifier(key) || ts.isStringLiteral(key) ? [key.text] : parts.flatMap((part) => part.isStringLiteral() || part.isNumberLiteral() ? [String(part.value)] : []);
        if (names.includes("constructor")) add("builtin-write", n, "constructor cannot be destructured from any receiver");
        if (names.some((name) => ["__proto__", "compile", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"].includes(name))) add("builtin-write", n, "Forbidden intrinsic member names cannot be destructured");
        if (!finite && carriedType(checker, checker.getTypeAtLocation(n.name), (part) => !!(part.flags & ts.TypeFlags.NonPrimitive) || part.getCallSignatures().length > 0 || part.getConstructSignatures().length > 0)) add("builtin-write", n, "Unresolved callable or opaque-object destructuring can conceal forbidden intrinsic methods");
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        if (builtinTarget(n.left)) add("builtin-write", n, "Writes to intrinsic declarations or objects are forbidden");
        const originalSlot = originalWriteSlot(n.left);
        if (originalSlot && !checker.isTypeAssignableTo(checker.getTypeAtLocation(n.right), originalSlot)) add("input-type", n, "A widened index view cannot replace a retained narrower value with an incompatible input");
        if (file === "dashboard-ir-renderer.ts" && styleTarget(n.left)) add("style-write", n, "Renderer style and cssText writes can replace provenance captions");
      }
      if (ts.isDeleteExpression(n) && builtinTarget(n.expression)) add("builtin-write", n, "Deleting intrinsic properties is forbidden");
      if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) && builtinTarget(n.operand)) add("builtin-write", n, "Updating intrinsic properties is forbidden");
      if (ts.isCallExpression(n) && (ts.isPropertyAccessExpression(n.expression) || ts.isElementAccessExpression(n.expression))) {
        const name = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : ts.isStringLiteral(n.expression.argumentExpression) ? n.expression.argumentExpression.text : "";
        if (n.arguments[0] && ["defineProperty", "defineProperties", "set", "setPrototypeOf", "assign"].includes(name) && libraryDeclaration(accessSymbol(checker, n.expression)) && builtinTarget(n.arguments[0])) add("builtin-write", n, "Reflective writes to intrinsic objects are forbidden");
        const keyType = ts.isElementAccessExpression(n.expression) ? checker.getTypeAtLocation(n.expression.argumentExpression) : undefined;
        const member = name || (keyType?.isStringLiteral() ? keyType.value : "");
        const symbol = accessSymbol(checker, n.expression) ?? checker.getPropertyOfType(checker.getTypeAtLocation(n.expression.expression), member);
        if (["__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"].includes(member)) add("builtin-write", n, "Accessor reflection is forbidden on every receiver");
        if (member === "compile" && nonDomLibraryDeclaration(symbol) && symbol?.declarations?.some((declaration) => ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === "RegExp")) add("builtin-write", n, "RegExp.compile mutates shared validator state");
        if (file === "dashboard-ir-renderer.ts" && name === "setProperty") add("style-write", n, "Renderer setProperty can replace provenance captions");
      }
      if (ts.isExportSpecifier(n)) {
        const name = (n.propertyName ?? n.name).text;
        if (BRAND_STORES.has(name) || CAPTURES.has(name) || name === "textDiagnostics") add("brand-confinement", n, "Runtime brand state and primitives cannot be exported");
        if (name === "kitText") add("mint", n, "kitText cannot be exposed as an exported value");
      }
      if (ts.isVariableStatement(n) && n.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) for (const declaration of n.declarationList.declarations) if (ts.isIdentifier(declaration.name) && (BRAND_STORES.has(declaration.name.text) || CAPTURES.has(declaration.name.text) || declaration.name.text === "textDiagnostics")) add("brand-confinement", n, "Runtime brand state and primitives must be module private");
      if (valueReference(n) && ts.isIdentifier(n)) {
        const declaration = accessSymbol(checker, n)?.valueDeclaration;
        const declaredHere = !!declaration && declaration.getSourceFile() === s && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name);
        if (declaredHere && (BRAND_STORES.has(n.text) || CAPTURES.has(n.text)) && !ownedBrandReference(n)) add("brand-confinement", n, "Brand stores and captured primitives stay inside the exact runtime brand declarations");
        if (declaredHere && n.text === "textDiagnostics" && !ownedDiagnosticReference(n)) add("brand-confinement", n, "The diagnostic global is only the direct receiver of its counter inside textViolation or its exact initialization");
      }
      if ((file === "dashboard-ir.ts" || file === "dashboard-ir-binder.ts") && (ts.isCallExpression(n) || ts.isNewExpression(n))) {
        const call = n.expression;
        const name = ts.isIdentifier(call) ? call.text : ts.isPropertyAccessExpression(call) ? call.name.text : ts.isElementAccessExpression(call) && ts.isStringLiteral(call.argumentExpression) ? call.argumentExpression.text : "";
        if (ts.isNewExpression(n) && ["Text", "Option", "DOMParser", "Notification"].includes(name) || ts.isCallExpression(n) && ["append", "prepend", "before", "after", "replaceWith", "replaceChildren", "appendChild", "insertBefore", "replaceChild", "createTextNode", "insertAdjacentText", "appendData", "insertData", "replaceData", "replaceWholeText", "insertAdjacentHTML", "write", "writeln", "setHTMLUnsafe", "setHTML", "createContextualFragment", "parseFromString", "parseHTMLUnsafe", "setRangeText", "setCustomValidity", "insertRule", "replaceSync", "fillText", "strokeText", "execCommand", "setNamedItem", "setAttribute", "setAttributeNS", "setAttributeNode", "alert", "confirm", "prompt"].includes(name)) add("text-sink", n, `String-capable text API outside the browser entry: ${name}`);
      }
      if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
        const keyType = ts.isElementAccessExpression(n) ? checker.getTypeAtLocation(n.argumentExpression) : undefined;
        const key = ts.isPropertyAccessExpression(n) ? n.name.text : keyType?.isStringLiteral() ? keyType.value : undefined;
        if (key === "t" && branded(checker, checker.getTypeAtLocation(n.expression)) && !(ts.isCallExpression(n.expression) && accessSymbol(checker, n.expression.expression)?.declarations?.some((declaration) => ts.isFunctionDeclaration(declaration) && declaration.name?.text === "readText" && declaration.getSourceFile().fileName === irPaths[0]))) add("brand-read", n, "Brand text must be read only through the checked reader");
      }
      if (runtimeExpression(n) && callable.carries(checker.getTypeAtLocation(n))) {
        const type = checker.getTypeAtLocation(n);
        const parent = n.parent;
        const directCall = (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === n;
        const projection = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === n && !type.getCallSignatures().length && !type.getConstructSignatures().length;
        const target = callableSlot(n as ts.Expression);
        if (!directCall && !projection && !approvedPresence(n) && (!target || !callable.safe(type, target))) add("mint", n, "Branded-parameter callable may only be a direct callee or enter a slot retaining its parameter brands");
      }
      if (ts.isMethodDeclaration(n) && n.name) {
        const type = checker.getTypeAtLocation(n.name);
        if (callable.carries(type) && !callable.safe(type, type)) add("mint", n, "Merged/overloaded method widens a branded parameter");
      }
      if (runtimeExpression(n) && !ts.isAsExpression(n.parent) && !ts.isTypeAssertionExpression(n.parent)) {
        const nullishOperand = ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && n.parent.left === n;
        const bindingInitializer = ts.isVariableDeclaration(n.parent) && n.parent.initializer === n && (ts.isObjectBindingPattern(n.parent.name) || ts.isArrayBindingPattern(n.parent.name));
        // The checker invents Any-valued contextual members for binding patterns;
        // writeTarget instead projects the source into each actual binding slot.
        if (!bindingInitializer) relation(n, nullishOperand ? checker.getNonNullableType(checker.getTypeAtLocation(n)) : checker.getTypeAtLocation(n), checker.getContextualType(n as ts.Expression));
      }
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const resolved = checker.getResolvedSignature(n);
        const original = resolved?.declaration && resolved.declaration.kind !== ts.SyntaxKind.JSDocSignature && checker.getSignatureFromDeclaration(resolved.declaration);
        if (original) for (const [index, argument] of (n.arguments ?? []).entries()) {
          const target = signatureParameter(checker, original, index);
          if (!target) continue;
          const hasConstraint = carriedType(checker, target, (type) => !!(type.flags & ts.TypeFlags.TypeParameter) && !!checker.getBaseConstraintOfType(type) && !(checker.getBaseConstraintOfType(type)!.flags & ts.TypeFlags.Unknown));
          if (hasConstraint) relation(argument, checker.getTypeAtLocation(argument), target);
        }
      }
      if ((ts.isVariableDeclaration(n) || ts.isPropertyDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) && n.initializer) {
        if (ts.isObjectBindingPattern(n.name) || ts.isArrayBindingPattern(n.name)) writeTarget(n.name, checker.getTypeAtLocation(n.initializer));
        else relation(n.initializer, checker.getTypeAtLocation(n.initializer), checker.getTypeAtLocation(n.name));
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        const op = n.operatorToken.kind;
        const source = op === ts.SyntaxKind.EqualsToken ? checker.getTypeAtLocation(n.right) : checker.getTypeAtLocation(n);
        writeTarget(n.left, source);
        relation(n, source, checker.getTypeAtLocation(n.left));
      }
      if (ts.isForInStatement(n) || ts.isForOfStatement(n)) {
        const elements = ts.isForInStatement(n) ? [checker.getStringType()] : iterableElements(checker, checker.getTypeAtLocation(n.expression), n, !!n.awaitModifier);
        for (const source of elements) {
          if (ts.isVariableDeclarationList(n.initializer)) for (const declaration of n.initializer.declarations) writeTarget(declaration.name, source);
          else { relation(n, source, checker.getTypeAtLocation(n.initializer)); writeTarget(n.initializer, source); }
        }
      }
      if (ts.isSatisfiesExpression(n) || ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) relation(n, checker.getTypeAtLocation(n.expression), checker.getTypeAtLocation(n.type));
      if (ts.isReturnStatement(n) && n.expression) {
        const owner = enclosingFunctionNode(n);
        const signature = owner && checker.getSignatureFromDeclaration(owner as ts.SignatureDeclaration);
        if (signature) relation(n, checker.getTypeAtLocation(n.expression), checker.getReturnTypeOfSignature(signature));
      }
      if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
        const symbol = n.name ? checker.getSymbolAtLocation(n.name) : checker.getTypeAtLocation(n).getSymbol();
        if (symbol) for (const clause of n.heritageClauses ?? []) for (const type of clause.types) {
          relation(n, checker.getDeclaredTypeOfSymbol(symbol), checker.getTypeAtLocation(type));
          if (clause.token === ts.SyntaxKind.ExtendsKeyword) relation(n, checker.getTypeOfSymbolAtLocation(symbol, n.name ?? n), checker.getTypeAtLocation(type.expression));
        }
      }
      if (ts.isTypeReferenceNode(n) || ts.isImportTypeNode(n)) {
        const symbol = checker.getTypeAtLocation(n).getSymbol();
        if (symbol && ["RElement", "RDocument"].includes(symbol.name) && symbol.declarations?.some((d) => d.getSourceFile().fileName === irPaths[1])) wrappedDomFiles.set(relative(src, s.fileName), n);
      }
      if (runtimeExpression(n) && checker.getTypeAtLocation(n).flags & ts.TypeFlags.Any) add("any", n, `Any-typed expression: ${n.getText(s)}`);
      if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) {
        const target = checker.getTypeAtLocation(n.type);
        if (target.flags & (ts.TypeFlags.Any | ts.TypeFlags.Never)) add("assertion", n, "Assertions to any or never are forbidden");
        if (unresolvedAssertion(checker, target)) add("assertion", n, "Generic/unevaluated assertion targets can instantiate a text brand and are forbidden");
        let inner: ts.Expression = n.expression;
        while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
        if (checker.getTypeAtLocation(n.expression).flags & ts.TypeFlags.Unknown && (target.flags & ts.TypeFlags.Object || target.isUnionOrIntersection() && target.types.some((t) => t.flags & ts.TypeFlags.Object))) add("assertion", n, "Unknown-to-object assertions are forbidden");
        if (branded(checker, target)) mint(n, undefined, target);
      }
      if (ts.isCallExpression(n) && nonliteralKitCall(checker, n)) mint(n);
      if (runtimeExpression(n)) {
        const symbol = accessSymbol(checker, n);
        const registrar = symbol?.declarations?.find((declaration) => ts.isFunctionDeclaration(declaration) && declaration.parent === declaration.getSourceFile()
          && declaration.getSourceFile().fileName === irPaths[0] && REGISTRARS.some((name) => declaration.name?.text === name));
        const copyMint = symbol?.declarations?.some((declaration) => ts.isFunctionDeclaration(declaration) && declaration.parent === declaration.getSourceFile() && declaration.getSourceFile().fileName === irPaths[0] && declaration.name?.text === "kitText");
        if (copyMint && !(ts.isCallExpression(n.parent) && n.parent.expression === n)) add("mint", n, "kitText may only be a direct literal-checked callee");
        if (registrar) {
          const parent = n.parent;
          if (ts.isCallExpression(parent) && parent.expression === n) mint(parent, "Runtime registrar use outside closed mint list", checker.getReturnTypeOfSignature(checker.getResolvedSignature(parent)!));
          else add("mint", n, "Runtime registrars cannot be aliased or exposed");
        }
      }
      if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) {
        const signature = checker.getSignatureFromDeclaration(n);
        if (signature) {
          const predicate = checker.getTypePredicateOfSignature(signature)?.type;
          if (n.type && ts.isTypePredicateNode(n.type) && predicate && (branded(checker, predicate) || unresolvedAssertion(checker, predicate))) mint(n, "Type predicates must not manufacture text brands", predicate);
          if (!n.body && !(file === "dashboard-ir.ts" && ts.isFunctionDeclaration(n) && n.parent === s && n.name?.text === "readText") && branded(checker, checker.getReturnTypeOfSignature(signature))) mint(n, "Overload/ambient signatures must not manufacture text brands", checker.getReturnTypeOfSignature(signature));
        }
      }
      if (ts.isTypePredicateNode(n) && n.type) {
        const target = checker.getTypeAtLocation(n.type);
        if (branded(checker, target) || unresolvedAssertion(checker, target)) mint(n, "Type predicates must not manufacture text brands", target);
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
        const rhs = checker.getTypeAtLocation(n.right);
        if (rhs.getConstructSignatures().some((sig) => branded(checker, checker.getReturnTypeOfSignature(sig)))) add("mint", n, "instanceof must not narrow into a text brand");
      }
      if (ts.isComputedPropertyName(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.getText(s) === "Symbol" && n.expression.name.text === "hasInstance") add("mint", n, "Symbol.hasInstance can manufacture branded narrowing");
      if (ts.isVariableDeclaration(n) && !n.initializer && n.type && branded(checker, checker.getTypeAtLocation(n.type))) {
        const statement = n.parent.parent;
        if (ts.isVariableStatement(statement) && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) mint(n, "Ambient values must not manufacture text brands", checker.getTypeAtLocation(n.type));
      }
      const reflection = reflectionViolation(checker, n);
      if (reflection) add("reflection", n, reflection);
      if (valueReference(n)) {
        const symbol = accessSymbol(checker, n);
        const diagnosticCapture = file === "dashboard-ir.ts" && ts.isIdentifier(n) && n.text === "globalThis" && ts.isAsExpression(n.parent) && ts.isVariableDeclaration(n.parent.parent) && ts.isIdentifier(n.parent.parent.name) && n.parent.parent.name.text === "textDiagnostics" && n.parent.parent.parent.parent.parent === s && n.parent.getText(s) === "globalThis as typeof globalThis & { __PCC_UI_TEXT_VIOLATIONS__?: number }";
        if (file !== "dashboard-ir-browser-entry.ts" && ts.isIdentifier(n) && ["globalThis", "self", "window"].includes(n.text) && !diagnosticCapture && (!symbol?.declarations?.length || !symbol.declarations.some((declaration) => irPaths.includes(declaration.getSourceFile().fileName)))) {
          result.domFiles.add(relative(src, s.fileName));
          add("dom", n, "Browser global outside the browser entry");
        }
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
      const owner = ts.isFunctionLike(n) ? n : enclosingFunctionNode(n);
      if (owner && runtimeInternals.has(fn) && runtimeInternals.get(fn) === owner && (context.startsWith("Unsafe text type relation (") || context === "Text mint outside closed function list" && (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)))) return;
      result.minted.add(key);
      const agentMint = !!target && carriedType(checker, target, (t) => !!checker.getPropertyOfType(t, "__agentText"));
      const kitMint = !target || carriedType(checker, target, (t) => !!checker.getPropertyOfType(t, "__kitText"));
      const agentFunction = file === "dashboard-ir-renderer.ts" && fn === "manifestProseText";
      if (agentMint && !agentFunction) add("mint", n, "AgentText may be minted only by manifestProseText");
      if (kitMint && agentFunction) add("mint", n, "manifestProseText must preserve AgentText authorship and cannot mint KitText");
      if (!owner || declarations.get(fn) !== owner) add("mint", n, `${context}: ${key}`);
    };
    walk(s);
  }
  if (JSON.stringify(IR_FILES.map((file) => `packages/gateway/src/mcp/${file}`).sort()) !== JSON.stringify([...bundled].sort())) result.findings.push({ rule: "inventory", file: "<inventory>", line: 0, detail: "Guard files differ from build metafile input allowlist" });
  for (const file of new Set([...wrappedDomFiles.keys(), ...result.domFiles])) if (!targets.includes(file.replace(/^mcp\//, ""))) {
    const node = wrappedDomFiles.get(file);
    if (node) add("inventory", node, "IR DOM recipient is not a lint target");
    else result.findings.push({ rule: "inventory", file, line: 0, detail: "IR DOM recipient is not a lint target" });
  }
  for (const parameter of presence.parameters) if (!presenceUsed.has(parameter)) result.findings.push({ rule: "stale-presence", file: presence.file, line: 0, detail: `Stale callable presence allowance: ${presence.function}:${parameter}` });
  for (const entry of mints) if (!result.minted.has(mintKey(entry.file, entry.function))) result.findings.push({ rule: "stale-mint", file: entry.file, line: 0, detail: `Stale mint allowance: ${entry.function}` });
  for (const entry of dom) if (!result.domUsed.has(entry.name)) result.findings.push({ rule: "stale-dom", file: "<allowlist>", line: 0, detail: `Stale DOM allowance: ${entry.name}` });
  return result;
}
export function importedText(s: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  const add = (n: ts.Node, detail: string): void => { findings.push({ rule: "import", file: relative(src, s.fileName), line: s.getLineAndCharacterOfPosition(n.getStart(s)).line + 1, detail }); };
  const permitted = permittedImporters.has(s.fileName);
  const registrarAllowed = (name: string): boolean => !!REGISTRAR_IMPORTERS.get(s.fileName)?.includes(name);
  if (permitted) {
    const registrarImports = (n: ts.Node): void => {
      if ((ts.isImportSpecifier(n) || ts.isExportSpecifier(n)) && REGISTRARS.some((name) => (n.propertyName ?? n.name).text === name)
        && (ts.isExportSpecifier(n) || !registrarAllowed((n.propertyName ?? n.name).text))) add(n, "Runtime registrar import/export outside declared mint modules");
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && /(?:^|\/)dashboard-ir(?:\.js)?$/.test(n.moduleSpecifier.text)
        && (n.importClause?.name || n.importClause?.namedBindings && ts.isNamespaceImport(n.importClause.namedBindings))) add(n, "Runtime registrars require reviewed named imports");
      if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && /(?:^|\/)dashboard-ir(?:\.js)?$/.test(n.moduleSpecifier.text)
        && (!n.exportClause || ts.isNamespaceExport(n.exportClause))) add(n, "Runtime registrar modules cannot be re-exported as a whole");
      ts.forEachChild(n, registrarImports);
    };
    registrarImports(s);
    return findings;
  }
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
export function allTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? allTsFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);
}
export function overriddenProgram(overrides: Map<string, string>, parsed = config): ts.Program {
  overrides = new Map([...overrides].map(([path, text]) => [path, text.replace(/\r\n/g, "\n")]));
  const host = ts.createCompilerHost(parsed.options);
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
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, host, oldProgram: program });
}

export const MUTATIONS = [
  {"name":"r2g X21 core instance constructor member","file":"dashboard-ir.ts","rule":"builtin-write","code":"export function probeCoreX21(raw: string): KitText {\n  const p = (new Set<unknown>() as { constructor: { prototype: { has(v: unknown): boolean } } }).constructor.prototype;\n  return boundStatusText(raw);\n}","lineOffset":1},
  {"name":"r2g X21 binder instance constructor member","file":"dashboard-ir-binder.ts","rule":"builtin-write","code":"export function probeBinderX21(status: number): KitText {\n  const p = (new Set<unknown>() as { constructor: { prototype: { has(v: unknown): boolean } } }).constructor.prototype;\n  return httpStatusText(status);\n}","lineOffset":1},
  {"name":"r2g X21 core constructor destructuring","file":"dashboard-ir.ts","rule":"builtin-write","code":"export function probeCoreConstructorBinding(raw: string): KitText {\n  const { constructor: owner } = new Set<unknown>();\n  return boundStatusText(raw);\n}","lineOffset":1},
  {"name":"r2g X21 binder constructor destructuring","file":"dashboard-ir-binder.ts","rule":"builtin-write","code":"export function probeBinderConstructorBinding(status: number): KitText {\n  const { constructor: owner } = new Set<unknown>();\n  return httpStatusText(status);\n}","lineOffset":1},
  {"name": "r2f N9 exact capture initializer TEXT_STORE_GET", "file": "dashboard-ir.ts", "rule": "captures-first", "needle": "= WeakMap.prototype.get;", "code": "= (WeakMap.prototype.get);"} ,
  {"name": "r2f N9 exact capture initializer TEXT_STORE_SET", "file": "dashboard-ir.ts", "rule": "captures-first", "needle": "= WeakMap.prototype.set;", "code": "= (WeakMap.prototype.set);"} ,
  {"name": "r2f N9 exact capture initializer TEXT_FREEZE", "file": "dashboard-ir.ts", "rule": "captures-first", "needle": "= Object.freeze;", "code": "= (Object.freeze);"} ,
  {"name": "r2f N9 exact capture initializer TEXT_APPLY", "file": "dashboard-ir.ts", "rule": "captures-first", "needle": "= Reflect.apply;", "code": "= (Reflect.apply);"} ,
  {"name": "r2f N9 diagnostic capture position", "file": "dashboard-ir.ts", "rule": "captures-first", "needle": "const textDiagnostics = globalThis", "code": "void 0;\nconst textDiagnostics = globalThis"} ,
  {"name": "r2f N9 unknown-to-union assertion", "file": "dashboard-ir-renderer.ts", "rule": "assertion", "code": "function probeUnknownUnion(value: unknown): { a: string } | { b: string } { return value as { a: string } | { b: string }; }"} ,

  {"name": "r2f O1 exact owner body registerKitText", "file": "dashboard-ir.ts", "rule": "brand-confinement", "needle": "export function registerKitText(t: string): KitText {", "code": "export function registerKitText(t: string): KitText { void 0;"} ,
  {"name": "r2f O1 exact owner body registerAgentText", "file": "dashboard-ir.ts", "rule": "brand-confinement", "needle": "export function registerAgentText(t: string): AgentText {", "code": "export function registerAgentText(t: string): AgentText { void 0;"} ,
  {"name": "r2f O1 exact owner body isKitText", "file": "dashboard-ir.ts", "rule": "brand-confinement", "needle": "export function isKitText(value: unknown): boolean {", "code": "export function isKitText(value: unknown): boolean { void 0;"} ,
  {"name": "r2f O1 exact owner body readText", "file": "dashboard-ir.ts", "rule": "brand-confinement", "needle": "export function readText(value: unknown, tier: \"kit\" | \"agent\" | \"authored\" = \"kit\"): KitText | AgentText {", "code": "export function readText(value: unknown, tier: \"kit\" | \"agent\" | \"authored\" = \"kit\"): KitText | AgentText { void 0;"} ,
  {"name": "r2f O1 exact owner body textViolation", "file": "dashboard-ir.ts", "rule": "brand-confinement", "needle": "function textViolation(): void {", "code": "function textViolation(): void { void 0;"} ,
  {"name": "r2f O1 Y03 owner edit leaks TEXT_BRANDS", "file": "dashboard-ir.ts", "rule": "brand-confinement", "needle": "export function registerKitText(t: string): KitText {", "code": "let probeLeakY03: object = {};\nexport function registerKitText(t: string): KitText { probeLeakY03 = TEXT_BRANDS;", "lineOffset": 1} ,

  {"name": "r2e4 fresh F11 unresolved global constructor acquisition", "file": "dashboard-ir-browser-entry.ts", "rule": "intrinsic-escape", "code": "function probeDynamicGlobal(): object { const key = [\"Reg\", \"Exp\"].join(\"\"); return (window as Window & { [key: string]: object })[key]!; }"} ,
  {"name": "r2e4 destructured unresolved computed callable key union", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeDestructuredComputed(p: { [key: string]: () => unknown }, key: \"safe\" | `com${string}`): unknown { const { [key]: fn } = p; return fn; }"} ,
  {"name": "r2e4 destructured compile name structural receiver", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeDestructuredCompile(p: { compile: unknown }): unknown { const { compile: fn } = p; return fn; }"} ,
  {"name": "r2e4 dynamic computed unknown result structural assertion", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeDynamicUnknown(p: { [key: string]: unknown }, key: string): void { const proto = p[key] as { has(v: unknown): boolean }; proto.has = () => true; }"} ,
  {"name": "r2e4 dynamic computed object result", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeDynamicObject(p: { [key: string]: object }, key: string): object { return p[key]!; }"} ,
  {"name": "r2e4 fresh F10 direct intrinsic valueOf result write", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeFresh10(): void { (Set.prototype.valueOf() as { has(v: unknown): boolean }).has = () => true; }"} ,
  {"name": "r2e4 fresh F09 nested Intl.Collator prototype alias", "file": "dashboard-ir-renderer.ts", "rule": "intrinsic-escape", "code": "function probeFresh09(): void { let p: { compare(a: string, b: string): number } = Intl.Collator.prototype; p.compare = () => 0; }"} ,
  {"name": "r2e4 fresh F08 intrinsic prototype reverse result alias", "file": "dashboard-ir-renderer.ts", "rule": "intrinsic-escape", "code": "function probeFresh08(): void { const p = Array.prototype.reverse() as { join(sep?: string): string }; p.join = () => \"forged\"; }"} ,
  {"name": "r2e4 fresh F07 intrinsic prototype valueOf result alias", "file": "dashboard-ir-renderer.ts", "rule": "intrinsic-escape", "code": "function probeFresh07(): void { const p = Set.prototype.valueOf() as { has(v: unknown): boolean }; p.has = () => true; }"} ,
  {"name": "r2e4 getPrototypeOf unknown alias retyped downstream", "file": "dashboard-ir-renderer.ts", "rule": "intrinsic-escape", "code": "function probePrototypeAliasRetyped(): unknown { const gp: (value: object) => unknown = Object.getPrototypeOf; const typed = gp as (value: object) => { has(v: unknown): boolean }; return typed(new Set<unknown>()); }"} ,
  {"name": "r2e4 N2b X01 structural let annotation: let s: { has(v: unknown): boolean } = Set.prototype; s.has = () => true; boundStatusText(raw)", "file": "dashboard-ir-renderer.ts", "rule": "intrinsic-escape", "code": "export function probeX01(d: RDocument, raw: string): RElement { let s: { has(v: unknown): boolean } = Set.prototype; const o = s.has; s.has = function (): boolean { return true; }; try { return el(d, \"pcc-x\", boundStatusText(raw)); } finally { s.has = o; } }"} ,
  {"name": "r2e4 N2b X02 structurally typed parameter: a helper writes p.has for p: { has(...) } = Set.prototype", "file": "dashboard-ir-renderer.ts", "rule": "intrinsic-escape", "code": "function probeSetHasX02(p: { has(v: unknown): boolean }, f: (v: unknown) => boolean): (v: unknown) => boolean { const o = p.has; p.has = f; return o; }\nexport function probeX02(d: RDocument, raw: string): RElement { const o = probeSetHasX02(Set.prototype, () => true); try { return el(d, \"pcc-x\", boundStatusText(raw)); } finally { probeSetHasX02(Set.prototype, o); } }", "lineOffset": 1} ,
  {"name": "r2e4 N2b X03 getter with a structural return type: box.p.join = ... where get p(): { join(...) } returns Array.prototype; joinKitText re-mints raw", "file": "dashboard-ir-renderer.ts", "rule": "intrinsic-escape", "code": "export function probeX03(d: RDocument, raw: string): RElement { const box = { get p(): { join(sep?: string): string } { return Array.prototype; } }; const o = box.p.join; box.p.join = function (): string { return raw; }; try { return el(d, \"pcc-x\", joinKitText(kitText(\"a\"), kitText(\"b\"))); } finally { box.p.join = o; } }"} ,
  {"name": "r2e4 N2b X04 this-typed helper: this.has = f, called with .call(Set.prototype, ...)", "file": "dashboard-ir-renderer.ts", "rule": "intrinsic-escape", "code": "function probeThisX04(this: { has(v: unknown): boolean }, f: (v: unknown) => boolean): (v: unknown) => boolean { const o = this.has; this.has = f; return o; }\nexport function probeX04(d: RDocument, raw: string): RElement { const o = probeThisX04.call(Set.prototype, () => true); try { return el(d, \"pcc-x\", boundStatusText(raw)); } finally { probeThisX04.call(Set.prototype, o); } }", "lineOffset": 1} ,
  {"name": "r2e4 N2b X12 let alias, structural assertion at the write: (s as { has(...) }).has = ...", "file": "dashboard-ir-renderer.ts", "rule": "intrinsic-escape", "code": "export function probeX12(d: RDocument, raw: string): RElement { let s = Set.prototype; const o = s.has; (s as { has(v: unknown): boolean }).has = function (): boolean { return true; }; try { return el(d, \"pcc-x\", boundStatusText(raw)); } finally { (s as { has(v: unknown): boolean }).has = o; } }"} ,
  {"name": "r2e4 N2b X15 structural assertion on the receiver of compile: (LIST_VERSION_RE as { compile(p: string): unknown }).compile(...) (W21's effect)", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "export function probeX15(d: RDocument, raw: string): RElement { const src = LIST_VERSION_RE.source; (LIST_VERSION_RE as { compile(p: string): unknown }).compile(\"^.+$\"); try { const r = readListField({ version: raw }, \"version\"); return el(d, \"pcc-x\", r.ok ? r.text : kitText(\"not ok\")); } finally { (LIST_VERSION_RE as { compile(p: string): unknown }).compile(src); } }"} ,
  {"name": "r2e4 N2b X16 core: structurally typed parameter writes Set.prototype.has; boundStatusText(raw) (core file)", "file": "dashboard-ir.ts", "rule": "intrinsic-escape", "code": "function probeSetHasX16(p: { has(v: unknown): boolean }, f: (v: unknown) => boolean): (v: unknown) => boolean { const o = p.has; p.has = f; return o; }\nexport function probeX16(raw: string): KitText { const o = probeSetHasX16(Set.prototype, () => true); try { return boundStatusText(raw); } finally { probeSetHasX16(Set.prototype, o); } }", "lineOffset": 1} ,
  {"name": "r2e4 N2b X18 entry: structural let annotation of window: w.RegExp.prototype.test = () => false", "file": "dashboard-ir-browser-entry.ts", "rule": "intrinsic-escape", "code": "export function probeX18(): void { let w: { RegExp: { prototype: { test(s: string): boolean } } } = window; w.RegExp.prototype.test = function (): boolean { return false; }; }"} ,
  {"name": "r2e4 N2b X19 let alias read of __proto__ through a structural assertion, then a write (no __proto__ in the write chain)", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "export function probeX19(d: RDocument, raw: string): RElement { let p = (new Set<unknown>() as { __proto__?: { has(v: unknown): boolean } }).__proto__!; const o = p.has; p.has = function (): boolean { return true; }; try { return el(d, \"pcc-x\", boundStatusText(raw)); } finally { p.has = o; } }"} ,
  {"name": "r2e4 N2b X20 Object.getPrototypeOf aliased with a structural return type (isPlain's own pattern), then p.has = ...", "file": "dashboard-ir-renderer.ts", "rule": "intrinsic-escape", "code": "export function probeX20(d: RDocument, raw: string): RElement { const gp: (value: object) => { has(v: unknown): boolean } = Object.getPrototypeOf; const p = gp(new Set<unknown>()); const o = p.has; p.has = function (): boolean { return true; }; try { return el(d, \"pcc-x\", boundStatusText(raw)); } finally { p.has = o; } }"} ,
  {"name": "r2e4 N2b X22 Sol's r2e2 Program 'aliased builtin write' with let instead of const (static only; WeakMap.get is captured)", "file": "dashboard-ir-renderer.ts", "rule": "intrinsic-escape", "code": "let probeIntrinsicX22: { get(key: object): unknown } = WeakMap.prototype; probeIntrinsicX22.get = () => \"forged\";"} ,
  {"name": "r2e4 N2b X23 __defineGetter__ by a computed (non-literal) key on an object-widened Set.prototype, a call not a write", "file": "dashboard-ir-renderer.ts", "rule": "intrinsic-escape", "code": "export function probeX23(d: RDocument, raw: string): RElement { const o: object = Set.prototype; const k = [\"__define\", \"Getter__\"].join(\"\"); const m = o as { [key: string]: (name: string, get: () => unknown) => void }; const keep = Set.prototype.has; m[k](\"has\", () => () => true); try { return el(d, \"pcc-x\", boundStatusText(raw)); } finally { m[k](\"has\", () => keep); } }"} ,
  {"name": "r2e4 control X05 control: array destructuring alias const [s] = [Set.prototype]; s.has = ...", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "export function probeX05(d: RDocument, raw: string): RElement { const [s] = [Set.prototype]; const o = s.has; s.has = function (): boolean { return true; }; try { return el(d, \"pcc-x\", boundStatusText(raw)); } finally { s.has = o; } }"} ,
  {"name": "r2e4 control X06 control: Reflect.set(s, \"has\", ...) through a let alias", "file": "dashboard-ir-renderer.ts", "rule": "reflection", "code": "export function probeX06(d: RDocument, raw: string): RElement { let s = Set.prototype; const o = s.has; Reflect.set(s, \"has\", function (): boolean { return true; }); try { return el(d, \"pcc-x\", boundStatusText(raw)); } finally { Reflect.set(s, \"has\", o); } }"} ,
  {"name": "r2e4 control X07 control: Object.assign(s, { has }) through a let alias", "file": "dashboard-ir-renderer.ts", "rule": "reflection", "code": "export function probeX07(d: RDocument, raw: string): RElement { let s = Set.prototype; const o = s.has; Object.assign(s, { has(): boolean { return true; } }); try { return el(d, \"pcc-x\", boundStatusText(raw)); } finally { Object.assign(s, { has: o }); } }"} ,
  {"name": "r2e4 control X08 control: optional-chaining call LIST_VERSION_RE?.compile(...)", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "export function probeX08(d: RDocument, raw: string): RElement { const src = LIST_VERSION_RE.source; LIST_VERSION_RE?.compile(\"^.+$\"); try { const r = readListField({ version: raw }, \"version\"); return el(d, \"pcc-x\", r.ok ? r.text : kitText(\"not ok\")); } finally { LIST_VERSION_RE?.compile(src); } }"} ,
  {"name": "r2e4 control X09 control: generic keyed write o[k] = v with o = Set.prototype, k = \"has\"", "file": "dashboard-ir-renderer.ts", "rule": "text-sink", "code": "function probeSetX09<T, K extends keyof T>(o: T, k: K, v: T[K]): void { o[k] = v; }\nexport function probeX09(d: RDocument, raw: string): RElement { const p = Set.prototype; const o = p.has; probeSetX09(p, \"has\", function (): boolean { return true; }); try { return el(d, \"pcc-x\", boundStatusText(raw)); } finally { probeSetX09(p, \"has\", o); } }"} ,
  {"name": "r2e4 fresh F01 object destructuring intrinsic", "file": "dashboard-ir-renderer.ts", "rule": "intrinsic-escape", "code": "function probeFresh01(): void { const { prototype: p }: { prototype: { has(v: unknown): boolean } } = Set; p.has = () => true; }"} ,
  {"name": "r2e4 fresh F02 Reflect.get prototype via structural view", "file": "dashboard-ir-renderer.ts", "rule": "intrinsic-escape", "code": "function probeFresh02(): void { const p = Reflect.get(Set, \"prototype\") as { has(v: unknown): boolean }; p.has = () => true; }"} ,
  {"name": "r2e4 fresh F03 intrinsic array indexed after widening", "file": "dashboard-ir-renderer.ts", "rule": "intrinsic-escape", "code": "function probeFresh03(): void { const values: { has(v: unknown): boolean }[] = [Set.prototype]; const p = values[0]!; p.has = () => true; }"} ,
  {"name": "r2e4 fresh F04 spread intrinsic into structural object", "file": "dashboard-ir-renderer.ts", "rule": "intrinsic-escape", "code": "function probeFresh04(): object { const p = { ...Set.prototype }; return p; }"} ,
  {"name": "r2e4 fresh F05 intrinsic parameter default", "file": "dashboard-ir-renderer.ts", "rule": "intrinsic-escape", "code": "function probeFresh05(p: { has(v: unknown): boolean } = Set.prototype): void { p.has = () => true; }"} ,
  {"name": "r2e4 fresh F06 conditional constructor escape", "file": "dashboard-ir-renderer.ts", "rule": "intrinsic-escape", "code": "function probeFresh06(flag: boolean): object { return flag ? Set : Array; }"} ,
  {"name": "r2e4 receiver-only intrinsic isolated acquisition", "file": "dashboard-ir-renderer.ts", "rule": "intrinsic-escape", "code": "function probeReceiverOnly(): object { const p: object = Set.prototype; return p; }"} ,
  {"name": "r2e4 name ban __proto__ structural read", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeNameproto(p: { __proto__: unknown }): unknown { return p.__proto__; }"} ,
  {"name": "r2e4 name ban __proto__ runtime-built key", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeComputedproto(p: { [key: string]: object }): unknown { const key = [\"__pro\", \"to__\"].join(\"\"); return p[key]; }"} ,
  {"name": "r2e4 name ban compile structural read", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeNamecompile(p: { compile: unknown }): unknown { return p.compile; }"} ,
  {"name": "r2e4 name ban compile runtime-built key", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeComputedcompile(p: { [key: string]: () => unknown }): unknown { const key = [\"com\", \"pile\"].join(\"\"); return p[key]; }"} ,
  {"name": "r2e4 name ban __defineGetter__ structural read", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeNamedefineGetter(p: { __defineGetter__: unknown }): unknown { return p.__defineGetter__; }"} ,
  {"name": "r2e4 name ban __defineGetter__ runtime-built key", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeComputeddefineGetter(p: { [key: string]: () => unknown }): unknown { const key = [\"__define\", \"Getter__\"].join(\"\"); return p[key]; }"} ,
  {"name": "r2e4 name ban __defineSetter__ structural read", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeNamedefineSetter(p: { __defineSetter__: unknown }): unknown { return p.__defineSetter__; }"} ,
  {"name": "r2e4 name ban __defineSetter__ runtime-built key", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeComputeddefineSetter(p: { [key: string]: () => unknown }): unknown { const key = [\"__define\", \"Setter__\"].join(\"\"); return p[key]; }"} ,
  {"name": "r2e4 name ban __lookupGetter__ structural read", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeNamelookupGetter(p: { __lookupGetter__: unknown }): unknown { return p.__lookupGetter__; }"} ,
  {"name": "r2e4 name ban __lookupGetter__ runtime-built key", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeComputedlookupGetter(p: { [key: string]: () => unknown }): unknown { const key = [\"__lookup\", \"Getter__\"].join(\"\"); return p[key]; }"} ,
  {"name": "r2e4 name ban __lookupSetter__ structural read", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeNamelookupSetter(p: { __lookupSetter__: unknown }): unknown { return p.__lookupSetter__; }"} ,
  {"name": "r2e4 name ban __lookupSetter__ runtime-built key", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeComputedlookupSetter(p: { [key: string]: () => unknown }): unknown { const key = [\"__lookup\", \"Setter__\"].join(\"\"); return p[key]; }"} ,
  {"name": "r2e4 getPrototypeOf Object alias typed result", "file": "dashboard-ir-renderer.ts", "rule": "intrinsic-escape", "code": "function probeObjectPrototypeAlias(): unknown { const gp: (value: object) => { has(v: unknown): boolean } = Object.getPrototypeOf; return gp(new Set<unknown>()); }"} ,
  {"name": "r2e4 getPrototypeOf Object direct typed result", "file": "dashboard-ir-renderer.ts", "rule": "intrinsic-escape", "code": "function probeObjectPrototypeDirect(): unknown { const p: { has(v: unknown): boolean } = Object.getPrototypeOf(new Set<unknown>()); return p; }"} ,
  {"name": "r2e4 getPrototypeOf Reflect alias typed result", "file": "dashboard-ir-renderer.ts", "rule": "intrinsic-escape", "code": "function probeReflectPrototypeAlias(): unknown { const gp: (value: object) => { has(v: unknown): boolean } | null = Reflect.getPrototypeOf; return gp(new Set<unknown>()); }"} ,
  {"name": "r2e4 getPrototypeOf Reflect direct typed result", "file": "dashboard-ir-renderer.ts", "rule": "intrinsic-escape", "code": "function probeReflectPrototypeDirect(): unknown { const p: object | null = Reflect.getPrototypeOf(new Set<unknown>()); return p; }"} ,
  {"name": "r2e4 N3b Y01 N3: textViolation's own body leaks textDiagnostics to a module let; another core function reaches location.hash through it", "file": "dashboard-ir.ts", "rule": "brand-confinement", "code": "function textViolation(): void {\n  textDiagnostics.__PCC_UI_TEXT_VIOLATIONS__ = (textDiagnostics.__PCC_UI_TEXT_VIOLATIONS__ ?? 0) + 1; probeLeakY01 = textDiagnostics;\n}\nlet probeLeakY01: object = {};\nexport function probeY01(raw: string): void { textViolation(); (probeLeakY01 as { location: { hash: string } }).location.hash = raw; }", "needle": "function textViolation(): void {\n  textDiagnostics.__PCC_UI_TEXT_VIOLATIONS__ = (textDiagnostics.__PCC_UI_TEXT_VIOLATIONS__ ?? 0) + 1;\n}", "lineOffset": 1} ,
  {"name": "r2e4 N3b Y02 N3: the same leak; createHTMLDocument(raw) + insertAdjacentElement put the claim into document.body (no listed API, no lint property)", "file": "dashboard-ir.ts", "rule": "brand-confinement", "code": "function textViolation(): void {\n  textDiagnostics.__PCC_UI_TEXT_VIOLATIONS__ = (textDiagnostics.__PCC_UI_TEXT_VIOLATIONS__ ?? 0) + 1; probeLeakY02 = textDiagnostics;\n}\nlet probeLeakY02: object = {};\nexport function probeY02(raw: string): void { textViolation(); const w = probeLeakY02 as { document: { implementation: { createHTMLDocument(t: string): { querySelector(s: string): { style: { display: string } } | null } }; body: { insertAdjacentElement(p: string, e: object): unknown } } }; const t = w.document.implementation.createHTMLDocument(raw).querySelector(\"title\"); if (t) { t.style.display = \"block\"; w.document.body.insertAdjacentElement(\"beforeend\", t); } }", "needle": "function textViolation(): void {\n  textDiagnostics.__PCC_UI_TEXT_VIOLATIONS__ = (textDiagnostics.__PCC_UI_TEXT_VIOLATIONS__ ?? 0) + 1;\n}", "lineOffset": 1} ,
  { name: "r2e3 N3 W30 widened diagnostics DOM alias", file: "dashboard-ir.ts", rule: "brand-confinement", code: 'export function probeW30(raw: string): void { const g: object = textDiagnostics; const w = g as { Text: new (s: string) => object; document: { body: { appendChild(n: object): unknown } } }; w.document.body.appendChild(new w.Text(raw)); }' },
  { name: "r2e3 N3 W31 structural diagnostics DOM alias", file: "dashboard-ir.ts", rule: "brand-confinement", code: 'export function probeW31(raw: string): void { const w = textDiagnostics as { Text: new (s: string) => object; document: { body: { insertBefore(n: object, r: null): unknown } } }; w.document.body.insertBefore(new w.Text(raw), null); }' },
  { name: "r2e3 N3 diagnostics alias without a sink", file: "dashboard-ir.ts", rule: "brand-confinement", code: 'const probeDiagnostics: object = textDiagnostics; void probeDiagnostics;' },
  { name: "r2e3 N3 diagnostics named export", file: "dashboard-ir.ts", rule: "brand-confinement", code: 'export { textDiagnostics };' },
  { name: "r2e3 N3 diagnostics initialization pin", file: "dashboard-ir.ts", rule: "brand-confinement", needle: 'textDiagnostics.__PCC_UI_TEXT_VIOLATIONS__ ??= 0;', code: 'textDiagnostics.__PCC_UI_TEXT_VIOLATIONS__ ??= 1;' },
  { name: "r2e3 N3 appendChild structural sink", file: "dashboard-ir-binder.ts", rule: "text-sink", code: 'function probeAppendChild(body: { appendChild(n: object): unknown }, n: object): void { body.appendChild(n); }' },
  { name: "r2e3 N3 insertBefore structural sink", file: "dashboard-ir.ts", rule: "text-sink", code: 'function probeInsertBefore(body: { insertBefore(n: object, r: null): unknown }, n: object): void { body.insertBefore(n, null); }' },
  { name: "r2e3 N3 replaceChild structural sink", file: "dashboard-ir-binder.ts", rule: "text-sink", code: 'function probeReplaceChild(body: { replaceChild(n: object, old: object): unknown }, n: object): void { body.replaceChild(n, n); }' },
  ...["Text", "Option", "DOMParser", "Notification"].map((name) => ({ name: `r2e3 N3 structural ${name} constructor`, file: "dashboard-ir.ts" as const, rule: "text-sink", code: `function probeConstructor(w: { ${name}: new (s: string) => object }, raw: string): void { new w.${name}(raw); }` })),
  { name: "r2e3 P3c insertAdjacentText", file: "dashboard-ir.ts", rule: "text-sink", code: 'export function probeP3c(raw: string): void { const g: unknown = globalThis; (g as { document: { body: { insertAdjacentText(where: string, s: string): void } } }).document.body.insertAdjacentText("beforeend", raw); }' },
  { name: "r2e3 P3c structural insertAdjacentText alone", file: "dashboard-ir.ts", rule: "text-sink", code: 'function probeAdjacent(body: { insertAdjacentText(where: string, s: string): void }, raw: string): void { body.insertAdjacentText("beforeend", raw); }' },
  { name: "r2e3 P3d4 CSS caption rule four", file: "dashboard-ir-renderer.ts", rule: "style-write", code: 'export function probeP3d4(raw: string): void { const g: unknown = globalThis; (g as { document: { styleSheets: { [i: number]: { cssRules: { [i: number]: { style: { cssText: string } } } } } } }).document.styleSheets[0]!.cssRules[4]!.style.cssText = "content:" + JSON.stringify(raw); }' },
  {"name": "r2e3 N2 W01 let alias: let s = Set.prototype; s.has = () => true (call time, restored); boundStatusText(raw)", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "export function probeW01(d: RDocument, raw: string): RElement { let s = Set.prototype; const o = s.has; s.has = function (): boolean { return true; }; try { return el(d, \"pcc-x\", boundStatusText(raw)); } finally { s.has = o; } }"},
  {"name": "r2e3 N2 W02 var alias", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "export function probeW02(d: RDocument, raw: string): RElement { var s = Set.prototype; const o = s.has; s.has = function (): boolean { return true; }; try { return el(d, \"pcc-x\", boundStatusText(raw)); } finally { s.has = o; } }"},
  {"name": "r2e3 N2 W04 parameter alias: a helper writes p.has for p = Set.prototype", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeSetHas04(p: Set<unknown>, f: (v: unknown) => boolean): (v: unknown) => boolean { const o = p.has; p.has = f; return o; }\nexport function probeW04(d: RDocument, raw: string): RElement { const o = probeSetHas04(Set.prototype, () => true); try { return el(d, \"pcc-x\", boundStatusText(raw)); } finally { probeSetHas04(Set.prototype, o); } }"},
  {"name": "r2e3 N2 W05 container alias: const box = { s: Set.prototype }; box.s.has = ...", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "export function probeW05(d: RDocument, raw: string): RElement { const box = { s: Set.prototype }; const o = box.s.has; box.s.has = function (): boolean { return true; }; try { return el(d, \"pcc-x\", boundStatusText(raw)); } finally { box.s.has = o; } }"},
  {"name": "r2e3 N2 W06 call-result alias: (() => Set.prototype)().has = ...", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeProto06(): Set<unknown> { return Set.prototype; }\nexport function probeW06(d: RDocument, raw: string): RElement { const o = probeProto06().has; probeProto06().has = function (): boolean { return true; }; try { return el(d, \"pcc-x\", boundStatusText(raw)); } finally { probeProto06().has = o; } }", "lineOffset": 1},
  {"name": "r2e3 N2 W07 for-of alias: for (const s of [Set.prototype]) s.has = ...", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "export function probeW07(d: RDocument, raw: string): RElement { const o = Set.prototype.has; for (const s of [Set.prototype]) s.has = function (): boolean { return true; }; try { return el(d, \"pcc-x\", boundStatusText(raw)); } finally { for (const s of [Set.prototype]) s.has = o; } }"},
  {"name": "r2e3 N2 W08 class-field alias: new (class { s = Set.prototype })().s.has = ...", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "class ProbeHolder08 { s = Set.prototype; }\nexport function probeW08(d: RDocument, raw: string): RElement { const h = new ProbeHolder08(); const o = h.s.has; h.s.has = function (): boolean { return true; }; try { return el(d, \"pcc-x\", boundStatusText(raw)); } finally { h.s.has = o; } }", "lineOffset": 1},
  {"name": "r2e3 N2 W12 let alias: Array.prototype.join returns server data, so joinKitText re-mints it as a GENUINE brand", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "export function probeW12(d: RDocument, raw: string): RElement { let a = Array.prototype; const o = a.join; a.join = function (): string { return raw; }; try { return el(d, \"pcc-x\", joinKitText(kitText(\"a\"), kitText(\"b\"))); } finally { a.join = o; } }"},
  {"name": "r2e3 N2 W13 let alias with a literal-key element write: a[\"join\"] = ...", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "export function probeW13(d: RDocument, raw: string): RElement { let a = Array.prototype; const o = a[\"join\"]; a[\"join\"] = function (): string { return raw; }; try { return el(d, \"pcc-x\", joinKitText(kitText(\"a\"), kitText(\"b\"))); } finally { a[\"join\"] = o; } }"},
  {"name": "r2e3 N2 W14 let alias in the core: Set.prototype.has, boundStatusText(raw) (core file)", "file": "dashboard-ir.ts", "rule": "builtin-write", "code": "export function probeW14(raw: string): KitText { let s = Set.prototype; const o = s.has; s.has = function (): boolean { return true; }; try { return boundStatusText(raw); } finally { s.has = o; } }"},
  {"name": "r2e3 N2 W15 let alias in the binder: Number.isInteger = () => true, then httpStatusText(200.5)", "file": "dashboard-ir-binder.ts", "rule": "builtin-write", "code": "export function probeW15(raw: string): KitText { let n = Number; const o = n.isInteger; n.isInteger = function (): boolean { return true; }; try { return httpStatusText(raw.length > 0 ? 200.5 : 0); } finally { n.isInteger = o; } }"},
  {"name": "r2e3 N2 W17 __defineGetter__ through an object-widened alias redefines Set.prototype.has (a call, not an assignment)", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "export function probeW17(d: RDocument, raw: string): RElement { const p: object = Set.prototype; const o = Set.prototype.has; (p as { __defineGetter__(k: string, f: () => unknown): void }).__defineGetter__(\"has\", () => () => true); try { return el(d, \"pcc-x\", boundStatusText(raw)); } finally { (p as { __defineGetter__(k: string, f: () => unknown): void }).__defineGetter__(\"has\", () => o); } }"},
  {"name": "r2e3 N2 W23 entry: window.RegExp.prototype.test = () => false (no alias; window is allowed in the entry, and the root walk recognises only globalThis)", "file": "dashboard-ir-browser-entry.ts", "rule": "builtin-write", "code": "export function probeW23(): void { window.RegExp.prototype.test = function (): boolean { return false; }; }"},
  {"name": "r2e3 N2 W21 RegExp.prototype.compile (lib-declared, a CALL not a write) rewrites the renderer's own LIST_VERSION_RE in place; a list row's version shows the claim bare", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "export function probeW21(d: RDocument, raw: string): RElement { const src = LIST_VERSION_RE.source; LIST_VERSION_RE.compile(\"^.+$\"); try { const r = readListField({ version: raw }, \"version\"); return el(d, \"pcc-x\", r.ok ? r.text : kitText(\"not ok\")); } finally { LIST_VERSION_RE.compile(src); } }"},
  {"name": "r2e3 N2 entry globalThis builtin write", "file": "dashboard-ir-browser-entry.ts", "rule": "builtin-write", "code": "function probeGlobalIntrinsic(): void { globalThis.RegExp.prototype.test = () => false; }"},
  {"name": "r2e3 N2 literal-type key alias write", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeLiteralAlias(p: Set<unknown>): void { const key = \"has\"; p[key] = () => true; }"},
  {"name": "r2e3 N2 parameter compound assignment", "file": "dashboard-ir-binder.ts", "rule": "builtin-write", "code": "function probeCompound(p: number[]): void { p.length += 1; }"},
  {"name": "r2e3 N2 parameter prefix update", "file": "dashboard-ir-binder.ts", "rule": "builtin-write", "code": "function probePrefix(p: number[]): void { ++p.length; }"},
  {"name": "r2e3 N2 parameter postfix update", "file": "dashboard-ir-binder.ts", "rule": "builtin-write", "code": "function probePostfix(p: number[]): void { p.length--; }"},
  {"name": "r2e3 N2 parameter delete", "file": "dashboard-ir-binder.ts", "rule": "builtin-write", "code": "function probeDelete(p: Set<unknown>): void { delete p.has; }"},
  {"name": "r2e3 N2 structural defineSetter call", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeDefineSetter(p: { __defineSetter__(k: string, f: (v: unknown) => void): void }): void { p.__defineSetter__(\"has\", () => {}); }"},
  {"name": "r2e3 N2 structural lookupGetter call", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeLookupGetter(p: { __lookupGetter__(k: string): unknown }): unknown { return p.__lookupGetter__(\"has\"); }"},
  {"name": "r2e3 N2 structural proto write", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeProtoWrite(p: { __proto__: object }): void { p.__proto__ = {}; }"},
  {"name": "r2e3 N2 computed proto write", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeComputedProtoWrite(p: { __proto__: object }): void { const key = \"__proto__\"; p[key] = {}; }"},
  {"name": "r2e3 N2 parameter RegExp compile", "file": "dashboard-ir-binder.ts", "rule": "builtin-write", "code": "function probeCompile(p: RegExp): void { p.compile(\"^.+$\"); }"},
  { name: "r2e2 private store shorthand export", file: "dashboard-ir.ts", rule: "brand-confinement", code: 'export const probeBrandShorthand = { TEXT_BRANDS };' },
  { name: "r2e2 kitText shorthand export", file: "dashboard-ir.ts", rule: "mint", code: 'export const probeCopyShorthand = { kitText };' },
  { name: "r2e2 literal-key brand text read", file: "dashboard-ir-renderer.ts", rule: "brand-read", code: 'function probeLiteralKeyText(value: KitText): string { const key = "t"; return value[key]; }' },
  { name: "r2e2 private store named export", file: "dashboard-ir.ts", rule: "brand-confinement", code: 'export { TEXT_BRANDS };' },
  { name: "r2e2 captured function named export", file: "dashboard-ir.ts", rule: "brand-confinement", code: 'export { TEXT_STORE_GET };' },
  { name: "r2e2 kitText named export", file: "dashboard-ir.ts", rule: "mint", code: 'export { kitText as probeEscape };' },
  { name: "r2e2 aliased builtin write", file: "dashboard-ir-renderer.ts", rule: "builtin-write", code: 'const probeIntrinsic: { get(key: object): unknown } = WeakMap.prototype; probeIntrinsic.get = () => "forged";' },
  { name: "r2e2 computed brand text read", file: "dashboard-ir-renderer.ts", rule: "brand-read", code: 'function probeBareComputedText(value: KitText): string { return value["t"]; }' },
  { name: "r2e2 nonreviewed erased type import", file: "dashboard-ir-renderer.ts", rule: "inventory", code: 'import type { v4 as ProbeForeignType } from "uuid";' },
  { name: "r2e2 dynamic runtime package import", file: "dashboard-ir-renderer.ts", rule: "inventory", code: 'const probeModulePath = "https://example.invalid/unreviewed.js"; void import(probeModulePath);' },
  { name: "r2e2 nested style content write", file: "dashboard-ir-renderer.ts", rule: "style-write", code: 'function probeStyleContent(value: { style: { content: string } }, raw: string): void { value.style.content = raw; }' },
  { name: "r2e2 builtin Object.assign", file: "dashboard-ir-renderer.ts", rule: "builtin-write", code: 'Object.assign(WeakMap.prototype, { get(): string { return "forged"; } });' },
  { name: "r2e2 code before primordial captures", file: "dashboard-ir.ts", rule: "captures-first", needle: "import type { BoundSourceClass, DashboardManifest, RenderSourceClass } from \"@pcc/spec\";", code: "const probeRunsBeforeCaptures = 0;\nimport type { BoundSourceClass, DashboardManifest, RenderSourceClass } from \"@pcc/spec\";" },
  { name: "r2e2 map store escape", file: "dashboard-ir.ts", rule: "brand-confinement", code: 'export const probeStoreEscape = TEXT_BRANDS;' },
  { name: "r2e2 captured primitive escape", file: "dashboard-ir.ts", rule: "brand-confinement", code: 'export const probeCaptureEscape = TEXT_STORE_GET;' },
  { name: "r2e2 bare brand text read", file: "dashboard-ir-renderer.ts", rule: "brand-read", code: 'function probeBareText(value: KitText): string { return value.t; }' },
  {"name": "r2e2 F20 direct TEXT_BRANDS.add of a raw object inside dashboard-ir.ts", "file": "dashboard-ir.ts", "rule": "brand-confinement", "code": "function probeVehF20(v: unknown): KitText { const branded = { inner: { t: kitText(\"checked\") } }; const widened: Record<string, unknown> = branded; widened[\"inner\"] = { t: v }; return branded.inner.t; }\nexport function probeF20(raw: string): KitText { const o = Object.freeze({ t: raw }); TEXT_BRANDS.add(o); return probeVehF20(o); }", "lineOffset": 1},
  {"name": "r2e2 F20a direct AGENT_TEXT_BRANDS.add of a raw object inside dashboard-ir.ts", "file": "dashboard-ir.ts", "rule": "brand-confinement", "code": "let probeSlotF20a: AgentText | undefined;\nfunction probeVehAF20a(v: unknown): AgentText { const b = { inner: { t: probeSlotF20a } }; const w: Record<string, unknown> = b; w[\"inner\"] = { t: v }; const r = b.inner.t; if (r === undefined) throw new Error(\"vehicle\"); return r; }\nexport function probeF20a(raw: string): AgentText { const o = Object.freeze({ t: raw }); AGENT_TEXT_BRANDS.add(o); return probeVehAF20a(o); }", "lineOffset": 2},
  {"name": "r2e2 F21 WeakSet.prototype.has replaced by IR code at call time (restored after)", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeVehF01(v: unknown): KitText { const branded = { inner: { t: kitText(\"checked\") } }; const widened: Record<string, unknown> = branded; widened[\"inner\"] = { t: v }; return branded.inner.t; }\nexport function probeF21(d: RDocument, raw: string): RElement { const orig = WeakSet.prototype.has; WeakSet.prototype.has = function (): boolean { return true; }; try { return el(d, \"pcc-x\", probeVehF01({ t: raw })); } finally { WeakSet.prototype.has = orig; } }", "lineOffset": 1},
  {"name": "r2e2 F21m WeakSet.prototype.has replaced at MODULE INIT of the renderer (never restored; separate tree state)", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "function probeVehF01(v: unknown): KitText { const branded = { inner: { t: kitText(\"checked\") } }; const widened: Record<string, unknown> = branded; widened[\"inner\"] = { t: v }; return branded.inner.t; }\nWeakSet.prototype.has = function (): boolean { return true; };\nexport function probeF21m(d: RDocument, raw: string): RElement { return el(d, \"pcc-x\", probeVehF01({ t: raw })); }", "lineOffset": 1},
  {"name": "r2e2 F22 Object.freeze replaced by IR code, then a real brand's t is overwritten through a { t: string } view (restored after)", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "export function probeF22(d: RDocument, raw: string): RElement { const f = Object.freeze; Object.freeze = ((o: unknown) => o) as typeof Object.freeze; try { const k = kitText(\"checked\"); (k as { t: string }).t = raw; return el(d, \"pcc-x\", k); } finally { Object.freeze = f; } }"},
  {"name": "r2e2 F23 httpStatusText mint called with a string laundered to number (binder)", "file": "dashboard-ir-binder.ts", "rule": "input-type", "code": "function probeVehNum23(v: unknown): number { const b = { inner: { n: 0 } }; const w: Record<string, unknown> = b; w[\"inner\"] = { n: v }; return b.inner.n; }\nexport function probeF23(raw: string): KitText { return httpStatusText(probeVehNum23(raw)); }"},
  {"name": "r2e2 F25 reportedFieldText with a laundered object whose normalize() is benign and toString() is the claim", "file": "dashboard-ir-renderer.ts", "rule": "input-type", "code": "function probeVehStr25(v: unknown): string { const b = { inner: { s: \"\" } }; const w: Record<string, unknown> = b; w[\"inner\"] = { s: v }; return b.inner.s; }\nexport function probeF25(d: RDocument, raw: string): RElement { const hostile = { normalize: (): string => \"ok\", toString: (): string => raw }; return el(d, \"pcc-x\", reportedFieldText(\"note\", probeVehStr25(hostile))); }"},
  {"name": "r2e2 F25b identifierText and boundStatusText with the same laundered object", "file": "dashboard-ir-renderer.ts", "rule": "input-type", "code": "function probeVehStr25(v: unknown): string { const b = { inner: { s: \"\" } }; const w: Record<string, unknown> = b; w[\"inner\"] = { s: v }; return b.inner.s; }\nexport function probeF25b(d: RDocument, raw: string): RElement[] { const hostile = { normalize: (): string => \"ok\", toString: (): string => raw }; return [el(d, \"pcc-x\", identifierText(\"id\", probeVehStr25(hostile))), el(d, \"pcc-x\", boundStatusText(probeVehStr25(hostile)))]; }"},
  {"name": "r2e2 F26a kitText aliased to a const, called with raw", "file": "dashboard-ir-renderer.ts", "rule": "mint", "code": "const probeK26a = kitText;\nexport function probeF26a(d: RDocument, raw: string): RElement { return el(d, \"pcc-x\", probeK26a(raw)); }"},
  {"name": "r2e2 F26b [raw].map(kitText)", "file": "dashboard-ir-renderer.ts", "rule": "mint", "code": "export function probeF26b(d: RDocument, raw: string): RElement { return el(d, \"pcc-x\", [raw].map(kitText)[0] ?? kitText(\"checked\")); }"},
  {"name": "r2e2 F26c kitText(`${raw}`)", "file": "dashboard-ir-renderer.ts", "rule": "mint", "code": "export function probeF26c(d: RDocument, raw: string): RElement { return el(d, \"pcc-x\", kitText(`${raw}`)); }"},
  {"name": "r2e2 F26d kitText(raw as \"checked\")", "file": "dashboard-ir-renderer.ts", "rule": "mint", "code": "export function probeF26d(d: RDocument, raw: string): RElement { return el(d, \"pcc-x\", kitText(raw as \"checked\")); }"},
  {"name": "r2e2 F26e kitText.call(undefined, raw)", "file": "dashboard-ir-renderer.ts", "rule": "mint", "code": "export function probeF26e(d: RDocument, raw: string): RElement { return el(d, \"pcc-x\", kitText.call(undefined, raw)); }"},
  {"name": "r2e2 F26f Reflect.apply(kitText, undefined, [raw])", "file": "dashboard-ir-renderer.ts", "rule": "mint", "code": "export function probeF26f(d: RDocument, raw: string): RElement { return el(d, \"pcc-x\", Reflect.apply(kitText, undefined, [raw])); }"},
  {"name": "r2e2 F26g kitText(...[raw])", "file": "dashboard-ir-renderer.ts", "rule": "mint", "code": "export function probeF26g(d: RDocument, raw: string): RElement { const args: [string] = [raw]; return el(d, \"pcc-x\", kitText(...args)); }"},
  {"name": "r2e2 F26i ({ k: kitText }).k(raw)", "file": "dashboard-ir-renderer.ts", "rule": "mint", "code": "export function probeF26i(d: RDocument, raw: string): RElement { return el(d, \"pcc-x\", ({ k: kitText }).k(raw)); }"},
  {"name": "r2e2 F26j kitText.bind(undefined)(raw)", "file": "dashboard-ir-renderer.ts", "rule": "mint", "code": "export function probeF26j(d: RDocument, raw: string): RElement { return el(d, \"pcc-x\", kitText.bind(undefined)(raw)); }"},
  {"name": "r2e2 F26k kitText through a callback parameter: [raw].reduce((_a, s) => kitText(s), ...) is literal-checked; instead pass kitText as a callback to a local higher-order helper", "file": "dashboard-ir-renderer.ts", "rule": "mint", "lineOffset": 1, "code": "function probeApply26k(f: (s: string) => KitText, s: string): KitText { return f(s); }\nexport function probeF26k(d: RDocument, raw: string): RElement { return el(d, \"pcc-x\", probeApply26k(kitText, raw)); }"},
  {"name": "r2e2 G9q exact runtime-internal owner", "file": "dashboard-ir.ts", "rule": "mint", "code": "export function probeG9q(raw: string): KitText { const o = { readText(v: unknown): KitText { return v as KitText; } }; return o.readText(raw); }"},
  {"name": "r2e2 R35i implicit index setter write", "file": "dashboard-ir-renderer.ts", "rule": "mint", "code": "export function probeR35i(d: RDocument, raw: string): RElement[] { const out: RElement[] = []; const w: { [k: string]: string } = { set t(v: KitText) { out.push(el(d, \"pcc-x\", v)); } }; w.t = raw; return out; }"},
  {"name": "r2e2 P3 unknown global append in binder", "file": "dashboard-ir-binder.ts", "rule": "text-sink", "code": "export function probeP3(raw: string): void { const g: unknown = globalThis; (g as { document: { body: { append(...s: string[]): void } } }).document.body.append(raw); }"},
  {"name": "r2e2 P3b unknown global alert in kit", "file": "dashboard-ir.ts", "rule": "text-sink", "code": "export function probeP3b(raw: string): void { const g: unknown = globalThis; (g as { alert(s: string): void }).alert(raw); }"},
  {"name": "r2e2 P3d CSS caption overwrite", "file": "dashboard-ir-renderer.ts", "rule": "style-write", "code": "export function probeP3d(raw: string): void { const g: unknown = globalThis; (g as { document: { styleSheets: { cssRules: { style: { cssText: string } }[] }[] } }).document.styleSheets[0]!.cssRules[0]!.style.cssText = \"content:\" + JSON.stringify(raw); }"},
  {"name": "r2e2 unknown variable assertion to object", "file": "dashboard-ir-binder.ts", "rule": "assertion", "code": "function probeUnknownObject(value: unknown): object { return value as { body: object }; }"},
  {"name": "r2e2 unknown assertion to object in browser", "file": "dashboard-ir-browser-entry.ts", "rule": "assertion", "code": "function probeUnknownBrowser(value: unknown): object { return value as { body: object }; }"},
  {"name": "r2e2 globalThis DOM outside browser", "file": "dashboard-ir-binder.ts", "rule": "dom", "code": "const probeGlobalThis = globalThis;"},
  {"name": "r2e2 self DOM outside browser", "file": "dashboard-ir.ts", "rule": "dom", "code": "const probeSelf = self;"},
  {"name": "r2e2 window DOM outside browser", "file": "dashboard-ir-renderer.ts", "rule": "dom", "code": "const probeWindow = window;"},
  {"name": "r2e2 stylesheet style overwrite", "file": "dashboard-ir-renderer.ts", "rule": "style-write", "code": "function probeStyleWrite(value: { style: string }, raw: string): void { value.style = raw; }"},
  {"name": "r2e2 stylesheet setProperty", "file": "dashboard-ir-renderer.ts", "rule": "style-write", "code": "function probeStyleCall(value: { setProperty(k: string, v: string): void }, raw: string): void { value.setProperty(\"content\", raw); }"},
  {"name": "r2e2 builtin compound assignment", "file": "dashboard-ir.ts", "rule": "builtin-write", "code": "Number.MAX_VALUE += 1;"},
  {"name": "r2e2 builtin delete", "file": "dashboard-ir-binder.ts", "rule": "builtin-write", "code": "delete Object.freeze;"},
  {"name": "r2e2 builtin defineProperty", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "Object.defineProperty(WeakMap.prototype, \"get\", { value: () => \"forged\" });"},
  {"name": "r2e2 builtin defineProperties", "file": "dashboard-ir.ts", "rule": "builtin-write", "code": "Object.defineProperties(Object, { freeze: { value: (v: unknown) => v } });"},
  {"name": "r2e2 builtin Reflect.set", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "Reflect.set(WeakMap.prototype, \"get\", () => \"forged\");"},
  {"name": "r2e2 builtin Reflect.defineProperty", "file": "dashboard-ir-renderer.ts", "rule": "builtin-write", "code": "Reflect.defineProperty(Object, \"freeze\", { value: (v: unknown) => v });"},
  {"name": "r2e2 builtin Object.setPrototypeOf", "file": "dashboard-ir-binder.ts", "rule": "builtin-write", "code": "Object.setPrototypeOf(WeakMap.prototype, {});"},
  {"name": "r2e2 builtin Reflect.setPrototypeOf", "file": "dashboard-ir.ts", "rule": "builtin-write", "code": "Reflect.setPrototypeOf(WeakMap.prototype, {});"},
  {"name": "r2e2 runtime package import", "file": "dashboard-ir-renderer.ts", "rule": "inventory", "code": "import { v4 as probeUuid } from \"uuid\"; void probeUuid;"},
  { name: "r2e registrar call outside declared mint", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'export function rogueMint(raw: string): KitText { return registerKitText(raw); }' },
  { name: "r2e upper-case ts-ignore", file: "dashboard-ir-renderer.ts", rule: "directive", code: '// @TS-IGNORE\nfunction uppercaseIgnored() {}' },
  { name: "r2e mixed-case ts-expect-error", file: "dashboard-ir-renderer.ts", rule: "directive", code: '// @Ts-Expect-Error\nfunction uppercaseExpected() {}' },
  {"name": "r2e R35 fresh object literal with a KitText setter assigned to an unbranded writable type", "rule": "mint", "file": "dashboard-ir-renderer.ts", "code": "export function probeR35(d: RDocument, raw: string): RElement[] { const out: RElement[] = []; const w: { t: string } = { set t(v: KitText) { out.push(el(d, \"pcc-x\", v)); } }; w.t = raw; return out; }"},
  {"name": "r2e R35b the same, returned from a function with an unbranded writable return type", "rule": "mint", "file": "dashboard-ir-renderer.ts", "code": "function probeMake35b(d: RDocument, out: RElement[]): { t: string } { return { set t(v: KitText) { out.push(el(d, \"pcc-x\", v)); } }; }\nexport function probeR35b(d: RDocument, raw: string): RElement[] { const out: RElement[] = []; probeMake35b(d, out).t = raw; return out; }"},
  {"name": "r2e R35c the same, in the binder", "rule": "mint", "file": "dashboard-ir-binder.ts", "code": "export function probeR35c(raw: string): KitText[] { const out: KitText[] = []; const w: { t: string } = { set t(v: KitText) { out.push(v); } }; w.t = raw; return out; }"},
  {"name": "r2e R37d object declaration destructuring of an identifier source into a narrower writable view", "rule": "mint", "file": "dashboard-ir-renderer.ts", "code": "export function probeR37d(d: RDocument, raw: string): RElement { const branded = { payload: kitText(\"checked\") }; const holder: { w: { payload: KitText } } = { w: branded }; const { w }: { w: { payload: string } } = holder; w.payload = raw; return el(d, \"pcc-x\", branded.payload); }"},
  {"name": "r2e R38 holder of a branded-parameter callable widened to unknown (pins M1b)", "rule": "mint", "file": "dashboard-ir-renderer.ts", "code": "export function probeR38(d: RDocument, raw: string): RElement { const holder: unknown = { g: el }; return (holder as { g: (d: RDocument, cls: string, text?: string) => RElement }).g(d, \"pcc-x\", raw); }"},
  {"name": "r2e R39 data-only discriminated-union target, written through the union (pins M3i)", "rule": "mint", "file": "dashboard-ir-renderer.ts", "lineOffset": 1, "code": "type ProbeDU39 = { k: \"a\"; t: string } | { k: \"b\"; t: string };\nexport function probeR39(d: RDocument, raw: string): RElement { const src: { k: \"a\" | \"b\"; t: KitText } = { k: \"a\", t: kitText(\"checked\") }; const u: ProbeDU39 = src; u.t = raw; return el(d, \"pcc-x\", src.t); }"},
  {"name": "r2e R40 case-variant // @TS-NOCHECK pragma at file start, spread laundering", "rule": "directive", "file": "dashboard-ir-renderer.ts", "needle": "/**", "code": "// @TS-NOCHECK\n/**"},
  {"name": "r2e R40b lowercase // @ts-nocheck at file start, same laundering (control)", "rule": "directive", "file": "dashboard-ir-renderer.ts", "needle": "/**", "code": "// @ts-nocheck\n/**"},
  {"name": "r2e R40c case-variant // @Ts-NoCheck alone, dashboard-ir.ts", "rule": "directive", "file": "dashboard-ir.ts", "needle": "/**", "code": "// @Ts-NoCheck\n/**"},
  {"name": "r2e DV2 // @TS-NOCHECK (upper case) at file start with a type error, renderer", "rule": "directive", "file": "dashboard-ir-renderer.ts", "needle": "/**", "code": "// @TS-NOCHECK\n/**"},
  {"name": "r2e DV5 /// @TS-NOCHECK triple-slash upper case at file start with a type error, renderer", "rule": "directive", "file": "dashboard-ir-renderer.ts", "needle": "/**", "code": "/// @TS-NOCHECK\n/**"},
  {"name": "r2e A4a presence condition leaks by assignment: if ((leak = onStale))", "rule": "mint", "file": "dashboard-ir-binder.ts", "needle": "  const bind = node.bind;\n", "code": "  const bind = node.bind;\n  let probeLeak: unknown = null; if ((probeLeak = onStale)) { void probeLeak; }\n", "lineOffset": 1},
  {"name": "r2e A4b presence condition with a comma operator", "rule": "mint", "file": "dashboard-ir-binder.ts", "needle": "  const bind = node.bind;\n", "code": "  const bind = node.bind;\n  let probeLeak: unknown = null; if ((probeLeak = 1, onStale)) { void probeLeak; }\n", "lineOffset": 1},
  {"name": "r2e A4c presence condition with ??", "rule": "mint", "file": "dashboard-ir-binder.ts", "needle": "  const bind = node.bind;\n", "code": "  const bind = node.bind;\n  const probeOther = (_why: KitText): void => {}; if (onStale ?? probeOther) { void 0; }\n", "lineOffset": 1},
  {"name": "r2e A4e presence condition with typeof", "rule": "mint", "file": "dashboard-ir-binder.ts", "needle": "  const bind = node.bind;\n", "code": "  const bind = node.bind;\n  if (typeof onStale === \"function\") { void 0; }\n", "lineOffset": 1},
  {"name": "r2e A4f presence condition with a call inside the condition", "rule": "mint", "file": "dashboard-ir-binder.ts", "needle": "  const bind = node.bind;\n", "code": "  const bind = node.bind;\n  const probeSink = (f: unknown): boolean => f !== null; if (onStale && probeSink(onStale)) { void 0; }\n", "lineOffset": 1},
  {"name": "r2e A4g presence condition storing through an IIFE", "rule": "mint", "file": "dashboard-ir-binder.ts", "needle": "  const bind = node.bind;\n", "code": "  const bind = node.bind;\n  let probeSaved: unknown = null; if (onStale && ((): boolean => { probeSaved = onStale; return true; })()) { void probeSaved; }\n", "lineOffset": 1},
  {"name": "r2e A4h presence condition: assignment of the && value", "rule": "mint", "file": "dashboard-ir-binder.ts", "needle": "  const bind = node.bind;\n", "code": "  const bind = node.bind;\n  let probeLeak: unknown = null; const probeFlag = node.id.length > 0; if ((probeLeak = probeFlag && onStale)) { void probeLeak; }\n", "lineOffset": 1},
  {"name": "r2e A4i presence in a while condition (expected false positive, fail closed)", "rule": "mint", "file": "dashboard-ir-binder.ts", "needle": "  const bind = node.bind;\n", "code": "  const bind = node.bind;\n  while (onStale) { break; }\n", "lineOffset": 1},
  {"name": "r2e registrar import outside declared mints", "file": "dashboard-ir-binder.ts", "rule": "import", "code": "import { registerAgentText } from \"./dashboard-ir.js\";"},

  { name: "r2d mapped-member predicate target", file: "dashboard-ir.ts", rule: "mint", code: 'type ExtraMapped = { [K in "t"]: KitText }; function extraPredicate(v: unknown): v is ExtraMapped { return true; }' },
  { name: "r2d mapped-member assertion signature target", file: "dashboard-ir.ts", rule: "mint", code: 'type ExtraMapped = { [K in "t"]: KitText }; interface ExtraAsserter { check(v: unknown): asserts v is ExtraMapped } const extraAsserter: ExtraAsserter = { check(_v: unknown): void {} };' },
  { name: "r2d mapped-member constructor instanceof target", file: "dashboard-ir.ts", rule: "mint", code: 'type ExtraMapped = { [K in "t"]: KitText }; const ExtraCtor: new () => ExtraMapped = class { t = kitText("checked"); }; export function extraInstance(v: unknown): KitText { return v instanceof ExtraCtor ? v.t : kitText("checked"); }' },
  {"name": "r2d predicate property signature", "file": "dashboard-ir.ts", "rule": "mint", "code": "interface ExtraPredicate { check: (v: unknown) => asserts v is KitText } const extraPredicate: ExtraPredicate = { check(_v: unknown): void {} };"},
  {"name": "r2d predicate interface call signature", "file": "dashboard-ir.ts", "rule": "mint", "code": "interface ExtraPredicate { (v: unknown): asserts v is KitText } const extraPredicate: ExtraPredicate = (_v: unknown): void => {};"},
  {"name": "r2d predicate type-literal call signature", "file": "dashboard-ir.ts", "rule": "mint", "code": "type ExtraPredicate = { (v: unknown): asserts v is KitText }; const extraPredicate: ExtraPredicate = (_v: unknown): void => {};"},
  {"name": "r2d instanceof without custom hasInstance", "file": "dashboard-ir.ts", "rule": "mint", "code": "class ExtraBrandBox { t: KitText = kitText(\"checked\"); } export function extraInstance(v: unknown): KitText { return v instanceof ExtraBrandBox ? v.t : kitText(\"checked\"); }"},
  {"name": "r2d branded callable property receiver", "file": "dashboard-ir.ts", "rule": "mint", "code": "function extraCallable(s: KitText): KitText { return s; } export const extraName = extraCallable.name;"},
  {"name": "r2d branded callable bind receiver preserves brand", "file": "dashboard-ir.ts", "rule": "mint", "code": "function extraCallable(s: KitText): KitText { return s; } export const extraBound = extraCallable.bind(undefined);"},
  {"name": "r2d directive after substitution template", "file": "dashboard-ir.ts", "rule": "directive", "code": "const extraTemplate = `value ${1}`; // @ts-ignore\nexport const extraValue = 1;"},
  {"name": "r2d directive after regex backtick", "file": "dashboard-ir-binder.ts", "rule": "directive", "code": "const extraRegex = /`/; // @ts-ignore\nexport const extraValue = 1;"},
  {"name": "r2d directive in empty parameters", "file": "dashboard-ir.ts", "rule": "directive", "code": "function extraEmpty(/* @ts-ignore */): void {}"},
  {"name": "r2d directive inside template substitution", "file": "dashboard-ir.ts", "rule": "directive", "code": "const extraTemplate = `${(() => { /* @ts-ignore */ return 1; })()}`;"},
  {"name": "r2d directive at end of file", "file": "dashboard-ir.ts", "rule": "directive", "code": "// @ts-ignore"},
  {"name": "r2d Record source object destructuring target", "file": "dashboard-ir.ts", "rule": "mint", "code": "export function extraDestruct(raw: string): KitText { const b: Record<\"payload\", KitText> = { payload: kitText(\"checked\") }; let w: { payload: string } = { payload: \"\" }; ({ w } = { w: b }); w.payload = raw; return b.payload; }"},
  {"name": "r2d Record source array destructuring target", "file": "dashboard-ir.ts", "rule": "mint", "code": "export function extraDestruct(raw: string): KitText { const b: Record<\"payload\", KitText> = { payload: kitText(\"checked\") }; let w: { payload: string } = { payload: \"\" }; [w] = [b]; w.payload = raw; return b.payload; }"},
  {"name": "r2d compound assignment with branded operand", "file": "dashboard-ir.ts", "rule": "mint", "lineOffset": 2, "code": "export function extraCompound(raw: string): KitText { let branded = kitText(\"checked\");\n// @ts-ignore\nbranded += kitText(\"checked\"); return branded; }"},
  {"name": "r2d predicate type-is signature", "file": "dashboard-ir.ts", "rule": "mint", "code": "type ExtraPredicate = (v: unknown) => v is KitText;"},
  {"name": "r2d directive in empty array", "file": "dashboard-ir.ts", "rule": "directive", "code": "const extraArray = [/* @ts-ignore */];"},
  { name: "O04c method type reached through Record (mapped type, identifier source)", file: "dashboard-ir-renderer.ts", rule: "mint", code: "type ProbeM4 = { m(s: string): KitText }[\"m\"]; const probeSrc4c = { f: (s: KitText): KitText => s }; const probeRec4: Record<\"f\", ProbeM4> = probeSrc4c; export function probeO04c(d: RDocument, raw: string): RElement { return el(d, \"pcc-x\", probeRec4.f(raw)); }" },
  { name: "O09 tuple element written through an object-type alias", file: "dashboard-ir-renderer.ts", rule: "mint", code: "export function probeO09(d: RDocument, raw: string): RElement { const branded: [KitText] = [kitText(\"checked\")]; const widened: { 0: string } = branded; widened[0] = raw; return el(d, \"pcc-x\", branded[0]); }" },
  { name: "O10 Record-typed source written through a widened alias", file: "dashboard-ir-renderer.ts", rule: "mint", code: "export function probeO10(d: RDocument, raw: string): RElement { const branded: Record<\"payload\", KitText> = { payload: kitText(\"checked\") }; const widened: { payload: string } = branded; widened.payload = raw; return el(d, \"pcc-x\", branded.payload); }" },
  { name: "O07 implicit index signature, method-typed value (identifier source)", file: "dashboard-ir-renderer.ts", rule: "mint", code: "type ProbeM7 = { m(s: string): KitText }[\"m\"]; const probeSrc7 = { f: (s: KitText): KitText => s }; const probeIdx7: { [k: string]: ProbeM7 } = probeSrc7; export function probeO07(d: RDocument, raw: string): RElement { const f = probeIdx7[\"f\"]; return el(d, \"pcc-x\", f ? f(raw) : kitText(\"checked\")); }" },
  { name: "O08a implicit index signature write, Record<string, unknown>", file: "dashboard-ir-renderer.ts", rule: "mint", code: "export function probeO08a(d: RDocument, raw: string): RElement { const branded = { payload: kitText(\"checked\") }; const widened: Record<string, unknown> = branded; widened[\"payload\"] = raw; return el(d, \"pcc-x\", branded.payload); }" },
  { name: "O08b implicit index signature write, { [k: string]: string }", file: "dashboard-ir-renderer.ts", rule: "mint", code: "export function probeO08b(d: RDocument, raw: string): RElement { const branded = { payload: kitText(\"checked\") }; const widened: { [k: string]: string } = branded; widened[\"payload\"] = raw; return el(d, \"pcc-x\", branded.payload); }" },
  { name: "O11 discriminated-union target decomposition", file: "dashboard-ir-renderer.ts", rule: "mint", code: "type ProbeDU11 = { k: \"a\"; f(s: string): KitText } | { k: \"b\"; f(s: string): KitText }; const probeSrc11: { k: \"a\" | \"b\"; f(s: KitText): KitText; extra: number } = { k: \"a\", f: (s) => s, extra: 1 }; const probeDU11: ProbeDU11 = probeSrc11; export function probeO11(d: RDocument, raw: string): RElement { return el(d, \"pcc-x\", probeDU11.f(raw)); }" },
  { name: "O12 for-of head assignment", file: "dashboard-ir-renderer.ts", rule: "mint", code: "export function probeO12(d: RDocument, raw: string): RElement { let w: { f(s: string): KitText } = { f: () => kitText(\"checked\") }; for (w of [{ f: (s: KitText): KitText => s }]) { break; } return el(d, \"pcc-x\", w.f(raw)); }" },
  { name: "O06l any door: Function.prototype.bind with a method-typed type argument", file: "dashboard-ir-renderer.ts", rule: "mint", code: "type ProbeM6 = { m(s: string): KitText }[\"m\"]; const probeId6l = (s: KitText): KitText => s; export function probeO06l(d: RDocument, raw: string): RElement { const b = probeId6l.bind<ProbeM6>(undefined); return el(d, \"pcc-x\", b(raw)); }" },
  { name: "O02b class implements a method-syntax interface member by declaration merging (no implements clause)", file: "dashboard-ir-renderer.ts", rule: "mint", code: "interface ProbeMerged { f(s: string): KitText } class ProbeMerged { f(s: KitText): KitText { return s; } } export function probeO02b(d: RDocument, raw: string): RElement { return el(d, \"pcc-x\", new ProbeMerged().f(raw)); }" },
  { name: "O13 assertion signature declared as an interface method", file: "dashboard-ir-renderer.ts", rule: "mint", code: "interface ProbeAsserter13 { check(v: unknown): asserts v is KitText } const probeA13: ProbeAsserter13 = { check(_v: unknown): void {} }; export function probeO13(d: RDocument, raw: string): RElement { probeA13.check(raw); return el(d, \"pcc-x\", raw); }" },
  { name: "O14 assertion signature declared as a function type", file: "dashboard-ir-renderer.ts", rule: "mint", code: "type ProbeAssertFn14 = (v: unknown) => asserts v is KitText; const probeAF14: ProbeAssertFn14 = (_v: unknown): void => {}; export function probeO14(d: RDocument, raw: string): RElement { probeAF14(raw); return el(d, \"pcc-x\", raw); }" },
  { name: "O15 instanceof narrowing with a static Symbol.hasInstance", file: "dashboard-ir-renderer.ts", rule: "mint", code: "class ProbeKitBox15 { static [Symbol.hasInstance](_v: unknown): boolean { return true; } t: KitText = kitText(\"checked\"); } export function probeO15(d: RDocument, raw: string): RElement { const x: unknown = { t: raw }; return el(d, \"pcc-x\", x instanceof ProbeKitBox15 ? x.t : kitText(\"checked\")); }" },
  { name: "O19a for-in head under @ts-ignore at the end of dashboard-ir.ts", file: "dashboard-ir.ts", rule: "mint", lineOffset: 3, code: "let probeK19: KitText = kitText(\"checked\");\nexport function probeO19a(raw: string): KitText {\n  // @ts-ignore\n  for (probeK19 in { [raw]: 1 }) { break; }\n  return probeK19;\n}" },
  { name: "O19b for-of head under @ts-ignore at the end of dashboard-ir.ts", file: "dashboard-ir.ts", rule: "mint", lineOffset: 3, code: "let probeK19b: KitText = kitText(\"checked\");\nexport function probeO19b(raw: string): KitText {\n  // @ts-ignore\n  for (probeK19b of [raw]) { break; }\n  return probeK19b;\n}" },
  { name: "N5 Z1 object-literal bivariance", file: "dashboard-ir.ts", rule: "mint", code: 'export const probeLaunder: { f(s: string): KitText } = { f: (s: KitText): KitText => s };' },
  { name: "N5 class implements method interface", file: "dashboard-ir.ts", rule: "mint", code: 'interface ProbeWide { f(s: string): KitText } class ProbeNarrow implements ProbeWide { f(s: KitText): KitText { return s; } }' },
  { name: "N5 class extends method member", file: "dashboard-ir.ts", rule: "mint", code: 'class ProbeWide { f(s: string): KitText { return kitText("checked"); } } class ProbeNarrow extends ProbeWide { f(s: KitText): KitText { return s; } }' },
  { name: "N5 static class extends method member", file: "dashboard-ir.ts", rule: "mint", code: 'class ProbeWide { static f(s: string): KitText { return kitText("checked"); } static run(s: string): KitText { return this.f(s); } } class ProbeNarrow extends ProbeWide { static override f(s: KitText): KitText { return s; } } const probeText = ProbeNarrow.run("raw");' },
  { name: "N5 accessor writer widening", file: "dashboard-ir.ts", rule: "mint", code: 'function probeSetter(raw: string): KitText { let saved = kitText("checked"); const narrow = { get payload(): string { return ""; }, set payload(v: KitText) { saved = v; } }; const wide: { payload: string } = narrow; wide.payload = raw; return saved; }' },
  { name: "N5 readonly accessor intermediary", file: "dashboard-ir.ts", rule: "mint", code: 'function probeSetter(raw: string): KitText { let saved = kitText("checked"); const narrow = { get payload(): string { return ""; }, set payload(v: KitText) { saved = v; } }; const view: { readonly payload: string } = narrow; const wide: { payload: string } = view; wide.payload = raw; return saved; }' },
  { name: "N5 readonly data intermediary", file: "dashboard-ir.ts", rule: "mint", code: 'function probeReadonly(raw: string): KitText { const narrow = { payload: kitText("checked") }; const view: { readonly payload: string } = narrow; const wide: { payload: string } = view; wide.payload = raw; return narrow.payload; }' },
  { name: "N5 mapped readonly data intermediary", file: "dashboard-ir.ts", rule: "mint", code: 'function probeReadonly(raw: string): KitText { const narrow = { payload: kitText("checked") }; const view: Readonly<{ payload: string }> = narrow; const wide: { payload: string } = view; wide.payload = raw; return narrow.payload; }' },
  { name: "N5 getter spread data widening", file: "dashboard-ir.ts", rule: "mint", code: 'function probeSpread(raw: string): KitText { const getter = { get payload(): KitText { return kitText("checked"); } }; const narrow = { ...getter }; const wide: { payload: string } = narrow; wide.payload = raw; return narrow.payload; }' },
  { name: "N5 readonly data declaration widening", file: "dashboard-ir.ts", rule: "mint", code: 'function probeReadonly(raw: string): KitText { const narrow: { readonly payload: KitText } = { payload: kitText("checked") }; const wide: { payload: string } = narrow; wide.payload = raw; return narrow.payload; }' },
  { name: "N5 readonly index intermediary", file: "dashboard-ir.ts", rule: "mint", code: 'function probeReadonly(raw: string): KitText { const narrow: Record<string, KitText> = { payload: kitText("checked") }; const view: { readonly [key: string]: string } = narrow; const wide: Record<string, string> = view; wide["payload"] = raw; return narrow["payload"]!; }' },
  { name: "N5 generic accessor class widening", file: "dashboard-ir.ts", rule: "mint", code: 'class ProbeBox<T> { constructor(public saved: T) {} get payload(): string { return ""; } set payload(v: T) { this.saved = v; } } function probeSetter(raw: string): KitText { const narrow = new ProbeBox(kitText("checked")); const wide: ProbeBox<string> = narrow; wide.payload = raw; return narrow.saved; }' },
  { name: "N5 instantiated accessor factory widening", file: "dashboard-ir.ts", rule: "mint", code: 'function probeBox<T>(initial: T) { let saved = initial; return { get payload(): string { return ""; }, set payload(v: T) { saved = v; }, get value(): T { return saved; } }; } function probeSetter(raw: string): KitText { const narrow = probeBox(kitText("checked")); const wide: { payload: string; readonly value: string } = narrow; wide.payload = raw; return narrow.value; }' },
  { name: "N5 opaque accessor factory widening", file: "dashboard-ir.ts", rule: "mint", code: 'function probeBox<T>(initial: T, onValue: (v: T) => void) { return { get payload(): string { return ""; }, set payload(v: T) { onValue(v); } }; } function probeSetter(raw: string): KitText { let saved = kitText("checked"); const narrow = probeBox(saved, (v) => { saved = v; }); const wide: { payload: string } = narrow; wide.payload = raw; return saved; }' },
  { name: "N5 method argument", file: "dashboard-ir.ts", rule: "mint", code: 'function probeTake(v: { f(s: string): KitText }): void {} probeTake({ f: (s: KitText): KitText => s });' },
  { name: "N5 function variable initializer", file: "dashboard-ir.ts", rule: "mint", code: 'type ProbeWide = { f(s: string): KitText }; const probeF: ProbeWide["f"] = (s: KitText): KitText => s;' },
  { name: "N5 assignment", file: "dashboard-ir.ts", rule: "mint", code: 'let probeV: { f(s: string): KitText } = { f: () => kitText("checked") }; probeV = { f: (s: KitText): KitText => s };' },
  { name: "N5 property initializer", file: "dashboard-ir.ts", rule: "mint", code: 'class ProbeBox { value: { f(s: string): KitText } = { f: (s: KitText): KitText => s }; }' },
  { name: "N5 object method member", file: "dashboard-ir.ts", rule: "mint", code: 'const probeV: { f(s: string): KitText } = { f(s: KitText): KitText { return s; } };' },
  { name: "N5 return", file: "dashboard-ir.ts", rule: "mint", code: 'function probeReturn(): { f(s: string): KitText } { return { f: (s: KitText): KitText => s }; }' },
  { name: "N5 contextual arrow return", file: "dashboard-ir.ts", rule: "mint", code: 'const probeReturn: () => { f(s: string): KitText } = () => ({ f: (s: KitText): KitText => s });' },
  { name: "N5 default value", file: "dashboard-ir.ts", rule: "mint", code: 'function probeDefault(v: { f(s: string): KitText } = { f: (s: KitText): KitText => s }): void {}' },
  { name: "N5 array element", file: "dashboard-ir.ts", rule: "mint", code: 'const probeValues: { f(s: string): KitText }[] = [{ f: (s: KitText): KitText => s }];' },
  { name: "N5 array spread", file: "dashboard-ir.ts", rule: "mint", code: 'const probeValues: { f(s: string): KitText }[] = [...[{ f: (s: KitText): KitText => s }]];' },
  { name: "N5 object spread", file: "dashboard-ir.ts", rule: "mint", code: 'const probeNarrow = { f: (s: KitText): KitText => s }; const probeWide: { f(s: string): KitText } = { ...probeNarrow };' },
  { name: "N5 satisfies relation", file: "dashboard-ir.ts", rule: "mint", code: 'const probeV = { f: (s: KitText): KitText => s } satisfies { f(s: string): KitText };' },
  { name: "N5 union parameter widening", file: "dashboard-ir.ts", rule: "mint", code: 'const probeV: { f(s: KitText | string): KitText } = { f: (s: KitText): KitText => s };' },
  { name: "N5 JSON.parse callable return any", file: "dashboard-ir.ts", rule: "mint", code: 'export const probeAnyParser: (s: string) => KitText = JSON.parse;' },
  { name: "N5 ambient callable return any", file: "dashboard-ir.ts", rule: "mint", code: 'declare function probeParse(s: string): any; const probeParser: (s: string) => KitText = probeParse;' },
  { name: "N5 object-carried any", file: "dashboard-ir.ts", rule: "mint", code: 'function probeAny(v: { text: any }): { text: KitText } { return v; }' },
  { name: "N5 array-carried any", file: "dashboard-ir.ts", rule: "mint", code: 'function probeAny(v: any[]): KitText[] { return v; }' },
  { name: "N5 existing array spread any", file: "dashboard-ir.ts", rule: "any", code: 'function probeAny(v: any[]): KitText[] { return [...v]; }' },
  { name: "N5 generic callable return any", file: "dashboard-ir.ts", rule: "mint", code: 'const probeParser: <T>(s: string) => T = JSON.parse; const probeText = probeParser<KitText>("raw");' },
  { name: "N5 rest parameter widening", file: "dashboard-ir.ts", rule: "mint", code: 'const probeV: { f(...s: string[]): KitText } = { f: (...s: KitText[]): KitText => s[0]! };' },
  { name: "N5 tuple parameter widening", file: "dashboard-ir.ts", rule: "mint", code: 'const probeV: { f(s: [string]): KitText } = { f: (s: [KitText]): KitText => s[0] };' },
  { name: "N5 constrained parameter widening", file: "dashboard-ir.ts", rule: "mint", code: 'const probeV: { f(s: string): KitText } = { f: <T extends KitText>(s: T): KitText => s };' },
  { name: "N5 overload parameter widening", file: "dashboard-ir.ts", rule: "mint", code: 'const probeV: { f(s: KitText): KitText; f(s: string): KitText } = { f: (s: KitText): KitText => s };' },
  { name: "N5 index-carried any", file: "dashboard-ir.ts", rule: "mint", code: 'function probeAny(v: Record<string, any>): Record<string, KitText> { return v; }' },
  { name: "N5 array-carried any assertion", file: "dashboard-ir.ts", rule: "mint", code: 'function probeAny(v: unknown): KitText[] { return v as any[]; }' },
  { name: "N5 object-carried any assertion", file: "dashboard-ir.ts", rule: "mint", code: 'function probeAny(v: unknown): { text: KitText } { return v as { text: any }; }' },
  { name: "N5 constructor-carried any", file: "dashboard-ir.ts", rule: "mint", code: 'declare const probeCtor: new () => { text: any }; const probeBranded: new () => { text: KitText } = probeCtor;' },
  { name: "N5 mutable array parameter widening", file: "dashboard-ir.ts", rule: "mint", code: 'function probeArray(raw: string): KitText { const branded: KitText[] = [kitText("checked")]; const widened: string[] = branded; widened.push(raw); return branded[1]!; }' },
  { name: "N5 asserted void parameter widening", file: "dashboard-ir.ts", rule: "mint", code: 'const probeF = ((s: KitText): void => {}) as { f(s: string): void }["f"];' },
  { name: "N5 structured union parameter widening", file: "dashboard-ir.ts", rule: "mint", code: 'const probeV: { f(s: { text: KitText } | { text: string }): KitText } = { f: (s: { text: KitText }): KitText => s.text };' },
  { name: "N5 mutable property widening", file: "dashboard-ir.ts", rule: "mint", code: 'function probeProperty(raw: string): KitText { const branded = { payload: kitText("checked") }; const widened: { payload: string } = branded; widened.payload = raw; return branded.payload; }' },
  { name: "N5 mutable index widening", file: "dashboard-ir.ts", rule: "mint", code: 'function probeIndex(raw: string): KitText { const branded: Record<string, KitText> = { payload: kitText("checked") }; const widened: Record<string, string> = branded; widened.payload = raw; return branded.payload!; }' },
  { name: "N5 constrained generic argument", file: "dashboard-ir.ts", rule: "mint", code: 'function probeTake<T extends { f(s: string): KitText }>(v: T): T { return v; } const probeV = probeTake({ f: (s: KitText): KitText => s });' },
  { name: "N5 nested constrained generic argument", file: "dashboard-ir.ts", rule: "mint", code: 'function probeTake<T extends { f(s: string): KitText }>(v: { value: T }): T { return v.value; } const probeV = probeTake({ value: { f: (s: KitText): KitText => s } });' },
  { name: "N5 this parameter widening", file: "dashboard-ir.ts", rule: "mint", code: 'const probeV: { f(this: string): KitText } = { f(this: KitText): KitText { return this; } };' },
  { name: "N5 tuple rest to fixed parameters", file: "dashboard-ir.ts", rule: "mint", code: 'const probeV: { f(s: string, t: string): KitText } = { f: (...s: [KitText, KitText]): KitText => s[0] };' },
  { name: "N5 fixed to tuple rest parameters", file: "dashboard-ir.ts", rule: "mint", code: 'const probeV: { f(...s: [string, string]): KitText } = { f: (s: KitText, t: KitText): KitText => s };' },
  { name: "N5 array rest to fixed parameter", file: "dashboard-ir.ts", rule: "mint", code: 'const probeV: { f(s: string): KitText } = { f: (...s: KitText[]): KitText => s[0]! };' },
  { name: "N5 mixed union parameter widening", file: "dashboard-ir.ts", rule: "mint", code: 'const probeV: { f(s: string | number): KitText } = { f: (s: KitText | number): KitText => typeof s === "number" ? kitText("checked") : s };' },
  { name: "N5 Map to ReadonlyMap any", file: "dashboard-ir.ts", rule: "mint", code: 'function probeMap(v: Map<string, any>): ReadonlyMap<string, KitText> { return v; }' },
  { name: "N5 Promise to PromiseLike any", file: "dashboard-ir.ts", rule: "mint", code: 'function probePromise(v: Promise<any>): PromiseLike<KitText> { return v; }' },
  { name: "N5 iterator to iterable any", file: "dashboard-ir.ts", rule: "mint", code: 'function probeIterator(v: IterableIterator<any>): Iterable<KitText> { return v; }' },
  { name: "N5 array to iterable any", file: "dashboard-ir.ts", rule: "mint", code: 'function probeIterable(v: any[]): Iterable<KitText> { return v; }' },
  { name: "N5 Map to iterable any", file: "dashboard-ir.ts", rule: "mint", code: 'function probeIterable(v: Map<string, any>): Iterable<readonly [string, KitText]> { return v; }' },
  { name: "N5 variadic tuple rest widening", file: "dashboard-ir.ts", rule: "mint", code: 'const probeV: { f(n: number, s: string): KitText } = { f: (...s: [number, ...KitText[]]): KitText => s[1]! };' },
  { name: "N5 variadic tuple trailing parameter widening", file: "dashboard-ir.ts", rule: "mint", code: 'const probeV: { f(n: number, s: KitText, t: string): KitText } = { f: (...s: [number, ...KitText[]]): KitText => s[2]! };' },
  { name: "N5 constrained generic rest argument", file: "dashboard-ir.ts", rule: "mint", code: 'function probeTake<T extends { f(s: string): KitText }>(...v: T[]): T | undefined { return v[0]; } const probeV = probeTake({ f: (s: KitText): KitText => s });' },
  { name: "N5 constrained generic tuple rest argument", file: "dashboard-ir.ts", rule: "mint", code: 'function probeTake<T extends { f(s: string): KitText }>(...v: [number, ...T[]]): T | undefined { return v[1]; } const probeV = probeTake(0, { f: (s: KitText): KitText => s });' },
  { name: "N5 constrained generic array rest spread", file: "dashboard-ir.ts", rule: "mint", code: 'function probeTake<T extends { f(s: string): KitText }>(...v: T[]): T | undefined { return v[0]; } const probeV = probeTake(...[{ f: (s: KitText): KitText => s }]);' },
  { name: "N5 constrained generic tuple rest spread", file: "dashboard-ir.ts", rule: "mint", code: 'function probeTake<T extends { f(s: string): KitText }>(...v: [number, ...T[]]): T | undefined { return v[1]; } const probeV = probeTake(0, ...[{ f: (s: KitText): KitText => s }]);' },
  { name: "N5 offset rest argument", file: "dashboard-ir.ts", rule: "mint", code: 'function probeTake(n: number, ...v: { f(s: string): KitText }[]): { f(s: string): KitText } { return v[0]!; } const probeV = probeTake(0, { f: (s: KitText): KitText => s });' },
  { name: "N5 offset rest spread", file: "dashboard-ir.ts", rule: "mint", code: 'function probeTake(n: number, ...v: { f(s: string): KitText }[]): { f(s: string): KitText } { return v[0]!; } const probeNarrow = [{ f: (s: KitText): KitText => s }]; const probeV = probeTake(0, ...probeNarrow);' },
  { name: "N5 constrained generic symbol argument", file: "dashboard-ir.ts", rule: "mint", code: 'function probeTake<T extends { f(s: string): KitText }>(v: T): { f(s: string): KitText } { return v; } const probeNarrow = { f: (s: KitText): KitText => s }; const probeV = probeTake(probeNarrow);' },
  { name: "N5 this-only parameter widening", file: "dashboard-ir.ts", rule: "mint", code: 'const probeV: { f(this: string): void } = { f(this: KitText): void {} };' },
  { name: "N5 this-only parameter loss", file: "dashboard-ir.ts", rule: "mint", code: 'const probeV: { f(): void } = { f(this: KitText): void {} };' },
  { name: "N5 mapped mutable property widening", file: "dashboard-ir.ts", rule: "mint", code: 'type ProbeMutable<T> = { -readonly [K in keyof T]: T[K] }; function probeProperty(raw: string): KitText { const branded: { readonly payload: KitText } = { payload: kitText("checked") }; const widened: ProbeMutable<{ readonly payload: string }> = branded; widened.payload = raw; return branded.payload; }' },
  { name: "N5 readonly array consumer widening", file: "dashboard-ir.ts", rule: "mint", code: 'class ProbeArray extends Array<KitText> { override includes(s: KitText): boolean { this.push(s); return true; } } function probeArray(raw: string): KitText { const branded = new ProbeArray(); const narrow: readonly KitText[] = branded; const widened: readonly string[] = narrow; widened.includes(raw); return branded[0]!; }' },
  { name: "N5 readonly Map key consumer widening", file: "dashboard-ir.ts", rule: "mint", code: 'class ProbeMap extends Map<KitText, KitText> { override get(key: KitText): KitText | undefined { this.set(kitText("checked"), key); return key; } } function probeMap(raw: string): KitText | undefined { const branded = new ProbeMap(); const narrow: ReadonlyMap<KitText, KitText> = branded; const widened: ReadonlyMap<string, KitText> = narrow; widened.get(raw); return branded.get(kitText("checked")); }' },
  { name: "N5 nested callable return any", file: "dashboard-ir.ts", rule: "mint", code: 'const probeParser: { parse(s: string): KitText } = { parse: JSON.parse };' },
  { name: "N5 existing direct JSON.parse any", file: "dashboard-ir.ts", rule: "any", code: 'const probeText: KitText = JSON.parse("raw");' },
  { name: "N5 existing any parameter", file: "dashboard-ir.ts", rule: "any", code: 'function probeAny(v: any): KitText { return v; }' },
  { name: "N5 existing as any", file: "dashboard-ir.ts", rule: "assertion", code: 'const probeText: KitText = "raw" as any;' },
  { name: "N5 suppressed string initializer", file: "dashboard-ir.ts", rule: "mint", lineOffset: 1, code: '// @ts-ignore\nconst probeText: KitText = "raw";' },
  { name: "N5 existing any argument", file: "dashboard-ir.ts", rule: "any", code: 'function probeAny(v: any): KitText { return joinKitText(v); }' },
  { name: "N5 existing any object member", file: "dashboard-ir.ts", rule: "any", code: 'function probeAny(v: any): { text: KitText } { return { text: v }; }' },
  { name: "N5 existing any array member", file: "dashboard-ir.ts", rule: "any", code: 'function probeAny(v: any): KitText[] { return [v]; }' },
  { name: "F10 X1 structural text write in IR", file: "dashboard-ir.ts", rule: "text-sink", code: 'export function probeSlotWrite(x: { textContent: string }, s: string): void { x.textContent = s; }' },
  { name: "F10 X1b structural text write in binder", file: "dashboard-ir-binder.ts", rule: "text-sink", code: 'export function probeSlotWrite(x: { textContent: string }, s: string): void { x.textContent = s; }' },
  { name: "F10 structural text write in renderer", file: "dashboard-ir-renderer.ts", rule: "text-sink", code: 'function probeSlotWrite(x: { textContent: string }, s: string): void { x.textContent = s; }' },
  { name: "F10 structural text write in browser entry", file: "dashboard-ir-browser-entry.ts", rule: "text-sink", code: 'function probeSlotWrite(x: { textContent: string }, s: string): void { x.textContent = s; }' },
  { name: "F10 compound structural text write", file: "dashboard-ir.ts", rule: "text-sink", code: 'function probeSlotWrite(x: { textContent: string }, s: string): void { x.textContent += s; }' },
  { name: "F10 computed literal structural text write", file: "dashboard-ir-binder.ts", rule: "text-sink", code: 'function probeSlotWrite(x: { textContent: string }, s: string): void { x["textContent"] = s; }' },
  { name: "F10 computed key structural text write", file: "dashboard-ir-binder.ts", rule: "text-sink", code: 'function probeSlotWrite(x: { textContent: string }, s: string): void { const key = "textContent"; x[key] = s; }' },
  { name: "F10 destructured structural text write", file: "dashboard-ir.ts", rule: "text-sink", code: 'function probeSlotWrite(x: { textContent: string }, s: string): void { [x.textContent] = [s]; }' },
  { name: "F10 callback cannot inherit setText sink", file: "dashboard-ir-browser-entry.ts", rule: "text-sink", needle: 'export function setText(node: { textContent: string | null }, text: KitText): void {', code: 'export function setText(node: { textContent: string | null }, text: KitText): void { const probeSlotWrite = (x: { textContent: string }, s: string): void => { x.textContent = s; };' },
  { name: "N3 nested predicate inside approved stamp", file: "dashboard-ir-renderer.ts", rule: "mint", needle: 'function stamp(iso: string): KitText {', code: 'function stamp(iso: string): KitText { const probeIsK = (s: string): s is KitText => s.length > 0;' },
  { name: "unlinted binder receives DOM wrapper", file: "dashboard-ir-binder.ts", rule: "inventory", code: 'function probeDomWrapper(n: import("./dashboard-ir-renderer.js").RElement) { return n.className; }' },
  { name: "C1 structural CSSOM escape", file: "dashboard-ir-renderer.ts", rule: "assertion", code: 'function probeC1(n: RElement, raw: string) { (n as unknown as { _el: { ownerDocument: { styleSheets: { item(i: number): { insertRule(r: string, i?: number): void } | null } } } })._el.ownerDocument.styleSheets.item(0)?.insertRule(".pcc-ir::before{content:" + JSON.stringify(raw) + "}", 0); }' },
  { name: "binder structural object escape", file: "dashboard-ir-binder.ts", rule: "assertion", code: 'function probeObject(raw: unknown) { return raw as unknown as { hidden: string }; }' },
  { name: "IR structural object escape", file: "dashboard-ir.ts", rule: "assertion", code: 'function probeObject(raw: unknown) { return raw as unknown as { hidden: string }; }' },
  { name: "B1 nested stamp", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'function probeB1() { function stamp(s: string) { return s as KitText; } return stamp("raw"); }' },
  { name: "B2 object method readField", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'const probeB2 = { readField(s: string) { return s as KitText; } };' },
  { name: "B3 local arrow bindScalar", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'function probeB3(s: string) { const bindScalar = (s: string) => s as KitText; return bindScalar(s); }' },
  { name: "B4 shadowed kitText", file: "dashboard-ir.ts", rule: "mint", code: 'function probeB4(s: string) { const kitText = (s: string) => s as KitText; return kitText(s); }' },
  { name: "class member stamp", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'class ProbeClass { stamp(s: string) { return s as KitText; } }' },
  { name: "object arrow stamp", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'const probeArrow = { stamp: (s: string) => s as KitText };' },
  { name: "class arrow stamp", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'class ProbeArrow { stamp = (s: string) => s as KitText; }' },
  { name: "getter stamp without mint", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'const probeGetter = { get stamp() { return "raw"; } };' },
  { name: "setter stamp without mint", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'const probeSetter = { set stamp(s: string) { void s; } };' },
  { name: "bound function expression stamp", file: "dashboard-ir-renderer.ts", rule: "mint", code: 'function probeExpression(s: string) { const stamp = function (s: string) { return s as KitText; }; return stamp(s); }' },
  { name: "wrapped local arrow stamp", file: "dashboard-ir-renderer.ts", rule: "mint", code: "function probeWrapped() { const stamp = (() => \"raw\"); return stamp(); }" },
  { name: "wrapped object function stamp", file: "dashboard-ir-renderer.ts", rule: "mint", code: "const probeWrapped = { stamp: (function () { return \"raw\"; }) };" },
  { name: "wrapped class arrow stamp", file: "dashboard-ir-renderer.ts", rule: "mint", code: "class ProbeWrapped { stamp = (() => \"raw\"); }" },
  { name: "wrapped computed method stamp", file: "dashboard-ir-renderer.ts", rule: "mint", code: "const probeWrapped = { [(\"stamp\") as const]() { return \"raw\"; } };" },
  { name: "assigned arrow stamp", file: "dashboard-ir-renderer.ts", rule: "mint", code: "function probeAssigned() { let stamp: () => string; stamp = () => \"raw\"; return stamp(); }" },
  { name: "AgentText mint in kitText", file: "dashboard-ir.ts", rule: "mint", needle: 'return registerKitText(s);', code: 'const prose = s as AgentText; void prose; return registerKitText(s);' },
  { name: "KitText mint in manifestProseText", file: "dashboard-ir-renderer.ts", rule: "mint", needle: 'return registerAgentText(String(n.props?.[key] ?? ""));', code: 'const own = String(n.props?.[key] ?? "") as KitText; void own; return registerAgentText(String(n.props?.[key] ?? ""));' },
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

export const N5_EXPECTED_DIAGNOSTICS: Record<string, { node: readonly number[]; browser: readonly number[] }> = {
  "N5 Z1 object-literal bivariance": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 class implements method interface": {
    "node": [
      2416
    ],
    "browser": [
      2416
    ]
  },
  "N5 class extends method member": {
    "node": [
      2416
    ],
    "browser": [
      2416
    ]
  },
  "N5 static class extends method member": {
    "node": [
      2417
    ],
    "browser": [
      2417
    ]
  },
  "N5 accessor writer widening": {
    "node": [],
    "browser": []
  },
  "N5 readonly accessor intermediary": {
    "node": [],
    "browser": []
  },
  "N5 readonly data intermediary": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 mapped readonly data intermediary": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 getter spread data widening": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 readonly data declaration widening": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 readonly index intermediary": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 generic accessor class widening": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 instantiated accessor factory widening": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 opaque accessor factory widening": {
    "node": [],
    "browser": []
  },
  "N5 method argument": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 function variable initializer": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 assignment": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 property initializer": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 object method member": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 return": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 contextual arrow return": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 default value": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 array element": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 array spread": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 object spread": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 satisfies relation": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 union parameter widening": {
    "node": [],
    "browser": []
  },
  "N5 JSON.parse callable return any": {
    "node": [],
    "browser": []
  },
  "N5 ambient callable return any": {
    "node": [],
    "browser": []
  },
  "N5 object-carried any": {
    "node": [],
    "browser": []
  },
  "N5 array-carried any": {
    "node": [],
    "browser": []
  },
  "N5 existing array spread any": {
    "node": [],
    "browser": []
  },
  "N5 generic callable return any": {
    "node": [],
    "browser": []
  },
  "N5 rest parameter widening": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 tuple parameter widening": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 constrained parameter widening": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 overload parameter widening": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 index-carried any": {
    "node": [],
    "browser": []
  },
  "N5 array-carried any assertion": {
    "node": [],
    "browser": []
  },
  "N5 object-carried any assertion": {
    "node": [],
    "browser": []
  },
  "N5 constructor-carried any": {
    "node": [],
    "browser": []
  },
  "N5 mutable array parameter widening": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 asserted void parameter widening": {
    "node": [
      2352
    ],
    "browser": [
      2352
    ]
  },
  "N5 structured union parameter widening": {
    "node": [],
    "browser": []
  },
  "N5 mutable property widening": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 mutable index widening": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 constrained generic argument": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 nested constrained generic argument": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 this parameter widening": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 tuple rest to fixed parameters": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 fixed to tuple rest parameters": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 array rest to fixed parameter": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 mixed union parameter widening": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 Map to ReadonlyMap any": {
    "node": [],
    "browser": []
  },
  "N5 Promise to PromiseLike any": {
    "node": [],
    "browser": []
  },
  "N5 iterator to iterable any": {
    "node": [],
    "browser": []
  },
  "N5 array to iterable any": {
    "node": [],
    "browser": []
  },
  "N5 Map to iterable any": {
    "node": [],
    "browser": []
  },
  "N5 variadic tuple rest widening": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 variadic tuple trailing parameter widening": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 constrained generic rest argument": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 constrained generic tuple rest argument": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 constrained generic array rest spread": {
    "node": [
      2345
    ],
    "browser": [
      2345
    ]
  },
  "N5 constrained generic tuple rest spread": {
    "node": [
      2345
    ],
    "browser": [
      2345
    ]
  },
  "N5 offset rest argument": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 offset rest spread": {
    "node": [
      2345
    ],
    "browser": [
      2345
    ]
  },
  "N5 constrained generic symbol argument": {
    "node": [
      2345
    ],
    "browser": [
      2345
    ]
  },
  "N5 this-only parameter widening": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 this-only parameter loss": {
    "node": [],
    "browser": []
  },
  "N5 mapped mutable property widening": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 readonly array consumer widening": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 readonly Map key consumer widening": {
    "node": [
      2322
    ],
    "browser": [
      2322
    ]
  },
  "N5 nested callable return any": {
    "node": [],
    "browser": []
  },
  "N5 existing direct JSON.parse any": {
    "node": [],
    "browser": []
  },
  "N5 existing any parameter": {
    "node": [],
    "browser": []
  },
  "N5 existing as any": {
    "node": [],
    "browser": []
  },
  "N5 suppressed string initializer": {
    "node": [],
    "browser": []
  },
  "N5 existing any argument": {
    "node": [],
    "browser": []
  },
  "N5 existing any object member": {
    "node": [],
    "browser": []
  },
  "N5 existing any array member": {
    "node": [],
    "browser": []
  }
};

export const R2E_SAFE_PROGRAMS = [
  {
    "name": "r2e A4d presence condition with !!",
    "rule": "mint",
    "file": "dashboard-ir-binder.ts",
    "needle": "  const bind = node.bind;\n",
    "code": "  const bind = node.bind;\n  if (!!onStale) { void 0; }\n",
    "lineOffset": 1
  }
] as const;

export const GUARD_PROGRAM_COUNT = 379;
export const GUARD_PROGRAM_MANIFEST_SHA256 = "bfba8b0432cb67d69a8ae6e656fe56c1eb35d8e6dc36091367fd3b4bfc1499b1";
export const GUARD_TIMEOUT_MS = 180_000;

export const GUARD_SHARDS = (() => {
  const shards: (typeof MUTATIONS[number])[][] = [[], [], [], []];
  for (const mutation of MUTATIONS) if (mutation.name.startsWith("N5")) shards[1]!.push(mutation);
  for (const mutation of MUTATIONS) {
    if (mutation.name.startsWith("N5")) continue;
    if (["B1 nested stamp", "N3 nested predicate inside approved stamp"].includes(mutation.name)) shards[0]!.push(mutation);
    else shards.reduce((smallest, shard) => shard.length < smallest.length ? shard : smallest).push(mutation);
  }
  return shards;
})();

export async function initializeGuard(mutations: readonly typeof MUTATIONS[number][], shard: number): Promise<void> {
  const started = performance.now();
  config = readConfig("tsconfig.browser.json");
  const host = ts.createCompilerHost(config.options);
  const readFile = host.readFile.bind(host);
  host.readFile = (path) => readFile(path)?.replace(/\r\n/g, "\n");
  program = ts.createProgram(config.fileNames, config.options, host);
  baseAudit = audit(program);
  mutationLines = new Map();
  mutationAudits = new Map();
  for (const mutation of mutations) {
    await new Promise<void>((done) => setTimeout(done, 0));
    const path = join(src, "mcp", mutation.file);
    const text = readFileSync(path, "utf8");
    const index = "needle" in mutation ? text.indexOf(mutation.needle) : -1;
    if ("needle" in mutation && index < 0) throw new Error(`Mutation target missing: ${mutation.name}`);
    const line = (index < 0 ? text.split("\n").length + 1 : text.slice(0, index).split("\n").length) + ("lineOffset" in mutation ? mutation.lineOffset : 0);
    const changed = "needle" in mutation ? text.replace(mutation.needle, mutation.code) : `${text}\n${mutation.code}\n`;
    mutationLines.set(mutation.name, { file: `mcp/${mutation.file}`, line, rule: mutation.rule });
    mutationAudits.set(mutation.name, audit(overriddenProgram(new Map([[path, changed]]))));
  }
  console.log("IR-TEXT-GUARD-TIMING", JSON.stringify({ shard, beforeAllMs: Math.round(performance.now() - started), programs: mutations.length + 1, timeoutMs: GUARD_TIMEOUT_MS }));
}
