/**
 * F3 under concurrency (found 2026-09-29 while answering readmodels #3714).
 *
 * POST /api/contributors/quickstart decides the identity (fresh, self, refuse)
 * BEFORE it awaits the wallet provider, then mints the key. Two concurrent
 * quickstarts for one unclaimed email both passed the decision across that
 * await, so both minted a key: two parties holding one identity. A claim through
 * /api/auth/provision landing during the await did the same. A fresh claim is
 * now decided again right before the insert, with nothing awaited in between;
 * the loser gets 409 and nothing else.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { provisionRoutes } from "../routes/provision.js";
import { contributorRoutes } from "../routes/contributors.js";
import { apiGate } from "../middleware/api-gate.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { initJobOffersStore, _resetJobOffersStoreForTests } from "../services/job-offers-store.js";
import { ADMIN_IDENTITY_ALLOWLIST_ENV_VARS } from "../auth/reserved-identities.js";

/** Holds each quickstart at the wallet call until `expected` requests have reached it (or release()). */
const hold = vi.hoisted(() => ({
  expected: 0,
  arrived: 0,
  release: (() => {}) as () => void,
  gate: Promise.resolve() as Promise<void>,
}));

vi.mock("../auth/embedded-wallet.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../auth/embedded-wallet.js")>();
  const demo = new real.DemoWalletAdapter();
  return {
    ...real,
    getEmbeddedWalletAdapter: () => ({
      providerId: demo.providerId,
      isProduction: false,
      async createWalletForEmail(email: string) {
        if (hold.expected > 0) {
          hold.arrived += 1;
          if (hold.arrived >= hold.expected) hold.release();
          await hold.gate;
        }
        return demo.createWalletForEmail(email);
      },
    }),
  };
});
vi.mock("../telemetry.js", () => ({ pipelineTelemetry: { emit: vi.fn() } }));
vi.mock("../services/audit-service.js", () => ({ auditService: { log: vi.fn() } }));
vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../middleware/security-hardening.js", () => ({
  canProvision: vi.fn(() => true),
  canSiweVerify: vi.fn(() => true),
  canSiweNonce: vi.fn(() => true),
}));

let app: FastifyInstance;
let seq = 0;
const fresh = (tag: string) => `${tag}-${Date.now().toString(36)}-${++seq}@x.test`;

beforeAll(async () => {
  for (const name of ADMIN_IDENTITY_ALLOWLIST_ENV_VARS) delete process.env[name];
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  _resetJobOffersStoreForTests();
  initJobOffersStore({});
  app = Fastify({ logger: false });
  await app.register(cookie, { secret: "test-only-cookie-secret-do-not-use-in-prod" });
  await app.register(apiGate);
  await app.register(siweAuthPlugin);
  await app.register(provisionRoutes);
  await app.register(contributorRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeStore();
  _resetJobOffersStoreForTests();
});

/** Hold the next quickstarts at the wallet call; released when `n` have arrived, by release(), or after 5 s. */
function holdNext(n: number): void {
  hold.expected = n;
  hold.arrived = 0;
  hold.gate = new Promise<void>((resolve) => {
    hold.release = resolve;
    setTimeout(resolve, 5_000);
  });
}

/** A key for some other, unclaimed identity (quickstart sits behind apiGate). */
async function callerKey(): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/provision", payload: { email: fresh("caller") } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().api_key as string;
}

const quickstart = (email: string, bearer: string) =>
  app.inject({
    method: "POST",
    url: "/api/contributors/quickstart",
    payload: { email, role: "model-author", ratePercent: 1 },
    headers: { authorization: `Bearer ${bearer}` },
  });

/** Active keys stored for an identity, compared case-insensitively. */
const keysOf = (id: string) =>
  getRepos().apiKeys.listActive().filter((k) => k.operatorId.trim().toLowerCase() === id.trim().toLowerCase());

describe("F3: quickstart's identity decision holds across its wallet await", () => {
  it("[neg] two concurrent quickstarts for one unclaimed email: one key; the other gets 409 and no wallet or key", async () => {
    const email = fresh("race");
    const [a, b] = [await callerKey(), await callerKey()];
    holdNext(2);
    const [r1, r2] = await Promise.all([quickstart(email, a), quickstart(email, b)]);
    hold.expected = 0;
    // Both reached the wallet call, so both passed the FIRST decision: the 409 is the second one's.
    expect(hold.arrived).toBe(2);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([201, 409]);
    const loser = r1.statusCode === 409 ? r1 : r2;
    expect(loser.json().error).toBe("identity_claimed");
    expect(loser.json().apiKey).toBeUndefined();
    expect(loser.json().walletAddress).toBeUndefined();
    expect(loser.json().mnemonic).toBeUndefined();
    expect(keysOf(email)).toHaveLength(1);
  });

  it("[neg] the identity is claimed through /api/auth/provision while quickstart awaits its wallet: 409, no second key", async () => {
    const email = fresh("race-provision");
    const caller = await callerKey();
    holdNext(Number.POSITIVE_INFINITY);
    const pending = quickstart(email, caller);
    for (let i = 0; hold.arrived < 1; i += 1) {
      expect(i, "quickstart never reached the wallet call").toBeLessThan(10_000);
      await new Promise((r) => setImmediate(r));
    }
    const winner = await app.inject({ method: "POST", url: "/api/auth/provision", payload: { email } });
    expect(winner.statusCode, winner.body).toBe(201);
    hold.release();
    const res = await pending;
    hold.expected = 0;
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().apiKey).toBeUndefined();
    expect(keysOf(email)).toHaveLength(1);
  });

  it("control: two concurrent quickstarts by the identity ITSELF (self-delegation) both succeed", async () => {
    const email = fresh("self-race");
    const first = await quickstart(email, await callerKey());
    expect(first.statusCode, first.body).toBe(201);
    const own = first.json().apiKey as string;
    holdNext(2);
    const [r1, r2] = await Promise.all([quickstart(email, own), quickstart(email, own)]);
    hold.expected = 0;
    expect(hold.arrived).toBe(2);
    expect([r1.statusCode, r2.statusCode]).toEqual([201, 201]);
    expect(keysOf(email)).toHaveLength(3);
  });

  it("control: an uncontended quickstart for an unclaimed email still succeeds", async () => {
    const email = fresh("solo");
    const res = await quickstart(email, await callerKey());
    expect(res.statusCode, res.body).toBe(201);
    expect(keysOf(email)).toHaveLength(1);
  });
});
