/**
 * FC-8 round 5 (astra pack 61d, DO-NOT-SHIP at #326 @d8190fe3) — shared
 * TypeScript-AST utilities for the e2e scripts' redaction guards. Not a
 * test file itself; imported by fc8-e2e-script-redaction.test.ts (call-site
 * allowlists) and fc8-round5-ast-sink-guard.test.ts (every sink argument).
 *
 * Round 4's call-site guard (fc8-e2e-script-redaction.test.ts) used a
 * regex, `/safeLogId\(([^()]*)\)/g`, to pull each call's argument text.
 * `[^()]*` excludes BOTH parens from the argument class, so it can never
 * match a call whose argument itself contains a nested call —
 * `safeLogId(String(status))` — because the class stops consuming at the
 * inner "(" and no amount of backtracking finds a position where the next
 * character is the closing ")" the pattern needs. The regex therefore
 * finds NO match at that call site: it is invisible to the allowlist
 * check, not merely mis-recorded (verdict finding 3's cheapest repro). A
 * real AST has no such blind spot — a CallExpression's arguments are
 * structured nodes, nested calls included, however much punctuation they
 * contain.
 */
import ts from "typescript";

export interface CallSite {
  fn: string;
  /** The exact source text of the call's arguments, nested calls included (e.g. "String(status)"). */
  argText: string;
}

/** Every call to one of `fnNames`, anywhere in `source`, at any nesting depth, with its exact argument source text. */
export function findCallSites(source: string, fnNames: readonly string[]): CallSite[] {
  const sourceFile = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, true);
  const allow = new Set(fnNames);
  const out: CallSite[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && allow.has(node.expression.text)) {
      const argText = node.arguments.map((a) => a.getText(sourceFile)).join(", ");
      out.push({ fn: node.expression.text, argText });
    }
    // Always recurse into every child, matched or not: a matched call's own
    // arguments (or any sibling expression) can themselves contain another
    // call to one of fnNames. This is exactly what the old regex could not do.
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return out;
}

/** Every call site whose argText is NOT in `allowed`, formatted for a test failure message. Empty = clean. */
export function unreviewedCallSites(sites: CallSite[], allowed: ReadonlySet<string>): string[] {
  return sites
    .filter((s) => !allowed.has(s.argText))
    .map((s) => `unreviewed ${s.fn} call site: ${s.fn}(${s.argText})`);
}

// ── Every sink argument must be literal-or-allowlisted-call ────────────────
//
// Step 2's broader guard: in each of the three e2e scripts, every
// console.*/stdout/stderr-write call — including calls to the script's own
// local L()/log() helper, which is how nearly every print site in these
// scripts actually reaches console.log — must build its arguments ONLY
// from string literals and calls to the allowlisted safe*/publicIdForLog
// functions. A bare identifier is accepted ONLY if it traces back (through
// a simple `const NAME = EXPR` in the same file) to such a call or literal,
// so natural code like `const camContentType = safeLogContentType(...)` can
// be reused by name in several log lines without re-wrapping it each time.

export interface AstGuardOptions {
  /** e.g. ["safeLogId","safeLogHex","safeLogInt","safeLogBool","safeLogEnum","safeLogContentType","safeLogErrorName","safeLogDecimal","publicIdForLog","envPresence"] */
  allowedFns: readonly string[];
  /** The script's own console.log-wrapping helper(s), e.g. ["L"] or ["log"]. */
  localSinkFns: readonly string[];
}

export interface Violation {
  line: number;
  text: string;
}

function isSinkCall(node: ts.Node, localSinks: ReadonlySet<string>): ts.CallExpression | null {
  if (!ts.isCallExpression(node)) return null;
  const expr = node.expression;
  if (ts.isIdentifier(expr) && localSinks.has(expr.text)) return node;
  if (ts.isPropertyAccessExpression(expr)) {
    const obj = expr.expression;
    const prop = expr.name.text;
    if (ts.isIdentifier(obj) && obj.text === "console" && ["log", "error", "warn", "info"].includes(prop)) {
      return node;
    }
    if (
      ts.isPropertyAccessExpression(obj) &&
      ts.isIdentifier(obj.expression) &&
      obj.expression.text === "process" &&
      (obj.name.text === "stdout" || obj.name.text === "stderr") &&
      prop === "write"
    ) {
      return node;
    }
  }
  return null;
}

/** Strips wrappers that never change the runtime value: parens and `as X` / `<X>` type assertions. A HARDCODED literal like `"0x80aD..." as Address` must still trace as a literal — the assertion is compile-time-only. */
function stripParens(node: ts.Expression): ts.Expression {
  while (true) {
    if (ts.isParenthesizedExpression(node)) { node = node.expression; continue; }
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) { node = node.expression; continue; }
    if (ts.isNonNullExpression(node)) { node = node.expression; continue; }
    return node;
  }
}

function isAllowedExpr(
  node: ts.Expression,
  constInits: Map<string, ts.Expression>,
  allowedFns: ReadonlySet<string>,
  depth: number,
): boolean {
  if (depth > 10) return false;
  const n = stripParens(node);

  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n)) return true;

  if (ts.isTemplateExpression(n)) {
    return n.templateSpans.every((span) => isAllowedExpr(span.expression, constInits, allowedFns, depth + 1));
  }

  if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && allowedFns.has(n.expression.text)) {
    // The call itself is the sanitizer; its OWN arguments are what it is
    // designed to validate, so they are not separately scrutinized here.
    return true;
  }

  // `"─".repeat(72)` — a pure, deterministic repetition of an already-
  // allowed base with a literal count. Separator-line idiom used
  // throughout these scripts; not a data path, never any external input.
  if (
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    n.expression.name.text === "repeat" &&
    n.arguments.length === 1 &&
    ts.isNumericLiteral(n.arguments[0]) &&
    isAllowedExpr(n.expression.expression, constInits, allowedFns, depth + 1)
  ) {
    return true;
  }

  if (ts.isConditionalExpression(n)) {
    return (
      isAllowedExpr(n.whenTrue, constInits, allowedFns, depth + 1) &&
      isAllowedExpr(n.whenFalse, constInits, allowedFns, depth + 1)
    );
  }

  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return (
      isAllowedExpr(n.left, constInits, allowedFns, depth + 1) &&
      isAllowedExpr(n.right, constInits, allowedFns, depth + 1)
    );
  }

  if (ts.isIdentifier(n)) {
    const init = constInits.get(n.text);
    if (!init) return false;
    return isAllowedExpr(init, constInits, allowedFns, depth + 1);
  }

  return false;
}

/**
 * Every sink-call argument in `source` that is NOT built only from string
 * literals and calls to `opts.allowedFns` (tracing simple same-file
 * `const`/`let NAME = EXPR` bindings back to their initializer). Empty =
 * clean. `opts.localSinkFns` names the script's own console.log wrapper(s)
 * so their call sites count as sinks too — otherwise this would only ever
 * see the wrapper's OWN internal `console.log(s)`, where `s` is just a
 * parameter name, and miss every real print site in the script.
 */
/** A same-line marker for a narrow, reviewed, provably-safe exception (e.g. MissingEnvError's own `.message`, which that class's doc comment guarantees is built only from a trusted name plus static text, never external data). Requires a visible, auditable comment at the call site — never a silent bypass. */
const SUPPRESS_MARKER = "fc8-ast-guard-allow";

/** The name of the nearest enclosing named function declaration/expression, if any (one level is enough for these scripts: every local sink wrapper is a top-level `function NAME(...)`). */
function enclosingFunctionName(node: ts.Node): string | undefined {
  let cur: ts.Node | undefined = node;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name) && cur.initializer && (ts.isFunctionExpression(cur.initializer) || ts.isArrowFunction(cur.initializer))) {
      return cur.name.text;
    }
    cur = cur.parent;
  }
  return undefined;
}

export function findUnsafeSinkArgs(source: string, opts: AstGuardOptions): Violation[] {
  const sourceFile = ts.createSourceFile("script.ts", source, ts.ScriptTarget.Latest, true);
  const allowedFns = new Set(opts.allowedFns);
  const localSinks = new Set(opts.localSinkFns);
  const constInits = new Map<string, ts.Expression>();
  const violations: Violation[] = [];
  const sourceLines = source.split("\n");

  function collect(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      constInits.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  }
  collect(sourceFile);

  function visit(node: ts.Node) {
    const call = isSinkCall(node, localSinks);
    if (call) {
      // A local sink wrapper's OWN internal console.log(param) call is not
      // itself a violation — every real call site is `wrapperName(...)`,
      // which this scanner already checks via localSinks. Without this,
      // the wrapper's single internal call (where the argument is just its
      // own parameter, unavoidably a bare identifier) would be flagged on
      // every script that defines one, independent of whether any actual
      // call site is unsafe.
      const isRawConsoleOrStdio = ts.isPropertyAccessExpression(call.expression);
      const enclosing = enclosingFunctionName(node);
      const insideLocalSinkDefinition = enclosing !== undefined && localSinks.has(enclosing);
      if (isRawConsoleOrStdio && insideLocalSinkDefinition) {
        ts.forEachChild(node, visit);
        return;
      }

      for (const arg of call.arguments) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(arg.getStart(sourceFile));
        if (sourceLines[line]?.includes(SUPPRESS_MARKER)) continue;
        if (!isAllowedExpr(arg, constInits, allowedFns, 0)) {
          violations.push({ line: line + 1, text: arg.getText(sourceFile) });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return violations;
}

// ── FC-8 round 5b (steward ruling #6712) ───────────────────────────────────
//
// publicChainRef prints a chain value VERBATIM — safe ONLY inside a
// stdout/stderr/report sink (findUnsafeSinkArgs above already proves every
// SINK ARGUMENT is literal-or-allowlisted-call, publicChainRef included
// once it's on that allowlist). This is the inverse direction: given every
// CALL to publicChainRef anywhere in the file, prove each one is actually
// reached from inside a sink call — never from an expression that builds a
// request body (the printer's printText/finalText, or any gw()/gwFetch()
// argument), and never just sitting in an unreviewed binding either.

/**
 * Every call to `publicChainRef` in `source` whose NEAREST enclosing
 * CallExpression (walking up `.parent`, skipping every non-call ancestor —
 * template spans, object/array literals, property assignments, variable
 * declarations) is not itself a recognized sink call (console.log,
 * console.error, console.warn, console.info, process.stdout.write,
 * process.stderr.write, or one of `localSinkFns`). A publicChainRef call
 * with NO enclosing CallExpression
 * at all (e.g. assigned to a bare `const` for later reuse) is also a
 * violation: this check does not trace identifiers back through
 * const-bindings the way findUnsafeSinkArgs's isAllowedExpr does, because
 * every real call site in this codebase inlines publicChainRef directly
 * inside a sink's template literal — if a future call site needs the
 * indirection, it should extend this function deliberately, not slip past
 * it silently. Empty = clean.
 */
export function findPublicChainRefOutsideSinks(source: string, localSinkFns: readonly string[]): Violation[] {
  const sourceFile = ts.createSourceFile("script.ts", source, ts.ScriptTarget.Latest, true);
  const localSinks = new Set(localSinkFns);
  const violations: Violation[] = [];

  function nearestEnclosingCall(node: ts.Node): ts.CallExpression | undefined {
    let cur: ts.Node | undefined = node.parent;
    while (cur) {
      if (ts.isCallExpression(cur)) return cur;
      cur = cur.parent;
    }
    return undefined;
  }

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "publicChainRef") {
      const enclosing = nearestEnclosingCall(node);
      const isOk = enclosing !== undefined && isSinkCall(enclosing, localSinks) !== null;
      if (!isOk) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push({ line: line + 1, text: node.getText(sourceFile) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return violations;
}
