/** Production isolation for the opt-in testing subpath (adapter-factory.ts:204-223). */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createMachineAdapter } from "../adapter-factory.js";
import type { DeviceConfig } from "../kernel-config.js";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const testingRoot = path.join(sourceRoot, "testing");

/** Parse module specifiers, so comments and ordinary string literals cannot trip the guard. */
function testingSpecifiers(source: string, filename: string): string[] {
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const inspect = (specifier: ts.Expression | undefined): void => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) return;
    const value = specifier.text;
    const relative = value.startsWith(".") || path.isAbsolute(value)
      ? path.resolve(path.dirname(filename), value) : undefined;
    if (
      value === "@pcc/kernel/testing" || value.startsWith("@pcc/kernel/testing/") ||
      relative === testingRoot || relative?.startsWith(testingRoot + path.sep)
    ) found.push(value);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) inspect(node.moduleSpecifier);
    if (ts.isExportDeclaration(node)) inspect(node.moduleSpecifier);
    if (ts.isCallExpression(node) && (
      node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require")
    )) inspect(node.arguments[0]);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      inspect(node.moduleReference.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return filename === testingRoot || filename === path.join(sourceRoot, "__tests__")
        ? [] : productionSources(filename);
    }
    return entry.name.endsWith(".ts") && !/\.(?:test|spec)\.ts$/.test(entry.name) ? [filename] : [];
  });
}

describe("FakeDevice production isolation", () => {
  it("scans exactly the independently enumerated production sources", () => {
    // Only the two top-level trees are excluded; nested __tests__ helpers stay scanned.
    const independent = readdirSync(sourceRoot, { recursive: true, encoding: "utf8" })
      .filter((relative) =>
        relative.endsWith(".ts") && !/\.(?:test|spec)\.ts$/.test(relative) &&
        !relative.startsWith(`testing${path.sep}`) && !relative.startsWith(`__tests__${path.sep}`),
      )
      .map((relative) => path.join(sourceRoot, relative))
      .filter((filename) => !lstatSync(filename).isDirectory());
    expect(productionSources(sourceRoot).sort()).toEqual(independent.sort());
  });

  it("includes production sentinels and excludes testing trees and test files", () => {
    const scanned = productionSources(sourceRoot).map((filename) => path.relative(sourceRoot, filename));
    expect(scanned).toEqual(expect.arrayContaining([
      "index.ts", "server.ts", "adapter-factory.ts", "printer-job.ts", "job-runner.ts",
      path.join("adapters", "types.ts"), path.join("adapters", "ipp-adapter.ts"),
      path.join("adapters", "sila", "sila-adapter.ts"), path.join("digital", "accounting-kernel.ts"),
      path.join("opentrons", "adapter.ts"), path.join("safety", "governor.ts"),
    ]));
    for (const relative of scanned) {
      expect(relative).not.toMatch(/\.(?:test|spec)\.ts$/);
      expect(relative.startsWith(`testing${path.sep}`)).toBe(false);
      expect(relative.startsWith(`__tests__${path.sep}`)).toBe(false);
    }
  });

  it.each([
    ["static import", 'import { FakeDevice } from "./testing/fake-device.js";', "index.ts", "./testing/fake-device.js"],
    ["multi-line import", 'import {\n FakeDevice,\n} from\n "./testing/index.js";', "index.ts", "./testing/index.js"],
    ["export star", 'export * from "./testing/index.js";', "index.ts", "./testing/index.js"],
    ["dynamic import", 'const module = await import("./testing/index.js");', "index.ts", "./testing/index.js"],
    ["require", 'const module = require("@pcc/kernel/testing");', "index.ts", "@pcc/kernel/testing"],
    ["deeper relative path", 'import { FakeDevice } from "../testing/fake-device.js";', "adapters/anything.ts", "../testing/fake-device.js"],
    ["package subpath", 'export { FakeDevice } from "@pcc/kernel/testing";', "index.ts", "@pcc/kernel/testing"],
  ])("specifier matcher catches %s", (_label, source, filename, specifier) => {
    expect(testingSpecifiers(source, path.join(sourceRoot, filename))).toEqual([specifier]);
  });

  it.each([
    'import { util } from "./testing-utils.js";',
    'export * from "./attesting.js";',
    'const module = import("@pcc/kernel-testing");',
    '// import { FakeDevice } from "./testing/fake-device.js";\nconsole.log("src/testing");',
    'console.log(\'import("./testing/fake-device.js")\');',
  ])("specifier matcher ignores near-miss %s", (source) => {
    expect(testingSpecifiers(source, path.join(sourceRoot, "index.ts"))).toEqual([]);
  });

  it("production sources have no imports or re-exports of src/testing", () => {
    const violations = productionSources(sourceRoot).flatMap((filename) =>
      testingSpecifiers(readFileSync(filename, "utf8"), filename).map((specifier) => ({
        file: path.relative(sourceRoot, filename), specifier,
      })),
    );
    expect(violations).toEqual([]);
  });

  it.each(["fake", "fake-device"])("factory refuses unregistered %s instead of silently fabricating", (adapterType) => {
    const device: DeviceConfig = {
      id: "fake-device-production-guard", type: "machine",
      adapterType: adapterType as DeviceConfig["adapterType"], config: {},
    };
    expect(() => createMachineAdapter(device)).toThrow(`Unknown machine adapterType "${adapterType}"`);
    expect(() => createMachineAdapter(device)).toThrow("refusing to fall back to a mock adapter");
  });

  it("package.json maps exactly one export into dist/testing", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, Record<string, string>>;
    };
    const testingExports = Object.entries(manifest.exports).filter(([, conditions]) =>
      Object.values(conditions).some((target) => target.startsWith("./dist/testing/")),
    );
    expect(testingExports).toEqual([["./testing", {
      types: "./dist/testing/index.d.ts", import: "./dist/testing/index.js", default: "./dist/testing/index.js",
    }]]);
  });
});
