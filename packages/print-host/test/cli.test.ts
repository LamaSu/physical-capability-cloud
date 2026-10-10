import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { generateHostKeys } from "../src/keygen.js";

vi.mock("../src/keygen.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/keygen.js")>();
  return { ...actual, generateHostKeys: vi.fn(actual.generateHostKeys) };
});

const dirs: string[] = [];
afterEach(async () => {
  vi.mocked(generateHostKeys).mockClear();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temporaryDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ph2-cli-"));
  dirs.push(dir);
  await chmod(dir, 0o700);
  return dir;
}

function capture() {
  let stdout = "";
  let stderr = "";
  const io = {
    stdout: { write: (text: string) => { stdout += text; } },
    stderr: { write: (text: string) => { stderr += text; } },
  };
  return { io, output: () => ({ stdout, stderr }) };
}

describe("print-host CLI", () => {
  it("keygen prints only the public identity and paths", async () => {
    const root = await temporaryDirectory();
    const outDir = join(root, "keys");
    const captured = capture();
    expect(await main(["keygen", "--out", outDir, "--not-after", "2099-01-01T00:00:00Z"], captured.io)).toBe(0);
    const { stdout, stderr } = captured.output();
    const result = JSON.parse(stdout);
    expect(result.identity.kind).toBe("pcc-printhost.public-identity");
    expect(result.paths.deviceKeyFile).toBe(join(outDir, "device-key.json"));
    expect(result.paths.operatorKeyFile).toBe(join(outDir, "operator-key.json"));
    expect(result.paths.publicIdentityFile).toBe(join(outDir, "public.json"));
    const device = JSON.parse(await readFile(result.paths.deviceKeyFile, "utf8"));
    const operator = JSON.parse(await readFile(result.paths.operatorKeyFile, "utf8"));
    for (const secret of [device.seed, operator.privateKey.slice(2)]) {
      for (let offset = 0; offset <= secret.length - 12; offset++) {
        expect((stdout + stderr).includes(secret.slice(offset, offset + 12))).toBe(false);
      }
    }
    expect(stderr).toBe("");
  });

  it("check-config prints only the checked public identity", async () => {
    const root = await temporaryDirectory();
    const generated = capture();
    expect(await main(["keygen", "--out", join(root, "keys")], generated.io)).toBe(0);
    const result = JSON.parse(generated.output().stdout);
    const apiToken = randomBytes(24).toString("hex");
    const providerToken = randomBytes(24).toString("hex");
    const rpcUrlFile = join(root, "rpc-url");
    const apiKeyFile = join(root, "api-key");
    await writeFile(rpcUrlFile, `https://rpc.example.test/${providerToken}\n`, { mode: 0o600 });
    await writeFile(apiKeyFile, `${apiToken}\n`, { mode: 0o600 });
    const dataDir = join(root, "data");
    await mkdir(dataDir, { mode: 0o700 });
    const configFile = join(root, "host.json");
    await writeFile(configFile, JSON.stringify({
      kernelId: "n144-cli", deviceId: "printer-cli",
      printer: { uri: "ipp://localhost:631/printers/test" },
      chain: { chainId: 84532, rpcUrlFile },
      gateway: { baseUrl: "https://gateway.example.test", apiKeyFile },
      keys: { deviceKeyFile: result.paths.deviceKeyFile, operatorKeyFile: result.paths.operatorKeyFile },
      dataDir,
    }), { mode: 0o600 });
    const checked = capture();
    expect(await main(["check-config", configFile], checked.io)).toBe(0);
    const { stdout, stderr } = checked.output();
    expect(JSON.parse(stdout)).toEqual({
      kernelId: "n144-cli", deviceId: "printer-cli", chainId: 84532,
      devicePublicKey: result.identity.devicePublicKey, operatorAddress: result.identity.operatorAddress,
      printerUri: "ipp://localhost:631/printers/test", gatewayBaseUrl: "https://gateway.example.test",
    });
    expect(stdout.includes(apiToken) || stdout.includes(providerToken)).toBe(false);
    expect(stderr).toBe("");
  });

  it.each([
    [], ["unknown"], ["keygen"], ["keygen", "--out"],
    ["keygen", "--out", "relative-unused", "--out", "relative-unused"],
    ["keygen", "--unknown", "value"], ["keygen", "--not-after", "2099-01-01T00:00:00Z"],
    ["check-config"], ["check-config", "relative-unused", "extra"],
  ])("bad arguments exit 2 (%#)", async (...argv: string[]) => {
    const captured = capture();
    expect(await main(argv, captured.io)).toBe(2);
    expect(captured.output().stdout).toBe("");
    expect(captured.output().stderr.startsWith("Usage:")).toBe(true);
  });

  it("failures print a safe error and no stack", async () => {
    const root = await temporaryDirectory();
    const missingConfig = join(root, "missing.json");
    const captured = capture();
    expect(await main(["check-config", missingConfig], captured.io)).toBe(1);
    expect(captured.output().stdout).toBe("");
    expect(captured.output().stderr).toBe(`not_found: ${missingConfig}\n`);
  });

  it("keygen errors print the closed message once", async () => {
    const captured = capture();
    expect(await main(["keygen", "--out", "relative-unused"], captured.io)).toBe(1);
    expect(captured.output()).toEqual({ stdout: "", stderr: "not_absolute: relative-unused\n" });
  });

  it("internal errors discard content-bearing messages", async () => {
    const root = await temporaryDirectory();
    vi.mocked(generateHostKeys).mockRejectedValueOnce(new Error(randomBytes(32).toString("hex")));
    const captured = capture();
    expect(await main(["keygen", "--out", join(root, "keys")], captured.io)).toBe(1);
    expect(captured.output().stdout).toBe("");
    // A failed mutation must not print the secret in the assertion's diagnostics.
    expect(captured.output().stderr === "internal_error: print-host operation failed\n",
      "internal errors use only the closed message").toBe(true);
  });
});
