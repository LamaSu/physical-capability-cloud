/** Buyer-owned escrows never enter a gateway-key funding or EAS write path. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { eq, schema } from "@pcc/store";
import type { Address } from "viem";

vi.mock("../contracts/escrow-client.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../contracts/escrow-client.js")>();
  return {
    ...actual,
    isWriteEnabled: vi.fn(() => true),
    getMilestoneV2: vi.fn(), getEscrowStateV2: vi.fn(),
    fundEscrowV2: vi.fn(), depositBondV2: vi.fn(), submitEvidenceV2: vi.fn(),
    submitAttestationV2: vi.fn(), releaseMilestoneV2: vi.fn(), waitForReceipt: vi.fn(),
    submitAttestationV3: vi.fn(), releaseMilestoneV3: vi.fn(),
  };
});
vi.mock("../activities/escrow.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../activities/escrow.js")>();
  return { ...actual, fundEscrowActivity: { invoke: vi.fn() } };
});
import * as chain from "../contracts/escrow-client.js";
import { fundEscrowActivity } from "../activities/escrow.js";
import { initStore, closeStore, getStore, getRepos } from "../db.js";
import { escrowRoutes } from "../routes/escrow.js";
import { driveSettlement } from "../services/settlement-crank.js";
import { runKeeperSweep } from "../services/settlement-keeper.js";
import { BUYER_FUNDED_ESCROW_VERSION } from "../services/buyer-funded-escrow.js";

const ADDRESS: Address = "0x1234567890123456789012345678901234567890";
const ABSENT: Address = "0x9876543210987654321098765432109876543210";
const UID = `0x${"ab".repeat(32)}`;
const ADMIN = "buyer-funded-refusals-admin";
const networkSpies = () => [chain.getMilestoneV2, chain.getEscrowStateV2, chain.fundEscrowV2,
  chain.depositBondV2, chain.submitEvidenceV2, chain.submitAttestationV2, chain.releaseMilestoneV2,
  chain.submitAttestationV3, chain.releaseMilestoneV3, chain.waitForReceipt];
let app: FastifyInstance;
beforeEach(async () => {
  vi.stubEnv("PCC_DB_PATH", ":memory:"); vi.stubEnv("PCC_USE_EAS_V2", "true"); vi.stubEnv("PCC_ADMIN_KEY", ADMIN);
  initStore({ seed: false });
  vi.clearAllMocks();
  vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
  vi.mocked(chain.getMilestoneV2).mockResolvedValue({ status: chain.MilestoneStatusV2.Released, stepId: UID, operatorBond: "0", challengeWindowEnd: 0 } as never);
  vi.mocked(chain.getEscrowStateV2).mockResolvedValue({ address: ADDRESS, milestones: [], funded: false } as never);
  for (const spy of [chain.releaseMilestoneV2, chain.releaseMilestoneV3, chain.submitAttestationV2, chain.submitAttestationV3])
    vi.mocked(spy).mockResolvedValue({ transactionHash: UID, status: "submitted" } as never);
  vi.mocked(fundEscrowActivity.invoke).mockResolvedValue({ ok: true, value: { action: "fund" } } as never);
  app = Fastify({ logger: false }); await app.register(escrowRoutes); await app.ready();
});
afterEach(async () => { await app.close(); closeStore(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function seed(version: string | null = BUYER_FUNDED_ESCROW_VERSION) {
  getRepos().escrows.insert({ id: "buyer-escrow", cwmId: "cwm-buyer", contractAddress: ADDRESS,
    payer: "0x5555555555555555555555555555555555555555", totalAmount: "10", currency: "USDC", status: "created",
    version, createdAt: new Date().toISOString(), deadline: new Date(Date.now() + 86400000).toISOString() });
  getRepos().escrows.insertMilestone({ id: "buyer-ms", escrowId: "buyer-escrow", stepId: "step", amount: "10", status: "pending", bondAmount: "0" });
}
function noChain() { for (const spy of networkSpies()) expect(spy).not.toHaveBeenCalled(); }
const post = (action: string, address = ADDRESS) => app.inject({ method: "POST", url: `/api/escrow/chain/${address}/${action}`,
  headers: { "x-admin-key": ADMIN }, ...(action.startsWith("attestation") ? { payload: { easUid: UID } } : {}) });

describe("buyer funded escrow refusals", () => {
  it("X1: fund refuses the marker before the activity or any chain call", async () => {
    seed(); const res = await post("fund"); expect(res.statusCode).toBe(409); expect(res.json().error).toBe("escrow_buyer_funded");
    expect(fundEscrowActivity.invoke).not.toHaveBeenCalled(); noChain();
  });
  it("X2: v2 funding still invokes the activity once", async () => {
    seed("v2"); const res = await post("fund"); expect(res.statusCode).toBe(200); expect(fundEscrowActivity.invoke).toHaveBeenCalledOnce();
  });
  it("X3: unreadable fund registry still refuses with 503", async () => {
    closeStore(); const res = await post("fund"); expect(res.statusCode).toBe(503); expect(res.json().error).toBe("escrow_lookup_unavailable");
    expect(fundEscrowActivity.invoke).not.toHaveBeenCalled(); noChain();
  });
  it("X4: crank refuses marker before reads, with writes enabled or disabled", async () => {
    seed();
    for (const enabled of [true, false]) {
      vi.mocked(chain.isWriteEnabled).mockReturnValue(enabled);
      expect(await driveSettlement(ADDRESS, 0)).toEqual({ escrowAddress: ADDRESS, milestoneIdx: 0, finalStatus: "Unfunded", outcome: "blocked", settled: false, steps: [], reason: "escrow_buyer_funded" });
      noChain();
    }
  });
  it("X5: crank fails closed when the registry lookup throws", async () => {
    closeStore(); expect(await driveSettlement(ADDRESS, 0)).toEqual({ escrowAddress: ADDRESS, milestoneIdx: 0, finalStatus: "Unfunded", outcome: "blocked", settled: false, steps: [], reason: "escrow_lookup_unavailable" }); noChain();
  });
  it("X6: v2 and an absent row still reach the chain read", async () => {
    seed("v2");
    for (const address of [ADDRESS, ABSENT]) {
      vi.mocked(chain.getMilestoneV2).mockClear(); await driveSettlement(address, 0);
      expect(chain.getMilestoneV2).toHaveBeenCalledOnce(); expect(chain.getMilestoneV2).toHaveBeenCalledWith(0, address);
    }
  });
  it("X7: keeper counts the marker as skippedV3 without a chain read", async () => {
    seed(); const result = await runKeeperSweep(getRepos()); expect(result.skippedV3).toBe(1); noChain();
  });
  it("X8: EAS release refuses marker and unknown versions, preserving v2/v3 defaults", async () => {
    seed(); await dispatchCases("release/0", chain.releaseMilestoneV2, chain.releaseMilestoneV3);
  });
  it("X9: EAS attestation refuses marker and unknown versions, preserving v2/v3 defaults", async () => {
    seed(); await dispatchCases("attestation/0", chain.submitAttestationV2, chain.submitAttestationV3);
  });
});
async function dispatchCases(action: string, v2: Function, v3: Function) {
  for (const [version, error] of [[BUYER_FUNDED_ESCROW_VERSION, "escrow_buyer_funded"], ["v9", "escrow_version_unknown"]]) {
    vi.clearAllMocks(); getStore().db.update(schema.escrows).set({ version }).where(eq(schema.escrows.id, "buyer-escrow")).run();
    const res = await post(action); expect(res.statusCode).toBe(409); expect(res.json().error).toBe(error); noChain();
  }
  for (const version of ["v3", "v2", null]) {
    vi.clearAllMocks(); getStore().db.update(schema.escrows).set({ version }).where(eq(schema.escrows.id, "buyer-escrow")).run();
    expect((await post(action)).statusCode).toBe(200);
    expect(version === "v3" ? v3 : v2).toHaveBeenCalledOnce(); expect(version === "v3" ? v2 : v3).not.toHaveBeenCalled();
  }
  vi.clearAllMocks(); const absent = await post(action, ABSENT); expect(absent.statusCode).toBe(404); expect(absent.json().error).toBe("escrow_not_found"); noChain();
  // Missing rows are 404 and an unreadable registry fails closed: no V2 fallback.
  closeStore(); vi.clearAllMocks(); const down = await post(action); expect(down.statusCode).toBe(503); expect(down.json().error).toBe("escrow_lookup_unavailable"); noChain();
}
