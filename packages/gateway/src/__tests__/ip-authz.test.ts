import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { randomUUID } from "node:crypto";
import { schema, sql } from "@pcc/store";
import { getLicensingEngine, resetStoryIPService, StoryIPService } from "@pcc/contracts";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { closeStore, getRepos, getStore, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import { __resetScopeCacheForTests, scopeChecker } from "../middleware/scope-checker.js";
import { kernelRoutes } from "../routes/kernels.js";
import { capabilityRoutes } from "../routes/capabilities.js";
import { ipRoutes } from "../routes/ip.js";
import { EVM_A, EVM_B } from "./helpers/kernel-registration-fixture.js";

vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../middleware/security-hardening.js", () => ({ canProvision: () => true, canSiweVerify: () => true }));

const OWNER = EVM_A.address.toLowerCase();
const OTHER = EVM_B.address.toLowerCase();
const ADMIN_SECRET = "n10a-admin-secret";
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
// Literal expectations keep these cells independent of the new ownership module, including red-before.
const bodies = {
  authentication_required: { error: "authentication_required", message: "This operator action needs an API key or a signed-in wallet." },
  explicit_credential_required: { error: "explicit_credential_required", message: "This decision needs an API key or a session key in the Authorization header; the sign-in cookie alone can't authorize it." },
  ip_owner_unknown: { error: "ip_owner_unknown", message: "No owner is recorded for this IP, so no one can change it, the gateway admin included." },
  wallet_proof_required: { error: "wallet_proof_required", message: "This IP action needs a proven wallet. Sign in with the wallet, then send a session key or the session token in the Authorization header." },
  not_kernel_operator: { error: "not_kernel_operator", message: "Only the recorded operator of this kernel can register its IP." },
  not_ip_owner: { error: "not_ip_owner", message: "Only the recorded owner of this IP can set its licensing terms." },
  designer_must_be_owner: { error: "designer_must_be_owner", message: "designerAddress must be the recorded owner of this IP." },
  operator_must_be_owner: { error: "operator_must_be_owner", message: "operatorAddress must be the recorded operator of this job's kernel." },
  not_parent_owner: { error: "not_parent_owner", message: "The parent IP's recorded owner is not this job's operator." },
  capability_not_found: { error: "capability_not_found", message: "No capability with this id is recorded, so it can't be registered as an IP." },
  job_not_found: { error: "job_not_found", message: "No job with this id is recorded." },
  capability_kernel_mismatch: { error: "capability_kernel_mismatch", message: "capability.kernelId is not the kernel recorded for this capability." },
  parent_not_job_capability: { error: "parent_not_job_capability", message: "parentIpId must be the IP registered for this job's own capability." },
  already_registered: { error: "already_registered", message: "This is already registered, or its registration is in progress." },
  registration_not_recorded: { error: "registration_not_recorded", message: "The gateway couldn't record this IP registration, so it doesn't count as registered. Try again." },
  derivative_not_recorded: { error: "derivative_not_recorded", message: "The gateway couldn't record this job's derivative link, so it doesn't count as registered. Try again." },
  read_failed: { error: "read_failed", message: "The gateway couldn't read the records that say who owns this IP. Try again shortly." },
};
type Refusal = keyof typeof bodies;
const callers = ["ADMIN", "OWNER_KEY", "OWNER_BEARER", "OWNER_COOKIE", "CLAIMED", "STRANGER", "ANON"] as const;
type Caller = typeof callers[number];
const actions = ["register-capability", "register-job-evidence", "set-licensing-terms", "dispute"] as const;
type Action = typeof actions[number];
let apps: FastifyInstance[];

beforeEach(() => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
  vi.stubEnv("PCC_ADMIN_KEY", ADMIN_SECRET);
  for (const name of ["DATABASE_URL", "RAILWAY_VOLUME_MOUNT_PATH", "PCC_GATEWAY_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "POSTHOG_API_KEY", "VITE_POSTHOG_KEY", "PCC_WILDCARD_KEY_MIGRATION", "PCC_WILDCARD_KEY_KEEP_IDS", "PCC_WILDCARD_KEY_REVOKE_IDS", "CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET", "LIT_API_KEY", "PRIVY_APP_ID", "PRIVY_APP_SECRET"]) {
    vi.stubEnv(name, "");
    delete process.env[name];
  }
  vi.stubEnv("LIT_API_KEY", randomUUID());
  vi.stubEnv("STORY_MOCK", "true");
  resetStoryIPService();
  closeStore();
  initStore({ seed: false });
  __resetScopeCacheForTests();
  apps = [];
});
afterEach(async () => {
  for (const app of apps) await app.close();
  closeStore();
  resetStoryIPService();
  __resetScopeCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function buildApp(noGate = false) {
  const app = Fastify({ logger: false });
  apps.push(app);
  if (!noGate) {
    app.decorateRequest("userId", null);
    app.decorateRequest("apiKeyId", null);
    app.decorateRequest("operatorId", null);
    await app.register(cookie, { secret: "n176-signed-session-cookie-secret" });
    await app.register(apiGate);
    await app.register(scopeChecker);
    await app.register(siweAuthPlugin);
    await app.register(kernelRoutes);
    await app.register(capabilityRoutes);
  }
  await app.register(ipRoutes);
  await app.ready();
  return app;
}
// Copy n176's real EIP-4361 nonce/signature flow; do not import another test file.
async function signIn(app: FastifyInstance, account = EVM_A) {
  const host = "localhost";
  const nonce = await app.inject({ url: "/api/auth/nonce", headers: { host } });
  expect(nonce.statusCode, nonce.body).toBe(200);
  const message = [
    `${host} wants you to sign in with your Ethereum account:`, account.address.toLowerCase(),
    "", "Sign in to PCC.", "", `URI: http://${host}`, "Version: 1", "Chain ID: 8453",
    `Nonce: ${nonce.json().nonce}`, `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
  const response = await app.inject({ method: "POST", url: "/api/auth/verify", headers: { host },
    payload: { message, signature: await account.signMessage({ message }) } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ token: string }>();
}
async function credentials(app: FastifyInstance): Promise<Record<Caller, Record<string, string>>> {
  const owner = await signIn(app);
  const stranger = await signIn(app, EVM_B);
  async function key(token: string) {
    const minted = await app.inject({ method: "POST", url: "/api/auth/session-key", headers: bearer(token) });
    expect(minted.statusCode, minted.body).toBe(201);
    return bearer(minted.json<{ api_key: string }>().api_key);
  }
  return {
    ADMIN: { ...bearer(provisionApiKey({ operatorId: "n10a-admin-ops" }).rawKey), "x-admin-key": ADMIN_SECRET },
    OWNER_KEY: await key(owner.token), OWNER_BEARER: bearer(owner.token),
    OWNER_COOKIE: { cookie: `pcc_session=${app.signCookie(owner.token)}` },
    CLAIMED: bearer(provisionApiKey({ operatorId: OWNER }).rawKey), STRANGER: await key(stranger.token), ANON: {},
  };
}
async function kernel(app: FastifyInstance, headers: Record<string, string>, id = "n10a-k") {
  const res = await app.inject({ method: "POST", url: "/api/kernels", headers, payload: { id, name: "N10a recorded operator" } });
  expect(res.statusCode, res.body).toBe(201);
  return id;
}
async function capability(app: FastifyInstance, headers: Record<string, string>, kernelId: string, id = "n10a-c") {
  const payload = { id, kernelId, name: "N10a capability", type: "fdm-printer" };
  const res = await app.inject({ method: "POST", url: "/api/capabilities", headers, payload });
  expect(res.statusCode, res.body).toBe(201);
  expect(getRepos().capabilities.findById(id)).toBeDefined();
  return payload;
}
function job(kernelId: string, capabilityId: string, id = "n10a-j") {
  return getRepos().jobs.insert({ id, kernelId, capabilityId, stepId: `step-${id}`, cwmId: `cwm-${id}`, status: "completed", assignedDevices: [] });
}
const capBody = (cap: { id: string; kernelId: string; name: string; type: string }, designerAddress = OWNER) => ({ capability: cap, designerAddress, designerName: "Recorded designer" });
const jobBody = (parentIpId: string, jobId = "n10a-j", operatorAddress = OWNER) => ({ parentIpId, jobId, operatorAddress, operatorName: "Recorded operator", evidenceBundleHash: "sha256:n10a" });
const termsBody = (ipId: string, designerAddress = OWNER) => ({ ipId, designerAddress, autoLicense: {
  minRevSharePercent: 5, minAssuranceTier: 0, allowedCapabilityTypes: ["fdm-printer"], allowedKinds: ["base"],
  cloneThreshold: 0.9, derivativeThreshold: 0.9, commercialUse: true, allowedRegions: ["US"],
}, standingOffers: [], defaultRevShare: 5, allowSubDerivatives: true, derivativeDecayRate: 0.5 });
const disputeBody = { evidenceHash: "sha256:disputed", reason: "N10a evidence disputed" };
async function register(app: FastifyInstance, headers: Record<string, string>, cap: Parameters<typeof capBody>[0], designer = OWNER) {
  const res = await app.inject({ method: "POST", url: "/api/ip/register-capability", headers, payload: capBody(cap, designer) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ registration: { ipId: string } }>().registration.ipId;
}
async function owned() {
  const app = await buildApp();
  const headers = await credentials(app);
  const k = await kernel(app, headers.OWNER_KEY);
  const cap = await capability(app, headers.OWNER_KEY, k);
  job(k, cap.id);
  const ip = await register(app, headers.OWNER_KEY, cap);
  const derivative = await app.inject({ method: "POST", url: "/api/ip/register-job-evidence", headers: headers.OWNER_KEY, payload: jobBody(ip) });
  expect(derivative.statusCode, derivative.body).toBe(200);
  const child = derivative.json<{ link: { childIpId: string } }>().link.childIpId;
  const freshCap = await capability(app, headers.OWNER_KEY, k, "n10a-fresh-c");
  job(k, cap.id, "n10a-fresh-j");
  const terms = await app.inject({ method: "POST", url: "/api/ip/set-licensing-terms", headers: headers.OWNER_KEY, payload: { ...termsBody(ip), defaultRevShare: 7 } });
  expect(terms.statusCode, terms.body).toBe(200);
  return { app, headers, k, cap, ip, child, freshCap };
}
type Fixture = Awaited<ReturnType<typeof owned>>;
function request(f: Fixture, action: Action, ip = f.ip): { url: string; payload: Record<string, unknown> } {
  if (action === "register-capability") return { url: "/api/ip/register-capability", payload: capBody(f.freshCap) };
  if (action === "register-job-evidence") return { url: "/api/ip/register-job-evidence", payload: jobBody(f.ip, "n10a-fresh-j") };
  if (action === "set-licensing-terms") return { url: "/api/ip/set-licensing-terms", payload: termsBody(ip) };
  return { url: `/api/ip/${ip}/dispute`, payload: disputeBody };
}
function spies() {
  return [vi.spyOn(StoryIPService.prototype, "registerCapabilityAsIP"), vi.spyOn(StoryIPService.prototype, "registerJobAsDerivative"),
    vi.spyOn(StoryIPService.prototype, "raiseDispute"), vi.spyOn(getLicensingEngine(), "setTerms")];
}
function counts() {
  return { registrations: getRepos().story.listIpRegistrations().length,
    links: getStore().db.select().from(schema.storyDerivativeLinks).all().length };
}
async function refuse(f: Fixture, caller: Caller, action: Action, error: Refusal | "api_key_required", status = 403, req = request(f, action)) {
  const calls = spies();
  const calledBefore = calls.map(spy => spy.mock.calls.length);
  const before = counts();
  const termsUrl = `/api/ip/${String(req.payload.ipId ?? f.ip)}/licensing-terms`;
  const prior = action === "set-licensing-terms" ? await f.app.inject({ url: termsUrl, headers: f.headers.OWNER_KEY }) : null;
  const res = await f.app.inject({ method: "POST", ...req, headers: f.headers[caller] });
  expect(res.statusCode, res.body).toBe(status);
  if (error === "api_key_required") expect(res.json().error).toBe("api_key_required");
  else expect(res.json()).toEqual(bodies[error]);
  calls.forEach((spy, i) => expect(spy).toHaveBeenCalledTimes(calledBefore[i]));
  expect(counts()).toEqual(before);
  if (prior) {
    const after = await f.app.inject({ url: termsUrl, headers: f.headers.OWNER_KEY });
    expect(after.statusCode).toBe(prior.statusCode);
    expect(after.json()).toEqual(prior.json());
  }
  return res;
}
function recordIp(ipId: string, capabilityId: string | null) {
  getRepos().story.insertIpRegistration({ ipId, capabilityId, nftTokenId: "1", licenseTermsId: "1", txHash: "0xfixture", csdUrl: "pcc://fixture", chain: "story-aeneid", registeredAt: new Date().toISOString() });
}
function recordLink(parentIpId: string, childIpId: string, jobId: string | null) {
  getRepos().story.insertDerivativeLink({ id: randomUUID(), parentIpId, childIpId, jobId, licenseTokenId: "1", evidenceBundleHash: "sha256:fixture", txHash: "0xfixture", linkedAt: new Date().toISOString() });
}

describe("A1 owned-IP caller matrix (S1)", () => {
  it.each(callers.flatMap(caller => actions.map(action => ({ caller, action }))))("$caller / $action", async ({ caller, action }) => {
    const f = await owned();
    if (caller === "ANON") return void await refuse(f, caller, action, "api_key_required", 401);
    if (caller === "OWNER_COOKIE") return void await refuse(f, caller, action, "explicit_credential_required");
    if (caller === "CLAIMED" || (caller === "ADMIN" && action === "dispute")) return void await refuse(f, caller, action, "wallet_proof_required");
    if (caller === "STRANGER" && action !== "dispute") return void await refuse(f, caller, action, action === "set-licensing-terms" ? "not_ip_owner" : "not_kernel_operator");
    const res = await f.app.inject({ method: "POST", ...request(f, action), headers: f.headers[caller] });
    expect(res.statusCode, res.body).toBe(200);
    if (action === "dispute") expect(res.json().raisedBy).toBe(caller === "STRANGER" ? OTHER : OWNER);
  });
  it.each(["set-licensing-terms", "dispute"] as const)("owned derivative / %s", async action => {
    const f = await owned();
    const res = await f.app.inject({ method: "POST", ...request(f, action, f.child), headers: f.headers.OWNER_KEY });
    expect(res.statusCode, res.body).toBe(200);
    if (action === "dispute") expect(res.json().raisedBy).toBe(OWNER);
  });
});

describe("A2 ownerless-IP caller matrix", () => {
  const states = ["S2-null-capability", "S3-zero", "S3-empty", "S4-non-wallet", "S5-capability-gone", "S6-null-job", "S6-two-links", "unknown", "S6-job-gone", "kernel-gone"] as const;
  const cells = states.flatMap(state => actions.filter(action =>
    action === "set-licensing-terms" || action === "dispute" || ["S3-zero", "S3-empty", "S4-non-wallet"].includes(state),
  ).flatMap(action => (["ADMIN", "OWNER_KEY", "CLAIMED", "STRANGER", "OWNER_COOKIE", "ANON"] as const).map(caller => ({ state, action, caller }))));
  it.each(cells)("$state / $caller / $action", async ({ state, caller, action }) => {
    const f = await owned();
    let ip = "0x3333333333333333333333333333333333333333";
    if (state === "S2-null-capability") recordIp(ip, null);
    else if (state === "S3-zero" || state === "S3-empty" || state === "S4-non-wallet") {
      getRepos().kernels.update(f.k, { operatorAddress: state === "S3-zero" ? "0x0000000000000000000000000000000000000000" : state === "S3-empty" ? "" : "ops-team" });
      ip = f.ip;
    } else if (state === "S5-capability-gone" || state === "kernel-gone" || state === "S6-job-gone") {
      getStore().db.run(sql`PRAGMA foreign_keys = OFF`);
      try {
        if (state === "S5-capability-gone") recordIp(ip, "n10a-no-capability");
        else if (state === "S6-job-gone") recordLink(f.ip, ip, "n10a-no-job");
        else { getStore().db.run(sql`DELETE FROM shop_kernels WHERE id = ${f.k}`); ip = f.ip; }
      } finally { getStore().db.run(sql`PRAGMA foreign_keys = ON`); }
    } else if (state === "S6-null-job") recordLink(f.ip, ip, null);
    else if (state === "S6-two-links") { recordLink(f.ip, ip, "n10a-j"); recordLink(f.ip, ip, "n10a-fresh-j"); }
    const error = caller === "ANON" ? "api_key_required" : caller === "OWNER_COOKIE" ? "explicit_credential_required" : "ip_owner_unknown";
    await refuse(f, caller, action, error, caller === "ANON" ? 401 : 403, request(f, action, ip));
  });
});

describe("A3 required records", () => {
  it.each(["capability_not_found", "capability_kernel_mismatch", "job_not_found"] as const)("%s", async error => {
    const f = await owned();
    const action = error === "job_not_found" ? "register-job-evidence" : "register-capability";
    const req = error === "job_not_found" ? { url: "/api/ip/register-job-evidence", payload: jobBody(f.ip, "missing-job") }
      : { url: "/api/ip/register-capability", payload: capBody({ ...f.freshCap, ...(error === "capability_not_found" ? { id: "missing-cap" } : { kernelId: "body-kernel" }) }) };
    await refuse(f, "OWNER_KEY", action, error, error === "capability_kernel_mismatch" ? 409 : 404, req);
  });
});

describe("A4 once-only registrations", () => {
  it.each(["register-capability", "register-job-evidence"] as const)("%s / sequential duplicate", async action => {
    const f = await owned();
    const spy = vi.spyOn(StoryIPService.prototype, action === "register-capability" ? "registerCapabilityAsIP" : "registerJobAsDerivative");
    const before = counts();
    const first = await f.app.inject({ method: "POST", ...request(f, action), headers: f.headers.OWNER_KEY });
    expect(first.statusCode, first.body).toBe(200);
    await refuse(f, "OWNER_KEY", action, "already_registered", 409);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(counts()).toEqual({ registrations: before.registrations + (action === "register-capability" ? 1 : 0), links: before.links + (action === "register-job-evidence" ? 1 : 0) });
    if (action === "register-capability") expect(getRepos().story.listIpRegistrations().filter(row => row.capabilityId === f.freshCap.id)).toHaveLength(1);
    else expect(getRepos().story.findDerivativeLinksByJob("n10a-fresh-j")).toHaveLength(1);
  });
  it.each(["register-capability", "register-job-evidence"] as const)("%s / concurrent duplicate", async action => {
    const f = await owned();
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const method = action === "register-capability" ? "registerCapabilityAsIP" : "registerJobAsDerivative";
    const original = StoryIPService.prototype[method];
    let entries = 0;
    const spy = vi.spyOn(StoryIPService.prototype, method).mockImplementation(async function (this: StoryIPService, ...args: unknown[]) {
      entered();
      // A missing in-flight guard must fail promptly rather than leave both requests waiting.
      if (++entries > 1) release();
      await barrier;
      return Reflect.apply(original, this, args);
    });
    const before = counts();
    // .then starts light-my-request's lazy promise before the barrier is observed.
    const first = f.app.inject({ method: "POST", ...request(f, action), headers: f.headers.OWNER_KEY }).then(res => res);
    await started;
    const second = f.app.inject({ method: "POST", ...request(f, action), headers: f.headers.OWNER_KEY }).then(res => res);
    try {
      const refused = await second;
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toEqual(bodies.already_registered);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(counts()).toEqual(before);
    } finally { release(); }
    const results = await Promise.all([first, second]);
    expect(results.map(res => res.statusCode).sort()).toEqual([200, 409]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(counts()).toEqual({ registrations: before.registrations + (action === "register-capability" ? 1 : 0), links: before.links + (action === "register-job-evidence" ? 1 : 0) });
  });
});

describe("A5 body addresses and parent ownership", () => {
  it.each((["OWNER_KEY", "ADMIN"] as const).flatMap(caller => (["register-capability", "set-licensing-terms"] as const).map(action => ({ caller, action }))))("$caller / $action / designer must be owner", async ({ caller, action }) => {
    const f = await owned();
    const req = request(f, action);
    req.payload.designerAddress = OTHER;
    await refuse(f, caller, action, "designer_must_be_owner", 403, req);
  });
  it.each(["OWNER_KEY", "ADMIN"] as const)("%s / operator must be owner", async caller => {
    const f = await owned();
    await refuse(f, caller, "register-job-evidence", "operator_must_be_owner", 403, { url: "/api/ip/register-job-evidence", payload: jobBody(f.ip, "n10a-fresh-j", OTHER) });
  });
  it("another IP of the same owner is not the job's capability parent", async () => {
    const f = await owned();
    const otherIp = await register(f.app, f.headers.OWNER_KEY, f.freshCap);
    await refuse(f, "OWNER_KEY", "register-job-evidence", "parent_not_job_capability", 409, { url: "/api/ip/register-job-evidence", payload: jobBody(otherIp, "n10a-fresh-j") });
  });
  it("a job's kernel operator must also own its capability parent", async () => {
    const f = await owned();
    const k = await kernel(f.app, f.headers.STRANGER, "n10a-other-k");
    const cap = await capability(f.app, f.headers.STRANGER, k, "n10a-other-c");
    const parentIp = await register(f.app, f.headers.STRANGER, cap, OTHER);
    job(f.k, cap.id, "n10a-cross-kernel-j");
    await refuse(f, "OWNER_KEY", "register-job-evidence", "not_parent_owner", 403, { url: "/api/ip/register-job-evidence", payload: jobBody(parentIp, "n10a-cross-kernel-j") });
  });
});

describe("A6 registrations require recorded rows", () => {
  it.each(["register-capability", "register-job-evidence"] as const)("%s / failed insert hides result and retry succeeds", async action => {
    const f = await owned();
    const marker = "N10A-INSERT-PRIVATE-MARKER";
    const before = counts();
    const persist = action === "register-capability" ? vi.spyOn(getRepos().story, "insertIpRegistration") : vi.spyOn(getRepos().story, "insertDerivativeLink");
    persist.mockImplementationOnce(() => { throw new Error(marker); });
    const res = await f.app.inject({ method: "POST", ...request(f, action), headers: f.headers.OWNER_KEY });
    expect(res.statusCode, res.body).toBe(500);
    expect(res.json()).toEqual(bodies[action === "register-capability" ? "registration_not_recorded" : "derivative_not_recorded"]);
    expect(res.body).not.toContain(marker);
    expect(counts()).toEqual(before);
    if (action === "register-capability") {
      const get = await f.app.inject({ url: `/api/ip/capability/${f.freshCap.id}`, headers: f.headers.OWNER_KEY });
      expect(get.statusCode, get.body).toBe(404);
      expect(get.json()).toEqual({ error: "ip_registration_not_found" });
    }
    persist.mockRestore();
    const retry = await f.app.inject({ method: "POST", ...request(f, action), headers: f.headers.OWNER_KEY });
    expect(retry.statusCode, retry.body).toBe(200);
    if (action === "register-capability") expect(getRepos().story.findIpByCapabilityId(f.freshCap.id)).toBeDefined();
    else expect(getRepos().story.findDerivativeLinksByJob("n10a-fresh-j")).toHaveLength(1);
  });
  it.each(["register-capability", "register-job-evidence"] as const)("%s / falsy insert is not recorded", async action => {
    const f = await owned();
    const persist = action === "register-capability" ? vi.spyOn(getRepos().story, "insertIpRegistration") : vi.spyOn(getRepos().story, "insertDerivativeLink");
    persist.mockReturnValueOnce(undefined);
    const before = counts();
    const res = await f.app.inject({ method: "POST", ...request(f, action), headers: f.headers.OWNER_KEY });
    expect(res.statusCode, res.body).toBe(500);
    expect(res.json()).toEqual(bodies[action === "register-capability" ? "registration_not_recorded" : "derivative_not_recorded"]);
    expect(counts()).toEqual(before);
  });
  it("GET capability confirms that the recorded row names the requested capability", async () => {
    const f = await owned();
    vi.spyOn(StoryIPService.prototype, "getIPRegistration").mockResolvedValueOnce({ ipId: f.ip } as Awaited<ReturnType<StoryIPService["getIPRegistration"]>>);
    const res = await f.app.inject({ url: `/api/ip/capability/${f.freshCap.id}`, headers: f.headers.OWNER_KEY });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json()).toEqual({ error: "ip_registration_not_found" });
  });
});

describe("A7 store reads fail closed", () => {
  it("capabilities.findById / register-capability", async () => {
    const f = await owned();
    vi.spyOn(getRepos().capabilities, "findById").mockImplementationOnce(() => { throw new Error("N10A-READ-PRIVATE-MARKER"); });
    const res = await refuse(f, "OWNER_KEY", "register-capability", "read_failed", 503);
    expect(res.body).not.toContain("N10A-READ-PRIVATE-MARKER");
  });
  it("story.findIpById / set-licensing-terms", async () => {
    const f = await owned();
    vi.spyOn(getRepos().story, "findIpById").mockImplementationOnce(() => { throw new Error("N10A-READ-PRIVATE-MARKER"); });
    const res = await refuse(f, "OWNER_KEY", "set-licensing-terms", "read_failed", 503);
    expect(res.body).not.toContain("N10A-READ-PRIVATE-MARKER");
  });
  it("confirm story.findIpById / GET capability", async () => {
    const f = await owned();
    const before = counts();
    vi.spyOn(getRepos().story, "findIpById").mockImplementationOnce(() => { throw new Error("N10A-READ-PRIVATE-MARKER"); });
    const res = await f.app.inject({ url: `/api/ip/capability/${f.cap.id}`, headers: f.headers.OWNER_KEY });
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json()).toEqual(bodies.read_failed);
    expect(res.body).not.toContain("N10A-READ-PRIVATE-MARKER");
    expect(counts()).toEqual(before);
  });
});

describe("A8 anonymous writes without a gate", () => {
  it.each(actions)("%s / authentication required", async action => {
    const app = await buildApp(true);
    const calls = spies();
    const before = counts();
    const ip = "0x1111111111111111111111111111111111111111";
    const payload = action === "register-capability" ? capBody({ id: "c", name: "C", type: "fdm-printer", kernelId: "k" })
      : action === "register-job-evidence" ? jobBody(ip) : action === "set-licensing-terms" ? termsBody(ip) : disputeBody;
    const url = action === "dispute" ? `/api/ip/${ip}/dispute` : `/api/ip/${action}`;
    const prior = action === "set-licensing-terms" ? await app.inject({ url: `/api/ip/${ip}/licensing-terms` }) : null;
    const res = await app.inject({ method: "POST", url, payload });
    expect(res.statusCode, res.body).toBe(401);
    expect(res.json()).toEqual(bodies.authentication_required);
    calls.forEach(spy => expect(spy).not.toHaveBeenCalled());
    expect(counts()).toEqual(before);
    if (prior) expect((await app.inject({ url: `/api/ip/${ip}/licensing-terms` })).json()).toEqual(prior.json());
  });
});

describe("A9 mixed-case recorded owner (S7)", () => {
  it.each([EVM_A.address, OWNER])("designer %s is accepted and Story receives lowercase", async designer => {
    const f = await owned();
    getRepos().kernels.update(f.k, { operatorAddress: EVM_A.address });
    const spy = vi.spyOn(StoryIPService.prototype, "registerCapabilityAsIP");
    await register(f.app, f.headers.OWNER_KEY, f.freshCap, designer);
    expect(spy).toHaveBeenCalledWith(f.freshCap, expect.objectContaining({ designerAddress: OWNER }));
  });
});

describe("A10 E24 claimed kernel owner needs wallet proof", () => {
  it("CLAIMED records EVM_A; only the proven OWNER_KEY acts on all four writes", async () => {
    const app = await buildApp();
    const headers = await credentials(app);
    const k = await kernel(app, headers.CLAIMED);
    expect(getRepos().kernels.findById(k)?.operatorAddress).toBe(OWNER);
    const cap = await capability(app, headers.CLAIMED, k);
    job(k, cap.id);
    const f: Fixture = { app, headers, k, cap, freshCap: cap, ip: "0x4444444444444444444444444444444444444444", child: "" };
    await refuse(f, "CLAIMED", "register-capability", "wallet_proof_required");
    f.ip = await register(app, headers.OWNER_KEY, cap);
    const req = { url: "/api/ip/register-job-evidence", payload: jobBody(f.ip) };
    await refuse(f, "CLAIMED", "register-job-evidence", "wallet_proof_required", 403, req);
    const derivative = await app.inject({ method: "POST", ...req, headers: headers.OWNER_KEY });
    expect(derivative.statusCode, derivative.body).toBe(200);
    await refuse(f, "CLAIMED", "set-licensing-terms", "wallet_proof_required");
    const terms = await app.inject({ method: "POST", ...request(f, "set-licensing-terms"), headers: headers.OWNER_KEY });
    expect(terms.statusCode, terms.body).toBe(200);
    await refuse(f, "CLAIMED", "dispute", "wallet_proof_required");
    const dispute = await app.inject({ method: "POST", ...request(f, "dispute"), headers: headers.OWNER_KEY });
    expect(dispute.statusCode, dispute.body).toBe(200);
    expect(dispute.json().raisedBy).toBe(OWNER);
  });
});

describe("A11 E24b capability creator and admin act for the recorded operator", () => {
  it("STRANGER creates C2 on the owner's kernel; OWNER_KEY and ADMIN act for EVM_A", async () => {
    const f = await owned();
    const c2 = await capability(f.app, f.headers.STRANGER, f.k, "n10a-c2");
    for (const designer of [OTHER, OWNER]) await refuse(f, "STRANGER", "register-capability", "not_kernel_operator", 403, { url: "/api/ip/register-capability", payload: capBody(c2, designer) });
    const ip = await register(f.app, f.headers.OWNER_KEY, c2);
    const spy = vi.spyOn(StoryIPService.prototype, "registerCapabilityAsIP");
    await register(f.app, f.headers.ADMIN, f.freshCap, EVM_A.address);
    expect(spy).toHaveBeenLastCalledWith(f.freshCap, expect.objectContaining({ designerAddress: OWNER }));
    await refuse(f, "STRANGER", "set-licensing-terms", "not_ip_owner", 403, request(f, "set-licensing-terms", ip));
    const terms = await f.app.inject({ method: "POST", url: "/api/ip/set-licensing-terms", headers: f.headers.ADMIN, payload: termsBody(ip, EVM_A.address) });
    expect(terms.statusCode, terms.body).toBe(200);
    const get = await f.app.inject({ url: `/api/ip/${ip}/licensing-terms`, headers: f.headers.OWNER_KEY });
    expect(get.statusCode).toBe(200);
    expect(get.json().terms.designerAddress).toBe(OWNER);
  });
});
