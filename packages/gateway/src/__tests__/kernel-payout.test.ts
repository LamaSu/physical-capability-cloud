import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { createHash, randomUUID } from "node:crypto";
import {
  decodeFunctionData, encodeFunctionResult, keccak256, parseAbi, toBytes,
  zeroAddress, zeroHash, type Address, type Hex, type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as contracts from "@pcc/contracts";
import { MilestoneEscrowV3ABI } from "@pcc/contracts/abi";
import { schema, sql } from "@pcc/store";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { authorityOf, EXPLICIT_CREDENTIAL_REQUIRED } from "../auth/kernel-authority.js";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { closeStore, getRepos, getStore, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import { __resetScopeCacheForTests, scopeChecker } from "../middleware/scope-checker.js";
import { kernelPayoutRoutes } from "../routes/kernel-payout.js";
import { walletsRoutes } from "../routes/wallets.js";
import {
  PAYOUT_CONSENT_SHA256, PAYOUT_CONSENT_TEMPLATE, PAYOUT_CONSENT_VERSION,
} from "../services/payout/consent.js";
import { CONSENT_SHA256 } from "../services/wallet-links/consent.js";

vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../middleware/security-hardening.js", () => ({
  canProvision: () => true, canSiweVerify: () => true,
}));

// Accounts and credentials exist only in this test process; no signing material is persisted.
const OWNER = privateKeyToAccount(generatePrivateKey());
const FOREIGN = privateKeyToAccount(generatePrivateKey());
const BUYER = privateKeyToAccount(generatePrivateKey());
const ADMIN = randomUUID();
const KERNEL = "n21-payout-kernel";
const JOB = "n21-payout-job";
const STEP = "n21-payout-step";
const CWM = "n21-payout-workflow";
const ESCROW = "0x1111111111111111111111111111111111111111" as Address;
const SIGNER = "0x2222222222222222222222222222222222222222" as Address;
const TOKEN = "0x3333333333333333333333333333333333333333" as Address;
const BLOCK = 12345678901234567n;
const BLOCK_HASH = `0x${"ab".repeat(32)}` as Hex;
const CHAIN = 84532;
const PROOF_URL = "/api/n21/proof";
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const terms = {
  version: PAYOUT_CONSENT_VERSION, sha256: PAYOUT_CONSENT_SHA256, template: PAYOUT_CONSENT_TEMPLATE,
};
const validBody = () => ({
  chainId: CHAIN, consentVersion: PAYOUT_CONSENT_VERSION, consentSha256: PAYOUT_CONSENT_SHA256,
});
type Headers = Record<string, string>;
type BindingRow = {
  id: string; kernel_id: string; chain_id: number; payout_address: string; bound_by_wallet: string;
  proof_via: string; proof_carrier: string; consent_version: string; consent_sha256: string;
  created_at: string; revoked_at: string | null; revoked_by: string | null; revoke_reason: string | null;
};
let apps: FastifyInstance[];

beforeEach(() => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("PCC_NETWORK", "base-sepolia");
  vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
  vi.stubEnv("PCC_ADMIN_KEY", ADMIN);
  for (const name of ["DATABASE_URL", "RAILWAY_VOLUME_MOUNT_PATH", "PCC_GATEWAY_PRIVATE_KEY",
    "DEPLOYER_PRIVATE_KEY", "POSTHOG_API_KEY", "VITE_POSTHOG_KEY", "PCC_WILDCARD_KEY_MIGRATION",
    "PCC_WILDCARD_KEY_KEEP_IDS", "PCC_WILDCARD_KEY_REVOKE_IDS", "TENANT_ENFORCE"]) {
    vi.stubEnv(name, "");
    delete process.env[name];
  }
  closeStore();
  initStore({ seed: false });
  __resetScopeCacheForTests();
  apps = [];
  seedKernel();
});

afterEach(async () => {
  for (const app of apps) await app.close();
  closeStore();
  __resetScopeCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function seedKernel(id = KERNEL) {
  const now = new Date().toISOString();
  getStore().db.insert(schema.shopKernels).values({
    id, name: "Payout record test", operatorAddress: OWNER.address,
    location: { lat: 0, lng: 0 }, physicalAddress: "test", maxAssuranceTier: 0,
    publicKey: "test-public-key", status: "online", registeredAt: now, lastHeartbeat: now, version: "1",
  }).run();
}

async function buildApp(publicClient?: PublicClient) {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.decorateRequest("operatorId", null);
  await app.register(cookie, { secret: randomUUID() });
  await app.register(siweAuthPlugin);
  await app.register(apiGate);
  await app.register(scopeChecker);
  await app.register(walletsRoutes);
  await app.register(kernelPayoutRoutes, { publicClient });
  app.get(PROOF_URL, async req => authorityOf(req));
  await app.ready();
  return app;
}

async function signIn(app: FastifyInstance, account = OWNER) {
  const host = "localhost";
  const nonce = await app.inject({ url: "/api/auth/nonce", headers: { host } });
  expect(nonce.statusCode).toBe(200);
  const message = [
    `${host} wants you to sign in with your Ethereum account:`, account.address.toLowerCase(),
    "", "Sign in to PCC.", "", `URI: http://${host}`, "Version: 1", "Chain ID: 8453",
    `Nonce: ${nonce.json().nonce}`, `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
  const response = await app.inject({
    method: "POST", url: "/api/auth/verify", headers: { host },
    payload: { message, signature: await account.signMessage({ message }) },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ token: string }>();
}

async function ownerCredentials(app: FastifyInstance, account = OWNER) {
  const session = await signIn(app, account);
  const minted = await app.inject({
    method: "POST", url: "/api/auth/session-key", headers: bearer(session.token),
  });
  expect(minted.statusCode).toBe(201);
  return {
    headers: bearer(minted.json<{ api_key: string }>().api_key),
    session: bearer(session.token), cookie: { cookie: `pcc_session=${app.signCookie(session.token)}` },
  };
}

function bindings() {
  return getStore().db.all<BindingRow>(sql`SELECT * FROM kernel_payout_bindings ORDER BY revoked_at IS NULL, created_at, id`);
}
function bind(app: FastifyInstance, headers: Headers, payload: Record<string, unknown> = validBody(), kernelId = KERNEL) {
  return app.inject({ method: "PUT", url: `/api/operator/payout/${kernelId}`, headers, payload });
}
function revoke(app: FastifyInstance, headers: Headers, chainId: unknown = CHAIN) {
  return app.inject({ method: "POST", url: `/api/operator/payout/${KERNEL}/revoke`, headers, payload: { chainId } });
}
function payout(app: FastifyInstance, headers: Headers, kernelId = KERNEL) {
  return app.inject({ url: `/api/kernels/${kernelId}/payout`, headers });
}

describe("kernel payout record", () => {
  it("T1: the owner's session key binds the proven wallet and exact consent", async () => {
    const app = await buildApp();
    const owner = await ownerCredentials(app);
    const response = await bind(app, owner.headers);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ created: true, binding: {
      kernelId: KERNEL, chainId: CHAIN, bound: true, payoutAddress: OWNER.address.toLowerCase(),
      proof: { via: "siwe-session", carrier: "key" }, consentVersion: terms.version,
      consentSha256: terms.sha256, consent: terms,
    } });
    const [row] = bindings();
    expect(row).toMatchObject({
      payout_address: OWNER.address.toLowerCase(), bound_by_wallet: OWNER.address.toLowerCase(),
      proof_via: "siwe-session", proof_carrier: "key", consent_version: terms.version,
      consent_sha256: terms.sha256, revoked_at: null,
    });
    expect(row!.payout_address).toBe(row!.bound_by_wallet);
    expect(row!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("T2: the owner's bearer session carries sign-in proof", async () => {
    const app = await buildApp();
    const owner = await ownerCredentials(app);
    const response = await bind(app, owner.session);
    expect(response.statusCode).toBe(200);
    expect(response.json().binding.proof).toEqual({ via: "siwe-session", carrier: "bearer-session" });
    expect(bindings()[0]!.proof_carrier).toBe("bearer-session");
  });

  it("T3: the owner's cookie alone cannot bind or revoke and stores nothing", async () => {
    const app = await buildApp();
    const owner = await ownerCredentials(app);
    for (const response of [await bind(app, owner.cookie), await revoke(app, owner.cookie)]) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual(EXPLICIT_CREDENTIAL_REQUIRED);
    }
    expect(bindings()).toEqual([]);
  });

  it.each(["agent", "device"] as const)("T4: a real self-link:%s owner proof cannot bind", async role => {
    const app = await buildApp();
    const key = provisionApiKey({ operatorId: OWNER.address.toLowerCase(), scopes: ["*"] });
    const headers = bearer(key.rawKey);
    const created = await app.inject({ method: "POST", url: "/api/wallets/link-requests", headers,
      payload: { keyType: "secp256k1", address: OWNER.address, chainId: CHAIN, role,
        label: `n21-self-link-${role}`, ...(role === "device" ? { kernelId: KERNEL } : {}) } });
    expect(created.statusCode).toBe(201);
    const link = created.json<{ requestId: string; userCode: string; message: string }>();
    const proof = await app.inject({ method: "POST", url: `/api/wallets/link-requests/${link.requestId}/proof`,
      payload: { signature: await OWNER.signMessage({ message: link.message }) } });
    expect(proof.statusCode).toBe(200);
    const approved = await app.inject({ method: "POST", url: `/api/wallets/link-requests/${link.requestId}/approve`,
      headers, payload: { userCode: link.userCode, decision: "approve", consentSha256: CONSENT_SHA256 } });
    expect(approved.statusCode).toBe(200);
    const linkedHeaders = { ...headers, "x-pcc-wallet": OWNER.address };
    const control = await app.inject({ url: PROOF_URL, headers: linkedHeaders });
    expect(control.statusCode).toBe(200);
    expect(control.json()).toMatchObject({ provenWallet: OWNER.address.toLowerCase(),
      provenWalletVia: `self-link:${role}`, provenWalletCarrier: "key", admin: false });
    const response = await bind(app, linkedHeaders);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "forbidden", reason: "wallet_sign_in_required" });
    expect(bindings()).toEqual([]);
  });

  it("T5: a foreign session key and a claimed-only owner key cannot bind", async () => {
    const app = await buildApp();
    const foreign = await ownerCredentials(app, FOREIGN);
    const response = await bind(app, foreign.headers);
    expect(response.statusCode).toBe(403);
    expect(response.json().reason).toBe("operator_proof_required");
    const claimed = provisionApiKey({ operatorId: OWNER.address.toLowerCase(), scopes: ["*"] });
    const unproven = await bind(app, bearer(claimed.rawKey));
    expect(unproven.statusCode).toBe(403);
    expect(unproven.json().reason).toBe("wallet_sign_in_required");
    expect(bindings()).toEqual([]);
  });

  it("T6: admin authority never binds, even beside owner proof, but can revoke", async () => {
    const app = await buildApp();
    const owner = await ownerCredentials(app);
    const key = provisionApiKey({ operatorId: "n21-admin", scopes: ["*"] });
    const admin = { ...bearer(key.rawKey), "x-admin-key": ADMIN };
    for (const headers of [admin, { ...owner.headers, "x-admin-key": ADMIN }]) {
      const response = await bind(app, headers);
      expect(response.statusCode).toBe(403);
      expect(response.json().reason).toBe("wallet_sign_in_required");
    }
    expect(bindings()).toEqual([]);
    expect((await bind(app, owner.headers)).statusCode).toBe(200);
    const response = await revoke(app, admin);
    expect(response.statusCode).toBe(200);
    expect(response.json().binding).toMatchObject({ revokedBy: "admin", revokeReason: "admin_revoked" });
    expect(bindings()[0]).toMatchObject({ revoked_by: "admin", revoke_reason: "admin_revoked" });
  });

  it("T7: body destinations are ignored in favor of the proven wallet", async () => {
    const app = await buildApp();
    const owner = await ownerCredentials(app);
    const response = await bind(app, owner.headers, { ...validBody(),
      payoutAddress: FOREIGN.address, address: FOREIGN.address, wallet: FOREIGN.address });
    expect(response.statusCode).toBe(200);
    expect(response.json().binding.payoutAddress).toBe(OWNER.address.toLowerCase());
    expect(bindings()[0]!.payout_address).toBe(OWNER.address.toLowerCase());
    expect(bindings()[0]!.bound_by_wallet).toBe(OWNER.address.toLowerCase());
  });

  it("T8: only the settlement chain and exact current consent are accepted", async () => {
    const app = await buildApp();
    const owner = await ownerCredentials(app);
    for (const chainId of [1, CHAIN + 0.5, `${CHAIN}`, null, Number.MAX_SAFE_INTEGER + 1]) {
      for (const response of [await bind(app, owner.headers, { ...validBody(), chainId }),
        await revoke(app, owner.headers, chainId)]) {
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: "invalid_chain",
          message: "chainId must be this gateway's settlement chain.", chainId: CHAIN });
      }
    }
    for (const patch of [{ consentVersion: "old" }, { consentSha256: "0".repeat(64) },
      { consentVersion: null }, { consentSha256: 123 }, { consentSha256: PAYOUT_CONSENT_SHA256.toUpperCase() }]) {
      const response = await bind(app, owner.headers, { ...validBody(), ...patch });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: "consent_mismatch", consent: terms });
    }
    expect(bindings()).toEqual([]);
  });

  it("T9: repeats are idempotent, ownership changes unbind immediately, and rebind preserves history", async () => {
    const app = await buildApp();
    const owner = await ownerCredentials(app);
    expect((await bind(app, owner.headers)).json().created).toBe(true);
    const before = bindings();
    const repeated = await bind(app, owner.session);
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().created).toBe(false);
    expect(bindings()).toEqual(before);
    getStore().db.run(sql`UPDATE shop_kernels SET operator_address = ${` ${FOREIGN.address.toUpperCase()} `} WHERE id = ${KERNEL}`);
    const changed = await payout(app, owner.headers);
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ kernelId: KERNEL, chainId: CHAIN, bound: false, reason: "owner_changed", consent: terms });
    const foreign = await ownerCredentials(app, FOREIGN);
    const rebound = await bind(app, foreign.headers);
    expect(rebound.statusCode).toBe(200);
    expect(rebound.json()).toMatchObject({ created: true, binding: { bound: true, payoutAddress: FOREIGN.address.toLowerCase() } });
    const rows = bindings();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: before[0]!.id, revoked_by: "owner", revoke_reason: "rebound" });
    expect(rows[0]!.revoked_at).toEqual(expect.any(String));
    expect(rows[1]).toMatchObject({ payout_address: FOREIGN.address.toLowerCase(), revoked_at: null });
    expect((await payout(app, owner.headers)).json().payoutAddress).toBe(FOREIGN.address.toLowerCase());
  });

  it("T10: GET reports bound, revoked, never bound, missing kernel, and failed reads distinctly", async () => {
    const app = await buildApp();
    const owner = await ownerCredentials(app);
    expect((await payout(app, owner.headers)).json()).toEqual({
      kernelId: KERNEL, chainId: CHAIN, bound: false, reason: "none", consent: terms,
    });
    await bind(app, owner.headers);
    const bound = await payout(app, owner.headers);
    expect(bound.statusCode).toBe(200);
    expect(bound.json()).toMatchObject({ bound: true, boundAt: bindings()[0]!.created_at,
      payoutAddress: OWNER.address.toLowerCase(), consent: terms });
    await revoke(app, owner.headers);
    expect((await payout(app, owner.headers)).json()).toEqual({
      kernelId: KERNEL, chainId: CHAIN, bound: false, reason: "revoked", consent: terms,
    });
    const missing = await payout(app, owner.headers, "n21-missing");
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "kernel_not_found", message: "No kernel with this id is registered." });
    getStore().db.run(sql`DROP TABLE kernel_payout_bindings`);
    const failed = await payout(app, owner.headers);
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ error: "read_failed", message: "The payout record could not be read. Try again shortly." });
  });

  it("T11: owner revoke is permanent and a second revoke is not_bound", async () => {
    const app = await buildApp();
    const owner = await ownerCredentials(app);
    await bind(app, owner.headers);
    const response = await revoke(app, owner.session);
    expect(response.statusCode).toBe(200);
    expect(response.json().binding).toEqual({ kernelId: KERNEL, chainId: CHAIN,
      payoutAddress: OWNER.address.toLowerCase(), boundAt: bindings()[0]!.created_at,
      revokedAt: bindings()[0]!.revoked_at, revokedBy: "owner", revokeReason: "owner_revoked" });
    const before = bindings();
    const again = await revoke(app, owner.headers);
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual({ error: "not_bound", message: "This kernel has no active payout record on this chain." });
    expect(bindings()).toEqual(before);
  });

  it("T12: payout consent hashes the exact UTF-8 template and leaves W1's deployed hash intact", () => {
    expect(PAYOUT_CONSENT_VERSION).toBe("kernel-payout-v1");
    expect(PAYOUT_CONSENT_TEMPLATE.endsWith("\n")).toBe(false);
    expect(PAYOUT_CONSENT_SHA256).toBe(createHash("sha256").update(PAYOUT_CONSENT_TEMPLATE, "utf8").digest("hex"));
    expect(CONSENT_SHA256).toBe("24480b7fd41e13804038619c248b398cd247d009729a8ff69d98b486c8b0dc19");
  });

  it("T13: GET payout requires authentication", async () => {
    const app = await buildApp();
    expect((await app.inject({ url: `/api/kernels/${KERNEL}/payout` })).statusCode).toBe(401);
    expect(bindings()).toEqual([]);
  });
});

const READER_ABI = [...MilestoneEscrowV3ABI, ...parseAbi([
  "function disputes(uint256) view returns (address challenger, uint256 challengerBond, bytes32 challengerEvidenceHash, string reason, bool resolved, bool challengerWon)",
])];
type ChainCall = { functionName: string; blockNumber?: bigint; address?: Address; blockHash?: Hex; requireCanonical?: boolean };
function fakeClient() {
  const factories = contracts.getDeployment("base-sepolia").contracts;
  const state = {
    claimedBy: new Set<string>([factories.milestoneEscrowFactoryV3!.toLowerCase()]),
    steps: [keccak256(toBytes(STEP))], operator: SIGNER, splits: [] as Array<{ recipient: Address; bps: bigint; roleTag: Hex; ipId: Hex }>,
    count: undefined as bigint | undefined, throwAt: "", calls: [] as ChainCall[],
  };
  const milestone = (index: bigint) => ({
    stepId: state.steps[Number(index)]!, operator: state.operator, amount: 1000000n,
    operatorBond: 100n, status: 1, evidenceBundleHash: zeroHash, verifierAttestationHash: zeroHash,
    challengeWindowEnd: 0n, challengeWindowSeconds: 60n, requiredTier: 0, jobIdHash: zeroHash,
    verifierAttestationUid: zeroHash, attestedFeeBps: 0, attestedFeeRecipient: zeroAddress,
  });
  const value = (name: string, args: readonly unknown[] = []) => {
    if (state.throwAt === name) throw new Error("simulated RPC outage");
    switch (name) {
      case "getMilestoneCount": return state.count ?? BigInt(state.steps.length);
      case "getMilestone": return milestone(args[0] as bigint);
      case "getPayoutMap": return state.splits;
      case "payoutMapSet": return state.splits.length > 0;
      case "tokenForMilestone": return TOKEN;
      case "disputes": return [zeroAddress, 0n, zeroHash, "", false, false];
      default: throw new Error(`Unexpected fake RPC read: ${name}`);
    }
  };
  const client = {
    getBlockNumber: vi.fn(async () => {
      if (state.throwAt === "getBlockNumber") throw new Error("simulated RPC outage");
      return BLOCK;
    }),
    getBlock: vi.fn(async (input: { blockNumber?: bigint } = {}) => {
      state.calls.push({ functionName: "getBlock", blockNumber: input.blockNumber });
      if (state.throwAt === "getBlock") throw new Error("simulated RPC outage");
      return { number: BLOCK, hash: BLOCK_HASH, timestamp: 1n };
    }),
    getChainId: vi.fn(async () => CHAIN),
    readContract: vi.fn(async (input: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
      state.calls.push({ functionName: input.functionName, blockNumber: input.blockNumber, address: input.address });
      if (input.functionName === "isProtocolEscrow") {
        if (state.throwAt === input.functionName) throw new Error("simulated RPC outage");
        expect(input.args).toEqual([ESCROW]);
        return state.claimedBy.has(input.address.toLowerCase());
      }
      return value(input.functionName, input.args);
    }),
    request: vi.fn(async (input: { method: string; params: [{ to: Address; data: Hex }, { blockHash: Hex; requireCanonical: boolean }] }) => {
      expect(input.method).toBe("eth_call");
      const call = decodeFunctionData({ abi: READER_ABI, data: input.params[0].data });
      state.calls.push({ functionName: call.functionName, address: input.params[0].to,
        blockHash: input.params[1].blockHash, requireCanonical: input.params[1].requireCanonical });
      return encodeFunctionResult({ abi: READER_ABI, functionName: call.functionName,
        result: value(call.functionName, call.args) } as never);
    }),
  };
  return { ...state, state, client: client as unknown as PublicClient, methods: client, factories };
}

function seedJob(linked = true, version = "v3") {
  getRepos().jobs.insert({ id: JOB, stepId: STEP, cwmId: CWM, capabilityId: "n21-capability",
    kernelId: KERNEL, status: "queued", assignedDevices: [], progress: 0 });
  if (linked) getStore().db.insert(schema.escrows).values({
    id: "n21-escrow", cwmId: CWM, contractAddress: ESCROW, payer: BUYER.address,
    totalAmount: "1", currency: "USDC", status: "funded", version,
    createdAt: new Date().toISOString(), deadline: new Date(Date.now() + 3600000).toISOString(),
  }).run();
}

function check(app: FastifyInstance, headers: Headers = {}) {
  return app.inject({ url: `/api/jobs/${JOB}/payout-check`, headers });
}

describe("job payout check", () => {
  it("P1: the gateway signer differs from the owner's bound wallet", async () => {
    const fake = fakeClient();
    const app = await buildApp(fake.client);
    const owner = await ownerCredentials(app);
    seedJob();
    await bind(app, owner.headers);
    const response = await check(app, owner.headers);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ jobId: JOB, kernelId: KERNEL, stepId: STEP,
      escrow: { link: "linked", address: ESCROW, recordedVersion: "v3", version: "v3", chainId: CHAIN },
      milestoneIndex: "0", blockNumber: BLOCK.toString(), blockHash: BLOCK_HASH,
      recipients: { ok: true, outcome: "pending", operator: { recipient: SIGNER, role: "operator-residual", plusBond: "100" }, splits: [] },
      match: false, reasons: ["recipient_is_not_the_bound_wallet"] });
  });

  it("P2: the operator residual recipient equal to the binding matches", async () => {
    const fake = fakeClient();
    fake.state.operator = OWNER.address;
    const app = await buildApp(fake.client);
    const owner = await ownerCredentials(app);
    seedJob();
    await bind(app, owner.headers);
    const response = await check(app, owner.headers);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ match: true, reasons: [], binding: { bound: true } });
  });

  it("P3: absent, revoked and owner-changed bindings never match", async () => {
    const fake = fakeClient();
    fake.state.operator = OWNER.address;
    const app = await buildApp(fake.client);
    const owner = await ownerCredentials(app);
    seedJob();
    for (const state of ["none", "revoked", "owner_changed"]) {
      if (state === "revoked") { await bind(app, owner.headers); await revoke(app, owner.headers); }
      if (state === "owner_changed") {
        await bind(app, owner.headers);
        getStore().db.run(sql`UPDATE shop_kernels SET operator_address = ${FOREIGN.address} WHERE id = ${KERNEL}`);
      }
      const plain = provisionApiKey({ operatorId: "n21-check-admin", scopes: ["*"] });
      const response = await check(app, { ...bearer(plain.rawKey), "x-admin-key": ADMIN });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ match: false, reasons: ["payout_wallet_unbound"],
        binding: { bound: false, reason: state } });
    }
  });

  it.each(["v1", "unknown"])("P4: chain-derived %s escrows never use the recorded v2 reader", async kind => {
    const reader = vi.spyOn(contracts, "readMilestoneRecipients");
    const fake = fakeClient();
    fake.state.claimedBy.clear();
    if (kind === "v1") fake.state.claimedBy.add(fake.factories.pccProtocol!.toLowerCase());
    const app = await buildApp(fake.client);
    const owner = await ownerCredentials(app);
    seedJob(true, "v2");
    const response = await check(app, owner.headers);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ match: null, reasons: expect.arrayContaining(["unsupported_version"]) });
    expect(reader).not.toHaveBeenCalled();
    expect(fake.methods.request).not.toHaveBeenCalled();
    expect(fake.state.calls.filter(c => c.functionName === "isProtocolEscrow")).toHaveLength(3);
  });

  it.each(["getBlockNumber", "isProtocolEscrow", "getMilestoneCount", "getMilestone", "getBlock", "disputes"])(
    "P5: RPC failure at %s is a 200 unknown, never a 500", async throwAt => {
      const fake = fakeClient();
      fake.state.throwAt = throwAt;
      const app = await buildApp(fake.client);
      const owner = await ownerCredentials(app);
      seedJob();
      const response = await check(app, owner.headers);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ match: null, reasons: expect.arrayContaining(["chain_read_failed"]) });
      if (throwAt === "disputes") expect(response.json().recipients.checks).toContainEqual(
        expect.objectContaining({ name: "dispute-read", ok: false }));
    },
  );

  it("P6: an unlinked job reports escrow_not_linked without chain calls", async () => {
    const fake = fakeClient();
    const app = await buildApp(fake.client);
    const owner = await ownerCredentials(app);
    seedJob(false);
    const response = await check(app, owner.headers);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ match: null, reasons: ["escrow_not_linked"], recipients: null });
    expect(fake.methods.getBlockNumber).not.toHaveBeenCalled();
  });

  it.each([0, 2])("P6: %s matching chain milestones cannot be attributed", async matches => {
    const fake = fakeClient();
    fake.state.steps = matches === 0 ? [zeroHash] : [keccak256(toBytes(STEP)), keccak256(toBytes(STEP))];
    const app = await buildApp(fake.client);
    const owner = await ownerCredentials(app);
    seedJob();
    const response = await check(app, owner.headers);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ match: null,
      reasons: expect.arrayContaining([matches === 0 ? "milestone_not_found" : "milestone_ambiguous"]) });
    expect(fake.methods.request).not.toHaveBeenCalled();
  });

  it("P6: shared steps and more than 64 milestones fail closed", async () => {
    const fake = fakeClient();
    const app = await buildApp(fake.client);
    const owner = await ownerCredentials(app);
    seedJob();
    fake.state.count = 65n;
    const tooMany = await check(app, owner.headers);
    expect(tooMany.statusCode).toBe(200);
    expect(tooMany.json()).toMatchObject({ match: null, reasons: expect.arrayContaining(["too_many_milestones"]) });
    expect(fake.state.calls.some(call => call.functionName === "getMilestone")).toBe(false);
    fake.state.count = undefined;
    getRepos().jobs.insert({ id: "n21-competing-job", stepId: STEP, cwmId: CWM,
      capabilityId: "n21-capability", kernelId: KERNEL, status: "queued", assignedDevices: [], progress: 0 });
    const shared = await check(app, owner.headers);
    expect(shared.statusCode).toBe(200);
    expect(shared.json()).toMatchObject({ match: null, reasons: expect.arrayContaining(["milestone_not_unique_to_job"]) });
  });

  it("P7: every state read uses the one pinned block or its canonical hash", async () => {
    const reader = vi.spyOn(contracts, "readMilestoneRecipients");
    const fake = fakeClient();
    const app = await buildApp(fake.client);
    const owner = await ownerCredentials(app);
    seedJob();
    const response = await check(app, owner.headers);
    expect(response.statusCode).toBe(200);
    expect(response.json().recipients.ok).toBe(true);
    expect(fake.methods.getBlockNumber).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith(expect.objectContaining({ client: fake.client, blockNumber: BLOCK }));
    for (const [call] of fake.methods.readContract.mock.calls) expect(call.blockNumber).toBe(BLOCK);
    for (const [call] of fake.methods.getBlock.mock.calls) expect(call?.blockNumber).toBe(BLOCK);
    for (const [call] of fake.methods.request.mock.calls) expect(call.params[1]).toEqual({ blockHash: BLOCK_HASH, requireCanonical: true });
    expect(fake.methods.request).toHaveBeenCalled();
  });

  it("P8: only the job's buyer, proven kernel operator and admin read it", async () => {
    const fake = fakeClient();
    const app = await buildApp(fake.client);
    const owner = await ownerCredentials(app);
    const buyer = await ownerCredentials(app, BUYER);
    const foreign = await ownerCredentials(app, FOREIGN);
    const claimed = provisionApiKey({ operatorId: OWNER.address.toLowerCase(), scopes: ["*"] });
    seedJob();
    getStore().db.run(sql`INSERT INTO negotiation_sessions
      (id, status, user_agent_id, kernel_id, capability_type, operator_constraints, job_id,
       escrow_address, cwm_id, created_at, expires_at)
      VALUES ('n21-session', 'committed', ${BUYER.address.toLowerCase()}, ${KERNEL}, 'test', '{}', ${JOB},
        ${ESCROW}, ${CWM}, ${new Date().toISOString()}, ${new Date(Date.now() + 3600000).toISOString()})`);
    for (const headers of [owner.headers, buyer.headers, { ...bearer(claimed.rawKey), "x-admin-key": ADMIN }]) {
      expect((await check(app, headers)).statusCode).toBe(200);
    }
    const stranger = await check(app, foreign.headers);
    expect(stranger.statusCode).toBe(404);
    const anonymous = await check(app);
    expect(anonymous.statusCode).toBe(401);
    const unproven = await check(app, bearer(claimed.rawKey));
    expect(unproven.statusCode).toBe(403);
    expect(unproven.json().error).toBe("identity_unverified");
    expect(fake.methods.getBlockNumber).toHaveBeenCalledTimes(3);
  });

  it("P9: a split recipient equal to the binding cannot substitute for the operator residual", async () => {
    const fake = fakeClient();
    fake.state.splits = [{ recipient: OWNER.address, bps: 1000n, roleTag: zeroHash, ipId: zeroHash }];
    const app = await buildApp(fake.client);
    const owner = await ownerCredentials(app);
    seedJob();
    await bind(app, owner.headers);
    const response = await check(app, owner.headers);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ match: false, reasons: ["recipient_is_not_the_bound_wallet"],
      recipients: { ok: true, splits: [expect.objectContaining({ recipient: OWNER.address, role: "split" })] } });
  });

  it("P10: all factories are checked and multiple claims prevent a recipient read", async () => {
    const reader = vi.spyOn(contracts, "readMilestoneRecipients");
    const fake = fakeClient();
    fake.state.claimedBy.add(fake.factories.milestoneEscrowFactoryV2!.toLowerCase());
    const app = await buildApp(fake.client);
    const owner = await ownerCredentials(app);
    seedJob();
    const response = await check(app, owner.headers);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ match: null, reasons: ["version_ambiguous"], recipients: null });
    expect(reader).not.toHaveBeenCalled();
    expect(fake.state.calls.filter(call => call.functionName === "isProtocolEscrow")).toHaveLength(3);
  });

  it("a derived version mismatch is informational and does not suppress a true match", async () => {
    const fake = fakeClient();
    fake.state.operator = OWNER.address;
    const app = await buildApp(fake.client);
    const owner = await ownerCredentials(app);
    seedJob(true, "v2");
    await bind(app, owner.headers);
    const response = await check(app, owner.headers);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ match: true, reasons: ["recorded_version_differs"],
      escrow: { version: "v3", recordedVersion: "v2" } });
  });
});
