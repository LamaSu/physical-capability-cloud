// Tests for scripts/ci/post-trusted-verdicts.mjs (board row N44, round 6).
// They run the real CLI against a fake GitHub API on 127.0.0.1, with a key pair
// made here, so the App JWT, the token's scope, the freshness rule, the check
// runs and the token's revocation are all checked end to end.
//
//   node --test scripts/ci/post-trusted-verdicts.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PR_TEXT, VERDICTS, conclusionFor, textConclusionFor } from "./post-trusted-verdicts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "post-trusted-verdicts.mjs");
const WORKFLOW = readFileSync(resolve(HERE, "../../.github/workflows/secret-scan.yml"), "utf8");

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs1", format: "pem" }); // GitHub issues PKCS#1 keys
const HEAD = "a".repeat(40);
const TOKEN = `ghs_${"T".repeat(36)}`;
const TITLE = "Add the widget";
// Key-shaped text is built at run time, so this file never trips a secret scan.
const PEM_LABEL = ["RSA", "PRIVATE", "KEY"].join(" ");
const PEM_BEGIN = `-----BEGIN ${PEM_LABEL}-----`;
const PEM_END = `-----END ${PEM_LABEL}-----`;
const AWS_LIKE = ["AK", "IA"].join("") + "ABCDEFGHIJKLMNOP";
const BODY = "It adds the widget.\nNothing else.";

/** A fake GitHub API. `routes` maps "METHOD /path" to (body) => [status, json]; every request is recorded. */
async function fakeGitHub(overrides = {}) {
  const requests = [];
  const routes = {
    "GET /repos/o/r/installation": () => [200, { id: 42 }],
    "POST /app/installations/42/access_tokens": () => [201, { token: TOKEN }],
    "GET /repos/o/r/pulls/7": () => [200, { head: { sha: HEAD }, title: TITLE, body: BODY }],
    "POST /repos/o/r/check-runs": () => [201, { id: 1 }],
    "DELETE /installation/token": () => [204, null],
    ...overrides,
  };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const key = `${req.method} ${req.url}`;
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method, path: req.url, auth: req.headers.authorization ?? "", body });
      const route = routes[key];
      const [status, json] = route ? route(body) : [404, { message: "Not Found" }];
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(json === null ? "" : JSON.stringify(json));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((done) => server.close(done)) };
}

function env(api, overrides = {}) {
  return {
    PATH: process.env.PATH,
    TRUSTED_CHECKS_APP_ID: "12345",
    TRUSTED_CHECKS_PRIVATE_KEY: PRIVATE_PEM,
    GITHUB_REPOSITORY: "o/r",
    GITHUB_API_URL: api.url,
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_RUN_ID: "999",
    GITHUB_RUN_ATTEMPT: "2",
    PR_NUMBER: "7",
    HEAD_SHA: HEAD,
    PR_TITLE: TITLE,
    PR_BODY: BODY,
    SCAN_RESULT: "success",
    GUARD_RESULT: "success",
    TEXT_RESULT: "success",
    ...overrides,
  };
}

/** Runs the real CLI (async: the fake API answers from this same process). */
function run(environment) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [SCRIPT], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("error", fail);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr });
    });
  });
}

const checkRuns = (api) => api.requests.filter((r) => r.method === "POST" && r.path === "/repos/o/r/check-runs");

function decodeJwt(jwt) {
  const [h, p, s] = jwt.split(".");
  const json = (part) => JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  return { header: json(h), payload: json(p), signed: `${h}.${p}`, signature: Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64") };
}

test("the verdicts are posted on the head commit, as the App, with a token scoped to this repo, then the token is revoked", async () => {
  const api = await fakeGitHub();
  try {
    const r = await run(env(api));
    assert.equal(r.status, 0, r.stderr);

    // The App JWT: RS256, issued by the App id, valid for at most ten minutes, signed by its key.
    const jwt = api.requests[0].auth.replace(/^Bearer /, "");
    const { header, payload, signed, signature } = decodeJwt(jwt);
    assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
    assert.equal(payload.iss, "12345");
    assert.equal(payload.exp - payload.iat, 600);
    assert.ok(verify("sha256", Buffer.from(signed), publicKey, signature), "the JWT signature");

    const [installation, minted, pr, first, second, text, revoke] = api.requests;
    assert.deepEqual([installation.method, installation.path], ["GET", "/repos/o/r/installation"]);
    assert.deepEqual([minted.method, minted.path, minted.auth], ["POST", "/app/installations/42/access_tokens", `Bearer ${jwt}`]);
    assert.deepEqual(minted.body, { repositories: ["r"], permissions: { checks: "write", pull_requests: "read" } });
    assert.deepEqual([pr.method, pr.path, pr.auth], ["GET", "/repos/o/r/pulls/7", `Bearer ${TOKEN}`]);
    for (const [request, verdict] of [[first, VERDICTS[0]], [second, VERDICTS[1]]]) {
      assert.equal(request.auth, `Bearer ${TOKEN}`);
      assert.equal(request.body.name, verdict.name);
      assert.equal(request.body.head_sha, HEAD);
      assert.equal(request.body.status, "completed");
      assert.equal(request.body.conclusion, "success");
      assert.equal(request.body.external_id, "999/2");
      assert.equal(request.body.details_url, "https://github.com/o/r/actions/runs/999");
    }
    // The text check: informational, "neutral" when the scan found nothing, never "success".
    assert.equal(text.body.name, "pcc-trusted/pr-text");
    assert.equal(text.body.head_sha, HEAD);
    assert.equal(text.body.conclusion, "neutral");
    assert.deepEqual([revoke.method, revoke.path, revoke.auth], ["DELETE", "/installation/token", `Bearer ${TOKEN}`]);
    assert.equal(api.requests.length, 7);

    // The token appears in the log only on the line that masks it.
    const tokenLines = r.stdout.split("\n").filter((line) => line.includes(TOKEN));
    assert.deepEqual(tokenLines, [`::add-mask::${TOKEN}`]);
  } finally {
    await api.close();
  }
});

test("the required checks are exactly the two the workflow's header names, and pr-text is the informational one", () => {
  assert.deepEqual(VERDICTS.map((v) => v.name), ["pcc-trusted/secret-scan", "pcc-trusted/trust-root-guard"]);
  for (const verdict of [...VERDICTS, PR_TEXT]) assert.ok(WORKFLOW.includes(verdict.name), verdict.name);
  assert.equal(PR_TEXT.name, "pcc-trusted/pr-text");
});

test("only an exact success passes; failure, cancelled and skipped all fail the required check", async () => {
  assert.equal(conclusionFor("success"), "success");
  assert.equal(textConclusionFor("success"), "neutral", "the text check never reads as a pass");
  for (const result of ["failure", "cancelled", "skipped"]) assert.equal(textConclusionFor(result), "failure", result);
  for (const result of ["failure", "cancelled", "skipped", "", undefined, "SUCCESS"]) {
    assert.equal(conclusionFor(result), "failure", String(result));
  }
  const api = await fakeGitHub();
  try {
    const r = await run(env(api, { SCAN_RESULT: "failure", GUARD_RESULT: "skipped", TEXT_RESULT: "failure" }));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(checkRuns(api).map((c) => [c.body.name, c.body.conclusion]), [
      ["pcc-trusted/secret-scan", "failure"],
      ["pcc-trusted/trust-root-guard", "failure"],
      ["pcc-trusted/pr-text", "failure"],
    ]);
  } finally {
    await api.close();
  }
});

test("nothing is posted when the pull request has a new head commit since this run read it (the newer run posts)", async () => {
  const api = await fakeGitHub({ "GET /repos/o/r/pulls/7": () => [200, { head: { sha: "b".repeat(40) }, title: TITLE, body: BODY }] });
  try {
    const r = await run(env(api));
    assert.equal(r.status, 1, r.stderr);
    assert.deepEqual(checkRuns(api), []);
    assert.equal(api.requests.at(-1).path, "/installation/token", "the token is still revoked");
  } finally {
    await api.close();
  }
});

for (const [label, pr] of [
  ["a new title", { head: { sha: HEAD }, title: "Add the widget (now with a key)", body: BODY }],
  ["a new description", { head: { sha: HEAD }, title: TITLE, body: `${BODY}\nedited` }],
]) {
  test(`with ${label} on the same head, the required checks still post (they cover the commit only) but pr-text does not`, async () => {
    const api = await fakeGitHub({ "GET /repos/o/r/pulls/7": () => [200, pr] });
    try {
      const r = await run(env(api));
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(checkRuns(api).map((c) => c.body.name), ["pcc-trusted/secret-scan", "pcc-trusted/trust-root-guard"]);
      assert.equal(api.requests.at(-1).path, "/installation/token");
    } finally {
      await api.close();
    }
  });
}

test("a description the API reports as null matches the empty one the event rendered", async () => {
  const api = await fakeGitHub({ "GET /repos/o/r/pulls/7": () => [200, { head: { sha: HEAD }, title: TITLE, body: null }] });
  try {
    const r = await run(env(api, { PR_BODY: "" }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(checkRuns(api).length, 3, "pr-text is posted: the text is unchanged");
  } finally {
    await api.close();
  }
});

for (const [label, overrides] of [
  ["no App id", { TRUSTED_CHECKS_APP_ID: "" }],
  ["a non-numeric App id", { TRUSTED_CHECKS_APP_ID: "12a" }],
  ["no private key (the environment's secrets are missing)", { TRUSTED_CHECKS_PRIVATE_KEY: "" }],
  ["a private key that is not PEM", { TRUSTED_CHECKS_PRIVATE_KEY: "not a key" }],
  ["a PEM that cannot sign", { TRUSTED_CHECKS_PRIVATE_KEY: `${PEM_BEGIN}\nAAAA\n${PEM_END}\n` }],
  ["an uppercase head sha", { HEAD_SHA: "A".repeat(40) }],
  ["a short head sha", { HEAD_SHA: "a".repeat(39) }],
  ["a pull request number of 0", { PR_NUMBER: "0" }],
  ["a pull request number with a path in it", { PR_NUMBER: "7/../../x" }],
  ["an unknown job result", { SCAN_RESULT: "succeeded" }],
  ["a missing job result", { GUARD_RESULT: "" }],
  ["a missing text result", { TEXT_RESULT: "" }],
  ["a repository that is not owner/name", { GITHUB_REPOSITORY: "o/r/../x" }],
]) {
  test(`given ${label}, it exits 2 and calls no API`, async () => {
    const api = await fakeGitHub();
    try {
      const r = await run(env(api, overrides));
      assert.equal(r.status, 2, r.stderr);
      assert.deepEqual(api.requests, []);
    } finally {
      await api.close();
    }
  });
}

test("an API failure exits 3, and a token already minted is still revoked", async () => {
  const api = await fakeGitHub({ "POST /repos/o/r/check-runs": () => [500, { message: "boom" }] });
  try {
    const r = await run(env(api));
    assert.equal(r.status, 3);
    assert.match(r.stderr, /GitHub answered 500 to POST \/repos\/\{repo\}\/check-runs: boom/);
    assert.equal(api.requests.at(-1).path, "/installation/token");
  } finally {
    await api.close();
  }
});

test("an App not installed on the repository exits 3 without minting or revoking anything", async () => {
  const api = await fakeGitHub({ "GET /repos/o/r/installation": () => [404, { message: "Not Found" }] });
  try {
    const r = await run(env(api));
    assert.equal(r.status, 3);
    assert.deepEqual(api.requests.map((q) => q.path), ["/repos/o/r/installation"]);
  } finally {
    await api.close();
  }
});

test("a token answer that is not a plain token is refused and never echoed", async () => {
  const forged = "ghs_aaaaaaaaaaaaaaaaaaaaaaaa\n::error::injected";
  const api = await fakeGitHub({ "POST /app/installations/42/access_tokens": () => [201, { token: forged }] });
  try {
    const r = await run(env(api));
    assert.equal(r.status, 3);
    assert.ok(!(r.stdout + r.stderr).includes("injected"), r.stdout + r.stderr);
    assert.deepEqual(checkRuns(api), []);
  } finally {
    await api.close();
  }
});

test("nothing from the pull request, and never the private key, reaches the log; no line starts a workflow command but the mask", async () => {
  const title = `::error::injected title ${AWS_LIKE}`;
  const body = `::warning::injected body\n${PEM_BEGIN}`;
  const api = await fakeGitHub({ "GET /repos/o/r/pulls/7": () => [200, { head: { sha: HEAD }, title, body }] });
  try {
    const r = await run(env(api, { PR_TITLE: title, PR_BODY: body }));
    assert.equal(r.status, 0, r.stderr);
    const log = r.stdout + r.stderr;
    assert.ok(!log.includes("injected"), log);
    assert.ok(!log.includes(AWS_LIKE), log);
    assert.ok(!log.includes("PRIVATE KEY"), log);
    for (const line of log.split("\n")) {
      if (line.startsWith("::")) assert.equal(line, `::add-mask::${TOKEN}`);
    }
  } finally {
    await api.close();
  }
});

test("an error message from GitHub cannot start a workflow command line", async () => {
  const api = await fakeGitHub({ "GET /repos/o/r/pulls/7": () => [500, { message: "oops\n::error::injected" }] });
  try {
    const r = await run(env(api));
    assert.equal(r.status, 3);
    for (const line of (r.stdout + r.stderr).split("\n")) {
      if (line.startsWith("::")) assert.equal(line, `::add-mask::${TOKEN}`);
    }
  } finally {
    await api.close();
  }
});
