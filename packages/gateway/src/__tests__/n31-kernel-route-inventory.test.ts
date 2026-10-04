/**
 * Board N31, #575 r2: the route inventory the steward asked for (#6493 (2), #6508 (1)). It reads
 * every production source file under packages/gateway/src with the TypeScript parser and checks:
 *
 *   A. Every write (insert, update or delete) of operator_policies or pending_approvals sits
 *      inside a route handler that calls the ONE kernel-ownership guard (auth/kernel-authority.ts).
 *      No such write exists outside a route.
 *   B. Every mutating route (POST, PUT, PATCH, DELETE, ALL) whose path names a :kernelId is
 *      guarded: its handler calls the guard (refuseKernelAction, or a same-file helper that does),
 *      a preHandler of its own does, or its plugin installs a preHandler hook that does before its
 *      first route. The rest must be EXACTLY the KNOWN_UNGUARDED list below (no more, no fewer), or
 *      one closed classification with an executable witness. A new unguarded kernel route fails
 *      CI; guarding one fails CI until it leaves the list.
 *
 * #575 r2 item 4 (astra, MEDIUM; the steward's #6658): the inventory proved that a guard was
 * CALLED, not that its answer was used, and some route and table forms escaped it. Now:
 *   - A guard call counts only when its result is consumed: returned, or tested by an `if` with a
 *     branch that returns or throws, directly or through the const it initializes. A preHandler
 *     counts only when that branch also sends a reply or throws: a hook that returns without
 *     sending lets the request through. astra's probe, a named hook that ignores the refusal in
 *     front of a write, is pinned as unguarded.
 *   - A route registration the scan cannot read fails CI: app.route({...}), or a mutating route on
 *     any receiver but `app` (every production route uses `app`). A computed path is resolved
 *     through the file's string constants. One that cannot be resolved must be EXACTLY one entry of
 *     COMPUTED_PATHS, which says why it is not a kernel route. If its handler reads
 *     req.params.kernelId, it is a kernel route anyway and must be guarded.
 *   - A guarded table reached by another name fails CI: a renamed import or destructuring, a const
 *     bound to it, the bare table passed to anything but insert, update, delete or from, or a raw
 *     SQL write naming it.
 *
 * A probe source pins that the scanner sees each form it must (A and B, guarded and not).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/gateway/src/__tests__ -> packages/gateway/src
const SRC_ROOT = path.join(__dirname, "..");
const MUTATING = new Set(["post", "put", "patch", "delete", "all"]);
/** The Fastify instance's name in every production route plugin. A route on another receiver fails CI. */
const ROUTE_RECEIVER = "app";
/**
 * The guards: auth/kernel-authority.ts's refuseKernelAction and refuseKernelRequest. A function
 * counts as a guard when it consumes one (the same-file helper rule below), and a preHandler counts
 * when it consumes one and sends the refusal, by name or inline. N31b (N126) moved master's #400
 * relayAccessGuard onto the kernel-authority tiers, so it counts through that rule, not by name (the
 * gateway owner's #6568 (c)).
 */
const GUARD_NAMES = new Set(["refuseKernelAction", "refuseKernelRequest"]);
const GUARDED_TABLES = new Set(["operatorPolicies", "pendingApprovals"]);
const GUARDED_SQL_TABLES = /\b(operator_policies|pending_approvals)\b/i;
/** Calls that may take a guarded table itself as their first argument. */
const TABLE_CALLS = new Set(["insert", "update", "delete", "from"]);

/**
 * Kernel routes with no ownership check yet, found by this inventory (bus #6505). The device relay
 * is guarded on master by #400's relayAccessGuard (merged after #575 opened); N31b guards heartbeat
 * and capability announce and fixes the manifest verify's self-auth (now CLASSIFIED), so nothing
 * is left. Keys are "METHOD path".
 */
const KNOWN_UNGUARDED = new Set<string>([]);

/**
 * Kernel-path routes that do not act on a shop kernel's operator controls, each with its own
 * check and an executable witness below. A closed set: adding one needs a witness test here.
 */
const CLASSIFIED: Record<string, { category: "digital_manifest_admin_only" | "digital_manifest_admin_or_registrant"; cite: string }> = {
  "POST /api/kernels/:kernelId/suspend": {
    category: "digital_manifest_admin_only",
    cite: "routes/kernel-marketplace.ts:401",
  },
  // N31b: verify's self-verification is the principal that registered the manifest, no longer an
  // x-agent-id header any caller could send (kernel-marketplace.ts isAdminAuthorized).
  "POST /api/kernels/:kernelId/verify": {
    category: "digital_manifest_admin_or_registrant",
    cite: "routes/kernel-marketplace.ts:182",
  },
};

/**
 * Mutating routes whose path the scan cannot resolve to text, keyed "METHOD file:path expression".
 * None names a kernel: each handler is checked not to read req.params.kernelId.
 */
const COMPUTED_PATHS: Record<string, string> = {
  "POST mcp/http-mcp-server.ts:surface.mountPath": "the MCP transport's mount (/mcp, /mcp/apps); an MCP session, not a kernel",
  "DELETE mcp/http-mcp-server.ts:surface.mountPath": "ends an MCP session at the transport's mount; not a kernel",
  "POST middleware/security-monitor.ts:path": "a honeypot decoy path from a fixed list; it records the probe and answers 404",
  "POST routes/template-session.ts:`${prefix}/start`": "a template session under the plugin's routePrefix option; no kernel id",
  "POST routes/template-session.ts:`${prefix}/:id/scrape`": "a template session (:id is the session); no kernel id",
  "POST routes/template-session.ts:`${prefix}/:id/ingest-docs`": "a template session (:id is the session); no kernel id",
  "POST routes/template-session.ts:`${prefix}/:id/build-agent`": "a template session (:id is the session); no kernel id",
};

interface RouteSite {
  key: string;
  file: string;
  line: number;
  guarded: boolean;
  /** The path is an expression the scan could not resolve. */
  computed: boolean;
  /** The handler reads req.params.kernelId. */
  readsKernelParam: boolean;
}

interface Scan {
  routes: RouteSite[];
  /** Writes of the guarded tables: where, and the route that encloses them (null: none). */
  writes: Array<{ file: string; line: number; route: RouteSite | null }>;
  /** Route registrations the scan cannot read (app.route, another receiver). */
  unreadable: string[];
  /** A guarded table reached by another name (an alias, a value, raw SQL). */
  aliases: string[];
}

/** An expression with its parentheses, casts, non-null marks and awaits taken off. */
function unwrap(node: ts.Expression): ts.Expression {
  let e = node;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isAwaitExpression(e)) {
    e = e.expression;
  }
  return e;
}

/** Whether `test` matches a node in `root`, outside any function nested in it. */
function within(root: ts.Node, test: (n: ts.Node) => boolean): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found || (n !== root && ts.isFunctionLike(n))) return;
    if (test(n)) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(root);
  return found;
}

const isSendCall = (n: ts.Node) => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "send";
/** Calls that write: a refused path containing one does not stop before the write. */
const WRITE_CALLS = new Set(["insert", "update", "delete", "run", "exec", "values", "set"]);
/**
 * Named SECOND authorizations (#579 r1 item 6): a refusal ANDed with the negation of a call to one
 * of these (`refusal && !isProvenHolderOfNamedScope(...)`) is still a refusal unless that named
 * authorization admits the caller. ANDed with anything else, the refusal is no longer certain.
 */
const ADMISSIONS = new Set(["isProvenHolderOfNamedScope", "isProvenGrant"]);

/** What a value is when the request must be refused: truthy (a refusal), falsy (an allowed-check), or unknown. */
type Refused = "truthy" | "falsy" | "unknown";
const flipRefused = (s: Refused): Refused => (s === "truthy" ? "falsy" : s === "falsy" ? "truthy" : "unknown");

const unwrapNode = (n: ts.Node): ts.Node => (ts.isExpression(n) ? unwrap(n) : n);
const callsAdmission = (n: ts.Node): boolean =>
  ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ADMISSIONS.has(n.expression.text)
    ? true
    : (ts.forEachChild(n, (c) => (callsAdmission(c) ? true : undefined)) ?? false);

/** `x == null`, `x === undefined` and the like: "eq" flips the refusal, "ne" keeps it; null when not a nullish comparison. */
function nullCompare(b: ts.BinaryExpression, from: ts.Node): "eq" | "ne" | null {
  const other = unwrapNode(b.left === from ? b.right : b.left);
  const nullish = other.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(other) && other.text === "undefined");
  if (!nullish) return null;
  const k = b.operatorToken.kind;
  if (k === ts.SyntaxKind.EqualsEqualsToken || k === ts.SyntaxKind.EqualsEqualsEqualsToken) return "eq";
  if (k === ts.SyntaxKind.ExclamationEqualsToken || k === ts.SyntaxKind.ExclamationEqualsEqualsToken) return "ne";
  return null;
}

/**
 * Follow a value carrying a refusal (`given`: what it is when the request must be refused) up
 * through the expressions that pass it on, to the node that consumes it. `!` flips it; `||` and
 * `??` keep a truthy refusal; `&&` keeps a falsy one, and keeps a truthy one only when its other
 * side is a negated named admission (ADMISSIONS); a nullish equality flips it. Anything else (a
 * field of the refusal, another comparison) makes it unknown.
 */
function follow(expr: ts.Node, given: Refused): { into: ts.Node | undefined; from: ts.Node; state: Refused } {
  let n = expr;
  let state = given;
  for (;;) {
    const p = n.parent;
    if (!p) return { into: undefined, from: n, state };
    if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isTypeAssertionExpression(p) || ts.isSatisfiesExpression(p) || ts.isNonNullExpression(p) || ts.isAwaitExpression(p)) {
      n = p;
      continue;
    }
    if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) {
      state = flipRefused(state);
      n = p;
      continue;
    }
    if (ts.isBinaryExpression(p)) {
      const k = p.operatorToken.kind;
      const other = unwrapNode(p.left === n ? p.right : p.left);
      if (k === ts.SyntaxKind.BarBarToken) state = state === "truthy" ? "truthy" : "unknown";
      else if (k === ts.SyntaxKind.QuestionQuestionToken) state = state === "truthy" && p.left === n ? "truthy" : "unknown";
      else if (k === ts.SyntaxKind.AmpersandAmpersandToken) {
        const waiver = ts.isPrefixUnaryExpression(other) && other.operator === ts.SyntaxKind.ExclamationToken && callsAdmission(other);
        state = state === "falsy" ? "falsy" : state === "truthy" && waiver ? "truthy" : "unknown";
      } else {
        const nc = nullCompare(p, n);
        if (!nc) return { into: p, from: n, state: "unknown" };
        if (nc === "eq") state = flipRefused(state);
      }
      n = p;
      continue;
    }
    return { into: p, from: n, state };
  }
}

/**
 * The refused path stops: it ends in a return or throw, writes nothing, and, for a hook, every
 * return on it sends a reply (a hook that returns without sending lets the request through).
 */
function stopsOnRefusal(statements: readonly ts.Statement[], mustSend: boolean): boolean {
  const last = statements[statements.length - 1];
  if (!last || !(ts.isReturnStatement(last) || ts.isThrowStatement(last))) return false;
  let ok = true;
  const visit = (n: ts.Node): void => {
    if (!ok || ts.isFunctionLike(n)) return;
    if (mustSend && ts.isReturnStatement(n) && !(n.expression && within(n.expression, isSendCall))) ok = false;
    else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && WRITE_CALLS.has(n.expression.name.text)) ok = false;
    else ts.forEachChild(n, visit);
  };
  for (const s of statements) visit(s);
  return ok;
}

const branchStatements = (s: ts.Statement): readonly ts.Statement[] => (ts.isBlock(s) ? s.statements : [s]);

/**
 * Whether a value carrying a refusal decides the request: it is returned (from a helper), or it is
 * tested by an `if` whose REFUSED path stops, directly or through the const it initializes. The
 * refused path is the then-branch when the condition is truthy on refusal, else the else-branch,
 * or, with no else, the statements that follow the `if` in its block.
 */
function consumed(expr: ts.Node, given: Refused, mustSend: boolean, depth = 0): boolean {
  const { into, from, state } = follow(expr, given);
  if (!into || state === "unknown") return false;
  if (ts.isReturnStatement(into) || (ts.isArrowFunction(into) && into.body === from)) return !mustSend;
  if (ts.isIfStatement(into) && into.expression === from) {
    const refused = state === "truthy" ? into.thenStatement : into.elseStatement;
    if (refused) return stopsOnRefusal(branchStatements(refused), mustSend);
    const block = into.parent;
    if (!ts.isBlock(block) && !ts.isSourceFile(block)) return false;
    const rest = block.statements.slice(block.statements.indexOf(into as ts.Statement) + 1);
    return stopsOnRefusal(rest, mustSend);
  }
  if (ts.isVariableDeclaration(into) && into.initializer === from && ts.isIdentifier(into.name) && depth === 0) {
    const name = into.name.text;
    let scope: ts.Node | undefined = into.parent;
    while (scope && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
    let used = false;
    const visit = (n: ts.Node): void => {
      if (used) return;
      if (ts.isIdentifier(n) && n.text === name && n !== into.name && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && consumed(n, state, mustSend, depth + 1)) {
        used = true;
        return;
      }
      ts.forEachChild(n, visit);
    };
    if (scope) visit(scope);
    return used;
  }
  return false;
}

/** Whether `body` calls one of `guards` and consumes its result (each guard with what it returns on refusal). */
function consumesGuard(body: ts.Node, guards: Map<string, Refused>, mustSend: boolean): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && guards.has(n.expression.text) && consumed(n, guards.get(n.expression.text)!, mustSend)) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(body);
  return found;
}

/**
 * What a same-file helper returns on refusal, when it returns a guard's answer (refuseOperate
 * returns the refusal: truthy; isRelayOperator returns `refusal === null`: falsy); null when it does
 * not, or when its returns disagree.
 */
function helperPolarity(fn: ts.FunctionLikeDeclaration, guards: Map<string, Refused>): Refused | null {
  const found = new Set<Refused>();
  const visit = (n: ts.Node): void => {
    if (n !== fn && ts.isFunctionLike(n)) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && guards.has(n.expression.text)) {
      const { into, from, state } = follow(n, guards.get(n.expression.text)!);
      const returned = into !== undefined && (ts.isReturnStatement(into) || (ts.isArrowFunction(into) && into === fn && into.body === from));
      if (returned && state !== "unknown") found.add(state);
    }
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return found.size === 1 ? [...found][0]! : null;
}

/** The text a route path expression resolves to through the file's string constants, if any. */
function resolvePath(expr: ts.Expression, consts: Map<string, ts.Expression>, seen = new Set<string>()): string | undefined {
  const e = unwrap(expr);
  if (ts.isStringLiteralLike(e)) return e.text;
  if (ts.isIdentifier(e)) {
    const init = consts.get(e.text);
    if (!init || seen.has(e.text)) return undefined;
    return resolvePath(init, consts, new Set([...seen, e.text]));
  }
  if (ts.isTemplateExpression(e)) {
    let text = e.head.text;
    for (const span of e.templateSpans) {
      const part = resolvePath(span.expression, consts, seen);
      if (part === undefined) return undefined;
      text += part + span.literal.text;
    }
    return text;
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolvePath(e.left, consts, seen);
    const right = resolvePath(e.right, consts, seen);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

/** Whether a handler reads req.params.kernelId (a property, an element, or a destructured binding). */
function readsKernelParam(handler: ts.Node): boolean {
  const isParams = (e: ts.Expression) => {
    const u = unwrap(e);
    return ts.isPropertyAccessExpression(u) && u.name.text === "params";
  };
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(n) && n.name.text === "kernelId" && isParams(n.expression)) found = true;
    else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === "kernelId" && isParams(n.expression)) found = true;
    else if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer && isParams(n.initializer) &&
      n.name.elements.some((el) => (el.propertyName ?? el.name).getText() === "kernelId")) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(handler);
  return found;
}

/** The name a table reference uses: an identifier, `x.table`, or `x["table"]`. */
function tableName(e: ts.Expression): string | null {
  const u = unwrap(e);
  if (ts.isIdentifier(u)) return u.text;
  if (ts.isPropertyAccessExpression(u)) return u.name.text;
  if (ts.isElementAccessExpression(u) && ts.isStringLiteralLike(u.argumentExpression)) return u.argumentExpression.text;
  return null;
}

function scanSource(fileName: string, text: string): Scan {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  // The file's functions by name (declarations, and consts bound to a function), and its string-ish consts.
  const functions = new Map<string, ts.FunctionLikeDeclaration>();
  const consts = new Map<string, ts.Expression>();
  const collect = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) functions.set(n.name.text, n);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = unwrap(n.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) functions.set(n.name.text, init);
      else if (ts.isVariableDeclarationList(n.parent) && (n.parent.flags & ts.NodeFlags.Const) !== 0) consts.set(n.name.text, n.initializer);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);

  // Same-file helpers that consume a guard are guards (e.g. kernels.ts refuseOperate); helpers that
  // also send its refusal may stand as a preHandler.
  const guards = new Map<string, Refused>([...GUARD_NAMES].map((name) => [name, "truthy" as Refused]));
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, fn] of functions) {
      if (guards.has(name) || !fn.body) continue;
      const polarity = helperPolarity(fn, guards);
      if (polarity !== null) {
        guards.set(name, polarity);
        grew = true;
      }
    }
  }
  const sendingGuards = new Set([...functions].filter(([, fn]) => fn.body && consumesGuard(fn.body, guards, true)).map(([name]) => name));
  const isHookGuard = (hook: ts.Expression): boolean => {
    const h = unwrap(hook);
    if (ts.isIdentifier(h)) return sendingGuards.has(h.text);
    if (ts.isArrowFunction(h) || ts.isFunctionExpression(h)) return consumesGuard(h, guards, true);
    if (ts.isArrayLiteralExpression(h)) return h.elements.some((el) => isHookGuard(el));
    return false;
  };

  // A plugin function whose preHandler hook guards (and sends) guards the routes registered after it.
  const hookStarts = new Map<ts.Node, number>();
  const findHooks = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "addHook" &&
      n.arguments.length >= 2 &&
      ts.isStringLiteralLike(n.arguments[0]!) &&
      n.arguments[0]!.text === "preHandler" &&
      isHookGuard(n.arguments[1]!)
    ) {
      let fn: ts.Node | undefined = n.parent;
      while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
      if (fn && !hookStarts.has(fn)) hookStarts.set(fn, n.getStart(sf));
    }
    ts.forEachChild(n, findHooks);
  };
  findHooks(sf);

  const handlerGuarded = (handler: ts.Expression): boolean => {
    const h = unwrap(handler);
    if (ts.isIdentifier(h)) {
      const fn = functions.get(h.text);
      return fn?.body !== undefined && consumesGuard(fn.body, guards, false);
    }
    return (ts.isArrowFunction(h) || ts.isFunctionExpression(h)) && consumesGuard(h, guards, false);
  };
  const ownPreHandlerGuarded = (options: ts.Expression | undefined): boolean => {
    const o = options === undefined ? undefined : unwrap(options);
    if (!o || !ts.isObjectLiteralExpression(o)) return false;
    return o.properties.some((p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === "preHandler" && isHookGuard(p.initializer));
  };
  const handlerNode = (handler: ts.Expression): ts.Node => {
    const h = unwrap(handler);
    return ts.isIdentifier(h) ? (functions.get(h.text) ?? h) : h;
  };

  const routes: RouteSite[] = [];
  const unreadable: string[] = [];
  const routeOf = new Map<ts.Node, RouteSite>();
  const findRoutes = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text;
      const receiver = n.expression.expression;
      const last = n.arguments[n.arguments.length - 1];
      const first = n.arguments[0];
      const isApp = ts.isIdentifier(receiver) && receiver.text === ROUTE_RECEIVER;
      if (method === "route" && first && (isApp || ts.isObjectLiteralExpression(unwrap(first)))) {
        // #579 r1 item 6: app.route(opts) with a variable is as unreadable as an inline object.
        const shown = ts.isObjectLiteralExpression(unwrap(first)) ? "{...}" : first.getText(sf);
        unreadable.push(`${fileName}:${lineOf(n)} ${receiver.getText(sf)}.route(${shown})`);
      } else if (MUTATING.has(method) && n.arguments.length >= 2 && last) {
        if (!isApp) {
          // A route-shaped call on another receiver: an inline handler, a handler naming a same-file
          // function (#579 r1 item 6), or a first argument that is a path.
          const l = unwrap(last);
          const routeShaped =
            ts.isArrowFunction(l) || ts.isFunctionExpression(l) || (ts.isIdentifier(l) && functions.has(l.text)) ||
            (first !== undefined && ts.isStringLiteralLike(unwrap(first)) && (unwrap(first) as ts.StringLiteralLike).text.startsWith("/"));
          if (routeShaped) unreadable.push(`${fileName}:${lineOf(n)} ${receiver.getText(sf)}.${method}(...)`);
        } else {
          const resolved = resolvePath(first!, consts);
          let fn: ts.Node | undefined = n.parent;
          while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
          const hookAt = fn ? hookStarts.get(fn) : undefined;
          const site: RouteSite = {
            key: resolved === undefined ? `${method.toUpperCase()} ${fileName}:${first!.getText(sf)}` : `${method.toUpperCase()} ${resolved}`,
            file: fileName,
            line: lineOf(n),
            guarded:
              handlerGuarded(last) ||
              (n.arguments.length >= 3 && ownPreHandlerGuarded(n.arguments[1])) ||
              (hookAt !== undefined && hookAt < n.getStart(sf)),
            computed: resolved === undefined,
            readsKernelParam: readsKernelParam(handlerNode(last)),
          };
          routes.push(site);
          routeOf.set(n, site);
        }
      }
    }
    ts.forEachChild(n, findRoutes);
  };
  findRoutes(sf);

  const writes: Scan["writes"] = [];
  const aliases: string[] = [];
  const alias = (n: ts.Node, why: string) => aliases.push(`${fileName}:${lineOf(n)} ${why}`);
  const isTypePosition = (n: ts.Node) => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) if (ts.isTypeNode(p)) return true;
    return false;
  };
  const find = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ["insert", "update", "delete"].includes(n.expression.name.text) && n.arguments.length >= 1) {
      const name = tableName(n.arguments[0]!);
      if (name && GUARDED_TABLES.has(name)) {
        let route: RouteSite | null = null;
        for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
          const site = routeOf.get(p);
          if (site) {
            route = site;
            break;
          }
        }
        writes.push({ file: fileName, line: lineOf(n), route });
      }
    }
    // Another name for a guarded table: a renamed import or destructuring, or a const bound to it.
    if (ts.isImportSpecifier(n) && n.propertyName && GUARDED_TABLES.has(n.propertyName.text) && n.name.text !== n.propertyName.text) {
      alias(n, `import { ${n.propertyName.text} as ${n.name.text} }`);
    }
    if (ts.isBindingElement(n) && n.propertyName && GUARDED_TABLES.has(n.propertyName.getText(sf)) && n.name.getText(sf) !== n.propertyName.getText(sf)) {
      alias(n, `{ ${n.propertyName.getText(sf)}: ${n.name.getText(sf)} }`);
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && !GUARDED_TABLES.has(n.name.text)) {
      const name = tableName(n.initializer);
      if (name && GUARDED_TABLES.has(name)) alias(n, `const ${n.name.text} = <${name}>`);
    }
    // The bare table as a value anywhere but a column read or the first argument of a table call.
    if (ts.isIdentifier(n) && GUARDED_TABLES.has(n.text) && !isTypePosition(n)) {
      const p = n.parent;
      const declaring =
        (ts.isBindingElement(p) && (p.name === n || p.propertyName === n)) || ts.isImportSpecifier(p) ||
        (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) ||
        (ts.isVariableDeclaration(p) && p.name === n);
      const columnRead = ts.isPropertyAccessExpression(p) && p.expression === n;
      const tableArgument =
        ts.isCallExpression(p) && p.arguments[0] === n && ts.isPropertyAccessExpression(p.expression) && TABLE_CALLS.has(p.expression.name.text);
      const aliasDeclaration = ts.isVariableDeclaration(p) && p.initializer === n;
      if (!declaring && !columnRead && !tableArgument && !aliasDeclaration) alias(n, `${n.text} used as a value`);
    }
    // Raw SQL that writes a guarded table.
    if ((ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) && GUARDED_SQL_TABLES.test(n.getText(sf)) && /\b(insert|update|delete)\b/i.test(n.getText(sf))) {
      alias(n, "raw SQL writes a guarded table");
    }
    ts.forEachChild(n, find);
  };
  find(sf);
  return { routes, writes, unreadable, aliases };
}

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "node_modules") out.push(...productionFiles(p));
    } else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

function scanGateway(): Scan {
  const all: Scan = { routes: [], writes: [], unreadable: [], aliases: [] };
  for (const file of productionFiles(SRC_ROOT)) {
    const s = scanSource(path.relative(SRC_ROOT, file), fs.readFileSync(file, "utf8"));
    all.routes.push(...s.routes);
    all.writes.push(...s.writes);
    all.unreadable.push(...s.unreadable);
    all.aliases.push(...s.aliases);
  }
  return all;
}

/** A kernel route: its path names :kernelId, or its path is computed and its handler reads params.kernelId. */
const isKernelRoute = (r: RouteSite) => r.key.includes(":kernelId") || (r.computed && r.readsKernelParam);

describe("N31 route inventory: the scanner sees what it must (probe)", () => {
  const probe = scanSource(
    "probe.ts",
    [
      'import { refuseKernelAction } from "../auth/kernel-authority.js";',
      "function refuseHelper(req: any, k: string) { return refuseKernelAction(req, {} as any, k, 'operate'); }",
      "export async function plain(app: any) {",
      '  app.post("/api/probe/:kernelId/open", async (req: any) => { db.insert(operatorPolicies).values({}); });',
      '  app.put<{ Params: { kernelId: string } }>(\n    "/api/probe/:kernelId/direct",\n    async (req: any) => { if (refuseKernelAction(req, {} as any, "k", "decide")) return; db.update(schema.pendingApprovals).set({}); },\n  );',
      '  app.patch("/api/probe/:kernelId/helper", async (req: any) => { if (refuseHelper(req, "k")) return; });',
      "}",
      // line 11: astra's probe (#575 r2 item 4): a named hook that calls the guard and ignores its refusal.
      "async function namedGuard(req: any) { refuseKernelAction(req, {} as any, 'k', 'operate'); }",
      "export async function byName(app: any) {",
      '  app.addHook("preHandler", namedGuard);',
      '  app.post("/api/probe/:kernelId/named-hook", async () => { db.insert(operatorPolicies).values({}); });',
      "}",
      "export async function hooked(app: any) {",
      '  app.post("/api/probe/:kernelId/before-hook", async () => {});',
      '  app.addHook("preHandler", async (req: any, reply: any) => { const r = refuseKernelAction(req, {} as any, "k", "operate"); if (r) return reply.code(r.status).send(r.body); });',
      '  app.delete("/api/probe/:kernelId/after-hook", async () => {});',
      "}",
      "function loose() { db.delete(operatorPolicies); }",
      // line 22: a guard result that decides nothing, and one that does through a const.
      'async function sendingGuard(req: any, reply: any) { const r = refuseKernelAction(req, {} as any, "k", "operate"); if (r) return reply.code(r.status).send(r.body); }',
      'async function silentGuard(req: any) { if (refuseKernelAction(req, {} as any, "k", "operate")) return; }',
      "export async function consumption(app: any) {",
      '  app.post("/api/probe/:kernelId/ignored", async (req: any) => { refuseKernelAction(req, {} as any, "k", "decide"); db.insert(pendingApprovals).values({}); });',
      '  app.post("/api/probe/:kernelId/unread", async (req: any) => { const r = refuseKernelAction(req, {} as any, "k", "decide"); db.insert(pendingApprovals).values({}); });',
      '  app.post("/api/probe/:kernelId/no-stop", async (req: any) => { if (refuseKernelAction(req, {} as any, "k", "decide")) log("refused"); });',
      '  app.post("/api/probe/:kernelId/via-const", async (req: any, reply: any) => { const r = refuseKernelAction(req, {} as any, "k", "decide"); if (r) return reply.code(r.status).send(r.body); });',
      '  app.post("/api/probe/:kernelId/own-hook", { preHandler: [sendingGuard] }, async () => {});',
      '  app.post("/api/probe/:kernelId/own-hook-silent", { preHandler: silentGuard }, async () => {});',
      '  app.post("/api/probe/:kernelId/own-hook-returning", { preHandler: refuseHelper }, async () => {});',
      "}",
      // line 33: registrations the scan cannot read, and computed paths.
      "export async function forms(app: any, child: any) {",
      '  app.route({ method: "POST", url: "/api/probe/:kernelId/route-object", handler: async () => {} });',
      '  child.post("/api/probe/:kernelId/other-receiver", async () => {});',
      '  const BASE = "/api/probe";',
      "  app.post(`${BASE}/:kernelId/resolved`, async () => {});",
      '  app.post(opts.prefix + "/x", async (req: any) => { use(req.params.kernelId); });',
      "  app.post(dynamicPath, async () => {});",
      '  app.all("/api/probe/:kernelId/all", async () => {});',
      "}",
      // line 42: a guarded table by another name.
      'import { operatorPolicies as op } from "@pcc/store";',
      "const { pendingApprovals: pa } = schema;",
      "const t = schema.operatorPolicies;",
      "helper(operatorPolicies);",
      "db.run(sql`UPDATE operator_policies SET x = 1`);",
      'db.insert(schema["pendingApprovals"]).values({});',
      // line 48: #579 r1 item 6 (astra): a refusal on the wrong branch or ANDed away, unreadable registrations.
      "export async function compound(app: any, child: any) {",
      '  app.post("/api/probe/:kernelId/inverted", async (req: any) => { if (refuseKernelAction(req, {} as any, "k", "decide")) { db.insert(pendingApprovals).values({}); } else return; });',
      '  app.post("/api/probe/:kernelId/and-false", async (req: any) => { if (refuseKernelAction(req, {} as any, "k", "decide") && false) return; });',
      '  app.post("/api/probe/:kernelId/write-then-return", async (req: any) => { if (refuseKernelAction(req, {} as any, "k", "decide")) { db.insert(pendingApprovals).values({}); return; } });',
      '  app.post("/api/probe/:kernelId/negated", async (req: any, reply: any) => { const r = refuseKernelAction(req, {} as any, "k", "decide"); if (!r) return; return reply.code(r.status).send(r.body); });',
      '  app.post("/api/probe/:kernelId/waived", async (req: any, reply: any) => { const r = refuseKernelAction(req, {} as any, "k", "decide"); if (r && !isProvenHolderOfNamedScope(req, {} as any, "k")) return reply.code(r.status).send(r.body); });',
      '  app.post("/api/probe/:kernelId/waived-by-anything", async (req: any, reply: any) => { const r = refuseKernelAction(req, {} as any, "k", "decide"); if (r && !somethingElse()) return reply.code(r.status).send(r.body); });',
      '  const routeOpts = { method: "POST", url: "/api/probe/:kernelId/route-var", handler: async () => {} };',
      "  app.route(routeOpts);",
      "  async function namedHandler() {}",
      '  child.post("/api/probe/:kernelId/named-other", namedHandler);',
      // line 59: the allow-path returns early and the refused path WRITES; a named handler at a computed path.
      '  app.post("/api/probe/:kernelId/negated-to-write", async (req: any) => { if (!refuseKernelAction(req, {} as any, "k", "decide")) return; db.insert(pendingApprovals).values({}); });',
      "  child.put(otherPath, namedHandler);",
      "}",
    ].join("\n"),
  );
  const byKey = new Map(probe.routes.map((r) => [r.key, r.guarded]));

  it("tells guarded routes from unguarded ones, by handler, helper, own preHandler and plugin hook", () => {
    expect(Object.fromEntries(byKey)).toEqual({
      "POST /api/probe/:kernelId/open": false,
      "PUT /api/probe/:kernelId/direct": true,
      "PATCH /api/probe/:kernelId/helper": true,
      // #575 r2 item 4: the hook calls the guard but ignores the refusal, so nothing is guarded.
      "POST /api/probe/:kernelId/named-hook": false,
      "POST /api/probe/:kernelId/before-hook": false,
      "DELETE /api/probe/:kernelId/after-hook": true,
      "POST /api/probe/:kernelId/ignored": false,
      "POST /api/probe/:kernelId/unread": false,
      "POST /api/probe/:kernelId/no-stop": false,
      "POST /api/probe/:kernelId/via-const": true,
      "POST /api/probe/:kernelId/own-hook": true,
      // A preHandler that returns without sending (or returns the refusal unsent) lets the request through.
      "POST /api/probe/:kernelId/own-hook-silent": false,
      "POST /api/probe/:kernelId/own-hook-returning": false,
      "POST /api/probe/:kernelId/resolved": false,
      'POST probe.ts:opts.prefix + "/x"': false,
      "POST probe.ts:dynamicPath": false,
      "ALL /api/probe/:kernelId/all": false,
      // #579 r1 item 6: the refused branch must stop, and must not write; an AND keeps the refusal
      // only when its other side is a named second authorization (ADMISSIONS).
      "POST /api/probe/:kernelId/inverted": false,
      "POST /api/probe/:kernelId/and-false": false,
      "POST /api/probe/:kernelId/write-then-return": false,
      "POST /api/probe/:kernelId/negated": true,
      "POST /api/probe/:kernelId/waived": true,
      "POST /api/probe/:kernelId/waived-by-anything": false,
      "POST /api/probe/:kernelId/negated-to-write": false,
    });
  });

  it("finds every write of the guarded tables, with its enclosing route or none", () => {
    expect(probe.writes.map((w) => [w.line, w.route?.key ?? null, w.route?.guarded ?? null])).toEqual([
      [4, "POST /api/probe/:kernelId/open", false],
      [7, "PUT /api/probe/:kernelId/direct", true],
      [14, "POST /api/probe/:kernelId/named-hook", false],
      [21, null, null],
      [25, "POST /api/probe/:kernelId/ignored", false],
      [26, "POST /api/probe/:kernelId/unread", false],
      [47, null, null],
      [49, "POST /api/probe/:kernelId/inverted", false],
      [51, "POST /api/probe/:kernelId/write-then-return", false],
      [59, "POST /api/probe/:kernelId/negated-to-write", false],
    ]);
  });

  it("refuses the registrations it cannot read, and tells a computed kernel route by its params", () => {
    expect(probe.unreadable).toEqual([
      "probe.ts:34 app.route({...})",
      "probe.ts:35 child.post(...)",
      "probe.ts:56 app.route(routeOpts)",
      "probe.ts:58 child.post(...)",
      "probe.ts:60 child.put(...)",
    ]);
    const computed = probe.routes.filter((r) => r.computed).map((r) => [r.key, isKernelRoute(r)]);
    expect(computed).toEqual([
      ['POST probe.ts:opts.prefix + "/x"', true],
      ["POST probe.ts:dynamicPath", false],
    ]);
  });

  it("refuses a guarded table reached by another name", () => {
    expect(probe.aliases.map((a) => Number(a.split(":")[1]!.split(" ")[0]))).toEqual([42, 43, 44, 45, 46]);
  });
});

describe("N31 route inventory: packages/gateway/src", () => {
  const scan = scanGateway();

  it("found the gateway's routes (the scan is not empty)", () => {
    expect(scan.routes.length).toBeGreaterThan(300);
  });

  it("reads every route registration and every guarded-table reference", () => {
    expect(scan.unreadable).toEqual([]);
    expect(scan.aliases).toEqual([]);
  });

  it("A: every write of operator_policies or pending_approvals is inside a guarded route", () => {
    expect(scan.writes.length).toBeGreaterThanOrEqual(8);
    const bad = scan.writes
      .filter((w) => !w.route || !w.route.guarded)
      .map((w) => `${w.file}:${w.line} (${w.route ? w.route.key : "outside any route"})`);
    expect(bad).toEqual([]);
  });

  it("every computed route path is exactly one COMPUTED_PATHS entry, and none names a kernel", () => {
    const computed = scan.routes.filter((r) => r.computed);
    expect(computed.map((r) => r.key).sort()).toEqual(Object.keys(COMPUTED_PATHS).sort());
    expect(computed.filter((r) => r.readsKernelParam).map((r) => r.key)).toEqual([]);
  });

  it("B: every mutating kernel route is guarded, or exactly one of KNOWN_UNGUARDED or CLASSIFIED", () => {
    const kernelRoutes = scan.routes.filter(isKernelRoute);
    const unguarded = kernelRoutes.filter((r) => !r.guarded && !(r.key in CLASSIFIED)).map((r) => r.key).sort();
    expect(unguarded).toEqual([...KNOWN_UNGUARDED].sort());
    for (const key of Object.keys(CLASSIFIED)) {
      const site = kernelRoutes.find((r) => r.key === key);
      expect(site, `${key} is still a route`).toBeDefined();
      expect(site!.guarded, `${key} is guarded now: drop it from CLASSIFIED`).toBe(false);
    }
    expect(kernelRoutes.filter((r) => r.guarded).map((r) => r.key).sort()).toEqual([
      "PATCH /api/operator/policy/:kernelId",
      "POST /api/kernels/:kernelId/capabilities",
      "POST /api/kernels/:kernelId/heartbeat",
      "POST /api/relay/:kernelId/camera/frame",
      "POST /api/relay/:kernelId/chat",
      "POST /api/relay/:kernelId/chat/respond",
      "POST /api/relay/:kernelId/scope",
      "POST /api/relay/:kernelId/scope/:scopeId/revoke",
      "POST /api/relay/:kernelId/tool-call",
      "POST /api/relay/:kernelId/tool-call/:callId/start",
      "POST /api/relay/:kernelId/tool-result",
      "PUT /api/kernels/:kernelId/agent-package/configure",
      "PUT /api/operator/policy/:kernelId",
    ]);
  });
});

describe("N31 route inventory: the CLASSIFIED witnesses", () => {
  // digital_manifest_admin_only: suspend acts on the in-memory digital-kernel manifest registry,
  // not a shop kernel, and its own check requires X-Admin-Key whenever PCC_ADMIN_KEY is set.
  const PREV_ADMIN = process.env.PCC_ADMIN_KEY;
  let app: FastifyInstance;
  /** A manifest the marketplace's validateManifest accepts. */
  const manifestFor = (kernelId: string, builder: string) => ({
    manifestVersion: "1.0.0",
    kernelId,
    name: "N31 inventory manifest",
    description: "n31",
    builder: { agentId: builder, name: "b" },
    capabilityType: "n31.test",
    workflowSteps: [{ id: "s1", name: "step" }],
    pricing: { currency: "USDC", baseUSD: 1 },
    maxAssuranceTier: 1,
    endpointURL: "https://example.invalid/n31",
    sessionKeyPolicy: { maxTTLSeconds: 60, allowedActions: ["invoke"] },
  });

  beforeAll(async () => {
    process.env.PCC_ADMIN_KEY = "n31-inventory-admin";
    const { kernelMarketplaceRoutes } = await import("../routes/kernel-marketplace.js");
    app = Fastify({ logger: false });
    app.addHook("onRequest", async (req) => {
      const principal = req.headers["x-test-principal"];
      if (typeof principal === "string") (req as unknown as { operatorId: string }).operatorId = principal;
    });
    await app.register(kernelMarketplaceRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (PREV_ADMIN === undefined) delete process.env.PCC_ADMIN_KEY;
    else process.env.PCC_ADMIN_KEY = PREV_ADMIN;
  });

  it("POST /api/kernels/:kernelId/suspend refuses a caller without the admin key", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/api/kernels/register",
      headers: { "x-test-principal": "registrant-n31-suspend" },
      payload: manifestFor("kernel-n31-inventory-manifest", "builder-n31"),
    });
    expect(reg.statusCode).toBe(201);
    // Even the registrant: suspension needs the admin key.
    for (const headers of [{ "x-test-principal": "registrant-n31-suspend" }, { "x-test-principal": "stranger-n31" }]) {
      const res = await app.inject({ method: "POST", url: "/api/kernels/kernel-n31-inventory-manifest/suspend", headers, payload: {} });
      expect(res.statusCode).toBe(401);
    }
  });

  it("POST /api/kernels/:kernelId/verify refuses a stranger who names the builder in x-agent-id", async () => {
    const manifest = manifestFor("kernel-n31-inventory-verify", "builder-n31-verify");
    const reg = await app.inject({ method: "POST", url: "/api/kernels/register", headers: { "x-test-principal": "registrant-n31" }, payload: manifest });
    expect(reg.statusCode).toBe(201);
    const res = await app.inject({
      method: "POST",
      url: "/api/kernels/kernel-n31-inventory-verify/verify",
      headers: { "x-test-principal": "stranger-n31", "x-agent-id": "builder-n31-verify" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });
});
