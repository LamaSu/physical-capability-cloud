import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { WalletError } from "./errors.js";
import { validateTransportUrl } from "./http.js";
import { generateWalletKeys, validateWalletKeys } from "./keys.js";

export type Role = "agent" | "device";
export type KeyType = "secp256k1" | "ed25519";
export interface WalletRecord {
  kind: "pcc-wallet";
  version: 1;
  label: string;
  role: Role;
  keyType: KeyType;
  address?: `0x${string}`;
  publicKey?: string;
  privateKey?: `0x${string}`;
  seed?: string;
  chainId: number;
  gatewayOrigin: string;
  createdAt: string;
  link: { requestId?: string; linkId?: string; accountId?: string; status?: string };
}

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const CREATE_FLAGS = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
const LABEL = /^[A-Za-z0-9._@-]{1,64}$/;
const RECORD_FIELDS = new Set([
  "kind", "version", "label", "role", "keyType", "address", "publicKey", "privateKey",
  "seed", "chainId", "gatewayOrigin", "createdAt", "link",
]);
const LINK_FIELDS = new Set(["requestId", "linkId", "accountId", "status"]);
const LINK_STATUSES = new Set([
  "pending_proof", "awaiting_approval", "authorization_pending", "slow_down",
  "approved", "denied", "expired", "failed", "revoked",
]);
const LINK_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function validateLabel(label: string): void {
  if (typeof label !== "string" || !LABEL.test(label)) throw new WalletError("invalid_label");
}

function requirePosix(): void {
  if (process.platform === "win32") throw new WalletError("Windows wallet storage is not supported in v1");
  if (typeof process.getuid !== "function" || constants.O_NOFOLLOW === undefined) {
    throw new WalletError("wallet_ownership_checks_unavailable");
  }
}

function storageDirectory(): string {
  return resolve(process.env.PCC_WALLET_DIR || join(homedir(), ".pcc", "wallets"));
}

export function walletPath(label: string): string {
  validateLabel(label);
  return join(storageDirectory(), `${label}.json`);
}

function optionalStat(path: string): Stats | undefined {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertOwner(stat: Stats, code: string): void {
  if (stat.uid !== process.getuid!()) throw new WalletError(code);
}

function assertDirectory(stat: Stats): void {
  if (stat.isSymbolicLink()) throw new WalletError("wallet_directory_symlink_refused");
  if (!stat.isDirectory()) throw new WalletError("wallet_directory_not_directory");
  assertOwner(stat, "wallet_directory_owner_mismatch");
  if ((stat.mode & 0o077) !== 0) throw new WalletError("wallet_directory_permissions_refused");
}

function assertParentDirectory(stat: Stats, directory: string): void {
  if (stat.isSymbolicLink()) throw new WalletError("wallet_directory_symlink_refused");
  if (!stat.isDirectory()) throw new WalletError("wallet_directory_not_directory");
  if (stat.uid !== process.getuid!() && stat.uid !== 0) {
    throw new WalletError(`wallet_directory_owner_mismatch: ${JSON.stringify(directory)}`);
  }
  if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) {
    throw new WalletError(`wallet_directory_permissions_refused: ${JSON.stringify(directory)}; run chmod 700 ${JSON.stringify(directory)}`);
  }
}

function assertFile(stat: Stats): void {
  if (stat.isSymbolicLink()) throw new WalletError("wallet_file_symlink_refused");
  if (!stat.isFile()) throw new WalletError("wallet_file_not_regular");
  assertOwner(stat, "wallet_file_owner_mismatch");
  if ((stat.mode & 0o7777) !== 0o600) throw new WalletError("wallet_file_mode_refused");
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** The key directory stays private; resolved ancestors follow safe_path rules. */
function assertSafeAncestors(directory: string): void {
  const directoryStat = optionalStat(directory);
  if (directoryStat?.isSymbolicLink()) throw new WalletError("wallet_directory_symlink_refused");
  if (directoryStat && !directoryStat.isDirectory()) throw new WalletError("wallet_directory_not_directory");
  let existingParent = dirname(directory);
  while (!optionalStat(existingParent)) {
    const parent = dirname(existingParent);
    if (parent === existingParent) throw new WalletError("wallet_directory_unavailable");
    existingParent = parent;
  }
  let current = realpathSync(existingParent);
  for (;;) {
    assertParentDirectory(lstatSync(current), current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function makeDirectories(directory: string): void {
  assertSafeAncestors(directory);
  const missing: string[] = [];
  let current = directory;
  while (!optionalStat(current)) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) throw new WalletError("wallet_directory_unavailable");
    current = parent;
  }
  for (const path of missing.reverse()) {
    let created = false;
    try { mkdirSync(path, { mode: DIR_MODE }); created = true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (created) {
      // A restrictive umask can remove owner bits as well. Restore only the
      // directory we just created, checking its identity around that chmod.
      const before = lstatSync(path);
      assertDirectory(before);
      chmodSync(path, DIR_MODE);
      const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
      try {
        const opened = fstatSync(descriptor);
        assertDirectory(opened);
        if (!sameFile(before, opened)) throw new WalletError("wallet_storage_changed");
        fchmodSync(descriptor, DIR_MODE);
        assertDirectory(fstatSync(descriptor));
        const after = lstatSync(path);
        assertDirectory(after);
        if (!sameFile(before, after)) throw new WalletError("wallet_storage_changed");
      } finally { closeSync(descriptor); }
    }
    assertDirectory(lstatSync(path));
  }
}

function checkStorage(create: boolean): Stats {
  requirePosix();
  const directory = storageDirectory();
  if (create) makeDirectories(directory);
  else assertSafeAncestors(directory);
  const stat = lstatSync(directory);
  assertDirectory(stat);
  return stat;
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function wrap(error: unknown): never {
  if (error instanceof WalletError) throw error;
  switch ((error as NodeJS.ErrnoException | null)?.code) {
    case "ENOENT": throw new WalletError("wallet_not_found");
    case "EEXIST": throw new WalletError("wallet_file_already_exists");
    case "ELOOP": throw new WalletError("wallet_symlink_refused");
    default: throw new WalletError("wallet_storage_failed");
  }
}

function validateLink(link: unknown): asserts link is WalletRecord["link"] {
  if (link === null || typeof link !== "object" || Array.isArray(link)) throw new WalletError("invalid_keystore");
  for (const [key, value] of Object.entries(link)) {
    if (!LINK_FIELDS.has(key) || typeof value !== "string"
      || (key === "status" ? !LINK_STATUSES.has(value) : key !== "accountId" && !LINK_ID.test(value))) throw new WalletError("invalid_keystore");
  }
}

function validateRecord(record: unknown, label: string): asserts record is WalletRecord {
  if (record === null || typeof record !== "object" || Array.isArray(record)) throw new WalletError("invalid_keystore");
  const data = record as WalletRecord;
  if (Object.keys(data).some((key) => !RECORD_FIELDS.has(key)) || data.kind !== "pcc-wallet" || data.version !== 1
    || data.label !== label || !LABEL.test(data.label) || !["agent", "device"].includes(data.role)
    || !["secp256k1", "ed25519"].includes(data.keyType) || data.chainId !== 84532
    || typeof data.gatewayOrigin !== "string" || typeof data.createdAt !== "string"
    || !Number.isFinite(Date.parse(data.createdAt))
    || new Date(data.createdAt).toISOString() !== data.createdAt) throw new WalletError("invalid_keystore");
  try {
    const gateway = validateTransportUrl(data.gatewayOrigin);
    if (gateway.origin !== data.gatewayOrigin) throw new WalletError("invalid_keystore");
  } catch { throw new WalletError("invalid_keystore"); }
  validateLink(data.link);
  validateWalletKeys(data);
}

export function createWallet(input: Pick<WalletRecord,
  "label" | "role" | "keyType" | "chainId" | "gatewayOrigin" | "createdAt"
>): WalletRecord {
  let descriptor: number | undefined;
  let created = false;
  let createdStat: Stats | undefined;
  let path: string | undefined;
  try {
    requirePosix();
    validateLabel(input.label);
    if (input.chainId !== 84532) throw new WalletError("unsupported_chain");
    if (input.role !== "agent" && input.role !== "device") throw new WalletError("unsupported_role");
    if (input.keyType !== "secp256k1" && input.keyType !== "ed25519") throw new WalletError("unsupported_key_type");
    const directoryStat = checkStorage(true);
    path = walletPath(input.label);
    // A regular existing file proceeds to the exclusive open; it is never replaced.
    if (optionalStat(path)?.isSymbolicLink()) throw new WalletError("wallet_file_symlink_refused");
    descriptor = openSync(path, CREATE_FLAGS, FILE_MODE);
    created = true;
    createdStat = fstatSync(descriptor);
    fchmodSync(descriptor, FILE_MODE);
    assertFile(fstatSync(descriptor));
    const wallet: WalletRecord = { kind: "pcc-wallet", version: 1, ...input, ...generateWalletKeys(input.keyType), link: {} };
    validateRecord(wallet, input.label);
    writeFileSync(descriptor, `${JSON.stringify(wallet, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    const descriptorStat = fstatSync(descriptor);
    assertFile(descriptorStat);
    const pathStat = lstatSync(path);
    assertFile(pathStat);
    if (!sameFile(descriptorStat, pathStat) || !sameFile(directoryStat, lstatSync(storageDirectory()))) {
      throw new WalletError("wallet_storage_changed");
    }
    closeSync(descriptor);
    descriptor = undefined;
    fsyncDirectory(storageDirectory());
    return wallet;
  } catch (error) {
    if (descriptor !== undefined) { try { closeSync(descriptor); } catch { /* public error only */ } }
    if (created && path && createdStat) {
      try {
        const current = optionalStat(path);
        if (current && !current.isSymbolicLink() && sameFile(createdStat, current)) unlinkSync(path);
      } catch { /* public error only */ }
    }
    return wrap(error);
  }
}

function checkedRead(label: string): { wallet: WalletRecord; stat: Stats } {
  validateLabel(label);
  checkStorage(false);
  const path = walletPath(label);
  const before = lstatSync(path);
  assertFile(before);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    assertFile(stat);
    if (!sameFile(before, stat)) throw new WalletError("wallet_storage_changed");
    const record: unknown = JSON.parse(readFileSync(descriptor, "utf8"));
    validateRecord(record, label);
    return { wallet: record, stat };
  } finally { closeSync(descriptor); }
}

export function readWallet(label: string): WalletRecord {
  try { return checkedRead(label).wallet; } catch (error) { return wrap(error); }
}

export function updateLink(wallet: WalletRecord, link: WalletRecord["link"]): WalletRecord {
  let descriptor: number | undefined;
  let temporary: string | undefined;
  let createdStat: Stats | undefined;
  try {
    const current = checkedRead(wallet.label);
    if (current.wallet.keyType !== wallet.keyType || current.wallet.address !== wallet.address
      || current.wallet.publicKey !== wallet.publicKey) throw new WalletError("wallet_storage_changed");
    validateLink(link);
    const updated = { ...current.wallet, link: { ...link } };
    temporary = join(storageDirectory(), `.${wallet.label}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`);
    descriptor = openSync(temporary, CREATE_FLAGS, FILE_MODE);
    createdStat = fstatSync(descriptor);
    fchmodSync(descriptor, FILE_MODE);
    assertFile(fstatSync(descriptor));
    writeFileSync(descriptor, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    const temporaryStat = fstatSync(descriptor);
    assertFile(temporaryStat);
    closeSync(descriptor);
    descriptor = undefined;
    const temporaryPathStat = lstatSync(temporary);
    assertFile(temporaryPathStat);
    if (!sameFile(temporaryStat, temporaryPathStat)) throw new WalletError("wallet_storage_changed");
    checkStorage(false);
    const target = walletPath(wallet.label);
    const targetStat = lstatSync(target);
    assertFile(targetStat);
    if (!sameFile(current.stat, targetStat)) throw new WalletError("wallet_storage_changed");
    renameSync(temporary, target);
    temporary = undefined;
    assertFile(lstatSync(target));
    fsyncDirectory(storageDirectory());
    return updated;
  } catch (error) {
    return wrap(error);
  } finally {
    if (descriptor !== undefined) { try { closeSync(descriptor); } catch { /* public error only */ } }
    if (temporary && createdStat) {
      try {
        const current = optionalStat(temporary);
        if (current && !current.isSymbolicLink() && sameFile(createdStat, current)) unlinkSync(temporary);
      } catch { /* public error only */ }
    }
  }
}
