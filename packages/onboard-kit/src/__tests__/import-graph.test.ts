import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { builtinModules } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const srcDir = fileURLToPath(new URL("..", import.meta.url));
const example = fileURLToPath(new URL("../examples/cnc-shop-config.json", import.meta.url));
const forbidden = ["@pcc/kernel", "@pcc/agent-kernel", "@pcc/agent-runtime", "@pcc/a2a", "@pcc/agent-broker", "@pcc/agent-user"];

function importGraph(entry: string) {
  const visited = new Set<string>(), externals = new Set<string>();
  function walk(file: string): void {
    if (visited.has(file)) return;
    visited.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function specifier(node: ts.Node | undefined): void {
      expect(node && ts.isStringLiteral(node), `non-literal import in ${file}`).toBe(true);
      if (!node || !ts.isStringLiteral(node)) return;
      if (node.text.startsWith(".")) walk(resolve(dirname(file), node.text.replace(/\.js$/, ".ts")));
      else externals.add(node.text);
    }
    function visit(node: ts.Node): void {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) specifier(node.moduleSpecifier);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier(node.arguments[0]);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  walk(entry);
  return { visited: [...visited].map(file => relative(srcDir, file)).sort(), externals: [...externals].sort() };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("IG1: follows actual imports, including types, without entering a PCC runtime", () => {
  const graph = importGraph(resolve(srcDir, "cli.ts"));
  expect(graph.externals.filter(name => forbidden.includes(name))).toEqual([]);
  const allowed = new Set([...builtinModules.map(name => name.replace(/^node:/, "")), "@pcc/spec", "@pcc/contract-builder", "zod"]);
  expect(graph.externals.filter(name => !allowed.has(name.replace(/^node:/, "")))).toEqual([]);
  for (const name of ["spec", "contract-builder"]) {
    const path = fileURLToPath(new URL(`../../../${name}/package.json`, import.meta.url));
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(pkg.dependencies ?? {}).filter(dep => forbidden.includes(dep))).toEqual([]);
  }
  for (const file of ["cli.ts", "validate.ts", "config-shape.ts", "known-types.ts", "scaffolder.ts", "scaffold-rules.ts", "types.ts"]) {
    expect(graph.visited).toContain(file);
  }
  expect(graph.externals).toContain("@pcc/spec");
  expect(graph.externals).toContain("@pcc/contract-builder");
  expect(readFileSync(resolve(srcDir, "scaffolder.ts"), "utf8")).toContain("@pcc/agent-kernel");
});

it("NET1: local CLI validation calls no network API", async () => {
  const deny = () => { throw new Error("network API called during local validation"); };
  const fetch = vi.fn(deny);
  vi.stubGlobal("fetch", fetch);
  const stubs = [
    fetch, vi.spyOn(http, "request").mockImplementation(deny), vi.spyOn(https, "request").mockImplementation(deny),
    vi.spyOn(net, "connect").mockImplementation(deny), vi.spyOn(net, "createConnection").mockImplementation(deny),
  ];
  const { runCli } = await import("../cli.js");
  expect(runCli(["validate", "--config", example], { log: vi.fn(), error: vi.fn() })).toBe(0);
  for (const stub of stubs) expect(stub).not.toHaveBeenCalled();
});
