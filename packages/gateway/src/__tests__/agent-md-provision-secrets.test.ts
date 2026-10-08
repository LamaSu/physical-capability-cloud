/**
 * The agent golden path must name every private key POST /api/auth/provision
 * can return. These tests drive the real route with the ERC-8004 identity-write
 * service mocked (nothing touches a chain), collect every private-key field in
 * the 201 body, and check the buyer path and the supply runbook against them.
 */

import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/posthog-service.js", () => ({
  trackServerEvent: vi.fn(),
}));
vi.mock("../services/audit-service.js", () => ({
  auditService: {
    log: vi.fn(),
    query: vi.fn().mockReturnValue([]),
    stats: vi.fn().mockReturnValue([]),
  },
}));

// vi.mock is hoisted; use vi.hoisted to create the mocks BEFORE hoisting.
const {
  mockRegisterAgentOnChain,
  mockIsIdentityWriteEnabled,
  mockGetIdentityRegistryAddress,
  mockGenerateOperatorWallet,
  mockSetAgentWalletOnChain,
} = vi.hoisted(() => ({
  mockRegisterAgentOnChain: vi.fn(),
  mockIsIdentityWriteEnabled: vi.fn(),
  mockGetIdentityRegistryAddress: vi.fn(
    () => "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  ),
  mockGenerateOperatorWallet: vi.fn(),
  mockSetAgentWalletOnChain: vi.fn(),
}));

vi.mock("../services/erc8004-identity-write.js", () => ({
  registerAgentOnChain: mockRegisterAgentOnChain,
  isIdentityWriteEnabled: mockIsIdentityWriteEnabled,
  getIdentityRegistryAddress: mockGetIdentityRegistryAddress,
  generateOperatorWallet: mockGenerateOperatorWallet,
  setAgentWalletOnChain: mockSetAgentWalletOnChain,
  checkSignerFunding: vi.fn(async () => ({
    signer: undefined,
    balanceWei: 0n,
    balanceEth: "0",
    sufficientForOneRegister: false,
  })),
  resetClientsForTest: vi.fn(),
  readAgentURI: vi.fn(),
  getIdentityWriteSigner: vi.fn(),
}));

import { provisionRoutes } from "../routes/provision.js";
import { initStore, closeStore } from "../db.js";

const root = new URL("../../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const provisionAction = () => JSON.parse(read("starter/buyer/buyer-path.json")).steps[0].actions[0] as {
  tool: string;
  request: string;
  responseFields: string[];
};

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  const app = Fastify({ logger: false });
  await app.register(provisionRoutes);
  await app.ready();
  return app;
}

/** A real Ed25519 public key as 64 hex characters: the SPKI DER's last 32 bytes. */
function localEd25519PublicKeyHex(): string {
  const der = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" });
  return der.subarray(der.length - 32).toString("hex");
}

/** Dotted path of every key named like a private key, anywhere in the body. */
function privateKeyPaths(value: unknown, path: string[] = []): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(/private_key/.test(key) ? [[...path, key].join(".")] : []),
    ...privateKeyPaths(child, [...path, key]),
  ]);
}

/** Every emitted path must be a documented response field and named in the request prose. */
function expectDocumented(paths: string[]): void {
  const provision = provisionAction();
  expect(provision.tool).toBe("provision_api_key");
  for (const path of paths) {
    expect(
      provision.responseFields.some((field) => field === path || field.startsWith(`${path} (`)),
      `buyer path responseFields must name ${path}`,
    ).toBe(true);
    expect(provision.request, `buyer path request must name ${path}`).toContain(path);
  }
}

describe("agent golden path names every private key the provision response carries", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    closeStore();
  });

  it("identity write on, own publicKey sent: operator_wallet.private_key and no Ed25519 private key", async () => {
    mockIsIdentityWriteEnabled.mockReturnValue(true);
    mockRegisterAgentOnChain.mockResolvedValue({
      agentId: 42n,
      txHash: "0xdeadbeef" + "0".repeat(56),
      registryAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      chainId: 84532,
    });
    // Fake wallet built at runtime: no key-shaped literal in this file.
    const wallet = { address: "0x" + "cd".repeat(20), privateKey: "0x" + "ab".repeat(32) };
    mockGenerateOperatorWallet.mockResolvedValue(wallet);
    mockSetAgentWalletOnChain.mockRejectedValue(new Error("no chain in tests"));

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: { email: "byok-identity@example.com", publicKey: localEd25519PublicKeyHex() },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ed25519.source).toBe("byok");
    expect(body.operator_wallet.private_key).toBe(wallet.privateKey);
    const paths = privateKeyPaths(body);
    expect(paths).toContain("operator_wallet.private_key");
    expect(paths.filter((path) => /^ed25519\..*private_key/.test(path))).toEqual([]);
    expectDocumented(paths);
  });

  it("identity write off, no publicKey: both encodings of the minted Ed25519 private key", async () => {
    mockIsIdentityWriteEnabled.mockReturnValue(false);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: { email: "minted-ed25519@example.com" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ed25519.source).toBe("server-minted");
    expect(mockRegisterAgentOnChain).not.toHaveBeenCalled();
    const paths = privateKeyPaths(body);
    expect(paths).toEqual(expect.arrayContaining(["ed25519.private_key", "ed25519.private_key_pkcs8_base64"]));
    expectDocumented(paths);
  });
});

describe("agent golden path drops the claims that no private key comes back", () => {
  it("buyer path request and supply runbook", () => {
    expect(provisionAction().request).not.toContain("no private key comes back");
    const runbook = read("starter/runbook/00-prerequisites.md");
    expect(runbook).toContain("operator_wallet.private_key");
    expect(runbook).not.toContain("no private key ever travels");
  });
});
