import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CdpWalletClient } from "@pcc/payments";
import * as walletConfig from "../wallet-links/config.js";
import { faucetRoutesEnabled } from "./config.js";
import { createFaucetClientProvider, type FaucetClient } from "./client.js";

const generalNames = ["CDP_API_KEY_ID", "CDP_API_KEY_NAME", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"] as const;
const dummyEnv = () => ({ PCC_FAUCET_CDP_API_KEY_ID: "dummy-faucet-id", PCC_FAUCET_CDP_API_KEY_SECRET: "dummy-faucet-secret" });
const fakeClient = (): FaucetClient => ({ requestFaucet: vi.fn(async () => ({ transactionHash: undefined })) });
let temporaryDirectory: string;

beforeEach(() => {
  for (const name of generalNames) {
    vi.stubEnv(name, "");
    delete process.env[name];
  }
  temporaryDirectory = mkdtempSync(join(tmpdir(), "pcc-faucet-test-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("testnet-only faucet routes", () => {
  it.each([undefined, "base-sepolia", "sepolia", "flow-evm-testnet", "localhost"])("allows network %s", (network) => {
    expect(faucetRoutesEnabled(network === undefined ? {} : { PCC_NETWORK: network })).toBe(true);
  });

  it.each([
    { PCC_NETWORK: "base" },
    { PCC_NETWORK: "unknown-net" },
    { PCC_NETWORK: "" },
    { CDP_NETWORK: "base" },
    { PCC_X402_CHAIN: "base-mainnet" },
    { CDP_NETWORK: "" },
    { PCC_X402_CHAIN: "" },
  ])("refuses a non-testnet configuration %j", (env) => {
    expect(faucetRoutesEnabled(env)).toBe(false);
  });

  it("allows only unset or base-sepolia CDP and x402 networks", () => {
    expect(faucetRoutesEnabled({ CDP_NETWORK: "base-sepolia", PCC_X402_CHAIN: "base-sepolia" })).toBe(true);
  });

  it.each([{ chains: [] }, { chains: [8453] }, { chains: [84532, 8453] }, { chains: [84532, 84532] }])("requires exactly [84532], refusing $chains", ({ chains }) => {
    const original = walletConfig.walletLinkConfig();
    vi.spyOn(walletConfig, "walletLinkConfig").mockReturnValue({ ...original, allowedChainIds: chains });
    expect(faucetRoutesEnabled({})).toBe(false);
  });

  it("registers nothing when wallet-link configuration throws", () => {
    vi.spyOn(walletConfig, "walletLinkConfig").mockImplementation(() => { throw new Error("dummy-config-error"); });
    expect(faucetRoutesEnabled({})).toBe(false);
  });
});

describe("dedicated faucet client credentials", () => {
  it.each([
    {},
    { PCC_FAUCET_CDP_API_KEY_ID: "dummy-id" },
    { PCC_FAUCET_CDP_API_KEY_SECRET: "dummy-secret" },
    { PCC_FAUCET_CDP_API_KEY_ID: "", PCC_FAUCET_CDP_API_KEY_SECRET: "dummy-secret" },
    { PCC_FAUCET_CDP_API_KEY_ID: "dummy-id", PCC_FAUCET_CDP_API_KEY_SECRET: "   " },
    { CDP_API_KEY_ID: "dummy-id", CDP_API_KEY_SECRET: "dummy-secret" },
  ])("refuses missing dedicated credentials %j even for an injected fake", (env) => {
    const injected = fakeClient();
    expect(createFaucetClientProvider(env, injected)()).toBeUndefined();
    expect(injected.requestFaucet).not.toHaveBeenCalled();
  });

  it.each(generalNames)("refuses general %s in supplied environment", (name) => {
    const injected = fakeClient();
    expect(createFaucetClientProvider({ ...dummyEnv(), [name]: "dummy-general-value" }, injected)()).toBeUndefined();
    expect(injected.requestFaucet).not.toHaveBeenCalled();
  });

  it.each(generalNames)("refuses general %s in process.env even with custom options", (name) => {
    vi.stubEnv(name, "dummy-general-value");
    expect(createFaucetClientProvider(dummyEnv(), fakeClient())()).toBeUndefined();
  });

  it("refuses a general name even when its value is empty", () => {
    expect(createFaucetClientProvider({ ...dummyEnv(), CDP_API_KEY_ID: "" }, fakeClient())()).toBeUndefined();
  });

  it("refuses the real wrapper's default mock without calling it", () => {
    const mock = new CdpWalletClient();
    const spy = vi.spyOn(mock, "requestFaucet");
    expect(mock.isMock).toBe(true);
    expect(createFaucetClientProvider(dummyEnv(), mock)()).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns an injected nonmock client with complete dedicated credentials", () => {
    const injected = fakeClient();
    const getClient = createFaucetClientProvider(dummyEnv(), injected);
    expect(getClient()).toBe(injected);
    expect(getClient()).toBe(injected);
  });

  it("builds and caches a real wrapper lazily with dummy fallback credentials and no call", () => {
    const spy = vi.spyOn(CdpWalletClient.prototype, "requestFaucet");
    const getClient = createFaucetClientProvider(dummyEnv());
    const client = getClient();
    expect(client).toBeInstanceOf(CdpWalletClient);
    expect(client!.isMock).toBe(false);
    expect(getClient()).toBe(client);
    expect(spy).not.toHaveBeenCalled();
    const cfg = (client as unknown as { cfg: Record<string, unknown> }).cfg;
    expect(cfg).toEqual({ apiKeyId: "dummy-faucet-id", apiKeySecret: "dummy-faucet-secret", network: "base-sepolia", mock: false });
  });

  it("reads only the two allowed file lines, strips surrounding quotes and never changes process.env", () => {
    const path = join(temporaryDirectory, "dummy.env");
    writeFileSync(path, [
      "# dummy credentials only",
      "CDP_API_KEY_ID=\"dummy-file-id\"",
      "CDP_API_KEY_SECRET='dummy-file-secret'",
      "CDP_WALLET_SECRET=dummy-ignored-wallet-value",
      "CDP_API_KEY_NAME=dummy-ignored-name",
      "PCC_NETWORK=base",
      "export CDP_API_KEY_ID=dummy-ignored-export",
      "ANOTHER_VARIABLE=dummy-ignored-value",
    ].join("\n"));
    const before = { ...process.env };
    const getClient = createFaucetClientProvider({ ...dummyEnv(), PCC_FAUCET_CDP_ENV_FILE: path });
    const client = getClient();
    expect(client!.isMock).toBe(false);
    expect((client as unknown as { cfg: Record<string, unknown> }).cfg).toEqual({
      apiKeyId: "dummy-file-id", apiKeySecret: "dummy-file-secret", network: "base-sepolia", mock: false,
    });
    expect(process.env).toEqual(before);
    for (const name of generalNames) expect(process.env[name]).toBeUndefined();
    rmSync(path);
    expect(getClient()).toBe(client);
  });

  it("reads the file on first use rather than provider creation", () => {
    const path = join(temporaryDirectory, "lazy.env");
    const getClient = createFaucetClientProvider({ PCC_FAUCET_CDP_ENV_FILE: path }, fakeClient());
    writeFileSync(path, "CDP_API_KEY_ID=dummy-id\nCDP_API_KEY_SECRET=dummy-secret\n");
    expect(getClient()).toBeDefined();
  });

  it("refuses a missing file with no fallback and caches that read", () => {
    const path = join(temporaryDirectory, "missing.env");
    const injected = fakeClient();
    const getClient = createFaucetClientProvider({ ...dummyEnv(), PCC_FAUCET_CDP_ENV_FILE: path }, injected);
    expect(getClient()).toBeUndefined();
    writeFileSync(path, "CDP_API_KEY_ID=dummy-id\nCDP_API_KEY_SECRET=dummy-secret\n");
    expect(getClient()).toBeUndefined();
    expect(injected.requestFaucet).not.toHaveBeenCalled();
  });

  it.each(["CDP_API_KEY_ID=dummy-only-id\n", "CDP_API_KEY_SECRET=dummy-only-secret\n", "CDP_API_KEY_ID=''\nCDP_API_KEY_SECRET=dummy-secret\n"])("refuses incomplete file contents without fallback", (contents) => {
    const path = join(temporaryDirectory, "incomplete.env");
    writeFileSync(path, contents);
    expect(createFaucetClientProvider({ ...dummyEnv(), PCC_FAUCET_CDP_ENV_FILE: path }, fakeClient())()).toBeUndefined();
  });

  it("refuses an unreadable path and an empty configured path", () => {
    expect(createFaucetClientProvider({ ...dummyEnv(), PCC_FAUCET_CDP_ENV_FILE: temporaryDirectory }, fakeClient())()).toBeUndefined();
    expect(createFaucetClientProvider({ ...dummyEnv(), PCC_FAUCET_CDP_ENV_FILE: "" }, fakeClient())()).toBeUndefined();
  });

  it("rechecks general environment names on every provider call", () => {
    const getClient = createFaucetClientProvider(dummyEnv(), fakeClient());
    expect(getClient()).toBeDefined();
    vi.stubEnv("CDP_API_KEY_SECRET", "dummy-late-general-value");
    expect(getClient()).toBeUndefined();
  });
});
