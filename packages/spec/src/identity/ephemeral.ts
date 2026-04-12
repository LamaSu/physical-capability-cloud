/**
 * Ephemeral Agent Identity — sessionKey / principalKey types for PCC.
 *
 * Two-tier identity scheme:
 * - **PrincipalKey**: Persistent, ERC-8004-registered agent identity.
 *   Accumulates reputation, is stakeable, lives across sessions.
 * - **SessionKey**: Ephemeral signing key authorized by a principalKey.
 *   Short-lived, scoped, cheap to mint millions of. No on-chain presence.
 *
 * Design: Explicit delegation with embedded scope. The principalKey signs
 * a SessionKey struct that serves as both authorization and capability token.
 * Reputation consequences always flow to the principalKey.
 *
 * Derivation: SLIP-0010 hardened Ed25519 (future). V1 uses fresh keypair
 * generation with explicit parent signature as authorization.
 *
 * See: ai/research/digital-verifier/06-ephemeral-identity.md
 *
 * This file contains ONLY types (no runtime code, no node:crypto imports)
 * so it is safe to import from browser code.
 */

import type { AgentRegistryId, ReputationFeedback } from "./erc8004.js";

// ---------------------------------------------------------------------------
// Principal Key (persistent identity)
// ---------------------------------------------------------------------------

/**
 * The persistent, ERC-8004-registered agent identity.
 *
 * This is the durable, accountable entity. It is registered once in the
 * Identity Registry (ERC-721), accumulates reputation, and is the target
 * of all reputation feedback — including feedback about its sessionKeys.
 */
export interface PrincipalKey {
  /** ERC-8004 registered agent ID (eip155:{chainId}:{registry}) */
  agentId: AgentRegistryId;
  /** Wallet address that owns the ERC-721 identity token */
  walletAddress: `0x${string}`;
  /** Raw Ed25519 public key (32 bytes) */
  publicKey: Uint8Array;
}

// ---------------------------------------------------------------------------
// Session Scope (capability token embedded in SessionKey)
// ---------------------------------------------------------------------------

/**
 * Enumerated session action types.
 *
 * Each action maps to a specific PCC operation that a sessionKey may sign for.
 * An unscoped sessionKey (empty allowedActions) is rejected by default —
 * the design enforces least-privilege.
 */
export type SessionAction =
  | "evidence_submit"
  | "workflow_step_complete"
  | "touchstone_response"
  | "attestation_sign"
  | "heartbeat"
  | "quote_respond";

/**
 * Scope restrictions for a session key.
 *
 * Restricts three dimensions:
 * 1. **allowedActions** — what the sessionKey can sign for
 * 2. **contractIds** — which contracts/jobs the sessionKey is bound to
 * 3. **maxSignatures** — rate limit on signature count
 *
 * A verifier checks all three before accepting a sessionKey-signed event.
 */
export interface SessionScope {
  /** Allowed action types (e.g., ['evidence_submit', 'workflow_step_complete']) */
  allowedActions: SessionAction[];
  /** Contract or job IDs this session is bound to (empty = any contract) */
  contractIds: string[];
  /** Maximum number of signatures this session key may produce */
  maxSignatures: number;
}

// ---------------------------------------------------------------------------
// Session Key (ephemeral identity)
// ---------------------------------------------------------------------------

/**
 * An ephemeral signing key authorized by a principalKey.
 *
 * The SessionKey struct IS the capability token: it contains the scope,
 * the expiry, and the parent's Ed25519 signature proving authorization.
 * A verifier checks: (1) session signature on evidence, (2) parent
 * signature on this struct, (3) scope constraints, (4) expiry.
 *
 * The parentSignature covers the canonical JSON form of all other fields.
 */
export interface SessionKey {
  /** Unique session identifier (UUID v4) */
  sessionId: string;
  /** The principalKey's agentId — links this session to the persistent identity */
  parentAgentId: AgentRegistryId;
  /** Raw Ed25519 public key of the session key (32 bytes) */
  publicKey: Uint8Array;
  /** Unix timestamp (seconds) when this session key was issued */
  issuedAt: number;
  /** Unix timestamp (seconds) when this session key expires */
  expiresAt: number;
  /** What this session key is allowed to do */
  scope: SessionScope;
  /**
   * Parent's Ed25519 signature over the canonical form of this struct
   * (excluding this field). Proves the parent authorized this sessionKey.
   * 64 bytes.
   */
  parentSignature: Uint8Array;
}

// ---------------------------------------------------------------------------
// Session Proof (links sessionKey to principalKey)
// ---------------------------------------------------------------------------

/**
 * Proof that a sessionKey was authorized by a principalKey.
 *
 * Travels with every sessionKey-signed evidence event. A verifier can
 * independently confirm the parent-child relationship by verifying the
 * parentSignature on the SessionKey struct against parentPublicKey.
 */
export interface SessionProof {
  /** The session key that signed the event */
  sessionKey: SessionKey;
  /** The parent's Ed25519 public key (for independent verification) */
  parentPublicKey: Uint8Array;
  /** Optional: SLIP-0010 derivation path (for future hardened derivation) */
  derivationPath?: string;
}

// ---------------------------------------------------------------------------
// Session Signed Event (evidence produced by a sessionKey)
// ---------------------------------------------------------------------------

/**
 * A signed event produced by a sessionKey.
 *
 * Contains the evidence data, the session's signature over it, and
 * the full proof chain back to the principalKey. A verifier checks
 * both signatures (session and parent) plus scope and expiry.
 */
export interface SessionSignedEvent {
  /** The data that was signed (arbitrary bytes — typically canonical JSON) */
  eventData: Uint8Array;
  /** Ed25519 signature by the sessionKey over eventData (64 bytes) */
  sessionSignature: Uint8Array;
  /** Proof chain linking sessionKey back to principalKey */
  proof: SessionProof;
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

/**
 * Revocation entry for a sessionKey.
 *
 * The parent signs the revocation to prove it was a deliberate act.
 * Revocations are checked by verifiers before accepting sessionKey-signed events.
 *
 * Revocation by tier:
 * - Tier 0: TTL expiry only (no explicit revocation needed)
 * - Tier 1: Off-chain signed revocation list
 * - Tier 2-3: On-chain revocation events
 */
export interface SessionRevocation {
  /** The session being revoked */
  sessionId: string;
  /** Unix timestamp (seconds) of revocation */
  revokedAt: number;
  /** Human-readable reason for revocation */
  reason: string;
  /** Parent's Ed25519 signature over canonical {sessionId, revokedAt, reason} */
  parentSignature: Uint8Array;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for session key issuance.
 *
 * Controls defaults and limits for sessionKey creation.
 * A principalKey agent can publish its policy in its AgentRegistrationFile
 * so other agents can assess trust posture.
 */
export interface SessionKeyConfig {
  /** Default TTL in seconds for new session keys */
  defaultTTLSeconds: number;
  /** Maximum allowed TTL in seconds (hard cap) */
  maxTTLSeconds: number;
  /** Default maximum signature count for new session keys */
  defaultMaxSignatures: number;
  /** Default allowed actions for new session keys */
  defaultAllowedActions: SessionAction[];
}

/**
 * Sensible defaults for session key configuration.
 *
 * - 1 hour default TTL (most PCC jobs complete in minutes)
 * - 24 hour max TTL (hard cap for long-running jobs)
 * - 1000 max signatures (generous for streaming sensor data)
 * - evidence_submit + workflow_step_complete as default actions
 */
export const DEFAULT_SESSION_KEY_CONFIG: SessionKeyConfig = {
  defaultTTLSeconds: 3600,
  maxTTLSeconds: 86400,
  defaultMaxSignatures: 1000,
  defaultAllowedActions: ["evidence_submit", "workflow_step_complete"],
};

// ---------------------------------------------------------------------------
// Verification result
// ---------------------------------------------------------------------------

/**
 * Result of verifying a session-signed event.
 *
 * Contains a boolean verdict plus an array of specific failures.
 * When valid, principalAgentId identifies the accountable registered agent.
 */
export interface SessionVerificationResult {
  /** Whether the event passed all verification checks */
  valid: boolean;
  /** List of specific failures (empty when valid) */
  failures: string[];
  /** The principalKey's agentId — present when valid or when parent sig is valid */
  principalAgentId?: AgentRegistryId;
}
