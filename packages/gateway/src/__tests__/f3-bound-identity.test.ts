/**
 * F3 bound-identity mark (readmodels #3714; decision #3713 option b).
 *
 * Email keys minted under identity binding carry a server-written mark
 * (metadata.identityBinding). apiGate exposes it as req.boundIdentity, next to
 * req.provenWallet, so a read gate CAN choose to accept bound email keys without
 * trusting legacy ones:
 *   - a FRESH claim (the identity was unclaimed at mint) is a root;
 *   - a delegation is marked only when the delegating key carries the mark;
 *   - a delegation from a LEGACY (unmarked) key is never marked: before binding,
 *     several parties could hold keys for the same string.
 * The mark proves first claim under binding, NOT control of the mailbox.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { provisionRoutes } from "../routes/provision.js";
import { contributorRoutes } from "../routes/contributors.js";
import { apiGate } from "../middleware/api-gate.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { provisionApiKey, hashApiKey, boundIdentityOfKey } from "../auth/api-key-auth.js";
import { initJobOffersStore, _resetJobOffersStoreForTests } from "../services/job-offers-store.js";
import { ADMIN_IDENTITY_ALLOWLIST_ENV_VARS } from "../auth/reserved-identities.js";

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
/** A fresh, never-used identity per test (the store is shared by the file). */
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
  // A gated probe and a public one (GET under the public /api/health prefix).
  const probe = async (req: import("fastify").FastifyRequest) => ({
    boundIdentity: req.boundIdentity,
    provenWallet: req.provenWallet,
  });
  app.get("/api/_test/whoami", probe);
  app.get("/api/health/_test-whoami", probe);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeStore();
  _resetJobOffersStoreForTests();
});

/** POST /api/auth/provision {email}; returns the raw key (the route answers `api_key`). */
async function provision(email: string, bearer?: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/provision",
    payload: { email },
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().api_key as string;
}

/** POST /api/contributors/quickstart (behind apiGate: the caller presents a key); returns the new key (`apiKey`). */
async function quickstart(email: string, bearer: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/contributors/quickstart",
    payload: { email, role: "model-author", ratePercent: 1 },
    headers: { authorization: `Bearer ${bearer}` },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().apiKey as string;
}

async function whoami(key: string, url = "/api/_test/whoami") {
  const res = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${key}` } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { boundIdentity: string | null; provenWallet: string | null };
}

/** The stored mark of a raw key, read back from the row the route wrote. */
function markOf(key: string): Record<string, unknown> | undefined {
  const row = getRepos().apiKeys.findActiveByHash(hashApiKey(key));
  expect(row).toBeTruthy();
  const meta = JSON.parse(String(row!.metadata ?? "{}")) as { identityBinding?: Record<string, unknown> };
  return meta.identityBinding;
}

describe("F3 bound-identity mark: minted only for a fresh claim or a marked lineage", () => {
  it("a FRESH email claim is marked as a root; apiGate exposes it as req.boundIdentity, never as a proven wallet", async () => {
    const email = fresh("root");
    const key = await provision(email);
    expect(await whoami(key)).toEqual({ boundIdentity: email, provenWallet: null });
    expect(markOf(key)).toEqual({ kind: "f3_email", id: email, root: true });
  });

  it("a delegation from a MARKED key is marked too, naming its parent", async () => {
    const email = fresh("chain");
    const first = await provision(email);
    const second = await provision(email, first);
    expect((await whoami(second)).boundIdentity).toBe(email);
    const parentId = getRepos().apiKeys.findActiveByHash(hashApiKey(first))!.id;
    expect(markOf(second)).toEqual({ kind: "f3_email", id: email, root: false, parentKeyId: parentId });
  });

  it("[neg] a LEGACY key (minted before binding: no mark) is not bound, and neither is any key it delegates", async () => {
    const email = fresh("legacy");
    const { rawKey } = provisionApiKey({ operatorId: email, scopes: ["operator"], metadata: { source: "landing-page" } });
    expect((await whoami(rawKey)).boundIdentity).toBeNull();
    const child = await provision(email, rawKey);
    expect((await whoami(child)).boundIdentity).toBeNull();
    expect(markOf(child)).toBeUndefined();
    // ...and the lineage stays unmarked however deep it goes.
    const grandchild = await provision(email, child);
    expect((await whoami(grandchild)).boundIdentity).toBeNull();
  });

  it("the contributors quickstart marks a fresh claim, and a delegation from that key", async () => {
    const caller = await provision(fresh("qs-caller"));
    const email = fresh("quick");
    const key = await quickstart(email, caller);
    expect(await whoami(key)).toEqual({ boundIdentity: email, provenWallet: null });
    expect(markOf(key)).toEqual({ kind: "f3_email", id: email, root: true });
    const again = await quickstart(email, key);
    expect((await whoami(again)).boundIdentity).toBe(email);
    expect(markOf(again)).toMatchObject({ root: false });
  });

  it("[neg] a SIWE-proven key is a proven wallet, not a bound email identity", async () => {
    const wallet = "0x1234567890abcdef1234567890abcdef12345678";
    const { rawKey } = provisionApiKey({
      operatorId: wallet,
      scopes: ["operator"],
      metadata: { siweVerified: true, provenAddress: wallet },
    });
    expect(await whoami(rawKey)).toEqual({ boundIdentity: null, provenWallet: wallet });
  });

  it("[neg] on a public route apiGate resolves no key, so nothing is bound", async () => {
    const key = await provision(fresh("public"));
    expect((await whoami(key, "/api/health/_test-whoami")).boundIdentity).toBeNull();
  });
});

describe("boundIdentityOfKey: null unless the key's own server-written mark names its operatorId", () => {
  const mark = (identityBinding: unknown) => JSON.stringify({ identityBinding });

  it.each<[string, unknown]>([
    ["names another identity", mark({ kind: "f3_email", id: "someone-else@x.test", root: true })],
    ["has another kind", mark({ kind: "siwe", id: "me@x.test", root: true })],
    ["has no id", mark({ kind: "f3_email", root: true })],
    ["is not an object", mark("f3_email")],
    ["is an array", mark([{ kind: "f3_email", id: "me@x.test" }])],
    ["is absent", JSON.stringify({ source: "landing-page" })],
    ["is not JSON", "{not json"],
    ["is not a string column", { identityBinding: { kind: "f3_email", id: "me@x.test", root: true } }],
  ])("[neg] the mark %s -> null", (_name, metadata) => {
    expect(boundIdentityOfKey({ operatorId: "me@x.test", metadata })).toBeNull();
  });

  it("[neg] a key with no operatorId, or no record, is never bound", () => {
    const metadata = mark({ kind: "f3_email", id: "", root: true });
    expect(boundIdentityOfKey({ operatorId: "", metadata })).toBeNull();
    expect(boundIdentityOfKey(null)).toBeNull();
    expect(boundIdentityOfKey(undefined)).toBeNull();
  });

  it("control: a mark naming the key's own operatorId (same identity after normalization) returns the stored operatorId", () => {
    const metadata = mark({ kind: "f3_email", id: " Me@X.test ", root: true });
    expect(boundIdentityOfKey({ operatorId: "me@x.test", metadata })).toBe("me@x.test");
  });
});
