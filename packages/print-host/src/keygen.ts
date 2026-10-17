import { constants } from "node:fs";
import { lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { makeKernelEd25519Signer } from "./kernel-signer.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { isUtcTimestamp } from "./keys.js";

export type KeyGenerationErrorCode = "not_absolute" | "bad_directory" | "bad_owner" |
  "bad_mode" | "already_exists" | "bad_not_after" | "bad_time" | "write_failed";

export class KeyGenerationError extends Error {
  readonly code: KeyGenerationErrorCode;
  readonly path: string;
  constructor(code: KeyGenerationErrorCode, path: string) {
    super(`${code}: ${path}`);
    this.name = "KeyGenerationError";
    this.code = code;
    this.path = path;
  }
}

export interface GenerateHostKeysOptions {
  expectedUid?: number;
  now?: Date;
  notAfter?: string;
}

export interface HostPublicIdentity {
  kind: "pcc-printhost.public-identity";
  version: 1;
  createdAt: string;
  devicePublicKey: string;
  operatorAddress: `0x${string}`;
}

export interface GeneratedHostKeys {
  identity: HostPublicIdentity;
  paths: { deviceKeyFile: string; operatorKeyFile: string; publicIdentityFile: string };
}

interface OwnedWrite { path: string; dev: number; ino: number }
interface PinnedDirectory { handle: FileHandle; dev: number; ino: number }

function errno(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
}

async function prepareDirectory(path: string, uid: number): Promise<PinnedDirectory> {
  let created = false;
  let handle: FileHandle | undefined;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (errno(error) !== "EEXIST") throw new KeyGenerationError("bad_directory", path);
  }
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new KeyGenerationError("bad_directory", path);
    if (stat.uid !== uid) throw new KeyGenerationError("bad_owner", path);
    if ((stat.mode & 0o077) !== 0) throw new KeyGenerationError("bad_mode", path);
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (stat.dev !== opened.dev || stat.ino !== opened.ino || !opened.isDirectory()) {
      throw new KeyGenerationError("bad_directory", path);
    }
    if (opened.uid !== uid) throw new KeyGenerationError("bad_owner", path);
    if ((opened.mode & 0o077) !== 0) throw new KeyGenerationError("bad_mode", path);
    if (created) {
      // A restrictive umask can remove owner bits; repair through the pinned fd.
      await handle.chmod(0o700);
      if (((await handle.stat()).mode & 0o777) !== 0o700) throw new KeyGenerationError("bad_mode", path);
    }
    return { handle, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (handle !== undefined) {
      try { await handle.close(); } catch { /* Keep the value-free original error. */ }
    }
    if (error instanceof KeyGenerationError) throw error;
    throw new KeyGenerationError("bad_directory", path);
  }
}

async function ensureAbsent(path: string, displayPath: string): Promise<void> {
  try { await lstat(path); }
  catch (error) {
    if (errno(error) === "ENOENT") return;
    throw new KeyGenerationError("write_failed", displayPath);
  }
  throw new KeyGenerationError("already_exists", displayPath);
}

/** Clean up only files this invocation opened with O_EXCL, never collision files. */
async function rollback(writes: OwnedWrite[]): Promise<void> {
  for (const written of [...writes].reverse()) {
    try {
      const stat = await lstat(written.path);
      if (stat.dev === written.dev && stat.ino === written.ino) await unlink(written.path);
    } catch { /* Preserve the original value-free error. */ }
  }
}

async function writeExclusive(path: string, displayPath: string, object: object, mode: number, uid: number,
  writes: OwnedWrite[]): Promise<void> {
  let fd: FileHandle | undefined;
  let bytes: Buffer | undefined;
  let tracked = false;
  try {
    fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    const stat = await fd.stat();
    writes.push({ path, dev: stat.dev, ino: stat.ino });
    tracked = true;
    if (!stat.isFile() || stat.uid !== uid) throw new KeyGenerationError("bad_owner", displayPath);
    // An unusual umask must never quietly alter the promised file permissions.
    await fd.chmod(mode);
    if (((await fd.stat()).mode & 0o777) !== mode) throw new KeyGenerationError("bad_mode", displayPath);
    bytes = Buffer.from(`${JSON.stringify(object)}\n`, "utf8");
    await fd.writeFile(bytes);
    await fd.sync();
    await fd.close();
    fd = undefined;
  } catch (error) {
    if (error instanceof KeyGenerationError) throw error;
    throw new KeyGenerationError(errno(error) === "EEXIST" ? "already_exists" : "write_failed", displayPath);
  } finally {
    bytes?.fill(0);
    if (fd !== undefined) {
      if (!tracked) {
        // If the first fstat transiently failed, recover the identity while we
        // still own the O_EXCL descriptor so outer rollback can remove it.
        try {
          const stat = await fd.stat();
          writes.push({ path, dev: stat.dev, ino: stat.ino });
        } catch { /* Never unlink an unidentifiable file that may have been replaced. */ }
      }
      try { await fd.close(); } catch { /* Do not expose a raw platform error. */ }
    }
  }
}

export async function generateHostKeys(outDir: string, options: GenerateHostKeysOptions = {}): Promise<GeneratedHostKeys> {
  if (!isAbsolute(outDir)) throw new KeyGenerationError("not_absolute", outDir);
  const uid = options.expectedUid ?? process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    throw new KeyGenerationError("bad_owner", outDir);
  }
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new KeyGenerationError("bad_time", outDir);
  const createdAt = now.toISOString();
  // createdAt is the same instant as now; a newly generated key must be valid
  // strictly after that instant, including when the caller supplies the clock.
  if (options.notAfter !== undefined &&
      (!isUtcTimestamp(options.notAfter) || Date.parse(options.notAfter) <= now.getTime())) {
    throw new KeyGenerationError("bad_not_after", outDir);
  }
  const directory = await prepareDirectory(outDir, uid);
  const paths = {
    deviceKeyFile: join(outDir, "device-key.json"),
    operatorKeyFile: join(outDir, "operator-key.json"),
    publicIdentityFile: join(outDir, "public.json"),
  };
  // Linux host: Node lacks openat, so /proc/self/fd binds every pathname operation
  // to the verified directory descriptor. There is deliberately no unsafe fallback.
  const pinnedPaths = {
    deviceKeyFile: `/proc/self/fd/${directory.handle.fd}/device-key.json`,
    operatorKeyFile: `/proc/self/fd/${directory.handle.fd}/operator-key.json`,
    publicIdentityFile: `/proc/self/fd/${directory.handle.fd}/public.json`,
  };
  let seed: Buffer | undefined;
  const writes: OwnedWrite[] = [];
  try {
    // Complete every collision check before generating or writing any material.
    await ensureAbsent(pinnedPaths.deviceKeyFile, paths.deviceKeyFile);
    await ensureAbsent(pinnedPaths.operatorKeyFile, paths.operatorKeyFile);
    await ensureAbsent(pinnedPaths.publicIdentityFile, paths.publicIdentityFile);
    seed = randomBytes(32);
    const signer = makeKernelEd25519Signer(seed);
    const devicePublicKey = signer.signingPublicKey;
    signer.secretKey.fill(0); // keygen needs only the derived public half.
    const privateKey = generatePrivateKey();
    const operatorAddress = privateKeyToAccount(privateKey).address;
    const expiry = options.notAfter === undefined ? {} : { notAfter: options.notAfter };
    await writeExclusive(pinnedPaths.deviceKeyFile, paths.deviceKeyFile, {
      kind: "pcc-printhost.device-key", version: 1, algorithm: "ed25519",
      purpose: "funded device principal: LO-EV-1 delegation grants and D2 package signatures (testnet)",
      createdAt, ...expiry, publicKey: devicePublicKey, seed: seed.toString("hex"),
    }, 0o600, uid, writes);
    await writeExclusive(pinnedPaths.operatorKeyFile, paths.operatorKeyFile, {
      kind: "pcc-printhost.operator-key", version: 1, algorithm: "secp256k1",
      purpose: "V-next operator EOA: D1 EIP-712 package signatures and submitEvidence transactions (testnet)",
      createdAt, ...expiry, address: operatorAddress, privateKey,
    }, 0o600, uid, writes);
    const identity: HostPublicIdentity = {
      kind: "pcc-printhost.public-identity", version: 1, createdAt, devicePublicKey, operatorAddress,
    };
    await writeExclusive(pinnedPaths.publicIdentityFile, paths.publicIdentityFile, identity, 0o644, uid, writes);
    const finalDirectory = await lstat(outDir);
    if (!finalDirectory.isDirectory() || finalDirectory.dev !== directory.dev || finalDirectory.ino !== directory.ino) {
      throw new KeyGenerationError("bad_directory", outDir);
    }
    if (finalDirectory.uid !== uid) throw new KeyGenerationError("bad_owner", outDir);
    if ((finalDirectory.mode & 0o077) !== 0) throw new KeyGenerationError("bad_mode", outDir);
    await directory.handle.sync();
    return { identity: Object.freeze(identity), paths: Object.freeze(paths) };
  } catch (error) {
    await rollback(writes);
    if (error instanceof KeyGenerationError) throw error;
    throw new KeyGenerationError("write_failed", outDir);
  } finally {
    seed?.fill(0);
    try { await directory.handle.close(); } catch { /* No raw platform error or secret escapes. */ }
  }
}
