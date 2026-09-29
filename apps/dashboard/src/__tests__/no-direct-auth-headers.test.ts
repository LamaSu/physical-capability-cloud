/**
 * The API key reaches a request in exactly one place (N50; sol #2857; astra
 * round 2).
 *
 * The boundary is structural (lib/gateway-base.ts, rules 1-3):
 * - The key is not in the auth store's state.
 * - Its one accessor, readApiKeyForAuthorizedFetch(), is read only by
 *   lib/authorized-fetch.ts.
 * - fetchWithKey() in lib/gateway-base.ts is the only code that puts a key on
 *   a request.
 *
 * TypeScript enforces part of this: reading apiKey from the store no longer
 * type-checks, and getAuthHeaders() no longer exists. This test enforces the
 * rest over every production module, with no whole-file exemptions:
 *   1. The identifier getAuthHeaders appears nowhere.
 *   2. The accessor is referenced only where it is defined (the store) and in
 *      lib/authorized-fetch.ts, including re-exports and dynamic access.
 *   3. The storage key literal appears only in the store, and no other module
 *      reads localStorage by a computed key or enumerates it.
 *   4. No module but lib/gateway-base.ts builds an Authorization header or a
 *      "Bearer …" value. A line that shows such text to a person, never
 *      sending it, is allowed only as an exact, reviewed line in
 *      DISPLAY_ONLY, which also fixes how many times it occurs. It is never
 *      allowed by file.
 *   5. At runtime, the store's state holds no key.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { useAuthStore } from "../stores/auth-store.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

const STORE = "stores/auth-store.ts";
const WRAPPER = "lib/authorized-fetch.ts";
const BOUNDARY = "lib/gateway-base.ts";

/**
 * Exact trimmed lines that show a credential format to a person (docs,
 * copyable examples) and are never sent. Each is keyed by file, with how many
 * times it occurs and why it was reviewed. An edit to such a line, or one
 * more copy of it, fails the test until it is reviewed again.
 */
const DISPLAY_ONLY: Record<string, { line: string; count: number; why: string }[]> = {
  "pages/AgentLinkPage.tsx": [
    {
      line: 'if (PCC_API_KEY) headers["Authorization"] = \\`Bearer \\${PCC_API_KEY}\\`;',
      count: 2,
      why: "text inside the two quickstart scripts the page shows for the user to copy (buildClaudeQuickstart, buildOpenAIQuickstart); a template string the dashboard never runs",
    },
  ],
};

function productionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : productionFiles(full);
    return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name) && !/\.(test|spec)\.[jt]sx?$/.test(name) && !name.endsWith(".d.ts") ? [full] : [];
  });
}

const FILES = productionFiles(SRC).map((full) => ({
  rel: relative(SRC, full).split(sep).join("/"),
  lines: readFileSync(full, "utf-8").split("\n"),
}));

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

interface Hit {
  file: string;
  n: number;
  /** The whole trimmed line; DISPLAY_ONLY compares all of it, never a prefix. */
  text: string;
}

function hits(pattern: RegExp, allowedFiles: string[] = []): Hit[] {
  return FILES.filter((f) => !allowedFiles.includes(f.rel)).flatMap((f) =>
    f.lines
      .map((line, i) => ({ file: f.rel, n: i + 1, text: line.trim() }))
      .filter(({ text }) => !isComment(text) && pattern.test(text)),
  );
}

const show = (h: Hit) => `${h.file}:${h.n} ${h.text.slice(0, 120)}`;

/** Building an Authorization header in any form: an object key, a header name, or a set/append call. */
const AUTHORIZATION = /["'`]authorization["'`]|\bauthorization\s*:|\.(?:set|append)\(\s*["'`]authorization/i;
/** Building a Bearer credential: a template, a concatenation, or a "Bearer " literal. */
const BEARER = /Bearer\s*\$\{|["'`]Bearer\s+["'`]?\s*\+|["'`]Bearer\s/;
/** Reaching the key's storage slot without naming it: a computed key, or enumerating storage. */
const STORAGE_SWEEP =
  /localStorage\s*(?:\.\s*key\s*\(|\[)|localStorage\.getItem\(\s*[^"'`\s)]|(?:keys|values|entries|assign)\(\s*(?:\{\s*)?(?:\.\.\.\s*)?localStorage|\.\.\.\s*localStorage|stringify\(\s*localStorage/;

describe("the API key reaches a request only through fetchWithKey (N50 round 2)", () => {
  it("getAuthHeaders is gone", () => {
    expect(hits(/\bgetAuthHeaders\b/).map(show)).toEqual([]);
  });

  it("only lib/authorized-fetch.ts reads the stored key", () => {
    expect(hits(/readApiKeyForAuthorizedFetch/, [STORE, WRAPPER]).map(show)).toEqual([]);
  });

  it("only the store touches the key's storage slot, by name or by sweeping storage", () => {
    expect(hits(/pcc-api-key/, [STORE]).map(show)).toEqual([]);
    expect(hits(STORAGE_SWEEP, [STORE]).map(show)).toEqual([]);
  });

  it("no module but lib/gateway-base.ts builds an Authorization header or a Bearer credential", () => {
    const found = new Map<string, Hit>();
    for (const h of [...hits(AUTHORIZATION, [BOUNDARY]), ...hits(BEARER, [BOUNDARY])]) found.set(`${h.file}:${h.n}`, h);
    const unreviewed = [...found.values()].filter((h) => !DISPLAY_ONLY[h.file]?.some((d) => d.line === h.text));
    expect(unreviewed.map(show), "Send the key with authorizedFetch (lib/authorized-fetch.ts); never build the header").toEqual([]);
  });

  it("each DISPLAY_ONLY line occurs exactly as often as it was reviewed for", () => {
    const wrong = Object.entries(DISPLAY_ONLY).flatMap(([file, lines]) => {
      const text = FILES.find((f) => f.rel === file)?.lines.map((l) => l.trim()) ?? [];
      return lines
        .map((d) => ({ d, seen: text.filter((t) => t === d.line).length }))
        .filter(({ d, seen }) => seen !== d.count)
        .map(({ d, seen }) => `${file}: "${d.line.slice(0, 80)}" occurs ${seen} times, reviewed for ${d.count}`);
    });
    expect(wrong).toEqual([]);
  });

  it("the auth store's state holds no key", () => {
    expect("apiKey" in useAuthStore.getState()).toBe(false);
    expect(Object.values(useAuthStore.getState()).some((v) => typeof v === "string" && /^pcc_/.test(v))).toBe(false);
  });

  it("the patterns catch each way of building a credential (self-test)", () => {
    for (const line of [
      "headers: { Authorization: `Bearer ${key}` },",
      'headers: { "authorization": token },',
      'h.set("Authorization", v);',
      "const auth = \"Bearer \" + key;",
      "const auth = `Bearer ${key}`;",
    ]) {
      expect(AUTHORIZATION.test(line) || BEARER.test(line), line).toBe(true);
    }
    expect(AUTHORIZATION.test('const label = "Authorized";')).toBe(false);
    for (const line of [
      "const k = localStorage.getItem(name);",
      "for (let i = 0; i < localStorage.length; i++) localStorage.key(i);",
      "const all = Object.entries(localStorage);",
      "send(JSON.stringify(localStorage));",
      "const copy = { ...localStorage };",
      "const v = localStorage[slot];",
    ]) {
      expect(STORAGE_SWEEP.test(line), line).toBe(true);
    }
    expect(STORAGE_SWEEP.test('localStorage.getItem("pcc-tour-seen")')).toBe(false);
  });
});
