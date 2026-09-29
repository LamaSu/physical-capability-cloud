/**
 * N79: once the gateway has given a job's escrow back (`refund_pending` on a chain escrow, `refunded` once done),
 * the raw chain routes must not move it toward a release. No evidence, no attestation and no release is sent for
 * it, on the EAS (V2/V3) path or the V1 path. Disputes stay open: V2 refunds only through resolveDispute.
 *
 * Nothing reaches a chain: the V2/V3 chain writes are mocks and the V1 facade methods are spied. A call to any of
 * them means the request reached the chain layer.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { getAddress } from "viem";

vi.mock("../contracts/escrow-client.js", async (importActual) => {
  const actual = await importActual<typeof import("../contracts/escrow-client.js")>();
  return {
    ...actual,
    isWriteEnabled: vi.fn(() => true),
    submitEvidenceV2: vi.fn(async () => ({ transactionHash: "0xevidence" })),
    submitAttestationV2: vi.fn(async () => ({ transactionHash: "0xattest" })),
    submitAttestationV3: vi.fn(async () => ({ transactionHash: "0xattest3" })),
    releaseMilestoneV2: vi.fn(async () => ({ transactionHash: "0xrelease" })),
    releaseMilestoneV3: vi.fn(async () => ({ transactionHash: "0xrelease3" })),
  };
});

import { escrowRoutes } from "../routes/escrow.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { getSettlementFacade } from "../facades/index.js";
import * as chain from "../contracts/escrow-client.js";

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
/** Seeded checksummed, as paid-job-flow writes escrow rows. */
const PENDING_V2 = addr(0xe5c01);
const PENDING_V3 = addr(0xe5c02);
const REFUNDED_V2 = addr(0xe5c03);
const LIVE_V2 = addr(0xe5c04);

function seedEscrow(id: string, contractAddress: string, status: string, version: "v2" | "v3") {
  const now = new Date().toISOString();
  getRepos().escrows.insert({
    id,
    cwmId: `cwm-${id}`,
    contractAddress,
    payer: "0x3333333333333333333333333333333333333333",
    totalAmount: "100",
    currency: "USDC",
    status,
    createdAt: now,
    deadline: new Date(Date.now() + 86_400_000).toISOString(),
    version,
  });
}

const UID = `0x${"ab".repeat(32)}`;
const ATTESTATION = (escrowAddress: string) => ({ escrowAddress, evidenceHash: `0x${"cd".repeat(32)}` });

/** The three routes that move a milestone toward paying the operator, with a valid body for each path. */
const ADVANCING = [
  { route: "release", body: (a: string) => ({ attestation: ATTESTATION(a) }) },
  { route: "evidence", body: () => ({ evidenceBundleHash: `0x${"ef".repeat(32)}` }) },
  { route: "attestation", body: (a: string) => ({ easUid: UID, attestation: ATTESTATION(a) }) },
] as const;

const V2_CHAIN_WRITES = [
  chain.submitEvidenceV2,
  chain.submitAttestationV2,
  chain.submitAttestationV3,
  chain.releaseMilestoneV2,
  chain.releaseMilestoneV3,
].map((f) => vi.mocked(f));

describe("N79: the raw chain routes never advance an escrow that was given back", () => {
  let app: FastifyInstance;
  let v1: Record<"releaseMilestone" | "submitAttestation" | "submitEvidenceHash" | "fileDispute", ReturnType<typeof vi.spyOn>>;
  const savedFlag = process.env.PCC_USE_EAS_V2;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    seedEscrow("esc-pending-v2", PENDING_V2, "refund_pending", "v2");
    seedEscrow("esc-pending-v3", PENDING_V3, "refund_pending", "v3");
    seedEscrow("esc-refunded-v2", REFUNDED_V2, "refunded", "v2");
    seedEscrow("esc-live-v2", LIVE_V2, "funded", "v2");
    const facade = getSettlementFacade();
    const ok = { success: true, data: { transactionHash: "0xv1" } } as never;
    v1 = {
      releaseMilestone: vi.spyOn(facade, "releaseMilestone").mockResolvedValue(ok),
      submitAttestation: vi.spyOn(facade, "submitAttestation").mockResolvedValue(ok),
      submitEvidenceHash: vi.spyOn(facade, "submitEvidenceHash").mockResolvedValue(ok),
      fileDispute: vi.spyOn(facade, "fileDispute").mockResolvedValue(ok),
    };
    app = Fastify({ logger: false });
    await app.register(escrowRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
    vi.restoreAllMocks();
    if (savedFlag === undefined) delete process.env.PCC_USE_EAS_V2;
    else process.env.PCC_USE_EAS_V2 = savedFlag;
  });

  beforeEach(() => {
    for (const f of V2_CHAIN_WRITES) f.mockClear();
    for (const s of Object.values(v1)) s.mockClear();
  });

  afterEach(() => {
    delete process.env.PCC_USE_EAS_V2;
  });

  const post = (address: string, route: string, body: unknown) =>
    app.inject({ method: "POST", url: `/api/escrow/chain/${address}/${route}/0`, payload: body as object });

  describe.each([
    { path: "EAS (V2/V3)", eas: true },
    { path: "V1", eas: false },
  ])("$path path", ({ eas }) => {
    beforeEach(() => {
      if (eas) process.env.PCC_USE_EAS_V2 = "true";
    });

    it.each(
      ADVANCING.flatMap((r) => [
        { ...r, address: PENDING_V2, status: "refund_pending", which: "a refund-pending V2 escrow" },
        { ...r, address: PENDING_V3, status: "refund_pending", which: "a refund-pending V3 escrow" },
        { ...r, address: REFUNDED_V2, status: "refunded", which: "a refunded escrow" },
        { ...r, address: PENDING_V2.toLowerCase(), status: "refund_pending", which: "a refund-pending escrow named in lowercase" },
      ]),
    )("$route on $which is refused with 409, and nothing is sent", async ({ route, body, address, status }) => {
      const res = await post(address, route, body(address));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual(expect.objectContaining({ error: "escrow_refunded", escrowStatus: status }));
      for (const f of V2_CHAIN_WRITES) expect(f).not.toHaveBeenCalled();
      for (const s of Object.values(v1)) expect(s).not.toHaveBeenCalled();
    });

    it.each(ADVANCING)("$route on a funded escrow still goes through (the guard is specific)", async ({ route, body }) => {
      const res = await post(LIVE_V2, route, body(LIVE_V2));
      expect(res.statusCode).toBe(200);
      const sent = V2_CHAIN_WRITES.filter((f) => f.mock.calls.length > 0).length + Object.values(v1).filter((s) => s.mock.calls.length > 0).length;
      expect(sent).toBe(1);
    });
  });

  it.each(ADVANCING)("$route fails closed when the escrow registry cannot be read: 503, and nothing is sent", async ({ route, body }) => {
    process.env.PCC_USE_EAS_V2 = "true";
    const spy = vi.spyOn(getRepos().escrows, "findByContractAddress").mockImplementation(() => {
      throw new Error("database is locked");
    });
    try {
      const res = await post(LIVE_V2, route, body(LIVE_V2));
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual(expect.objectContaining({ error: "escrow_registry_unavailable" }));
      for (const f of V2_CHAIN_WRITES) expect(f).not.toHaveBeenCalled();
      for (const s of Object.values(v1)) expect(s).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("a dispute on a refund-pending escrow still goes through: V2 refunds only through resolveDispute", async () => {
    const res = await post(PENDING_V2, "dispute", {
      challengerBond: "1",
      challengerEvidenceHash: `0x${"12".repeat(32)}`,
      reason: "the job failed; refund the payer",
    });
    expect(res.statusCode).toBe(200);
    expect(v1.fileDispute).toHaveBeenCalledTimes(1);
  });
});
