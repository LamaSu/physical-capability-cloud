import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { sql } from "@pcc/store";

vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../middleware/security-hardening.js", () => ({ canProvision: () => true }));
vi.mock("../auth/ed25519.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/ed25519.js")>();
  return { ...actual, generateEd25519Keypair: vi.fn(actual.generateEd25519Keypair) };
});
const chain = vi.hoisted(() => ({
  registerAgentOnChain: vi.fn(),
  isIdentityWriteEnabled: vi.fn(),
  generateOperatorWallet: vi.fn(),
  setAgentWalletOnChain: vi.fn(),
}));
vi.mock("../services/erc8004-identity-write.js", () => ({
  ...chain,
  getIdentityRegistryAddress: () => "0x8004A818BFB912233c491871b3d84c89A494BD9e",
}));

import { provisionApiKey } from "../auth/api-key-auth.js";
import { generateEd25519Keypair } from "../auth/ed25519.js";
import { closeStore, getStore, initStore } from "../db.js";
import { provisionRoutes } from "../routes/provision.js";
import { auditService } from "../services/audit-service.js";
import { trackServerEvent } from "../services/posthog-service.js";

const PRIVATE_KEY_PROPERTIES = new Set([
  "private_key", "private_key_pkcs8_base64", "privateKey", "secret_key",
]);

function privateKeyPropertyPaths(value: unknown, path = "$"): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([name, child]) => {
    const childPath = `${path}.${name}`;
    return [
      ...(PRIVATE_KEY_PROPERTIES.has(name) ? [childPath] : []),
      ...privateKeyPropertyPaths(child, childPath),
    ];
  });
}

function storedPublicKey(keyId: string): string | null | undefined {
  return getStore().db.get<{ public_key: string | null }>(sql`
    SELECT public_key FROM api_keys WHERE id = ${keyId}
  `)?.public_key;
}

function expectProvisionSource(keyId: string, source: "none" | "byok") {
  const entries = auditService.query({ eventType: "auth.key_provisioned", resourceId: keyId });
  expect.soft(entries).toHaveLength(1);
  expect.soft(entries[0]?.metadata?.ed25519_keypair_source).toBe(source);
  expect.soft(trackServerEvent).toHaveBeenCalledTimes(1);
  expect.soft(trackServerEvent).toHaveBeenCalledWith(
    "api_key_provisioned",
    expect.objectContaining({ ed25519_keypair_source: source }),
  );
}

describe("provisioning never generates or returns an Ed25519 private key", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("PCC_DB_PATH", ":memory:");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("RAILWAY_VOLUME_MOUNT_PATH", "");
    delete process.env.DATABASE_URL;
    delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
    chain.isIdentityWriteEnabled.mockReturnValue(true);
    chain.registerAgentOnChain.mockResolvedValue({
      agentId: 42n,
      txHash: `0x${"a".repeat(64)}`,
      registryAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      chainId: 84532,
    });
    chain.generateOperatorWallet.mockResolvedValue({
      address: `0x${"b".repeat(40)}`, privateKey: `0x${"de".repeat(32)}`,
    });
    chain.setAgentWalletOnChain.mockResolvedValue({ txHash: `0x${"a".repeat(64)}` });
    initStore({ seed: false });
    app = Fastify({ logger: false });
    await app.register(provisionRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    vi.unstubAllEnvs();
  });

  it.each([true, false])("omitting publicKey leaves no signing key with identity writes %s", async (identityWrites) => {
    chain.isIdentityWriteEnabled.mockReturnValue(identityWrites);
    const response = await app.inject({
      method: "POST", url: "/api/auth/provision", payload: { email: "n78@example.com" },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect.soft(body.api_key).toMatch(/^pcc_live_/);
    expect.soft(body.ed25519).toEqual({ public_key: null, source: "none" });
    expect.soft(storedPublicKey(body.key_id)).toBeNull();
    expect.soft(privateKeyPropertyPaths(body)).toEqual([]);
    expect.soft(generateEd25519Keypair).not.toHaveBeenCalled();
    expect.soft(body.onchain.status).toBe(identityWrites ? "written" : "disabled");
    expectProvisionSource(body.key_id, "none");
  });

  it.each([
    ["lowercase", (hex: string) => hex],
    ["0x-prefixed", (hex: string) => `0x${hex}`],
    ["uppercase", (hex: string) => hex.toUpperCase()],
    ["uppercase and 0x-prefixed", (hex: string) => `0x${hex.toUpperCase()}`],
  ] as const)("BYOK accepts %s and never exposes private material", async (_label, format) => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const normalized = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
    const supplied = format(normalized);
    const response = await app.inject({
      method: "POST", url: "/api/auth/provision",
      payload: { email: "n78-byok@example.com", publicKey: supplied },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect.soft(body.api_key).toMatch(/^pcc_live_/);
    expect.soft(body.ed25519).toEqual({ public_key: normalized, source: "byok" });
    expect.soft(storedPublicKey(body.key_id)).toBe(normalized);
    expect.soft(privateKeyPropertyPaths(body)).toEqual([]);
    expectProvisionSource(body.key_id, "byok");

    const result = provisionApiKey({ operatorId: "n78-byok-direct@example.com", publicKey: supplied });
    expect.soft(result.record.publicKey).toBe(normalized);
    expect.soft(result).not.toHaveProperty("ed25519");
    expect.soft(generateEd25519Keypair).not.toHaveBeenCalled();
  });

  it("direct provisioning without publicKey never calls the keypair generator", () => {
    const result = provisionApiKey({ operatorId: "n78-direct@example.com" });
    expect.soft(generateEd25519Keypair).not.toHaveBeenCalled();
    expect.soft(result).not.toHaveProperty("ed25519");
    expect.soft(result.record.publicKey).toBeNull();
    expect.soft(storedPublicKey(result.record.id)).toBeNull();
    expect.soft(result.rawKey).toMatch(/^pcc_live_/);
  });

  it("verification without a signing key returns key_not_found without promising a gateway key", async () => {
    const provision = await app.inject({
      method: "POST", url: "/api/auth/provision", payload: { email: "n78-verify@example.com" },
    });
    expect(provision.statusCode).toBe(201);
    const response = await app.inject({
      method: "POST", url: `/api/agents/${provision.json().key_id}/verify`,
      payload: { message: "test message", signature: "a".repeat(128) },
    });
    expect.soft(response.statusCode).toBe(404);
    const body = response.json();
    expect.soft(body.error).toBe("key_not_found");
    expect.soft(body.message).toEqual(expect.any(String));
    expect.soft(String(body.message)).not.toContain("server-minted");
  });
});
