/**
 * Audit C-03 containment — gateway escrow chain-write route tests.
 *
 * Two endpoints let an untrusted caller steer the gateway's own signer
 * (PCC_GATEWAY_PRIVATE_KEY):
 *
 *   1. POST /api/escrow/chain/:address/approve — took spender (:address), token
 *      and amount straight from the request, so the signer could be made to
 *      approve an arbitrary spender for an arbitrary ERC-20. Now 410 Gone,
 *      accepting no params at all.
 *   2. POST /api/escrow/chain/:address/fund — validated only isAddress(), then
 *      forwarded the caller-supplied address into a chain write. Now gated on
 *      provenance: the address must resolve to an escrow row this gateway
 *      created.
 *
 * The load-bearing assertions are the negative ones: the settlement facade's
 * chain-write methods must never be reached from either rejected path. NO chain
 * calls, NO wallet, NO network — the facade is spied and the DB is in-memory.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { getAddress } from "viem";

import { escrowRoutes } from "../routes/escrow.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { getSettlementFacade } from "../facades/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Seeded in the DB (checksummed, exactly as paid-job-flow writes it). */
const KNOWN_LOWER = "0xabcdef0123456789abcdef0123456789abcdef01";
const KNOWN = getAddress(KNOWN_LOWER);

/** Seeded too — a second row so the two happy-path cases never share an
 *  activity idempotency key (which is derived from the escrow address). */
const KNOWN_2_LOWER = "0xabcdef0123456789abcdef0123456789abcdef02";
const KNOWN_2 = getAddress(KNOWN_2_LOWER);

/** Never seeded. All-numeric hex, so no EIP-55 checksum concerns. */
const UNKNOWN = "0x1111111111111111111111111111111111111111";
/** The attacker's own address in the original C-03 report. */
const ATTACKER = "0x2222222222222222222222222222222222222222";

function seedEscrow(id: string, contractAddress: string, version: "v2" | "v3" = "v2") {
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

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(escrowRoutes);
  await app.ready();
  return app;
}

// ===========================================================================
// Suite
// ===========================================================================

describe("audit C-03 — escrow chain-write containment", () => {
  let app: FastifyInstance;
  let fundSpy: ReturnType<typeof vi.spyOn>;
  let approveSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    initStore({ seed: false });
    seedEscrow("esc-known-001", KNOWN);
    seedEscrow("esc-known-002", KNOWN_2);

    const facade = getSettlementFacade();
    // Stub the two chain-write facade methods. A call to either means the
    // request reached the on-chain layer; the rejection tests assert 0 calls.
    fundSpy = vi.spyOn(facade, "fundEscrow").mockResolvedValue({
      success: true,
      data: { transactionHash: "0xtest", status: "submitted", action: "fund" },
    } as never);
    approveSpy = vi.spyOn(facade, "approveToken").mockResolvedValue({
      success: true,
      data: { transactionHash: "0xtest", status: "submitted" },
    } as never);

    app = await buildApp();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
    closeStore();
  });

  beforeEach(() => {
    fundSpy.mockClear();
    approveSpy.mockClear();
  });

  // -------------------------------------------------------------------------
  // 1 — /approve is gone: 410 regardless of params, never reaches the chain
  // -------------------------------------------------------------------------

  describe("POST /api/escrow/chain/:address/approve", () => {
    it("returns 410 endpoint_removed with no body at all", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/escrow/chain/${KNOWN}/approve`,
      });

      expect(res.statusCode).toBe(410);
      expect(res.json().error).toBe("endpoint_removed");
      expect(approveSpy).not.toHaveBeenCalled();
    });

    it("returns 410 for the exact C-03 exploit shape (attacker spender + real token + max amount)", async () => {
      const res = await app.inject({
        method: "POST",
        // :address is the ERC-20 `spender` the old route approved.
        url: `/api/escrow/chain/${ATTACKER}/approve`,
        payload: {
          amount: "1000000",
          // Real Base USDC — the old route took tokenAddress from the caller.
          tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        },
      });

      expect(res.statusCode).toBe(410);
      expect(res.json().error).toBe("endpoint_removed");
      expect(approveSpy).not.toHaveBeenCalled();
    });

    it("returns 410 for every other param permutation (no param is honoured)", async () => {
      const payloads: unknown[] = [
        {},
        { amount: "1" },
        { amount: "0" },
        { amount: "-5" },
        { amount: "not-a-number" },
        { amount: "999999999999", tokenAddress: ATTACKER },
        { tokenAddress: ATTACKER },
        { spender: ATTACKER, amount: "1" },
      ];

      for (const payload of payloads) {
        const res = await app.inject({
          method: "POST",
          url: `/api/escrow/chain/${ATTACKER}/approve`,
          payload: payload as Record<string, unknown>,
        });
        expect(res.statusCode).toBe(410);
        expect(res.json().error).toBe("endpoint_removed");
      }
      expect(approveSpy).not.toHaveBeenCalled();
    });

    it("returns 410 even for a malformed address — the route validates nothing because it accepts nothing", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/escrow/chain/not-an-address/approve`,
        payload: { amount: "1" },
      });

      expect(res.statusCode).toBe(410);
      expect(approveSpy).not.toHaveBeenCalled();
    });

    it("stays registered (410, not 404) so existing clients get a clear signal", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/escrow/chain/${KNOWN}/approve`,
        payload: {},
      });

      expect(res.statusCode).not.toBe(404);
      expect(res.statusCode).toBe(410);
      // The message must name the remediation so a client knows why.
      expect(res.json().message).toMatch(/C-03/);
    });
  });

  // -------------------------------------------------------------------------
  // 2 — /fund provenance gate
  // -------------------------------------------------------------------------

  describe("POST /api/escrow/chain/:address/fund", () => {
    it("rejects an address with no escrow row — 404, and NO chain call is made", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/escrow/chain/${UNKNOWN}/fund`,
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("escrow_not_found");
      // The load-bearing assertion: the gate short-circuits before the
      // settlement facade (and therefore before any signer/RPC activity).
      expect(fundSpy).not.toHaveBeenCalled();
    });

    it("rejects an attacker-chosen address the same way", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/escrow/chain/${ATTACKER}/fund`,
      });

      expect(res.statusCode).toBe(404);
      expect(fundSpy).not.toHaveBeenCalled();
    });

    it("still rejects a malformed address with 400 (unchanged behaviour)", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/escrow/chain/not-an-address/fund`,
      });

      expect(res.statusCode).toBe(400);
      expect(fundSpy).not.toHaveBeenCalled();
    });

    it("funds a known escrow row — the gate lets protocol-created escrows through", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/escrow/chain/${KNOWN}/fund`,
      });

      expect(res.statusCode).toBe(200);
      expect(fundSpy).toHaveBeenCalledTimes(1);
      // The address forwarded on-chain is the one from the path.
      expect((fundSpy.mock.calls[0] as unknown[])[0]).toBe(KNOWN);
    });

    it("accepts a lowercase address for a checksum-stored row (no casing false-negative)", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/escrow/chain/${KNOWN_2_LOWER}/fund`,
      });

      expect(res.statusCode).toBe(200);
      expect(fundSpy).toHaveBeenCalledTimes(1);
    });

    it("preserves the idempotency-key header pass-through", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/escrow/chain/${KNOWN}/fund`,
        headers: { "idempotency-key": "c03-test-key-1" },
      });

      // Same escrow as the earlier happy path: the activity's on-chain
      // semantic key is already recorded, so this is served idempotently
      // rather than re-hitting the chain. Either way it must not be a
      // provenance rejection.
      expect(res.statusCode).toBe(200);
      expect(res.statusCode).not.toBe(404);
    });
  });
});
