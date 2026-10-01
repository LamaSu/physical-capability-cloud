/**
 * Forward compatibility for accepted-deal v3's sealed-deal read (it ships
 * separately; nothing here serves a sealed deal). Two things are reserved now so
 * that the v3 change cannot be undercut by what is already live:
 *
 *   1. `sealed_deal_read` is a scope a legacy "*" key does NOT carry. A wildcard
 *      key cannot delegate it through callerMayDelegate, exactly like settlement,
 *      admin and operator (SCOPES_NOT_CARRIED_BY_WILDCARD).
 *   2. Operator ids that start with "svc:" are service principals (svc:vcr,
 *      svc:oracle). Their keys are issued by the operator out of band, so the
 *      unverified self-service paths (POST /api/auth/provision {email}, POST
 *      /api/contributors/quickstart) must never mint one. A "svc:" identity is
 *      ALWAYS claimed: the same 409 identity_claimed a claimed identity gets,
 *      with no hint, whatever the database holds, whatever the casing, and even
 *      for a caller holding a key of that very identity (no self-delegation:
 *      service keys are re-issued out of band, like an admin's).
 *
 * Reproduced at c800283c before any code changed. The file imports only modules
 * and exports that exist there.
 *
 * Reachability, stated plainly: both paths check the email's SHAPE before they
 * ask about the identity. POST /api/auth/provision accepts any local part
 * (/^[^\s@]+@[^\s@]+\.[^\s@]+$/), so "svc:vcr@x.test" reaches the rule and is
 * a 409; a bare "svc:vcr" has no "@" and is a 400 invalid_email first. The
 * quickstart's zod .email() rejects a ":" in the local part, so it answers 400
 * invalid_request to every svc: spelling before the rule is asked. The rule
 * itself (isClaimedIdentity, decideUnverifiedIdentity: the one decision both
 * paths share) is therefore also asserted directly, where the bare ids from the
 * spec, "svc:vcr" and "SVC:Oracle", are decided.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { provisionRoutes } from "../routes/provision.js";
import { contributorRoutes } from "../routes/contributors.js";
import {
  ADMIN_IDENTITY_ALLOWLIST_ENV_VARS,
  IDENTITY_CLAIMED_RESPONSE,
  callerMayDelegate,
  decideUnverifiedIdentity,
  isClaimedIdentity,
} from "../auth/reserved-identities.js";
import { SCOPES_NOT_CARRIED_BY_WILDCARD } from "../middleware/scope-checker.js";
import { normalizeIdentity } from "../auth/identity-normalize.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { generateApiKey } from "../auth/api-key-auth.js";

vi.mock("../telemetry.js", () => ({ pipelineTelemetry: { emit: vi.fn() } }));
vi.mock("../services/audit-service.js", () => ({ auditService: { log: vi.fn() } }));
vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../middleware/security-hardening.js", () => ({
  canProvision: vi.fn(() => true),
  canSiweVerify: vi.fn(() => true),
  canSiweNonce: vi.fn(() => true),
}));

const SEALED = "sealed_deal_read";

/** ASCII to its fullwidth compatibility form (U+FF01..U+FF5E): NFKC folds it back, so it names the same identity. */
const fullwidth = (s: string) => [...s].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join("");

describe("sealed_deal_read is not carried by a legacy wildcard", () => {
  it("[neg] it is among the scopes a wildcard does not carry", () => {
    expect(SCOPES_NOT_CARRIED_BY_WILDCARD.has(SEALED)).toBe(true);
  });

  it("[neg] a legacy \"*\" key cannot delegate sealed_deal_read", () => {
    expect(callerMayDelegate(["*"], [SEALED])).toEqual([]);
  });

  it("[neg] asked for next to ordinary scopes, the wildcard delegates the ordinary ones and not this one", () => {
    expect(callerMayDelegate(["*"], ["contributor:read", SEALED, "schedule:read"])).toEqual([
      "contributor:read",
      "schedule:read",
    ]);
  });

  it("[neg] a key that holds a DIFFERENT explicit scope next to \"*\" still cannot delegate it", () => {
    expect(callerMayDelegate(["*", "operator", "contributor:read"], [SEALED])).toEqual([]);
  });

  it("control: a key that holds sealed_deal_read explicitly may delegate it, with or without \"*\"", () => {
    expect(callerMayDelegate([SEALED], [SEALED])).toEqual([SEALED]);
    expect(callerMayDelegate(["*", SEALED], [SEALED])).toEqual([SEALED]);
  });

  it("control: nothing else was narrowed: the wildcard still carries ordinary scopes and still does not carry money, admin or operator", () => {
    expect(callerMayDelegate(["*"], ["contributor:read"])).toEqual(["contributor:read"]);
    for (const scope of ["settlement", "admin", "operator"]) {
      expect(callerMayDelegate(["*"], [scope]), scope).toEqual([]);
      expect(SCOPES_NOT_CARRIED_BY_WILDCARD.has(scope), scope).toBe(true);
    }
  });
});

describe("svc: identities are never claimable through the unverified provision paths", () => {
  let app: FastifyInstance;
  let seq = 0;
  const fresh = (tag: string) => `${tag}-${Date.now().toString(36)}-${++seq}`;
  const saved: Record<string, string | undefined> = {};
  const clearAllowlists = () => {
    for (const name of ADMIN_IDENTITY_ALLOWLIST_ENV_VARS) delete process.env[name];
  };

  beforeAll(async () => {
    for (const name of ADMIN_IDENTITY_ALLOWLIST_ENV_VARS) saved[name] = process.env[name];
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    app = Fastify({ logger: false });
    await app.register(cookie, { secret: "test-only-cookie-secret-do-not-use-in-prod" });
    await app.register(siweAuthPlugin);
    await app.register(provisionRoutes);
    await app.register(contributorRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
    for (const name of ADMIN_IDENTITY_ALLOWLIST_ENV_VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  beforeEach(clearAllowlists);
  afterEach(clearAllowlists);

  const provision = (email: string, bearer?: string) =>
    app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: { email },
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    });

  const quickstart = (email: string) =>
    app.inject({
      method: "POST",
      url: "/api/contributors/quickstart",
      payload: { email, role: "model-author", ratePercent: 1 },
    });

  /** Active keys for an identity under the identity fold (whatever spelling was minted). */
  const keysFor = (id: string) =>
    getRepos()
      .apiKeys.listActive()
      .filter((k) => normalizeIdentity(k.operatorId) === normalizeIdentity(id)).length;

  /** A key row inserted directly: how the operator issues a service key out of band. */
  function seedKey(operatorId: string, scopes: string[]): string {
    const { rawKey, keyHash, keyPrefix } = generateApiKey();
    getRepos().apiKeys.insert({
      id: `svc-key-${++seq}`,
      keyHash,
      keyPrefix,
      operatorId,
      scopes: JSON.stringify(scopes),
      rateLimit: "1000/hour",
      usageCount: "0",
      createdAt: new Date().toISOString(),
    } as never);
    return rawKey;
  }

  /** The least a request needs for decideUnverifiedIdentity: the Bearer header. */
  const reqWith = (bearer?: string) =>
    ({ headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }) as unknown as FastifyRequest;

  // ── The rule itself (bare ids included) ───────────────────────────
  it("[neg] isClaimedIdentity: a svc: identity is claimed with nothing in the database, in any casing, padding or compatibility spelling", () => {
    for (const id of [
      "svc:vcr",
      "SVC:Oracle",
      "Svc:Anything-At-All",
      "  svc:vcr  ",
      "\tsvc:vcr\n",
      fullwidth("svc:vcr"), // NFKC folds it to "svc:vcr"
      `svc:${fresh("never-seen")}@x.test`,
    ]) {
      expect(isClaimedIdentity(id), JSON.stringify(id)).toBe(true);
    }
  });

  it("isClaimedIdentity does not over-match: only the PREFIX \"svc:\" makes an identity a service identity", () => {
    for (const id of ["svc", "svcs:vcr", "my-svc:vcr", "xsvc:vcr", "svc.vcr", "svc-vcr", `${fresh("a.svc")}@x.test`, `${fresh("b")}@svc.test`]) {
      expect(isClaimedIdentity(id), id).toBe(false);
    }
  });

  it("[neg] decideUnverifiedIdentity refuses a svc: identity: with no key, with a stranger's key, and with the identity's OWN key", () => {
    const ghost = `svc:${fresh("ghost")}@x.test`;
    expect(decideUnverifiedIdentity(reqWith(), ghost).kind).toBe("refuse");
    expect(decideUnverifiedIdentity(reqWith(), "SVC:Oracle").kind).toBe("refuse");

    const strangerKey = seedKey(fresh("stranger") + "@x.test", ["operator"]);
    expect(decideUnverifiedIdentity(reqWith(strangerKey), ghost).kind).toBe("refuse");

    // The identity's own key: an ordinary claimed identity would be "self" here
    // (a delegated key). A service identity is re-issued out of band instead.
    const own = `svc:${fresh("own")}@x.test`;
    const ownKey = seedKey(own, ["operator"]);
    expect(decideUnverifiedIdentity(reqWith(ownKey), own).kind).toBe("refuse");
    expect(decideUnverifiedIdentity(reqWith(ownKey), own.toUpperCase()).kind).toBe("refuse");
  });

  it("control: an ordinary identity is still fresh when unclaimed, and still delegates to its own key", () => {
    const ordinary = `${fresh("ordinary")}@x.test`;
    expect(decideUnverifiedIdentity(reqWith(), ordinary).kind).toBe("fresh");
    const key = seedKey(ordinary, ["operator"]);
    expect(decideUnverifiedIdentity(reqWith(key), ordinary).kind).toBe("self");
  });

  // ── Over HTTP: POST /api/auth/provision ───────────────────────────
  it("[neg] provisioning a svc: identity is 409 identity_claimed, whatever the casing, padding or spelling, and nothing is minted", async () => {
    // A fresh suffix per run: the identity must be refused because it is a
    // service identity, not because an earlier test happened to mint it.
    const n = fresh("vcr");
    for (const email of [
      `svc:${n}@x.test`,
      `SVC:${n}-oracle@x.test`,
      `Svc:Mixed.Case.${n}@X.TEST`,
      `  svc:${n}-padded@x.test  `,
      `${fullwidth("svc:")}${n}-fullwidth@x.test`,
    ]) {
      const res = await provision(email);
      expect(res.statusCode, `${JSON.stringify(email)}: ${res.body}`).toBe(409);
      expect(res.json().error).toBe("identity_claimed");
      expect(res.json().api_key).toBeUndefined();
      expect(keysFor(email), JSON.stringify(email)).toBe(0);
    }
  });

  it("[neg] the bare ids from the spec, svc:vcr and SVC:Oracle, are refused too and mint nothing", async () => {
    for (const email of ["svc:vcr", "SVC:Oracle"]) {
      const res = await provision(email);
      // 400 invalid_email (the shape check runs first) or 409 identity_claimed: never a key.
      expect([400, 409], `${email}: ${res.body}`).toContain(res.statusCode);
      expect(res.json().api_key, email).toBeUndefined();
      expect(keysFor(email), email).toBe(0);
    }
  });

  it("[neg] the refusal is IDENTICAL to a claimed identity's: it never says the identity is a service identity", async () => {
    const claimed = `${fresh("claimed")}@x.test`;
    expect((await provision(claimed)).statusCode).toBe(201);
    const claimedRes = await provision(claimed);
    const svcRes = await provision(`svc:${fresh("vcr")}@x.test`);
    expect(claimedRes.statusCode).toBe(409);
    expect(svcRes.statusCode).toBe(409);
    expect(svcRes.body).toBe(claimedRes.body);
    expect(svcRes.json()).toEqual(IDENTITY_CLAIMED_RESPONSE);
    expect(svcRes.body).not.toContain("svc");
    expect(svcRes.headers["content-type"]).toBe(claimedRes.headers["content-type"]);
  });

  it("[neg] the holder of a key of that very identity cannot delegate another one: 409, no new key", async () => {
    const own = `svc:${fresh("holder")}@x.test`;
    const ownKey = seedKey(own, ["operator"]);
    expect(keysFor(own)).toBe(1);
    const res = await provision(own, ownKey);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe("identity_claimed");
    expect(keysFor(own)).toBe(1);
    const respelled = await provision(own.toUpperCase(), ownKey);
    expect(respelled.statusCode, respelled.body).toBe(409);
    expect(keysFor(own)).toBe(1);
  });

  it("control: an ordinary email still provisions (201, [\"operator\"]), and so do emails that merely CONTAIN svc", async () => {
    for (const email of [
      `${fresh("ordinary")}@x.test`,
      `${fresh("svcteam")}@x.test`,
      `team.svc.${fresh("ops")}@x.test`,
      `${fresh("ops")}@svc.test`,
    ]) {
      const res = await provision(email);
      expect(res.statusCode, `${email}: ${res.body}`).toBe(201);
      expect(res.json().scopes).toEqual(["operator"]);
    }
  });

  // ── Over HTTP: POST /api/contributors/quickstart ──────────────────
  it("[neg] the contributor quickstart never mints a svc: identity either", async () => {
    const n = fresh("vcr");
    for (const email of [`svc:${n}@x.test`, `SVC:${n}-oracle@x.test`, "svc:vcr", "SVC:Oracle"]) {
      const res = await quickstart(email);
      // 409 identity_claimed from the identity rule, or 400 invalid_request from
      // the email shape check that runs before it: never a key, never a 2xx.
      expect([400, 409], `${email}: ${res.body}`).toContain(res.statusCode);
      expect(keysFor(email), email).toBe(0);
    }
  });

  it("control: the quickstart still serves an ordinary email", async () => {
    const res = await quickstart(`${fresh("contributor")}@x.test`);
    expect(res.statusCode, res.body).toBe(201);
  });
});
