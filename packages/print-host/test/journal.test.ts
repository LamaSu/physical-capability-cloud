import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJobJournal, JournalError, type JournalCode, type JournalState } from "../src/journal.js";
import type { RelayEvidenceBundle } from "../src/gateway-client.js";

let dir: string;
const jobId = "job-journal-1";
const at = "2026-10-15T17:00:00.000Z";
const time = () => Date.parse(at);
const bundle: RelayEvidenceBundle = {
  events: [], bundleHash: `sha256:${"a".repeat(64)}`,
  kernelSignature: { signer: `0x${"b".repeat(40)}`, algorithm: "ed25519", value: "c".repeat(128) },
};

beforeEach(async () => { dir = await fs.mkdtemp(join(tmpdir(), "print-host-journal-")); await fs.chmod(dir, 0o700); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }); });

describe("job journal", () => {
  it("writes only ordered closed records with private file and directory modes", async () => {
    const journal = createJobJournal(dir, time);
    const states: JournalState[] = ["claimed", "in_progress_reported", "printing", "printed", "bundle_saved", "evidence_stored"];
    for (const state of states) await journal.append(jobId, state);
    const records = await journal.read(jobId);
    expect(records).toEqual(states.map((state) => ({ at, jobId, state })));
    expect(await journal.has(jobId)).toBe(true);
    expect(await journal.has("another-job")).toBe(false);
    expect(await journal.list()).toEqual([{ at, jobId, state: "evidence_stored" }]);
    const lines = (await fs.readFile(journal.journalPath(jobId), "utf8")).trimEnd().split("\n");
    expect(lines).toEqual(states.map((state) => JSON.stringify({ at, jobId, state })));
    expect((await fs.stat(journal.directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(join(dir, "sessions"))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(journal.journalPath(jobId))).mode & 0o777).toBe(0o600);
  });

  it("saves the signed bundle as a private synced file and refuses overwriting it", async () => {
    const journal = createJobJournal(dir, time);
    await journal.append(jobId, "printed");
    await journal.saveBundle(jobId, bundle);
    expect(JSON.parse(await fs.readFile(journal.bundlePath(jobId), "utf8"))).toEqual(bundle);
    expect((await fs.stat(journal.bundlePath(jobId))).mode & 0o777).toBe(0o600);
    await expect(journal.saveBundle(jobId, bundle)).rejects.toMatchObject({ code: "journal_bundle_exists" });
  });

  it.each(["claimed", "in_progress_reported", "printing"] as const)("a restart makes %s interrupted exactly once", async (state) => {
    const original = createJobJournal(dir, time);
    await original.append(jobId, state);
    const restarted = createJobJournal(dir, time);
    await restarted.initialize();
    await restarted.initialize();
    expect((await restarted.read(jobId)).map((record) => record.state)).toEqual([state, "interrupted"]);
    expect(await restarted.has(jobId)).toBe(true);
  });

  it.each(["busy", "bundle_saved", "evidence_indeterminate", "evidence_stored", "abandoned"] as const)(
    "a restart retains %s and the existing journal exclusion", async (state) => {
      const original = createJobJournal(dir, time);
      await original.append(jobId, state);
      const restarted = createJobJournal(dir, time);
      expect((await restarted.read(jobId)).map((record) => record.state)).toEqual([state]);
      expect(await restarted.has(jobId)).toBe(true);
    },
  );

  it.each(["busy", "printed", "print_failed", "bundle_saved", "evidence_indeterminate", "evidence_refused", "simulated_refused"] as const)(
    "a session without a stored receipt makes %s interrupted on restart", async (state) => {
      const original = createJobJournal(dir, time);
      await original.append(jobId, state);
      await fs.mkdir(original.sessionDirectory(jobId), { mode: 0o700 });
      await fs.writeFile(join(original.sessionDirectory(jobId), "00000000.json"), "{}", { mode: 0o600 });
      const restarted = createJobJournal(dir, time);
      await restarted.initialize();
      await restarted.initialize();
      expect((await restarted.read(jobId)).map((record) => record.state)).toEqual([state, "interrupted"]);
      expect(await restarted.has(jobId)).toBe(true);
      const nextRestart = createJobJournal(dir, time);
      expect((await nextRestart.read(jobId)).map((record) => record.state)).toEqual([state, "interrupted"]);
    },
  );

  it("excludes an orphan session whose host journal was never saved", async () => {
    const original = createJobJournal(dir, time);
    await original.initialize();
    await fs.mkdir(original.sessionDirectory(jobId), { mode: 0o700 });
    await fs.writeFile(join(original.sessionDirectory(jobId), "00000000.json"), "{}", { mode: 0o600 });
    const restarted = createJobJournal(dir, time);
    expect(await restarted.has(jobId)).toBe(true);
    expect(await restarted.list()).toEqual([{ at, jobId, state: "interrupted" }]);
    expect(await fs.readdir(restarted.directory)).toEqual([`${jobId}.jsonl`]);
  });

  it("retains a session with a durable evidence-stored receipt", async () => {
    const original = createJobJournal(dir, time);
    await original.append(jobId, "evidence_stored");
    await fs.mkdir(original.sessionDirectory(jobId), { mode: 0o700 });
    const restarted = createJobJournal(dir, time);
    expect((await restarted.read(jobId)).map((record) => record.state)).toEqual(["evidence_stored"]);
    expect(await restarted.has(jobId)).toBe(true);
  });

  it("encodes the session basename and refuses invalid IDs", () => {
    const journal = createJobJournal(dir, time);
    expect(journal.sessionDirectory("../outside")).toBe(join(dir, "sessions", "..%2Foutside"));
    expect(() => journal.sessionDirectory(".")).toThrowError("journal_bad_id");
    expect(() => journal.sessionDirectory("..")).toThrowError("journal_bad_id");
    expect(() => journal.sessionDirectory("bad\njob")).toThrowError("journal_bad_id");
    expect(() => journal.sessionDirectory("\ud800")).toThrowError("journal_bad_id");
  });

  it("refuses symlink or insecure session roots and per-job session directories", async () => {
    const original = createJobJournal(dir, time);
    await original.initialize();
    await fs.mkdir(original.sessionDirectory(jobId), { mode: 0o755 });
    await expect(createJobJournal(dir, time).initialize()).rejects.toMatchObject({ code: "journal_bad_directory" });
    await fs.chmod(original.sessionDirectory(jobId), 0o700);
    await fs.rename(original.sessionDirectory(jobId), join(dir, "actual-session"));
    await fs.symlink(join(dir, "actual-session"), original.sessionDirectory(jobId));
    await expect(createJobJournal(dir, time).initialize()).rejects.toMatchObject({ code: "journal_bad_directory" });
    await fs.unlink(original.sessionDirectory(jobId));
    await fs.chmod(join(dir, "sessions"), 0o755);
    await expect(createJobJournal(dir, time).initialize()).rejects.toMatchObject({ code: "journal_bad_directory" });
    await fs.rmdir(join(dir, "sessions"));
    await fs.symlink(join(dir, "actual-session"), join(dir, "sessions"));
    await expect(createJobJournal(dir, time).initialize()).rejects.toMatchObject({ code: "journal_bad_directory" });
  });

  it("serializes concurrent appends into complete records", async () => {
    const journal = createJobJournal(dir, time);
    await Promise.all([journal.append(jobId, "claimed"), journal.append(jobId, "in_progress_reported"), journal.append(jobId, "printing")]);
    expect((await journal.read(jobId)).map((record) => record.state)).toEqual(["claimed", "in_progress_reported", "printing"]);
  });

  it("does not resolve a write until its file fsync completes", async () => {
    const journal = createJobJournal(dir, time);
    await journal.initialize();
    let release!: () => void;
    let reached!: () => void;
    const synced = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === journal.journalPath(jobId)) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementationOnce(async () => { reached(); await gate; await sync(); });
      }
      return handle;
    });
    let resolved = false;
    const write = journal.append(jobId, "claimed").then(() => { resolved = true; });
    await synced;
    expect(resolved).toBe(false);
    release();
    await write;
    expect(resolved).toBe(true);
  });

  it("syncs the bundle descriptor and journal directory before returning", async () => {
    const journal = createJobJournal(dir, time);
    await journal.initialize();
    const calls: string[] = [];
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        calls.push(args[0] === journal.bundlePath(jobId) ? "bundle" : "directory");
        await sync();
      });
      return handle;
    });
    await journal.saveBundle(jobId, bundle);
    expect(calls).toEqual(["bundle", "directory"]);
  });

  it("fails closed on partial JSONL after a crash", async () => {
    const journal = createJobJournal(dir, time);
    await journal.append(jobId, "printing");
    await fs.appendFile(journal.journalPath(jobId), '{"at":');
    await expect(createJobJournal(dir, time).initialize()).rejects.toMatchObject({ code: "journal_invalid" });
  });

  it("refuses runtime casts that try to persist server text or secrets", async () => {
    const journal = createJobJournal(dir, time);
    const secret = "PRIVATE_SERVER_TEXT_OR_KEY";
    await expect(journal.append(jobId, secret as JournalState)).rejects.toMatchObject({ code: "journal_invalid" });
    await expect(journal.append(jobId, "abandoned", secret as JournalCode)).rejects.toMatchObject({ code: "journal_invalid" });
    expect(await journal.has(jobId)).toBe(false);
    expect(await fs.readdir(journal.directory)).toEqual([]);
  });

  it("encodes job IDs into basenames and never follows a job-file symlink", async () => {
    const journal = createJobJournal(dir, time);
    await journal.append("../outside", "claimed");
    expect(journal.journalPath("../outside")).toBe(join(journal.directory, "..%2Foutside.jsonl"));
    expect(await journal.read("../outside")).toEqual([{ at, jobId: "../outside", state: "claimed" }]);
    await fs.symlink(journal.journalPath("../outside"), journal.journalPath(jobId));
    await expect(journal.append(jobId, "claimed")).rejects.toMatchObject({ code: "journal_bad_file" });
    await expect(journal.read(jobId)).rejects.toMatchObject({ code: "journal_bad_file" });
  });

  it("refuses a symlink journal directory and insecure existing modes", async () => {
    const linked = join(dir, "linked");
    await fs.mkdir(linked, { mode: 0o700 });
    await fs.symlink(linked, join(dir, "journal"));
    await expect(createJobJournal(dir).initialize()).rejects.toMatchObject({ code: "journal_bad_directory" });
    await fs.unlink(join(dir, "journal"));
    await fs.mkdir(join(dir, "journal"), { mode: 0o755 });
    await expect(createJobJournal(dir).initialize()).rejects.toMatchObject({ code: "journal_bad_directory" });
  });

  it("drops the underlying filesystem error text", async () => {
    const journal = createJobJournal(dir);
    await journal.initialize();
    vi.spyOn(fs, "open").mockRejectedValueOnce(new Error("PRIVATE_DOCUMENT_OR_SERVER_TEXT"));
    let caught: unknown;
    try { await journal.append(jobId, "claimed"); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(JournalError);
    expect(String(caught)).toBe("JournalError: journal_write_failed");
    expect(JSON.stringify(caught)).not.toContain("PRIVATE_DOCUMENT_OR_SERVER_TEXT");
    expect(Object.hasOwn(caught as object, "cause")).toBe(false);
  });
});
