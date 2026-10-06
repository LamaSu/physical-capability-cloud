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

export interface TextSinkArgumentAllowance {
  /** Explain why this exact string names data rather than a writable DOM member. */
  reason: string;
  matches(call: ts.CallExpression, argument: ts.Expression): boolean;
}

export interface TextSinkConfig {
  file: string;
  scriptKind: ts.ScriptKind;
  sinks: readonly string[];
  /** Include an adapter's attribute-forwarding method as well as the DOM method. */
  attributeMethods?: readonly string[];
  /** Only these literal metadata attributes may be written; absent means none. */
  allowedAttributes?: readonly string[];
  allowedNodeCalls?: readonly TextSinkCallAllowance[];
  allowedNameArguments?: readonly TextSinkArgumentAllowance[];
}

const TEXT_PROPERTIES = new Set(["textContent", "innerText", "outerText", "nodeValue", "data", "innerHTML", "outerHTML", "srcdoc", "value", "defaultValue", "label"]);
const NODE_OR_TEXT_METHODS = new Set(["append", "prepend", "before", "after", "replaceWith", "replaceChildren"]);
const TEXT_INSERTION_METHODS = new Set(["createTextNode", "insertAdjacentText", "appendData", "insertData", "replaceData", "replaceWholeText"]);
const HTML_METHODS = new Set(["insertAdjacentHTML", "write", "writeln", "setHTMLUnsafe", "setHTML"]);
const PARSER_METHODS = new Set(["createContextualFragment", "parseFromString"]);
const FORBIDDEN_METHODS = new Set([...NODE_OR_TEXT_METHODS, ...TEXT_INSERTION_METHODS, ...HTML_METHODS, ...PARSER_METHODS, "setAttribute", "setAttributeNS", "setAttributeNode"]);
const OBJECT_REFLECTION_METHODS = new Set(["defineProperty", "defineProperties", "setPrototypeOf", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors"]);
const SETTER_METHODS = new Set(["__defineSetter__", "__lookupSetter__"]);
const TEXT_CONSTRUCTORS = new Set(["Text", "Option", "DOMParser"]);
const DIALOGS = new Set(["alert", "confirm", "prompt"]);
const REFLECTION_REFERENCES = new Set(["Reflect", "Proxy", "eval", "Function", "Object"]);

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

/** Parentheses and type-only wrappers do not make a direct call an alias read. */
function isDirectCallTarget(node: ts.Node): boolean {
  let expression = node;
  for (;;) {
    const parent = expression.parent;
    if (!parent || !(ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent) || ts.isNonNullExpression(parent) || ts.isSatisfiesExpression(parent)) || parent.expression !== expression) break;
    expression = parent;
  }
  return ts.isCallExpression(expression.parent) && expression.parent.expression === expression;
}

function isBuiltinReference(node: ts.Node, name: string): boolean {
  return isIdentifier(node, name) || memberName(node) === name;
}

function isLiteralKey(node: ts.Node | undefined): boolean {
  if (!node) return false;
  node = unwrap(node);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) return true;
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return true;
  return ts.isPrefixUnaryExpression(node) && (node.operator === ts.SyntaxKind.PlusToken || node.operator === ts.SyntaxKind.MinusToken) && ts.isNumericLiteral(node.operand);
}

function isMemberReceiver(node: ts.Node): boolean {
  return (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) && node.parent.expression === node;
}

function isValueIdentifier(node: ts.Identifier): boolean {
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isTypeNode(parent) || ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return false;
  }
  const parent = node.parent;
  if ((ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node)) return false;
  if ("name" in parent && parent.name === node && !ts.isShorthandPropertyAssignment(parent)) return false;
  return !ts.isLabeledStatement(parent) && !ts.isBreakOrContinueStatement(parent);
}

function isAllowedOwnKeys(node: ts.Node): boolean {
  if (isBuiltinReference(node, "Reflect") && isMemberReceiver(node)) node = node.parent;
  return (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isBuiltinReference(node.expression, "Reflect") && memberName(node) === "ownKeys" && isDirectCallTarget(node);
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
  const attributeMethods = new Set(["setAttribute", "setAttributeNS", "toggleAttribute", ...(config.attributeMethods ?? [])]);
  const allowedAttributes = new Set(config.allowedAttributes ?? []);
  const forbiddenMethods = new Set([...FORBIDDEN_METHODS, ...attributeMethods]);
  const isForbiddenName = (name: string) => isTextProperty(name) || forbiddenMethods.has(name) || OBJECT_REFLECTION_METHODS.has(name) || SETTER_METHODS.has(name);
  const checkTarget = (node: ts.Node): void => {
    node = unwrap(node);
    if (ts.isElementAccessExpression(node) && !isLiteralKey(node.argumentExpression)) report(node, "dynamic computed property write");
    else if (isTextProperty(memberName(node))) report(node, `text property write: ${memberName(node)}`);
    else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        const name = "name" in property ? literalName(property.name) : undefined;
        if ("name" in property && property.name && ts.isComputedPropertyName(property.name) && !isLiteralKey(property.name.expression)) report(property, "dynamic method destructuring");
        if (name && forbiddenMethods.has(name)) report(property, `forbidden method destructuring: ${name}`);
        if (name && (OBJECT_REFLECTION_METHODS.has(name) || SETTER_METHODS.has(name) || REFLECTION_REFERENCES.has(name))) report(property, `forbidden reflection destructuring: ${name}`);
        if (name && (TEXT_CONSTRUCTORS.has(name) || DIALOGS.has(name))) report(property, `forbidden display API destructuring: ${name}`);
        if (ts.isPropertyAssignment(property)) checkTarget(property.initializer);
        else if (ts.isSpreadAssignment(property)) checkTarget(property.expression);
      }
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) checkTarget(ts.isSpreadElement(element) ? element.expression : element);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) checkTarget(node.left);
  };
  const visit = (node: ts.Node): void => {
    // Types describe a surface but cannot read a method or render a byte.
    if (ts.isTypeNode(node)) return;
    // A nested callback in a sink is not the sink itself and receives no exemption.
    if (!sinks.has(nearestFunction(node) as ts.Node)) {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) checkTarget(node.left);
      if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) checkTarget(node.initializer);
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) checkTarget(node.operand);
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const name = literalName(node.propertyName ?? node.name);
        if (node.propertyName && ts.isComputedPropertyName(node.propertyName) && !isLiteralKey(node.propertyName.expression)) report(node, "dynamic method destructuring");
        if (name && forbiddenMethods.has(name)) report(node, `forbidden method destructuring: ${name}`);
        if (name && (OBJECT_REFLECTION_METHODS.has(name) || SETTER_METHODS.has(name) || REFLECTION_REFERENCES.has(name))) report(node, `forbidden reflection destructuring: ${name}`);
        if (name && (TEXT_CONSTRUCTORS.has(name) || DIALOGS.has(name))) report(node, `forbidden display API destructuring: ${name}`);
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const method = memberName(node);
        if (method && forbiddenMethods.has(method) && !isDirectCallTarget(node)) report(node, `forbidden method read: ${method}`);
        if (method && SETTER_METHODS.has(method)) report(node, `forbidden setter reflection: ${method}`);
        if (isBuiltinReference(node.expression, "Reflect") && !isAllowedOwnKeys(node)) report(node, "forbidden Reflect access");
        if (method === "Reflect" && !isAllowedOwnKeys(node)) report(node, "forbidden Reflect reference");
        if (method === "Proxy" || method === "eval" || method === "Function") report(node, `forbidden reflection reference: ${method}`);
        if (method === "Object" && !isMemberReceiver(node)) report(node, "Object used as a value may hide reflection");
        if (method && TEXT_CONSTRUCTORS.has(method)) report(node, `text-carrying constructor reference: ${method}`);
        if (method && DIALOGS.has(method) && !isDirectCallTarget(node)) report(node, `text dialog reference: ${method}`);
        if (isBuiltinReference(node.expression, "Object")) {
          if (method === undefined || (method && OBJECT_REFLECTION_METHODS.has(method))) report(node, `forbidden Object reflection: ${method ?? "dynamic member"}`);
          if (method === "assign" && !isDirectCallTarget(node)) report(node, "Object.assign used as a value may write text properties");
        }
      }
      if (ts.isIdentifier(node) && isValueIdentifier(node)) {
        if (node.text === "Reflect" && !isAllowedOwnKeys(node)) report(node, "forbidden Reflect reference");
        if (node.text === "Proxy" || node.text === "eval" || node.text === "Function") report(node, `forbidden reflection reference: ${node.text}`);
        // Copying the reflection object would hide later assign/descriptor calls.
        if (node.text === "Object" && !isMemberReceiver(node)) report(node, "Object used as a value may hide reflection");
        if (TEXT_CONSTRUCTORS.has(node.text)) report(node, `text-carrying constructor reference: ${node.text}`);
        if (DIALOGS.has(node.text) && !isDirectCallTarget(node)) report(node, `text dialog reference: ${node.text}`);
      }
      if (ts.isNewExpression(node)) {
        const constructor = calledName(node.expression);
        if (constructor && TEXT_CONSTRUCTORS.has(constructor)) report(node, `text-carrying constructor: ${constructor}`);
      }
      if (ts.isCallExpression(node)) {
        const method = calledName(node.expression);
        if (method && TEXT_INSERTION_METHODS.has(method)) report(node, `text insertion call: ${method}`);
        if (method && HTML_METHODS.has(method)) report(node, `HTML insertion call: ${method}`);
        if (method && PARSER_METHODS.has(method)) report(node, `text parser call: ${method}`);
        if (method === "setAttributeNode") report(node, "attribute node insertion call: setAttributeNode");
        if (method && DIALOGS.has(method)) report(node, `text dialog call: ${method}`);
        if (method && NODE_OR_TEXT_METHODS.has(method) && !(config.allowedNodeCalls ?? []).some((allowance) => allowance.reason.trim() && allowance.matches(node))) report(node, `string-capable insertion call: ${method}`);
        if (method && attributeMethods.has(method)) {
          const key = node.arguments[method === "setAttributeNS" ? 1 : 0];
          const literal = key && unwrap(key);
          const name = literal && (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) ? literal.text : undefined;
          if (name === undefined || !allowedAttributes.has(name)) report(node, name === undefined ? `dynamic attribute write: ${method}` : `unapproved attribute write: ${name}`);
        }
        for (const argument of node.arguments) {
          const literal = unwrap(argument);
          if ((ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) && isForbiddenName(literal.text) && !(config.allowedNameArguments ?? []).some((allowance) => allowance.reason.trim() && allowance.matches(node, argument))) report(argument, `forbidden member name argument: ${literal.text}`);
        }
        const called = calledExpression(node.expression);
        const direct = unwrap(node.expression);
        const isObjectAssign = (expression: ts.Node) => (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) && isBuiltinReference(expression.expression, "Object") && memberName(expression) === "assign";
        if (isObjectAssign(called) && !isObjectAssign(direct)) report(node, "indirect Object.assign may write text properties");
        if (isObjectAssign(direct)) {
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
