/**
 * FC-8 round 3 (astra pack 61b census closure) — dynamic proof for
 * scripts/smoke-digital-verifier.sh. Astra's "Required confirmation"
 * (verdict :83) applies here too; for a bash script that means a PATH-shim
 * `curl` (and `git`/`gh`, so Checks 1-2 resolve deterministically offline
 * instead of hitting a real network) returning canary-bearing bodies, with
 * the REAL script run end-to-end — including inherited xtrace, re-confirming
 * round 2's `set +x` fix holds for the full script, not just the prefix
 * round 2 tested.
 *
 * Source-text pins for this script already exist in
 * fc8-e2e-script-redaction.test.ts (round 2) and stay as extra guards; this
 * file adds the dynamic layer astra asked for.
 *
 * At the pre-fix baseline this test FAILS: the canary appears in stdout and
 * in the written report file. See
 * returns/pcc-gateway-work/61c-fc8-repro-r3-7701661a.log.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CANARY = "SENTINEL-ORACLE-KEY-5f1e";
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SHIM_DIR = fileURLToPath(new URL("./support/fc8-round3-bash-shim", import.meta.url));
const REPORT_FILE = join(REPO_ROOT, "ai/supervisor/smoke-test-report.json");

// FC-8 round 4: the script now reads the oracle key from a FILE
// (PCC_ORACLE_KEY_FILE), never the PCC_ORACLE_KEY env var — see
// fc8-round4-smoke-digital-verifier-launcher.test.ts for the dedicated
// PS4/credential-file coverage. This file's own concern (does the census
// of gateway/oracle FIELDS leak under inherited xtrace) is orthogonal to
// which credential-launch mechanism is in play, so a neutral, non-canary
// key file is enough here.
function makeOracleKeyFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "fc8-r3-keyfile-"));
  const path = join(dir, "oracle.key");
  writeFileSync(path, "test-oracle-key-not-a-secret");
  return path;
}

function runShimmedSmokeScript(opts: { inheritXtrace: boolean }) {
  try { rmSync(REPORT_FILE); } catch {}

  const env = {
    ...process.env,
    PATH: `${SHIM_DIR}:${process.env.PATH}`,
    FC8_CANARY: CANARY,
    PCC_ORACLE_KEY_FILE: makeOracleKeyFile(),
  };
  delete (env as Record<string, string | undefined>).PCC_ORACLE_KEY;

  // Inherited xtrace is simulated the same way a real parent shell would
  // propagate it: `set -o xtrace; export SHELLOPTS` in a wrapper, then exec
  // the real script — not `bash -x`, so this also covers the SHELLOPTS path.
  const args = opts.inheritXtrace
    ? ["-c", "set -o xtrace; export SHELLOPTS; exec bash scripts/smoke-digital-verifier.sh"]
    : ["scripts/smoke-digital-verifier.sh"];

  const result = spawnSync("bash", args, {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });

  const reportFile = (() => { try { return readFileSync(REPORT_FILE, "utf8"); } catch { return ""; } })();
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", reportFile };
}

describe("FC-8 round 3 — smoke-digital-verifier.sh — dynamic canary run (inherited xtrace)", () => {
  it("[neg] no canary in stdout, stderr, or the written report file", () => {
    const { stdout, stderr, reportFile } = runShimmedSmokeScript({ inheritXtrace: true });
    expect(stdout).not.toContain(CANARY);
    expect(stderr).not.toContain(CANARY);
    expect(reportFile).not.toContain(CANARY);
    // sanity: the run actually reached the sites under test, not a no-op
    expect(stdout).toContain("Setup status:");
  }, 40_000);

  it("[neg] not even under a plain bash -x invocation (belt and suspenders on the xtrace fix)", () => {
    try { rmSync(REPORT_FILE); } catch {}
    const env = {
      ...process.env,
      PATH: `${SHIM_DIR}:${process.env.PATH}`,
      FC8_CANARY: CANARY,
      PCC_ORACLE_KEY_FILE: makeOracleKeyFile(),
    };
    delete (env as Record<string, string | undefined>).PCC_ORACLE_KEY;
    const result = spawnSync("bash", ["-x", "scripts/smoke-digital-verifier.sh"], {
      cwd: REPO_ROOT, env, encoding: "utf8", timeout: 30_000,
    });
    expect(result.stdout ?? "").not.toContain(CANARY);
    expect(result.stderr ?? "").not.toContain(CANARY);
  }, 40_000);
});
