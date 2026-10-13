import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkHostConfig, HostConfigError, loadHostConfig, type HostConfig } from "../src/config.js";
import { generateHostKeys } from "../src/keygen.js";
import type * as secretFile from "../src/secret-file.js";

const mocks = vi.hoisted(() => ({ fileBuffers: [] as { path: string; bytes: Buffer }[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});
vi.mock("../src/secret-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof secretFile>();
  return { ...actual, readSecretFile: vi.fn(async (...args: Parameters<typeof actual.readSecretFile>) => {
    const bytes = await actual.readSecretFile(...args);
    mocks.fileBuffers.push({ path: args[0], bytes });
    return bytes;
  }) };
});

const dirs: string[] = [];

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "ph2-config-"));
  dirs.push(dir);
  await chmod(dir, 0o700);
  const path = join(dir, "host.json");
  const config = {
    kernelId: "kernel:n144",
    deviceId: "device_n144-1",
    printer: { uri: "ipp://127.0.0.1:631/ipp/print" },
    chain: { chainId: 84532 as const, rpcUrlFile: join(dir, "rpc-url") },
    gateway: { baseUrl: "https://capability.network", apiKeyFile: join(dir, "api-key") },
    keys: { deviceKeyFile: join(dir, "keys", "device-key.json"), operatorKeyFile: join(dir, "keys", "operator-key.json") },
    dataDir: join(dir, "data"),
  };
  async function save(value: unknown = config, mode = 0o644) {
    await writeFile(path, JSON.stringify(value), { mode });
    await chmod(path, mode);
  }
  await save();
  return { dir, path, config, save };
}

async function completeFixture(chainId: 84532 | 31337 = 84532) {
  const setup = await fixture();
  const pair = await generateHostKeys(join(setup.dir, "keys"));
  const rpcSecret = randomBytes(24).toString("hex");
  const apiSecret = randomBytes(24).toString("hex");
  const config: HostConfig = { ...setup.config, chain: { ...setup.config.chain, chainId } };
  await writeFile(config.chain.rpcUrlFile, `https://rpc.example.test/${rpcSecret}\n`, { mode: 0o600 });
  await writeFile(config.gateway.apiKeyFile, `${apiSecret}\n`, { mode: 0o600 });
  await mkdir(config.dataDir, { mode: 0o700 });
  await chmod(config.dataDir, 0o700);
  await setup.save(config);
  return { ...setup, config, pair, rpcSecret, apiSecret };
}

function containsSecret(value: string, secret: string): boolean {
  for (let index = 0; index <= secret.length - 12; index++) {
    if (value.includes(secret.slice(index, index + 12))) return true;
  }
  return false;
}

function expectNoSecret(value: unknown, secrets: string[]) {
  const forms = [String(value), JSON.stringify(value), inspect(value, { depth: 5, showHidden: true })];
  for (const form of forms) for (const secret of secrets) expect(containsSecret(form, secret)).toBe(false);
}

async function expectConfigFailure(operation: () => Promise<unknown>, code: string, secrets: string[] = []) {
  let caught: unknown;
  try { await operation(); } catch (error) { caught = error; }
  expect(caught instanceof HostConfigError).toBe(true);
  expect((caught as HostConfigError).code === code).toBe(true);
  expect(Object.hasOwn(caught as object, "cause")).toBe(false);
  const allowedKeys = new Set(["name", "code", "path", "field"]);
  expect(Object.keys(caught as object).every((key) => allowedKeys.has(key))).toBe(true);
  expectNoSecret(caught, secrets);
  expectNoSecret((caught as Error).message, secrets);
  return caught as HostConfigError;
}

beforeEach(async () => {
  mocks.fileBuffers = [];
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("host configuration", () => {
  it("loads a valid config and freezes each nested object", async () => {
    const setup = await fixture();
    const config = await loadHostConfig(setup.path);
    expect(config).toEqual(setup.config);
    expect(Object.isFrozen(config)).toBe(true);
    for (const nested of [config.chain, config.gateway, config.keys, config.printer]) expect(Object.isFrozen(nested)).toBe(true);
  });

  it.each([8453, 1, 11155111])("refuses chain %s with an explicit testnet-only error", async (chainId) => {
    const setup = await fixture();
    await setup.save({ ...setup.config, chain: { ...setup.config.chain, chainId } });
    const error = await expectConfigFailure(() => loadHostConfig(setup.path), "testnet_only");
    expect(error.message).toBe(`testnet_only: ${setup.path}; the print host is testnet-only`);
  });

  it.each(["root", "chain", "keys", "gateway", "printer"])("refuses unknown fields in %s", async (section) => {
    const setup = await fixture();
    const value = section === "root"
      ? { ...setup.config, unexpected: true }
      : { ...setup.config, [section]: { ...(setup.config as unknown as Record<string, object>)[section], unexpected: true } };
    await setup.save(value);
    await expectConfigFailure(() => loadHostConfig(setup.path), "bad_schema");
  });

  it.each([
    "http://remote.example.test", "https://operator@remote.example.test", "https://@remote.example.test",
    "https://remote.example.test/?access=private", "https://remote.example.test/#fragment",
    "https://remote.example.test/?", "https://remote.example.test/#", "https://remote.example.test/ with-space",
    "https:operator@remote.example.test", "https:@remote.example.test",
    "https:/operator@remote.example.test", "https:/@remote.example.test",
    "https:///operator@remote.example.test", "https:///@remote.example.test",
    String.raw`https:\operator@remote.example.test`, String.raw`https:\@remote.example.test`,
    String.raw`https:\\operator@remote.example.test`, String.raw`https:\\@remote.example.test`,
    String.raw`https:/\operator@remote.example.test`, String.raw`https:/\@remote.example.test`,
    String.raw`https://remote.example.test\@other.example.test`,
    "https:remote.example.test", "https:/remote.example.test", "https:///remote.example.test",
  ])("refuses invalid gateway URL %s", async (baseUrl) => {
    const setup = await fixture();
    await setup.save({ ...setup.config, gateway: { ...setup.config.gateway, baseUrl } });
    await expectConfigFailure(() => loadHostConfig(setup.path), "bad_schema");
  });

  it.each(["http://127.0.0.1:8080", "http://[::1]:8080", "http://localhost:8080"])("accepts gateway loopback URL %s", async (baseUrl) => {
    const setup = await fixture();
    await setup.save({ ...setup.config, gateway: { ...setup.config.gateway, baseUrl } });
    expect((await loadHostConfig(setup.path)).gateway.baseUrl).toBe(baseUrl);
  });

  it.each(["https://printer.example.test", "ipp:/without-host", "ipp://operator@printer.example.test"])("refuses invalid printer URI %s", async (uri) => {
    const setup = await fixture();
    await setup.save({ ...setup.config, printer: { uri } });
    await expectConfigFailure(() => loadHostConfig(setup.path), "bad_schema");
  });

  it.each(["rpcUrlFile", "apiKeyFile", "deviceKeyFile", "operatorKeyFile", "dataDir"])("refuses a relative %s path", async (field) => {
    const setup = await fixture();
    const value = structuredClone(setup.config);
    if (field === "rpcUrlFile") value.chain.rpcUrlFile = "relative";
    else if (field === "apiKeyFile") value.gateway.apiKeyFile = "relative";
    else if (field === "deviceKeyFile" || field === "operatorKeyFile") value.keys[field] = "relative";
    else value.dataDir = "relative";
    await setup.save(value);
    await expectConfigFailure(() => loadHostConfig(setup.path), "bad_schema");
  });

  it.each([0o664, 0o646, 0o666])("refuses a config mode writable by others (%s)", async (mode) => {
    const setup = await fixture();
    await setup.save(setup.config, mode);
    await expectConfigFailure(() => loadHostConfig(setup.path), "bad_mode");
  });

  it("checks the config owner, absolute path, regular file, and symlink status", async () => {
    const setup = await fixture();
    await expectConfigFailure(() => loadHostConfig(setup.path, { expectedUid: process.getuid!() + 1 }), "bad_owner");
    await expectConfigFailure(() => loadHostConfig("relative.json"), "not_absolute");
    await expectConfigFailure(() => loadHostConfig(setup.dir), "not_regular_file");
    const link = join(setup.dir, "host-link.json");
    await symlink(setup.path, link);
    await expectConfigFailure(() => loadHostConfig(link), "symlink");
  });

  it("detects a config file swapped between lstat and open", async () => {
    const setup = await fixture();
    const originalOpen = (await vi.importActual<typeof fs>("node:fs/promises")).open;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      await fs.rename(setup.path, join(setup.dir, "original"));
      await setup.save();
      return originalOpen(...args);
    });
    await expectConfigFailure(() => loadHostConfig(setup.path), "changed_during_open");
  });

  it("refuses a config symlink swapped between lstat and open", async () => {
    const setup = await fixture();
    const originalOpen = (await vi.importActual<typeof fs>("node:fs/promises")).open;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const target = join(setup.dir, "original");
      await fs.rename(setup.path, target);
      await fs.symlink(target, setup.path);
      return originalOpen(...args);
    });
    await expectConfigFailure(() => loadHostConfig(setup.path), "read_failed");
  });

  it("rechecks config mode after open", async () => {
    const setup = await fixture();
    const originalOpen = (await vi.importActual<typeof fs>("node:fs/promises")).open;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await originalOpen(...args);
      await handle.chmod(0o666);
      return handle;
    });
    await expectConfigFailure(() => loadHostConfig(setup.path), "bad_mode");
  });

  it("rechecks config owner on the opened file", async () => {
    const setup = await fixture();
    const originalOpen = (await vi.importActual<typeof fs>("node:fs/promises")).open;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await originalOpen(...args);
      const originalStat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementationOnce(async (...statArgs) => {
        const stat = await originalStat(...statArgs);
        stat.uid = typeof stat.uid === "number" ? stat.uid + 1 : stat.uid + 1n;
        return stat;
      });
      return handle;
    });
    await expectConfigFailure(() => loadHostConfig(setup.path), "bad_owner");
  });

  it("does not retain JSON parser excerpts or schema values", async () => {
    const setup = await fixture();
    const secret = "abcdef"[randomBytes(1)[0]! % 6]! + randomBytes(32).toString("hex");
    await writeFile(setup.path, `${secret}{`, { mode: 0o644 });
    const parseError = await expectConfigFailure(() => loadHostConfig(setup.path), "bad_json", [secret]);
    expect(parseError.message === `bad_json: ${setup.path}`, "bad_json uses only its closed message").toBe(true);
    await setup.save({ ...setup.config, kernelId: secret.repeat(3) });
    const schemaError = await expectConfigFailure(() => loadHostConfig(setup.path), "bad_schema", [secret]);
    expect(schemaError.message).toBe(`bad_schema: ${setup.path} (kernelId)`);
  });

  it("checks all private files end to end and returns only public identity", async () => {
    const setup = await completeFixture();
    const result = await checkHostConfig(await loadHostConfig(setup.path));
    const expected = {
      kernelId: setup.config.kernelId, deviceId: setup.config.deviceId, chainId: 84532,
      devicePublicKey: setup.pair.identity.devicePublicKey, operatorAddress: setup.pair.identity.operatorAddress,
      printerUri: setup.config.printer.uri, gatewayBaseUrl: setup.config.gateway.baseUrl,
    };
    const deviceFile = JSON.parse(await readFile(setup.pair.paths.deviceKeyFile, "utf8")) as { seed: string };
    const operatorFile = JSON.parse(await readFile(setup.pair.paths.operatorKeyFile, "utf8")) as { privateKey: string };
    expectNoSecret(result, [setup.rpcSecret, setup.apiSecret, deviceFile.seed, operatorFile.privateKey.slice(2)]);
    expect(JSON.stringify(result) === JSON.stringify(expected)).toBe(true);
  });

  it("zeroes the RPC URL and API-key buffers after successful validation", async () => {
    const setup = await completeFixture();
    await checkHostConfig(setup.config);
    for (const path of [setup.config.chain.rpcUrlFile, setup.config.gateway.apiKeyFile]) {
      const buffers = mocks.fileBuffers.filter((entry) => entry.path === path);
      expect(buffers).toHaveLength(1);
      expect(buffers[0].bytes.length > 0).toBe(true);
      expect(buffers[0].bytes.every((byte) => byte === 0), "validated credential bytes were retained").toBe(true);
    }
  });

  it.each(["RPC URL", "API key"] as const)("zeroes the %s buffer after failed validation", async (credential) => {
    const setup = await completeFixture();
    const isRpc = credential === "RPC URL";
    const path = isRpc ? setup.config.chain.rpcUrlFile : setup.config.gateway.apiKeyFile;
    const invalid = isRpc ? `http://rpc.example.test/${setup.rpcSecret}` : `${setup.apiSecret} whitespace`;
    await writeFile(path, invalid, { mode: 0o600 });
    await expectConfigFailure(() => checkHostConfig(setup.config), isRpc ? "bad_rpc_url" : "bad_api_key",
      [setup.rpcSecret, setup.apiSecret]);
    const buffers = mocks.fileBuffers.filter((entry) => entry.path === path);
    expect(buffers).toHaveLength(1);
    expect(buffers[0].bytes.length > 0).toBe(true);
    expect(buffers[0].bytes.every((byte) => byte === 0), "rejected credential bytes were retained").toBe(true);
  });

  it.each(["http://127.0.0.1:8545", "http://[::1]:8545", "http://localhost:8545"])("allows anvil RPC at %s", async (url) => {
    const setup = await completeFixture(31337);
    await writeFile(setup.config.chain.rpcUrlFile, `${url}\r\n`, { mode: 0o600 });
    expect((await checkHostConfig(setup.config)).chainId).toBe(31337);
  });

  it.each(["http://127.0.0.1:8545", "ftp://remote.example.test", "https://remote.example.test\nsecond", ""])("refuses invalid Base Sepolia RPC %s", async (url) => {
    const setup = await completeFixture();
    await writeFile(setup.config.chain.rpcUrlFile, url, { mode: 0o600 });
    await expectConfigFailure(() => checkHostConfig(setup.config), "bad_rpc_url", [setup.apiSecret]);
  });

  it("refuses remote HTTP RPC for anvil without leaking provider credentials", async () => {
    const setup = await completeFixture(31337);
    await writeFile(setup.config.chain.rpcUrlFile, `http://rpc.example.test/${setup.rpcSecret}\n`, { mode: 0o600 });
    await expectConfigFailure(() => checkHostConfig(setup.config), "bad_rpc_url", [setup.rpcSecret, setup.apiSecret]);
  });

  it.each(["", "\n", "two tokens", "one\nsecond", "one\n\n"])("refuses invalid API token shape %s", async (token) => {
    const setup = await completeFixture();
    await writeFile(setup.config.gateway.apiKeyFile, token, { mode: 0o600 });
    await expectConfigFailure(() => checkHostConfig(setup.config), "bad_api_key", [setup.rpcSecret]);
  });

  it("never leaks an invalid API token", async () => {
    const setup = await completeFixture();
    await writeFile(setup.config.gateway.apiKeyFile, `${setup.apiSecret} whitespace`, { mode: 0o600 });
    await expectConfigFailure(() => checkHostConfig(setup.config), "bad_api_key", [setup.rpcSecret, setup.apiSecret]);
  });

  it.each([0o750, 0o770, 0o755])("refuses a non-private data directory (%s)", async (mode) => {
    const setup = await completeFixture();
    await chmod(setup.config.dataDir, mode);
    await expectConfigFailure(() => checkHostConfig(setup.config), "bad_data_dir", [setup.rpcSecret, setup.apiSecret]);
  });

  it("refuses a symlink data directory", async () => {
    const setup = await completeFixture();
    const target = join(setup.dir, "data-target");
    await mkdir(target, { mode: 0o700 });
    await rm(setup.config.dataDir, { recursive: true });
    await symlink(target, setup.config.dataDir);
    await expectConfigFailure(() => checkHostConfig(setup.config), "bad_data_dir", [setup.rpcSecret, setup.apiSecret]);
  });

  it("revalidates a caller-supplied config before touching credentials", async () => {
    const setup = await fixture();
    const invalid = { ...setup.config, chain: { ...setup.config.chain, chainId: 8453 } } as unknown as HostConfig;
    await expectConfigFailure(() => checkHostConfig(invalid), "testnet_only");
  });
});
