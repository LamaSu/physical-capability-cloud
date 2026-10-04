/**
 * N107b codemod ratchet (the PR steward's strict ruling of 10/03): a Fastify or pino logger call
 * must never take a raw string as its message. Every message must be lit(), so the closed-schema
 * chokepoint (closed-sinks.ts gatewayLoggerOptions) can tell a producer-declared message from one
 * it must hash. The chokepoint still hashes a raw message at run time; this keeps the codemod's
 * result from eroding.
 *
 * Round 2 of #538 (codemod pack, MEDIUM): the first ratchet matched only the `<expr>.log` receiver
 * and literal arguments, so `app.log.child({}).info("raw")`, an aliased logger, or a string
 * variable passed. This one uses TypeScript's type checker over packages/gateway's own program:
 *   - a logger is any receiver whose TYPE is a logger (it has child, level and the level methods),
 *     whatever expression or alias produced it; a bespoke `{ info, warn }` shim is not one;
 *   - a message is raw when its TYPE is a string, any or unknown, whatever expression produced it.
 * A probe file compiled in the same way pins that the check catches each of those forms.
 */
import { describe, it, expect } from "vitest";
import ts from "typescript";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// packages/gateway/src/__tests__/observability -> packages/gateway/src
const SRC_ROOT = join(__dirname, "..", "..");
const TSCONFIG = join(SRC_ROOT, "..", "tsconfig.json");
const LOG_METHODS = ["info", "warn", "error", "debug", "fatal", "trace"];

interface Violation {
  file: string;
  line: number;
  text: string;
}

function compilerOptions(): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(TSCONFIG, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    },
  });
  if (!parsed) throw new Error(`cannot read ${TSCONFIG}`);
  return { ...parsed.options, noEmit: true };
}

function rootNames(): string[] {
  const parsed = ts.getParsedCommandLineOfConfigFile(TSCONFIG, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined })!;
  return parsed.fileNames;
}

/** A logger by its type: something with child(), a level and every level method. */
function isLoggerType(type: ts.Type, checker: ts.TypeChecker): boolean {
  const apparent = checker.getApparentType(type);
  const has = (name: string) => apparent.getProperty(name) !== undefined;
  return has("child") && has("level") && LOG_METHODS.every(has);
}

/** A raw message by its type: a string (or a union holding one), any or unknown. */
function isRawMessageType(type: ts.Type): boolean {
  if (type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
  return type.isUnion() && type.types.some((t) => (t.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0);
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
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && LOG_METHODS.includes(node.expression.name.text)) {
        const receiver = node.expression.expression;
        if (isLoggerType(checker.getTypeAtLocation(receiver), checker)) {
          const level = node.expression.name.text;
          const [first, second] = node.arguments;
          if (first && ts.isObjectLiteralExpression(first)) {
            for (const prop of first.properties) {
              if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "msg" && isRawMessageType(checker.getTypeAtLocation(prop.initializer))) {
                report(prop.initializer, `log.${level}({ msg: <raw>, ... }): msg must be lit(...)`);
              }
            }
          }
          if (second) {
            if (isRawMessageType(checker.getTypeAtLocation(second))) report(second, `log.${level}(obj, <raw>, ...): the message must be lit(...)`);
          } else if (first && isRawMessageType(checker.getTypeAtLocation(first))) {
            report(first, `log.${level}(<raw>): the message must be lit(...)`);
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

describe("N107b ratchet: no raw logger message escapes lit()", () => {
  it("the type-based check catches a child logger, an alias and a string variable (probe)", () => {
    const options = compilerOptions();
    const probe = join(SRC_ROOT, "__ratchet_probe__.ts");
    const source = [
      'import Fastify from "fastify";',
      'import { lit } from "./observability/closed-schema.js";',
      "const app = Fastify();",
      'const raw: string = "raw marker";',
      'app.log.child({}).info("raw marker");', // line 5: a child logger
      "const alias = app.log;",
      'alias.warn("raw marker");', // line 7: an aliased logger
      "app.log.info(raw);", // line 8: a string variable
      "app.log.error({ a: 1 }, raw);", // line 9: (obj, raw)
      "app.log.info({ msg: raw });", // line 10: a raw msg field
      'app.log.info(lit("declared"));',
      'app.log.info({ a: 1 }, lit("declared"));',
      'const shim = { info: (m: string) => m, warn: (m: string) => m };',
      'shim.info("a bespoke shim is not a logger");',
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
    expect(lines).toEqual([5, 7, 8, 9, 10]);
  }, 180_000);

  it("every Fastify/pino logger call in packages/gateway/src uses lit() for its message", () => {
    const program = ts.createProgram({ rootNames: rootNames(), options: compilerOptions() });
    const files = program.getSourceFiles().filter((f) => !f.isDeclarationFile && inGatewaySource(f.fileName));
    expect(files.length, "the scan found source files").toBeGreaterThan(50);
    const violations = scanProgram(program, inGatewaySource);
    if (violations.length > 0) {
      const report = violations.map((v) => `  ${v.file.replace(SRC_ROOT + "/", "")}:${v.line}: ${v.text}`).join("\n");
      throw new Error(`Found ${violations.length} raw logger message(s) outside lit():\n${report}`);
    }
    expect(violations).toEqual([]);
  }, 180_000);
});
