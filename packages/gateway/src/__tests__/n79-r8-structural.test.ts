/**
 * N79 round 8 (astra pack 126i, MEDIUM-3 / Q4 on 4b24042b; iteration 3, lead review).
 *
 * The superseded T1 test (n79-r6-review.test.ts, "P1 (T1, general AST scan)...", removed by this
 * round — see n79-r8/scan.patch for the deletion diff) parsed an AST but matched writer calls with
 * REGEXES over source text, and authorized callers by NAME only. Two bypasses, reproduced against
 * that test at 4b24042b (n79-r8/repro-scan-at-4b24042b.txt):
 *   - `repos.escrows.updateMilestoneStatus(resolveId(), "released")` — a nested call inside the
 *     argument list evades the `[^)]*` regex (it can't cross the `)` that closes the nested call);
 *   - a function named `recordChainSettlement` in ANY OTHER FILE is treated as an allowed writer,
 *     because the authorization check compared the TEXT "recordChainSettlement", never which file
 *     or which declaration produced it.
 *
 * This test instead builds a real `ts.Program` + `TypeChecker` over the gateway's OWN production
 * source (its own tsconfig, noEmit + skipLibCheck) and identifies every writer PRIMITIVE and every
 * ALLOWED WRITER by DECLARATION IDENTITY — the actual AST node(s) a symbol or a call's resolved
 * signature point to — never by name text alone.
 *
 * MODULE RESOLUTION. dist/ is not built for any @pcc/* workspace package in this environment (only
 * node_modules are installed), so a plain ts.Program would fail to resolve `@pcc/store` et al. —
 * exactly the problem packages/gateway/vitest.config.ts already documents and solves for the Vite/
 * esbuild layer by aliasing every `@pcc/*` specifier straight to its TypeScript source. This test
 * does the same thing one layer down, for the TypeScript module resolver itself (see
 * `buildPccAliasMap` / `resolveModuleNames` below) — hermetic, no monorepo build required.
 *
 * WRITER PRIMITIVES (matched by declaration, never by name):
 *   1. `updateMilestoneStatus` / `updateStatus` — anchored to BOTH the `IEscrowRepository` method
 *      (gateway code typed through `getRepos(): IRepositories` resolves here) AND the method of
 *      EVERY class that structurally `implements IEscrowRepository` (found via heritage-clause
 *      walk + alias-resolved symbol comparison, never a hard-coded file list — today that's just
 *      `EscrowRepository`, packages/db/src/repositories/settlement.ts:7, reached e.g. through
 *      `buildRepositories(db).escrows...`, which resolves to the CONCRETE class, not the interface).
 *   2. `insert` (escrows: a literal `"completed"` status is a write) / `insertMilestone` (escrow
 *      milestones: a literal `"released"` status is a write) — same dual interface+class anchoring
 *      as #1. Status is read the same way as a Drizzle `.set(...)`/`.values(...)` object (see
 *      `classifySetArgument`): the single object-literal argument's `status` property.
 *   3. `casEscrowStatus` (packages/gateway/src/services/escrow-refund.ts, module-private).
 *   4. a Drizzle `update(<table>)` / `insert(<table>)` where `<table>` resolves — by SYMBOL *or* by
 *      TYPE (so a `const t = schema.escrows` alias, or `schema["escrowMilestones"]` element access,
 *      both still resolve; confirmed empirically that TypeScript returns a reference-equal `Type`
 *      for the same underlying table through either form) — to the `escrows` / `escrowMilestones`
 *      declaration in packages/db/src/schema/settlement.ts, immediately followed by `.set(...)` /
 *      `.values(...)`.
 *
 * UNTYPED ESCAPE HATCH. A call whose resolved signature has NO declaration (callee typed `any`,
 * e.g. `(getRepos() as any).escrows.updateMilestoneStatus(...)`) can't be matched by declaration
 * identity at all — identity requires a type to carry it. This is handled as a separate, explicit
 * fallback (`recordUntypedFallback`), by callee NAME TEXT, with asymmetric strictness: the specific
 * names (`updateMilestoneStatus`, `insertMilestone`, `casEscrowStatus` — unlikely to collide with
 * any unrelated repository) are a violation UNCONDITIONALLY when unresolved; the generic/ambiguous
 * names (`updateStatus`, `insert`, and a `.update(X).set(...)` chain whose table ALSO didn't
 * resolve) require a literal `"released"`/`"completed"` status to count as a write, and are
 * POTENTIAL (reviewable) on a non-literal status, to avoid flagging every unrelated any-typed
 * `updateStatus`/`insert` call across the codebase. The Drizzle table-argument path (#4 above) does
 * NOT depend on the call's own signature resolving — it is identity-based on the ARGUMENT — so
 * `(db as any).update(schema.escrows).set(...)` is already caught by the ordinary path, confirmed
 * empirically and exercised again here as a mutant for the regression record.
 *
 * ALLOWED: writes (and any match at all) whose nearest enclosing FunctionDeclaration is, by node
 * identity, escrow-refund.ts's own `recordChainSettlement` or `recordMockEscrowReleased`. The walk
 * passes transparently through anonymous callbacks (both writers' statements live inside
 * `storeDb().transaction(() => { ... })`) and stops at the first true FunctionDeclaration ancestor.
 * `casEscrowStatus`'s own body — the one primitive-with-a-body that lives INSIDE the scanned
 * directory — is exempt by the same identity mechanism for its internal Drizzle call (its "dynamic
 * `to`"). The interface/class methods have no body and settlement.ts isn't scanned, so no equivalent
 * exemption is needed for them.
 *
 * NON-CALL REFERENCES to a writer primitive outside the allowed writers are always a violation:
 * assignment, `.bind`/`.call`/`.apply`, argument-passing, destructuring, and (new this round)
 * ElementAccessExpression with a string-literal key (`repos.escrows["updateMilestoneStatus"]`).
 *
 * RAW SQL. A string or template literal naming `update`/`insert into` + `escrows`/`escrow_milestones`
 * anywhere outside the two writers is also a violation — `db.run(sql\`UPDATE escrows ...\`)` is a
 * third, completely untyped way to reach the same tables that no declaration-identity check (typed
 * or untyped-fallback) can see at all, since there is no callee to resolve.
 *
 * FAIL-OPEN GUARD. If an import this test depends on (directly or transitively, within the scanned
 * files) silently fails to resolve, everything downstream of it becomes `any`-typed and vanishes
 * from every check above. The sanity test asserts every import/export module specifier in the
 * scanned files resolves to a symbol, and names any that don't — extended (iteration 3, item B) to
 * dynamic `import(...)` calls (confirmed empirically: `checker.getSymbolAtLocation` resolves a
 * dynamic import's string argument exactly like a static `moduleSpecifier`, same TS2307 on
 * failure) and `require(...)` calls (which get NO such checker treatment at all — a plain function
 * call with a string argument — so these are resolved directly via `resolveSpecifierDirectly`,
 * reusing the exact alias logic the Program itself was built with).
 *
 * REPO-LAYER CLOSURE (iteration 3, item A). Everything above only walks packages/gateway/src/**, so
 * a NEW writer method added to the repository layer ITSELF — e.g. a hypothetical `markReleased(id)`
 * on `EscrowRepository` doing its own `this.db.update(escrowMilestones).set({ status: "released"
 * })` — is invisible to it: gateway code calling that method resolves to a declaration no anchor
 * array contains, and nothing ever inspects the method's OWN body. `scanDbLayerWrites` closes this
 * by walking packages/db/src/** directly (same table-identity-by-symbol-or-type logic as primitive
 * #4) and asserting every matching status-touching write sits inside one of the four anchored
 * primitive METHOD declarations, by node identity — no literal/non-literal split here, since a
 * brand-new repository method is exactly as dangerous whether it hardcodes the terminal status or
 * takes it as a parameter. Scanned: packages/db/src/** EXCLUDING seed/** (dev/test FIXTURE data for
 * the in-memory store — seed/escrow.ts's seedEscrow() literally inserts a milestone with the
 * literal status "released", the INITIAL mock state of a row for local display, never a runtime
 * settlement TRANSITION, and reachable from no request path at all), migrations/** (hand-written
 * .sql, not even TypeScript), __tests__/**, and *.test.ts.
 *
 * Everything else is reviewed in REVIEWED_POTENTIAL_WRITES below, keyed by (file, enclosing
 * function, primitive, exact normalized snippet) — the key doubles as drift detection: if the VALUE
 * at a reviewed site ever changes (not just its existence), the snippet stops matching and the scan
 * reports it as a brand-new, unreviewed finding.
 */
import { describe, it, expect, beforeAll } from "vitest";
import * as ts from "typescript";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────
// Program construction — @pcc/* resolved straight to TypeScript source.
// ─────────────────────────────────────────────────────────────────────────

const SRC_ROOTS = ["src", "ts", ""];
const SRC_EXTS = [".ts", ".tsx"];

function srcForDistTarget(pkgDir: string, target: string): string | null {
  const rest = target.replace(/^\.\//, "").replace(/^dist\//, "");
  const base = rest.replace(/\.[cm]?js$/, "");
  for (const root of SRC_ROOTS) {
    for (const ext of SRC_EXTS) {
      const cand = join(pkgDir, root, base + ext);
      if (existsSync(cand)) return cand;
    }
  }
  return null;
}

function pickExportTarget(val: unknown): string | null {
  if (typeof val === "string") return val;
  if (val && typeof val === "object") {
    const o = val as Record<string, unknown>;
    const t = o.import ?? o.default ?? o.node ?? o.require;
    return typeof t === "string" ? t : null;
  }
  return null;
}

interface PccAliases {
  /** Exact specifier -> source file, for "." and any explicitly declared "exports" subpath. */
  exact: Map<string, string>;
  /** Package name -> its directory, for packages with NO "exports" map (or a subpath outside it)
   *  — e.g. `@pcc/verifier` declares only "main"/"types", so Node's default (unrestricted) subpath
   *  resolution lets production code import `@pcc/verifier/dist/capture/verifier.js` directly.
   *  Confirmed on the current tree: 10 such imports across capture/verifier-factory.ts,
   *  routes/capture.ts, routes/capture-3d.ts all into `@pcc/verifier/dist/**`. */
  pkgDirByName: Map<string, string>;
}

/** @pcc/<name>[/<subpath>] -> absolute TypeScript source entry file. Mirrors
 *  packages/gateway/vitest.config.ts's buildWorkspaceAliases (same problem, one layer down: the
 *  TypeScript module resolver, not Vite/esbuild). */
function buildPccAliasMap(pkgsDir: string): PccAliases {
  const exact = new Map<string, string>();
  const pkgDirByName = new Map<string, string>();
  for (const entry of readdirSync(pkgsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgDir = join(pkgsDir, entry.name);
    const pjPath = join(pkgDir, "package.json");
    if (!existsSync(pjPath)) continue;
    let pj: { name?: string; exports?: unknown; main?: string; module?: string };
    try {
      pj = JSON.parse(readFileSync(pjPath, "utf8"));
    } catch {
      continue;
    }
    const name = pj.name ?? "";
    if (!name.startsWith("@pcc/")) continue;
    pkgDirByName.set(name, pkgDir);
    const subentries: Array<[string, string | null]> = [];
    if (pj.exports && typeof pj.exports === "object") {
      for (const [key, val] of Object.entries(pj.exports as Record<string, unknown>)) {
        subentries.push([key, pickExportTarget(val)]);
      }
    } else if (typeof pj.exports === "string") {
      subentries.push([".", pj.exports]);
    }
    if (subentries.length === 0) subentries.push([".", pj.module ?? pj.main ?? "./dist/index.js"]);
    for (const [key, target] of subentries) {
      if (!target) continue;
      const src = srcForDistTarget(pkgDir, target);
      if (!src) continue;
      const spec = key === "." ? name : `${name}/${key.replace(/^\.\//, "")}`;
      exact.set(spec, src);
    }
  }
  return { exact, pkgDirByName };
}

/** Fallback for a `@pcc/<name>/<subpath>` specifier not covered by an explicit "exports" entry:
 *  packages without an "exports" map (only "main"/"types") impose no subpath restriction, so
 *  production code can and does import e.g. `@pcc/verifier/dist/capture/verifier.js` directly. */
function resolvePccDeepSubpath(moduleName: string, aliases: PccAliases): string | null {
  const match = /^(@pcc\/[^/]+)\/(.+)$/.exec(moduleName);
  if (!match) return null;
  const [, pkgName, subpath] = match;
  const pkgDir = aliases.pkgDirByName.get(pkgName!);
  if (!pkgDir) return null;
  return srcForDistTarget(pkgDir, subpath!);
}

interface BuiltProgram {
  program: ts.Program;
  checker: ts.TypeChecker;
  /** Gateway production files — the scope of the original P1 scan. */
  files: string[];
  /** packages/db/src production files — the scope of the repo-layer closure scan (iteration 3,
   *  item A). EXCLUDES seed/**, migrations/**, __tests__/**, *.test.ts, *.d.ts. seed/** is excluded
   *  because it is dev/test FIXTURE data for the in-memory store (confirmed: seed/escrow.ts's
   *  seedEscrow() literally inserts a milestone with the literal status "released" — the INITIAL
   *  mock state of a row for local display, never a runtime settlement TRANSITION, and reachable
   *  from no request path at all). migrations/** is raw hand-written .sql, not even TypeScript. */
  dbFiles: string[];
  gatewaySrcDir: string;
  gatewayDir: string;
  dbSrcDir: string;
  pkgsDir: string;
  compilerOptions: ts.CompilerOptions;
  pccAliasMap: PccAliases;
}

/** Parse a package's own tsconfig the same way buildProgram does for gateway, returning the
 *  resolved compiler options (noEmit/skipLibCheck layered on) and its own include/exclude file
 *  list — the common logic shared by the gateway scope and the db-layer scope. */
function parseOwnTsconfig(pkgDir: string): { fileNames: string[]; options: ts.CompilerOptions } {
  const configPath = join(pkgDir, "tsconfig.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(`fatal: cannot read ${configPath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")}`);
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, pkgDir);
  // rootDir/outDir/declaration(Map)/composite are irrelevant to a noEmit structural scan, and the
  // first three produce a spurious "File is not under rootDir" diagnostic once @pcc/* aliasing
  // pulls sibling-package source into the same program (confirmed while building this test).
  const { rootDir, outDir, declaration, declarationMap, composite, ...restOptions } = parsed.options;
  return { fileNames: parsed.fileNames, options: { ...restOptions, noEmit: true, skipLibCheck: true } };
}

function buildProgram(): BuiltProgram {
  const here = dirname(fileURLToPath(import.meta.url)); // .../gateway/src/__tests__
  const gatewaySrcDir = resolve(here, ".."); // .../gateway/src
  const gatewayDir = resolve(gatewaySrcDir, ".."); // .../gateway
  const pkgsDir = resolve(gatewayDir, ".."); // .../packages
  const dbDir = join(pkgsDir, "db");
  const dbSrcDir = join(dbDir, "src");

  const pccAliasMap = buildPccAliasMap(pkgsDir);

  const gatewayParsed = parseOwnTsconfig(gatewayDir);
  const compilerOptions = gatewayParsed.options; // shared for both program roots — one Program, one checker.

  // Belt-and-suspenders on top of the tsconfig's own include/exclude (already excludes
  // src/**/*.test.ts and src/__tests__/** — verified it yields exactly the 263 production files).
  const files = gatewayParsed.fileNames.filter(
    (f) => !f.includes(`${sep}__tests__${sep}`) && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"),
  );

  const dbParsed = parseOwnTsconfig(dbDir);
  const dbFiles = dbParsed.fileNames.filter(
    (f) =>
      !f.includes(`${sep}__tests__${sep}`) &&
      !f.includes(`${sep}seed${sep}`) &&
      !f.includes(`${sep}migrations${sep}`) &&
      !f.endsWith(".test.ts") &&
      !f.endsWith(".d.ts"),
  );

  const moduleResolutionCache = ts.createModuleResolutionCache(gatewayDir, (f) => f, compilerOptions);
  function resolveModuleNames(
    moduleNames: string[],
    containingFile: string,
    _reusedNames: string[] | undefined,
    _redirectedReference: ts.ResolvedProjectReference | undefined,
    options: ts.CompilerOptions,
  ): (ts.ResolvedModule | undefined)[] {
    return moduleNames.map((moduleName) => {
      const alias = pccAliasMap.exact.get(moduleName) ?? resolvePccDeepSubpath(moduleName, pccAliasMap);
      if (alias) return { resolvedFileName: alias, extension: ts.Extension.Ts, isExternalLibraryImport: false };
      return ts.resolveModuleName(moduleName, containingFile, options, ts.sys, moduleResolutionCache).resolvedModule;
    });
  }

  const host = ts.createCompilerHost(compilerOptions);
  host.resolveModuleNames = resolveModuleNames;

  // ONE Program covering both scopes (gateway files + db files as roots) — db/src files were
  // already pulled in transitively via @pcc/store aliasing anyway; rooting them explicitly just
  // guarantees every db/src file we care about is present even if nothing gateway-side imports it.
  const program = ts.createProgram({ rootNames: [...files, ...dbFiles], options: compilerOptions, host });
  const checker = program.getTypeChecker();

  return { program, checker, files, dbFiles, gatewaySrcDir, gatewayDir, dbSrcDir, pkgsDir, compilerOptions, pccAliasMap };
}

// ─────────────────────────────────────────────────────────────────────────
// Anchors — the exact declaration nodes (and, for tables, types) every call/reference is compared
// against, by identity. Repo-method primitives anchor to ARRAYS: the interface method PLUS the
// method of every class that structurally implements it (found via heritage clauses, never a
// hard-coded file list), since gateway code can be typed through either.
// ─────────────────────────────────────────────────────────────────────────

interface Anchors {
  updateMilestoneStatusDecls: ts.Declaration[];
  updateStatusDecls: ts.Declaration[];
  insertDecls: ts.Declaration[];
  insertMilestoneDecls: ts.Declaration[];
  casEscrowStatusDecl: ts.FunctionDeclaration;
  recordChainSettlementDecl: ts.FunctionDeclaration;
  recordMockEscrowReleasedDecl: ts.FunctionDeclaration;
  escrowsTableDecl: ts.Declaration;
  escrowsTableType: ts.Type;
  escrowMilestonesTableDecl: ts.Declaration;
  escrowMilestonesTableType: ts.Type;
}

/** Follow an import alias symbol to the symbol it actually refers to (a heritage-clause type
 *  reference resolves, via getSymbolAtLocation, to the LOCAL import specifier's symbol — a
 *  different object from the interface declaration's own symbol — not through it). */
function resolveAliasedSymbol(checker: ts.TypeChecker, sym: ts.Symbol | undefined): ts.Symbol | undefined {
  if (sym && sym.flags & ts.SymbolFlags.Alias) return checker.getAliasedSymbol(sym);
  return sym;
}

/** Every ClassDeclaration in the program (excluding node_modules) whose heritage clause
 *  `implements` the given interface declaration, found structurally — never by a hard-coded file
 *  list. Confirmed empirically: ~80ms over ~880 non-node_modules source files. */
function findImplementingClasses(program: ts.Program, checker: ts.TypeChecker, ifaceDecl: ts.InterfaceDeclaration): ts.ClassDeclaration[] {
  const ifaceSymbol = checker.getSymbolAtLocation(ifaceDecl.name);
  const implementers: ts.ClassDeclaration[] = [];
  function visit(node: ts.Node) {
    if (ts.isClassDeclaration(node) && node.heritageClauses) {
      for (const hc of node.heritageClauses) {
        if (hc.token !== ts.SyntaxKind.ImplementsKeyword) continue;
        for (const t of hc.types) {
          const sym = resolveAliasedSymbol(checker, checker.getSymbolAtLocation(t.expression));
          if (sym === ifaceSymbol) implementers.push(node);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  for (const sf of program.getSourceFiles()) {
    if (sf.fileName.includes(`${sep}node_modules${sep}`)) continue;
    visit(sf);
  }
  return implementers;
}

function methodDecl(members: ts.NodeArray<ts.ClassElement | ts.TypeElement>, name: string): ts.Declaration | undefined {
  for (const m of members) {
    if ((ts.isMethodSignature(m) || ts.isMethodDeclaration(m)) && ts.isIdentifier(m.name) && m.name.text === name) return m;
  }
  return undefined;
}

function findAnchors(program: ts.Program, gatewayDir: string, pkgsDir: string): Anchors {
  const refundPath = join(gatewayDir, "src/services/escrow-refund.ts");
  const refundSf = program.getSourceFile(refundPath);
  if (!refundSf) throw new Error(`fatal: ${refundPath} is not in the program`);
  const checker = program.getTypeChecker();

  let casEscrowStatusDecl: ts.FunctionDeclaration | undefined;
  let recordChainSettlementDecl: ts.FunctionDeclaration | undefined;
  let recordMockEscrowReleasedDecl: ts.FunctionDeclaration | undefined;
  for (const stmt of refundSf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      if (stmt.name.text === "casEscrowStatus") casEscrowStatusDecl = stmt;
      if (stmt.name.text === "recordChainSettlement") recordChainSettlementDecl = stmt;
      if (stmt.name.text === "recordMockEscrowReleased") recordMockEscrowReleasedDecl = stmt;
    }
  }
  if (!casEscrowStatusDecl) throw new Error("fatal: casEscrowStatus FunctionDeclaration not found in escrow-refund.ts");
  if (!recordChainSettlementDecl) throw new Error("fatal: recordChainSettlement FunctionDeclaration not found in escrow-refund.ts");
  if (!recordMockEscrowReleasedDecl) throw new Error("fatal: recordMockEscrowReleased FunctionDeclaration not found in escrow-refund.ts");

  const ifacePath = join(pkgsDir, "db/src/interfaces/IEscrowRepository.ts");
  const ifaceSf = program.getSourceFile(ifacePath);
  if (!ifaceSf) throw new Error(`fatal: ${ifacePath} is not in the program`);
  let ifaceDecl: ts.InterfaceDeclaration | undefined;
  for (const stmt of ifaceSf.statements) {
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === "IEscrowRepository") ifaceDecl = stmt;
  }
  if (!ifaceDecl) throw new Error("fatal: IEscrowRepository interface declaration not found");

  const updateMilestoneStatusDecls: ts.Declaration[] = [];
  const updateStatusDecls: ts.Declaration[] = [];
  const insertDecls: ts.Declaration[] = [];
  const insertMilestoneDecls: ts.Declaration[] = [];

  function collectFrom(members: ts.NodeArray<ts.ClassElement | ts.TypeElement>, label: string) {
    const ums = methodDecl(members, "updateMilestoneStatus");
    const us = methodDecl(members, "updateStatus");
    const ins = methodDecl(members, "insert");
    const insM = methodDecl(members, "insertMilestone");
    if (ums) updateMilestoneStatusDecls.push(ums);
    if (us) updateStatusDecls.push(us);
    if (ins) insertDecls.push(ins);
    if (insM) insertMilestoneDecls.push(insM);
    if (!ums || !us || !ins || !insM) {
      throw new Error(`fatal: ${label} is missing one of updateMilestoneStatus/updateStatus/insert/insertMilestone`);
    }
  }
  collectFrom(ifaceDecl.members, "IEscrowRepository");

  const implementingClasses = findImplementingClasses(program, checker, ifaceDecl);
  if (implementingClasses.length === 0) throw new Error("fatal: no class found structurally implementing IEscrowRepository — anchor discovery is broken");
  for (const cls of implementingClasses) {
    collectFrom(cls.members, `class ${cls.name?.text ?? "<anonymous>"} implementing IEscrowRepository`);
  }

  const schemaPath = join(pkgsDir, "db/src/schema/settlement.ts");
  const schemaSf = program.getSourceFile(schemaPath);
  if (!schemaSf) throw new Error(`fatal: ${schemaPath} is not in the program`);
  let escrowsTableDecl: ts.VariableDeclaration | undefined;
  let escrowMilestonesTableDecl: ts.VariableDeclaration | undefined;
  for (const stmt of schemaSf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === "escrows") escrowsTableDecl = decl;
        if (ts.isIdentifier(decl.name) && decl.name.text === "escrowMilestones") escrowMilestonesTableDecl = decl;
      }
    }
  }
  if (!escrowsTableDecl) throw new Error("fatal: schema `escrows` table declaration not found");
  if (!escrowMilestonesTableDecl) throw new Error("fatal: schema `escrowMilestones` table declaration not found");
  const escrowsSym = checker.getSymbolAtLocation(escrowsTableDecl.name)!;
  const escrowMilestonesSym = checker.getSymbolAtLocation(escrowMilestonesTableDecl.name)!;
  const escrowsTableType = checker.getTypeOfSymbolAtLocation(escrowsSym, escrowsTableDecl);
  const escrowMilestonesTableType = checker.getTypeOfSymbolAtLocation(escrowMilestonesSym, escrowMilestonesTableDecl);

  return {
    updateMilestoneStatusDecls,
    updateStatusDecls,
    insertDecls,
    insertMilestoneDecls,
    casEscrowStatusDecl,
    recordChainSettlementDecl,
    recordMockEscrowReleasedDecl,
    escrowsTableDecl,
    escrowsTableType,
    escrowMilestonesTableDecl,
    escrowMilestonesTableType,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Structural classification helpers.
// ─────────────────────────────────────────────────────────────────────────

/** Nearest enclosing FunctionDeclaration, walking OUT of arrow functions, function expressions,
 *  method declarations, and every other non-FunctionDeclaration ancestor (e.g. the anonymous
 *  `.transaction(() => ...)` callback both allowed writers use). undefined = no enclosing
 *  FunctionDeclaration at all (top-level, or only inside a class method / arrow-const) — treated
 *  as "outside" by every caller below (fail closed). */
function enclosingFunctionDeclaration(node: ts.Node): ts.FunctionDeclaration | undefined {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur)) return cur;
    cur = cur.parent;
  }
  return undefined;
}

/** Same walk, for the db-layer scan (iteration 3, item A): repo primitives are CLASS METHODS, not
 *  top-level FunctionDeclarations, so the "am I inside the primitive's own body" check needs the
 *  nearest enclosing MethodDeclaration instead — same transparency through anonymous callbacks. */
function enclosingMethodDeclaration(node: ts.Node): ts.MethodDeclaration | undefined {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isMethodDeclaration(cur)) return cur;
    cur = cur.parent;
  }
  return undefined;
}

type StatusClass = { kind: "literal"; value: string } | { kind: "nonliteral" };

/** StringLiteral / NoSubstitutionTemplateLiteral are literals; anything else (identifier, property
 *  access, conditional, a template WITH substitutions, a call, ...) is non-literal. */
function classifyStatusExpr(expr: ts.Expression | undefined): StatusClass {
  if (expr && ts.isStringLiteralLike(expr)) return { kind: "literal", value: expr.text };
  return { kind: "nonliteral" };
}

/** The CallExpression immediately chained after `call` via `.methodName(...)`, e.g. the `.set(...)`
 *  that follows `.update(table)`, or the `.values(...)` that follows `.insert(table)`. undefined if
 *  not directly chained (nothing to analyze structurally). */
function findChainedCall(call: ts.CallExpression, methodName: string): ts.CallExpression | undefined {
  const parent = call.parent;
  if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === call && parent.name.text === methodName) {
    const grandparent = parent.parent;
    if (grandparent && ts.isCallExpression(grandparent) && grandparent.expression === parent) return grandparent;
  }
  return undefined;
}

type SetArgClass = { relevant: false } | { relevant: true; status: StatusClass; snippet: string };

/** Does a `.set(...)` / `.values(...)` / repo `insert(...)`/`insertMilestone(...)` argument touch a
 *  `status` field at all, and if so, is that value a literal or not? A non-object-literal argument,
 *  or an object literal with a spread, is "a spread or non-literal object" — the brief's own
 *  POTENTIAL trigger, full stop, since we can't statically see what it carries (snippet falls back
 *  to the whole argument's text in both cases, since there's no narrower sub-expression to point
 *  to). An object literal with no `status` key and no spread doesn't touch status at all and is
 *  simply irrelevant to this scan. When a `status` key IS found, the snippet is that property's OWN
 *  value text (e.g. "SETTLEMENT_OWNED_ESCROW_STATUS"), not the whole enclosing object literal. */
function classifySetArgument(arg: ts.Expression | undefined): SetArgClass {
  if (!arg) return { relevant: false };
  if (!ts.isObjectLiteralExpression(arg)) return { relevant: true, status: { kind: "nonliteral" }, snippet: arg.getText() };
  let statusExpr: ts.Expression | undefined;
  let hasSpread = false;
  for (const prop of arg.properties) {
    if (ts.isSpreadAssignment(prop)) {
      hasSpread = true;
      continue;
    }
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "status") {
      statusExpr = prop.initializer;
    } else if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === "status") {
      statusExpr = prop.name; // `{ status }` — value IS the identifier `status`.
    }
  }
  if (statusExpr) return { relevant: true, status: classifyStatusExpr(statusExpr), snippet: statusExpr.getText() };
  if (hasSpread) return { relevant: true, status: { kind: "nonliteral" }, snippet: arg.getText() };
  return { relevant: false };
}

/** Table identity for a Drizzle `update(<table>)` / `insert(<table>)` argument: SYMBOL-based first
 *  (precise for the common `schema.escrows` / bare-identifier shape), then TYPE-based (handles an
 *  alias — `const t = schema.escrows` — and an ElementAccessExpression — `schema["escrowMilestones"]`
 *  — both confirmed empirically to still carry a reference-equal `Type` back to the same table). */
function resolveTableKind(expr: ts.Expression, checker: ts.TypeChecker, anchors: Anchors): "escrows" | "escrowMilestones" | undefined {
  let nameNode: ts.Node | undefined;
  if (ts.isPropertyAccessExpression(expr)) nameNode = expr.name;
  else if (ts.isIdentifier(expr)) nameNode = expr;
  if (nameNode) {
    const sym = checker.getSymbolAtLocation(nameNode);
    const decls = sym?.getDeclarations() ?? [];
    if (decls.includes(anchors.escrowsTableDecl)) return "escrows";
    if (decls.includes(anchors.escrowMilestonesTableDecl)) return "escrowMilestones";
  }
  const type = checker.getTypeAtLocation(expr);
  if (type === anchors.escrowsTableType) return "escrows";
  if (type === anchors.escrowMilestonesTableType) return "escrowMilestones";
  return undefined;
}

function normalizeSnippet(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ─────────────────────────────────────────────────────────────────────────
// The scan itself.
// ─────────────────────────────────────────────────────────────────────────

type PrimitiveKind =
  | "repo.updateMilestoneStatus"
  | "repo.updateStatus"
  | "repo.insert"
  | "repo.insertMilestone"
  | "casEscrowStatus"
  | "drizzle.update.escrows"
  | "drizzle.update.escrowMilestones"
  | "drizzle.insert.escrows"
  | "drizzle.insert.escrowMilestones"
  | "untyped.updateMilestoneStatus"
  | "untyped.insertMilestone"
  | "untyped.casEscrowStatus"
  | "untyped.updateStatus"
  | "untyped.insert"
  | "untyped.update"
  | "rawSql";

interface Finding {
  kind: "write" | "potential" | "reference";
  primitive: PrimitiveKind;
  file: string;
  line: number;
  enclosing: string;
  snippet: string;
}

interface ScanResult {
  /** A literal "released"/"completed" write OUTSIDE both allowed writers — a hard violation. */
  writes: Finding[];
  /** A non-literal status OUTSIDE both allowed writers — must appear in REVIEWED_POTENTIAL_WRITES. */
  potentials: Finding[];
  /** A non-call reference to a primitive OUTSIDE both allowed writers — always a hard violation. */
  references: Finding[];
  /** Matches found INSIDE the allowed writers — for the sanity check only. */
  allowedWrites: Finding[];
  /** Raw SQL text naming the tables OUTSIDE both allowed writers — always a hard violation. */
  rawSql: Finding[];
  /** Subset of writes/potentials that only matched via the untyped-escape-hatch fallback — for the
   *  "how many untyped matches exist" sanity report; each entry here is ALSO already present in
   *  `writes` or `potentials` (not double-enforced, just double-counted for visibility). */
  untyped: Finding[];
}

function classifyEnclosing(node: ts.Node, anchors: Anchors): { bucket: "allowed" | "primitiveOwnBody" | "outside"; decl: ts.FunctionDeclaration | undefined } {
  const decl = enclosingFunctionDeclaration(node);
  if (decl === anchors.recordChainSettlementDecl || decl === anchors.recordMockEscrowReleasedDecl) return { bucket: "allowed", decl };
  if (decl === anchors.casEscrowStatusDecl) return { bucket: "primitiveOwnBody", decl };
  return { bucket: "outside", decl };
}

function makeFinding(
  kind: Finding["kind"],
  primitive: PrimitiveKind,
  relFile: string,
  node: ts.Node,
  sf: ts.SourceFile,
  decl: ts.FunctionDeclaration | undefined,
  snippet: string,
): Finding {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
  return { kind, primitive, file: relFile, line: line + 1, enclosing: decl?.name?.text ?? "<top-level>", snippet: normalizeSnippet(snippet) };
}

// Map, not a plain object literal: calleeName is attacker/AST-derived text, and a plain object's
// lookup would silently return an INHERITED Object.prototype member (toString, constructor,
// hasOwnProperty, valueOf, ...) for those keys instead of undefined — confirmed the hard way (a
// `heliaCid.toString()` call in cid-blob-storage.ts matched as a false positive, `[Function
// toString]`, before this fix). Map has no prototype-chain lookup surface for string keys.
const UNCONDITIONAL_UNTYPED_NAMES = new Map<string, PrimitiveKind>([
  ["updateMilestoneStatus", "untyped.updateMilestoneStatus"],
  ["insertMilestone", "untyped.insertMilestone"],
  ["casEscrowStatus", "untyped.casEscrowStatus"],
]);
const GENERIC_UNTYPED_NAMES = new Map<string, PrimitiveKind>([
  ["updateStatus", "untyped.updateStatus"],
  ["insert", "untyped.insert"],
]);

const RAW_SQL_PATTERN = /\b(update|insert\s+into)\s+["`]?(escrows|escrow_milestones)\b/i;

function scanProgram(program: ts.Program, checker: ts.TypeChecker, files: string[], gatewaySrcDir: string, anchors: Anchors): ScanResult {
  const result: ScanResult = { writes: [], potentials: [], references: [], allowedWrites: [], rawSql: [], untyped: [] };

  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    const relFile = file.startsWith(gatewaySrcDir) ? file.slice(gatewaySrcDir.length + 1) : file;

    function pushWriteOrPotential(status: StatusClass, primitive: PrimitiveKind, node: ts.Node, decl: ts.FunctionDeclaration | undefined, snippet: string, isWriteLiteral: (v: string) => boolean, untyped: boolean) {
      let finding: Finding | undefined;
      if (status.kind === "literal") {
        if (isWriteLiteral(status.value)) finding = makeFinding("write", primitive, relFile, node, sf, decl, snippet);
      } else {
        finding = makeFinding("potential", primitive, relFile, node, sf, decl, snippet);
      }
      if (!finding) return;
      (finding.kind === "write" ? result.writes : result.potentials).push(finding);
      if (untyped) result.untyped.push(finding);
    }

    function recordPrimitiveCall(callNode: ts.CallExpression, primitive: PrimitiveKind, statusExpr: ts.Expression | undefined, isWriteLiteral: (v: string) => boolean) {
      const { bucket, decl } = classifyEnclosing(callNode, anchors);
      const status = classifyStatusExpr(statusExpr);
      const snippet = statusExpr ? statusExpr.getText(sf) : "<missing arg>";
      if (bucket === "allowed") {
        if (status.kind === "literal" && isWriteLiteral(status.value)) {
          result.allowedWrites.push(makeFinding("write", primitive, relFile, callNode, sf, decl, snippet));
        }
        return;
      }
      if (bucket === "primitiveOwnBody") return;
      pushWriteOrPotential(status, primitive, callNode, decl, snippet, isWriteLiteral, false);
    }

    /** `insert`/`insertMilestone` (repo methods) take ONE object-literal argument, same shape as a
     *  Drizzle `.set(...)`/`.values(...)` object — reuse classifySetArgument directly. */
    function recordInsertLikeRepoCall(callNode: ts.CallExpression, primitive: PrimitiveKind, isWriteLiteral: (v: string) => boolean) {
      const r = classifySetArgument(callNode.arguments[0]);
      if (!r.relevant) return;
      const { bucket, decl } = classifyEnclosing(callNode, anchors);
      if (bucket === "allowed") {
        if (r.status.kind === "literal" && isWriteLiteral(r.status.value)) {
          result.allowedWrites.push(makeFinding("write", primitive, relFile, callNode, sf, decl, r.snippet));
        }
        return;
      }
      if (bucket === "primitiveOwnBody") return;
      pushWriteOrPotential(r.status, primitive, callNode, decl, r.snippet, isWriteLiteral, false);
    }

    function recordDrizzleMatch(call: ts.CallExpression, isUpdate: boolean, table: "escrows" | "escrowMilestones") {
      const chained = findChainedCall(call, isUpdate ? "set" : "values");
      if (!chained) return;
      const setResult = classifySetArgument(chained.arguments[0]);
      if (!setResult.relevant) return;
      const primitive: PrimitiveKind = isUpdate
        ? table === "escrows" ? "drizzle.update.escrows" : "drizzle.update.escrowMilestones"
        : table === "escrows" ? "drizzle.insert.escrows" : "drizzle.insert.escrowMilestones";
      const isWriteLiteral = (v: string) => (table === "escrows" ? v === "completed" : v === "released");
      const { bucket, decl } = classifyEnclosing(call, anchors);
      if (bucket === "allowed") {
        if (setResult.status.kind === "literal" && isWriteLiteral(setResult.status.value)) {
          result.allowedWrites.push(makeFinding("write", primitive, relFile, call, sf, decl, setResult.snippet));
        }
        return;
      }
      if (bucket === "primitiveOwnBody") return;
      pushWriteOrPotential(setResult.status, primitive, call, decl, setResult.snippet, isWriteLiteral, false);
    }

    /** No resolved declaration for this call's callee at all (an any-typed callee). Fail closed by
     *  NAME TEXT: the specific names are unconditional violations; the generic/ambiguous ones need
     *  a literal terminal status to count as a write (else POTENTIAL on a non-literal status). */
    function recordUntypedFallback(node: ts.CallExpression, calleeName: string) {
      const { bucket, decl } = classifyEnclosing(node, anchors);
      if (bucket === "allowed" || bucket === "primitiveOwnBody") return;

      const unconditionalPrimitive = UNCONDITIONAL_UNTYPED_NAMES.get(calleeName);
      if (unconditionalPrimitive) {
        const finding = makeFinding("write", unconditionalPrimitive, relFile, node, sf, decl, node.getText(sf));
        result.writes.push(finding);
        result.untyped.push(finding);
        return;
      }

      const genericPrimitive = GENERIC_UNTYPED_NAMES.get(calleeName);
      if (genericPrimitive) {
        let status: StatusClass;
        let snippet: string;
        if (calleeName === "updateStatus") {
          const statusExpr = node.arguments[1];
          status = classifyStatusExpr(statusExpr);
          snippet = statusExpr ? statusExpr.getText(sf) : "<missing arg>";
        } else {
          const r = classifySetArgument(node.arguments[0]);
          if (!r.relevant) return;
          status = r.status;
          snippet = r.snippet;
        }
        // Can't tell which table an untyped generic call targets — accept either terminal literal.
        pushWriteOrPotential(status, genericPrimitive, node, decl, snippet, (v) => v === "released" || v === "completed", true);
        return;
      }

      if (calleeName === "update") {
        const chained = findChainedCall(node, "set");
        if (!chained) return;
        const r = classifySetArgument(chained.arguments[0]);
        if (!r.relevant) return;
        pushWriteOrPotential(r.status, "untyped.update", node, decl, r.snippet, (v) => v === "released" || v === "completed", true);
      }
    }

    function recordNonCallReference(node: ts.Node, primitive: PrimitiveKind) {
      const { bucket, decl } = classifyEnclosing(node, anchors);
      if (bucket === "allowed" || bucket === "primitiveOwnBody") return;
      result.references.push(makeFinding("reference", primitive, relFile, node, sf, decl, node.getText(sf)));
    }

    function recordRawSql(node: ts.Node, text: string) {
      if (!RAW_SQL_PATTERN.test(text)) return;
      const { bucket, decl } = classifyEnclosing(node, anchors);
      if (bucket === "allowed" || bucket === "primitiveOwnBody") return;
      result.rawSql.push(makeFinding("reference", "rawSql", relFile, node, sf, decl, text.slice(0, 160)));
    }

    function visit(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const expr = node.expression;
        // getResolvedSignature (not getSymbolAtLocation on the callee) is what makes this
        // identity-transparent through a plain alias (`const f = repos.escrows.updateMilestoneStatus;
        // f(...)`) and through destructuring — confirmed empirically: the inferred function TYPE of
        // the local variable still carries the ORIGINAL declaration as its signature's
        // `.declaration`, even though `getSymbolAtLocation` on a bare local identifier resolves to
        // the local variable's OWN declaration, not the source method. (`.bind(...)`-produced calls
        // ALSO still resolve through this — confirmed — but `.bind`/`.call`/`.apply` REFERENCES
        // themselves are additionally caught below, since relying solely on call resolution would
        // miss a reference that is never subsequently called.)
        const calleeDecl = checker.getResolvedSignature(node)?.declaration;
        const calleeName = ts.isPropertyAccessExpression(expr) ? expr.name.text : ts.isIdentifier(expr) ? expr.text : undefined;

        if (calleeDecl && anchors.updateMilestoneStatusDecls.includes(calleeDecl)) {
          recordPrimitiveCall(node, "repo.updateMilestoneStatus", node.arguments[1], (v) => v === "released");
        } else if (calleeDecl && anchors.updateStatusDecls.includes(calleeDecl)) {
          recordPrimitiveCall(node, "repo.updateStatus", node.arguments[1], (v) => v === "completed");
        } else if (calleeDecl && anchors.insertDecls.includes(calleeDecl)) {
          recordInsertLikeRepoCall(node, "repo.insert", (v) => v === "completed");
        } else if (calleeDecl && anchors.insertMilestoneDecls.includes(calleeDecl)) {
          recordInsertLikeRepoCall(node, "repo.insertMilestone", (v) => v === "released");
        } else if (calleeDecl === anchors.casEscrowStatusDecl) {
          recordPrimitiveCall(node, "casEscrowStatus", node.arguments[2], (v) => v === "completed");
        } else {
          // No signature-identity match. Two independent, non-exclusive fallbacks:
          let matchedDrizzle = false;
          if (ts.isPropertyAccessExpression(expr) && (expr.name.text === "update" || expr.name.text === "insert")) {
            // Identity-based on the TABLE ARGUMENT, not the call's own signature — works whether or
            // not the receiver (`db`/`storeDb()`) is any-typed (confirmed empirically).
            const tableArg = node.arguments[0];
            const tableKind = tableArg ? resolveTableKind(tableArg, checker, anchors) : undefined;
            if (tableKind) {
              recordDrizzleMatch(node, expr.name.text === "update", tableKind);
              matchedDrizzle = true;
            }
          }
          if (!matchedDrizzle && !calleeDecl && calleeName) {
            recordUntypedFallback(node, calleeName);
          }
        }
      }

      // Non-call references: assigned, passed as an argument, .bind/.call/.apply.
      if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
        let name: string | undefined;
        let keyNode: ts.Node | undefined;
        if (ts.isPropertyAccessExpression(node)) {
          name = node.name.text;
          keyNode = node.name;
        } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
          name = node.argumentExpression.text;
          keyNode = node.argumentExpression;
        }
        if (name && keyNode && (name === "updateMilestoneStatus" || name === "updateStatus" || name === "insert" || name === "insertMilestone")) {
          const isDirectCallee = ts.isCallExpression(node.parent) && node.parent.expression === node;
          if (!isDirectCallee) {
            // PropertyAccessExpression resolves its OWN symbol directly; ElementAccessExpression
            // with a string-literal key has no such symbol (confirmed empirically — it resolves
            // via the SOURCE expression's type instead, same technique as destructuring below).
            let decls: ts.Declaration[] = [];
            if (ts.isPropertyAccessExpression(node)) {
              const sym = checker.getSymbolAtLocation(keyNode);
              decls = sym?.getDeclarations() ?? [];
            } else if (ts.isElementAccessExpression(node)) {
              const srcType = checker.getTypeAtLocation(node.expression);
              const prop = srcType.getProperty(name);
              decls = prop?.getDeclarations() ?? [];
            }
            if (name === "updateMilestoneStatus" && decls.some((d) => anchors.updateMilestoneStatusDecls.includes(d))) {
              recordNonCallReference(node, "repo.updateMilestoneStatus");
            } else if (name === "updateStatus" && decls.some((d) => anchors.updateStatusDecls.includes(d))) {
              recordNonCallReference(node, "repo.updateStatus");
            } else if (name === "insert" && decls.some((d) => anchors.insertDecls.includes(d))) {
              recordNonCallReference(node, "repo.insert");
            } else if (name === "insertMilestone" && decls.some((d) => anchors.insertMilestoneDecls.includes(d))) {
              recordNonCallReference(node, "repo.insertMilestone");
            }
          }
        }
      }
      // Non-call references to casEscrowStatus (module-private — only reachable within this file).
      if (ts.isIdentifier(node) && node.text === "casEscrowStatus") {
        const isDeclName = ts.isFunctionDeclaration(node.parent) && node.parent.name === node;
        const isDirectCallee = ts.isCallExpression(node.parent) && node.parent.expression === node;
        if (!isDeclName && !isDirectCallee) {
          const sym = checker.getSymbolAtLocation(node);
          const decls = sym?.getDeclarations() ?? [];
          if (decls.includes(anchors.casEscrowStatusDecl)) recordNonCallReference(node, "casEscrowStatus");
        }
      }
      // Destructuring (`const { updateMilestoneStatus } = repos.escrows`): the binding element's own
      // symbol resolves to the new LOCAL variable, not the source property (confirmed empirically),
      // so resolve the DESTRUCTURING SOURCE's type and look the property up on it instead.
      if (ts.isBindingElement(node)) {
        const nameNode = node.propertyName ?? node.name;
        if (ts.isIdentifier(nameNode) && ["updateMilestoneStatus", "updateStatus", "insert", "insertMilestone"].includes(nameNode.text)) {
          const declNode = node.parent.parent;
          if (ts.isVariableDeclaration(declNode) && declNode.initializer) {
            const srcType = checker.getTypeAtLocation(declNode.initializer);
            const prop = srcType.getProperty(nameNode.text);
            const decls = prop?.getDeclarations() ?? [];
            if (nameNode.text === "updateMilestoneStatus" && decls.some((d) => anchors.updateMilestoneStatusDecls.includes(d))) {
              recordNonCallReference(node, "repo.updateMilestoneStatus");
            } else if (nameNode.text === "updateStatus" && decls.some((d) => anchors.updateStatusDecls.includes(d))) {
              recordNonCallReference(node, "repo.updateStatus");
            } else if (nameNode.text === "insert" && decls.some((d) => anchors.insertDecls.includes(d))) {
              recordNonCallReference(node, "repo.insert");
            } else if (nameNode.text === "insertMilestone" && decls.some((d) => anchors.insertMilestoneDecls.includes(d))) {
              recordNonCallReference(node, "repo.insertMilestone");
            }
          }
        }
      }
      // Raw SQL: a string/template literal naming update/insert-into + escrows/escrow_milestones.
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
        recordRawSql(node, node.getText(sf));
      }

      ts.forEachChild(node, visit);
    }
    visit(sf);
  }

  return result;
}

/** Repo-layer closure (iteration 3, item A). The scan above only walks gateway/src, so a NEW writer
 *  method added to the repository layer itself is invisible to it — e.g. a hypothetical
 *  `markReleased(id)` on `EscrowRepository` doing its own `this.db.update(escrowMilestones).set({
 *  status: "released" })`: gateway code calling it resolves to a declaration no anchor array
 *  contains, and nothing ever inspects the method's OWN body to see what it writes. This scans
 *  packages/db/src/** directly (same table-identity-by-symbol-or-type logic as the Drizzle
 *  primitive path above) and asserts every matching status-touching write sits inside one of the
 *  four anchored primitive METHOD declarations, by node identity. Unlike the gateway scan there is
 *  no literal-vs-non-literal split here: ANY status-touching write to these tables outside the four
 *  anchors is already the violation, independent of what value it writes — a brand-new repository
 *  method is exactly as dangerous whether it hardcodes "released" or takes it as a parameter. Also
 *  carries the raw-SQL check (iteration 4, item 4 — the gateway-only version missed this scope
 *  entirely): same RAW_SQL_PATTERN, same identity-based exemption for the four anchored methods. */
function scanDbLayerWrites(program: ts.Program, checker: ts.TypeChecker, dbFiles: string[], dbSrcDir: string, anchors: Anchors): { violations: Finding[]; rawSql: Finding[] } {
  const violations: Finding[] = [];
  const rawSql: Finding[] = [];
  const allMethodAnchors: ts.Declaration[] = [
    ...anchors.updateMilestoneStatusDecls,
    ...anchors.updateStatusDecls,
    ...anchors.insertDecls,
    ...anchors.insertMilestoneDecls,
  ];

  for (const file of dbFiles) {
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    const relFile = file.startsWith(dbSrcDir) ? file.slice(dbSrcDir.length + 1) : file;

    function visit(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const expr = node.expression;
        if (ts.isPropertyAccessExpression(expr) && (expr.name.text === "update" || expr.name.text === "insert")) {
          const isUpdate = expr.name.text === "update";
          const tableArg = node.arguments[0];
          const tableKind = tableArg ? resolveTableKind(tableArg, checker, anchors) : undefined;
          if (tableKind) {
            const chained = findChainedCall(node, isUpdate ? "set" : "values");
            const setResult = chained ? classifySetArgument(chained.arguments[0]) : { relevant: false as const };
            if (setResult.relevant) {
              const methodDecl = enclosingMethodDeclaration(node);
              const isAnchored = !!methodDecl && allMethodAnchors.includes(methodDecl);
              if (!isAnchored) {
                const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
                const primitive: PrimitiveKind = isUpdate
                  ? tableKind === "escrows" ? "drizzle.update.escrows" : "drizzle.update.escrowMilestones"
                  : tableKind === "escrows" ? "drizzle.insert.escrows" : "drizzle.insert.escrowMilestones";
                violations.push({
                  kind: "write",
                  primitive,
                  file: relFile,
                  line: line + 1,
                  enclosing: methodDecl?.name && ts.isIdentifier(methodDecl.name) ? methodDecl.name.text : "<top-level>",
                  snippet: normalizeSnippet(setResult.snippet),
                });
              }
            }
          }
        }
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
        const text = node.getText(sf);
        if (RAW_SQL_PATTERN.test(text)) {
          const methodDecl = enclosingMethodDeclaration(node);
          const isAnchored = !!methodDecl && allMethodAnchors.includes(methodDecl);
          if (!isAnchored) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
            rawSql.push({
              kind: "reference",
              primitive: "rawSql",
              file: relFile,
              line: line + 1,
              enclosing: methodDecl?.name && ts.isIdentifier(methodDecl.name) ? methodDecl.name.text : "<top-level>",
              snippet: normalizeSnippet(text.slice(0, 160)),
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
  }
  return { violations, rawSql };
}

interface UnresolvedSpecifier {
  file: string;
  line: number;
  specifier: string;
  kind: "static" | "dynamic-import" | "require";
}

/** Direct module resolution for a specifier that the checker will never bind to a symbol on its
 *  own (require(...) is just a plain function call to the TS checker — there is no module-
 *  resolution side effect the way there is for import/export syntax or a dynamic `import()`,
 *  confirmed empirically). Reuses the exact alias logic the Program itself was built with. */
function resolveSpecifierDirectly(specifierText: string, containingFile: string, compilerOptions: ts.CompilerOptions, pccAliasMap: PccAliases): boolean {
  if (pccAliasMap.exact.has(specifierText) || resolvePccDeepSubpath(specifierText, pccAliasMap)) return true;
  return !!ts.resolveModuleName(specifierText, containingFile, compilerOptions, ts.sys).resolvedModule;
}

/** Every import/export module specifier, dynamic `import(...)` call, and `require(...)` call (with
 *  a string-literal argument) in the given files that does NOT resolve — the fail-open guard
 *  (requirement 5, extended in iteration 3 item B to dynamic forms): if resolution silently fails,
 *  everything downstream becomes `any`-typed and vanishes from every check above without a trace,
 *  so this must be independently asserted empty rather than inferred from "the scan found nothing
 *  wrong". Confirmed empirically: `checker.getSymbolAtLocation` resolves a dynamic import's string
 *  argument exactly like a static import's moduleSpecifier (same TS2307 diagnostic on failure) —
 *  `require(...)` does not get this treatment at all and needs the direct fallback above. */
function findUnresolvedImports(
  program: ts.Program,
  checker: ts.TypeChecker,
  files: string[],
  baseDir: string,
  compilerOptions: ts.CompilerOptions,
  pccAliasMap: PccAliases,
): UnresolvedSpecifier[] {
  const unresolved: UnresolvedSpecifier[] = [];
  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    const relFile = file.startsWith(baseDir) ? file.slice(baseDir.length + 1) : file;

    function record(spec: ts.Expression, kind: UnresolvedSpecifier["kind"]) {
      const { line } = sf!.getLineAndCharacterOfPosition(spec.getStart());
      unresolved.push({ file: relFile, line: line + 1, specifier: spec.getText(sf), kind });
    }

    function visit(node: ts.Node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (!checker.getSymbolAtLocation(node.moduleSpecifier)) record(node.moduleSpecifier, "static");
      } else if (ts.isCallExpression(node) && ts.isImportCall(node)) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg) && !checker.getSymbolAtLocation(arg)) record(arg, "dynamic-import");
      } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg) && !resolveSpecifierDirectly(arg.text, file, compilerOptions, pccAliasMap)) record(arg, "require");
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
  }
  return unresolved;
}

// ─────────────────────────────────────────────────────────────────────────
// Reviewed potential-write allowlist.
//
// This is a review device, not a security boundary: the ALLOWED-WRITER decision above is always
// by node identity. Keying this list by (file, enclosing function NAME) is safe here because a
// name-key miss fails CLOSED (an unreviewed finding, not a silent pass) — renaming the enclosing
// function, or a same-named function appearing elsewhere, can only ever surface a NEW unreviewed
// entry, never hide an existing one. `expectedSnippet` is the exact (whitespace-normalized) source
// text of the status expression at that site: if the VALUE there ever changes — not just whether a
// match still exists — the snippet stops matching and the finding becomes unreviewed again.
// ─────────────────────────────────────────────────────────────────────────

interface ReviewedPotentialWrite {
  file: string;
  enclosingFunction: string;
  primitive: PrimitiveKind;
  expectedSnippet: string;
  reason: string;
}

const REVIEWED_POTENTIAL_WRITES: ReviewedPotentialWrite[] = [
  {
    file: "services/escrow-refund.ts",
    enclosingFunction: "refundEscrowForTerminalJob",
    primitive: "repo.updateMilestoneStatus",
    expectedSnippet: "target",
    reason:
      // Re-verified against the round-8 integration tree (juliet's resolveRowlessDefaultTarget/abiStatusEnum
      // additions shifted this file by +33 lines from the round-8-lead-review numbering; content unchanged).
      'escrow-refund.ts:244-245: `target = isMockEscrowAddress(escrow.contractAddress) ? ESCROW_REFUND_STATUS.DONE : ESCROW_REFUND_STATUS.PENDING`. ' +
      'ESCROW_REFUND_STATUS = { PENDING: "refund_pending", DONE: "refunded" } (packages/spec/src/types/settlement.ts:77,79) — neither value is "released".',
  },
  {
    file: "services/escrow-refund.ts",
    enclosingFunction: "refundEscrowForTerminalJob",
    primitive: "repo.updateStatus",
    expectedSnippet: "target",
    reason:
      "escrow-refund.ts:246: same `target` as above (one `const`, two writers in the same function) — neither "
      + '"refund_pending" nor "refunded" is "completed".',
  },
  {
    file: "services/escrow-refund.ts",
    enclosingFunction: "beginSettlement",
    primitive: "drizzle.update.escrows",
    expectedSnippet: "SETTLEMENT_OWNED_ESCROW_STATUS",
    reason:
      'escrow-refund.ts:101: `SETTLEMENT_OWNED_ESCROW_STATUS = "completing"` (a module-level const, never reassigned) — distinct from "completed". ' +
      "The matched call site itself is escrow-refund.ts:345 (`.set({ status: SETTLEMENT_OWNED_ESCROW_STATUS })`).",
  },
  {
    file: "services/escrow-refund.ts",
    enclosingFunction: "releaseEscrowFromSettlement",
    primitive: "casEscrowStatus",
    expectedSnippet: "claim.prior",
    reason:
      "escrow-refund.ts:391: the brief's own named example (a hand-back to claim.prior). `claim.prior` is set ONLY by beginSettlement " +
      "(escrow-refund.ts:354, `prior = escrow.status`), and ONLY inside the branch gated on " +
      '`REFUNDABLE_ESCROW_STATUSES.has(escrow.status)` (escrow-refund.ts:342; REFUNDABLE_ESCROW_STATUSES = new Set(["funded","active"]) at ' +
      "line 92) — so when set, prior is \"funded\" or \"active\", never \"completed\". releaseEscrowFromSettlement only calls casEscrowStatus " +
      "when claim.prior is truthy (escrow-refund.ts:391's own `if (claim.prior)` guard), so an unset (undefined) prior never reaches this call either.",
  },
  {
    file: "routes/paid-job-flow.ts",
    enclosingFunction: "createJobFromSession",
    primitive: "repo.insert",
    expectedSnippet: "escrowStatus",
    reason:
      "paid-job-flow.ts:650-657: `repos.escrows.insert({..., status: escrowStatus, ...})`. `escrowStatus: string` (line 374) is assigned " +
      'EXACTLY three literals across this function\'s mutually exclusive branches: "funded" (line 378, mock settlement), "funded" ' +
      '(line 517, V3), "created" (line 642, V1/V2) — never "completed". This is a fresh escrow row at job creation; it cannot already be paid.',
  },
  {
    file: "routes/paid-job-flow.ts",
    enclosingFunction: "createJobFromSession",
    primitive: "repo.insertMilestone",
    expectedSnippet: 'escrowStatus === "funded" ? "funded" : "pending"',
    reason:
      'paid-job-flow.ts:667-674: `repos.escrows.insertMilestone({..., status: escrowStatus === "funded" ? "funded" : "pending", ...})`. ' +
      'The ternary\'s own two branches are the literals "funded"/"pending" — regardless of what `escrowStatus` holds, this expression can ' +
      'never evaluate to "released". A fresh milestone row at job creation; it cannot already be released.',
  },
];

function checkAgainstReviewedList(potentials: Finding[], reviewed: ReviewedPotentialWrite[]): { unreviewed: Finding[]; unused: ReviewedPotentialWrite[] } {
  const remaining = [...reviewed];
  const unreviewed: Finding[] = [];
  for (const f of potentials) {
    const idx = remaining.findIndex(
      (r) => r.file === f.file && r.enclosingFunction === f.enclosing && r.primitive === f.primitive && r.expectedSnippet === f.snippet,
    );
    if (idx === -1) unreviewed.push(f);
    else remaining.splice(idx, 1);
  }
  return { unreviewed, unused: remaining };
}

/** Specifiers this scan independently confirmed are unresolved for a REVIEWED, pre-existing reason
 *  — not a resolution gap this scan introduced, and not something a fix belongs in a test file for.
 *  Same drift-detection shape as REVIEWED_POTENTIAL_WRITES: a name-key miss fails CLOSED (shows up
 *  as newly-unresolved), it never silently hides a NEW unresolved specifier. */
interface KnownUnresolvedSpecifier {
  file: string;
  specifier: string;
  kind: UnresolvedSpecifier["kind"];
  reason: string;
}

const KNOWN_UNRESOLVED_SPECIFIERS: KnownUnresolvedSpecifier[] = [
  {
    file: "services/cid-blob-storage.ts",
    specifier: '"helia"',
    kind: "dynamic-import",
    reason:
      'cid-blob-storage.ts:244-245: the import itself carries `// @ts-expect-error helia is a peer dep through @pcc/kernel` — the ' +
      "codebase's own authors already acknowledge gateway has no direct dependency on it (only @pcc/kernel does, " +
      "packages/kernel/package.json:52) and suppress the resulting type error. Pre-existing, not introduced by this scan.",
  },
  {
    file: "services/cid-blob-storage.ts",
    specifier: '"@helia/unixfs"',
    kind: "dynamic-import",
    reason:
      'cid-blob-storage.ts:246-247: same pattern, `// @ts-expect-error @helia/unixfs is a peer dep through @pcc/kernel` ' +
      "(packages/kernel/package.json:43).",
  },
];

function checkAgainstKnownUnresolved(found: UnresolvedSpecifier[], known: KnownUnresolvedSpecifier[]): { newlyUnresolved: UnresolvedSpecifier[]; unused: KnownUnresolvedSpecifier[] } {
  const remaining = [...known];
  const newlyUnresolved: UnresolvedSpecifier[] = [];
  for (const f of found) {
    const idx = remaining.findIndex((k) => k.file === f.file && k.specifier === f.specifier && k.kind === f.kind);
    if (idx === -1) newlyUnresolved.push(f);
    else remaining.splice(idx, 1);
  }
  return { newlyUnresolved, unused: remaining };
}

// ─────────────────────────────────────────────────────────────────────────

const SUITE_TIMEOUT_MS = 120_000; // GitHub's runners can be 2-3x slower than this box.

describe("N79 round 8: P1 (T1, structural scan by declaration identity)", () => {
  let built: BuiltProgram;
  let anchors: Anchors;
  let scan: ScanResult;
  let dbLayerViolations: Finding[];
  let dbLayerRawSql: Finding[];
  let unresolvedImports: UnresolvedSpecifier[];
  let buildMs: number;
  let scanMs: number;

  beforeAll(() => {
    const t0 = Date.now();
    built = buildProgram();
    anchors = findAnchors(built.program, built.gatewayDir, built.pkgsDir);
    const t1 = Date.now();
    scan = scanProgram(built.program, built.checker, built.files, built.gatewaySrcDir, anchors);
    const dbLayerScan = scanDbLayerWrites(built.program, built.checker, built.dbFiles, built.dbSrcDir, anchors);
    dbLayerViolations = dbLayerScan.violations;
    dbLayerRawSql = dbLayerScan.rawSql;
    unresolvedImports = [
      ...findUnresolvedImports(built.program, built.checker, built.files, built.gatewaySrcDir, built.compilerOptions, built.pccAliasMap),
      ...findUnresolvedImports(built.program, built.checker, built.dbFiles, built.dbSrcDir, built.compilerOptions, built.pccAliasMap),
    ];
    const t2 = Date.now();
    buildMs = t1 - t0;
    scanMs = t2 - t1;
    // eslint-disable-next-line no-console
    console.log(
      `[n79-r8] program build ${buildMs}ms, scan ${scanMs}ms, sourceFiles=${built.program.getSourceFiles().length}, ` +
        `rootFiles=${built.files.length}, dbFiles=${built.dbFiles.length}, ` +
        `untypedMatches=${scan.untyped.length}, rawSqlMatches=${scan.rawSql.length}, dbLayerViolations=${dbLayerViolations.length}, ` +
        `dbLayerRawSqlMatches=${dbLayerRawSql.length}, unresolvedImports=${unresolvedImports.length}`,
    );
  }, SUITE_TIMEOUT_MS);

  it(
    "sanity: the program resolves @pcc/* from source with no fatal errors, every import/dynamic-import/require resolves, the scanned file counts are plausible, both allowed writers' own writes are found and correctly attributed, and there are zero untyped/raw-SQL matches today",
    () => {
      expect(built.files.length).toBeGreaterThan(100); // 263 production .ts files under gateway/src at the time this was written
      expect(built.dbFiles.length).toBeGreaterThan(20); // packages/db/src production files (minus seed/migrations/tests)

      for (const f of [...built.files, ...built.dbFiles]) {
        const sf = built.program.getSourceFile(f);
        expect(sf, f).toBeDefined();
        expect(built.program.getSyntacticDiagnostics(sf!), f).toEqual([]);
      }

      // Fail-open guard (requirement 5, extended in iteration 3 item B to dynamic import()/require()
      // and to the db-layer file set): every import/export/dynamic-import/require specifier in the
      // scanned files must resolve, OR be a reviewed, pre-existing, justified exception. A silent
      // NEW resolution failure turns everything downstream `any` and invisible to every check above.
      const { newlyUnresolved, unused: unusedKnownUnresolved } = checkAgainstKnownUnresolved(unresolvedImports, KNOWN_UNRESOLVED_SPECIFIERS);
      expect(unusedKnownUnresolved, "a known-unresolved entry no longer matches anything found — it may have been fixed (remove the entry) or the import moved (re-verify, don't just delete)").toEqual([]);
      expect(newlyUnresolved, JSON.stringify(newlyUnresolved, null, 2)).toEqual([]);

      const byEnclosing = (name: string) => scan.allowedWrites.filter((w) => w.enclosing === name);
      const chain = byEnclosing("recordChainSettlement");
      const mock = byEnclosing("recordMockEscrowReleased");
      expect(chain.length, "recordChainSettlement should show its own writes, not pass vacuously").toBeGreaterThan(0);
      expect(mock.length, "recordMockEscrowReleased should show its own writes, not pass vacuously").toBeGreaterThan(0);
      expect(chain.some((w) => w.primitive === "repo.updateMilestoneStatus")).toBe(true);
      expect(chain.some((w) => w.primitive === "casEscrowStatus")).toBe(true);
      expect(mock.some((w) => w.primitive === "repo.updateMilestoneStatus")).toBe(true);
      expect(mock.some((w) => w.primitive === "casEscrowStatus")).toBe(true);

      // Untyped-escape-hatch and raw-SQL matches are reported here as a hard gate: the lead expects
      // 0 today; any non-zero count must be reviewed by a human, not silently absorbed. Raw SQL is
      // checked in BOTH scopes (iteration 4, item 4 extended this to packages/db/src too).
      expect(scan.untyped, JSON.stringify(scan.untyped, null, 2)).toEqual([]);
      expect(scan.rawSql, JSON.stringify(scan.rawSql, null, 2)).toEqual([]);
      expect(dbLayerRawSql, JSON.stringify(dbLayerRawSql, null, 2)).toEqual([]);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    "P1 (T1): no WRITE, unreviewed POTENTIAL write, bare reference, raw-SQL match, or repo-layer closure violation exists outside the anchored primitives",
    () => {
      const { unreviewed, unused } = checkAgainstReviewedList(scan.potentials, REVIEWED_POTENTIAL_WRITES);
      expect(unused, "a reviewed allowlist entry no longer matches anything found — re-verify by hand whether the code changed in a way that invalidates the reasoning, don't just delete the entry").toEqual([]);
      const violations = [...scan.writes, ...scan.references, ...scan.rawSql, ...unreviewed, ...dbLayerViolations, ...dbLayerRawSql];
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    },
    SUITE_TIMEOUT_MS,
  );
});
