import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadReceiptSigner } from "../settlement/receipt-signer.js";

const directories: string[] = [];
async function run(...args: string[]) {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  let stdout = "";
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout += String(chunk); return true; });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderr += String(chunk); return true; });
  try {
    process.argv = [process.execPath, resolve(import.meta.dirname, "../../../../scripts/generate-gateway-receipt-key.ts"), ...args];
    process.exitCode = 0;
    vi.resetModules();
    await import("../../../../scripts/generate-gateway-receipt-key.js");
    return { status: process.exitCode, stdout, stderr };
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    out.mockRestore();
    err.mockRestore();
  }
}
function outputPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "gateway-receipt-key-"));
  directories.push(directory);
  return join(directory, "receipt.seed");
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("gateway receipt key generation script", () => {
  it("creates an exclusive 0600 seed file and prints only the matching public metadata", async () => {
    const path = outputPath();
    const result = await run("--out", path);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const content = readFileSync(path, "utf8");
    expect(content).toMatch(/^0x[0-9a-f]{64}\n$/);
    const seed = content.trim();
    const key = loadReceiptSigner(0, { PCC_GATEWAY_RECEIPT_SEED: seed, PCC_GATEWAY_RECEIPT_VALID_FROM: "0" })!;
    expect(result.stdout === `kid=${key.kid}\npublicKey=${key.publicKey}\n`).toBe(true);
    const bytes = Buffer.from(seed.slice(2), "hex");
    for (const secret of [seed, seed.slice(2), seed.toUpperCase(), bytes.toString("base64"), bytes.toString("base64url")]) {
      expect(result.stdout.includes(secret)).toBe(false);
      expect(result.stderr.includes(secret)).toBe(false);
    }
  });

  it("refuses to overwrite any existing output file", async () => {
    const path = outputPath();
    writeFileSync(path, "leave this file alone\n", { mode: 0o600 });
    const result = await run("--out", path);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("gateway receipt key generation failed\n");
    expect(readFileSync(path, "utf8")).toBe("leave this file alone\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.each([[], ["--out"], ["--out", ""], ["ignored"], ["--out", "file", "ignored"]].map((args, index) => ({ args, index })))(
    "requires exactly --out and a nonempty path ($index)", async ({ args }) => {
      const result = await run(...args);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("usage: generate-gateway-receipt-key --out <path>\n");
    },
  );
});
