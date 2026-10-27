/**
 * N71 round 7 (astra pack 83f, DO-NOT-SHIP at 7d8ba154): the sink scanner, rebuilt
 * BY DECLARATION, as ruled (DECISIONS.md, "N71 (#451): round 7 drops every hand
 * list", 05:43).
 *
 * Rounds 1-6 each closed only the sink SHAPES, safe-value NAMES, or FILES astra
 * happened to show the lane — a hand list of each. Round 6's own scanner (still
 * readable in git history) proved that pattern wrong a SIXTH time: it trusted a list
 * of 8 call shapes, a per-file name allowlist with prose reasons, and a 12-file
 * scope — and astra's round-7 verdict found four CRITICALs and a MEDIUM sitting
 * exactly in those three hand lists, not in any site the old scanner saw. This file
 * establishes the following bounded static property:
 *
 * (P1) A recognized sink value (a sink object, a sink method or a sink-typed receiver) may appear only as the callee or receiver of a call the engine classifies, or as a const alias the engine tracks.
 * (P2) A sink value in ANY other position is an ESCAPE, and an escape fails closed: it is a violation row, or an unresolved/escape row that needs a reviewed baseline reason. "Any other position" includes:
 *   - a call or `new` argument;
 *   - an object-literal property value;
 *   - an array element;
 *   - a property or field assignment;
 *   - a destructuring ASSIGNMENT (not only a declaration);
 *   - a return value;
 *   - a default parameter value;
 *   - a spread.
 * (P3) A parameter that reaches a sink unformatted makes its function a DERIVED sink for that argument position, and the engine then scans that function's callers. Run it to a fixpoint, not one level. A baseline row may no longer admit a forwarder's parameter leaf for its future callers.
 *   - Stored-field provenance follows every statically resolved assignment write to a property's symbol and its declarations, including element-access and destructuring assignment targets. This is flow-insensitive: it does not prove execution order or which runtime object instance a write targets.
 *   - Unresolved computed property keys, reflection or helper-based mutations, implicit constructor parameter-property writes, and writes outside the indexed program can still escape this provenance pass. It is not general heap-alias or accessor-side-effect analysis.
 * (P4) Receiver recognition covers:
 *   - union constituents and `checker.getNonNullableType` (so `trace.getActiveSpan()` and `Span | undefined` are recognized);
 *   - mapped and `Pick<>` types, through `checker.getPropertyOfType(type, method)?.declarations`;
 *   - pino/fastify `LogFn` and OTel's `Span` in the resolved-signature fallback.
 * (P5) Proofs:
 *   - A function expression counts as control flow only in positions the engine verifies, where its return value can't reach the sink argument (codex F5, :925).
 *   - `JSON.stringify` is transparent only with no second argument, or a null/undefined or literal-array second argument, AND an argument whose value is proven. Any replacer function, or a value that may carry `toJSON`, is unproven (codex F5, :997).
 *   - A destructured or trace binding that is ever reassigned, or written through a property, is not trusted from its initializer (codex F5, :882).
 *   - A parameter proof is refused for a method that overrides a base member or implements an interface member (Opus F3 shape 5).
 *   - The literal-union shortcut applies only to an identifier root, or to a root that is itself proven (Opus F3 shape 6).
 *
 * A discarded result of a classified fluent call is not a sink-value use.
 * Public derived methods make a receiver a sink container; private/protected
 * helpers remain derived at their callable members and every invocation.
 * Recognition is declaration/provenance based, not a claim to reconstruct every
 * runtime value or arbitrary reflection. Unresolved callees and recognized sink
 * escapes fail closed. The whole gateway package is scanned; the existing
 * baseline is shrink-only unless an occurrence receives an explicit review.
 *
 * This file is the ENGINE only (Program/TypeChecker setup, sink resolution,
 * argument-safety proof, whole-package scan, baseline diffing) — no vitest
 * dependency, so `scripts/generate-n71-sink-baseline.ts` can import it directly.
 * n71-sink-scanner.test.ts wraps it in `describe`/`it` and adds the probe suite.
 */

import * as ts from "typescript";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

const THIS_DIR = dirname(fileURLToPath(import.meta.url)); // .../packages/gateway/src/__tests__
export const GATEWAY_ROOT = resolve(THIS_DIR, "..", ".."); // .../packages/gateway
export const GATEWAY_SRC = join(GATEWAY_ROOT, "src");
const TSCONFIG_PATH = join(GATEWAY_ROOT, "tsconfig.json");
export const BASELINE_PATH = join(THIS_DIR, "fixtures", "n71-sink-baseline.json");
export const PROBE_FIXTURE_PATH = join(THIS_DIR, "fixtures", "n71-sink-scanner-probes.ts");

/**
 * N71's own scope (DECISIONS.md 05:43, ruling (4)): these files must have ZERO
 * violations. Every other file in the whole-package scan goes through the
 * shrink-only baseline instead. Paths are relative to packages/gateway/src/.
 */
export const N71_SCOPE_FILES: readonly string[] = [
  "facades/base.facade.ts",
  "facades/capability.facade.ts",
  "facades/compliance.facade.ts",
  "facades/facade-errors.ts",
  "facades/job.facade.ts",
  "facades/kernel.facade.ts",
  "facades/populators/device.populator.ts",
  "facades/settlement.facade.ts",
  "redaction.ts",
  "routes/job-submit.ts",
  "routes/setup.ts",
  "services/kernel-service.ts",
];

// ─────────────────────────────────────────────────────────────────────────────
// Declaration-path constants (ruling (1)'s sink surface, named explicitly)
// ─────────────────────────────────────────────────────────────────────────────

const TELEMETRY_FILE_SUFFIX = "/src/telemetry.ts";
const TRACING_FILE_SUFFIX = "/src/tracing.ts";
const SENTRY_FILE_SUFFIX = "/src/sentry.ts";
const POSTHOG_FILE_SUFFIX = "/src/services/posthog-service.ts";
const SENTRY_PKG = "/node_modules/@sentry/";
const OTEL_PKG = "/node_modules/@opentelemetry/";
const FASTIFY_PKG = "/node_modules/fastify/";
const PINO_PKG = "/node_modules/pino/";

const LOGGER_METHODS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "child"]);

/** Formatters recognized BY DECLARATION (file + exported name), never by bare name
 *  matching alone. Their own arguments are deliberately not recursed into — the
 *  whole point of each is to launder an otherwise-unsafe value. */
const SAFE_FORMATTERS: ReadonlyArray<{ name: string; fileSuffix: string }> = [
  { name: "logSafeId", fileSuffix: "/src/redaction.ts" },
  { name: "knownErrorClassName", fileSuffix: "/src/redaction.ts" },
  { name: "logSafeSmallInt", fileSuffix: "/src/redaction.ts" },
  { name: "logSafeInt", fileSuffix: "/src/redaction.ts" },
  { name: "logSafeIsoTimestamp", fileSuffix: "/src/redaction.ts" },
  { name: "logSafeAddress", fileSuffix: "/src/redaction.ts" },
  { name: "facadeErrorTelemetryCode", fileSuffix: "/src/facades/facade-errors.ts" },
  { name: "safeServerEventProperties", fileSuffix: "/src/services/posthog-policy.ts" },
  { name: "safeServerEventDistinctId", fileSuffix: "/src/services/posthog-policy.ts" },
  { name: "prepareServerEventDistinctId", fileSuffix: "/src/services/posthog-policy.ts" },
];

// ─────────────────────────────────────────────────────────────────────────────
// AST helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Strip parens/`as`/`<T>`/`!` wrappers. Never strips optional chaining. */
function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  for (;;) {
    if (ts.isParenthesizedExpression(n)) { n = n.expression; continue; }
    if (ts.isAsExpression(n)) { n = n.expression; continue; }
    if (ts.isTypeAssertionExpression(n)) { n = n.expression; continue; }
    if (ts.isNonNullExpression(n)) { n = n.expression; continue; }
    return n;
  }
}

function isIdentifierNamed(expr: ts.Expression, name: string): boolean {
  const n = unwrap(expr);
  return ts.isIdentifier(n) && n.text === name;
}

function isLiteralLike(expr: ts.Expression): boolean {
  const n = unwrap(expr);
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n)) return true;
  if (n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword || n.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(n) && n.text === "undefined") return true;
  // A negative numeric literal (`-1`) parses as a PrefixUnaryExpression, not a
  // NumericLiteral — still a literal value by construction.
  if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(n.operand)) return true;
  return false;
}

function isBuiltinUndefined(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  const n = unwrap(expr);
  if (!ts.isIdentifier(n) || n.text !== "undefined") return false;
  const symbol = checker.getSymbolAtLocation(n);
  return !symbol?.valueDeclaration && !symbol?.declarations?.length;
}

function declarationFiles(sym: ts.Symbol | undefined): string[] {
  if (!sym?.declarations) return [];
  return sym.declarations.map((d) => d.getSourceFile().fileName);
}

function anyDeclFileMatches(sym: ts.Symbol | undefined, pred: (file: string) => boolean): boolean {
  return declarationFiles(sym).some(pred);
}

/** Resolve a symbol at `expr`, following import/re-export aliases to their target. */
function resolveSymbol(expr: ts.Expression, checker: ts.TypeChecker): ts.Symbol | undefined {
  const n = unwrap(expr);
  let sym = ts.isIdentifier(n) && ts.isShorthandPropertyAssignment(n.parent) ? checker.getShorthandAssignmentValueSymbol(n.parent) :
    ts.isPropertyAccessExpression(n) ? checker.getSymbolAtLocation(n.name) : checker.getSymbolAtLocation(n);
  const seen = new Set<ts.Symbol>();
  while (sym && sym.flags & ts.SymbolFlags.Alias && !seen.has(sym)) {
    seen.add(sym);
    const aliased = checker.getAliasedSymbol(sym);
    if (!aliased || aliased === sym) break;
    sym = aliased;
  }
  return sym;
}

// ─────────────────────────────────────────────────────────────────────────────
// Program / TypeChecker (built ONCE, cached)
// ─────────────────────────────────────────────────────────────────────────────

export interface ScannerContext {
  program: ts.Program;
  checker: ts.TypeChecker;
  /** Absolute file names tsconfig.json's own include/exclude resolves to. */
  scopeFileNames: string[];
  /** ms spent building the Program (ts.createProgram + getTypeChecker). */
  buildMs: number;
  /** Function symbol -> every call site (whole scope) invoking it, for proving a
   *  parameter is always passed a literal across the WHOLE program (e.g.
   *  BaseFacade.execute()'s `operation`, called from every facade subclass). */
  callSitesByDecl: Map<ts.Node, Invocation[]>;
  escapedFunctions: Set<ts.Node>;
}

let cached: ScannerContext | null = null;

export function getScanner(): ScannerContext {
  if (cached) return cached;
  const t0 = performance.now();
  const configFile = ts.readConfigFile(TSCONFIG_PATH, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(`tsconfig read error: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")}`);
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, GATEWAY_ROOT);
  const rootNames = [...parsed.fileNames, PROBE_FIXTURE_PATH];
  const program = ts.createProgram({ rootNames, options: parsed.options });
  const checker = program.getTypeChecker();
  const buildMs = performance.now() - t0;
  const { callSitesByDecl, escapedFunctions } = buildCallSiteIndex(program, checker, rootNames);
  cached = { program, checker, scopeFileNames: parsed.fileNames, buildMs, callSitesByDecl, escapedFunctions };
  return cached;
}

/** Resolve callable implementations, including variable/property-held closures. */
function callableDeclaration(expr: ts.Expression, checker: ts.TypeChecker): ts.FunctionLikeDeclaration | undefined {
  const n = unwrap(expr);
  if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return n;
  const decl = resolveSymbol(n, checker)?.valueDeclaration;
  if (decl && ts.isFunctionLike(decl) && "parameters" in decl && "body" in decl) return decl as ts.FunctionLikeDeclaration;
  if (decl && (ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl) || ts.isPropertyDeclaration(decl)) && decl.initializer) {
    const init = unwrap(decl.initializer);
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
  }
  return undefined;
}

/** Function/method declarations invoked anywhere in `scopeFileNames`, keyed by
 *  declaration node, each with every call site found. Used to prove a PARAMETER
 *  (not just a local variable) is always literal across the whole program — see
 *  isSafeParameterReference. */
function buildCallSiteIndex(
  program: ts.Program,
  checker: ts.TypeChecker,
  scopeFileNames: string[],
): { callSitesByDecl: Map<ts.Node, Invocation[]>; escapedFunctions: Set<ts.Node> } {
  const index = new Map<ts.Node, Invocation[]>();
  const escapedFunctions = new Set<ts.Node>();
  for (const fileName of scopeFileNames) {
    const sf = program.getSourceFile(fileName);
    if (!sf) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const sym = resolveSymbol(node, checker);
        const decl = sym?.valueDeclaration;
        if (decl && (ts.isMethodDeclaration(decl) || ts.isFunctionDeclaration(decl))) {
          const parent = node.parent;
          const directCall = ts.isCallExpression(parent) && parent.expression === node;
          const declarationName = (decl as ts.NamedDeclaration).name === node;
          const memberName = ts.isPropertyAccessExpression(parent) && parent.name === node;
          const importName = ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent);
          if (!directCall && !declarationName && !memberName && !importName) escapedFunctions.add(decl);
        }
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const targets = new Set<ts.Node>(callableTargets(node.expression, checker));
        const signature = checker.getResolvedSignature(node)?.declaration;
        if (signature) targets.add(signature);
        for (const decl of targets) if (ts.isFunctionLike(decl)) {
          const arr = index.get(decl) ?? [];
          arr.push(node);
          index.set(decl, arr);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { callSitesByDecl: index, escapedFunctions };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sink resolution — ruling (1): by declaration, default-deny
// ─────────────────────────────────────────────────────────────────────────────

type Invocation = ts.CallExpression | ts.NewExpression;
type SinkCall = Invocation | ts.TaggedTemplateExpression;
const UNSUPPORTED_SINK = "<unsupported-sink>";

function memberAccess(expr: ts.Expression): { receiver: ts.Expression; name: string | null } | null {
  const n = unwrap(expr);
  if (ts.isPropertyAccessExpression(n)) return { receiver: n.expression, name: n.name.text };
  if (ts.isElementAccessExpression(n)) {
    const key = n.argumentExpression && unwrap(n.argumentExpression);
    return { receiver: n.expression, name: key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key) || ts.isNumericLiteral(key)) ? key.text : null };
  }
  return null;
}

/** Follow local value provenance as well as TypeScript's import aliases. Every
 * possible assignment participates, so a reassigned alias cannot hide a sink. */
const originCache = new WeakMap<ts.TypeChecker, WeakMap<ts.Expression, ts.Expression[]>>();
function localOrigins(expr: ts.Expression, checker: ts.TypeChecker, seen = new Set<ts.Symbol>()): ts.Expression[] {
  if (seen.size) return localOriginsUncached(expr, checker, seen);
  let cache = originCache.get(checker);
  if (!cache) originCache.set(checker, cache = new WeakMap());
  const previous = cache.get(expr);
  if (previous) return previous;
  const result = localOriginsUncached(expr, checker, seen);
  cache.set(expr, result);
  return result;
}

function localOriginsUncached(expr: ts.Expression, checker: ts.TypeChecker, seen: Set<ts.Symbol>): ts.Expression[] {
  const n = unwrap(expr);
  const access = memberAccess(n);
  if (access) {
    const values = storedMemberValues(n, access, checker, seen);
    return values.length ? values.flatMap((value) => localOrigins(value, checker, seen)) : [n];
  }
  if (!ts.isIdentifier(n)) return [n];
  const sym = resolveSymbol(n, checker);
  if (!sym || seen.has(sym)) return [n];
  const decl = sym.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl)) return [n];
  const nextSeen = new Set(seen).add(sym);
  const values = decl.initializer ? [decl.initializer] : [];
  const scope = enclosingFunctionOrSourceFile(decl);
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && (node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) &&
        ts.isIdentifier(unwrap(node.left)) && resolveSymbol(unwrap(node.left), checker) === sym) values.push(node.right);
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return values.length ? values.flatMap((value) => localOrigins(value, checker, nextSeen)) : [n];
}

const scopeAssignmentsCache = new WeakMap<ts.Node, ts.BinaryExpression[]>();
function scopeAssignments(scope: ts.Node): ts.BinaryExpression[] {
  const cached = scopeAssignmentsCache.get(scope);
  if (cached) return cached;
  const assignments: ts.BinaryExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) assignments.push(node);
    ts.forEachChild(node, visit);
  };
  visit(scope);
  scopeAssignmentsCache.set(scope, assignments);
  return assignments;
}

function memberPath(expr: ts.Expression): { root: ts.Expression; keys: Array<string | null> } {
  let root = unwrap(expr);
  const keys: Array<string | null> = [];
  for (;;) {
    const member = memberAccess(root);
    if (!member) return { root, keys: keys.reverse() };
    keys.push(member.name);
    root = unwrap(member.receiver);
  }
}

function storedMemberValues(
  expr: ts.Expression,
  access: { receiver: ts.Expression; name: string | null },
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): ts.Expression[] {
  const values: ts.Expression[] = [];
  for (const receiver of localOrigins(access.receiver, checker, seen)) {
    if (ts.isArrayLiteralExpression(receiver)) {
      if (access.name !== null && /^\d+$/.test(access.name)) {
        const value = receiver.elements[Number(access.name)];
        if (value) values.push(value);
      } else if (access.name === null) values.push(...receiver.elements);
    }
    if (ts.isObjectLiteralExpression(receiver)) {
      for (const prop of receiver.properties) {
        if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
        const key = prop.name;
        const name = ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNumericLiteral(key) ? key.text : null;
        if (access.name === null || name === null || access.name === name) values.push(ts.isPropertyAssignment(prop) ? prop.initializer : prop.name);
      }
    }
  }
  const target = memberPath(expr);
  const rootSym = ts.isIdentifier(target.root) ? resolveSymbol(target.root, checker) : undefined;
  const decl = rootSym?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl)) return values;
  const targetOrigins = localOrigins(target.root, checker, seen);
  for (const assignment of scopeAssignments(enclosingFunctionOrSourceFile(decl))) {
    const candidate = memberPath(assignment.left);
    if (candidate.keys.length !== target.keys.length || candidate.keys.some((key, index) => key !== null && target.keys[index] !== null && key !== target.keys[index])) continue;
    const candidateSym = ts.isIdentifier(candidate.root) ? resolveSymbol(candidate.root, checker) : undefined;
    const sameRoot = candidateSym === rootSym || localOrigins(candidate.root, checker, seen).some((origin) => targetOrigins.includes(origin));
    if (sameRoot) values.push(assignment.right);
  }
  return values;
}

function isConsoleReceiver(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  return localOrigins(expr, checker).some((n) => {
    if (!ts.isIdentifier(n)) return false;
    const type = checker.getNonNullableType(checker.getTypeAtLocation(n));
    const parts = type.isUnionOrIntersection() ? type.types : [type];
    return parts.some((part) => part.symbol?.getName() === "Console" && anyDeclFileMatches(part.symbol, (f) => !f.startsWith(GATEWAY_SRC)));
  });
}

function processStreamName(expr: ts.Expression, checker: ts.TypeChecker): string | null {
  for (const origin of localOrigins(expr, checker)) {
    const access = memberAccess(origin) ?? (ts.isIdentifier(origin) ? bindingSource(origin, checker) : null);
    if (!access || (access.name !== "stdout" && access.name !== "stderr")) continue;
    for (const base of localOrigins(access.receiver, checker)) {
      if (!isIdentifierNamed(base, "process") || anyDeclFileMatches(resolveSymbol(base, checker), (f) => f.startsWith(GATEWAY_SRC))) continue;
      const type = checker.getTypeAtLocation(base);
      const propSym = checker.getPropertyOfType(type, access.name);
      if (propSym?.declarations?.some((decl) => ts.isInterfaceDeclaration(decl.parent) && decl.parent.name.text === "Process")) return access.name;
    }
  }
  return null;
}

function loggerProperty(type: ts.Type, method: string, checker: ts.TypeChecker): boolean {
  const property = checker.getPropertyOfType(type, method);
  if (!property) return false;
  const location = property.valueDeclaration ?? property.declarations?.[0];
  if (!location) return false;
  const memberType = checker.getTypeOfSymbolAtLocation(property, location);
  return memberType.getCallSignatures().some((signature) => {
    const decl = signature.declaration;
    if (!decl) return false;
    const file = decl.getSourceFile().fileName;
    return (file.includes(PINO_PKG) || file.includes(FASTIFY_PKG)) &&
      ts.isInterfaceDeclaration(decl.parent) && decl.parent.name.text === "LogFn";
  });
}

function declaredUnder(expr: ts.Expression, checker: ts.TypeChecker, pred: (file: string) => boolean, method?: string | null): boolean {
  const seen = new Set<ts.Type>();
  const matchesType = (type: ts.Type): boolean => {
    if (seen.has(type)) return false;
    seen.add(type);
    if (type.isUnionOrIntersection() && type.types.some(matchesType)) return true;
    const nonNullable = checker.getNonNullableType(type);
    if (nonNullable !== type && matchesType(nonNullable)) return true;
    if (anyDeclFileMatches(type.symbol, pred)) return true;
    if (method && anyDeclFileMatches(checker.getPropertyOfType(type, method), pred)) return true;
    return false;
  };
  for (const origin of localOrigins(expr, checker)) {
    if (anyDeclFileMatches(resolveSymbol(origin, checker), pred) || matchesType(checker.getTypeAtLocation(origin))) return true;
  }
  return false;
}

/** Classify the actual callable and its receiver. Unsupported invocations of a
 * known sink fail closed instead of being accepted merely for having a type. */
const sinkCache = new WeakMap<ts.TypeChecker, WeakMap<ts.Expression, string | null>>();
function sinkExpression(expr: ts.Expression, checker: ts.TypeChecker, seen = new Set<ts.Expression>()): string | null {
  if (seen.size) return sinkExpressionUncached(expr, checker, seen);
  let cache = sinkCache.get(checker);
  if (!cache) sinkCache.set(checker, cache = new WeakMap());
  if (cache.has(expr)) return cache.get(expr)!;
  const result = sinkExpressionUncached(expr, checker, seen);
  cache.set(expr, result);
  return result;
}

function bindingSource(expr: ts.Expression, checker: ts.TypeChecker): { receiver: ts.Expression; name: string | null } | null {
  const decl = resolveSymbol(expr, checker)?.valueDeclaration;
  if (!decl || !ts.isBindingElement(decl) || !ts.isObjectBindingPattern(decl.parent)) return null;
  const variable = decl.parent.parent;
  if (!ts.isVariableDeclaration(variable) || !variable.initializer) return null;
  const key = decl.propertyName ?? decl.name;
  const name = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : null;
  return { receiver: variable.initializer, name };
}

function sinkExpressionUncached(expr: ts.Expression, checker: ts.TypeChecker, seen: Set<ts.Expression>): string | null {
  const n = unwrap(expr);
  if (seen.has(n)) return null;
  const nextSeen = new Set(seen).add(n);
  const origins = localOrigins(n, checker);
  if (origins.length !== 1 || origins[0] !== n) {
    const matches = origins.map((origin) => sinkExpression(origin, checker, nextSeen)).filter((sink): sink is string => sink !== null);
    if (!matches.length) return null;
    return matches.every((sink) => sink === matches[0]) ? matches[0] : UNSUPPORTED_SINK;
  }
  if (ts.isConditionalExpression(n)) {
    return sinkExpression(n.whenTrue, checker, nextSeen) || sinkExpression(n.whenFalse, checker, nextSeen) ? UNSUPPORTED_SINK : null;
  }
  if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.BarBarToken || n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)) {
    return sinkExpression(n.left, checker, nextSeen) || sinkExpression(n.right, checker, nextSeen) ? UNSUPPORTED_SINK : null;
  }
  const access = memberAccess(n) ?? (ts.isIdentifier(n) ? bindingSource(n, checker) : null);
  const method = access?.name ?? (ts.isIdentifier(n) ? n.text : null);
  if (access) {
    if (isConsoleReceiver(access.receiver, checker)) return method ? `console.${method}` : UNSUPPORTED_SINK;
    for (const receiver of localOrigins(access.receiver, checker)) {
      if (!ts.isObjectLiteralExpression(receiver)) continue;
      for (const property of receiver.properties) {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
        const name = property.name;
        const propertyName = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
        if (method !== null && method !== propertyName) continue;
        const value = ts.isPropertyAssignment(property) ? property.initializer : property.name;
        const nested = sinkExpression(value, checker, nextSeen);
        if (nested) return method && propertyName ? nested : UNSUPPORTED_SINK;
      }
    }
    const stream = processStreamName(access.receiver, checker);
    if (stream && (method === "write" || method === null)) return method ? `process.${stream}.write` : UNSUPPORTED_SINK;
    if (checker.getTypeAtLocation(access.receiver).getCallSignatures().length && sinkExpression(access.receiver, checker, nextSeen)) return UNSUPPORTED_SINK;
  }
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return sinkExpression(n.right, checker, nextSeen) ? UNSUPPORTED_SINK : null;
  }
  if (ts.isCallExpression(n) && sinkExpression(n.expression, checker, nextSeen)) return UNSUPPORTED_SINK;
  const target = access?.receiver ?? n;
  if (declaredUnder(target, checker, (f) => f.endsWith(TELEMETRY_FILE_SUFFIX))) return method ? `pipelineTelemetry.${method}` : UNSUPPORTED_SINK;
  if (declaredUnder(target, checker, (f) => f.endsWith(TRACING_FILE_SUFFIX))) return method ?? UNSUPPORTED_SINK;
  if (declaredUnder(target, checker, (f) => f.endsWith(SENTRY_FILE_SUFFIX) || f.includes(SENTRY_PKG))) return method ? `Sentry.${method}` : UNSUPPORTED_SINK;
  if (declaredUnder(target, checker, (f) => f.includes(OTEL_PKG), method)) return method ? `otel.${method}` : UNSUPPORTED_SINK;
  if (access && (method === null || LOGGER_METHODS.has(method)) &&
      localOrigins(target, checker).some((origin) => {
        const type = checker.getNonNullableType(checker.getTypeAtLocation(origin));
        return method ? loggerProperty(type, method, checker) : [...LOGGER_METHODS].some((name) => loggerProperty(type, name, checker));
      })) return method ? `log.${method}` : UNSUPPORTED_SINK;
  const sym = resolveSymbol(n, checker);
  if (sym?.getName() === "trackServerEvent" && anyDeclFileMatches(sym, (f) => f.endsWith(POSTHOG_FILE_SUFFIX))) return "trackServerEvent";
  return null;
}

function sinkSignature(decl: ts.SignatureDeclaration | ts.JSDocSignature | undefined, method?: string | null): string | null {
  if (!decl) return null;
  const file = decl.getSourceFile().fileName;
  if (ts.isMethodSignature(decl) && ts.isInterfaceDeclaration(decl.parent) &&
      decl.parent.name.text === "Console" && !file.startsWith(GATEWAY_SRC)) {
    const name = decl.name;
    return ts.isIdentifier(name) || ts.isStringLiteral(name) ? `console.${name.text}` : UNSUPPORTED_SINK;
  }
  if ((file.includes(PINO_PKG) || file.includes(FASTIFY_PKG)) && ts.isCallSignatureDeclaration(decl) &&
      ts.isInterfaceDeclaration(decl.parent) && decl.parent.name.text === "LogFn") return method ? `log.${method}` : "log.call";
  if (file.includes(OTEL_PKG) && ts.isMethodSignature(decl) && ts.isInterfaceDeclaration(decl.parent) && decl.parent.name.text === "Span") {
    return method ? `otel.${method}` : UNSUPPORTED_SINK;
  }
  return null;
}

/** Self-sanitizing emitKernelLifecycleEvent is scanned at its internal write. */
export function matchSink(call: SinkCall, checker: ts.TypeChecker): string | null {
  const sink = sinkExpression(ts.isTaggedTemplateExpression(call) ? call.tag : call.expression, checker);
  if (sink) return sink;
  return sinkSignature(checker.getResolvedSignature(call)?.declaration,
    memberAccess(ts.isTaggedTemplateExpression(call) ? call.tag : call.expression)?.name);
}

/**
 * Ruling (1): "A callee that cannot be resolved in a scanned file FAILS." Checked
 * independently of matchSink — a call that ISN'T a recognized sink can still fail
 * here if its callee resolves to nothing at all (effectively `any`-typed), which is
 * exactly the `(req as any).log?.warn?.()` escape hatch the brief names. Returns
 * true if the callee resolves to SOME symbol (safe to classify, even as "not a
 * sink"); false if it cannot be resolved at all.
 */
function calleeResolves(call: SinkCall, checker: ts.TypeChecker): boolean {
  const callee = unwrap(ts.isTaggedTemplateExpression(call) ? call.tag : call.expression);
  // A dynamic `import("...")` is a language construct (the module loader), not a
  // disguised sink — there is no symbol to resolve for the `import` keyword
  // itself, and none is needed: it cannot secretly be a console.log in disguise.
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isPropertyAccessExpression(callee)) {
    // A property access resolves if EITHER the property itself or the receiver
    // resolves to a real declaration (not `any`).
    const propSym = checker.getSymbolAtLocation(callee.name);
    if (propSym) return true;
    const receiverType = checker.getTypeAtLocation(unwrap(callee.expression));
    return !isAnyOrUnknownType(receiverType);
  }
  if (ts.isElementAccessExpression(callee)) {
    const type = checker.getTypeAtLocation(callee);
    return !isAnyOrUnknownType(type);
  }
  const sym = resolveSymbol(callee, checker);
  if (sym) return true;
  const type = checker.getTypeAtLocation(callee);
  return !isAnyOrUnknownType(type);
}

function isAnyOrUnknownType(type: ts.Type): boolean {
  return Boolean(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument safety — ruling (2): no name allowlist
// ─────────────────────────────────────────────────────────────────────────────

export interface Violation {
  file: string;
  sink: string;
  argText: string;
  fingerprint: string;
}

interface ScanCtx {
  file: string;
  checker: ts.TypeChecker;
  sourceFile: ts.SourceFile;
  sink: string;
  sinkNode: ts.Node;
  out: Violation[];
  callSitesByDecl: Map<ts.Node, Invocation[]>;
  escapedFunctions: Set<ts.Node>;
  /** Recursion guard for isSafeParameterReference's transitive argument-safety
   *  proof (e.g. BaseFacade.emitTelemetry's `operation` is itself always passed
   *  execute()'s own `operation` parameter, which is in turn always literal at
   *  ITS call sites — two hops). Bounded, not unlimited: defaults to "unsafe". */
  depth: number;
  /** The derivation pass refuses caller-based proofs to track forwarding itself. */
  deriving?: boolean;
  unsafeNodes?: ts.Node[];
}

function normalizeArgText(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).trim();
}

function enclosingDeclarationName(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isModuleDeclaration(node)) {
    return node.name ? `${ts.SyntaxKind[node.kind]}:${node.name.getText(sourceFile)}` : undefined;
  }
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return `${ts.SyntaxKind[node.kind]}:${node.name.getText(sourceFile)}`;
  }
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.initializer
    && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    return `${ts.SyntaxKind[node.kind]}:${node.name.getText(sourceFile)}`;
  }
  return undefined;
}

function sinkExpressionIdentity(node: ts.Node, sourceFile: ts.SourceFile): string {
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) return normalizeArgText(node.expression, sourceFile);
  if (ts.isTaggedTemplateExpression(node)) return normalizeArgText(node.tag, sourceFile);
  return normalizeArgText(node, sourceFile);
}

/** Identify each call position within its declaration and each complete unsafe
 *  expression. Formatting a safe sibling does not change an existing identity. */
export function createViolation(
  file: string,
  sink: string,
  node: ts.Node,
  sourceFile: ts.SourceFile,
  sinkNode: ts.Node = node,
): Violation {
  const declarations: string[] = [];
  let owner: ts.Node = sourceFile;
  for (let parent = sinkNode.parent; parent; parent = parent.parent) {
    const name = enclosingDeclarationName(parent, sourceFile);
    if (name) {
      if (declarations.length === 0) owner = parent;
      declarations.unshift(name);
    }
  }
  const expression = sinkExpressionIdentity(sinkNode, sourceFile);
  let ordinal = 0;
  const visit = (candidate: ts.Node): void => {
    if (candidate === sinkNode) return;
    if (candidate.pos >= sinkNode.pos) return;
    if (candidate.kind === sinkNode.kind && sinkExpressionIdentity(candidate, sourceFile) === expression) ordinal++;
    ts.forEachChild(candidate, visit);
  };
  visit(owner);
  const childPath: number[] = [];
  for (let child = node; child !== sinkNode && child.parent; child = child.parent) {
    const siblings: ts.Node[] = [];
    ts.forEachChild(child.parent, (sibling) => { siblings.push(sibling); });
    childPath.unshift(siblings.indexOf(child));
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([declarations, sinkNode.kind, expression, ordinal, childPath, normalizeArgText(node, sourceFile)]))
    .digest("hex");
  return { file, sink, argText: normalizeArgText(node, sourceFile), fingerprint };
}

function pushViolation(ctx: ScanCtx, node: ts.Node): void {
  ctx.out.push(createViolation(ctx.file, ctx.sink, node, ctx.sourceFile, ctx.sinkNode));
  ctx.unsafeNodes?.push(node);
}

const DATE_INSTANT_METHODS = new Set(["toISOString", "getTime", "valueOf", "toJSON"]);

/** `new Date().toISOString()` / `.getTime()` / `.valueOf()` / `.toJSON()` — a
 *  zero-argument instance method on a freshly-constructed, zero-argument `Date`
 *  (i.e. "right now"). No caller/dependency influence whatsoever: this is NOT
 *  `new Date(callerSuppliedValue)`, which this check deliberately refuses (only
 *  `new Date()` with ZERO arguments qualifies). */
function isSafeDateInstantCall(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || !DATE_INSTANT_METHODS.has(callee.name.text)) return false;
  if (call.arguments.length !== 0) return false;
  const receiver = unwrap(callee.expression);
  if (!ts.isNewExpression(receiver) || (receiver.arguments?.length ?? 0) !== 0) return false;
  if (!isIdentifierNamed(receiver.expression, "Date")) return false;
  const sym = resolveSymbol(unwrap(receiver.expression), checker);
  return anyDeclFileMatches(sym, (f) => !f.startsWith(GATEWAY_SRC)); // ambient lib Date, not a local shadow
}

/** Is this call a known SAFE FORMATTER, recognized by its declaration (file +
 *  exported name) — never by bare name matching alone? */
function isSafeFormatterCall(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const callee = unwrap(call.expression);
  // Date.now() — a built-in, zero-argument, no caller/dependency influence.
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === "now" && isIdentifierNamed(callee.expression, "Date")) {
    const sym = resolveSymbol(unwrap(callee.expression), checker);
    if (anyDeclFileMatches(sym, (f) => !f.startsWith(GATEWAY_SRC))) return true; // ambient lib Date, not a local shadow
  }
  if (isSafeDateInstantCall(call, checker)) return true;
  const sym = resolveSymbol(callee, checker);
  if (!sym) return false;
  const name = sym.getName();
  return SAFE_FORMATTERS.some((f) => f.name === name && anyDeclFileMatches(sym, (file) => file.endsWith(f.fileSuffix)));
}

/** JSON.stringify is a transparent (non-laundering) wrapper: safe iff its own
 *  argument is safe. Lets a sink's self-sanitizing internal write (F4) build its
 *  line inline without an intermediate local (see checkArg's "local" handling). */
function isJsonStringifyCall(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "stringify") return false;
  if (!isIdentifierNamed(callee.expression, "JSON")) return false;
  const sym = resolveSymbol(unwrap(callee.expression), checker);
  return anyDeclFileMatches(sym, (f) => !f.startsWith(GATEWAY_SRC));
}

/** A value whose statically-known TYPE is itself a literal type, or a union
 *  entirely composed of literal types (e.g. `status: "completed" | "failed"`, or
 *  BaseFacade's own `FacadeName` union) — provable by declaration, no name
 *  allowlist needed. */
function hasLiteralUnionType(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  const type = checker.getTypeAtLocation(expr);
  const parts = type.isUnion() ? type.types : [type];
  if (parts.length === 0) return false;
  return parts.every((t) => Boolean(t.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral)));
}

function enclosingFunctionOrSourceFile(node: ts.Node): ts.Node {
  let n: ts.Node = node;
  while (n && !ts.isSourceFile(n) && !ts.isFunctionLike(n)) n = n.parent;
  return n;
}

interface ValueWrites {
  values: ts.Expression[];
  mutated: boolean;
}

function referenceRoot(expr: ts.Expression): ts.Expression {
  let n = unwrap(expr);
  for (;;) {
    const access = memberAccess(n);
    if (!access) return n;
    n = unwrap(access.receiver);
  }
}

/** Track every assignment operator and member write, not only bare `=`. */
const writesCache = new WeakMap<ts.TypeChecker, WeakMap<ts.Symbol, WeakMap<ts.Node, ValueWrites>>>();
function findAssignmentsTo(symbol: ts.Symbol, scope: ts.Node, checker: ts.TypeChecker): ValueWrites {
  let symbols = writesCache.get(checker);
  if (!symbols) writesCache.set(checker, symbols = new WeakMap());
  let scopes = symbols.get(symbol);
  if (!scopes) symbols.set(symbol, scopes = new WeakMap());
  const previous = scopes.get(scope);
  if (previous) return previous;
  const writes: ValueWrites = { values: [], mutated: false };
  const targetsSymbol = (expr: ts.Expression): boolean => {
    if (resolveSymbol(unwrap(expr), checker) === symbol) return true;
    const root = referenceRoot(expr);
    return ts.isIdentifier(root) && checker.getSymbolAtLocation(root) === symbol;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && (node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) && targetsSymbol(node.left)) {
      const left = unwrap(node.left);
      if (ts.isIdentifier(left)) {
        writes.values.push(node.right);
      } else {
        writes.mutated = true;
      }
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) && targetsSymbol(node.operand)) writes.mutated = true;
    if (ts.isDeleteExpression(node) && targetsSymbol(node.expression)) writes.mutated = true;
    const patternTargetsSymbol = (pattern: ts.Node): boolean => {
      if (ts.isIdentifier(pattern)) return checker.getSymbolAtLocation(pattern) === symbol;
      if (ts.isPropertyAssignment(pattern)) return patternTargetsSymbol(pattern.initializer);
      if (ts.isShorthandPropertyAssignment(pattern)) return checker.getShorthandAssignmentValueSymbol(pattern) === symbol;
      if (ts.isSpreadAssignment(pattern) || ts.isSpreadElement(pattern)) return patternTargetsSymbol(pattern.expression);
      if (ts.isObjectLiteralExpression(pattern)) return pattern.properties.some(patternTargetsSymbol);
      if (ts.isArrayLiteralExpression(pattern)) return pattern.elements.some(patternTargetsSymbol);
      if (ts.isBinaryExpression(pattern) && pattern.operatorToken.kind === ts.SyntaxKind.EqualsToken) return patternTargetsSymbol(pattern.left);
      return false;
    };
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        (ts.isObjectLiteralExpression(unwrap(node.left)) || ts.isArrayLiteralExpression(unwrap(node.left))) && patternTargetsSymbol(unwrap(node.left))) writes.mutated = true;
    if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer) &&
        (targetsSymbol(node.initializer) || patternTargetsSymbol(node.initializer))) writes.mutated = true;
    ts.forEachChild(node, visit);
  };
  visit(scope);
  scopes.set(scope, writes);
  return writes;
}

/** Objects are only proved when every use is a read at an inspected sink or a
 * transparent serialization. Passing, returning or aliasing a mutable object
 * prevents the proof, because another reference could change it. */
function aggregateEscapes(symbol: ts.Symbol, scope: ts.Node, checker: ts.TypeChecker): boolean {
  let escapes = false;
  const visit = (node: ts.Node): void => {
    if (escapes) return;
    if (ts.isIdentifier(node) && (checker.getSymbolAtLocation(node) === symbol ||
        (ts.isShorthandPropertyAssignment(node.parent) && checker.getShorthandAssignmentValueSymbol(node.parent) === symbol))) {
      if (ts.isVariableDeclaration(node.parent) && node.parent.name === node) return;
      let value: ts.Node = node;
      while (ts.isParenthesizedExpression(value.parent) || ts.isAsExpression(value.parent) || ts.isNonNullExpression(value.parent)) value = value.parent;
      while ((ts.isPropertyAccessExpression(value.parent) || ts.isElementAccessExpression(value.parent)) && value.parent.expression === value) value = value.parent;
      const parent = value.parent;
      if (ts.isCallExpression(parent) && parent.arguments.some((arg) => arg === value) &&
          (matchSink(parent, checker) || isJsonStringifyCall(parent, checker) || isSafeFormatterCall(parent, checker))) return;
      escapes = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return escapes;
}

const MAX_TRANSITIVE_DEPTH = 6;

/** Checks `expr` the same way checkArg does, but silently (no violations pushed
 *  to the real output) and depth-bounded — used when PROVING a parameter or
 *  destructured binding is safe requires checking what its own source expression
 *  is, which can itself bottom out in another parameter/local/formatter one or
 *  more hops away (e.g. emitTelemetry's `operation` is always execute()'s own
 *  `operation` parameter, which is in turn always a literal at ITS call sites). */
function isExprSafeSilently(expr: ts.Expression, ctx: ScanCtx): boolean {
  if (ctx.depth >= MAX_TRANSITIVE_DEPTH) return false;
  const throwaway: Violation[] = [];
  return checkArg(expr, { ...ctx, out: throwaway, depth: ctx.depth + 1 });
}

/** "A const whose declaration has a literal initializer" / "a local whose EVERY
 *  assignment in its scope is a literal" — a `let`/`const` local, proven safe by
 *  checking its declaration initializer PLUS every later `x = ...` assignment
 *  within its enclosing function (or module scope for a top-level const). The
 *  initializer/each assignment is checked with the SAME full recursive proof as
 *  any sink argument (isExprSafeSilently), not just a bare literal — so e.g. a
 *  local assigned `facadeErrorTelemetryCode(error)` or `{error: "fixed"}` counts,
 *  while one assigned a bare caller-influenced identifier does not. */
function isSafeVariableReference(symbol: ts.Symbol, ctx: ScanCtx): boolean {
  const decl = symbol.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl)) return false;
  const scope = enclosingFunctionOrSourceFile(decl);
  const values: ts.Expression[] = [];
  if (decl.initializer) values.push(decl.initializer);
  const writes = findAssignmentsTo(symbol, scope, ctx.checker);
  if (writes.mutated) return false;
  values.push(...writes.values);
  const isAggregate = values.some((value) => {
    const n = unwrap(value);
    const type = ctx.checker.getTypeAtLocation(n);
    return ts.isObjectLiteralExpression(n) || ts.isArrayLiteralExpression(n) || Boolean(type.flags & ts.TypeFlags.Object);
  });
  if (isAggregate && aggregateEscapes(symbol, scope, ctx.checker)) return false;
  return values.length > 0 && values.every((v) => isExprSafeSilently(v, ctx));
}

/** A destructured binding (`const { traceId, spanId } = startTrace(...)`) whose
 *  SOURCE call is `startTrace` (tracing.ts): both `traceId` and `spanId` are
 *  freshly generated inside startTrace (crypto `randomBytes` hex, see
 *  tracing.ts) — never derived from, or influenced by, startTrace's OWN
 *  arguments. Trusting the destructured return of THIS SPECIFIC declared
 *  function is narrower than trusting "any sink's return": it is a positive,
 *  checked fact about tracing.ts's one implementation, not a blanket exemption. */
function isSafeStartTraceDestructuring(symbol: ts.Symbol, checker: ts.TypeChecker): boolean {
  const decl = symbol.valueDeclaration;
  if (!decl || !ts.isBindingElement(decl) || decl.dotDotDotToken || decl.initializer) return false;
  const property = decl.propertyName ?? decl.name;
  if (!(ts.isIdentifier(property) || ts.isStringLiteral(property)) || (property.text !== "traceId" && property.text !== "spanId")) return false;
  const bindingPattern = decl.parent;
  if (!ts.isObjectBindingPattern(bindingPattern)) return false;
  const varDecl = bindingPattern.parent;
  if (!ts.isVariableDeclaration(varDecl) || !varDecl.initializer) return false;
  const writes = findAssignmentsTo(symbol, enclosingFunctionOrSourceFile(decl), checker);
  if (writes.mutated || writes.values.length) return false;
  const init = unwrap(varDecl.initializer);
  if (!ts.isCallExpression(init)) return false;
  const calleeSym = resolveSymbol(init.expression, checker);
  return anyDeclFileMatches(calleeSym, (f) => f.endsWith(TRACING_FILE_SUFFIX)) && isIdentifierNamed(init.expression, "startTrace");
}

/** A function/method PARAMETER, proven safe by checking EVERY call site of its
 *  enclosing function across the whole scanned program (not just one file) is
 *  safe at that position — e.g. BaseFacade.execute()'s `operation`, called from
 *  every facade subclass with a literal, always; or emitTelemetry's own
 *  `operation`, always execute()'s `operation` one hop up (isExprSafeSilently
 *  proves each call-site argument the same way, not just "is it a bare literal").
 *  A call site that OMITS this parameter entirely (valid when it's optional) is
 *  the same as passing `undefined` — itself literal-like — rather than a failure. */
function isSafeParameterReference(symbol: ts.Symbol, ctx: ScanCtx): boolean {
  if (ctx.deriving || ctx.depth >= MAX_TRANSITIVE_DEPTH) return false;
  const decl = symbol.valueDeclaration;
  if (!decl || !ts.isParameter(decl)) return false;
  const paramDecl = decl as ts.ParameterDeclaration;
  const fn = paramDecl.parent;
  if (!ts.isFunctionLike(fn) || !("parameters" in fn)) return false;
  if (ctx.escapedFunctions.has(fn) || isVirtualMethod(fn, ctx.checker)) return false;
  const writes = findAssignmentsTo(symbol, fn, ctx.checker);
  if (writes.mutated || writes.values.length) return false;
  const index = fn.parameters.indexOf(paramDecl);
  if (index < 0) return false;
  const sites = ctx.callSitesByDecl.get(fn as unknown as ts.Node) ?? [];
  if (sites.length === 0) return false; // no call site found anywhere in scope — don't vacuously trust
  for (const call of sites) {
    const arg = call.arguments?.[index];
    if (!arg) {
      // Omitted at this call site: safe iff the parameter is optional (then the
      // value is `undefined`, itself literal-like) or has a literal/safe default.
      if (paramDecl.questionToken) continue;
      if (paramDecl.initializer && isExprSafeSilently(paramDecl.initializer, ctx)) continue;
      return false;
    }
    if (ts.isSpreadElement(arg) || !isExprSafeSilently(arg, ctx)) return false;
  }
  return true;
}

/** A static caller list cannot prove virtual dispatch through a base/interface. */
function memberOwner(fn: ts.Node): ts.MethodDeclaration | ts.PropertyDeclaration | undefined {
  if (ts.isMethodDeclaration(fn)) return fn;
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isPropertyDeclaration(fn.parent) && fn.parent.initializer === fn) return fn.parent;
  return undefined;
}

function inheritedMembers(fn: ts.Node, checker: ts.TypeChecker): ts.Node[] {
  const member = memberOwner(fn);
  if (!member || !ts.isClassLike(member.parent)) return [];
  const name = member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name)) ? member.name.text : undefined;
  if (!name) return [];
  const declarations: ts.Node[] = [];
  const seen = new Set<ts.Type>();
  const visit = (type: ts.Type): void => {
    if (seen.has(type)) return;
    seen.add(type);
    const property = checker.getPropertyOfType(type, name);
    declarations.push(...property?.declarations ?? []);
    for (const decl of type.symbol?.declarations ?? []) {
      if (ts.isClassLike(decl) || ts.isInterfaceDeclaration(decl)) {
        for (const clause of decl.heritageClauses ?? []) for (const base of clause.types) visit(checker.getTypeAtLocation(base));
      }
    }
  };
  for (const clause of member.parent.heritageClauses ?? []) for (const base of clause.types) visit(checker.getTypeAtLocation(base));
  return declarations;
}

function isVirtualMethod(fn: ts.SignatureDeclaration, checker: ts.TypeChecker): boolean {
  const member = memberOwner(fn);
  if (!member || !ts.isClassLike(member.parent)) return false;
  return Boolean(member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.OverrideKeyword)) || inheritedMembers(fn, checker).length > 0;
}

function isVerifiedControlFlow(fn: ts.ArrowFunction | ts.FunctionExpression, ctx: ScanCtx): boolean {
  let value: ts.Node = fn;
  while (ts.isParenthesizedExpression(value.parent) || ts.isAsExpression(value.parent) || ts.isNonNullExpression(value.parent)) value = value.parent;
  const call = value.parent;
  if (!ts.isCallExpression(call) || call !== ctx.sinkNode || call.arguments[call.arguments.length - 1] !== value) return false;
  const method = memberAccess(call.expression)?.name;
  const decl = ctx.checker.getResolvedSignature(call)?.declaration;
  if (!decl) return false;
  const file = decl.getSourceFile().fileName;
  // These APIs execute a callback under a span; they never serialize its return.
  return (file.includes(OTEL_PKG) && method === "startActiveSpan") ||
    ((file.includes(SENTRY_PKG) || file.endsWith(SENTRY_FILE_SUFFIX)) &&
      (method === "startSpan" || method === "startSpanManual"));
}

/** Prove JSON values by provenance as well as their surface type. No user hook
 * can execute while a purportedly transparent serialization is being checked. */
function isJsonValueWithoutHooks(expr: ts.Expression, ctx: ScanCtx, seen = new Set<ts.Symbol>()): boolean {
  const n = unwrap(expr);
  if (isLiteralLike(n) && (!isIdentifierNamed(n, "undefined") || isBuiltinUndefined(n, ctx.checker))) return true;
  if (ts.isObjectLiteralExpression(n)) return n.properties.every((property) => {
    if (!ts.isPropertyAssignment(property)) return false;
    const name = property.name;
    if (ts.isComputedPropertyName(name) || ((ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "toJSON")) return false;
    return isJsonValueWithoutHooks(property.initializer, ctx, seen);
  });
  if (ts.isArrayLiteralExpression(n)) return n.elements.every((element) => !ts.isSpreadElement(element) && isJsonValueWithoutHooks(element, ctx, seen));
  if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)) return true;
  if (ts.isTemplateExpression(n)) return n.templateSpans.every((span) => isJsonValueWithoutHooks(span.expression, ctx, seen));
  if (ts.isConditionalExpression(n)) return isJsonValueWithoutHooks(n.whenTrue, ctx, seen) && isJsonValueWithoutHooks(n.whenFalse, ctx, seen);
  if (ts.isCallExpression(n) && isSafeFormatterCall(n, ctx.checker)) {
    const type = ctx.checker.getTypeAtLocation(n);
    return !(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Object)) && !type.isIntersection();
  }
  if (ts.isIdentifier(n)) {
    const symbol = resolveSymbol(n, ctx.checker);
    if (!symbol || seen.has(symbol)) return false;
    const decl = symbol.valueDeclaration;
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return false;
    const writes = findAssignmentsTo(symbol, enclosingFunctionOrSourceFile(decl), ctx.checker);
    const type = ctx.checker.getTypeAtLocation(n);
    const aggregate = Boolean(type.flags & ts.TypeFlags.Object) || ts.isObjectLiteralExpression(unwrap(decl.initializer)) || ts.isArrayLiteralExpression(unwrap(decl.initializer));
    if (writes.mutated || (aggregate && aggregateEscapes(symbol, enclosingFunctionOrSourceFile(decl), ctx.checker))) return false;
    const next = new Set(seen).add(symbol);
    return [decl.initializer, ...writes.values].every((value) => isJsonValueWithoutHooks(value, ctx, next));
  }
  return false;
}

function isTransparentStringify(call: ts.CallExpression, ctx: ScanCtx): boolean {
  const replacer = call.arguments[1] && unwrap(call.arguments[1]);
  if (replacer && replacer.kind !== ts.SyntaxKind.NullKeyword && !isBuiltinUndefined(replacer, ctx.checker) &&
      !(ts.isArrayLiteralExpression(replacer) && replacer.elements.every((element) => isLiteralLike(element)))) return false;
  return Boolean(call.arguments[0]) && isExprSafeSilently(call.arguments[0], ctx) && isJsonValueWithoutHooks(call.arguments[0], ctx);
}

/** The core safety proof for an already-RESOLVED symbol (enum member / safe
 *  variable / safe parameter / startTrace destructuring). Split from
 *  isSafeIdentifierReference so a shorthand object property — whose correct
 *  symbol comes from `getShorthandAssignmentValueSymbol`, NOT the generic
 *  `getSymbolAtLocation` every other identifier reference uses — can share it. */
function isSafeSymbolReference(sym: ts.Symbol | undefined, ctx: ScanCtx): boolean {
  if (!sym) return false;
  if (sym.valueDeclaration && ts.isEnumMember(sym.valueDeclaration)) return true; // "an enum member (resolved by declaration)"
  if (isSafeVariableReference(sym, ctx)) return true;
  if (isSafeParameterReference(sym, ctx)) return true;
  if (isSafeStartTraceDestructuring(sym, ctx.checker)) return true;
  return false;
}

function hasUnsafeReferenceWrites(expr: ts.Expression, ctx: ScanCtx): boolean {
  const root = referenceRoot(expr);
  if (root !== unwrap(expr) && ts.isIdentifier(root)) {
    const rootSymbol = ctx.checker.getSymbolAtLocation(root);
    if (hasUnsafeWrites(rootSymbol, ctx)) return true;
    const decl = rootSymbol?.valueDeclaration;
    if (rootSymbol && decl && ts.isVariableDeclaration(decl) && decl.initializer &&
        (ts.isObjectLiteralExpression(unwrap(decl.initializer)) || ts.isArrayLiteralExpression(unwrap(decl.initializer))) &&
        (!isExprSafeSilently(decl.initializer, ctx) || aggregateEscapes(rootSymbol, enclosingFunctionOrSourceFile(decl), ctx.checker))) return true;
  }
  return hasUnsafeWrites(ctx.checker.getSymbolAtLocation(expr), ctx);
}

function hasUnsafeWrites(symbol: ts.Symbol | undefined, ctx: ScanCtx): boolean {
  const decl = symbol?.valueDeclaration;
  if (!symbol || !decl) return false;
  if (ts.isParameter(decl) && !isSafeParameterReference(symbol, ctx)) return true;
  if (ts.isBindingElement(decl) && !isSafeStartTraceDestructuring(symbol, ctx.checker)) return true;
  if ((ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl) || ts.isPropertyAssignment(decl)) && decl.initializer &&
      !isExprSafeSilently(decl.initializer, ctx)) return true;
  const writes = findAssignmentsTo(symbol, enclosingFunctionOrSourceFile(decl), ctx.checker);
  if (writes.mutated || writes.values.some((value) => !isExprSafeSilently(value, ctx))) return true;
  return ts.isParameter(decl) && (writes.values.length > 0 || ctx.escapedFunctions.has(decl.parent));
}

function isSafeIdentifierReference(expr: ts.Expression, ctx: ScanCtx): boolean {
  return isSafeSymbolReference(ctx.checker.getSymbolAtLocation(expr), ctx);
}

/**
 * Checks one argument expression (or, recursively, one leaf inside it) against the
 * allowed forms (ruling (2)). Pushes a Violation for every offending LEAF. Returns
 * true iff the whole (sub)expression is allowed.
 */
export function checkArg(expr: ts.Expression, ctx: ScanCtx): boolean {
  const n = unwrap(expr);

  if (isLiteralLike(n) && (!isIdentifierNamed(n, "undefined") || isBuiltinUndefined(n, ctx.checker))) return true;

  // Only declaration-verified tracing callbacks are control flow. A closure in
  // data position (including a serializer callback) is an unproven value.
  if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && isVerifiedControlFlow(n, ctx)) return true;

  // template-literal holes
  if (ts.isTemplateExpression(n)) {
    let ok = true;
    for (const span of n.templateSpans) ok = checkArg(span.expression, ctx) && ok;
    return ok;
  }

  // conditional expression (ternary) — both branches must be safe
  if (ts.isConditionalExpression(n)) {
    const a = checkArg(n.whenTrue, ctx);
    const b = checkArg(n.whenFalse, ctx);
    return a && b;
  }

  // Strict comparisons produce a primitive boolean independently of input text.
  if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)) return true;

  // `a ?? b` / `a || b` — same "closed if both sides are closed" shape as a ternary
  if (
    ts.isBinaryExpression(n) &&
    (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || n.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    const a = checkArg(n.left, ctx);
    const b = checkArg(n.right, ctx);
    return a && b;
  }

  // object literal: property values, shorthand identifiers, spreads — includes
  // span attribute objects (e.g. Sentry.startSpanManual's `{attributes: {...}}`),
  // which are plain object literals under this same recursion.
  if (ts.isObjectLiteralExpression(n)) {
    let ok = true;
    for (const prop of n.properties) {
      if (prop.name && ts.isComputedPropertyName(prop.name)) ok = checkArg(prop.name.expression, ctx) && ok;
      if (ts.isPropertyAssignment(prop)) {
        ok = checkArg(prop.initializer, ctx) && ok;
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        // `getSymbolAtLocation(prop.name)` on a shorthand returns the PROPERTY's
        // own symbol (its valueDeclaration is the ShorthandPropertyAssignment
        // itself), not the local variable/parameter it references — the
        // dedicated API below resolves to the actual referenced value symbol.
        const valueSym = ctx.checker.getShorthandAssignmentValueSymbol(prop);
        const safe = isSafeSymbolReference(valueSym, ctx) || (hasLiteralUnionType(prop.name, ctx.checker) && !hasUnsafeWrites(valueSym, ctx));
        if (!safe) pushViolation(ctx, prop.name);
        ok = safe && ok;
      } else if (ts.isSpreadAssignment(prop)) {
        ok = checkArg(prop.expression, ctx) && ok;
      } else {
        pushViolation(ctx, prop);
        ok = false;
      }
    }
    return ok;
  }

  // array literal: elements, spreads
  if (ts.isArrayLiteralExpression(n)) {
    let ok = true;
    for (const el of n.elements) {
      if (ts.isSpreadElement(el)) ok = checkArg(el.expression, ctx) && ok;
      else ok = checkArg(el, ctx) && ok;
    }
    return ok;
  }

  if (ts.isSpreadElement(n)) return checkArg(n.expression, ctx);

  if (ts.isCallExpression(n)) {
    if (isSafeFormatterCall(n, ctx.checker)) return true;
    if (isJsonStringifyCall(n, ctx.checker) && isTransparentStringify(n, ctx)) {
      return n.arguments.every((arg) => checkArg(arg, ctx));
    }
    pushViolation(ctx, n);
    return false;
  }

  // identifiers / member expressions: a literal-type-union (e.g. `status:
  // "completed"|"failed"`, or BaseFacade's own `FacadeName`), OR a local/parameter
  // the checker can prove is always literal — NEVER a name allowlist.
  if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) {
    const root = referenceRoot(n);
    if (hasLiteralUnionType(n, ctx.checker) &&
        (ts.isIdentifier(root) || (root !== n && isExprSafeSilently(root, ctx))) &&
        !hasUnsafeReferenceWrites(n, ctx)) return true;
    if (isSafeIdentifierReference(n, ctx)) return true;
    pushViolation(ctx, n);
    return false;
  }

  pushViolation(ctx, n);
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived sinks and universal sink-value escapes
// ─────────────────────────────────────────────────────────────────────────────

type DerivedSinks = Map<ts.Node, Set<number>>;
const derivedCache = new WeakMap<ScannerContext, DerivedSinks>();
const derivedDefaults = new WeakMap<DerivedSinks, Map<ts.Node, ts.Expression[]>>();
const derivedReasons = new WeakMap<ScannerContext, Array<{ file: string; line: number; parameter: string; index: number; via: string; leaf: string }>>();

export function derivedSinkDiagnostics(scanner: ScannerContext): Array<{ file: string; line: number; parameter: string; index: number; via: string; leaf: string }> {
  getDerivedSinks(scanner);
  return derivedReasons.get(scanner) ?? [];
}

/** Resolve callable member implementations through the receiver's value origins,
 * not only its exposed structural type. A const alias may narrow that type while
 * retaining an instance whose method forwards to a sink. */
const callableCallSites = new WeakMap<ts.TypeChecker, Map<ts.Node, Invocation[]>>();

function callableReceiverOrigins(expr: ts.Expression, checker: ts.TypeChecker, seen = new Set<ts.Symbol>()): ts.Expression[] {
  const origins = new Set<ts.Expression>([...localOrigins(expr, checker), expr]);
  for (const origin of [...origins]) {
    if (!ts.isIdentifier(unwrap(origin))) continue;
    const symbol = resolveSymbol(origin, checker);
    const declaration = symbol?.valueDeclaration;
    if (!symbol || seen.has(symbol) || !declaration || !ts.isParameter(declaration)) continue;
    const fn = declaration.parent;
    if (!ts.isFunctionLike(fn) || !("parameters" in fn)) continue;
    const index = fn.parameters.indexOf(declaration);
    if (index < 0) continue;
    const next = new Set(seen).add(symbol);
    if (declaration.initializer) for (const value of callableReceiverOrigins(declaration.initializer, checker, next)) origins.add(value);
    for (const call of callableCallSites.get(checker)?.get(fn) ?? []) {
      const argument = call.arguments?.[index];
      if (!argument || ts.isSpreadElement(argument)) continue;
      for (const value of callableReceiverOrigins(argument, checker, next)) origins.add(value);
    }
  }
  return [...origins];
}

const callableTargetsCache = new WeakMap<ts.TypeChecker, WeakMap<ts.Expression, ts.Node[]>>();
function callableTargets(expr: ts.Expression, checker: ts.TypeChecker): ts.Node[] {
  let cache = callableTargetsCache.get(checker);
  if (!cache) callableTargetsCache.set(checker, cache = new WeakMap());
  const prior = cache.get(expr);
  if (prior) return prior;
  const targets = new Set<ts.Node>();
  for (const candidate of [...localOrigins(expr, checker), expr]) {
    const direct = callableDeclaration(candidate, checker);
    if (direct) targets.add(direct);
    // Overload signatures and their implementation share a symbol; a resolved
    // overload is never sufficient to discard the implementation's provenance.
    for (const declaration of resolveSymbol(candidate, checker)?.declarations ?? []) {
      if (ts.isFunctionLike(declaration) && "body" in declaration) targets.add(declaration);
      if (ts.isClassLike(declaration) && checker.getTypeAtLocation(candidate).getConstructSignatures().length) for (const member of declaration.members) {
        if (ts.isConstructorDeclaration(member)) targets.add(member);
      }
    }
    const candidateType = checker.getTypeAtLocation(candidate);
    for (const signature of candidateType.getConstructSignatures()) {
      const declaration = signature.declaration;
      if (declaration && ts.isConstructorDeclaration(declaration) && ts.isClassLike(declaration.parent)) {
        for (const member of declaration.parent.members) if (ts.isConstructorDeclaration(member)) targets.add(member);
      }
    }
    const member = memberAccess(candidate) ?? (ts.isIdentifier(candidate) ? bindingSource(candidate, checker) : null);
    if (!member) continue;
    const seen = new Set<ts.Type>();
    const visitType = (type: ts.Type): void => {
      if (seen.has(type)) return;
      seen.add(type);
      if (type.isUnionOrIntersection()) for (const part of type.types) visitType(part);
      const nonNullable = checker.getNonNullableType(type);
      if (nonNullable !== type) visitType(nonNullable);
      const properties = member.name === null ? checker.getPropertiesOfType(type) : [checker.getPropertyOfType(type, member.name)].filter((property): property is ts.Symbol => Boolean(property));
      for (const property of properties) for (const declaration of property.declarations ?? []) {
        if (ts.isFunctionLike(declaration) && "body" in declaration) targets.add(declaration);
        if ((ts.isPropertyDeclaration(declaration) || ts.isPropertyAssignment(declaration)) && declaration.initializer) {
          const initializer = unwrap(declaration.initializer);
          if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) targets.add(initializer);
        }
      }
    };
    for (const receiver of callableReceiverOrigins(member.receiver, checker)) visitType(checker.getTypeAtLocation(receiver));
  }
  const result = [...targets];
  cache.set(expr, result);
  return result;
}

function derivedArgumentPositions(call: Invocation, checker: ts.TypeChecker, derived: DerivedSinks): Set<number> {
  const positions = new Set<number>();
  const addDeclaration = (decl: ts.Node | undefined): void => {
    if (!decl) return;
    for (const index of derived.get(decl) ?? []) {
      positions.add(index);
      if (ts.isFunctionLike(decl) && "parameters" in decl && decl.parameters[index]?.dotDotDotToken) {
        for (let argument = index; argument < (call.arguments?.length ?? 0); argument++) positions.add(argument);
      }
    }
  };
  for (const declaration of callableTargets(call.expression, checker)) addDeclaration(declaration);
  addDeclaration(checker.getResolvedSignature(call)?.declaration);
  // A spread can shift every later formal position. Inspect the full argument
  // list rather than assuming that syntactic argument indices still match it.
  if (positions.size && call.arguments?.some(ts.isSpreadElement)) {
    for (let index = 0; index < (call.arguments?.length ?? 0); index++) positions.add(index);
  }
  return positions;
}

function defaultsForParameter(parameter: ts.ParameterDeclaration): ts.Expression[] {
  const values: ts.Expression[] = parameter.initializer ? [parameter.initializer] : [];
  const visit = (node: ts.Node): void => {
    if (ts.isBindingElement(node) && node.initializer) values.push(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(parameter.name);
  return values;
}

function derivedDefaultInitializers(call: Invocation, checker: ts.TypeChecker, derived: DerivedSinks): ts.Expression[] {
  const targets = new Set<ts.Node>();
  for (const decl of callableTargets(call.expression, checker)) targets.add(decl);
  const signature = checker.getResolvedSignature(call)?.declaration;
  if (signature) targets.add(signature);
  const cached = derivedDefaults.get(derived);
  if (cached) return [...targets].flatMap((target) => cached.get(target) ?? []);
  const values: ts.Expression[] = [];
  for (const [fn, indices] of derived) {
    if (!ts.isFunctionLike(fn) || !("parameters" in fn) ||
        (!targets.has(fn) && !inheritedMembers(fn, checker).some((member) => targets.has(member)))) continue;
    for (const index of indices) if (fn.parameters[index]) values.push(...defaultsForParameter(fn.parameters[index]));
  }
  return values;
}

/** Default expressions can run for omitted/undefined arguments or missing
 * destructured members. Refuse an unproven default at every derived caller,
 * including calls through inherited/interface signatures and spread arguments. */
function derivedDefaultsAreSafe(call: Invocation, checker: ts.TypeChecker, derived: DerivedSinks, ctx: ScanCtx): boolean {
  return derivedDefaultInitializers(call, checker, derived).every((initializer) =>
    isExprSafeSilently(initializer, { ...ctx, sourceFile: initializer.getSourceFile() }));
}

/** Preserve stored-value provenance across methods. A property's declaration is
 * a shared key when generic/mapped types produce different checker symbols.
 * Every statically resolved write participates; no execution-order proof is used. */
const propertyWriteSources = new WeakMap<ts.TypeChecker, Map<ts.Symbol | ts.Declaration, ts.Expression[]>>();

function propertyDependencySymbol(expr: ts.Expression, checker: ts.TypeChecker): ts.Symbol | undefined {
  const direct = resolveSymbol(expr, checker);
  if (direct) return direct;
  const member = memberAccess(expr);
  return member && member.name !== null ? checker.getPropertyOfType(checker.getTypeAtLocation(member.receiver), member.name) : undefined;
}

function indexPropertyWriteSources(scanner: ScannerContext): void {
  if (propertyWriteSources.has(scanner.checker)) return;
  const sources = new Map<ts.Symbol | ts.Declaration, ts.Expression[]>();
  const add = (target: ts.Expression, source: ts.Expression): void => {
    if (ts.isArrayLiteralExpression(target)) { for (const value of target.elements) if (!ts.isOmittedExpression(value)) add(ts.isSpreadElement(value) ? value.expression : value, source); return; }
    if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isPropertyAssignment(property)) add(property.initializer, source);
        else if (ts.isSpreadAssignment(property)) add(property.expression, source);
      }
      return;
    }
    if (ts.isBinaryExpression(target)) { add(target.left, source); return; }
    if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) return;
    const symbol = propertyDependencySymbol(target, scanner.checker);
    if (symbol) for (const key of [symbol, ...symbol.declarations ?? []]) sources.set(key, [...sources.get(key) ?? [], source]);
  };
  for (const file of [...scanner.scopeFileNames, PROBE_FIXTURE_PATH]) {
    const sf = scanner.program.getSourceFile(file);
    if (!sf) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) add(node.left, node.right);
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  propertyWriteSources.set(scanner.checker, sources);
}

/** Follow unformatted leaves to parameters, including local forwarding aliases.
 * The set is monotone: every newly derived argument is propagated until stable. */
function parameterDependencies(node: ts.Node, checker: ts.TypeChecker, seen = new Set<ts.Symbol>()): Set<ts.ParameterDeclaration> {
  const result = new Set<ts.ParameterDeclaration>();
  const visit = (value: ts.Node): void => {
    if (ts.isCallExpression(value) && isSafeFormatterCall(value, checker)) return;
    if (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      const symbol = ts.isShorthandPropertyAssignment(value.parent) ? checker.getShorthandAssignmentValueSymbol(value.parent) : propertyDependencySymbol(value, checker);
      if (!symbol || seen.has(symbol)) {
        // A shared property symbol must not erase a different receiver root.
        if (!ts.isIdentifier(value)) ts.forEachChild(value, visit);
        return;
      }
      const decl = symbol.valueDeclaration;
      const indexed = propertyWriteSources.get(checker);
      const writes = [...new Set([symbol, ...symbol.declarations ?? []].flatMap((key) => indexed?.get(key) ?? []))];
      if (writes.length || (decl && ts.isPropertyDeclaration(decl))) {
        seen.add(symbol);
        if (decl && ts.isPropertyDeclaration(decl) && decl.initializer) visit(decl.initializer);
        for (const write of writes) visit(write);
      }
      if (decl && ts.isParameter(decl)) { result.add(decl); return; }
      if (decl && ts.isBindingElement(decl)) {
        seen.add(symbol);
        let owner: ts.Node = decl.parent;
        while (ts.isObjectBindingPattern(owner) || ts.isArrayBindingPattern(owner) || ts.isBindingElement(owner)) owner = owner.parent;
        if (ts.isParameter(owner)) result.add(owner);
        else if (ts.isVariableDeclaration(owner) && owner.initializer) visit(owner.initializer);
        return;
      }
      if (decl && ts.isVariableDeclaration(decl)) {
        seen.add(symbol);
        if (decl.initializer) visit(decl.initializer);
        for (const assignment of findAssignmentsTo(symbol, enclosingFunctionOrSourceFile(decl), checker).values) visit(assignment);
      }
    }
    ts.forEachChild(value, visit);
  };
  visit(node);
  return result;
}

function getDerivedSinks(scanner: ScannerContext): DerivedSinks {
  indexPropertyWriteSources(scanner);
  if (callableCallSites.get(scanner.checker) !== scanner.callSitesByDecl) {
    callableCallSites.set(scanner.checker, scanner.callSitesByDecl);
    callableTargetsCache.delete(scanner.checker);
  }
  const cached = derivedCache.get(scanner);
  if (cached) return cached;
  const derived: DerivedSinks = new Map();
  const reasons: Array<{ file: string; line: number; parameter: string; index: number; via: string; leaf: string }> = [];
  const calls: SinkCall[] = [];
  for (const file of [...scanner.scopeFileNames, PROBE_FIXTURE_PATH]) {
    const sf = scanner.program.getSourceFile(file);
    if (!sf) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const call of calls) {
      const nativeSink = matchSink(call, scanner.checker);
      const args = ts.isTaggedTemplateExpression(call) ? [call.template] : [...call.arguments ?? []];
      const positions = nativeSink ? new Set(args.map((_, index) => index)) :
        !ts.isTaggedTemplateExpression(call) ? derivedArgumentPositions(call, scanner.checker, derived) : new Set<number>();
      if (!positions.size) continue;
      const unsafeNodes: ts.Node[] = [];
      const ctx: ScanCtx = {
        file: "", checker: scanner.checker, sourceFile: call.getSourceFile(), sink: nativeSink ?? "<derived-sink>",
        sinkNode: call, out: [], callSitesByDecl: scanner.callSitesByDecl,
        escapedFunctions: scanner.escapedFunctions, depth: 0, deriving: true, unsafeNodes,
      };
      for (const index of positions) if (args[index]) checkArg(args[index], ctx);
      if (!ts.isTaggedTemplateExpression(call)) for (const initializer of derivedDefaultInitializers(call, scanner.checker, derived)) {
        checkArg(initializer, { ...ctx, sourceFile: initializer.getSourceFile(), sinkNode: initializer });
      }
      for (const node of unsafeNodes) for (const parameter of parameterDependencies(node, scanner.checker)) {
        const fn = parameter.parent;
        if (!ts.isFunctionLike(fn) || !("parameters" in fn)) continue;
        const index = fn.parameters.indexOf(parameter);
        if (index < 0) continue;
        let indices = derived.get(fn);
        if (!indices) derived.set(fn, indices = new Set());
        if (!indices.has(index)) {
          indices.add(index); changed = true;
          reasons.push({ file: parameter.getSourceFile().fileName, line: parameter.getSourceFile().getLineAndCharacterOfPosition(parameter.getStart()).line + 1,
            parameter: parameter.name.getText(), index, via: (ts.isTaggedTemplateExpression(call) ? call.tag : call.expression).getText(), leaf: node.getText() });
        }
        for (const inherited of inheritedMembers(fn, scanner.checker)) {
          const target = (ts.isPropertyDeclaration(inherited) && inherited.initializer &&
            (ts.isArrowFunction(inherited.initializer) || ts.isFunctionExpression(inherited.initializer))) ? inherited.initializer : inherited;
          let inheritedIndices = derived.get(target);
          if (!inheritedIndices) derived.set(target, inheritedIndices = new Set());
          if (!inheritedIndices.has(index)) { inheritedIndices.add(index); changed = true; }
        }
      }
    }
  }
  const defaults = new Map<ts.Node, ts.Expression[]>();
  for (const [fn, indices] of derived) {
    if (!ts.isFunctionLike(fn) || !("parameters" in fn)) continue;
    const initializers: ts.Expression[] = [];
    for (const index of indices) {
      const parameter = fn.parameters[index];
      if (!parameter) continue;
      initializers.push(...defaultsForParameter(parameter));
    }
    for (const target of [fn, ...inheritedMembers(fn, scanner.checker)]) {
      defaults.set(target, [...defaults.get(target) ?? [], ...initializers]);
    }
  }
  derivedDefaults.set(derived, defaults);
  derivedCache.set(scanner, derived);
  derivedReasons.set(scanner, reasons);
  return derived;
}

/** Object receivers are values too, even when they have no call signature. */
const sinkValueCache = new WeakMap<DerivedSinks, WeakMap<ts.Expression, boolean>>();
function recognizedSinkValue(expr: ts.Expression, checker: ts.TypeChecker, derived: DerivedSinks): boolean {
  let cache = sinkValueCache.get(derived);
  if (!cache) sinkValueCache.set(derived, cache = new WeakMap());
  const prior = cache.get(expr);
  if (prior !== undefined) return prior;
  const recognized = recognizedSinkValueUncached(expr, checker, derived);
  cache.set(expr, recognized);
  return recognized;
}

function recognizedSinkValueUncached(expr: ts.Expression, checker: ts.TypeChecker, derived: DerivedSinks): boolean {
  if (callableTargets(expr, checker).some((declaration) => derived.has(declaration))) return true;
  const type = checker.getTypeAtLocation(expr);
  const callable = type.getCallSignatures().length > 0;
  if (callable && (sinkExpression(expr, checker) || type.getCallSignatures().some((signature) => sinkSignature(signature.declaration)))) return true;
  if (isConsoleReceiver(expr, checker) || processStreamName(expr, checker)) return true;
  const types = [...new Set([...localOrigins(expr, checker), expr].flatMap((origin) => {
    const originType = checker.getTypeAtLocation(origin);
    return originType.isUnionOrIntersection() ? originType.types : [originType];
  }))];
  for (const part of types) {
    const nonNullable = checker.getNonNullableType(part);
    // A mapped receiver is identified by its methods' source declarations.
    for (const property of checker.getPropertiesOfType(nonNullable)) {
      const propertyDeclaration = property.valueDeclaration ?? property.declarations?.[0];
      if (propertyDeclaration && checker.getTypeOfSymbolAtLocation(property, propertyDeclaration).getCallSignatures().some((signature) => sinkSignature(signature.declaration))) return true;
      if (LOGGER_METHODS.has(property.name) && loggerProperty(nonNullable, property.name, checker)) return true;
      for (const declaration of property.declarations ?? []) {
        // A receiver's public callable surface can escape through structural
        // types. Private/protected helpers remain derived at their own calls;
        // they do not make every ordinary data read on the container an escape.
        const exposed = !(ts.canHaveModifiers(declaration) && ts.getModifiers(declaration)?.some((modifier) =>
          modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword)) &&
          !("name" in declaration && declaration.name && ts.isPrivateIdentifier(declaration.name as ts.Node));
        if (exposed && derived.has(declaration)) return true;
        if (exposed && (ts.isPropertyDeclaration(declaration) || ts.isPropertyAssignment(declaration)) && declaration.initializer &&
            derived.has(unwrap(declaration.initializer))) return true;
        const file = declaration.getSourceFile().fileName;
        if (file.includes(OTEL_PKG) && (ts.isMethodSignature(declaration) || ts.isMethodDeclaration(declaration) || ts.isFunctionDeclaration(declaration))) return true;
        if ((file.endsWith(TELEMETRY_FILE_SUFFIX) || file.endsWith(TRACING_FILE_SUFFIX) || file.endsWith(SENTRY_FILE_SUFFIX) || file.includes(SENTRY_PKG)) &&
            (ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration) || ts.isFunctionDeclaration(declaration))) return true;
      }
    }
  }
  return false;
}

/** Only runtime expression positions participate. Declaration/type/property names
 * are metadata; shorthand properties are runtime reads of their value symbol. */
function isRuntimeExpression(node: ts.Node): node is ts.Expression {
  if (!ts.isExpression(node)) return false;
  const parent = node.parent;
  if (!parent) return false;
  if ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent) ||
        ts.isMethodSignature(parent) || ts.isPropertySignature(parent) || ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) || ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) ||
        ts.isBindingElement(parent)) && parent.name === node)) return false;
  for (let ancestor: ts.Node | undefined = parent; ancestor; ancestor = ancestor.parent) {
    if (ts.isTypeNode(ancestor) || ts.isImportDeclaration(ancestor) || ts.isExportDeclaration(ancestor)) return false;
    if (ts.isStatement(ancestor) || ts.isExpressionStatement(ancestor)) break;
  }
  return true;
}

function sinkValueUseIsTracked(expr: ts.Expression, scanner: ScannerContext, derived: DerivedSinks): boolean {
  let value: ts.Node = expr;
  // Receiver/callee chains are allowed only when their actual call is classified.
  for (;;) {
    const parent = value.parent;
    if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent) || ts.isNonNullExpression(parent)) { value = parent; continue; }
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === value) { value = parent; continue; }
    if (((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === value) || (ts.isTaggedTemplateExpression(parent) && parent.tag === value)) {
      return Boolean(matchSink(parent, scanner.checker)) || (!ts.isTaggedTemplateExpression(parent) && derivedArgumentPositions(parent, scanner.checker, derived).size > 0);
    }
    if (ts.isCallExpression(value) && ts.isExpressionStatement(parent) && matchSink(value, scanner.checker)) return true;
    if (ts.isVariableDeclaration(parent) && parent.initializer === value &&
        ts.isVariableDeclarationList(parent.parent) && Boolean(parent.parent.flags & ts.NodeFlags.Const)) {
      // Binding/object aliases are tracked by localOrigins/bindingSource.
      return ts.isIdentifier(parent.name) || (ts.isObjectBindingPattern(parent.name) && parent.name.elements.every((element) =>
        ts.isIdentifier(element.name) && !element.dotDotDotToken && (!element.propertyName || ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName))));
    }
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Whole-program scan
// ─────────────────────────────────────────────────────────────────────────────

export interface ScanResult {
  violations: Violation[];
  unresolvedCallees: Violation[];
  scanMs: number;
  fileCount: number;
}

/** Scans one AST subtree (any node — a whole SourceFile, or a single function body
 *  for a probe) for sink violations AND unresolvable callees. Shared by scanFiles
 *  (whole-package scan) and the probe suite (one named fixture function at a time). */
export function scanNode(node: ts.Node, file: string, sourceFile: ts.SourceFile, scanner: ScannerContext): ScanResult {
  const t0 = performance.now();
  const violations: Violation[] = [];
  const unresolvedCallees: Violation[] = [];
  const derived = getDerivedSinks(scanner);
  const visit = (n: ts.Node): void => {
    if ((isRuntimeExpression(n) && recognizedSinkValue(n, scanner.checker, derived) && !sinkValueUseIsTracked(n, scanner, derived)) ||
        (ts.isMethodDeclaration(n) && ts.isObjectLiteralExpression(n.parent) && derived.has(n))) {
      unresolvedCallees.push(createViolation(file, "<sink-escape>", n, sourceFile));
    }
    if (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isTaggedTemplateExpression(n)) {
      const nativeSink = matchSink(n, scanner.checker);
      const derivedPositions = !ts.isTaggedTemplateExpression(n) ? derivedArgumentPositions(n, scanner.checker, derived) : new Set<number>();
      const sink = nativeSink ?? (derivedPositions.size ? "<derived-sink>" : null);
      if (sink && sink !== UNSUPPORTED_SINK) {
        const ctx: ScanCtx = {
          file,
          checker: scanner.checker,
          sourceFile,
          sink,
          out: violations,
          callSitesByDecl: scanner.callSitesByDecl,
          escapedFunctions: scanner.escapedFunctions,
          sinkNode: n,
          depth: 0,
        };
        if (ts.isTaggedTemplateExpression(n)) {
          checkArg(n.template, ctx);
        } else {
          const args = n.arguments ?? [];
          for (let index = 0; index < args.length; index++) {
            if (nativeSink || derivedPositions.has(index)) checkArg(args[index], ctx);
          }
          if (!derivedDefaultsAreSafe(n, scanner.checker, derived, ctx)) pushViolation(ctx, n);
        }
      } else if (sink === UNSUPPORTED_SINK || !calleeResolves(n, scanner.checker)) {
        // Ruling (1): "A callee that cannot be resolved in a scanned file FAILS."
        unresolvedCallees.push(createViolation(file, "<unresolved-callee>", n, sourceFile));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return { violations, unresolvedCallees, scanMs: performance.now() - t0, fileCount: 1 };
}

/** Scans every file in `scopeFileNames` (default: the whole gateway package, per
 *  tsconfig's own include/exclude) for sink violations AND unresolvable callees. */
export function scanFiles(fileNames: string[], scanner: ScannerContext): ScanResult {
  const t0 = performance.now();
  const violations: Violation[] = [];
  const unresolvedCallees: Violation[] = [];
  for (const fileName of fileNames) {
    const sourceFile = scanner.program.getSourceFile(fileName);
    if (!sourceFile) continue;
    const relFile = fileName.startsWith(GATEWAY_SRC + "/") ? fileName.slice(GATEWAY_SRC.length + 1) : fileName;
    const result = scanNode(sourceFile, relFile, sourceFile, scanner);
    violations.push(...result.violations);
    unresolvedCallees.push(...result.unresolvedCallees);
  }
  return { violations, unresolvedCallees, scanMs: performance.now() - t0, fileCount: fileNames.length };
}

export function scanWholePackage(scanner: ScannerContext = getScanner()): ScanResult {
  return scanFiles(scanner.scopeFileNames, scanner);
}

/** Finds a top-level named function declaration in `sourceFile` by name (used by
 *  the probe suite to scan exactly one fixture function). */
export function findNamedFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return stmt;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Baseline (ruling (3)): shrink-only
// ─────────────────────────────────────────────────────────────────────────────

/** Each occurrence retains its complete expression and declaration fingerprint.
 *  Arrays preserve multiplicity even if a caller supplies identical rows. */
export type Baseline = Record<string, Record<string, Pick<Violation, "argText" | "fingerprint">[]>>;

export function baselineFromViolations(entries: Violation[]): Baseline {
  const out: Baseline = {};
  for (const v of entries) {
    (out[v.file] ??= {})[v.sink] ??= [];
    const list = out[v.file][v.sink];
    list.push({ argText: v.argText, fingerprint: v.fingerprint });
  }
  for (const file of Object.keys(out)) {
    for (const sink of Object.keys(out[file])) {
      out[file][sink].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint) || a.argText.localeCompare(b.argText));
    }
  }
  return out;
}

function fromBaseline(baseline: Baseline): Violation[] {
  const out: Violation[] = [];
  for (const [file, sinks] of Object.entries(baseline)) {
    for (const [sink, occurrences] of Object.entries(sinks)) {
      for (const occurrence of occurrences) {
        if (!occurrence || typeof occurrence.argText !== "string" || typeof occurrence.fingerprint !== "string") {
          throw new Error("Baseline rows require complete expressions and occurrence fingerprints");
        }
        out.push({ file, sink, ...occurrence });
      }
    }
  }
  return out;
}

export function loadBaseline(path: string = BASELINE_PATH): Baseline {
  if (!existsSync(path)) return {};
  const baseline = JSON.parse(readFileSync(path, "utf8")) as Baseline;
  fromBaseline(baseline);
  return baseline;
}

export function violationKey(v: Violation): string {
  return JSON.stringify([v.file, v.sink, v.fingerprint, v.argText]);
}

/** Multiset subtraction consumes each admitted occurrence only once. */
function subtractOccurrences(current: Violation[], admitted: Violation[]): Violation[] {
  const counts = new Map<string, number>();
  for (const row of admitted) counts.set(violationKey(row), (counts.get(violationKey(row)) ?? 0) + 1);
  return current.filter((row) => {
    const key = violationKey(row);
    const count = counts.get(key) ?? 0;
    if (count === 0) return true;
    counts.set(key, count - 1);
    return false;
  });
}

/** Entries present in `current` but not `baseline` — a NEW, unexplained violation. */
export function newViolations(current: Violation[], baseline: Baseline): Violation[] {
  return subtractOccurrences(current, fromBaseline(baseline));
}

/** Entries present in `baseline` but no longer in `current` — a STALE baseline row
 *  (the violation was fixed); the baseline must be regenerated to shrink. */
export function staleBaselineEntries(current: Violation[], baseline: Baseline): Violation[] {
  return subtractOccurrences(fromBaseline(baseline), current);
}

/** Explicit review additions must identify distinct, currently new occurrences. */
export function validateReviewedAdditions(entries: unknown, current: Violation[], baseline: Baseline): Violation[] {
  if (!Array.isArray(entries)) throw new Error("Reviewed additions must be an array");
  const available = new Set(newViolations(current, baseline).map(violationKey));
  const seen = new Set<string>();
  return entries.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid reviewed addition");
    const row = entry as Record<string, unknown>;
    if (typeof row.file !== "string" || typeof row.sink !== "string" || typeof row.argText !== "string"
      || typeof row.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(row.fingerprint)
      || row.classification !== "not_a_leak" || typeof row.reason !== "string" || !row.reason.trim()) {
      throw new Error("Each reviewed addition needs file, sink, complete argText, fingerprint, not_a_leak classification and reason");
    }
    const violation: Violation = { file: row.file, sink: row.sink, argText: row.argText, fingerprint: row.fingerprint };
    const key = violationKey(violation);
    if (N71_SCOPE_FILES.includes(row.file) || !available.has(key) || seen.has(key)) {
      throw new Error("Reviewed additions must be distinct, currently new occurrences outside N71's scope");
    }
    seen.add(key);
    return violation;
  });
}

/**
 * Regenerates the baseline file. SHRINK-ONLY: when a baseline already exists, the
 * new file is the INTERSECTION of the existing baseline and the current violations
 * — it can only remove rows (fixed violations drop out), never add one a prior run
 * did not already know about. A NEW violation (not already in the baseline) is
 * never silently absorbed by running this script; the only way to pass the test
 * for a new violation is to fix the underlying code. The very first run, with no
 * baseline file yet, bootstraps from the full current set.
 *
 * Usage: `pnpm --dir packages/gateway exec tsx scripts/generate-n71-sink-baseline.ts`
 */
export function regenerateBaseline(current: Violation[], path: string = BASELINE_PATH): { baseline: Baseline; removed: number; bootstrapped: boolean } {
  const bootstrapped = !existsSync(path);
  const existing = loadBaseline(path);
  const existingOccurrences = fromBaseline(existing);
  const kept = bootstrapped ? current : subtractOccurrences(existingOccurrences, staleBaselineEntries(current, existing));
  const removed = bootstrapped ? 0 : fromBaseline(existing).length - kept.length;
  const baseline = baselineFromViolations(kept);
  writeFileSync(path, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  return { baseline, removed, bootstrapped };
}
