/**
 * N10a — /api/ip/* authorization (Gate A). WP-E's negative tests, each paired with its allowed case
 * so the check is proven in both directions:
 *   - a non-owner cannot set licensing terms, set splits or claim; the owner can;
 *   - an IP with no recorded owner cannot be changed by anyone;
 *   - an API key is not proof of identity, even when its operatorId equals the owner's wallet;
 *   - settle-royalties: only a party to the job, only a released milestone, revenue and payer from
 *     server state (a disagreeing body is 409), and a failed payment fails the request;
 *   - claim records the caller; pay and dispute act as the caller only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { getLicensingEngine, getStoryIPService, resetLicensingEngine, resetStoryIPService, type LicenseEvaluation } from "@pcc/contracts";
import { ipRoutes } from "../routes/ip.js";
import { apiGate } from "../middleware/api-gate.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, getRepos, initStore } from "../db.js";

process.env.STORY_MOCK = "true";

/** Seeded: kernel-nyc is operated by OWNER and runs capability cap-nyc-fdm. */
const OWNER = "0x1111111111111111111111111111111111111111";
/** Seeded: kernel-sf's operator, who owns nothing on kernel-nyc. */
const OTHER = "0x2222222222222222222222222222222222222222";
const BUYER = "0x0000000000000000000000000000000000b0b0b0";

let seq = 0;
function as(wallet: string): Record<string, string> {
  const now = new Date();
  const token = `authz-session-${++seq}`;
  getRepos().sessions.insert({
    id: `authz-sess-${seq}`,
    walletAddress: wallet,
    token,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    lastActiveAt: now.toISOString(),
  });
  return { authorization: `Bearer ${token}` };
}

async function buildApp(withGate = false): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  const app = Fastify({ logger: false });
  if (withGate) await app.register(apiGate);
  await app.register(ipRoutes);
  await app.ready();
  return app;
}

async function registerCapabilityIp(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/ip/register-capability",
    headers: as(OWNER),
    payload: {
      capability: { id: "cap-nyc-fdm", name: "FDM", type: "fdm", kernelId: "kernel-nyc" },
      designerAddress: OWNER,
      designerName: "NYC MakerSpace",
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ registration: { ipId: string } }>().registration.ipId;
}

/** A job on kernel-nyc with a consistent escrow and milestone (the seeded ones do not line up). */
function seedSettledJob(opts: { status?: string; currency?: string; amount?: string } = {}): string {
  const repos = getRepos();
  repos.jobs.insert({
    id: "job-n10a",
    stepId: "step-n10a",
    cwmId: "cwm-n10a",
    capabilityId: "cap-nyc-fdm",
    kernelId: "kernel-nyc",
    status: "completed",
    assignedDevices: [],
    progress: 100,
  });
  repos.escrows.insert({
    id: "esc-n10a",
    cwmId: "cwm-n10a",
    contractAddress: "mock-escrow-n10a",
    payer: BUYER,
    totalAmount: opts.amount ?? "25.00",
    currency: opts.currency ?? "USDC",
    status: "completed",
    createdAt: "2026-09-24T00:00:00Z",
    deadline: "2026-09-30T00:00:00Z",
  });
  repos.escrows.insertMilestone({
    id: "ms-n10a",
    escrowId: "esc-n10a",
    stepId: "step-n10a",
    amount: opts.amount ?? "25.00",
    status: opts.status ?? "released",
    bondAmount: "0.00",
  });
  return "job-n10a";
}

async function registerEvidenceIp(app: FastifyInstance, parentIpId: string, jobId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/ip/register-job-evidence",
    headers: as(OWNER),
    payload: { parentIpId, jobId, evidenceBundleHash: "0xbundle", operatorAddress: OWNER, operatorName: "NYC" },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ link: { childIpId: string } }>().link.childIpId;
}

/** Make the licensing engine owe the parent 10% of the child's revenue, so settlement has a row. */
function owe10Percent(parentIpId: string, childIpId: string): void {
  const evaluation = { approved: true, revSharePercent: 10, derivativeDepth: 1, effectiveRevShare: 10, reasons: [] } as unknown as LicenseEvaluation;
  getLicensingEngine().grantLicense(evaluation, { parentIpId, childIpId, licensingTermsId: "terms-n10a", recipientAddress: OWNER });
}

describe("N10a: /api/ip/* authorization", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetStoryIPService();
    resetLicensingEngine();
    app = await buildApp();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    closeStore();
    resetStoryIPService();
    resetLicensingEngine();
  });

  describe("E1/E2: only the recorded owner changes an IP", () => {
    it("set-licensing-terms, distribute-royalties and claim: a non-owner is 403, the owner is 200", async () => {
      const ipId = await registerCapabilityIp(app);
      const terms = (who: string) => ({
        method: "POST" as const,
        url: "/api/ip/set-licensing-terms",
        headers: as(who),
        payload: { ipId, designerAddress: who, autoLicense: {}, standingOffers: [], defaultRevShare: 5, allowSubDerivatives: true, derivativeDecayRate: 0.5 },
      });
      const splits = (who: string) => ({
        method: "POST" as const,
        url: "/api/ip/distribute-royalties",
        headers: as(who),
        payload: { ipId, splits: [{ address: who, role: "integrator", percentage: 100, label: "all to me" }] },
      });
      const claim = (who: string) => ({ method: "POST" as const, url: `/api/ip/${encodeURIComponent(ipId)}/claim`, headers: as(who), payload: {} });

      for (const req of [terms(OTHER), splits(OTHER), claim(OTHER)]) {
        const res = await app.inject(req);
        expect(res.statusCode).toBe(403);
        expect(res.json<{ error: string }>().error).toBe("not_ip_owner");
      }
      for (const req of [terms(OWNER), splits(OWNER), claim(OWNER)]) {
        expect((await app.inject(req)).statusCode).toBe(200);
      }
    });

    it("an IP with no recorded owner cannot be changed by anyone", async () => {
      for (const url of ["/api/ip/set-licensing-terms", "/api/ip/distribute-royalties"]) {
        const res = await app.inject({
          method: "POST",
          url,
          headers: as(OWNER),
          payload: { ipId: "0xunrecorded", designerAddress: OWNER, splits: [{ address: OWNER, role: "integrator", percentage: 100, label: "x" }] },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json<{ error: string }>().error).toBe("ip_owner_unknown");
      }
      const claim = await app.inject({ method: "POST", url: "/api/ip/0xunrecorded/claim", headers: as(OWNER), payload: {} });
      expect(claim.json<{ error: string }>().error).toBe("ip_owner_unknown");
    });

    it("the owner cannot set terms that name someone else as the designer", async () => {
      const ipId = await registerCapabilityIp(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/ip/set-licensing-terms",
        headers: as(OWNER),
        payload: { ipId, designerAddress: OTHER, autoLicense: {}, standingOffers: [] },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: string }>().error).toBe("designer_must_be_caller");
    });

    it("claim records the caller's address, never the zero address", async () => {
      const ipId = await registerCapabilityIp(app);
      expect((await app.inject({ method: "POST", url: `/api/ip/${encodeURIComponent(ipId)}/claim`, headers: as(OWNER), payload: {} })).statusCode).toBe(200);
      const claims = getRepos().story.findRevenueClaimsByIp(ipId);
      expect(claims).toHaveLength(1);
      expect(claims[0]!.claimerAddress).toBe(OWNER);
    });
  });

  describe("registration records ownership from the caller, never from the body", () => {
    it("only the operator of the capability's kernel registers it, as itself, for a recorded capability", async () => {
      const body = (designer: string, capabilityId = "cap-nyc-fdm") => ({
        capability: { id: capabilityId, name: "FDM", type: "fdm", kernelId: "kernel-nyc" },
        designerAddress: designer,
        designerName: "X",
      });
      const run = (who: string, payload: unknown) => app.inject({ method: "POST", url: "/api/ip/register-capability", headers: as(who), payload: payload as object });
      expect((await run(OTHER, body(OTHER))).json<{ error: string }>().error).toBe("not_kernel_operator");
      expect((await run(OWNER, body(OTHER))).json<{ error: string }>().error).toBe("designer_must_be_caller");
      expect((await run(OWNER, body(OWNER, "cap-not-recorded"))).json<{ error: string }>().error).toBe("capability_not_found");
      expect((await run(OWNER, body(OWNER))).statusCode).toBe(200);
    });

    it("only the operator of a job's kernel registers its evidence, for a recorded job and parent", async () => {
      const parent = await registerCapabilityIp(app);
      const body = (who: string, jobId = "job-001", parentIpId = parent) => ({ parentIpId, jobId, evidenceBundleHash: "0xb", operatorAddress: who, operatorName: "op" });
      const run = (who: string, payload: object) => app.inject({ method: "POST", url: "/api/ip/register-job-evidence", headers: as(who), payload });
      expect((await run(OTHER, body(OTHER))).json<{ error: string }>().error).toBe("not_kernel_operator");
      expect((await run(OWNER, body(OTHER))).json<{ error: string }>().error).toBe("operator_must_be_caller");
      expect((await run(OWNER, body(OWNER, "job-not-recorded"))).json<{ error: string }>().error).toBe("job_not_found");
      // The parent must be the IP of the job's own capability (coord-watch #2974), not any known IP.
      expect((await run(OWNER, body(OWNER, "job-001", "0xno-parent"))).json<{ error: string }>().error).toBe("parent_not_job_capability");
      expect((await run(OWNER, body(OWNER))).statusCode).toBe(200);
    });
  });

  describe("identity: an API key is not proof of who you are", () => {
    it("a key whose operatorId IS the owner's wallet is still refused; the owner's SIWE session is accepted", async () => {
      await app.close();
      closeStore();
      app = await buildApp(true);
      const ipId = await registerCapabilityIp(app);
      // Anyone can provision a key claiming any operatorId (POST /api/auth/provision is public).
      const { rawKey } = provisionApiKey({ operatorId: OWNER, name: "claims to be the owner" });
      const payload = { ipId, splits: [{ address: OWNER, role: "integrator", percentage: 100, label: "all" }] };
      const withKey = await app.inject({ method: "POST", url: "/api/ip/distribute-royalties", headers: { authorization: `Bearer ${rawKey}` }, payload });
      expect(withKey.statusCode).toBe(401);
      expect(withKey.json<{ error: string }>().error).toBe("verified_wallet_required");
      const withSession = await app.inject({ method: "POST", url: "/api/ip/distribute-royalties", headers: as(OWNER), payload });
      expect(withSession.statusCode).toBe(200);
    });

    it("no session at all is 401 on every mutation", async () => {
      for (const [url, payload] of [
        ["/api/ip/set-licensing-terms", { ipId: "0xa", designerAddress: OWNER }],
        ["/api/ip/distribute-royalties", { ipId: "0xa", splits: [{ address: OWNER, role: "integrator", percentage: 100, label: "x" }] }],
        ["/api/ip/settle-royalties", { jobId: "job-001", childIpId: "0xc" }],
        ["/api/ip/0xa/pay", { amount: "1" }],
        ["/api/ip/0xa/claim", {}],
        ["/api/ip/0xa/dispute", { evidenceHash: "0xe", reason: "r" }],
      ] as const) {
        const res = await app.inject({ method: "POST", url, payload });
        expect(res.statusCode, url).toBe(401);
      }
    });
  });

  describe("E3: settle-royalties", () => {
    async function settled(opts?: Parameters<typeof seedSettledJob>[0]) {
      const parent = await registerCapabilityIp(app);
      const jobId = seedSettledJob(opts);
      const child = await registerEvidenceIp(app, parent, jobId);
      owe10Percent(parent, child);
      return { parent, child, jobId };
    }
    const settle = (who: string, body: object) => app.inject({ method: "POST", url: "/api/ip/settle-royalties", headers: as(who), payload: body });

    it.each([["the buyer", BUYER], ["the kernel operator", OWNER]])("%s settles a released milestone, at the server's revenue and payer", async (_who, who) => {
      const { child, jobId } = await settled();
      const res = await settle(who, { jobId, childIpId: child });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ revenue: string; payerAddress: string; distributions: Array<{ outcome: string; amount: string }>; totalDistributed: string }>();
      expect(body.revenue).toBe("25000000"); // $25.00 in USDC base units, from the milestone
      expect(body.payerAddress).toBe(BUYER); // the escrow's payer
      expect(body.distributions).toEqual([expect.objectContaining({ outcome: "paid", amount: "2500000" })]);
    });

    it("royalties are settled once: a second settlement by anyone is 409 already_settled, and pays nothing", async () => {
      const { child, jobId } = await settled();
      expect((await settle(BUYER, { jobId, childIpId: child })).statusCode).toBe(200);
      const spy = vi.spyOn(getStoryIPService(), "payJobRoyalty");
      for (const who of [BUYER, OWNER]) {
        const again = await settle(who, { jobId, childIpId: child });
        expect(again.statusCode).toBe(409);
        expect(again.json<{ error: string }>().error).toBe("already_settled");
      }
      expect(spy).not.toHaveBeenCalled();
    });

    it("a settlement that paid nothing can be tried again; one that paid anything cannot", async () => {
      const { child, jobId } = await settled();
      vi.spyOn(getStoryIPService(), "payJobRoyalty").mockRejectedValueOnce(new Error("rpc down"));
      expect((await settle(BUYER, { jobId, childIpId: child })).statusCode).toBe(502); // nothing paid: claim released
      expect((await settle(BUYER, { jobId, childIpId: child })).statusCode).toBe(200); // retried, paid
      expect((await settle(BUYER, { jobId, childIpId: child })).statusCode).toBe(409); // never twice
    });

    it("another workflow's released milestone never settles this job (no fallback across workflows)", async () => {
      const parent = await registerCapabilityIp(app);
      const repos = getRepos();
      // The job's own workflow has no escrow; another workflow has a released milestone with the same step id.
      repos.jobs.insert({ id: "job-orphan", stepId: "step-shared", cwmId: "cwm-mine", capabilityId: "cap-nyc-fdm", kernelId: "kernel-nyc", status: "completed", assignedDevices: [], progress: 100 });
      repos.escrows.insert({ id: "esc-other", cwmId: "cwm-other", contractAddress: "mock-escrow-other", payer: BUYER, totalAmount: "99.00", currency: "USDC", status: "completed", createdAt: "2026-09-24T00:00:00Z", deadline: "2026-09-30T00:00:00Z" });
      repos.escrows.insertMilestone({ id: "ms-other", escrowId: "esc-other", stepId: "step-shared", amount: "99.00", status: "released", bondAmount: "0.00" });
      const child = await registerEvidenceIp(app, parent, "job-orphan");
      const res = await settle(BUYER, { jobId: "job-orphan", childIpId: child });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).toBe("no_settlement_record");
    });

    it("a non-party is 403", async () => {
      const { child, jobId } = await settled();
      const res = await settle(OTHER, { jobId, childIpId: child });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: string }>().error).toBe("not_job_party");
    });

    it("an unreleased milestone is 409", async () => {
      const { child, jobId } = await settled({ status: "funded" });
      const res = await settle(BUYER, { jobId, childIpId: child });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).toBe("milestone_not_released");
    });

    it("a body revenue or payer that disagrees with server state is 409; one that agrees is accepted", async () => {
      const { child, jobId } = await settled();
      const inflated = await settle(BUYER, { jobId, childIpId: child, jobRevenue: "250000000" });
      expect(inflated.statusCode).toBe(409);
      expect(inflated.json<{ error: string }>().error).toBe("revenue_mismatch");
      const otherPayer = await settle(BUYER, { jobId, childIpId: child, payerAddress: OTHER });
      expect(otherPayer.statusCode).toBe(409);
      expect(otherPayer.json<{ error: string }>().error).toBe("payer_mismatch");
      expect((await settle(BUYER, { jobId, childIpId: child, jobRevenue: "25000000", payerAddress: BUYER })).statusCode).toBe(200);
    });

    it("the child IP must be this job's own evidence", async () => {
      const { parent, jobId } = await settled();
      const res = await settle(BUYER, { jobId, childIpId: parent });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).toBe("ip_not_linked_to_job");
    });

    it("an unknown job is 404 and a currency with no known decimals is 409", async () => {
      expect((await settle(BUYER, { jobId: "job-nope", childIpId: "0xc" })).statusCode).toBe(404);
      const { child, jobId } = await settled({ currency: "DAI" });
      const res = await settle(BUYER, { jobId, childIpId: child });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).toBe("unsupported_currency");
    });

    it("a failed royalty payment fails the request and is reported as failed, not swallowed (and the claim is released)", async () => {
      const { child, jobId } = await settled();
      vi.spyOn(getStoryIPService(), "payJobRoyalty").mockRejectedValueOnce(new Error("rpc down"));
      const res = await settle(BUYER, { jobId, childIpId: child });
      expect(res.statusCode).toBe(502);
      const body = res.json<{ error: string; distributions: Array<{ outcome: string; error?: string }>; totalDistributed: string }>();
      expect(body.error).toBe("settlement_incomplete");
      expect(body.distributions).toEqual([expect.objectContaining({ outcome: "failed", error: "rpc down" })]);
      expect(body.totalDistributed).toBe("0");
    });
  });

  describe("Story real mode: the gateway never pays on a caller's behalf (gateway review #2971)", () => {
    afterEach(() => {
      process.env.STORY_MOCK = "true";
    });

    it("pay and settle-royalties answer 501 not_executed, and nothing is paid", async () => {
      const parent = await registerCapabilityIp(app);
      const jobId = seedSettledJob();
      const child = await registerEvidenceIp(app, parent, jobId);
      owe10Percent(parent, child);
      const spy = vi.spyOn(getStoryIPService(), "payJobRoyalty");
      process.env.STORY_MOCK = "false";
      const pay = await app.inject({ method: "POST", url: `/api/ip/${encodeURIComponent(parent)}/pay`, headers: as(BUYER), payload: { amount: "1000" } });
      const settle = await app.inject({ method: "POST", url: "/api/ip/settle-royalties", headers: as(BUYER), payload: { jobId, childIpId: child } });
      expect([pay.statusCode, settle.statusCode]).toEqual([501, 501]);
      expect(pay.json<{ error: string }>().error).toBe("not_executed");
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("forward-compatible with gateway #326's proven wallet", () => {
    it("a wallet apiGate proved (req.provenWallet) is accepted without a session; a client cannot set it", async () => {
      await app.close();
      closeStore();
      process.env.PCC_DB_PATH = ":memory:";
      initStore({ seed: true });
      app = Fastify({ logger: false });
      app.addHook("onRequest", async (req) => {
        // What #326's apiGate will do for a SIWE-minted key; here, for any request carrying x-test-proven.
        if (req.headers["x-test-proven"] === "1") (req as { provenWallet?: string }).provenWallet = OWNER;
      });
      await app.register(ipRoutes);
      await app.ready();
      const ipId = await registerCapabilityIp(app);
      const payload = { ipId, splits: [{ address: OWNER, role: "integrator", percentage: 100, label: "all" }] };
      expect((await app.inject({ method: "POST", url: "/api/ip/distribute-royalties", headers: { "x-test-proven": "1" }, payload })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/api/ip/distribute-royalties", payload })).statusCode).toBe(401);
    });

    it("once apiGate has decided, its null is final: the owner's session is not consulted behind it (gateway #3160)", async () => {
      await app.close();
      closeStore();
      process.env.PCC_DB_PATH = ":memory:";
      initStore({ seed: true });
      app = Fastify({ logger: false });
      app.addHook("onRequest", async (req) => {
        // What #326's apiGate does for a SIWE cookie riding on another identity's API key: it proves no wallet.
        if (req.headers["x-test-gate-null"] === "1") (req as { provenWallet?: string | null }).provenWallet = null;
      });
      await app.register(ipRoutes);
      await app.ready();
      const ipId = await registerCapabilityIp(app);
      const payload = { ipId, splits: [{ address: OWNER, role: "integrator", percentage: 100, label: "all" }] };
      // With no verdict from the gate, the owner's own SIWE session is the proof.
      expect((await app.inject({ method: "POST", url: "/api/ip/distribute-royalties", headers: as(OWNER), payload })).statusCode).toBe(200);
      // The same session, after the gate answered null, proves nothing.
      const res = await app.inject({ method: "POST", url: "/api/ip/distribute-royalties", headers: { ...as(OWNER), "x-test-gate-null": "1" }, payload });
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: string }>().error).toBe("verified_wallet_required");
    });
  });

  describe("Story real mode that refuses to execute (N10b's STORY_NOT_EXECUTED) is 501, not a 500", () => {
    const notExecuted = () => Object.assign(new Error("Story real mode is not executed"), { code: "STORY_NOT_EXECUTED" });

    it("pay answers 501 not_executed", async () => {
      const ipId = await registerCapabilityIp(app);
      vi.spyOn(getStoryIPService(), "payJobRoyalty").mockRejectedValueOnce(notExecuted());
      const res = await app.inject({ method: "POST", url: `/api/ip/${encodeURIComponent(ipId)}/pay`, headers: as(BUYER), payload: { amount: "1000" } });
      expect(res.statusCode).toBe(501);
      expect(res.json<{ error: string }>().error).toBe("not_executed");
    });

    it("settle-royalties answers 501 when Story executed none of the payments, and says nothing was paid", async () => {
      const parent = await registerCapabilityIp(app);
      const jobId = seedSettledJob();
      const child = await registerEvidenceIp(app, parent, jobId);
      owe10Percent(parent, child);
      vi.spyOn(getStoryIPService(), "payJobRoyalty").mockRejectedValue(notExecuted());
      const res = await app.inject({ method: "POST", url: "/api/ip/settle-royalties", headers: as(BUYER), payload: { jobId, childIpId: child } });
      expect(res.statusCode).toBe(501);
      expect(res.json<{ error: string; totalDistributed: string }>()).toMatchObject({ error: "not_executed", totalDistributed: "0" });
    });

    it("any other Story failure stays a 500 with its own error name", async () => {
      const ipId = await registerCapabilityIp(app);
      vi.spyOn(getStoryIPService(), "payJobRoyalty").mockRejectedValueOnce(new Error("rpc down"));
      const res = await app.inject({ method: "POST", url: `/api/ip/${encodeURIComponent(ipId)}/pay`, headers: as(BUYER), payload: { amount: "1000" } });
      expect(res.statusCode).toBe(500);
      expect(res.json<{ error: string }>().error).toBe("pay_royalty_failed");
    });
  });

  describe("E4: pay and dispute act as the caller, against an IP with a recorded owner", () => {
    it("pay: the payer is the caller; another payer is 403, an ownerless IP 403, a non-integer amount 400", async () => {
      const ipId = await registerCapabilityIp(app);
      const pay = (body: object, id = ipId) => app.inject({ method: "POST", url: `/api/ip/${encodeURIComponent(id)}/pay`, headers: as(BUYER), payload: body });
      expect((await pay({ amount: "1000", payerAddress: OTHER })).json<{ error: string }>().error).toBe("payer_must_be_caller");
      expect((await pay({ amount: "1000" }, "0xunrecorded")).json<{ error: string }>().error).toBe("ip_owner_unknown");
      expect((await pay({ amount: "10.5" })).statusCode).toBe(400);
      const spy = vi.spyOn(getStoryIPService(), "payJobRoyalty");
      expect((await pay({ amount: "1000" })).statusCode).toBe(200);
      expect(spy).toHaveBeenCalledWith(ipId, "1000", BUYER);
    });

    it("dispute: any proven wallet may dispute a recorded IP and is named as the disputant", async () => {
      const ipId = await registerCapabilityIp(app);
      const res = await app.inject({ method: "POST", url: `/api/ip/${encodeURIComponent(ipId)}/dispute`, headers: as(OTHER), payload: { evidenceHash: "0xe", reason: "copied design" } });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ raisedBy: string }>().raisedBy).toBe(OTHER);
      const unknown = await app.inject({ method: "POST", url: "/api/ip/0xunrecorded/dispute", headers: as(OTHER), payload: { evidenceHash: "0xe", reason: "r" } });
      expect(unknown.json<{ error: string }>().error).toBe("ip_owner_unknown");
    });
  });
});
