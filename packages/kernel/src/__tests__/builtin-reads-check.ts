/**
 * The DEFAULT-DENY check behind evidence-emitter-builtins.test.ts (steward DECISIONS 01:30, #6668,
 * #6792, 04:06 and 05:05; astra packs 289, 291, 293, 299, 303, 307, 309 and 313). It is a copy of
 * @pcc/spec's src/__tests__/builtin-reads-check.ts (#519), identical below this paragraph: the two
 * packages' tests differ only in the `CheckOptions` they pass, and a test file of one package cannot
 * import the other's.
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
 * rest, and so does an instance field's initializer, which runs at `new` even in a class evaluated
 * at load (astra pack 303). Type positions are erased and are not walked.
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
 *     namespace or on `unknown` or `any` never. On anything else, the receiver must be OWNED
 *     (DECISIONS 05:05; astra packs 309 and 313): a static type is no evidence of where a field comes
 *     from. Owned means one of:
 *       - an owned snapshot: its type carries the brand, `[OWNED]`, a `declare const OWNED: unique
 *         symbol` in a primordials file;
 *       - a const bound to a fresh `ObjectCreate(null)` record, or to an object literal that defines
 *         the field;
 *       - a property descriptor, whose `enumerable` and `configurable` are always its own, and whose
 *         `value`, `writable`, `get` and `set` are read where the trusted hasOwn proves them its own.
 *     The brand is MINTED only on what the code makes: the trusted `ObjectCreate(null)` itself, an
 *     object literal that defines every field the type has (none optional), an array literal, or an
 *     owned value of the very same type. Anything else taken as an owned type (an assertion, a type
 *     predicate, an implicit `any`) is allowed only where CheckOptions.provenance names the place,
 *     with the snapshot it comes from. Nothing outside the check supplies one: an entry point's
 *     parameter, or a parameter of a function handed to code the check does not walk, may not have
 *     an owned type, and neither may what such code answers (a Map's get, what the code stored, aside).
 *     An assertion to a type parameter or to `never` is refused outright: it takes any value as
 *     whatever it is instantiated with (astra pack 313);
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
 *   - an object (or an opaque value) handed to code the check does not walk only if that code reads
 *     nothing of it through [[Get]]: an own-data reader (OWN_DATA_READERS by the path it was captured
 *     from, an in-repo capture named in CheckOptions.ownDataReaders, Reflect.apply of one, an
 *     executor's reject), a built-in read through its internal slots (a Map, Set, Date), a dense
 *     literal list of primitives, or a call site named as a collaborator;
 *   - a write by Object.defineProperty, or by a helper named in CheckOptions.writers (its first
 *     parameter is what it writes), only onto an owned snapshot, a value the code just made, a private
 *     field or a native promise; and an owned container is never widened where it is written;
 *   - a call whose callee is an identifier, `this.#private`, or `super`, under any parentheses, `!`,
 *     `as`, `satisfies` or `<T>`, and `new` of an identifier, when the TARGET is fixed, seen code
 *     (astra pack 303):
 *       - a function, method or class declared in the repository (the closure enters and checks it);
 *       - a function written in place, or a const bound to one;
 *       - a const whose value is computed at load (top-level, or in a function called where it is
 *         written there), unless it was taken from third-party code;
 *       - a parameter whose function is not an entry point, never escapes as a value, and is passed
 *         seen code by every call in the scope; or the resolve and reject of an executor passed to the
 *         Promise captured at load.
 *     Any other target (a callback or field supplied at run time, a const read from data, a `let`, an
 *     unresolved name, third-party code) fails closed unless its call site is a named collaborator
 *     (CheckOptions.collaborators), with its reason;
 *   - unary `!`, `-`, `~`, `typeof`, `void`, and `++`/`--` on a writable target. `-` and `~` need a
 *     primitive operand;
 *   - binary arithmetic, bitwise, logical, `===` and `!==`. `+`, `<`, `<=`, `>`, `>=` and
 *     compound arithmetic assignment need primitive operands (an object's valueOf or toString would
 *     be looked up);
 *   - assignment to a local, to `this.#private`, to an integer element of a typed array, to a
 *     property or element of a binding declared `const x = ObjectCreate(null)`, to a property of an
 *     owned snapshot (its fields are its own: a write elsewhere could run an inherited setter), or to
 *     `length` of an array, with a primitive value (an array's
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
  /** The repository root: keys and the closure's names give a file by its path relative to it, so no two files share a key. */
  root: string;
  /**
   * The CLOSED list of collaborators, each with its reason (astra pack 303):
   *   - `path:Name` or `path:Class.member`: a declaration the closure reaches but does not enter;
   *   - `path:Enclosing:callee()` (with `#n` when that declaration makes several such calls): a call
   *     whose target the check cannot see, a function value supplied at run time or third-party code.
   * Every entry needs a reason, and must match exactly one declaration or call site: an entry that
   * is unexplained, matches nothing or matches several is reported like any violation.
   */
  collaborators?: ReadonlyMap<string, string>;
  /**
   * The CLOSED list of places where an `unknown` or `any` is taken as an object type, each with the
   * provenance that makes its fields own data (astra pack 309): `path:Enclosing:as T` for an
   * assertion, or `path:Name:is T` for a type predicate (with `#n` when that declaration has several
   * alike). The reason says where the value comes from: an owned null-prototype copy, say. An entry
   * that is unexplained, matches nothing or matches several is reported like any violation.
   */
  provenance?: ReadonlyMap<string, string>;
  /**
   * In-repo captures that are own-data readers, which OWN_DATA_READERS cannot name by path: a trap-free
   * Proxy test taken at load through process.getBuiltinModule, say. `path:Name` of the capture, with
   * its reason. Closed, like the collaborators.
   */
  ownDataReaders?: ReadonlyMap<string, string>;
  /**
   * In-repo helpers that write onto their FIRST parameter through Object.defineProperty (append,
   * defineField): `path:Name`, with the reason. Each call of one is judged as the write it makes: its
   * first argument must be an owned snapshot or a value the code just made (astra pack 313).
   */
  writers?: ReadonlyMap<string, string>;
}

/** A file's path relative to `root`, with forward slashes; a file outside `root` keeps its whole path. */
function relativeName(fileName: string, root: string): string {
  const normalized = fileName.split("\\").join("/");
  const base = root.split("\\").join("/").replace(/\/+$/, "");
  return normalized.startsWith(`${base}/`) ? normalized.slice(base.length + 1) : normalized;
}

/** Which declarations and call sites each collaborator entry matched. */
type Matches = Map<string, Set<unknown>>;

/** What is wrong with the collaborator and provenance entries: no reason, no match (stale), or several matches. */
function collaboratorProblems(options: CheckOptions, matches: Matches): string[] {
  const problems: string[] = [];
  const lists: Array<[string, string, ReadonlyMap<string, string> | undefined]> = [
    ["collaborator", "declaration or call site", options.collaborators],
    ["provenance", "conversion", options.provenance],
    ["own-data reader", "capture", options.ownDataReaders],
    ["writer", "helper", options.writers],
  ];
  for (const [kind, what, list] of lists) {
    for (const [key, reason] of list ?? new Map<string, string>()) {
      if (typeof reason !== "string" || reason.trim() === "") problems.push(`${kind} ${key}: no reason is given`);
      const count = matches.get(key)?.size ?? 0;
      if (count === 0) problems.push(`${kind} ${key}: matches no ${what} (a stale entry)`);
      else if (count > 1) problems.push(`${kind} ${key}: matches ${count} ${what}s; name each`);
    }
  }
  return problems;
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
/**
 * Code the check does not walk that may be handed a value a caller supplied (astra pack 309): each
 * reads only the operand's own data or its identity, and runs no getter on it. By the path it was
 * captured from at load. On a Proxy, the descriptor, key and prototype readers run its traps: the
 * code tests `IsProxy` (node:util types.isProxy, trap-free) first, and the tests hand a Proxy to
 * each place.
 */
const OWN_DATA_READERS = new Set([
  // own data and shape
  "Object.getOwnPropertyDescriptor", "Reflect.getOwnPropertyDescriptor", "Reflect.ownKeys", "Object.getOwnPropertyNames", "Object.keys",
  "Object.getPrototypeOf", "Reflect.getPrototypeOf", "Object.isFrozen", "uncurried Object.prototype.hasOwnProperty",
  // writes: defines the target's own property from a descriptor the code made, reading nothing of the target
  "Object.defineProperty",
  // brand tests: no property is read
  "Array.isArray", "node:util.types.isProxy", "node:util.types.isPromise", "Number.isSafeInteger", "Number.isInteger", "Number.isFinite",
  // identity: held or compared, never read
  "uncurried WeakSet.prototype.add", "uncurried WeakSet.prototype.has", "uncurried Map.prototype.get", "uncurried Map.prototype.set",
  "uncurried Map.prototype.has", "uncurried Set.prototype.add", "uncurried Set.prototype.has",
  // binds a function to a `this` it holds and never reads (the function operand is judged as a call target)
  "uncurried Function.prototype.bind",
]);
/** Intrinsic constructors whose `new` always makes a fresh object (by the path they were captured from). */
const FRESH_CONSTRUCTORS = new Set(["Array", "Map", "Set", "WeakSet", "WeakMap", "Date", "Error", "TypeError", "RangeError", "Uint8Array"]);
/** What a key may be: ToPropertyKey of anything else looks up its toString or valueOf. */
const PROPERTY_KEY = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.ESSymbolLike;

/** "file:line what: text" for each node of `fileName` (or of its named top-level functions) that is not an allowed form. */
export function builtinReads(program: ts.Program, fileName: string, options: CheckOptions, functions?: ReadonlySet<string>): string[] {
  const source = program.getSourceFile(fileName)!;
  const matches: Matches = new Map();
  const walker = makeWalker(program, options, [source], new Set([source]), matches);
  walker.walkFile(source, functions);
  return [...walker.found, ...collaboratorProblems(options, matches)];
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
  options: CheckOptions,
  matches: Matches = new Map(),
): ts.Node[] {
  const checker = program.getTypeChecker();
  const roots: ts.Node[] = [];
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
      const key = closureKey(declaration, options.root);
      if (options.collaborators?.has(key) === true) {
        let matched = matches.get(key);
        if (matched === undefined) matches.set(key, (matched = new Set()));
        matched.add(symbol);
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
  // A module's top-level statements run at load in any module the closure reaches, and they may install
  // a function where reached code finds it (`table[key] = fn`), so they join the closure (astra pack 307).
  const modulesEntered = new Set<ts.SourceFile>();
  const enterModule = (source: ts.SourceFile): void => {
    if (modulesEntered.has(source)) return;
    modulesEntered.add(source);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement) && !ts.isInterfaceDeclaration(statement) &&
        !ts.isTypeAliasDeclaration(statement) && !ts.isFunctionDeclaration(statement) && !ts.isClassDeclaration(statement) &&
        !ts.isVariableStatement(statement) && !ts.isModuleDeclaration(statement) && !ts.isEnumDeclaration(statement)) {
        enqueue(statement);
      }
    }
  };
  for (let i = 0; i < roots.length; i++) {
    enterModule(roots[i]!.getSourceFile());
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
  return roots;
}

/** "path:Name" for a declaration, "path:Class.member" for a class member: how roots and collaborators are named. */
export function closureKey(node: ts.Node, root: string): string {
  const file = node.getSourceFile();
  const path = relativeName(file.fileName, root);
  if (ts.isSourceFile(node)) return `${path}:(the whole file)`;
  const name = ts.isConstructorDeclaration(node) ? "constructor" : (ts.getNameOfDeclaration(node as ts.Declaration)?.getText(file) ?? ts.SyntaxKind[node.kind]);
  const owner = node.parent !== undefined && (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent)) ? node.parent.name?.text : undefined;
  return `${path}:${owner !== undefined ? `${owner}.` : ""}${name}`;
}

/** "file:line what: text" for each node of the trusted closure of `seedFiles` that is not an allowed form, and what it reached. */
export function closureReads(
  program: ts.Program,
  seedFiles: readonly string[],
  options: CheckOptions,
  inRepo: (fileName: string) => boolean,
): { reached: string[]; found: string[]; collaboratorsUsed: string[]; provenanceUsed: string[]; readersUsed: string[]; writersUsed: string[] } {
  const matches: Matches = new Map();
  const roots = trustedClosure(program, seedFiles, inRepo, options, matches);
  const seeds = new Set(seedFiles.map((file) => program.getSourceFile(file)!));
  const walker = makeWalker(program, options, roots, seeds, matches);
  for (const root of roots) walker.walkRoot(root);
  return {
    reached: roots.map((root) => closureKey(root, options.root)),
    found: [...new Set([...walker.found, ...collaboratorProblems(options, matches)])],
    collaboratorsUsed: [...matches.keys()].filter((key) => options.collaborators?.has(key) === true).sort(),
    provenanceUsed: [...matches.keys()].filter((key) => options.provenance?.has(key) === true).sort(),
    readersUsed: [...matches.keys()].filter((key) => options.ownDataReaders?.has(key) === true).sort(),
    writersUsed: [...matches.keys()].filter((key) => options.writers?.has(key) === true).sort(),
  };
}

/**
 * The check's machinery over `program`: walkFile checks a file (or named functions of it), walkRoot
 * one reached declaration. `scope` is the code a call through a parameter is resolved against (the
 * closure's roots, or the one file), and `seeds` the files whose exports are the entry points, which
 * callers outside the check call with values it cannot see.
 */
function makeWalker(program: ts.Program, options: CheckOptions, scope: readonly ts.Node[], seeds: ReadonlySet<ts.SourceFile>, matches: Matches) {
  const checker = program.getTypeChecker();
  const found: string[] = [];
  const report = (node: ts.Node, what: string) => {
    const file = node.getSourceFile();
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    found.push(`${relativeName(file.fileName, options.root)}:${line + 1} ${what}: ${node.getText(file).split("\n")[0]!.slice(0, 80)}`);
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
  const endsWithHasOwn = (condition: ts.Expression, receiver: ts.Expression, key: ts.Expression | string): boolean => {
    let c = unwrap(condition);
    while (ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) c = unwrap(c.right);
    if (!(ts.isCallExpression(c) && ts.isIdentifier(c.expression) && isTrustedHasOwn(c.expression) && c.arguments.length === 2 && sameOperand(c.arguments[0]!, receiver))) return false;
    const k = unwrap(c.arguments[1]!);
    return typeof key === "string" ? (ts.isStringLiteral(k) || ts.isNoSubstitutionTemplateLiteral(k)) && k.text === key : sameOperand(k, key);
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
   * A read of `receiver[key]` (or `receiver.name`, with the key the name's string) proven OWN by the
   * trusted hasOwn, with nothing running in between: `hasOwn(x, k) ? x[k] : ...`, `hasOwn(x, k) &&
   * x[k]`, or `if (hasOwn(x, k))` whose branch begins with the read. The guard ends with that hasOwn
   * call, and the read is the first thing the guarded part evaluates: code running in between (a
   * call, an assignment) could remove the property.
   */
  const provenOwn = (read: ts.Node, receiver: ts.Expression, key: ts.Expression | string): boolean => {
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
    // An owned snapshot's fields are its own (a null-prototype record, or a literal with no optional field): no setter runs.
    if (ts.isPropertyAccessExpression(t)) return isNullPrototypeRecord(t.expression) || isArrayLength(t) || isOwned(typeOf(t.expression));
    return false;
  };

  // -- call targets (astra pack 303): a call passes only when the code it runs is fixed and seen --
  const isIntrinsic = (declaration: ts.Node): boolean => {
    const file = declaration.getSourceFile();
    return program.isSourceFileDefaultLibrary(file) || /[\\/]node_modules[\\/]@types[\\/]node[\\/]/.test(file.fileName);
  };
  /** Code outside the repository's own source that is neither an intrinsic nor a node: built-in. */
  const isThirdParty = (declaration: ts.Node): boolean => {
    const file = declaration.getSourceFile();
    return !isIntrinsic(declaration) && (file.isDeclarationFile || /[\\/]node_modules[\\/]/.test(file.fileName));
  };
  const symbolOf = (node: ts.Node): ts.Symbol | undefined => {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol;
  };
  const isConst = (declaration: ts.Node): declaration is ts.VariableDeclaration =>
    ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
  /**
   * Whether `node` runs once, when its module loads: it is in a top-level const initializer (or a
   * top-level class's extends clause), with no function between other than one called right where
   * it is written. A top-level const's own declaration runs at load too.
   */
  const runsAtLoad = (node: ts.Node): boolean => {
    if (isConst(node) && ts.isVariableStatement(node.parent.parent) && ts.isSourceFile(node.parent.parent.parent)) return true;
    const loadTime = loadTimeOf(node.getSourceFile());
    for (let at: ts.Node | undefined = node; at !== undefined; at = at.parent) {
      if (loadTime.has(at)) return true;
      if ((ts.isFunctionLike(at) && !isImmediatelyInvoked(at)) || ts.isClassStaticBlockDeclaration(at)) return false;
    }
    return false;
  };
  /** A const whose initializer runs at load: its value is fixed before any caller acts. */
  const isLoadTimeConst = (declaration: ts.Node): declaration is ts.VariableDeclaration =>
    isConst(declaration) && declaration.initializer !== undefined && runsAtLoad(declaration);
  /** Whether `reference` only names its declaration or exports it, rather than using the value. */
  const isNamingOnly = (reference: ts.Node): boolean => {
    const parent = reference.parent;
    if (
      (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isClassDeclaration(parent) ||
        ts.isPropertyDeclaration(parent) || ts.isParameter(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) &&
      parent.name === reference
    ) {
      return true;
    }
    return ts.isExportSpecifier(parent) || ts.isExportAssignment(parent);
  };
  // Every reference in `scope` (identifiers and #names in value positions), by the symbol it resolves to.
  let referenceIndex: Map<ts.Symbol, ts.Node[]> | undefined;
  const referencesOf = (symbol: ts.Symbol): ts.Node[] => {
    if (referenceIndex === undefined) {
      const index = new Map<ts.Symbol, ts.Node[]>();
      const walk = (node: ts.Node): void => {
        if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
        if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isImportDeclaration(node)) return;
        if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
          const s = symbolOf(node);
          if (s !== undefined) {
            const list = index.get(s);
            if (list === undefined) index.set(s, [node]);
            else list.push(node);
          }
        }
        ts.forEachChild(node, walk);
      };
      for (const root of scope) walk(root);
      referenceIndex = index;
    }
    return referenceIndex.get(symbol) ?? [];
  };
  /** The call or `new` whose callee is `reference` (under erased wrappers), or undefined when the reference is used otherwise. */
  const callOf = (reference: ts.Node): ts.CallExpression | ts.NewExpression | undefined => {
    let at: ts.Node = reference;
    if (ts.isPropertyAccessExpression(reference.parent) && reference.parent.name === reference) at = reference.parent;
    while (ts.isParenthesizedExpression(at.parent) || ts.isNonNullExpression(at.parent) || ts.isAsExpression(at.parent) || ts.isSatisfiesExpression(at.parent) || ts.isTypeAssertionExpression(at.parent)) {
      at = at.parent;
    }
    const parent = at.parent;
    return (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === at ? parent : undefined;
  };
  /** The binding that names a function: its declaration's name, or the const it is the initializer of. */
  const functionSymbol = (fn: ts.SignatureDeclaration): ts.Symbol | undefined => {
    if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name !== undefined) return checker.getSymbolAtLocation(fn.name);
    if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
      let at: ts.Node = fn;
      while (ts.isParenthesizedExpression(at.parent) || ts.isAsExpression(at.parent) || ts.isSatisfiesExpression(at.parent)) at = at.parent;
      const parent = at.parent;
      if (ts.isVariableDeclaration(parent) && parent.initializer === at && ts.isIdentifier(parent.name) && ts.isVariableDeclarationList(parent.parent) && (parent.parent.flags & ts.NodeFlags.Const) !== 0) {
        return checker.getSymbolAtLocation(parent.name);
      }
    }
    return undefined;
  };
  /** Whether calling `expression`'s value runs fixed, seen code: a function written in place, or a binding that resolves to one. */
  const valueFixed = (expression: ts.Expression, seen: Set<ts.Node>): boolean => {
    const e = unwrap(expression);
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isClassExpression(e) || e.kind === ts.SyntaxKind.NullKeyword) return true;
    return ts.isIdentifier(e) && (e.text === "undefined" || identifierFixed(e, seen));
  };
  const identifierFixed = (identifier: ts.Node, seen: Set<ts.Node>): boolean => {
    const declarations = symbolOf(identifier)?.declarations ?? [];
    return declarations.length > 0 && declarations.every((d) => declarationFixed(d, seen));
  };
  const declarationFixed = (declaration: ts.Declaration, seen: Set<ts.Node>): boolean => {
    if (seen.has(declaration)) return true;
    seen.add(declaration);
    // A global or a node: binding: the identifier check judges its use after load.
    if (isIntrinsic(declaration)) return true;
    if (isThirdParty(declaration)) return false;
    if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration) || ts.isClassDeclaration(declaration) || ts.isConstructorDeclaration(declaration)) return true;
    if (ts.isParameter(declaration)) return parameterFixed(declaration, seen);
    if (isLoadTimeConst(declaration)) return loadTimeFixed(declaration.initializer!, seen);
    if (isConst(declaration) && declaration.initializer !== undefined) return valueFixed(declaration.initializer, seen);
    // A let or var, a binding element, a declared value, an import that resolves to nothing: supplied at run time.
    return false;
  };
  /**
   * A value computed at load is fixed when the module loads: nothing a caller does afterwards
   * changes it. It is seen code unless it was taken from third-party code, directly or through
   * another load-time const; that is named as a collaborator instead.
   */
  const loadTimeFixed = (initializer: ts.Expression, seen: Set<ts.Node>): boolean => {
    let fixed = true;
    const walk = (node: ts.Node): void => {
      if (!fixed || (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node))) return;
      if (ts.isIdentifier(node) && !isNamingOnly(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
        for (const d of symbolOf(node)?.declarations ?? []) {
          if (isThirdParty(d)) fixed = false;
          else if (isLoadTimeConst(d) && !seen.has(d)) {
            seen.add(d);
            if (!loadTimeFixed(d.initializer!, seen)) fixed = false;
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(initializer);
    return fixed;
  };
  /** Whether `fn` is an entry point: exported from a seed file, or a public method or constructor of a class a seed file exports. */
  const isEntryPoint = (fn: ts.SignatureDeclaration): boolean => {
    if (!seeds.has(fn.getSourceFile())) return false;
    const moduleSymbol = checker.getSymbolAtLocation(fn.getSourceFile());
    const exported = new Set<ts.Symbol>();
    for (const e of moduleSymbol !== undefined ? checker.getExportsOfModule(moduleSymbol) : []) exported.add(e.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(e) : e);
    const own = functionSymbol(fn);
    if (own !== undefined && exported.has(own)) return true;
    const owner = fn.parent;
    if ((ts.isMethodDeclaration(fn) || ts.isConstructorDeclaration(fn) || ts.isGetAccessorDeclaration(fn) || ts.isSetAccessorDeclaration(fn)) && ts.isClassLike(owner)) {
      const classSymbol = owner.name !== undefined ? checker.getSymbolAtLocation(owner.name) : undefined;
      const isPrivate = fn.name !== undefined && ts.isPrivateIdentifier(fn.name) || (ts.getCombinedModifierFlags(fn) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0;
      return classSymbol !== undefined && exported.has(classSymbol) && !isPrivate;
    }
    return false;
  };
  /**
   * A parameter is fixed when every call of its function in `scope` passes fixed code there (or
   * nothing, or its default is fixed), and the function never escapes as a value, which would let
   * callers the check cannot see supply it. An entry point's parameters, and an unnamed function's,
   * are supplied by whoever calls it: never fixed.
   */
  const parameterFixed = (parameter: ts.ParameterDeclaration, seen: Set<ts.Node>): boolean => {
    const fn = parameter.parent;
    if (!ts.isFunctionLike(fn) || parameter.dotDotDotToken !== undefined || !ts.isIdentifier(parameter.name)) return false;
    if (parameter.initializer !== undefined && !valueFixed(parameter.initializer, seen)) return false;
    // A promise executor's resolve and reject, when the promise is made by the Promise captured at load, are the engine's own.
    if (isPromiseExecutor(fn)) return fn.parameters.indexOf(parameter) < 2;
    if (isEntryPoint(fn)) return false;
    const symbol = functionSymbol(fn);
    if (symbol === undefined) return false;
    const index = fn.parameters.indexOf(parameter);
    for (const reference of referencesOf(symbol)) {
      if (isNamingOnly(reference)) continue;
      const call = callOf(reference);
      if (call === undefined) return false;
      const argument = call.arguments?.[index];
      // An argument passed where the call runs at load is a value fixed at load.
      if (argument !== undefined && !(runsAtLoad(call) ? loadTimeFixed(argument, seen) : valueFixed(argument, seen))) return false;
    }
    return true;
  };
  /** Whether `expression` is the intrinsic Promise: the global itself, or a load-time const taken from it. */
  const isIntrinsicPromise = (expression: ts.Expression, seen: Set<ts.Node> = new Set()): boolean => {
    const e = unwrap(expression);
    if (!ts.isIdentifier(e)) return false;
    const symbol = symbolOf(e);
    for (const d of symbol?.declarations ?? []) {
      if (seen.has(d)) continue;
      seen.add(d);
      if (isIntrinsic(d) && symbol!.getName() === "Promise") return true;
      if (isLoadTimeConst(d) && isIntrinsicPromise(d.initializer!, seen)) return true;
    }
    return false;
  };
  /** Whether `fn` is written as the executor of `new P(fn)`, where P is the intrinsic Promise. */
  const isPromiseExecutor = (fn: ts.SignatureDeclaration): boolean => {
    if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return false;
    let at: ts.Node = fn;
    while (ts.isParenthesizedExpression(at.parent)) at = at.parent;
    const parent = at.parent;
    return ts.isNewExpression(parent) && parent.arguments?.[0] === at && isIntrinsicPromise(parent.expression);
  };
  /** Whether a call's callee (an identifier, `this.#member` or `super`) runs fixed, seen code. */
  const callTargetFixed = (callee: ts.Expression): boolean => {
    if (callee.kind === ts.SyntaxKind.SuperKeyword) return true;
    if (isPrivateMember(callee)) {
      // A private method is fixed code; a private field holds whatever was assigned to it at run time.
      const declarations = symbolOf((callee as ts.PropertyAccessExpression).name)?.declarations ?? [];
      return declarations.length > 0 && declarations.every((d) => ts.isMethodDeclaration(d));
    }
    return identifierFixed(callee, new Set());
  };
  /** The nearest enclosing declaration with a name: what a call-site key is relative to. */
  const enclosingNamed = (node: ts.Node): ts.Node | undefined => {
    for (let at = node.parent; at !== undefined; at = at.parent) {
      if (ts.isConstructorDeclaration(at)) return at;
      if (
        (ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at) || ts.isGetAccessorDeclaration(at) || ts.isSetAccessorDeclaration(at) ||
          ts.isPropertyDeclaration(at) || ts.isClassDeclaration(at)) &&
        at.name !== undefined
      ) {
        return at;
      }
      if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name)) return at;
    }
    return undefined;
  };
  /** `path:Enclosing:callee()`, numbered `#n` in source order when the enclosing declaration makes several calls of that callee. */
  const callSiteKey = (call: ts.CallExpression | ts.NewExpression, callee: ts.Expression): string => {
    const enclosing = enclosingNamed(call);
    const text = callee.getText();
    const base = `${enclosing !== undefined ? closureKey(enclosing, options.root) : `${relativeName(call.getSourceFile().fileName, options.root)}:(top level)`}:${text}()`;
    const same: ts.Node[] = [];
    const walk = (n: ts.Node): void => {
      if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && unwrap(n.expression).getText() === text && enclosingNamed(n) === enclosing) same.push(n);
      ts.forEachChild(n, walk);
    };
    walk(enclosing ?? call.getSourceFile());
    return same.length > 1 ? `${base}#${same.indexOf(call) + 1}` : base;
  };
  /** A call whose target is not fixed and seen: allowed only at a call site named as a collaborator. */
  const unseenTarget = (call: ts.CallExpression | ts.NewExpression, callee: ts.Expression, what = "a call whose target the check cannot see (supplied at run time, or third-party code)"): void => {
    const key = callSiteKey(call, callee);
    if (options.collaborators?.has(key) === true) {
      let matched = matches.get(key);
      if (matched === undefined) matches.set(key, (matched = new Set()));
      matched.add(call);
      return;
    }
    report(call, `${what}; name the call site ${key} as a collaborator, with its reason`);
  };
  /**
   * Whether the callee is code the check walks: a function, method or class declared in the
   * repository (directly or through a const alias), or a function written in place. A call into it
   * is seen through its own body, where a call through a parameter is resolved against its callers.
   */
  const walkedTarget = (callee: ts.Expression, seen: Set<ts.Node> = new Set()): boolean => {
    if (isPrivateMember(callee)) {
      const declarations = symbolOf((callee as ts.PropertyAccessExpression).name)?.declarations ?? [];
      return declarations.length > 0 && declarations.every((d) => ts.isMethodDeclaration(d));
    }
    if (!ts.isIdentifier(callee)) return false;
    const declarations = symbolOf(callee)?.declarations ?? [];
    return declarations.length > 0 && declarations.every((d) => {
      if (seen.has(d) || isIntrinsic(d) || isThirdParty(d)) return false;
      seen.add(d);
      if (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d) || ts.isClassDeclaration(d)) return true;
      if (isConst(d) && d.initializer !== undefined) {
        const init = unwrap(d.initializer);
        return ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isClassExpression(init) || (ts.isIdentifier(init) && walkedTarget(init, seen));
      }
      return false;
    });
  };
  /** Whether a parameter of this type may be invoked by its callee: a function type, `Function`, or a type parameter constrained to one. */
  const isCallableType = (type: ts.Type, seen: Set<ts.Type> = new Set()): boolean => {
    if (seen.has(type)) return false;
    seen.add(type);
    if (type.isUnion() || type.isIntersection()) return type.types.some((part) => isCallableType(part, seen));
    if (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never)) return false;
    const t = type;
    if (t.flags & ts.TypeFlags.TypeParameter) {
      const constraint = checker.getBaseConstraintOfType(t);
      return constraint !== undefined && constraint !== t && isCallableType(constraint, seen);
    }
    if (t.getCallSignatures().length + t.getConstructSignatures().length > 0) return true;
    const name = (t.getSymbol() ?? t.aliasSymbol)?.getName();
    return name === "Function" || name === "CallableFunction" || name === "NewableFunction";
  };
  /** Whether `argument` may be invoked by the callee: its parameter is callable, or is `any` and the argument is a function. */
  const mayBeInvoked = (argument: ts.Expression): boolean => {
    const parameter = checker.getContextualType(argument);
    if (parameter === undefined) return isCallableType(typeOf(argument));
    if (isCallableType(parameter)) return true;
    return (parameter.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 && isCallableType(typeOf(argument));
  };
  /**
   * Whether every function an opaque callee (an intrinsic, a node: built-in, a load-time capture) may
   * invoke among its operands is seen code (astra pack 307): `Reflect.apply(f, ...)`, an uncurried
   * `call` or `bind`, `new Promise(executor)` or `then(onFulfilled)` run their function operand. An
   * operand in a callable parameter position, a callable element of an array literal passed as an
   * argument list, and an array argument of callable elements must each be fixed.
   */
  const operandsSeen = (call: ts.CallExpression | ts.NewExpression): boolean => {
    const atLoad = runsAtLoad(call);
    const fixed = (e: ts.Expression): boolean => (atLoad ? loadTimeFixed(e, new Set()) : valueFixed(e, new Set()));
    for (const argument of call.arguments ?? []) {
      const a = unwrap(argument);
      if (mayBeInvoked(argument) && !fixed(argument)) return false;
      if (ts.isArrayLiteralExpression(a)) {
        for (const element of a.elements) {
          if (ts.isSpreadElement(element)) return false;
          if (mayBeInvoked(element) && !fixed(element)) return false;
        }
      } else {
        const elementType = checker.getIndexTypeOfType(checker.getNonNullableType(typeOf(argument)), ts.IndexKind.Number);
        if (elementType !== undefined && isCallableType(elementType) && !fixed(argument)) return false;
      }
    }
    return true;
  };

  // -- provenance (astra pack 309): what a caller supplies is read only through an own-data reader --
  const isLoose = (type: ts.Type): boolean => (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
  /**
   * A type with nothing the code can read: `unknown`, `any`, `object` or `{}`. A value of it can be
   * read only once it is taken as a readable shape, which is a conversion.
   */
  const isOpaque = (type: ts.Type): boolean => {
    if (isLoose(type) || (type.flags & ts.TypeFlags.NonPrimitive) !== 0) return true;
    if (type.isIntersection()) return type.types.every(isOpaque);
    return (type.flags & ts.TypeFlags.Object) !== 0 && checker.getPropertiesOfType(type).length === 0 && checker.getIndexInfosOfType(type).length === 0 &&
      type.getCallSignatures().length === 0 && type.getConstructSignatures().length === 0;
  };
  /** An opaque value, an array of them, or a union with one: what the code may not read until an own-data reader has. */
  const holdsLoose = (type: ts.Type): boolean => {
    if (isOpaque(type)) return true;
    if (type.isUnion()) return type.types.some(holdsLoose);
    const element = checker.isArrayType(type) || checker.isTupleType(type) ? checker.getIndexTypeOfType(type, ts.IndexKind.Number) : undefined;
    return element !== undefined && isOpaque(element);
  };
  /** Whether a value of this type may be an object whose fields could be read: not only primitives, not a function (calls are call targets), and not unknown or any (opaque until narrowed). */
  const mayBeObject = (type: ts.Type, seen: Set<ts.Type> = new Set()): boolean => {
    if (seen.has(type)) return false;
    seen.add(type);
    if (type.isUnion() || type.isIntersection()) return type.types.some((t) => mayBeObject(t, seen));
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | PRIMITIVE | ts.TypeFlags.ESSymbolLike)) return false;
    if (type.flags & ts.TypeFlags.TypeParameter) {
      const constraint = checker.getBaseConstraintOfType(type);
      return constraint !== undefined && constraint !== type && mayBeObject(constraint, seen);
    }
    return (type.flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive)) !== 0 && !isCallableType(type);
  };
  const isEntryParameter = (declaration: ts.Node): declaration is ts.ParameterDeclaration =>
    ts.isParameter(declaration) && ts.isFunctionLike(declaration.parent) && isEntryPoint(declaration.parent);
  /** Where an opaque callee was taken from: `Object.getOwnPropertyDescriptor`, `node:util.types.isProxy`, `uncurried Object.prototype.hasOwnProperty`. */
  const capturedPath = (expression: ts.Expression, seen: Set<ts.Node> = new Set()): string | undefined => {
    const e = unwrap(expression);
    if (ts.isPropertyAccessExpression(e)) {
      const base = capturedPath(e.expression, seen);
      return base === undefined ? undefined : `${base}.${e.name.text}`;
    }
    if (ts.isCallExpression(e) && e.arguments.length === 1) {
      const callee = capturedPath(e.expression, seen);
      const argument = capturedPath(e.arguments[0]!, seen);
      if (callee === "Function.prototype.bind.bind" && argument === "Function.prototype.call") return "uncurryThis";
      if (callee === "uncurryThis" && argument !== undefined) return `uncurried ${argument}`;
      return undefined;
    }
    if (!ts.isIdentifier(e)) return undefined;
    const from = importedFrom(e);
    if (from !== null && from.startsWith("node:")) {
      // A node: binding, by the name it is imported under: `node:util.types` for `import { types } from "node:util"`.
      const specifier = checker.getSymbolAtLocation(e)?.declarations?.[0];
      if (specifier !== undefined && ts.isImportSpecifier(specifier)) return `${from}.${(specifier.propertyName ?? specifier.name).text}`;
      return specifier !== undefined && ts.isNamespaceImport(specifier) ? from : undefined;
    }
    const symbol = symbolOf(e);
    const declaration = symbol?.declarations?.[0];
    if (declaration === undefined) return undefined;
    if (isIntrinsic(declaration)) return symbol!.getName();
    if (isLoadTimeConst(declaration) && !seen.has(declaration)) {
      // `seen` holds the consts being followed (a cycle guard), not every const met: one may appear twice.
      seen.add(declaration);
      const path = capturedPath(declaration.initializer!, seen);
      seen.delete(declaration);
      return path;
    }
    return undefined;
  };
  /**
   * Whether an opaque callee reads only its operands' own data or identity, running no getter on
   * them: what a caller's value may be passed to. One of OWN_DATA_READERS by the path it was captured
   * from, or an in-repo capture named in CheckOptions.ownDataReaders; `Reflect.apply` of one of them
   * (`ReflectApply(HasOwnProperty, o, [k])`); or the reject of an executor handed to the Promise
   * captured at load, which holds its reason and reads nothing of it.
   */
  const isOwnDataReader = (callee: ts.Expression, call?: ts.CallExpression | ts.NewExpression): boolean => {
    const path = capturedPath(callee);
    if (path !== undefined && OWN_DATA_READERS.has(path)) return true;
    if (path === "Reflect.apply" && call !== undefined) {
      const target = call.arguments?.[0];
      const targetPath = target === undefined ? undefined : capturedPath(target);
      if (targetPath !== undefined && (OWN_DATA_READERS.has(`uncurried ${targetPath}`) || OWN_DATA_READERS.has(targetPath))) return true;
    }
    const e = unwrap(callee);
    if (!ts.isIdentifier(e)) return false;
    const declaration = symbolOf(e)?.declarations?.[0];
    if (declaration === undefined) return false;
    if (ts.isParameter(declaration) && ts.isFunctionLike(declaration.parent) && isPromiseExecutor(declaration.parent) && declaration.parent.parameters.indexOf(declaration) === 1) return true;
    const key = closureKey(declaration, options.root);
    if (options.ownDataReaders?.has(key) !== true || !isLoadTimeConst(declaration)) return false;
    let matched = matches.get(key);
    if (matched === undefined) matches.set(key, (matched = new Set()));
    matched.add(declaration);
    return true;
  };
  const elementOf = (type: ts.Type): ts.Type | undefined =>
    checker.isArrayType(type) || checker.isTupleType(type) ? checker.getIndexTypeOfType(type, ts.IndexKind.Number) : undefined;
  /**
   * The brand's key: `[OWNED]`, where OWNED is a `declare const OWNED: unique symbol` in a primordials
   * file. Only an owned snapshot's type carries it (DECISIONS 05:05).
   */
  const isBrandKey = (property: ts.Symbol): boolean =>
    (property.declarations ?? []).some((d) => {
      if (!(ts.isPropertySignature(d) || ts.isPropertyDeclaration(d)) || !ts.isComputedPropertyName(d.name) || !ts.isIdentifier(d.name.expression)) return false;
      const key = declarationOf(d.name.expression);
      return key !== undefined && ts.isVariableDeclaration(key) && ts.isIdentifier(key.name) && key.name.text === "OWNED" && inPrimordials(key);
    });
  /** Whether every value of this type is an owned snapshot: each part, null and undefined aside, carries the brand. */
  const isOwned = (type: ts.Type): boolean => {
    const t = checker.getNonNullableType(type);
    const parts = t.isUnion() ? t.types : [t];
    return parts.length > 0 && parts.every((part) => (part.flags & ts.TypeFlags.Never) === 0 && checker.getPropertiesOfType(part).some(isBrandKey));
  };
  /** Whether the brand appears anywhere in this type: a part of it, an element, a type argument, or a property's type. */
  const containsOwned = (type: ts.Type, seen: Set<ts.Type> = new Set()): boolean => {
    if (seen.has(type)) return false;
    seen.add(type);
    if (type.isUnion() || type.isIntersection()) return type.types.some((t) => containsOwned(t, seen));
    if ((type.flags & ts.TypeFlags.Object) === 0) return false;
    if (checker.getPropertiesOfType(type).some(isBrandKey)) return true;
    if ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference && checker.getTypeArguments(type as ts.TypeReference).some((t) => containsOwned(t, seen))) return true;
    for (const info of checker.getIndexInfosOfType(type)) if (containsOwned(info.type, seen)) return true;
    if (fromLib(type.getSymbol())) return false;
    return checker.getPropertiesOfType(type).some((p) => containsOwned(checker.getTypeOfSymbol(p), seen));
  };
  /** The engine's property descriptor type (lib PropertyDescriptor or TypedPropertyDescriptor). */
  const isPropertyDescriptorType = (type: ts.Type): boolean => {
    const t = checker.getNonNullableType(type);
    const symbol = t.getSymbol() ?? t.aliasSymbol;
    return fromLib(symbol) && (symbol!.getName() === "PropertyDescriptor" || symbol!.getName() === "TypedPropertyDescriptor");
  };
  /** The initializer of a const `identifier` names, through parentheses and assertions; undefined for anything else. */
  const constInitializer = (identifier: ts.Identifier): ts.Expression | undefined => {
    const declaration = checker.getSymbolAtLocation(identifier)?.declarations?.[0];
    return declaration !== undefined && isConst(declaration) && declaration.initializer !== undefined ? unwrap(declaration.initializer) : undefined;
  };
  /** Whether a const object literal defines `name` itself (no spread): a property it makes its own. */
  const literalDefines = (identifier: ts.Identifier, name: string): boolean => {
    const init = constInitializer(identifier);
    if (init === undefined || !ts.isObjectLiteralExpression(init) || init.properties.some((p) => ts.isSpreadAssignment(p))) return false;
    return init.properties.some((p) => p.name !== undefined && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name);
  };
  /**
   * Whether `expression` makes a new object right here: `ObjectCreate(null)`, an object or array
   * literal, `new` of an intrinsic constructor or of a class declared in the repository, or a call of
   * an in-repo function each of whose returns makes one (newList).
   */
  const freshExpression = (expression: ts.Expression, seen: Set<ts.Node> = new Set()): boolean => {
    const e = unwrap(expression);
    if (isFreshObjectCreate(e) || ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e)) return true;
    if (ts.isNewExpression(e)) {
      const declarations = ts.isIdentifier(e.expression) ? symbolOf(e.expression)?.declarations ?? [] : [];
      return walkedTarget(e.expression) || (declarations.length > 0 && declarations.every((d) => isLoadTimeConst(d) && capturedPath(d.initializer!) !== undefined && isIntrinsicPath(capturedPath(d.initializer!)!)));
    }
    if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return false;
    const fn = symbolOf(e.expression)?.declarations?.[0];
    if (fn === undefined || !ts.isFunctionDeclaration(fn) || fn.body === undefined || seen.has(fn) || isIntrinsic(fn) || isThirdParty(fn)) return false;
    seen.add(fn);
    const returns: ts.ReturnStatement[] = [];
    const walk = (n: ts.Node): void => {
      if (ts.isFunctionLike(n) && n !== fn) return;
      if (ts.isReturnStatement(n)) returns.push(n);
      ts.forEachChild(n, walk);
    };
    walk(fn.body);
    // A return of a const the function itself bound to a fresh value (`const out = newList(n); ... return out;`).
    return returns.length > 0 && returns.every((r) => r.expression !== undefined && (freshExpression(r.expression, seen) || isFreshLocal(r.expression)));
  };
  /** Whether a captured path names an intrinsic constructor whose `new` makes a fresh object. */
  const isIntrinsicPath = (path: string): boolean => FRESH_CONSTRUCTORS.has(path);
  /** A const bound to a value the code just made (freshExpression). */
  const isFreshLocal = (expression: ts.Expression): boolean => {
    const e = unwrap(expression);
    if (!ts.isIdentifier(e)) return false;
    if (isNullPrototypeRecord(e)) return true;
    const init = constInitializer(e);
    return init !== undefined && freshExpression(init);
  };
  /**
   * Whether `receiver` is owned where `name` is read from it (DECISIONS 05:05): its type carries the
   * brand; it is a const bound to a fresh null-prototype record, or to an object literal that defines
   * `name`; or it is a property descriptor, whose `enumerable` and `configurable` are always its own,
   * and whose `value`, `writable`, `get` and `set` are read only where the trusted hasOwn proves them
   * its own (an accessor's descriptor has no own `value`, and one written on Object.prototype is not its own).
   */
  const ownedReceiver = (read: ts.Node, receiver: ts.Expression, name: string): boolean => {
    if (isOwned(typeOf(receiver))) return true;
    const r = unwrap(receiver);
    if (ts.isIdentifier(r) && (isNullPrototypeRecord(r) || literalDefines(r, name))) return true;
    if (isPropertyDescriptorType(typeOf(receiver))) {
      if (name === "enumerable" || name === "configurable") return true;
      return provenOwn(read, r, name);
    }
    return false;
  };
  /** Whether a type is a type parameter, or `never`, or a union or intersection with one: what an assertion launders into. */
  const launderingTarget = (type: ts.Type): boolean =>
    (type.flags & (ts.TypeFlags.TypeParameter | ts.TypeFlags.Never)) !== 0 || ((type.isUnion() || type.isIntersection()) && type.types.some(launderingTarget));
  /** Whether a type has a property it may lack: an object literal minted as it would read that one from a prototype. */
  const hasOptionalProperty = (type: ts.Type): boolean =>
    (checker.getNonNullableType(type).isUnion() ? (checker.getNonNullableType(type) as ts.UnionType).types : [checker.getNonNullableType(type)]).some((t) =>
      checker.getPropertiesOfType(t).some((p) => (p.flags & ts.SymbolFlags.Optional) !== 0));
  /**
   * Whether a value of type `from` may be taken as `to`, which carries the brand (a mint): the trusted
   * `ObjectCreate(null)` itself (a fresh, empty record with no prototype), an object literal that
   * defines every property `to` has (none optional), or an owned value of that very type.
   */
  const mintAllowed = (operand: ts.Expression, to: ts.Type): boolean => {
    if (isFreshObjectCreate(operand)) return true;
    const e = unwrap(operand);
    if (ts.isObjectLiteralExpression(e)) return !hasOptionalProperty(to) && !e.properties.some((p) => ts.isSpreadAssignment(p));
    if (ts.isArrayLiteralExpression(e)) return !e.elements.some((element) => ts.isSpreadElement(element));
    const from = typeOf(operand);
    return isOwned(from) && checker.isTypeAssignableTo(from, to) && checker.isTypeAssignableTo(to, from);
  };
  /** The trusted `ObjectCreate(null)` itself: a fresh, empty null-prototype object, typed as the code will fill it. */
  const isFreshObjectCreate = (expression: ts.Expression): boolean => {
    const e = unwrap(expression);
    return ts.isCallExpression(e) && ts.isIdentifier(e.expression) && isTrustedObjectCreate(e.expression) &&
      e.arguments.length === 1 && e.arguments[0]!.kind === ts.SyntaxKind.NullKeyword;
  };
  /** A conversion's label: `as T` for an assertion, `is T` for a type predicate, with T's text on one line. */
  const conversionLabel = (node: ts.AsExpression | ts.TypeAssertion | ts.TypePredicateNode): string =>
    `${ts.isTypePredicateNode(node) ? "is" : "as"} ${(node.type ?? node).getText().replace(/\s+/g, " ")}`;
  /** Records that a named entry matched `node`; false when `key` is not in `list`. */
  const named = (list: ReadonlyMap<string, string> | undefined, key: string, node: ts.Node): boolean => {
    if (list?.has(key) !== true) return false;
    let matched = matches.get(key);
    if (matched === undefined) matches.set(key, (matched = new Set()));
    matched.add(node);
    return true;
  };
  /**
   * A value taken as an owned snapshot's type by an assertion or a type predicate (a MINT), where
   * mintAllowed does not allow it: allowed only where `CheckOptions.provenance` names the place, with
   * the snapshot it comes from (DECISIONS 05:05).
   */
  const mint = (node: ts.AsExpression | ts.TypeAssertion | ts.TypePredicateNode): void => {
    const label = conversionLabel(node);
    const enclosing = ts.isTypePredicateNode(node) ? node.parent : enclosingNamed(node);
    const scopeNode = enclosing ?? node.getSourceFile();
    const same: ts.Node[] = [];
    const walk = (n: ts.Node): void => {
      if ((ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || ts.isTypePredicateNode(n)) && conversionLabel(n) === label &&
        (ts.isTypePredicateNode(n) ? n.parent : enclosingNamed(n)) === enclosing) same.push(n);
      ts.forEachChild(n, walk);
    };
    walk(scopeNode);
    const base = `${enclosing !== undefined ? closureKey(enclosing, options.root) : `${relativeName(node.getSourceFile().fileName, options.root)}:(top level)`}:${label}`;
    const key = same.length > 1 ? `${base}#${same.indexOf(node) + 1}` : base;
    if (named(options.provenance, key, node)) return;
    report(node, `an owned snapshot minted from a value no snapshot made: mint one from ObjectCreate(null) or a literal, or name ${key} in provenance with the snapshot it comes from (DECISIONS 05:05)`);
  };
  /** An `any` passed or held where an owned type, or a type parameter, is expected: the implicit form of a mint. */
  const checkFlow = (expression: ts.Expression | undefined): void => {
    if (expression === undefined || isFreshObjectCreate(expression)) return;
    if ((typeOf(expression).flags & ts.TypeFlags.Any) === 0) return;
    const expected = checker.getContextualType(expression);
    if (expected !== undefined && (containsOwned(expected) || launderingTarget(expected))) {
      report(expression, "an any held where an owned snapshot (or a type parameter) is expected: no snapshot made it (DECISIONS 05:05)");
    }
  };
  /**
   * Whether a container of owned values (an array's elements, a Map's or Set's type arguments) is taken
   * as one whose elements are of a different type: a write through the wider type could store a value
   * no snapshot made (array and method covariance).
   */
  const widensElements = (actual: ts.Type, expected: ts.Type): boolean => {
    const same = (a: ts.Type, b: ts.Type): boolean => checker.isTypeAssignableTo(a, b) && checker.isTypeAssignableTo(b, a);
    const actualElement = checker.getIndexTypeOfType(checker.getNonNullableType(actual), ts.IndexKind.Number);
    const expectedElement = checker.getIndexTypeOfType(checker.getNonNullableType(expected), ts.IndexKind.Number);
    if (actualElement !== undefined && expectedElement !== undefined) return containsOwned(actualElement) && !same(actualElement, expectedElement);
    const a = checker.getNonNullableType(actual) as ts.TypeReference;
    const b = checker.getNonNullableType(expected) as ts.TypeReference;
    if (!((a as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) || !((b as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference)) return false;
    const actualArgs = checker.getTypeArguments(a);
    const expectedArgs = checker.getTypeArguments(b);
    return actualArgs.some((t, i) => containsOwned(t) && (expectedArgs[i] === undefined || !same(t, expectedArgs[i]!)));
  };
  /** The paths of the captured intrinsics that write a property onto their first operand. */
  const DEFINERS = new Set(["Object.defineProperty", "Reflect.defineProperty"]);
  /** The writer `fn` is, when CheckOptions.writers names it: a helper whose first parameter is the object it writes. */
  const isWriter = (fn: ts.Node): boolean => (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && options.writers?.has(closureKey(fn, options.root)) === true;
  /**
   * Whether `target` may be written: an owned snapshot (its writes are typed), a const the code just
   * made (a fresh record, literal or `new`), `this.#field`, or the first parameter of a named writer
   * (whose own call sites are judged). A value of any other type may be an owned snapshot held through
   * a wider type, and a write there could store what no snapshot made (astra pack 313).
   */
  const definableTarget = (target: ts.Expression): boolean => {
    if (isOwned(typeOf(target)) || isFreshLocal(target) || freshExpression(target) || isPrivateMember(unwrap(target))) return true;
    // A native promise's own `constructor`, pinned (pinned()): a promise is written only that one constant.
    const kinds = kindsOf(typeOf(target));
    if (kinds.length > 0 && kinds.every((k) => k === "object:Promise" || k === "object:PromiseLike")) return true;
    const t = unwrap(target);
    if (!ts.isIdentifier(t)) return false;
    const declaration = symbolOf(t)?.declarations?.[0];
    if (declaration === undefined || !ts.isParameter(declaration)) return false;
    const fn = declaration.parent;
    if (!isWriter(fn) || (fn as ts.SignatureDeclaration).parameters.indexOf(declaration) !== 0) return false;
    named(options.writers, closureKey(fn, options.root), fn);
    return true;
  };
  /**
   * The checks on a call that writes (an intrinsic definer, or a named writer): its target must be
   * definable, and an owned container may not be widened where it is written (array, Map and Set
   * covariance would let a wider value in).
   */
  const checkWrite = (call: ts.CallExpression | ts.NewExpression, callee: ts.Expression): void => {
    const path = capturedPath(callee);
    const declaration = ts.isIdentifier(unwrap(callee)) ? symbolOf(unwrap(callee))?.declarations?.[0] : undefined;
    const writer = declaration !== undefined && isWriter(declaration);
    if (!(writer || (path !== undefined && DEFINERS.has(path)))) return;
    const target = call.arguments?.[0];
    if (target === undefined) return;
    if (!definableTarget(target)) {
      report(target, "a write to an object that is not an owned snapshot or a value this code just made: through a wider type it could store what no snapshot made (astra pack 313)");
    }
    const expected = checker.getContextualType(target);
    if (expected !== undefined && widensElements(typeOf(target), expected)) {
      report(target, "an owned container widened where it is written: a wider value could be stored in it (astra pack 313)");
    }
  };
  /**
   * Whether `parameter` belongs to a function written as an argument of code the check does not walk
   * (a callback an intrinsic, a node: built-in or a collaborator calls): that code supplies its value.
   */
  const suppliedOutside = (parameter: ts.ParameterDeclaration): boolean => {
    const fn = parameter.parent;
    if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return false;
    let at: ts.Node = fn;
    while (ts.isParenthesizedExpression(at.parent)) at = at.parent;
    const call = at.parent;
    return (ts.isCallExpression(call) || ts.isNewExpression(call)) && call.expression !== at && !walkedTarget(unwrap(call.expression)) && !isPromiseExecutor(fn);
  };
  /** An array literal written right here, dense, of primitives and functions (Reflect.apply's argument list): its elements are the code's own. */
  const primitiveArgumentList = (argument: ts.Expression): boolean => {
    const a = unwrap(argument);
    return ts.isArrayLiteralExpression(a) && a.elements.every((element) =>
      !ts.isSpreadElement(element) && !ts.isOmittedExpression(element) && (!mayBeObject(typeOf(element)) || isCallableType(typeOf(element))) && !holdsLoose(typeOf(element)));
  };
  /** A built-in object an intrinsic reads through its internal slots, not its properties: a Map, Set, WeakSet, Date or typed array. */
  const slotObject = (type: ts.Type): boolean => {
    const kinds = kindsOf(type);
    return kinds.length > 0 && kinds.every((k) => k.startsWith("object:") && k !== "object:Promise" && k !== "object:PromiseLike" && k !== "object:Error" && k !== "object:RegExp" && k !== "object:Function");
  };
  /** Paths whose answer is what the code itself put there (a Map's get), so an owned type for it is the stored value's. */
  const OWNED_ANSWERS = new Set(["uncurried Map.prototype.get", "uncurried Map.prototype.set", "Object.defineProperty"]);
  /**
   * The operands and answer of a call into code the check does not walk (an intrinsic, a node:
   * built-in, a capture, a collaborator): an object handed to it may be read through [[Get]] (its
   * toJSON, toString, then or constructor looked up) unless it is an own-data reader, and its answer
   * may not claim an owned type (DECISIONS 05:05).
   */
  const checkOpaqueCall = (call: ts.CallExpression | ts.NewExpression, callee: ts.Expression): void => {
    if (walkedTarget(callee)) return;
    // A call through a parameter runs what its callers pass: callTargetFixed judged that.
    const parameter = ts.isIdentifier(unwrap(callee)) ? symbolOf(unwrap(callee))?.declarations?.[0] : undefined;
    if (parameter !== undefined && ts.isParameter(parameter)) return;
    const path = capturedPath(callee);
    // A new Map, Set or array is empty: its type arguments describe what the code will put in it (writes are checked).
    const fresh = ts.isNewExpression(call) && path !== undefined && FRESH_CONSTRUCTORS.has(path);
    if (!fresh && containsOwned(typeOf(call)) && !(path !== undefined && OWNED_ANSWERS.has(path))) {
      report(call, "an owned type for what code the check does not walk answers: no snapshot made it (DECISIONS 05:05)");
    }
    if (isOwnDataReader(callee, call)) return;
    for (const argument of call.arguments ?? []) {
      const type = typeOf(argument);
      if (holdsLoose(type) || (mayBeObject(type) && !isCallableType(type) && !slotObject(type) && !primitiveArgumentList(argument))) {
        unseenTarget(call, callee, "an object handed to code the check does not walk, which may read it through [[Get]] (DECISIONS 05:05)");
        return;
      }
    }
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
    if (ts.isTypePredicateNode(node)) {
      // A type predicate that narrows to an owned type mints, wherever it is called (DECISIONS 05:05).
      if (node.type !== undefined && containsOwned(checker.getTypeFromTypeNode(node.type))) mint(node);
      return false;
    }
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return false; // erased
    // Operator and punctuation tokens are the structure of the node above them, which is checked.
    if (node.kind >= ts.SyntaxKind.FirstPunctuation && node.kind <= ts.SyntaxKind.LastPunctuation) return true;
    switch (node.kind) {
      // A caller's value, and an any held where an object type is expected (astra pack 309).
      case ts.SyntaxKind.Parameter: {
        // Where a value comes from outside (an entry point's caller, or code the check does not walk that calls a
        // function handed to it), an owned type would be the caller's claim: anything can be handed in typed so.
        const n = node as ts.ParameterDeclaration;
        if (containsOwned(checker.getTypeAtLocation(n)) && (isEntryParameter(n) || suppliedOutside(n))) {
          report(n, "an owned type where code outside the check supplies the value: no snapshot made it (DECISIONS 05:05)");
        }
        return true;
      }
      case ts.SyntaxKind.VariableDeclaration: {
        const n = node as ts.VariableDeclaration;
        if (n.type !== undefined) checkFlow(n.initializer);
        return true;
      }
      // Declarations and members: walked into; their expressions are checked as they come.
      case ts.SyntaxKind.FunctionDeclaration:
      case ts.SyntaxKind.ClassDeclaration:
      case ts.SyntaxKind.Constructor:
      case ts.SyntaxKind.MethodDeclaration:
      case ts.SyntaxKind.PropertyDeclaration:
      case ts.SyntaxKind.GetAccessor:
      case ts.SyntaxKind.SetAccessor:
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
      case ts.SyntaxKind.ReturnStatement:
        checkFlow((node as ts.ReturnStatement).expression);
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
        const kinds = kindsOf(typeOf(n.expression));
        for (const kind of kinds) {
          if (!(name === "length" && (kind === "array" || kind === "string"))) report(n, `.${name} on a ${kind}`);
        }
        // A static type is no evidence of where a field comes from (DECISIONS 05:05): the receiver must be owned.
        if (kinds.length === 0 && !ownedReceiver(n, n.expression, name)) {
          report(n, `.${name} on a receiver that is not an owned snapshot: its type says nothing about where the field comes from (DECISIONS 05:05)`);
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
        } else if (!callTargetFixed(callee)) {
          unseenTarget(n, callee);
        } else if (!walkedTarget(callee) && !operandsSeen(n)) {
          unseenTarget(n, callee, "a call into code the check does not walk, which may invoke a function operand the check cannot see");
        }
        for (const argument of n.arguments) checkFlow(argument);
        if (ts.isIdentifier(callee) || isPrivateMember(callee) || callee.kind === ts.SyntaxKind.SuperKeyword) {
          checkOpaqueCall(n, callee);
          checkWrite(n, callee);
        }
        return true;
      }
      case ts.SyntaxKind.NewExpression: {
        const n = node as ts.NewExpression;
        if (!ts.isIdentifier(n.expression)) report(n, "new of a constructor looked up at call time");
        else if (!callTargetFixed(n.expression)) unseenTarget(n, n.expression);
        else if (!walkedTarget(n.expression) && !operandsSeen(n)) {
          unseenTarget(n, n.expression, "a construction by code the check does not walk, which may invoke a function operand the check cannot see");
        }
        for (const argument of n.arguments ?? []) checkFlow(argument);
        if (ts.isIdentifier(n.expression)) checkOpaqueCall(n, n.expression);
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
          checkFlow(n.right);
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
      case ts.SyntaxKind.AsExpression:
      case ts.SyntaxKind.TypeAssertionExpression: {
        const n = node as ts.AsExpression | ts.TypeAssertion;
        if (launderingTarget(typeOf(n))) {
          report(n, "an assertion to a type parameter or to never: it takes any value as whatever it is instantiated with (astra pack 313)");
        } else if (containsOwned(typeOf(n)) && !mintAllowed(n.expression, typeOf(n))) {
          mint(n);
        }
        return true;
      }
      case ts.SyntaxKind.ConditionalExpression:
      case ts.SyntaxKind.ParenthesizedExpression:
      case ts.SyntaxKind.NonNullExpression:
      case ts.SyntaxKind.SatisfiesExpression:
      case ts.SyntaxKind.TypeOfExpression:
      case ts.SyntaxKind.VoidExpression:
      case ts.SyntaxKind.ArrowFunction:
      case ts.SyntaxKind.FunctionExpression:
      case ts.SyntaxKind.ShorthandPropertyAssignment:
        return true;
      case ts.SyntaxKind.ObjectLiteralExpression:
        return true;
      case ts.SyntaxKind.PropertyAssignment:
        checkFlow((node as ts.PropertyAssignment).initializer);
        return true;
      case ts.SyntaxKind.ComputedPropertyName: {
        const expression = (node as ts.ComputedPropertyName).expression;
        if (!isPrimitive(expression)) report(node, "a computed key that is not a primitive (its toString is looked up)");
        return true;
      }
      case ts.SyntaxKind.ArrayLiteralExpression:
        for (const element of (node as ts.ArrayLiteralExpression).elements) if (!ts.isSpreadElement(element)) checkFlow(element);
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
          if (kinds.length === 0 && !isOwned(typeOf(n))) report(element, `destructuring .${name} from a value that is not an owned snapshot (DECISIONS 05:05)`);
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
        if (ts.isVariableStatement(statement)) {
          for (const d of statement.declarationList.declarations) if (d.initializer) loadTime.add(d.initializer);
        } else if (ts.isClassDeclaration(statement)) {
          for (const clause of statement.heritageClauses ?? []) loadTime.add(clause);
        } else if (!ts.isFunctionDeclaration(statement) && !ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement) &&
          !ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) {
          // A top-level statement (`table[key] = fn;`, `ObjectFreeze(x);`) runs once, at load.
          loadTime.add(statement);
        }
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
    // An instance field's initializer runs at `new`, after load, even in a class evaluated at load (astra pack 303);
    // its computed name, and a static field's initializer, run when the class is evaluated.
    const deferred = ts.isPropertyDeclaration(node) && (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Static) === 0 ? node.initializer : undefined;
    ts.forEachChild(node, (child) => visit(child, child === deferred ? false : now, loadTime));
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
  // An in-memory file's directory exists, so a module in it resolves.
  const directoryExists = host.directoryExists?.bind(host) ?? ts.sys.directoryExists;
  host.directoryExists = (name) => {
    const prefix = `${name.split("\\").join("/").replace(/\/+$/, "")}/`;
    return [...files.keys()].some((file) => file.split("\\").join("/").startsWith(prefix)) || directoryExists(name);
  };
  return ts.createProgram([...files.keys()], options, host);
}
