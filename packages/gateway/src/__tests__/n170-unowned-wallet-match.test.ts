import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { schema } from "@pcc/store";
import { closeStore, getStore, initStore } from "../db.js";
import { jobReaderOf, operatedKernelsOf } from "../readmodels/job-execution.js";
import { findOperatorKernels } from "../readmodels/operator-work.js";
import { batchRoutes } from "../routes/batches.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const REAL = "0x1234567890abcdef1234567890abcdef12345678";
const MIXED = "0xaBcDeF1234567890aBcDeF1234567890aBcDeF12";
const NEAR = "0x0000000000000000000000000000000000000001";
const NOW = "2026-10-15T12:00:00.000Z";

function insertKernel(id: string, operatorAddress: string) {
  getStore().db.insert(schema.shopKernels).values({
    id,
    name: id,
    operatorAddress,
    location: { lat: 0, lng: 0 },
    physicalAddress: "1 Test St",
    maxAssuranceTier: 1,
    publicKey: "test-key",
    status: "online",
    registeredAt: NOW,
    lastHeartbeat: NOW,
    version: "1.0.0",
  }).run();
}

function insertBuyerJob(id: string, userAgentId: string) {
  const { db, repos } = getStore();
  // Buyer controls use a placeholder-owned kernel, so ownership cannot grant access.
  repos.capabilities.insert({
    id: `cap-${id}`,
    kernelId: "kernel-zero",
    type: "fdm",
    name: "Test printer",
    materials: [],
    assuranceTiers: [1],
    pricing: { currency: "USDC", baseCost: "1", minimum: "1" },
    availability: {},
    location: { lat: 0, lng: 0 },
  });
  repos.jobs.insert({
    id,
    stepId: `step-${id}`,
    cwmId: `cwm-${id}`,
    capabilityId: `cap-${id}`,
    kernelId: "kernel-zero",
    status: "queued",
    assignedDevices: [],
  });
  db.insert(schema.negotiationSessions).values({
    id: `session-${id}`,
    userAgentId,
    kernelId: "kernel-zero",
    capabilityType: "fdm",
    operatorConstraints: {},
    jobId: id,
    createdAt: NOW,
    expiresAt: NOW,
  }).run();
}

describe("N170: unowned placeholders never match a wallet", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", ":memory:");
    initStore({ seed: false });
    insertKernel("kernel-zero", ZERO);
    insertKernel("kernel-empty", "");
    insertKernel("kernel-padded-zero", `  ${ZERO}  `);
    insertKernel("kernel-padded-upper-zero", `  ${ZERO.toUpperCase()}  `);
    insertKernel("kernel-real", REAL);
    insertKernel("kernel-mixed", `  ${MIXED}  `);
    insertKernel("kernel-near", NEAR);
  });

  afterEach(() => {
    closeStore();
    vi.unstubAllEnvs();
  });

  it("R1: ZERO operates no placeholder-owned kernels", () => {
    expect([...operatedKernelsOf(ZERO, getStore().repos)]).toEqual([]);
  });

  it.each(["", "  ", `  ${ZERO}  `, `  ${ZERO.toUpperCase()}  `])(
    "pin: R1 unowned wallet %j operates no kernels",
    (wallet) => {
      expect([...operatedKernelsOf(wallet, getStore().repos)]).toEqual([]);
    },
  );

  it("R2: ZERO is neither the single-session buyer nor a kernel operator", () => {
    insertBuyerJob("job-zero", ZERO);
    const { db, repos } = getStore();
    const reader = jobReaderOf(ZERO, repos, db);
    expect.soft([...reader.buyerJobs]).toEqual([]);
    expect([...reader.kernels]).toEqual([]);
  });

  it("pin: R2 an empty buyer and wallet grant no access", () => {
    insertBuyerJob("job-empty", "");
    const { db, repos } = getStore();
    const reader = jobReaderOf("", repos, db);
    expect([...reader.buyerJobs]).toEqual([]);
    expect([...reader.kernels]).toEqual([]);
  });

  it("R3: ZERO finds no placeholder-owned operator kernels", () => {
    expect(findOperatorKernels(ZERO, getStore().db)).toEqual([]);
  });

  it("R3b: uppercase ZERO finds no placeholder-owned operator kernels", () => {
    expect(findOperatorKernels("0X" + "0".repeat(40), getStore().db)).toEqual([]);
  });

  it.each(["", "  ", `  ${ZERO}  `, `  ${ZERO.toUpperCase()}  `])(
    "pin: R3 unowned wallet %j finds no operator kernels",
    (wallet) => {
      expect(findOperatorKernels(wallet, getStore().db)).toEqual([]);
    },
  );

  it("pin: P1 a real wallet gets its own kernel through both loaders", () => {
    const { db, repos } = getStore();
    expect.soft([...operatedKernelsOf(REAL, repos)]).toEqual(["kernel-real"]);
    expect(findOperatorKernels(REAL, db).map((k) => k.id)).toEqual(["kernel-real"]);
  });

  it("pin: P2 a real wallet gets its single-session buyer job", () => {
    insertBuyerJob("job-real", REAL);
    const { db, repos } = getStore();
    expect([...jobReaderOf(REAL, repos, db).buyerJobs]).toEqual(["job-real"]);
  });

  it("pin: P3 mixed-case recorded addresses match a lowercase wallet", () => {
    insertBuyerJob("job-mixed", `  ${MIXED}  `);
    const { db, repos } = getStore();
    const wallet = MIXED.toLowerCase();
    expect.soft([...operatedKernelsOf(wallet, repos)]).toEqual(["kernel-mixed"]);
    expect.soft(findOperatorKernels(wallet, db).map((k) => k.id)).toEqual(["kernel-mixed"]);
    expect([...jobReaderOf(wallet, repos, db).buyerJobs]).toEqual(["job-mixed"]);
  });

  it("pin: P4 the near-zero real wallet gets its kernel and single-session buyer job", () => {
    insertBuyerJob("job-near", NEAR);
    const { db, repos } = getStore();
    expect.soft([...operatedKernelsOf(NEAR, repos)]).toEqual(["kernel-near"]);
    expect.soft(findOperatorKernels(NEAR, db).map((k) => k.id)).toEqual(["kernel-near"]);
    expect([...jobReaderOf(NEAR, repos, db).buyerJobs]).toEqual(["job-near"]);
  });

  it("pin: preserves each loader's handling of mixed-case wallet arguments", () => {
    const { db, repos } = getStore();
    expect([...operatedKernelsOf(MIXED, repos)]).toEqual([]);
    expect(findOperatorKernels(MIXED, db).map((k) => k.id)).toEqual(["kernel-mixed"]);
  });

  it("pin: preserves the address shape check", () => {
    insertKernel("kernel-label", "operator@example.com");
    const { db, repos } = getStore();
    expect([...operatedKernelsOf("operator@example.com", repos)]).toEqual([]);
    expect(findOperatorKernels("operator@example.com", db)).toEqual([]);
  });
});

describe("N170 F1: shared-claim release requires an owned claimant", () => {
  const ADMIN = "n170-shared-claim-admin";
  const OTHER = "0x9999999999999999999999999999999999999999";
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv("DATABASE_URL", ":memory:");
    vi.stubEnv("PCC_ADMIN_KEY", ADMIN);
    initStore({ seed: false });
    app = Fastify({ logger: false });
    // Stand in for the API gate's proven wallet without opening a socket.
    app.addHook("onRequest", async (req) => {
      const wallet = req.headers["x-n170-proven-wallet"];
      if (typeof wallet === "string") {
        (req as unknown as { provenWallet: string }).provenWallet = wallet;
      }
    });
    await app.register(batchRoutes);
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    vi.unstubAllEnvs();
  });

  async function adminClaimFor(agentId: string) {
    const created = await app.inject({
      method: "POST",
      url: "/api/batches/shared",
      headers: { "x-admin-key": ADMIN },
      // No caller operates this kernel, so claimant tests exercise only that branch.
      payload: { kernelId: "kernel-n170-claim", capabilityType: "fdm", totalSlots: 4, protocolType: "fdm-test", pricePerSlot: "1" },
    });
    expect(created.statusCode).toBe(200);
    const batchId = created.json().batch.id as string;
    const claimed = await app.inject({
      method: "POST",
      url: `/api/batches/shared/${batchId}/claim`,
      headers: { "x-admin-key": ADMIN },
      payload: { agentId, slotCount: 1, sampleLabels: ["n170-private-sample"] },
    });
    expect(claimed.statusCode).toBe(200);
    const claimId = claimed.json().claim.id as string;
    return `/api/batches/shared/${batchId}/claim/${claimId}`;
  }

  it.each([ZERO, `  ${ZERO}  `])("F1a: ZERO cannot release an unowned claim for %j", async (agentId) => {
    const url = await adminClaimFor(agentId);
    const refused = await app.inject({ method: "DELETE", url, headers: { "x-n170-proven-wallet": ZERO } });
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toEqual({ error: "Claim not found" });

    const released = await app.inject({ method: "DELETE", url, headers: { "x-admin-key": ADMIN } });
    expect(released.statusCode).toBe(200);
    expect(released.json()).toMatchObject({ released: true, claim: { agentId, sampleLabels: ["n170-private-sample"] } });
  });

  it("F1b: a proven real wallet releases its own claim", async () => {
    const url = await adminClaimFor(REAL);
    const released = await app.inject({ method: "DELETE", url, headers: { "x-n170-proven-wallet": REAL } });
    expect(released.statusCode).toBe(200);
    expect(released.json()).toMatchObject({ released: true, claim: { agentId: REAL } });
  });

  it("F1c: a proven near-zero wallet releases its own claim", async () => {
    const url = await adminClaimFor(NEAR);
    const released = await app.inject({ method: "DELETE", url, headers: { "x-n170-proven-wallet": NEAR } });
    expect(released.statusCode).toBe(200);
    expect(released.json()).toMatchObject({ released: true, claim: { agentId: NEAR } });
  });

  it("pin: F1d a different proven real wallet cannot release someone else's claim", async () => {
    const url = await adminClaimFor(REAL);
    const refused = await app.inject({ method: "DELETE", url, headers: { "x-n170-proven-wallet": OTHER } });
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toEqual({ error: "Claim not found" });
  });

  it("F1e: a proven wallet releases its own padded, mixed-case recorded claim", async () => {
    const agentId = `  ${MIXED}  `;
    const url = await adminClaimFor(agentId);
    const released = await app.inject({ method: "DELETE", url, headers: { "x-n170-proven-wallet": MIXED.toLowerCase() } });
    expect(released.statusCode).toBe(200);
    expect(released.json()).toMatchObject({ released: true, claim: { agentId } });
  });
});
