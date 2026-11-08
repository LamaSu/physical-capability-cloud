/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { adoptApiKey, useAuthStore } from "../stores/auth-store.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY_OWNER = "lib/authorized-fetch.ts";

function productionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : productionFiles(full);
    return /\.[cm]?[jt]sx?$/.test(name) && !/\.(test|spec)\.[jt]sx?$/.test(name) && !name.endsWith(".d.ts") ? [full] : [];
  });
}

function literalPreference(node: ts.Expression | undefined): boolean {
  return node !== undefined && (
    ts.isStringLiteral(node) || ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword
  );
}

function storageViolations(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression.getText(file);
      if (/^(?:(?:window|globalThis|self)\.)?(?:local|session)Storage$/.test(receiver) && ["setItem", "removeItem", "clear"].includes(method)) {
        const slot = node.arguments[0];
        const authSlot = slot && ts.isStringLiteral(slot) && /session|token|api.?key|key.?id|expires/i.test(slot.text);
        if (method === "clear" || !slot || !ts.isStringLiteral(slot) || authSlot || (method === "setItem" && !literalPreference(node.arguments[1]))) {
          hits.push(`${path}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return hits;
}

afterEach(() => adoptApiKey(null));

describe("session state storage", () => {
  it("keeps session metadata volatile and permits only literal preference writes outside the key owner", () => {
    const state = useAuthStore.getState();
    expect(state).toHaveProperty("sessionKeyId", null);
    expect(state).toHaveProperty("sessionKeyExpiresAt", null);
    const source = readFileSync(join(SRC, "stores/auth-store.ts"), "utf-8");
    expect(source).not.toMatch(/zustand\/middleware|\bpersist\s*\(/);
    const violations = productionFiles(SRC)
      .filter((full) => relative(SRC, full) !== KEY_OWNER)
      .flatMap((full) => storageViolations(relative(SRC, full), readFileSync(full, "utf-8")));
    expect(violations).toEqual([]);

    for (const probe of [
      'localStorage.setItem("pcc-session", token);',
      'sessionStorage.setItem("pcc-session-key-id", key_id);',
      'localStorage.setItem("pcc-key-expiry", expires_at);',
      'localStorage.setItem("profile", JSON.stringify(useAuthStore.getState()));',
      'localStorage.setItem("profile", response.api_key);',
    ]) {
      expect(storageViolations("stores/Probe.ts", probe), probe).toEqual(["stores/Probe.ts:1"]);
    }
    expect(storageViolations("components/Probe.ts", 'localStorage.setItem("pcc-tour-seen", "true");')).toEqual([]);
  });
});
