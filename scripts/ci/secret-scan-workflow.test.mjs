// Structural checks on the workflows that run the secret scan (board row N44).
// They read the YAML as text: the job that runs them installs no packages.
//
//   node --test scripts/ci/secret-scan-workflow.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TRUST_ROOT, trustRootViolations } from "./trust-root-guard.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TRUSTED = readFileSync(resolve(ROOT, ".github/workflows/secret-scan.yml"), "utf8");
const CI = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");
const GUARD_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "trust-root-guard.mjs");

/** The text of the step whose name contains `name`, up to the next step. */
function step(workflow, name) {
  const start = workflow.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `no step named "${name}"`);
  const next = workflow.indexOf("\n      - ", start + 1);
  return workflow.slice(start, next < 0 ? undefined : next);
}

/** The text of the job keyed `name` directly under `jobs:`, up to the next job (or EOF). */
function job(workflow, name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `no job named "${name}"`);
  const body = workflow.slice(start + 1);
  const next = /\n {2}\S/.exec(body);
  return next ? body.slice(0, next.index) : body;
}

test("the trusted scan runs on a merge queue's promotion commit", () => {
  assert.match(TRUSTED, /^ {2}merge_group:\n {4}types: \[checks_requested\]$/m);
});

test("editing a pull request's title or description runs the trusted scan again", () => {
  const types = /^ {2}pull_request_target:\n {4}types: \[([^\]]*)\]$/m.exec(TRUSTED)?.[1] ?? "";
  assert.ok(types.split(",").map((t) => t.trim()).includes("edited"), types);
});

test("the checkout is the base commit for a pull request and for a merge queue, never the code under test", () => {
  const ref = /ref: (\$\{\{.*\}\})/.exec(TRUSTED)?.[1] ?? "";
  assert.match(ref, /github\.event_name == 'pull_request_target' && github\.event\.pull_request\.base\.sha/);
  assert.match(ref, /github\.event_name == 'merge_group' && github\.event\.merge_group\.base_sha/);
  assert.match(TRUSTED, /persist-credentials: false/);
  assert.match(TRUSTED, /^permissions:\n {2}contents: read$/m);
});

test("the merge queue's head commit and every object it adds are scanned with the base's scanner", () => {
  const s = step(TRUSTED, "Scan the merge queue's commit");
  assert.match(s, /if: github\.event_name == 'merge_group'/);
  assert.match(s, /HEAD_SHA: \$\{\{ github\.event\.merge_group\.head_sha \}\}/);
  assert.match(s, /BASE_SHA: \$\{\{ github\.event\.merge_group\.base_sha \}\}/);
  assert.match(s, /git fetch --no-tags --quiet origin "\$HEAD_SHA"/);
  assert.match(s, /node scripts\/ci\/secret-scan\.mjs --tree "\$HEAD_SHA" --range "\$\{BASE_SHA\}\.\.\$\{HEAD_SHA\}"/);
});

test("the pull request's title and description are scanned, and reach the shell only through the environment", () => {
  const s = step(TRUSTED, "Scan the pull request's title and description");
  assert.match(s, /PR_TITLE: \$\{\{ github\.event\.pull_request\.title \}\}/);
  assert.match(s, /PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}/);
  assert.match(s, /node scripts\/ci\/secret-scan\.mjs --text /);
  // No expression is expanded inside a run script (script injection).
  for (const run of TRUSTED.split(/\n\s+run: \|\n/).slice(1)) {
    const script = run.split(/\n {6}- /)[0];
    assert.ok(!script.includes("${{"), `an expression inside a run script:\n${script}`);
  }
});

test("a push that creates the branch scans its whole history, in both workflows", () => {
  for (const [name, wf] of [["secret-scan.yml", TRUSTED], ["ci.yml", CI]]) {
    const zero = /"\$BEFORE" = "0{40}" \]; then\n\s*(.+)\n/.exec(wf)?.[1] ?? "";
    assert.match(zero, /--history HEAD/, name);
  }
});

// ── The trust root (finding 1, round 5) ─────────────────────────────────────
// A pull request that edits the trust root itself (the trusted scan's
// definition, the scanner it calls, or a CODEOWNERS file) must fail a
// required check whose own definition is read from the base branch.

test("a trust-root-guard job exists", () => {
  assert.ok(job(TRUSTED, "trust-root-guard").startsWith("  trust-root-guard:"));
});

test("the trust-root-guard job does not run on push (the scan above is detection there, not prevention)", () => {
  assert.match(job(TRUSTED, "trust-root-guard"), /if: github\.event_name != 'push'/);
});

test("the trust-root-guard job checks out only the base commit, never the head, and persists no credentials", () => {
  const guard = job(TRUSTED, "trust-root-guard");
  const ref = /ref: (\$\{\{.*\}\})/.exec(guard)?.[1] ?? "";
  assert.match(ref, /github\.event\.pull_request\.base\.sha/);
  assert.match(ref, /github\.event\.merge_group\.base_sha/);
  assert.ok(!ref.includes(".head."), ref);
  assert.match(guard, /persist-credentials: false/);
});

test("the trust-root-guard run step passes both SHAs through env and never interpolates an expression inside run", () => {
  const s = step(TRUSTED, "Refuse a change to the trust root");
  assert.match(s, /HEAD_SHA: \$\{\{.*\}\}/);
  assert.match(s, /BASE_SHA: \$\{\{.*\}\}/);
  assert.match(s, /git fetch --no-tags --quiet origin "\$HEAD_SHA"/);
  assert.match(s, /node scripts\/ci\/trust-root-guard\.mjs "\$BASE_SHA" "\$HEAD_SHA"/);
  const run = s.split(/\n\s+run: \|\n/)[1] ?? "";
  assert.ok(!run.includes("${{"), `an expression inside the run script:\n${run}`);
});

test("the workflow grants permissions exactly once, so trust-root-guard inherits read-only too", () => {
  assert.equal((TRUSTED.match(/permissions:/g) || []).length, 1);
  assert.match(TRUSTED, /^permissions:\n {2}contents: read$/m);
});

test("the header names both required checks", () => {
  const header = TRUSTED.slice(0, TRUSTED.indexOf("\non:"));
  assert.match(header, /required status checks? on master/);
  assert.ok(header.includes("trusted-secret-scan"), "trusted-secret-scan");
  assert.ok(header.includes("trust-root-guard"), "trust-root-guard");
});

// ── trustRootViolations (unit) ───────────────────────────────────────────────

test("trustRootViolations flags every trust-root path, deduped and sorted", () => {
  assert.deepEqual(trustRootViolations(TRUST_ROOT), [...TRUST_ROOT].sort());
});

test("trustRootViolations ignores near-misses that are not exact trust-root paths", () => {
  const nearMisses = [
    "scripts/ci/secret-scan.mjs.bak",
    "x/.github/workflows/secret-scan.yml",
    ".github/workflows/secret-scan.yaml",
    "codeowners",
    "CODEOWNERS.md",
    "scripts/ci/secret-scan.mjs/extra",
  ];
  assert.deepEqual(trustRootViolations(nearMisses), []);
});

test("trustRootViolations dedupes its hits and sorts them", () => {
  const hits = trustRootViolations([
    "scripts/ci/trust-root-guard.mjs",
    "unrelated/file.ts",
    ".github/CODEOWNERS",
    "scripts/ci/trust-root-guard.mjs",
    "CODEOWNERS",
  ]);
  assert.deepEqual(hits, [".github/CODEOWNERS", "CODEOWNERS", "scripts/ci/trust-root-guard.mjs"]);
});

// ── trust-root-guard.mjs, the CLI (end to end against a real git repo) ─────
// Each scenario builds its own repo under the OS temp directory (this box
// redirects TMPDIR under /mnt/sparkbulk; a bare CI runner falls back to its
// own default), commits trust-root files once as `base`, then commits a
// change on a fresh branch and runs the real script against both commit ids.

function buildRepo() {
  const dir = mkdtempSync(join(tmpdir(), "trust-root-guard-"));
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "--quiet", "-b", "main"]);
  git(["config", "user.email", "trust-root-guard-test@example.com"]);
  git(["config", "user.name", "trust-root-guard-test"]);
  for (const trustPath of TRUST_ROOT) {
    const abs = join(dir, trustPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${trustPath}\n`);
  }
  writeFileSync(join(dir, "README.md"), "base\n");
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", "base"]);
  const base = git(["rev-parse", "HEAD"]).trim();
  return { dir, git, base };
}

function removeRepo(repo) {
  rmSync(repo.dir, { recursive: true, force: true });
}

let scenarioId = 0;

/** Commits `mutate`'s changes on a fresh branch off `repo.base`; returns the new commit id. */
function commitChange(repo, mutate, message = "change") {
  repo.git(["checkout", "--quiet", "-b", `scenario-${scenarioId++}`, repo.base]);
  mutate();
  repo.git(["add", "-A"]);
  repo.git(["commit", "--quiet", "-m", message]);
  return repo.git(["rev-parse", "HEAD"]).trim();
}

/** Spawns the real CLI (never its internals) with `cwd` as the repo root. */
function runGuard(cwd, args) {
  const r = spawnSync(process.execPath, [GUARD_SCRIPT, ...args], { cwd, encoding: "utf8", timeout: 30_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

for (const trustPath of TRUST_ROOT) {
  test(`trust-root-guard exits 1 and lists ${trustPath} when a change touches it`, () => {
    const repo = buildRepo();
    try {
      const head = commitChange(repo, () => appendFileSync(join(repo.dir, trustPath), "touched\n"));
      const r = runGuard(repo.dir, [repo.base, head]);
      assert.equal(r.status, 1);
      assert.ok(r.stdout.includes(trustPath), r.stdout);
    } finally {
      removeRepo(repo);
    }
  });
}

test("trust-root-guard exits 0 when a change is unrelated to the trust root", () => {
  const repo = buildRepo();
  try {
    const head = commitChange(repo, () => {
      mkdirSync(join(repo.dir, "src"), { recursive: true });
      writeFileSync(join(repo.dir, "src/unrelated.ts"), "export const ok = true;\n");
    });
    const r = runGuard(repo.dir, [repo.base, head]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /none in the trust root/);
  } finally {
    removeRepo(repo);
  }
});

test("trust-root-guard exits 1 when a change renames scripts/ci/secret-scan.mjs away", () => {
  const repo = buildRepo();
  try {
    const head = commitChange(repo, () =>
      repo.git(["mv", "scripts/ci/secret-scan.mjs", "scripts/ci/secret-scan-renamed.mjs"]),
    );
    const r = runGuard(repo.dir, [repo.base, head]);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes("scripts/ci/secret-scan.mjs"), r.stdout);
  } finally {
    removeRepo(repo);
  }
});

test("trust-root-guard exits 1 when a change deletes .github/CODEOWNERS", () => {
  const repo = buildRepo();
  try {
    const head = commitChange(repo, () => repo.git(["rm", "--quiet", ".github/CODEOWNERS"]));
    const r = runGuard(repo.dir, [repo.base, head]);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes(".github/CODEOWNERS"), r.stdout);
  } finally {
    removeRepo(repo);
  }
});

test("a changed path named with an injected workflow command never produces a `::`-prefixed output line", () => {
  const repo = buildRepo();
  try {
    const injected = "innocuous\n::error::injected";
    const head = commitChange(repo, () => {
      writeFileSync(join(repo.dir, injected), "x\n");
      appendFileSync(join(repo.dir, ".github/CODEOWNERS"), "touched\n");
    });
    const r = runGuard(repo.dir, [repo.base, head]);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes(".github/CODEOWNERS"), r.stdout);
    for (const line of (r.stdout + r.stderr).split("\n")) {
      assert.ok(!line.startsWith("::"), `a workflow-command line: ${JSON.stringify(line)}`);
    }
  } finally {
    removeRepo(repo);
  }
});

for (const [label, args] of [
  ["no arguments", []],
  ["one argument", ["a".repeat(40)]],
  ["three arguments", ["a".repeat(40), "b".repeat(40), "c".repeat(40)]],
  ["a non-hex base", ["not-a-sha", "b".repeat(40)]],
  ["a non-hex head", ["a".repeat(40), "not-a-sha"]],
  ["an uppercase sha (the pattern is lowercase-only)", ["A".repeat(40), "b".repeat(40)]],
  ["a too-short sha", ["a".repeat(39), "b".repeat(40)]],
]) {
  test(`trust-root-guard exits 2 given ${label}`, () => {
    const r = runGuard(ROOT, args);
    assert.equal(r.status, 2, r.stderr);
  });
}

test("trust-root-guard exits 2 given a well-formed but unknown commit id", () => {
  const repo = buildRepo();
  try {
    const r = runGuard(repo.dir, [repo.base, "f".repeat(40)]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /could not list the paths/);
  } finally {
    removeRepo(repo);
  }
});
