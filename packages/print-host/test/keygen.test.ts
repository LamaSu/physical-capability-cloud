import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect, promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateHostKeys, KeyGenerationError } from "../src/keygen.js";
import { loadDeviceKey, loadOperatorKey } from "../src/keys.js";

const keygenBuffers = vi.hoisted(() => ({
  seeds: [] as Uint8Array[],
  secretKeys: [] as Uint8Array[],
  serialized: [] as Buffer[],
}));
vi.mock("../src/kernel-signer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/kernel-signer.js")>();
  return { ...actual, makeKernelEd25519Signer: vi.fn((...args: Parameters<typeof actual.makeKernelEd25519Signer>) => {
    const signer = actual.makeKernelEd25519Signer(...args);
    if (args[0] !== undefined) keygenBuffers.seeds.push(args[0]);
    keygenBuffers.secretKeys.push(signer.secretKey);
    return signer;
  }) };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), mkdir: vi.fn(actual.mkdir) };
});

let parent: string;
beforeEach(async () => {
  keygenBuffers.seeds = [];
  keygenBuffers.secretKeys = [];
  keygenBuffers.serialized = [];
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
  vi.mocked(fs.mkdir).mockReset().mockImplementation(actual.mkdir);
  parent = await fs.mkdtemp(join(tmpdir(), "ph2-keygen-"));
  await fs.chmod(parent, 0o700);
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(parent, { recursive: true, force: true }); });

async function secrets(outDir: string): Promise<string[]> {
  const device = JSON.parse(await fs.readFile(join(outDir, "device-key.json"), "utf8")) as { seed: string };
  const operator = JSON.parse(await fs.readFile(join(outDir, "operator-key.json"), "utf8")) as { privateKey: string };
  return [device.seed, operator.privateKey.slice(2)];
}
function assertNoLeak(value: unknown, rawSecrets: string[]): void {
  const output = [String(value), JSON.stringify(value) ?? "", inspect(value, { depth: 5, showHidden: true })];
  for (const raw of rawSecrets) {
    for (let start = 0; start <= raw.length - 12; start++) {
      expect(output.some((text) => text.includes(raw.slice(start, start + 12))), "secret fragment was exposed").toBe(false);
    }
  }
}
function keyFileOpenPaths(): string[] {
  return vi.mocked(fs.open).mock.calls.map(([path]) => String(path))
    .filter((path) => /\/(?:device-key|operator-key|public)\.json$/.test(path));
}
async function captureSerializedWrites(failOperatorSync = false): Promise<void> {
  const actualOpen = (await vi.importActual<typeof fs>("node:fs/promises")).open;
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await actualOpen(...args);
    if (/\/(?:device-key|operator-key|public)\.json$/.test(String(args[0]))) {
      const actualWriteFile = handle.writeFile.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementation(async (...writeArgs: Parameters<typeof handle.writeFile>) => {
        expect(Buffer.isBuffer(writeArgs[0]), "key JSON is written from a mutable buffer").toBe(true);
        const bytes = writeArgs[0] as Buffer;
        expect(bytes.some((byte) => byte !== 0), "captured JSON starts with data").toBe(true);
        keygenBuffers.serialized.push(bytes);
        return actualWriteFile(...writeArgs);
      });
      if (failOperatorSync && String(args[0]).endsWith("/operator-key.json")) {
        vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("injected sync failure"));
      }
    }
    return handle;
  });
}
function assertGenerationBuffersZeroed(serializedCount: number): void {
  expect(keygenBuffers.seeds).toHaveLength(1);
  expect(keygenBuffers.secretKeys).toHaveLength(1);
  expect(keygenBuffers.serialized).toHaveLength(serializedCount);
  for (const [label, buffers] of [
    ["seed", keygenBuffers.seeds], ["secret key", keygenBuffers.secretKeys],
    ["serialized JSON", keygenBuffers.serialized],
  ] as const) {
    for (const bytes of buffers) {
      expect(bytes.length > 0).toBe(true);
      expect(bytes.every((byte) => byte === 0), `generated ${label} bytes were retained`).toBe(true);
    }
  }
}

describe("host key generation", () => {
  it("creates a private directory, two loadable private files, and the public identity", async () => {
    const directory = join(parent, "new");
    const result = await generateHostKeys(directory, { notAfter: "2030-01-01T00:00:00Z" });
    expect((await fs.lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.lstat(result.paths.deviceKeyFile)).mode & 0o777).toBe(0o600);
    expect((await fs.lstat(result.paths.operatorKeyFile)).mode & 0o777).toBe(0o600);
    expect((await fs.lstat(result.paths.publicIdentityFile)).mode & 0o777).toBe(0o644);
    const device = await loadDeviceKey(result.paths.deviceKeyFile);
    const operator = await loadOperatorKey(result.paths.operatorKeyFile, 84532);
    expect(device.signingPublicKey === result.identity.devicePublicKey).toBe(true);
    expect(operator.address === result.identity.operatorAddress).toBe(true);
    const rawSecrets = await secrets(directory);
    assertNoLeak(result, rawSecrets);
    assertNoLeak(device, rawSecrets);
    assertNoLeak(operator, rawSecrets);
    const publicIdentity = JSON.parse(await fs.readFile(result.paths.publicIdentityFile, "utf8")) as unknown;
    assertNoLeak(publicIdentity, rawSecrets);
    expect(JSON.stringify(publicIdentity) === JSON.stringify(result.identity)).toBe(true);
  });

  for (const filename of ["device-key.json", "operator-key.json", "public.json"]) {
    it(`refuses existing ${filename} before writing anything`, async () => {
      const directory = join(parent, "existing");
      await fs.mkdir(directory, { mode: 0o700 });
      const path = join(directory, filename);
      const previous = randomBytes(80);
      await fs.writeFile(path, previous, { mode: 0o600 });
      let error: unknown;
      try { await generateHostKeys(directory); } catch (caught) { error = caught; }
      expect(error instanceof KeyGenerationError).toBe(true);
      expect((error as KeyGenerationError).code).toBe("already_exists");
      expect((await fs.readFile(path)).equals(previous)).toBe(true);
      expect((await fs.readdir(directory)).join(",") === filename).toBe(true);
      assertNoLeak(error, [previous.toString("hex")]);
      previous.fill(0);
    });
  }

  it("checks an existing operator key before opening the device key", async () => {
    const directory = join(parent, "operator-precheck");
    await fs.mkdir(directory, { mode: 0o700 });
    const path = join(directory, "operator-key.json");
    const previous = randomBytes(80);
    await fs.writeFile(path, previous, { mode: 0o600 });
    vi.mocked(fs.open).mockClear();
    await expect(generateHostKeys(directory)).rejects.toMatchObject({
      code: "already_exists", message: `already_exists: ${path}`,
    });
    expect(keyFileOpenPaths()).toEqual([]);
    expect((await fs.readFile(path)).equals(previous)).toBe(true);
    previous.fill(0);
  });

  it("checks an existing public identity before opening either secret file", async () => {
    const directory = join(parent, "public-precheck");
    await fs.mkdir(directory, { mode: 0o700 });
    const path = join(directory, "public.json");
    const previous = randomBytes(80);
    await fs.writeFile(path, previous, { mode: 0o644 });
    vi.mocked(fs.open).mockClear();
    await expect(generateHostKeys(directory)).rejects.toMatchObject({
      code: "already_exists", message: `already_exists: ${path}`,
    });
    expect(keyFileOpenPaths()).toEqual([]);
    expect(await fs.readdir(directory)).toEqual(["public.json"]);
    expect((await fs.readFile(path)).equals(previous)).toBe(true);
    previous.fill(0);
  });

  it("zeroes the seed, secret key, and serialized JSON buffers after generation", async () => {
    await captureSerializedWrites();
    await generateHostKeys(join(parent, "zero-success"));
    assertGenerationBuffersZeroed(3);
  });

  it("zeroes the seed, secret key, and serialized JSON buffers after a write failure", async () => {
    await captureSerializedWrites(true);
    const directory = join(parent, "zero-failure");
    await expect(generateHostKeys(directory)).rejects.toMatchObject({ code: "write_failed" });
    assertGenerationBuffersZeroed(2);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("preserves 0600 secret files and 0644 public identity under umask 077", async () => {
    // Node forbids changing the process umask inside Vitest's thread worker.
    // Run the actual producer in a child process with the local tsx loader.
    const directory = join(parent, "umask-077");
    await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { generateHostKeys } from "./src/keygen.ts";
      process.umask(0o077);
      await generateHostKeys(process.argv[1]);
    `, directory], { cwd: new URL("..", import.meta.url) });
    expect((await fs.lstat(join(directory, "device-key.json"))).mode & 0o777).toBe(0o600);
    expect((await fs.lstat(join(directory, "operator-key.json"))).mode & 0o777).toBe(0o600);
    expect((await fs.lstat(join(directory, "public.json"))).mode & 0o777).toBe(0o644);
  });

  it("opens every generated key file through the pinned directory descriptor", async () => {
    await generateHostKeys(join(parent, "pinned-opens"));
    const openedPaths = keyFileOpenPaths();
    expect(openedPaths).toHaveLength(3);
    for (const path of openedPaths) expect(path.startsWith("/proc/self/fd/")).toBe(true);
  });

  it("rejects an existing 0755 directory before opening any key file", async () => {
    const directory = join(parent, "unsafe-opens");
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.chmod(directory, 0o755);
    vi.mocked(fs.open).mockClear();
    await expect(generateHostKeys(directory)).rejects.toMatchObject({
      code: "bad_mode", message: `bad_mode: ${directory}`,
    });
    expect(keyFileOpenPaths()).toEqual([]);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("two fresh runs create different keys", async () => {
    const first = await generateHostKeys(join(parent, "one"));
    const second = await generateHostKeys(join(parent, "two"));
    expect(first.identity.devicePublicKey !== second.identity.devicePublicKey).toBe(true);
    expect(first.identity.operatorAddress !== second.identity.operatorAddress).toBe(true);
    assertNoLeak(first, await secrets(join(parent, "one")));
    assertNoLeak(second, await secrets(join(parent, "two")));
  });

  it("rolls back the first file when the second exclusive open fails", async () => {
    const directory = join(parent, "rollback");
    const actualOpen = (await vi.importActual<typeof fs>("node:fs/promises")).open;
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith("/operator-key.json")) throw new Error("injected write failure");
      return actualOpen(...args);
    });
    let error: unknown;
    try { await generateHostKeys(directory); } catch (caught) { error = caught; }
    expect(error instanceof KeyGenerationError).toBe(true);
    expect((error as KeyGenerationError).code).toBe("write_failed");
    expect((await fs.readdir(directory)).length).toBe(0);
  });

  it("does not remove an operator file created by a colliding writer", async () => {
    const directory = join(parent, "collision");
    const foreign = randomBytes(80);
    const actualOpen = (await vi.importActual<typeof fs>("node:fs/promises")).open;
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith("/operator-key.json")) {
        await fs.writeFile(args[0], foreign, { mode: 0o600 });
      }
      return actualOpen(...args);
    });
    let error: unknown;
    try { await generateHostKeys(directory); } catch (caught) { error = caught; }
    expect(error instanceof KeyGenerationError).toBe(true);
    expect((error as KeyGenerationError).code).toBe("already_exists");
    expect((await fs.readFile(join(directory, "operator-key.json"))).equals(foreign)).toBe(true);
    expect((await fs.readdir(directory)).join(",") === "operator-key.json").toBe(true);
    assertNoLeak(error, [foreign.toString("hex")]);
    foreign.fill(0);
  });

  it("rolls back a created file after a transient initial fstat failure", async () => {
    const directory = join(parent, "stat-failure");
    const actualOpen = (await vi.importActual<typeof fs>("node:fs/promises")).open;
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actualOpen(...args);
      if (String(args[0]).endsWith("/device-key.json")) {
        vi.spyOn(handle, "stat").mockRejectedValueOnce(new Error("injected fstat failure"));
      }
      return handle;
    });
    let error: unknown;
    try { await generateHostKeys(directory); } catch (caught) { error = caught; }
    expect(error instanceof KeyGenerationError).toBe(true);
    expect((error as KeyGenerationError).code).toBe("write_failed");
    expect((await fs.readdir(directory)).length).toBe(0);
  });

  it("pins the output directory and refuses a parent replacement without touching its target", async () => {
    const directory = join(parent, "swapped");
    const original = join(parent, "original");
    const target = join(parent, "target");
    await fs.mkdir(target, { mode: 0o700 });
    const actualOpen = (await vi.importActual<typeof fs>("node:fs/promises")).open;
    let replaced = false;
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (!replaced && String(args[0]).endsWith("/device-key.json")) {
        replaced = true;
        await fs.rename(directory, original);
        await fs.symlink(target, directory);
      }
      return actualOpen(...args);
    });
    let error: unknown;
    try { await generateHostKeys(directory); } catch (caught) { error = caught; }
    expect(error instanceof KeyGenerationError).toBe(true);
    expect((error as KeyGenerationError).code).toBe("bad_directory");
    expect((await fs.readdir(target)).length).toBe(0);
    expect((await fs.readdir(original)).length).toBe(0);
  });

  it("repairs owner permissions removed by a restrictive creation umask", async () => {
    const directory = join(parent, "owner-mode");
    const actualMkdir = (await vi.importActual<typeof fs>("node:fs/promises")).mkdir;
    vi.mocked(fs.mkdir).mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
      const result = await actualMkdir(...args);
      if (args[0] === directory) await fs.chmod(directory, 0o500);
      return result;
    });
    const generated = await generateHostKeys(directory);
    expect((await fs.lstat(directory)).mode & 0o777).toBe(0o700);
    assertNoLeak(generated, await secrets(directory));
  });

  it("refuses an injected wrong directory owner and malformed expiry without echoing values", async () => {
    const directory = join(parent, "wrong-owner");
    const malformed = randomBytes(32).toString("hex");
    for (const [options, code] of [
      [{ expectedUid: process.getuid!() + 1 }, "bad_owner"],
      [{ notAfter: malformed }, "bad_not_after"],
    ] as const) {
      let error: unknown;
      try { await generateHostKeys(directory, options); } catch (caught) { error = caught; }
      expect(error instanceof KeyGenerationError).toBe(true);
      expect((error as KeyGenerationError).code === code).toBe(true);
      assertNoLeak(error, [malformed]);
    }
  });

  it("rejects expiry at or before the generation time before opening any files", async () => {
    const now = new Date("2030-01-01T00:00:00.500Z");
    for (const notAfter of [
      "2029-12-31T23:59:59Z", "2030-01-01T00:00:00Z", "2030-01-01T00:00:00.500Z",
    ]) {
      const directory = join(parent, `expired-${Date.parse(notAfter)}`);
      vi.mocked(fs.open).mockClear();
      await expect(generateHostKeys(directory, { now, notAfter })).rejects.toMatchObject({
        code: "bad_not_after", message: `bad_not_after: ${directory}`,
      });
      expect(vi.mocked(fs.open)).not.toHaveBeenCalled();
      await expect(fs.lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("accepts expiry strictly after createdAt", async () => {
    const now = new Date("2030-01-01T00:00:00.500Z");
    const notAfter = "2030-01-01T00:00:00.501Z";
    const generated = await generateHostKeys(join(parent, "valid-expiry"), { now, notAfter });
    expect(generated.identity.createdAt).toBe(now.toISOString());
    for (const path of [generated.paths.deviceKeyFile, generated.paths.operatorKeyFile]) {
      const object = JSON.parse(await fs.readFile(path, "utf8")) as { createdAt: string; notAfter: string };
      expect(object.createdAt).toBe(now.toISOString());
      expect(object.notAfter).toBe(notAfter);
    }
  });

  it("concurrent generators have one complete winner and one safe collision", async () => {
    const directory = join(parent, "concurrent");
    const outcomes = await Promise.allSettled([generateHostKeys(directory), generateHostKeys(directory)]);
    expect(outcomes.filter((item) => item.status === "fulfilled").length).toBe(1);
    expect(outcomes.filter((item) => item.status === "rejected").length).toBe(1);
    const failure = outcomes.find((item) => item.status === "rejected") as PromiseRejectedResult;
    expect(failure.reason instanceof KeyGenerationError).toBe(true);
    expect(failure.reason.code).toBe("already_exists");
    const rawSecrets = await secrets(directory);
    assertNoLeak(failure.reason, rawSecrets);
    const device = await loadDeviceKey(join(directory, "device-key.json"));
    const operator = await loadOperatorKey(join(directory, "operator-key.json"), 84532);
    assertNoLeak(device, rawSecrets);
    assertNoLeak(operator, rawSecrets);
    expect((await fs.readdir(directory)).length).toBe(3);
  });

  it("refuses relative output, unsafe directory modes, and symlink directories", async () => {
    const directory = join(parent, "unsafe");
    await fs.mkdir(directory, { mode: 0o755 });
    const link = join(parent, "link");
    await fs.symlink(directory, link);
    for (const [path, code] of [["relative", "not_absolute"], [directory, "bad_mode"], [link, "bad_directory"]]) {
      let error: unknown;
      try { await generateHostKeys(path); } catch (caught) { error = caught; }
      expect(error instanceof KeyGenerationError).toBe(true);
      expect((error as KeyGenerationError).code === code).toBe(true);
    }
  });
});
