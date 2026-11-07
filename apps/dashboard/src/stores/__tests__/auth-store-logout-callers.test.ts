import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AUTH_STORE = join(SRC, "stores/auth-store.ts");

function productionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    // Tests legitimately exercise the low-level logout, so exclude test files.
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : productionFiles(full);
    return /\.[cm]?[jt]sx?$/.test(name) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(name) && !name.endsWith(".d.ts") ? [full] : [];
  });
}

function logoutCalls(sources: Map<string, string>): string[] {
  // Only the store's types are needed. Unrelated imports stay unresolved, so
  // hook logout methods remain distinct and no dependency tree is loaded.
  const files = new Map(sources);
  files.set(AUTH_STORE, `
    interface AuthState {
      logout: () => void;
      signOutWallet: (options?: { keepPersisted?: boolean }) => unknown;
      [key: string]: unknown;
    }
    interface AuthStore {
      (): AuthState;
      <T>(selector: (state: AuthState) => T): T;
      getState(): AuthState;
    }
    export declare const useAuthStore: AuthStore;
  `);
  const options: ts.CompilerOptions = { noLib: true, noEmit: true, allowJs: true, jsx: ts.JsxEmit.Preserve };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (path) => {
    const source = files.get(path);
    return source === undefined ? undefined : ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  };
  host.readFile = (path) => files.get(path);
  host.fileExists = (path) => files.has(path);
  host.resolveModuleNames = (names, containingFile) => names.map((name) =>
    resolve(dirname(containingFile), name).replace(/\.[cm]?js$/, ".ts") === AUTH_STORE
      ? { resolvedFileName: AUTH_STORE, extension: ts.Extension.Ts }
      : undefined,
  );
  const program = ts.createProgram([...files.keys()], options, host);
  const checker = program.getTypeChecker();
  const hits: string[] = [];
  for (const path of sources.keys()) {
    const file = program.getSourceFile(path)!;
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const declaration = checker.getResolvedSignature(node)?.declaration;
        if (declaration?.getSourceFile().fileName === AUTH_STORE &&
          ts.isPropertySignature(declaration.parent) && declaration.parent.name.getText() === "logout") {
          hits.push(`${relative(SRC, path)}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  return hits;
}

describe("auth store logout callers", () => {
  it("reserves the low-level logout for the auth store and tests", () => {
    const sources = new Map(productionFiles(SRC)
      .filter((path) => path !== AUTH_STORE)
      .map((path) => [path, readFileSync(path, "utf8")]));
    const probe = join(SRC, "stores/LogoutProbe.ts");
    sources.set(probe, `import { useAuthStore as store } from "./auth-store.js";
      import { useAuth } from "../hooks/use-auth.js";
      const logout = store((state) => state.signOutWallet); logout();
      const wallet = useAuth(); wallet.logout();
      const { logout: walletLogout } = useAuth(); walletLogout();
    `);
    expect(logoutCalls(sources)).toEqual([]);

    expect(logoutCalls(new Map([[probe, `import { useAuthStore as store } from "./auth-store.js";
      store.getState().logout();
      const { logout: signOut } = store.getState(); signOut();
      const selected = store((state) => state.logout); selected();
      const state = store(); state.logout();
      const alias = store.getState().logout; alias();
    `]]))).toEqual([2, 3, 4, 5, 6].map((line) => `stores/LogoutProbe.ts:${line}`));
  });
});
