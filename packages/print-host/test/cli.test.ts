import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress, keccak256, parseTransaction, toBytes } from "viem";
import { main } from "../src/cli.js";
import { generateHostKeys } from "../src/keygen.js";
import { createGatewayClient } from "../src/gateway-client.js";
import { HOST_LOG_CODES } from "../src/host.js";
import { createJobJournal } from "../src/journal.js";
import { FakeMachineAdapter } from "../src/testing/fake-machine-adapter.js";
import type { createEvidenceBroadcaster, EvidenceBroadcaster } from "../src/chain.js";

vi.mock("../src/keygen.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/keygen.js")>();
  return { ...actual, generateHostKeys: vi.fn(actual.generateHostKeys) };
});

const dirs: string[] = [];
afterEach(async () => {
  vi.mocked(generateHostKeys).mockClear();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temporaryDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ph2-cli-"));
  dirs.push(dir);
  await chmod(dir, 0o700);
  return dir;
}

function capture() {
  let stdout = "";
  let stderr = "";
  const io = {
    stdout: { write: (text: string) => { stdout += text; } },
    stderr: { write: (text: string) => { stderr += text; } },
  };
  return { io, output: () => ({ stdout, stderr }) };
}

async function runFixture(stopFields: Record<string, unknown> = { emergencyStop: "clear" }) {
  const root = await temporaryDirectory();
  const generated = await generateHostKeys(join(root, "keys"));
  const apiToken = `pcc_test_${randomBytes(24).toString("hex")}`;
  const providerToken = randomBytes(24).toString("hex");
  const rpcUrlFile = join(root, "rpc-url");
  const apiKeyFile = join(root, "api-key");
  await writeFile(rpcUrlFile, `https://rpc.example.test/${providerToken}\n`, { mode: 0o600 });
  await writeFile(apiKeyFile, `${apiToken}\r\n`, { mode: 0o600 });
  const dataDir = join(root, "data");
  const inputsDir = join(root, "inputs");
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(inputsDir, { mode: 0o700 });
  const configFile = join(root, "host.json");
  await writeFile(configFile, JSON.stringify({
    kernelId: "n144-cli-run", deviceId: "printer-cli-run",
    printer: { uri: "ipp://localhost:631/printers/test" },
    chain: { chainId: 84532, rpcUrlFile, maxFeePerGasCap: "100", maxPriorityFeePerGasCap: "10", gasCap: "250000" },
    gateway: { baseUrl: "https://gateway.example.test", apiKeyFile },
    keys: { deviceKeyFile: generated.paths.deviceKeyFile, operatorKeyFile: generated.paths.operatorKeyFile },
    dataDir,
  }), { mode: 0o600 });
  const jobName = randomBytes(24).toString("hex");
  // The deterministic fake adapter timestamps its events from this fixture epoch.
  const fundedAt = Math.floor(Date.UTC(2026, 9, 9) / 1_000) - 60;
  await writeFile(join(inputsDir, "cli-job.json"), JSON.stringify({
    jobName, totalPages: 1, documentFile: "buyer.pdf",
    unit: {
      settlementUnitId: `0x${randomBytes(32).toString("hex")}`,
      challengeNonce: `0x${randomBytes(32).toString("hex")}`,
      fundedAt, reclaimAt: Math.floor(Date.now() / 1_000) + 3 * 24 * 60 * 60,
    },
  }));
  await writeFile(join(inputsDir, "buyer.pdf"), "%PDF-1.7\nprivate buyer document\n");
  const calls: string[] = [];
  const fetchImpl = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    let body: unknown;
    if (path.endsWith("/heartbeat")) body = { acknowledged: true };
    else if (path.endsWith("/jobs")) body = {
      ...stopFields, jobs: [{ id: "cli-job", kernelId: "n144-cli-run", status: "queued" }],
    };
    else if (path.endsWith("/job-status")) body = { updated: true };
    else if (path.endsWith("/evidence")) {
      const request = JSON.parse(String(init?.body));
      body = { stored: true, jobId: request.jobId, contentHash: request.evidence.bundleHash, hashModel: "event_bundle_hash" };
    } else throw new Error("unexpected fake gateway call");
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  const adapter = new FakeMachineAdapter("printer-cli-run", "n144-cli-run");
  adapter.source.simulated = false;
  const dispose = vi.spyOn(adapter, "dispose");
  const createPrinter = vi.fn<[], { adapter: FakeMachineAdapter; dispose(): Promise<void> }>(() => ({
    adapter, dispose: () => adapter.dispose(),
  }));
  const device = JSON.parse(await readFile(generated.paths.deviceKeyFile, "utf8"));
  const operator = JSON.parse(await readFile(generated.paths.operatorKeyFile, "utf8"));
  return { configFile, inputsDir, dataDir, calls, fetchImpl, adapter, dispose, createPrinter, operatorAddress: generated.identity.operatorAddress,
    secrets: [apiToken, providerToken, device.seed, operator.privateKey.slice(2), jobName, "private buyer document"] };
}

function assertRunOutput(captured: ReturnType<typeof capture>, secrets: string[]) {
  const { stdout, stderr } = captured.output();
  expect(stderr).toBe("");
  const lines = stdout.trim().split("\n").filter(Boolean);
  expect(lines.every(line => (HOST_LOG_CODES as readonly string[]).includes(line))).toBe(true);
  for (const secret of secrets) expect((stdout + stderr).includes(secret)).toBe(false);
}

describe("print-host CLI", () => {
  it("keygen prints only the public identity and paths", async () => {
    const root = await temporaryDirectory();
    const outDir = join(root, "keys");
    const captured = capture();
    expect(await main(["keygen", "--out", outDir, "--not-after", "2099-01-01T00:00:00Z"], captured.io)).toBe(0);
    const { stdout, stderr } = captured.output();
    const result = JSON.parse(stdout);
    expect(result.identity.kind).toBe("pcc-printhost.public-identity");
    expect(result.paths.deviceKeyFile).toBe(join(outDir, "device-key.json"));
    expect(result.paths.operatorKeyFile).toBe(join(outDir, "operator-key.json"));
    expect(result.paths.publicIdentityFile).toBe(join(outDir, "public.json"));
    const device = JSON.parse(await readFile(result.paths.deviceKeyFile, "utf8"));
    const operator = JSON.parse(await readFile(result.paths.operatorKeyFile, "utf8"));
    for (const secret of [device.seed, operator.privateKey.slice(2)]) {
      for (let offset = 0; offset <= secret.length - 12; offset++) {
        expect((stdout + stderr).includes(secret.slice(offset, offset + 12))).toBe(false);
      }
    }
    expect(stderr).toBe("");
  });

  it("check-config prints only the checked public identity", async () => {
    const root = await temporaryDirectory();
    const generated = capture();
    expect(await main(["keygen", "--out", join(root, "keys")], generated.io)).toBe(0);
    const result = JSON.parse(generated.output().stdout);
    const apiToken = randomBytes(24).toString("hex");
    const providerToken = randomBytes(24).toString("hex");
    const rpcUrlFile = join(root, "rpc-url");
    const apiKeyFile = join(root, "api-key");
    await writeFile(rpcUrlFile, `https://rpc.example.test/${providerToken}\n`, { mode: 0o600 });
    await writeFile(apiKeyFile, `${apiToken}\n`, { mode: 0o600 });
    const dataDir = join(root, "data");
    await mkdir(dataDir, { mode: 0o700 });
    const configFile = join(root, "host.json");
    await writeFile(configFile, JSON.stringify({
      kernelId: "n144-cli", deviceId: "printer-cli",
      printer: { uri: "ipp://localhost:631/printers/test" },
      chain: { chainId: 84532, rpcUrlFile },
      gateway: { baseUrl: "https://gateway.example.test", apiKeyFile },
      keys: { deviceKeyFile: result.paths.deviceKeyFile, operatorKeyFile: result.paths.operatorKeyFile },
      dataDir,
    }), { mode: 0o600 });
    const checked = capture();
    expect(await main(["check-config", configFile], checked.io)).toBe(0);
    const { stdout, stderr } = checked.output();
    expect(JSON.parse(stdout)).toEqual({
      kernelId: "n144-cli", deviceId: "printer-cli", chainId: 84532,
      devicePublicKey: result.identity.devicePublicKey, operatorAddress: result.identity.operatorAddress,
      printerUri: "ipp://localhost:631/printers/test", gatewayBaseUrl: "https://gateway.example.test",
    });
    expect(stdout.includes(apiToken) || stdout.includes(providerToken)).toBe(false);
    expect(stderr).toBe("");
  });

  it.each([
    [], ["unknown"], ["keygen"], ["keygen", "--out"],
    ["keygen", "--out", "relative-unused", "--out", "relative-unused"],
    ["keygen", "--unknown", "value"], ["keygen", "--not-after", "2099-01-01T00:00:00Z"],
    ["check-config"], ["check-config", "relative-unused", "extra"],
    ["run"], ["run", "--config"], ["run", "--config", "unused", "--once", "--once"],
    ["run", "--config", "unused", "--poll-only", "--poll-only"],
    ["run", "--config", "unused", "--no-submit", "--no-submit"],
    ["run", "--config", "unused", "--inputs-dir"], ["run", "--config", "unused", "--unknown"],
    ["run", "--config", "unused", "--config", "unused"],
  ])("bad arguments exit 2 (%#)", async (...argv: string[]) => {
    const captured = capture();
    expect(await main(argv, captured.io)).toBe(2);
    expect(captured.output().stdout).toBe("");
    expect(captured.output().stderr.startsWith("Usage:")).toBe(true);
  });

  it("failures print a safe error and no stack", async () => {
    const root = await temporaryDirectory();
    const missingConfig = join(root, "missing.json");
    const captured = capture();
    expect(await main(["check-config", missingConfig], captured.io)).toBe(1);
    expect(captured.output().stdout).toBe("");
    expect(captured.output().stderr).toBe(`not_found: ${missingConfig}\n`);
  });

  it("keygen errors print the closed message once", async () => {
    const captured = capture();
    expect(await main(["keygen", "--out", "relative-unused"], captured.io)).toBe(1);
    expect(captured.output()).toEqual({ stdout: "", stderr: "not_absolute: relative-unused\n" });
  });

  it("internal errors discard content-bearing messages", async () => {
    const root = await temporaryDirectory();
    vi.mocked(generateHostKeys).mockRejectedValueOnce(new Error(randomBytes(32).toString("hex")));
    const captured = capture();
    expect(await main(["keygen", "--out", join(root, "keys")], captured.io)).toBe(1);
    expect(captured.output().stdout).toBe("");
    // A failed mutation must not print the secret in the assertion's diagnostics.
    expect(captured.output().stderr === "internal_error: print-host operation failed\n",
      "internal errors use only the closed message").toBe(true);
  });

  it("run --once defaults to the strict reader and claims a job with clear e-stop and available inputs", async () => {
    const fixture = await runFixture();
    fixture.adapter.scriptStart({ outcome: "busy" });
    const fetchImpl = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async (input, init) => {
      // After discovery supplies the job, the pre-print poll can have an empty
      // queue: its own clear field and jobs array still authorize this print.
      if (new URL(String(input)).pathname.endsWith("/jobs") && fixture.calls.includes("/api/operator/jobs")) {
        fixture.calls.push("/api/operator/jobs");
        return new Response(JSON.stringify({ jobs: [], emergencyStop: "clear" }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return fixture.fetchImpl(input, init);
    });
    const captured = capture();
    expect(await main(["run", "--config", fixture.configFile, "--once", "--inputs-dir", fixture.inputsDir], captured.io, {
      createGateway: config => createGatewayClient({ ...config, fetchImpl }),
      createPrinter: fixture.createPrinter,
    })).toBe(0);
    expect(fixture.calls).toEqual([
      "/api/operator/heartbeat", "/api/operator/jobs", "/api/operator/job-status", "/api/operator/jobs",
    ]);
    expect(fixture.adapter.commands.map(command => command.type)).toEqual(["start"]);
    const records = (await readFile(join(fixture.dataDir, "journal", "cli-job.jsonl"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line));
    expect(records.map(record => record.state)).toEqual(["claimed", "in_progress_reported", "printing", "busy"]);
    expect(fixture.dispose).toHaveBeenCalledOnce();
    assertRunOutput(captured, fixture.secrets);
  });

  it("run --once defaults to the strict reader and claims nothing when emergencyStop is absent", async () => {
    const fixture = await runFixture({});
    const createGateway = vi.fn((config: Parameters<typeof createGatewayClient>[0]) =>
      createGatewayClient({ ...config, fetchImpl: fixture.fetchImpl }));
    const captured = capture();
    expect(await main(["run", "--config", fixture.configFile, "--once", "--inputs-dir", fixture.inputsDir], captured.io, {
      createGateway, createPrinter: fixture.createPrinter,
    })).toBe(0);
    expect(fixture.calls).toEqual(["/api/operator/heartbeat", "/api/operator/jobs"]);
    expect(fixture.adapter.commands).toEqual([]);
    expect(await readdir(join(fixture.dataDir, "journal"))).toEqual([]);
    expect(createGateway).toHaveBeenCalledOnce();
    expect(createGateway.mock.calls[0]![0].wallet).toBe(fixture.operatorAddress);
    expect(fixture.dispose).toHaveBeenCalledOnce();
    assertRunOutput(captured, fixture.secrets);
  });

  it("run binds the operator transaction signer to the config chain and gives the broadcaster only its scoped authority", async () => {
    const fixture = await runFixture();
    const config = JSON.parse(await readFile(fixture.configFile, "utf8"));
    config.chain = { ...config.chain, chainId: 31337, maxFeePerGasCap: "100", maxPriorityFeePerGasCap: "10", gasCap: "250000" };
    await writeFile(fixture.configFile, JSON.stringify(config), { mode: 0o600 });
    fixture.adapter.scriptStart({ outcome: "busy" });
    const broadcaster: EvidenceBroadcaster = {
      submit: vi.fn(async () => ({ code: "already_committed" as const })),
      readBack: vi.fn(async () => ({ code: "already_committed" as const })),
    };
    let transaction: Promise<`0x${string}`> | undefined;
    const createBroadcaster = vi.fn((settings: Parameters<typeof createEvidenceBroadcaster>[0],
      operator: Parameters<typeof createEvidenceBroadcaster>[1]) => {
      expect(settings).toEqual({ chain: config.chain });
      expect(Object.keys(operator).sort()).toEqual(["address", "signSubmitEvidenceTx"]);
      transaction = operator.signSubmitEvidenceTx({
        escrow: getAddress(keccak256(toBytes("cli escrow")).slice(0, 42)),
        unitId: keccak256(toBytes("cli unit")), packageDigest: keccak256(toBytes("cli package")),
        nonce: 0, gas: 21000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 10n,
      });
      return broadcaster;
    });
    const captured = capture();
    expect(await main(["run", "--config", fixture.configFile, "--once", "--inputs-dir", fixture.inputsDir], captured.io, {
      createGateway: settings => createGatewayClient({ ...settings, fetchImpl: fixture.fetchImpl }),
      createPrinter: fixture.createPrinter, createBroadcaster,
    })).toBe(0);
    expect(createBroadcaster).toHaveBeenCalledOnce();
    expect(parseTransaction(await transaction!).chainId).toBe(31337);
    expect(broadcaster.submit).not.toHaveBeenCalled();
    assertRunOutput(captured, fixture.secrets);
  });

  it("run failures report only closed codes", async () => {
    const root = await temporaryDirectory();
    const captured = capture();
    expect(await main(["run", "--config", join(root, "missing.json"), "--once"], captured.io)).toBe(1);
    expect(captured.output()).toEqual({ stdout: "", stderr: "not_found\n" });
  });

  it.each(["all", "maxFeePerGasCap", "maxPriorityFeePerGasCap", "gasCap"] as const)(
    "real run refuses missing transaction caps (%s) before opening credentials or devices", async (field) => {
      const fixture = await runFixture();
      const config = JSON.parse(await readFile(fixture.configFile, "utf8"));
      if (field === "all") {
        for (const cap of ["maxFeePerGasCap", "maxPriorityFeePerGasCap", "gasCap"]) delete config.chain[cap];
      } else delete config.chain[field];
      await writeFile(fixture.configFile, JSON.stringify(config), { mode: 0o600 });
      await rm(config.keys.operatorKeyFile);
      const createGateway = vi.fn(() => { throw new Error("missing caps cannot open gateway"); });
      const createBroadcaster = vi.fn(() => { throw new Error("missing caps cannot open broadcaster"); });
      const captured = capture();
      expect(await main(["run", "--config", fixture.configFile, "--once"], captured.io, {
        createGateway, createPrinter: fixture.createPrinter, createBroadcaster,
      })).toBe(1);
      expect(captured.output()).toEqual({ stdout: "", stderr: "submit_caps_required\n" });
      expect(createGateway).not.toHaveBeenCalled();
      expect(createBroadcaster).not.toHaveBeenCalled();
      expect(fixture.createPrinter).not.toHaveBeenCalled();
    },
  );

  it.each(["maxFeePerGasCap", "maxPriorityFeePerGasCap", "gasCap"] as const)(
    "real run refuses a zero %s", async (field) => {
      const fixture = await runFixture();
      const config = JSON.parse(await readFile(fixture.configFile, "utf8"));
      config.chain[field] = "0";
      if (field === "maxFeePerGasCap") config.chain.maxPriorityFeePerGasCap = "0";
      await writeFile(fixture.configFile, JSON.stringify(config), { mode: 0o600 });
      const captured = capture();
      expect(await main(["run", "--config", fixture.configFile, "--once"], captured.io)).toBe(1);
      expect(captured.output()).toEqual({ stdout: "", stderr: "submit_caps_required\n" });
    },
  );

  it("--no-submit explicitly permits missing caps and records submit_disabled even with positive caps", async () => {
    for (const withCaps of [false, true]) {
      const fixture = await runFixture();
      if (!withCaps) {
        const config = JSON.parse(await readFile(fixture.configFile, "utf8"));
        for (const cap of ["maxFeePerGasCap", "maxPriorityFeePerGasCap", "gasCap"]) delete config.chain[cap];
        await writeFile(fixture.configFile, JSON.stringify(config), { mode: 0o600 });
      }
      fixture.adapter.scriptStart({ outcome: "success", jobId: 902 });
      const createBroadcaster = vi.fn(() => { throw new Error("no-submit cannot construct a broadcaster"); });
      const captured = capture();
      const running = main(["run", "--config", fixture.configFile, "--once", "--no-submit", "--inputs-dir", fixture.inputsDir], captured.io, {
        createGateway: settings => createGatewayClient({ ...settings, fetchImpl: fixture.fetchImpl }),
        createPrinter: fixture.createPrinter, createBroadcaster,
      });
      await fixture.adapter.started();
      process.emit("SIGTERM");
      expect(await running).toBe(0);
      const records = (await readFile(join(fixture.dataDir, "journal", "cli-job.jsonl"), "utf8"))
        .trim().split("\n").map(line => JSON.parse(line));
      expect(records.at(-1)).toMatchObject({ state: "evidence_stored", code: "submit_disabled" });
      expect(records.some(record => record.state === "submit_attempted")).toBe(false);
      expect(createBroadcaster).not.toHaveBeenCalled();
      assertRunOutput(captured, fixture.secrets);
    }
  });

  it("run --poll-only never claims even with clear e-stop and available inputs", async () => {
    const fixture = await runFixture();
    // If --poll-only is removed, the real host can reach start and finish this
    // refusal promptly instead of leaving the mutant waiting for a printer.
    fixture.adapter.scriptStart({ outcome: "busy" });
    const captured = capture();
    expect(await main(["run", "--config", fixture.configFile, "--once", "--poll-only", "--inputs-dir", fixture.inputsDir], captured.io, {
      createGateway: config => createGatewayClient({
        ...config, fetchImpl: fixture.fetchImpl, emergencyStopReader: () => ({ proceed: true }),
      }),
      createPrinter: fixture.createPrinter,
    })).toBe(0);
    expect(fixture.calls).toEqual(["/api/operator/heartbeat", "/api/operator/jobs"]);
    expect(fixture.adapter.commands).toEqual([]);
    expect(await readdir(join(fixture.dataDir, "journal"))).toEqual([]);
    expect(fixture.createPrinter).not.toHaveBeenCalled();
    expect(fixture.dispose).not.toHaveBeenCalled();
    assertRunOutput(captured, fixture.secrets);
  });

  it("run --poll-only works before operator and device keys or RPC credentials are provisioned", async () => {
    const fixture = await runFixture();
    const config = JSON.parse(await readFile(fixture.configFile, "utf8"));
    await Promise.all([
      rm(config.keys.deviceKeyFile), rm(config.keys.operatorKeyFile), rm(config.chain.rpcUrlFile),
    ]);
    for (const cap of ["maxFeePerGasCap", "maxPriorityFeePerGasCap", "gasCap"]) delete config.chain[cap];
    await writeFile(fixture.configFile, JSON.stringify(config), { mode: 0o600 });
    const captured = capture();
    const createBroadcaster = vi.fn(() => { throw new Error("poll-only cannot construct a broadcaster"); });
    const createGateway = vi.fn((settings: Parameters<typeof createGatewayClient>[0]) =>
      createGatewayClient({ ...settings, fetchImpl: fixture.fetchImpl }));
    expect(await main(["run", "--config", fixture.configFile, "--once", "--poll-only"], captured.io, {
      createGateway,
      createPrinter: fixture.createPrinter, createBroadcaster,
    })).toBe(0);
    expect(fixture.calls).toEqual(["/api/operator/heartbeat", "/api/operator/jobs"]);
    expect(fixture.createPrinter).not.toHaveBeenCalled();
    expect(createBroadcaster).not.toHaveBeenCalled();
    expect(createGateway.mock.calls[0]![0]).not.toHaveProperty("wallet");
    expect(await readdir(join(fixture.dataDir, "journal"))).toEqual([]);
    assertRunOutput(captured, fixture.secrets);
  });

  it("run --once exits 1 for an invalid journal instead of reporting a successful smoke test", async () => {
    const fixture = await runFixture();
    await mkdir(join(fixture.dataDir, "journal"), { mode: 0o700 });
    await writeFile(join(fixture.dataDir, "journal", "cli-job.jsonl"), "invalid local journal\n", { mode: 0o600 });
    const captured = capture();
    expect(await main(["run", "--config", fixture.configFile, "--once", "--poll-only"], captured.io, {
      createGateway: config => createGatewayClient({ ...config, fetchImpl: fixture.fetchImpl }),
      createPrinter: fixture.createPrinter,
    })).toBe(1);
    expect(captured.output()).toEqual({ stdout: "journal_failed\n", stderr: "journal_write_failed\n" });
    expect(fixture.calls).toEqual([]);
    expect(fixture.adapter.commands).toEqual([]);
    expect(fixture.createPrinter).not.toHaveBeenCalled();
    expect(fixture.dispose).not.toHaveBeenCalled();
  });

  it("run refuses a live data-directory owner with the closed lock code and releases its own lock on exit", async () => {
    const fixture = await runFixture();
    const owner = createJobJournal(fixture.dataDir);
    await owner.initialize();
    try {
      for (const once of [true, false]) {
        const captured = capture();
        expect(await main(["run", "--config", fixture.configFile, "--poll-only", ...(once ? ["--once"] : [])], captured.io, {
          createGateway: settings => createGatewayClient({ ...settings, fetchImpl: fixture.fetchImpl }),
        })).toBe(1);
        expect(captured.output()).toEqual({ stdout: once ? "data_dir_locked\n" : "data_dir_locked\nhost_shutdown\n", stderr: "data_dir_locked\n" });
        expect(fixture.calls).toEqual([]);
      }
    } finally { await owner.close(); }
    const captured = capture();
    expect(await main(["run", "--config", fixture.configFile, "--once", "--poll-only"], captured.io, {
      createGateway: settings => createGatewayClient({ ...settings, fetchImpl: fixture.fetchImpl }),
    })).toBe(0);
    expect(await readdir(join(fixture.dataDir, "journal"))).not.toContain(".lock");
  });

  it.each(["SIGINT", "SIGTERM"] as const)("run --once handles %s by cancelling and posting signed failure evidence", async (signal) => {
    const fixture = await runFixture();
    fixture.adapter.scriptStart({ outcome: "success", jobId: 901 });
    const captured = capture();
    const before = process.listenerCount(signal);
    const running = main(["run", "--config", fixture.configFile, "--once", "--inputs-dir", fixture.inputsDir], captured.io, {
      createGateway: config => createGatewayClient({
        ...config, fetchImpl: fixture.fetchImpl, emergencyStopReader: () => ({ proceed: true }),
      }),
      createPrinter: fixture.createPrinter,
    });
    await fixture.adapter.started();
    process.emit(signal);
    const result = await running;
    expect(captured.output().stderr).toBe("");
    expect(result).toBe(0);
    expect(fixture.adapter.cancels).toEqual([901]);
    expect(fixture.calls.filter(path => path.endsWith("/evidence"))).toHaveLength(1);
    const bundle = JSON.parse(await readFile(join(fixture.dataDir, "journal", "cli-job.bundle.json"), "utf8"));
    expect(bundle.kernelSignature.algorithm).toBe("ed25519");
    expect(bundle.sessionKeyAuthorization).toBeDefined();
    expect(bundle.events.some((event: { type: string }) => event.type === "execution_failed")).toBe(true);
    expect(bundle.events.some((event: { type: string }) => event.type === "execution_completed")).toBe(false);
    expect(fixture.dispose).toHaveBeenCalledOnce();
    expect(process.listenerCount(signal)).toBe(before);
    assertRunOutput(captured, fixture.secrets);
  });
});
