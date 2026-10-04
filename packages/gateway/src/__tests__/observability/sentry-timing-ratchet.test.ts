/**
 * N107b round 4 (the PR steward's escalated property, C11): the one declared-by-construction source.
 * An error event and a breadcrumb leave with the server's clock read at the chokepoint. A transaction's
 * and a span's start and end times leave as the Sentry SDK took them, and they are declared by
 * construction: no producer can supply them, because no gateway code passes a time to a Sentry or
 * OpenTelemetry span API. This ratchet proves that over packages/gateway/src with TypeScript's type
 * checker, so a call is found whatever alias or import names it:
 *   - a call whose function is declared in @sentry/* or @opentelemetry/* must not take an object
 *     literal with a time option (startTime, endTime, timestamp, startTimestamp, endTimestamp,
 *     start_timestamp), nor a spread (its keys cannot be read), nor an options value whose type has
 *     one of those keys;
 *   - a span's end() and updateStartTime() take no argument;
 *   - captureEvent is not called (an event's type and times would be the caller's).
 *
 * N107c (tests pack, #538 round 3): that scanner named a call by its callee's text and read only
 * plain keys, so `{ ["startTime"]: t }`, `span["end"](t)` and an aliased or bound method passed.
 * Now:
 *   - a call is found by its resolved signature's declaration and named by it, however its
 *     function was reached (an element access, an alias, a destructured or a bound method);
 *   - a key is read from its type, so a computed key naming a literal or a constant counts, and a
 *     computed key the type cannot name is refused;
 *   - an event's and an exception's time are times too: addEvent's third argument (or a time as
 *     its second) and recordException's second;
 *   - a Sentry or OpenTelemetry function used as a value is followed: bound (its pre-bound
 *     arguments are its first), called through call or apply, named by a variable that keeps its
 *     type, or passed into a function of this program, where each use of that parameter must be a
 *     direct call, checked as a call of the function passed. Any other use is refused.
 * A probe compiled in the same way pins that the check catches each form.
 */
import { describe, it, expect } from "vitest";
import ts from "typescript";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// packages/gateway/src/__tests__/observability -> packages/gateway/src
const SRC_ROOT = join(__dirname, "..", "..");
const TSCONFIG = join(SRC_ROOT, "..", "tsconfig.json");

const TIME_KEYS = new Set(["startTime", "endTime", "timestamp", "startTimestamp", "endTimestamp", "start_timestamp"]);
const NO_ARGUMENT_METHODS = new Set(["end", "updateStartTime"]);
const FORBIDDEN_CALLS = new Set(["captureEvent"]);
/** A method whose argument at this index is a time: an event's (addEvent's third) and an exception's (recordException's second). */
const TIME_ARGUMENTS: ReadonlyMap<string, number> = new Map([["addEvent", 2], ["recordException", 1]]);

interface Violation {
  file: string;
  line: number;
  text: string;
}

function parsedConfig(): ts.ParsedCommandLine {
  const parsed = ts.getParsedCommandLineOfConfigFile(TSCONFIG, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    },
  });
  if (!parsed) throw new Error(`cannot read ${TSCONFIG}`);
  return parsed;
}

const isTelemetryApi = (file: string | undefined) => !!file && /[/\\](@sentry|@opentelemetry)[/\\]/.test(file);

/**
 * The declaration of the function a call runs: its resolved signature's, so a call is found
 * whatever reached its function (an import alias, a destructured or aliased method, a bound one,
 * an element access); else its callee's symbol.
 */
function calledDeclaration(call: ts.CallExpression, checker: ts.TypeChecker): ts.Declaration | undefined {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (declaration && !ts.isJSDocSignature(declaration)) return declaration;
  const callee = ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name
    : ts.isElementAccessExpression(call.expression)
      ? call.expression.argumentExpression
      : call.expression;
  let symbol = checker.getSymbolAtLocation(callee);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.declarations?.[0];
}

/** A declaration's own name (a method's or function's), if it has a plain one. */
function declarationName(declaration: ts.Declaration | undefined): string | undefined {
  const name = declaration && (declaration as { name?: ts.Node }).name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;
}

/** The callee's own name as written (a property, an element access with a literal, an identifier). */
function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) return callee.argumentExpression.text;
  if (ts.isIdentifier(callee)) return callee.text;
  return undefined;
}

/** A property's key as the program names it: a literal, or a computed key whose type is a literal; else undefined. */
function propertyKey(name: ts.PropertyName, checker: ts.TypeChecker): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const type = checker.getTypeAtLocation(name.expression);
    if (type.isStringLiteral()) return type.value;
    if (type.isNumberLiteral()) return String(type.value);
  }
  return undefined;
}

/** A type a time can take (a number, a Date, an HrTime tuple or any array), or any or unknown. */
function isTimeLikeType(type: ts.Type, checker: ts.TypeChecker): boolean {
  if (type.isUnion()) return type.types.some((t) => isTimeLikeType(t, checker));
  if (type.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
  if (checker.isArrayType(type) || checker.isTupleType(type)) return true;
  return type.getSymbol()?.getName() === "Date";
}

/** A function value whose every call signature is a Sentry or OpenTelemetry API's. */
function isTelemetryFunction(type: ts.Type): boolean {
  const signatures = type.getCallSignatures();
  return signatures.length > 0 && signatures.every((signature) => isTelemetryApi(signature.getDeclaration()?.getSourceFile().fileName));
}

/** A function-like declaration in the scanned program, with a body the scan can read. */
function functionWithBody(declaration: ts.Declaration | undefined): ts.SignatureDeclaration & { body: ts.Node } | undefined {
  if (!declaration) return undefined;
  if ((ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration) || ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration)) && declaration.body) {
    return declaration as ts.SignatureDeclaration & { body: ts.Node };
  }
  return undefined;
}

/** What a scan found: the API calls it checked and the API functions it followed into this program (so an empty scan cannot pass). */
interface Found {
  calls: number;
  followed: number;
}

function scanProgram(program: ts.Program, include: (fileName: string) => boolean, found: Found = { calls: 0, followed: 0 }): Violation[] {
  const checker = program.getTypeChecker();
  const violations: Violation[] = [];
  const report = (node: ts.Node, why: string) => {
    const sourceFile = node.getSourceFile();
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({ file: sourceFile.fileName, line: line + 1, text: why });
  };

  /** One call of a Sentry or OpenTelemetry function, named `name`, with these arguments. */
  const checkTelemetryCall = (at: ts.Node, name: string, args: readonly ts.Expression[]) => {
    found.calls += 1;
    if (FORBIDDEN_CALLS.has(name)) report(at, `${name}(): an event's type and times would be the caller's`);
    if (NO_ARGUMENT_METHODS.has(name) && args.length > 0) report(at, `${name}(<time>): a span's times are the SDK's clock`);
    const timeAt = TIME_ARGUMENTS.get(name);
    if (timeAt !== undefined && args.length > timeAt) report(args[timeAt]!, `${name}(..., <time>): a time is the SDK's clock`);
    if (name === "addEvent" && args[1] !== undefined && !ts.isObjectLiteralExpression(args[1]) && isTimeLikeType(checker.getTypeAtLocation(args[1]), checker)) {
      report(args[1], "addEvent(name, <time>): an event's time is the SDK's clock");
    }
    for (const argument of args) {
      if (ts.isSpreadElement(argument)) {
        report(argument, `${name}(...spread): arguments the ratchet cannot read`);
      } else if (ts.isObjectLiteralExpression(argument)) {
        for (const property of argument.properties) {
          if (ts.isSpreadAssignment(property)) {
            report(property, `${name}({ ...spread }): an option the ratchet cannot read`);
            continue;
          }
          const key = property.name === undefined ? undefined : propertyKey(property.name, checker);
          if (key === undefined) report(property, `${name}({ [<key>]: ... }): an option key the ratchet cannot read`);
          else if (TIME_KEYS.has(key)) report(property, `${name}({ ${key} }): a time option`);
        }
      } else if (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument)) {
        const type = checker.getTypeAtLocation(argument);
        if (!(type.flags & ts.TypeFlags.StringLike) && [...TIME_KEYS].some((key) => checker.getApparentType(type).getProperty(key) !== undefined)) {
          report(argument, `${name}(<options with a time key>): pass an object literal without a time option`);
        }
      }
    }
  };

  /**
   * A Sentry or OpenTelemetry function passed as a value into a function of this program: the
   * ratchet follows it into that function, where each use of the parameter must be a direct call,
   * checked as a call of the function passed. Any other use is a path the ratchet cannot follow.
   */
  const followArgument = (call: ts.CallExpression, index: number, argument: ts.Expression, name: string) => {
    const callee = functionWithBody(calledDeclaration(call, checker));
    const parameter = callee?.parameters[index];
    if (!callee || !parameter || parameter.dotDotDotToken || !ts.isIdentifier(parameter.name) || !include(callee.getSourceFile().fileName)) {
      report(argument, `${name} passed where the ratchet cannot follow its calls`);
      return;
    }
    found.followed += 1;
    const symbol = checker.getSymbolAtLocation(parameter.name);
    const visitUse = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node !== parameter.name && checker.getSymbolAtLocation(node) === symbol) {
        const parent = node.parent;
        if (ts.isCallExpression(parent) && parent.expression === node) checkTelemetryCall(parent, name, parent.arguments);
        else report(argument, `${name} passed into ${callee.name?.getText() ?? "a function"}, which uses it other than by calling it`);
      }
      ts.forEachChild(node, visitUse);
    };
    visitUse(callee.body);
  };

  /** Where a Sentry or OpenTelemetry function value may appear: called, bound with no argument, called through call/apply, named by a variable that keeps its type, or followed into a function of this program. */
  const checkFunctionValue = (node: ts.Expression) => {
    const parent = node.parent;
    const name = declarationName(checker.getTypeAtLocation(node).getCallSignatures()[0]?.getDeclaration()) ?? "<telemetry function>";
    if (ts.isCallExpression(parent) && parent.expression === node) return; // a direct call: checked as a call
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      const call = parent.parent;
      const method = parent.name.text;
      if (ts.isCallExpression(call) && call.expression === parent) {
        if (method === "bind") {
          if (call.arguments.length > 1) checkTelemetryCall(call, name, call.arguments.slice(1));
          return;
        }
        if (method === "call") return checkTelemetryCall(call, name, call.arguments.slice(1));
        if (method === "apply") {
          const list = call.arguments[1];
          if (list === undefined) return;
          if (ts.isArrayLiteralExpression(list)) return checkTelemetryCall(call, name, list.elements);
          return report(list, `${name}.apply(thisArg, <arguments>): arguments the ratchet cannot read`);
        }
      }
      return; // a property of the function (its name, its length)
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === node && !parent.type) return; // the variable keeps its type
    if (ts.isCallExpression(parent) && parent.arguments.includes(node)) {
      if (isTelemetryApi(calledDeclaration(parent, checker)?.getSourceFile().fileName)) return; // handed to the API itself
      return followArgument(parent, parent.arguments.indexOf(node), node, name);
    }
    if (ts.isParenthesizedExpression(parent)) return checkFunctionValue(parent);
    report(node, `${name} used where the ratchet cannot follow its calls`);
  };

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || !include(sourceFile.fileName)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const declaration = calledDeclaration(node, checker);
        if (isTelemetryApi(declaration?.getSourceFile().fileName)) {
          checkTelemetryCall(node, declarationName(declaration) ?? calleeName(node) ?? "<call>", node.arguments);
        }
      }
      if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isIdentifier(node)) && ts.isExpression(node)) {
        const parent = node.parent;
        const isName = (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isVariableDeclaration(parent) && parent.name === node) || ts.isBindingElement(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent) || ts.isImportClause(parent) || ts.isExportSpecifier(parent) || ts.isParameter(parent);
        if (!isName && isTelemetryFunction(checker.getTypeAtLocation(node))) checkFunctionValue(node as ts.Expression);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return violations;
}

const inGatewaySource = (fileName: string) =>
  fileName.startsWith(SRC_ROOT + "/") && !fileName.includes("/__tests__/") && !fileName.includes("/node_modules/");

describe("N107b round 4, C11: no gateway code passes a time to a Sentry or OpenTelemetry span", () => {
  it("the check catches a time option, a spread, an options value, an end time and captureEvent (probe)", () => {
    const options = { ...parsedConfig().options, noEmit: true };
    const probe = join(SRC_ROOT, "__timing_ratchet_probe__.ts");
    const source = [
      'import * as Sentry from "@sentry/node";',
      'import { trace, type SpanOptions } from "@opentelemetry/api";',
      'const tracer = trace.getTracer("probe");',
      "const t = Date.now();",
      'const span = tracer.startSpan("a", { startTime: t });', // line 5: an OTel start time
      "span.end(t);", // line 6: an OTel end time
      'Sentry.startSpan({ name: "b", startTime: t }, () => 1);', // line 7: a Sentry start time
      'const extra = { name: "c" };',
      "Sentry.startInactiveSpan({ ...extra });", // line 9: a spread
      'const opts: SpanOptions = { attributes: {} };',
      'tracer.startSpan("d", opts);', // line 11: an options value whose type has startTime
      'Sentry.captureEvent({ message: "e" });', // line 12: captureEvent
      'tracer.startActiveSpan("f", (s) => { s.end(); return 1; });',
      'Sentry.startSpan({ name: "g", op: "db" }, () => 1);',
      "const local = { end: (x: number) => x, startSpan: (o: { startTime: number }) => o };",
      "local.end(1);",
      "local.startSpan({ startTime: 1 });",
      // N107c (tests pack r3, question 2): the forms the first scanner let through.
      'tracer.startSpan("h", { ["startTime"]: t });', // line 18: a computed time key
      'const timeKey = "startTime";',
      'tracer.startSpan("i", { [timeKey]: t });', // line 20: a computed key from a constant
      'span["end"](t);', // line 21: an element-access call
      "const endFn = span.end.bind(span);",
      "endFn(t);", // line 23: a bound method
      "const { startSpan: sentryStart } = Sentry;",
      'sentryStart({ name: "j", startTime: t }, () => 1);', // line 25: a destructured function
      'span.addEvent("e", {}, t);', // line 26: an event's time
      'span.recordException(new Error("x"), t);', // line 27: an exception's time
      "const dynamicKey = String(Date.now());",
      'tracer.startSpan("k", { [dynamicKey]: 1 });', // line 29: a key the scan cannot read
      'span.addEvent("ok-event", { a: 1 });',
      "span.end.call(span, t);", // line 31: a time through call
      "span.end.apply(span, [t]);", // line 32: a time through apply
      "const preBound = span.end.bind(span, t);", // line 33: a time bound in advance
      'span.addEvent("x", t);', // line 34: an event's time as its second argument
      "const typed: (o: { name: string; startTime?: number }, cb: () => number) => number = Sentry.startSpan;", // line 35: a type that loses the API
      "function wrap(start: (o: { name: string; startTime?: number }) => unknown) {",
      '  return start({ name: "w", startTime: t });', // line 37: a time passed through a parameter
      "}",
      "wrap(Sentry.startInactiveSpan);",
      "function keep(f: unknown) {",
      "  return f;",
      "}",
      "keep(Sentry.startInactiveSpan);", // line 43: a function the ratchet cannot follow
      "const alias = Sentry.startSpan;",
      'alias({ name: "ok" }, () => 1);',
      "function wrapOk(start: (o: { name: string }) => unknown) {",
      '  return start({ name: "ok" });',
      "}",
      "wrapOk(Sentry.startInactiveSpan);",
      "void preBound;",
      "void typed;",
    ].join("\n");
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, language, onError, create) =>
      fileName === probe ? ts.createSourceFile(fileName, source, language, true) : getSourceFile(fileName, language, onError, create);
    const fileExists = host.fileExists.bind(host);
    host.fileExists = (fileName) => fileName === probe || fileExists(fileName);
    const readFile = host.readFile.bind(host);
    host.readFile = (fileName) => (fileName === probe ? source : readFile(fileName));
    const program = ts.createProgram({ rootNames: [probe], options, host });
    const lines = scanProgram(program, (fileName) => fileName === probe).map((v) => v.line);
    expect([...new Set(lines)].sort((a, b) => a - b)).toEqual([5, 6, 7, 9, 11, 12, 18, 20, 21, 23, 25, 26, 27, 29, 31, 32, 33, 34, 35, 37, 43]);
  }, 180_000);

  it("packages/gateway/src passes no time to any Sentry or OpenTelemetry span API", () => {
    const parsed = parsedConfig();
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true } });
    const files = program.getSourceFiles().filter((f) => !f.isDeclarationFile && inGatewaySource(f.fileName));
    expect(files.length, "the scan found source files").toBeGreaterThan(50);
    const found: Found = { calls: 0, followed: 0 };
    const violations = scanProgram(program, inGatewaySource, found);
    // The gateway calls these APIs in dozens of places, and hands Sentry's span API to the closed
    // schema's startDeclaredSpan six times (kernel 1, settlement 5): a scan that finds none is broken.
    expect(found.calls, "the scan found the gateway's API calls").toBeGreaterThan(30);
    expect(found.followed, "the scan followed Sentry's span API into startDeclaredSpan").toBe(6);
    if (violations.length > 0) {
      const report = violations.map((v) => `  ${v.file.replace(SRC_ROOT + "/", "")}:${v.line}: ${v.text}`).join("\n");
      throw new Error(`Found ${violations.length} time(s) passed to a Sentry or OpenTelemetry span API:\n${report}`);
    }
    expect(violations).toEqual([]);
  }, 180_000);
});
