// Structural checks on the workflows that run the secret scan (board row N44).
// They read the YAML as text: the job that runs them installs no packages.
//
//   node --test scripts/ci/secret-scan-workflow.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TRUST_ROOT, trustRootViolations } from "./trust-root-guard.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TRUSTED = readFileSync(resolve(ROOT, ".github/workflows/secret-scan.yml"), "utf8");
const CI = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");
const GUARD_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "trust-root-guard.mjs");

/** The text of the step whose name contains `name`, up to the next step or job (or EOF). */
function step(workflow, name) {
  const start = workflow.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `no step named "${name}"`);
  const next = /\n {6}- |\n {2}\S/.exec(workflow.slice(start + 1));
  return workflow.slice(start, next ? start + 1 + next.index : undefined);
}

/** Every `run: |` script: the lines after it that are blank or indented deeper than its key. */
function runScripts(workflow) {
  const lines = workflow.split("\n");
  const scripts = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^( *)run: \|$/.exec(lines[i]);
    if (!m) continue;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() !== "" && line.length - line.trimStart().length <= m[1].length) break;
      body.push(line);
    }
    scripts.push(body.join("\n"));
  }
  return scripts;
}

/** The workflow without its comment lines. */
function uncommented(workflow) {
  return workflow.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
}

/** The text of the job keyed `name` directly under `jobs:`, up to the next job (or EOF). */
function job(workflow, name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `no job named "${name}"`);
  const body = workflow.slice(start + 1);
  const next = /\n {2}\S/.exec(body);
  return next ? body.slice(0, next.index) : body;
}

test("the trusted scan does not run on merge_group (a queue runs workflow files a pull request can add)", () => {
  assert.ok(!/^ {2}merge_group:/m.test(TRUSTED), "merge_group trigger");
  assert.ok(!TRUSTED.includes("github.event.merge_group"), "a merge_group expression");
});

test("editing a pull request's title or description runs the trusted scan again", () => {
  const types = /^ {2}pull_request_target:\n {4}types: \[([^\]]*)\]$/m.exec(TRUSTED)?.[1] ?? "";
  assert.ok(types.split(",").map((t) => t.trim()).includes("edited"), types);
});

test("every checkout is the base commit for a pull request, never the code under test", () => {
  const refs = [...TRUSTED.matchAll(/ref: (\$\{\{.*\}\})/g)].map((m) => m[1]);
  assert.equal(refs.length, 4, refs.join("\n"));
  for (const ref of refs) {
    assert.match(ref, /github\.event\.pull_request\.base\.sha/);
    assert.ok(!ref.includes(".head."), ref);
  }
  assert.equal((TRUSTED.match(/persist-credentials: false/g) || []).length, 4);
  assert.match(TRUSTED, /^permissions:\n {2}contents: read$/m);
});

test("one run per pull request: a newer push or edit cancels the old run; pushes to master are never cancelled", () => {
  assert.match(TRUSTED, /^concurrency:\n {2}group: secret-scan-\$\{\{ github\.event\.pull_request\.number \|\| github\.sha \}\}\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request_target' \}\}$/m);
});

test("the pull request's title and description are scanned, and reach the shell only through the environment", () => {
  const s = step(TRUSTED, "Scan the pull request's title and description");
  assert.match(s, /PR_TITLE: \$\{\{ github\.event\.pull_request\.title \}\}/);
  assert.match(s, /PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}/);
  assert.match(s, /node scripts\/ci\/secret-scan\.mjs --text /);
  // No expression is expanded inside a run script (script injection), block or one-line.
  const scripts = runScripts(TRUSTED);
  assert.equal(scripts.length, 4, "every block script was found");
  for (const script of scripts) {
    assert.ok(!script.includes("${{"), `an expression inside a run script:\n${script}`);
  }
  for (const [, line] of TRUSTED.matchAll(/\n\s+run: (?!\|)(.*)/g)) {
    assert.ok(!line.includes("${{"), `an expression inside a run line: ${line}`);
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

test("the trust-root-guard job runs only for a pull request (on push the scan above is detection, not prevention)", () => {
  assert.match(job(TRUSTED, "trust-root-guard"), /\n {4}if: github\.event_name == 'pull_request_target'\n/);
});

test("the trust-root-guard job checks out only the base commit, never the head, and persists no credentials", () => {
  const guard = job(TRUSTED, "trust-root-guard");
  const ref = /ref: (\$\{\{.*\}\})/.exec(guard)?.[1] ?? "";
  assert.equal(ref, "${{ github.event.pull_request.base.sha }}");
  assert.match(guard, /persist-credentials: false/);
});

test("the trust-root-guard run step passes both SHAs through env and never interpolates an expression inside run", () => {
  const s = step(TRUSTED, "Refuse a change to the trust root");
  assert.match(s, /HEAD_SHA: \$\{\{.*\}\}/);
  assert.match(s, /BASE_SHA: \$\{\{.*\}\}/);
  assert.match(s, /git fetch --no-tags --quiet origin "\$HEAD_SHA"/);
  assert.match(s, /node scripts\/ci\/trust-root-guard\.mjs "\$BASE_SHA" "\$HEAD_SHA"/);
  const [run] = runScripts(s);
  assert.ok(run && !run.includes("${{"), `an expression inside the run script:\n${run}`);
});

test("the workflow grants permissions exactly once, so trust-root-guard inherits read-only too", () => {
  assert.equal((TRUSTED.match(/permissions:/g) || []).length, 1);
  assert.match(TRUSTED, /^permissions:\n {2}contents: read$/m);
});

test("the required scan covers commit content only; the title and description are scanned by their own job, for pr-text", () => {
  assert.ok(!job(TRUSTED, "trusted-secret-scan").includes("title and description"), "the required scan reads PR text");
  const text = job(TRUSTED, "pr-text-scan");
  assert.match(text, /\n {4}if: github\.event_name == 'pull_request_target'\n/);
  assert.ok(text.includes("- name: Scan the pull request's title and description"), text);
  assert.match(text, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
});

test("the header names both required checks, the App as their source, and the master-only environment", () => {
  const header = TRUSTED.slice(0, TRUSTED.indexOf("\non:"));
  assert.ok(header.includes("pcc-trusted/secret-scan"), "pcc-trusted/secret-scan");
  assert.ok(header.includes("pcc-trusted/trust-root-guard"), "pcc-trusted/trust-root-guard");
  assert.match(header, /with that App as their source \(its app_id\), never "any source"/);
  assert.match(header, /environment named trusted-checks whose deployment branches are\n# +"Selected branches": master only/);
  assert.match(header, /No merge queue/);
  assert.match(header, /pcc-trusted\/pr-text, but that check is\n# INFORMATIONAL and must not be required/);
  assert.match(header, /allow ONLY rebase merging/);
});

// ── The verdicts (finding 1, round 6) ───────────────────────────────────────
// The required checks are check runs a dedicated App posts on the pull
// request's head commit. Only the post-verdicts job can reach the App's key.

const VERDICT_JOB = job(TRUSTED, "post-verdicts");

test("post-verdicts waits for both jobs, runs whatever their result, and never for a cancelled run or a push", () => {
  assert.match(VERDICT_JOB, /\n {4}needs: \[trusted-secret-scan, trust-root-guard, pr-text-scan\]\n/);
  assert.match(VERDICT_JOB, /\n {4}if: \$\{\{ github\.event_name == 'pull_request_target' && !cancelled\(\) \}\}\n/);
});

test("post-verdicts runs in the trusted-checks environment, checks out only the base, and runs only the verdict script", () => {
  assert.match(VERDICT_JOB, /\n {4}environment: trusted-checks\n/);
  assert.match(VERDICT_JOB, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(VERDICT_JOB, /persist-credentials: false/);
  const uses = [...VERDICT_JOB.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(uses, ["actions/checkout@v4"]);
  const runs = [...VERDICT_JOB.matchAll(/\n\s+run: (.*)/g)].map((m) => m[1]);
  assert.deepEqual(runs, ["node scripts/ci/post-trusted-verdicts.mjs"]);
});

test("post-verdicts gets every pull-request value and both job results through env, from the event and needs", () => {
  const s = step(TRUSTED, "Post the verdicts on the pull request's head commit");
  for (const [name, expr] of [
    ["TRUSTED_CHECKS_APP_ID", "secrets.TRUSTED_CHECKS_APP_ID"],
    ["TRUSTED_CHECKS_PRIVATE_KEY", "secrets.TRUSTED_CHECKS_PRIVATE_KEY"],
    ["PR_NUMBER", "github.event.pull_request.number"],
    ["HEAD_SHA", "github.event.pull_request.head.sha"],
    ["PR_TITLE", "github.event.pull_request.title"],
    ["PR_BODY", "github.event.pull_request.body"],
    ["SCAN_RESULT", "needs.trusted-secret-scan.result"],
    ["GUARD_RESULT", "needs.trust-root-guard.result"],
    ["TEXT_RESULT", "needs.pr-text-scan.result"],
  ]) {
    assert.ok(s.includes(`${name}: \${{ ${expr} }}`), `${name}: ${expr}`);
  }
});

test("only post-verdicts names a secret or the trusted-checks environment, in any workflow", () => {
  const outside = uncommented(TRUSTED.replace(VERDICT_JOB, ""));
  assert.ok(!outside.includes("secrets."), "a secret outside post-verdicts");
  assert.ok(!outside.includes("trusted-checks"), "the environment outside post-verdicts");
  const dir = resolve(ROOT, ".github/workflows");
  for (const name of readdirSync(dir)) {
    if (name === "secret-scan.yml") continue;
    const text = uncommented(readFileSync(join(dir, name), "utf8"));
    assert.ok(!text.includes("trusted-checks"), `${name} names the trusted-checks environment`);
    assert.ok(!text.includes("TRUSTED_CHECKS_"), `${name} names a trusted-checks secret`);
  }
});

// ── trustRootViolations (unit) ───────────────────────────────────────────────

test("trustRootViolations flags every trust-root path, deduped and sorted", () => {
  assert.deepEqual(trustRootViolations(TRUST_ROOT), [...TRUST_ROOT].sort());
});

test("trustRootViolations ignores near-misses that are not trust-root files or under a trust-root directory", () => {
  const nearMisses = [
    "scripts/ci/secret-scan.mjs.bak",
    "x/.github/workflows/secret-scan.yml",
    ".github/workflowsX/ci.yml",
    ".github/workflow/ci.yml",
    "github/workflows/ci.yml",
    ".github/actions",
    "x/.github/actions/a/action.yml",
    "codeowners",
    "CODEOWNERS.md",
    "scripts/ci/secret-scan.mjs/extra",
    "scripts/ci/post-trusted-verdicts.test.mjs",
  ];
  assert.deepEqual(trustRootViolations(nearMisses), []);
});

test("any file under .github/workflows/ or .github/actions/ is a trust-root change, a new one included", () => {
  assert.deepEqual(trustRootViolations([".github/workflows/new-one.yml"]), [".github/workflows/"]);
  assert.deepEqual(trustRootViolations([".github/workflows/ci.yml"]), [".github/workflows/"]);
  assert.deepEqual(trustRootViolations([".github/actions/x/action.yml"]), [".github/actions/"]);
});

test("trustRootViolations returns fixed entries, deduped and sorted, never a changed path", () => {
  const hits = trustRootViolations([
    "scripts/ci/trust-root-guard.mjs",
    "unrelated/file.ts",
    ".github/CODEOWNERS",
    "scripts/ci/trust-root-guard.mjs",
    ".github/workflows/a.yml",
    ".github/workflows/b.yml",
    "CODEOWNERS",
  ]);
  assert.deepEqual(hits, [".github/CODEOWNERS", ".github/workflows/", "CODEOWNERS", "scripts/ci/trust-root-guard.mjs"]);
  for (const hit of hits) assert.ok(TRUST_ROOT.includes(hit), hit);
});

// ── trust-root-guard.mjs, the CLI (end to end against a real git repo) ─────
// Each scenario builds its own repo under the OS temp directory (this box
// redirects TMPDIR under /mnt/sparkbulk; a bare CI runner falls back to its
// own default), commits trust-root files once as `base`, then commits a
// change on a fresh branch and runs the real script against both commit ids.

/** A file that stands for a trust-root entry: the file itself, or one inside a directory entry. */
function fileFor(trustPath) {
  return trustPath.endsWith("/") ? `${trustPath}existing.yml` : trustPath;
}

function buildRepo() {
  const dir = mkdtempSync(join(tmpdir(), "trust-root-guard-"));
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "--quiet", "-b", "main"]);
  git(["config", "user.email", "trust-root-guard-test@example.com"]);
  git(["config", "user.name", "trust-root-guard-test"]);
  for (const trustPath of TRUST_ROOT) {
    const abs = join(dir, fileFor(trustPath));
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
      const head = commitChange(repo, () => appendFileSync(join(repo.dir, fileFor(trustPath)), "touched\n"));
      const r = runGuard(repo.dir, [repo.base, head]);
      assert.equal(r.status, 1);
      assert.ok(r.stdout.includes(trustPath), r.stdout);
    } finally {
      removeRepo(repo);
    }
  });
}

test("trust-root-guard exits 1 when a change ADDS a workflow file (it could name the trusted-checks environment)", () => {
  const repo = buildRepo();
  try {
    const head = commitChange(repo, () => writeFileSync(join(repo.dir, ".github/workflows/added.yml"), "on: push\n"));
    const r = runGuard(repo.dir, [repo.base, head]);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes(".github/workflows/"), r.stdout);
    assert.ok(!r.stdout.includes("added.yml"), "a changed path was printed");
  } finally {
    removeRepo(repo);
  }
});

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

test("a workflow file named with an injected workflow command is caught, and its name is never printed", () => {
  const repo = buildRepo();
  try {
    const head = commitChange(repo, () => writeFileSync(join(repo.dir, ".github/workflows/x\n::error::injected.yml"), "x\n"));
    const r = runGuard(repo.dir, [repo.base, head]);
    assert.equal(r.status, 1);
    for (const line of (r.stdout + r.stderr).split("\n")) {
      assert.ok(!line.startsWith("::"), `a workflow-command line: ${JSON.stringify(line)}`);
    }
    assert.ok(!r.stdout.includes("injected"), r.stdout);
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
