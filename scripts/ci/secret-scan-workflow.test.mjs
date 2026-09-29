// Structural checks on the workflows that run the secret scan (board row N44).
// They read the YAML as text: the job that runs them installs no packages.
//
//   node --test scripts/ci/secret-scan-workflow.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TRUSTED = readFileSync(resolve(ROOT, ".github/workflows/secret-scan.yml"), "utf8");
const CI = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");

/** The text of the step whose name contains `name`, up to the next step. */
function step(workflow, name) {
  const start = workflow.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `no step named "${name}"`);
  const next = workflow.indexOf("\n      - ", start + 1);
  return workflow.slice(start, next < 0 ? undefined : next);
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
