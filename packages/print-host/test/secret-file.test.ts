import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSecretFile, SecretFileError, type SecretFileErrorCode } from "../src/secret-file.js";

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "print-host-secret-"));
  await fs.chmod(directory, 0o700);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.chmod(directory, 0o700);
  await fs.rm(directory, { recursive: true, force: true });
});

async function write(mode = 0o600, contents = randomBytes(64)): Promise<string> {
  const path = join(directory, "secret");
  await fs.writeFile(path, contents, { mode });
  await fs.chmod(path, mode);
  return path;
}

async function expectFailure(
  promise: Promise<unknown>,
  code: SecretFileErrorCode,
  path: string,
): Promise<void> {
  try {
    await promise;
    throw new Error("expected secure file refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(SecretFileError);
    expect((error as SecretFileError).code).toBe(code);
    expect((error as SecretFileError).path).toBe(path);
  }
}

describe("readSecretFile", () => {
  it.each([0o600, 0o400])("accepts mode %o in a private directory", async (mode) => {
    const contents = randomBytes(64);
    const path = await write(mode, contents);
    const result = await readSecretFile(path);
    expect(result.equals(contents)).toBe(true);
    result.fill(0);
    contents.fill(0);
  });

  it.each([0o640, 0o604, 0o644, 0o660])("refuses mode %o", async (mode) => {
    const path = await write(mode);
    await expectFailure(readSecretFile(path), "bad_mode", path);
  });

  it("refuses a symlink to an otherwise valid secret file", async () => {
    const path = await write();
    const link = join(directory, "link");
    await fs.symlink(path, link);
    await expectFailure(readSecretFile(link), "symlink", link);
  });

  it("refuses a directory", async () => {
    await expectFailure(readSecretFile(directory), "not_regular_file", directory);
  });

  it.each([0o750, 0o770, 0o755])("refuses parent mode %o", async (mode) => {
    const path = await write();
    await fs.chmod(directory, mode);
    await expectFailure(readSecretFile(path), "bad_parent", path);
  });

  it("refuses a symlinked parent directory", async () => {
    const parent = join(directory, "private");
    await fs.mkdir(parent, { mode: 0o700 });
    const path = join(parent, "secret");
    await fs.writeFile(path, randomBytes(64), { mode: 0o600 });
    const link = join(directory, "linked-parent");
    await fs.symlink(parent, link);
    const throughLink = join(link, "secret");
    await expectFailure(readSecretFile(throughLink), "bad_parent", throughLink);
  });

  it("refuses a relative path", async () => {
    await expectFailure(readSecretFile("relative-secret"), "not_absolute", "relative-secret");
  });

  it("refuses missing files", async () => {
    const path = join(directory, "missing");
    await expectFailure(readSecretFile(path), "not_found", path);
  });

  it("refuses an over-cap file", async () => {
    const path = await write(0o600, randomBytes(64 * 1024 + 1));
    await expectFailure(readSecretFile(path), "too_large", path);
  });

  it("refuses a wrong owner through the injected uid", async () => {
    const path = await write();
    const actual = await fs.lstat(path);
    await expectFailure(readSecretFile(path, { expectedUid: actual.uid + 1 }), "bad_owner", path);
  });

  it("refuses a parent owned by another uid", async () => {
    const path = await write();
    const originalLstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stat = await originalLstat(...args);
      if (args[0] === directory) stat.uid = typeof stat.uid === "number" ? stat.uid + 1 : stat.uid + 1n;
      return stat;
    });
    await expectFailure(readSecretFile(path), "bad_parent", path);
  });

  it("detects a file swapped between lstat and open", async () => {
    const path = await write();
    const originalOpen = fs.open.bind(fs);
    // Test-only seam: intercept the filesystem dependency at open, after the
    // reader's lstat checks. No race hook is part of the public reader API.
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      await fs.rename(path, join(directory, "original"));
      await fs.writeFile(path, randomBytes(64), { mode: 0o600 });
      return originalOpen(...args);
    });
    await expectFailure(readSecretFile(path), "changed_during_open", path);
  });

  it("rechecks mode on the opened file", async () => {
    const path = await write();
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      await fs.chmod(path, 0o640);
      return originalOpen(...args);
    });
    await expectFailure(readSecretFile(path), "bad_mode", path);
  });

  it("rechecks owner on the opened file", async () => {
    const path = await write();
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await originalOpen(...args);
      const originalStat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementationOnce(async (...statArgs) => {
        const stat = await originalStat(...statArgs);
        stat.uid = typeof stat.uid === "number" ? stat.uid + 1 : stat.uid + 1n;
        return stat;
      });
      return handle;
    });
    await expectFailure(readSecretFile(path), "bad_owner", path);
  });

  it("caps reads even when the file grows after fstat", async () => {
    const path = await write(0o600, randomBytes(8));
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await originalOpen(...args);
      const originalRead = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementationOnce(async (...readArgs) => {
        await fs.appendFile(path, randomBytes(32));
        return originalRead(...readArgs);
      });
      return handle;
    });
    await expectFailure(readSecretFile(path, { maxBytes: 16 }), "too_large", path);
  });

  it("errors have no content or underlying filesystem cause", async () => {
    const secret = randomBytes(32).toString("hex");
    const path = await write(0o640, Buffer.from(secret));
    let error: unknown;
    try {
      await readSecretFile(path);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SecretFileError);
    const forms = [
      (error as Error).message,
      String(error),
      JSON.stringify(error),
      inspect(error, { depth: 5, showHidden: true }),
    ];
    for (const form of forms) {
      for (let offset = 0; offset <= secret.length - 12; offset += 1) {
        expect(form.includes(secret.slice(offset, offset + 12))).toBe(false);
      }
    }
    expect(Object.hasOwn(error as object, "cause")).toBe(false);
  });

  it("erases a partial read and drops content-bearing read errors", async () => {
    const path = await write();
    const content = randomBytes(32).toString("hex");
    let readBuffer: Buffer | undefined;
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await originalOpen(...args);
      vi.spyOn(handle, "read").mockImplementationOnce(async (...readArgs) => {
        const buffer = readArgs[0];
        if (!Buffer.isBuffer(buffer)) throw new Error("unexpected read overload");
        readBuffer = buffer;
        buffer.write(content);
        throw new Error(content);
      });
      return handle;
    });
    let error: unknown;
    try { await readSecretFile(path); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(SecretFileError);
    expect((error as SecretFileError).code).toBe("read_failed");
    expect(readBuffer?.every((byte) => byte === 0)).toBe(true);
    for (const form of [String(error), JSON.stringify(error), inspect(error, { depth: 5 })]) {
      for (let offset = 0; offset <= content.length - 12; offset += 1) {
        expect(form.includes(content.slice(offset, offset + 12))).toBe(false);
      }
    }
  });
});
