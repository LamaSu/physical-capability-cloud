/**
 * N46 authority layer on WP-A (steward #3906: "the authority layer rides WP-A";
 * operator item 57, option a: the gateway pays only within bounded, scoped
 * authority). Two paths that make the gateway's key act had no owner:
 *
 *   - POST /api/protocol/create-escrow: ANY authenticated key made the gateway
 *     signer create an escrow with a caller-chosen payer, arbiter and token (gas
 *     plus on-chain state). No user flow needs it, so it is now the admin's.
 *   - PUT /api/jobs/:jobId/complete and POST /api/jobs/:jobId/resume-settlement:
 *     ANY authenticated key that knew a jobId completed the job (evidence,
 *     settlement, milestone release) or resumed its settlement. They are now the
 *     job's operator's (the owner of the job's kernel) or the admin's.
 *
 * Reproduced at 81e061f1 before any code changed. The file imports only modules
 * that exist there.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const protocol = vi.hoisted(() => ({ creates: 0 }));

vi.mock("../contracts/protocol-client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isWriteEnabled: () => true,
  getProtocolAddress: () => "0x00000000000000000000000000000000000000c1",
  createEscrowViaProtocol: async () => {
    protocol.creates += 1;
    return { escrowAddress: "0x00000000000000000000000000000000000000e5", transactionHash: "0xtest" };
  },
}));

vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: async () => ({
    init: async () => undefined,
    isReady: () => true,
    archiveBundle: async () => ({ cid: "bafytest", metadataCid: "bafymeta" }),
    archiveEncryptedBundle: async () => ({ cid: "bafyenc", metadataCid: "bafyencmeta" }),
    retrieveBundle: async () => ({}),
    stop: async () => undefined,
  }),
}));

const ADMIN_SECRET = "n46-authority-test-admin-secret";
const OWNER = "n46-kernel-owner@x.test";
const STRANGER = "n46-stranger@x.test";
const savedAdmin = process.env.PCC_ADMIN_KEY;

let app: FastifyInstance;
let getRepos: typeof import("../db.js").getRepos;
let ownerKey = "";
let strangerKey = "";
let seq = 0;
let ipSeq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
const KERNEL = `kernel-n46-authority-${Date.now().toString(36)}`;

const call = (method: string, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({
    method: method as never,
    url,
    remoteAddress: `10.146.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
    headers,
    payload: payload as never,
  });
const asKey = (k: string) => ({ authorization: `Bearer ${k}` });
const asAdmin = () => ({ authorization: `Bearer ${strangerKey}`, "x-admin-key": ADMIN_SECRET });

/** A job on OWNER's kernel, in the state the completion claim accepts. */
function newJob(status = "in_progress"): string {
  const id = uid("job-n46");
  insertJob(id, KERNEL, status);
  return id;
}
function insertJob(id: string, kernelId: string, status = "in_progress"): void {
  const capabilityId = `cap-${kernelId}-n46`;
  if (!getRepos().capabilities.findById(capabilityId)) {
    getRepos().capabilities.insert({
      id: capabilityId,
      kernelId,
      type: "n46-test",
      name: "N46 test capability",
      materials: [],
      assuranceTiers: [0],
      pricing: { currency: "USDC", baseCost: "10", minimum: "5" },
      availability: {},
      location: { lat: 0, lng: 0 },
    } as never);
  }
  getRepos().jobs.insert({
    id,
    stepId: `step-${id}`,
    cwmId: `cwm-${id}`,
    capabilityId,
    kernelId,
    status,
    assignedDevices: [],
    startedAt: new Date().toISOString(),
    progress: 0,
    assuranceTier: 0,
  } as never);
}
const jobStatus = (id: string) => getRepos().jobs.findById(id)?.status;

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ADMIN_SECRET;
  const db = await import("../db.js");
  db.initStore({ seed: false });
  getRepos = db.getRepos;
  const { provisionApiKey } = await import("../auth/api-key-auth.js");
  ownerKey = provisionApiKey({ operatorId: OWNER, scopes: ["operator"] }).rawKey;
  strangerKey = provisionApiKey({ operatorId: STRANGER, scopes: ["operator"] }).rawKey;
  const { getKernelFacade } = await import("../facades/index.js");
  const reg = await getKernelFacade().register({ id: KERNEL, name: "N46 authority kernel" }, OWNER);
  expect(reg.success).toBe(true);
  const { apiGate } = await import("../middleware/api-gate.js");
  const { paidJobFlowRoutes } = await import("../routes/paid-job-flow.js");
  const { pccProtocolRoutes } = await import("../routes/pcc-protocol.js");
  app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(paidJobFlowRoutes);
  await app.register(pccProtocolRoutes);
  await app.ready();
});

beforeEach(() => {
  protocol.creates = 0;
});

afterAll(async () => {
  await app?.close();
  const { closeStore } = await import("../db.js");
  closeStore();
  if (savedAdmin === undefined) delete process.env.PCC_ADMIN_KEY;
  else process.env.PCC_ADMIN_KEY = savedAdmin;
});

const escrowBody = {
  payer: "0x00000000000000000000000000000000000000a1",
  arbiter: "0x00000000000000000000000000000000000000a2",
  token: "0x00000000000000000000000000000000000000a3",
  cwmId: `0x${"ab".repeat(32)}`,
};

describe("N46 authority: the gateway signer creates escrows only for the admin", () => {
  it("[neg] an ordinary API key cannot make the gateway create an escrow", async () => {
    const res = await call("POST", "/api/protocol/create-escrow", asKey(strangerKey), escrowBody);
    expect([401, 403]).toContain(res.statusCode);
    expect(protocol.creates).toBe(0);
  });

  it("[neg] a WRONG admin secret is refused, never downgraded to the key's own rights", async () => {
    const res = await call("POST", "/api/protocol/create-escrow", { ...asKey(strangerKey), "x-admin-key": "wrong" }, escrowBody);
    expect([401, 403]).toContain(res.statusCode);
    expect(protocol.creates).toBe(0);
  });

  it("control: the admin creates one", async () => {
    const res = await call("POST", "/api/protocol/create-escrow", asAdmin(), escrowBody);
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(protocol.creates).toBe(1);
  });
});

describe("N46 authority: only the job's operator (or the admin) completes it or resumes its settlement", () => {
  it("[neg] a stranger cannot complete another operator's job; the job is untouched", async () => {
    const id = newJob();
    const res = await call("PUT", `/api/jobs/${id}/complete`, asKey(strangerKey), {});
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("not_job_operator");
    expect(jobStatus(id)).toBe("in_progress");
  });

  it("[neg] a stranger cannot resume another operator's settlement (a job whose evidence is in)", async () => {
    const id = newJob("evidence_submitted");
    const res = await call("POST", `/api/jobs/${id}/resume-settlement`, asKey(strangerKey), {});
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("not_job_operator");
    expect(jobStatus(id)).toBe("evidence_submitted");
  });

  it("[neg] a job on an UNOWNED kernel is the admin's alone (fail closed)", async () => {
    const unowned = uid("kernel-n46-unowned");
    const { getKernelFacade } = await import("../facades/index.js");
    // Registered with no actor: the zero-address placeholder, owned by nobody.
    expect((await getKernelFacade().register({ id: unowned, name: "unowned" })).success).toBe(true);
    expect(getRepos().kernels.findById(unowned)?.operatorAddress).toBe("0x0000000000000000000000000000000000000000");
    const id = uid("job-n46-unowned");
    insertJob(id, unowned);
    const res = await call("PUT", `/api/jobs/${id}/complete`, asKey(ownerKey), {});
    expect(res.statusCode, res.body).toBe(403);
  });

  it("control: the kernel's owner passes the owner check (under a respelled identity too)", async () => {
    const respelled = provisionApiKey2(` ${OWNER.toUpperCase()} `);
    for (const key of [ownerKey, respelled]) {
      const id = newJob();
      const res = await call("PUT", `/api/jobs/${id}/complete`, asKey(key), {});
      expect(res.statusCode, res.body).not.toBe(403);
      expect(res.statusCode, res.body).not.toBe(401);
    }
  });

  it("control: the admin passes the owner check", async () => {
    const id = newJob();
    const res = await call("PUT", `/api/jobs/${id}/complete`, asAdmin(), {});
    expect(res.statusCode, res.body).not.toBe(403);
    expect(res.statusCode, res.body).not.toBe(401);
  });
});

function provisionApiKey2(operatorId: string): string {
  // A second key for the owner's identity, spelled differently (identity
  // matching is trimmed and case-insensitive).
  const { rawKey, keyHash, keyPrefix } = generateKey();
  getRepos().apiKeys.insert({
    id: uid("n46-owner-key2"),
    keyHash,
    keyPrefix,
    operatorId,
    scopes: JSON.stringify(["operator"]),
    rateLimit: "1000/hour",
    usageCount: "0",
    createdAt: new Date().toISOString(),
  } as never);
  return rawKey;
}
let generateKey: typeof import("../auth/api-key-auth.js").generateApiKey;
beforeAll(async () => {
  ({ generateApiKey: generateKey } = await import("../auth/api-key-auth.js"));
});
