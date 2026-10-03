#!/usr/bin/env node
// Board row N44, round 5: the trust-root guard for the enforcing secret scan.
//
// The trusted scan (.github/workflows/secret-scan.yml) is only as good as its
// definition. On merge_group GitHub runs that workflow file from the queue's
// commit, which carries the pull request's own changes, so a pull request that
// edits the file (or the scanner it calls) could swap the scan for a no-op that
// passes. This guard fails any change that touches the trust root. It runs on
// pull_request_target, where GitHub takes the job's definition from the base
// branch, and on every push to the pull request (synchronize), so a no-op
// swapped in after an approval fails as well. Landing a trust-root change then
// needs the operator to override this required check knowingly.
//
// Usage: node scripts/ci/trust-root-guard.mjs <base-sha> <head-sha>
//   Lists the paths that <head-sha> changes since its merge base with
//   <base-sha> (git objects only: nothing is checked out or run). Exits 1 when
//   one is in the trust root, 2 on a usage or git error, and 0 otherwise. Only
//   trust-root paths are ever printed (they come from the fixed list below), so
//   no file name from the pull request reaches the log.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The files that decide what the enforcing scan checks. GitHub reads CODEOWNERS from any of three places. */
export const TRUST_ROOT = Object.freeze([
  ".github/workflows/secret-scan.yml",
  "scripts/ci/secret-scan.mjs",
  "scripts/ci/trust-root-guard.mjs",
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
]);

/** The trust-root paths among `changedPaths`, sorted and without repeats. Exact matches only. */
export function trustRootViolations(changedPaths) {
  const root = new Set(TRUST_ROOT);
  return [...new Set(changedPaths)].filter((path) => root.has(path)).sort();
}

const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function runGit(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * The paths that `head` changes since its merge base with `base`. --no-renames
 * lists a renamed file under its old and its new path, so moving a trust-root
 * file away is a change to it; -z keeps any file name, newlines included, whole.
 */
export function changedPaths(base, head, git = runGit) {
  return git(["diff", "--no-renames", "--name-only", "-z", `${base}...${head}`]).split("\0").filter(Boolean);
}

export function main(argv, { git = runGit, out = process.stdout, err = process.stderr } = {}) {
  if (argv.length !== 2 || !COMMIT_ID.test(argv[0]) || !COMMIT_ID.test(argv[1])) {
    err.write("usage: trust-root-guard.mjs <base-sha> <head-sha> (full commit ids)\n");
    return 2;
  }
  const [base, head] = argv;
  let paths;
  try {
    paths = changedPaths(base, head, git);
  } catch {
    err.write("trust-root-guard: could not list the paths this change touches\n");
    return 2;
  }
  const hits = trustRootViolations(paths);
  if (hits.length > 0) {
    out.write(
      "This change touches the secret scan's trust root:\n" +
        hits.map((path) => `  - ${path}\n`).join("") +
        "A pull request may not change the checks that judge it. Landing a trust-root change needs the operator to override this required check knowingly.\n",
    );
    return 1;
  }
  out.write(`trust-root-guard: ${paths.length} changed path(s), none in the trust root.\n`);
  return 0;
}

const invoked = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (import.meta.url === invoked) process.exitCode = main(process.argv.slice(2));
