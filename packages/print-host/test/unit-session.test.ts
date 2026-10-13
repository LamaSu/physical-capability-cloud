import { createPrivateKey, createPublicKey, randomBytes, verify } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvidenceEmitter, makeKernelEd25519Signer, runPrintJob,
  type PrintJobOptions, type PrintJobResult } from "@pcc/kernel";
import { verifyBundleSignature } from "@pcc/kernel-sdk";
import { canonicalize, COMPROMISED_DEVICE_PUBLIC_KEYS, hashBundle, hashEvent, sessionKeyDelegationPreimage,
  type EvidenceEvent, type SessionAction } from "@pcc/spec";
import { FakeMachineAdapter } from "../src/index.js";
import { loadDeviceKey, type DeviceKey } from "../src/keys.js";
import * as sessionSigners from "../src/kernel-signer.js";
import * as api from "../src/unit-session.js";

const cleanups: Array<() => Promise<void>> = [];
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
const stillPending = Symbol("pending real async work");
const gap7TimeoutMs = 60_000;

function bytes32(): string { return `0x${randomBytes(32).toString("hex")}`; }
function testIds(testId: string) {
  return { kernelId: `n144-print-host-${testId}`, deviceId: `n144-printer-${testId}` };
}
function harness(testId: string) {
  const { kernelId, deviceId } = testIds(testId);
  const adapter = new FakeMachineAdapter(deviceId, kernelId);
  const signer = makeKernelEd25519Signer();
  const emitter = new EvidenceEmitter(kernelId, signer.signFn);
  cleanups.push(async () => { await adapter.dispose(); signer.secretKey.fill(0); });
  return { adapter, signer, emitter };
}
function job(jobId: string): Omit<PrintJobOptions, "adapter" | "emitter"> {
  return { jobId, stepId: `${jobId}-print`, jobName: `${jobId}.pdf`, totalPages: 1, timeoutMs: 300 };
}

async function awaitRealWork<T>(pending: Promise<T>, boundMs: number): Promise<T | typeof stillPending> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<typeof stillPending>((resolve) => {
      timer = realSetTimeout(() => resolve(stillPending), boundMs);
    })]);
  } finally { if (timer) realClearTimeout(timer); }
}
async function drainPrintJob(pending: Promise<PrintJobResult>): Promise<PrintJobResult> {
  const result = await awaitRealWork(pending, 250);
  if (result !== stillPending) return result;
  for (let elapsedMs = 0; vi.isFakeTimers() && elapsedMs < 120_000; elapsedMs += 1_000) {
    await vi.advanceTimersByTimeAsync(1_000);
    const drained = await awaitRealWork(pending, 25);
    if (drained !== stillPending) return drained;
  }
  return pending;
}
async function completingPrint(setup: ReturnType<typeof harness>, options: ReturnType<typeof job>, ippJobId: number) {
  setup.adapter.scriptStart({ outcome: "success", jobId: ippJobId });
  const started = setup.adapter.started();
  const pending = runPrintJob({ ...options, adapter: setup.adapter, emitter: setup.emitter });
  const first = await Promise.race([started.then(() => "started" as const), pending]);
  expect(first, "the scripted print must start").toBe("started");
  setup.adapter.emit("execution_started", { ippJobId, jobName: options.jobName });
  setup.adapter.emit("execution_progress", { ippJobId, totalPages: 1, progress: 100 });
  setup.adapter.emit("execution_completed", { ippJobId, totalPages: 1 });
  return drainPrintJob(pending);
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
    } else if (entry.isFile()) files.push(path);
  }
  return { directories, files };
}
async function expectPrivateJournalFiles(directory: string): Promise<number> {
  const paths = await journalPaths(directory);
  for (const path of paths.directories) expect((await stat(path)).mode & 0o777, `${path} must be mode 0700`).toBe(0o700);
  for (const path of paths.files) expect((await stat(path)).mode & 0o777, `${path} must be mode 0600`).toBe(0o600);
  return paths.files.length;
}

// Copied from the frozen GAP-7 repro: inspect every raw 32-byte window, then
// inspect hex, base64/base64url and JSON byte arrays without importing the repro.
async function publicKeysFromSeedsOnDisk(directory: string, deviceSeed?: Uint8Array): Promise<Set<string>> {
  const candidates = new Set<string>();
  const addByteWindows = (bytes: Buffer) => {
    for (let offset = 0; offset + 32 <= bytes.length; offset++) candidates.add(bytes.subarray(offset, offset + 32).toString("hex"));
  };
  for (const path of (await journalPaths(directory)).files) {
    const bytes = await readFile(path);
    if (deviceSeed) expect(bytes.includes(Buffer.from(deviceSeed)), "journal files must not contain the raw device private seed").toBe(false);
    addByteWindows(bytes);
    const text = bytes.toString("utf8");
    for (const match of text.matchAll(/(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64,}(?![0-9a-fA-F])/g)) {
      const hex = match[0].replace(/^0x/, "").toLowerCase();
      for (let offset = 0; offset + 64 <= hex.length; offset += 2) candidates.add(hex.slice(offset, offset + 64));
    }
    for (const match of text.matchAll(/[A-Za-z0-9+/_-]+={0,2}/g)) {
      if (match[0].length > 8192) continue;
      addByteWindows(Buffer.from(match[0], "base64"));
    }
    const jsonByteRuns = /\[\s*\d+(?:\s*,\s*\d+){31,}\s*\]|\{\s*"\d+"\s*:\s*\d+(?:\s*,\s*"\d+"\s*:\s*\d+){31,}\s*\}/g;
    for (const match of text.matchAll(jsonByteRuns)) {
      let parsed: number[] | Record<string, number>;
      try { parsed = JSON.parse(match[0]); } catch { continue; }
      if (!Array.isArray(parsed) && !Object.keys(parsed).every((key, index) => key === String(index))) continue;
      const values = Array.isArray(parsed) ? parsed : Object.values(parsed);
      if (values.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) addByteWindows(Buffer.from(values));
    }
  }
  const publicKeys = new Set<string>();
  for (const candidate of candidates) {
    const privateKey = createPrivateKey({ key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(candidate, "hex"),
    ]), format: "der", type: "pkcs8" });
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

async function fixture(testId: string, currentSeconds = Math.floor(Date.now() / 1_000)) {
  const directory = await mkdtemp(join(tmpdir(), "printhost-unit-session-"));
  await chmod(directory, 0o700);
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const seed = randomBytes(32);
  cleanups.push(async () => { seed.fill(0); });
  const identity = makeKernelEd25519Signer(seed);
  const keyPath = join(directory, "device.json");
  await writeFile(keyPath, JSON.stringify({
    kind: "pcc-printhost.device-key", version: 1, algorithm: "ed25519", purpose: "unit session runtime test",
    createdAt: new Date(currentSeconds * 1_000).toISOString(), publicKey: identity.signingPublicKey, seed: seed.toString("hex"),
  }), { mode: 0o600 });
  identity.secretKey.fill(0);
  const operator = getAddress(`0x${randomBytes(20).toString("hex")}`);
  const deviceKey = await loadDeviceKey(keyPath, {
    now: new Date(currentSeconds * 1_000), delegationBinding: { chainId: 84532, operator },
  });
  const journalDir = join(directory, "journal");
  const unit = { settlementUnitId: bytes32(), challengeNonce: bytes32() };
  const options = {
    ...unit, jobId: `job-${testId}`, parentAgentId: `eip155:84532:${operator.toLowerCase()}`,
    fundedAt: currentSeconds - 60, expiresAt: currentSeconds + 3 * 24 * 60 * 60, deviceKey, journalDir,
  };
  return { directory, seed, deviceKey, unit, options, kernelId: `kernel-${testId}` };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function eventFor(setup: Fixture, patch: Partial<EvidenceEvent> = {}): Promise<EvidenceEvent> {
  const raw: Omit<EvidenceEvent, "id" | "hash"> = {
    type: "execution_completed", timestamp: new Date().toISOString(),
    source: { deviceId: "printer-runtime", deviceType: "controller", kernelId: setup.kernelId },
    payload: { jobId: setup.options.jobId, ...setup.unit, progress: 100 },
    ...patch,
  };
  return { ...raw, id: `event-${randomBytes(8).toString("hex")}`, hash: await hashEvent(raw) };
}

afterEach(async () => {
  const failures: unknown[] = [];
  try {
    for (const cleanup of cleanups.splice(0)) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
  } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  if (failures.length) throw failures[0];
});

describe("print-host per-unit evidence session", () => {
  it.each(["missing", "different"] as const)("refuses a %s load-time delegation parent before creating a journal or signing (I2)", async (variant) => {
    const setup = await fixture(`parent-${variant}`);
    const before = await readdir(setup.directory);
    const signDelegation = vi.fn(setup.deviceKey.signDelegation);
    const deviceKey = Object.assign(Object.create(Object.getPrototypeOf(setup.deviceKey)), {
      ...setup.deviceKey, signDelegation,
      delegationParent: variant === "missing" ? undefined : `eip155:84532:0x${randomBytes(20).toString("hex")}`,
    }) as DeviceKey;
    const mint = vi.spyOn(sessionSigners, "makeKernelEd25519Signer");
    let caught: unknown;
    try { await api.openUnitEvidenceSession({ ...setup.options, deviceKey }); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: "bad_options", message: "bad_options" });
    expect(Object.keys(caught as object).sort()).toEqual(["code", "name"].sort());
    expect(await readdir(setup.directory)).toEqual(before);
    expect(mint).not.toHaveBeenCalled();
    expect(signDelegation).not.toHaveBeenCalled();
  });

  it("refuses a compromised device with a closed code before creating a journal or signing", async () => {
    const setup = await fixture("compromised-device");
    const before = await readdir(setup.directory);
    const compromised = [...COMPROMISED_DEVICE_PUBLIC_KEYS][0]!;
    const signDelegation = vi.fn(setup.deviceKey.signDelegation);
    const deviceKey = Object.assign(Object.create(Object.getPrototypeOf(setup.deviceKey)), {
      ...setup.deviceKey, publicKeyHex: compromised.slice(2), signingPublicKey: compromised, signDelegation,
    }) as DeviceKey;
    const mint = vi.spyOn(sessionSigners, "makeKernelEd25519Signer");
    let caught: unknown;
    try { await api.openUnitEvidenceSession({ ...setup.options, deviceKey }); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: "compromised_device", message: "compromised_device" });
    expect(Object.keys(caught as object).sort()).toEqual(["code", "name"].sort());
    expect(String(caught)).not.toContain(compromised);
    expect(await readdir(setup.directory)).toEqual(before);
    expect(mint).not.toHaveBeenCalled();
    expect(signDelegation).not.toHaveBeenCalled();
  });

  it.each(["fundedAt", "expiresAt"] as const)("refuses %s outside protocol integer seconds before creating a journal (T2)", async (field) => {
    const setup = await fixture(`range-${field}`);
    const before = await readdir(setup.directory);
    const signDelegation = vi.fn(setup.deviceKey.signDelegation);
    const deviceKey = Object.assign(Object.create(Object.getPrototypeOf(setup.deviceKey)), {
      ...setup.deviceKey, signDelegation,
    }) as DeviceKey;
    const mint = vi.spyOn(sessionSigners, "makeKernelEd25519Signer");
    for (const value of [1_599_999_999, 2 ** 32, setup.options[field] * 1_000, 1_600_000_000.5]) {
      const options = { ...setup.options, fundedAt: 1_600_000_000, expiresAt: 2 ** 32 - 1, deviceKey,
        [field]: value, now: () => 1_800_000_000 };
      let caught: unknown;
      try { await api.openUnitEvidenceSession(options); } catch (error) { caught = error; }
      expect(caught).toMatchObject({ code: "bad_options", message: "bad_options" });
      expect(Object.keys(caught as object).sort()).toEqual(["code", "name"].sort());
      expect(await readdir(setup.directory)).toEqual(before);
    }
    expect(mint).not.toHaveBeenCalled();
    expect(signDelegation).not.toHaveBeenCalled();
  });

  it.each([[1_600_000_000, 1_600_000_001], [2 ** 32 - 2, 2 ** 32 - 1]])(
    "opens valid protocol range boundaries %i to %i", async (fundedAt, expiresAt) => {
      const setup = await fixture(`range-boundary-${fundedAt}`);
      await expect(api.openUnitEvidenceSession({ ...setup.options, fundedAt, expiresAt, now: () => fundedAt })).resolves.toBeDefined();
    },
  );

  it("GAP-7 a unit-level evidence session signs ONE journaled bundle under a delegated session key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T00:00:00.000Z"));
    const setup = harness("gap-7");
    const keyed = await fixture("delegated-unit");
    const journalDir = keyed.options.journalDir;
    expect(typeof api.openUnitEvidenceSession, "missing toolkit API: openUnitEvidenceSession").toBe("function");
    expect(typeof api.resumeUnitEvidenceSession, "missing toolkit API: resumeUnitEvidenceSession").toBe("function");
    const { unit, deviceKey, seed: deviceSeed } = keyed;
    const options = job("delegated-unit");
    const parentAgentId = keyed.options.parentAgentId;
    const fundedAt = Math.floor(Date.now() / 1_000) - 60;
    const expiresAt = Math.floor(Date.now() / 1_000) + 3 * 24 * 60 * 60;
    const session = await api.openUnitEvidenceSession({
      ...unit, jobId: options.jobId, parentAgentId, fundedAt, deviceKey, journalDir, expiresAt,
    });
    const result = await completingPrint(setup, options, 107);
    expect(result.success).toBe(true);
    const expectedEvents = structuredClone(result.events);
    // H3 consumes print events, never the print's already signed success bundle.
    await session.addPrintResult(result);
    const carrierEvent = async (
      type: "courier_pickup_confirmed" | "courier_delivery_confirmed", providerEventId: string,
    ): Promise<EvidenceEvent> => {
      const event: Omit<EvidenceEvent, "id" | "hash"> = {
        type, timestamp: new Date().toISOString(),
        source: { deviceId: "easypost:n144-tracking", deviceType: "courier_api", kernelId: testIds("gap-7").kernelId, simulated: false },
        payload: {
          jobId: options.jobId, providerEventId, trackingCode: "n144-tracking",
          provenance: "independent_carrier_scan", independentCarrierScan: true, ...unit,
        },
      };
      return { ...event, id: providerEventId, hash: await hashEvent(event) };
    };
    vi.setSystemTime(new Date("2026-10-09T01:00:00.000Z"));
    const pickup = await carrierEvent("courier_pickup_confirmed", "carrier-pickup");
    expectedEvents.push(structuredClone(pickup));
    await session.addEvent(pickup);
    const keysBeforeResume = await publicKeysFromSeedsOnDisk(journalDir, deviceSeed);
    expect(keysBeforeResume, "the device private seed must not stay at rest before resume").not.toContain(deviceKey.publicKeyHex);
    const resumeOptions = { journalDir, settlementUnitId: unit.settlementUnitId, deviceKey };
    const tamperedDir = await copyPrivateJournal(journalDir);
    const copiedDir = await copyPrivateJournal(journalDir);
    const copiesKeysBeforeResume = await Promise.all([tamperedDir, copiedDir].map((directory) => publicKeysFromSeedsOnDisk(directory, deviceSeed)));
    for (const keys of copiesKeysBeforeResume) expect(keys, "journal copies must not contain the device private seed before resume").not.toContain(deviceKey.publicKeyHex);
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
    const resumed = await api.resumeUnitEvidenceSession(resumeOptions);
    vi.setSystemTime(new Date("2026-10-11T01:00:00.000Z"));
    const delivery = await carrierEvent("courier_delivery_confirmed", "carrier-delivery");
    expectedEvents.push(structuredClone(delivery));
    await resumed.addEvent(delivery);
    const keysBeforeFinalize = await publicKeysFromSeedsOnDisk(journalDir, deviceSeed);
    const copiedKeysAfterResume = await publicKeysFromSeedsOnDisk(copiedDir, deviceSeed);
    const bundle = await resumed.finalize();
    expect(bundle.jobId, "the bundle jobId must equal the PCC job id").toBe(options.jobId);
    const authorization = bundle.sessionKeyAuthorization;
    expect(authorization, "the unit bundle must carry device-authorized sessionKeyAuthorization").toBeDefined();
    const sessionPublicKeyHex = authorization!.publicKey.replace(/^0x/, "").toLowerCase();
    expect(keysBeforeResume, "the session private seed must not stay at rest before resume").not.toContain(sessionPublicKeyHex);
    for (const keys of copiesKeysBeforeResume) expect(keys, "journal copies must not contain the session private seed before resume").not.toContain(sessionPublicKeyHex);
    expect(keysBeforeFinalize, "the session private seed must not stay at rest in the resumed journal before finalization").not.toContain(sessionPublicKeyHex);
    expect(copiedKeysAfterResume, "the resumed journal copy must not contain the session private seed before finalization").not.toContain(sessionPublicKeyHex);
    const keysAtRest = await publicKeysFromSeedsOnDisk(journalDir, deviceSeed);
    expect(keysAtRest, "the device private seed must not stay at rest after finalization").not.toContain(deviceKey.publicKeyHex);
    expect(keysAtRest, "the session private seed must not stay at rest after finalization").not.toContain(sessionPublicKeyHex);
    const canonicalBundle = canonicalize(bundle);
    const serializedBundle = JSON.stringify(bundle);
    expect(bundle.events).toHaveLength(expectedEvents.length);
    for (const event of bundle.events) expect(event.payload, `${event.type} must commit settlementUnitId and challengeNonce`).toMatchObject(unit);
    for (const event of expectedEvents) expect(bundle.events).toContainEqual(expect.objectContaining({
      type: event.type, timestamp: event.timestamp, source: event.source, payload: expect.objectContaining(event.payload),
    }));
    expect(authorization!.parentAgentId, "parentAgentId must identify the operator on chain 84532").toBe(parentAgentId);
    expect(authorization!.scope.contractIds, "contractIds must be exactly the PCC job id").toEqual([options.jobId]);
    const firstEventTimestamp = Math.floor(Math.min(...expectedEvents.map((event) => Date.parse(event.timestamp))) / 1_000);
    expect(Number.isInteger(authorization!.issuedAt), "issuedAt must be whole Unix seconds").toBe(true);
    expect(authorization!.issuedAt, "issuedAt must be at or after fundedAt").toBeGreaterThanOrEqual(fundedAt);
    expect(authorization!.issuedAt, "issuedAt must be at or before the first event").toBeLessThanOrEqual(firstEventTimestamp);
    expect(authorization!.issuedAt).toBe(fundedAt);
    expect(authorization!.expiresAt, "expiresAt must equal the unit reclaimAt").toBe(expiresAt);
    expect(authorization!.scope.allowedActions).toContain("evidence_submit");
    expect(authorization!.scope.maxSignatures, "maxSignatures must equal the number of events in the ONE bundle").toBe(bundle.events.length);
    const sessionPublicKey = Buffer.from(authorization!.publicKey.replace(/^0x/, ""), "hex");
    expect(sessionPublicKey).toHaveLength(32);
    expect(sessionPublicKey.equals(Buffer.from(deviceKey.publicKeyHex, "hex"))).toBe(false);
    const preimage = sessionKeyDelegationPreimage({
      ...authorization!, parentAgentId: authorization!.parentAgentId as Parameters<typeof sessionKeyDelegationPreimage>[0]["parentAgentId"],
      publicKey: sessionPublicKey, scope: { ...authorization!.scope, allowedActions: authorization!.scope.allowedActions as SessionAction[] },
    });
    const devicePublicKey = createPublicKey({ key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(deviceKey.publicKeyHex, "hex"),
    ]), format: "der", type: "spki" });
    const parentSignature = Buffer.from(authorization!.parentSignature.replace(/^0x/, ""), "hex");
    expect(verify(null, preimage, devicePublicKey, parentSignature)).toBe(true);
    expect(verifyBundleSignature(bundle, sessionPublicKey)).toBe(true);
    vi.setSystemTime(new Date("2026-10-11T02:00:00.000Z"));
    const repeated = await resumed.finalize();
    expect(canonicalize(repeated), "repeat finalization must return the identical journaled bundle at a later instant").toBe(canonicalBundle);
    expect(JSON.stringify(repeated), "repeat finalization preserves serialized bytes").toBe(serializedBundle);
    const finalizedSession = await api.resumeUnitEvidenceSession(resumeOptions);
    const recovered = await finalizedSession.finalize();
    expect(canonicalize(recovered)).toBe(canonicalBundle);
    expect(JSON.stringify(recovered)).toBe(serializedBundle);
    await expect(Promise.resolve().then(() => api.resumeUnitEvidenceSession({
      ...resumeOptions, settlementUnitId: bytes32(),
    }))).rejects.toThrow();
    expect(await expectPrivateJournalFiles(journalDir), "the unit session must persist journal files").toBeGreaterThan(0);
  }, gap7TimeoutMs);

  it("the copied GAP-7 seed scan detects encoded secrets and ignores hashes and signatures", async () => {
    const setup = await fixture("seed-scan");
    const directory = join(setup.directory, "scan");
    await mkdir(directory, { mode: 0o700 });
    const seed = randomBytes(32);
    seed.fill(0xfb, 0, 3);
    const signer = makeKernelEd25519Signer(seed);
    cleanups.push(async () => { seed.fill(0); signer.secretKey.fill(0); });
    const scanFile = async (fileName: string, contents: string) => {
      const path = join(directory, fileName);
      try { await writeFile(path, contents); return await publicKeysFromSeedsOnDisk(directory); }
      finally { await rm(path, { force: true }); }
    };
    expect(await scanFile("no-seed.txt", "journal metadata without a private seed\n")).not.toContain(signer.publicKeyHex);
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
    for (const [fileName, form, contents] of forms) expect(await scanFile(fileName, contents), `the scan must find the held key from ${form} alone`).toContain(signer.publicKeyHex);
    const session = await api.openUnitEvidenceSession(setup.options);
    await session.addEvent(await eventFor(setup));
    const bundle = await session.finalize();
    const heldKey = bundle.sessionKeyAuthorization!.publicKey.replace(/^0x/, "");
    expect(verifyBundleSignature(bundle, Buffer.from(heldKey, "hex"))).toBe(true);
    const eventHashes = bundle.events.map((event) => event.hash.replace(/^sha256:/, ""));
    for (const hash of eventHashes) expect(hash).toMatch(/^[0-9a-f]{64}$/i);
    expect(bundle.kernelSignature.value).toMatch(/^[0-9a-f]{128}$/i);
    const hashesAndSignature = [...eventHashes, bundle.kernelSignature.value].join("\n");
    expect(hashesAndSignature, "the false-positive fixture must not contain the device public key").not.toContain(setup.deviceKey.publicKeyHex);
    const foundKeys = await scanFile("hashes-and-signature.txt", hashesAndSignature);
    for (const publicKey of [signer.publicKeyHex, setup.deviceKey.publicKeyHex, heldKey]) expect(foundKeys, "event hashes and a real signature must not identify a held key").not.toContain(publicKey);
    secretKey.fill(0);
  });

  it("the copied GAP-7 raw scan finds seeds and secret keys at every byte offset without false positives", async () => {
    const setup = await fixture("raw-seed-scan");
    const signer = makeKernelEd25519Signer();
    const seed = Buffer.from(signer.secretKey.subarray(0, 32));
    cleanups.push(async () => { seed.fill(0); signer.secretKey.fill(0); });
    const directory = join(setup.directory, "scan");
    await mkdir(directory, { mode: 0o700 });
    const forms = [
      ["raw-seed", seed], ["raw-secret-key", Buffer.from(signer.secretKey)],
      ["raw-odd-offset", Buffer.concat([randomBytes(7), seed, randomBytes(13)])],
    ] as const;
    for (const [form, bytes] of forms) {
      const path = join(directory, form);
      try { await writeFile(path, bytes); expect(await publicKeysFromSeedsOnDisk(directory), `the scan must find the held key from ${form} alone`).toContain(signer.publicKeyHex); }
      finally { await rm(path, { force: true }); }
    }
    await writeFile(join(directory, "random-bytes"), randomBytes(137));
    expect(await publicKeysFromSeedsOnDisk(directory), "random bytes must not identify a held key").not.toContain(signer.publicKeyHex);
  });

  it.each(["settlementUnitId", "challengeNonce", "jobId", "kernelId"] as const)("refuses an event missing %s", async (field) => {
    const setup = await fixture(`missing-${field}`);
    const session = await api.openUnitEvidenceSession(setup.options);
    const event = await eventFor(setup);
    if (field === "kernelId") Reflect.deleteProperty(event.source, "kernelId");
    else delete event.payload[field];
    await expect(Promise.resolve().then(() => session.addEvent(event))).rejects.toThrow();
  });

  it.each(["settlementUnitId", "challengeNonce", "jobId", "kernelId"] as const)("refuses an event with mismatched %s", async (field) => {
    const setup = await fixture(`mismatch-${field}`);
    const session = await api.openUnitEvidenceSession(setup.options);
    const event = await eventFor(setup);
    if (field === "kernelId") event.source.kernelId = "";
    else event.payload[field] = field === "jobId" ? "another-job" : bytes32();
    await expect(Promise.resolve().then(() => session.addEvent(event))).rejects.toThrow();
  });

  it("refuses resume under another device public key", async () => {
    const setup = await fixture("original-device");
    const other = await fixture("other-device");
    await api.openUnitEvidenceSession(setup.options);
    await expect(api.resumeUnitEvidenceSession({
      journalDir: setup.options.journalDir, settlementUnitId: setup.unit.settlementUnitId, deviceKey: other.deviceKey,
    })).rejects.toThrow();
  });

  it("refuses valid JSON with a changed open record and an unchanged hash chain", async () => {
    const setup = await fixture("hash-only-tamper");
    await api.openUnitEvidenceSession(setup.options);
    const paths = (await journalPaths(setup.options.journalDir)).files.sort();
    expect(paths).toHaveLength(1);
    const path = paths[0]!;
    const record = JSON.parse(await readFile(path, "utf8")) as {
      hash: string; record: { binding: { parentAgentId: string } };
    };
    const originalHash = record.hash;
    record.record.binding.parentAgentId = `eip155:84532:0x${randomBytes(20).toString("hex")}`;
    await writeFile(path, canonicalize(record));
    expect(JSON.parse(await readFile(path, "utf8")).hash).toBe(originalHash);
    await expect(api.resumeUnitEvidenceSession({
      journalDir: setup.options.journalDir, settlementUnitId: setup.unit.settlementUnitId, deviceKey: setup.deviceKey,
    })).rejects.toMatchObject({ code: "journal_integrity", message: "journal_integrity" });
  });

  it("refuses an intact copied journal when the requested settlement unit differs", async () => {
    const setup = await fixture("wrong-unit");
    await api.openUnitEvidenceSession(setup.options);
    const copy = await copyPrivateJournal(setup.options.journalDir);
    await expect(api.resumeUnitEvidenceSession({
      journalDir: copy, settlementUnitId: bytes32(), deviceKey: setup.deviceKey,
    })).rejects.toMatchObject({ code: "unit_mismatch", message: "unit_mismatch" });
  });

  it.each([
    "2026-02-30T12:00:00.000Z", "2026-10-09T12:00:00", "2026-10-09t12:00:00z",
    "2026-10-09T12:00:60Z", "2026-10-09T12:00:00+25:00",
  ])("refuses an event with malformed timestamp %s", async (timestamp) => {
    const setup = await fixture("malformed-time");
    const session = await api.openUnitEvidenceSession(setup.options);
    await expect(session.addEvent(await eventFor(setup, { timestamp })))
      .rejects.toMatchObject({ code: "event_time", message: "event_time" });
  });

  it("refuses a second event from a different source kernel", async () => {
    const setup = await fixture("kernel-consistency");
    const session = await api.openUnitEvidenceSession(setup.options);
    await session.addEvent(await eventFor(setup));
    const next = await eventFor(setup);
    next.source.kernelId = "kernel-another";
    await expect(session.addEvent(next)).rejects.toMatchObject({ code: "event_binding" });
  });

  it("gateway commitRelayEvidence accepts this session's canonical event and bundle hashes", async () => {
    const setup = await fixture("gateway-parity");
    const session = await api.openUnitEvidenceSession(setup.options);
    await session.addEvent(await eventFor(setup));
    const bundle = await session.finalize();
    for (const { id: _id, hash, ...event } of bundle.events) expect(hash).toBe(await hashEvent(event));
    expect(bundle.bundleHash).toBe(await hashBundle(bundle.events));
    // Runtime-only relative import keeps the gateway beyond print-host rootDir.
    const modulePath = "../../gateway/src/services/relay-evidence-commitment.ts";
    const gateway = await import(modulePath) as { commitRelayEvidence: (
      evidence: unknown, captured: null, job: { jobId: string; kernelId: string },
    ) => Promise<{ ok: boolean; commitment?: { bundleHash: string; hashModel: string; events: unknown[] } }> };
    const committed = await gateway.commitRelayEvidence(bundle, null, { jobId: setup.options.jobId, kernelId: setup.kernelId });
    expect(committed).toMatchObject({ ok: true, commitment: {
      bundleHash: bundle.bundleHash, hashModel: "event_bundle_hash", events: bundle.events.map(({ id: _id, ...event }) => event),
    } });
  });

  it("mints a distinct session public key for each unit", async () => {
    const setup = await fixture("distinct-key");
    const first = await api.openUnitEvidenceSession(setup.options);
    await first.addEvent(await eventFor(setup));
    const firstBundle = await first.finalize();
    const other = { ...setup, unit: { settlementUnitId: bytes32(), challengeNonce: bytes32() } };
    other.options = { ...setup.options, ...other.unit, journalDir: join(setup.directory, "second-journal") };
    const second = await api.openUnitEvidenceSession(other.options);
    await second.addEvent(await eventFor(other));
    const secondBundle = await second.finalize();
    expect(firstBundle.sessionKeyAuthorization!.publicKey).not.toBe(secondBundle.sessionKeyAuthorization!.publicKey);
    for (const bundle of [firstBundle, secondBundle]) expect(verifyBundleSignature(bundle,
      Buffer.from(bundle.sessionKeyAuthorization!.publicKey.replace(/^0x/, ""), "hex"))).toBe(true);
  });

  it("clock skew waits the complete 120-second bound before a closed refusal", async () => {
    const setup = await fixture("clock-skew-refusal");
    vi.useFakeTimers();
    const fundedAt = setup.options.fundedAt;
    let state = "pending";
    let caught: unknown;
    const pending = api.openUnitEvidenceSession({ ...setup.options, now: () => fundedAt - 1 }).then(
      () => { state = "resolved"; }, (error: unknown) => { state = "rejected"; caught = error; },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(state, "clock skew cannot reject immediately or open with issuedAt below fundedAt").toBe("pending");
    await vi.advanceTimersByTimeAsync(119_999);
    expect(state, "the host must allow the full 120 seconds for its clock to catch up").toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(state).toBe("rejected");
    expect(caught).toMatchObject({ code: "clock_skew", message: "clock_skew" });
    expect(Object.keys(caught as object).sort()).toEqual(["code", "name"].sort());
  });

  it("clock skew proceeds when the host clock catches up and never back-dates below fundedAt", async () => {
    const setup = await fixture("clock-skew-catchup");
    vi.useFakeTimers();
    let now = setup.options.fundedAt - 1;
    let opened = false;
    const pending = api.openUnitEvidenceSession({ ...setup.options, now: () => now }).then((session) => { opened = true; return session; });
    await vi.advanceTimersByTimeAsync(0);
    expect(opened).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(opened).toBe(false);
    now = setup.options.fundedAt;
    await vi.advanceTimersByTimeAsync(1_000);
    const session = await pending;
    expect(opened).toBe(true);
    const event = await eventFor(setup, { timestamp: new Date(now * 1_000).toISOString() });
    await session.addEvent(event);
    const bundle = await session.finalize();
    expect(bundle.sessionKeyAuthorization!.issuedAt).toBe(setup.options.fundedAt);
    expect(bundle.sessionKeyAuthorization!.issuedAt).toBeGreaterThanOrEqual(setup.options.fundedAt);
  });

  it("mints only at finalization and zeroizes the mocked session secret after signing", async () => {
    const setup = await fixture("zeroize-success");
    const original = sessionSigners.makeKernelEd25519Signer;
    const secrets: Uint8Array[] = [];
    const mint = vi.spyOn(sessionSigners, "makeKernelEd25519Signer").mockImplementation((seed) => {
      const signer = original(seed); secrets.push(signer.secretKey); return signer;
    });
    const session = await api.openUnitEvidenceSession(setup.options);
    await session.addEvent(await eventFor(setup));
    expect(mint, "no session key exists during transit").not.toHaveBeenCalled();
    const bundle = await session.finalize();
    expect(mint).toHaveBeenCalledOnce();
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.some((byte) => byte !== 0), "the captured session secret is erased before finalize resolves").toBe(false);
    expect(verifyBundleSignature(bundle, Buffer.from(bundle.sessionKeyAuthorization!.publicKey.replace(/^0x/, ""), "hex"))).toBe(true);
    await session.finalize();
    const resumed = await api.resumeUnitEvidenceSession({
      journalDir: setup.options.journalDir, settlementUnitId: setup.unit.settlementUnitId, deviceKey: setup.deviceKey,
    });
    await resumed.finalize();
    expect(mint, "a journaled final record never re-signs").toHaveBeenCalledOnce();
  });

  it("concurrent sessions sharing a journal finalize one identical bundle and mint once", async () => {
    const setup = await fixture("concurrent-finalize");
    const first = await api.openUnitEvidenceSession(setup.options);
    await first.addEvent(await eventFor(setup));
    const second = await api.resumeUnitEvidenceSession({
      journalDir: setup.options.journalDir, settlementUnitId: setup.unit.settlementUnitId, deviceKey: setup.deviceKey,
    });
    const mint = vi.spyOn(sessionSigners, "makeKernelEd25519Signer");
    const [a, b] = await Promise.all([first.finalize(), second.finalize()]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(mint).toHaveBeenCalledOnce();
    expect(verifyBundleSignature(a, Buffer.from(a.sessionKeyAuthorization!.publicKey.replace(/^0x/, ""), "hex"))).toBe(true);
  });

  it("a finalized journal copy replays identical bytes after expiresAt without minting a key", async () => {
    const setup = await fixture("expired-final-copy");
    const session = await api.openUnitEvidenceSession(setup.options);
    await session.addEvent(await eventFor(setup));
    const finalized = await session.finalize();
    const serialized = JSON.stringify(finalized);
    const copy = await copyPrivateJournal(setup.options.journalDir);
    finalized.events[0]!.payload.progress = 0;
    finalized.kernelSignature.value = "caller-mutated";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date((setup.options.expiresAt + 30 * 24 * 60 * 60) * 1_000));
    const mint = vi.spyOn(sessionSigners, "makeKernelEd25519Signer");
    expect(JSON.stringify(await session.finalize())).toBe(serialized);
    const recovered = await api.resumeUnitEvidenceSession({
      journalDir: copy, settlementUnitId: setup.unit.settlementUnitId, deviceKey: setup.deviceKey,
    });
    expect(JSON.stringify(await recovered.finalize())).toBe(serialized);
    expect(mint).not.toHaveBeenCalled();
  });

  it("zeroizes the mocked session secret and exposes only a closed code when delegation fails", async () => {
    const setup = await fixture("zeroize-failure");
    const original = sessionSigners.makeKernelEd25519Signer;
    const secrets: Uint8Array[] = [];
    vi.spyOn(sessionSigners, "makeKernelEd25519Signer").mockImplementation((seed) => {
      const signer = original(seed); secrets.push(signer.secretKey); return signer;
    });
    const sensitive = setup.seed.toString("hex");
    const deviceKey = Object.assign(Object.create(Object.getPrototypeOf(setup.deviceKey)), {
      ...setup.deviceKey, signDelegation: vi.fn().mockRejectedValue(new Error(sensitive)),
    }) as DeviceKey;
    const session = await api.openUnitEvidenceSession({ ...setup.options, deviceKey });
    await session.addEvent(await eventFor(setup));
    let caught: unknown;
    try { await session.finalize(); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: "signing_failed", message: "signing_failed" });
    expect(String(caught)).not.toContain(sensitive);
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.some((byte) => byte !== 0), "a rejected delegation still erases the session secret").toBe(false);
  });
});
