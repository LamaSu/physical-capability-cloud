import { randomBytes, createPrivateKey, createPublicKey, verify } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrintJobOptions, PrintJobResult } from "@pcc/kernel";
import { runPrintJob } from "../../kernel/dist/printer-job.js";
import { verifyBundleSignature } from "@pcc/kernel-sdk";
import { getAddress } from "viem";
import { makeKernelEd25519Signer } from "../src/kernel-signer.js";
import * as kernelSigners from "../src/kernel-signer.js";
import * as unitSessions from "../src/unit-session.js";
import { loadDeviceKey, type DeviceKey } from "../src/keys.js";
import { checkDelegationScope, hashEvent, sessionKeyDelegationPreimage, type EvidenceBundle, type EvidenceEvent, type SessionAction } from "@pcc/spec";
import type { HostConfig } from "../src/config.js";
import { createGatewayClient, type GatewayClient, type GwCode, type GwResult, type PollJobsValue, type RelayEvidenceBundle } from "../src/gateway-client.js";
import { createHost, HOST_LOG_CODES, type HostLogCode } from "../src/host.js";
import { createJobJournal } from "../src/journal.js";
import { defaultJobInputSource, type JobInputSource } from "../src/job-inputs.js";
import { FakeMachineAdapter } from "../src/testing/fake-machine-adapter.js";

const jobId = "job:buyer";
const anotherJob = "job:second";
const cleanups: Array<() => Promise<void>> = [];
const documentCanary = `private-document-${randomBytes(24).toString("hex")}`;
const secretCanary = `private-key-${randomBytes(24).toString("hex")}`;
const serverCanary = `server-text-${randomBytes(24).toString("hex")}`;

/** Only the host's clocks are advanced; filesystem and kernel signing finish normally. */
class ManualTimers {
  now = Date.now();
  private id = 0;
  private readonly pending = new Map<number, { due: number; callback: () => void }>();
  setTimeout = (callback: () => void, ms: number): unknown => {
    const id = ++this.id;
    this.pending.set(id, { due: this.now + ms, callback });
    return id;
  };
  clearTimeout = (handle: unknown): void => { this.pending.delete(handle as number); };
  async advance(ms: number): Promise<void> {
    this.now += ms;
    const due = [...this.pending].filter(([, timer]) => timer.due <= this.now);
    for (const [id, timer] of due) { this.pending.delete(id); timer.callback(); }
    for (let index = 0; index < 20; index++) await Promise.resolve();
  }
  get count(): number { return this.pending.size; }
}

function poll(jobs = [jobId], stop: PollJobsValue["stop"] = { proceed: true }): GwResult<PollJobsValue> {
  return { ok: true, value: { stop, jobs: jobs.map((id) => ({ jobId: id, status: "queued" })), foreignJobsDropped: 0, truncated: false } };
}

function failed(code: GwCode, retryAfterS?: number): Extract<GwResult<never>, { ok: false }> {
  return { ok: false, code, status: null, ...(retryAfterS === undefined ? {} : { retryAfterS }) };
}

function gateway() {
  return {
    pollJobs: vi.fn(async (): Promise<GwResult<PollJobsValue>> => poll()),
    heartbeat: vi.fn(async () => ({ ok: true as const, value: null })),
    reportInProgress: vi.fn(async (_id: string) => ({ ok: true as const, value: { updated: true as const } })),
    postRelayEvidence: vi.fn(async (id: string, bundle: RelayEvidenceBundle) => ({
      ok: true as const, value: { jobId: id, contentHash: bundle.bundleHash, hashModel: "event_bundle_hash" as const },
    })),
    toJSON: () => ({ baseUrl: "https://gateway.example.test", kernelId: "kernel:test" }),
    toString: () => "gateway",
    [inspect.custom]: () => ({ baseUrl: "https://gateway.example.test", kernelId: "kernel:test" }),
  };
}

type Print = (options: PrintJobOptions) => Promise<PrintJobResult>;
async function fixture(options: {
  adapterOptions?: ConstructorParameters<typeof FakeMachineAdapter>[2];
  simulated?: boolean;
  gateway?: GatewayClient;
  inputSource?: JobInputSource;
  print?: Print;
  pollOnly?: boolean;
  stopSignal?: AbortSignal;
  eStopPollIntervalMs?: number;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "print-host-loop-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const timers = new ManualTimers();
  const config: HostConfig = {
    kernelId: "kernel:test", deviceId: "device:test", printer: { uri: "ipp://localhost/ipp/print" },
    chain: { chainId: 31337, rpcUrlFile: "/unused/rpc" },
    gateway: { baseUrl: "https://gateway.example.test", apiKeyFile: "/unused/api-key" },
    keys: { deviceKeyFile: "/unused/device", operatorKeyFile: "/unused/operator" },
    dataDir: dir,
    ...(options.eStopPollIntervalMs === undefined ? {} : { eStopPollIntervalMs: options.eStopPollIntervalMs }),
  };
  const adapter = new FakeMachineAdapter(config.deviceId, config.kernelId, options.adapterOptions);
  adapter.source.simulated = options.simulated ?? false;
  cleanups.push(() => adapter.dispose());
  const seed = randomBytes(32);
  const identity = makeKernelEd25519Signer(seed);
  const deviceKeyFile = join(dir, "device.json");
  await writeFile(deviceKeyFile, JSON.stringify({
    kind: "pcc-printhost.device-key", version: 1, algorithm: "ed25519", purpose: "host loop test",
    createdAt: new Date().toISOString(), publicKey: identity.signingPublicKey, seed: seed.toString("hex"),
  }), { mode: 0o600 });
  identity.secretKey.fill(0);
  const operatorAddress = getAddress(`0x${randomBytes(20).toString("hex")}`);
  const loaded = await loadDeviceKey(deviceKeyFile, { delegationBinding: { chainId: 31337, operator: operatorAddress } });
  const deviceKey = Object.assign(Object.create(Object.getPrototypeOf(loaded)), {
    ...loaded, signDelegation: vi.fn(loaded.signDelegation), signD2: vi.fn(loaded.signD2),
  }) as DeviceKey;
  cleanups.push(async () => { seed.fill(0); });
  const unit = { settlementUnitId: `0x${randomBytes(32).toString("hex")}`, challengeNonce: `0x${randomBytes(32).toString("hex")}`,
    fundedAt: Math.floor(Math.min(Date.UTC(2026, 9, 9), timers.now) / 1_000) - 60, reclaimAt: Math.floor(timers.now / 1_000) + 3 * 24 * 60 * 60 };
  const journal = createJobJournal(dir, () => timers.now);
  const gw = gateway();
  const inputSource = vi.fn(options.inputSource ?? (async () => ({ ok: true as const, value: {
    documentData: Buffer.from(`%PDF-1.7\n${documentCanary}`), jobName: "buyer.pdf", totalPages: 2,
    unit,
  } })));
  const logs: HostLogCode[] = [];
  const deps = {
    config, gateway: options.gateway ?? gw, inputSource, adapter, deviceKey, operatorAddress, journal,
    clock: () => timers.now, timers, logger: (code: HostLogCode) => { logs.push(code); },
    timeoutMs: 500, cancelWindowMs: 100,
    ...(options.print ? { print: options.print } : {}),
    ...(options.pollOnly === undefined ? {} : { pollOnly: options.pollOnly }),
    ...(options.stopSignal ? { stopSignal: options.stopSignal } : {}),
  };
  const host = createHost(deps);
  return { dir, timers, config, adapter, seed, deviceKey, operatorAddress, unit, journal, gw, inputSource, logs, deps, host };
}

async function states(setup: Awaited<ReturnType<typeof fixture>>, id = jobId) {
  return (await setup.journal.read(id)).map((record) => record.state);
}

async function finishedWithin<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("host tick did not finish")), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function complete(setup: Awaited<ReturnType<typeof fixture>>, ippJobId = 101) {
  setup.adapter.scriptStart({ outcome: "success", jobId: ippJobId });
  const started = setup.adapter.started();
  const tick = setup.host.runOnce();
  await finishedWithin(started);
  setup.adapter.emit("execution_started", { ippJobId });
  setup.adapter.emit("execution_completed", { ippJobId, totalPages: 2 });
  await finishedWithin(tick);
}

function expectSigned(bundle: RelayEvidenceBundle, deviceKey: DeviceKey) {
  const authorization = bundle.sessionKeyAuthorization;
  expect(authorization, "the posted bundle must carry the SESSION authorization").toBeDefined();
  expect(bundle.kernelSignature?.algorithm).toBe("ed25519");
  const sessionPublicKey = Buffer.from(authorization!.publicKey.replace(/^0x/, ""), "hex");
  expect(verifyBundleSignature(bundle as EvidenceBundle, sessionPublicKey)).toBe(true);
  expect(verifyBundleSignature(bundle as EvidenceBundle, Buffer.from(deviceKey.publicKeyHex, "hex")),
    "the device key never signs a bundle").toBe(false);
  const devicePublicKey = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(deviceKey.publicKeyHex, "hex")]),
    format: "der", type: "spki",
  });
  const delegation = { ...authorization!, publicKey: sessionPublicKey,
    parentAgentId: authorization!.parentAgentId as Parameters<typeof sessionKeyDelegationPreimage>[0]["parentAgentId"],
    scope: { ...authorization!.scope, allowedActions: authorization!.scope.allowedActions as SessionAction[] } };
  expect(verify(null, sessionKeyDelegationPreimage(delegation), devicePublicKey,
    Buffer.from(authorization!.parentSignature.replace(/^0x/, ""), "hex"))).toBe(true);
  expect(checkDelegationScope(authorization, { settlingJobId: (bundle as EvidenceBundle).jobId ?? jobId, sessionSignedEventCount: bundle.events.length })).toEqual({ ok: true });
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

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

describe("print-host run loop", () => {
  it("claims, reports, re-polls and saves the signed bundle before posting with exact private journal order", async () => {
    const setup = await fixture();
    const actions: string[] = [];
    setup.gw.pollJobs.mockImplementation(async () => { actions.push("poll"); return poll(); });
    setup.gw.reportInProgress.mockImplementation(async () => {
      actions.push("in_progress"); expect(await states(setup)).toEqual(["claimed"]);
      return { ok: true, value: { updated: true } };
    });
    setup.gw.postRelayEvidence.mockImplementation(async (id, bundle) => {
      actions.push("post");
      const saved = JSON.parse(await readFile(setup.journal.bundlePath(id), "utf8"));
      expect(saved).toEqual(bundle);
      expect(await states(setup)).toEqual(["claimed", "in_progress_reported", "printing", "printed", "bundle_saved"]);
      expectSigned(bundle, setup.deviceKey);
      return { ok: true, value: { jobId: id, contentHash: bundle.bundleHash, hashModel: "event_bundle_hash" } };
    });
    await complete(setup);
    expect(actions).toEqual(["poll", "in_progress", "poll", "post"]);
    expect(await states(setup)).toEqual(["claimed", "in_progress_reported", "printing", "printed", "bundle_saved", "evidence_stored"]);
    expect(setup.adapter.commands.map((command) => command.type)).toEqual(["start"]);
    expect(setup.gw.reportInProgress).toHaveBeenCalledWith(jobId);
    expect((await stat(setup.journal.directory)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(setup.journal.directory)) {
      const path = join(setup.journal.directory, name);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const bytes = await readFile(path);
      for (const canary of [documentCanary, secretCanary, serverCanary, setup.seed.toString("hex")]) {
        expect(bytes.toString("utf8")).not.toContain(canary);
      }
      expect(bytes.includes(Buffer.from(setup.seed))).toBe(false);
    }
    for (const log of setup.logs) expect(HOST_LOG_CODES).toContain(log);
    expect(JSON.stringify(setup.logs)).not.toContain(documentCanary);
    expect(JSON.stringify(setup.logs)).not.toContain(secretCanary);
  });

  it("opens the per-unit SESSION after in_progress with the public operator and exact funded binding", async () => {
    const setup = await fixture();
    const original = unitSessions.openUnitEvidenceSession;
    const open = vi.spyOn(unitSessions, "openUnitEvidenceSession").mockImplementation(async (options) => {
      expect(await states(setup)).toEqual(["claimed", "in_progress_reported"]);
      return original(options);
    });
    await complete(setup);
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0]![0]).toMatchObject({
      settlementUnitId: setup.unit.settlementUnitId, challengeNonce: setup.unit.challengeNonce,
      fundedAt: setup.unit.fundedAt, expiresAt: setup.unit.reclaimAt, jobId,
      parentAgentId: `eip155:31337:${setup.operatorAddress.toLowerCase()}`,
      deviceKey: setup.deviceKey, journalDir: join(setup.dir, "sessions", "job%3Abuyer"),
    });
    expect((await stat(setup.journal.sessionDirectory(jobId))).mode & 0o777).toBe(0o700);
    const bundle = setup.gw.postRelayEvidence.mock.calls[0]![1];
    expect(bundle.sessionKeyAuthorization).toMatchObject({
      parentAgentId: `eip155:31337:${setup.operatorAddress.toLowerCase()}`,
      issuedAt: setup.unit.fundedAt, expiresAt: setup.unit.reclaimAt,
      scope: { contractIds: [jobId], maxSignatures: bundle.events.length },
    });
    expectSigned(bundle, setup.deviceKey);
  });

  it("discards print bundles and uses a fresh erased throwaway signer for every job without widening the device key", async () => {
    const setup = await fixture();
    const original = kernelSigners.makeKernelEd25519Signer;
    const signers: ReturnType<typeof makeKernelEd25519Signer>[] = [];
    vi.spyOn(kernelSigners, "makeKernelEd25519Signer").mockImplementation((seed) => {
      const signer = original(seed); signers.push(signer); return signer;
    });
    const results: PrintJobResult[] = [];
    const print = vi.fn(async (options: PrintJobOptions) => {
      const result = await runPrintJob(options);
      results.push(result);
      return result;
    });
    const host = createHost({ ...setup.deps, print });
    setup.gw.pollJobs.mockResolvedValue(poll([jobId, anotherJob]));
    for (const ippJobId of [811, 812]) {
      setup.adapter.scriptStart({ outcome: "success", jobId: ippJobId });
      const started = setup.adapter.started();
      const tick = host.runOnce();
      await finishedWithin(started);
      setup.adapter.emit("execution_started", { ippJobId });
      setup.adapter.emit("execution_completed", { ippJobId, totalPages: 2 });
      expect(await finishedWithin(tick)).not.toHaveProperty("bundle");
    }
    expect(print).toHaveBeenCalledTimes(2);
    expect(signers).toHaveLength(4);
    expect(print.mock.calls[0]![0].emitter).not.toBe(print.mock.calls[1]![0].emitter);
    const throwaways = results.map((result) => signers.find((signer) => result.bundle?.kernelSignature.signer === `0x${signer.publicKeyHex.slice(0, 40)}`)!);
    expect(throwaways.every(Boolean)).toBe(true);
    expect(throwaways[0]!.publicKeyHex).not.toBe(throwaways[1]!.publicKeyHex);
    for (const signer of signers) expect(signer.secretKey.some((byte) => byte !== 0), "every ephemeral secret must be erased").toBe(false);
    expect(Reflect.has(setup.deviceKey, "signFn")).toBe(false);
    expect(setup.deviceKey.signDelegation).toHaveBeenCalledTimes(2);
    expect(setup.deviceKey.signD2).not.toHaveBeenCalled();
    for (let index = 0; index < results.length; index++) {
      const result = results[index]!;
      expect(result.bundle).toBeDefined();
      expect(result.bundle!.sessionKeyAuthorization).toBeUndefined();
      const [id, posted] = setup.gw.postRelayEvidence.mock.calls[index]!;
      expectSigned(posted, setup.deviceKey);
      expect(posted).not.toEqual(result.bundle);
      expect(posted.kernelSignature).not.toEqual(result.bundle!.kernelSignature);
      expect(posted.events).toEqual(result.events);
      expect(posted.sessionKeyAuthorization!.publicKey).not.toBe(throwaways[index]!.publicKeyHex);
      expect(JSON.parse(await readFile(setup.journal.bundlePath(id), "utf8"))).toEqual(posted);
      for (const directory of [setup.journal.directory, setup.journal.sessionDirectory(id)]) {
        for (const path of (await journalPaths(directory)).files) {
          const text = await readFile(path, "utf8");
          expect(text).not.toContain(result.bundle!.id);
          expect(text).not.toContain(result.bundle!.kernelSignature.value);
        }
      }
    }
  });

  it("adds every result event in order before finalizing the SESSION and accepts the gateway commitment", async () => {
    const setup = await fixture();
    const original = unitSessions.openUnitEvidenceSession;
    const order: string[] = [];
    vi.spyOn(unitSessions, "openUnitEvidenceSession").mockImplementation(async (options) => {
      const session = await original(options);
      return { ...session,
        addEvent: async (event) => { order.push(event.id); await session.addEvent(event); },
        finalize: async () => { order.push("finalize"); return session.finalize(); },
      };
    });
    let result!: PrintJobResult;
    const print = vi.fn(async (options: PrintJobOptions) => { result = await runPrintJob(options); return result; });
    const host = createHost({ ...setup.deps, print });
    setup.adapter.scriptStart({ outcome: "success", jobId: 813 });
    const tick = host.runOnce();
    await finishedWithin(setup.adapter.started());
    setup.adapter.emit("execution_started", { ippJobId: 813 });
    setup.adapter.emit("execution_progress", { ippJobId: 813, progress: 50 });
    setup.adapter.emit("execution_completed", { ippJobId: 813, totalPages: 2 });
    await finishedWithin(tick);
    expect(result.events.length).toBeGreaterThanOrEqual(3);
    expect(order).toEqual([...result.events.map((event) => event.id), "finalize"]);
    const bundle = setup.gw.postRelayEvidence.mock.calls[0]![1];
    expect(bundle.events).toEqual(result.events);
    const modulePath = "../../gateway/src/services/relay-evidence-commitment.ts";
    const { commitRelayEvidence } = await import(modulePath) as { commitRelayEvidence: (
      evidence: unknown, captured: null, job: { jobId: string; kernelId: string },
    ) => Promise<{ ok: boolean; commitment?: { bundleHash: string; hashModel: string; events: unknown[] } }> };
    let sent: { jobId: string; kernelId: string; evidence: RelayEvidenceBundle } | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, options?: RequestInit) => {
      sent = JSON.parse(String(options?.body));
      const committed = await commitRelayEvidence(sent!.evidence, null, { jobId, kernelId: setup.config.kernelId });
      expect(committed).toMatchObject({ ok: true, commitment: {
        bundleHash: bundle.bundleHash, hashModel: "event_bundle_hash",
        events: bundle.events.map(({ id: _id, ...event }) => event),
      } });
      return new Response(JSON.stringify({ stored: true, jobId, contentHash: bundle.bundleHash, hashModel: "event_bundle_hash" }),
        { headers: { "content-type": "application/json" } });
    });
    const gw = createGatewayClient({ baseUrl: "https://gateway.example.test",
      apiKey: `pcc_test_${randomBytes(24).toString("hex")}`, kernelId: setup.config.kernelId, fetchImpl });
    expect(await gw.postRelayEvidence(jobId, bundle)).toMatchObject({ ok: true });
    expect(sent).toEqual({ jobId, kernelId: setup.config.kernelId, evidence: bundle });
  });

  it("the SESSION journals contain no raw or encoded device, print, or session secrets", async () => {
    const setup = await fixture();
    const original = kernelSigners.makeKernelEd25519Signer;
    const signers: ReturnType<typeof makeKernelEd25519Signer>[] = [];
    vi.spyOn(kernelSigners, "makeKernelEd25519Signer").mockImplementation((seed) => {
      const signer = original(seed); signers.push(signer); return signer;
    });
    await complete(setup);
    const directory = setup.journal.sessionDirectory(jobId);
    expect(await expectPrivateJournalFiles(directory)).toBeGreaterThan(1);
    const keys = await publicKeysFromSeedsOnDisk(directory, setup.seed);
    expect(keys).not.toContain(setup.deviceKey.publicKeyHex);
    expect(signers).toHaveLength(2);
    const sessionPublicKey = setup.gw.postRelayEvidence.mock.calls[0]![1].sessionKeyAuthorization!.publicKey;
    expect(keys, "the finalized SESSION private seed must never be recoverable from its journal").not.toContain(sessionPublicKey);
    for (const signer of signers) expect(keys).not.toContain(signer.publicKeyHex);
  }, 60_000);

  it("the default e-stop reader starts nothing", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ jobs: [{ id: jobId, kernelId: "kernel:test", status: "queued" }] }), {
      headers: { "content-type": "application/json" },
    }));
    const gw = createGatewayClient({ baseUrl: "https://gateway.example.test", apiKey: `pcc_test_${"c".repeat(32)}`, kernelId: "kernel:test", fetchImpl });
    const setup = await fixture({ gateway: gw });
    await setup.host.runOnce();
    expect(setup.inputSource).not.toHaveBeenCalled();
    expect(await setup.journal.has(jobId)).toBe(false);
    expect(setup.adapter.commands).toEqual([]);
    expect(setup.logs).toContain("reader_unavailable");
  });

  it("a stop at the pre-print re-poll prints nothing", async () => {
    const print = vi.fn(async (): Promise<PrintJobResult> => ({ success: false, events: [], durationMs: 0 }));
    const setup = await fixture({ print });
    setup.gw.pollJobs.mockResolvedValueOnce(poll()).mockResolvedValueOnce(poll([jobId], { proceed: false, why: "stopped" }));
    await setup.host.runOnce();
    expect(setup.gw.pollJobs).toHaveBeenCalledTimes(2);
    expect(print).not.toHaveBeenCalled();
    expect(await states(setup)).toEqual(["claimed", "in_progress_reported"]);
    expect(setup.gw.postRelayEvidence).not.toHaveBeenCalled();
  });

  it("a failed pre-print re-poll prints nothing", async () => {
    const print = vi.fn(async (): Promise<PrintJobResult> => ({ success: false, events: [], durationMs: 0 }));
    const setup = await fixture({ print });
    setup.gw.pollJobs.mockResolvedValueOnce(poll()).mockResolvedValueOnce(failed("network"));
    await setup.host.runOnce();
    expect(print).not.toHaveBeenCalled();
    expect(await states(setup)).toEqual(["claimed", "in_progress_reported"]);
  });

  it.each(["report", "silent"] as const)("a mid-print stop cancels the %s printer and posts signed failure evidence", async (cancelBehavior) => {
    const setup = await fixture({ adapterOptions: { cancelBehavior, cancelConfirmMs: 5 } });
    setup.gw.pollJobs.mockResolvedValueOnce(poll()).mockResolvedValueOnce(poll()).mockResolvedValueOnce(poll([], { proceed: false, why: "stopped" }));
    setup.adapter.scriptStart({ outcome: "success", jobId: 202 });
    const tick = setup.host.runOnce();
    await finishedWithin(setup.adapter.started());
    await setup.timers.advance(5_000);
    await finishedWithin(tick);
    expect(setup.adapter.cancels).toEqual([202]);
    expect(setup.adapter.commands.map((command) => command.type)).toEqual(["start"]);
    expect(await states(setup)).toEqual(["claimed", "in_progress_reported", "printing", "print_failed", "bundle_saved", "evidence_stored"]);
    expect(setup.gw.postRelayEvidence).toHaveBeenCalledTimes(1);
    const bundle = setup.gw.postRelayEvidence.mock.calls[0]![1];
    expect(bundle.events.some((event) => event.type === "execution_failed")).toBe(true);
    expectSigned(bundle, setup.deviceKey);
    expect(setup.timers.count).toBe(0);
  });

  it("the watcher aborts on a mid-print poll failure", async () => {
    const setup = await fixture();
    setup.gw.pollJobs.mockResolvedValueOnce(poll()).mockResolvedValueOnce(poll()).mockResolvedValueOnce(failed("network"));
    setup.adapter.scriptStart({ outcome: "success", jobId: 303 });
    const tick = setup.host.runOnce();
    await finishedWithin(setup.adapter.started());
    await setup.timers.advance(5_000);
    // Prove the watcher sent cancel before the kernel's independent timeout can fire.
    expect(setup.adapter.cancels).toEqual([303]);
    await finishedWithin(tick);
    expect(await states(setup)).toContain("print_failed");
    expectSigned(setup.gw.postRelayEvidence.mock.calls[0]![1], setup.deviceKey);
  });

  it.each([2, 4])("the watcher keeps polling after clear and aborts at watcher poll %i with signed failure evidence", async (stopAt) => {
    const shutdown = new AbortController();
    const setup = await fixture({ stopSignal: shutdown.signal });
    let printResult: PrintJobResult | undefined;
    const print = vi.fn(async (options: PrintJobOptions) => {
      // The device emits no completion; its guard must outlast every watcher poll.
      printResult = await runPrintJob({ ...options, timeoutMs: 60_000 });
      return printResult;
    });
    const host = createHost({ ...setup.deps, print });
    setup.gw.pollJobs.mockResolvedValueOnce(poll()).mockResolvedValueOnce(poll());
    for (let watcherPoll = 1; watcherPoll < stopAt; watcherPoll++) {
      setup.gw.pollJobs.mockResolvedValueOnce(poll());
    }
    setup.gw.pollJobs.mockResolvedValueOnce(poll([], { proceed: false, why: "stopped" }));
    setup.adapter.scriptStart({ outcome: "success", jobId: 310 + stopAt });
    const tick = host.runOnce();
    try {
      await finishedWithin(setup.adapter.started());
      for (let watcherPoll = 1; watcherPoll < stopAt; watcherPoll++) {
        await setup.timers.advance(5_000);
        expect(setup.gw.pollJobs).toHaveBeenCalledTimes(2 + watcherPoll);
        expect(setup.adapter.cancels).toEqual([]);
        expect(await setup.adapter.getStatus()).toBe("busy");
        expect(printResult).toBeUndefined();
        expect(print.mock.calls[0]![0].signal?.aborted).toBe(false);
        expect(setup.gw.postRelayEvidence).not.toHaveBeenCalled();
      }
      await setup.timers.advance(5_000);
      expect(setup.gw.pollJobs).toHaveBeenCalledTimes(2 + stopAt);
      expect(print.mock.calls[0]![0].signal?.aborted).toBe(true);
      expect(setup.adapter.cancels).toEqual([310 + stopAt]);
      await finishedWithin(tick);
      expect(printResult).toMatchObject({ success: false, cancelRequested: "aborted" });
      expect(await states(setup)).toEqual(["claimed", "in_progress_reported", "printing", "print_failed", "bundle_saved", "evidence_stored"]);
      expect(setup.gw.postRelayEvidence).toHaveBeenCalledTimes(1);
      const [postedJob, bundle] = setup.gw.postRelayEvidence.mock.calls[0]!;
      expect(postedJob).toBe(jobId);
      expect(bundle.events.some((event) => event.type === "execution_failed")).toBe(true);
      expectSigned(bundle, setup.deviceKey);
      expect(setup.timers.count).toBe(0);
    } finally {
      // Also drain the long print when a mutant fails an assertion before aborting it.
      shutdown.abort();
      await finishedWithin(tick);
    }
  });

  it("host shutdown cancels the in-flight job, saves its signed failure and drains run", async () => {
    const setup = await fixture({ adapterOptions: { cancelEventOrder: "after-resolve" } });
    const stop = new AbortController();
    setup.adapter.scriptStart({ outcome: "success", jobId: 404 });
    const running = setup.host.run(stop.signal);
    await finishedWithin(setup.adapter.started());
    stop.abort();
    await finishedWithin(running);
    expect(setup.adapter.cancels).toEqual([404]);
    expect(setup.gw.postRelayEvidence).toHaveBeenCalledTimes(1);
    expect(await states(setup)).toContain("evidence_stored");
    expect(setup.timers.count).toBe(0);
    expect(setup.adapter.commands.every((command) => command.type !== "stop")).toBe(true);
  });

  it("a reported device failure posts a signed failure bundle", async () => {
    const setup = await fixture();
    setup.adapter.scriptStart({ outcome: "success", jobId: 505 });
    const tick = setup.host.runOnce();
    await finishedWithin(setup.adapter.started());
    setup.adapter.emit("execution_failed", { ippJobId: 505, state: "aborted", origin: "device" });
    await finishedWithin(tick);
    expect(await states(setup)).toEqual(["claimed", "in_progress_reported", "printing", "print_failed", "bundle_saved", "evidence_stored"]);
    expectSigned(setup.gw.postRelayEvidence.mock.calls[0]![1], setup.deviceKey);
  });

  it("busy is retried three times and then abandoned", async () => {
    const setup = await fixture();
    for (let attempt = 0; attempt < 3; attempt++) {
      setup.adapter.scriptStart({ outcome: "busy" });
      await setup.host.runOnce();
      await setup.timers.advance(5_000);
    }
    await setup.host.runOnce();
    expect(setup.adapter.commands).toHaveLength(3);
    expect(setup.gw.reportInProgress).toHaveBeenCalledTimes(1);
    expect(await states(setup)).toEqual(["claimed", "in_progress_reported", "printing", "busy", "printing", "busy", "printing", "busy", "abandoned"]);
    expect((await setup.journal.read(jobId)).at(-1)).toMatchObject({ state: "abandoned", code: "busy_retry_limit" });
    expect(setup.gw.postRelayEvidence).not.toHaveBeenCalled();
    const records = await Promise.all((await readdir(setup.journal.sessionDirectory(jobId)))
      .map(async (name) => JSON.parse(await readFile(join(setup.journal.sessionDirectory(jobId), name), "utf8"))));
    expect(records.map((record) => record.record.kind)).toEqual(["open"]);
  });

  it("a busy result contributes no events and never finalizes the SESSION", async () => {
    const print = vi.fn(async (options: PrintJobOptions): Promise<PrintJobResult> => {
      const raw: Omit<EvidenceEvent, "id" | "hash"> = {
        type: "execution_started", timestamp: new Date().toISOString(),
        source: { deviceId: "device:test", deviceType: "controller", kernelId: "kernel:test", simulated: false },
        payload: { jobId: options.jobId, settlementUnitId: options.settlementUnitId, challengeNonce: options.challengeNonce },
      };
      const event = { ...raw, id: `event:${randomBytes(8).toString("hex")}`, hash: await hashEvent(raw) };
      return { success: false, busy: { reason: "device", adapterId: options.adapter.id, jobId: options.jobId },
        events: [event], durationMs: 1 };
    });
    const setup = await fixture({ print });
    const original = unitSessions.openUnitEvidenceSession;
    const addEvent = vi.fn();
    const finalize = vi.fn();
    vi.spyOn(unitSessions, "openUnitEvidenceSession").mockImplementation(async (options) => {
      const session = await original(options);
      addEvent.mockImplementation((event) => session.addEvent(event));
      finalize.mockImplementation(() => session.finalize());
      return { ...session, addEvent, finalize };
    });
    expect(await setup.host.runOnce()).toMatchObject({ state: "busy" });
    expect(await states(setup)).toEqual(["claimed", "in_progress_reported", "printing", "busy"]);
    expect(addEvent).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
    expect(setup.deviceKey.signDelegation).not.toHaveBeenCalled();
    expect(setup.gw.postRelayEvidence).not.toHaveBeenCalled();
    const records = await Promise.all((await readdir(setup.journal.sessionDirectory(jobId)))
      .map(async (name) => JSON.parse(await readFile(join(setup.journal.sessionDirectory(jobId), name), "utf8"))));
    expect(records.map((record) => record.record.kind)).toEqual(["open"]);
  });

  it("an expired unit after busy is abandoned without another print or session finalization", async () => {
    const setup = await fixture();
    const original = unitSessions.openUnitEvidenceSession;
    const finalize = vi.fn();
    vi.spyOn(unitSessions, "openUnitEvidenceSession").mockImplementation(async (options) => {
      const session = await original(options);
      finalize.mockImplementation(() => session.finalize());
      return { ...session, finalize };
    });
    setup.adapter.scriptStart({ outcome: "busy" });
    await setup.host.runOnce();
    await setup.timers.advance(setup.unit.reclaimAt * 1_000 - setup.timers.now + 1);
    await setup.host.runOnce();
    expect(setup.adapter.commands).toHaveLength(1);
    expect(await states(setup)).toEqual(["claimed", "in_progress_reported", "printing", "busy", "abandoned"]);
    expect(setup.logs).toContain("session_failed");
    expect(finalize).not.toHaveBeenCalled();
    expect(setup.gw.postRelayEvidence).not.toHaveBeenCalled();
    const records = await Promise.all((await readdir(setup.journal.sessionDirectory(jobId)))
      .map(async (name) => JSON.parse(await readFile(join(setup.journal.sessionDirectory(jobId), name), "utf8"))));
    expect(records.map((record) => record.record.kind)).toEqual(["open"]);
  });

  it("a unit expiring during the fresh pre-print poll starts no work", async () => {
    const setup = await fixture();
    setup.gw.pollJobs.mockResolvedValueOnce(poll()).mockImplementationOnce(async () => {
      setup.timers.now = setup.unit.reclaimAt * 1_000;
      return poll();
    });
    await setup.host.runOnce();
    expect(await states(setup)).toEqual(["claimed", "in_progress_reported", "abandoned"]);
    expect(setup.logs).toContain("session_failed");
    expect(setup.adapter.commands).toEqual([]);
    expect(setup.deviceKey.signDelegation).not.toHaveBeenCalled();
    expect(setup.gw.postRelayEvidence).not.toHaveBeenCalled();
  });

  it.each(["job_not_found", "settlement_owned_status", "job_kernel_changed", "invalid_status"] as const)("an in_progress %s refusal abandons the job without printing", async (code) => {
    const setup = await fixture();
    setup.gw.reportInProgress.mockResolvedValue(failed(code) as never);
    await setup.host.runOnce();
    await setup.host.runOnce();
    expect(await states(setup)).toEqual(["claimed", "abandoned"]);
    expect((await setup.journal.read(jobId)).at(-1)).toMatchObject({ code });
    expect(setup.adapter.commands).toEqual([]);
    expect(setup.gw.reportInProgress).toHaveBeenCalledTimes(1);
  });

  it("transient in_progress errors retain claimed and give up after three total attempts", async () => {
    const setup = await fixture();
    setup.gw.reportInProgress.mockResolvedValue(failed("network") as never);
    for (let attempt = 0; attempt < 3; attempt++) {
      await setup.host.runOnce();
      if (attempt < 2) expect(await states(setup)).toEqual(["claimed"]);
      await setup.timers.advance(5_000);
    }
    await setup.host.runOnce();
    expect(setup.gw.reportInProgress).toHaveBeenCalledTimes(3);
    expect(await states(setup)).toEqual(["claimed", "abandoned"]);
    expect(setup.adapter.commands).toEqual([]);
  });

  it("a transient in_progress refusal retries the same claim and prints only after acknowledgement", async () => {
    const setup = await fixture();
    setup.gw.reportInProgress.mockResolvedValueOnce(failed("unavailable") as never);
    await setup.host.runOnce();
    expect(await states(setup)).toEqual(["claimed"]);
    expect(setup.adapter.commands).toEqual([]);
    await setup.timers.advance(5_000);
    await complete(setup);
    expect(setup.inputSource).toHaveBeenCalledTimes(1);
    expect(setup.gw.reportInProgress).toHaveBeenCalledTimes(2);
    expect(await states(setup)).toEqual(["claimed", "in_progress_reported", "printing", "printed", "bundle_saved", "evidence_stored"]);
  });

  it("indeterminate evidence is never re-posted across ticks or restarts", async () => {
    const setup = await fixture();
    setup.gw.postRelayEvidence.mockResolvedValue(failed("indeterminate") as never);
    await complete(setup);
    expect(await states(setup)).toContain("evidence_indeterminate");
    for (let tick = 0; tick < 2; tick++) { await setup.timers.advance(5_000); await setup.host.runOnce(); }
    const restarted = createHost({ ...setup.deps, journal: createJobJournal(setup.dir, () => setup.timers.now) });
    await restarted.runOnce();
    expect(setup.gw.postRelayEvidence).toHaveBeenCalledTimes(1);
    expect(setup.adapter.commands).toHaveLength(1);
    expect(await states(setup)).toEqual(["claimed", "in_progress_reported", "printing", "printed", "bundle_saved", "evidence_indeterminate", "interrupted"]);
    expect(setup.logs).toContain("interrupted");
  });

  it("a refused relay records its closed code and does not retry", async () => {
    const setup = await fixture();
    setup.gw.postRelayEvidence.mockResolvedValue(failed("evidence_refused") as never);
    await complete(setup);
    await setup.host.runOnce();
    expect((await setup.journal.read(jobId)).at(-1)).toMatchObject({ state: "evidence_refused", code: "evidence_refused" });
    expect(setup.gw.postRelayEvidence).toHaveBeenCalledTimes(1);
  });

  it.each(["claimed", "in_progress_reported", "printing"] as const)("a restart interrupts a %s job and never reprints it", async (state) => {
    const print = vi.fn(async (): Promise<PrintJobResult> => ({ success: false, events: [], durationMs: 0 }));
    const setup = await fixture({ print });
    await setup.journal.initialize();
    await setup.journal.append(jobId, state);
    const restarted = createHost({ ...setup.deps, journal: createJobJournal(setup.dir, () => setup.timers.now) });
    await restarted.runOnce();
    await restarted.runOnce();
    expect(await states(setup)).toEqual([state, "interrupted"]);
    expect(print).not.toHaveBeenCalled();
    expect(setup.gw.reportInProgress).not.toHaveBeenCalled();
    expect(setup.gw.postRelayEvidence).not.toHaveBeenCalled();
  });

  it("simultaneous ticks have only one job in flight", async () => {
    const setup = await fixture();
    const print = vi.fn((options: PrintJobOptions) =>
      runPrintJob(options));
    const host = createHost({ ...setup.deps, print });
    setup.gw.pollJobs.mockResolvedValue(poll([jobId, anotherJob]));
    setup.adapter.scriptStart({ outcome: "success", jobId: 606 });
    const first = host.runOnce();
    await finishedWithin(setup.adapter.started());
    const second = host.runOnce();
    // Give a competing tick filesystem time to reach the injected print seam.
    // The first print remains live throughout this observation window.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(print).toHaveBeenCalledTimes(1);
    expect(setup.adapter.commands).toHaveLength(1);
    expect(setup.gw.reportInProgress).toHaveBeenCalledTimes(1);
    expect(await setup.journal.has(anotherJob)).toBe(false);
    setup.adapter.emit("execution_completed", { ippJobId: 606, totalPages: 2 });
    await finishedWithin(Promise.all([first, second]));
    expect(setup.gw.postRelayEvidence).toHaveBeenCalledTimes(1);
    expect(await setup.journal.has(anotherJob)).toBe(false);
    setup.adapter.scriptStart({ outcome: "success", jobId: 607 });
    const next = host.runOnce();
    await finishedWithin(setup.adapter.started());
    expect(setup.gw.reportInProgress).toHaveBeenLastCalledWith(anotherJob);
    setup.adapter.emit("execution_completed", { ippJobId: 607, totalPages: 2 });
    await finishedWithin(next);
    expect(setup.gw.postRelayEvidence).toHaveBeenCalledTimes(2);
  });

  it("the host does not recover a foreign-kernel job dropped by its gateway client", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      jobs: [{ id: "foreign-job", kernelId: "kernel:foreign", status: "queued" }],
    }), { headers: { "content-type": "application/json" } }));
    const gw = createGatewayClient({
      baseUrl: "https://gateway.example.test", apiKey: `pcc_test_${"d".repeat(32)}`,
      kernelId: "kernel:test", emergencyStopReader: () => ({ proceed: true }), fetchImpl,
    });
    const setup = await fixture({ gateway: gw });
    await setup.host.runOnce();
    expect(setup.inputSource).not.toHaveBeenCalled();
    expect(await setup.journal.has("foreign-job")).toBe(false);
    expect(setup.adapter.commands).toEqual([]);
  });

  it("simulated device events in real mode are refused and never posted", async () => {
    const setup = await fixture({ simulated: true });
    const finalize = vi.fn();
    const original = unitSessions.openUnitEvidenceSession;
    vi.spyOn(unitSessions, "openUnitEvidenceSession").mockImplementation(async (options) => {
      const session = await original(options);
      finalize.mockImplementation(() => session.finalize());
      return { ...session, finalize };
    });
    await complete(setup);
    expect(await states(setup)).toEqual(["claimed", "in_progress_reported", "printing", "simulated_refused"]);
    expect(setup.gw.postRelayEvidence).not.toHaveBeenCalled();
    expect(await readdir(setup.journal.directory)).toEqual(["job%3Abuyer.jsonl"]);
    expect(setup.logs).toContain("simulated_refused");
    expect(finalize).not.toHaveBeenCalled();
    const records = await Promise.all((await readdir(setup.journal.sessionDirectory(jobId)))
      .map(async (name) => JSON.parse(await readFile(join(setup.journal.sessionDirectory(jobId), name), "utf8"))));
    expect(records.map((record) => record.record.kind)).toEqual(["open"]);
  });

  it.each(["events", "bundle"] as const)("a simulated event found only in result.%s is still refused", async (location) => {
    const source = { deviceId: "device:test", deviceType: "controller" as const, kernelId: "kernel:test", simulated: true };
    const event = { id: "event:test", type: "execution_completed" as const, timestamp: new Date().toISOString(), source, payload: { ippJobId: 1 }, hash: `sha256:${"a".repeat(64)}` as const };
    const bundle: EvidenceBundle = {
      id: "bundle:test", jobId, stepId: jobId, kernelId: "kernel:test", assuranceTier: 0,
      createdAt: new Date().toISOString(), events: location === "bundle" ? [event] : [],
      bundleHash: `sha256:${"b".repeat(64)}`,
      kernelSignature: await makeKernelEd25519Signer().signFn(`sha256:${"b".repeat(64)}`),
    };
    const print = vi.fn(async (): Promise<PrintJobResult> => ({ success: true, events: location === "events" ? [event] : [], bundle, durationMs: 0 }));
    const setup = await fixture({ print });
    await setup.host.runOnce();
    expect(await states(setup)).toContain("simulated_refused");
    expect(setup.gw.postRelayEvidence).not.toHaveBeenCalled();
  });

  it("--poll-only heartbeats and polls but never claims", async () => {
    const setup = await fixture({ pollOnly: true });
    await setup.host.runOnce();
    await setup.timers.advance(30_000);
    await setup.host.runOnce();
    expect(setup.gw.pollJobs).toHaveBeenCalledTimes(2);
    expect(setup.gw.heartbeat).toHaveBeenCalledTimes(2);
    expect(setup.inputSource).not.toHaveBeenCalled();
    expect(await setup.journal.has(jobId)).toBe(false);
    expect(setup.gw.reportInProgress).not.toHaveBeenCalled();
    expect(setup.adapter.commands).toEqual([]);
  });

  it("unavailable inputs are skipped without claiming", async () => {
    const setup = await fixture({ inputSource: defaultJobInputSource });
    await setup.host.runOnce();
    expect(setup.inputSource).toHaveBeenCalledWith(jobId);
    expect(await setup.journal.has(jobId)).toBe(false);
    expect(setup.gw.reportInProgress).not.toHaveBeenCalled();
    expect(setup.logs).toContain("job_inputs_unavailable");
  });

  it.each(["unit", "settlementUnitId", "challengeNonce", "fundedAt", "reclaimAt"] as const)(
    "missing unit binding %s skips the real job without claiming and logs a closed code", async (field) => {
      const unit: Record<string, unknown> = { settlementUnitId: `0x${randomBytes(32).toString("hex")}`,
        challengeNonce: `0x${randomBytes(32).toString("hex")}`, fundedAt: Math.floor(Date.now() / 1_000) - 60,
        reclaimAt: Math.floor(Date.now() / 1_000) + 86_400 };
      if (field !== "unit") delete unit[field];
      const value = { documentData: Buffer.from("%PDF-1.7"), jobName: "buyer.pdf", totalPages: 1,
        ...(field === "unit" ? {} : { unit }) };
      const inputSource = vi.fn(async () => ({ ok: true as const, value })) as unknown as JobInputSource;
      const setup = await fixture({ inputSource });
      const open = vi.spyOn(unitSessions, "openUnitEvidenceSession");
      await setup.host.runOnce();
      expect(await setup.journal.has(jobId)).toBe(false);
      expect(setup.gw.reportInProgress).not.toHaveBeenCalled();
      expect(setup.adapter.commands).toEqual([]);
      expect(setup.gw.postRelayEvidence).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(setup.logs).toContain("job_inputs_bad_schema");
      for (const code of setup.logs) expect(HOST_LOG_CODES).toContain(code);
    },
  );

  it("a restart with a SESSION journal and no host record is interrupted without reprinting or posting", async () => {
    const setup = await fixture();
    await setup.journal.initialize();
    await unitSessions.openUnitEvidenceSession({ ...setup.unit, jobId,
      parentAgentId: `eip155:31337:${setup.operatorAddress.toLowerCase()}`,
      expiresAt: setup.unit.reclaimAt, deviceKey: setup.deviceKey,
      journalDir: setup.journal.sessionDirectory(jobId) });
    const host = createHost({ ...setup.deps, journal: createJobJournal(setup.dir, () => setup.timers.now) });
    await host.runOnce();
    await host.runOnce();
    expect(await states(setup)).toEqual(["interrupted"]);
    expect(setup.logs).toContain("interrupted");
    expect(setup.inputSource).not.toHaveBeenCalled();
    expect(setup.adapter.commands).toEqual([]);
    expect(setup.gw.reportInProgress).not.toHaveBeenCalled();
    expect(setup.gw.postRelayEvidence).not.toHaveBeenCalled();
  });

  it("a crash after saving the SESSION bundle interrupts on restart and never auto-posts it", async () => {
    const setup = await fixture();
    const originalAppend = setup.journal.append.bind(setup.journal);
    vi.spyOn(setup.journal, "append").mockImplementation(async (id, state, code) => {
      await originalAppend(id, state, code);
      if (state === "bundle_saved") throw new Error(serverCanary);
    });
    await complete(setup);
    expect(await states(setup)).toEqual(["claimed", "in_progress_reported", "printing", "printed", "bundle_saved"]);
    const saved = JSON.parse(await readFile(setup.journal.bundlePath(jobId), "utf8"));
    expectSigned(saved, setup.deviceKey);
    expect(setup.gw.postRelayEvidence).not.toHaveBeenCalled();
    expect(setup.logs).toContain("journal_failed");
    const restarted = createHost({ ...setup.deps, journal: createJobJournal(setup.dir, () => setup.timers.now) });
    await restarted.runOnce();
    await restarted.runOnce();
    expect(await states(setup)).toEqual(["claimed", "in_progress_reported", "printing", "printed", "bundle_saved", "interrupted"]);
    expect(setup.logs).toContain("interrupted");
    expect(setup.adapter.commands).toHaveLength(1);
    expect(setup.gw.reportInProgress).toHaveBeenCalledTimes(1);
    expect(setup.inputSource).toHaveBeenCalledTimes(1);
    expect(setup.gw.postRelayEvidence).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(setup.journal.bundlePath(jobId), "utf8"))).toEqual(saved);
  });

  it("a print timeout posts SESSION-signed failure evidence", async () => {
    const setup = await fixture();
    setup.adapter.scriptStart({ outcome: "success", jobId: 814 });
    await finishedWithin(setup.host.runOnce());
    expect(setup.adapter.cancels).toEqual([814]);
    const bundle = setup.gw.postRelayEvidence.mock.calls[0]![1];
    expect(bundle.events.some((event) => event.type === "execution_failed")).toBe(true);
    expect(await states(setup)).toContain("print_failed");
    expectSigned(bundle, setup.deviceKey);
  });

  it("failure events without the print's own bundle still become a posted SESSION failure bundle", async () => {
    const print = vi.fn(async (options: PrintJobOptions): Promise<PrintJobResult> => {
      const raw: Omit<EvidenceEvent, "id" | "hash"> = { type: "execution_failed", timestamp: new Date().toISOString(),
        source: { deviceId: "device:test", deviceType: "controller", kernelId: "kernel:test", simulated: false },
        payload: { jobId: options.jobId, settlementUnitId: options.settlementUnitId, challengeNonce: options.challengeNonce,
          ippJobId: 815, origin: "kernel", reason: "aborted" } };
      const event = { ...raw, id: `event:${randomBytes(8).toString("hex")}`, hash: await hashEvent(raw) };
      return { success: false, events: [event], durationMs: 1 };
    });
    const setup = await fixture({ print });
    await setup.host.runOnce();
    const bundle = setup.gw.postRelayEvidence.mock.calls[0]![1];
    expect(bundle.events).toEqual((await print.mock.results[0]!.value).events);
    expectSigned(bundle, setup.deviceKey);
    expect(await states(setup)).toEqual(["claimed", "in_progress_reported", "printing", "print_failed", "bundle_saved", "evidence_stored"]);
  });

  it("a result with neither a bundle nor busy records no_bundle", async () => {
    const print = vi.fn(async (): Promise<PrintJobResult> => ({ success: false, error: serverCanary, events: [], durationMs: 0 }));
    const setup = await fixture({ print });
    await setup.host.runOnce();
    expect((await setup.journal.read(jobId)).at(-1)).toMatchObject({ state: "print_failed", code: "no_bundle" });
    expect(setup.gw.postRelayEvidence).not.toHaveBeenCalled();
    expect(JSON.stringify(setup.logs)).not.toContain(serverCanary);
    expect(await readFile(setup.journal.journalPath(jobId), "utf8")).not.toContain(serverCanary);
    for (const log of setup.logs) expect(HOST_LOG_CODES).toContain(log);
  });

  it("a thrown print erases its throwaway secret and leaves the SESSION unfinalized", async () => {
    const setup = await fixture();
    const original = kernelSigners.makeKernelEd25519Signer;
    const signers: ReturnType<typeof makeKernelEd25519Signer>[] = [];
    vi.spyOn(kernelSigners, "makeKernelEd25519Signer").mockImplementation((seed) => {
      const signer = original(seed); signers.push(signer); return signer;
    });
    const print = vi.fn(async (): Promise<PrintJobResult> => {
      expect(signers).toHaveLength(1);
      expect(signers[0]!.secretKey.some((byte) => byte !== 0)).toBe(true);
      throw new Error(serverCanary);
    });
    const host = createHost({ ...setup.deps, print });
    expect(await host.runOnce()).toMatchObject({ state: "print_failed" });
    expect(signers).toHaveLength(1);
    expect(signers[0]!.secretKey.some((byte) => byte !== 0)).toBe(false);
    expect(setup.deviceKey.signDelegation).not.toHaveBeenCalled();
    expect(setup.gw.postRelayEvidence).not.toHaveBeenCalled();
    expect((await setup.journal.read(jobId)).at(-1)).toMatchObject({ state: "print_failed", code: "no_bundle" });
    const records = await Promise.all((await readdir(setup.journal.sessionDirectory(jobId)))
      .map(async (name) => JSON.parse(await readFile(join(setup.journal.sessionDirectory(jobId), name), "utf8"))));
    expect(records.map((record) => record.record.kind)).toEqual(["open"]);
    expect(await readdir(setup.journal.directory)).toEqual(["job%3Abuyer.jsonl"]);
    expect(JSON.stringify(setup.logs)).not.toContain(serverCanary);
    expect(setup.timers.count).toBe(0);
  });

  it("heartbeats are limited to one every thirty seconds", async () => {
    const setup = await fixture({ pollOnly: true });
    await setup.host.runOnce();
    await setup.timers.advance(29_999);
    await setup.host.runOnce();
    expect(setup.gw.heartbeat).toHaveBeenCalledTimes(1);
    await setup.timers.advance(1);
    await setup.host.runOnce();
    expect(setup.gw.heartbeat).toHaveBeenCalledTimes(2);
  });

  it("a printing job heartbeats every thirty seconds even with a sixty-second e-stop interval", async () => {
    const setup = await fixture({ eStopPollIntervalMs: 60_000 });
    setup.adapter.scriptStart({ outcome: "success", jobId: 808 });
    const tick = setup.host.runOnce();
    await finishedWithin(setup.adapter.started());
    await setup.timers.advance(30_000);
    expect(setup.gw.heartbeat).toHaveBeenCalledTimes(2);
    expect(setup.gw.pollJobs).toHaveBeenCalledTimes(2);
    setup.adapter.emit("execution_completed", { ippJobId: 808, totalPages: 2 });
    await finishedWithin(tick);
    expect(setup.timers.count).toBe(0);
  });

  it("a sixty-second backoff keeps thirty-second heartbeats without polling early", async () => {
    const setup = await fixture({ pollOnly: true });
    let sawFirstPoll!: () => void;
    const firstPoll = new Promise<void>((resolve) => { sawFirstPoll = resolve; });
    setup.gw.pollJobs.mockImplementation(async () => {
      sawFirstPoll();
      return failed("rate_limited", 60);
    });
    const stop = new AbortController();
    const running = setup.host.run(stop.signal);
    await finishedWithin(firstPoll);
    await setup.timers.advance(0);
    expect(setup.gw.heartbeat).toHaveBeenCalledTimes(1);
    await setup.timers.advance(30_000);
    expect(setup.gw.heartbeat).toHaveBeenCalledTimes(2);
    expect(setup.gw.pollJobs).toHaveBeenCalledTimes(1);
    await setup.timers.advance(30_000);
    expect(setup.gw.heartbeat).toHaveBeenCalledTimes(3);
    expect(setup.gw.pollJobs).toHaveBeenCalledTimes(2);
    stop.abort();
    await finishedWithin(running);
    expect(setup.timers.count).toBe(0);
  });

  it("poll failures use bounded exponential backoff and honour retry-after", async () => {
    const setup = await fixture({ pollOnly: true });
    setup.gw.pollJobs.mockResolvedValue(failed("network"));
    const waits: number[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await setup.host.runOnce();
      expect(result.kind).toBe("backoff");
      waits.push(result.waitMs);
      await setup.timers.advance(result.waitMs);
    }
    expect(waits.at(-1)).toBe(60_000);
    expect(waits.every((wait) => wait > 0 && wait <= 60_000)).toBe(true);
    expect(waits.every((wait, index) => index === 0 || wait >= waits[index - 1]!)).toBe(true);
    setup.gw.pollJobs.mockResolvedValueOnce(failed("rate_limited", 45));
    expect((await setup.host.runOnce()).waitMs).toBeGreaterThanOrEqual(45_000);
  });
});
