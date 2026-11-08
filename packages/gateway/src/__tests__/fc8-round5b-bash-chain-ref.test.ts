/**
 * FC-8 round 5b (steward ruling #6712, DECISIONS 00:53) — dynamic,
 * behavioral tests for smoke-digital-verifier.sh's new public_chain_ref()
 * function. fc8-round5-smoke-digital-verifier-bash-static.test.ts proves
 * every echo/printf/report $-expansion is validated (a STATIC, line-based
 * scan); it does not — and by design excludes — exercising a validator
 * function's own internal LOGIC. This file extracts public_chain_ref's
 * actual function body out of the real script file (never a hand-copied
 * re-implementation) and runs it in an isolated `bash -c` subshell, the
 * same "extract and eval in isolation" technique needed to unit-test a
 * bash function without executing the rest of the script (which requires
 * PCC_ORACLE_KEY_FILE, network access, gh/git, etc).
 *
 * This script has no live call site for public_chain_ref today (see its
 * own doc comment) — the function exists for parity with redact-log.ts's
 * publicChainRef. These tests are what makes that function's own shape
 * check meaningfully regression-tested (mutant (a)'s bash analogue,
 * mutant (d) in the round-5b brief) despite there being no production
 * call site a canary could flow through.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT_PATH = fileURLToPath(new URL("../../../../scripts/smoke-digital-verifier.sh", import.meta.url));

/** [startLine, endLine) (0-indexed, end exclusive) of `name`'s function body, by brace-depth tracking from its `name() {` line. Same technique as the static test's validatorFunctionRanges. */
function functionRange(lines: string[], name: string): [number, number] {
  const startRe = new RegExp(`^${name}\\s*\\(\\)\\s*\\{`);
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) {
      let depth = 0;
      let j = i;
      for (; j < lines.length; j++) {
        depth += (lines[j].match(/\{/g) || []).length;
        depth -= (lines[j].match(/\}/g) || []).length;
        if (j > i && depth <= 0) break;
      }
      return [i, j + 1];
    }
  }
  throw new Error(`function ${name} not found in ${SCRIPT_PATH}`);
}

/** The exact source text of function `name`, extracted from the real script file. */
function extractFunction(name: string): string {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  const lines = source.split("\n");
  const [start, end] = functionRange(lines, name);
  return lines.slice(start, end).join("\n");
}

/** Runs `fnName(...args)` inside a fresh `bash -c` subshell whose ONLY code is the extracted function body — never the whole script (no network, no PCC_ORACLE_KEY_FILE, no git/gh required). */
function runBashFunction(fnName: string, fnSource: string, args: string[]): { stdout: string; status: number } {
  const result = spawnSync("bash", ["-c", `${fnSource}\n${fnName} "$@"`, "bash", ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  return { stdout: (result.stdout ?? "").replace(/\n$/, ""), status: result.status ?? -1 };
}

describe("FC-8 round 5b (steward ruling #6712) — smoke-digital-verifier.sh's public_chain_ref(), extracted and run in isolation", () => {
  const fnSource = extractFunction("public_chain_ref");

  it("sanity: the function was actually extracted (a real, non-empty body)", () => {
    expect(fnSource).toContain("public_chain_ref");
    expect(fnSource.split("\n").length).toBeGreaterThan(3);
  });

  it("prints a shape-valid tx hash VERBATIM", () => {
    const tx = "0x" + "b".repeat(64);
    const { stdout, status } = runBashFunction("public_chain_ref", fnSource, [tx, "tx"]);
    expect(status).toBe(0);
    expect(stdout).toBe(tx);
  });

  it("prints a shape-valid event topic VERBATIM", () => {
    const topic = "0x" + "c".repeat(64);
    const { stdout, status } = runBashFunction("public_chain_ref", fnSource, [topic, "topic"]);
    expect(status).toBe(0);
    expect(stdout).toBe(topic);
  });

  it("prints a shape-valid address VERBATIM", () => {
    const addr = "0x" + "a".repeat(40);
    const { stdout, status } = runBashFunction("public_chain_ref", fnSource, [addr, "address"]);
    expect(status).toBe(0);
    expect(stdout).toBe(addr);
  });

  it('[neg] wrong shape for the claimed kind prints "(invalid)", never the value', () => {
    const tx64 = "0x" + "b".repeat(64);
    const addr40 = "0x" + "a".repeat(40);
    expect(runBashFunction("public_chain_ref", fnSource, [tx64, "address"]).stdout).toBe("(invalid)");
    expect(runBashFunction("public_chain_ref", fnSource, [addr40, "tx"]).stdout).toBe("(invalid)");
    expect(runBashFunction("public_chain_ref", fnSource, [addr40, "topic"]).stdout).toBe("(invalid)");
    expect(runBashFunction("public_chain_ref", fnSource, ["not-hex-at-all", "tx"]).stdout).toBe("(invalid)");
  });

  it('[neg] missing/empty value prints "(invalid)"', () => {
    expect(runBashFunction("public_chain_ref", fnSource, ["", "tx"]).stdout).toBe("(invalid)");
  });

  it('[neg] an unrecognized kind prints "(invalid)", even for an otherwise shape-valid value', () => {
    const tx64 = "0x" + "b".repeat(64);
    expect(runBashFunction("public_chain_ref", fnSource, [tx64, "commit_sha"]).stdout).toBe("(invalid)");
    expect(runBashFunction("public_chain_ref", fnSource, [tx64, ""]).stdout).toBe("(invalid)");
  });

  it('[neg] a full git commit SHA (40 hex, no "0x" prefix) is ALWAYS "(invalid)" here — proving a git/GitHub identifier cannot be (mis)routed through public_chain_ref and have it "work"; it must stay on public_id_for_log', () => {
    const gitSha = "c".repeat(40); // exactly what COMMIT_SHA/LOCAL_SHA/REMOTE_SHA look like — 40 hex, no 0x
    expect(runBashFunction("public_chain_ref", fnSource, [gitSha, "address"]).stdout).toBe("(invalid)");
    expect(runBashFunction("public_chain_ref", fnSource, [gitSha, "tx"]).stdout).toBe("(invalid)");
  });

  it("never exits non-zero (never throws, in bash terms) for any input shape", () => {
    for (const [v, kind] of [
      ["", "tx"], ["not-hex", "address"], ["0x" + "a".repeat(64), "address"],
      ["0x" + "a".repeat(40), "tx"], ["0x" + "a".repeat(40), "topic"],
    ] as const) {
      expect(runBashFunction("public_chain_ref", fnSource, [v, kind]).status).toBe(0);
    }
  });
});

describe("FC-8 round 5b (steward ruling #6712) — a git SHA stays on public_id_for_log, never public_chain_ref (source-text pin)", () => {
  // Mutant (c) in the round-5b brief: "a git SHA routed through
  // publicChainRef/public_chain_ref". Unlike (a)/(d) (a shape-check
  // bypass inside the function itself, caught by the behavioral tests
  // above), this mutant targets a CALL SITE — swapping which function a
  // git-SHA variable is piped through. public_chain_ref would always
  // print "(invalid)" for a 40-hex, no-"0x" git SHA (proven above), so the
  // dynamic end-to-end script tests wouldn't notice a message-text-only
  // change; this pin is the direct, honest guard for that call-site swap.
  const source = () => readFileSync(SCRIPT_PATH, "utf8");

  it("every git-SHA call site uses public_id_for_log with kind commit_sha", () => {
    expect(source()).toMatch(/LOCAL_SHA_LOG=\$\(public_id_for_log "\$LOCAL_SHA" commit_sha\)/);
    expect(source()).toMatch(/REMOTE_SHA_LOG=\$\(public_id_for_log "\$REMOTE_SHA" commit_sha\)/);
    expect(source().match(/public_id_for_log "\$COMMIT_SHA" commit_sha/g)?.length).toBe(2);
  });

  it('[neg] no git-SHA variable (LOCAL_SHA, REMOTE_SHA, COMMIT_SHA) is ever piped through public_chain_ref', () => {
    expect(source()).not.toMatch(/public_chain_ref\s+"\$(LOCAL_SHA|REMOTE_SHA|COMMIT_SHA)"/);
  });
});
