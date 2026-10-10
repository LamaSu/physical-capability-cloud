import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateHostKeys, KeyGenerationError } from "../src/keygen.js";
import { loadDeviceKey, loadOperatorKey } from "../src/keys.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), mkdir: vi.fn(actual.mkdir) };
});

let parent: string;
beforeEach(async () => {
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

describe("host key generation", () => {
  it("creates a private directory, two loadable private files, and the public identity", async () => {
    const directory = join(parent, "new");
    const result = await generateHostKeys(directory, { notAfter: "2030-01-01T00:00:00Z" });
    expect((await fs.lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.lstat(result.paths.deviceKeyFile)).mode & 0o777).toBe(0o600);
    expect((await fs.lstat(result.paths.operatorKeyFile)).mode & 0o777).toBe(0o600);
    expect((await fs.lstat(result.paths.publicIdentityFile)).mode & 0o777).toBe(0o644);
    const device = await loadDeviceKey(result.paths.deviceKeyFile);
    const operator = await loadOperatorKey(result.paths.operatorKeyFile);
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
    const operator = await loadOperatorKey(join(directory, "operator-key.json"));
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
