#!/usr/bin/env node
/**
 * scripts/smoke-digital-verifier.mjs — the SUPPORTED entry point for
 * scripts/smoke-digital-verifier.sh (FC-8 round 5, astra pack 61d, finding
 * 4's reopened residual).
 *
 * Bash expands an inherited PS4 to build the trace line for a script's
 * very first statement BEFORE that script has executed anything at all —
 * so no command the .sh file runs, however early, can retroactively clear
 * a hostile PS4/xtrace state the CALLER already had active (see the
 * threat-model comment at the top of smoke-digital-verifier.sh). The only
 * way to close that is a process boundary built from OUTSIDE bash, by
 * something that controls the child's environment before bash ever
 * starts. This file is that boundary: a plain Node process that execs
 * `bash --noprofile --norc scripts/smoke-digital-verifier.sh` with an
 * environment it constructs ITSELF — an EXPLICIT allowlist of the
 * variables the script documents as inputs, plus PATH and HOME. Nothing
 * else from this process's own environment is forwarded: never PS4,
 * SHELLOPTS, BASHOPTS, BASH_ENV, ENV, BASH_XTRACEFD, or PCC_ORACLE_KEY
 * (the key itself — only PCC_ORACLE_KEY_FILE, a path, ever crosses this
 * boundary). `--noprofile --norc` additionally stops the child from
 * sourcing a profile/rc file that could reintroduce any of these.
 *
 * The script's own `set +x` (its absolute first statement) and its
 * PCC_ORACLE_KEY_FILE convention stay as defense in depth — this launcher
 * is the supported boundary, not a replacement for either.
 *
 * Direct invocation of the .sh file is UNSUPPORTED (see its own header).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, "smoke-digital-verifier.sh");

/**
 * The variables this launcher forwards to the script's process, beyond
 * PATH/HOME — exactly what the script's own header/body document as
 * inputs: PCC_ORACLE_KEY_FILE (required) and ORACLE_DIRECT (optional, has
 * an in-script default). Nothing else the calling process's environment
 * might hold is ever forwarded.
 */
export const DOCUMENTED_INPUT_VARS = ["PCC_ORACLE_KEY_FILE", "ORACLE_DIRECT"];

/**
 * Documented here as the explicit negative list the launcher test fixture
 * asserts against — not consulted by buildChildEnv itself, which only
 * ever COPIES FROM the allowlist above (an allowlist needs no matching
 * denylist to be sound; this exists so the test can name its intent).
 */
export const NEVER_FORWARDED_VARS = [
  "PS4", "SHELLOPTS", "BASHOPTS", "BASH_ENV", "ENV", "BASH_XTRACEFD", "PCC_ORACLE_KEY",
];

/** Builds the child process environment from scratch — NEVER `{ ...sourceEnv }`. Only PATH, HOME, and the documented input vars are copied over. */
export function buildChildEnv(sourceEnv = process.env) {
  const env = Object.create(null);
  if (sourceEnv.PATH) env.PATH = sourceEnv.PATH;
  if (sourceEnv.HOME) env.HOME = sourceEnv.HOME;
  for (const name of DOCUMENTED_INPUT_VARS) {
    if (sourceEnv[name] !== undefined) env[name] = sourceEnv[name];
  }
  return env;
}

/** Runs the smoke-test script through the process boundary described above. Returns the same shape as node:child_process's spawnSync. */
export function runSmokeTest(sourceEnv = process.env) {
  const env = buildChildEnv(sourceEnv);
  return spawnSync("bash", ["--noprofile", "--norc", SCRIPT_PATH], {
    env,
    encoding: "utf8",
    cwd: dirname(__dirname),
  });
}

// CLI behavior lives only behind this guard, same convention as the .ts
// e2e scripts — a plain `import` of this module (as a test does) never
// execs the script.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runSmokeTest();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    console.error(`FATAL: ${result.error.name === "Error" || result.error.name === "TypeError" ? result.error.name : "Error"}`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
