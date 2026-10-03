// Tests for scripts/smoke-digital-verifier.sh (board row N44), run hermetically.
// A stub `curl` and `gh` on PATH answer every request from a per-test route
// table, the script runs in a scratch directory, and each test reads the report
// the script writes there. Nothing reaches the network.
//
//   node --test scripts/ci/smoke-digital-verifier.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../smoke-digital-verifier.sh");
const GW = "https://capability.network";
const ORACLE = "https://refer-proxy-joint-cleaning.trycloudflare.com";
// Built at run time, so this file holds no key literal for the secret scan.
const KEY_SHAPED = ["pcc", "live", "0123456789abcdef0123456789abcdef"].join("_");

// The stub answers "<METHOD> <URL>" from $SMOKE_ROUTES:
//   { status, body, exit, lockDir }
// It writes the body to -o's file or to stdout, then expands -w's %{http_code}
// and \n as curl does, then exits with `exit` (a transport failure after the
// body when nonzero). lockDir makes -o's directory read-only after writing.
const STUB_CURL = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
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
const route = JSON.parse(fs.readFileSync(process.env.SMOKE_ROUTES, "utf8"))[method + " " + url];
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

/** Run the script against `routes` (merged over the sound defaults). */
function run(overrides = {}, env = {}) {
  const work = mkdtempSync(join(tmpdir(), "smoke-dv-"));
  try {
    const bin = join(work, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "curl"), STUB_CURL, { mode: 0o755 });
    writeFileSync(join(bin, "gh"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
    const routes = join(work, "routes.json");
    writeFileSync(routes, JSON.stringify({ ...baseRoutes(), ...overrides }));
    const cwd = join(work, "cwd");
    mkdirSync(cwd);
    const res = spawnSync("bash", [SCRIPT], {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: work,
        SMOKE_ROUTES: routes,
        PCC_ORACLE_KEY: "smoke-oracle-key",
        ...env,
      },
    });
    const reportFile = join(cwd, "ai/supervisor/smoke-test-report.json");
    const reportText = existsSync(reportFile) ? readFileSync(reportFile, "utf8") : "";
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
const HEX64 = "0123456789abcdef".repeat(4);
const CONTIGUOUS_KEY = ["pcc", "live", HEX64].join("_");

for (const [label, byte, stripped] of [
  ["a carriage return", "\r", true],
  ["an ESC byte", "\x1b", true],
  ["a DEL byte", "\x7f", true],
  ["a SOH byte", "\x01", true],
  ["a backspace byte", "\x08", true],
  ["a VT byte", "\x0b", true],
  // tab and newline are never stripped, so the key can never rejoin; these
  // two are a non-regression check that they are not treated specially.
  ["a newline", "\n", false],
  ["a tab", "\t", false],
]) {
  test(`a verify reason split by ${label} never reaches the output as a contiguous key`, () => {
    const reason = ["pcc", "live", byte + HEX64].join("_");
    const r = run(verifyAnswer(JSON.stringify({ result: { verified: true, reason } })));
    assert.equal(status(r, "oracle-verify"), "PASS");
    assert.ok(!r.stdout.includes(CONTIGUOUS_KEY), "stdout");
    assert.ok(!r.stderr.includes(CONTIGUOUS_KEY), "stderr");
    if (stripped) {
      assert.ok(r.stdout.includes("pcc_live_<redacted>"), `expected a redacted marker in:\n${r.stdout}`);
    }
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
