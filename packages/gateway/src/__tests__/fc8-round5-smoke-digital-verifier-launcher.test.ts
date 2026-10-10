/**
 * FC-8 round 5 (astra pack 61d, DO-NOT-SHIP at #326 @d8190fe3), finding
 * 4's reopened residual — the canonical launcher. The steward's round-4
 * ruling closed astra's exact bare-variable PS4 reproduction by moving the
 * secret out of the environment entirely (PCC_ORACLE_KEY_FILE, a path,
 * replaces PCC_ORACLE_KEY, a value) — but the verdict reopened the
 * underlying claim: Bash expands an inherited PS4/xtrace state to trace a
 * script's OWN FIRST STATEMENT before that script has executed anything at
 * all, so no amount of in-script hardening (where PCC_ORACLE_KEY_FILE sits
 * in the script, whether `set +x` is the first line) closes a PS4 that
 * independently reads whatever file the real secret sits in, or a
 * PCC_ORACLE_KEY some OTHER process left exported.
 *
 * At 4dbafd7f there is no launcher at all — scripts/smoke-digital-verifier.mjs
 * does not exist — so this file fails because spawning it finds nothing to
 * run (see the sanity assertion below, which fails loudly rather than
 * passing vacuously on an early, no-op exit).
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const LAUNCHER_PATH = join(REPO_ROOT, "scripts", "smoke-digital-verifier.mjs");

function withFile(content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fc8-r5-launcher-"));
  const path = join(dir, "payload");
  writeFileSync(path, content);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("FC-8 round 5 — smoke-digital-verifier.mjs — the canonical launcher (finding 4's reopened residual)", () => {
  it("[neg] a hostile PS4 (file-reading form), SHELLOPTS=xtrace, BASH_ENV, and PCC_ORACLE_KEY all set — none reach the script, none leak", () => {
    const PS4_SENTINEL = "FC8R5_PS4_FILE_SENTINEL_7d2e";
    const BASH_ENV_SENTINEL = "FC8R5_BASH_ENV_SENTINEL_3af1";
    const ORACLE_KEY_SENTINEL = "FC8R5_PCC_ORACLE_KEY_SENTINEL_c960";

    const ps4File = withFile(PS4_SENTINEL);
    const bashEnvFile = withFile(`echo "${BASH_ENV_SENTINEL}"\n`);
    const { path: realKeyFile, cleanup: cleanupKeyFile } = withFile("not-a-sentinel-real-oracle-key");

    try {
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        // The script's own documented, legitimate inputs — the launcher
        // SHOULD forward these two, and only these two.
        PCC_ORACLE_KEY_FILE: realKeyFile,
        ORACLE_DIRECT: "http://127.0.0.1:1", // deliberately unreachable; the script tolerates a dead oracle
        // Hostile: a PS4 that actively reads a file containing a sentinel —
        // this is the launcher test's own payload, distinct from astra's
        // bare-variable recipe (already covered by the round-4 file).
        PS4: `$(cat "${ps4File.path}" 2>/dev/null) `,
        SHELLOPTS: "xtrace",
        BASH_ENV: bashEnvFile.path,
        ENV: bashEnvFile.path,
        PCC_ORACLE_KEY: ORACLE_KEY_SENTINEL,
      };

      const result = spawnSync("node", [LAUNCHER_PATH], {
        cwd: REPO_ROOT,
        env,
        encoding: "utf8",
        timeout: 40_000,
      });

      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";

      for (const sentinel of [PS4_SENTINEL, BASH_ENV_SENTINEL, ORACLE_KEY_SENTINEL]) {
        expect(stdout, `${sentinel} leaked to stdout`).not.toContain(sentinel);
        expect(stderr, `${sentinel} leaked to stderr`).not.toContain(sentinel);
      }

      // Sanity: the script actually RAN (reached a real check), rather
      // than the launcher being missing/erroring before anything executed
      // — a no-op here would make every assertion above pass vacuously.
      // At 4dbafd7f there is no launcher at all, so this is where this
      // test fails: spawnSync finds nothing to run.
      expect(stdout, "script did not run to a recognizable point — launcher missing or broken").toContain("Setup status:");
    } finally {
      ps4File.cleanup();
      bashEnvFile.cleanup();
      cleanupKeyFile();
    }
  }, 45_000);

  it("never forwards PS4/SHELLOPTS/BASHOPTS/BASH_ENV/ENV/BASH_XTRACEFD/PCC_ORACLE_KEY to the child, by construction", async () => {
    const mod = await import(LAUNCHER_PATH);
    const hostileSource: Record<string, string> = {
      PATH: "/usr/bin",
      HOME: "/home/test",
      PCC_ORACLE_KEY_FILE: "/tmp/does-not-matter",
      ORACLE_DIRECT: "http://127.0.0.1:1",
      PS4: "SHOULD_NOT_FORWARD",
      SHELLOPTS: "xtrace",
      BASHOPTS: "SHOULD_NOT_FORWARD",
      BASH_ENV: "SHOULD_NOT_FORWARD",
      ENV: "SHOULD_NOT_FORWARD",
      BASH_XTRACEFD: "2",
      PCC_ORACLE_KEY: "SHOULD_NOT_FORWARD",
      SOME_UNRELATED_VAR: "SHOULD_NOT_FORWARD",
    };
    const childEnv = mod.buildChildEnv(hostileSource);
    for (const name of mod.NEVER_FORWARDED_VARS) {
      expect(childEnv, `${name} must never be forwarded`).not.toHaveProperty(name);
    }
    expect(childEnv).not.toHaveProperty("SOME_UNRELATED_VAR");
    expect(childEnv.PATH).toBe("/usr/bin");
    expect(childEnv.HOME).toBe("/home/test");
    expect(childEnv.PCC_ORACLE_KEY_FILE).toBe("/tmp/does-not-matter");
    expect(childEnv.ORACLE_DIRECT).toBe("http://127.0.0.1:1");
  });
});
