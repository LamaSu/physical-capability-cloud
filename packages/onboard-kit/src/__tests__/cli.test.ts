import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainModule, runCli } from "../cli.js";
import { scaffold } from "../scaffolder.js";

const example = fileURLToPath(new URL("../examples/cnc-shop-config.json", import.meta.url));
const packageDir = fileURLToPath(new URL("../..", import.meta.url));
const scratchDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "pcc-cli-"));
  scratchDirs.push(dir);
  return dir;
}
function configFile(value: unknown): string {
  const path = join(scratch(), "config.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}
function invalidConfig(): string {
  const config = JSON.parse(readFileSync(example, "utf8"));
  config.kernel.kernelId = "";
  return configFile(config);
}
function run(argv: string[]) {
  const logs: string[] = [], errors: string[] = [], calls: Array<[string, string]> = [];
  const code = runCli(argv, {
    log: line => { logs.push(line); calls.push(["log", line]); },
    error: line => { errors.push(line); calls.push(["error", line]); },
  });
  return { code, logs, errors, calls };
}
function textOutput(path: string, passed: boolean): void {
  const result = run(["validate", "--config", path]);
  expect(result.code).toBe(passed ? 0 : 1);
  expect(result.errors).toEqual([]);
  expect(result.logs).toHaveLength(5);
  expect(result.logs[0].split("\n")[0]).toBe(`Validation ${passed ? "PASSED" : "FAILED"}`);
  expect(result.logs.slice(1)).toEqual([
    `Input: onboard config ${path} (not a kernel runtime config; see POST /api/setup/validate)`,
    "Checked: config, adapters, capabilities",
    "Not checked: evidence bundles, signing key, wallet, adapter modules, kernel agent, machine-profile template fit",
    "This checks shape and local consistency by the rules in this copy of the kit. It registers nothing, and it does not show that a gateway will list, quote, fund or pay for anything.",
  ]);
  expect(result.calls.map(([channel]) => channel)).toEqual(["log", "log", "log", "log", "log"]);
  expect(result.logs.join("\n").split(path).join("")).not.toMatch(/\b(ready|live|verified|authentic|kernel-signed)\b/i);
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CLI frame", () => {
  it("CLI1: prints the summary and four exact scope lines for a valid config", () => {
    textOutput(example, true);
  });

  it("CLI1b: retains the five-call structure for a failed validation", () => {
    textOutput(invalidConfig(), false);
  });

  it("CLI2: bounds reads and redacts parser details", () => {
    const dir = scratch();
    const missing = join(dir, "missing.json");
    const absent = run(["validate", "--config", missing]);
    expect(absent.code).toBe(2);
    expect(absent.logs).toEqual([]);
    expect(absent.errors).toEqual([`Cannot read config ${missing}: ENOENT`]);
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "not json SECRETMARK");
    const parsed = run(["validate", "--config", broken]);
    expect(parsed.code).toBe(2);
    expect(parsed.logs).toEqual([]);
    expect(parsed.errors).toHaveLength(1);
    expect(JSON.stringify(parsed.calls)).not.toContain("SECRETMARK");
    expect(parsed.errors[0].startsWith(`Cannot read config ${broken}: not valid JSON`)).toBe(true);
    expect(parsed.errors[0].slice(`Cannot read config ${broken}: not valid JSON`.length)).toMatch(/^( \(position \d+\))?$/);
    const large = join(dir, "large.json");
    writeFileSync(large, "x".repeat(1_048_577));
    const capped = run(["validate", "--config", large]);
    expect(capped.code).toBe(2);
    expect(capped.logs).toEqual([]);
    expect(capped.errors).toEqual([`Cannot read config ${large}: larger than 1 MiB`]);
  });

  it("CLI3: parses flags in order and reports redacted usage failures", () => {
    const usage = "Usage: pcc-onboard validate --config <path> [--json]";
    const missing = join(scratch(), "missing.json");
    const cases: Array<[string[], string]> = [
      [["validate", "--config", example, "--bogus"], "Unknown flag --bogus"],
      [["validate", "--config", missing, "--signing-key", "0xabc"], "keys are read from files only"],
      [["validate", "--private-key=0xdeadbeef"], "keys are read from files only"],
      [["validate", "--seed"], "keys are read from files only"],
      [["help", "--seed=secret"], "keys are read from files only"],
      [["validate", "--config", example, "--bogus=0xdeadbeef"], "Unknown flag --bogus="],
      [["validate", `--config=${example}`], "Unknown flag --config="],
      [["validate", "--config", example, "stray"], "Unexpected argument"],
      [["validate"], usage], [["validate", "--config"], usage],
      [["validate", "--config", "--json"], usage],
      [["validate", "--config", "a", "--config", "b"], usage],
      [["validate", "--config", example, "--json", "--json"], usage],
      [["scaffold", "--config", example, "--json"], "Unknown flag --json"],
      [["scaffold", "--config", example, "--output"], "Usage: pcc-onboard scaffold --config <path> [--output <dir>]"],
      [["scaffold", "--config", example, "--output", "a", "--output", "b"], "Usage: pcc-onboard scaffold --config <path> [--output <dir>]"],
    ];
    for (const [argv, message] of cases) {
      const result = run(argv);
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.calls).toEqual([["error", message]]);
      expect(JSON.stringify(result.calls)).not.toContain("deadbeef");
    }
    const help = run([]);
    expect(help.code).toBe(0);
    expect(help.logs).toHaveLength(1);
    expect(help.errors).toEqual([]);
    expect(help.logs[0]).toContain("  --json            Print the result as one JSON object (validate only)\n");
    for (const command of ["help", "--help", "-h"]) {
      expect(run([command, "ignored"])).toEqual(help);
    }
    const unknown = run(["valdate"]);
    expect(unknown.code).toBe(2);
    expect(unknown.logs).toEqual([]);
    expect(unknown.errors).toEqual(["Unknown command", help.logs[0]]);
  });

  it("CLI4: emits one JSON object with ordered local scope fields", () => {
    for (const [path, valid] of [[example, true], [invalidConfig(), false]] as const) {
      const result = run(["validate", "--config", path, "--json"]);
      expect(result.code).toBe(valid ? 0 : 1);
      expect(result.logs).toHaveLength(1);
      expect(result.errors).toEqual([]);
      const out = JSON.parse(result.logs[0]);
      expect(Object.keys(out)).toEqual(["valid", "scope", "checked", "notChecked", "checks", "errors", "warnings", "summary"]);
      expect(out.valid).toBe(valid);
      expect(out.scope).toBe("local");
      expect(out.checked).toEqual(["config", "adapters", "capabilities"]);
      expect(out.notChecked).toEqual(["evidence bundles", "signing key", "wallet", "adapter modules", "kernel agent", "machine-profile template fit"]);
      expect(out.checks).toEqual(expect.any(Array));
      expect(out.errors).toEqual(out.checks.filter((c: any) => !c.passed && c.severity === "error"));
      expect(out.warnings).toEqual(out.checks.filter((c: any) => !c.passed && c.severity === "warning"));
      expect(out.summary.split("\n")[0]).toBe(`Validation ${valid ? "PASSED" : "FAILED"}`);
      expect(result.logs[0]).toBe(JSON.stringify(out, null, 2));
    }
    for (const value of [null, [], 7]) {
      const result = run(["validate", "--config", configFile(value), "--json"]);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.logs[0]).errors.some((e: any) => e.name === "config")).toBe(true);
    }
  });

  it("CLI5: scaffolds only after validation and preserves generated files", () => {
    const out = scratch();
    const failed = run(["scaffold", "--config", invalidConfig(), "--output", out]);
    expect(failed.code).toBe(1);
    expect(failed.logs).toEqual([]);
    expect(failed.errors).toHaveLength(2);
    expect(failed.errors[0]).toBe("Configuration validation failed:\n");
    expect(failed.errors[1].split("\n")[0]).toBe("Validation FAILED");
    expect(readdirSync(out)).toEqual([]);
    const config = JSON.parse(readFileSync(example, "utf8"));
    const generated = scaffold({ config, outputDir: out });
    const passed = run(["scaffold", "--config", example, "--output", out]);
    expect(passed.code).toBe(0);
    expect(passed.errors).toEqual([]);
    for (const file of generated.files) expect(readFileSync(join(out, file.path), "utf8")).toBe(file.content);
    expect(passed.logs).toEqual([
      ...generated.files.map(file => `  Created: ${file.path} — ${file.description}`), "\n" + generated.summary,
    ]);
  });

  it("CLI6: detects the main module through a symlink", () => {
    const dir = scratch();
    const realFile = join(dir, "main.js"), link = join(dir, "bin-link"), other = join(dir, "other.js");
    writeFileSync(realFile, "");
    writeFileSync(other, "");
    symlinkSync(realFile, link);
    const moduleUrl = pathToFileURL(realpathSync(realFile)).href;
    expect(isMainModule(link, moduleUrl)).toBe(true);
    expect(isMainModule(undefined, moduleUrl)).toBe(false);
    expect(isMainModule(join(dir, "missing"), moduleUrl)).toBe(false);
    expect(isMainModule(other, moduleUrl)).toBe(false);
  });

  it("CLI7: reads at most 1 MiB from a file or a pipe", () => {
    const dir = scratch();
    const path = join(dir, "exact.json");
    const text = readFileSync(example, "utf8");
    writeFileSync(path, text + " ".repeat(1_048_576 - Buffer.byteLength(text)));
    const exact = run(["validate", "--config", path]);
    expect(exact.code).toBe(0);
    expect(exact.errors).toEqual([]);

    const payload = join(dir, "payload");
    writeFileSync(payload, "x".repeat(1_048_577));
    const piped = spawnSync("bash", ["-c", 'cat "$1" | "$0" --import tsx src/cli.ts validate --config /dev/stdin', process.execPath, payload], {
      cwd: packageDir, encoding: "utf8", timeout: 30000,
    });
    expect(piped.error).toBeUndefined();
    expect(piped.status).toBe(2);
    expect(piped.stdout).toBe("");
    expect(piped.stderr).toBe("Cannot read config /dev/stdin: larger than 1 MiB\n");
  });

  it("CLI8: prints V8's position only, never digits from the input", () => {
    for (const [text, suffix] of [
      ["position 42 nope", ""],
      ['{"a":1}}', " (position 7)"],
      ["{\n  \"a\": 1,\n}", " (position 12)"],
    ]) {
      const path = join(scratch(), "invalid.json");
      writeFileSync(path, text);
      const result = run(["validate", "--config", path]);
      expect(result.code).toBe(2);
      expect(result.logs).toEqual([]);
      expect(result.errors).toEqual([`Cannot read config ${path}: not valid JSON${suffix}`]);
    }
  });

  it("CLI9: the wallet value appears in neither the text output nor --json", () => {
    const hex = "ab".repeat(32);
    const config = JSON.parse(readFileSync(example, "utf8"));
    config.kernel.walletPrivateKeyEnvVar = "0x" + hex;
    const path = configFile(config);
    const text = run(["validate", "--config", path]);
    const json = run(["validate", "--config", path, "--json"]);
    for (const result of [text, json]) {
      expect(result.code).toBe(1);
      expect(result.errors).toEqual([]);
      expect(result.logs.join("\n")).not.toContain(hex);
    }
    expect(JSON.parse(json.logs[0]).warnings).toContainEqual(expect.objectContaining({
      name: "kernel.walletPrivateKeyEnvVar",
      message: "the scaffolded agent never reads the variable named in walletPrivateKeyEnvVar; KernelAgent takes no wallet setting, so its wallet is a new random key each start",
    }));
  });
});
