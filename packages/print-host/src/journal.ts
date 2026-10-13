import { constants } from "node:fs";
import fs from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { GwCode, RelayEvidenceBundle } from "./gateway-client.js";
import { jobFileStem } from "./job-inputs.js";

export const JOURNAL_STATES = [
  "claimed", "in_progress_reported", "printing", "printed", "print_failed", "busy",
  "bundle_saved", "evidence_stored", "evidence_indeterminate", "evidence_refused",
  "abandoned", "interrupted", "simulated_refused",
] as const;
export type JournalState = typeof JOURNAL_STATES[number];
export type JournalCode = GwCode | "no_bundle" | "busy_retry_limit" | "host_shutdown";
export interface JournalRecord { at: string; jobId: string; state: JournalState; code?: JournalCode }

export type JournalErrorCode =
  | "journal_bad_id" | "journal_bad_directory" | "journal_bad_file" | "journal_invalid"
  | "journal_read_failed" | "journal_write_failed" | "journal_bundle_exists";
/** Closed errors deliberately omit paths, content, and filesystem causes. */
export class JournalError extends Error {
  constructor(readonly code: JournalErrorCode) { super(code); this.name = "JournalError"; }
}

export interface JobJournal {
  readonly directory: string;
  initialize(): Promise<void>;
  has(jobId: string): Promise<boolean>;
  append(jobId: string, state: JournalState, code?: JournalCode): Promise<void>;
  saveBundle(jobId: string, bundle: RelayEvidenceBundle): Promise<void>;
  read(jobId: string): Promise<readonly JournalRecord[]>;
  /** Last record of every existing journal, including completed jobs. */
  list(): Promise<readonly JournalRecord[]>;
  journalPath(jobId: string): string;
  bundlePath(jobId: string): string;
  /** The unit session creates this private per-job directory after claim. */
  sessionDirectory(jobId: string): string;
}

const codes = new Set<string>([
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
]);
const states = new Set<string>(JOURNAL_STATES);
const interruptedStates = new Set<JournalState>(["claimed", "in_progress_reported", "printing"]);

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
        if (Object.keys(value).some((key) => !["at", "jobId", "state", "code"].includes(key))
          || value.jobId !== jobId || typeof value.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.at)
          || !Number.isFinite(Date.parse(value.at)) || typeof value.state !== "string" || !states.has(value.state)
          || (Object.hasOwn(value, "code") && (typeof value.code !== "string" || !codes.has(value.code)))) {
          throw new JournalError("journal_invalid");
        }
        return value as unknown as JournalRecord;
      });
    } finally { await handle.close(); }
  }

  async function appendRaw(jobId: string, state: JournalState, code?: JournalCode): Promise<void> {
    if (!states.has(state) || (code !== undefined && !codes.has(code))) throw new JournalError("journal_invalid");
    const at = new Date(clock()).toISOString();
    const record: JournalRecord = { at, jobId, state, ...(code === undefined ? {} : { code }) };
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
        await prepare();
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
          if (last?.state !== "evidence_stored" && last?.state !== "interrupted") {
            await appendRaw(jobId, "interrupted");
          }
        }
      } catch (error) { throw safe(error, "journal_read_failed"); }
    })();
    return initialization;
  }

  async function serial<T>(operation: () => Promise<T>, fallback: JournalErrorCode): Promise<T> {
    await initialize();
    const result = pending.then(operation);
    pending = result.catch(() => undefined);
    try { return await result; } catch (error) { throw safe(error, fallback); }
  }

  return {
    directory,
    initialize,
    journalPath: (jobId) => path(jobId, ".jsonl"),
    bundlePath: (jobId) => path(jobId, ".bundle.json"),
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
    append: (jobId, state, code) => serial(() => appendRaw(jobId, state, code), "journal_write_failed"),
    read: (jobId) => serial(() => readRaw(jobId), "journal_read_failed"),
    list: () => serial(listRaw, "journal_read_failed"),
    saveBundle: (jobId, bundle) => serial(async () => {
      await checkDirectory();
      const bytes = Buffer.from(`${JSON.stringify(bundle)}\n`, "utf8");
      let handle;
      try {
        handle = await fs.open(path(jobId, ".bundle.json"), constants.O_WRONLY | constants.O_CREAT
          | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
        const opened = await handle.stat();
        if (!opened.isFile() || opened.uid !== expectedUid || (opened.mode & 0o777) !== 0o600) throw new JournalError("journal_bad_file");
        await handle.writeFile(bytes);
        await handle.sync();
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") throw new JournalError("journal_bundle_exists");
        throw error;
      } finally { bytes.fill(0); await handle?.close(); }
      await syncDirectory(directory);
    }, "journal_write_failed"),
  };
}
