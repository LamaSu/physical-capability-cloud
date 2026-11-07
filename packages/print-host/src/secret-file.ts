import { constants } from "node:fs";
import fs from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

export type SecretFileErrorCode =
  | "not_absolute"
  | "not_found"
  | "not_regular_file"
  | "symlink"
  | "bad_mode"
  | "bad_owner"
  | "bad_parent"
  | "too_large"
  | "changed_during_open"
  | "read_failed";

/** Contains no filesystem error, cause, or file contents. */
export class SecretFileError extends Error {
  readonly code: SecretFileErrorCode;
  readonly path: string;

  constructor(code: SecretFileErrorCode, path: string) {
    super(`${code}: ${path}`);
    this.name = "SecretFileError";
    this.code = code;
    this.path = path;
  }
}

export interface SecretFileOptions {
  expectedUid?: number;
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024;

function safeError(error: unknown, path: string): SecretFileError {
  if (error instanceof SecretFileError) return error;
  const code = typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
  if (code === "ENOENT") return new SecretFileError("not_found", path);
  if (code === "ELOOP") return new SecretFileError("symlink", path);
  return new SecretFileError("read_failed", path);
}

/** Reads only from the checked descriptor; callers must erase the returned bytes. */
export async function readSecretFile(
  path: string,
  options: SecretFileOptions = {},
): Promise<Buffer> {
  if (!isAbsolute(path)) throw new SecretFileError("not_absolute", path);
  const expectedUid = options.expectedUid ?? process.getuid?.();
  if (expectedUid === undefined || !Number.isSafeInteger(expectedUid) || expectedUid < 0) {
    throw new SecretFileError("bad_owner", path);
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= 0x7fff_ffff) {
    throw new SecretFileError("too_large", path);
  }

  let checked;
  try {
    checked = await fs.lstat(path);
  } catch (error) {
    throw safeError(error, path);
  }
  if (checked.isSymbolicLink()) throw new SecretFileError("symlink", path);
  if (!checked.isFile()) throw new SecretFileError("not_regular_file", path);
  if ((checked.mode & 0o077) !== 0) throw new SecretFileError("bad_mode", path);
  if (checked.uid !== expectedUid) throw new SecretFileError("bad_owner", path);
  if (checked.size > maxBytes) throw new SecretFileError("too_large", path);

  try {
    const parent = await fs.lstat(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink()
      || parent.uid !== expectedUid || (parent.mode & 0o077) !== 0) {
      throw new SecretFileError("bad_parent", path);
    }
  } catch {
    throw new SecretFileError("bad_parent", path);
  }

  let file;
  try {
    // O_NONBLOCK prevents a raced replacement with a FIFO from blocking open.
    file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW
      | constants.O_NOCTTY | constants.O_NONBLOCK);
  } catch (error) {
    throw safeError(error, path);
  }

  let bytes: Buffer | undefined;
  try {
    const opened = await file.stat();
    if (opened.dev !== checked.dev || opened.ino !== checked.ino) {
      throw new SecretFileError("changed_during_open", path);
    }
    if (!opened.isFile()) throw new SecretFileError("not_regular_file", path);
    if ((opened.mode & 0o077) !== 0) throw new SecretFileError("bad_mode", path);
    if (opened.uid !== expectedUid) throw new SecretFileError("bad_owner", path);
    if (opened.size > maxBytes) throw new SecretFileError("too_large", path);

    // The extra byte detects growth after fstat without an unbounded readFile.
    bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length <= maxBytes) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) return bytes.subarray(0, length);
      length += bytesRead;
    }
    throw new SecretFileError("too_large", path);
  } catch (error) {
    bytes?.fill(0);
    throw safeError(error, path);
  } finally {
    try {
      await file.close();
    } catch {
      bytes?.fill(0);
      throw new SecretFileError("read_failed", path);
    }
  }
}
