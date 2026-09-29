/**
 * No wildcard minting (WP-A A6, MUST-CLOSE 6).
 *
 * `provisionApiKey` used to write `JSON.stringify(opts.scopes ?? ["*"])`, so any
 * caller that omitted `scopes` minted a wildcard key — and a wildcard key used to
 * bypass the entire scope layer, money path included. Scopes are now required
 * and a wildcard is refused at mint time, before the lock or the DB is touched.
 *
 * Every caller of provisionApiKey across packages/ (grep, WP-A):
 *   - routes/provision.ts     -> ["operator"] or ["operator","settlement"]
 *   - routes/contributors.ts  -> contributor:read/write, schedule:read/publish
 *   - tests only otherwise (now all explicit and narrow).
 * The route-level tests below pin that both self-service entry points keep
 * minting explicit, narrow scopes — never "*".
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { provisionApiKey, assertMintableScopes } from "../auth/api-key-auth.js";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { provisionRoutes } from "../routes/provision.js";
import { contributorRoutes } from "../routes/contributors.js";
import { initStore, closeStore, getRepos } from "../db.js";

vi.mock("../telemetry.js", () => ({ pipelineTelemetry: { emit: vi.fn() } }));
vi.mock("../services/audit-service.js", () => ({ auditService: { log: vi.fn() } }));
vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../middleware/security-hardening.js", () => ({
  canProvision: vi.fn(() => true),
  canSiweVerify: vi.fn(() => true),
  canSiweNonce: vi.fn(() => true),
}));

function buildSiweMessage(p: { domain: string; address: string; nonce: string }): string {
  return [
    `${p.domain} wants you to sign in with your Ethereum account:`,
    p.address, "", "Sign in to Physical Capability Cloud", "",
    `URI: http://${p.domain}`,
    "Version: 1",
    "Chain ID: 1",
    `Nonce: ${p.nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
}

let n = 0;
const uniqueOperator = () => `mint-${Date.now()}-${++n}@example.com`;

describe("provisionApiKey refuses to mint a wildcard (MUST-CLOSE 6)", () => {
  beforeAll(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
  });
  afterAll(() => closeStore());

  const expectRefused = (scopes: unknown, code: string) => {
    const operatorId = uniqueOperator();
    let thrown: (Error & { code?: string }) | undefined;
    try {
      provisionApiKey({ operatorId, scopes } as never);
    } catch (e) {
      thrown = e as Error & { code?: string };
    }
    expect(thrown, `scopes=${JSON.stringify(scopes)} must throw`).toBeInstanceOf(Error);
    expect(thrown?.code).toBe(code);
    // Nothing persisted for the refused call.
    expect(getRepos().apiKeys.countByOperator(operatorId)).toBe(0);
  };

  it("REFUSES a call that omits scopes (used to default to [\"*\"])", () => {
    const operatorId = uniqueOperator();
    expect(() => provisionApiKey({ operatorId } as never)).toThrow(/scopes/);
    expect(getRepos().apiKeys.countByOperator(operatorId)).toBe(0);
    expectRefused(undefined, "scopes_required");
  });

  it("REFUSES [\"*\"]", () => {
    expectRefused(["*"], "wildcard_scope_refused");
  });

  it("REFUSES a wildcard hidden among narrow scopes, and family wildcards", () => {
    expectRefused(["operator", "*"], "wildcard_scope_refused");
    expectRefused(["operator.*"], "wildcard_scope_refused");
    expectRefused(["*:read"], "wildcard_scope_refused");
  });

  it("REFUSES malformed scope sets (fail closed)", () => {
    expectRefused(null, "scopes_required");
    expectRefused("operator", "scopes_required");
    expectRefused([""], "invalid_scopes");
    expectRefused([" operator"], "invalid_scopes");
    expectRefused([42], "invalid_scopes");
    expectRefused([["operator"]], "invalid_scopes");
  });

  it("assertMintableScopes is the same gate, usable before any side effect", () => {
    expect(() => assertMintableScopes(["*"])).toThrow(/wildcard/);
    expect(() => assertMintableScopes(["operator", "settlement"])).not.toThrow();
  });

  // Positive controls.
  it("mints explicit narrow scopes exactly as given", () => {
    const { record } = provisionApiKey({ operatorId: uniqueOperator(), scopes: ["operator"] });
    expect(JSON.parse(record!.scopes)).toEqual(["operator"]);
  });

  it("allows an explicit EMPTY scope list (narrow by definition)", () => {
    const { record } = provisionApiKey({ operatorId: uniqueOperator(), scopes: [] });
    expect(JSON.parse(record!.scopes)).toEqual([]);
  });
});

describe("self-service entry points never mint \"*\"", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
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
  });
  beforeEach(() => { delete process.env.PCC_SETTLEMENT_OPERATORS; });
  afterEach(() => { delete process.env.PCC_SETTLEMENT_OPERATORS; });

  /** The persisted row is the authority — not just the response echo. */
  const storedScopes = (keyId: string): unknown =>
    JSON.parse(getRepos().apiKeys.findById(keyId)!.scopes);

  async function siweToken(account: ReturnType<typeof privateKeyToAccount>): Promise<string> {
    const nonceRes = await app.inject({ method: "GET", url: "/api/auth/nonce", headers: { host: "pcc.test" } });
    const { nonce } = nonceRes.json() as { nonce: string };
    const message = buildSiweMessage({ domain: "pcc.test", address: account.address, nonce });
    const signature = await account.signMessage({ message });
    const verify = await app.inject({
      method: "POST", url: "/api/auth/verify", headers: { host: "pcc.test" },
      payload: { message, signature },
    });
    expect(verify.statusCode).toBe(200);
    return (verify.json() as { token: string }).token;
  }

  it("POST /api/auth/provision — EMAIL path mints [\"operator\"], never \"*\"", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/auth/provision", payload: { email: uniqueOperator() },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { key_id: string; scopes: string[] };
    expect(body.scopes).toEqual(["operator"]);
    expect(storedScopes(body.key_id)).toEqual(["operator"]);
  });

  it("POST /api/auth/provision — SIWE path (not allowlisted) mints [\"operator\"], never \"*\"", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const token = await siweToken(account);
    const res = await app.inject({
      method: "POST", url: "/api/auth/provision",
      headers: { authorization: `Bearer ${token}` },
      payload: { walletAddress: account.address },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { key_id: string; scopes: string[] };
    expect(body.scopes).toEqual(["operator"]);
    expect(storedScopes(body.key_id)).not.toContain("*");
  });

  it("POST /api/auth/provision — SIWE path (allowlisted) mints operator+settlement, never \"*\"", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    process.env.PCC_SETTLEMENT_OPERATORS = account.address.toLowerCase();
    const token = await siweToken(account);
    const res = await app.inject({
      method: "POST", url: "/api/auth/provision",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { key_id: string; scopes: string[] };
    expect(body.scopes).toEqual(["operator", "settlement"]);
    expect(storedScopes(body.key_id)).not.toContain("*");
  });

  it("POST /api/contributors/quickstart mints the four contributor scopes, never \"*\"", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/contributors/quickstart",
      payload: { email: uniqueOperator(), role: "model-author", ratePercent: 1.5 },
    });
    expect(res.statusCode).toBe(201);
    const { keyId } = res.json() as { keyId: string };
    expect(storedScopes(keyId)).toEqual([
      "contributor:read",
      "contributor:write",
      "schedule:read",
      "schedule:publish",
    ]);
  });
});
