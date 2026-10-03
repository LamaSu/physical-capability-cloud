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
import { PCC_API_KEY_LIVE_PREFIX } from "@pcc/spec";
import { getRepos } from "../db.js";
import {
  generateEd25519Keypair,
  normalizePublicKeyHex,
  type Ed25519Keypair,
} from "./ed25519.js";

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

/**
 * Refuse any scope set that is not an explicit, narrow list (MUST-CLOSE 6).
 *
 * `provisionApiKey` used to default an omitted `scopes` to `["*"]`, so ANY
 * caller that forgot the field minted a key that — at the time — bypassed the
 * whole scope layer, money path included. Scopes are now REQUIRED, and a
 * wildcard is refused outright: no code path can mint `"*"` any more. Any scope
 * containing `*` is refused (a family wildcard like `operator.*` is advertised
 * as satisfying a whole family by agent introspection), as is anything that is
 * not a non-empty, trimmed string. An explicit EMPTY array is allowed — it is
 * narrow by definition (it holds no scope).
 *
 * Throws an Error carrying a `code` (`scopes_required` | `invalid_scopes` |
 * `wildcard_scope_refused`); nothing is persisted.
 */
export function assertMintableScopes(scopes: unknown): asserts scopes is string[] {
  if (!Array.isArray(scopes)) {
    throw Object.assign(
      new Error("provisionApiKey: `scopes` is required — pass an explicit array of narrow scopes"),
      { code: "scopes_required" },
    );
  }
  for (const scope of scopes) {
    if (typeof scope !== "string" || scope.length === 0 || scope.trim() !== scope) {
      throw Object.assign(
        new Error("provisionApiKey: every scope must be a non-empty string without surrounding whitespace"),
        { code: "invalid_scopes" },
      );
    }
    if (scope.includes("*")) {
      throw Object.assign(
        new Error("provisionApiKey: wildcard scopes are never minted — grant explicit narrow scopes"),
        { code: "wildcard_scope_refused" },
      );
    }
  }
}

/**
 * Parse provisionApiKey's `notAfter` bound. null/undefined = no bound. Anything
 * else must parse to a real instant: an unreadable bound throws
 * (`invalid_expiry`) rather than silently becoming "never expires".
 */
function expiryBoundMs(notAfter: string | null | undefined): number | null {
  if (notAfter === undefined || notAfter === null) return null;
  const ms = typeof notAfter === "string" ? new Date(notAfter).getTime() : Number.NaN;
  if (!Number.isFinite(ms)) {
    throw Object.assign(
      new Error("provisionApiKey: `notAfter` is not a valid timestamp"),
      { code: "invalid_expiry" },
    );
  }
  return ms;
}

export function provisionApiKey(opts: {
  operatorId: string;
  name?: string;
  description?: string;
  /**
   * REQUIRED, explicit and narrow. `"*"` (or any scope containing `*`) throws —
   * see assertMintableScopes. There is no default.
   */
  scopes: string[];
  rateLimit?: string;
  expiresInDays?: number;
  /**
   * Absolute upper bound on the new key's expiry (an ISO-8601 timestamp). The
   * key expires at the EARLIER of this and `expiresInDays`, never later than
   * `notAfter`. A key minted on another key's authority (the F3 same-identity
   * path) passes that key's own `expiresAt` here, so a short-lived key cannot
   * mint a longer-lived one (WP-A repair R4). null/undefined = no bound. An
   * unparseable value throws (`invalid_expiry`); nothing is persisted.
   */
  notAfter?: string | null;
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
  // Validate BEFORE taking the lock or touching the DB: a refused scope set
  // (or an unreadable expiry bound) must leave no trace.
  assertMintableScopes(opts.scopes);
  const boundMs = expiryBoundMs(opts.notAfter);

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

    // The EARLIER of the relative lifetime and the absolute bound (R4).
    let expiresMs: number | null = opts.expiresInDays
      ? now.getTime() + opts.expiresInDays * 86400000
      : null;
    if (boundMs !== null && (expiresMs === null || boundMs < expiresMs)) {
      expiresMs = boundMs;
    }

    const record = repo.insert({
      id: randomUUID(),
      keyHash,
      keyPrefix,
      operatorId: opts.operatorId,
      name: opts.name ?? null,
      description: opts.description ?? null,
      scopes: JSON.stringify(opts.scopes),
      rateLimit: opts.rateLimit ?? "1000/hour",
      usageCount: "0",
      createdAt: now.toISOString(),
      expiresAt: expiresMs === null ? null : new Date(expiresMs).toISOString(),
      metadata: opts.metadata ? JSON.stringify(opts.metadata) : null,
      publicKey: storedPublicKeyHex,
    });

    return { rawKey, record, ed25519: mintedKeypair };
  } finally {
    provisioningLocks.delete(opts.operatorId);
  }
}
