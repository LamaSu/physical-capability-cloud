/**
 * N46 authority on POST /api/escrow/chain/:address/fund (N46 pack 104, F1; the
 * steward placed the remainder on #326).
 *
 * The route makes the gateway's OWN signer fund an escrow, so it spends gateway
 * money. The spend guard (caps and the kill switch) lives on the master-based
 * #453 and is not on this branch. What was missing here is AUTHORITY: after the
 * provenance gate (the address must be an escrow this gateway created) ANY
 * authenticated key, a stranger's included, made the gateway fund it.
 *
 * Now the caller must be the escrow's RECORDED payer (escrows.payer, the buyer
 * the gateway wrote down when it created the escrow; matched with sameIdentity,
 * or, for an address, against the caller's PROVEN wallet case-insensitively) or
 * present the admin secret. A wrong secret is refused, never downgraded to the
 * key's own rights. An escrow with no recorded payer is the admin's alone. The
 * order is 401 (no identity), then the provenance gate (404), then 403; nothing
 * is funded on a refusal.
 *
 * The chain is never touched: the settlement facade's fundEscrow is spied, so a
 * call to it means the request got past the authority layer to the on-chain
 * activity. Reproduced at 4de265ce before any code changed: the [neg] tests
 * fail there. The file imports only modules that exist there.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { getAddress } from "viem";

import { escrowRoutes } from "../routes/escrow.js";
import { apiGate } from "../middleware/api-gate.js";
import { scopeChecker } from "../middleware/scope-checker.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { getSettlementFacade } from "../facades/index.js";

const ADMIN_SECRET = "fund-authority-test-admin-secret";
const PAYER_ID = "fund.payer@x.test";
const STRANGER_ID = "fund.stranger@x.test";
const ZERO = "0x0000000000000000000000000000000000000000";
/** A wallet proven through SIWE: the key's operatorId is the lowercase address. */
const WALLET_LOWER = "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef";
const OTHER_WALLET_LOWER = "0xcafecafecafecafecafecafecafecafecafecafe";
const savedAdmin = process.env.PCC_ADMIN_KEY;

let app: FastifyInstance;
let bareApp: FastifyInstance;
let fundSpy: ReturnType<typeof vi.spyOn>;
let payerKey = "";
let strangerKey = "";
let walletKey = "";
let zeroKey = "";
let seq = 0;

/**
 * Seed an escrow row the way paid-job-flow writes it (the checksummed contract
 * address; `payer` is whatever the session declared). Every call gets its own
 * address: the fund activity is idempotent per address, so two scenarios must
 * never share one. The hex is letter-heavy, so the EIP-55 form differs from the
 * lowercase form and the casing assertions mean something.
 */
function seedEscrow(payer: string): { stored: string; lower: string } {
  const n = ++seq;
  const lower = `0x${"abcdef".repeat(6)}${n.toString(16).padStart(4, "0")}`;
  const stored = getAddress(lower);
  expect(stored).not.toBe(lower);
  getRepos().escrows.insert({
    id: `esc-fund-authority-${n}`,
    cwmId: `cwm-fund-authority-${n}`,
    contractAddress: stored,
    payer,
    totalAmount: "100",
    currency: "USDC",
    status: "created",
    createdAt: new Date().toISOString(),
    deadline: new Date(Date.now() + 86_400_000).toISOString(),
    version: "v2",
  });
  return { stored, lower };
}

const asKey = (key: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${key}`, ...extra });
const fund = (address: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: `/api/escrow/chain/${address}/fund`, headers });
const fundBare = (address: string, headers: Record<string, string> = {}) =>
  bareApp.inject({ method: "POST", url: `/api/escrow/chain/${address}/fund`, headers });

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ADMIN_SECRET;
  initStore({ seed: false });
  payerKey = provisionApiKey({ operatorId: PAYER_ID, scopes: ["settlement"] }).rawKey;
  strangerKey = provisionApiKey({ operatorId: STRANGER_ID, scopes: ["settlement"] }).rawKey;
  walletKey = provisionApiKey({
    operatorId: WALLET_LOWER,
    scopes: ["settlement"],
    metadata: { siweVerified: true, provenAddress: WALLET_LOWER },
  }).rawKey;
  zeroKey = provisionApiKey({ operatorId: ZERO, scopes: ["settlement"] }).rawKey;

  // NO chain call, NO wallet: stub the facade's write. A call means the request
  // reached the on-chain activity.
  fundSpy = vi.spyOn(getSettlementFacade(), "fundEscrow").mockResolvedValue({
    success: true,
    data: { transactionHash: "0xtest", status: "submitted", action: "fund" },
  } as never);

  // The real gate and the real money-floor scope check, in server.ts's order.
  // The keys above hold `settlement`, so the scope floor lets every one of them
  // through and the authority layer is what decides.
  app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(scopeChecker);
  await app.register(escrowRoutes);
  await app.ready();

  // No gate in front: the identity the gate would attach is read from test
  // headers, so a request with none shows what the handler does on its own.
  bareApp = Fastify({ logger: false });
  bareApp.addHook("onRequest", async (req) => {
    const as = req.headers["x-test-operator"];
    if (typeof as === "string") {
      (req as unknown as { operatorId: string }).operatorId = as;
      (req as unknown as { userId: string }).userId = as;
    }
    const wallet = req.headers["x-test-proven-wallet"];
    if (typeof wallet === "string") (req as unknown as { provenWallet: string }).provenWallet = wallet;
  });
  await bareApp.register(escrowRoutes);
  await bareApp.ready();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await app?.close();
  await bareApp?.close();
  closeStore();
  if (savedAdmin === undefined) delete process.env.PCC_ADMIN_KEY;
  else process.env.PCC_ADMIN_KEY = savedAdmin;
});

beforeEach(() => {
  process.env.PCC_ADMIN_KEY = ADMIN_SECRET;
  fundSpy.mockClear();
});

describe("N46 /fund authority: only the recorded payer or the admin makes the gateway fund an escrow", () => {
  it("[neg] a stranger's key cannot make the gateway fund an escrow that is not theirs", async () => {
    const e = seedEscrow(PAYER_ID);
    const res = await fund(e.stored, asKey(strangerKey));
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("not_escrow_payer");
    expect(fundSpy).not.toHaveBeenCalled();
    // The refusal never says who the payer is.
    expect(res.body).not.toContain(PAYER_ID);
  });

  it("[neg] respelling the address in the URL buys the stranger nothing", async () => {
    const e = seedEscrow(PAYER_ID);
    for (const spelling of [e.stored, e.lower]) {
      const res = await fund(spelling, asKey(strangerKey));
      expect(res.statusCode, `${spelling}: ${res.body}`).toBe(403);
    }
    expect(fundSpy).not.toHaveBeenCalled();
  });

  it("[neg] a WRONG admin secret is refused, never downgraded to the payer's own rights", async () => {
    const e = seedEscrow(PAYER_ID);
    const res = await fund(e.stored, asKey(payerKey, { "x-admin-key": "not-the-admin-secret" }));
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("admin_key_invalid");
    expect(fundSpy).not.toHaveBeenCalled();
  });

  it("[neg] an EMPTY admin header is a presented (invalid) secret, not an absent one", async () => {
    const e = seedEscrow(PAYER_ID);
    const res = await fund(e.stored, asKey(payerKey, { "x-admin-key": "" }));
    expect([401, 403], res.body).toContain(res.statusCode);
    expect(fundSpy).not.toHaveBeenCalled();
  });

  it("[neg] a secret presented while PCC_ADMIN_KEY is unset is refused (fail closed), never downgraded", async () => {
    const e = seedEscrow(PAYER_ID);
    delete process.env.PCC_ADMIN_KEY;
    const res = await fund(e.stored, asKey(payerKey, { "x-admin-key": ADMIN_SECRET }));
    expect(res.statusCode, res.body).toBe(503);
    expect(fundSpy).not.toHaveBeenCalled();
  });

  it("[neg] an escrow with NO recorded payer is the admin's alone (blank payer, whitespace payer)", async () => {
    for (const blank of ["", "   "]) {
      const e = seedEscrow(blank);
      for (const key of [strangerKey, payerKey]) {
        const res = await fund(e.stored, asKey(key));
        expect(res.statusCode, `payer=${JSON.stringify(blank)}: ${res.body}`).toBe(403);
      }
    }
    expect(fundSpy).not.toHaveBeenCalled();
  });

  it("[neg] the zero-address placeholder is no payer either, in any spelling: a key carrying that very identity is refused", async () => {
    for (const placeholder of [ZERO, "0X0000000000000000000000000000000000000000", `０x${"0".repeat(39)}0`, ` ${ZERO} `]) {
      const e = seedEscrow(placeholder);
      const res = await fund(e.stored, asKey(zeroKey));
      expect(res.statusCode, `${JSON.stringify(placeholder)}: ${res.body}`).toBe(403);
    }
    expect(fundSpy).not.toHaveBeenCalled();
  });

  it("[neg] an address the gateway never created is 404 for the stranger AND the admin (the provenance gate stands)", async () => {
    const unknown = "0x1111111111111111111111111111111111111111";
    for (const headers of [asKey(strangerKey), asKey(strangerKey, { "x-admin-key": ADMIN_SECRET })]) {
      const res = await fund(unknown, headers);
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json().error).toBe("escrow_not_found");
    }
    expect(fundSpy).not.toHaveBeenCalled();
  });

  it("[neg] no credentials at all is refused at the gate, nothing funded", async () => {
    const e = seedEscrow(PAYER_ID);
    const res = await fund(e.stored);
    expect(res.statusCode, res.body).toBe(401);
    expect(fundSpy).not.toHaveBeenCalled();
  });

  it("control: the recorded payer funds, however the identity was typed (case, padding, fullwidth)", async () => {
    for (const recorded of [
      "Fund.Payer@X.TEST",
      "  fund.payer@x.test  ",
      "ｆｕｎｄ.ｐａｙｅｒ@ｘ.ｔｅｓｔ",
    ]) {
      fundSpy.mockClear();
      const e = seedEscrow(recorded);
      const res = await fund(e.stored, asKey(payerKey));
      expect(res.statusCode, `${JSON.stringify(recorded)}: ${res.body}`).toBe(200);
      expect(fundSpy).toHaveBeenCalledTimes(1);
      expect((fundSpy.mock.calls[0] as unknown[])[0]).toBe(e.stored);
    }
  });

  it("control: the admin funds any escrow the gateway knows, one with no recorded payer included", async () => {
    for (const payer of [PAYER_ID, ""]) {
      fundSpy.mockClear();
      const e = seedEscrow(payer);
      const res = await fund(e.stored, asKey(strangerKey, { "x-admin-key": ADMIN_SECRET }));
      expect(res.statusCode, `payer=${JSON.stringify(payer)}: ${res.body}`).toBe(200);
      expect(fundSpy).toHaveBeenCalledTimes(1);
    }
  });

  it("control: an address payer is matched with the caller's wallet case-insensitively (EIP-55 payer, lowercase key)", async () => {
    const e = seedEscrow(getAddress(WALLET_LOWER));
    expect(getAddress(WALLET_LOWER)).not.toBe(WALLET_LOWER);
    const res = await fund(e.stored, asKey(walletKey));
    expect(res.statusCode, res.body).toBe(200);
    expect(fundSpy).toHaveBeenCalledTimes(1);
  });

  it("[neg] another wallet is not the payer of an address-payer escrow", async () => {
    const e = seedEscrow(getAddress(OTHER_WALLET_LOWER));
    const res = await fund(e.stored, asKey(walletKey));
    expect(res.statusCode, res.body).toBe(403);
    expect(fundSpy).not.toHaveBeenCalled();
  });
});

describe("N46 /fund authority: the handler fails closed on its own (nothing in front of it)", () => {
  it("[neg] with NO identity attached the handler refuses: 401, nothing funded", async () => {
    const e = seedEscrow(PAYER_ID);
    const res = await fundBare(e.stored);
    expect(res.statusCode, res.body).toBe(401);
    expect(res.json().error).toBe("authentication_required");
    expect(fundSpy).not.toHaveBeenCalled();
  });

  it("[neg] 401 comes before the provenance gate: an unknown address with no identity is 401, not 404", async () => {
    const res = await fundBare("0x1111111111111111111111111111111111111111");
    expect(res.statusCode, res.body).toBe(401);
    expect(fundSpy).not.toHaveBeenCalled();
  });

  it("a malformed address is still a 400 (input validation, unchanged)", async () => {
    const res = await fundBare("not-an-address");
    expect(res.statusCode, res.body).toBe(400);
    expect(fundSpy).not.toHaveBeenCalled();
  });

  it("the order is 401, then 404, then 403: an identified stranger on an unknown address gets 404, on a known one 403", async () => {
    const stranger = { "x-test-operator": STRANGER_ID };
    const unknown = await fundBare("0x1111111111111111111111111111111111111111", stranger);
    expect(unknown.statusCode, unknown.body).toBe(404);
    const known = seedEscrow(PAYER_ID);
    const refused = await fundBare(known.stored, stranger);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(fundSpy).not.toHaveBeenCalled();
  });

  it("the recorded payer's PROVEN wallet is matched case-insensitively, whatever identity the key carries", async () => {
    const e = seedEscrow(getAddress(WALLET_LOWER));
    const res = await fundBare(e.stored, {
      "x-test-operator": "wallet-owner-ops@x.test",
      "x-test-proven-wallet": WALLET_LOWER,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(fundSpy).toHaveBeenCalledTimes(1);
  });

  it("[neg] a proven wallet that is not the payer's is refused", async () => {
    const e = seedEscrow(getAddress(WALLET_LOWER));
    const res = await fundBare(e.stored, {
      "x-test-operator": "wallet-owner-ops@x.test",
      "x-test-proven-wallet": OTHER_WALLET_LOWER,
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(fundSpy).not.toHaveBeenCalled();
  });

  it("[neg] a proven wallet matches nothing when the recorded payer is not an address", async () => {
    const e = seedEscrow(PAYER_ID);
    const res = await fundBare(e.stored, {
      "x-test-operator": "wallet-owner-ops@x.test",
      "x-test-proven-wallet": WALLET_LOWER,
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(fundSpy).not.toHaveBeenCalled();
  });
});
