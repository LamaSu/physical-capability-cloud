/**
 * FC-8 round 4 (astra pack 61c), finding 4 — the FIXED credential-file
 * launch path. See scripts/smoke-digital-verifier.sh's own header comment
 * for the full threat model; this test proves both halves of the narrowed
 * claim dynamically:
 *   1. Astra's exact reproduction (PS4='$PCC_ORACLE_KEY ', a bare variable
 *      reference, no command substitution) no longer leaks anything, since
 *      PCC_ORACLE_KEY is never set at all under the new convention — only
 *      PCC_ORACLE_KEY_FILE (a path) is.
 *   2. The documented residual still holds: a PS4 that already knows the
 *      exact file path and actively reads it
 *      (`$(cat "$PCC_ORACLE_KEY_FILE")`) can still leak the key on the one
 *      irreducible trace event (the `set +x` line itself) — this is
 *      expected to "fail" in the sense of reproducing the residual, not a
 *      bug in the fix; see the round-4 report for why this is accepted and
 *      not expanded in scope.
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

  it("[repro, documented residual] a PS4 that already knows the file path can still read it on the one irreducible trace event", () => {
    const CANARY = "FC8_CANARY_PS4_RESIDUAL_5f1e";
    const { path: keyFile, cleanup } = withKeyFile(CANARY);
    try {
      const env = { ...process.env, PATH: `${SHIM_DIR}:${process.env.PATH}`, FC8_CANARY: "unused-in-this-test" };
      delete env.PCC_ORACLE_KEY;
      env.PCC_ORACLE_KEY_FILE = keyFile;
      // A targeted PS4 that knows the exact path — the residual this fix
      // does not and cannot close from inside the script. See the
      // threat-model comment in smoke-digital-verifier.sh.
      env.PS4 = `$(cat "${keyFile}" 2>/dev/null) `;

      const result = spawnSync("bash", ["-x", "scripts/smoke-digital-verifier.sh"], {
        cwd: REPO_ROOT, env, encoding: "utf8", timeout: 10_000,
      });
      // This DEMONSTRATES the residual leak — a passing assertion here
      // confirms the documented threat model is accurate, not overclaimed.
      expect(result.stderr ?? "").toContain(CANARY);
    } finally {
      cleanup();
    }
  }, 15_000);

  it("[repro, documented residual] PCC_ORACLE_KEY lingering in the environment from something OTHER than this script still leaks under astra's exact recipe", () => {
    // Found while mutation testing this round: the first draft of the
    // comment above claimed astra's bare-variable recipe "now expands to
    // nothing, because that variable no longer exists here" — true of this
    // script's OWN code, but not something this script can guarantee about
    // its environment. If a sibling script, CI job, or pre-fix shell
    // profile still exports PCC_ORACLE_KEY for unrelated reasons, this
    // script's own refusal to read it does not stop bash's PS4 expansion,
    // which operates on whatever is in the environment regardless of
    // whether this script's source ever references it.
    const CANARY = "FC8_LEGACY_INHERITED_CANARY_5f1e";
    const { path: keyFile, cleanup } = withKeyFile("not-the-canary-this-is-the-file-based-key");
    try {
      const env = { ...process.env, PATH: `${SHIM_DIR}:${process.env.PATH}`, FC8_CANARY: "unused-in-this-test" };
      env.PCC_ORACLE_KEY_FILE = keyFile;
      env.PCC_ORACLE_KEY = CANARY; // lingering export this script never reads, but the CALLER still set
      env.PS4 = "$PCC_ORACLE_KEY "; // astra's exact payload — now resolves via the inherited export, not this script
      const result = spawnSync("bash", ["-x", "scripts/smoke-digital-verifier.sh"], {
        cwd: REPO_ROOT, env, encoding: "utf8", timeout: 10_000,
      });
      // This DEMONSTRATES the residual leak, same as the file-path-aware
      // PS4 test above — a passing assertion here confirms the threat-model
      // comment's "IF PCC_ORACLE_KEY is not present in the environment"
      // qualifier is accurate, not overclaimed.
      expect(result.stderr ?? "").toContain(CANARY);
    } finally {
      cleanup();
    }
  }, 15_000);
});
