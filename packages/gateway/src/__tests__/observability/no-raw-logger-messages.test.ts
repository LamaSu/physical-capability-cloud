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
 *
 * N107c (tests pack, #538 round 3): that scanner checked only the second argument when there were
 * two, read only a plain `msg` key, and found a call only through `<logger>.<level>(...)`. Now:
 *   - a log call is any call whose resolved signature is pino's LogFn or the gateway's
 *     DeclaredLogFn, however its function was reached: a property, an element access
 *     (`log["error"]`), an alias, a destructured or a bound method;
 *   - the message is where pino reads it: the first argument unless that is a merging object (an
 *     object type), else the second. It must be declared (lit); a format argument after a declared
 *     message is closed at run time. A spread argument cannot be read and is refused;
 *   - a merging object's `msg` field is read from its TYPE, so a computed key whose value is a
 *     string literal or a constant counts, and a computed key the type cannot name (an index
 *     signature) is refused;
 *   - a child logger's bindings must be an object literal the scan can read: literal keys (or
 *     computed ones that resolve to a literal), no spread, no key named like an Object.prototype
 *     member (pino runs that member as the binding's serializer); its options take no msgPrefix.
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

/** A declared value by its type: the closed schema's Declared (what lit and declare return). */
function isDeclaredType(type: ts.Type): boolean {
  const symbol = type.getSymbol() ?? type.aliasSymbol;
  return symbol?.getName() === "Declared" && (symbol.declarations ?? []).some((d) => d.getSourceFile().fileName.endsWith("closed-schema.ts"));
}

const NOT_OBJECT =
  ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike |
  ts.TypeFlags.BooleanLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never;

/** pino's merging object: an argument whose type is an object type (every member of a union one). */
function isMergingObjectType(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.every(isMergingObjectType);
  return (type.flags & NOT_OBJECT) === 0;
}

const LOG_FN_INTERFACES: ReadonlySet<string> = new Set(["LogFn", "DeclaredLogFn"]);

/** The interface and file that declare the signature a call resolves to. */
function resolvedDeclaration(call: ts.CallExpression, checker: ts.TypeChecker): ts.Declaration | undefined {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  return declaration && !ts.isJSDocSignature(declaration) ? declaration : undefined;
}

/** A log call: its resolved signature is pino's LogFn or the gateway's DeclaredLogFn, or it is `<logger>.<level>(...)`. */
function isLogCall(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const declaration = resolvedDeclaration(call, checker);
  if (declaration && ts.isCallSignatureDeclaration(declaration) && ts.isInterfaceDeclaration(declaration.parent) && LOG_FN_INTERFACES.has(declaration.parent.name.text)) {
    const file = declaration.getSourceFile().fileName;
    if (/[/\\]pino[/\\]/.test(file) || file.endsWith("closed-sinks.ts")) return true;
  }
  const callee = call.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text : undefined;
  return !!name && LOG_METHODS.includes(name) && isLoggerType(checker.getTypeAtLocation((callee as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression), checker);
}

/** A child-logger call: `<logger>.child(...)`, or a call that resolves to pino's or Fastify's child method. */
function isChildCall(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const callee = call.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text : undefined;
  if (name === "child" && isLoggerType(checker.getTypeAtLocation((callee as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression), checker)) return true;
  const declaration = resolvedDeclaration(call, checker);
  if (declaration && (ts.isMethodSignature(declaration) || ts.isMethodDeclaration(declaration)) && declaration.name.getText() === "child") {
    return /[/\\](pino|fastify)[/\\]/.test(declaration.getSourceFile().fileName);
  }
  return false;
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

const PROTOTYPE_NAMES: ReadonlySet<string> = new Set(Object.getOwnPropertyNames(Object.prototype));

/** How many log and child-logger calls a scan found (so an empty scan cannot pass). */
interface Found {
  logCalls: number;
  childCalls: number;
}

function scanProgram(program: ts.Program, include: (fileName: string) => boolean, found: Found = { logCalls: 0, childCalls: 0 }): Violation[] {
  const checker = program.getTypeChecker();
  const violations: Violation[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || !include(sourceFile.fileName)) continue;
    const report = (node: ts.Node, why: string) => {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push({ file: sourceFile.fileName, line: line + 1, text: why });
    };
    const checkLogCall = (call: ts.CallExpression) => {
      const args = call.arguments;
      const spread = args.find(ts.isSpreadElement);
      if (spread) return report(spread, "log(...spread): arguments the scan cannot read");
      const [first, second] = args;
      if (!first) return;
      const firstType = checker.getTypeAtLocation(first);
      // A declared message first: the arguments after it are its format arguments, closed at run time.
      if (isDeclaredType(firstType)) return;
      if (!isMergingObjectType(firstType)) return report(first, "log(<raw>, ...): the message must be lit(...)");
      // A merging object first: its msg field, then the message after it.
      const msg = checker.getPropertyOfType(checker.getApparentType(firstType), "msg");
      if (msg) {
        if (!isDeclaredType(checker.getTypeOfSymbolAtLocation(msg, first))) report(first, "log({ msg: <raw> }, ...): msg must be lit(...)");
      } else if (checker.getIndexTypeOfType(checker.getApparentType(firstType), ts.IndexKind.String)) {
        report(first, "log({ [<key>]: ... }, ...): a merging object whose keys the scan cannot name may carry msg");
      }
      if (second && !isDeclaredType(checker.getTypeAtLocation(second))) report(second, "log(obj, <raw>, ...): the message must be lit(...)");
    };
    const checkChildCall = (call: ts.CallExpression) => {
      const [bindings, options] = call.arguments;
      if (bindings === undefined) return;
      if (!ts.isObjectLiteralExpression(bindings)) return report(bindings, "child(<bindings>): bindings the scan cannot read");
      for (const property of bindings.properties) {
        if (ts.isSpreadAssignment(property)) {
          report(property, "child({ ...spread }): bindings the scan cannot read");
          continue;
        }
        const key = property.name === undefined ? undefined : propertyKey(property.name, checker);
        if (key === undefined) report(property, "child({ [<key>]: ... }): a binding key the scan cannot read");
        else if (PROTOTYPE_NAMES.has(key)) report(property, `child({ ${key} }): pino runs an Object.prototype member as the binding's serializer`);
      }
      if (options !== undefined) {
        if (!ts.isObjectLiteralExpression(options)) report(options, "child(bindings, <options>): options the scan cannot read");
        else if (options.properties.some((property) => ts.isSpreadAssignment(property) || (property.name !== undefined && propertyKey(property.name, checker) === "msgPrefix"))) {
          report(options, "child(bindings, { msgPrefix }): a message prefix is a message no producer declared");
        }
      }
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (isLogCall(node, checker)) {
          found.logCalls += 1;
          checkLogCall(node);
        } else if (isChildCall(node, checker)) {
          found.childCalls += 1;
          checkChildCall(node);
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
      // N107c (tests pack r3, question 2): the forms the first scanner let through.
      "app.log.info(raw, 1);", // line 15: a raw message with a non-raw second argument
      'app.log.info({ ["msg"]: raw });', // line 16: a computed msg key
      'app.log.info({ "msg": raw });', // line 17: a string-literal msg key
      'const msgKey = "msg";',
      "app.log.info({ [msgKey]: raw });", // line 19: a computed key from a constant
      "const { info } = app.log;",
      "info(raw);", // line 21: a destructured level method
      "const warnFn = app.log.warn;",
      "warnFn(raw);", // line 23: an aliased level method
      'app.log["error"](raw);', // line 24: an element-access call
      "const bound = app.log.info.bind(app.log);",
      "bound(raw);", // line 26: a bound level method
      'app.log.info(lit("declared %s"), raw);', // a format argument after a declared message: closed at run time
      "const bindings: Record<string, unknown> = {};",
      'app.log.child(bindings).info(lit("x"));', // line 29: bindings the scan cannot read
      'app.log.child({ ...bindings }).info(lit("x"));', // line 30: a spread binding
      'app.log.child({ ["__proto__"]: 1 }).info(lit("x"));', // line 31: a prototype-named binding key
      'app.log.child({ ok: 1, "two": 2 }).info(lit("x"));',
      "const fields: Record<string, unknown> = {};",
      "app.log.info(fields);", // line 34: a merging object whose keys the scan cannot name (it may carry msg)
      "app.log.info(...[raw]);", // line 35: a spread argument
      'app.log.child({}, { msgPrefix: raw }).info(lit("x"));', // line 36: a message prefix
      'app.log.child({}, { level: "info" }).info(lit("x"));',
      'app.log.warn({ k: 1 });',
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
    expect(lines).toEqual([5, 7, 8, 9, 10, 15, 16, 17, 19, 21, 23, 24, 26, 29, 30, 31, 34, 35, 36]);
  }, 180_000);

  it("every Fastify/pino logger call in packages/gateway/src uses lit() for its message", () => {
    const program = ts.createProgram({ rootNames: rootNames(), options: compilerOptions() });
    const files = program.getSourceFiles().filter((f) => !f.isDeclarationFile && inGatewaySource(f.fileName));
    expect(files.length, "the scan found source files").toBeGreaterThan(50);
    const found: Found = { logCalls: 0, childCalls: 0 };
    const violations = scanProgram(program, inGatewaySource, found);
    // The gateway makes about a hundred log calls and no child logger: a scan that finds none is broken.
    expect(found.logCalls, "the scan found the gateway's log calls").toBeGreaterThan(80);
    if (violations.length > 0) {
      const report = violations.map((v) => `  ${v.file.replace(SRC_ROOT + "/", "")}:${v.line}: ${v.text}`).join("\n");
      throw new Error(`Found ${violations.length} raw logger message(s) outside lit():\n${report}`);
    }
    expect(violations).toEqual([]);
  }, 180_000);
});
