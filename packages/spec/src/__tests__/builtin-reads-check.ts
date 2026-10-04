/**
 * The DEFAULT-DENY check behind profile-admission-builtins.test.ts (steward DECISIONS 01:30 and
 * #6792, astra packs 289, 291). A copy of this file serves @pcc/kernel's evidence emitter; the two
 * differ only in the `CheckOptions` their tests pass.
 *
 * It walks EVERY node of the trusted path that runs after load, and a node passes only if it is one
 * of the forms named below, under that form's condition. Anything else is reported, so syntax
 * nobody listed fails closed instead of slipping through. It uses the TypeScript checker, so every
 * condition that depends on a value's type reads the static type, with built-ins resolved through
 * subtypes, intersections and type-parameter constraints.
 *
 * What runs at load is exempt, since nothing a caller does can precede it. That covers top-level
 * `const` initializers, a function called right where it is written there (`(() => ...)()`), and a
 * top-level class's `extends` clause. Any other function body runs later and is walked like the
 * rest. Type positions are erased and are not walked.
 *
 * The forms that pass (each listed in `checkNode` below):
 *   - literals (string, number, bigint, true, false, null, a template with no substitution);
 *   - an identifier that is a local, a parameter, a load-time capture or an import from a non-node:
 *     module. NOT a global the default library declares (except the read-only undefined, NaN and
 *     Infinity), and NOT a binding or namespace imported from a node: module, which Node can re-sync
 *     after load;
 *   - `this`; `super(...)` in a constructor;
 *   - a template whose every substitution is a primitive (an object's toString would be looked up);
 *   - a property read: on a built-in only `length` of an array or a string (own data); on a module
 *     namespace never; on anything else, allowed. This one trusts the static type: a property the
 *     type declares is taken to be present. Every input is `unknown` until plain-data copies it into
 *     null-prototype records and dense arrays, and a read on `unknown` or `any` is refused;
 *   - an element read, whose key must be a string, number or symbol (ToPropertyKey of anything
 *     else looks up its toString):
 *       - an integer-indexed element of a typed array, always;
 *       - an element of an array, a string or any record only where it is proven OWN, with nothing
 *         running in between (a string's element is read through a captured `charAt`, which never
 *         reaches String.prototype; a loop bound is no proof, astra pack 293): `hasOwn(x, k) ? x[k] : ...`, `hasOwn(x, k) && x[k]`, or
 *         `if (hasOwn(x, k))` whose branch begins with the read. The trusted hasOwn is the last
 *         thing the guard evaluates (alone, or the rightmost operand of a chain of `&&`), the read
 *         is the first thing the guarded part evaluates, and `x` and `k` are the same bindings (or
 *         the same literal key). A call or an assignment in between could remove the property;
 *       - any key of a binding declared `const x = ObjectCreate(null)`, with the trusted
 *         ObjectCreate (CheckOptions.primordials), which has no prototype;
 *   - a call whose callee is an identifier (a function value), `this.#private`, or `super`, under
 *     any parentheses, `!`, `as`, `satisfies` or `<T>`;
 *   - `new` of an identifier;
 *   - unary `!`, `-`, `~`, `typeof`, `void`, and `++`/`--` on a writable target. `-` and `~` need a
 *     primitive operand;
 *   - binary arithmetic, bitwise, logical, `===` and `!==`. `+`, `<`, `<=`, `>`, `>=` and
 *     compound arithmetic assignment need primitive operands (an object's valueOf or toString would
 *     be looked up);
 *   - assignment to a local, to `this.#private`, to an integer element of a typed array, to a
 *     property or element of a binding declared `const x = ObjectCreate(null)` (a write elsewhere
 *     could run an inherited setter), or to `length` of an array, with a primitive value (an array's
 *     length is own data: setting it runs no setter, and shrinking deletes only own elements);
 *   - the conditional operator, parentheses, `as`, `!` (non-null), `satisfies` and `<T>` assertions;
 *   - arrow functions and function expressions (their bodies are walked);
 *   - an object literal whose members are plain, shorthand, method or accessor definitions with
 *     identifier, string or number keys, or computed keys of a primitive type. A spread is refused;
 *   - an array literal without spreads or holes;
 *   - `await` of a call to one of `CheckOptions.awaitWrappers` (they pin the promise first);
 *   - the statements block, variable, expression, if, for (classic), while, do, return, throw, try,
 *     catch, break, continue, switch, case, default, empty and labeled, plus function and class
 *     declarations and their members.
 * Everything else is refused: `in`, `instanceof`, `==`, `!=`, `delete`, `for...in`, `for...of`,
 * spread, array destructuring, object destructuring of a built-in, a tagged template, a regular
 * expression literal, `yield`, `import()`, `import.meta`, `with`, `debugger`, a decorator, a class
 * expression, and any form not named here.
 */
import ts from "typescript";

export interface CheckOptions {
  /**
   * The files whose `hasOwn` (a function declaration) and `ObjectCreate` (a top-level
   * `const ObjectCreate = Object.create`) are trusted: a look-alike declared anywhere else is not.
   */
  primordials: RegExp;
  /** Calls that pin a promise before it is awaited: `await` takes only a call of one of these. */
  awaitWrappers: ReadonlySet<string>;
}

const TYPED_ARRAYS = new Set([
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
  "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array", "Buffer",
]);
const BUILTIN_OBJECTS = new Set([
  ...TYPED_ARRAYS,
  "ArrayBuffer", "SharedArrayBuffer", "DataView",
  "Map", "ReadonlyMap", "Set", "ReadonlySet", "WeakMap", "WeakSet", "WeakRef",
  "Promise", "PromiseLike", "RegExp", "RegExpMatchArray", "Date", "Error", "Function", "CallableFunction", "NewableFunction",
]);
const ARRAYS = new Set(["Array", "ReadonlyArray"]);
const READ_ONLY_GLOBALS = new Set(["undefined", "NaN", "Infinity"]);
const PRIMITIVE = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.BooleanLike |
  ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never | ts.TypeFlags.EnumLike;
/** What a key may be: ToPropertyKey of anything else looks up its toString or valueOf. */
const PROPERTY_KEY = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.ESSymbolLike;

/** "file:line what: text" for each node of `fileName` (or of its named top-level functions) that is not an allowed form. */
export function builtinReads(program: ts.Program, fileName: string, options: CheckOptions, functions?: ReadonlySet<string>): string[] {
  const walker = makeWalker(program, options);
  walker.walkFile(program.getSourceFile(fileName)!, functions);
  return walker.found;
}

/**
 * The trusted path's code (steward DECISIONS 04:06): the seed files' top-level code, and every
 * in-repo declaration it reaches, transitively, through ANY reference: a call, or a function passed,
 * stored or captured as a value, through imports and re-exports. It is computed from the program's
 * symbols, so a new callee joins without anyone listing it. Code `inRepo` rejects (node_modules, the
 * default library, declaration files) is not entered. A reference to it is judged by the check
 * itself: a load-time capture, a node: binding or a global.
 */
export function trustedClosure(
  program: ts.Program,
  seedFiles: readonly string[],
  inRepo: (fileName: string) => boolean,
  collaborators: ReadonlyMap<string, string> = new Map(),
): { roots: ts.Node[]; collaboratorsUsed: string[] } {
  const checker = program.getTypeChecker();
  const roots: ts.Node[] = [];
  const used = new Set<string>();
  const queued = new Set<ts.Node>();
  const enqueue = (node: ts.Node): void => {
    for (let at: ts.Node | undefined = node; at !== undefined; at = at.parent) if (queued.has(at)) return;
    queued.add(node);
    roots.push(node);
  };
  const follow = (start: ts.Symbol | undefined): void => {
    let symbol = start;
    if (symbol === undefined) return;
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    for (const declaration of symbol.declarations ?? []) {
      const source = declaration.getSourceFile();
      if (source.isDeclarationFile || !inRepo(source.fileName)) continue;
      // A collaborator the trusted code hands its results to, named with its reason, is not entered.
      const key = closureKey(declaration);
      if (collaborators.has(key)) {
        used.add(key);
        continue;
      }
      if (ts.isShorthandPropertyAssignment(declaration)) {
        follow(checker.getShorthandAssignmentValueSymbol(declaration));
      } else if (
        ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration) || ts.isConstructorDeclaration(declaration) ||
        ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration) || ts.isClassDeclaration(declaration) ||
        ts.isClassExpression(declaration) || ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration) || ts.isEnumDeclaration(declaration)
      ) {
        enqueue(declaration);
      } else if ((ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration)) && declaration.initializer !== undefined) {
        enqueue(declaration);
      }
    }
  };
  for (const file of seedFiles) enqueue(program.getSourceFile(file)!);
  for (let i = 0; i < roots.length; i++) {
    const walk = (node: ts.Node): void => {
      if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return; // erased
      if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
        follow(checker.getSymbolAtLocation(node));
        if (ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) follow(checker.getShorthandAssignmentValueSymbol(node.parent));
      }
      ts.forEachChild(node, walk);
    };
    walk(roots[i]!);
  }
  return { roots, collaboratorsUsed: [...used].sort() };
}

/** "file:Name" for a declaration, "file:Class.member" for a class member: how roots and collaborators are named. */
export function closureKey(node: ts.Node): string {
  const file = node.getSourceFile();
  const base = file.fileName.split(/[\\/]/).pop();
  if (ts.isSourceFile(node)) return `${base}:(the whole file)`;
  const name = ts.getNameOfDeclaration(node as ts.Declaration)?.getText(file) ?? ts.SyntaxKind[node.kind];
  const owner = node.parent !== undefined && (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent)) ? node.parent.name?.text : undefined;
  return `${base}:${owner !== undefined ? `${owner}.` : ""}${name}`;
}

/** "file:line what: text" for each node of the trusted closure of `seedFiles` that is not an allowed form, and what it reached. */
export function closureReads(
  program: ts.Program,
  seedFiles: readonly string[],
  options: CheckOptions,
  inRepo: (fileName: string) => boolean,
  collaborators: ReadonlyMap<string, string> = new Map(),
): { reached: string[]; found: string[]; collaboratorsUsed: string[] } {
  const { roots, collaboratorsUsed } = trustedClosure(program, seedFiles, inRepo, collaborators);
  const walker = makeWalker(program, options);
  for (const root of roots) walker.walkRoot(root);
  return { reached: roots.map(closureKey), found: [...new Set(walker.found)], collaboratorsUsed };
}

/** The check's machinery over `program`: walkFile checks a file (or named functions of it), walkRoot one reached declaration. */
function makeWalker(program: ts.Program, options: CheckOptions) {
  const checker = program.getTypeChecker();
  const found: string[] = [];
  const report = (node: ts.Node, what: string) => {
    const file = node.getSourceFile();
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    found.push(`${file.fileName.split(/[\\/]/).pop()}:${line + 1} ${what}: ${node.getText(file).split("\n")[0]!.slice(0, 80)}`);
  };
  const fromLib = (symbol: ts.Symbol | undefined): boolean =>
    symbol?.declarations?.some((d) => {
      const file = d.getSourceFile();
      return program.isSourceFileDefaultLibrary(file) || /[\\/]node_modules[\\/]@types[\\/]node[\\/]/.test(file.fileName);
    }) === true;
  const typeOf = (node: ts.Node) => checker.getTypeAtLocation(node);

  /** The module an identifier was imported from (resolving aliases), or null. */
  const importedFrom = (identifier: ts.Identifier): string | null => {
    const symbol = checker.getSymbolAtLocation(identifier);
    const declaration = symbol?.declarations?.[0];
    if (declaration === undefined) return null;
    if (!(ts.isImportSpecifier(declaration) || ts.isNamespaceImport(declaration) || ts.isImportClause(declaration))) return null;
    let at: ts.Node = declaration;
    while (!ts.isImportDeclaration(at)) at = at.parent;
    return (at.moduleSpecifier as ts.StringLiteral).text;
  };

  /** Each built-in `type` is, or extends, intersects or is constrained to. */
  const kindsOf = (type: ts.Type, seen: Set<ts.Type> = new Set()): string[] => {
    if (seen.has(type)) return [];
    seen.add(type);
    if (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never)) return [];
    if (type.isUnion() || type.isIntersection()) return type.types.flatMap((t) => kindsOf(t, seen));
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return ["any"];
    if (type.flags & ts.TypeFlags.StringLike) return ["string"];
    if (type.flags & ts.TypeFlags.NumberLike) return ["number"];
    if (type.flags & ts.TypeFlags.BooleanLike) return ["boolean"];
    if (type.flags & ts.TypeFlags.BigIntLike) return ["bigint"];
    if (type.flags & ts.TypeFlags.TypeParameter) {
      const constraint = checker.getBaseConstraintOfType(type);
      return constraint !== undefined && constraint !== type ? kindsOf(constraint, seen) : ["any"];
    }
    const symbol = type.getSymbol() ?? type.aliasSymbol;
    const name = symbol?.getName();
    if (fromLib(symbol) && name !== undefined && ARRAYS.has(name)) return ["array"];
    if (fromLib(symbol) && name !== undefined && BUILTIN_OBJECTS.has(name)) return [`object:${name}`];
    if (symbol !== undefined && symbol.flags & ts.SymbolFlags.ValueModule) return ["namespace"];
    const target = ((type as ts.TypeReference).target ?? type) as ts.InterfaceType;
    if ((target as ts.ObjectType).objectFlags & ts.ObjectFlags.ClassOrInterface) {
      return (checker.getBaseTypes(target) ?? []).flatMap((t) => kindsOf(t, seen));
    }
    if (type.getCallSignatures().length > 0 && type.getProperties().length === 0) return ["function"];
    return [];
  };
  const isPrimitive = (node: ts.Node): boolean => {
    const type = typeOf(node);
    const parts = type.isUnion() ? type.types : [type];
    return parts.every((t) => (t.flags & PRIMITIVE) !== 0);
  };
  const isPropertyKey = (node: ts.Node): boolean => {
    const type = typeOf(node);
    const parts = type.isUnion() ? type.types : [type];
    return parts.every((t) => (t.flags & PROPERTY_KEY) !== 0);
  };
  /** `expression` without the wrappers that are erased: parentheses, `!`, `as`, `satisfies` and `<T>`. */
  const unwrap = (expression: ts.Expression): ts.Expression => {
    let at = expression;
    while (ts.isParenthesizedExpression(at) || ts.isNonNullExpression(at) || ts.isAsExpression(at) || ts.isSatisfiesExpression(at) || ts.isTypeAssertionExpression(at)) at = at.expression;
    return at;
  };
  /** The declaration `identifier` resolves to, through import aliases. */
  const declarationOf = (identifier: ts.Identifier): ts.Declaration | undefined => {
    let symbol = checker.getSymbolAtLocation(identifier);
    if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.declarations?.[0];
  };
  const inPrimordials = (declaration: ts.Node): boolean => options.primordials.test(declaration.getSourceFile().fileName);

  /** The trusted own-property check: a function declaration named hasOwn in a primordials file. */
  const isTrustedHasOwn = (callee: ts.Identifier): boolean => {
    const declaration = declarationOf(callee);
    return declaration !== undefined && ts.isFunctionDeclaration(declaration) && declaration.name?.text === "hasOwn" && inPrimordials(declaration);
  };
  /** Whether `a` and `b` name the same binding, or are the same string or number literal. */
  const sameOperand = (a: ts.Expression, b: ts.Expression): boolean => {
    const x = unwrap(a);
    const y = unwrap(b);
    if (ts.isIdentifier(x) && ts.isIdentifier(y)) {
      const sx = checker.getSymbolAtLocation(x);
      return sx !== undefined && sx === checker.getSymbolAtLocation(y);
    }
    if ((ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) && (ts.isStringLiteral(y) || ts.isNoSubstitutionTemplateLiteral(y))) return x.text === y.text;
    return ts.isNumericLiteral(x) && ts.isNumericLiteral(y) && x.text === y.text;
  };
  /**
   * Whether the LAST thing `condition` evaluates is the trusted `hasOwn(receiver, key)`: the
   * condition is that call, or a chain of `&&` whose rightmost operand is.
   */
  const endsWithHasOwn = (condition: ts.Expression, receiver: ts.Expression, key: ts.Expression): boolean => {
    let c = unwrap(condition);
    while (ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) c = unwrap(c.right);
    return ts.isCallExpression(c) && ts.isIdentifier(c.expression) && isTrustedHasOwn(c.expression) && c.arguments.length === 2 &&
      sameOperand(c.arguments[0]!, receiver) && sameOperand(c.arguments[1]!, key);
  };
  /**
   * Whether `read` is the FIRST thing `from` evaluates: it sits on the left spine of `from`, where
   * every step evaluates its leftmost operand before anything else.
   */
  const firstEvaluated = (from: ts.Node, read: ts.Node): boolean => {
    let at: ts.Node = from;
    for (;;) {
      if (at === read) return true;
      if (ts.isParenthesizedExpression(at) || ts.isNonNullExpression(at) || ts.isAsExpression(at) || ts.isSatisfiesExpression(at) || ts.isTypeAssertionExpression(at) ||
        ts.isPropertyAccessExpression(at) || ts.isElementAccessExpression(at) || ts.isCallExpression(at) || ts.isTypeOfExpression(at) || ts.isVoidExpression(at)) {
        at = at.expression;
      } else if (ts.isBinaryExpression(at) && !(at.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && at.operatorToken.kind <= ts.SyntaxKind.LastAssignment)) {
        at = at.left;
      } else if (ts.isPrefixUnaryExpression(at) && at.operator !== ts.SyntaxKind.PlusPlusToken && at.operator !== ts.SyntaxKind.MinusMinusToken) {
        at = at.operand;
      } else if (ts.isConditionalExpression(at)) {
        at = at.condition;
      } else if (ts.isReturnStatement(at) || ts.isExpressionStatement(at) || ts.isThrowStatement(at)) {
        if (at.expression === undefined) return false;
        at = at.expression;
      } else if (ts.isVariableStatement(at)) {
        const first = at.declarationList.declarations[0];
        if (first?.initializer === undefined) return false;
        at = first.initializer;
      } else if (ts.isBlock(at)) {
        if (at.statements.length === 0) return false;
        at = at.statements[0]!;
      } else if (ts.isIfStatement(at)) {
        at = at.expression;
      } else {
        return false;
      }
    }
  };
  /**
   * A read of `receiver[key]` proven OWN by the trusted hasOwn, with nothing running in between:
   * `hasOwn(x, k) ? x[k] : ...`, `hasOwn(x, k) && x[k]`, or `if (hasOwn(x, k))` whose branch begins
   * with the read. The guard ends with that hasOwn call, and the read is the first thing the guarded
   * part evaluates: code running in between (a call, an assignment) could remove the property.
   */
  const provenOwn = (read: ts.Node, receiver: ts.Expression, key: ts.Expression): boolean => {
    for (let child: ts.Node = read, parent = read.parent; parent !== undefined && !ts.isFunctionLike(parent); child = parent, parent = parent.parent) {
      if (ts.isConditionalExpression(parent) && parent.whenTrue === child && endsWithHasOwn(parent.condition, receiver, key)) return firstEvaluated(child, read);
      if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && parent.right === child && endsWithHasOwn(parent.left, receiver, key)) {
        return firstEvaluated(child, read);
      }
      if (ts.isIfStatement(parent) && parent.thenStatement === child && endsWithHasOwn(parent.expression, receiver, key)) return firstEvaluated(child, read);
    }
    return false;
  };
  /** The trusted `ObjectCreate`: a top-level `const ObjectCreate = Object.create` in a primordials file. */
  const isTrustedObjectCreate = (callee: ts.Identifier): boolean => {
    const declaration = declarationOf(callee);
    if (declaration === undefined || !ts.isVariableDeclaration(declaration) || !inPrimordials(declaration)) return false;
    const list = declaration.parent;
    const init = declaration.initializer;
    return ts.isIdentifier(declaration.name) && declaration.name.text === "ObjectCreate" && ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0 &&
      ts.isSourceFile(list.parent.parent) && init !== undefined && ts.isPropertyAccessExpression(init) && ts.isIdentifier(init.expression) &&
      init.expression.text === "Object" && init.name.text === "create";
  };
  /** Whether `expression` is a binding declared `const x = ObjectCreate(null)`, with the trusted ObjectCreate. */
  const isNullPrototypeRecord = (expression: ts.Expression): boolean => {
    if (!ts.isIdentifier(expression)) return false;
    const declaration = checker.getSymbolAtLocation(expression)?.declarations?.[0];
    if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return false;
    if (!(ts.isVariableDeclarationList(declaration.parent) && declaration.parent.flags & ts.NodeFlags.Const)) return false;
    const init = unwrap(declaration.initializer);
    return ts.isCallExpression(init) && ts.isIdentifier(init.expression) && isTrustedObjectCreate(init.expression) &&
      init.arguments.length === 1 && init.arguments[0]!.kind === ts.SyntaxKind.NullKeyword;
  };
  const isTypedElement = (node: ts.ElementAccessExpression): boolean =>
    (typeOf(node.argumentExpression).flags & ts.TypeFlags.NumberLike) !== 0 &&
    (() => {
      const kinds = kindsOf(typeOf(node.expression));
      return kinds.length > 0 && kinds.every((k) => k.startsWith("object:") && TYPED_ARRAYS.has(k.slice(7)));
    })();
  const isPrivateMember = (node: ts.Expression): boolean =>
    ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword && ts.isPrivateIdentifier(node.name);
  /** `x.length` where `x` is an array: own data on every array, so a write runs no setter. */
  const isArrayLength = (target: ts.Expression): boolean => {
    const t = unwrap(target);
    if (!ts.isPropertyAccessExpression(t) || t.name.text !== "length") return false;
    const kinds = kindsOf(typeOf(t.expression));
    return kinds.length > 0 && kinds.every((k) => k === "array");
  };
  /** A target an assignment or ++/-- may write without running an inherited setter. */
  const writableTarget = (target: ts.Expression): boolean => {
    const t = unwrap(target);
    if (ts.isIdentifier(t)) return true;
    if (isPrivateMember(t)) return true;
    if (ts.isElementAccessExpression(t)) return isTypedElement(t) || isNullPrototypeRecord(t.expression);
    if (ts.isPropertyAccessExpression(t)) return isNullPrototypeRecord(t.expression) || isArrayLength(t);
    return false;
  };

  const checkIdentifier = (node: ts.Identifier): void => {
    const parent = node.parent;
    // Names that are not references: declarations, property names, labels.
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return;
    if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) && parent.name === node) return;
    if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent) || ts.isBindingElement(parent)) && parent.name === node) return;
    if (ts.isBindingElement(parent) && parent.propertyName === node) return;
    if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return;
    const from = importedFrom(node);
    if (from !== null) {
      if (from.startsWith("node:")) report(node, `a binding from ${from}, used after load`);
      return;
    }
    const symbol = checker.getSymbolAtLocation(node);
    if (fromLib(symbol) && !READ_ONLY_GLOBALS.has(node.text)) report(node, "a global, used after load");
    if (node.text === "arguments" && symbol === undefined) report(node, "arguments");
  };

  /** Checks `node` itself; returns false when its subtree must not be walked (type positions). */
  const checkNode = (node: ts.Node): boolean => {
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return false; // erased
    // Operator and punctuation tokens are the structure of the node above them, which is checked.
    if (node.kind >= ts.SyntaxKind.FirstPunctuation && node.kind <= ts.SyntaxKind.LastPunctuation) return true;
    switch (node.kind) {
      // Declarations and members: walked into; their expressions are checked as they come.
      case ts.SyntaxKind.FunctionDeclaration:
      case ts.SyntaxKind.ClassDeclaration:
      case ts.SyntaxKind.Constructor:
      case ts.SyntaxKind.MethodDeclaration:
      case ts.SyntaxKind.PropertyDeclaration:
      case ts.SyntaxKind.GetAccessor:
      case ts.SyntaxKind.SetAccessor:
      case ts.SyntaxKind.Parameter:
      case ts.SyntaxKind.VariableDeclaration:
      case ts.SyntaxKind.VariableDeclarationList:
      case ts.SyntaxKind.HeritageClause:
      case ts.SyntaxKind.ExpressionWithTypeArguments:
      case ts.SyntaxKind.PrivateIdentifier:
      case ts.SyntaxKind.Block:
      case ts.SyntaxKind.VariableStatement:
      case ts.SyntaxKind.ExpressionStatement:
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.ReturnStatement:
      case ts.SyntaxKind.ThrowStatement:
      case ts.SyntaxKind.TryStatement:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.BreakStatement:
      case ts.SyntaxKind.ContinueStatement:
      case ts.SyntaxKind.SwitchStatement:
      case ts.SyntaxKind.CaseBlock:
      case ts.SyntaxKind.CaseClause:
      case ts.SyntaxKind.DefaultClause:
      case ts.SyntaxKind.EmptyStatement:
      case ts.SyntaxKind.LabeledStatement:
      case ts.SyntaxKind.ExportKeyword:
      case ts.SyntaxKind.AsyncKeyword:
      case ts.SyntaxKind.ReadonlyKeyword:
      case ts.SyntaxKind.StaticKeyword:
      case ts.SyntaxKind.PrivateKeyword:
      case ts.SyntaxKind.PublicKeyword:
      case ts.SyntaxKind.ProtectedKeyword:
      case ts.SyntaxKind.DeclareKeyword:
      case ts.SyntaxKind.AbstractKeyword:
      case ts.SyntaxKind.OverrideKeyword:
      case ts.SyntaxKind.DefaultKeyword:
      case ts.SyntaxKind.ConstKeyword:
      case ts.SyntaxKind.QuestionToken:
      case ts.SyntaxKind.ExclamationToken:
      case ts.SyntaxKind.EqualsGreaterThanToken:
      case ts.SyntaxKind.QuestionDotToken:
      case ts.SyntaxKind.AsteriskToken:
      case ts.SyntaxKind.DotDotDotToken:
        return true;
      // Erased: interfaces, type aliases, enums of types, imports and exports of declarations.
      case ts.SyntaxKind.InterfaceDeclaration:
      case ts.SyntaxKind.TypeAliasDeclaration:
      case ts.SyntaxKind.ImportDeclaration:
      case ts.SyntaxKind.ExportDeclaration:
      case ts.SyntaxKind.TypeParameter:
      case ts.SyntaxKind.TypeOfKeyword:
        return false;
      // Literals and keywords that read nothing.
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NumericLiteral:
      case ts.SyntaxKind.BigIntLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TrueKeyword:
      case ts.SyntaxKind.FalseKeyword:
      case ts.SyntaxKind.NullKeyword:
      case ts.SyntaxKind.ThisKeyword:
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail:
        return true;
      case ts.SyntaxKind.SuperKeyword:
        if (!(ts.isCallExpression(node.parent) && node.parent.expression === node)) report(node, "super, other than super(...)");
        return true;
      case ts.SyntaxKind.Identifier:
        checkIdentifier(node as ts.Identifier);
        return true;
      case ts.SyntaxKind.TemplateExpression:
        return true;
      case ts.SyntaxKind.TemplateSpan: {
        const expression = (node as ts.TemplateSpan).expression;
        if (!isPrimitive(expression)) report(expression, "a template substituting a non-primitive (its toString is looked up)");
        return true;
      }
      case ts.SyntaxKind.PropertyAccessExpression: {
        const n = node as ts.PropertyAccessExpression;
        if (n.expression.kind === ts.SyntaxKind.ThisKeyword && ts.isPrivateIdentifier(n.name)) return true;
        const name = n.name.text;
        for (const kind of kindsOf(typeOf(n.expression))) {
          if (!(name === "length" && (kind === "array" || kind === "string"))) report(n, `.${name} on a ${kind}`);
        }
        return true;
      }
      case ts.SyntaxKind.ElementAccessExpression: {
        const n = node as ts.ElementAccessExpression;
        if (!isPropertyKey(n.argumentExpression)) {
          report(n, `[${n.argumentExpression.getText()}] a key that is not a string, number or symbol (its toString is looked up)`);
          return true;
        }
        if (isTypedElement(n) || isNullPrototypeRecord(n.expression) || provenOwn(n, unwrap(n.expression), n.argumentExpression)) return true;
        const kinds = kindsOf(typeOf(n.expression));
        report(n, `[${n.argumentExpression.getText()}] not proven own${kinds.length > 0 ? ` on a ${kinds.join("|")}` : ""}`);
        return true;
      }
      case ts.SyntaxKind.CallExpression: {
        const n = node as ts.CallExpression;
        const callee = unwrap(n.expression);
        if (!(ts.isIdentifier(callee) || isPrivateMember(callee) || callee.kind === ts.SyntaxKind.SuperKeyword)) {
          report(n, "a call whose callee is looked up at call time");
        }
        return true;
      }
      case ts.SyntaxKind.NewExpression: {
        const n = node as ts.NewExpression;
        if (!ts.isIdentifier(n.expression)) report(n, "new of a constructor looked up at call time");
        return true;
      }
      case ts.SyntaxKind.PrefixUnaryExpression: {
        const n = node as ts.PrefixUnaryExpression;
        switch (n.operator) {
          case ts.SyntaxKind.ExclamationToken:
            return true;
          case ts.SyntaxKind.MinusToken:
          case ts.SyntaxKind.TildeToken:
          case ts.SyntaxKind.PlusToken:
            if (!isPrimitive(n.operand)) report(n, "a unary operator on a non-primitive (valueOf is looked up)");
            return true;
          case ts.SyntaxKind.PlusPlusToken:
          case ts.SyntaxKind.MinusMinusToken:
            if (!writableTarget(n.operand)) report(n, "++/-- on a target that could run an inherited setter");
            return true;
        }
        report(n, "a unary operator the allowlist does not name");
        return true;
      }
      case ts.SyntaxKind.PostfixUnaryExpression: {
        const n = node as ts.PostfixUnaryExpression;
        if (!writableTarget(n.operand)) report(n, "++/-- on a target that could run an inherited setter");
        return true;
      }
      case ts.SyntaxKind.BinaryExpression: {
        const n = node as ts.BinaryExpression;
        const op = n.operatorToken.kind;
        if (op === ts.SyntaxKind.EqualsToken || op === ts.SyntaxKind.AmpersandAmpersandEqualsToken || op === ts.SyntaxKind.BarBarEqualsToken || op === ts.SyntaxKind.QuestionQuestionEqualsToken) {
          if (!writableTarget(n.left)) report(n, "a write to a target that could run an inherited setter");
          else if (isArrayLength(n.left) && !isPrimitive(n.right)) report(n, "an array length set to a non-primitive (its valueOf is looked up)");
          return true;
        }
        if (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment) {
          if (!writableTarget(n.left)) report(n, "a write to a target that could run an inherited setter");
          if (!isPrimitive(n.left) || !isPrimitive(n.right)) report(n, "compound assignment with a non-primitive operand");
          return true;
        }
        switch (op) {
          case ts.SyntaxKind.EqualsEqualsEqualsToken:
          case ts.SyntaxKind.ExclamationEqualsEqualsToken:
          case ts.SyntaxKind.AmpersandAmpersandToken:
          case ts.SyntaxKind.BarBarToken:
          case ts.SyntaxKind.QuestionQuestionToken:
          case ts.SyntaxKind.CommaToken:
            return true;
          case ts.SyntaxKind.PlusToken:
          case ts.SyntaxKind.MinusToken:
          case ts.SyntaxKind.AsteriskToken:
          case ts.SyntaxKind.AsteriskAsteriskToken:
          case ts.SyntaxKind.SlashToken:
          case ts.SyntaxKind.PercentToken:
          case ts.SyntaxKind.LessThanToken:
          case ts.SyntaxKind.LessThanEqualsToken:
          case ts.SyntaxKind.GreaterThanToken:
          case ts.SyntaxKind.GreaterThanEqualsToken:
          case ts.SyntaxKind.AmpersandToken:
          case ts.SyntaxKind.BarToken:
          case ts.SyntaxKind.CaretToken:
          case ts.SyntaxKind.LessThanLessThanToken:
          case ts.SyntaxKind.GreaterThanGreaterThanToken:
          case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
            if (!isPrimitive(n.left) || !isPrimitive(n.right)) report(n, "an operator on a non-primitive (valueOf or toString is looked up)");
            return true;
          case ts.SyntaxKind.InKeyword:
            report(n, "the in operator (it consults prototypes)");
            return true;
          case ts.SyntaxKind.InstanceOfKeyword:
            report(n, "instanceof (it runs Symbol.hasInstance)");
            return true;
        }
        report(n, "an operator the allowlist does not name (== and != convert)");
        return true;
      }
      case ts.SyntaxKind.ConditionalExpression:
      case ts.SyntaxKind.ParenthesizedExpression:
      case ts.SyntaxKind.AsExpression:
      case ts.SyntaxKind.NonNullExpression:
      case ts.SyntaxKind.SatisfiesExpression:
      case ts.SyntaxKind.TypeAssertionExpression:
      case ts.SyntaxKind.TypeOfExpression:
      case ts.SyntaxKind.VoidExpression:
      case ts.SyntaxKind.ArrowFunction:
      case ts.SyntaxKind.FunctionExpression:
      case ts.SyntaxKind.ShorthandPropertyAssignment:
        return true;
      case ts.SyntaxKind.ObjectLiteralExpression:
      case ts.SyntaxKind.PropertyAssignment:
        return true;
      case ts.SyntaxKind.ComputedPropertyName: {
        const expression = (node as ts.ComputedPropertyName).expression;
        if (!isPrimitive(expression)) report(node, "a computed key that is not a primitive (its toString is looked up)");
        return true;
      }
      case ts.SyntaxKind.ArrayLiteralExpression:
        return true;
      case ts.SyntaxKind.AwaitExpression: {
        let operand = (node as ts.AwaitExpression).expression;
        while (ts.isParenthesizedExpression(operand)) operand = operand.expression;
        if (!(ts.isCallExpression(operand) && ts.isIdentifier(operand.expression) && options.awaitWrappers.has(operand.expression.text))) {
          report(node, "await of a promise no wrapper pinned");
        }
        return true;
      }
      case ts.SyntaxKind.ObjectBindingPattern: {
        const n = node as ts.ObjectBindingPattern;
        const kinds = kindsOf(typeOf(n));
        for (const element of n.elements) {
          const key = element.propertyName ?? element.name;
          const name = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : key.getText();
          for (const kind of kinds) {
            if (!(name === "length" && (kind === "array" || kind === "string"))) report(element, `destructuring .${name} from a ${kind}`);
          }
          if (element.dotDotDotToken !== undefined) report(element, "a rest element (it copies through [[Get]])");
        }
        return true;
      }
      case ts.SyntaxKind.BindingElement:
        return true;
    }
    // Default: deny. A form nobody listed fails closed.
    report(node, `a syntax form the allowlist does not name (${ts.SyntaxKind[node.kind]})`);
    return true;
  };

  // What a module evaluates once, at load: its top-level const initializers, and its top-level classes' extends clauses.
  const loadTimes = new Map<ts.SourceFile, Set<ts.Node>>();
  const loadTimeOf = (source: ts.SourceFile): Set<ts.Node> => {
    let loadTime = loadTimes.get(source);
    if (loadTime === undefined) {
      loadTime = new Set<ts.Node>();
      for (const statement of source.statements) {
        if (ts.isVariableStatement(statement)) for (const d of statement.declarationList.declarations) if (d.initializer) loadTime.add(d.initializer);
        if (ts.isClassDeclaration(statement)) for (const clause of statement.heritageClauses ?? []) loadTime.add(clause);
      }
      loadTimes.set(source, loadTime);
    }
    return loadTime;
  };
  const isImmediatelyInvoked = (node: ts.Node): boolean => {
    if (!(ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return false;
    let at: ts.Node = node;
    while (ts.isParenthesizedExpression(at.parent)) at = at.parent;
    return ts.isCallExpression(at.parent) && at.parent.expression === at;
  };
  const visit = (node: ts.Node, atLoad: boolean, loadTime: Set<ts.Node>): void => {
    const now = ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node) ? atLoad && isImmediatelyInvoked(node) : atLoad || loadTime.has(node);
    if (!now && !checkNode(node)) return;
    if (now && (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isImportDeclaration(node))) return;
    ts.forEachChild(node, (child) => visit(child, now, loadTime));
  };
  const walkFile = (source: ts.SourceFile, functions?: ReadonlySet<string>): void => {
    const loadTime = loadTimeOf(source);
    const scope = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
      if (functions === undefined || (ts.isFunctionDeclaration(node) && node.name !== undefined && functions.has(node.name.text))) visit(node, false, loadTime);
      else ts.forEachChild(node, scope);
    };
    if (functions === undefined) for (const statement of source.statements) scope(statement);
    else scope(source);
  };
  /** One declaration the closure reached, checked in place: inside a top-level initializer, with no function between, it runs at load. */
  const walkRoot = (root: ts.Node): void => {
    if (ts.isSourceFile(root)) return walkFile(root);
    const loadTime = loadTimeOf(root.getSourceFile());
    let atLoad = false;
    for (let at = root.parent; at !== undefined; at = at.parent) {
      if (ts.isFunctionLike(at) || ts.isClassStaticBlockDeclaration(at)) break;
      if (loadTime.has(at)) {
        atLoad = true;
        break;
      }
    }
    visit(root, atLoad, loadTime);
  };
  return { found, walkFile, walkRoot };
}

export function compilerOptions(dir: string): ts.CompilerOptions {
  const configPath = ts.findConfigFile(dir, ts.sys.fileExists, "tsconfig.json")!;
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!;
  return { ...parsed.options, noEmit: true };
}

/** A program over one in-memory file, with the package's compiler options and the default library. */
export function programOf(dir: string, fileName: string, text: string): ts.Program {
  return programOfFiles(dir, new Map([[fileName, text]]));
}

/** A program over in-memory files (absolute name to text), with the package's compiler options, any overrides, and the default library. */
export function programOfFiles(dir: string, files: ReadonlyMap<string, string>, overrides: ts.CompilerOptions = {}): ts.Program {
  const options = { ...compilerOptions(dir), ...overrides };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, ...rest) => {
    const text = files.get(name);
    return text !== undefined ? ts.createSourceFile(name, text, languageVersion, true) : getSourceFile(name, languageVersion, ...rest);
  };
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => files.has(name) || fileExists(name);
  const readFile = host.readFile.bind(host);
  host.readFile = (name) => files.get(name) ?? readFile(name);
  return ts.createProgram([...files.keys()], options, host);
}
