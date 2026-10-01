/**
 * Test fixture: kernel rows with a KNOWN authorized assurance ceiling.
 *
 * WP-C R1 serves every graph-search node and compose candidate at
 * min(claimed tier, authorizedAssuranceCeiling(its kernel row)), and a node or
 * candidate whose kernel has no row is served at 0. Tests that exercise
 * tier-based filtering and ranking therefore need their candidates to sit on a
 * kernel row whose ceiling is known. `ensureTrustedKernel` creates one with the
 * maximum ceiling (3): a proven secp256k1 signer plus a track record that
 * ReputationService allows up to tier 3 (>= 20 jobs, effective rep >= 600).
 *
 * Not a test file (no `.test.ts` suffix), so vitest does not collect it.
 */

import { getRepos, initStore } from "../../db.js";

/** Signer + track record that yield an authorized ceiling of 3. */
export const TRUSTED_KERNEL_FIELDS = {
  signingKeyAlgorithm: "secp256k1",
  signingAddress: "0x1234567890abcdef1234567890abcdef12345678",
  reputation: 900,
  totalJobsCompleted: 50,
} as const;

/** Proven signer but a fresh record: ceiling 1. */
export const SIGNED_FRESH_KERNEL_FIELDS = {
  signingKeyAlgorithm: "secp256k1",
  signingAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  reputation: 0,
  totalJobsCompleted: 0,
} as const;

/** No signer (ceiling 0) regardless of the track record. */
export const UNSIGNED_KERNEL_FIELDS = {
  signingKeyAlgorithm: null,
  signingAddress: null,
  signingKeyPublicKey: null,
  reputation: 950,
  totalJobsCompleted: 127,
} as const;

/**
 * Insert a kernel row if `kernelId` has none (idempotent). `fields` override
 * the defaults (unowned-looking test operator, claim 3, no signer).
 */
export function ensureKernelRow(
  kernelId: string,
  fields: Record<string, unknown> = {},
): void {
  initStore({ seed: false }); // no-op when the file already initialised the store
  const repos = getRepos();
  if (repos.kernels.findById(kernelId)) return;
  const now = new Date().toISOString();
  repos.kernels.insert({
    id: kernelId,
    name: `Fixture ${kernelId}`,
    operatorAddress: "fixture-operator@example.com",
    location: { lat: 0, lng: 0 },
    physicalAddress: "",
    maxAssuranceTier: 3,
    publicKey: `0x${"00".repeat(32)}`,
    reputation: 0,
    totalJobsCompleted: 0,
    status: "online",
    registeredAt: now,
    lastHeartbeat: now,
    version: "0.1.0",
    ...fields,
  } as never);
}

/** A kernel row with the maximum authorized ceiling (3), owned by `operatorAddress`. */
export function ensureTrustedKernel(
  kernelId: string,
  operatorAddress = "fixture-operator@example.com",
): void {
  ensureKernelRow(kernelId, { operatorAddress, ...TRUSTED_KERNEL_FIELDS });
}
