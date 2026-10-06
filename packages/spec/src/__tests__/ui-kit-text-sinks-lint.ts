import ts from "typescript";

export interface TextSinkIssue {
  file: string;
  line: number;
  column: number;
  rule: string;
}

export interface TextSinkCallAllowance {
  /** An allowance must explain why this specific call cannot insert a string. */
  reason: string;
  matches(call: ts.CallExpression): boolean;
}

export interface TextSinkConfig {
  file: string;
  scriptKind: ts.ScriptKind;
  sinks: readonly string[];
  /** Include an adapter's attribute-forwarding method as well as the DOM method. */
  attributeMethods?: readonly string[];
  allowedNodeCalls?: readonly TextSinkCallAllowance[];
}

const TEXT_PROPERTIES = new Set(["textContent", "innerText", "outerText", "nodeValue", "data"]);
const NODE_OR_TEXT_METHODS = new Set(["append", "prepend", "before", "after", "replaceWith", "replaceChildren"]);

function unwrap(node: ts.Node): ts.Node {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}

function literalName(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isComputedPropertyName(node)) {
    const key = unwrap(node.expression);
    return ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key) ? key.text : undefined;
  }
  return undefined;
}

export function memberName(node: ts.Node): string | undefined {
  node = unwrap(node);
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) {
    const key = node.argumentExpression && unwrap(node.argumentExpression);
    // An identifier key is a variable, not a literal property name.
    return key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) ? key.text : undefined;
  }
  return undefined;
}

function calledExpression(node: ts.Node): ts.Node {
  node = unwrap(node);
  const name = memberName(node);
  // Calling or binding a forbidden DOM method indirectly cannot evade the rule.
  if ((name === "call" || name === "apply" || name === "bind") && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) return calledExpression(node.expression);
  return node;
}

function calledName(node: ts.Node): string | undefined {
  node = calledExpression(node);
  return ts.isIdentifier(node) ? node.text : memberName(node);
}

export function isIdentifier(node: ts.Node | undefined, name: string): boolean {
  if (!node) return false;
  node = unwrap(node);
  return ts.isIdentifier(node) && node.text === name;
}

export function isMember(node: ts.Node | undefined, receiver: string, name: string): boolean {
  if (!node) return false;
  node = unwrap(node);
  return (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isIdentifier(node.expression, receiver) && memberName(node) === name;
}

function isTextProperty(name: string | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  // Reflected ARIA properties use camel case (ariaLabel); bracketed attributes
  // use aria-label. Both are displays, as are tooltips and image alternatives.
  return TEXT_PROPERTIES.has(name) || lower === "title" || lower === "alt" || lower === "placeholder" || lower.startsWith("aria-") || (name.startsWith("aria") && name.length > 4 && name[4] !== name[4].toLowerCase());
}

function isTextAttribute(name: string): boolean {
  name = name.toLowerCase();
  return name === "title" || name === "alt" || name === "placeholder" || name.startsWith("aria-");
}

function functionName(node: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) && node.name) return literalName(node.name);
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (ts.isVariableDeclaration(node.parent)) return literalName(node.parent.name);
  }
  return undefined;
}

function nearestFunction(node: ts.Node): ts.Node | undefined {
  for (let p = node.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p;
  return undefined;
}

export function enclosingNamedFunction(node: ts.Node): string | undefined {
  for (let p = node.parent; p; p = p.parent) {
    const name = functionName(p);
    if (name) return name;
  }
  return undefined;
}

/** Resolve only an immutable local binding; unknown/parameter/shadowed origins fail closed. */
export function localConstInitializer(node: ts.Node, name: string): ts.Expression | undefined {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isBlock(p) || ts.isSourceFile(p)) {
      for (const statement of p.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (!isIdentifier(declaration.name, name)) continue;
          return statement.declarationList.flags & ts.NodeFlags.Const && declaration.pos < node.pos ? declaration.initializer : undefined;
        }
      }
    }
    if (ts.isFunctionLike(p) && p.parameters.some((parameter) => isIdentifier(parameter.name, name))) return undefined;
  }
  return undefined;
}

export function isElementCreation(node: ts.Node | undefined): boolean {
  if (!node) return false;
  node = unwrap(node);
  return ts.isCallExpression(node) && isMember(node.expression, "document", "createElement");
}

/** Parse TS or JS; sink bodies are the only general exemptions. All insertion
 * methods that accept strings are forbidden unless a reviewed, Node-only call
 * has a small explicit allowance. This avoids guessing whether an argument is
 * safe from its spelling or treating every identifier as a Node. */
export function lintTextSinks(source: string, config: TextSinkConfig): TextSinkIssue[] {
  const file = ts.createSourceFile(config.file, source, ts.ScriptTarget.Latest, true, config.scriptKind);
  const issues: TextSinkIssue[] = [];
  const definitions = new Map(config.sinks.map((name) => [name, [] as ts.Node[]]));
  const report = (node: ts.Node, rule: string) => {
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
    issues.push({ file: config.file, line: line + 1, column: character + 1, rule });
  };
  const collect = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) {
      const name = functionName(node);
      if (name) definitions.get(name)?.push(node);
    }
    ts.forEachChild(node, collect);
  };
  collect(file);
  const sinks = new Set<ts.Node>();
  for (const [name, nodes] of definitions) {
    if (nodes.length === 1) sinks.add(nodes[0]);
    else report(nodes[1] ?? file, `sink ${name} must have exactly one definition (found ${nodes.length})`);
  }
  const attributeMethods = new Set(config.attributeMethods ?? ["setAttribute"]);
  const checkTarget = (node: ts.Node): void => {
    node = unwrap(node);
    if (isTextProperty(memberName(node))) report(node, `text property write: ${memberName(node)}`);
    else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) checkTarget(property.initializer);
        else if (ts.isSpreadAssignment(property)) checkTarget(property.expression);
      }
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) checkTarget(ts.isSpreadElement(element) ? element.expression : element);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) checkTarget(node.left);
  };
  const visit = (node: ts.Node): void => {
    // A nested callback in a sink is not the sink itself and receives no exemption.
    if (!sinks.has(nearestFunction(node) as ts.Node)) {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) checkTarget(node.left);
      if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) checkTarget(node.initializer);
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) checkTarget(node.operand);
      if (ts.isCallExpression(node)) {
        const method = calledName(node.expression);
        if (method === "createTextNode" || method === "insertAdjacentText") report(node, `text insertion call: ${method}`);
        if (method && NODE_OR_TEXT_METHODS.has(method) && !(config.allowedNodeCalls ?? []).some((allowance) => allowance.reason.trim() && allowance.matches(node))) report(node, `string-capable insertion call: ${method}`);
        if (method && (attributeMethods.has(method) || method === "setAttributeNS")) {
          const key = node.arguments[method === "setAttributeNS" ? 1 : 0];
          const name = key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) ? key.text : undefined;
          if (name === undefined || isTextAttribute(name)) report(node, name === undefined ? `dynamic attribute write: ${method}` : `text attribute write: ${name}`);
        }
        if (isMember(calledExpression(node.expression), "Object", "assign") && !isMember(node.expression, "Object", "assign")) report(node, "indirect Object.assign may write text properties");
        if (isMember(node.expression, "Object", "assign")) {
          for (const argument of node.arguments.slice(1)) {
            const value = unwrap(argument);
            if (!ts.isObjectLiteralExpression(value)) report(argument, "Object.assign source may contain text properties");
            else for (const property of value.properties) {
              const name = "name" in property ? literalName(property.name) : undefined;
              if (ts.isSpreadAssignment(property) || name === undefined) report(property, "Object.assign source may contain text properties");
              else if (isTextProperty(name)) report(property, `Object.assign text property: ${name}`);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return issues;
}
