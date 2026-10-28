import { createPrivateKey, createPublicKey, randomBytes, randomUUID, sign, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { privateKeyToAccount } from "viem/accounts";
import { hashBundle, hashEvent, type EvidenceEvent } from "@pcc/spec";
import { sql } from "@pcc/store";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { closeStore, getRepos, getStore, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import { __resetScopeCacheForTests, scopeChecker } from "../middleware/scope-checker.js";
import { kernelRoutes } from "../routes/kernels.js";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { settlementReceiptRoutes } from "../routes/settlement-receipts.js";
import { computePackageBodyHash, PACKAGE_FORMAT, PACKAGE_SCHEMA_VERSION, type FinalMilestonePackageV2Body, type Hex } from "../settlement/final-milestone-package-v2.js";
import { computeGatewayReceiptDigest } from "../settlement/gateway-receipt.js";

vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../middleware/security-hardening.js", () => ({
  canProvision: () => true,
  canSiweVerify: () => true,
}));

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const H = (digit: string) => `0x${digit.repeat(64)}` as Hex;
const ESCROW = "0x00000000000000000000000000000000000e5c0f" as Hex;
const FOREIGN_KERNEL = "session-key-host-foreign";
const TYPES = {
  FinalMilestonePackageV2: [
    { name: "chainId", type: "uint256" }, { name: "escrow", type: "address" },
    { name: "settlementUnitId", type: "bytes32" }, { name: "jobIdHash", type: "bytes32" },
    { name: "milestoneIndex", type: "uint256" }, { name: "stepId", type: "bytes32" },
    { name: "compositionRoot", type: "bytes32" }, { name: "acceptedEnvelopeHash", type: "bytes32" },
    { name: "packageBodyHash", type: "bytes32" },
  ],
} as const;

// All signing credentials are generated in memory for this test, never fixtures on disk.
function wallet() {
  return privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
}

function ed25519Key(seed = randomBytes(32).toString("hex")) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed, "hex")]),
    format: "der", type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey);
  const raw = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(12);
  return { privateKey, publicKey, hex: `0x${raw.toString("hex")}` };
}

async function sessionKey(app: FastifyInstance, account: ReturnType<typeof wallet>) {
  const host = "localhost";
  const nonce = await app.inject({ method: "GET", url: "/api/auth/nonce", headers: { host } });
  expect(nonce.statusCode).toBe(200);
  const message = [
    `${host} wants you to sign in with your Ethereum account:`, account.address,
    "", "Sign in to PCC.", "", `URI: http://${host}`, "Version: 1", "Chain ID: 8453",
    `Nonce: ${nonce.json().nonce}`, `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
  const verified = await app.inject({
    method: "POST", url: "/api/auth/verify", headers: { host },
    payload: { message, signature: await account.signMessage({ message }) },
  });
  expect(verified.statusCode).toBe(200);
  const minted = await app.inject({
    method: "POST", url: "/api/auth/session-key", headers: bearer(verified.json().token),
  });
  // Do not include auth response bodies in assertion diagnostics: they contain credentials.
  expect(minted.statusCode).toBe(201);
  const key = minted.json<{ api_key: string; key_id: string }>();
  const row = getRepos().apiKeys.findById(key.key_id)!;
  expect(row.operatorId).toBe(account.address);
  expect(JSON.parse(row.metadata!)).toMatchObject({ source: "siwe-session" });
  return bearer(key.api_key);
}

describe("SIWE session keys on print host routes", () => {
  let app: FastifyInstance;
  let owner: ReturnType<typeof wallet>;
  let ownerHeaders: ReturnType<typeof bearer>;
  let foreignHeaders: ReturnType<typeof bearer>;
  let kernelId: string;
  let jobId: string;
  let admin: string;
  let device: ReturnType<typeof ed25519Key>;
  let receiptKey: ReturnType<typeof ed25519Key>;
  const db = () => getStore().db;
  const receipts = () => db().all(sql`SELECT * FROM gateway_receipts`);
  const challenges = () => db().all(sql`SELECT * FROM settlement_challenges`);
  const challenge = () => db().get(sql`SELECT * FROM settlement_challenges ORDER BY issued_at DESC LIMIT 1`) as { state: string } | undefined;

  beforeEach(async () => {
    vi.stubEnv("PCC_DB_PATH", ":memory:");
    vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
    for (const name of ["DATABASE_URL", "RAILWAY_VOLUME_MOUNT_PATH", "PCC_GATEWAY_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "POSTHOG_API_KEY", "VITE_POSTHOG_KEY", "PCC_WILDCARD_KEY_MIGRATION", "PCC_WILDCARD_KEY_KEEP_IDS", "PCC_WILDCARD_KEY_REVOKE_IDS"]) {
      vi.stubEnv(name, "");
      delete process.env[name];
    }
    admin = randomUUID();
    vi.stubEnv("PCC_ADMIN_KEY", admin);
    const receiptSeed = randomBytes(32).toString("hex");
    vi.stubEnv("PCC_GATEWAY_RECEIPT_SEED", receiptSeed);
    vi.stubEnv("PCC_GATEWAY_RECEIPT_VALID_FROM", "0");
    receiptKey = ed25519Key(receiptSeed);
    device = ed25519Key();
    closeStore();
    initStore({ seed: true });
    __resetScopeCacheForTests();

    app = Fastify({ logger: false });
    app.decorateRequest("userId", null);
    app.decorateRequest("apiKeyId", null);
    app.decorateRequest("operatorId", null);
    await app.register(cookie, { secret: randomUUID() });
    // Exercise sibling routes registered before the non-encapsulated auth hooks.
    await app.register(siweAuthPlugin);
    await app.register(kernelRoutes);
    await app.register(operatorRelayRoutes);
    await app.register(settlementReceiptRoutes);
    await app.register(apiGate);
    await app.register(scopeChecker);
    await app.ready();

    const job = getRepos().jobs.findAll().find(row => row.kernelId && row.status === "queued");
    expect(job, "the seed must contain a queued job with a kernel and capability").toBeDefined();
    jobId = job!.id;
    kernelId = job!.kernelId!;
    // Reuse the supplied receipt fixture's registry-row replacement technique.
    // Retain the seeded capability/job references, then register KA through HTTP.
    db().run(sql`PRAGMA foreign_keys = OFF`);
    try {
      db().run(sql`DELETE FROM shop_kernels WHERE id = ${kernelId}`);
    } finally {
      db().run(sql`PRAGMA foreign_keys = ON`);
    }
    owner = wallet();
    ownerHeaders = await sessionKey(app, owner);
    const foreign = wallet();
    foreignHeaders = await sessionKey(app, foreign);
    for (const [id, account, headers] of [
      [kernelId, owner, ownerHeaders],
      [FOREIGN_KERNEL, foreign, foreignHeaders],
    ] as const) {
      const registered = await app.inject({
        method: "POST", url: "/api/kernels", headers,
        payload: { id, name: `Session key host ${id}` },
      });
      expect(registered.statusCode, registered.body).toBe(201);
      expect(getRepos().kernels.findById(id)!.operatorAddress).toBe(account.address);
    }
    expect(getRepos().jobs.findById(jobId)).toMatchObject({ kernelId, status: "queued" });
    // Keep the actual operator established by registration; add only the device registry key.
    db().run(sql`UPDATE shop_kernels SET signing_key_algorithm = 'ed25519', signing_key_public_key = ${device.hex}, signing_address = NULL WHERE id = ${kernelId}`);
  });

  afterEach(async () => {
    await app?.close();
    closeStore();
    __resetScopeCacheForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function evidence() {
    const source = { deviceId: "printer-1", deviceType: "fdm", kernelId };
    return { events: [
      { type: "execution_completed", timestamp: "2026-09-29T22:35:01.000Z", source, payload: { ok: true, jobId } },
      { type: "cv_inspection_result", timestamp: "2026-09-29T22:35:02.000Z", source, payload: { passed: true, jobId } },
    ] };
  }

  async function issuedPackage() {
    // Only challenge issuance uses the admin secret. Host requests carry just their session key.
    const issued = await app.inject({
      method: "POST", url: "/api/admin/settlement-challenges", headers: { "x-admin-key": admin },
      payload: { jobId, chainId: "8453", escrow: ESCROW, settlementUnitId: H("1") },
    });
    expect(issued.statusCode, issued.body).toBe(200);
    const binding = issued.json<{ nonce: Hex; tChallengeRef: string }>();
    const body: FinalMilestonePackageV2Body = {
      packageSchemaVersion: PACKAGE_SCHEMA_VERSION, packageFormat: PACKAGE_FORMAT, compositionSchemaVersion: "1",
      unitBinding: {
        chainId: "8453", escrow: ESCROW, settlementUnitId: H("1"), jobIdHash: H("2"),
        milestoneIndex: "0", stepId: H("3"), compositionRoot: H("4"), acceptedEnvelopeHash: H("5"),
      },
      producer: {
        kernelId, operatorPrincipalId: `eip155:8453:${owner.address.toLowerCase()}`,
        devicePrincipalId: `ed25519:${device.hex}`,
      },
      challengeBinding: { nonce: binding.nonce, tChallengeRef: binding.tChallengeRef },
      evidence: { evidenceBlockHash: H("7") }, evidenceTimeBounds: { start: "1700000000", end: "1700000100" },
    };
    const hash = computePackageBodyHash(body);
    const signatures = [
      {
        signer: owner.address.toLowerCase(), scheme: "secp256k1-eip712",
        sig: (await owner.signTypedData({
          domain: { name: "PCC FinalMilestonePackage", version: "2", chainId: 8453n, verifyingContract: ESCROW },
          types: TYPES, primaryType: "FinalMilestonePackageV2",
          message: { ...body.unitBinding, chainId: 8453n, milestoneIndex: 0n, packageBodyHash: hash },
        })).toLowerCase(),
      },
      {
        signer: device.hex, scheme: "ed25519-raw32",
        sig: `0x${sign(null, Buffer.from(hash.slice(2), "hex"), device.privateKey).toString("hex")}`,
      },
    ];
    return { packageEnvelope: { body, signatures } };
  }

  it("P1: the operator's session key polls its queued job with emergencyStop clear", async () => {
    const response = await app.inject({
      method: "GET", url: `/api/operator/jobs?kernelId=${kernelId}&status=queued`, headers: ownerHeaders,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ emergencyStop: "clear", jobs: expect.arrayContaining([expect.objectContaining({ id: jobId, kernelId, status: "queued" })]) });
  });

  it("P2: the operator's session key sends an acknowledged heartbeat", async () => {
    const response = await app.inject({
      method: "POST", url: "/api/operator/heartbeat", headers: ownerHeaders,
      payload: { kernelId, status: "online" },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ acknowledged: true, kernelId });
  });

  it("P3: the operator's session key claims its job as in_progress", async () => {
    const response = await app.inject({
      method: "POST", url: "/api/operator/job-status", headers: ownerHeaders,
      payload: { jobId, status: "in_progress" },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ updated: true, jobId, status: "in_progress" });
    expect(getRepos().jobs.findById(jobId)).toMatchObject({ kernelId, status: "in_progress" });
  });

  it("P4: the operator's session key stores valid LO-EV evidence with reproducible hashes", async () => {
    const response = await app.inject({
      method: "POST", url: "/api/operator/evidence", headers: ownerHeaders,
      payload: { jobId, kernelId, evidence: evidence() },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ stored: true, jobId, hashModel: "event_bundle_hash", eventsStored: 2 });
    const rows = getRepos().evidence.findEventsByBundle(body.bundleId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.hash).toBe(await hashEvent({ type: row.type, timestamp: row.timestamp, source: row.source, payload: row.payload } as Omit<EvidenceEvent, "hash" | "id">));
    }
    const expectedHash = await hashBundle(rows as unknown as EvidenceEvent[]);
    expect(body.contentHash).toBe(expectedHash);
    expect(getRepos().evidence.findById(body.bundleId)).toMatchObject({ jobId, kernelId, bundleHash: expectedHash });
  });

  it("P5: the operator's session key receives a signed receipt and consumes its challenge", async () => {
    const payload = await issuedPackage();
    expect(challenge()?.state).toBe("issued");
    const response = await app.inject({
      method: "POST", url: `/api/operator/jobs/${jobId}/receipt`, headers: ownerHeaders, payload,
    });
    expect(response.statusCode, response.body).toBe(200);
    const stored = response.json();
    expect(Object.keys(stored).sort()).toEqual(["kid", "receipt", "receiptDigest", "signatureHex"]);
    expect(stored.receipt).toMatchObject({ chainId: 8453, escrow: ESCROW, settlementUnitId: H("1"), receivedAt: expect.any(Number) });
    expect(stored.kid).toEqual(expect.any(String));
    expect(stored.receiptDigest).toBe(computeGatewayReceiptDigest(stored.receipt));
    expect(stored.signatureHex).toMatch(/^0x[0-9a-f]{128}$/);
    expect(verify(null, Buffer.from(stored.receiptDigest.slice(2), "hex"), receiptKey.publicKey, Buffer.from(stored.signatureHex.slice(2), "hex"))).toBe(true);
    expect(receipts()).toHaveLength(1);
    expect(challenge()?.state).toBe("consumed");
  });

  it("P6: another wallet's session key cannot submit evidence or store anything for the job", async () => {
    expect(getRepos().evidence.findByJob(jobId)).toHaveLength(0);
    const response = await app.inject({
      method: "POST", url: "/api/operator/evidence", headers: foreignHeaders,
      payload: { jobId, kernelId, evidence: evidence() },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toEqual({ error: "forbidden", reason: "operator_proof_required", message: expect.any(String) });
    expect(getRepos().evidence.findByJob(jobId)).toHaveLength(0);
  });

  it("P7: another wallet's session key cannot mint a receipt or consume the issued challenge", async () => {
    const payload = await issuedPackage();
    expect(challenge()?.state).toBe("issued");
    const before = challenges();
    expect(receipts()).toHaveLength(0);
    const response = await app.inject({
      method: "POST", url: `/api/operator/jobs/${jobId}/receipt`, headers: foreignHeaders, payload,
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toEqual({ error: "forbidden", reason: "operator_proof_required", message: expect.any(String) });
    expect(receipts()).toHaveLength(0);
    expect(challenges()).toEqual(before);
    expect(challenge()?.state).toBe("issued");
  });
});
