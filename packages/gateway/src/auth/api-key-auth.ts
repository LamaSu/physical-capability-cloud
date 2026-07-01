/**
 * API Key authentication for PCC.
 *
 * Keys are prefixed with `pcc_live_` or `pcc_test_`.
 * Only the SHA-256 hash is stored in the DB — the raw key is shown once at provisioning.
 *
 * Usage:
 *   Authorization: Bearer pcc_live_abc123...
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { getRepos } from "../db.js";
import {
  generateEd25519Keypair,
  normalizePublicKeyHex,
  type Ed25519Keypair,
} from "./ed25519.js";

// Note: FastifyRequest augmentation for apiKeyId/operatorId lives in
// require-auth.ts alongside the userId declaration.

const KEY_PREFIX = "pcc_live_";

/** Hash a raw API key for storage/lookup */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

/** Generate a new API key. Returns { rawKey, keyHash, keyPrefix } */
export function generateApiKey(): { rawKey: string; keyHash: string; keyPrefix: string } {
  const secret = randomBytes(32).toString("hex");
  const rawKey = `${KEY_PREFIX}${secret}`;
  const keyHash = hashApiKey(rawKey);
  return { rawKey, keyHash, keyPrefix: rawKey.slice(0, 12) };
}

/**
 * Resolve an API key from the Authorization header.
 * Returns the key record or null.
 */
export function resolveApiKey(req: FastifyRequest) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer pcc_")) return null;

  const rawKey = authHeader.slice(7); // "Bearer " is 7 chars
  const keyHash = hashApiKey(rawKey);

  const repo = getRepos().apiKeys;
  const keyRecord = repo.findActiveByHash(keyHash);
  if (!keyRecord) return null;

  // Check expiry
  if (keyRecord.expiresAt && new Date(keyRecord.expiresAt).getTime() < Date.now()) {
    return null;
  }

  // Increment usage (fire-and-forget)
  try { repo.incrementUsage(keyRecord.id); } catch { /* non-fatal */ }

  return keyRecord;
}

/**
 * Provision a new API key for an operator.
 * Returns the raw key (shown once) + key record.
 */
// Per-operator provisioning lock to prevent TOCTOU race on concurrent requests
const provisioningLocks = new Set<string>();

/**
 * Result of provisioning an API key.
 *
 * `rawKey` is the bearer token (shown ONCE, then forgotten).
 *
 * `record` is the persisted row, including the agent's Ed25519 public key
 * if one was provided/generated.
 *
 * `ed25519` is populated iff this provision call MINTED a keypair (caller
 * didn't bring their own). It is the one and only chance the caller has
 * to capture the matching private key — surface it to the agent in the
 * HTTP response and forget it.
 */
export interface ProvisionResult {
  rawKey: string;
  record: ReturnType<ReturnType<typeof getRepos>["apiKeys"]["insert"]>;
  ed25519?: Ed25519Keypair;
}

export function provisionApiKey(opts: {
  operatorId: string;
  name?: string;
  description?: string;
  scopes?: string[];
  rateLimit?: string;
  expiresInDays?: number;
  metadata?: Record<string, unknown>;
  /**
   * Optional caller-provided Ed25519 public key (hex, 64 chars, no 0x).
   * When set, the gateway stores it AS-IS and does NOT generate one or
   * return any private material — the agent already has the matching
   * private key.
   *
   * When omitted, the gateway generates a fresh Ed25519 keypair, stores
   * the public half, and returns the private half in the ProvisionResult
   * (only chance to capture it).
   *
   * Invalid input (non-hex, wrong length) throws — the route layer maps
   * that to HTTP 400.
   */
  publicKey?: string;
}): ProvisionResult {
  // Serialize provisioning per operator to prevent race condition (VULN-05 fix)
  if (provisioningLocks.has(opts.operatorId)) {
    throw new Error("Key provisioning in progress — try again in a moment");
  }
  provisioningLocks.add(opts.operatorId);

  try {
    const repo = getRepos().apiKeys;

    // Limit keys per operator (max 5 active)
    const activeCount = repo.countByOperator(opts.operatorId);
    if (activeCount >= 5) {
      throw new Error("Maximum 5 active API keys per operator");
    }

    // Ed25519: BYOK or mint
    let storedPublicKeyHex: string | null = null;
    let mintedKeypair: Ed25519Keypair | undefined;
    if (opts.publicKey !== undefined) {
      const cleaned = normalizePublicKeyHex(opts.publicKey);
      if (cleaned === null) {
        throw Object.assign(
          new Error("publicKey must be a 32-byte Ed25519 public key (64 hex chars, optional 0x prefix)"),
          { code: "invalid_public_key" },
        );
      }
      storedPublicKeyHex = cleaned;
    } else {
      mintedKeypair = generateEd25519Keypair();
      storedPublicKeyHex = mintedKeypair.publicKeyHex;
    }

    const { rawKey, keyHash, keyPrefix } = generateApiKey();
    const now = new Date();

    const record = repo.insert({
      id: randomUUID(),
      keyHash,
      keyPrefix,
      operatorId: opts.operatorId,
      name: opts.name ?? null,
      description: opts.description ?? null,
      scopes: JSON.stringify(opts.scopes ?? ["*"]),
      rateLimit: opts.rateLimit ?? "1000/hour",
      usageCount: "0",
      createdAt: now.toISOString(),
      expiresAt: opts.expiresInDays
        ? new Date(now.getTime() + opts.expiresInDays * 86400000).toISOString()
        : null,
      metadata: opts.metadata ? JSON.stringify(opts.metadata) : null,
      publicKey: storedPublicKeyHex,
    });

    return { rawKey, record, ed25519: mintedKeypair };
  } finally {
    provisioningLocks.delete(opts.operatorId);
  }
}
