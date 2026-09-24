/**
 * Unit tests for auth/kernel-owner-guard.ts, the WP-C thin wrapper over the ONE
 * kernel-ownership predicate in auth/kernel-operator.ts (PR #335, verbatim).
 *
 * The wrapper adds a PRESENT-actor requirement (401), WP-C's error codes, and
 * `ownsKernel` for callers that already hold the kernel row. Ownership itself is
 * lookupKernelOwner + ZERO_ADDRESS + isSamePrincipal from the shared module.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import {
  checkKernelOwner,
  ownsKernel,
  resolveRequestActor,
} from "../auth/kernel-owner-guard.js";
import { ZERO_ADDRESS } from "../auth/kernel-operator.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, getRepos, initStore } from "../db.js";

const OWNER_EVM = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";

function insertKernel(id: string, operatorAddress: string) {
  getRepos().kernels.insert({
    id,
    name: `Guard ${id}`,
    operatorAddress,
    location: { lat: 0, lng: 0 },
    physicalAddress: "",
    maxAssuranceTier: 0,
    publicKey: `0x${"00".repeat(32)}`,
    reputation: 0,
    totalJobsCompleted: 0,
    status: "online",
    registeredAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    version: "0.1.0",
  } as never);
}

/** A bare request object: only what the resolver reads. */
function fakeReq(fields: Record<string, unknown> = {}, headers: Record<string, string> = {}): FastifyRequest {
  return { headers, cookies: {}, ...fields } as unknown as FastifyRequest;
}

beforeAll(() => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  insertKernel("guard-owned", "op-owner");
  insertKernel("guard-evm", OWNER_EVM);
  insertKernel("guard-empty-owner", "");
  insertKernel("guard-zero-owner", ZERO_ADDRESS);
});

afterAll(() => {
  closeStore();
});

describe("ownsKernel (same comparison as requireKernelOperator)", () => {
  it("the recorded owner owns the kernel; anyone else does not", () => {
    expect(ownsKernel("op-owner", "op-owner")).toBe(true);
    expect(ownsKernel("op-owner", "op-other")).toBe(false);
  });

  it("compares principals case-insensitively (isSamePrincipal: EIP-55 casing is one address)", () => {
    expect(ownsKernel(OWNER_EVM, OWNER_EVM.toLowerCase())).toBe(true);
  });

  it("nobody owns an unowned placeholder, not even an actor equal to the placeholder", () => {
    expect(ownsKernel("", "")).toBe(false);
    expect(ownsKernel(ZERO_ADDRESS, ZERO_ADDRESS)).toBe(false);
    expect(ownsKernel(null, "op-owner")).toBe(false);
    expect(ownsKernel(undefined, "op-owner")).toBe(false);
  });

  it("a missing, blank or non-string actor owns nothing (fail closed)", () => {
    expect(ownsKernel("op-owner", undefined)).toBe(false);
    expect(ownsKernel("op-owner", "")).toBe(false);
    expect(ownsKernel("op-owner", "   ")).toBe(false);
    expect(ownsKernel("op-owner", 42)).toBe(false);
    expect(ownsKernel(42, "op-owner")).toBe(false);
  });
});

describe("resolveRequestActor", () => {
  it("prefers apiGate's operatorId, then userId", () => {
    expect(resolveRequestActor(fakeReq({ operatorId: "op-1", userId: "0xabc" }))).toBe("op-1");
    expect(resolveRequestActor(fakeReq({ userId: "0xabc" }))).toBe("0xabc");
  });

  it("ignores blank and non-string identities", () => {
    expect(resolveRequestActor(fakeReq({ operatorId: "   ", userId: 7 }))).toBeUndefined();
    expect(resolveRequestActor(fakeReq({ operatorId: 42 }))).toBeUndefined();
  });

  it("resolves a Bearer API key itself when apiGate did not run (public path)", () => {
    const { rawKey } = provisionApiKey({ operatorId: "op-from-key", scopes: ["operator"] });
    expect(resolveRequestActor(fakeReq({}, { authorization: `Bearer ${rawKey}` }))).toBe("op-from-key");
  });

  it("returns undefined for no credentials or an unknown key", () => {
    expect(resolveRequestActor(fakeReq())).toBeUndefined();
    expect(
      resolveRequestActor(fakeReq({}, { authorization: `Bearer pcc_live_${"0".repeat(64)}` })),
    ).toBeUndefined();
  });
});

describe("checkKernelOwner", () => {
  it("authorizes the recorded owner and returns the actor", async () => {
    await expect(checkKernelOwner("op-owner", "guard-owned")).resolves.toEqual({ ok: true, actor: "op-owner" });
    await expect(checkKernelOwner(OWNER_EVM.toLowerCase(), "guard-evm")).resolves.toMatchObject({ ok: true });
  });

  it("[neg] a different principal -> 403 not_kernel_owner", async () => {
    await expect(checkKernelOwner("op-attacker", "guard-owned")).resolves.toMatchObject({
      ok: false,
      status: 403,
      error: "not_kernel_owner",
    });
  });

  it("[neg] a legacy placeholder owner ('' or zero address) -> 403 not_kernel_owner (claim via register first)", async () => {
    for (const id of ["guard-empty-owner", "guard-zero-owner"]) {
      const v = await checkKernelOwner("op-owner", id);
      expect(v).toMatchObject({ ok: false, status: 403, error: "not_kernel_owner" });
      if (!v.ok) expect(v.message).toMatch(/no recorded operator/);
    }
    // Presenting the placeholder itself as the identity grants nothing either.
    await expect(checkKernelOwner(ZERO_ADDRESS, "guard-zero-owner")).resolves.toMatchObject({ status: 403 });
  });

  it("[neg] an unknown kernel -> 404 kernel_not_found", async () => {
    await expect(checkKernelOwner("op-owner", "guard-no-such-kernel")).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: "kernel_not_found",
    });
  });

  it("[neg] no actor -> 401 api_key_required, before any lookup", async () => {
    for (const actor of [undefined, "", "  "]) {
      await expect(checkKernelOwner(actor, "guard-owned")).resolves.toMatchObject({
        ok: false,
        status: 401,
        error: "api_key_required",
      });
    }
  });

  // Keep LAST: it closes the store.
  it("[neg] a failed owner lookup (store unavailable) -> 502 kernel_lookup_failed, never a grant", async () => {
    closeStore();
    await expect(checkKernelOwner("op-owner", "guard-owned")).resolves.toMatchObject({
      ok: false,
      status: 502,
      error: "kernel_lookup_failed",
    });
  });
});
