/**
 * SIWE hardening — the fixes for cross-family review findings on PR #309.
 *
 * PR #309 made GET /api/auth/nonce and POST /api/auth/verify public (they were
 * 401ing, which made SIWE login impossible). Opening them turned several
 * pre-existing weaknesses into reachable ones, so the same PR hardens them:
 *
 *   - the nonce route no longer does a SQLite DELETE per unauthenticated call,
 *     and is rate-limited + capped (was an amplification path);
 *   - nonce consumption is atomic (one signed message minted N sessions);
 *   - chainId / issuedAt / expirationTime validation fails CLOSED (all three
 *     previously let malformed or future-dated values through).
 *
 * Limitations that were reported and deliberately NOT fixed there — request-Host
 * domain validation, process-local nonce/limit state, no ERC-1271 — are
 * documented in the siwe-auth.ts docblock, not silently dropped.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { __resetSiweNonceForTest } from "../middleware/security-hardening.js";
import { initStore, closeStore, getRepos } from "../db.js";

function buildSiweMessage(p: {
  domain: string; address: string; statement: string; uri: string;
  version: string; chainId: string; nonce: string; issuedAt: string;
  expirationTime?: string;
}): string {
  const lines = [
    `${p.domain} wants you to sign in with your Ethereum account:`,
    p.address, "", p.statement, "",
    `URI: ${p.uri}`,
    `Version: ${p.version}`,
    `Chain ID: ${p.chainId}`,
    `Nonce: ${p.nonce}`,
    `Issued At: ${p.issuedAt}`,
  ];
  if (p.expirationTime) lines.push(`Expiration Time: ${p.expirationTime}`);
  return lines.join("\n");
}

describe("SIWE hardening (PR #309 cross-family review)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    app = Fastify({ logger: false });
    await app.register(cookie, { secret: "test-only-cookie-secret-do-not-use-in-prod" });
    await app.register(siweAuthPlugin);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  beforeEach(() => { __resetSiweNonceForTest(); });

  const getNonce = async () => {
    const res = await app.inject({
      method: "GET", url: "/api/auth/nonce", headers: { host: "pcc.test" },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).nonce as string;
  };

  /** Build + sign a message, defaulting every field to something valid. */
  async function signed(
    account: ReturnType<typeof privateKeyToAccount>,
    over: Partial<Parameters<typeof buildSiweMessage>[0]> = {},
  ) {
    const nonce = await getNonce();
    const message = buildSiweMessage({
      domain: "pcc.test", address: account.address,
      statement: "Sign in to Physical Capability Cloud",
      uri: "http://pcc.test", version: "1", chainId: "1", nonce,
      issuedAt: new Date().toISOString(),
      ...over,
    });
    return { message, signature: await account.signMessage({ message }) };
  }

  const verify = (payload: { message: string; signature: string }) =>
    app.inject({
      method: "POST", url: "/api/auth/verify",
      headers: { host: "pcc.test" }, payload,
    });

  // ── The amplification path this PR would otherwise have opened ────

  describe("the public nonce route is bounded", () => {
    it("does NOT touch the session store on the unauthenticated path", async () => {
      // The old code called sessions.deleteExpired() on EVERY nonce request.
      const repo = getRepos().sessions;
      const spy = vi.spyOn(repo, "deleteExpired");
      await getNonce();
      await getNonce();
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("rate-limits nonce issuance per IP", async () => {
      let sawLimit = false;
      for (let i = 0; i < 70; i++) {
        const res = await app.inject({
          method: "GET", url: "/api/auth/nonce", headers: { host: "pcc.test" },
        });
        if (res.statusCode === 429) {
          expect(res.json().error).toBe("rate_limited");
          sawLimit = true;
          break;
        }
      }
      expect(sawLimit).toBe(true);
    });
  });

  // ── One signature must mint exactly one session ───────────────────

  describe("nonce consumption is one-time", () => {
    it("REFUSES a second verify of the same signed message", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const msg = await signed(account);

      const first = await verify(msg);
      expect(first.statusCode).toBe(200);

      const replay = await verify(msg);
      expect(replay.statusCode).toBe(401);
      expect(JSON.parse(replay.body).error).toMatch(/already used|Nonce/i);
    });

    it("REFUSES concurrent verifies of one signed message — exactly one wins", async () => {
      // This is the race the fix closes: the nonce check happens before
      // `await verifyMessage`, so both requests used to pass it and both minted
      // a session. One signature, N sessions.
      const account = privateKeyToAccount(generatePrivateKey());
      const msg = await signed(account);

      const results = await Promise.all([verify(msg), verify(msg), verify(msg)]);
      const ok = results.filter((r) => r.statusCode === 200);
      const denied = results.filter((r) => r.statusCode === 401);
      expect(ok).toHaveLength(1);
      expect(denied).toHaveLength(2);
    });
  });

  // ── Validation must fail CLOSED ───────────────────────────────────

  describe("message validation fails closed", () => {
    it("REJECTS a partially-numeric Chain ID (parseInt('1abc') was 1)", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const res = await verify(await signed(account, { chainId: "1abc" }));
      expect(res.statusCode).toBe(400);
    });

    it("REJECTS an unparseable Issued At (previously slipped past !isNaN)", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const res = await verify(await signed(account, { issuedAt: "not-a-date" }));
      expect(res.statusCode).toBe(401);
    });

    it("REJECTS a future-dated message (was never checked at all)", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const res = await verify(await signed(account, { issuedAt: future }));
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).error).toMatch(/future/i);
    });

    it("REJECTS an unparseable Expiration Time (previously accepted forever)", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const res = await verify(await signed(account, { expirationTime: "whenever" }));
      expect(res.statusCode).toBe(401);
    });

    it("REJECTS an already-expired message", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const past = new Date(Date.now() - 60 * 1000).toISOString();
      const res = await verify(await signed(account, { expirationTime: past }));
      expect(res.statusCode).toBe(401);
    });

    // Positive control: none of the tightening above breaks a normal login.
    it("still ACCEPTS a well-formed message, including a valid future expiry", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const soon = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const res = await verify(await signed(account, { expirationTime: soon }));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).address.toLowerCase()).toBe(account.address.toLowerCase());
    });
  });
});
