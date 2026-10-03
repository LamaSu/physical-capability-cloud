import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The boundary policy of the clean external install check (ledger R4 D1;
 * verdict 101 F6). Pure functions with no side effects on import, so the unit
 * tests exercise exactly what scripts/clean-install-check.mjs enforces.
 *
 * - manifestProblems: one packed package.json. Every dependency spec is
 *   resolved to the registry package it installs (an `npm:` alias counts as
 *   its target), and anything that is not a registry range is refused.
 * - installedPackages: every package installed in the consumer project, by
 *   the name in its own package.json, including any package bundled inside
 *   another (a nested node_modules), at any depth (verdict 101b).
 * - installedProblems: every installed package, so a transitive dependency
 *   is checked too, and a bundled one is refused: it is in no dependency list.
 * - payloadProblems: the tarball's file list. Only package.json, README,
 *   LICENSE and build output under dist/ may ship; each dist/ file needs a
 *   source under src/ (so stale output fails) AND a pattern in the package's
 *   publication manifest (scripts/publication-manifest.json), so a file
 *   ships because the package chose to publish it, not because a source
 *   happens to exist (verdict 101b).
 * - contentProblems: each payload file's text against secret patterns.
 */

/** Chain clients must never ride along in the public kit: not directly, not by alias, not transitively. */
export const CHAIN_CLIENTS = new Set([
  "viem",
  "ox",
  "ethers",
  "wagmi",
  "web3",
  "permissionless",
  "thirdweb",
  "alchemy-sdk",
  "@solana/web3.js",
  "@coinbase/wallet-sdk",
  "@coinbase/cdp-sdk",
  "@coinbase/coinbase-sdk",
  "@coinbase/onchainkit",
]);
const CHAIN_CLIENT_PREFIXES = [
  "@wagmi/",
  "@ethersproject/",
  "web3-",
  "@walletconnect/",
  "@reown/",
  "@metamask/",
  "@privy-io/",
  "@thirdweb-dev/",
  "@safe-global/",
  "@account-abstraction/",
  "@alchemy/",
  "@biconomy/",
  "@zerodev/",
];

export function isChainClient(name) {
  return CHAIN_CLIENTS.has(name) || CHAIN_CLIENT_PREFIXES.some((prefix) => name.startsWith(prefix));
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
/** Specs that do not install a registry package by name: workspace, local, git and URL forms. */
const NON_REGISTRY_SPEC = /^(?:workspace|catalog|file|link|portal|patch|git|git\+[a-z]+|github|gitlab|bitbucket|https?):/;

/** The registry package a dependency spec installs: `{ target }`, or `{ problem }`. */
export function specTarget(alias, spec) {
  if (typeof spec !== "string") return { problem: `${alias} has a spec that is not a string` };
  if (spec.startsWith("npm:")) {
    const rest = spec.slice(4);
    const at = rest.indexOf("@", rest.startsWith("@") ? 1 : 0);
    const target = at === -1 ? rest : rest.slice(0, at);
    if (!PACKAGE_NAME.test(target)) return { problem: `${alias} is an alias to ${JSON.stringify(target)}, not a package name` };
    return { target };
  }
  if (NON_REGISTRY_SPEC.test(spec) || spec.includes("/") || spec.includes("\\")) {
    return { problem: `${alias} is ${JSON.stringify(spec)}, not a registry version range` };
  }
  return { target: alias };
}

const DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];

/** Problems with one packed package.json. `packed` is the set of names packed together. */
export function manifestProblems(name, pj, { packed, privateNames }) {
  const problems = [];
  if (JSON.stringify(pj).includes("workspace:")) problems.push(`${name}: packed package.json still contains "workspace:"`);
  for (const field of ["bundledDependencies", "bundleDependencies"]) {
    const bundled = pj[field];
    if (bundled === true || (Array.isArray(bundled) && bundled.length > 0)) {
      problems.push(`${name}: ${field} would ship code that no dependency list shows`);
    }
  }
  for (const field of DEPENDENCY_FIELDS) {
    for (const [alias, spec] of Object.entries(pj[field] ?? {})) {
      const resolved = specTarget(alias, spec);
      if (resolved.problem) {
        problems.push(`${name}: ${field}: ${resolved.problem}`);
        continue;
      }
      for (const dep of new Set([alias, resolved.target])) {
        const via = dep === alias ? "" : ` (as ${alias})`;
        if (dep.startsWith("@pcc/") && !packed.has(dep)) problems.push(`${name}: depends on ${dep}${via}, which is not part of the public kit`);
        if (dep.startsWith("@pcc/") && privateNames.has(dep) && dep !== "@pcc/adk") problems.push(`${name}: depends on private ${dep}${via}`);
        if (isChainClient(dep)) problems.push(`${name}: depends on chain client ${dep}${via}`);
      }
    }
  }
  return problems;
}

/** The package directories in one node_modules directory, scopes included: `[[dirent, dir]]`. */
function packageDirs(modules) {
  const out = [];
  for (const child of readdirSync(modules, { withFileTypes: true })) {
    if (child.name.startsWith(".")) continue; // .bin, .pnpm, .modules.yaml
    const dir = join(modules, child.name);
    if (child.name.startsWith("@") && child.isDirectory()) {
      for (const scoped of readdirSync(dir, { withFileTypes: true })) out.push([scoped, join(dir, scoped.name)]);
    } else {
      out.push([child, dir]);
    }
  }
  return out;
}

function readPackage(dir, project) {
  const pj = join(dir, "package.json");
  if (!existsSync(pj)) return null;
  const { name, version } = JSON.parse(readFileSync(pj, "utf8"));
  return { name, version, dir: relative(project, dir) };
}

/** Whether `path` is a directory, following a symlink to its target. */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// pnpm's own metadata under a node_modules. Every other name is a package to account for, so a
// package cannot hide under an arbitrary dot-name like `.concealed` (verdict 101d).
const PNPM_METADATA = new Set([".bin", ".pnpm", ".modules.yaml"]);

/**
 * The entries in one node_modules directory as `[name, dir]`, scopes expanded. A scope directory
 * can be a symlink, so the directory test follows links; a package entry may itself be a symlink,
 * left for the caller to canonicalize.
 */
function moduleEntries(modules) {
  const out = [];
  for (const child of readdirSync(modules, { withFileTypes: true })) {
    if (PNPM_METADATA.has(child.name)) continue; // only pnpm's own metadata, not any dot-name
    const dir = join(modules, child.name);
    if (child.name.startsWith("@") && isDirectory(dir)) {
      for (const scoped of readdirSync(dir, { withFileTypes: true })) {
        if (PNPM_METADATA.has(scoped.name)) continue;
        out.push([`${child.name}/${scoped.name}`, join(dir, scoped.name)]);
      }
    } else {
      out.push([child.name, dir]);
    }
  }
  return out;
}

/**
 * Packages bundled inside `dir` (its own node_modules), at any depth (verdict 101c). A published
 * package's own node_modules holds only what shipped with it, so every entry is accounted for: a
 * readable package is recorded with `bundledIn`, and anything else -- a directory with no
 * package.json, or a symlink that will not resolve -- is an opaque entry the policy fails closed
 * on, never a silent skip. Symlinks are canonicalized against `seen`, so a cycle can neither spin
 * nor hide a target the walk already passed; there is no depth limit (the README's "at any depth").
 */
function bundledPackages(dir, owner, project, found, seen) {
  const modules = join(dir, "node_modules");
  if (!existsSync(modules)) return;
  for (const [name, child] of moduleEntries(modules)) {
    let real;
    try {
      real = realpathSync(child);
    } catch {
      found.push({ opaque: `${name} is a symlink that does not resolve`, dir: relative(project, child), bundledIn: owner });
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    const pkg = readPackage(child, project);
    if (!pkg) {
      found.push({ opaque: `${name} has no package.json`, dir: relative(project, child), bundledIn: owner });
      continue;
    }
    found.push({ ...pkg, bundledIn: owner });
    bundledPackages(child, owner, project, found, seen);
  }
}

/**
 * Every package installed in a pnpm consumer project, by the name in its own package.json:
 * `[{ name, version, dir, bundledIn? }]`. A package's own directory is a real directory under
 * .pnpm/<id>/node_modules (its dependencies there are symlinks); anything inside the package's
 * own node_modules was bundled with it, and carries `bundledIn`.
 */
export function installedPackages(project) {
  const store = join(project, "node_modules", ".pnpm");
  if (!existsSync(store)) throw new Error(`${store} is missing; the consumer was not installed by pnpm`);
  const found = [];
  const seen = new Set();
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const modules = join(store, entry.name, "node_modules");
    if (!existsSync(modules)) continue;
    for (const [dirent, dir] of packageDirs(modules)) {
      if (!dirent.isDirectory()) continue; // a dependency, linked from its own .pnpm entry
      const pkg = readPackage(dir, project);
      if (!pkg) continue;
      found.push(pkg);
      bundledPackages(dir, pkg.name, project, found, seen);
    }
  }
  return found;
}

/** Problems with the packages installed in the consumer project: `[{ name, version, dir, bundledIn? }]`. */
export function installedProblems(installed, { packed }) {
  const problems = [];
  for (const entry of installed) {
    if (entry.opaque) {
      // The walk could not read into an entry under a package's own node_modules. Fail closed:
      // the public kit must not ship something the graph check cannot see into (verdict 101c).
      problems.push(`installed graph has an opaque entry at ${entry.dir}, bundled inside ${entry.bundledIn}: ${entry.opaque}`);
      continue;
    }
    const { name, version, dir, bundledIn } = entry;
    const where = `${name}@${version} (${dir})`;
    if (typeof name !== "string" || name === "") problems.push(`installed package without a name at ${dir}`);
    else if (isChainClient(name)) problems.push(`installed graph contains chain client ${where}`);
    else if (name.startsWith("@pcc/") && !packed.has(name)) problems.push(`installed graph contains ${where}, which is not part of the public kit`);
    if (bundledIn) problems.push(`installed graph contains ${where}, bundled inside ${bundledIn}: a bundled package is in no dependency list`);
  }
  return problems;
}

const TOP_LEVEL_FILES = /^(?:package\.json|(?:README|LICENSE|LICENCE)(?:\.md|\.txt)?)$/;
/** Build outputs and the source file each must come from. Longest suffix first. */
const OUTPUTS = [
  [".d.ts.map", ".ts"],
  [".js.map", ".ts"],
  [".d.ts", ".ts"],
  [".js", ".ts"],
  [".json", ".json"],
];
const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** A glob as a RegExp: `**` spans directories, `*` stays within one segment. */
function globRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      out += glob[i + 2] === "/" ? "(?:[^/]+/)*" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") {
      out += "[^/]*";
    } else {
      out += /[\\^$.|?+()[\]{}]/.test(c) ? `\\${c}` : c;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Problems with one tarball's file list (paths inside the tarball, without
 * the leading "package/"). `hasSource(path)` says whether the package's own
 * directory has that file; `allowed` is the package's publication manifest
 * (globs). A dist/ file must have both.
 */
export function payloadProblems(name, files, { hasSource, allowed = [] }) {
  const published = allowed.map(globRegExp);
  const problems = [];
  for (const file of files) {
    if (TOP_LEVEL_FILES.test(file)) continue;
    const segments = file.split("/");
    if (segments[0] !== "dist" || segments.length < 2 || !segments.every((s) => SAFE_SEGMENT.test(s))) {
      problems.push(`${name}: unexpected file in tarball: ${file}`);
      continue;
    }
    if (segments.includes("__tests__") || /\.(?:test|spec)\./.test(file)) {
      problems.push(`${name}: test file in tarball: ${file}`);
      continue;
    }
    const output = OUTPUTS.find(([suffix]) => file.endsWith(suffix));
    if (!output) {
      problems.push(`${name}: unexpected file type in tarball: ${file}`);
      continue;
    }
    const source = `src/${file.slice("dist/".length, file.length - output[0].length)}${output[1]}`;
    if (!hasSource(source)) problems.push(`${name}: ${file} has no source ${source}; stale build output?`);
    else if (!published.some((re) => re.test(file))) problems.push(`${name}: ${file} is not in the package's publication manifest`);
  }
  return problems;
}

// The secret families the review router's push gate scans for, plus PGP
// blocks. Each is assembled from parts, so this file itself does not match.
const SECRET_PATTERNS = [
  ["a private key block", new RegExp("-----BEGIN (?:[A-Z0-9]+ )*PRIV" + "ATE KEY(?: BLOCK)?-----")],
  ["a PCC API key", new RegExp("\\bpcc_(?:live|oracle|test)_" + "[A-Za-z0-9]{16,}")],
  ["an AWS access key", new RegExp("\\bAK" + "IA[0-9A-Z]{16}\\b")],
  ["a GitHub token", new RegExp("\\b(?:gh[pousr]_" + "[A-Za-z0-9]{30,}|github_pat_" + "[A-Za-z0-9_]{30,})")],
  ["a Stripe live key", new RegExp("\\b(?:sk|rk)_li" + "ve_[A-Za-z0-9]{10,}")],
  ["a Slack token", new RegExp("\\bxo" + "x[abprs]-[A-Za-z0-9-]{10,}")],
  [
    "a secret-valued key field",
    new RegExp(
      '"(?:secret|private|secret_?key|private_?key|secretKey|privateKey|seed|mnemonic)"\\s*:\\s*' + '"(?:0x)?[A-Za-z0-9+/=_-]{32,}"',
    ),
  ],
];

/** Problems with one payload file's text. */
export function contentProblems(name, file, text) {
  const problems = [];
  for (const [what, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) problems.push(`${name}: ${file} contains what looks like ${what}`);
  }
  return problems;
}
