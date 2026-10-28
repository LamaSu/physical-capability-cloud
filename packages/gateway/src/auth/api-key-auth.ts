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
import { SELF_SERVICE_KEY_SCOPES } from "../middleware/scope-checker.js";
import { PCC_API_KEY_LIVE_PREFIX } from "@pcc/spec";
import { getRepos } from "../db.js";
import { normalizePublicKeyHex } from "./ed25519.js";

// Note: FastifyRequest augmentation for apiKeyId/operatorId lives in
// require-auth.ts alongside the userId declaration.

// Canonical live prefix comes from @pcc/spec (single source of truth shared with
// the manifest key-guard `containsApiKey` and sse-auth's query-string rejection).
const KEY_PREFIX = PCC_API_KEY_LIVE_PREFIX;

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
 * Resolve a BARE PCC API-key token — the string that follows "Bearer ", e.g.
 * the value an MCP Streamable-HTTP transport surfaces to a tool handler as
 * `extra.authInfo.token` — into its active key record, or null.
 *
 * This is the same DB-backed validation `resolveApiKey` performs (hash →
 * active-by-hash → expiry → usage bump), decoupled from `FastifyRequest` so a
 * NON-HTTP caller (the MCP typed-operation handler, which runs in-process inside
 * the gateway) can derive an authenticated principal WITHOUT a request object
 * and WITHOUT round-tripping the token to the upstream API.
 *
 * Fails closed: a missing / malformed / expired / revoked / unknown token
 * returns null (the caller then treats the operation as unauthenticated). The
 * token is used only as a hash input — it is NEVER logged, echoed, or forwarded.
 */
export function resolveApiKeyFromToken(token: string | undefined | null) {
  // Same prefix guard as resolveApiKey's "Bearer pcc_" check, applied to the
  // bare token. Accepts both pcc_live_ and pcc_test_ (the guard is just "pcc_").
  if (!token || !token.startsWith("pcc_")) return null;

  const keyHash = hashApiKey(token);

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
 * Resolve an API key from the Authorization header.
 * Returns the key record or null.
 *
 * Thin wrapper over resolveApiKeyFromToken: the header guard ("Bearer pcc_")
 * and the 7-char "Bearer " slice are preserved exactly, so existing callers see
 * identical behavior; the DB validation now lives in the token-based helper.
 */
export function resolveApiKey(req: FastifyRequest) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer pcc_")) return null;
  return resolveApiKeyFromToken(authHeader.slice(7)); // "Bearer " is 7 chars
}

/**
 * F3 owner proof: only an active key minted by SIWE carries its stored session identity.
 * Valid only while every session deletion revokes its keys (logout revokes in the
 * same transaction; other deletions happen only after expiry); a new session-ending
 * path must revoke the session's keys too.
 */
export function siweSessionKeyAddress(key: ReturnType<typeof resolveApiKey>): string | null {
  if (!key || key.revokedAt || (key.expiresAt !== null && !(Date.parse(key.expiresAt) > Date.now()))) {
    return null;
  }
  try {
    return JSON.parse(key.metadata ?? "null")?.source === "siwe-session"
      ? key.operatorId.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

/**
 * Provision a new API key for an operator.
 * Returns the raw key (shown once) + key record.
 */
// Per-operator provisioning lock to prevent TOCTOU race on concurrent requests
const provisioningLocks = new Set<string>();

export type ProvisionErrorCode =
  | "too_many_keys"
  | "provision_in_progress"
  | "invalid_public_key";

/** Only closed codes may cross the provisioning error boundary. */
export function classifyProvisionError(err: unknown): ProvisionErrorCode | "unknown" {
  if (!(err instanceof Error) || !("code" in err)) return "unknown";
  switch (err.code) {
    case "too_many_keys": return "too_many_keys";
    case "provision_in_progress": return "provision_in_progress";
    case "invalid_public_key": return "invalid_public_key";
    default: return "unknown";
  }
}

/**
 * Result of provisioning an API key.
 *
 * `rawKey` is the bearer token (shown ONCE, then forgotten).
 *
 * `record` stores an Ed25519 public key only when supplied by the caller.
 * Otherwise it has no signing key on file. Provisioning never generates
 * or returns a signing private key.
 */
export interface ProvisionResult {
  rawKey: string;
  record: ReturnType<ReturnType<typeof getRepos>["apiKeys"]["insert"]>;
}

export function provisionApiKey(opts: {
  operatorId: string;
  name?: string;
  description?: string;
  scopes?: string[];
  rateLimit?: string;
  expiresAt?: string;
  expiresInDays?: number;
  metadata?: Record<string, unknown>;
  /**
   * Optional caller-provided Ed25519 public key (64 hex chars, optional 0x).
   * The gateway normalizes and stores only this public key. When omitted,
   * no signing key is on file. Provisioning never generates or returns
   * the private half.
   *
   * Invalid input (non-hex, wrong length) throws — the route layer maps
   * that to HTTP 400.
   */
  publicKey?: string;
}): ProvisionResult {
  // Serialize provisioning per operator to prevent race condition (VULN-05 fix)
  if (provisioningLocks.has(opts.operatorId)) {
    throw Object.assign(
      new Error("Key provisioning in progress — try again in a moment"),
      { code: "provision_in_progress" as const },
    );
  }
  provisioningLocks.add(opts.operatorId);

  try {
    const repo = getRepos().apiKeys;

    // Limit keys per operator (max 5 active)
    const activeCount = repo.countByOperator(opts.operatorId);
    if (activeCount >= 5) {
      throw Object.assign(
        new Error("Maximum 5 active API keys per operator"),
        { code: "too_many_keys" as const },
      );
    }

    // Only caller-supplied Ed25519 public keys are stored.
    let storedPublicKeyHex: string | null = null;
    if (opts.publicKey !== undefined) {
      const cleaned = normalizePublicKeyHex(opts.publicKey);
      if (cleaned === null) {
        throw Object.assign(
          new Error("publicKey must be a 32-byte Ed25519 public key (64 hex chars, optional 0x prefix)"),
          { code: "invalid_public_key" as const },
        );
      }
      storedPublicKeyHex = cleaned;
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
      scopes: JSON.stringify(opts.scopes ?? SELF_SERVICE_KEY_SCOPES),
      rateLimit: opts.rateLimit ?? "1000/hour",
      usageCount: "0",
      createdAt: now.toISOString(),
      expiresAt: opts.expiresAt ?? (opts.expiresInDays
        ? new Date(now.getTime() + opts.expiresInDays * 86400000).toISOString()
        : null),
      metadata: opts.metadata ? JSON.stringify(opts.metadata) : null,
      publicKey: storedPublicKeyHex,
    });

    return { rawKey, record };
  } finally {
    provisioningLocks.delete(opts.operatorId);
  }
}
