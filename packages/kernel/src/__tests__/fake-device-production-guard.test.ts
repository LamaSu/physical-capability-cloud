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
function moduleSpecifiers(source: string, filename: string): string[] {
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const inspect = (specifier: ts.Expression | undefined): void => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) return;
    found.push(specifier.text);
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

function testingSpecifiers(source: string, filename: string): string[] {
  return moduleSpecifiers(source, filename).filter((value) => {
    const relative = value.startsWith(".") || path.isAbsolute(value)
      ? path.resolve(path.dirname(filename), value) : undefined;
    return value === "@pcc/kernel/testing" || value.startsWith("@pcc/kernel/testing/") ||
      relative === testingRoot || relative?.startsWith(testingRoot + path.sep);
  });
}

function vitestSpecifiers(source: string, filename: string): string[] {
  return moduleSpecifiers(source, filename).filter((value) => {
    const relative = value.startsWith(".") || path.isAbsolute(value)
      ? path.resolve(path.dirname(filename), value).replace(/\.(?:js|ts)$/, "") : undefined;
    return value === "vitest" || value.startsWith("vitest/") ||
      value === "@pcc/kernel/conformance/vitest" ||
      value.startsWith("@pcc/kernel/conformance/vitest/") ||
      relative === path.join(sourceRoot, "conformance", "vitest");
  });
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

/** All shipped testing code is audited too; it may violate contracts but cannot conceal fabrication. */
function testingSources(directory: string = testingRoot): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? testingSources(filename) : entry.name.endsWith(".ts") ? [filename] : [];
  });
}

/** Include declaration exports as well as barrel exports, so private helpers stay private. */
function exportedNames(source: string, filename: string): string[] {
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const bindingNames = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) found.push(name.text);
    else for (const element of name.elements) if (ts.isBindingElement(element)) bindingNames(element.name);
  };
  for (const statement of parsed.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) found.push("*");
      else if (ts.isNamedExports(statement.exportClause)) {
        found.push(...statement.exportClause.elements.map((element) => element.name.text));
      } else found.push(statement.exportClause.name.text);
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      found.push(statement.isExportEquals ? "export=" : "default");
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) found.push("default");
    else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) bindingNames(declaration.name);
    } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement) ||
      ts.isImportEqualsDeclaration(statement)) found.push(statement.name?.text ?? "<unnamed export>");
    else found.push("<unknown export>");
  }
  return found.sort();
}

type FabricationTag = "simulated" | "mock";
interface TagViolation { property: FabricationTag; operation: "delete" | "assign"; line: number }

function unwrapExpression(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)) expression = expression.expression;
  return expression;
}

function fabricationTagName(node: ts.Node): FabricationTag | undefined {
  if (ts.isComputedPropertyName(node)) {
    const key = unwrapExpression(node.expression);
    return ts.isStringLiteralLike(key) ? fabricationTagName(key) : undefined;
  }
  const name = ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
  return name === "simulated" || name === "mock" ? name : undefined;
}

function assignedTag(expression: ts.Expression): FabricationTag | undefined {
  const target = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(target)) return fabricationTagName(target.name);
  if (ts.isElementAccessExpression(target)) {
    const key = unwrapExpression(target.argumentExpression);
    return ts.isStringLiteralLike(key) ? fabricationTagName(key) : undefined;
  }
  return undefined;
}

/** Inspect syntax, not substrings: comments, strings and similarly named properties are harmless. */
function forbiddenFabricationTagWrites(source: string, filename: string): TagViolation[] {
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const found: TagViolation[] = [];
  const record = (node: ts.Node, property: FabricationTag | undefined, operation: TagViolation["operation"]): void => {
    if (property) found.push({ property, operation, line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1 });
  };
  const forbiddenValue = (expression: ts.Expression): boolean => {
    const value = unwrapExpression(expression);
    return value.kind === ts.SyntaxKind.FalseKeyword ||
      (ts.isIdentifier(value) && value.text === "undefined") || ts.isVoidExpression(value);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isDeleteExpression(node)) record(node, assignedTag(node.expression), "delete");
    if (ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && forbiddenValue(node.right)) {
      record(node, assignedTag(node.left), "assign");
    }
    if ((ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) &&
      node.initializer && forbiddenValue(node.initializer)) record(node, fabricationTagName(node.name), "assign");
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
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
      path.join("conformance", "index.ts"), path.join("conformance", "clauses.ts"),
      path.join("conformance", "report.ts"), path.join("conformance", "runner.ts"),
      path.join("conformance", "vitest.ts"),
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

  it.each([
    ["static import", 'import { it } from "vitest";', "conformance/runner.ts", "vitest"],
    ["export star", 'export * from "./vitest.js";', "conformance/index.ts", "./vitest.js"],
    ["dynamic import", 'const module = import("vitest/node");', "conformance/index.ts", "vitest/node"],
    ["require", 'const module = require("@pcc/kernel/conformance/vitest");', "conformance/index.ts", "@pcc/kernel/conformance/vitest"],
    ["import equals", 'import module = require("vitest");', "conformance/report.ts", "vitest"],
    ["root re-export", 'export * from "./conformance/vitest.js";', "index.ts", "./conformance/vitest.js"],
    ["deeper relative path", 'import { wrapper } from "../conformance/vitest.js";', "adapters/anything.ts", "../conformance/vitest.js"],
    ["package subpath", 'export * from "@pcc/kernel/conformance/vitest/extra";', "index.ts", "@pcc/kernel/conformance/vitest/extra"],
  ])("Vitest matcher catches %s", (_label, source, filename, specifier) => {
    expect(vitestSpecifiers(source, path.join(sourceRoot, filename))).toEqual([specifier]);
  });

  it.each([
    'import { result } from "./vitest-utils.js";',
    'const name = "vitest";',
    '// import { it } from "vitest";\nconsole.log("./vitest.js");',
  ])("Vitest matcher ignores near-miss %s", (source) => {
    expect(vitestSpecifiers(source, path.join(sourceRoot, "conformance", "index.ts"))).toEqual([]);
  });

  it("the main conformance entry and its core modules never import Vitest", () => {
    const directory = path.join(sourceRoot, "conformance");
    const scanned = productionSources(directory).filter((filename) => filename !== path.join(directory, "vitest.ts"));
    expect(scanned.map((filename) => path.basename(filename)).sort()).toEqual([
      "clauses.ts", "index.ts", "report.ts", "runner.ts",
    ]);
    const violations = scanned.flatMap((filename) =>
      vitestSpecifiers(readFileSync(filename, "utf8"), filename).map((specifier) => ({
        file: path.relative(sourceRoot, filename), specifier,
      })),
    );
    expect(violations).toEqual([]);
  });

  it("all production sources except the opt-in wrapper never import Vitest", () => {
    const wrapper = path.join(sourceRoot, "conformance", "vitest.ts");
    const scanned = productionSources(sourceRoot).filter((filename) => filename !== wrapper);
    expect(scanned).toEqual(expect.arrayContaining([
      path.join(sourceRoot, "index.ts"), path.join(sourceRoot, "conformance", "index.ts"),
    ]));
    expect(scanned).not.toContain(wrapper);
    const violations = scanned.flatMap((filename) =>
      vitestSpecifiers(readFileSync(filename, "utf8"), filename).map((specifier) => ({
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

  it("scans every testing source including both shipped fault modules", () => {
    const scanned = testingSources().sort();
    const independent = readdirSync(testingRoot, { recursive: true, encoding: "utf8" })
      .filter((relative) => relative.endsWith(".ts"))
      .map((relative) => path.join(testingRoot, relative))
      .filter((filename) => !lstatSync(filename).isDirectory()).sort();
    expect(scanned).toEqual(independent);
    // The fault injector and generator are guarded dist inputs, through the existing testing export.
    expect(scanned.map((filename) => path.relative(testingRoot, filename))).toEqual([
      "fake-device.ts", "faults.ts", "index.ts", "negative-controls.ts",
    ]);
  });

  it("each testing module exports exactly its audited public names", () => {
    const actual = Object.fromEntries(testingSources().map((filename) => [
      path.relative(testingRoot, filename), exportedNames(readFileSync(filename, "utf8"), filename),
    ]));
    expect(actual).toEqual({
      "fake-device.ts": ["FakeDevice", "FakeDeviceOptions", "FakeDeviceStartOutcome"],
      "faults.ts": ["SHIPPED_DEVICE_FAULTS", "ShippedDeviceFault", "withDeviceFault"],
      "index.ts": [
        "FakeDevice", "FakeDeviceOptions", "FakeDeviceStartOutcome", "NegativeControl",
        "NegativeControlOptions", "NegativeControls", "SHIPPED_DEVICE_FAULTS", "ShippedDeviceFault",
        "generateNegativeControls", "withDeviceFault",
      ],
      "negative-controls.ts": ["NegativeControl", "NegativeControlOptions", "NegativeControls", "generateNegativeControls"],
    });
  });

  it("shipped testing sources never remove or falsify fabrication tags", () => {
    const scanned = testingSources();
    // An empty or production-only walk must not turn this safety check into a vacuous pass.
    expect(scanned).toEqual(expect.arrayContaining([
      path.join(testingRoot, "fake-device.ts"), path.join(testingRoot, "faults.ts"),
      path.join(testingRoot, "index.ts"), path.join(testingRoot, "negative-controls.ts"),
    ]));
    const violations = scanned.flatMap((filename) =>
      forbiddenFabricationTagWrites(readFileSync(filename, "utf8"), filename).map((violation) => ({
        file: path.relative(sourceRoot, filename), ...violation,
      })),
    );
    expect(violations).toEqual([]);
  });

  it("shipped testing sources never import Vitest", () => {
    const violations = testingSources().flatMap((filename) =>
      vitestSpecifiers(readFileSync(filename, "utf8"), filename).map((specifier) => ({
        file: path.relative(sourceRoot, filename), specifier,
      })),
    );
    expect(violations).toEqual([]);
  });

  it.each((["simulated", "mock"] as const).flatMap((property) => [
    [`delete dot ${property}`, `delete event.source.${property};`, property, "delete"],
    [`delete bracket ${property}`, `delete event.payload["${property}"];`, property, "delete"],
    [`delete template ${property}`, `delete event.payload[\`${property}\`];`, property, "delete"],
    [`assign false dot ${property}`, `event.source.${property} = false;`, property, "assign"],
    [`assign false bracket ${property}`, `event.payload["${property}"] = false;`, property, "assign"],
    [`assign undefined dot ${property}`, `event.source.${property} = undefined;`, property, "assign"],
    [`assign undefined bracket ${property}`, `event.payload["${property}"] = undefined;`, property, "assign"],
    [`assign void ${property}`, `event.payload["${property}"] = void 0;`, property, "assign"],
    [`parenthesized assignment ${property}`, `(event.source.${property}) = (false as boolean);`, property, "assign"],
    [`logical assignment ${property}`, `event.source.${property} &&= false;`, property, "assign"],
    [`object false ${property}`, `const event = { ${property}: false };`, property, "assign"],
    [`object undefined ${property}`, `const event = { ["${property}"]: undefined };`, property, "assign"],
    [`class initializer ${property}`, `class Event { ${property} = undefined; }`, property, "assign"],
  ]))("fabrication guard catches %s", (_label, source, property, operation) => {
    expect(forbiddenFabricationTagWrites(source, "scratch.ts")).toEqual([{ property, operation, line: 1 }]);
  });

  it.each([
    "delete event.source.simulatedX;",
    "event.source.simulatedX = false;",
    'event.payload["mockX"] = undefined;',
    'const property = "simulated"; const other = "mock";',
    'const simulated = "other"; event[simulated] = false;',
    'const text = "delete event.source.simulated; event.payload.mock = false";',
    "// delete event.source.simulated;\n/* event.payload.mock = undefined; */",
    "event.source.simulated = true; event.payload.mock = true;",
    "const event = { simulated: true, mock: true, simulatedX: false, mockX: undefined };",
  ])("fabrication guard ignores near-miss %s", (source) => {
    expect(forbiddenFabricationTagWrites(source, "scratch.ts")).toEqual([]);
  });

  it("testing barrel exposes only the opt-in FakeDevice and conformance self-test surface", () => {
    const filename = path.join(testingRoot, "index.ts");
    const parsed = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
    const exports = parsed.statements.filter(ts.isExportDeclaration).map((statement) => ({
      from: statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text : undefined,
      typeOnly: statement.isTypeOnly,
      names: statement.exportClause && ts.isNamedExports(statement.exportClause)
        ? statement.exportClause.elements.map((element) => element.name.text) : undefined,
    }));
    expect(exports).toEqual([
      { from: "./fake-device.js", typeOnly: false, names: ["FakeDevice"] },
      { from: "./fake-device.js", typeOnly: true, names: ["FakeDeviceOptions", "FakeDeviceStartOutcome"] },
      { from: "./faults.js", typeOnly: false, names: ["SHIPPED_DEVICE_FAULTS", "withDeviceFault"] },
      { from: "./faults.js", typeOnly: true, names: ["ShippedDeviceFault"] },
      { from: "./negative-controls.js", typeOnly: false, names: ["generateNegativeControls"] },
      { from: "./negative-controls.js", typeOnly: true, names: ["NegativeControl", "NegativeControlOptions", "NegativeControls"] },
    ]);
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

  it("package.json exposes conformance and Vitest through separate opt-in subpaths", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, Record<string, string>>;
    };
    expect(manifest.exports["./conformance"]).toEqual({
      types: "./dist/conformance/index.d.ts", import: "./dist/conformance/index.js", default: "./dist/conformance/index.js",
    });
    expect(manifest.exports["./conformance/vitest"]).toEqual({
      types: "./dist/conformance/vitest.d.ts", import: "./dist/conformance/vitest.js", default: "./dist/conformance/vitest.js",
    });
  });
});
