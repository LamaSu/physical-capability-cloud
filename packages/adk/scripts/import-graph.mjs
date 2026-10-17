/**
 * Walk the installed modules reachable from every entry in a package's exports
 * map, including JavaScript and type declarations.
 *
 * 1. Collect every concrete export target; reject patterns and missing files.
 * 2. Walk runtime and declaration entries separately, breadth-first by real path.
 * 3. Read import, re-export, import-equals, import(), require() and type edges
 *    from the TypeScript AST, not from comments or source-text searches.
 * 4. Skip Node builtins.
 * 5. Reject forbidden packages before attempting to resolve their imports.
 * 6. Follow runtime imports through relative paths and package exports,
 *    including matching subpath patterns and supported conditional targets.
 * 7. Resolve declaration imports in both NodeNext module modes; follow
 *    reference paths and check reference types by name.
 * 8. Return sorted, unique problems, visited files and package names.
 *
 * Non-literal import() and require() calls fail closed. Static analysis cannot
 * see createRequire(...)(...), module.require, a require held in another
 * variable, eval or new Function, or Worker file paths.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { isBuiltin } from "node:module";
import ts from "typescript";

const DECLARATION = /\.d\.(?:ts|mts|cts)$/;
const JAVASCRIPT = /\.(?:js|mjs|cjs)$/;
const RUNTIME_CONDITIONS = new Set(["node", "import", "require", "module-sync", "default"]);
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function inside(directory, file) {
  const path = relative(directory, file);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function displayPath(root, file) {
  return relative(root, file).split(sep).join("/");
}

function bareSpecifier(specifier) {
  if (
    !specifier ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.includes("\\") ||
    URL_SCHEME.test(specifier)
  ) {
    return null;
  }

  const segments = specifier.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;

  const count = segments[0].startsWith("@") ? 2 : 1;
  if (segments.length < count) return null;

  return {
    name: segments.slice(0, count).join("/"),
    subpath: segments.slice(count).join("/"),
  };
}

function probe(candidate) {
  for (const file of [candidate, `${candidate}.js`, `${candidate}.json`, join(candidate, "index.js")]) {
    if (isFile(file)) return realpathSync(file);
  }
  return null;
}

function findPackage(directory, name) {
  let current = directory;

  while (true) {
    const manifest = join(current, "node_modules", ...name.split("/"), "package.json");
    if (isFile(manifest)) return realpathSync(dirname(manifest));

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function runtimeExportTargets(value, targets) {
  if (typeof value === "string") {
    targets.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) runtimeExportTargets(item, targets);
  } else if (value && typeof value === "object") {
    for (const [condition, item] of Object.entries(value)) {
      if (RUNTIME_CONDITIONS.has(condition)) runtimeExportTargets(item, targets);
    }
  }
}

function resolveRuntime(specifier, file) {
  if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) {
    const found = probe(resolve(dirname(file), specifier));
    return { files: found ? [found] : [], bad: !found };
  }

  const parsed = bareSpecifier(specifier);
  if (!parsed) return { files: [], bad: true };

  const directory = findPackage(dirname(file), parsed.name);
  if (!directory) return { files: [], bad: true };

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  } catch {
    return { files: [], bad: true };
  }

  if (!Object.hasOwn(manifest, "exports")) {
    const candidate = parsed.subpath
      ? resolve(directory, parsed.subpath)
      : resolve(directory, typeof manifest.main === "string" ? manifest.main : "index.js");
    const found = probe(candidate);
    return { files: found ? [found] : [], bad: !found };
  }

  const requested = parsed.subpath ? `./${parsed.subpath}` : ".";
  const map = manifest.exports;
  const branches = [];

  if (
    typeof map === "string" ||
    Array.isArray(map) ||
    (map && typeof map === "object" && !Object.keys(map).some((key) => key.startsWith(".")))
  ) {
    if (requested === ".") branches.push({ value: map, substitution: null });
  } else if (map && typeof map === "object") {
    if (Object.hasOwn(map, requested)) {
      branches.push({ value: map[requested], substitution: null });
    } else {
      for (const [key, value] of Object.entries(map)) {
        const star = key.indexOf("*");
        if (!key.startsWith(".") || star === -1 || star !== key.lastIndexOf("*")) continue;

        const prefix = key.slice(0, star);
        const suffix = key.slice(star + 1);
        if (
          requested.startsWith(prefix) &&
          requested.endsWith(suffix) &&
          requested.length >= prefix.length + suffix.length
        ) {
          const substitution = requested.slice(prefix.length, requested.length - suffix.length);
          branches.push({ value, substitution });
        }
      }
    }
  }

  const files = [];
  let bad = false;

  for (const { value, substitution } of branches) {
    const targets = [];
    runtimeExportTargets(value, targets);

    for (const raw of targets) {
      const target = substitution === null ? raw : raw.replaceAll("*", substitution);
      const segments = target.split("/");

      if (!target.startsWith("./") || segments.includes("..") || segments.includes("node_modules")) {
        bad = true;
        continue;
      }

      const candidate = resolve(directory, target);
      if (!isFile(candidate)) {
        bad = true;
        continue;
      }

      const actual = realpathSync(candidate);
      if (!inside(directory, actual)) {
        bad = true;
        continue;
      }

      files.push(actual);
    }
  }

  return { files: [...new Set(files)], bad: bad || files.length === 0 };
}

function resolveDeclarations(specifier, file) {
  const files = new Set();
  const options = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };

  for (const mode of [ts.ModuleKind.ESNext, ts.ModuleKind.CommonJS]) {
    const result = ts.resolveModuleName(
      specifier,
      file,
      options,
      ts.sys,
      undefined,
      undefined,
      mode,
    );

    const found = result.resolvedModule?.resolvedFileName;
    if (found && isFile(found)) files.add(realpathSync(found));
  }

  return { files: [...files], bad: files.size === 0 };
}

function nearestPackageName(file) {
  let current = dirname(file);

  while (true) {
    const manifest = join(current, "package.json");
    if (isFile(manifest)) {
      try {
        const name = JSON.parse(readFileSync(manifest, "utf8")).name;
        if (typeof name === "string" && name !== "") return name;
      } catch {
        // Continue to the enclosing package.
      }
    }

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Walk from an installed package's complete exports map.
 *
 * `forbidden` contains package names rather than full import specifiers.
 * Both walks use real paths, and all reported file paths are relative to root.
 */
export function walkImportGraph(packageDir, { forbidden, root }) {
  const directory = realpathSync(packageDir);
  const rootDir = realpathSync(root);
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const packageName = manifest.name;
  const problems = [];
  const runtimeEntries = [];
  const declarationEntries = [];

  function collectEntries(value) {
    if (typeof value === "string") {
      const segments = value.split("/");
      const candidate = resolve(directory, value);

      if (
        !value.startsWith("./") ||
        segments.includes("..") ||
        segments.includes("node_modules") ||
        !isFile(candidate)
      ) {
        problems.push(`${packageName}: exports entry ${value} does not exist`);
        return;
      }

      const actual = realpathSync(candidate);
      if (!inside(directory, actual)) {
        problems.push(`${packageName}: exports entry ${value} does not exist`);
        return;
      }

      if (DECLARATION.test(value)) {
        declarationEntries.push(actual);
      } else {
        runtimeEntries.push(actual);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) collectEntries(item);
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (key.includes("*")) {
          problems.push(`${packageName}: exports key ${key} is a pattern; the walk cannot list its files`);
        } else {
          collectEntries(item);
        }
      }
    }
  }

  if (!Object.hasOwn(manifest, "exports")) {
    problems.push(`${packageName}: has no exports map`);
  } else {
    collectEntries(manifest.exports);
    if (runtimeEntries.length === 0 && declarationEntries.length === 0 && problems.length === 0) {
      problems.push(`${packageName}: exports map has no file entries`);
    }
  }

  function walk(kind, entries) {
    const pending = [...entries];
    const visited = new Set();
    const packages = new Set();

    for (let next = 0; next < pending.length; next++) {
      const file = realpathSync(pending[next]);
      if (visited.has(file)) continue;
      visited.add(file);

      const F = displayPath(rootDir, file);
      const name = nearestPackageName(file);
      if (name !== null) packages.add(name);

      if (file.endsWith(".json")) continue;

      const declaration = DECLARATION.test(file);
      if (!declaration && !JAVASCRIPT.test(file)) {
        problems.push(`${F}: not a JavaScript module or a declaration file`);
        continue;
      }

      let source;
      try {
        source = ts.createSourceFile(
          file,
          readFileSync(file, "utf8"),
          ts.ScriptTarget.Latest,
          true,
          declaration ? ts.ScriptKind.TS : ts.ScriptKind.JS,
        );
      } catch {
        problems.push(`${F}: cannot read or parse module`);
        continue;
      }

      const specifiers = [];
      const nonLiteral = `${F}: an import() or require() whose specifier is not a string literal`;

      function collectLiteral(node) {
        if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
          specifiers.push(node.text);
        } else {
          problems.push(nonLiteral);
        }
      }

      function visit(node) {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          if (node.moduleSpecifier) collectLiteral(node.moduleSpecifier);
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
          collectLiteral(node.moduleReference.expression);
        } else if (declaration && ts.isImportTypeNode(node)) {
          if (ts.isLiteralTypeNode(node.argument)) {
            collectLiteral(node.argument.literal);
          } else {
            problems.push(nonLiteral);
          }
        } else if (
          ts.isCallExpression(node) &&
          (
            node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === "require")
          )
        ) {
          collectLiteral(node.arguments[0]);
        }
        ts.forEachChild(node, visit);
      }

      visit(source);

      if (declaration) {
        for (const reference of source.referencedFiles) {
          const referenced = resolve(dirname(file), reference.fileName);
          if (isFile(referenced)) {
            pending.push(realpathSync(referenced));
          } else {
            problems.push(`${F}: cannot resolve ${reference.fileName}`);
          }
        }

        for (const reference of source.typeReferenceDirectives) {
          const parsed = bareSpecifier(reference.fileName);
          if (parsed && forbidden.has(parsed.name)) {
            problems.push(`${F}: imports ${reference.fileName}, which must not be reachable from ${packageName}'s exports`);
          }
        }
      }

      for (const specifier of specifiers) {
        if (isBuiltin(specifier)) continue;

        const parsed = bareSpecifier(specifier);
        if (parsed && forbidden.has(parsed.name)) {
          problems.push(`${F}: imports ${specifier}, which must not be reachable from ${packageName}'s exports`);
          continue;
        }

        const result = kind === "runtime"
          ? resolveRuntime(specifier, file)
          : resolveDeclarations(specifier, file);

        if (result.bad) problems.push(`${F}: cannot resolve ${specifier}`);
        for (const target of result.files) pending.push(target);
      }
    }

    return {
      files: [...visited].map((file) => displayPath(rootDir, file)).sort(),
      packages: [...packages].sort(),
    };
  }

  const runtime = walk("runtime", runtimeEntries);
  const types = walk("types", declarationEntries);

  return {
    problems: [...new Set(problems)].sort(),
    runtime,
    types,
  };
}
