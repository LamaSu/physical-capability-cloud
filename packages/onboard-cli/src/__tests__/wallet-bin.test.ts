import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("../../", import.meta.url));
let temporary: string;
let bin: string;
function child(args: string[], cwd?: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const capture = mkdtempSync(join(tmpdir(), "pcc-wallet-child-"));
    const outPath = join(capture, "stdout");
    const errPath = join(capture, "stderr");
    const out = openSync(outPath, "w");
    const err = openSync(errPath, "w");
    const processChild = spawn(process.execPath, args, { cwd, stdio: ["ignore", out, err] });
    closeSync(out);
    closeSync(err);
    processChild.once("error", (error) => { rmSync(capture, { recursive: true, force: true }); reject(error); });
    processChild.once("close", (status) => {
      const stdout = readFileSync(outPath, "utf8");
      const stderr = readFileSync(errPath, "utf8");
      rmSync(capture, { recursive: true, force: true });
      resolve({ status, stdout, stderr });
    });
  });
}
beforeAll(async () => {
  const build = await child([join(packageDir, "node_modules/typescript/bin/tsc"), "-p", "."], packageDir);
  expect(build.status, build.stderr).toBe(0);
  temporary = mkdtempSync(join(tmpdir(), "pcc-wallet-bin-"));
  bin = join(temporary, "pcc-wallet");
  symlinkSync(join(packageDir, "dist/wallet/cli.js"), bin);
});
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

describe("installed pcc-wallet bin", () => {
  it("prints CLI help through an npm bin symlink in a child process", async () => {
    const result = await child([bin, "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: pcc-wallet");
  });
  it("rejects a bad command through an npm bin symlink in a child process", async () => {
    const result = await child([bin, "bad-command"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("unknown_wallet_command\n");
  });
});
