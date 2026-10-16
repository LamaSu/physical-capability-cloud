import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@pcc/store";
import { closeStore, getStore, initStore } from "../db.js";
import { jobReaderOf, operatedKernelsOf } from "../readmodels/job-execution.js";
import { findOperatorKernels } from "../readmodels/operator-work.js";

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
    "R1: unowned wallet %j operates no kernels",
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

  it("R2: an empty buyer and wallet grant no access", () => {
    insertBuyerJob("job-empty", "");
    const { db, repos } = getStore();
    const reader = jobReaderOf("", repos, db);
    expect([...reader.buyerJobs]).toEqual([]);
    expect([...reader.kernels]).toEqual([]);
  });

  it("R3: ZERO finds no placeholder-owned operator kernels", () => {
    expect(findOperatorKernels(ZERO, getStore().db)).toEqual([]);
  });

  it.each(["", "  ", `  ${ZERO}  `, `  ${ZERO.toUpperCase()}  `])(
    "R3: unowned wallet %j finds no operator kernels",
    (wallet) => {
      expect(findOperatorKernels(wallet, getStore().db)).toEqual([]);
    },
  );

  it("P1: a real wallet gets its own kernel through both loaders", () => {
    const { db, repos } = getStore();
    expect.soft([...operatedKernelsOf(REAL, repos)]).toEqual(["kernel-real"]);
    expect(findOperatorKernels(REAL, db).map((k) => k.id)).toEqual(["kernel-real"]);
  });

  it("P2: a real wallet gets its single-session buyer job", () => {
    insertBuyerJob("job-real", REAL);
    const { db, repos } = getStore();
    expect([...jobReaderOf(REAL, repos, db).buyerJobs]).toEqual(["job-real"]);
  });

  it("P3: mixed-case recorded addresses match a lowercase wallet", () => {
    insertBuyerJob("job-mixed", `  ${MIXED}  `);
    const { db, repos } = getStore();
    const wallet = MIXED.toLowerCase();
    expect.soft([...operatedKernelsOf(wallet, repos)]).toEqual(["kernel-mixed"]);
    expect.soft(findOperatorKernels(wallet, db).map((k) => k.id)).toEqual(["kernel-mixed"]);
    expect([...jobReaderOf(wallet, repos, db).buyerJobs]).toEqual(["job-mixed"]);
  });

  it("P4: the near-zero real wallet gets its kernel and single-session buyer job", () => {
    insertBuyerJob("job-near", NEAR);
    const { db, repos } = getStore();
    expect.soft([...operatedKernelsOf(NEAR, repos)]).toEqual(["kernel-near"]);
    expect.soft(findOperatorKernels(NEAR, db).map((k) => k.id)).toEqual(["kernel-near"]);
    expect([...jobReaderOf(NEAR, repos, db).buyerJobs]).toEqual(["job-near"]);
  });

  it("preserves each loader's handling of mixed-case wallet arguments", () => {
    const { db, repos } = getStore();
    expect([...operatedKernelsOf(MIXED, repos)]).toEqual([]);
    expect(findOperatorKernels(MIXED, db).map((k) => k.id)).toEqual(["kernel-mixed"]);
  });

  it("preserves the address shape check", () => {
    insertKernel("kernel-label", "operator@example.com");
    const { db, repos } = getStore();
    expect([...operatedKernelsOf("operator@example.com", repos)]).toEqual([]);
    expect(findOperatorKernels("operator@example.com", db)).toEqual([]);
  });
});
