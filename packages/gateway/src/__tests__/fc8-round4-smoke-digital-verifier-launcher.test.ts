/**
 * FC-8 round 4 (astra pack 61c), finding 4 — the FIXED credential-file
 * launch path. See scripts/smoke-digital-verifier.sh's own header comment
 * for the full threat model.
 *
 * FC-8 round 5: this file used to also carry two "[repro, documented
 * residual]" tests that DEMONSTRATED a PS4-file-read leak and a lingering
 * PCC_ORACLE_KEY leak against DIRECT invocation of the .sh file — accepted
 * at round 4 as a residual this script cannot close for itself. Round 5
 * closes it instead, with a process boundary the script cannot provide on
 * its own: scripts/smoke-digital-verifier.mjs, the canonical launcher,
 * which builds the child's environment from an explicit allowlist rather
 * than inheriting PS4/SHELLOPTS/BASH_ENV/PCC_ORACLE_KEY. Direct invocation
 * is now UNSUPPORTED (see the .sh file's header), so those two tests —
 * which existed to document an ACCEPTED gap in the then-supported path —
 * are removed rather than kept as permanently-failing residual proof; the
 * SAME two scenarios, run against the canonical launcher instead of direct
 * invocation, are fc8-round5-smoke-digital-verifier-launcher.test.ts's
 * reproduction (which fails at 4dbafd7f because the launcher does not
 * exist, and passes once it does).
 *
 * The one test below stays as regression coverage for the OLD,
 * env-var-based attack (astra's exact original recipe) against the
 * OLD, now-unsupported direct-invocation path — still worth knowing it
 * doesn't regress, even though that path is no longer the recommended one.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SHIM_DIR = fileURLToPath(new URL("./support/fc8-round4-bash-shim", import.meta.url));

function withKeyFile(content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fc8-r4-keyfile-"));
  const path = join(dir, "oracle.key");
  writeFileSync(path, content);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("FC-8 round 4 — smoke-digital-verifier.sh — fixed credential-file launch path (finding 4)", () => {
  it("[neg] astra's exact recipe no longer leaks: PCC_ORACLE_KEY is never set under the new convention", () => {
    const CANARY = "FC8_CANARY_PS4_FIXED_5f1e";
    const { path: keyFile, cleanup } = withKeyFile(CANARY);
    try {
      const env = { ...process.env, PATH: `${SHIM_DIR}:${process.env.PATH}`, FC8_CANARY: "unused-in-this-test" };
      delete env.PCC_ORACLE_KEY; // the old convention is gone; never set it
      env.PCC_ORACLE_KEY_FILE = keyFile;
      env.PS4 = "$PCC_ORACLE_KEY "; // astra's exact payload, now referencing a variable that does not exist

      const result = spawnSync("bash", ["-x", "scripts/smoke-digital-verifier.sh"], {
        cwd: REPO_ROOT, env, encoding: "utf8", timeout: 10_000,
      });
      expect(result.stderr ?? "").not.toContain(CANARY);
      expect(result.stdout ?? "").not.toContain(CANARY);
    } finally {
      cleanup();
    }
  }, 15_000);
});
