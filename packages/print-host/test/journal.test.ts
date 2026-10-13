import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { constants } from "node:fs";
import { createJobJournal, JOURNAL_STATES, JournalError, type JournalCode, type JournalState, type SignedMilestonePackage } from "../src/journal.js";
import type { ReceiptEnvelope, RelayEvidenceBundle } from "../src/gateway-client.js";

let dir: string;
const jobId = "job-journal-1";
const at = "2026-10-15T17:00:00.000Z";
const time = () => Date.parse(at);
const bundle: RelayEvidenceBundle = {
  events: [], bundleHash: `sha256:${"a".repeat(64)}`,
  kernelSignature: { signer: `0x${"b".repeat(40)}`, algorithm: "ed25519", value: "c".repeat(128) },
};
const publicWord = () => `0x${randomBytes(32).toString("hex")}` as const;
const receipt = (): ReceiptEnvelope => ({
  receipt: {
    chainId: 84532, escrow: `0x${randomBytes(20).toString("hex")}`,
    settlementUnitId: publicWord(), packageDigest: publicWord(), receivedAt: Math.floor(time() / 1_000),
  },
  signatureHex: `0x${randomBytes(64).toString("hex")}`, receiptDigest: publicWord(), kid: "test-public-receipt-key",
});

beforeEach(async () => { dir = await fs.mkdtemp(join(tmpdir(), "print-host-journal-")); await fs.chmod(dir, 0o700); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }); });

describe("job journal", () => {
  it.each(JOURNAL_STATES)("a funded unit stays used in %s, for the same job and every later job", async (state) => {
    const unit = publicWord();
    const journal = createJobJournal(dir, time);
    expect(await journal.reserveUnit(jobId, unit)).toBe(true);
    const metadata = state === "package_built" ? { packageDigest: publicWord(), evidenceBlockHash: publicWord() } : undefined;
    await journal.append(jobId, state, undefined, metadata);
    expect(await journal.reserveUnit(jobId, unit)).toBe(false);
    expect(await journal.reserveUnit("another-job", unit)).toBe(false);
    expect(await journal.has("another-job")).toBe(false);
    expect(await journal.reserveUnit("another-job", publicWord())).toBe(true);
  });

  it("an orphan reservation survives a crash before the claim's first side effect", async () => {
    const unit = publicWord();
    const original = createJobJournal(dir, time);
    expect(await original.reserveUnit(jobId, unit)).toBe(true);
    expect(await original.has(jobId)).toBe(false);
    expect(await original.list()).toEqual([]);
    await original.close();
    const restarted = createJobJournal(dir, time);
    expect(await restarted.reserveUnit(jobId, unit)).toBe(false);
    expect(await restarted.reserveUnit("new-job", unit)).toBe(false);
    expect(await restarted.has(jobId)).toBe(false);
    expect(await restarted.has("new-job")).toBe(false);
    expect(await restarted.reserveUnit("new-job", publicWord())).toBe(true);
  });

  it("serializes competing reservations so exactly one job consumes the unit", async () => {
    const unit = publicWord();
    const journal = createJobJournal(dir, time);
    expect(await Promise.all([journal.reserveUnit(jobId, unit), journal.reserveUnit("new-job", unit)]))
      .toEqual([true, false]);
    expect(await journal.list()).toEqual([]);
  });

  it.each(["package", "bundle", "receipt", "session"] as const)(
    "refuses a legacy journal's funded unit recovered from its %s artifact", async (kind) => {
      const unit = publicWord();
      const journal = createJobJournal(dir, time);
      await journal.append(jobId, "print_failed");
      if (kind === "package") {
        await journal.savePackage(jobId, { body: { unitBinding: { settlementUnitId: unit } } } as unknown as SignedMilestonePackage);
      } else if (kind === "bundle") {
        await journal.saveBundle(jobId, { ...bundle, events: [{ payload: { settlementUnitId: unit } }] } as unknown as RelayEvidenceBundle);
      } else if (kind === "receipt") {
        const value = receipt();
        await journal.saveReceipt(jobId, { ...value, receipt: { ...value.receipt, settlementUnitId: unit } });
      } else {
        await fs.mkdir(journal.sessionDirectory(jobId), { mode: 0o700 });
        await fs.writeFile(join(journal.sessionDirectory(jobId), "00000000.json"), JSON.stringify({
          record: { kind: "open", binding: { settlementUnitId: unit } },
        }), { mode: 0o600 });
      }
      const before = await fs.readFile(journal.journalPath(jobId), "utf8");
      expect(await journal.reserveUnit("new-job", unit)).toBe(false);
      expect(await journal.has("new-job")).toBe(false);
      expect(await fs.readFile(journal.journalPath(jobId), "utf8")).toBe(before);
      expect(await journal.reserveUnit("new-job", publicWord())).toBe(true);
    },
  );

  it("a leftover temporary reservation also retains the unit after restart", async () => {
    const unit = publicWord();
    const original = createJobJournal(dir, time);
    await original.initialize();
    await fs.writeFile(join(original.directory, `.unit-${unit.slice(2)}.used.json.tmp-${randomBytes(16).toString("hex")}`), '{"version":', { mode: 0o600 });
    await original.close();
    const restarted = createJobJournal(dir, time);
    expect(await restarted.reserveUnit("new-job", unit)).toBe(false);
    expect(await restarted.has("new-job")).toBe(false);
    expect(await restarted.reserveUnit("different-unit-job", publicWord())).toBe(true);
  });

  it.each(["malformed", "partial", "wrong_unit", "insecure", "symlink"] as const)(
    "fails closed on an existing %s reservation without changing any journal", async (kind) => {
      const unit = publicWord();
      const journal = createJobJournal(dir, time);
      await journal.initialize();
      const marker = join(journal.directory, `.unit-${unit.slice(2)}.used.json`);
      if (kind === "symlink") {
        const target = join(dir, "other-file");
        await fs.writeFile(target, "PRIVATE_CANARY", { mode: 0o600 });
        await fs.symlink(target, marker);
      } else {
        const value = kind === "partial" ? '{"version":' : kind === "malformed" ? "{}"
          : JSON.stringify({ version: 1, jobId, settlementUnitId: kind === "wrong_unit" ? publicWord() : unit });
        await fs.writeFile(marker, value, { mode: kind === "insecure" ? 0o644 : 0o600 });
      }
      const code = ["insecure", "symlink"].includes(kind) ? "journal_bad_file" : "journal_invalid";
      await expect(journal.reserveUnit("new-job", unit)).rejects.toMatchObject({ code, message: code });
      expect(await journal.has("new-job")).toBe(false);
      expect(await journal.list()).toEqual([]);
    },
  );

  it("rejects nonlowercase bytes32 unit ids with a closed code before publishing a marker", async () => {
    const journal = createJobJournal(dir, time);
    const unit = publicWord();
    for (const invalid of ["", "PRIVATE_CANARY", `${unit}00`, unit.slice(2), `0xA${unit.slice(3)}`]) {
      await expect(journal.reserveUnit(jobId, invalid)).rejects.toMatchObject({ code: "journal_invalid", message: "journal_invalid" });
    }
    expect(await journal.has(jobId)).toBe(false);
    expect(await fs.readdir(journal.directory)).toEqual([".lock"]);
  });

  it("publishes and syncs a reservation before allowing the claim side effect", async () => {
    const journal = createJobJournal(dir, time);
    await journal.initialize();
    const unit = publicWord();
    const final = join(journal.directory, `.unit-${unit.slice(2)}.used.json`);
    const open = fs.open.bind(fs);
    const link = fs.link.bind(fs);
    const calls: string[] = [];
    let release!: () => void;
    let reached!: () => void;
    const reachedDirectorySync = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).startsWith(`${final}.tmp-`)) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => { await sync(); calls.push("file_synced"); });
      } else if (args[0] === journal.directory) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          reached(); await gate; await sync(); calls.push("directory_synced");
        });
      }
      return handle;
    });
    vi.spyOn(fs, "link").mockImplementation(async (...args) => {
      expect(calls).toEqual(["file_synced"]);
      await link(...args); calls.push("linked");
    });
    const claim = vi.fn(() => { calls.push("claimed"); });
    const pending = journal.reserveUnit(jobId, unit).then((reserved) => { if (reserved) claim(); });
    await reachedDirectorySync;
    expect(claim).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(final, "utf8"))).toEqual({ version: 1, jobId, settlementUnitId: unit });
    expect((await fs.stat(final)).mode & 0o777).toBe(0o600);
    release();
    await pending;
    expect(calls).toEqual(["file_synced", "linked", "directory_synced", "claimed"]);
  });

  it("allows the closed retryable emergency-stop code to persist and reload", async () => {
    const journal = createJobJournal(dir, time);
    await journal.append(jobId, "package_built", undefined, { packageDigest: publicWord(), evidenceBlockHash: publicWord() });
    await journal.append(jobId, "receipt_stored", "kernel_emergency_stopped");
    await journal.close();
    expect((await createJobJournal(dir, time).read(jobId)).at(-1)?.code).toBe("kernel_emergency_stopped");
  });

  it.each(["package_built", "receipt_stored", "submit_attempted", "submit_indeterminate", "submitted", "already_committed", "conflict", "refused"] as const)(
    "a stored receipt preserves %s and its public package hashes across restart", async (state) => {
      const original = createJobJournal(dir, time);
      const hashes = { packageDigest: `0x${randomBytes(32).toString("hex")}`, evidenceBlockHash: `0x${randomBytes(32).toString("hex")}` };
      await original.append(jobId, "evidence_stored");
      await original.append(jobId, "package_built", undefined, hashes);
      if (state !== "package_built") await original.append(jobId, state);
      await fs.mkdir(original.sessionDirectory(jobId), { mode: 0o700 });
      await original.close();
      const restarted = createJobJournal(dir, time);
      const records = await restarted.read(jobId);
      expect(records.at(-1)?.state).toBe(state);
      expect(records[1]).toEqual({ at, jobId, state: "package_built", ...hashes });
      expect(records.some((record) => record.state === "interrupted")).toBe(false);
    },
  );

  it("refuses missing or nonpublic package metadata without persisting it", async () => {
    const journal = createJobJournal(dir, time);
    await expect(journal.append(jobId, "package_built")).rejects.toMatchObject({ code: "journal_invalid" });
    const hashes = { packageDigest: `0x${randomBytes(32).toString("hex")}`, evidenceBlockHash: `0x${randomBytes(32).toString("hex")}` };
    await expect(journal.append(jobId, "submit_attempted", undefined, hashes)).rejects.toMatchObject({ code: "journal_invalid" });
    const nonpublic = { ...hashes, rawTransaction: "PRIVATE_CANARY" };
    await expect(journal.append(jobId, "package_built", undefined, nonpublic))
      .rejects.toMatchObject({ code: "journal_invalid" });
    await expect(journal.append(jobId, "package_built", undefined, { ...hashes, packageDigest: "PRIVATE_CANARY" }))
      .rejects.toMatchObject({ code: "journal_invalid" });
    expect(await journal.has(jobId)).toBe(false);
  });

  it("recovery artifact reads refuse symlinks, insecure files and partial JSON", async () => {
    const journal = createJobJournal(dir, time);
    await journal.saveBundle(jobId, bundle);
    expect(await journal.readBundle(jobId)).toEqual(bundle);
    await fs.symlink(journal.bundlePath(jobId), journal.packagePath(jobId));
    await expect(journal.readPackage(jobId)).rejects.toMatchObject({ code: "journal_bad_file" });
    await fs.unlink(journal.packagePath(jobId));
    await fs.writeFile(journal.packagePath(jobId), "{}", { mode: 0o644 });
    await expect(journal.readPackage(jobId)).rejects.toMatchObject({ code: "journal_bad_file" });
    await fs.chmod(journal.packagePath(jobId), 0o600);
    await fs.writeFile(journal.packagePath(jobId), '{"body":');
    await expect(journal.readPackage(jobId)).rejects.toMatchObject({ code: "journal_invalid" });
  });

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
    await original.close();
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
      await original.close();
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
      await original.close();
      const restarted = createJobJournal(dir, time);
      await restarted.initialize();
      await restarted.initialize();
      expect((await restarted.read(jobId)).map((record) => record.state)).toEqual([state, "interrupted"]);
      expect(await restarted.has(jobId)).toBe(true);
      await restarted.close();
      const nextRestart = createJobJournal(dir, time);
      expect((await nextRestart.read(jobId)).map((record) => record.state)).toEqual([state, "interrupted"]);
    },
  );

  it("excludes an orphan session whose host journal was never saved", async () => {
    const original = createJobJournal(dir, time);
    await original.initialize();
    await fs.mkdir(original.sessionDirectory(jobId), { mode: 0o700 });
    await fs.writeFile(join(original.sessionDirectory(jobId), "00000000.json"), "{}", { mode: 0o600 });
    await original.close();
    const restarted = createJobJournal(dir, time);
    expect(await restarted.has(jobId)).toBe(true);
    expect(await restarted.list()).toEqual([{ at, jobId, state: "interrupted" }]);
    expect(await fs.readdir(restarted.directory)).toEqual([".lock", `${jobId}.jsonl`]);
  });

  it("retains a session with a durable evidence-stored receipt", async () => {
    const original = createJobJournal(dir, time);
    await original.append(jobId, "evidence_stored");
    await fs.mkdir(original.sessionDirectory(jobId), { mode: 0o700 });
    await original.close();
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
    await original.close();
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
        calls.push(String(args[0]).startsWith(`${journal.bundlePath(jobId)}.tmp-`) ? "bundle" : "directory");
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
    await journal.close();
    await expect(createJobJournal(dir, time).initialize()).rejects.toMatchObject({ code: "journal_invalid" });
  });

  it("refuses runtime casts that try to persist server text or secrets", async () => {
    const journal = createJobJournal(dir, time);
    const secret = "PRIVATE_SERVER_TEXT_OR_KEY";
    await expect(journal.append(jobId, secret as JournalState)).rejects.toMatchObject({ code: "journal_invalid" });
    await expect(journal.append(jobId, "abandoned", secret as JournalCode)).rejects.toMatchObject({ code: "journal_invalid" });
    expect(await journal.has(jobId)).toBe(false);
    expect(await fs.readdir(journal.directory)).toEqual([".lock"]);
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

  it("persists a lowercase public transaction hash only on submit_attempted", async () => {
    const journal = createJobJournal(dir, time);
    const transactionHash = publicWord();
    await journal.append(jobId, "submit_attempted", undefined, { transactionHash });
    expect(await journal.read(jobId)).toEqual([{ at, jobId, state: "submit_attempted", transactionHash }]);
    for (const state of ["receipt_stored", "submitted", "package_built"] as const) {
      await expect(journal.append(jobId, state, undefined, { transactionHash })).rejects.toMatchObject({ code: "journal_invalid" });
    }
    for (const invalid of [`0x${"A".repeat(64)}`, "0x", "PRIVATE_CANARY", `${transactionHash}00`]) {
      await expect(journal.append(jobId, "submit_attempted", undefined, { transactionHash: invalid }))
        .rejects.toMatchObject({ code: "journal_invalid" });
    }
    await journal.close();
    expect((await createJobJournal(dir, time).read(jobId)).at(-1)?.transactionHash).toBe(transactionHash);
  });

  it.each([
    { state: "submitted", transactionHash: publicWord() },
    { state: "submit_attempted", transactionHash: `0x${"A".repeat(64)}` },
    { state: "submit_attempted", transactionHash: "PRIVATE_CANARY" },
  ])("validates transaction metadata on read: $state / $transactionHash", async (metadata) => {
    const journal = createJobJournal(dir, time);
    await journal.initialize();
    await fs.writeFile(journal.journalPath(jobId), `${JSON.stringify({ at, jobId, ...metadata })}\n`, { mode: 0o600 });
    await expect(journal.read(jobId)).rejects.toMatchObject({ code: "journal_invalid" });
  });

  it("stores a strict receipt artifact and rejects malformed recovery receipts", async () => {
    const journal = createJobJournal(dir, time);
    expect(await journal.readReceipt(jobId)).toBeUndefined();
    const value = receipt();
    await journal.saveReceipt(jobId, value);
    await journal.append(jobId, "receipt_stored");
    expect(await journal.readReceipt(jobId)).toEqual(value);
    expect((await fs.stat(journal.receiptPath(jobId))).mode & 0o777).toBe(0o600);
    await expect(journal.saveReceipt(jobId, value)).rejects.toMatchObject({ code: "journal_bundle_exists" });
    await fs.writeFile(journal.receiptPath(jobId), JSON.stringify({ ...value, serverText: "PRIVATE_CANARY" }));
    await expect(journal.readReceipt(jobId)).rejects.toMatchObject({ code: "journal_invalid" });
  });

  it.each(["bundle", "package", "receipt"] as const)("publishes the %s only by linking a synced unique temp file", async (kind) => {
    const journal = createJobJournal(dir, time);
    await journal.initialize();
    const final = kind === "bundle" ? journal.bundlePath(jobId)
      : kind === "package" ? journal.packagePath(jobId) : journal.receiptPath(jobId);
    const open = fs.open.bind(fs);
    const link = fs.link.bind(fs);
    const calls: string[] = [];
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (typeof args[1] === "number" && (args[1] & constants.O_WRONLY)) {
        expect(String(args[0])).toMatch(new RegExp(`\\.${kind}\\.json\\.tmp-[0-9a-f]{32}$`));
        expect((args[1] & constants.O_EXCL) !== 0).toBe(true);
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => { calls.push("file_synced"); await sync(); });
      } else if (args[0] === journal.directory) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => { calls.push("directory_synced"); await sync(); });
      }
      return handle;
    });
    vi.spyOn(fs, "link").mockImplementation(async (...args) => {
      expect(calls).toEqual(["file_synced"]);
      expect(args[1]).toBe(final);
      await expect(fs.stat(final)).rejects.toMatchObject({ code: "ENOENT" });
      calls.push("linked");
      await link(...args);
    });
    if (kind === "bundle") await journal.saveBundle(jobId, bundle);
    else if (kind === "package") await journal.savePackage(jobId, { body: { public: true } } as unknown as SignedMilestonePackage);
    else await journal.saveReceipt(jobId, receipt());
    expect(calls).toEqual(["file_synced", "linked", "directory_synced"]);
    expect((await fs.readdir(journal.directory)).some((file) => file.includes(".tmp-"))).toBe(false);
  });

  it("a partial leftover temp artifact is ignored after restart and cannot block another save", async () => {
    const original = createJobJournal(dir, time);
    await original.initialize();
    const leftover = `${original.bundlePath(jobId)}.tmp-crash`;
    await fs.writeFile(leftover, '{"events":', { mode: 0o600 });
    await original.close();
    const journal = createJobJournal(dir, time);
    await journal.saveBundle(jobId, bundle);
    expect(await journal.readBundle(jobId)).toEqual(bundle);
    expect(await fs.readFile(leftover, "utf8")).toBe('{"events":');
  });

  it("takes an exclusive data-directory lock and releases it on clean close", async () => {
    const first = createJobJournal(dir, time);
    await first.initialize();
    const lockPath = join(first.directory, ".lock");
    const identity = JSON.parse(await fs.readFile(lockPath, "utf8"));
    const selfStat = await fs.readFile("/proc/self/stat", "utf8");
    expect(identity).toEqual({
      pid: process.pid, startTime: selfStat.slice(selfStat.lastIndexOf(")") + 1).trim().split(/\s+/)[19],
      bootId: (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
    });
    await expect(createJobJournal(dir, time).initialize()).rejects.toMatchObject({ code: "data_dir_locked" });
    expect(JSON.parse(await fs.readFile(lockPath, "utf8"))).toEqual(identity);
    await first.close();
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(first.append(jobId, "claimed")).rejects.toMatchObject({ code: "data_dir_locked" });
    await expect(createJobJournal(dir, time).initialize()).resolves.toBeUndefined();
  });

  it("two simultaneous starts on an unlocked directory have exactly one owner", async () => {
    const journals = [createJobJournal(dir, time), createJobJournal(dir, time)];
    const outcomes = await Promise.allSettled(journals.map((journal) => journal.initialize()));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const refused = outcomes.find((outcome) => outcome.status === "rejected");
    expect(refused).toMatchObject({ reason: { code: "data_dir_locked" } });
    await Promise.all(journals.map((journal) => journal.close()));
  });

  it.each(["bootId", "pid", "startTime"] as const)("takes over a stale lock identified by its %s", async (field) => {
    const first = createJobJournal(dir, time);
    await first.initialize();
    const lockPath = join(first.directory, ".lock");
    const identity = JSON.parse(await fs.readFile(lockPath, "utf8"));
    await first.close();
    if (field === "bootId") identity.bootId = `${identity.bootId[0] === "0" ? "1" : "0"}${identity.bootId.slice(1)}`;
    else if (field === "pid") identity.pid = 2_147_483_647;
    else identity.startTime = String(BigInt(identity.startTime) + 1n);
    await fs.writeFile(lockPath, JSON.stringify(identity), { mode: 0o600 });
    const next = createJobJournal(dir, time);
    await next.initialize();
    const current = JSON.parse(await fs.readFile(lockPath, "utf8"));
    expect(current.pid).toBe(process.pid);
    expect(current[field]).not.toBe(identity[field]);
  });

  it.each(["/proc/self/stat", "/proc/sys/kernel/random/boot_id"])("refuses to start if %s is unreadable", async (blocked) => {
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation((...args) => {
      if (args[0] === blocked) return Promise.reject(Object.assign(new Error("PRIVATE_CANARY"), { code: "EACCES" }));
      return readFile(...args);
    });
    await expect(createJobJournal(dir, time).initialize()).rejects.toMatchObject({ code: "data_dir_locked" });
  });

  it("an unreadable existing pid identity is not treated as stale", async () => {
    const first = createJobJournal(dir, time);
    await first.initialize();
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation((...args) => {
      if (args[0] === `/proc/${process.pid}/stat`) return Promise.reject(Object.assign(new Error("PRIVATE_CANARY"), { code: "EACCES" }));
      return readFile(...args);
    });
    await expect(createJobJournal(dir, time).initialize()).rejects.toMatchObject({ code: "data_dir_locked" });
  });
});
