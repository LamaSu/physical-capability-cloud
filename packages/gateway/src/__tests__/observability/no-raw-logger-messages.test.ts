/**
 * N107b codemod ratchet (the PR steward's strict ruling of 10/03): a Fastify or pino logger call
 * (app.log / req.log / request.log / reply.log / fastify.log / this.log / a bare `logger`/`log`
 * identifier) must never take a plain string literal or template literal as its message — every
 * message must be lit(), so the closed-schema chokepoint (closed-sinks.ts gatewayLoggerOptions)
 * can tell a producer-declared message from one it must hash. tsc cannot refuse a plain string
 * message (pino's own overloads accept one); this is the lint rule closed-schema.ts itself asks
 * for ("Notes for the codemod": "a lint rule ... would make the codemod's result stick").
 *
 * A static source scan (TypeScript's own parser) over packages/gateway/src, excluding
 * __tests__ — this file would otherwise need to exempt itself from itself.
 */
import { describe, it, expect } from "vitest";
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// packages/gateway/src/__tests__/observability -> packages/gateway/src
const SRC_ROOT = join(__dirname, "..", "..");

const LOG_METHODS = new Set(["info", "warn", "error", "debug", "fatal", "trace"]);
const SKIP_DIRS = new Set(["__tests__", "node_modules", "dist"]);

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      listSourceFiles(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The receiver just before `.info(`/`.warn(`/etc. Only the `<expr>.log` property-access shape
 * (req.log, request.log, reply.log, app.log, fastify.log, this.log, a child logger off one of
 * those, ...) is a REAL Fastify/pino logger — that property is Fastify's own decorator, and
 * every instance of it in this codebase is the real thing.
 *
 * A BARE `logger` or `log` identifier is deliberately NOT matched here: every such site in this
 * codebase (services/*-sweeper.ts, services/settlement-keeper.ts, routes/admin-demand.ts,
 * routes/tool-search.ts's internal buildIndex/getIndex, routes/telemetry.ts's structured-logger)
 * is a bespoke `{info, warn}`-shaped parameter or a non-Fastify logger, not a FastifyBaseLogger —
 * closing it here would be a false positive. Each is either timer-driven (never reachable from a
 * request) or, where it is request-reachable, already wrapped at the call site that constructs it
 * (e.g. server.ts's `{ info: (m) => app.log.info({ note: declare.id(m) }, lit(...)) }` shims) —
 * the REAL Fastify call those shims make is itself a `<expr>.log.info(...)` site this scan does
 * cover.
 */
function isLoggerReceiver(expr: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(expr) && expr.name.text === "log";
}

/** A bare string/template literal — exactly what lit() exists to replace. */
function isBareStringArg(node: ts.Expression): boolean {
  return (
    ts.isStringLiteralLike(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateExpression(node)
  );
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

function scanFile(file: string, sourceText: string): Violation[] {
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: Violation[] = [];

  const report = (node: ts.Node, why: string) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({ file, line: line + 1, text: why });
  };

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && LOG_METHODS.has(callee.name.text) && isLoggerReceiver(callee.expression)) {
        const args = node.arguments;
        if (args.length > 0) {
          const first = args[0]!;
          if (isBareStringArg(first)) {
            // log.X("plain message", ...)
            report(first, `log.${callee.name.text}(<literal>, ...) — message must be lit(...)`);
          } else if (ts.isObjectLiteralExpression(first)) {
            // log.X({ msg: "plain message", ... }) — the Fastify single-object-with-msg-key form.
            for (const prop of first.properties) {
              if (
                ts.isPropertyAssignment(prop) &&
                ts.isIdentifier(prop.name) &&
                prop.name.text === "msg" &&
                isBareStringArg(prop.initializer)
              ) {
                report(prop.initializer, `log.${callee.name.text}({ msg: <literal>, ... }) — msg must be lit(...)`);
              }
            }
            // log.X({...}, "plain message", ...) — the (obj, msg) form.
            if (args.length > 1 && isBareStringArg(args[1]!)) {
              report(args[1]!, `log.${callee.name.text}(obj, <literal>, ...) — message must be lit(...)`);
            }
          } else if (args.length > 1 && isBareStringArg(args[1]!)) {
            // log.X(someNonObjectFirstArg, "plain message", ...) — e.g. log.X(err, "message").
            report(args[1]!, `log.${callee.name.text}(firstArg, <literal>, ...) — message must be lit(...)`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return violations;
}

describe("N107b ratchet: no raw logger message escapes lit()", () => {
  it("every Fastify/pino logger call in packages/gateway/src uses lit() for its message", () => {
    const files = listSourceFiles(SRC_ROOT);
    expect(files.length, "the scan found source files").toBeGreaterThan(50);

    const violations = files.flatMap((file) => scanFile(file, readFileSync(file, "utf8")));

    if (violations.length > 0) {
      const report = violations
        .map((v) => `  ${v.file.replace(SRC_ROOT + "/", "")}:${v.line} — ${v.text}`)
        .join("\n");
      throw new Error(`Found ${violations.length} raw logger message(s) outside lit():\n${report}`);
    }
    expect(violations).toEqual([]);
  });
});
