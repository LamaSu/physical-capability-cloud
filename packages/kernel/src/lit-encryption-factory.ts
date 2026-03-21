/**
 * LitEncryptionFactory — creates the appropriate Lit encryption service based on env.
 *
 * Usage:
 *   const svc = createLitEncryptionService();
 *   await svc.connect();
 *   const encrypted = await svc.encryptBundle(bundle, escrowAddress, jobId);
 *
 * Set LIT_PROTOCOL_REAL=true to activate the real Lit Protocol path (datil-dev network by default).
 * Default: mock mode (local AES-256-GCM, no network required).
 * Network options (via LitEncryptionServiceOptions.network):
 *   - "datil-dev" (default when real) -- active dev/test network
 *   - "datil" -- production Lit network
 * NOTE: "datil-test" was decommissioned Feb 25, 2026. Do not use it.
 */

import { LitEncryptionService } from "./lit-encryption-service.js";
import type { LitEncryptionServiceOptions } from "./lit-encryption-service.js";
import { RealLitEncryptionService } from "./lit-encryption-real.js";

export type { LitEncryptionServiceOptions };

/** Union type returned by the factory — covers both service variants. */
export type AnyLitEncryptionService = LitEncryptionService | RealLitEncryptionService;

/**
 * Factory function that returns the correct Lit encryption service.
 *
 * Resolution order:
 *   1. `options.mock` explicitly set → honour it
 *   2. `LIT_PROTOCOL_REAL=true` env var → real service
 *   3. Default → mock service
 *
 * @param options  - Forwarded to whichever service is constructed.
 * @returns LitEncryptionService (mock) or RealLitEncryptionService (real).
 */
export function createLitEncryptionService(
  options: LitEncryptionServiceOptions = {},
): AnyLitEncryptionService {
  const useReal =
    options.mock === false ||
    (options.mock === undefined && process.env.LIT_PROTOCOL_REAL === "true");

  if (useReal) {
    return new RealLitEncryptionService(options);
  }

  return new LitEncryptionService({ ...options, mock: true });
}

/**
 * Convenience helper — returns true when the factory would produce a real service.
 */
export function isRealLitEnabled(): boolean {
  return process.env.LIT_PROTOCOL_REAL === "true";
}
