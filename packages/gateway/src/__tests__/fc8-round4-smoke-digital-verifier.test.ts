/**
 * FC-8 round 4 (astra pack 61c) — the steward's generic test (bus #6482) for
 * scripts/smoke-digital-verifier.sh.
 *
 * Finding 2: round 3's shim put canaries in IGNORED fields (a `note`/`diag`
 * sibling) while the fields the script actually reads, compares, prints,
 * and persists (health/oracle status, result.verified, valid) got a clean
 * "ok"/"true". support/fc8-round4-bash-shim/curl puts the canary in those
 * exact fields instead. Parameterized over an ID-shaped canary and a
 * space-containing canary; asserts the raw value AND its URI/base64/hex
 * encodings are absent from stdout, stderr, and the written report file.
 *
 * Finding 4: Bash expands an inherited PS4 before `set +x` takes effect, so
 * `PS4='$PCC_ORACLE_KEY '` (astra's own reproduction — not even a command
 * substitution, a bare variable reference) leaks the key on the trace of
 * `set -euo pipefail` and of `set +x` itself, regardless of where `set +x`
 * sits in the script. This is tested against the OLD launch path (the
 * current PCC_ORACLE_KEY env var) as asked; see
 * fc8-round4-smoke-digital-verifier-launcher.test.ts for the fixed path.
 *
 * At 68b9f098 the finding-2 tests FAIL and the finding-4 repro test PASSES
 * (i.e. correctly demonstrates the leak). See
 * returns/pcc-gateway-work/61d-fc8-repro-68b9f098.log.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ID_CANARY = "PCCOracleKey5f1e";
const SPACE_CANARY = "SENTINEL ORACLE KEY 5f1e";
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SHIM_DIR = fileURLToPath(new URL("./support/fc8-round4-bash-shim", import.meta.url));
const REPORT_FILE = join(REPO_ROOT, "ai/supervisor/smoke-test-report.json");

// FC-8 round 4: the script reads the oracle key from a FILE
// (PCC_ORACLE_KEY_FILE), never the PCC_ORACLE_KEY env var (finding 4's
// fix). A neutral, non-canary key file — this test's own concern (finding
// 2's field census) is orthogonal to which credential-launch mechanism is
// in play. Mutation testing this round caught this test file passing the
// OLD env var here: the script exited at the "PCC_ORACLE_KEY_FILE is not
// set" guard before Checks 3/5/6 (the mutated/fixed code) ever ran, so
// the finding-2 assertions below were vacuously green regardless of the
// source. The `toContain("Setup status:")` sanity check at the end of
// each test exists specifically to make that failure mode loud.
function makeOracleKeyFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "fc8-r4-keyfile-"));
  const path = join(dir, "oracle.key");
  writeFileSync(path, "test-oracle-key-not-a-secret");
  return path;
}

function allEncodings(canary: string): string[] {
  return [
    canary,
    encodeURIComponent(canary),
    Buffer.from(canary, "utf8").toString("base64"),
    Buffer.from(canary, "utf8").toString("hex"),
  ];
}

describe.each([
  ["ID-shaped canary", ID_CANARY],
  ["space-containing canary", SPACE_CANARY],
])("FC-8 round 4 — smoke-digital-verifier.sh — %s in every read field (finding 2)", (_label, canary) => {
  it("[neg] no encoding of the canary reaches stdout, stderr, or the report file", () => {
    try { rmSync(REPORT_FILE); } catch {}
    const env = {
      ...process.env,
      PATH: `${SHIM_DIR}:${process.env.PATH}`,
      FC8_CANARY: canary,
      PCC_ORACLE_KEY_FILE: makeOracleKeyFile(),
    };
    delete (env as Record<string, string | undefined>).PCC_ORACLE_KEY;
    const result = spawnSync("bash", ["scripts/smoke-digital-verifier.sh"], {
      cwd: REPO_ROOT, env, encoding: "utf8", timeout: 30_000,
    });
    const reportFile = (() => { try { return readFileSync(REPORT_FILE, "utf8"); } catch { return ""; } })();
    const all = [result.stdout ?? "", result.stderr ?? "", reportFile].join("\n").toLowerCase();

    for (const encoded of allEncodings(canary)) {
      expect(all, `encoding "${encoded}" of canary leaked`).not.toContain(encoded.toLowerCase());
    }
    // sanity: the run actually reached Checks 3/5/6 (the sites under test),
    // not a no-op that exited early at the credential-file guard.
    expect(result.stdout ?? "", "script exited before reaching the sites under test").toContain(
      "Setup status:",
    );
  }, 40_000);
});

describe("FC-8 round 4 — smoke-digital-verifier.sh — PS4 expands before set +x (finding 4, old launch path)", () => {
  it("[repro] astra's exact recipe: PS4='$PCC_ORACLE_KEY ' leaks the key via the trace of set -euo pipefail / set +x", () => {
    const CANARY = "FC8_CANARY_PS4_5f1e";
    const env = {
      ...process.env,
      PATH: `${SHIM_DIR}:${process.env.PATH}`,
      FC8_CANARY: "unused-for-this-test",
      PCC_ORACLE_KEY: CANARY,
      PS4: "$PCC_ORACLE_KEY ",
    };
    const result = spawnSync("bash", ["-x", "scripts/smoke-digital-verifier.sh"], {
      cwd: REPO_ROOT, env, encoding: "utf8", timeout: 10_000,
    });
    // This assertion documents the OLD, vulnerable launch path — it is
    // expected to find the leak at 68b9f098. The fixed (credential-file)
    // launch path is tested separately, since this exact env-var-based
    // invocation is what's being retired.
    expect(result.stderr ?? "").toContain(CANARY);
  }, 15_000);
});
