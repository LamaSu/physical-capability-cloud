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
const SENTRY_PKG = "/node_modules/@sentry/";
const OTEL_PKG = "/node_modules/@opentelemetry/";
const FASTIFY_PKG = "/node_modules/fastify/";
const PINO_PKG = "/node_modules/pino/";

const CONSOLE_METHODS = new Set(["log", "info", "warn", "error", "debug"]);
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
  const callSitesByDecl = buildCallSiteIndex(program, checker, parsed.fileNames);
  cached = { program, checker, scopeFileNames: parsed.fileNames, buildMs, callSitesByDecl };
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
): Map<ts.Node, ts.CallExpression[]> {
  const index = new Map<ts.Node, ts.CallExpression[]>();
  for (const fileName of scopeFileNames) {
    const sf = program.getSourceFile(fileName);
    if (!sf) continue;
    const visit = (node: ts.Node): void => {
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
  return index;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sink resolution — ruling (1): by declaration, default-deny
// ─────────────────────────────────────────────────────────────────────────────

/** `process.stdout.write` / `process.stderr.write` — resolves the RECEIVER
 *  property (`.stdout`/`.stderr`) to the `Process` interface, so another
 *  Writable's `.write` (an HTTP response, `reply.raw`, ...) is never swept in. */
function matchProcessWriteSink(call: ts.CallExpression, checker: ts.TypeChecker): string | null {
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "write") return null;
  const receiver = unwrap(callee.expression);
  if (!ts.isPropertyAccessExpression(receiver)) return null;
  const streamName = receiver.name.text;
  if (streamName !== "stdout" && streamName !== "stderr") return null;
  const base = unwrap(receiver.expression);
  if (!isIdentifierNamed(base, "process")) return null;
  const baseSym = checker.getSymbolAtLocation(base);
  // A locally-shadowed `process` (declared somewhere in gateway src) is not the
  // ambient Node global — refuse to match rather than false-sink it.
  if (anyDeclFileMatches(baseSym, (f) => f.startsWith(GATEWAY_SRC))) return null;
  const propSym = checker.getSymbolAtLocation(receiver.name);
  const decl = propSym?.declarations?.[0];
  const parent = decl?.parent;
  if (decl && parent && ts.isInterfaceDeclaration(parent) && parent.name.text === "Process") {
    return `process.${streamName}.write`;
  }
  return null;
}

function isConsoleReceiver(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  const n = unwrap(expr);
  if (!ts.isIdentifier(n)) return false;
  const type = checker.getTypeAtLocation(n);
  if (type.symbol?.getName() !== "Console") return false;
  const varSym = checker.getSymbolAtLocation(n);
  // Refuse a locally-declared `console` shadow — must be the ambient global.
  return !anyDeclFileMatches(varSym, (f) => f.startsWith(GATEWAY_SRC));
}

/** Does this call's RECEIVER (for a property-access callee) or CALLEE (for a bare
 *  identifier callee) resolve — by its own symbol declaration, OR by its static
 *  TYPE's declaring symbol — to a file matching `pred`? Covers both module-scoped
 *  singletons (`Sentry`, `pipelineTelemetry`, declared where they're imported from)
 *  and interface-typed locals (`span: Span`, `req.log: FastifyBaseLogger`). */
function calleeOrReceiverDeclaredUnder(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  pred: (file: string) => boolean,
): boolean {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) {
    const sym = resolveSymbol(callee, checker);
    return anyDeclFileMatches(sym, pred);
  }
  if (ts.isPropertyAccessExpression(callee)) {
    const receiver = unwrap(callee.expression);
    const receiverSym = resolveSymbol(receiver, checker);
    if (receiverSym && anyDeclFileMatches(receiverSym, pred)) return true;
    const type = checker.getTypeAtLocation(receiver);
    const typeSym = type.symbol;
    if (typeSym?.declarations?.some((d) => pred(d.getSourceFile().fileName))) return true;
  }
  return false;
}

function calleeOrMethodName(call: ts.CallExpression): string {
  const callee = unwrap(call.expression);
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (ts.isIdentifier(callee)) return callee.text;
  return "<call>";
}

/**
 * Returns a human-readable sink name, or null if `call` is not a sink by
 * declaration. Ruling (3) (F4): emitKernelLifecycleEvent sanitizes INSIDE itself,
 * so it is deliberately NOT matched here at its call sites — only its own internal
 * `process.stderr.write` (matched generically above) is scanned.
 */
export function matchSink(call: ts.CallExpression, checker: ts.TypeChecker): string | null {
  const procWrite = matchProcessWriteSink(call, checker);
  if (procWrite) return procWrite;

  const callee = unwrap(call.expression);
  if (ts.isPropertyAccessExpression(callee)) {
    const method = callee.name.text;
    if (CONSOLE_METHODS.has(method) && isConsoleReceiver(callee.expression, checker)) {
      return `console.${method}`;
    }
  }

  if (calleeOrReceiverDeclaredUnder(call, checker, (f) => f.endsWith(TELEMETRY_FILE_SUFFIX))) {
    return `pipelineTelemetry.${calleeOrMethodName(call)}`;
  }
  if (calleeOrReceiverDeclaredUnder(call, checker, (f) => f.endsWith(TRACING_FILE_SUFFIX))) {
    return calleeOrMethodName(call); // startTrace / endTrace / withSpan / withSpanSync
  }
  if (calleeOrReceiverDeclaredUnder(call, checker, (f) => f.endsWith(SENTRY_FILE_SUFFIX) || f.includes(SENTRY_PKG))) {
    return `Sentry.${calleeOrMethodName(call)}`;
  }
  if (calleeOrReceiverDeclaredUnder(call, checker, (f) => f.includes(OTEL_PKG))) {
    return `otel.${calleeOrMethodName(call)}`;
  }
  if (ts.isPropertyAccessExpression(callee) && LOGGER_METHODS.has(callee.name.text)) {
    if (calleeOrReceiverDeclaredUnder(call, checker, (f) => f.includes(FASTIFY_PKG) || f.includes(PINO_PKG))) {
      return `log.${callee.name.text}`;
    }
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
function calleeResolves(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const callee = unwrap(call.expression);
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
}

interface ScanCtx {
  file: string;
  checker: ts.TypeChecker;
  sourceFile: ts.SourceFile;
  sink: string;
  out: Violation[];
  callSitesByDecl: Map<ts.Node, ts.CallExpression[]>;
  /** Recursion guard for isSafeParameterReference's transitive argument-safety
   *  proof (e.g. BaseFacade.emitTelemetry's `operation` is itself always passed
   *  execute()'s own `operation` parameter, which is in turn always literal at
   *  ITS call sites — two hops). Bounded, not unlimited: defaults to "unsafe". */
  depth: number;
}

function normalizeArgText(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/g, " ").trim().slice(0, 200);
}

function pushViolation(ctx: ScanCtx, node: ts.Node): void {
  ctx.out.push({ file: ctx.file, sink: ctx.sink, argText: normalizeArgText(node, ctx.sourceFile) });
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

function findAssignmentsTo(symbol: ts.Symbol, scope: ts.Node, checker: ts.TypeChecker): ts.Expression[] {
  const out: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = unwrap(node.left);
      if (ts.isIdentifier(left) && checker.getSymbolAtLocation(left) === symbol) {
        out.push(node.right);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return out;
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
  values.push(...findAssignmentsTo(symbol, scope, ctx.checker));
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
      if (ts.isPropertyAssignment(prop)) {
        ok = checkArg(prop.initializer, ctx) && ok;
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        // `getSymbolAtLocation(prop.name)` on a shorthand returns the PROPERTY's
        // own symbol (its valueDeclaration is the ShorthandPropertyAssignment
        // itself), not the local variable/parameter it references — the
        // dedicated API below resolves to the actual referenced value symbol.
        const valueSym = ctx.checker.getShorthandAssignmentValueSymbol(prop);
        const safe = hasLiteralUnionType(prop.name, ctx.checker) || isSafeSymbolReference(valueSym, ctx);
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
    if (hasLiteralUnionType(n, ctx.checker)) return true;
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
    if (ts.isCallExpression(n)) {
      const sink = matchSink(n, scanner.checker);
      if (sink) {
        const ctx: ScanCtx = {
          file,
          checker: scanner.checker,
          sourceFile,
          sink,
          out: violations,
          callSitesByDecl: scanner.callSitesByDecl,
          depth: 0,
        };
        for (const arg of n.arguments) checkArg(arg, ctx);
      } else if (!calleeResolves(n, scanner.checker)) {
        // Ruling (1): "A callee that cannot be resolved in a scanned file FAILS."
        unresolvedCallees.push({ file, sink: "<unresolved-callee>", argText: normalizeArgText(n, sourceFile) });
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

/** file -> sink -> sorted, de-duplicated normalized argText list. Never keyed by
 *  line number, so an unrelated edit elsewhere in a file never perturbs it. */
export type Baseline = Record<string, Record<string, string[]>>;

function toBaseline(entries: Violation[]): Baseline {
  const out: Baseline = {};
  for (const v of entries) {
    (out[v.file] ??= {})[v.sink] ??= [];
    const list = out[v.file][v.sink];
    if (!list.includes(v.argText)) list.push(v.argText);
  }
  for (const file of Object.keys(out)) {
    for (const sink of Object.keys(out[file])) out[file][sink].sort();
  }
  return out;
}

function fromBaseline(baseline: Baseline): Violation[] {
  const out: Violation[] = [];
  for (const [file, sinks] of Object.entries(baseline)) {
    for (const [sink, argTexts] of Object.entries(sinks)) {
      for (const argText of argTexts) out.push({ file, sink, argText });
    }
  }
  return out;
}

export function loadBaseline(): Baseline {
  if (!existsSync(BASELINE_PATH)) return {};
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

function violationKey(v: Violation): string {
  return `${v.file}\u0000${v.sink}\u0000${v.argText}`;
}

/** Entries present in `current` but not `baseline` — a NEW, unexplained violation. */
export function newViolations(current: Violation[], baseline: Baseline): Violation[] {
  const baseKeys = new Set(fromBaseline(baseline).map(violationKey));
  return current.filter((v) => !baseKeys.has(violationKey(v)));
}

/** Entries present in `baseline` but no longer in `current` — a STALE baseline row
 *  (the violation was fixed); the baseline must be regenerated to shrink. */
export function staleBaselineEntries(current: Violation[], baseline: Baseline): Violation[] {
  const curKeys = new Set(current.map(violationKey));
  return fromBaseline(baseline).filter((v) => !curKeys.has(violationKey(v)));
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
export function regenerateBaseline(current: Violation[]): { baseline: Baseline; removed: number; bootstrapped: boolean } {
  const bootstrapped = !existsSync(BASELINE_PATH);
  const existing = loadBaseline();
  const currentKeys = new Set(current.map(violationKey));
  const kept = bootstrapped ? current : fromBaseline(existing).filter((v) => currentKeys.has(violationKey(v)));
  const removed = bootstrapped ? 0 : fromBaseline(existing).length - kept.length;
  const baseline = toBaseline(kept);
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  return { baseline, removed, bootstrapped };
}
