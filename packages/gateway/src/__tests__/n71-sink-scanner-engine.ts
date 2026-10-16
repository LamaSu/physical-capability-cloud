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
 * closes the property BY CONSTRUCTION instead:
 *
 *   (1) SINKS BY DECLARATION, default-deny. A `ts.Program` is built from the
 *       gateway's own tsconfig.json, and every call's callee (and, for a method
 *       call, its RECEIVER) is resolved through the `TypeChecker` — never by
 *       matching a hardcoded list of call SHAPES. A callee this resolution cannot
 *       follow (an `as any` escape hatch, most directly) FAILS: it cannot be
 *       exempted by looking like something benign, because nothing is exempted by
 *       looking like anything — every call in scope is classified, or it is a
 *       violation.
 *   (2) NO NAME ALLOWLIST. An argument passes only if it is a literal, an enum
 *       member, a const/local whose value the checker can prove is always a
 *       literal, or the return of a formatter recognized by ITS OWN declaration
 *       (logSafeId, knownErrorClassName, logSafeSmallInt, logSafeInt,
 *       logSafeIsoTimestamp, facadeErrorTelemetryCode, Date.now). There is no
 *       per-file, per-identifier, prose-justified exemption list of any kind.
 *   (3) SCOPE is the whole gateway package (every file tsconfig.json's own
 *       `include`/`exclude` resolves to — the same file list `tsc` itself
 *       compiles), not a hardcoded file list. N71's own files must be at ZERO
 *       violations; every other existing violation is captured in a GENERATED,
 *       shrink-only baseline (see n71-sink-baseline.json and
 *       scripts/generate-n71-sink-baseline.ts).
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
  let sym = ts.isPropertyAccessExpression(n) ? checker.getSymbolAtLocation(n.name) : checker.getSymbolAtLocation(n);
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
  callSitesByDecl: Map<ts.Node, ts.CallExpression[]>;
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

/** Function/method declarations invoked anywhere in `scopeFileNames`, keyed by
 *  declaration node, each with every call site found. Used to prove a PARAMETER
 *  (not just a local variable) is always literal across the whole program — see
 *  isSafeParameterReference. */
function buildCallSiteIndex(
  program: ts.Program,
  checker: ts.TypeChecker,
  scopeFileNames: string[],
): { callSitesByDecl: Map<ts.Node, ts.CallExpression[]>; escapedFunctions: Set<ts.Node> } {
  const index = new Map<ts.Node, ts.CallExpression[]>();
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
      if (ts.isCallExpression(node)) {
        const sym = resolveSymbol(node.expression, checker);
        const decl = sym?.valueDeclaration;
        if (
          decl &&
          (ts.isMethodDeclaration(decl) ||
            ts.isFunctionDeclaration(decl) ||
            ts.isArrowFunction(decl) ||
            ts.isFunctionExpression(decl) ||
            ts.isConstructorDeclaration(decl))
        ) {
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

type SinkCall = ts.CallExpression | ts.TaggedTemplateExpression;
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
    const type = checker.getTypeAtLocation(n);
    return type.symbol?.getName() === "Console" && anyDeclFileMatches(type.symbol, (f) => !f.startsWith(GATEWAY_SRC));
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

function declaredUnder(expr: ts.Expression, checker: ts.TypeChecker, pred: (file: string) => boolean): boolean {
  for (const origin of localOrigins(expr, checker)) {
    if (anyDeclFileMatches(resolveSymbol(origin, checker), pred)) return true;
    const type = checker.getTypeAtLocation(origin);
    if (type.symbol?.declarations?.some((decl) => pred(decl.getSourceFile().fileName))) return true;
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
  if (declaredUnder(target, checker, (f) => f.includes(OTEL_PKG))) return method ? `otel.${method}` : UNSUPPORTED_SINK;
  if (access && (method === null || LOGGER_METHODS.has(method)) && declaredUnder(target, checker, (f) => f.includes(FASTIFY_PKG) || f.includes(PINO_PKG))) return method ? `log.${method}` : UNSUPPORTED_SINK;
  const sym = resolveSymbol(n, checker);
  if (sym?.getName() === "trackServerEvent" && anyDeclFileMatches(sym, (f) => f.endsWith(POSTHOG_FILE_SUFFIX))) return "trackServerEvent";
  return null;
}

/** Self-sanitizing emitKernelLifecycleEvent is scanned at its internal write. */
export function matchSink(call: SinkCall, checker: ts.TypeChecker): string | null {
  const sink = sinkExpression(ts.isTaggedTemplateExpression(call) ? call.tag : call.expression, checker);
  if (sink) return sink;
  // A known sink passed to another callable can be invoked indirectly there.
  // Its invocation cannot be classified at this boundary, so reject the escape.
  if (ts.isCallExpression(call) && call.arguments.some((arg) =>
    localOrigins(arg, checker).some((origin) => {
      const escapedSink = sinkExpression(origin, checker);
      if (!escapedSink) return false;
      return checker.getTypeAtLocation(origin).getCallSignatures().length > 0 ||
        escapedSink.startsWith("console.") || escapedSink.startsWith("process.") || escapedSink.startsWith("log.");
    }),
  )) return UNSUPPORTED_SINK;
  const decl = checker.getResolvedSignature(call)?.declaration;
  if (decl && ts.isMethodSignature(decl) && ts.isInterfaceDeclaration(decl.parent) &&
      decl.parent.name.text === "Console" && !decl.getSourceFile().fileName.startsWith(GATEWAY_SRC)) {
    const name = decl.name;
    return ts.isIdentifier(name) || ts.isStringLiteral(name) ? `console.${name.text}` : UNSUPPORTED_SINK;
  }
  return null;
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
  callSitesByDecl: Map<ts.Node, ts.CallExpression[]>;
  escapedFunctions: Set<ts.Node>;
  /** Recursion guard for isSafeParameterReference's transitive argument-safety
   *  proof (e.g. BaseFacade.emitTelemetry's `operation` is itself always passed
   *  execute()'s own `operation` parameter, which is in turn always literal at
   *  ITS call sites — two hops). Bounded, not unlimited: defaults to "unsafe". */
  depth: number;
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
  if (ts.isCallExpression(node)) return normalizeArgText(node.expression, sourceFile);
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
  if (!decl || !ts.isBindingElement(decl)) return false;
  const bindingPattern = decl.parent;
  if (!ts.isObjectBindingPattern(bindingPattern)) return false;
  const varDecl = bindingPattern.parent;
  if (!ts.isVariableDeclaration(varDecl) || !varDecl.initializer) return false;
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
  if (ctx.depth >= MAX_TRANSITIVE_DEPTH) return false;
  const decl = symbol.valueDeclaration;
  if (!decl || !ts.isParameter(decl)) return false;
  const paramDecl = decl as ts.ParameterDeclaration;
  const fn = paramDecl.parent;
  if (!ts.isFunctionLike(fn) || !("parameters" in fn)) return false;
  if (ctx.escapedFunctions.has(fn)) return false;
  const writes = findAssignmentsTo(symbol, fn, ctx.checker);
  if (writes.mutated || writes.values.length) return false;
  const index = fn.parameters.indexOf(paramDecl);
  if (index < 0) return false;
  const sites = ctx.callSitesByDecl.get(fn as unknown as ts.Node) ?? [];
  if (sites.length === 0) return false; // no call site found anywhere in scope — don't vacuously trust
  for (const call of sites) {
    const arg = call.arguments[index];
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

  if (isLiteralLike(n)) return true;

  // A function/arrow-function argument is control flow, not data (e.g. the
  // callback to facadeTracer.startActiveSpan) — any sink calls INSIDE its body are
  // found independently by the same whole-file walk; this is never recursed into
  // as if it were a logged value.
  if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return true;

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
    if (isJsonStringifyCall(n, ctx.checker)) {
      // Transparent wrapper — recurse into its own argument(s) instead of trusting
      // or rejecting the call itself.
      let ok = true;
      for (const a of n.arguments) ok = checkArg(a, ctx) && ok;
      return ok;
    }
    pushViolation(ctx, n);
    return false;
  }

  // identifiers / member expressions: a literal-type-union (e.g. `status:
  // "completed"|"failed"`, or BaseFacade's own `FacadeName`), OR a local/parameter
  // the checker can prove is always literal — NEVER a name allowlist.
  if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) {
    if (hasLiteralUnionType(n, ctx.checker) && !hasUnsafeReferenceWrites(n, ctx)) return true;
    if (isSafeIdentifierReference(n, ctx)) return true;
    pushViolation(ctx, n);
    return false;
  }

  pushViolation(ctx, n);
  return false;
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
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) || ts.isTaggedTemplateExpression(n)) {
      const sink = matchSink(n, scanner.checker);
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
          for (const arg of n.arguments) checkArg(arg, ctx);
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
