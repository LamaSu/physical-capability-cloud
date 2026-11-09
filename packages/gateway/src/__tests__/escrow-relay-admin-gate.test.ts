/** The escrow chain routes check the caller, the escrow and the submitted value: only the gateway admin secret reaches a gateway-key escrow write, for a known escrow of a supported version, and an evidence relay carries its job's pinned bundle. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { schema } from "@pcc/store";

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
const lock = vi.hoisted(() => ({ held: 0 }));
vi.mock("../contracts/signer-lock.js", () => ({
  withSignerLock: vi.fn(async (fn: () => Promise<unknown>) => {
    lock.held += 1;
    try { return await fn(); } finally { lock.held -= 1; }
  }),
  __resetSignerLockForTests: vi.fn(),
}));

import * as chain from "../contracts/escrow-client.js";
import { withSignerLock } from "../contracts/signer-lock.js";
import * as activities from "../activities/escrow.js";
import { getSettlementFacade } from "../facades/index.js";
import { initStore, closeStore, getStore, getRepos } from "../db.js";
import { closeWorkflowStore } from "../workflow-store.js";
import { escrowRoutes } from "../routes/escrow.js";
import { BUYER_FUNDED_ESCROW_VERSION } from "../services/buyer-funded-escrow.js";

const ADMIN = "relay-gate-admin";
const UID = "0x" + "ab".repeat(32);
const BUYER = "0x5555555555555555555555555555555555555555";
const V2 = "0x2000000000000000000000000000000000000002";
const V3 = "0x3000000000000000000000000000000000000003";
const BF = "0x4000000000000000000000000000000000000004";
const V9 = "0x9000000000000000000000000000000000000009";
const NOSESSION = "0x6000000000000000000000000000000000000001";
const NOJOB = "0x6000000000000000000000000000000000000002";
const NOTPINNED = "0x6000000000000000000000000000000000000003";
const PINMISSING = "0x6000000000000000000000000000000000000004";
const TWO = "0x6000000000000000000000000000000000000005";
const SAME = "0x6000000000000000000000000000000000000006";
const UNKNOWN = "0x1111111111111111111111111111111111111111";
const pinnedHex: Record<string, string> = { [V2]: "a2", [V3]: "a3", [SAME]: "c1" };
const chainOf = (address: string) => "0x" + (pinnedHex[address] ?? "a2").repeat(32);
const callers = {
  admin: { "x-admin-key": ADMIN },
  operator: { "x-test-principal": "op-stranger" },
  "wrong-secret": { "x-test-principal": "op-stranger", "x-admin-key": "not-the-gateway-secret" },
  buyer: { "x-test-principal": BUYER, "x-test-proven-wallet": BUYER },
};
const routes = ["fund", "release", "dispute", "deposit-bond", "evidence", "attestation"] as const;
const flags = ["true", "false"] as const;
type Route = typeof routes[number];
type Flag = typeof flags[number];
type Caller = keyof typeof callers;
const ADMIN_REQUIRED = { error: "forbidden", reason: "admin_required", message: "These escrow chain writes need the gateway admin secret." };
const NOT_FOUND = { error: "escrow_not_found", message: "No escrow with this contract address is known to this gateway. Gateway-key settlement writes are limited to protocol-created escrows." };
const LOOKUP_UNAVAILABLE = { error: "escrow_lookup_unavailable", message: "The escrow registry is unreadable; refusing a gateway-key settlement write to an address of unverified provenance." };
const BUYER_FUNDED = { error: "escrow_buyer_funded", message: "Buyer-funded escrows do not use gateway-key settlement writes." };
const VERSION_UNKNOWN = { error: "escrow_version_unknown", message: "The escrow version is not supported for gateway-key settlement writes." };
const NOT_PINNED = { error: "evidence_not_pinned", message: "This escrow's job has no pinned evidence bundle to relay." };
const MISMATCH = { error: "evidence_hash_mismatch", message: "The hash is not this escrow's pinned evidence bundle." };
const directNames = ["releaseMilestoneV2", "releaseMilestoneV3", "submitAttestationV2", "submitAttestationV3", "submitEvidenceV2"] as const;
const facadeNames = ["fundEscrow", "releaseMilestone", "fileDispute", "depositBond", "submitEvidenceHash", "submitAttestation"] as const;
const activityFor = {
  fund: activities.fundEscrowActivity,
  release: activities.releaseMilestoneActivity,
  dispute: activities.fileDisputeActivity,
  "deposit-bond": activities.depositBondActivity,
  evidence: activities.submitEvidenceActivity,
};
const facadeFor = {
  fund: "fundEscrow", release: "releaseMilestone", dispute: "fileDispute",
  "deposit-bond": "depositBond", evidence: "submitEvidenceHash", attestation: "submitAttestation",
} as const;
const networkSpies = () => [chain.getMilestoneV2, chain.getEscrowStateV2, chain.fundEscrowV2,
  chain.depositBondV2, chain.submitEvidenceV2, chain.submitAttestationV2, chain.releaseMilestoneV2,
  chain.submitAttestationV3, chain.releaseMilestoneV3, chain.waitForReceipt];
let app: FastifyInstance;
let context: string;
const seen: Array<{ fn: string; held: number }> = [];
const facadeSpies = {} as Record<typeof facadeNames[number], ReturnType<typeof vi.spyOn>>;
let invokeSpies: Array<ReturnType<typeof vi.spyOn>>;

function seedEscrow(id: string, contractAddress: string, version: string | null = "v2") {
  const now = new Date().toISOString();
  getRepos().escrows.insert({
    id,
    cwmId: `cwm-${id}`,
    contractAddress,
    payer: "0x3333333333333333333333333333333333333333",
    totalAmount: "100",
    currency: "USDC",
    status: "created",
    createdAt: now,
    deadline: new Date(Date.now() + 86_400_000).toISOString(),
    version,
  });
}
function seedSession(id: string, jobId: string, escrowAddress: string | null, cwmId: string) {
  const now = new Date().toISOString();
  getStore().db.insert(schema.negotiationSessions).values({ id, status: "committed", userAgentId: BUYER,
    kernelId: "kernel-relay", capabilityType: "fdm", operatorConstraints: {}, jobId, escrowAddress, cwmId,
    createdAt: now, expiresAt: now } as any).run();
}
function seedJob(id: string, cwmId: string, evidenceBundleId: string | null) {
  getRepos().jobs.insert({ id, stepId: "step-relay", cwmId, capabilityId: "cap-relay", kernelId: "kernel-relay",
    status: "evidence_submitted", assignedDevices: [], progress: 100, evidenceBundleId } as any);
}
function seedBundle(id: string, jobId: string, hex: string) {
  const now = new Date().toISOString();
  getRepos().evidence.insert({ id, jobId, stepId: "step-relay", kernelId: "kernel-relay", assuranceTier: 1,
    bundleHash: "sha256:" + hex.repeat(32), kernelSignature: { signer: "gateway", algorithm: "sha256", value: "test" },
    createdAt: now } as any);
}
function seedRows() {
  for (const [id, address, version] of [
    ["v2", V2, "v2"], ["v3", V3, "v3"], ["bf", BF, BUYER_FUNDED_ESCROW_VERSION], ["v9", V9, "v9"],
    ["nosession", NOSESSION, "v2"], ["nojob", NOJOB, "v2"], ["notpinned", NOTPINNED, "v2"],
    ["pinmissing", PINMISSING, "v2"], ["two", TWO, "v2"], ["same", SAME, "v2"],
  ]) seedEscrow(id, address, version);
  for (const [id, address, hex] of [["v2", V2, "a2"], ["v3", V3, "a3"], ["same", SAME, "c1"]]) {
    seedSession(`session-${id}`, `job-${id}`, address, `cwm-${id}`);
    seedJob(`job-${id}`, `cwm-${id}`, `bundle-${id}`);
    seedBundle(`bundle-${id}`, `job-${id}`, hex);
  }
  // Unpinned bundle rows of a job are never relayed: only the job's pinned bundle is.
  seedBundle("bundle-v2-unpinned", "job-v2", "f2");
  seedSession("session-nojob", "job-missing", NOJOB, "cwm-nojob");
  seedSession("session-notpinned", "job-notpinned", NOTPINNED, "cwm-notpinned");
  seedJob("job-notpinned", "cwm-notpinned", null);
  seedBundle("bundle-notpinned-unpinned", "job-notpinned", "a2");
  seedSession("session-pinmissing", "job-pinmissing", PINMISSING, "cwm-pinmissing");
  seedJob("job-pinmissing", "cwm-pinmissing", "bundle-missing");
  seedSession("session-two-a", "job-two-a", TWO, "cwm-two");
  seedSession("session-two-b", "job-two-b", null, "cwm-two");
  seedJob("job-two-a", "cwm-two", "bundle-two-a");
  seedJob("job-two-b", "cwm-two", "bundle-two-b");
  seedBundle("bundle-two-a", "job-two-a", "b1");
  seedBundle("bundle-two-b", "job-two-b", "b2");
  seedSession("session-same-cwm", "job-same", null, "cwm-same");
}
function fresh() { vi.clearAllMocks(); seen.length = 0; closeWorkflowStore(); }
function nothingRan() {
  for (const spy of [...invokeSpies, ...Object.values(facadeSpies), ...networkSpies()])
    expect(spy, context).not.toHaveBeenCalled();
  expect(withSignerLock, context).not.toHaveBeenCalled();
  expect(seen, context).toEqual([]);
}
function defaultBody(route: Route, address: string, flag: Flag) {
  if (route === "release") return flag === "true" ? undefined : { attestation: { escrowAddress: address } };
  if (route === "dispute") return { challengerBond: "1", challengerEvidenceHash: "0x" + "dd".repeat(32), reason: "test" };
  if (route === "evidence") return { evidenceBundleHash: chainOf(address) };
  if (route === "attestation") return flag === "true" ? { easUid: UID } : { attestation: { escrowAddress: address } };
  return undefined;
}
function call(route: Route, address: string, caller: Caller, flag: Flag, body = defaultBody(route, address, flag)) {
  vi.stubEnv("PCC_USE_EAS_V2", flag);
  context = `${route}, flag=${flag}, caller=${caller}, address=${address}`;
  const suffix = route === "fund" ? route : `${route}/0`;
  return app.inject({ method: "POST", url: `/api/escrow/chain/${address}/${suffix}`,
    headers: callers[caller], ...(body === undefined ? {} : { payload: body }) });
}

// The escrow chain routes check the caller, the escrow and the submitted value.
describe("escrow chain writes check the caller, the escrow and the submitted value", () => {
  beforeEach(async () => {
    vi.stubEnv("PCC_DB_PATH", ":memory:");
    vi.stubEnv("PCC_ADMIN_KEY", ADMIN);
    initStore({ seed: false });
    vi.clearAllMocks();
    seen.length = 0;
    lock.held = 0;
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(withSignerLock).mockImplementation(async fn => {
      lock.held += 1;
      try { return await fn(); } finally { lock.held -= 1; }
    });
    for (const name of directNames) {
      vi.mocked(chain[name]).mockImplementation(async () => {
        seen.push({ fn: name, held: lock.held });
        return { transactionHash: UID, status: "submitted" } as never;
      });
    }
    for (const name of facadeNames) {
      facadeSpies[name] = vi.spyOn(getSettlementFacade(), name).mockImplementation(async () => {
        seen.push({ fn: name, held: lock.held });
        return { success: true, data: { transactionHash: UID, status: "submitted", action: name } } as never;
      });
    }
    invokeSpies = Object.values(activityFor).map(activity => vi.spyOn(activity, "invoke"));
    seedRows();
    app = Fastify({ logger: false });
    app.addHook("onRequest", async req => {
      const principal = req.headers["x-test-principal"];
      if (typeof principal === "string") {
        (req as any).operatorId = principal;
        (req as any).apiKeyId = `key-${principal}`;
      }
      const wallet = req.headers["x-test-proven-wallet"];
      if (typeof wallet === "string") {
        (req as any).provenWallet = wallet.toLowerCase();
        (req as any).provenWalletVia = "siwe-session";
        (req as any).provenWalletCarrier = "key";
      }
    });
    await app.register(escrowRoutes);
    await app.ready();
  });
  afterEach(async () => {
    await app.close(); closeStore(); closeWorkflowStore(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  });

  it("A1 a caller without the gateway admin secret is refused on every escrow chain write, on both flag branches, before any chain or activity call", async () => {
    for (const route of routes) for (const flag of flags) for (const caller of ["operator", "wrong-secret", "buyer"] as const) {
      fresh();
      const res = await call(route, V2, caller, flag);
      expect(res.statusCode, context).toBe(403);
      expect(res.json(), context).toEqual(ADMIN_REQUIRED);
      nothingRan();
    }
  });
  it("A2 the admin check runs before the escrow lookup: no secret is 403 for an unknown address and for an unreadable registry", async () => {
    for (const route of routes) for (const flag of flags) {
      fresh();
      const res = await call(route, UNKNOWN, "operator", flag);
      expect(res.statusCode, context).toBe(403);
      expect(res.json(), context).toEqual(ADMIN_REQUIRED);
      nothingRan();
    }
    closeStore();
    for (const route of routes) for (const flag of flags) {
      fresh();
      const res = await call(route, V2, "operator", flag);
      expect(res.statusCode, context).toBe(403);
      expect(res.json(), context).toEqual(ADMIN_REQUIRED);
      nothingRan();
    }
  });
  it("P1 the admin gets the not-found reply for an unknown escrow address, with no chain or activity call", async () => {
    for (const route of routes) for (const flag of flags) {
      fresh();
      const res = await call(route, UNKNOWN, "admin", flag);
      expect(res.statusCode, context).toBe(404);
      expect(res.json(), context).toEqual(NOT_FOUND);
      nothingRan();
    }
  });
  it("P2 the admin gets 503 when the escrow registry is unreadable: no write falls back to V2", async () => {
    closeStore();
    for (const route of routes) for (const flag of flags) {
      fresh();
      const res = await call(route, V2, "admin", flag);
      expect(res.statusCode, context).toBe(503);
      expect(res.json(), context).toEqual(LOOKUP_UNAVAILABLE);
      nothingRan();
    }
  });
  it("P3 the admin gets 409 for a buyer-funded escrow on every escrow chain write", async () => {
    for (const route of routes) for (const flag of flags) {
      fresh();
      const res = await call(route, BF, "admin", flag);
      expect(res.statusCode, context).toBe(409);
      expect(res.json(), context).toEqual(BUYER_FUNDED);
      nothingRan();
    }
  });
  it("P4 the admin gets 409 for an unsupported escrow version on every escrow chain write", async () => {
    for (const route of routes) for (const flag of flags) {
      fresh();
      const res = await call(route, V9, "admin", flag);
      expect(res.statusCode, context).toBe(409);
      expect(res.json(), context).toEqual(VERSION_UNKNOWN);
      nothingRan();
    }
  });
  it("W1 the admin's fund, dispute and deposit-bond writes run once, inside the signer lock", async () => {
    for (const route of ["fund", "dispute", "deposit-bond"] as const) for (const address of [V2, V3]) {
      fresh();
      const body = defaultBody(route, address, "false");
      const res = await call(route, address, "admin", "false", body);
      const fn = facadeFor[route];
      expect(res.statusCode, context).toBe(200);
      expect(activityFor[route].invoke, context).toHaveBeenCalledOnce();
      expect(withSignerLock, context).toHaveBeenCalledOnce();
      expect(seen, context).toEqual([{ fn, held: 1 }]);
      expect(facadeSpies[fn].mock.calls[0][0], context).toBe(address);
      if (route !== "fund") expect(facadeSpies[fn].mock.calls[0][1], context).toBe(0);
      if (route === "dispute") expect(facadeSpies[fn].mock.calls[0][2], context).toEqual(body);
    }
  });
  it("W2 release dispatches by escrow version on the V2 flag and through its activity on the V1 flag, inside the signer lock", async () => {
    for (const flag of flags) for (const address of [V2, V3]) {
      fresh();
      const body = defaultBody("release", address, flag);
      const res = await call("release", address, "admin", flag, body);
      expect(res.statusCode, context).toBe(200);
      expect(withSignerLock, context).toHaveBeenCalledOnce();
      if (flag === "true") {
        const fn = address === V3 ? "releaseMilestoneV3" : "releaseMilestoneV2";
        expect(seen, context).toEqual([{ fn, held: 1 }]);
        expect(chain[fn], context).toHaveBeenCalledWith(0, address);
        expect(chain[address === V3 ? "releaseMilestoneV2" : "releaseMilestoneV3"], context).not.toHaveBeenCalled();
        expect(res.json().path, context).toBe(address === V3 ? "eas-v3-mode-b" : "eas-v2");
      } else {
        expect(seen, context).toEqual([{ fn: "releaseMilestone", held: 1 }]);
        expect(facadeSpies.releaseMilestone.mock.calls[0].slice(0, 3), context).toEqual([address, 0, body?.attestation]);
        expect(activities.releaseMilestoneActivity.invoke, context).toHaveBeenCalledOnce();
      }
    }
  });
  it("W3 attestation dispatches by escrow version on the V2 flag and through the facade on the V1 flag, inside the signer lock", async () => {
    for (const flag of flags) for (const address of [V2, V3]) {
      fresh();
      const body = defaultBody("attestation", address, flag);
      const res = await call("attestation", address, "admin", flag, body);
      expect(res.statusCode, context).toBe(200);
      expect(withSignerLock, context).toHaveBeenCalledOnce();
      if (flag === "true") {
        const fn = address === V3 ? "submitAttestationV3" : "submitAttestationV2";
        expect(seen, context).toEqual([{ fn, held: 1 }]);
        expect(chain[fn], context).toHaveBeenCalledWith(0, UID, address);
        expect(chain[address === V3 ? "submitAttestationV2" : "submitAttestationV3"], context).not.toHaveBeenCalled();
        expect(res.json().path, context).toBe(address === V3 ? "eas-v3-mode-b" : "eas-v2");
      } else {
        expect(seen, context).toEqual([{ fn: "submitAttestation", held: 1 }]);
        expect(facadeSpies.submitAttestation.mock.calls[0].slice(0, 3), context).toEqual([address, 0, body?.attestation]);
      }
    }
  });
  it("W4 evidence relays the pinned bundle in its chain form, inside the signer lock, on both flag branches", async () => {
    for (const address of [V2, V3]) for (const flag of flags)
      for (const hash of [chainOf(address), "0x" + chainOf(address).slice(2).toUpperCase()]) {
        fresh();
        const res = await call("evidence", address, "admin", flag, { evidenceBundleHash: hash });
        expect(res.statusCode, context).toBe(200);
        expect(withSignerLock, context).toHaveBeenCalledOnce();
        if (flag === "true") {
          expect(seen, context).toEqual([{ fn: "submitEvidenceV2", held: 1 }]);
          expect(chain.submitEvidenceV2, context).toHaveBeenCalledWith(0, chainOf(address), address);
        } else {
          expect(seen, context).toEqual([{ fn: "submitEvidenceHash", held: 1 }]);
          expect(facadeSpies.submitEvidenceHash.mock.calls[0].slice(0, 3), context).toEqual([address, 0, chainOf(address)]);
          expect(activities.submitEvidenceActivity.invoke, context).toHaveBeenCalledOnce();
        }
      }
  });
  it("H1 evidence refuses a hash that is not the escrow's pinned bundle, for the admin too, with no chain call", async () => {
    for (const flag of flags) for (const hash of ["0x" + "ee".repeat(32), "0x" + "f2".repeat(32), "sha256:" + "a2".repeat(32), "a2".repeat(32), "0x" + "a2".repeat(31)]) {
      fresh();
      const res = await call("evidence", V2, "admin", flag, { evidenceBundleHash: hash });
      expect(res.statusCode, context).toBe(409);
      expect(res.json(), context).toEqual(MISMATCH);
      nothingRan();
    }
  });
  it("H2 evidence refuses when the escrow names no single job with a pinned bundle", async () => {
    for (const flag of flags) for (const [address, hash] of [
      ...[NOSESSION, NOJOB, NOTPINNED, PINMISSING].map(address => [address, "0x" + "a2".repeat(32)]),
      [TWO, "0x" + "b1".repeat(32)], [TWO, "0x" + "b2".repeat(32)],
    ]) {
      fresh();
      const res = await call("evidence", address, "admin", flag, { evidenceBundleHash: hash });
      expect(res.statusCode, context).toBe(409);
      expect(res.json(), context).toEqual(NOT_PINNED);
      nothingRan();
    }
  });
  it("H3 two sessions that name the same job count as one job", async () => {
    fresh();
    const res = await call("evidence", SAME, "admin", "true", { evidenceBundleHash: "0x" + "c1".repeat(32) });
    expect(res.statusCode, context).toBe(200);
    expect(chain.submitEvidenceV2, context).toHaveBeenCalledOnce();
    expect(chain.submitEvidenceV2, context).toHaveBeenCalledWith(0, "0x" + "c1".repeat(32), SAME);
  });
  it("an evidence hash that isn't a string is refused as a bad request", async () => {
    for (const flag of flags) for (const { kind, body } of [
      { kind: "array", body: { evidenceBundleHash: ["0x" + "a2".repeat(32)] } },
      { kind: "number", body: { evidenceBundleHash: 42 } },
      { kind: "object", body: { evidenceBundleHash: { h: "0x" + "a2".repeat(32) } } },
    ]) {
      fresh();
      const res = await call("evidence", V2, "admin", flag, body as any);
      context += `, body=${kind}`;
      expect(res.statusCode, context).toBe(400);
      expect(res.json(), context).toEqual({ error: "evidenceBundleHash is required" });
      nothingRan();
    }
  });
  it("I1 a refused call takes no idempotency key: the admin's call right after it succeeds", async () => {
    for (const route of ["fund", "dispute", "deposit-bond", "release", "evidence"] as const) {
      fresh();
      const refused = await call(route, V2, "operator", "false");
      expect(refused.statusCode, context).toBe(403);
      nothingRan();
      const accepted = await call(route, V2, "admin", "false");
      expect(accepted.statusCode, context).toBe(200);
      expect(JSON.stringify(accepted.json()), context).not.toContain("IdempotencyMismatchError");
      expect(seen, context).toEqual([{ fn: facadeFor[route], held: 1 }]);
    }
  });
  it("O1 the parameter checks still answer first", async () => {
    for (const route of routes) for (const flag of flags) {
      fresh();
      const res = await call(route, "not-an-address", "operator", flag);
      expect(res.statusCode, context).toBe(400);
      expect(res.json(), context).toEqual({ error: "Invalid address" });
      nothingRan();
    }
    for (const flag of flags) {
      fresh();
      const res = await call("evidence", V2, "operator", flag, {});
      expect(res.statusCode, context).toBe(400);
      expect(res.json(), context).toEqual({ error: "evidenceBundleHash is required" });
      nothingRan();
    }
  });
  it("O2 on the V2 flag, the write-disabled reply comes after the caller and escrow checks", async () => {
    vi.mocked(chain.isWriteEnabled).mockReturnValue(false);
    for (const route of ["release", "evidence", "attestation"] as const) {
      fresh();
      const refused = await call(route, V2, "operator", "true");
      expect(refused.statusCode, context).toBe(403);
      expect(refused.json(), context).toEqual(ADMIN_REQUIRED);
      nothingRan();
      fresh();
      const unknown = await call(route, UNKNOWN, "admin", "true");
      expect(unknown.statusCode, context).toBe(404);
      expect(unknown.json(), context).toEqual(NOT_FOUND);
      nothingRan();
      fresh();
      const disabled = await call(route, V2, "admin", "true");
      expect(disabled.statusCode, context).toBe(503);
      expect(disabled.json().error, context).toBe("write_disabled");
      nothingRan();
    }
  });
});
