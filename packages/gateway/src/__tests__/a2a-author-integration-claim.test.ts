/**
 * N73 (steward #3819): the A2A `pcc-author-integration` skill registers a kernel
 * OWNED BY THE AUTHENTICATED CALLER, never by a body field. The same fix as WP-C
 * R6 (ff33eaf4), folded into WP-A because F3 made shop_kernels.operator_address a
 * CLAIM source (auth/reserved-identities.ts, isClaimedIdentity).
 *
 * Before: the skill called KernelFacade.register with
 * `operatorAddress: p.operatorAddress ?? "a2a-operator"` and no actor, so a new
 * kernel's owner came from the request body. Any key of any scope, or a bare SIWE
 * session, could name an UNCLAIMED email as the owner. That email was then
 * claimed for good: its real holder's POST /api/auth/provision {email} got 409
 * identity_claimed, and a claim is never released (R2). Reproduced at 0ad0e60d
 * before any code changed.
 *
 * The file imports only modules that exist before the fix, so it runs unchanged
 * against the old routes/a2a-tasks.ts: every [neg] case fails there.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { a2aTasksRoutes, __resetA2ATasksForTest } from "../routes/a2a-tasks.js";
import { provisionRoutes } from "../routes/provision.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { isClaimedIdentity } from "../auth/reserved-identities.js";
import { closeStore, getRepos, initStore } from "../db.js";

let app: FastifyInstance;
let callerKey: string;
let walletToken: string;
const CALLER = "n73-a2a-caller@x.test";
const WALLET = "0x73a2a00000000000000000000000000000000073";
const savedAuthFlag = process.env.PCC_A2A_AUTH_DISABLED;

let seq = 0;
let ipSeq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
/** A fresh email nobody has claimed: no key, no kernel, no registration. */
const unclaimedEmail = () => `${uid("n73-victim")}@x.test`;

const asCaller = () => ({ authorization: `Bearer ${callerKey}` });
const asWallet = () => ({ authorization: `Bearer ${walletToken}` });

async function authorIntegration(params: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: "/a2a/tasks/send",
    headers: { "content-type": "application/json", ...headers },
    payload: JSON.stringify({
      jsonrpc: "2.0",
      id: uid("rpc"),
      method: "tasks/send",
      params: { skill: "pcc-author-integration", params },
    }),
  });
}

/** The real holder of `email` asks for a key for it (the unverified email path). */
const provisionEmail = (email: string) =>
  app.inject({
    method: "POST",
    url: "/api/auth/provision",
    remoteAddress: `10.73.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
    payload: { email },
  });

const kernelsNamed = (name: string) => getRepos().kernels.findAll().filter((k) => k.name === name);

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  callerKey = provisionApiKey({ operatorId: CALLER, scopes: ["operator"] }).rawKey;
  // A bare SIWE session (no API key): the A2A gate accepts it as a caller.
  walletToken = randomBytes(24).toString("hex");
  const now = new Date();
  getRepos().sessions.insert({
    id: uid("n73-session"),
    walletAddress: WALLET,
    token: walletToken,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    lastActiveAt: now.toISOString(),
  });
  // No apiGate: /a2a/* is outside /api/ and resolves its own auth.
  app = Fastify({ logger: false });
  await app.register(a2aTasksRoutes);
  await app.register(provisionRoutes);
  await app.ready();
});

afterEach(() => {
  __resetA2ATasksForTest();
  if (savedAuthFlag === undefined) delete process.env.PCC_A2A_AUTH_DISABLED;
  else process.env.PCC_A2A_AUTH_DISABLED = savedAuthFlag;
});

afterAll(async () => {
  await app.close();
  closeStore();
});

describe("N73: pcc-author-integration binds the kernel to the authenticated caller, so it cannot claim someone else's identity", () => {
  it("[neg] a key holder that names an unclaimed email as operatorAddress owns the kernel itself; the email stays unclaimed and its holder can still provision it", async () => {
    delete process.env.PCC_A2A_AUTH_DISABLED; // the production gate is on
    const victim = unclaimedEmail();
    expect(isClaimedIdentity(victim)).toBe(false);

    const res = await authorIntegration(
      { lane: "machine", name: uid("N73 Diner"), type: uid("n73-type"), operatorAddress: victim },
      asCaller(),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().result?.state, res.body).toBe("COMPLETED");
    const kernelId = res.json().result.artifacts[0].data.kernelId as string;

    expect(getRepos().kernels.findById(kernelId)?.operatorAddress).toBe(CALLER);
    expect(res.json().result.artifacts[0].data.operatorAddress).toBe(CALLER);
    expect(isClaimedIdentity(victim)).toBe(false);
    const provision = await provisionEmail(victim);
    expect(provision.statusCode, provision.body).not.toBe(409);
    expect(provision.statusCode, provision.body).toBeLessThan(300);
  });

  it("[neg] a bare SIWE session is judged the same way: the wallet owns the kernel, the named email is not claimed", async () => {
    delete process.env.PCC_A2A_AUTH_DISABLED;
    const victim = unclaimedEmail();
    const res = await authorIntegration(
      { lane: "machine", name: uid("N73 Wallet"), type: uid("n73-wallet-type"), operatorAddress: victim },
      asWallet(),
    );
    expect(res.json().result?.state, res.body).toBe("COMPLETED");
    const kernelId = res.json().result.artifacts[0].data.kernelId as string;
    expect(getRepos().kernels.findById(kernelId)?.operatorAddress).toBe(WALLET);
    expect(isClaimedIdentity(victim)).toBe(false);
  });

  it("[neg] with operatorAddress omitted, the kernel is the caller's, not the placeholder \"a2a-operator\" that no key holds", async () => {
    delete process.env.PCC_A2A_AUTH_DISABLED;
    const name = uid("N73 Default");
    const res = await authorIntegration({ lane: "machine", name, type: uid("n73-default-type") }, asCaller());
    expect(res.json().result?.state, res.body).toBe("COMPLETED");
    const rows = kernelsNamed(name);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operatorAddress).toBe(CALLER);
  });

  it("[neg] with PCC_A2A_AUTH_DISABLED and NO credentials the skill is refused: nothing is registered and nothing is claimed", async () => {
    process.env.PCC_A2A_AUTH_DISABLED = "true";
    const victim = unclaimedEmail();
    const name = uid("N73 Anonymous");
    const type = uid("n73-anon-type");
    const res = await authorIntegration({ lane: "machine", name, type, operatorAddress: victim });
    expect(res.statusCode).toBe(200); // JSON-RPC carries errors in the body
    expect(res.json().result).toBeUndefined();
    expect(res.json().error?.code).toBe(-32600);
    expect(res.json().error?.message).toMatch(/authentication required/i);
    expect(kernelsNamed(name)).toEqual([]);
    expect(getRepos().capabilities.findByType(type)).toEqual([]);
    expect(isClaimedIdentity(victim)).toBe(false);
  });

  it("[neg] with PCC_A2A_AUTH_DISABLED the owner still comes from the caller's key, never from the body", async () => {
    process.env.PCC_A2A_AUTH_DISABLED = "true";
    const victim = unclaimedEmail();
    const name = uid("N73 Keyed");
    const res = await authorIntegration(
      { lane: "human", name, type: uid("n73-keyed-type"), operatorAddress: victim },
      asCaller(),
    );
    expect(res.json().result?.state, res.body).toBe("COMPLETED");
    const rows = kernelsNamed(name);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operatorAddress).toBe(CALLER);
    expect(isClaimedIdentity(victim)).toBe(false);
  });

  it("control: an authenticated caller onboards: a new kernel is registered and the capability is published on it", async () => {
    delete process.env.PCC_A2A_AUTH_DISABLED;
    const type = uid("n73-cap-type");
    const res = await authorIntegration({ lane: "machine", name: uid("N73 Printer"), type }, asCaller());
    expect(res.json().result?.state, res.body).toBe("COMPLETED");
    const data = res.json().result.artifacts[0].data;
    expect(getRepos().kernels.findById(data.kernelId)).toBeTruthy();
    expect(data.capability.kernelId).toBe(data.kernelId);
    expect(getRepos().capabilities.findByType(type)).toHaveLength(1);
  });
});
