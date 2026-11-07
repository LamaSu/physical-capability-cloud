import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { privateKeyToAccount } from "viem/accounts";
import { eq, schema, sql } from "@pcc/store";
import { getRepos, getStore } from "../db.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { computePackageBodyHash, PACKAGE_FORMAT, PACKAGE_SCHEMA_VERSION, type FinalMilestonePackageV2Body, type Hex } from "../settlement/final-milestone-package-v2.js";
import { computeGatewayReceiptDigest } from "../settlement/gateway-receipt.js";
import * as operatorVerifierModule from "../settlement/operator-signature-verifier.js";

// Only existing modules are imported: on the base tree these tests reach the
// real app and fail on the absent HTTP routes, rather than missing modules.
const vectors = JSON.parse(readFileSync(new URL("./fixtures/finalmilestonepackage-v2-d1-eip712.vectors.json", import.meta.url), "utf8"));
const operator = privateKeyToAccount(vectors.keys.operator.privateKey as Hex);
const wrongOperator = privateKeyToAccount(vectors.keys.nonOperator.privateKey as Hex);
const H = (digit: string) => `0x${digit.repeat(64)}` as Hex;
const ADMIN = "receipt-route-test-admin";
const ESCROW = "0x00000000000000000000000000000000000e5c0f" as Hex;
const SEED = "41".repeat(32);
const RECEIPT_SEED = "57".repeat(32);

function key(seed: string) {
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed, "hex")]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const raw = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(12);
  return { privateKey, publicKey, hex: `0x${raw.toString("hex")}`, raw };
}
const device = key(SEED);
const otherDevice = key("42".repeat(32));
const receiptKey = key(RECEIPT_SEED);
const expectedKid = createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${receiptKey.raw.toString("base64url")}"}`).digest("base64url");
const TYPES = {
  FinalMilestonePackageV2: [
    { name: "chainId", type: "uint256" }, { name: "escrow", type: "address" },
    { name: "settlementUnitId", type: "bytes32" }, { name: "jobIdHash", type: "bytes32" },
    { name: "milestoneIndex", type: "uint256" }, { name: "stepId", type: "bytes32" },
    { name: "compositionRoot", type: "bytes32" }, { name: "acceptedEnvelopeHash", type: "bytes32" },
    { name: "packageBodyHash", type: "bytes32" },
  ],
} as const;

describe("durable settlement receipts through the gateway app", () => {
  let app: FastifyInstance;
  let jobId: string;
  let otherJobId: string;
  let kernelId: string;
  let bearer: string;
  let basicBearer: string;
  let contributorBearer: string;
  let now: number;
  const envNames = ["PCC_DB_PATH", "DATABASE_URL", "RAILWAY_VOLUME_MOUNT_PATH", "PCC_SEED_DATA", "PCC_ADMIN_KEY", "PCC_GATEWAY_RECEIPT_SEED", "PCC_GATEWAY_RECEIPT_VALID_FROM"] as const;
  const savedEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  const adminHeaders = () => ({ "x-admin-key": ADMIN, authorization: `Bearer ${bearer}` });
  const basicHeaders = () => ({ authorization: `Bearer ${basicBearer}` });
  const url = (id = jobId) => `/api/operator/jobs/${id}/receipt`;
  const unit = () => ({ chainId: "8453", escrow: ESCROW, settlementUnitId: H("1"), jobIdHash: H("2"), milestoneIndex: "0", stepId: H("3"), compositionRoot: H("4"), acceptedEnvelopeHash: H("5") });
  const db = () => getStore().db;
  const receipts = () => db().all(sql`SELECT * FROM gateway_receipts`);
  const challenge = () => db().get(sql`SELECT * FROM settlement_challenges ORDER BY issued_at DESC LIMIT 1`) as { state: string; nonce: string; t_challenge_ref: string; expires_at: number } | undefined;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    process.env.PCC_SEED_DATA = "true";
    process.env.PCC_ADMIN_KEY = ADMIN;
    delete process.env.DATABASE_URL;
    delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
    const { createGateway } = await import("../server.js");
    ({ app } = await createGateway(0));
    // Simulate an already proven wallet only for the verifier's extra caller
    // binding test; ordinary route tests authenticate with the admin secret.
    app.addHook("onRequest", async (req) => {
      const wallet = req.headers["x-test-proven-wallet"];
      if (typeof wallet === "string") {
        req.provenWallet = wallet;
        req.provenWalletCarrier = "key";
      }
      if (req.headers["x-test-duplicate-admin"] === "true") req.raw.rawHeaders.push("X-Admin-Key", ADMIN);
    });
    await app.ready();
    const jobs = getRepos().jobs.findAll().filter((job) => job.kernelId);
    expect(jobs.length).toBeGreaterThan(1);
    jobId = jobs[0].id;
    otherJobId = jobs[1].id;
    kernelId = jobs[0].kernelId!;
    bearer = provisionApiKey({ operatorId: operator.address.toLowerCase(), name: "Receipt test credential", scopes: ["*"] }).rawKey;
    basicBearer = provisionApiKey({ operatorId: operator.address.toLowerCase(), name: "Basic operator receipt credential", scopes: ["operator:basic"] }).rawKey;
    contributorBearer = provisionApiKey({ operatorId: operator.address.toLowerCase(), name: "Contributor receipt credential", scopes: ["contributor:read"] }).rawKey;
  }, 120_000);

  beforeEach(() => {
    now = Math.floor(Date.now() / 1000);
    vi.spyOn(Date, "now").mockImplementation(() => now * 1000);
    process.env.PCC_ADMIN_KEY = ADMIN;
    process.env.PCC_GATEWAY_RECEIPT_SEED = RECEIPT_SEED;
    process.env.PCC_GATEWAY_RECEIPT_VALID_FROM = "0";
    for (const table of ["gateway_receipts", "settlement_challenges"]) {
      if (db().get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`)) db().run(sql.raw(`DELETE FROM ${table}`));
    }
    db().run(sql`UPDATE shop_kernels SET operator_address = ${operator.address.toLowerCase()}, signing_key_algorithm = 'ed25519', signing_key_public_key = ${device.hex}, signing_address = NULL WHERE id = ${kernelId}`);
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await app?.close();
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  async function issue(overrides: Record<string, unknown> = {}, headers = adminHeaders()) {
    return app.inject({ method: "POST", url: "/api/admin/settlement-challenges", headers, payload: { jobId, chainId: "8453", escrow: ESCROW, settlementUnitId: H("1"), ...overrides } });
  }
  async function issued() {
    const result = await issue();
    expect(result.statusCode).toBe(200);
    return result.json<{ nonce: Hex; tChallengeRef: string; expiresAt: number }>();
  }
  async function envelope(binding: { nonce: Hex; tChallengeRef: string }, options: { kernel?: string; evidence?: Hex; d1?: typeof operator; d2?: typeof device; chainId?: string; brokenD2?: boolean } = {}) {
    const signingDevice = options.d2 ?? device;
    const body: FinalMilestonePackageV2Body = {
      packageSchemaVersion: PACKAGE_SCHEMA_VERSION, packageFormat: PACKAGE_FORMAT, compositionSchemaVersion: "1",
      unitBinding: { ...unit(), chainId: options.chainId ?? "8453" },
      producer: { kernelId: options.kernel ?? kernelId, operatorPrincipalId: `eip155:${options.chainId ?? "8453"}:${operator.address.toLowerCase()}`, devicePrincipalId: `ed25519:${signingDevice.hex}` },
      challengeBinding: { nonce: binding.nonce, tChallengeRef: binding.tChallengeRef },
      evidence: { evidenceBlockHash: options.evidence ?? H("7") }, evidenceTimeBounds: { start: "1700000000", end: "1700000100" },
    };
    const hash = computePackageBodyHash(body);
    const d1Account = options.d1 ?? operator;
    const signatures = [
      { signer: operator.address.toLowerCase(), scheme: "secp256k1-eip712", sig: (await d1Account.signTypedData({ domain: { name: "PCC FinalMilestonePackage", version: "2", chainId: BigInt(body.unitBinding.chainId), verifyingContract: ESCROW }, types: TYPES, primaryType: "FinalMilestonePackageV2", message: { ...body.unitBinding, chainId: BigInt(body.unitBinding.chainId), milestoneIndex: 0n, packageBodyHash: hash } })).toLowerCase() },
      { signer: signingDevice.hex, scheme: "ed25519-raw32", sig: `0x${sign(null, Buffer.from(hash.slice(2), "hex"), options.brokenD2 ? otherDevice.privateKey : signingDevice.privateKey).toString("hex")}` },
    ];
    return { packageEnvelope: { body, signatures } };
  }
  const post = (payload: unknown, headers = adminHeaders(), id = jobId) => app.inject({ method: "POST", url: url(id), headers, payload: payload as Record<string, unknown> });
  async function expectRefused(payload: unknown, error: string, status = 422) {
    const result = await post(payload);
    expect(result.statusCode).toBe(status);
    expect(result.json().error).toBe(error);
    expect(receipts()).toHaveLength(0);
  }
  async function withEarlierRegisteredKernel(test: () => Promise<void>) {
    const savedKernel = db().select().from(schema.shopKernels).where(eq(schema.shopKernels.id, kernelId)).get()!;
    const earlierKernelId = "receipt-route-earlier-kernel";
    // Reinsert the job's kernel after the competing row, preserving its job/device references.
    db().run(sql`PRAGMA foreign_keys = OFF`);
    try {
      db().run(sql`DELETE FROM shop_kernels WHERE id = ${kernelId}`);
      db().insert(schema.shopKernels).values({ ...savedKernel, id: earlierKernelId, signingKeyPublicKey: otherDevice.hex }).run();
    } finally {
      try {
        db().insert(schema.shopKernels).values(savedKernel).run();
      } finally {
        db().run(sql`PRAGMA foreign_keys = ON`);
      }
    }
    try {
      await test();
    } finally {
      db().run(sql`DELETE FROM shop_kernels WHERE id = ${earlierKernelId}`);
    }
  }

  it("issues a real signed receipt and atomically consumes the issued challenge", async () => {
    const binding = await issued();
    const response = await post(await envelope(binding));
    expect(response.statusCode).toBe(200);
    const stored = response.json();
    expect(Object.keys(stored).sort()).toEqual(["kid", "receipt", "receiptDigest", "signatureHex"]);
    expect(stored.kid).toBe(expectedKid);
    expect(stored.receipt.receivedAt).toBe(now);
    expect(stored.receipt.chainId).toBe(8453);
    expect(stored.receipt.escrow).toBe(ESCROW);
    expect(stored.receiptDigest).toBe(computeGatewayReceiptDigest(stored.receipt));
    expect(stored.signatureHex).toMatch(/^0x[0-9a-f]{128}$/);
    expect(verify(null, Buffer.from(stored.receiptDigest.slice(2), "hex"), receiptKey.publicKey, Buffer.from(stored.signatureHex.slice(2), "hex"))).toBe(true);
    expect(challenge()?.state).toBe("consumed");
    expect(receipts()).toHaveLength(1);
    expect(response.body).not.toContain(RECEIPT_SEED);
  });

  it("returns the identical stored receipt after the clock advances", async () => {
    const payload = await envelope(await issued());
    const first = await post(payload);
    expect(first.statusCode).toBe(200);
    now += 180;
    const second = await post(payload);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(receipts()).toHaveLength(1);
  });

  it("refuses to overwrite a receipt with a different package digest", async () => {
    const binding = await issued();
    const first = await post(await envelope(binding));
    expect(first.statusCode).toBe(200);
    const second = await post(await envelope(binding, { evidence: H("8") }));
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("receipt_exists");
    const read = await app.inject({ method: "GET", url: url(), headers: adminHeaders() });
    expect(read.json()).toEqual(first.json());
    expect(receipts()).toHaveLength(1);
  });

  it.each(["missing proven key", "different registered key", "secp256k1 only"])("refuses a registry with %s without consuming the challenge", async (variant) => {
    const binding = await issued();
    if (variant === "missing proven key") db().run(sql`UPDATE shop_kernels SET signing_key_algorithm = NULL, signing_key_public_key = NULL WHERE id = ${kernelId}`);
    if (variant === "different registered key") db().run(sql`UPDATE shop_kernels SET signing_key_public_key = ${otherDevice.hex} WHERE id = ${kernelId}`);
    if (variant === "secp256k1 only") db().run(sql`UPDATE shop_kernels SET signing_key_algorithm = 'secp256k1', signing_key_public_key = NULL, signing_address = ${operator.address.toLowerCase()} WHERE id = ${kernelId}`);
    await expectRefused(await envelope(binding), "package_registry_refused");
    expect(challenge()?.state).toBe("issued");
  });

  it("refuses another kernel's earlier registered device key and accepts the job kernel's key", async () => {
    await withEarlierRegisteredKernel(async () => {
      const binding = await issued();
      await expectRefused(await envelope(binding, { d2: otherDevice }), "package_registry_refused");
      expect(challenge()?.state).toBe("issued");

      const accepted = await post(await envelope(binding));
      expect(accepted.statusCode).toBe(200);
      expect(receipts()).toHaveLength(1);
      expect(challenge()?.state).toBe("consumed");
    });
  });

  it("refuses another kernel's key when the job kernel has no proven signer", async () => {
    await withEarlierRegisteredKernel(async () => {
      const binding = await issued();
      db().run(sql`UPDATE shop_kernels SET signing_key_algorithm = NULL, signing_key_public_key = NULL WHERE id = ${kernelId}`);
      await expectRefused(await envelope(binding, { d2: otherDevice }), "package_registry_refused");
      expect(challenge()?.state).toBe("issued");
    });
  });

  it.each([
    ["no algorithm", null],
    ["secp256k1 algorithm", "secp256k1"],
  ] as const)("refuses an Ed25519 public key registered with %s", async (_name, algorithm) => {
    const binding = await issued();
    const address = algorithm === "secp256k1" ? operator.address.toLowerCase() : null;
    db().run(sql`UPDATE shop_kernels SET signing_key_algorithm = ${algorithm}, signing_key_public_key = ${device.hex}, signing_address = ${address} WHERE id = ${kernelId}`);
    await expectRefused(await envelope(binding), "package_registry_refused");
    expect(challenge()?.state).toBe("issued");
  });

  it("refuses a D2 signer different from the proven registry device", async () => {
    const binding = await issued();
    await expectRefused(await envelope(binding, { d2: otherDevice }), "package_registry_refused");
    expect(challenge()?.state).toBe("issued");
  });

  it("refuses when the job's kernel registry row no longer exists", async () => {
    const binding = await issued();
    const payload = await envelope(binding);
    const savedKernel = db().select().from(schema.shopKernels).where(eq(schema.shopKernels.id, kernelId)).get()!;
    db().run(sql`PRAGMA foreign_keys = OFF`);
    try {
      db().run(sql`DELETE FROM shop_kernels WHERE id = ${kernelId}`);
      await expectRefused(payload, "package_registry_refused");
      expect(challenge()?.state).toBe("issued");
    } finally {
      db().insert(schema.shopKernels).values(savedKernel).run();
      db().run(sql`PRAGMA foreign_keys = ON`);
    }
  });

  it("refuses a D2 signature made by another device under the registered signer label", async () => {
    const binding = await issued();
    await expectRefused(await envelope(binding, { brokenD2: true }), "invalid_package_signatures");
    expect(challenge()?.state).toBe("issued");
  });

  it("refuses a package with no issued challenge", async () => {
    await expectRefused(await envelope({ nonce: H("6"), tChallengeRef: "gateway-challenge-absent" }), "package_challenge_refused");
  });

  it.each(["nonce", "tChallengeRef"] as const)("refuses a challenge with a mismatched %s", async (field) => {
    const binding = await issued();
    const mismatched = { ...binding, [field]: field === "nonce" ? H("f") : "another-challenge-reference" };
    await expectRefused(await envelope(mismatched), "package_challenge_refused");
    expect(challenge()?.state).toBe("issued");
  });

  it("refuses an expired challenge", async () => {
    const binding = await issued();
    db().run(sql`UPDATE settlement_challenges SET expires_at = ${now - 1}`);
    await expectRefused(await envelope(binding), "package_challenge_refused");
    expect(challenge()?.state).toBe("issued");
  });

  it("refuses a challenge issued for a different job", async () => {
    const response = await issue({ jobId: otherJobId });
    expect(response.statusCode).toBe(200);
    await expectRefused(await envelope(response.json()), "package_challenge_refused");
    expect(challenge()?.state).toBe("issued");
  });

  it("refuses a consumed challenge even after a new package and no stored receipt", async () => {
    const binding = await issued();
    const first = await post(await envelope(binding));
    expect(first.statusCode).toBe(200);
    db().run(sql`DELETE FROM gateway_receipts`);
    await expectRefused(await envelope(binding, { evidence: H("8") }), "package_challenge_refused");
  });

  it("concurrent first posts persist exactly one receipt", async () => {
    const payload = await envelope(await issued());
    const responses = await Promise.all([post(payload), post(payload)]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(responses[0].json()).toEqual(responses[1].json());
    expect(receipts()).toHaveLength(1);
    expect(challenge()?.state).toBe("consumed");
  });

  it("concurrent different packages return one receipt and one conflict from the stored winner", async () => {
    const binding = await issued();
    const firstPackage = await envelope(binding);
    const secondPackage = await envelope(binding, { evidence: H("8") });
    const realFactory = operatorVerifierModule.createEip712OperatorVerifier;
    let releaseFirst!: () => void;
    const firstLookupGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let lookups = 0;
    const factory = vi.spyOn(operatorVerifierModule, "createEip712OperatorVerifier").mockImplementation((deps) => realFactory({
      ...deps,
      async operatorForUnit(unitBinding, options) {
        // Hold the first request after its pre-check until the competing receipt is stored.
        if (++lookups === 1) await firstLookupGate;
        return deps.operatorForUnit(unitBinding, options);
      },
    }));
    const responses = await Promise.all([
      Promise.resolve(post(firstPackage)).finally(releaseFirst),
      Promise.resolve(post(secondPackage)).finally(releaseFirst),
    ]);
    // Both factories/lookup calls prove the loser passed the pre-check and read an issued challenge.
    expect(factory).toHaveBeenCalledTimes(2);
    expect(lookups).toBe(2);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const winner = responses.find((response) => response.statusCode === 200)!;
    const loser = responses.find((response) => response.statusCode === 409)!;
    expect(loser.json()).toEqual({ error: "receipt_exists" });
    const rows = db().select().from(schema.gatewayReceipts).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].packageDigest).toBe(winner.json().receipt.packageDigest);
    expect(challenge()?.state).toBe("consumed");
    const read = await app.inject({ method: "GET", url: url(), headers: adminHeaders() });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(winner.json());
  });

  it.each(["missing seed", "future validFrom"])("refuses an unavailable signer (%s) before burning the challenge", async (variant) => {
    const binding = await issued();
    if (variant === "missing seed") delete process.env.PCC_GATEWAY_RECEIPT_SEED;
    else process.env.PCC_GATEWAY_RECEIPT_VALID_FROM = String(now + 60);
    await expectRefused(await envelope(binding), "receipt_signer_unavailable", 503);
    expect(challenge()?.state).toBe("issued");
  });

  it("refuses a malformed package body with a stable code", async () => {
    await expectRefused({ packageEnvelope: { body: { rejectedSecret: "should-never-echo" }, signatures: [] } }, "invalid_package_body", 400);
  });

  it("refuses a package produced by a different kernel", async () => {
    const binding = await issued();
    await expectRefused(await envelope(binding, { kernel: "kernel-other" }), "kernel_mismatch", 409);
    expect(challenge()?.state).toBe("issued");
  });

  it("refuses D1 signed by the wrong operator without consuming the challenge", async () => {
    const binding = await issued();
    await expectRefused(await envelope(binding, { d1: wrongOperator }), "package_operator_refused");
    expect(challenge()?.state).toBe("issued");
  });

  it("also binds an already proven caller wallet to the registry operator", async () => {
    const binding = await issued();
    const result = await post(await envelope(binding), { ...adminHeaders(), "x-test-proven-wallet": wrongOperator.address.toLowerCase() });
    expect(result.statusCode).toBe(422);
    expect(result.json().error).toBe("package_operator_refused");
    expect(receipts()).toHaveLength(0);
    expect(challenge()?.state).toBe("issued");
  });

  it("rejects an unsafe chain id before consuming a challenge", async () => {
    const binding = await issued();
    await expectRefused(await envelope(binding, { chainId: "9007199254740992" }), "invalid_settlement_unit", 400);
    expect(challenge()?.state).toBe("issued");
  });

  it.each(["POST", "GET"] as const)("%s returns the stable unknown-job refusal", async (method) => {
    const result = await app.inject({ method, url: url("job-absent"), headers: adminHeaders(), ...(method === "POST" ? { payload: {} } : {}) });
    expect(result.statusCode).toBe(404);
    expect(result.json().error).toBe("job_not_found");
  });

  it("GET before a receipt exists returns the stable receipt-not-found refusal", async () => {
    const result = await app.inject({ method: "GET", url: url(), headers: adminHeaders() });
    expect(result.statusCode).toBe(404);
    expect(result.json().error).toBe("receipt_not_found");
  });

  it("GET returns the identical stored body and never needs a signer", async () => {
    const first = await post(await envelope(await issued()));
    expect(first.statusCode).toBe(200);
    delete process.env.PCC_GATEWAY_RECEIPT_SEED;
    now += 360;
    const result = await app.inject({ method: "GET", url: url(), headers: adminHeaders() });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual(first.json());
  });

  it("POST lets a basic operator key reach the kernel refusal without writing a receipt or changing challenges", async () => {
    const payload = await envelope(await issued());
    const challengesBefore = db().all(sql`SELECT * FROM settlement_challenges`);
    expect(challenge()?.state).toBe("issued");
    const result = await post(payload, basicHeaders());
    expect(result.statusCode).toBe(403);
    expect(result.json()).toEqual({ error: "forbidden", reason: "operator_proof_required", message: expect.any(String) });
    expect(receipts()).toHaveLength(0);
    expect(db().all(sql`SELECT * FROM settlement_challenges`)).toEqual(challengesBefore);
  });

  it("GET lets the same basic operator key reach the kernel refusal for a stored receipt", async () => {
    const minted = await post(await envelope(await issued()));
    expect(minted.statusCode).toBe(200);
    const result = await app.inject({ method: "GET", url: url(), headers: basicHeaders() });
    expect(result.statusCode).toBe(403);
    expect(result.json()).toEqual({ error: "forbidden", reason: "operator_proof_required", message: expect.any(String) });
  });

  it.each(["POST", "GET"] as const)("%s refuses a key without operator scopes at the scope layer", async (method) => {
    const result = await app.inject({ method, url: url(), headers: { authorization: `Bearer ${contributorBearer}` }, ...(method === "POST" ? { payload: {} } : {}) });
    expect(result.statusCode).toBe(403);
    expect(result.json().error).toBe("insufficient_scope");
  });

  it("a key provisioned with a claimed operator wallet cannot POST or GET receipts", async () => {
    const provisioned = await app.inject({ method: "POST", url: "/api/auth/provision", remoteAddress: "192.0.2.99", payload: { walletAddress: operator.address.toLowerCase(), name: "Claimed operator" } });
    expect(provisioned.statusCode).toBe(201);
    const headers = { authorization: `Bearer ${provisioned.json().api_key}` };
    const write = await post({}, headers);
    expect(write.statusCode).toBe(403);
    const read = await app.inject({ method: "GET", url: url(), headers });
    expect(read.statusCode).toBe(403);
    expect(receipts()).toHaveLength(0);
  });

  it("accepts the admin secret alone for challenge issue and DECIDE receipt access", async () => {
    // The base tree reaches its absent issuer with ordinary API authentication.
    expect((await issue()).statusCode).toBe(200);
    const result = await issue({}, { "x-admin-key": ADMIN } as ReturnType<typeof adminHeaders>);
    expect(result.statusCode).toBe(200);
    const minted = await post(await envelope(result.json()), { "x-admin-key": ADMIN } as ReturnType<typeof adminHeaders>);
    expect(minted.statusCode).toBe(200);
    const read = await app.inject({ method: "GET", url: url(), headers: { "x-admin-key": ADMIN } });
    expect(read.json()).toEqual(minted.json());
  });

  it.each(["absent", "stored"] as const)("E2: HEAD with the admin secret alone matches GET when the receipt is %s", async (state) => {
    if (state === "stored") {
      const minted = await post(await envelope(await issued()));
      expect(minted.statusCode).toBe(200);
    }
    const headers = { "x-admin-key": ADMIN };
    const read = await app.inject({ method: "GET", url: url(), headers });
    const head = await app.inject({ method: "HEAD", url: url(), headers });
    expect(read.statusCode).toBe(state === "stored" ? 200 : 404);
    expect(head.statusCode).toBe(read.statusCode);
    expect(head.statusCode).not.toBe(401);
    expect(head.body).toBe("");
  });

  it.each(["/api/operator/jobs", "/api/admin/demand/status"])("E3: the admin secret alone cannot authenticate GET %s", async (path) => {
    const result = await app.inject({ method: "GET", url: path, headers: { "x-admin-key": ADMIN } });
    expect(result.statusCode).toBe(401);
    expect(result.json().error).toBe("api_key_required");
  });

  it("the issuer creates a gateway nonce and reference with a 24 hour default TTL", async () => {
    const binding = await issued();
    expect(binding.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(binding.tChallengeRef).toEqual(expect.any(String));
    expect(binding.tChallengeRef.length).toBeGreaterThan(0);
    expect(binding.expiresAt).toBe(now + 24 * 60 * 60);
    expect(challenge()?.state).toBe("issued");
  });

  it("repeat issuance for the same open unit returns the identical challenge", async () => {
    const first = await issued();
    now += 90;
    const second = await issued();
    expect(second).toEqual(first);
    expect(db().all(sql`SELECT * FROM settlement_challenges`)).toHaveLength(1);
  });

  it("a different job cannot take the same settlement unit", async () => {
    await issued();
    const result = await issue({ jobId: otherJobId });
    expect(result.statusCode).toBe(409);
    expect(result.json().error).toBe("challenge_exists");
    expect(db().all(sql`SELECT * FROM settlement_challenges`)).toHaveLength(1);
  });

  it("a consumed challenge can be replaced with a fresh issued one for the same job", async () => {
    const first = await issued();
    const minted = await post(await envelope(first));
    expect(minted.statusCode).toBe(200);
    const second = await issued();
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.tChallengeRef).not.toBe(first.tChallengeRef);
    expect(db().all(sql`SELECT * FROM settlement_challenges WHERE state = 'issued'`)).toHaveLength(1);
  });

  it("an expired challenge is replaced with a fresh issued challenge for the same job", async () => {
    const first = await issued();
    now = first.expiresAt;
    const second = await issued();
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.tChallengeRef).not.toBe(first.tChallengeRef);
    expect(second.expiresAt).toBe(now + 86400);
    expect(db().all(sql`SELECT * FROM settlement_challenges WHERE state = 'issued'`)).toHaveLength(1);
    expect(db().all(sql`SELECT * FROM settlement_challenges WHERE state = 'consumed'`)).toHaveLength(1);
  });

  it("issuer refuses an admin-scoped API key without the admin secret", async () => {
    const key = provisionApiKey({ operatorId: "receipt-admin-scope-caller", name: "Administrative scope only", scopes: ["admin"] }).rawKey;
    const result = await issue({}, { authorization: `Bearer ${key}` } as ReturnType<typeof adminHeaders>);
    expect(result.statusCode).toBe(403);
    expect(result.json().error).toBe("admin_required");
    expect(db().all(sql`SELECT * FROM settlement_challenges`)).toHaveLength(0);
  });

  it("issuer refuses an anonymous caller through the API gate without writing a challenge", async () => {
    // First reach the authenticated route, so the base tree fails on its absent
    // issuer instead of accidentally testing an unrelated authentication gate.
    expect((await issue()).statusCode).toBe(200);
    db().run(sql`DELETE FROM settlement_challenges`);
    const result = await issue({}, {} as ReturnType<typeof adminHeaders>);
    expect(result.statusCode).toBe(401);
    expect(result.json().error).toBe("api_key_required");
    expect(db().all(sql`SELECT * FROM settlement_challenges`)).toHaveLength(0);
  });

  it.each(["no admin header", "wrong admin header", "wildcard scoped API key", "unset admin secret"])("issuer refuses %s without writing a challenge", async (variant) => {
    let headers: Record<string, string> = { authorization: `Bearer ${bearer}` };
    if (variant === "wrong admin header") headers["x-admin-key"] = "incorrect-admin-secret";
    if (variant === "unset admin secret") {
      delete process.env.PCC_ADMIN_KEY;
      headers["x-admin-key"] = ADMIN;
    }
    const result = await issue({}, headers as ReturnType<typeof adminHeaders>);
    expect(result.statusCode).toBe(403);
    expect(result.json().error).toBe("admin_required");
    expect(db().all(sql`SELECT * FROM settlement_challenges`)).toHaveLength(0);
  });

  it("issuer refuses a duplicated admin field even when its joined value equals the secret", async () => {
    // light-my-request collapses repeated fields. The probe hook adds the second
    // raw field after API authentication, before the issuer's strict admin gate.
    process.env.PCC_ADMIN_KEY = `${ADMIN}, ${ADMIN}`;
    const result = await app.inject({ method: "POST", url: "/api/admin/settlement-challenges", headers: { authorization: `Bearer ${bearer}`, "x-admin-key": process.env.PCC_ADMIN_KEY, "x-test-duplicate-admin": "true" }, payload: { jobId, chainId: "8453", escrow: ESCROW, settlementUnitId: H("1") } });
    expect(result.statusCode).toBe(403);
    expect(result.json().error).toBe("admin_required");
    expect(db().all(sql`SELECT * FROM settlement_challenges`)).toHaveLength(0);
  });

  it.each([
    ["missing job", { jobId: "job-absent" }, 404, "job_not_found"],
    ["zero chain", { chainId: "0" }, 400, "invalid_challenge_request"],
    ["unsafe chain", { chainId: "9007199254740992" }, 400, "invalid_challenge_request"],
    ["malformed escrow", { escrow: "0xabc" }, 400, "invalid_challenge_request"],
    ["malformed unit", { settlementUnitId: "0xabc" }, 400, "invalid_challenge_request"],
    ["zero TTL", { ttlSeconds: 0 }, 400, "invalid_challenge_request"],
    ["fractional TTL", { ttlSeconds: 1.5 }, 400, "invalid_challenge_request"],
    ["overlong TTL", { ttlSeconds: 604801 }, 400, "invalid_challenge_request"],
  ])("issuer rejects %s", async (_name, overrides, status, error) => {
    const result = await issue(overrides as Record<string, unknown>);
    expect(result.statusCode).toBe(status);
    expect(result.json().error).toBe(error);
    expect(db().all(sql`SELECT * FROM settlement_challenges`)).toHaveLength(0);
  });

  it("issuer accepts the seven day maximum TTL", async () => {
    const result = await issue({ ttlSeconds: 604800 });
    expect(result.statusCode).toBe(200);
    expect(result.json().expiresAt).toBe(now + 604800);
  });
});
