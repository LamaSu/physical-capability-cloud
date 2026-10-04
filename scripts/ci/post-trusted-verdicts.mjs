#!/usr/bin/env node
// Board row N44, rounds 6 and 7: the secret scan's verdicts, as check runs a pull request cannot forge.
//
// The scan and the trust-root guard run on pull_request_target, from the base
// branch's definition. But GitHub attaches those jobs' results to the BASE
// commit, and any workflow a pull request adds can run jobs with the same names
// on the pull request's own commit (astra r5, F1). So the required checks are not
// those jobs. They are the check runs this script posts on the pull request's
// HEAD commit, authenticated as a dedicated GitHub App, and branch protection
// requires them from that App. A pull request's workflows cannot mint that App's
// token: its key is a secret of the trusted-checks environment, which only master
// can deploy to (see the header of .github/workflows/secret-scan.yml).
//
// The required checks guarantee the head commit's CONTENT only, which no edit can
// change (round 7). A title or description can be edited after any check, so the
// text scan is reported as the INFORMATIONAL pcc-trusted/pr-text: neutral when it
// found nothing, failure when it did, and never a merge guarantee.
//
// Usage, in the post-verdicts job only; every input comes from the environment:
//   node scripts/ci/post-trusted-verdicts.mjs
// The required checks are posted only while the pull request's head is still the
// commit this run scanned; pcc-trusted/pr-text only while its title and
// description are also unchanged. Otherwise a newer run is coming, and posts.
// Exit codes: 0 the required checks posted; 1 a new head commit since this run
// read it, nothing posted; 2 a missing or malformed input; 3 a GitHub API failure.
// Nothing from the pull request (title, description, file names) is ever printed,
// and neither is the App's key or token, except to mask the token.

import { createPrivateKey, sign } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The required checks, each from the result of the job that produced it. Both cover the head commit only. */
export const VERDICTS = Object.freeze([
  Object.freeze({ name: "pcc-trusted/secret-scan", job: "trusted-secret-scan", input: "SCAN_RESULT" }),
  Object.freeze({ name: "pcc-trusted/trust-root-guard", job: "trust-root-guard", input: "GUARD_RESULT" }),
]);

/** The informational check on the title and description. It must never be required (see the header). */
export const PR_TEXT = Object.freeze({ name: "pcc-trusted/pr-text", job: "pr-text-scan", input: "TEXT_RESULT" });

const JOB_RESULTS = Object.freeze(["success", "failure", "cancelled", "skipped"]);
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/;
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;
const API_URL = /^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/;

export class UsageError extends Error {}

export class ApiError extends Error {
  constructor(method, route, status, detail) {
    super(`GitHub answered ${status} to ${method} ${route}${detail ? `: ${detail}` : ""}`);
    this.status = status;
  }
}

/** Text safe for one log line: no control characters, so no line can start a workflow command. */
export function printable(text, limit = 200) {
  return String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").slice(0, limit);
}

/** The inputs, checked. Throws UsageError naming the first bad one (never its value). */
export function readInputs(env) {
  const required = (name, pattern) => {
    const value = env[name];
    if (typeof value !== "string" || !pattern.test(value)) throw new UsageError(`${name} is missing or malformed`);
    return value;
  };
  const appId = required("TRUSTED_CHECKS_APP_ID", DECIMAL_ID);
  const privateKey = env.TRUSTED_CHECKS_PRIVATE_KEY;
  if (typeof privateKey !== "string" || !privateKey.includes("PRIVATE KEY")) {
    throw new UsageError("TRUSTED_CHECKS_PRIVATE_KEY is missing or not a PEM private key");
  }
  const results = {};
  for (const verdict of [...VERDICTS, PR_TEXT]) {
    const value = env[verdict.input];
    if (!JOB_RESULTS.includes(value)) throw new UsageError(`${verdict.input} is missing or malformed`);
    results[verdict.input] = value;
  }
  const apiUrl = required("GITHUB_API_URL", API_URL).replace(/\/+$/, "");
  const runId = env.GITHUB_RUN_ID && DECIMAL_ID.test(env.GITHUB_RUN_ID) ? env.GITHUB_RUN_ID : null;
  const runAttempt = env.GITHUB_RUN_ATTEMPT && DECIMAL_ID.test(env.GITHUB_RUN_ATTEMPT) ? env.GITHUB_RUN_ATTEMPT : "1";
  const serverUrl = env.GITHUB_SERVER_URL && API_URL.test(env.GITHUB_SERVER_URL) ? env.GITHUB_SERVER_URL.replace(/\/+$/, "") : null;
  return {
    appId,
    privateKey,
    repository: required("GITHUB_REPOSITORY", REPOSITORY),
    apiUrl,
    prNumber: Number(required("PR_NUMBER", DECIMAL_ID)),
    headSha: required("HEAD_SHA", COMMIT_ID),
    // Actions renders a missing description as "": the API's null is read the same way below.
    title: typeof env.PR_TITLE === "string" ? env.PR_TITLE : "",
    body: typeof env.PR_BODY === "string" ? env.PR_BODY : "",
    results,
    runId,
    runAttempt,
    serverUrl,
  };
}

function base64url(data) {
  return Buffer.from(data).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** A GitHub App JWT (RS256), valid from a minute ago for nine minutes; GitHub allows at most ten. */
export function appJwt(appId, privateKeyPem, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), createPrivateKey(privateKeyPem));
  return `${header}.${payload}.${base64url(signature)}`;
}

/** Only an exact "success" passes; failure, cancelled and skipped all fail the required check. */
export function conclusionFor(result) {
  return result === "success" ? "success" : "failure";
}

/** The text check never reads as a pass: "neutral" when the scan found nothing, else "failure". */
export function textConclusionFor(result) {
  return result === "success" ? "neutral" : "failure";
}

function client(apiUrl, fetchImpl) {
  return async function request(method, route, path, credential, body) {
    let response;
    try {
      response = await fetchImpl(`${apiUrl}${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${credential}`,
          "User-Agent": "pcc-trusted-verdicts",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new ApiError(method, route, "no answer", printable(err?.message ?? err));
    }
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) throw new ApiError(method, route, response.status, printable(json?.message ?? ""));
    return json;
  };
}

export async function main(env, { fetch: fetchImpl = globalThis.fetch, out = process.stdout, err = process.stderr, now } = {}) {
  let inputs;
  try {
    inputs = readInputs(env);
  } catch (error) {
    err.write(`post-trusted-verdicts: ${error.message}. Nothing posted.\n`);
    return 2;
  }
  const { repository, prNumber, headSha } = inputs;
  const request = client(inputs.apiUrl, fetchImpl);
  let jwt;
  try {
    jwt = appJwt(inputs.appId, inputs.privateKey, now);
  } catch {
    err.write("post-trusted-verdicts: TRUSTED_CHECKS_PRIVATE_KEY could not sign. Nothing posted.\n");
    return 2;
  }
  let token = null;
  try {
    const installation = await request("GET", "/repos/{repo}/installation", `/repos/${repository}/installation`, jwt);
    if (!installation || !DECIMAL_ID.test(String(installation.id))) throw new ApiError("GET", "/repos/{repo}/installation", "an answer", "no installation id");
    // Only this repository, and only what posting a verdict needs.
    const minted = await request("POST", "/app/installations/{id}/access_tokens", `/app/installations/${installation.id}/access_tokens`, jwt, {
      repositories: [repository.split("/")[1]],
      permissions: { checks: "write", pull_requests: "read" },
    });
    if (!minted || typeof minted.token !== "string" || !TOKEN.test(minted.token)) {
      throw new ApiError("POST", "/app/installations/{id}/access_tokens", "an answer", "no usable token");
    }
    token = minted.token;
    out.write(`::add-mask::${token}\n`);

    // Post only for what this run scanned. A newer push or edit has its own run, which posts.
    const pr = await request("GET", "/repos/{repo}/pulls/{number}", `/repos/${repository}/pulls/${prNumber}`, token);
    const current = { head: pr?.head?.sha, title: pr?.title ?? "", body: pr?.body ?? "" };
    if (current.head !== headSha) {
      out.write(`post-trusted-verdicts: pull request #${prNumber} has a new head commit since this run read it; nothing posted, the newer run posts.\n`);
      return 1;
    }
    const post = async (check, conclusion, result, summary) => {
      await request("POST", "/repos/{repo}/check-runs", `/repos/${repository}/check-runs`, token, {
        name: check.name,
        head_sha: headSha,
        status: "completed",
        conclusion,
        ...(inputs.runId ? { external_id: `${inputs.runId}/${inputs.runAttempt}` } : {}),
        ...(inputs.runId && inputs.serverUrl ? { details_url: `${inputs.serverUrl}/${repository}/actions/runs/${inputs.runId}` } : {}),
        output: {
          title: conclusion === "failure" ? `Failed (the ${check.job} job: ${result})` : conclusion === "success" ? "Passed" : "Nothing found (not a merge guarantee)",
          summary,
        },
      });
      out.write(`post-trusted-verdicts: ${check.name} = ${conclusion} on ${headSha}\n`);
    };

    for (const verdict of VERDICTS) {
      const result = inputs.results[verdict.input];
      await post(verdict, conclusionFor(result), result,
        `The base branch's ${verdict.job} job finished with "${result}" for this commit's content. ` +
          "Posted by the trusted-checks App from the base branch's secret-scan workflow.");
    }

    // The title and description: informational, and only for the text this run scanned.
    if (current.title !== inputs.title || current.body !== inputs.body) {
      out.write(`post-trusted-verdicts: ${PR_TEXT.name} not posted: the title or description changed since this run read them; the newer run posts.\n`);
    } else {
      const result = inputs.results[PR_TEXT.input];
      await post(PR_TEXT, textConclusionFor(result), result,
        `The base branch's ${PR_TEXT.job} job finished with "${result}" for this version of the title and description. ` +
          "Informational only: the text can change after this check, so it never guarantees a merge.");
    }
    return 0;
  } catch (error) {
    err.write(`post-trusted-verdicts: ${error instanceof ApiError ? error.message : printable(error?.message ?? error)}. Not every verdict was posted.\n`);
    return 3;
  } finally {
    if (token) {
      // Revoke it now rather than leave it alive for its hour.
      await request("DELETE", "/installation/token", "/installation/token", token).catch(() => {});
    }
  }
}

const invoked = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (import.meta.url === invoked) process.exitCode = await main(process.env);
