import { createPrivateKey, createPublicKey, randomBytes, verify } from "node:crypto";
import { chmod, cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIppPrintKernel,
  EvidenceEmitter,
  makeKernelEd25519Signer,
  runPrintJob,
  type IppPrintKernel,
  type PrintJobOptions,
  type PrintJobResult,
} from "@pcc/kernel";
import { verifyBundleSignature } from "@pcc/kernel-sdk";
import {
  canonicalize,
  hashEvent,
  sessionKeyDelegationPreimage,
  type EvidenceBundle,
  type EvidenceEvent,
  type SessionAction,
} from "@pcc/spec";
import { FakeMachineAdapter } from "../src/index.js";

const gap = (name: string, fn: () => Promise<void>) =>
  process.env.PRINT_HOST_SHOW_GAPS === "1" ? it(name, fn) : it.fails(name, fn);

const timeoutMs = 300;
const cleanups: Array<() => Promise<void>> = [];
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
const realNow = performance.now.bind(performance);
const stillPending = Symbol("pending real async work");

// Requested toolkit API; local types keep this repro compilable before it exists.
interface UnitEvidenceSession {
  addPrintResult(result: PrintJobResult): void | Promise<void>;
  addEvent(event: EvidenceEvent): void | Promise<void>;
  finalize(): Promise<EvidenceBundle>;
}

interface UnitEvidenceSessionApi {
  openUnitEvidenceSession(options: {
    settlementUnitId: string;
    challengeNonce: string;
    jobId: string;
    parentAgentId: string;
    fundedAt: number;
    deviceSigner: ReturnType<typeof makeKernelEd25519Signer>;
    journalDir: string;
    // The host passes the unit's reclaimAt as expiresAt.
    expiresAt: number;
  }): UnitEvidenceSession | Promise<UnitEvidenceSession>;
  resumeUnitEvidenceSession(options: {
    journalDir: string;
    settlementUnitId: string;
    deviceSigner: ReturnType<typeof makeKernelEd25519Signer>;
  }): UnitEvidenceSession | Promise<UnitEvidenceSession>;
}

function testIds(testId: string) {
  return {
    kernelId: `n144-print-host-${testId}`,
    deviceId: `n144-printer-${testId}`,
  };
}

function harness(testId: string, options?: ConstructorParameters<typeof FakeMachineAdapter>[2]) {
  const { kernelId, deviceId } = testIds(testId);
  const adapter = new FakeMachineAdapter(deviceId, kernelId, options);
  const signer = makeKernelEd25519Signer();
  const emitter = new EvidenceEmitter(kernelId, signer.signFn);
  cleanups.push(() => adapter.dispose());
  return { adapter, signer, emitter };
}

function job(jobId: string): Omit<PrintJobOptions, "adapter" | "emitter"> {
  return { jobId, stepId: `${jobId}-print`, jobName: `${jobId}.pdf`, totalPages: 1, timeoutMs };
}

function bundleSigningKey(bundle: EvidenceBundle, devicePublicKeyHex: string): Buffer {
  const key = bundle.sessionKeyAuthorization?.publicKey ?? devicePublicKeyHex;
  return Buffer.from(key.replace(/^0x/, ""), "hex");
}

async function completingPrint(
  setup: ReturnType<typeof harness>,
  options: Omit<PrintJobOptions, "adapter" | "emitter">,
  ippJobId: number,
  startMessage = "the scripted print must start",
) {
  setup.adapter.scriptStart({ outcome: "success", jobId: ippJobId });
  const started = setup.adapter.started();
  const pending = runPrintJob({ ...options, adapter: setup.adapter, emitter: setup.emitter });
  const first = await Promise.race([started.then(() => "started" as const), pending]);
  expect(first, startMessage).toBe("started");
  setup.adapter.emit("execution_started", { ippJobId, jobName: options.jobName });
  setup.adapter.emit("execution_progress", { ippJobId, totalPages: 1, progress: 100 });
  setup.adapter.emit("execution_completed", { ippJobId, totalPages: 1 });
  return drainPrintJob(pending);
}

async function awaitRealWork<T>(pending: Promise<T>, boundMs: number): Promise<T | typeof stillPending> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<typeof stillPending>((resolve) => {
        timer = realSetTimeout(() => resolve(stillPending), boundMs);
      }),
    ]);
  } finally {
    if (timer) realClearTimeout(timer);
  }
}

async function drainPrintJob(pending: Promise<PrintJobResult>): Promise<PrintJobResult> {
  const result = await awaitRealWork(pending, 250);
  if (result !== stillPending) return result;
  // Fallback for an ignored abort or separate fake-time quiesce/settle waits.
  // Give crypto.subtle real time to finish before advancing another fake bound.
  for (let elapsedMs = 0; vi.isFakeTimers() && elapsedMs < 120_000; elapsedMs += 1_000) {
    await vi.advanceTimersByTimeAsync(1_000);
    const drained = await awaitRealWork(pending, 25);
    if (drained !== stillPending) return drained;
  }
  return pending;
}

async function journalPaths(directory: string): Promise<{ directories: string[]; files: string[] }> {
  const entries = await readdir(directory, { withFileTypes: true });
  const directories = [directory];
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await journalPaths(path);
      directories.push(...nested.directories);
      files.push(...nested.files);
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return { directories, files };
}

async function expectPrivateJournalFiles(directory: string): Promise<number> {
  const paths = await journalPaths(directory);
  for (const path of paths.directories) {
    expect((await stat(path)).mode & 0o777, `${path} must be mode 0700`).toBe(0o700);
  }
  for (const path of paths.files) {
    expect((await stat(path)).mode & 0o777, `${path} must be mode 0600`).toBe(0o600);
  }
  return paths.files.length;
}

async function publicKeysFromSeedsOnDisk(directory: string, deviceSeed?: Uint8Array): Promise<Set<string>> {
  const candidates = new Set<string>();
  const addByteWindows = (bytes: Buffer) => {
    for (let offset = 0; offset + 32 <= bytes.length; offset++) {
      candidates.add(bytes.subarray(offset, offset + 32).toString("hex"));
    }
  };
  for (const path of (await journalPaths(directory)).files) {
    const bytes = await readFile(path);
    if (deviceSeed) {
      expect(bytes.includes(Buffer.from(deviceSeed)), "journal files must not contain the raw device private seed").toBe(false);
    }
    // Raw seeds and secret keys may appear at any byte offset, including in binary journals.
    addByteWindows(bytes);
    const text = bytes.toString("utf8");
    for (const match of text.matchAll(/(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64,}(?![0-9a-fA-F])/g)) {
      const hex = match[0].replace(/^0x/, "").toLowerCase();
      for (let offset = 0; offset + 64 <= hex.length; offset += 2) {
        candidates.add(hex.slice(offset, offset + 64));
      }
    }
    for (const match of text.matchAll(/[A-Za-z0-9+/_-]+={0,2}/g)) {
      // Skip tokens longer than 8192 characters to bound base64/base64url candidate work.
      if (match[0].length > 8192) continue;
      addByteWindows(Buffer.from(match[0], "base64"));
    }
    const jsonByteRuns = /\[\s*\d+(?:\s*,\s*\d+){31,}\s*\]|\{\s*"\d+"\s*:\s*\d+(?:\s*,\s*"\d+"\s*:\s*\d+){31,}\s*\}/g;
    for (const match of text.matchAll(jsonByteRuns)) {
      let parsed: number[] | Record<string, number>;
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)
        && !Object.keys(parsed).every((key, index) => key === String(index))) continue;
      const bytes = Array.isArray(parsed) ? parsed : Object.values(parsed);
      if (bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
        addByteWindows(Buffer.from(bytes));
      }
    }
  }
  const publicKeys = new Set<string>();
  for (const candidate of candidates) {
    const privateKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        Buffer.from(candidate, "hex"),
      ]),
      format: "der",
      type: "pkcs8",
    });
    const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" });
    publicKeys.add(publicKey.subarray(-32).toString("hex"));
  }
  return publicKeys;
}

async function copyPrivateJournal(directory: string): Promise<string> {
  const copyDir = await mkdtemp(join(tmpdir(), "n144-journal-copy-"));
  cleanups.push(() => rm(copyDir, { recursive: true, force: true }));
  await cp(directory, copyDir, { recursive: true });
  const paths = await journalPaths(copyDir);
  for (const path of paths.directories) await chmod(path, 0o700);
  for (const path of paths.files) await chmod(path, 0o600);
  return copyDir;
}

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

describe("N144 print-host toolkit gap repros", () => {
  it("the journal seed scan finds encoded private seeds and ignores seed-free files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "n144-seed-scan-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const scanFile = async (fileName: string, contents: string) => {
      const path = join(directory, fileName);
      try {
        await writeFile(path, contents);
        return await publicKeysFromSeedsOnDisk(directory);
      } finally {
        await rm(path, { force: true });
      }
    };
    const seed = randomBytes(32);
    // These runtime bytes force base64url to use its distinct '-' and '_' alphabet.
    seed.fill(0xfb, 0, 3);
    const signer = makeKernelEd25519Signer(seed);
    expect(await scanFile("no-seed.txt", "journal metadata without a private seed\n"))
      .not.toContain(signer.publicKeyHex);
    const secretKey = Buffer.from(signer.secretKey);
    const forms = [
      ["seed.hex", "64-hex seed", seed.toString("hex")],
      ["seed-prefixed.hex", "0x-prefixed 64-hex seed", `0x${seed.toString("hex")}\n`],
      ["secret-key.hex", "128-hex secretKey", secretKey.toString("hex")],
      ["seed.base64", "base64 seed", seed.toString("base64")],
      ["seed.base64url", "base64url seed", seed.toString("base64url")],
      ["secret-key.base64", "base64 secretKey", secretKey.toString("base64")],
      ["secret-key.json", "JSON Uint8Array secretKey", JSON.stringify({ secretKey: signer.secretKey })],
      ["seed-array.json", "JSON seed array", JSON.stringify(Array.from(seed))],
    ] as const;
    for (const [fileName, form, contents] of forms) {
      expect(await scanFile(fileName, contents), `the scan must find the held key from ${form} alone`)
        .toContain(signer.publicKeyHex);
    }

    const setup = harness("seed-scan-bundle");
    const result = await completingPrint(setup, job("seed-scan-bundle"), 120);
    expect(result.bundle).toBeDefined();
    const bundle = result.bundle!;
    expect(verifyBundleSignature(bundle, bundleSigningKey(bundle, setup.signer.publicKeyHex))).toBe(true);
    const eventHashes = bundle.events.map((event) => event.hash.replace(/^sha256:/, ""));
    for (const hash of eventHashes) expect(hash).toMatch(/^[0-9a-f]{64}$/i);
    expect(bundle.kernelSignature.value).toMatch(/^[0-9a-f]{128}$/i);
    const hashesAndSignature = [
      ...eventHashes, bundle.kernelSignature.value,
    ].join("\n");
    expect(hashesAndSignature, "the false-positive fixture must not contain the device public key")
      .not.toContain(setup.signer.publicKeyHex);
    const foundKeys = await scanFile("hashes-and-signature.txt", hashesAndSignature);
    for (const heldKey of [signer.publicKeyHex, setup.signer.publicKeyHex]) {
      expect(foundKeys, "event hashes and a real signature must not identify a held key").not.toContain(heldKey);
    }
  });

  it("the journal seed scan finds raw seeds and secret keys at every byte offset without false positives", async () => {
    const directory = await mkdtemp(join(tmpdir(), "n144-raw-seed-scan-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const signer = makeKernelEd25519Signer();
    const seed = Buffer.from(signer.secretKey.subarray(0, 32));
    const forms = [
      ["raw-seed", seed],
      ["raw-secret-key", Buffer.from(signer.secretKey)],
      ["raw-odd-offset", Buffer.concat([randomBytes(7), seed, randomBytes(13)])],
    ] as const;
    for (const [form, bytes] of forms) {
      const path = join(directory, form);
      try {
        await writeFile(path, bytes);
        expect(await publicKeysFromSeedsOnDisk(directory), `the scan must find the held key from ${form} alone`)
          .toContain(signer.publicKeyHex);
      } finally {
        await rm(path, { force: true });
      }
    }
    await writeFile(join(directory, "random-bytes"), randomBytes(137));
    expect(await publicKeysFromSeedsOnDisk(directory), "random bytes must not identify a held key")
      .not.toContain(signer.publicKeyHex);
  });

  it("the scripted adapter completes a print through runPrintJob", async () => {
    const setup = harness("harness-check");
    const result = await completingPrint(setup, job("harness-check"), 100);
    expect(result.success).toBe(true);
    expect(result.bundle).toBeDefined();
    expect(result.events.map((event) => event.type)).toEqual([
      "execution_started", "execution_progress", "execution_completed",
    ]);
    expect(result.completion?.printerJobId).toBe(100);
    expect(setup.adapter.commands).toEqual([
      { type: "start", payload: { jobName: "harness-check.pdf", totalPages: 1 } },
    ]);
    expect(await setup.adapter.getStatus()).toBe("idle");
    await setup.adapter.quiesceEvidence();
  });

  it.each(["before-resolve", "after-resolve"] as const)(
    "the fake normalizes cancel ids and reports state 7 %s",
    async (cancelEventOrder) => {
      vi.useFakeTimers();
      const setup = harness(`cancel-check-${cancelEventOrder}`, { cancelEventOrder });
      const ippJobId = cancelEventOrder === "before-resolve" ? 109 : 119;
      setup.adapter.scriptStart({ outcome: "success", jobId: ippJobId });
      await setup.adapter.execute({ type: "start" });
      for (const invalidId of [" 109", "0x6d", "1e2"]) {
        await expect(setup.adapter.cancelJob(invalidId)).rejects.toThrow();
        expect(setup.adapter.cancels).toEqual([]);
      }
      const observations: string[] = [];
      const terminal = new Promise<void>((resolve) => setup.adapter.onEvidence((event) => {
        expect(event.type).toBe("execution_failed");
        expect(event.payload).toMatchObject({ ippJobId, state: "canceled" });
        observations.push("state-7");
        resolve();
      }));
      await setup.adapter.cancelJob(String(ippJobId + 1));
      expect(observations).toEqual([]);
      expect(await setup.adapter.getStatus()).toBe("busy");
      const canceled = setup.adapter.cancelJob(String(ippJobId)).then(() => {
        observations.push("cancel-resolved");
      });
      await Promise.all([canceled, terminal]);
      expect(observations).toEqual(cancelEventOrder === "before-resolve"
        ? ["state-7", "cancel-resolved"] : ["cancel-resolved", "state-7"]);
      await setup.adapter.cancelJob(ippJobId);
      expect(setup.adapter.cancels).toEqual([ippJobId + 1, ippJobId, ippJobId]);
      expect(await setup.adapter.getStatus()).toBe("idle");
      await setup.adapter.quiesceEvidence();
    },
  );

  it("the fake reports a device cancellation only once per job under both cancel/event orders", async () => {
    for (const cancelEventOrder of ["before-resolve", "after-resolve"] as const) {
      const setup = harness(`cancel-once-${cancelEventOrder}`, { cancelEventOrder });
      const ippJobId = cancelEventOrder === "before-resolve" ? 110 : 120;
      setup.adapter.scriptStart({ outcome: "success", jobId: ippJobId });
      await setup.adapter.execute({ type: "start" });
      const events: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
      setup.adapter.onEvidence((event) => events.push(event));
      await setup.adapter.cancelJob(ippJobId + 1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(events, "a cancel for a different job must report nothing").toEqual([]);
      expect(await setup.adapter.getStatus()).toBe("busy");
      // Both calls enter while active, exercising the guard on the later report.
      await expect(Promise.all([
        setup.adapter.cancelJob(ippJobId), setup.adapter.cancelJob(ippJobId),
      ]), "repeated cancels of the same device job must remain accepted")
        .resolves.toEqual([undefined, undefined]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(events, "repeated cancels must report exactly one execution_failed").toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "execution_failed", payload: { ippJobId, state: "canceled", origin: "device" },
      });
      expect(setup.adapter.cancels).toEqual([ippJobId + 1, ippJobId, ippJobId]);
      expect(await setup.adapter.getStatus()).toBe("idle");
      await setup.adapter.quiesceEvidence();
    }
  });

  it("the silent fake reports once only after its real cancel deadline, even with repeated cancels", async () => {
    vi.useFakeTimers();
    const cancelConfirmMs = 100;
    const setup = harness("silent-cancel-control", { cancelBehavior: "silent", cancelConfirmMs });
    setup.adapter.scriptStart({ outcome: "success", jobId: 121 });
    await setup.adapter.execute({ type: "start" });
    const events: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    let reportedAt = 0;
    setup.adapter.onEvidence((event) => {
      reportedAt = realNow();
      events.push(event);
    });
    const canceledAt = realNow();
    await setup.adapter.cancelJob(121);
    await setup.adapter.cancelJob(121);
    const idle = setup.adapter.quiesceEvidence();
    // Advancing fake timers cannot trigger the adapter's real deadline.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events, "a silent cancel must not report before its real deadline").toHaveLength(0);
    expect(await awaitRealWork(idle, 20), "silent cancellation must keep work active before its deadline")
      .toBe(stillPending);
    expect(await awaitRealWork(idle, 250), "the silent cancel deadline must fire and quiesce work")
      .not.toBe(stillPending);
    // Native timers use a millisecond clock; allow its rounding against performance.now().
    expect(reportedAt - canceledAt, "the silent report must wait for the cancel-confirm deadline within timer resolution")
      .toBeGreaterThanOrEqual(cancelConfirmMs - 2);
    await setup.adapter.cancelJob(121);
    await new Promise<void>((resolve) => realSetTimeout(resolve, cancelConfirmMs + 20));
    expect(events, "repeated silent cancels must emit exactly once").toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "execution_failed",
      payload: { ippJobId: 121, state: "processing", reason: "cancel-unconfirmed", jobStateReasons: [], origin: "device" },
    });
    expect(setup.adapter.cancels).toEqual([121, 121, 121]);
    expect(await setup.adapter.getStatus()).toBe("idle");
  });

  it("a stale cancel poll cannot suppress cancellation of a replacement job", async () => {
    const setup = harness("stale-cancel-poll", { cancelEventOrder: "after-resolve" });
    const events: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    setup.adapter.onEvidence((event) => events.push(event));
    setup.adapter.scriptStart({ outcome: "success", jobId: 122 });
    await setup.adapter.execute({ type: "start" });
    await setup.adapter.cancelJob(122);
    // Replace the job before the scheduled poll, so its guard returns without finishWork.
    setup.adapter.scriptStart({ outcome: "success", jobId: 123 });
    await setup.adapter.execute({ type: "start" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toHaveLength(0);
    await setup.adapter.cancelJob(123);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events, "a completed stale cancel poll must permit the next job's cancel report").toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ ippJobId: 123, state: "canceled", origin: "device" });
    await setup.adapter.quiesceEvidence();
  });

  gap("GAP-1 real mode never simulates", async () => {
    vi.useFakeTimers();
    let kernel: IppPrintKernel;
    try {
      kernel = createIppPrintKernel({
        ...testIds("gap-1"), mockMode: false, uri: "ipp://127.0.0.1:9/ipp/print",
      });
    } catch (error) {
      // Explicit real-mode unavailability may be refused at construction.
      expect(error).toBeInstanceOf(Error);
      return;
    }
    cleanups.push(() => kernel.dispose());
    // Contain the constructor's optional IPP import, without waiting for a warning.
    await vi.dynamicImportSettled();
    const pending = kernel.print({
      ...job("real-required"),
      documentData: Buffer.from("N144 test document"),
      timeoutMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await drainPrintJob(pending);
    const simulatedEvents = result.events.filter(
      (event) => event.source.simulated === true || event.payload.mock === true,
    );
    expect(
      !result.success || simulatedEvents.length === 0,
      "mockMode:false must refuse the print or record no simulated/mock events: a reported downgrade still yields simulated evidence, which cannot settle",
    ).toBe(true);
  });

  gap("GAP-2 a print's evidence holds only its own job's events (N106)", async () => {
    const setup = harness("gap-2");
    const first = job("print-A");
    const resultA = await completingPrint(setup, first, 101);
    expect(resultA.success).toBe(true);
    const resultB = await completingPrint(setup, job("print-B"), 102);
    expect(resultB.success).toBe(true);
    const eventsA = setup.emitter.getEvents(first.jobId, first.stepId!);
    const foreignEvents = eventsA.filter(
      (event) => event.payload.ippJobId === 102,
    );
    expect(foreignEvents, "print A must contain none of print B's events").toEqual([]);
    expect(eventsA, "print A must retain exactly its three events").toHaveLength(3);
    for (const event of eventsA) expect(event.payload.ippJobId).toBe(101);
  });

  gap("GAP-3 a reported failure returns a SIGNED execution_failed bundle", async () => {
    const setup = harness("gap-3");
    setup.adapter.scriptStart({ outcome: "success", jobId: 103 });
    const started = setup.adapter.started();
    const pending = runPrintJob({ ...job("reported-failure"), ...setup });
    await started;
    setup.adapter.emit("execution_started", { ippJobId: 103 });
    setup.adapter.emit("execution_failed", { ippJobId: 103, state: "canceled" });
    const result = await drainPrintJob(pending);
    expect(result.success).toBe(false);
    expect(result.bundle, "a device-reported failure must return a signed bundle").toBeDefined();
    const bundle = result.bundle!;
    expect(bundle.events.some((event) => event.type === "execution_failed")).toBe(true);
    expect(bundle.events.some((event) => event.type === "execution_completed")).toBe(false);
    expect(verifyBundleSignature(bundle, bundleSigningKey(bundle, setup.signer.publicKeyHex))).toBe(true);
  });

  for (const cancelBehavior of ["report", "silent"] as const) {
    gap(`GAP-4 a timeout cancels the device job and returns a SIGNED execution_failed bundle${cancelBehavior === "silent" ? " (silent printer)" : ""}`, async () => {
      vi.useFakeTimers();
      const setup = harness(`gap-4-${cancelBehavior}`, { cancelBehavior });
      setup.adapter.scriptStart({ outcome: "success", jobId: 104 });
      const started = setup.adapter.started();
      const pending = runPrintJob({ ...job("timed-out"), ...setup });
      await started;
      setup.adapter.emit("execution_started", { ippJobId: 104 });
      await vi.advanceTimersByTimeAsync(timeoutMs);
      const result = await drainPrintJob(pending);
      expect(result.success).toBe(false);
      expect(
        setup.adapter.cancels.length, "a timed-out device job must be canceled with cancelJob(104)",
      ).toBeGreaterThanOrEqual(1);
      expect(setup.adapter.cancels.every((id) => id === 104), "every cancel must target job 104").toBe(true);
      expect(
        setup.adapter.commands.some((command) => command.type === "stop"),
        "never 'stop': it ends polling before the canceled state",
      ).toBe(false);
      expect(result.bundle, "a timeout must return a signed failure bundle").toBeDefined();
      const bundle = result.bundle!;
      expect(bundle.events.some((event) => event.type === "execution_failed")).toBe(true);
      expect(bundle.events.some((event) => event.type === "execution_completed")).toBe(false);
      expect(verifyBundleSignature(bundle, bundleSigningKey(bundle, setup.signer.publicKeyHex))).toBe(true);
      const failures = bundle.events.filter((event) => event.type === "execution_failed");
      expect(failures, "a device-confirmed timeout must include exactly one execution_failed").toHaveLength(1);
      // Assumes a contract-honouring adapter; real IppAdapter origin stamping and its
      // cancel-confirm deadline are not tested here (adk was asked in bus #7752).
      expect(failures[0]!.payload).toMatchObject({ ippJobId: 104, origin: "device" });
      if (cancelBehavior === "silent") {
        expect(failures[0]!.payload).toMatchObject({ reason: "cancel-unconfirmed" });
      }
      expect((result as PrintJobResult & { failure?: unknown }).failure)
        .toMatchObject({ kind: "timeout", origin: "device" });
      expect((result as PrintJobResult & { cancelRequested?: unknown }).cancelRequested).toBeTruthy();
      if (cancelBehavior === "silent") {
        const following = await completingPrint(setup, job("after-silent-timeout"), 124,
          "a following print must start instead of a busy refusal with reason quiescing");
        expect(following.success).toBe(true);
      }
    });

  }

  for (const cancelEventOrder of ["before-resolve", "after-resolve", "silent printer"] as const) {
    gap(`GAP-5 an abort input cancels the device job and returns a SIGNED execution_failed bundle (${cancelEventOrder})`, async () => {
      vi.useFakeTimers();
      const silent = cancelEventOrder === "silent printer";
      const setup = harness(`gap-5-${cancelEventOrder}`, {
        cancelBehavior: silent ? "silent" : "report",
        cancelEventOrder: silent ? "after-resolve" : cancelEventOrder,
      });
      const ippJobId = cancelEventOrder === "before-resolve" ? 105 : silent ? 125 : 115;
      const controller = new AbortController();
      // Requested host input: pcc-adk chooses the abort input's API shape.
      const options = {
        ...job(`aborted-${cancelEventOrder}`), timeoutMs: 10_000, signal: controller.signal,
      } as Omit<PrintJobOptions, "adapter" | "emitter">;
      setup.adapter.scriptStart({ outcome: "success", jobId: ippJobId });
      const started = setup.adapter.started();
      const pending = runPrintJob({ ...options, ...setup });
      await started;
      setup.adapter.emit("execution_started", { ippJobId });
      controller.abort();
      const result = await drainPrintJob(pending);
      expect(
        setup.adapter.cancels.length, `an aborted device job must be canceled with cancelJob(${ippJobId})`,
      ).toBeGreaterThanOrEqual(1);
      expect(setup.adapter.cancels.every((id) => id === ippJobId), `every cancel must target job ${ippJobId}`).toBe(true);
      expect(
        setup.adapter.commands.some((command) => command.type === "stop"),
        "never 'stop': it ends polling before the canceled state",
      ).toBe(false);
      expect(result.durationMs).toBeLessThan(10_000);
      expect(result.success).toBe(false);
      expect(result.bundle, "an abort must return a signed failure bundle").toBeDefined();
      const bundle = result.bundle!;
      expect(bundle.events.some((event) => event.type === "execution_failed")).toBe(true);
      expect(bundle.events.some((event) => event.type === "execution_completed")).toBe(false);
      expect(verifyBundleSignature(bundle, bundleSigningKey(bundle, setup.signer.publicKeyHex))).toBe(true);
      const failures = bundle.events.filter((event) => event.type === "execution_failed");
      expect(failures, "a device-confirmed abort must include exactly one execution_failed").toHaveLength(1);
      // Assumes a contract-honouring adapter; real IppAdapter origin stamping and its
      // cancel-confirm deadline are not tested here (adk was asked in bus #7752).
      expect(failures[0]!.payload).toMatchObject({ ippJobId, origin: "device" });
      if (silent) expect(failures[0]!.payload).toMatchObject({ reason: "cancel-unconfirmed" });
      expect((result as PrintJobResult & { failure?: unknown }).failure)
        .toMatchObject({ kind: "aborted", origin: "device" });
      expect((result as PrintJobResult & { cancelRequested?: unknown }).cancelRequested).toBeTruthy();
      if (silent) {
        const following = await completingPrint(setup, job("after-silent-abort"), 126,
          "a following print must start instead of a busy refusal with reason quiescing");
        expect(following.success).toBe(true);
      }
    });
  }

  gap("GAP-6 the unit fields reach every event", async () => {
    const setup = harness("gap-6");
    const unit = {
      settlementUnitId: `0x${"a".repeat(64)}`,
      challengeNonce: `0x${"b".repeat(64)}`,
    };
    // Requested host inputs: the current PrintJobOptions does not expose these yet.
    const options = { ...job("unit-bound"), ...unit } as Omit<PrintJobOptions, "adapter" | "emitter">;
    const result = await completingPrint(setup, options, 106);
    expect(result.success).toBe(true);
    expect(result.events).toHaveLength(3);
    expect(result.bundle, "unit-bound events must be in a signed bundle").toBeDefined();
    expect(result.bundle!.events, "the signed bundle must contain all three print events").toHaveLength(3);
    for (const event of result.bundle!.events) {
      expect(event.payload, `${event.type} must commit settlementUnitId and challengeNonce`)
        .toMatchObject(unit);
    }
  });

  gap("GAP-7 a unit-level evidence session signs ONE journaled bundle under a delegated session key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T00:00:00.000Z"));
    const setup = harness("gap-7");
    const journalDir = await mkdtemp(join(tmpdir(), "n144-unit-evidence-"));
    cleanups.push(() => rm(journalDir, { recursive: true, force: true }));
    const sdk = await import("@pcc/kernel-sdk") as Record<string, unknown>;
    const kernel = await import("@pcc/kernel") as Record<string, unknown>;
    const requestedApi = {
      openUnitEvidenceSession: sdk.openUnitEvidenceSession ?? kernel.openUnitEvidenceSession,
      resumeUnitEvidenceSession: sdk.resumeUnitEvidenceSession ?? kernel.resumeUnitEvidenceSession,
    };
    expect(typeof requestedApi.openUnitEvidenceSession, "missing toolkit API: openUnitEvidenceSession").toBe("function");
    expect(typeof requestedApi.resumeUnitEvidenceSession, "missing toolkit API: resumeUnitEvidenceSession").toBe("function");
    const api = requestedApi as unknown as UnitEvidenceSessionApi;
    const unit = {
      settlementUnitId: `0x${"c".repeat(64)}`,
      challengeNonce: `0x${"d".repeat(64)}`,
    };
    const options = job("delegated-unit");
    const operator = `0x${"ab".repeat(20)}`;
    const parentAgentId = `eip155:84532:${operator}`;
    const fundedAt = Math.floor(Date.now() / 1_000) - 60;
    // The unit is funded before printing; expiresAt is its reclaimAt, including late/retried settle.
    const expiresAt = Math.floor(Date.now() / 1_000) + 3 * 24 * 60 * 60;
    const session = await api.openUnitEvidenceSession({
      ...unit, jobId: options.jobId, parentAgentId, fundedAt,
      deviceSigner: setup.signer, journalDir, expiresAt,
    });
    const result = await completingPrint(setup, options, 107);
    expect(result.success).toBe(true);
    const expectedEvents = structuredClone(result.events);
    // H3 consumes the print's events, never its already signed success bundle.
    await session.addPrintResult(result);
    const carrierEvent = async (
      type: "courier_pickup_confirmed" | "courier_delivery_confirmed",
      providerEventId: string,
    ): Promise<EvidenceEvent> => {
      const event: Omit<EvidenceEvent, "id" | "hash"> = {
        type,
        timestamp: new Date().toISOString(),
        source: {
          deviceId: "easypost:n144-tracking", deviceType: "courier_api",
          kernelId: testIds("gap-7").kernelId, simulated: false,
        },
        payload: {
          jobId: options.jobId, providerEventId, trackingCode: "n144-tracking",
          provenance: "independent_carrier_scan", independentCarrierScan: true,
        },
      };
      return { ...event, id: providerEventId, hash: await hashEvent(event) };
    };
    vi.setSystemTime(new Date("2026-10-09T01:00:00.000Z"));
    const pickup = await carrierEvent("courier_pickup_confirmed", "carrier-pickup");
    expectedEvents.push(structuredClone(pickup));
    await session.addEvent(pickup);
    const deviceSeed = setup.signer.secretKey.subarray(0, 32);
    const keysBeforeResume = await publicKeysFromSeedsOnDisk(journalDir, deviceSeed);
    expect(keysBeforeResume, "the device private seed must not stay at rest before resume")
      .not.toContain(setup.signer.publicKeyHex);
    const resumeOptions = { journalDir, settlementUnitId: unit.settlementUnitId, deviceSigner: setup.signer };
    const tamperedDir = await copyPrivateJournal(journalDir);
    const copiedDir = await copyPrivateJournal(journalDir);
    const copiesKeysBeforeResume = await Promise.all([tamperedDir, copiedDir].map(
      (directory) => publicKeysFromSeedsOnDisk(directory, deviceSeed),
    ));
    for (const keys of copiesKeysBeforeResume) {
      expect(keys, "journal copies must not contain the device private seed before resume")
        .not.toContain(setup.signer.publicKeyHex);
    }
    for (const path of (await journalPaths(tamperedDir)).files) {
      const contents = await readFile(path);
      if (contents.length === 0) continue;
      contents[Math.floor(contents.length / 2)]! ^= 0x01;
      await writeFile(path, contents);
    }
    await expect(Promise.resolve().then(() => api.resumeUnitEvidenceSession({
      ...resumeOptions, journalDir: tamperedDir,
    })), "a broken journal must be refused").rejects.toThrow();
    await expect(Promise.resolve().then(() => api.resumeUnitEvidenceSession({
      ...resumeOptions, journalDir: copiedDir,
    })), "an untampered copied journal must remain resumable").resolves.toBeDefined();
    // Discard the original session and recover the same unit from its journal.
    const resumed = await api.resumeUnitEvidenceSession(resumeOptions);
    vi.setSystemTime(new Date("2026-10-11T01:00:00.000Z"));
    const delivery = await carrierEvent("courier_delivery_confirmed", "carrier-delivery");
    expectedEvents.push(structuredClone(delivery));
    await resumed.addEvent(delivery);
    const bundle = await resumed.finalize();
    expect(bundle.jobId, "the bundle jobId must equal the PCC job id").toBe(options.jobId);
    const authorization = bundle.sessionKeyAuthorization;
    expect(authorization, "the unit bundle must carry device-authorized sessionKeyAuthorization").toBeDefined();
    const sessionPublicKeyHex = authorization!.publicKey.replace(/^0x/, "").toLowerCase();
    expect(keysBeforeResume, "the session private seed must not stay at rest before resume")
      .not.toContain(sessionPublicKeyHex);
    for (const keys of copiesKeysBeforeResume) {
      expect(keys, "journal copies must not contain the session private seed before resume")
        .not.toContain(sessionPublicKeyHex);
    }
    const keysAtRest = await publicKeysFromSeedsOnDisk(journalDir, deviceSeed);
    expect(keysAtRest, "the device private seed must not stay at rest after finalization")
      .not.toContain(setup.signer.publicKeyHex);
    expect(keysAtRest, "the session private seed must not stay at rest after finalization")
      .not.toContain(sessionPublicKeyHex);
    const canonicalBundle = canonicalize(bundle);
    expect(bundle.events).toHaveLength(expectedEvents.length);
    for (const event of bundle.events) {
      expect(event.payload, `${event.type} must commit settlementUnitId and challengeNonce`).toMatchObject(unit);
    }
    for (const event of expectedEvents) {
      expect(bundle.events).toContainEqual(expect.objectContaining({
        type: event.type, timestamp: event.timestamp, source: event.source,
        payload: expect.objectContaining(event.payload),
      }));
    }
    expect(authorization!.parentAgentId, "parentAgentId must identify the operator on chain 84532").toBe(parentAgentId);
    expect(authorization!.scope.contractIds, "contractIds must be exactly the PCC job id").toEqual([options.jobId]);
    const firstEventTimestamp = Math.floor(Math.min(...expectedEvents.map((event) => Date.parse(event.timestamp))) / 1_000);
    expect(Number.isInteger(authorization!.issuedAt), "issuedAt must be whole Unix seconds").toBe(true);
    expect(authorization!.issuedAt, "issuedAt must be at or after fundedAt").toBeGreaterThanOrEqual(fundedAt);
    expect(authorization!.issuedAt, "issuedAt must be at or before the first event").toBeLessThanOrEqual(firstEventTimestamp);
    expect(authorization!.expiresAt, "expiresAt must equal the unit reclaimAt").toBe(expiresAt);
    expect(authorization!.scope.allowedActions).toContain("evidence_submit");
    expect(authorization!.scope.maxSignatures, "maxSignatures must equal the number of events in the ONE bundle")
      .toBe(bundle.events.length);
    const sessionPublicKey = Buffer.from(authorization!.publicKey.replace(/^0x/, ""), "hex");
    expect(sessionPublicKey).toHaveLength(32);
    expect(sessionPublicKey.equals(Buffer.from(setup.signer.publicKeyHex, "hex"))).toBe(false);
    const preimage = sessionKeyDelegationPreimage({
      ...authorization!,
      parentAgentId: authorization!.parentAgentId as Parameters<typeof sessionKeyDelegationPreimage>[0]["parentAgentId"],
      publicKey: sessionPublicKey,
      scope: {
        ...authorization!.scope,
        allowedActions: authorization!.scope.allowedActions as SessionAction[],
      },
    });
    const devicePublicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(setup.signer.publicKeyHex, "hex"),
      ]),
      format: "der",
      type: "spki",
    });
    const parentSignature = Buffer.from(authorization!.parentSignature.replace(/^0x/, ""), "hex");
    expect(verify(null, preimage, devicePublicKey, parentSignature)).toBe(true);
    expect(verifyBundleSignature(bundle, sessionPublicKey)).toBe(true);
    vi.setSystemTime(new Date("2026-10-11T02:00:00.000Z"));
    expect(canonicalize(await resumed.finalize()), "repeat finalization must return the identical journaled bundle at a later instant")
      .toBe(canonicalBundle);
    const finalizedSession = await api.resumeUnitEvidenceSession(resumeOptions);
    expect(canonicalize(await finalizedSession.finalize())).toBe(canonicalBundle);
    await expect(Promise.resolve().then(() => api.resumeUnitEvidenceSession({
      ...resumeOptions, settlementUnitId: `0x${"e".repeat(64)}`,
    }))).rejects.toThrow();
    expect(await expectPrivateJournalFiles(journalDir), "the unit session must persist journal files").toBeGreaterThan(0);
  });

  gap("GAP-8 a busy refusal is reported as busy and emits no failure (N127)", async () => {
    const setup = harness("gap-8");
    setup.adapter.scriptStart({ outcome: "busy" });
    const result = await runPrintJob({ ...job("busy-refusal"), ...setup });
    expect(result.success).toBe(false);
    expect(result.events.filter((event) => event.type === "execution_failed")).toEqual([]);
    expect(setup.emitter.getEvents("busy-refusal", "busy-refusal-print")).toEqual([]);
    // Requested structured result field; no parsing of error/message text.
    const busy = (result as PrintJobResult & { busy?: unknown }).busy;
    expect(busy, "a busy refusal must expose a structured busy object").toMatchObject({ reason: "device" });
  });
});
