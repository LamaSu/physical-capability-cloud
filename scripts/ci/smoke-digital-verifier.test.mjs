// Tests for scripts/smoke-digital-verifier.sh (board row N44), run hermetically
// through its SUPPORTED entry point, scripts/smoke-digital-verifier.mjs
// (FC-8 round 5 / the N44 merge: the launcher is a process boundary that
// rebuilds the child's environment from an explicit allowlist — PATH, HOME,
// PCC_ORACLE_KEY_FILE, ORACLE_DIRECT — and forwards nothing else, so
// PCC_ORACLE_KEY, $SMOKE_ROUTES and TMPDIR never cross it; see the
// adaptation notes on run(), below).
// A stub `curl` and `gh` on PATH answer every request from a per-test route
// table, and each test reads the report the script writes to the repo's own
// ai/supervisor/smoke-test-report.json (the launcher pins the script's cwd
// to the repo root; any pre-existing report is backed up and restored).
// Nothing reaches the network.
//
//   node --test scripts/ci/smoke-digital-verifier.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// N44 merge: the SUPPORTED entry point is the launcher, not the .sh file
// directly (see the .sh's own header, "UNSUPPORTED: direct invocation").
const LAUNCHER = resolve(HERE, "../smoke-digital-verifier.mjs");
// The launcher pins the script's cwd to the repo root (dirname of scripts/,
// i.e. two levels up from scripts/ci/) — it takes no cwd override — so
// REPORT_FILE resolves there too, not to a per-test scratch directory.
const REPO_ROOT = resolve(HERE, "..", "..");
const REPORT_FILE = join(REPO_ROOT, "ai/supervisor/smoke-test-report.json");
const GW = "https://capability.network";
const ORACLE = "https://refer-proxy-joint-cleaning.trycloudflare.com";
// Built at run time, so this file holds no key literal for the secret scan.
const KEY_SHAPED = ["pcc", "live", "0123456789abcdef0123456789abcdef"].join("_");

// The launcher's allowlist does not forward $SMOKE_ROUTES (not a documented
// input of the script), so the stub's routes path is baked into its own
// generated source as a literal instead of read from the environment. It
// otherwise answers "<METHOD> <URL>" from that table exactly as before:
//   { status, body, exit, lockDir }
// It writes the body to -o's file or to stdout, then expands -w's %{http_code}
// and \n as curl does, then exits with `exit` (a transport failure after the
// body when nonzero). lockDir makes -o's directory read-only after writing.
function stubCurl(routesPath) {
  return `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const ROUTES_PATH = ${JSON.stringify(routesPath)};
const args = process.argv.slice(2);
let out, fmt, method, url, data = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-o") out = args[++i];
  else if (a === "-w") fmt = args[++i];
  else if (a === "-X") method = args[++i];
  else if (a === "-d" || a === "--data" || a === "--data-raw") { data = true; i++; }
  else if (a === "-H" || a === "--max-time") i++;
  else if (/^https?:\\/\\//.test(a)) url = a;
}
method = method || (data ? "POST" : "GET");
const route = JSON.parse(fs.readFileSync(ROUTES_PATH, "utf8"))[method + " " + url];
if (!route) { process.stderr.write("curl: (7) Failed to connect\\n"); process.exit(7); }
const body = Buffer.from(route.body || "", "utf8");
if (out) {
  fs.writeFileSync(out, body);
  if (route.lockDir) fs.chmodSync(path.dirname(out), 0o555);
} else {
  process.stdout.write(body);
}
if (fmt) process.stdout.write(fmt.split("%{http_code}").join(String(route.status || 200)).split("\\\\n").join("\\n"));
process.exit(route.exit || 0);
`;
}

function baseRoutes() {
  return {
    [`GET ${GW}/api/health`]: { status: 200, body: '{"status":"ok"}' },
    [`GET ${GW}/api/setup/status`]: { status: 200, body: '{"overall":"ready"}' },
    [`GET ${ORACLE}/health`]: { status: 200, body: '{"status":"ok"}' },
    [`POST ${ORACLE}/verify`]: { status: 200, body: '{"result":{"verified":false,"reason":"smoke"}}' },
    [`POST ${GW}/api/auth/provision`]: { status: 201, body: '{"api_key":"smoke-api-key"}' },
    [`GET ${GW}/api/capabilities/types`]: { status: 200, body: '{"types":["cnc"]}' },
    [`GET ${GW}/api/kernels`]: { status: 200, body: '{"kernels":[]}' },
    [`GET ${GW}/api/status/integrations`]: { status: 200, body: '{"litProtocol":{"configured":false}}' },
    [`GET ${GW}/api/auth/validate`]: { status: 200, body: '{"valid":true,"operatorId":"smoke"}' },
  };
}

// The launcher pins the script's cwd to the repo root, so every run() below
// writes the report there, not to a scratch directory. Save whatever (if
// anything) was there before this suite ran, and restore it afterward.
const REPORT_BACKUP = existsSync(REPORT_FILE) ? readFileSync(REPORT_FILE) : null;
after(() => {
  if (REPORT_BACKUP === null) rmSync(REPORT_FILE, { force: true });
  else writeFileSync(REPORT_FILE, REPORT_BACKUP);
});

/**
 * Run the script through its launcher against `routes` (merged over the
 * sound defaults).
 *
 * Adapted from the pre-merge N44 version — key setup and the launcher only:
 *   - the oracle key is written to a FILE and forwarded as
 *     PCC_ORACLE_KEY_FILE (FC-8's contract), not PCC_ORACLE_KEY itself;
 *   - the script runs through the launcher
 *     (scripts/smoke-digital-verifier.mjs), never bash on the .sh file
 *     directly;
 *   - because the launcher rebuilds the child's environment from an
 *     explicit allowlist (PATH, HOME, PCC_ORACLE_KEY_FILE, ORACLE_DIRECT —
 *     see its own DOCUMENTED_INPUT_VARS), $SMOKE_ROUTES no longer crosses
 *     it, so the stub's routes path is baked into its own source instead
 *     (stubCurl(), above), and the script's cwd is pinned to the repo root
 *     (REPORT_FILE, above), not a per-test scratch directory.
 *   - that same allowlist also means `env` overrides this suite passes —
 *     TMPDIR, for the two tests below that set it — no longer reach the
 *     script's process either (TMPDIR was never a documented input of the
 *     script, and is not in the launcher's allowlist). Those two tests
 *     still pass (a value that can never arrive can never leak), but they
 *     no longer exercise a live TMPDIR-handling path through the supported
 *     entry point — flagged in the report as a claim this suite no longer
 *     proves, not one it disproves.
 */
function run(overrides = {}, env = {}) {
  const work = mkdtempSync(join(tmpdir(), "smoke-dv-"));
  try {
    const bin = join(work, "bin");
    mkdirSync(bin);
    const routes = join(work, "routes.json");
    writeFileSync(join(bin, "curl"), stubCurl(routes), { mode: 0o755 });
    writeFileSync(join(bin, "gh"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
    writeFileSync(routes, JSON.stringify({ ...baseRoutes(), ...overrides }));
    const keyFile = join(work, "oracle-key");
    writeFileSync(keyFile, "smoke-oracle-key");
    const res = spawnSync(process.execPath, [LAUNCHER], {
      encoding: "utf8",
      timeout: 120_000,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: work,
        PCC_ORACLE_KEY_FILE: keyFile,
        ...env,
      },
    });
    const reportText = existsSync(REPORT_FILE) ? readFileSync(REPORT_FILE, "utf8") : "";
    return {
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      reportText,
      report: reportText ? JSON.parse(reportText) : { checks: [] },
    };
  } finally {
    chmodTree(work);
    rmSync(work, { recursive: true, force: true });
  }
}

/** Undo lockDir so the scratch directory can be removed. */
function chmodTree(dir) {
  const r = spawnSync("chmod", ["-R", "u+w", dir]);
  if (r.error) throw r.error;
}

const status = (r, name) => r.report.checks.find((c) => c.name === name)?.status ?? "MISSING";
const verifyAnswer = (body, extra = {}) => ({ [`POST ${ORACLE}/verify`]: { status: 200, body, ...extra } });

// ── The authenticated verify request (finding 3, first blocker) ─────────────

test("a processed verify request passes whether the oracle says verified true or false", () => {
  for (const verified of [false, true]) {
    const r = run(verifyAnswer(JSON.stringify({ result: { verified, reason: "smoke" } })));
    assert.equal(status(r, "oracle-verify"), "PASS", `verified=${verified}`);
  }
});

for (const [label, body] of [
  ["an empty body", ""],
  ["a whitespace-only body", " \n "],
  ["two JSON documents", "{}{}"],
  ["two answers", '{"result":{"verified":true}}{"result":{"verified":false}}'],
  ["a valid answer followed by malformed bytes", '{"result":{"verified":true}} trailing'],
  ["a string where the boolean belongs", '{"result":{"verified":"true"}}'],
  ["an array", '[{"result":{"verified":true}}]'],
  // N44 (round 5, F3): a NUL anywhere in the body becomes SOH before bash ever
  // sees it (nul_safe), and json_object_where refuses a body holding one
  // outright, so all three shapes below must fail exactly like the others.
  ["a valid object followed by a NUL byte", '{"result":{"verified":true}}' + "\0"],
  ["a NUL byte inside a JSON string", '{"result":{"verified":true,"reason":"a' + "\0" + 'b"}}'],
  ["a leading NUL byte", "\0" + '{"result":{"verified":true}}'],
]) {
  test(`a 200 verify answer with ${label} fails`, () => {
    const r = run(verifyAnswer(body));
    assert.equal(status(r, "oracle-verify"), "FAIL");
    // F3: bash's command substitution would otherwise silently drop the NUL
    // and print this warning straight to stderr, bypassing say() entirely.
    assert.ok(!r.stderr.includes("ignored null byte"), r.stderr);
  });
}

test("a verify answer cut off by a transport error fails", () => {
  assert.equal(status(run(verifyAnswer('{"result":{"verified":true}}', { exit: 56 })), "oracle-verify"), "FAIL");
});

// ── The end-to-end flow (finding 3, second blocker) ─────────────────────────

test("a sound end-to-end flow passes", () => {
  assert.equal(status(run(), "e2e-flow"), "PASS");
});

for (const [label, route, answer] of [
  ["key validation answers 401", `GET ${GW}/api/auth/validate`, { status: 401, body: '{"valid":true}' }],
  ["key validation says the string \"true\"", `GET ${GW}/api/auth/validate`, { status: 200, body: '{"valid":"true"}' }],
  ["key validation's body is followed by a transport error", `GET ${GW}/api/auth/validate`, { status: 200, body: '{"valid":true}', exit: 56 }],
  ["provisioning answers 500", `POST ${GW}/api/auth/provision`, { status: 500, body: '{"api_key":"smoke-api-key"}' }],
  ["provisioning answers two documents", `POST ${GW}/api/auth/provision`, { status: 201, body: '{"api_key":"a"}{"api_key":"b"}' }],
  ["the capability-type list answers 500", `GET ${GW}/api/capabilities/types`, { status: 500, body: '{"error":"down"}' }],
  ["the kernel list fails in transport", `GET ${GW}/api/kernels`, { status: 200, body: "", exit: 7 }],
  ["setup status answers something that is not an object", `GET ${GW}/api/setup/status`, { status: 200, body: "[]" }],
]) {
  test(`the end-to-end flow fails when ${label}`, () => {
    assert.equal(status(run({ [route]: answer }), "e2e-flow"), "FAIL");
  });
}

// ── Output (finding 3, sinks outside say()) ─────────────────────────────────

test("a key-shaped TMPDIR never reaches the output, even when temporary files fail", () => {
  const r = run({}, { TMPDIR: `/nonexistent/${KEY_SHAPED}` });
  assert.ok(!r.stdout.includes(KEY_SHAPED), "stdout");
  assert.ok(!r.stderr.includes(KEY_SHAPED), "stderr");
  assert.ok(!r.reportText.includes(KEY_SHAPED), "report");
});

test("a failing cleanup never prints a key-shaped TMPDIR path", () => {
  const work = mkdtempSync(join(tmpdir(), "smoke-dv-tmp-"));
  const keyDir = join(work, KEY_SHAPED);
  mkdirSync(keyDir);
  try {
    const r = run(verifyAnswer('{"result":{"verified":false}}', { lockDir: true }), { TMPDIR: keyDir });
    assert.ok(!r.stdout.includes(KEY_SHAPED), "stdout");
    assert.ok(!r.stderr.includes(KEY_SHAPED), "stderr");
  } finally {
    chmodTree(work);
    rmSync(work, { recursive: true, force: true });
  }
});

test("control bytes in a response never reach the terminal", () => {
  const reason = "\u001b]0;PWNED\u0007\u001b[2J\rcleared";
  const r = run(verifyAnswer(JSON.stringify({ result: { verified: false, reason } })));
  assert.equal(status(r, "oracle-verify"), "PASS");
  assert.ok(!r.stdout.includes("\u001b]0;PWNED"), "an OSC sequence from the response");
  assert.ok(!r.stdout.includes("\u001b[2J"), "a CSI sequence from the response");
  assert.ok(!r.stdout.includes("\rcleared"), "a carriage return from the response");
});

// ── Sanitization order: redact runs again after the control-byte strip ─────
// (F2, round 5). Stripping control bytes can JOIN a split "pcc_live_" prefix
// to the hex that follows it ("pcc_" "live_" + CR + hex is no key until the
// CR is gone); sanitize() must redact again after the strip, or the rejoined
// key prints whole. Built at run time so this file holds no key literal.
//
// N44 merge note (fc8-split-n44-mergetree, conflict 3): N44's own pass
// message here printed `reason: $REASON` (`.result.reason`, redact()-
// sanitized); FC-8 round 2 — kept verbatim a few lines above this file's
// stub route table, and in smoke-digital-verifier.sh's own merged verify
// case — found that unsafe anyway: .result.reason is the oracle's free
// text and may reflect an arbitrary secret redact()'s PCC-key-shaped regex
// would not catch, so the merged script never prints it at all (only the
// validated boolean `verified`). That FC-8 sink rule is kept over this
// N44 behavior (see the report). The `if (stripped) { assert.ok(includes
// ("pcc_live_<redacted>")) }` branch this loop used to have is removed
// for that reason: it asserted evidence of a print path that no longer
// exists. The two assert.ok(!includes(CONTIGUOUS_KEY)) checks below —
// the actual leak-prevention property — stand for every byte, stripped
// or not, and now hold unconditionally (reason is never printed, stripped
// or rejoined or otherwise, so it can never reach output at all).
const HEX64 = "0123456789abcdef".repeat(4);
const CONTIGUOUS_KEY = ["pcc", "live", HEX64].join("_");

for (const [label, byte] of [
  ["a carriage return", "\r"],
  ["an ESC byte", "\x1b"],
  ["a DEL byte", "\x7f"],
  ["a SOH byte", "\x01"],
  ["a backspace byte", "\x08"],
  ["a VT byte", "\x0b"],
  // tab and newline are never stripped, so the key can never rejoin; these
  // two are a non-regression check that they are not treated specially.
  ["a newline", "\n"],
  ["a tab", "\t"],
]) {
  test(`a verify reason split by ${label} never reaches the output as a contiguous key`, () => {
    const reason = ["pcc", "live", byte + HEX64].join("_");
    const r = run(verifyAnswer(JSON.stringify({ result: { verified: true, reason } })));
    assert.equal(status(r, "oracle-verify"), "PASS");
    assert.ok(!r.stdout.includes(CONTIGUOUS_KEY), "stdout");
    assert.ok(!r.stderr.includes(CONTIGUOUS_KEY), "stderr");
  });
}

// ── NUL bytes never reach bash's command substitution as a raw NUL ─────────
// (F3, round 5). Every response body is piped through nul_safe (NUL -> SOH)
// before bash's $(...) sees it, so bash can never silently drop one or print
// its "ignored null byte" warning straight to stderr, bypassing say().

test("the gateway health endpoint answering a body with an embedded NUL byte does not crash the script", () => {
  const r = run({ [`GET ${GW}/api/health`]: { status: 200, body: '{"status":"ok","note":"a' + "\0" + 'b"}' } });
  assert.ok(!r.stderr.includes("ignored null byte"), r.stderr);
  // The script ran to completion (a later check recorded a status) rather
  // than aborting under `set -euo pipefail`.
  assert.notEqual(status(r, "new-code-deployed"), "MISSING");
});
