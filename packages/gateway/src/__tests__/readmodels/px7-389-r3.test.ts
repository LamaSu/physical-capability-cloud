/**
 * Cross-family review r2 of #389 (rm-px7-389-r2-1a1bf039, DO-NOT-SHIP). These tests reproduce its
 * findings at 1a1bf039 and pin the replacement rule:
 *   HIGH    contested money was `escrowed`: a V-next contest state, the job's own disputed
 *           status, or an open dispute on the milestone now reads `contested`;
 *   MEDIUM  REFUND_ALLOCATED was `not_held`: the payer is not yet refunded, so `refund_pending`;
 *   MEDIUM  update_status was offered as always refused, which is false for a caller the PATCH
 *           route authorizes: the action is not offered until the read model can decide it;
 *   MEDIUM  offset paging could repeat or skip rows when the list changed between pages: every
 *           page carries a snapshot of the whole list, and a page asked for under an older
 *           snapshot is refused (409 list_changed).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  buildOperatorIncomeDTO,
  buildOperatorWorkDTO,
  type CapabilityLite,
  type KernelJobSource,
  type OperatorWorkSources,
} from "../../readmodels/operator-work.js";
import { buildSettlementAxis, type JobRow, type SettlementSource } from "../../readmodels/job-execution.js";

const AS_OF = "2026-09-24T12:00:00.000Z";
const NOW = Date.parse(AS_OF);
const K1 = { id: "k-1", name: "Shop One", operatorAddress: "0xAbC", location: { lat: 40.7128, lng: -74.006 } };
const CAPS: CapabilityLite[] = [{ id: "cap-fdm", kernelId: "k-1", type: "fdm", name: "FDM printing" }];
const OPERATOR_NYC = "0x1111111111111111111111111111111111111111";

function job(over: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-x", stepId: "step-x", cwmId: "cwm-x", capabilityId: "cap-fdm", kernelId: "k-1", status: "queued",
    startedAt: "2026-09-20T10:00:00.000Z", completedAt: null, progress: 0, assuranceTier: 1, ...over,
  };
}
const escrow = (over: Record<string, unknown> = {}) => ({
  id: "esc-x", cwmId: "cwm-x", contractAddress: "0x3333333333333333333333333333333333333333", totalAmount: "30.00",
  currency: "USDC", status: "funded", createdAt: AS_OF, deadline: AS_OF, version: "v3", ...over,
});
const milestone = (over: Record<string, unknown> = {}) => ({ id: "ms-x", stepId: "step-x", amount: "12.50", status: "funded", ...over });
const linked = (e = escrow(), ms: unknown[] = [milestone()]): SettlementSource => ({
  link: "linked", basis: "negotiation_session_escrow_address", matches: ["negotiation_session_escrow_address"], escrow: e as any, milestones: ms as any,
});
type DisputesRead = { ok: true; value: Array<{ escrowId: string; milestoneStepId: string; status: string }> } | { ok: false };
const NO_DISPUTES: DisputesRead = { ok: true, value: [] };
const kj = (j: JobRow, s: SettlementSource, disputes: DisputesRead = NO_DISPUTES): KernelJobSource =>
  ({ job: j, settlement: buildSettlementAxis(j, { ok: true, value: s }), disputes }) as KernelJobSource;
function sources(over: Partial<OperatorWorkSources> = {}): OperatorWorkSources {
  return {
    kernels: [K1],
    capabilities: { ok: true, value: CAPS },
    kernelJobs: { ok: true, value: [] },
    approvals: { ok: true, value: [] },
    claimedOffers: { ok: true, value: [] },
    openOffers: { ok: true, value: [] },
    ...over,
  };
}
const work = (jobs: KernelJobSource[], limit = 200, offset = 0) =>
  buildOperatorWorkDTO(sources({ kernelJobs: { ok: true, value: jobs } }), AS_OF, { limit, offset, nowMs: NOW });
const fundingOf = (src: KernelJobSource) => work([src]).items[0]!.pay.funding;

describe("HIGH (review r2 of #389): contested money is never `escrowed`", () => {
  it("a V-next contest or escalation state on the escrow reads `contested`", () => {
    for (const status of ["PRIMARY_ASSERTED", "CHALLENGED", "BACKUP_PENDING", "BACKUP_ASSERTED"]) {
      expect(fundingOf(kj(job(), linked(escrow({ status })))), status).toBe("contested");
    }
  });

  it("a job whose own status is disputed reads `contested`, beside its disputed phase", () => {
    const item = work([kj(job({ status: "disputed" }), linked())]).items[0]!;
    expect(item.phase).toBe("disputed");
    expect(item.pay.funding).toBe("contested");
  });

  it("an open dispute on this milestone reads `contested`; a settled one does not", () => {
    const d = (status: string): DisputesRead => ({ ok: true, value: [{ escrowId: "esc-x", milestoneStepId: "step-x", status }] });
    expect(fundingOf(kj(job(), linked(), d("filed")))).toBe("contested");
    expect(fundingOf(kj(job(), linked(), d("under_review")))).toBe("contested");
    expect(fundingOf(kj(job(), linked(), d("resolved_for_operator")))).toBe("escrowed");
    expect(fundingOf(kj(job(), linked(), d("dismissed")))).toBe("escrowed");
  });

  it("NEGATIVE: a dispute that went to the challenger, an unrecognized dispute status, or a failed dispute read is `unknown`", () => {
    const d = (status: string): DisputesRead => ({ ok: true, value: [{ escrowId: "esc-x", milestoneStepId: "step-x", status }] });
    expect(fundingOf(kj(job(), linked(), d("resolved_for_challenger")))).toBe("unknown");
    expect(fundingOf(kj(job(), linked(), d("appealed")))).toBe("unknown");
    expect(fundingOf(kj(job(), linked(), { ok: false }))).toBe("unknown");
  });

  it("an uncontested funded escrow and milestone still read `escrowed`", () => {
    expect(fundingOf(kj(job(), linked()))).toBe("escrowed");
  });
});

describe("MEDIUM (review r2 of #389): a decided refund the payer has not received is `refund_pending`", () => {
  it("REFUND_ALLOCATED is refund_pending, never not_held", () => {
    expect(fundingOf(kj(job(), linked(escrow({ status: "REFUND_ALLOCATED" }))))).toBe("refund_pending");
  });
});

describe("MEDIUM (review r2 of #389): update_status is not offered until the read model can decide it", () => {
  it("no kernel job item carries an update_status action, open or finished", () => {
    const items = work([kj(job({ id: "job-open" }), linked()), kj(job({ id: "job-done", status: "completed" }), linked())]).items;
    expect(items).toHaveLength(2);
    for (const item of items) expect(item.actions.map((a) => a.op)).not.toContain("update_status");
  });
});

describe("MEDIUM (review r2 of #389): paging under a changing list is detected, never silently wrong", () => {
  const three = () => ["job-a", "job-b", "job-c"].map((id) => kj(job({ id, stepId: `step-${id}` }), linked(escrow(), [milestone({ stepId: `step-${id}` })])));

  it("every page carries a snapshot of the whole sorted list: the same list gives the same snapshot", () => {
    const first = work(three(), 2, 0);
    const second = work(three(), 2, 2);
    expect(typeof first.snapshot).toBe("string");
    expect(first.snapshot.length).toBeGreaterThanOrEqual(16);
    expect(second.snapshot).toBe(first.snapshot);
  });

  it("removing, adding or reordering an item changes the snapshot", () => {
    const base = work(three(), 2, 0).snapshot;
    expect(work(three().slice(1), 2, 0).snapshot).not.toBe(base);
    expect(work([...three(), kj(job({ id: "job-d", stepId: "step-job-d" }), linked(escrow(), [milestone({ stepId: "step-job-d" })]))], 2, 0).snapshot).not.toBe(base);
    const reordered = three();
    reordered[0] = kj(job({ id: "job-a", stepId: "step-job-a", status: "disputed" }), linked(escrow(), [milestone({ stepId: "step-job-a" })]));
    expect(work(reordered, 2, 0).snapshot).not.toBe(base);
  });

  it("the income rows carry the same kind of snapshot", () => {
    const src = (jobs: KernelJobSource[]) => sources({ kernelJobs: { ok: true, value: jobs } });
    const a = buildOperatorIncomeDTO(src(three()), AS_OF, { limit: 2, offset: 0 });
    const b = buildOperatorIncomeDTO(src(three().slice(1)), AS_OF, { limit: 2, offset: 0 });
    expect(typeof a.snapshot).toBe("string");
    expect(b.snapshot).not.toBe(a.snapshot);
  });
});

describe("the routes refuse a page asked for under an older snapshot (409 list_changed)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    const db = await import("../../db.js");
    db.initStore({ seed: true });
    const offers = await import("../../services/job-offers-store.js");
    offers._resetJobOffersStoreForTests();
    offers.initJobOffersStore({});
    const { operatorWorkRoutes } = await import("../../routes/operator-work.js");
    app = Fastify({ logger: false });
    app.addHook("onRequest", async (req) => {
      const p = req.headers["x-test-principal"];
      if (typeof p === "string") {
        (req as any).operatorId = p;
        (req as any).provenWallet = p.toLowerCase();
      }
    });
    await app.register(operatorWorkRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    (await import("../../db.js")).closeStore();
    (await import("../../services/job-offers-store.js"))._resetJobOffersStoreForTests();
  });

  const get = (url: string) => app.inject({ method: "GET", url, headers: { "x-test-principal": OPERATOR_NYC } });

  it("the current snapshot continues; any other is 409 list_changed with the current one; a repeated one is 400", async () => {
    for (const path of ["/api/operator/work", "/api/operator/income"]) {
      const first = await get(`${path}?limit=1`);
      expect(first.statusCode, path).toBe(200);
      const snapshot = first.json().snapshot as string;
      expect(typeof snapshot, path).toBe("string");
      expect((await get(`${path}?limit=1&offset=1&snapshot=${encodeURIComponent(snapshot)}`)).statusCode, path).toBe(200);
      const stale = await get(`${path}?limit=1&offset=1&snapshot=stale-snapshot`);
      expect(stale.statusCode, path).toBe(409);
      expect(stale.json().error, path).toBe("list_changed");
      expect(stale.json().snapshot, path).toBe(snapshot);
      expect((await get(`${path}?snapshot=a&snapshot=b`)).statusCode, path).toBe(400);
    }
  });
});
