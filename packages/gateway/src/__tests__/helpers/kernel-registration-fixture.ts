import Fastify, { type FastifyInstance } from "fastify";
import { kernelSigningProofMessage } from "@pcc/kernel";
import { privateKeyToAccount } from "viem/accounts";
import { provisionApiKey } from "../../auth/api-key-auth.js";
import { generateEd25519Keypair, signWithPrivateKeyHex } from "../../auth/ed25519.js";
import { apiGate } from "../../middleware/api-gate.js";
import { scopeChecker, __resetScopeCacheForTests } from "../../middleware/scope-checker.js";
import { kernelRoutes } from "../../routes/kernels.js";
import { closeStore, getRepos, initStore } from "../../db.js";

export const OWNER = "0x1111111111111111111111111111111111111111";
export const OTHER = "0x2222222222222222222222222222222222222222";
export const ADMIN_SECRET = "registration-test-admin";
export const ED_A = generateEd25519Keypair();
export const ED_B = generateEd25519Keypair();
export const EVM_A = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
export const EVM_B = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

export type TestSigner =
  | { algorithm: "ed25519"; publicKey: string }
  | { algorithm: "secp256k1"; address: string };
export const ED_SIGNER: TestSigner = { algorithm: "ed25519", publicKey: `0x${ED_A.publicKeyHex}` };
export const EVM_SIGNER: TestSigner = { algorithm: "secp256k1", address: EVM_A.address };
export interface Challenge { challengeId: string; message: string; expiresAt: string }

export function signEd(message: string, key = ED_A): string {
  const signature = signWithPrivateKeyHex(key.privateKeyHex, Buffer.from(message, "base64"));
  if (!signature) throw new Error("Could not sign test registration challenge");
  return signature;
}

export function signerFields(signer: TestSigner): Record<string, string> {
  return signer.algorithm === "ed25519"
    ? { signingKeyAlgorithm: "ed25519", signingPublicKey: signer.publicKey }
    : { signingKeyAlgorithm: "secp256k1", signingAddress: signer.address };
}

export function legacyEdProof(kernelId: string, key = ED_A): string {
  const signature = signWithPrivateKeyHex(key.privateKeyHex, Buffer.from(kernelSigningProofMessage(kernelId), "utf8"));
  if (!signature) throw new Error("Could not sign test legacy proof");
  return signature;
}

export async function registrationFixture() {
  const envNames = ["PCC_DB_PATH", "DATABASE_URL", "RAILWAY_VOLUME_MOUNT_PATH", "PCC_DEPLOYMENT_ENV", "RAILWAY_ENVIRONMENT_NAME", "NODE_ENV", "PCC_CHAIN_ID", "PCC_PUBLIC_URL", "PCC_GATEWAY_URL", "RAILWAY_PUBLIC_DOMAIN", "PCC_ADMIN_KEY", "PCC_KERNEL_LEGACY_SIGNING_PROOF"] as const;
  const saved = new Map(envNames.map((name) => [name, process.env[name]]));
  delete process.env.DATABASE_URL;
  delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
  delete process.env.PCC_KERNEL_LEGACY_SIGNING_PROOF;
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_DEPLOYMENT_ENV = "prod";
  process.env.PCC_CHAIN_ID = "84532";
  process.env.PCC_PUBLIC_URL = "https://capability.network";
  process.env.PCC_ADMIN_KEY = ADMIN_SECRET;
  closeStore();
  initStore({ seed: false });
  __resetScopeCacheForTests();
  const app: FastifyInstance = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const proven = req.headers["x-test-proven-wallet"];
    if (typeof proven === "string") {
      const authority = req as unknown as { provenWallet: string; provenWalletVia: string };
      authority.provenWallet = proven;
      authority.provenWalletVia = typeof req.headers["x-test-proven-wallet-via"] === "string"
        ? req.headers["x-test-proven-wallet-via"] : "self-link:agent";
    }
  });
  await app.register(apiGate);
  await app.register(scopeChecker);
  await app.register(kernelRoutes);
  await app.ready();
  const ownerKey = provisionApiKey({ operatorId: OWNER }).rawKey;
  const sameClaimKey = provisionApiKey({ operatorId: OWNER }).rawKey;
  const otherKey = provisionApiKey({ operatorId: OTHER }).rawKey;
  const headers = (key = ownerKey) => ({ authorization: `Bearer ${key}` });
  const adminHeaders = { ...headers(otherKey), "x-admin-key": ADMIN_SECRET };
  const provenHeaders = { ...headers(), "x-test-proven-wallet": OWNER };
  async function issue(kernelId: string, signer: TestSigner = ED_SIGNER, key = ownerKey): Promise<Challenge> {
    const result = await app.inject({ method: "POST", url: "/api/kernels/registration-challenges", headers: headers(key), payload: { kernelId, signer } });
    if (result.statusCode !== 201) throw new Error(`Challenge issuance failed: ${result.statusCode} ${result.body}`);
    return result.json() as Challenge;
  }
  async function proof(kernelId: string, signer: TestSigner = ED_SIGNER, key = ownerKey) {
    const challenge = await issue(kernelId, signer, key);
    const signature = signer.algorithm === "ed25519" ? signEd(challenge.message) : await EVM_A.signMessage({ message: challenge.message });
    return { ...signerFields(signer), registrationProof: { challengeId: challenge.challengeId, signature } };
  }
  async function register(id: string, payload: Record<string, unknown> = {}, requestHeaders: Record<string, string> = headers()) {
    return app.inject({ method: "POST", url: "/api/kernels", headers: requestHeaders, payload: { id, name: "Initial profile", ...payload } });
  }
  const row = (id: string) => structuredClone(getRepos().kernels.findById(id));
  async function close() {
    await app.close();
    closeStore();
    __resetScopeCacheForTests();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  return { app, ownerKey, sameClaimKey, otherKey, headers, adminHeaders, provenHeaders, issue, proof, register, row, close };
}
export type RegistrationFixture = Awaited<ReturnType<typeof registrationFixture>>;
