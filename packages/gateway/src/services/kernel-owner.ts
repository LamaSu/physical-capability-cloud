/**
 * Who may act as an offer's claimant: one resolution shared by the job-offer
 * routes, the courier shim and the print-and-mail handoff (kits K0 slice 2;
 * astra 142).
 */

import { getRepos } from "../db.js";

/** Resolve a kernel's owner (its operatorAddress). Routes accept an override so tests stay hermetic. */
export type KernelOwnerOf = (kernelId: string) => string | null;

/** The production resolver: shop_kernels.operatorAddress, or null when nobody provably owns the kernel. */
export function kernelOwnerFromStore(kernelId: string): string | null {
  try {
    return getRepos().kernels.findById(kernelId)?.operatorAddress ?? null;
  } catch {
    // No store (or a store error): nobody provably owns the kernel, so an
    // ownership check built on this fails closed.
    return null;
  }
}

/**
 * The principal that may act as an offer's claimant: the authenticated
 * principal recorded privately at claim time, or, for an offer claimed before
 * that binding existed, the current owner of the kernel that claimed it. On the
 * courier shim that kernel id is the legacy driverAgent label, so the fallback
 * holds only when the label names a real kernel with a provable owner; anything
 * else resolves to null and every claimant check fails closed.
 */
export function offerClaimant(
  claimantOf: (offerId: string) => string | null,
  offer: { id: string; claimedByKernelId: string | null },
  kernelOwnerOf: KernelOwnerOf,
): string | null {
  return claimantOf(offer.id) ?? (offer.claimedByKernelId ? kernelOwnerOf(offer.claimedByKernelId) : null);
}
