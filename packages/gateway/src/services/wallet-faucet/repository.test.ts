import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { closeStore, initStore } from "../../db.js";
import {
  claimLinkProof, createLinkRequest, decideLinkRequest, finishLinkProof,
} from "../wallet-links/repository.js";
import { verifyProofMessage } from "../wallet-links/message.js";
import {
  attemptableClaim, ensureFundingGrant, finishFundingClaim, fundingClaims, leaseFundingClaim,
} from "./repository.js";

const now = Date.parse("2026-10-15T12:00:00.000Z");
const day = 86_400_000;
const config = {
  publicOrigin: "https://capability.network",
  domain: "capability.network",
  uri: "https://capability.network/link",
  env: "staging",
  allowedChainIds: [84532],
};

beforeEach(() => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("DATABASE_URL", ":memory:");
  initStore({ seed: false });
});
afterEach(() => {
  closeStore();
  vi.unstubAllEnvs();
});

// All fixture writes use the same repositories as W1/W2 routes. Historical
// grants are created at their original time rather than backdated with raw SQL.
async function grant(createdAt = now) {
  const account = privateKeyToAccount(generatePrivateKey());
  const request = createLinkRequest({
    keyType: "secp256k1", identity: account.address.toLowerCase(), role: "device",
    label: "repository-test", chainId: 84532,
  }, "local", config, createdAt);
  const signature = await account.signMessage({ message: request.message });
  const proof = claimLinkProof(request.id, createdAt);
  const valid = await verifyProofMessage(proof, signature, config, createdAt);
  expect(valid).toBe(true);
  finishLinkProof(proof, signature, valid);
  const approval = decideLinkRequest(request.id, "repository-owner", "approve", createdAt);
  expect(approval.status).toBe("approved");
  const claims = ensureFundingGrant(approval.linkId!, createdAt);
  expect(claims).toHaveLength(5);
  expect(claims.every(claim => claim.status === "pending" && claim.attempts === 0)).toBe(true);
  return { linkId: approval.linkId!, claim: claims[0]! };
}

async function failedClaim(createdAt: number) {
  const result = await grant(createdAt);
  const leased = leaseFundingClaim(result.claim, createdAt);
  expect(leased).toBeDefined();
  finishFundingClaim(leased!, undefined, "unknown", createdAt);
  const claim = fundingClaims(result.linkId)[0]!;
  expect(claim).toMatchObject({ status: "failed", attempts: 1, lease_until: null });
  return { ...result, claim };
}

describe("wallet faucet repository lease guards", () => {
  it.each([
    { age: day + 1, allowed: false, label: "24 h + 1 ms" },
    { age: day, allowed: false, label: "exactly 24 h" },
    { age: day - 1, allowed: true, label: "24 h - 1 ms" },
  ])("R2e JS failed retry at $label has attempt eligibility $allowed", async ({ age, allowed }) => {
    const result = await failedClaim(now - age);
    expect(attemptableClaim(result.claim, now)).toBe(allowed);
  });

  it("R2e JS keeps a pending claim older than 24 h attemptable", async () => {
    const result = await grant(now - day - 1);
    expect(attemptableClaim(result.claim, now)).toBe(true);
  });

  it("F3 SQL enforces 30 s backoff after every failure and a maximum of five attempts", async () => {
    const result = await grant();
    let claim = result.claim;
    let attemptedAt = now;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const leased = leaseFundingClaim(claim, attemptedAt);
      expect(leased, `attempt ${attempt} at the allowed boundary`).toBeDefined();
      expect(leased!.attempts).toBe(attempt);
      finishFundingClaim(leased!, undefined, "unknown", attemptedAt);
      claim = fundingClaims(result.linkId)[0]!;
      expect(claim).toMatchObject({ status: "failed", attempts: attempt, lease_until: null });
      expect(leaseFundingClaim(claim, attemptedAt + 29_999), `backoff after attempt ${attempt}`).toBeUndefined();
      expect(fundingClaims(result.linkId)[0]).toEqual(claim);
      attemptedAt += 30_000;
    }
    expect(leaseFundingClaim(claim, attemptedAt), "sixth attempt after the backoff").toBeUndefined();
    expect(leaseFundingClaim(claim, attemptedAt + 3_600_000), "sixth attempt much later").toBeUndefined();
    expect(fundingClaims(result.linkId)[0]).toEqual(claim);
  });

  it("F3 SQL never re-leases a succeeded claim after its lease and backoff have ended", async () => {
    const result = await grant();
    const leased = leaseFundingClaim(result.claim, now);
    expect(leased).toBeDefined();
    const transactionHash = `0x${randomBytes(32).toString("hex")}`;
    finishFundingClaim(leased!, transactionHash, undefined, now);
    const succeeded = fundingClaims(result.linkId)[0]!;
    expect(succeeded).toMatchObject({ status: "succeeded", attempts: 1, tx_hash: transactionHash, lease_until: null });
    expect(leaseFundingClaim(succeeded, now + 30_000)).toBeUndefined();
    expect(leaseFundingClaim(succeeded, now + day)).toBeUndefined();
    expect(fundingClaims(result.linkId)[0]).toEqual(succeeded);
  });

  it.each([
    { age: day + 1, allowed: false, label: "24 h + 1 ms" },
    { age: day, allowed: false, label: "exactly 24 h" },
    { age: day - 1, allowed: true, label: "24 h - 1 ms" },
  ])("F4(a) failed retry at $label has lease eligibility $allowed", async ({ age, allowed }) => {
    const result = await failedClaim(now - age);
    const leased = leaseFundingClaim(result.claim, now);
    if (allowed) {
      expect(leased).toMatchObject({ status: "failed", attempts: 2, last_attempt_at: new Date(now).toISOString() });
    } else {
      expect(leased).toBeUndefined();
      expect(fundingClaims(result.linkId)[0]).toEqual(result.claim);
    }
  });

  it("F4(a) a pending grant older than 24 h remains eligible for its first lease", async () => {
    const result = await grant(now - day - 1);
    const leased = leaseFundingClaim(result.claim, now);
    expect(leased).toMatchObject({ status: "pending", attempts: 1, last_attempt_at: new Date(now).toISOString() });
  });
});
