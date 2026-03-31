/**
 * LitEncryptionFactory — creates the appropriate Lit encryption service based on env.
 *
 * Usage:
 *   const svc = createLitEncryptionService();
 *   await svc.connect();
 *   const encrypted = await svc.encryptBundle(bundle, escrowAddress, jobId);
 *
 * Set LIT_PROTOCOL_REAL=true to activate Lit Protocol Chipotle v3 REST API.
 * Optionally set LIT_API_KEY for authenticated Chipotle access (PKP key management).
 * Default: mock mode (local AES-256-GCM, no network required).
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
 *   2. `LIT_PROTOCOL_REAL=true` env var → real service (Chipotle REST API)
 *   3. Default → mock service (local AES-256-GCM)
 *
 * @param options  - Forwarded to whichever service is constructed.
 * @returns LitEncryptionService (mock) or RealLitEncryptionService (Chipotle v3).
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
