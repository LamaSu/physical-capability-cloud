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

/** The file that declares the function a call runs (through an import alias, if any). */
function declaringFile(call: ts.CallExpression, checker: ts.TypeChecker): string | undefined {
  const callee = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
  let symbol = checker.getSymbolAtLocation(callee);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.declarations?.[0]?.getSourceFile().fileName;
}

const isTelemetryApi = (file: string | undefined) => !!file && /[/\\](@sentry|@opentelemetry)[/\\]/.test(file);

function calleeName(call: ts.CallExpression): string | undefined {
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  return undefined;
}

function scanProgram(program: ts.Program, include: (fileName: string) => boolean): Violation[] {
  const checker = program.getTypeChecker();
  const violations: Violation[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || !include(sourceFile.fileName)) continue;
    const report = (node: ts.Node, why: string) => {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push({ file: sourceFile.fileName, line: line + 1, text: why });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isTelemetryApi(declaringFile(node, checker))) {
        const name = calleeName(node) ?? "<call>";
        if (FORBIDDEN_CALLS.has(name)) report(node, `${name}(): an event's type and times would be the caller's`);
        if (NO_ARGUMENT_METHODS.has(name) && node.arguments.length > 0) report(node, `${name}(<time>): a span's times are the SDK's clock`);
        for (const argument of node.arguments) {
          if (ts.isObjectLiteralExpression(argument)) {
            for (const property of argument.properties) {
              if (ts.isSpreadAssignment(property)) report(property, `${name}({ ...spread }): an option the ratchet cannot read`);
              else if (property.name && ts.isIdentifier(property.name) && TIME_KEYS.has(property.name.text)) report(property, `${name}({ ${property.name.text} }): a time option`);
              else if (property.name && ts.isStringLiteral(property.name) && TIME_KEYS.has(property.name.text)) report(property, `${name}({ "${property.name.text}" }): a time option`);
            }
          } else if (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument)) {
            const type = checker.getTypeAtLocation(argument);
            if (!(type.flags & ts.TypeFlags.StringLike) && [...TIME_KEYS].some((key) => checker.getApparentType(type).getProperty(key) !== undefined)) {
              report(argument, `${name}(<options with a time key>): pass an object literal without a time option`);
            }
          }
        }
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
    expect([...new Set(lines)].sort((a, b) => a - b)).toEqual([5, 6, 7, 9, 11, 12]);
  }, 180_000);

  it("packages/gateway/src passes no time to any Sentry or OpenTelemetry span API", () => {
    const parsed = parsedConfig();
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true } });
    const files = program.getSourceFiles().filter((f) => !f.isDeclarationFile && inGatewaySource(f.fileName));
    expect(files.length, "the scan found source files").toBeGreaterThan(50);
    const violations = scanProgram(program, inGatewaySource);
    if (violations.length > 0) {
      const report = violations.map((v) => `  ${v.file.replace(SRC_ROOT + "/", "")}:${v.line}: ${v.text}`).join("\n");
      throw new Error(`Found ${violations.length} time(s) passed to a Sentry or OpenTelemetry span API:\n${report}`);
    }
    expect(violations).toEqual([]);
  }, 180_000);
});
