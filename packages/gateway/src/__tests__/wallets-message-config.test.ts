import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { closeStore, initStore } from "../db.js";
import { walletsRoutes } from "../routes/wallets.js";
import { getLinkRequest } from "../services/wallet-links/repository.js";
import * as config from "../services/wallet-links/config.js";

const consent = vi.hoisted(() => ({ sha256: undefined as string | undefined }));
vi.mock("../services/wallet-links/consent.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/wallet-links/consent.js")>();
  return { ...actual, get CONSENT_SHA256() { return consent.sha256 ?? actual.CONSENT_SHA256; } };
});

const path = "/api/wallets/link-requests";
let app: FastifyInstance;

beforeEach(async () => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
  vi.stubEnv("NODE_ENV", "staging");
  vi.stubEnv("PCC_DEPLOYMENT_ENV", "");
  vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "");
  consent.sha256 = undefined;
  initStore({ seed: false });
  app = Fastify();
  await app.register(walletsRoutes);
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  closeStore();
  consent.sha256 = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function signedRequest() {
  const account = privateKeyToAccount(generatePrivateKey());
  const created = await app.inject({ method: "POST", url: path,
    payload: { keyType: "secp256k1", address: account.address, role: "agent", label: "cli@laptop", chainId: 84532 } });
  expect(created.statusCode).toBe(201);
  const request = created.json() as { requestId: string; message: string };
  const signature = await account.signMessage({ message: request.message });
  return { ...request, signature };
}

describe("wallet proof binds current configuration between create and proof", () => {
  it("refuses proof with 401 when the consent module hash changes after create", async () => {
    const request = await signedRequest();
    consent.sha256 = "0".repeat(64);
    const proof = await app.inject({ method: "POST", url: `${path}/${request.requestId}/proof`, payload: { signature: request.signature } });
    expect(proof.statusCode).toBe(401);
    expect(proof.json()).toEqual({ error: "invalid_proof" });
    expect(getLinkRequest(request.requestId)?.status).toBe("failed");
  });

  it("refuses proof with 401 when only the configured domain changes after create", async () => {
    const request = await signedRequest();
    const original = config.walletLinkConfig();
    vi.spyOn(config, "walletLinkConfig").mockReturnValue({ ...original, domain: "other.example" });
    expect(config.walletLinkConfig().uri).toBe(original.uri);
    const proof = await app.inject({ method: "POST", url: `${path}/${request.requestId}/proof`, payload: { signature: request.signature } });
    expect(proof.statusCode).toBe(401);
    expect(proof.json()).toEqual({ error: "invalid_proof" });
    expect(getLinkRequest(request.requestId)?.status).toBe("failed");
  });
});
