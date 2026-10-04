/**
 * N71 round 6 (astra pack 83e, DO-NOT-SHIP at 5241c248): the sink scanner.
 *
 * Rounds 1-5 each fixed only the sinks astra happened to show the lane (a dependency's
 * exception text, or an unvalidated caller id, reaching a console/logger/span/telemetry
 * call). Astra kept finding a NEW instance of the SAME class because "fixed the sinks
 * you showed me" is not a proof that no sixth one exists. This file closes the class BY
 * CONSTRUCTION: it parses the PR's own 12 source files with the TypeScript compiler API
 * (syntactic AST only — no type-checker/Program is needed, since every decision below is
 * about an expression's SHAPE, never its static type) and fails if ANY argument to a
 * listed sink is anything other than a literal, a call to a small closed set of safe
 * helpers, or an identifier/member-expression this file's author explicitly allowlisted
 * with a reason. A sixth instance of "dependency or caller text in a log" cannot exist in
 * these 12 files without either being fixed or being named, with a reason, right here.
 *
 * ── SINKS (the shapes below; see matchSink) ──────────────────────────────────────────
 *   console.log/info/warn/error/debug · <expr>.log.<trace|debug|info|warn|error|fatal>(...)
 *   · logger.<method>(...) · {span|*Span}.{setStatus,recordException,setAttribute,
 *   setAttributes,addEvent,updateName}(...) · pipelineTelemetry.emit(...) ·
 *   this.emitTelemetry(...) · Sentry.{captureException,captureMessage}(...)
 * Every one is matched through optional chaining (`a?.b?.()`), parentheses and `as`
 * casts on the callee/receiver (asPropertyAccess + unwrap), per the brief.
 *
 * ── ALLOWED ARGUMENT FORMS (checkArg; applied recursively into object-literal property
 *    values/shorthands/spreads, array elements/spreads, template-literal holes, AND —
 *    a deliberate extension beyond the brief's 3 named recursion sites, see below —
 *    both branches of a conditional (ternary) expression) ──────────────────────────────
 *   - literals: string, number, boolean, null, undefined.
 *   - calls to a small CLOSED set of safe helpers (SAFE_CALLEE_NAMES): knownErrorClassName
 *     and logSafeId (redaction.ts, this round's own helpers — see Step 2), and Date.now
 *     (built-in, zero-argument, returns a numeric timestamp with no caller/dependency
 *     influence). These calls' OWN arguments are deliberately NOT recursed into: the
 *     entire point of logSafeId/knownErrorClassName is to launder an otherwise-unsafe
 *     value, so requiring their input to ALSO already be "safe" would make them useless.
 *     No other pre-existing "closed helper for codes" call was found in the 12 files
 *     beyond knownErrorClassName (already named by the brief) — see the report.
 *   - identifiers / member expressions ONLY from the per-file ALLOWLIST below, each with
 *     a one-line reason.
 *   Anything else is a violation: file:line:column, the sink, and the offending text.
 *
 * ── Three deliberate extensions beyond the brief's literal text (all documented here and
 *    in the report so a reviewer can second-guess them) ────────────────────────────────
 *   1. Conditional-expression (ternary) recursion. Without it, kernel-service.ts's own
 *      ALREADY-FIXED (round 5) `lifecycleSpan.setStatus({ code: result.success ? 1 : 2,
 *      message: result.success ? "ok" : "job_run_failed" })` would be a false positive —
 *      both ternary branches are fixed literals, so the whole expression is as closed as
 *      a literal itself.
 *   2. Spread elements/assignments (`...x`) are checked the same way a bare identifier
 *      argument would be — the brief names object-property-values, array-elements and
 *      template-holes as recursion sites but does not mention spreads explicitly; this
 *      closes that gap rather than silently skipping spread content.
 *   3. `a ?? b` / `a || b` recursion into both sides — the same "closed if both sides are
 *      closed" shape as a ternary. Without it, kernel-service.ts's
 *      `this.config.kernelId ?? "default"` (an allowlisted member-expression OR a
 *      literal) would be a false positive too.
 *
 * ── MUTANT-TESTABLE LINES (Step 3, mutants e/f — the PROBE below is what catches them) ─
 *   Mutant (e) "the scanner allows any identifier": targets the `if (entry) return true;`
 *   / `return false;` pair inside checkArg's identifier/member-expression branch.
 *   Mutant (f) "the scanner ignores optional-chained calls": targets the
 *   `if (!ts.isPropertyAccessExpression(n)) return null;` line inside asPropertyAccess —
 *   replacing it with a version that also rejects `n.questionDotToken !== undefined`
 *   reproduces exactly "ignores optional-chained calls" (matchSink's first step calls
 *   asPropertyAccess on the outer callee, so an optional-chained sink call like
 *   `(req as any).log?.warn?.(...)` would stop being recognized as a sink AT ALL).
 */
import { describe, it, expect } from "vitest";
import * as ts from "typescript";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// AST helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Strip parens and `as`/`<T>`/`!` wrappers. Never strips optional chaining — `?.` stays
 *  meaningful on whatever node carries it (see asPropertyAccess). */
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

/** A (possibly optional-chained) property access, after unwrapping. Optional chaining
 *  does not change the node KIND, only sets `questionDotToken` — so it must be accepted
 *  exactly like a plain `.`. (Mutant-f target: the next line.) */
function asPropertyAccess(expr: ts.Expression): { receiver: ts.Expression; name: string } | null {
  const n = unwrap(expr);
  if (!ts.isPropertyAccessExpression(n)) return null;
  return { receiver: n.expression, name: n.name.text };
}

function isIdentifierNamed(expr: ts.Expression, name: string): boolean {
  const n = unwrap(expr);
  return ts.isIdentifier(n) && n.text === name;
}

function isThisExpr(expr: ts.Expression): boolean {
  return unwrap(expr).kind === ts.SyntaxKind.ThisKeyword;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sink recognition — exactly the 8 shapes named in the brief
// ─────────────────────────────────────────────────────────────────────────────

const CONSOLE_METHODS = new Set(["log", "info", "warn", "error", "debug"]);
const DOT_LOG_METHODS = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);
const SPAN_METHODS = new Set(["setStatus", "recordException", "setAttribute", "setAttributes", "addEvent", "updateName"]);
const SENTRY_METHODS = new Set(["captureException", "captureMessage"]);

/** Returns a human-readable sink name, or null if `call` isn't one of the 8 shapes. */
/** Functions in scope that write their argument to a log stream themselves; each call site is a sink. */
const STREAM_EMITTERS = new Set(["emitKernelLifecycleEvent"]);

function matchSink(call: ts.CallExpression): string | null {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee) && STREAM_EMITTERS.has(callee.text)) return callee.text;

  const outer = asPropertyAccess(call.expression);
  if (!outer) return null;
  const { receiver, name: method } = outer;

  // process.stdout.write(...) / process.stderr.write(...)
  const stream = asPropertyAccess(receiver);
  if (
    stream &&
    method === "write" &&
    (stream.name === "stdout" || stream.name === "stderr") &&
    isIdentifierNamed(stream.receiver, "process")
  ) {
    return `process.${stream.name}.write`;
  }

  if (isIdentifierNamed(receiver, "console") && CONSOLE_METHODS.has(method)) return `console.${method}`;
  if (isIdentifierNamed(receiver, "Sentry") && SENTRY_METHODS.has(method)) return `Sentry.${method}`;
  if (isIdentifierNamed(receiver, "pipelineTelemetry") && method === "emit") return "pipelineTelemetry.emit";
  if (isThisExpr(receiver) && method === "emitTelemetry") return "this.emitTelemetry";
  if (isIdentifierNamed(receiver, "logger")) return `logger.${method}`;

  const receiverUnwrapped = unwrap(receiver);
  if (
    ts.isIdentifier(receiverUnwrapped) &&
    (receiverUnwrapped.text === "span" || /Span$/.test(receiverUnwrapped.text)) &&
    SPAN_METHODS.has(method)
  ) {
    return `${receiverUnwrapped.text}.${method}`;
  }

  // <expr>.log.<method>(...) — the receiver must itself be a property access named "log".
  const inner = asPropertyAccess(receiver);
  if (inner && inner.name === "log" && DOT_LOG_METHODS.has(method)) return `<expr>.log.${method}`;

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Allowed argument forms
// ─────────────────────────────────────────────────────────────────────────────

/** Calls whose callee resolves to one of these names are unconditionally allowed — their
 *  OWN arguments are deliberately not recursed into (see the file doc comment). */
const SAFE_CALLEE_NAMES = new Set(["knownErrorClassName", "logSafeId", "logSafeSmallInt", "Date.now"]);

function calleeText(expr: ts.Expression): string | null {
  const n = unwrap(expr);
  if (ts.isIdentifier(n)) return n.text;
  if (ts.isPropertyAccessExpression(n)) {
    const obj = unwrap(n.expression);
    if (ts.isIdentifier(obj)) return `${obj.text}.${n.name.text}`;
  }
  return null;
}

export interface Violation {
  file: string;
  line: number;
  column: number;
  sink: string;
  argText: string;
}

/** Per-file allowlist: exact source text of an identifier/member-expression -> reason. */
type FileAllowlist = Record<string, string>;
type Allowlist = Record<string, FileAllowlist>;

interface ScanCtx {
  file: string;
  allowlist: Allowlist;
  sourceFile: ts.SourceFile;
  sink: string;
  out: Violation[];
}

function pushViolation(ctx: ScanCtx, node: ts.Node): void {
  const pos = ctx.sourceFile.getLineAndCharacterOfPosition(node.getStart(ctx.sourceFile));
  ctx.out.push({
    file: ctx.file,
    line: pos.line + 1,
    column: pos.character + 1,
    sink: ctx.sink,
    argText: node.getText(ctx.sourceFile).replace(/\s+/g, " ").trim().slice(0, 200),
  });
}

/** Checks one argument expression (or, recursively, one leaf inside it) against the
 *  allowed forms. Pushes a Violation for every offending LEAF (not just the top-level
 *  argument), so e.g. `{ err: err.message, deviceId }` yields two distinct violations.
 *  Returns true iff the whole (sub)expression is allowed. */
function checkArg(expr: ts.Expression, ctx: ScanCtx): boolean {
  const n = unwrap(expr);

  // literals
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n)) return true;
  if (n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword || n.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(n) && n.text === "undefined") return true;

  // template-literal holes
  if (ts.isTemplateExpression(n)) {
    let ok = true;
    for (const span of n.templateSpans) ok = checkArg(span.expression, ctx) && ok;
    return ok;
  }

  // conditional expression (ternary) — scanner extension, see file doc comment.
  if (ts.isConditionalExpression(n)) {
    const whenTrueOk = checkArg(n.whenTrue, ctx);
    const whenFalseOk = checkArg(n.whenFalse, ctx);
    return whenTrueOk && whenFalseOk;
  }

  // `a ?? b` / `a || b` — a 3rd scanner extension: picking one of two values is the
  // same "closed if both sides are closed" shape as a ternary (e.g. kernel-service.ts's
  // `this.config.kernelId ?? "default"` — a validated member-expression OR a literal).
  if (
    ts.isBinaryExpression(n) &&
    (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || n.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    const leftOk = checkArg(n.left, ctx);
    const rightOk = checkArg(n.right, ctx);
    return leftOk && rightOk;
  }

  // object literal: property values, shorthand identifiers, spreads
  if (ts.isObjectLiteralExpression(n)) {
    let ok = true;
    for (const prop of n.properties) {
      if (ts.isPropertyAssignment(prop)) ok = checkArg(prop.initializer, ctx) && ok;
      else if (ts.isShorthandPropertyAssignment(prop)) ok = checkArg(prop.name, ctx) && ok;
      else if (ts.isSpreadAssignment(prop)) ok = checkArg(prop.expression, ctx) && ok;
      else { pushViolation(ctx, prop); ok = false; }
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

  // calls to the closed, safe helper set — their own arguments are not recursed into
  if (ts.isCallExpression(n)) {
    const name = calleeText(n.expression);
    if (name && SAFE_CALLEE_NAMES.has(name)) return true;
    pushViolation(ctx, n);
    return false;
  }

  // identifiers / member expressions: only via this file's explicit allowlist
  if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) {
    const text = n.getText(ctx.sourceFile);
    // MUTANT-E-TARGET: the next two lines. Replacing them with a bare `return true;`
    // reproduces "the scanner allows any identifier".
    if (ctx.allowlist[ctx.file]?.[text]) return true;
    pushViolation(ctx, n);
    return false;
  }

  pushViolation(ctx, n);
  return false;
}

/** Parses `sourceText` as `file` and returns every violation found in every matched sink
 *  call's arguments. */
function collectViolations(file: string, sourceText: string, allowlist: Allowlist): Violation[] {
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Violation[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const sink = matchSink(node);
      if (sink) {
        const ctx: ScanCtx = { file, allowlist, sourceFile, sink, out };
        for (const arg of node.arguments) checkArg(arg, ctx);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return out;
}

function formatViolations(vs: Violation[]): string {
  if (vs.length === 0) return "(no violations)";
  return vs.map((v) => `${v.file}:${v.line}:${v.column} [${v.sink}] ${v.argText}`).join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// The PR's scope: the 12 source files + the per-file allowlist
// ─────────────────────────────────────────────────────────────────────────────

const GATEWAY_SRC = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // .../packages/gateway/src

const SCOPE_FILES = [
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

/**
 * Every entry below is this file's author asserting, BY NAME, that a specific
 * identifier/member-expression in a specific file can only ever hold a closed/fixed
 * value — never dependency or caller text — and saying why. See the report for the
 * file-by-file audit each reason is based on.
 */
const ALLOWLIST: Allowlist = {
  "facades/base.facade.ts": {
    "this.facadeName": "Set once in each facade's own constructor from a fixed literal (e.g. super(\"capability\")) — every subclass checked, never caller input.",
    "operation": "execute()'s 1st parameter; every this.execute(...) call site across all 12 files passes a fixed literal (e.g. \"submit\") — verified, never caller input.",
    "SpanStatusCode.OK": "An @opentelemetry/api enum member — a fixed constant.",
    "SpanStatusCode.ERROR": "An @opentelemetry/api enum member — a fixed constant.",
    "code": "execute()'s local variable; assigned only from a facade-authored literal, TRANSIENT_ERROR_CODE, or a facade-errors class's own optional .code — every throw site across the 12 files passes a literal (verified).",
    "status": "emitTelemetry's parameter, typed as the closed literal union \"completed\" | \"failed\".",
    "metadata": "emitTelemetry's own parameter (private method); its only call sites, scanned above in this same file, pass only literals or the allowlisted message/operation below.",
    "message": "execute()'s local variable, reached only inside an instanceof-narrowed facade-authored error class; astra round 4/5 already accepted it for the response/telemetry (verdict Q1/Q3) — this round's scope is the span, which now gets `code` only.",
  },
  "facades/kernel.facade.ts": {
    "KERNEL_TTL_LOWER_BOUND_HOURS": "Module-level `const X = <number literal>` (this file, top) — fixed at load time, never reassigned, never caller/dependency input.",
    "KERNEL_TTL_UPPER_BOUND_HOURS": "Module-level `const X = <number literal>` (this file, top) — fixed at load time, never reassigned, never caller/dependency input.",
    "KERNEL_TTL_DEFAULT_HOURS": "Module-level `const X = <number literal>` (this file, top) — fixed at load time, never reassigned, never caller/dependency input.",
    "sinceLastHeartbeatSec": "heartbeat()'s local: null or Math.floor((now - the STORED prior heartbeat) / 1000) — a server-computed integer, never caller text.",
    "wasExpiredForMinutes": "heartbeat()'s local: null or Math.floor(of a difference of server-stored timestamps) — a server-computed integer, never caller text.",
    "line": "emitKernelLifecycleEvent's own JSON of its argument plus a server timestamp; that argument is checked as a sink at every call site in these files (STREAM_EMITTERS).",
  },
  "services/kernel-service.ts": {
    "this.config.kernelId": "KernelService's own KernelConfig.kernelId, fixed at construction from the operator's own config/env — never per-request caller input.",
    "phase": "OnPhaseCallback's 2nd parameter (@pcc/kernel/job-runner.ts) is typed as the closed literal union \"job_accepted\" | \"job_started\" | \"evidence_capture\".",
    "status": "OnPhaseCallback's 3rd parameter (@pcc/kernel/job-runner.ts) is typed as the closed literal union \"completed\" | \"failed\".",
  },
  "facades/settlement.facade.ts": {
    "address": "Every method's own parameter, validated via this.validateAddress()/isAddress() before any sink call in this file — a well-formed 0x+40hex Ethereum address.",
    "milestoneIndex": "Every method's own parameter, validated via this.validateMilestoneIndex() (rejects NaN/negative) before any sink call in this file — a number.",
    "summary.epochId": "EpochSummary.epochId (@pcc/bundler/src/batch-settler.ts) is typed `number` — an internally-incremented batch counter, never caller input.",
    "summary.totalIntents": "EpochSummary.totalIntents (@pcc/bundler/src/batch-settler.ts) is typed `number` — a server-computed count.",
  },
};

function scanScopeFiles(): Violation[] {
  const all: Violation[] = [];
  for (const rel of SCOPE_FILES) {
    const text = readFileSync(join(GATEWAY_SRC, rel), "utf8");
    all.push(...collectViolations(rel, text, ALLOWLIST));
  }
  return all;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests: sink recognition + allowed-forms mechanics (synthetic sources)
// ─────────────────────────────────────────────────────────────────────────────

function violationsIn(src: string, allowlist: Allowlist = {}, file = "probe.ts"): Violation[] {
  return collectViolations(file, src, allowlist);
}

describe("N71 round 6: sink scanner mechanics", () => {
  it("PROBE: flags exactly the forbidden err.message and deviceId inside an optional-chained req.log?.warn?.() call; the knownErrorClassName call is unflagged", () => {
    const src = `
      function probe(req: any, err: unknown, deviceId: string) {
        console.warn("fixed_code", knownErrorClassName(err));
        (req as any).log?.warn?.({ err: err.message, deviceId }, "message");
      }
    `;
    const violations = violationsIn(src);
    expect(violations, formatViolations(violations)).toHaveLength(2);
    expect(violations.every((v) => v.sink === "<expr>.log.warn")).toBe(true);
    expect(violations.map((v) => v.argText).sort()).toEqual(["deviceId", "err.message"]);
  });

  it("recognizes every one of the 8 listed sink shapes and flags an unlisted-identifier argument in each", () => {
    const cases: Array<[string, string]> = [
      ["console.log", "console.log(bad);"],
      ["console.info", "console.info(bad);"],
      ["console.warn", "console.warn(bad);"],
      ["console.error", "console.error(bad);"],
      ["console.debug", "console.debug(bad);"],
      ["<expr>.log.warn", "x.log.warn(bad);"],
      ["<expr>.log.fatal (optional-chained)", "x?.log?.fatal?.(bad);"],
      ["logger.info", "logger.info(bad);"],
      ["span.setAttribute", "span.setAttribute('k', bad);"],
      ["*Span.addEvent", "customSpan.addEvent(bad);"],
      ["pipelineTelemetry.emit", "pipelineTelemetry.emit(bad, 'p', 's');"],
      ["this.emitTelemetry", "class X { m() { this.emitTelemetry(bad); } }"],
      ["Sentry.captureException", "Sentry.captureException(bad);"],
      ["Sentry.captureMessage", "Sentry.captureMessage(bad);"],
      ["process.stderr.write", "process.stderr.write(bad);"],
      ["process.stdout.write", "process.stdout.write(`x ${bad}`);"],
      ["emitKernelLifecycleEvent", "emitKernelLifecycleEvent({ event: 'k', kernelId: bad });"],
    ];
    for (const [label, src] of cases) {
      const violations = violationsIn(src);
      expect(violations.length, `${label}: ${formatViolations(violations)}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("a non-sink call (e.g. trackServerEvent, auditService.log) is never scanned, however it is shaped", () => {
    expect(violationsIn("trackServerEvent('x', { raw: freeText }, actorId);")).toHaveLength(0);
    expect(violationsIn("auditService.log({ metadata: { raw: freeText } });")).toHaveLength(0);
  });

  it("a template-literal hole recurses: Date.now() is allowed, a bare identifier is flagged", () => {
    expect(violationsIn("console.log(`t=${Date.now()}`);")).toHaveLength(0);
    const bad = violationsIn("console.log(`id=${someId}`);");
    expect(bad).toHaveLength(1);
    expect(bad[0].argText).toBe("someId");
  });

  it("a ternary of two literals is allowed (round 5's own lifecycleSpan.setStatus pattern); a non-literal branch is flagged", () => {
    expect(violationsIn('span.setStatus({ code: ok ? 1 : 2, message: ok ? "a" : "b" });')).toHaveLength(0);
    const bad = violationsIn('span.setStatus({ message: ok ? "a" : freeText });');
    expect(bad).toHaveLength(1);
    expect(bad[0].argText).toBe("freeText");
  });

  it("`a ?? b` / `a || b` recurses into both sides (kernel-service.ts's `this.config.kernelId ?? \"default\"` pattern)", () => {
    const allowlist: Allowlist = { "k.ts": { safe: "test fixture" } };
    expect(violationsIn('console.log(safe ?? "default");', allowlist, "k.ts")).toHaveLength(0);
    const bad = violationsIn('console.log(unsafe ?? "default");');
    expect(bad).toHaveLength(1);
    expect(bad[0].argText).toBe("unsafe");
    const badOr = violationsIn('console.log("" || unsafe);');
    expect(badOr).toHaveLength(1);
    expect(badOr[0].argText).toBe("unsafe");
  });

  it("a spread element/assignment is checked the same way a bare identifier argument would be", () => {
    const bad = violationsIn("pipelineTelemetry.emit('id', 'phase', 'completed', { metadata: { ...rest } });");
    expect(bad).toHaveLength(1);
    expect(bad[0].argText).toBe("rest");
  });

  it("knownErrorClassName(...) and logSafeId(...) are allowed regardless of their OWN argument — that argument is exactly what they launder", () => {
    expect(violationsIn("console.warn(knownErrorClassName(anyRawDependencyError));")).toHaveLength(0);
    expect(violationsIn("console.warn(logSafeId(anyRawCallerId));")).toHaveLength(0);
  });

  it("allowlist entries are scoped per file — an identifier allowed in one file is not allowed in another", () => {
    const src = "console.warn(code);";
    const allowlist: Allowlist = { "a.ts": { code: "test fixture" } };
    expect(violationsIn(src, allowlist, "a.ts")).toHaveLength(0);
    expect(violationsIn(src, allowlist, "b.ts")).toHaveLength(1);
  });

  it("control: a fully-literal call to every sink shape is clean", () => {
    expect(
      violationsIn(
        'console.error("fixed", 1, true, null, undefined, { a: "x", b: [1, 2, "y"] }, `literal ${1}`);',
      ),
    ).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The real scan: the PR's own 12 source files
// ─────────────────────────────────────────────────────────────────────────────

describe("N71 round 6: the sink scanner over the PR's own 12 source files", () => {
  it("finds zero unexplained sinks across the PR's scope (closes the class by construction)", () => {
    const violations = scanScopeFiles();
    expect(violations, formatViolations(violations)).toEqual([]);
  });
});

describe("logSafeSmallInt (N71 round 6 follow-up)", () => {
  it("passes an integer inside the bounds, and turns anything else into null", async () => {
    const { logSafeSmallInt } = await import("../redaction.js");
    expect(logSafeSmallInt(2, 0, 3)).toBe(2);
    expect(logSafeSmallInt(0, 0, 3)).toBe(0);
    for (const bad of [4, -1, 1.5, NaN, "2", "N71-SENTINEL", null, undefined, {}, [2]]) {
      expect(logSafeSmallInt(bad as unknown, 0, 3), String(bad)).toBeNull();
    }
  });
});
