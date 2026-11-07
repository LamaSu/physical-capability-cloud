import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourcePaths = {
  provision: new URL("../routes/provision.ts", import.meta.url),
  sweeper: new URL("../services/erc8004-identity-sweeper.ts", import.meta.url),
  classifier: new URL("../services/chain-error-code.ts", import.meta.url),
};

function parse(source: string) {
  const filename = "/construction.ts";
  const options = { noLib: true, noResolve: true, target: ts.ScriptTarget.ESNext };
  const host = ts.createCompilerHost(options);
  const file = ts.createSourceFile(filename, source, options.target, true);
  host.getSourceFile = (name) => name === filename ? file : undefined;
  const program = ts.createProgram([filename], options, host);
  return { file, checker: program.getTypeChecker() };
}

function visit(node: ts.Node, fn: (node: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? bindingIdentifiers(element.name) : []);
}

function errorBoundaryViolations(source: string): string[] {
  const { file, checker } = parse(source);
  const bindings = new Map<ts.Symbol, ts.Identifier>();
  const violations: string[] = [];
  const symbolAt = (node: ts.Identifier) => ts.isShorthandPropertyAssignment(node.parent)
    ? checker.getShorthandAssignmentValueSymbol(node.parent)
    : checker.getSymbolAtLocation(node);
  const addBinding = (name: ts.BindingName) => {
    for (const identifier of bindingIdentifiers(name)) {
      const symbol = symbolAt(identifier);
      if (symbol) bindings.set(symbol, identifier);
    }
  };

  visit(file, (node) => {
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      addBinding(node.variableDeclaration.name);
    }
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    const isCatch = (ts.isPropertyAccessExpression(callee) && callee.name.text === "catch")
      || (ts.isElementAccessExpression(callee) && ts.isStringLiteral(callee.argumentExpression)
        && callee.argumentExpression.text === "catch");
    if (!isCatch || !node.arguments[0]) return;
    let callback: ts.Node = node.arguments[0];
    while (ts.isParenthesizedExpression(callback)) callback = callback.expression;
    if (ts.isIdentifier(callback)) {
      const declaration = checker.getSymbolAtLocation(callback)?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
        callback = declaration.initializer;
      } else if (declaration && ts.isFunctionDeclaration(declaration)) {
        callback = declaration;
      }
    }
    if ((ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)
      || ts.isFunctionDeclaration(callback)) && callback.parameters[0]) {
      addBinding(callback.parameters[0].name);
    }
  });

  // Allowlist: only these imported functions declassify an unknown error into
  // closed codes. Resolve import symbols, so aliases work and shadowing cannot
  // turn a same-named local function into an escape hatch.
  function isClassifierArgument(node: ts.Identifier): boolean {
    const call = node.parent;
    if (!ts.isCallExpression(call) || !call.arguments.includes(node)
      || !ts.isIdentifier(call.expression)) return false;
    const declaration = checker.getSymbolAtLocation(call.expression)?.declarations?.[0];
    if (!declaration || !ts.isImportSpecifier(declaration)) return false;
    const importDeclaration = declaration.parent.parent.parent;
    if (!ts.isImportDeclaration(importDeclaration)
      || !ts.isStringLiteral(importDeclaration.moduleSpecifier)) return false;
    const name = (declaration.propertyName ?? declaration.name).text;
    const module = importDeclaration.moduleSpecifier.text;
    return (name === "classifyChainError"
      && ["./chain-error-code.js", "../services/chain-error-code.js"].includes(module))
      || (name === "classifyProvisionError" && module === "../auth/api-key-auth.js");
  }

  visit(file, (node) => {
    if (!ts.isIdentifier(node)) return;
    const symbol = symbolAt(node);
    if (!symbol || !bindings.has(symbol) || bindings.get(symbol) === node) return;
    if (!isClassifierArgument(node)) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart());
      violations.push(`line ${line + 1}: ${node.getText()} read by ${node.parent.getText()}`);
    }
  });
  return violations;
}

function classifierTraversalViolations(source: string): string[] {
  const { file, checker } = parse(source);
  let classifier: ts.FunctionDeclaration | undefined;
  visit(file, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "classifyChainError") classifier = node;
  });
  if (!classifier?.body || !classifier.parameters[0]
    || !ts.isIdentifier(classifier.parameters[0].name)) return ["missing classifyChainError boundary"];
  const tainted = new Set<ts.Symbol>();
  const initial = checker.getSymbolAtLocation(classifier.parameters[0].name);
  if (initial) tainted.add(initial);
  const isTainted = (node: ts.Node): node is ts.Identifier => ts.isIdentifier(node)
    && tainted.has(checker.getSymbolAtLocation(node)!);
  const violations: string[] = [];

  // Propagate aliases, including a cause traversal, before checking all reads.
  let changed = true;
  while (changed) {
    changed = false;
    visit(classifier.body, (node) => {
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
      const initializer = node.initializer;
      if (!isTainted(initializer)
        && !(ts.isPropertyAccessExpression(initializer) && initializer.name.text === "cause"
          && isTainted(initializer.expression))) return;
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol && !tainted.has(symbol)) { tainted.add(symbol); changed = true; }
    });
  }

  function insidePositiveGuard(node: ts.Node, constructor: string): boolean {
    for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
      if (!ts.isIfStatement(parent) || child !== parent.thenStatement) continue;
      const condition = parent.expression;
      if (!ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword
        || !isTainted(condition.left) || !ts.isIdentifier(condition.right)
        || checker.getSymbolAtLocation(condition.left) !== checker.getSymbolAtLocation(node)) continue;
      const declaration = checker.getSymbolAtLocation(condition.right)?.declarations?.[0];
      if (constructor === "ChainWriteError" && declaration && ts.isClassDeclaration(declaration)
        && declaration.name?.text === constructor && declaration.parent === file) return true;
      if (constructor === "BaseError" && declaration && ts.isImportSpecifier(declaration)
        && (declaration.propertyName ?? declaration.name).text === constructor) {
        const imported = declaration.parent.parent.parent;
        if (ts.isImportDeclaration(imported) && ts.isStringLiteral(imported.moduleSpecifier)
          && imported.moduleSpecifier.text === "viem") return true;
      }
    }
    return false;
  }

  // Named allowlist for the classifier only:
  // - instanceof: choose a fixed code from a concrete error class;
  // - aliases and Set.has/add: traverse causes safely, including cycles;
  // - ChainWriteError.code: its closed code after a positive class guard;
  // - BaseError.cause: traverse viem wrappers after a positive class guard.
  // No text property, coercion, serialization, arbitrary call, or error return
  // is allowed. The module's own catch bindings obey the stricter rule above.
  visit(classifier.body, (node) => {
    if (!isTainted(node)) return;
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && (parent.name === node || parent.initializer === node)) return;
    if (ts.isBinaryExpression(parent) && ((parent.left === node
      && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      || (parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword))) return;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      if (parent.name.text === "code" && insidePositiveGuard(node, "ChainWriteError")) return;
      if (parent.name.text === "cause" && insidePositiveGuard(node, "BaseError")) return;
    }
    if (ts.isCallExpression(parent) && parent.arguments.includes(node)
      && ts.isPropertyAccessExpression(parent.expression)
      && ["has", "add"].includes(parent.expression.name.text)
      && ts.isIdentifier(parent.expression.expression)) {
      const declaration = checker.getSymbolAtLocation(parent.expression.expression)?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
        && ts.isNewExpression(declaration.initializer) && ts.isIdentifier(declaration.initializer.expression)
        && declaration.initializer.expression.text === "Set"
        && !checker.getSymbolAtLocation(declaration.initializer.expression)) return;
    }
    violations.push(`unapproved classifier error read: ${parent.getText()}`);
  });
  return violations;
}

describe("caught errors cross only closed-code boundaries (T6)", () => {
  it("the sweeper startup catch also logs only a fixed code", () => {
    const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    const { file } = parse(source);
    const catches: ts.CallExpression[] = [];
    visit(file, (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "catch"
        && node.expression.expression.getText().includes('import("./services/erc8004-identity-sweeper.js")')) {
        catches.push(node);
      }
    });
    expect(catches).toHaveLength(1);
    const callback = catches[0].arguments[0];
    expect(ts.isArrowFunction(callback)).toBe(true);
    if (!ts.isArrowFunction(callback)) return;
    expect(callback.parameters).toHaveLength(0);
    expect(callback.body.getText()).toContain('code: "unknown"');
  });

  for (const [name, path] of Object.entries(sourcePaths)) {
    it(`${name} never reads caught errors outside the named classifier allowlist`, () => {
      const source = readFileSync(fileURLToPath(path), "utf8");
      expect(errorBoundaryViolations(source)).toEqual([]);
      if (name === "classifier") expect(classifierTraversalViolations(source)).toEqual([]);
    });
  }

  it.each([
    "try {} catch (err) { const alias = err; log(alias); }",
    "try {} catch (err) { log({ err }); }",
    "promise.catch(err => log(err.message));",
    "promise['catch'](({ message }) => log(message));",
    "const handler = err => log(err); promise.catch(handler);",
    "try {} catch (err) { const classifyChainError = x => String(x); classifyChainError(err); }",
  ])("the guard rejects error aliasing, serialization, and shadowed boundaries: %s", (source) => {
    expect(errorBoundaryViolations(source).length).toBeGreaterThan(0);
  });

  it("resolves classifier aliases and distinguishes shadowed error bindings", () => {
    expect(errorBoundaryViolations(`
      import { classifyChainError as classify } from '../services/chain-error-code.js';
      try {} catch (err) {
        { const err = 'safe'; log(err); }
        const code = classify(err);
        log(code);
      }
    `)).toEqual([]);
  });

  it("the classifier guard rejects text reads through a traversal alias", () => {
    expect(classifierTraversalViolations(`
      function classifyChainError(error: unknown) {
        const current = error;
        return String(current.message);
      }
    `).length).toBeGreaterThan(0);
  });
});
