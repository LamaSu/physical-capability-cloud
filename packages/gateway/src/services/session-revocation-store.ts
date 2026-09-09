/**
 * Shared in-memory ephemeral-session-key revocation store (§8.5-2).
 *
 * Records `sessionId → revokedAt` (Unix SECONDS) for EPHEMERAL session keys
 * (`@pcc/spec` SessionKey / SessionRevocation — the per-job scoped delegations
 * produced by SessionKeyService). This is NOT the user-auth `sessions.revokedAt`
 * DB column (`packages/db/src/schema/auth.ts`), which is a different concept and
 * is deliberately not touched here.
 *
 * WHY A SHARED STORE: revocation state must be consulted from two places —
 *   1. the identity-session verify endpoint (`routes/identity-session.ts`), which
 *      passes a `Set<string>` of revoked ids to `verifySessionSignedEvent`; and
 *   2. the settlement verify path (`services/device-evidence-settlement.ts`), which
 *      needs the `revokedAt` TIME of each revocation so it can judge validity at
 *      `effectiveEvidenceTime` per §7.3-4 ("revoked before evidence time → invalid;
 *      else prior evidence stands").
 * A module-private `Set<string>` (the prior shape in identity-session.ts) carried
 * no `revokedAt` and could not be read from the settlement path, so it is replaced
 * by this store.
 *
 * UNIT: Unix SECONDS, matching `SessionKeyService.revokeSessionKey` and
 * `verifySessionSignedEvent`'s `Math.floor(Date.now() / 1000)` clock.
 *
 * KNOWN LIMITATION (Gate-5; spec §8.6): in-memory and single-process. A gateway
 * restart clears it, and a second instance would not see these revocations.
 * Durable / multi-instance revocation (a DB table, or on-chain
 * EmergencyInvalidation) is an owner-gated later step and is intentionally NOT
 * added here.
 */

/** A single revocation, time-keyed. `revokedAt` is Unix SECONDS. */
export interface SessionRevocationRecord {
  sessionId: string;
  revokedAt: number;
}

export class SessionRevocationStore {
  private readonly revokedAtBySession = new Map<string, number>();

  /**
   * Record a revocation. `revokedAt` defaults to now (Unix SECONDS).
   * Idempotent and fail-closed: if the session is already revoked, keeps the
   * EARLIEST `revokedAt` (a session does not "un-revoke" or move its revocation
   * later — once dead, it is dead from the earliest recorded instant forward).
   * Returns the effective (stored) `revokedAt`.
   */
  revoke(sessionId: string, revokedAt: number = Math.floor(Date.now() / 1000)): number {
    const existing = this.revokedAtBySession.get(sessionId);
    const effective = existing === undefined ? revokedAt : Math.min(existing, revokedAt);
    this.revokedAtBySession.set(sessionId, effective);
    return effective;
  }

  /** True iff the session has been revoked (at any time). */
  isRevoked(sessionId: string): boolean {
    return this.revokedAtBySession.has(sessionId);
  }

  /** The `revokedAt` (Unix SECONDS) for a session, or undefined if not revoked. */
  getRevokedAt(sessionId: string): number | undefined {
    return this.revokedAtBySession.get(sessionId);
  }

  /**
   * All revocations as time-keyed records (Unix SECONDS). The settlement verify
   * path consumes this so it can disqualify a session only when its revocation
   * predates the effective evidence time (§7.3-4).
   */
  list(): SessionRevocationRecord[] {
    return Array.from(this.revokedAtBySession, ([sessionId, revokedAt]) => ({
      sessionId,
      revokedAt,
    }));
  }

  /**
   * Revoked session ids as a `Set<string>`. The identity-session verify endpoint
   * passes this straight to `verifySessionSignedEvent` (check 5), preserving the
   * behavior of the module-private set it replaces.
   */
  revokedIdSet(): Set<string> {
    return new Set(this.revokedAtBySession.keys());
  }

  /** Clear all revocations (test/util). */
  clear(): void {
    this.revokedAtBySession.clear();
  }
}

/**
 * The process-wide shared revocation store. Both the identity-session routes and
 * the settlement verify path read/write this single instance.
 */
export const sessionRevocationStore = new SessionRevocationStore();
