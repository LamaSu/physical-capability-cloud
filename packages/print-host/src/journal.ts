import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseReceipt, type GwCode, type ReceiptEnvelope, type RelayEvidenceBundle } from "./gateway-client.js";
import type { signMilestonePackage } from "./package-builder.js";
import { jobFileStem } from "./job-inputs.js";

export const JOURNAL_STATES = [
  "claimed", "in_progress_reported", "printing", "printed", "print_failed", "busy",
  "bundle_saved", "evidence_stored", "evidence_indeterminate", "evidence_refused",
  "abandoned", "interrupted", "simulated_refused",
  "package_built", "receipt_stored", "submit_attempted", "submitted", "already_committed", "conflict", "refused", "submit_indeterminate",
] as const;
export type JournalState = typeof JOURNAL_STATES[number];
export const SUBMIT_CODES = [
  "package_inputs_missing", "submit_disabled", "package_invalid", "submit_absent",
  "submit_rpc_unavailable", "submit_refused", "submit_caps_exceeded", "submit_unknown",
  "submit_unreconciled", "receipt_conflict", "receipt_mismatch",
] as const;
export type JournalCode = GwCode | "no_bundle" | "busy_retry_limit" | "host_shutdown" | typeof SUBMIT_CODES[number];
export interface PackageHashes { packageDigest: string; evidenceBlockHash: string }
export interface TransactionHash { transactionHash: string }
export type JournalMetadata = PackageHashes | TransactionHash;
export type SignedMilestonePackage = Awaited<ReturnType<typeof signMilestonePackage>>;
export interface JournalRecord extends Partial<PackageHashes & TransactionHash> { at: string; jobId: string; state: JournalState; code?: JournalCode }

export type JournalErrorCode =
  | "journal_bad_id" | "journal_bad_directory" | "journal_bad_file" | "journal_invalid"
  | "journal_read_failed" | "journal_write_failed" | "journal_bundle_exists" | "data_dir_locked";
/** Closed errors deliberately omit paths, content, and filesystem causes. */
export class JournalError extends Error {
  constructor(readonly code: JournalErrorCode) { super(code); this.name = "JournalError"; }
}

export interface JobJournal {
  readonly directory: string;
  initialize(): Promise<void>;
  /** Release this instance's data-directory lock after outstanding writes. */
  close(): Promise<void>;
  has(jobId: string): Promise<boolean>;
  append(jobId: string, state: JournalState, code?: JournalCode, metadata?: JournalMetadata): Promise<void>;
  saveBundle(jobId: string, bundle: RelayEvidenceBundle): Promise<void>;
  readBundle(jobId: string): Promise<RelayEvidenceBundle>;
  savePackage(jobId: string, value: SignedMilestonePackage): Promise<void>;
  readPackage(jobId: string): Promise<SignedMilestonePackage | undefined>;
  saveReceipt(jobId: string, value: ReceiptEnvelope): Promise<void>;
  readReceipt(jobId: string): Promise<ReceiptEnvelope | undefined>;
  read(jobId: string): Promise<readonly JournalRecord[]>;
  /** Last record of every existing journal, including completed jobs. */
  list(): Promise<readonly JournalRecord[]>;
  journalPath(jobId: string): string;
  bundlePath(jobId: string): string;
  packagePath(jobId: string): string;
  receiptPath(jobId: string): string;
  /** The unit session creates this private per-job directory after claim. */
  sessionDirectory(jobId: string): string;
}

const codes = new Set<string>([
  ...SUBMIT_CODES,
  "unauthenticated", "not_kernel_operator", "operator_proof_required", "job_has_no_kernel",
  "insufficient_scope", "blocked_by_policy", "forbidden", "kernel_not_found", "route_unavailable",
  "rate_limited", "bad_request", "unavailable", "server_error", "network", "timeout",
  "malformed_response", "job_not_found", "settlement_owned_status", "job_kernel_changed",
  "invalid_status", "payload_too_large", "bad_bundle", "stored_mismatch", "not_stored",
  "evidence_refused", "indeterminate", "no_bundle", "busy_retry_limit", "host_shutdown",
  "spend_not_approved", "idempotency_conflict", "reconciliation_required",
  "kernel_unowned", "kernel_mismatch", "job_not_active",
  "carrier_record_ownership_mismatch", "carrier_not_configured",
  "missing_fields", "invalid_parcel", "invalid_document_hash",
  "provider_mode_not_production", "weight_exceeds_ceiling", "rate_exceeds_ceiling",
  "receipt_exists", "receipt_signer_unavailable",
]);
const states = new Set<string>(JOURNAL_STATES);
const interruptedStates = new Set<JournalState>(["claimed", "in_progress_reported", "printing"]);
function validMetadata(state: unknown, value: Partial<PackageHashes & TransactionHash>): boolean {
  const valid = (word: unknown) => typeof word === "string" && /^0x[0-9a-f]{64}$/.test(word);
  const packageValid = state === "package_built" ? valid(value.packageDigest) && valid(value.evidenceBlockHash)
    : !Object.hasOwn(value, "packageDigest") && !Object.hasOwn(value, "evidenceBlockHash");
  return packageValid && (!Object.hasOwn(value, "transactionHash")
    || (state === "submit_attempted" && valid(value.transactionHash)));
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function safe(error: unknown, fallback: JournalErrorCode): JournalError {
  return error instanceof JournalError ? error : new JournalError(fallback);
}

/** Every resolved write has synced its descriptor and directory before the host acts. */
export function createJobJournal(dataDir: string, clock: () => number = Date.now): JobJournal {
  const directory = join(dataDir, "journal");
  const sessionsDirectory = join(dataDir, "sessions");
  const expectedUid = process.getuid?.();
  let initialization: Promise<void> | undefined;
  let pending: Promise<unknown> = Promise.resolve();
  const lockPath = join(directory, ".lock");
  let heldLock: { dev: number; ino: number } | undefined;
  let closed = false;

  function path(jobId: string, suffix: string): string {
    const stem = jobFileStem(jobId);
    if (stem === undefined) throw new JournalError("journal_bad_id");
    return join(directory, `${stem}${suffix}`);
  }

  function sessionDirectory(jobId: string): string {
    const stem = jobFileStem(jobId);
    // A bare directory name has no suffix to keep dot entries from resolving
    // to the sessions root or its parent, unlike the journal file basenames.
    if (stem === undefined || stem === "." || stem === "..") throw new JournalError("journal_bad_id");
    return join(sessionsDirectory, stem);
  }

  async function syncDirectory(dir: string): Promise<void> {
    const handle = await fs.open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async function checkDirectory(): Promise<void> {
    if (!isAbsolute(dataDir) || expectedUid === undefined) throw new JournalError("journal_bad_directory");
    for (const dir of [dataDir, directory, sessionsDirectory]) {
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== expectedUid
        || (stat.mode & 0o777) !== 0o700) throw new JournalError("journal_bad_directory");
    }
  }

  async function prepare(): Promise<void> {
    if (!isAbsolute(dataDir) || expectedUid === undefined) throw new JournalError("journal_bad_directory");
    const parent = await fs.lstat(dataDir);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== expectedUid
      || (parent.mode & 0o777) !== 0o700) throw new JournalError("journal_bad_directory");
    for (const dir of [directory, sessionsDirectory]) {
      try {
        await fs.mkdir(dir, { mode: 0o700 });
        await syncDirectory(dataDir);
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
      }
    }
    await checkDirectory();
  }

  interface LockIdentity { pid: number; startTime: string; bootId: string }

  function startTime(stat: string): string {
    // comm (field 2) may contain spaces and parentheses. Fields after its last
    // closing parenthesis begin with state (field 3), so field 22 is index 19.
    const end = stat.lastIndexOf(")");
    const value = end < 0 ? undefined : stat.slice(end + 1).trim().split(/\s+/)[19];
    if (!value || !/^[1-9][0-9]*$/.test(value)) throw new JournalError("data_dir_locked");
    return value;
  }

  async function processIdentity(): Promise<LockIdentity> {
    try {
      const bootId = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(bootId)) throw new JournalError("data_dir_locked");
      return { pid: process.pid, startTime: startTime(await fs.readFile("/proc/self/stat", "utf8")), bootId };
    } catch { throw new JournalError("data_dir_locked"); }
  }

  async function acquireLock(): Promise<void> {
    const identity = await processIdentity();
    for (let retry = 0; retry < 3; retry++) {
      let handle;
      try {
        handle = await fs.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        const stat = await handle.stat();
        heldLock = { dev: stat.dev, ino: stat.ino };
        await handle.writeFile(`${JSON.stringify(identity)}\n`);
        await handle.sync();
        await syncDirectory(directory);
        return;
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) {
          throw new JournalError("data_dir_locked");
        }
      } finally { await handle?.close(); }

      try {
        const before = await fs.lstat(lockPath);
        if (!before.isFile() || before.isSymbolicLink() || before.uid !== expectedUid
          || (before.mode & 0o777) !== 0o600 || before.size > 2_048) throw new JournalError("data_dir_locked");
        const reader = await fs.open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let lock: LockIdentity;
        try {
          const opened = await reader.stat();
          if (opened.dev !== before.dev || opened.ino !== before.ino) continue;
          const value: unknown = JSON.parse(await reader.readFile("utf8"));
          if (typeof value !== "object" || value === null || Array.isArray(value)) throw new JournalError("data_dir_locked");
          const record = value as Record<string, unknown>;
          if (Object.keys(record).sort().join(",") !== "bootId,pid,startTime"
            || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0
            || typeof record.startTime !== "string" || !/^[1-9][0-9]*$/.test(record.startTime)
            || typeof record.bootId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(record.bootId)) {
            throw new JournalError("data_dir_locked");
          }
          lock = record as unknown as LockIdentity;
        } finally { await reader.close(); }
        let stale = lock.bootId !== identity.bootId;
        if (!stale) {
          try { stale = startTime(await fs.readFile(`/proc/${lock.pid}/stat`, "utf8")) !== lock.startTime; }
          catch (error) { if (isMissing(error)) stale = true; else throw new JournalError("data_dir_locked"); }
        }
        if (!stale) throw new JournalError("data_dir_locked");
        const current = await fs.lstat(lockPath);
        if (current.dev !== before.dev || current.ino !== before.ino) continue;
        // O_EXCL decides the replacement winner. There remains a narrow race
        // between this inode check and unlink during concurrent stale takeover;
        // operators must not launch simultaneous replacements of a stale lock.
        await fs.unlink(lockPath);
        await syncDirectory(directory);
      } catch (error) {
        if (isMissing(error)) continue;
        throw new JournalError("data_dir_locked");
      }
    }
    throw new JournalError("data_dir_locked");
  }

  async function releaseLock(): Promise<void> {
    if (!heldLock) return;
    try {
      const stat = await fs.lstat(lockPath);
      if (stat.dev !== heldLock.dev || stat.ino !== heldLock.ino) throw new JournalError("data_dir_locked");
      await fs.unlink(lockPath);
      await syncDirectory(directory);
      heldLock = undefined;
    } catch (error) {
      if (isMissing(error)) { heldLock = undefined; return; }
      throw safe(error, "data_dir_locked");
    }
  }

  async function readRaw(jobId: string): Promise<JournalRecord[]> {
    await checkDirectory();
    const filePath = path(jobId, ".jsonl");
    let before;
    try { before = await fs.lstat(filePath); } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== expectedUid
      || (before.mode & 0o777) !== 0o600) throw new JournalError("journal_bad_file");
    const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()
        || opened.uid !== expectedUid || (opened.mode & 0o777) !== 0o600) throw new JournalError("journal_bad_file");
      if (opened.size > 4 * 1024 * 1024) throw new JournalError("journal_invalid");
      const text = await handle.readFile("utf8");
      if (!text || !text.endsWith("\n") || Buffer.byteLength(text) > 4 * 1024 * 1024) throw new JournalError("journal_invalid");
      return text.slice(0, -1).split("\n").map((line) => {
        let record: unknown;
        try { record = JSON.parse(line); } catch { throw new JournalError("journal_invalid"); }
        if (typeof record !== "object" || record === null || Array.isArray(record)) throw new JournalError("journal_invalid");
        const value = record as Record<string, unknown>;
        if (Object.keys(value).some((key) => !["at", "jobId", "state", "code", "packageDigest", "evidenceBlockHash", "transactionHash"].includes(key))
          || value.jobId !== jobId || typeof value.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.at)
          || !Number.isFinite(Date.parse(value.at)) || typeof value.state !== "string" || !states.has(value.state)
          || (Object.hasOwn(value, "code") && (typeof value.code !== "string" || !codes.has(value.code)))
          || !validMetadata(value.state, value)) {
          throw new JournalError("journal_invalid");
        }
        return value as unknown as JournalRecord;
      });
    } finally { await handle.close(); }
  }

  async function appendRaw(jobId: string, state: JournalState, code?: JournalCode, metadata?: JournalMetadata): Promise<void> {
    // Snapshot before validation so an accessor or concurrent caller cannot
    // substitute non-hash text between the check and JSON serialization.
    const publicHashes: Partial<PackageHashes & TransactionHash> = {};
    if (metadata !== undefined) {
      for (const key of Object.keys(metadata)) {
        if (!["packageDigest", "evidenceBlockHash", "transactionHash"].includes(key)) throw new JournalError("journal_invalid");
        publicHashes[key as keyof typeof publicHashes] = (metadata as unknown as Record<string, string>)[key];
      }
    }
    if (!states.has(state) || (code !== undefined && !codes.has(code)) || !validMetadata(state, publicHashes)) throw new JournalError("journal_invalid");
    const at = new Date(clock()).toISOString();
    const record: JournalRecord = { at, jobId, state, ...(code === undefined ? {} : { code }), ...publicHashes };
    await checkDirectory();
    const filePath = path(jobId, ".jsonl");
    let before;
    try { before = await fs.lstat(filePath); } catch (error) { if (!isMissing(error)) throw error; }
    if (before && (!before.isFile() || before.isSymbolicLink() || before.uid !== expectedUid
      || (before.mode & 0o777) !== 0o600)) throw new JournalError("journal_bad_file");
    const handle = await fs.open(filePath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT
      | constants.O_NOFOLLOW | constants.O_NONBLOCK | (before ? 0 : constants.O_EXCL), 0o600);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.uid !== expectedUid || (opened.mode & 0o777) !== 0o600
        || (before && (opened.dev !== before.dev || opened.ino !== before.ino))) throw new JournalError("journal_bad_file");
      await handle.writeFile(`${JSON.stringify(record)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    await syncDirectory(directory);
  }

  async function listRaw(): Promise<JournalRecord[]> {
    await checkDirectory();
    const records: JournalRecord[] = [];
    const files = (await fs.readdir(directory)).filter((name) => name.endsWith(".jsonl")).sort();
    for (const file of files) {
      let jobId: string;
      try { jobId = decodeURIComponent(file.slice(0, -6)); } catch { throw new JournalError("journal_invalid"); }
      if (path(jobId, ".jsonl") !== join(directory, file)) throw new JournalError("journal_invalid");
      const entries = await readRaw(jobId);
      if (entries.length) records.push(entries[entries.length - 1]);
    }
    return records;
  }

  function initialize(): Promise<void> {
    initialization ??= (async () => {
      try {
        if (closed) throw new JournalError("data_dir_locked");
        await prepare();
        await acquireLock();
        const latest = new Map((await listRaw()).map((record) => [record.jobId, record]));
        for (const record of latest.values()) {
          if (interruptedStates.has(record.state)) {
            await appendRaw(record.jobId, "interrupted");
            latest.set(record.jobId, { ...record, state: "interrupted" });
          }
        }
        // A session journal is public evidence of a previous claim. Even if the
        // host journal write was lost, never reopen it, reprint, or post on restart.
        // Only a durable stored receipt establishes that reconciliation is done.
        for (const name of (await fs.readdir(sessionsDirectory)).sort()) {
          let jobId: string;
          try { jobId = decodeURIComponent(name); } catch { throw new JournalError("journal_invalid"); }
          const dir = sessionDirectory(jobId);
          if (dir !== join(sessionsDirectory, name)) throw new JournalError("journal_invalid");
          const stat = await fs.lstat(dir);
          if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== expectedUid
            || (stat.mode & 0o777) !== 0o700) throw new JournalError("journal_bad_directory");
          const last = latest.get(jobId);
          const stored = last && (await readRaw(jobId)).some((record) => record.state === "evidence_stored");
          if (!stored && last?.state !== "interrupted") {
            await appendRaw(jobId, "interrupted");
          }
        }
      } catch (error) {
        await releaseLock();
        throw safe(error, "journal_read_failed");
      }
    })();
    return initialization;
  }

  async function serial<T>(operation: () => Promise<T>, fallback: JournalErrorCode): Promise<T> {
    await initialize();
    const result = pending.then(operation);
    pending = result.catch(() => undefined);
    try { return await result; } catch (error) { throw safe(error, fallback); }
  }

  async function readArtifact(jobId: string, suffix: string, limit: number): Promise<unknown | undefined> {
    await checkDirectory();
    const filePath = path(jobId, suffix);
    let before;
    try { before = await fs.lstat(filePath); } catch (error) { if (isMissing(error)) return undefined; throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== expectedUid
      || (before.mode & 0o777) !== 0o600) throw new JournalError("journal_bad_file");
    const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()
        || opened.uid !== expectedUid || (opened.mode & 0o777) !== 0o600) throw new JournalError("journal_bad_file");
      if (opened.size > limit) throw new JournalError("journal_invalid");
      const bytes = Buffer.alloc(limit + 1);
      try {
        let length = 0;
        while (length < bytes.length) {
          const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > limit) throw new JournalError("journal_invalid");
        try { return JSON.parse(bytes.subarray(0, length).toString("utf8")); }
        catch { throw new JournalError("journal_invalid"); }
      } finally { bytes.fill(0); }
    } finally { await handle.close(); }
  }

  async function saveArtifact(jobId: string, suffix: string, value: unknown): Promise<void> {
    await checkDirectory();
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    const finalPath = path(jobId, suffix);
    const tempPath = `${finalPath}.tmp-${randomBytes(16).toString("hex")}`;
    let handle;
    let created = false;
    try {
      handle = await fs.open(tempPath, constants.O_WRONLY | constants.O_CREAT
        | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      created = true;
      const opened = await handle.stat();
      if (!opened.isFile() || opened.uid !== expectedUid || (opened.mode & 0o777) !== 0o600) throw new JournalError("journal_bad_file");
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      // link never overwrites an existing final artifact. A crash before this
      // point leaves only a disposable temp file; after it, the artifact is whole.
      await fs.link(tempPath, finalPath);
      await fs.unlink(tempPath);
      created = false;
      await syncDirectory(directory);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") throw new JournalError("journal_bundle_exists");
      throw error;
    } finally {
      bytes.fill(0);
      await handle?.close();
      if (created) await fs.unlink(tempPath).catch(() => undefined);
    }
  }

  function writing<T>(operation: () => Promise<T>): Promise<T> {
    return serial(async () => {
      if (closed || !heldLock) throw new JournalError("data_dir_locked");
      return operation();
    }, "journal_write_failed");
  }

  return {
    directory,
    initialize,
    close: async () => {
      if (initialization) await initialization.catch(() => undefined);
      await pending;
      closed = true;
      await releaseLock();
    },
    journalPath: (jobId) => path(jobId, ".jsonl"),
    bundlePath: (jobId) => path(jobId, ".bundle.json"),
    packagePath: (jobId) => path(jobId, ".package.json"),
    receiptPath: (jobId) => path(jobId, ".receipt.json"),
    sessionDirectory,
    has: (jobId) => serial(async () => {
      await checkDirectory();
      try {
        const stat = await fs.lstat(path(jobId, ".jsonl"));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid
          || (stat.mode & 0o777) !== 0o600) throw new JournalError("journal_bad_file");
        return true;
      } catch (error) { if (isMissing(error)) return false; throw error; }
    }, "journal_read_failed"),
    append: (jobId, state, code, hashes) => writing(() => appendRaw(jobId, state, code, hashes)),
    read: (jobId) => serial(() => readRaw(jobId), "journal_read_failed"),
    list: () => serial(listRaw, "journal_read_failed"),
    saveBundle: (jobId, bundle) => writing(() => saveArtifact(jobId, ".bundle.json", bundle)),
    readBundle: (jobId) => serial(async () => {
      const bundle = await readArtifact(jobId, ".bundle.json", 4 * 1024 * 1024);
      if (!bundle) throw new JournalError("journal_invalid");
      return bundle as RelayEvidenceBundle;
    }, "journal_read_failed"),
    savePackage: (jobId, value) => writing(() => saveArtifact(jobId, ".package.json", value)),
    readPackage: (jobId) => serial(async () => await readArtifact(jobId, ".package.json", 128 * 1024) as SignedMilestonePackage | undefined, "journal_read_failed"),
    saveReceipt: (jobId, value) => writing(async () => {
      const parsed = parseReceipt(value);
      if (!parsed) throw new JournalError("journal_invalid");
      await saveArtifact(jobId, ".receipt.json", parsed);
    }),
    readReceipt: (jobId) => serial(async () => {
      const value = await readArtifact(jobId, ".receipt.json", 16 * 1024);
      if (value === undefined) return undefined;
      const parsed = parseReceipt(value);
      if (!parsed) throw new JournalError("journal_invalid");
      return parsed;
    }, "journal_read_failed"),
  };
}
