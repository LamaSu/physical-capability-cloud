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

export interface TextMintHelper {
  name: string;
  /** Explain the grammar or trusted source that permits this helper to mint text. */
  reason: string;
}

export interface TextMintConfig {
  /** The module-private function that creates and registers runtime brands. */
  mint: string;
  /** The PCC-copy helper, whose callers outside helpers must supply literals. */
  kitText: string;
  helpers: readonly TextMintHelper[];
}

export interface TextComputedWriteAllowance {
  /** Only this named function may write computed keys to this exact binding. */
  function: string;
  target: string;
  reason: string;
}

export interface TextComputedReadAllowance extends TextComputedWriteAllowance {
  /** Optional parameter key for one read guarded by propertyIsEnumerable; otherwise require a fresh local. */
  ownKey?: string;
}

export interface AgentTextConfig {
  /** The sole claim-checking agent brand mint and sole marked agent sink. */
  mint: string;
  sink: string;
  reason: string;
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
  /** JS runtime brands use separate syntactic mint checks. */
  textMints?: TextMintConfig;
  agentText?: AgentTextConfig;
  allowedComputedWrites?: readonly TextComputedWriteAllowance[];
  /** Computed reads require a reviewed fresh local or one exact enumerable-own-data guard. */
  allowedComputedReads?: readonly TextComputedReadAllowance[];
}

const TEXT_PROPERTIES = new Set(["text", "textContent", "innerText", "outerText", "nodeValue", "data", "innerHTML", "outerHTML", "srcdoc", "value", "defaultValue", "label"]);
const NODE_OR_TEXT_METHODS = new Set(["append", "prepend", "before", "after", "replaceWith", "replaceChildren"]);
const TEXT_INSERTION_METHODS = new Set(["createTextNode", "insertAdjacentText", "appendData", "insertData", "replaceData", "replaceWholeText"]);
const HTML_METHODS = new Set(["insertAdjacentHTML", "write", "writeln", "setHTMLUnsafe", "setHTML"]);
const PARSER_METHODS = new Set(["createContextualFragment", "parseFromString", "parseHTMLUnsafe"]);
const NAMED_TEXT_METHODS = new Set(["setRangeText", "setCustomValidity", "insertRule", "replaceSync", "fillText", "strokeText", "execCommand", "setNamedItem"]);
const FORBIDDEN_METHODS = new Set([...NODE_OR_TEXT_METHODS, ...TEXT_INSERTION_METHODS, ...HTML_METHODS, ...PARSER_METHODS, ...NAMED_TEXT_METHODS, "replace", "setAttribute", "setAttributeNS", "setAttributeNode"]);
const OBJECT_REFLECTION_METHODS = new Set(["defineProperty", "defineProperties", "setPrototypeOf", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors"]);
const SETTER_METHODS = new Set(["__defineSetter__", "__lookupSetter__"]);
const TEXT_CONSTRUCTORS = new Set(["Text", "Option", "DOMParser", "Notification"]);
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

/** A strict comparison with a literal produces a boolean, never an alias or a
 * callable reference. Manifest action.confirm is data used this way. */
function isLiteralComparison(node: ts.Node): boolean {
  let expression = node;
  for (;;) {
    const parent = expression.parent;
    if (!parent || !(ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent) || ts.isNonNullExpression(parent) || ts.isSatisfiesExpression(parent)) || parent.expression !== expression) break;
    expression = parent;
  }
  const parent = expression.parent;
  if (!ts.isBinaryExpression(parent) || (parent.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken && parent.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken)) return false;
  return ts.isStringLiteral(unwrap(parent.left === expression ? parent.right : parent.left));
}

function isLiteralOnlyText(node: ts.Node | undefined): boolean {
  if (!node) return false;
  node = unwrap(node);
  return ts.isStringLiteral(node) || (ts.isConditionalExpression(node) && isLiteralOnlyText(node.whenTrue) && isLiteralOnlyText(node.whenFalse));
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

function variableScope(node: ts.VariableDeclaration): ts.Node {
  const lexical = ts.isVariableDeclarationList(node.parent) && !!(node.parent.flags & ts.NodeFlags.BlockScoped);
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isSourceFile(p) || ts.isFunctionLike(p) || (lexical && ts.isBlock(p))) return p;
  }
  return node.getSourceFile();
}

/** Bindings are resolved by scope, rather than by matching a variable spelling.
 * A var is function-scoped; a let/const, catch parameter, or function parameter
 * that shadows it cannot borrow the reviewed object's allowance. */
function bindingResolver(file: ts.SourceFile): (node: ts.Node, name: string) => ts.Node[] | undefined {
  const scopes = new Map<ts.Node, Map<string, ts.Node[]>>();
  const add = (scope: ts.Node, name: string, declaration: ts.Node) => {
    let bindings = scopes.get(scope);
    if (!bindings) scopes.set(scope, bindings = new Map());
    const declarations = bindings.get(name) ?? [];
    declarations.push(declaration);
    bindings.set(name, declarations);
  };
  const addName = (scope: ts.Node, name: ts.BindingName, declaration: ts.Node) => {
    if (ts.isIdentifier(name)) add(scope, name.text, declaration);
    else for (const element of name.elements) if (ts.isBindingElement(element)) addName(scope, element.name, declaration);
  };
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const scope = ts.isCatchClause(node.parent) ? node.parent : variableScope(node);
      addName(scope, node.name, node);
    }
    if (ts.isFunctionLike(node)) for (const parameter of node.parameters) addName(node, parameter.name, parameter);
    if (ts.isFunctionDeclaration(node) && node.name) {
      const scope = nearestFunction(node) ?? file;
      add(scope, node.name.text, node);
    }
    ts.forEachChild(node, collect);
  };
  collect(file);
  return (node, name) => {
    for (let p = node.parent; p; p = p.parent) {
      const declarations = scopes.get(p)?.get(name);
      if (declarations) return declarations;
    }
    return undefined;
  };
}

function isReassignmentIdentifier(node: ts.Identifier): boolean {
  let target: ts.Node = node;
  for (;;) {
    const parent = target.parent;
    if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent) || ts.isNonNullExpression(parent) || ts.isSatisfiesExpression(parent)) { target = parent; continue; }
    // Destructuring writes can be nested, but a member's receiver/key is a read.
    if ((ts.isPropertyAssignment(parent) && parent.initializer === target) || ts.isShorthandPropertyAssignment(parent) || ts.isArrayLiteralExpression(parent) || ts.isObjectLiteralExpression(parent) || ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent)) { target = parent; continue; }
    if (ts.isBinaryExpression(parent) && parent.left === target && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return true;
    if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) return true;
    return (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === target;
  }
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

/** Named DOM API denylist, plus computed-read/write and .constructor rules.
 * It does not prove closure over all DOM APIs. Sink bodies are the general
 * exemptions; named string-capable insertion calls need reviewed Node-only allowances.
 * Type-aware IR checks additionally reject unresolved/any expressions. */
export function lintTextSinks(source: string, config: TextSinkConfig): TextSinkIssue[] {
  const file = ts.createSourceFile(config.file, source, ts.ScriptTarget.Latest, true, config.scriptKind);
  const issues: TextSinkIssue[] = [];
  const definitions = new Map(config.sinks.map((name) => [name, [] as ts.Node[]]));
  const mintConfig = config.textMints;
  const agentConfig = config.agentText;
  const agentTargets = new Set(agentConfig ? [agentConfig.mint, agentConfig.sink] : []);
  const agentDefinitions = new Map([...agentTargets].map((name) => [name, [] as ts.Node[]]));
  const allFunctions = new Map<string, ts.Node[]>();
  const mintTargets = new Set(mintConfig ? [mintConfig.mint, mintConfig.kitText] : []);
  const mintDefinitions = new Map((mintConfig ? [mintConfig.mint, mintConfig.kitText, ...mintConfig.helpers.map((helper) => helper.name)] : []).map((name) => [name, [] as ts.Node[]]));
  const report = (node: ts.Node, rule: string) => {
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
    issues.push({ file: config.file, line: line + 1, column: character + 1, rule });
  };
  const collect = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) {
      const name = functionName(node);
      if (name) definitions.get(name)?.push(node);
      if (name) mintDefinitions.get(name)?.push(node);
      if (name) agentDefinitions.get(name)?.push(node);
      if (name) {
        const named = allFunctions.get(name) ?? [];
        named.push(node);
        allFunctions.set(name, named);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(file);
  const sinks = new Set<ts.Node>();
  for (const [name, nodes] of definitions) {
    if (nodes.length === 1) sinks.add(nodes[0]);
    else report(nodes[1] ?? file, `sink ${name} must have exactly one definition (found ${nodes.length})`);
  }
  const mintHelpers = new Map<string, ts.Node>();
  const usedMintHelpers = new Set<string>();
  if (mintConfig) {
    for (const [name, nodes] of mintDefinitions) {
      if (nodes.length !== 1) report(nodes[1] ?? file, `text mint function ${name} must have exactly one definition (found ${nodes.length})`);
    }
    for (const helper of mintConfig.helpers) {
      if (!helper.reason.trim()) report(file, `text mint helper ${helper.name} requires a reason`);
      const nodes = mintDefinitions.get(helper.name);
      if (nodes?.length === 1 && helper.reason.trim()) mintHelpers.set(helper.name, nodes[0]);
    }
    if (new Set(mintConfig.helpers.map((helper) => helper.name)).size !== mintConfig.helpers.length) report(file, "duplicate text mint helper allowance");
  }
  if (agentConfig) {
    if (!agentConfig.reason.trim()) report(file, "agent text boundary requires a reason");
    if (!config.sinks.includes(agentConfig.sink)) report(file, `agent text sink must be a designated sink: ${agentConfig.sink}`);
    for (const [name, nodes] of agentDefinitions) if (nodes.length !== 1) report(nodes[1] ?? file, `agent text function ${name} must have exactly one definition (found ${nodes.length})`);
  }
  const resolveBinding = bindingResolver(file);
  function isFreshObject(node: ts.Node | undefined): boolean {
    if (!node) return false;
    node = unwrap(node);
    return (ts.isObjectLiteralExpression(node) && node.properties.length === 0) ||
      (ts.isCallExpression(node) && isMember(node.expression, "Object", "create") && !resolveBinding(node, "Object") && node.arguments.length === 1 && node.arguments[0].kind === ts.SyntaxKind.NullKeyword);
  }

  const reassignedBindings = new Set<ts.Node>();
  const findReassignments = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isReassignmentIdentifier(node)) {
      const declarations = resolveBinding(node, node.text);
      for (const declaration of declarations ?? []) reassignedBindings.add(declaration);
    }
    ts.forEachChild(node, findReassignments);
  };
  findReassignments(file);
  const usedComputedAllowances = new Set<TextComputedWriteAllowance>();
  const computedAllowances = config.allowedComputedWrites ?? [];
  const allowanceKeys = new Set<string>();
  for (const allowance of computedAllowances) {
    if (!allowance.reason.trim()) report(file, `computed write allowance ${allowance.function}.${allowance.target} requires a reason`);
    if (allFunctions.get(allowance.function)?.length !== 1) report(file, `computed write allowance function must have exactly one definition: ${allowance.function}`);
    const key = `${allowance.function}.${allowance.target}`;
    if (allowanceKeys.has(key)) report(file, `duplicate computed write allowance: ${key}`);
    allowanceKeys.add(key);
  }
  const isAllowedComputedWrite = (node: ts.ElementAccessExpression): boolean => {
    const receiver = unwrap(node.expression);
    if (!ts.isIdentifier(receiver)) return false;
    const owner = nearestFunction(node);
    const name = owner && functionName(owner);
    const allowance = computedAllowances.find((entry) => entry.function === name && entry.target === receiver.text && entry.reason.trim());
    if (!allowance) return false;
    usedComputedAllowances.add(allowance);
    const declarations = resolveBinding(receiver, receiver.text);
    if (allFunctions.get(allowance.function)?.length !== 1 || declarations?.length !== 1 || !ts.isVariableDeclaration(declarations[0]) || declarations[0].pos >= node.pos || !isFreshObject(declarations[0].initializer) || reassignedBindings.has(declarations[0])) {
      report(node, `computed write target must be a fresh unreassigned object: ${allowance.function}.${allowance.target}`);
      return false;
    }
    return true;
  };
  const readAllowances = config.allowedComputedReads ?? [];
  const usedReadAllowances = new Set<TextComputedWriteAllowance>();
  const isAllowedComputedRead = (node: ts.ElementAccessExpression): boolean => {
    if (isAllowedComputedWrite(node)) return true;
    const receiver = unwrap(node.expression);
    const owner = nearestFunction(node);
    if (!ts.isIdentifier(receiver) || !owner) return false;
    const allowance = readAllowances.find((entry) => entry.function === functionName(owner) && entry.target === receiver.text && entry.reason.trim());
    if (!allowance) return false;
    usedReadAllowances.add(allowance);
    const declarations = resolveBinding(receiver, receiver.text);
    if (allowance.ownKey !== undefined) {
      const key = node.argumentExpression;
      const conditional = node.parent;
      const guard = ts.isConditionalExpression(conditional) && conditional.whenTrue === node && isIdentifier(conditional.whenFalse, "undefined") ? conditional.condition : undefined;
      const call = guard && ts.isCallExpression(guard) ? guard : undefined;
      const member = call && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "call" ? call.expression.expression : undefined;
      const enumerable = member && ts.isPropertyAccessExpression(member) && member.name.text === "propertyIsEnumerable" && isMember(member.expression, "Object", "prototype") && !resolveBinding(member, "Object");
      const keyDeclarations = key && ts.isIdentifier(key) ? resolveBinding(key, key.text) : undefined;
      const parameters = ts.isFunctionDeclaration(owner) ? owner.parameters : undefined;
      if (allFunctions.get(allowance.function)?.length !== 1 || parameters?.length !== 2 ||
          !isIdentifier(parameters[0].name, allowance.target) || !isIdentifier(parameters[1].name, allowance.ownKey) ||
          declarations?.length !== 1 || declarations[0] !== parameters[0] ||
          keyDeclarations?.length !== 1 || keyDeclarations[0] !== parameters[1] ||
          reassignedBindings.has(parameters[0]) || reassignedBindings.has(parameters[1]) ||
          !ts.isReturnStatement(conditional.parent) || !enumerable || !call || call.arguments.length !== 2 ||
          !isIdentifier(call.arguments[0], allowance.target) || !isIdentifier(call.arguments[1], allowance.ownKey) ||
          !isIdentifier(key, allowance.ownKey) || !ts.isConditionalExpression(conditional) ||
          resolveBinding(conditional.whenFalse, "undefined")) {
        report(node, `computed read requires the exact enumerable own-data guard: ${allowance.function}.${allowance.target}`);
        return false;
      }
      return true;
    }
    const declaration = declarations?.length === 1 && ts.isVariableDeclaration(declarations[0]) ? declarations[0] : undefined;
    const initializer = declaration?.initializer && unwrap(declaration.initializer);
    const clone = initializer && ts.isCallExpression(initializer) && isMember(initializer.expression, "Object", "assign") && !resolveBinding(initializer, "Object") && initializer.arguments.length === 2 && isFreshObject(initializer.arguments[0]);
    if (allFunctions.get(allowance.function)?.length !== 1 || !declaration || declaration.pos >= node.pos || reassignedBindings.has(declaration) || !(isFreshObject(initializer) || clone)) {
      report(node, `computed read target must be a fresh unreassigned object: ${allowance.function}.${allowance.target}`);
      return false;
    }
    return true;
  };
  const attributeMethods = new Set(["setAttribute", "setAttributeNS", "toggleAttribute", ...(config.attributeMethods ?? [])]);
  const allowedAttributes = new Set(config.allowedAttributes ?? []);
  const forbiddenMethods = new Set([...FORBIDDEN_METHODS, ...attributeMethods]);
  const isForbiddenName = (name: string) => isTextProperty(name) || forbiddenMethods.has(name) || OBJECT_REFLECTION_METHODS.has(name) || SETTER_METHODS.has(name);
  const checkTarget = (node: ts.Node): void => {
    node = unwrap(node);
    if (ts.isElementAccessExpression(node) && isAllowedComputedWrite(node)) return;
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
    if (agentConfig) {
      if (ts.isIdentifier(node) && agentTargets.has(node.text) && isValueIdentifier(node) && !isDirectCallTarget(node)) report(node, `agent text reference must be a direct call: ${node.text}`);
      if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && agentTargets.has(memberName(node) ?? "")) report(node, `agent text cannot be reached through a member: ${memberName(node)}`);
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const name = literalName(node.propertyName ?? node.name);
        if (name && agentTargets.has(name)) report(node, `agent text destructuring: ${name}`);
      }
      if (ts.isPropertyAssignment(node)) {
        const name = literalName(node.name);
        if (name && agentTargets.has(name) && ts.isObjectLiteralExpression(node.parent) && ts.isBinaryExpression(node.parent.parent) && node.parent.parent.left === node.parent) report(node, `agent text destructuring: ${name}`);
      }
      if (ts.isCallExpression(node)) {
        const name = calledName(node.expression);
        if (name && agentTargets.has(name) && !isIdentifier(unwrap(node.expression), name)) report(node, `indirect agent text call: ${name}`);
      }
    }
    // Mint checks apply even in sink bodies: a text sink cannot mint arbitrary
    // input. References are closed rather than trying to chase mutable aliases.
    if (mintConfig) {
      if (ts.isIdentifier(node) && mintTargets.has(node.text) && isValueIdentifier(node) && !isDirectCallTarget(node)) report(node, `text mint reference must be a direct call: ${node.text}`);
      if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && mintTargets.has(memberName(node) ?? "")) report(node, `text mint cannot be reached through a member: ${memberName(node)}`);
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const name = literalName(node.propertyName ?? node.name);
        if (name && mintTargets.has(name)) report(node, `text mint destructuring: ${name}`);
      }
      if (ts.isPropertyAssignment(node)) {
        const name = literalName(node.name);
        if (name && mintTargets.has(name) && ts.isObjectLiteralExpression(node.parent) && ts.isBinaryExpression(node.parent.parent) && node.parent.parent.left === node.parent) report(node, `text mint destructuring: ${name}`);
      }
      if (ts.isCallExpression(node)) {
        const name = calledName(node.expression);
        if (name && mintTargets.has(name)) {
          const direct = unwrap(node.expression);
          const caller = nearestFunction(node);
          const helper = caller && functionName(caller);
          const approved = !!helper && mintHelpers.get(helper) === caller;
          if (!(ts.isIdentifier(direct) && direct.text === name)) report(node, `indirect text mint call: ${name}`);
          if (name === mintConfig.mint && !approved) report(node, `text mint call outside approved helpers: ${name}`);
          const literalCopy = node.arguments.length === 1 && isLiteralOnlyText(node.arguments[0]);
          if (name === mintConfig.kitText && !approved && !literalCopy) report(node, `kit text requires a literal-only argument: ${name}`);
          if (approved && helper && (name === mintConfig.mint || !literalCopy)) usedMintHelpers.add(helper);
        }
      }
    }
    // A nested callback in a sink is not the sink itself and receives no exemption.
    if (!sinks.has(nearestFunction(node) as ts.Node)) {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) checkTarget(node.left);
      if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) checkTarget(node.initializer);
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) checkTarget(node.operand);
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const name = literalName(node.propertyName ?? node.name);
        if (node.propertyName && ts.isComputedPropertyName(node.propertyName) && !isLiteralKey(node.propertyName.expression)) report(node, "dynamic method destructuring");
        if (name === "constructor") report(node, "forbidden .constructor destructuring read");
        if (name && forbiddenMethods.has(name)) report(node, `forbidden method destructuring: ${name}`);
        if (name && (OBJECT_REFLECTION_METHODS.has(name) || SETTER_METHODS.has(name) || REFLECTION_REFERENCES.has(name))) report(node, `forbidden reflection destructuring: ${name}`);
        if (name && (TEXT_CONSTRUCTORS.has(name) || DIALOGS.has(name))) report(node, `forbidden display API destructuring: ${name}`);
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const method = memberName(node);
        const writeTarget = ts.isBinaryExpression(node.parent) && node.parent.left === node && node.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
        if (config.scriptKind === ts.ScriptKind.JS && ts.isElementAccessExpression(node) && !isLiteralKey(node.argumentExpression) && !writeTarget && !isAllowedComputedRead(node)) report(node, "dynamic computed property read");
        if (method === "constructor" && !writeTarget) report(node, "forbidden .constructor read");
        if (method && forbiddenMethods.has(method) && !isDirectCallTarget(node)) report(node, `forbidden method read: ${method}`);
        if (method && SETTER_METHODS.has(method)) report(node, `forbidden setter reflection: ${method}`);
        if (isBuiltinReference(node.expression, "Reflect") && !isAllowedOwnKeys(node)) report(node, "forbidden Reflect access");
        if (method === "Reflect" && !isAllowedOwnKeys(node)) report(node, "forbidden Reflect reference");
        if (method === "Proxy" || method === "eval" || method === "Function") report(node, `forbidden reflection reference: ${method}`);
        if (method === "Object" && !isMemberReceiver(node)) report(node, "Object used as a value may hide reflection");
        if (method && TEXT_CONSTRUCTORS.has(method)) report(node, `text-carrying constructor reference: ${method}`);
        if (method && DIALOGS.has(method) && !isDirectCallTarget(node) && !isLiteralComparison(node)) report(node, `text dialog reference: ${method}`);
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
        if (method && NAMED_TEXT_METHODS.has(method)) report(node, `named text API call: ${method}`);
        // Only an explicit String(...) or literal receiver distinguishes string data
        // manipulation from CSSStyleSheet.replace; extra arguments do not do so.
        const receiver = (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) ? unwrap(node.expression.expression) : undefined;
        const stringReceiver = receiver && (ts.isStringLiteral(receiver) || ts.isNoSubstitutionTemplateLiteral(receiver)
          || (ts.isCallExpression(receiver) && isIdentifier(receiver.expression, "String") && !resolveBinding(receiver.expression, "String") && receiver.arguments.length === 1));
        if (method === "replace" && !stringReceiver) report(node, "stylesheet text call: replace");
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
          // The first argument is the sole write target. An inline object literal
          // is fresh and cannot be a DOM node; every other target fails closed.
          const target = node.arguments[0];
          if (!target || !(ts.isObjectLiteralExpression(unwrap(target)) || isFreshObject(target))) report(node, "Object.assign target must be a fresh object literal");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (mintConfig) for (const helper of mintConfig.helpers) {
    if (!usedMintHelpers.has(helper.name)) report(mintHelpers.get(helper.name) ?? file, `stale text mint helper allowance: ${helper.name}`);
  }
  for (const allowance of computedAllowances) if (!usedComputedAllowances.has(allowance)) report(file, `stale computed write allowance: ${allowance.function}.${allowance.target}`);
  for (const allowance of readAllowances) if (!usedReadAllowances.has(allowance)) report(file, `stale computed read allowance: ${allowance.function}.${allowance.target}`);
  return issues;
}
