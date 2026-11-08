/**
 * Deterministic build of the Phase-B browser kit from the AUDITED TypeScript modules.
 *
 *   node scripts/build-dashboard-ir-kit.mjs            # build:ir-kit  → write the bundle
 *   node scripts/build-dashboard-ir-kit.mjs --check    # check:ir-kit  → byte-compare committed vs fresh
 *
 * The committed apps/dashboard/public/ui-kit/v1/pcc-ir-kit.js is the reviewed = shipped
 * artifact. CI + the Docker build run --check and fail on any drift, giving:
 *   audited TS → deterministic build → committed artifact → byte-equivalence gate → shipped bytes.
 * The bundle is unminified so the diff (and any audit) reads cleanly.
 */
import esbuild from "esbuild";
import ts from "typescript";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const gatewayRoot = resolve(here, "..");
const repoRoot = resolve(gatewayRoot, "../..");
const entry = resolve(gatewayRoot, "src/mcp/dashboard-ir-browser-entry.ts");
const outfile = resolve(gatewayRoot, "../../apps/dashboard/public/ui-kit/v1/pcc-ir-kit.js");
const BANNER = "/* GENERATED from packages/gateway/src/mcp/dashboard-ir-browser-entry.ts by\n   scripts/build-dashboard-ir-kit.mjs — DO NOT EDIT. Regenerate with `pnpm build:ir-kit`. */";

// The generated bundle must NEVER contain a host-call / bridge / write surface.
// Behavioral tests are authoritative; this static scan is defense-in-depth.
const FORBIDDEN = ["__PCC_HOST_BRIDGE__", "__PCC_HOST_OPERATIONS__", "tools/call", "registerComponent"];

const BUILD = {
  entryPoints: [entry],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["es2022"],
  minify: false,
  sourcemap: false,
  legalComments: "none",
  banner: { js: BANNER },
  metafile: true,
  write: false,
  absWorkingDir: gatewayRoot, // pin cwd so relative-path rendering/resolution is deterministic
};

const check = process.argv.includes("--check");
const result = await esbuild.build(BUILD);
const out = result.outputFiles[0];
const bytes = Buffer.from(out.contents); // RAW bytes — the shipped artifact, not a decoded string
const text = out.text;

for (const id of FORBIDDEN) {
  if (text.includes(id)) { console.error(`FAIL: forbidden identifier "${id}" present in the generated bundle.`); process.exit(2); }
}
// Every esbuild input counts, including packages below node_modules. Pin full
// repository-relative paths so a same-named file cannot replace an audited input.
const repoPath = (path) => relative(repoRoot, resolve(gatewayRoot, path)).replaceAll("\\", "/");
const inputs = Object.keys(result.metafile.inputs).map(repoPath).sort();
const expected = [
  "packages/gateway/src/mcp/dashboard-ir-binder.ts",
  "packages/gateway/src/mcp/dashboard-ir-browser-entry.ts",
  "packages/gateway/src/mcp/dashboard-ir-renderer.ts",
  "packages/gateway/src/mcp/dashboard-ir.ts",
];
if (JSON.stringify(inputs) !== JSON.stringify(expected)) { console.error(`FAIL: unexpected bundle inputs — expected ${expected.join(",")}, got ${inputs.join(",")}`); process.exit(3); }

// Pin the reviewed runtime graph as well as its vertices. Type-only @pcc/spec
// imports are erased by esbuild and add no runtime dependency to the kit.
const reviewedImports = {
  "packages/gateway/src/mcp/dashboard-ir.ts": [],
  "packages/gateway/src/mcp/dashboard-ir-binder.ts": ["packages/gateway/src/mcp/dashboard-ir.ts"],
  "packages/gateway/src/mcp/dashboard-ir-renderer.ts": ["packages/gateway/src/mcp/dashboard-ir.ts"],
  "packages/gateway/src/mcp/dashboard-ir-browser-entry.ts": [
    "packages/gateway/src/mcp/dashboard-ir-binder.ts",
    "packages/gateway/src/mcp/dashboard-ir-renderer.ts",
    "packages/gateway/src/mcp/dashboard-ir.ts",
  ],
};
// Metafiles omit erased type imports and nonliteral dynamic imports. Parse the
// reviewed sources too, so no source-level dependency can reach around this graph.
const reviewedSourceImports = {
  "packages/gateway/src/mcp/dashboard-ir.ts": ["@pcc/spec"],
  "packages/gateway/src/mcp/dashboard-ir-binder.ts": ["./dashboard-ir.js"],
  "packages/gateway/src/mcp/dashboard-ir-renderer.ts": ["./dashboard-ir.js"],
  "packages/gateway/src/mcp/dashboard-ir-browser-entry.ts": ["./dashboard-ir.js", "./dashboard-ir-binder.js", "./dashboard-ir-renderer.js"],
};
function verifyReviewedSourceImports(path) {
  const file = ts.createSourceFile(path, readFileSync(resolve(repoRoot, path), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const fail = (node, detail) => {
    console.error(`FAIL: unreviewed source import in ${path}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1} — ${detail}`);
    process.exit(3);
  };
  const walk = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isImportEqualsDeclaration(node)) fail(node, "Dynamic and require-style imports are forbidden");
    let specifier;
    let typeOnly = false;
    if (ts.isImportDeclaration(node)) {
      specifier = node.moduleSpecifier;
      typeOnly = !!node.importClause?.isTypeOnly || !node.importClause?.name && !!node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.length > 0 && node.importClause.namedBindings.elements.every((element) => element.isTypeOnly);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      specifier = node.moduleSpecifier;
      typeOnly = node.isTypeOnly || !!node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every((element) => element.isTypeOnly);
    } else if (ts.isImportTypeNode(node)) {
      specifier = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : node.argument;
      typeOnly = true;
    }
    if (specifier && (!ts.isStringLiteral(specifier) || !reviewedSourceImports[path].includes(specifier.text) || specifier.text === "@pcc/spec" && !typeOnly)) fail(node, "Only the pinned IR graph and the core's type-only @pcc/spec import are reviewed");
    ts.forEachChild(node, walk);
  };
  walk(file);
}
for (const path of expected) verifyReviewedSourceImports(path);

const inputMetadata = new Map(Object.entries(result.metafile.inputs).map(([path, input]) => [repoPath(path), input]));
for (const path of expected) {
  const input = inputMetadata.get(path);
  const imports = [...new Set(input.imports.map((dependency) => repoPath(dependency.path)))].sort();
  if (input.imports.some((dependency) => dependency.external || dependency.kind !== "import-statement") ||
      JSON.stringify(imports) !== JSON.stringify(reviewedImports[path])) {
    console.error(`FAIL: unexpected runtime imports in ${path} — got ${imports.join(",")}`);
    process.exit(3);
  }
}

if (check) {
  let committed;
  try { committed = readFileSync(outfile); }
  catch { console.error(`FAIL check:ir-kit — committed bundle missing at ${outfile}. Run \`pnpm build:ir-kit\` and commit it.`); process.exit(1); }
  if (!committed.equals(bytes)) { console.error("FAIL check:ir-kit — committed pcc-ir-kit.js differs (byte-compare) from a fresh build of the audited TS. Run `pnpm build:ir-kit` and commit the result."); process.exit(1); }
  console.log(`OK check:ir-kit — committed bundle is byte-identical to a fresh build (${bytes.length} bytes).`);
} else {
  mkdirSync(dirname(outfile), { recursive: true });
  writeFileSync(outfile, bytes);
  console.log(`OK build:ir-kit — wrote ${outfile} (${bytes.length} bytes). Forbidden scan + 4-file input allowlist clean.`);
}
