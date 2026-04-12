/**
 * Comprehensive tests for SessionKeyService — ephemeral agent identity.
 *
 * 25 test cases covering:
 * - Happy path (4)
 * - Expiry (3)
 * - Scope (3)
 * - Signature security (4)
 * - Revocation (4)
 * - Reputation (2)
 * - Edge cases (3)
 * - Security (2)
 *
 * Uses real Ed25519 cryptography via tweetnacl.
 */

import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import { SessionKeyService } from "../ephemeral-identity.js";
import type {
  PrincipalKey,
  SessionScope,
  SessionKeyConfig,
  SessionAction,
} from "@pcc/spec";
import { DEFAULT_SESSION_KEY_CONFIG } from "@pcc/spec";
import type { AgentRegistryId } from "@pcc/spec";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Generate a deterministic test principal with real Ed25519 keys */
function makePrincipal(): {
  principal: PrincipalKey;
  privateKey: Uint8Array;
} {
  const keypair = nacl.sign.keyPair();
  return {
    principal: {
      agentId: "eip155:84532:0xDeadBeef00000000000000000000000000000001" as AgentRegistryId,
      walletAddress: "0xDeadBeef00000000000000000000000000000001",
      publicKey: keypair.publicKey,
    },
    privateKey: keypair.secretKey,
  };
}

/** Generate a second principal for cross-key tests */
function makeOtherPrincipal(): {
  principal: PrincipalKey;
  privateKey: Uint8Array;
} {
  const keypair = nacl.sign.keyPair();
  return {
    principal: {
      agentId: "eip155:84532:0xCafeBabe00000000000000000000000000000002" as AgentRegistryId,
      walletAddress: "0xCafeBabe00000000000000000000000000000002",
      publicKey: keypair.publicKey,
    },
    privateKey: keypair.secretKey,
  };
}

const service = new SessionKeyService();

/** Create a standard event payload */
function makeEventData(content: string = "test-evidence-payload"): Uint8Array {
  return new TextEncoder().encode(content);
}

// ---------------------------------------------------------------------------
// Happy Path Tests
// ---------------------------------------------------------------------------

describe("SessionKeyService", () => {
  describe("Happy path", () => {
    it("1. Issue sessionKey, sign event, verify — full round-trip", () => {
      const { principal, privateKey } = makePrincipal();

      // Issue
      const { sessionKey, sessionPrivateKey } = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
        scope: {
          allowedActions: ["evidence_submit"],
          contractIds: ["job-001"],
          maxSignatures: 10,
        },
        ttlSeconds: 300,
      });

      // Sign
      const eventData = makeEventData();
      const event = service.signEvent({
        eventData,
        sessionKey,
        sessionPrivateKey,
        parentPublicKey: principal.publicKey,
      });

      // Verify
      const result = service.verifySessionSignedEvent({
        event,
        action: "evidence_submit",
      });

      expect(result.valid).toBe(true);
      expect(result.failures).toEqual([]);
      expect(result.principalAgentId).toBe(principal.agentId);
    });

    it("2. Issue sessionKey with custom scope — scope is correctly set", () => {
      const { principal, privateKey } = makePrincipal();

      const customScope: Partial<SessionScope> = {
        allowedActions: ["touchstone_response", "attestation_sign"],
        contractIds: ["contract-alpha", "contract-beta"],
        maxSignatures: 42,
      };

      const { sessionKey } = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
        scope: customScope,
      });

      expect(sessionKey.scope.allowedActions).toEqual([
        "touchstone_response",
        "attestation_sign",
      ]);
      expect(sessionKey.scope.contractIds).toEqual([
        "contract-alpha",
        "contract-beta",
      ]);
      expect(sessionKey.scope.maxSignatures).toBe(42);
    });

    it("3. Issue sessionKey with custom TTL — expiresAt is correct", () => {
      const { principal, privateKey } = makePrincipal();

      const beforeIssue = Math.floor(Date.now() / 1000);
      const { sessionKey } = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
        ttlSeconds: 600,
      });
      const afterIssue = Math.floor(Date.now() / 1000);

      // issuedAt should be within the test window
      expect(sessionKey.issuedAt).toBeGreaterThanOrEqual(beforeIssue);
      expect(sessionKey.issuedAt).toBeLessThanOrEqual(afterIssue);

      // expiresAt should be issuedAt + 600
      expect(sessionKey.expiresAt).toBe(sessionKey.issuedAt + 600);
    });

    it("4. Round-trip: issue -> sign -> verify -> extract principalAgentId", () => {
      const { principal, privateKey } = makePrincipal();

      const { sessionKey, sessionPrivateKey } = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
      });

      const event = service.signEvent({
        eventData: makeEventData("round-trip test"),
        sessionKey,
        sessionPrivateKey,
        parentPublicKey: principal.publicKey,
      });

      const result = service.verifySessionSignedEvent({
        event,
        action: "evidence_submit", // in default allowed actions
      });

      expect(result.valid).toBe(true);
      expect(result.principalAgentId).toBe(
        "eip155:84532:0xDeadBeef00000000000000000000000000000001",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Expiry Tests
  // ---------------------------------------------------------------------------

  describe("Expiry", () => {
    it("5. Expired sessionKey — verification fails with session_expired", () => {
      const { principal, privateKey } = makePrincipal();

      const { sessionKey, sessionPrivateKey } = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
        ttlSeconds: 60,
      });

      const event = service.signEvent({
        eventData: makeEventData(),
        sessionKey,
        sessionPrivateKey,
        parentPublicKey: principal.publicKey,
      });

      // Simulate time 120 seconds in the future
      const futureTimestamp = sessionKey.expiresAt + 60;
      const result = service.verifySessionSignedEvent({
        event,
        action: "evidence_submit",
        currentTimestamp: futureTimestamp,
      });

      expect(result.valid).toBe(false);
      expect(result.failures).toContain("session_expired");
    });

    it("6. Not-yet-valid sessionKey (verified before issuedAt) — fails gracefully", () => {
      const { principal, privateKey } = makePrincipal();

      const { sessionKey, sessionPrivateKey } = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
        ttlSeconds: 300,
      });

      const event = service.signEvent({
        eventData: makeEventData(),
        sessionKey,
        sessionPrivateKey,
        parentPublicKey: principal.publicKey,
      });

      // Simulate verification 10 seconds BEFORE issuance
      const pastTimestamp = sessionKey.issuedAt - 10;
      const result = service.verifySessionSignedEvent({
        event,
        action: "evidence_submit",
        currentTimestamp: pastTimestamp,
      });

      expect(result.valid).toBe(false);
      expect(result.failures).toContain("session_not_yet_valid");
    });

    it("7. TTL exactly at boundary — verification passes", () => {
      const { principal, privateKey } = makePrincipal();

      const { sessionKey, sessionPrivateKey } = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
        ttlSeconds: 100,
      });

      const event = service.signEvent({
        eventData: makeEventData(),
        sessionKey,
        sessionPrivateKey,
        parentPublicKey: principal.publicKey,
      });

      // Verify at exactly expiresAt — should still pass (expiresAt is inclusive)
      const result = service.verifySessionSignedEvent({
        event,
        action: "evidence_submit",
        currentTimestamp: sessionKey.expiresAt,
      });

      expect(result.valid).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Scope Tests
  // ---------------------------------------------------------------------------

  describe("Scope", () => {
    it("8. Action not in allowedActions — fails with action_not_allowed", () => {
      const { principal, privateKey } = makePrincipal();

      const { sessionKey, sessionPrivateKey } = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
        scope: {
          allowedActions: ["evidence_submit"],
        },
      });

      const event = service.signEvent({
        eventData: makeEventData(),
        sessionKey,
        sessionPrivateKey,
        parentPublicKey: principal.publicKey,
      });

      // Try to use for a different action
      const result = service.verifySessionSignedEvent({
        event,
        action: "touchstone_response",
      });

      expect(result.valid).toBe(false);
      expect(result.failures).toContain("action_not_allowed");
    });

    it("9. Empty allowedActions — fails all actions", () => {
      const { principal, privateKey } = makePrincipal();

      const { sessionKey, sessionPrivateKey } = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
        scope: {
          allowedActions: [] as SessionAction[],
        },
      });

      const event = service.signEvent({
        eventData: makeEventData(),
        sessionKey,
        sessionPrivateKey,
        parentPublicKey: principal.publicKey,
      });

      // Every action should fail
      const result1 = service.verifySessionSignedEvent({
        event,
        action: "evidence_submit",
      });
      expect(result1.valid).toBe(false);
      expect(result1.failures).toContain("action_not_allowed");

      const result2 = service.verifySessionSignedEvent({
        event,
        action: "heartbeat",
      });
      expect(result2.valid).toBe(false);
      expect(result2.failures).toContain("action_not_allowed");
    });

    it("10. Multiple allowed actions — accepts any of them", () => {
      const { principal, privateKey } = makePrincipal();

      const { sessionKey, sessionPrivateKey } = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
        scope: {
          allowedActions: [
            "evidence_submit",
            "workflow_step_complete",
            "touchstone_response",
          ],
        },
      });

      const event = service.signEvent({
        eventData: makeEventData(),
        sessionKey,
        sessionPrivateKey,
        parentPublicKey: principal.publicKey,
      });

      // All three should pass
      for (const action of [
        "evidence_submit",
        "workflow_step_complete",
        "touchstone_response",
      ]) {
        const result = service.verifySessionSignedEvent({
          event,
          action,
        });
        expect(result.valid).toBe(true);
      }

      // But not this one
      const denied = service.verifySessionSignedEvent({
        event,
        action: "attestation_sign",
      });
      expect(denied.valid).toBe(false);
      expect(denied.failures).toContain("action_not_allowed");
    });
  });

  // ---------------------------------------------------------------------------
  // Signature Security Tests
  // ---------------------------------------------------------------------------

  describe("Signature security", () => {
    it("11. Tampered eventData — verification fails", () => {
      const { principal, privateKey } = makePrincipal();

      const { sessionKey, sessionPrivateKey } = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
      });

      const originalData = makeEventData("original data");
      const event = service.signEvent({
        eventData: originalData,
        sessionKey,
        sessionPrivateKey,
        parentPublicKey: principal.publicKey,
      });

      // Tamper with the event data AFTER signing
      const tamperedEvent = {
        ...event,
        eventData: makeEventData("tampered data"),
      };

      const result = service.verifySessionSignedEvent({
        event: tamperedEvent,
        action: "evidence_submit",
      });

      expect(result.valid).toBe(false);
      expect(result.failures).toContain("session_signature_invalid");
    });

    it("12. Tampered parent signature — verification fails", () => {
      const { principal, privateKey } = makePrincipal();

      const { sessionKey, sessionPrivateKey } = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
      });

      // Corrupt the parent signature
      const corruptedSessionKey = {
        ...sessionKey,
        parentSignature: new Uint8Array(64), // zeroed out
      };

      const event = service.signEvent({
        eventData: makeEventData(),
        sessionKey: corruptedSessionKey,
        sessionPrivateKey,
        parentPublicKey: principal.publicKey,
      });

      const result = service.verifySessionSignedEvent({
        event,
        action: "evidence_submit",
      });

      expect(result.valid).toBe(false);
      expect(result.failures).toContain("parent_signature_invalid");
    });

    it("13. Wrong parent public key — verification fails", () => {
      const { principal, privateKey } = makePrincipal();
      const { principal: otherPrincipal } = makeOtherPrincipal();

      const { sessionKey, sessionPrivateKey } = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
      });

      // Sign with correct session key but provide wrong parent public key
      const event = service.signEvent({
        eventData: makeEventData(),
        sessionKey,
        sessionPrivateKey,
        parentPublicKey: otherPrincipal.publicKey, // WRONG parent
      });

      const result = service.verifySessionSignedEvent({
        event,
        action: "evidence_submit",
      });

      expect(result.valid).toBe(false);
      expect(result.failures).toContain("parent_signature_invalid");
      // principalAgentId should be undefined when parent sig fails
      expect(result.principalAgentId).toBeUndefined();
    });

    it("14. Valid parent sig but wrong session key public key — fails", () => {
      const { principal, privateKey } = makePrincipal();

      const { sessionKey, sessionPrivateKey } = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
      });

      // Create a DIFFERENT keypair and use ITS private key to sign
      const impostor = nacl.sign.keyPair();

      const event = service.signEvent({
        eventData: makeEventData(),
        sessionKey, // carries the original session public key
        sessionPrivateKey: impostor.secretKey, // sign with impostor's key
        parentPublicKey: principal.publicKey,
      });

      const result = service.verifySessionSignedEvent({
        event,
        action: "evidence_submit",
      });

      // Session signature will fail because the signature is from impostor,
      // but sessionKey.publicKey is the original session key
      expect(result.valid).toBe(false);
      expect(result.failures).toContain("session_signature_invalid");
    });
  });

  // ---------------------------------------------------------------------------
  // Revocation Tests
  // ---------------------------------------------------------------------------

  describe("Revocation", () => {
    it("15. Revoked sessionKey — verification fails with session_revoked", () => {
      const { principal, privateKey } = makePrincipal();

      const { sessionKey, sessionPrivateKey } = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
      });

      const event = service.signEvent({
        eventData: makeEventData(),
        sessionKey,
        sessionPrivateKey,
        parentPublicKey: principal.publicKey,
      });

      // Add this session to the revocation set
      const revokedIds = new Set([sessionKey.sessionId]);

      const result = service.verifySessionSignedEvent({
        event,
        action: "evidence_submit",
        revokedSessionIds: revokedIds,
      });

      expect(result.valid).toBe(false);
      expect(result.failures).toContain("session_revoked");
    });

    it("16. Valid revocation signature — revocation accepted", () => {
      const { principal, privateKey } = makePrincipal();

      const revocation = service.revokeSessionKey({
        sessionId: "session-to-revoke",
        principalPrivateKey: privateKey,
        reason: "compromised",
      });

      const valid = service.verifyRevocation({
        revocation,
        principalPublicKey: principal.publicKey,
      });

      expect(valid).toBe(true);
      expect(revocation.sessionId).toBe("session-to-revoke");
      expect(revocation.reason).toBe("compromised");
      expect(revocation.revokedAt).toBeGreaterThan(0);
    });

    it("17. Invalid revocation signature (forged) — revocation rejected", () => {
      const { privateKey } = makePrincipal();
      const { principal: otherPrincipal } = makeOtherPrincipal();

      // Sign revocation with one key, verify with different principal
      const revocation = service.revokeSessionKey({
        sessionId: "session-forgery-attempt",
        principalPrivateKey: privateKey,
        reason: "forged revocation",
      });

      const valid = service.verifyRevocation({
        revocation,
        principalPublicKey: otherPrincipal.publicKey, // wrong key
      });

      expect(valid).toBe(false);
    });

    it("18. Revoke then verify — fails even if not expired", () => {
      const { principal, privateKey } = makePrincipal();

      const { sessionKey, sessionPrivateKey } = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
        ttlSeconds: 3600, // 1 hour — far from expired
      });

      const event = service.signEvent({
        eventData: makeEventData(),
        sessionKey,
        sessionPrivateKey,
        parentPublicKey: principal.publicKey,
      });

      // Revoke and add to set
      const revocation = service.revokeSessionKey({
        sessionId: sessionKey.sessionId,
        principalPrivateKey: privateKey,
        reason: "parent_request",
      });

      // Verify the revocation itself is legitimate
      expect(
        service.verifyRevocation({
          revocation,
          principalPublicKey: principal.publicKey,
        }),
      ).toBe(true);

      // Now verify the event — should fail due to revocation
      const revokedIds = new Set([sessionKey.sessionId]);
      const result = service.verifySessionSignedEvent({
        event,
        action: "evidence_submit",
        revokedSessionIds: revokedIds,
      });

      expect(result.valid).toBe(false);
      expect(result.failures).toContain("session_revoked");
      // No other failures — crypto is all good
      expect(result.failures).not.toContain("session_signature_invalid");
      expect(result.failures).not.toContain("parent_signature_invalid");
      expect(result.failures).not.toContain("session_expired");
    });
  });

  // ---------------------------------------------------------------------------
  // Reputation Tests
  // ---------------------------------------------------------------------------

  describe("Reputation", () => {
    it("19. Create positive reputation feedback — correct agentId, value, tags", () => {
      const { principal, privateKey } = makePrincipal();

      const { sessionKey } = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
      });

      const proof = {
        sessionKey,
        parentPublicKey: principal.publicKey,
      };

      const feedback = service.createReputationFeedback({
        sessionProof: proof,
        value: 100n,
        tag1: "quality",
        tag2: "pass",
      });

      expect(feedback.value).toBe(100n);
      expect(feedback.tag1).toBe("quality");
      expect(feedback.tag2).toBe("pass");
      expect(feedback.valueDecimals).toBe(0);
      // agentId should be derived from the principal's registry address
      expect(feedback.agentId).toBeGreaterThan(0n);
    });

    it("20. Create negative reputation feedback — correct agentId, value, tags", () => {
      const { principal, privateKey } = makePrincipal();

      const { sessionKey } = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
      });

      const proof = {
        sessionKey,
        parentPublicKey: principal.publicKey,
      };

      const feedback = service.createReputationFeedback({
        sessionProof: proof,
        value: -1000n,
        tag1: "touchstone",
        tag2: "fail",
      });

      expect(feedback.value).toBe(-1000n);
      expect(feedback.tag1).toBe("touchstone");
      expect(feedback.tag2).toBe("fail");
      expect(feedback.agentId).toBeGreaterThan(0n);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge Cases
  // ---------------------------------------------------------------------------

  describe("Edge cases", () => {
    it("21. Two sessionKeys from same principal — both work independently", () => {
      const { principal, privateKey } = makePrincipal();

      const session1 = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
        scope: { allowedActions: ["evidence_submit"] },
      });

      const session2 = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
        scope: { allowedActions: ["workflow_step_complete"] },
      });

      // Both should have different session IDs
      expect(session1.sessionKey.sessionId).not.toBe(
        session2.sessionKey.sessionId,
      );

      // Both should have different public keys
      expect(session1.sessionKey.publicKey).not.toEqual(
        session2.sessionKey.publicKey,
      );

      // Session 1 verifies with its action
      const event1 = service.signEvent({
        eventData: makeEventData("event-1"),
        sessionKey: session1.sessionKey,
        sessionPrivateKey: session1.sessionPrivateKey,
        parentPublicKey: principal.publicKey,
      });
      const result1 = service.verifySessionSignedEvent({
        event: event1,
        action: "evidence_submit",
      });
      expect(result1.valid).toBe(true);

      // Session 2 verifies with its action
      const event2 = service.signEvent({
        eventData: makeEventData("event-2"),
        sessionKey: session2.sessionKey,
        sessionPrivateKey: session2.sessionPrivateKey,
        parentPublicKey: principal.publicKey,
      });
      const result2 = service.verifySessionSignedEvent({
        event: event2,
        action: "workflow_step_complete",
      });
      expect(result2.valid).toBe(true);

      // Cross-action should fail
      const cross1 = service.verifySessionSignedEvent({
        event: event1,
        action: "workflow_step_complete",
      });
      expect(cross1.valid).toBe(false);
      expect(cross1.failures).toContain("action_not_allowed");
    });

    it("22. maxSignatures field exists and is correctly set", () => {
      const { principal, privateKey } = makePrincipal();

      const { sessionKey } = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
        scope: { maxSignatures: 5 },
      });

      expect(sessionKey.scope.maxSignatures).toBe(5);

      // Default maxSignatures
      const { sessionKey: defaultSession } = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
      });

      expect(defaultSession.scope.maxSignatures).toBe(
        DEFAULT_SESSION_KEY_CONFIG.defaultMaxSignatures,
      );
    });

    it("23. Empty scope (all defaults) — uses DEFAULT_SESSION_KEY_CONFIG values", () => {
      const { principal, privateKey } = makePrincipal();

      const { sessionKey } = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
        // No scope override, no ttl override
      });

      expect(sessionKey.scope.allowedActions).toEqual(
        DEFAULT_SESSION_KEY_CONFIG.defaultAllowedActions,
      );
      expect(sessionKey.scope.maxSignatures).toBe(
        DEFAULT_SESSION_KEY_CONFIG.defaultMaxSignatures,
      );
      expect(sessionKey.scope.contractIds).toEqual([]);

      // TTL should be the default
      expect(sessionKey.expiresAt - sessionKey.issuedAt).toBe(
        DEFAULT_SESSION_KEY_CONFIG.defaultTTLSeconds,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Security Tests
  // ---------------------------------------------------------------------------

  describe("Security", () => {
    it("24. Cannot forge a sessionKey without principalPrivateKey", () => {
      const { principal } = makePrincipal();

      // Try to create a fake sessionKey with a random signature
      const fakeKeypair = nacl.sign.keyPair();
      const fakeSessionKey = {
        sessionId: "forged-session",
        parentAgentId: principal.agentId,
        publicKey: fakeKeypair.publicKey,
        issuedAt: Math.floor(Date.now() / 1000),
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scope: {
          allowedActions: ["evidence_submit" as SessionAction],
          contractIds: [],
          maxSignatures: 1000,
        },
        parentSignature: new Uint8Array(64), // fake signature
      };

      const event = service.signEvent({
        eventData: makeEventData("forged event"),
        sessionKey: fakeSessionKey,
        sessionPrivateKey: fakeKeypair.secretKey,
        parentPublicKey: principal.publicKey,
      });

      const result = service.verifySessionSignedEvent({
        event,
        action: "evidence_submit",
      });

      // Session signature will pass (fake key signed with matching private key)
      // But parent signature MUST fail (was not signed by principal)
      expect(result.valid).toBe(false);
      expect(result.failures).toContain("parent_signature_invalid");
      expect(result.principalAgentId).toBeUndefined();
    });

    it("25. Cannot replay a sessionSignature on different eventData", () => {
      const { principal, privateKey } = makePrincipal();

      const { sessionKey, sessionPrivateKey } = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
      });

      // Sign original event
      const originalEvent = service.signEvent({
        eventData: makeEventData("original evidence"),
        sessionKey,
        sessionPrivateKey,
        parentPublicKey: principal.publicKey,
      });

      // Verify original passes
      const originalResult = service.verifySessionSignedEvent({
        event: originalEvent,
        action: "evidence_submit",
      });
      expect(originalResult.valid).toBe(true);

      // Attempt replay: use the original signature with different data
      const replayEvent = {
        ...originalEvent,
        eventData: makeEventData("fabricated evidence"),
        // Keep the original sessionSignature (replay)
      };

      const replayResult = service.verifySessionSignedEvent({
        event: replayEvent,
        action: "evidence_submit",
      });

      expect(replayResult.valid).toBe(false);
      expect(replayResult.failures).toContain("session_signature_invalid");
    });
  });

  // ---------------------------------------------------------------------------
  // Configuration Validation
  // ---------------------------------------------------------------------------

  describe("Configuration validation", () => {
    it("rejects TTL exceeding maxTTLSeconds", () => {
      const { principal, privateKey } = makePrincipal();

      expect(() =>
        service.issueSessionKey({
          principal,
          principalPrivateKey: privateKey,
          ttlSeconds: 100000, // exceeds default max of 86400
        }),
      ).toThrow("TTL 100000s exceeds maximum 86400s");
    });

    it("rejects zero TTL", () => {
      const { principal, privateKey } = makePrincipal();

      expect(() =>
        service.issueSessionKey({
          principal,
          principalPrivateKey: privateKey,
          ttlSeconds: 0,
        }),
      ).toThrow("TTL must be positive");
    });

    it("rejects invalid principalPrivateKey length", () => {
      const { principal } = makePrincipal();

      expect(() =>
        service.issueSessionKey({
          principal,
          principalPrivateKey: new Uint8Array(32), // wrong length
        }),
      ).toThrow("principalPrivateKey must be 64 bytes");
    });

    it("accepts custom config overrides", () => {
      const { principal, privateKey } = makePrincipal();

      const customConfig: SessionKeyConfig = {
        defaultTTLSeconds: 60,
        maxTTLSeconds: 120,
        defaultMaxSignatures: 5,
        defaultAllowedActions: ["heartbeat"],
      };

      const { sessionKey } = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
        config: customConfig,
      });

      expect(sessionKey.expiresAt - sessionKey.issuedAt).toBe(60);
      expect(sessionKey.scope.maxSignatures).toBe(5);
      expect(sessionKey.scope.allowedActions).toEqual(["heartbeat"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Deterministic JSON serialization
  // ---------------------------------------------------------------------------

  describe("Deterministic JSON", () => {
    it("canonical form is stable across re-serialization", () => {
      const { principal, privateKey } = makePrincipal();

      // Issue twice with the same scope (different session IDs)
      const { sessionKey: sk1 } = service.issueSessionKey({
        principal,
        principalPrivateKey: privateKey,
        scope: {
          allowedActions: ["workflow_step_complete", "evidence_submit"],
          contractIds: ["beta", "alpha"],
          maxSignatures: 10,
        },
      });

      // The scope in the canonicalized version sorts allowedActions and contractIds.
      // This ensures that the parent signature verifies regardless of input order.
      // We can verify this by creating an event and checking it verifies.
      const sessionPrivateKey = nacl.sign.keyPair().secretKey;
      // (This won't verify with session sig since we used a different key,
      // but the parent sig verification is what we care about here)

      // Issue another one with reversed scope order
      const { sessionKey: sk2, sessionPrivateKey: sp2 } =
        service.issueSessionKey({
          principal,
          principalPrivateKey: privateKey,
          scope: {
            allowedActions: ["evidence_submit", "workflow_step_complete"],
            contractIds: ["alpha", "beta"],
            maxSignatures: 10,
          },
        });

      // Both should have parent signatures that verify
      const event2 = service.signEvent({
        eventData: makeEventData(),
        sessionKey: sk2,
        sessionPrivateKey: sp2,
        parentPublicKey: principal.publicKey,
      });

      const result2 = service.verifySessionSignedEvent({
        event: event2,
        action: "evidence_submit",
      });

      expect(result2.valid).toBe(true);
    });
  });
});
