import { and, eq, lt } from "drizzle-orm";
import { passkeySessions } from "../schema/index.js";
import type { StoreDB } from "../connection.js";

/**
 * Session store for the WebAuthn register-challenge → verify-attestation
 * round trip. Replaces the in-memory Map used in PR #197's stub — survives
 * process restarts + multi-instance deploys.
 */
export class PasskeySessionRepository {
  constructor(private db: StoreDB) {}

  insert(row: {
    sessionId: string;
    challenge: string;
    rpId: string;
    expectedOrigin: string;
    operatorId?: string;
    createdAt: number;
    expiresAt: number;
  }) {
    return this.db.insert(passkeySessions).values(row).returning().get();
  }

  /** Look up a session — callers MUST also check expiresAt vs now. */
  findById(sessionId: string) {
    return this.db
      .select()
      .from(passkeySessions)
      .where(eq(passkeySessions.sessionId, sessionId))
      .get();
  }

  /** One-shot consumption: delete a session by id after successful verify. */
  delete(sessionId: string) {
    return this.db
      .delete(passkeySessions)
      .where(eq(passkeySessions.sessionId, sessionId))
      .run();
  }

  /**
   * Best-effort sweeper — remove rows past their expiresAt. Called
   * opportunistically by the challenge endpoint so we don't need a
   * separate cron. Idempotent.
   */
  sweepExpired(now: number) {
    return this.db
      .delete(passkeySessions)
      .where(lt(passkeySessions.expiresAt, now))
      .run();
  }
}
