/**
 * SessionKeyService — Issue, verify, and revoke ephemeral session keys.
 *
 * This service implements the ephemeral identity tier described in
 * ai/research/digital-verifier/06-ephemeral-identity.md.
 *
 * Design principles:
 * - Explicit delegation: parent signs a SessionKey struct as authorization.
 * - Off-chain issuance: zero gas cost for creating session keys.
 * - Scoped authority: each session key is restricted by actions, contracts, TTL.
 * - Reputation routing: all consequences flow to the principalKey.
 * - Deterministic JSON: canonical serialization prevents signature ambiguity.
 *
 * Crypto: Ed25519 via tweetnacl (same library used by @pcc/spec identity stack).
 */

import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import type {
  PrincipalKey,
  SessionKey,
  SessionScope,
  SessionProof,
  SessionSignedEvent,
  SessionRevocation,
  SessionKeyConfig,
  SessionVerificationResult,
  SessionAction,
} from "@pcc/spec";
import { DEFAULT_SESSION_KEY_CONFIG } from "@pcc/spec";
import type { AgentRegistryId, ReputationFeedback } from "@pcc/spec";
import { derivePath, type DerivedKey } from "./slip10-ed25519.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Uint8Array to a hex string.
 * Used for deterministic JSON serialization of binary fields.
 */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Produce the canonical byte representation of a SessionKey struct
 * for signing/verification.
 *
 * CRITICAL: This excludes the parentSignature field.
 * The parent signs this canonical form; the signature goes INTO parentSignature.
 *
 * Deterministic JSON: sorted keys, no whitespace, binary fields as hex.
 * This format is stable across JS engines because we control key order explicitly.
 *
 * `derivationPath` is INCLUDED in the canonical form ONLY when present.
 * This keeps backward compatibility: a legacy sessionKey (no derivationPath)
 * produces the same canonical bytes it did before the field was added, so
 * its parentSignature still verifies. A derived sessionKey has derivationPath
 * set, which means the parent signs over the path as well — committing to
 * the canonical derivation location in the tree.
 */
function canonicalSessionKeyBytes(sk: Omit<SessionKey, "parentSignature">): Uint8Array {
  const body: Record<string, unknown> = {
    sessionId: sk.sessionId,
    parentAgentId: sk.parentAgentId,
    publicKey: toHex(sk.publicKey),
    issuedAt: sk.issuedAt,
    expiresAt: sk.expiresAt,
    scope: {
      allowedActions: [...sk.scope.allowedActions].sort(),
      contractIds: [...sk.scope.contractIds].sort(),
      maxSignatures: sk.scope.maxSignatures,
    },
  };
  // Only include derivationPath when present so legacy (fresh-keypair)
  // sessionKeys produce byte-identical canonical output.
  if (sk.derivationPath !== undefined) {
    body.derivationPath = sk.derivationPath;
  }
  const canonical = JSON.stringify(body);
  return new TextEncoder().encode(canonical);
}

/**
 * Produce the canonical byte representation of a revocation record
 * for signing/verification.
 *
 * Excludes parentSignature.
 */
function canonicalRevocationBytes(rev: Omit<SessionRevocation, "parentSignature">): Uint8Array {
  const canonical = JSON.stringify({
    sessionId: rev.sessionId,
    revokedAt: rev.revokedAt,
    reason: rev.reason,
  });
  return new TextEncoder().encode(canonical);
}

// ---------------------------------------------------------------------------
// SessionKeyService
// ---------------------------------------------------------------------------

export class SessionKeyService {
  /**
   * Issue a new session key for a principal.
   *
   * V1: generates a fresh Ed25519 keypair and has the parent sign the
   * SessionKey struct as authorization. SLIP-0010 derivation is a future
   * enhancement (tracked in the research report Section 3).
   *
   * @param params.principal - The principalKey (registered agent identity)
   * @param params.principalPrivateKey - Ed25519 private key (64 bytes in tweetnacl format)
   * @param params.scope - Optional scope overrides (merged with defaults)
   * @param params.ttlSeconds - Optional TTL override
   * @param params.config - Optional config override
   *
   * @returns The sessionKey struct and its private key (for the child agent)
   *
   * @throws If TTL exceeds maxTTLSeconds
   * @throws If principalPrivateKey length is invalid
   */
  issueSessionKey(params: {
    principal: PrincipalKey;
    principalPrivateKey: Uint8Array;
    scope?: Partial<SessionScope>;
    ttlSeconds?: number;
    config?: SessionKeyConfig;
  }): { sessionKey: SessionKey; sessionPrivateKey: Uint8Array } {
    const config = params.config ?? DEFAULT_SESSION_KEY_CONFIG;

    // Validate principal private key length (tweetnacl uses 64-byte secret keys)
    if (params.principalPrivateKey.length !== 64) {
      throw new Error(
        `principalPrivateKey must be 64 bytes (tweetnacl format), got ${params.principalPrivateKey.length}`,
      );
    }

    // Resolve TTL
    const ttl = params.ttlSeconds ?? config.defaultTTLSeconds;
    if (ttl > config.maxTTLSeconds) {
      throw new Error(
        `TTL ${ttl}s exceeds maximum ${config.maxTTLSeconds}s`,
      );
    }
    if (ttl <= 0) {
      throw new Error("TTL must be positive");
    }

    // Generate a fresh Ed25519 keypair for the session
    const sessionKeypair = nacl.sign.keyPair();

    // Build scope with defaults
    const scope: SessionScope = {
      allowedActions: (params.scope?.allowedActions ?? config.defaultAllowedActions) as SessionAction[],
      contractIds: params.scope?.contractIds ?? [],
      maxSignatures: params.scope?.maxSignatures ?? config.defaultMaxSignatures,
    };

    const now = Math.floor(Date.now() / 1000);

    // Construct the SessionKey struct (without parentSignature)
    const sessionKeyBody = {
      sessionId: randomUUID(),
      parentAgentId: params.principal.agentId,
      publicKey: sessionKeypair.publicKey,
      issuedAt: now,
      expiresAt: now + ttl,
      scope,
    };

    // Sign the canonical form with the parent's private key
    const canonical = canonicalSessionKeyBytes(sessionKeyBody);
    const parentSignature = nacl.sign.detached(canonical, params.principalPrivateKey);

    const sessionKey: SessionKey = {
      ...sessionKeyBody,
      parentSignature,
    };

    return {
      sessionKey,
      sessionPrivateKey: sessionKeypair.secretKey,
    };
  }

  /**
   * Issue a session key via SLIP-0010 hardened Ed25519 derivation.
   *
   * Deterministic counterpart to `issueSessionKey`. Instead of generating a
   * fresh random keypair, the child key is derived from the parent seed via
   * HMAC-SHA512 down a hardened path.
   *
   * What derivation gives us:
   *   - Reproducibility: same parent seed + same path → same child keypair
   *   - Canonical audit trail: the path is the child's coordinates in a tree
   *   - Offline issuance: child keys never traverse a network
   *
   * What derivation does NOT give us:
   *   - Independent verifiability. Ed25519 has no public-child derivation,
   *     so a verifier cannot confirm the derivation relationship from just
   *     the parent pubkey + path. AUTHORIZATION still comes from the
   *     parent's signature over the SessionKey struct (parentSignature).
   *     The derivation is reproducibility-grade; the signature is authority-grade.
   *     Both are required.
   *
   * @param params.parentSeed - 16..64 bytes of entropy the parent derives from.
   *   This is the parent's CHAIN ROOT seed, NOT their Ed25519 private key —
   *   they must be kept separate. Typically generated once at principalKey
   *   creation and stored alongside (not inside) the principalKey.
   * @param params.path - SLIP-0010 hardened path, e.g. "m/8004'/84532'/42'/0'".
   *   Every segment must be hardened (suffix ' or h).
   * @param params.principal - The principalKey (registered agent identity).
   *   Used to populate parentAgentId on the SessionKey struct.
   * @param params.principalPrivateKey - The principalKey's 64-byte tweetnacl
   *   secretKey. Used to sign the SessionKey struct (authorization).
   * @param params.scope - Optional scope overrides (merged with defaults)
   * @param params.ttlSeconds - Optional TTL override
   * @param params.config - Optional config override
   *
   * @returns sessionKey (with parentSignature + derivationPath),
   *   sessionPrivateKey (64-byte tweetnacl secretKey for the child),
   *   and derivationPath (echoed for caller convenience).
   *
   * @throws If the path is non-hardened or malformed (via derivePath)
   * @throws If TTL exceeds maxTTLSeconds, TTL <= 0, or principalPrivateKey length is wrong
   */
  deriveSessionKey(params: {
    parentSeed: Uint8Array;
    path: string;
    principal: PrincipalKey;
    principalPrivateKey: Uint8Array;
    scope?: Partial<SessionScope>;
    ttlSeconds?: number;
    config?: SessionKeyConfig;
  }): {
    sessionKey: SessionKey;
    sessionPrivateKey: Uint8Array;
    derivationPath: string;
  } {
    const config = params.config ?? DEFAULT_SESSION_KEY_CONFIG;

    // Validate principal private key length (tweetnacl uses 64-byte secret keys)
    if (params.principalPrivateKey.length !== 64) {
      throw new Error(
        `principalPrivateKey must be 64 bytes (tweetnacl format), got ${params.principalPrivateKey.length}`,
      );
    }

    // Resolve TTL (same rules as issueSessionKey for consistency)
    const ttl = params.ttlSeconds ?? config.defaultTTLSeconds;
    if (ttl > config.maxTTLSeconds) {
      throw new Error(
        `TTL ${ttl}s exceeds maximum ${config.maxTTLSeconds}s`,
      );
    }
    if (ttl <= 0) {
      throw new Error("TTL must be positive");
    }

    // Derive the child keypair deterministically. This throws on non-hardened
    // or malformed paths — we let that propagate so callers see the precise
    // error message from the SLIP-0010 module.
    const derived: DerivedKey = derivePath(params.parentSeed, params.path);

    // Expand the 32-byte Ed25519 seed into a tweetnacl 64-byte secretKey
    // so the returned sessionPrivateKey is the same shape issueSessionKey
    // returns (keeps the signEvent/verify API identical for both modes).
    const sessionKeypair = nacl.sign.keyPair.fromSeed(derived.privateKey);

    // Build scope with defaults (identical logic to issueSessionKey)
    const scope: SessionScope = {
      allowedActions: (params.scope?.allowedActions ??
        config.defaultAllowedActions) as SessionAction[],
      contractIds: params.scope?.contractIds ?? [],
      maxSignatures:
        params.scope?.maxSignatures ?? config.defaultMaxSignatures,
    };

    const now = Math.floor(Date.now() / 1000);

    // Build the SessionKey body INCLUDING derivationPath so the parent's
    // signature commits to the derivation location.
    const sessionKeyBody: Omit<SessionKey, "parentSignature"> = {
      sessionId: randomUUID(),
      parentAgentId: params.principal.agentId,
      publicKey: new Uint8Array(sessionKeypair.publicKey),
      issuedAt: now,
      expiresAt: now + ttl,
      scope,
      derivationPath: params.path,
    };

    // Parent signs over the canonical form (which now includes derivationPath).
    // This is the AUTHORIZATION step — derivation alone is not authorization
    // (see R06 section 5 "implicit delegation" for the rationale).
    const canonical = canonicalSessionKeyBytes(sessionKeyBody);
    const parentSignature = nacl.sign.detached(
      canonical,
      params.principalPrivateKey,
    );

    const sessionKey: SessionKey = {
      ...sessionKeyBody,
      parentSignature,
    };

    return {
      sessionKey,
      sessionPrivateKey: sessionKeypair.secretKey,
      derivationPath: params.path,
    };
  }

  /**
   * Sign an event using a session key.
   *
   * Convenience method that produces a complete SessionSignedEvent
   * ready for submission to a verifier.
   *
   * @param params.eventData - The data to sign (arbitrary bytes)
   * @param params.sessionKey - The session key struct (with parentSignature)
   * @param params.sessionPrivateKey - The session's Ed25519 private key (64 bytes)
   * @param params.parentPublicKey - The principal's public key
   * @param params.derivationPath - Optional SLIP-0010 path (future use)
   *
   * @returns A complete SessionSignedEvent
   */
  signEvent(params: {
    eventData: Uint8Array;
    sessionKey: SessionKey;
    sessionPrivateKey: Uint8Array;
    parentPublicKey: Uint8Array;
    derivationPath?: string;
  }): SessionSignedEvent {
    const sessionSignature = nacl.sign.detached(
      params.eventData,
      params.sessionPrivateKey,
    );

    const proof: SessionProof = {
      sessionKey: params.sessionKey,
      parentPublicKey: params.parentPublicKey,
      derivationPath: params.derivationPath,
    };

    return {
      eventData: params.eventData,
      sessionSignature,
      proof,
    };
  }

  /**
   * Verify a session-signed event.
   *
   * Performs 5 checks in order:
   * 1. Session key signature is valid over eventData
   * 2. Parent signature is valid over the SessionKey struct
   * 3. Session key is not expired
   * 4. Session key scope allows the requested action
   * 5. Session key is not revoked (if revocation set provided)
   *
   * Returns a result with all failures (does not short-circuit).
   * This allows callers to see ALL issues, not just the first one.
   *
   * @param params.event - The session-signed event to verify
   * @param params.action - The action type being performed
   * @param params.revokedSessionIds - Optional set of revoked session IDs
   * @param params.currentTimestamp - Optional override for current time (testing)
   *
   * @returns Verification result with valid flag, failures array, and principalAgentId
   */
  verifySessionSignedEvent(params: {
    event: SessionSignedEvent;
    action: string;
    revokedSessionIds?: Set<string>;
    currentTimestamp?: number;
  }): SessionVerificationResult {
    const { event, action, revokedSessionIds, currentTimestamp } = params;
    const { sessionKey } = event.proof;
    const failures: string[] = [];

    // Check 1: Verify session signature over eventData
    const sessionSigValid = nacl.sign.detached.verify(
      event.eventData,
      event.sessionSignature,
      sessionKey.publicKey,
    );
    if (!sessionSigValid) {
      failures.push("session_signature_invalid");
    }

    // Check 2: Verify parent signature over canonical SessionKey struct.
    // Include derivationPath when present so the canonical bytes match what
    // the parent originally signed for derived sessionKeys.
    const sessionKeyBody: Omit<SessionKey, "parentSignature"> = {
      sessionId: sessionKey.sessionId,
      parentAgentId: sessionKey.parentAgentId,
      publicKey: sessionKey.publicKey,
      issuedAt: sessionKey.issuedAt,
      expiresAt: sessionKey.expiresAt,
      scope: sessionKey.scope,
      ...(sessionKey.derivationPath !== undefined
        ? { derivationPath: sessionKey.derivationPath }
        : {}),
    };
    const canonical = canonicalSessionKeyBytes(sessionKeyBody);

    const parentSigValid = nacl.sign.detached.verify(
      canonical,
      sessionKey.parentSignature,
      event.proof.parentPublicKey,
    );
    if (!parentSigValid) {
      failures.push("parent_signature_invalid");
    }

    // Check 3: Verify expiry
    const now = currentTimestamp ?? Math.floor(Date.now() / 1000);
    if (now > sessionKey.expiresAt) {
      failures.push("session_expired");
    }
    if (now < sessionKey.issuedAt) {
      failures.push("session_not_yet_valid");
    }

    // Check 4: Verify scope — action must be in allowedActions
    if (!sessionKey.scope.allowedActions.includes(action as SessionAction)) {
      failures.push("action_not_allowed");
    }

    // Check 5: Verify not revoked
    if (revokedSessionIds && revokedSessionIds.has(sessionKey.sessionId)) {
      failures.push("session_revoked");
    }

    return {
      valid: failures.length === 0,
      failures,
      principalAgentId: parentSigValid ? sessionKey.parentAgentId : undefined,
    };
  }

  /**
   * Create a revocation for a session key.
   *
   * The parent signs the revocation to prove it was a deliberate act.
   * The revocation can then be added to an off-chain revocation list
   * (Tier 1) or emitted as an on-chain event (Tier 2-3).
   *
   * @param params.sessionId - ID of the session to revoke
   * @param params.principalPrivateKey - Parent's Ed25519 private key (64 bytes)
   * @param params.reason - Human-readable reason
   *
   * @returns A signed revocation record
   */
  revokeSessionKey(params: {
    sessionId: string;
    principalPrivateKey: Uint8Array;
    reason: string;
  }): SessionRevocation {
    const revokedAt = Math.floor(Date.now() / 1000);

    const revocationBody = {
      sessionId: params.sessionId,
      revokedAt,
      reason: params.reason,
    };

    const canonical = canonicalRevocationBytes(revocationBody);
    const parentSignature = nacl.sign.detached(canonical, params.principalPrivateKey);

    return {
      ...revocationBody,
      parentSignature,
    };
  }

  /**
   * Verify that a revocation is legitimate — signed by a specific principal.
   *
   * @param params.revocation - The revocation record to verify
   * @param params.principalPublicKey - The principal's Ed25519 public key
   *
   * @returns true if the revocation signature is valid
   */
  verifyRevocation(params: {
    revocation: SessionRevocation;
    principalPublicKey: Uint8Array;
  }): boolean {
    const revocationBody = {
      sessionId: params.revocation.sessionId,
      revokedAt: params.revocation.revokedAt,
      reason: params.revocation.reason,
    };

    const canonical = canonicalRevocationBytes(revocationBody);

    return nacl.sign.detached.verify(
      canonical,
      params.revocation.parentSignature,
      params.principalPublicKey,
    );
  }

  /**
   * Create a ReputationFeedback record for a sessionKey event,
   * routed to the principalKey's agentId.
   *
   * This is the accountability routing mechanism: all reputation effects
   * from sessionKey behavior flow to the principalKey. The sessionProof
   * in the feedbackURI provides the audit trail for investigators.
   *
   * @param params.sessionProof - The proof linking sessionKey to principalKey
   * @param params.value - Reputation value (+100 for good, -1000 for bad)
   * @param params.tag1 - Primary tag (e.g., "touchstone", "quality")
   * @param params.tag2 - Secondary tag (e.g., "pass", "fail")
   *
   * @returns A ReputationFeedback targeting the principalKey's agentId
   */
  createReputationFeedback(params: {
    sessionProof: SessionProof;
    value: bigint;
    tag1: string;
    tag2: string;
  }): ReputationFeedback {
    // Extract the numeric agentId from the AgentRegistryId string
    // Format: eip155:{chainId}:{registryAddress}
    // The agentId in ReputationFeedback is a bigint token ID.
    // We use a hash-derived ID from the parent's agentId string.
    const parentAgentId = params.sessionProof.sessionKey.parentAgentId;

    // Parse the agent registry address to derive a deterministic bigint agentId.
    // The AgentRegistryId format is eip155:{chainId}:{registryAddress}.
    // For reputation, we need the numeric token ID. In production this comes
    // from the Identity Registry; for now we derive a deterministic ID from
    // the registry address.
    const parts = parentAgentId.split(":");
    const registryAddress = parts[2] ?? "0x0";
    // Use the last 8 hex chars of the address as a bigint token ID.
    // This is a placeholder — in production the actual ERC-721 tokenId is used.
    const addressHex = registryAddress.replace("0x", "").slice(-16);
    const agentIdBigInt = BigInt("0x" + (addressHex || "0"));

    return {
      agentId: agentIdBigInt,
      value: params.value,
      valueDecimals: 0,
      tag1: params.tag1,
      tag2: params.tag2,
    };
  }
}
