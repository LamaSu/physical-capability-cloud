/**
 * The boundary policy of the clean external install check (ledger R4 D1;
 * verdict 101 F6). Pure functions with no side effects on import, so the unit
 * tests exercise exactly what scripts/clean-install-check.mjs enforces.
 *
 * - manifestProblems: one packed package.json. Every dependency spec is
 *   resolved to the registry package it installs (an `npm:` alias counts as
 *   its target), and anything that is not a registry range is refused.
 * - installedProblems: every package actually installed in the consumer
 *   project, by its real name, so a transitive dependency is checked too.
 * - payloadProblems: the tarball's file list against an allowlist. Only
 *   package.json, README, LICENSE and build output under dist/ that has a
 *   source file under src/ may ship, so a stale or stray file fails.
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

/** Problems with the packages installed in the consumer project: `[{ name, version, dir }]`, by real name. */
export function installedProblems(installed, { packed }) {
  const problems = [];
  for (const { name, version, dir } of installed) {
    const where = `${name}@${version} (${dir})`;
    if (typeof name !== "string" || name === "") problems.push(`installed package without a name at ${dir}`);
    else if (isChainClient(name)) problems.push(`installed graph contains chain client ${where}`);
    else if (name.startsWith("@pcc/") && !packed.has(name)) problems.push(`installed graph contains ${where}, which is not part of the public kit`);
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

/**
 * Problems with one tarball's file list (paths inside the tarball, without
 * the leading "package/"). `hasSource(path)` says whether the package's own
 * directory has that file.
 */
export function payloadProblems(name, files, { hasSource }) {
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
