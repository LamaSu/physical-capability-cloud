import { eq, lt } from "drizzle-orm";
import { sessions } from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type { ISessionRepository } from "../interfaces/ISessionRepository.js";

export class SessionRepository implements ISessionRepository {
  constructor(private db: StoreDB) {}

  findByToken(token: string) {
    return this.db.select().from(sessions).where(eq(sessions.token, token)).get();
  }

  findByAddress(walletAddress: string) {
    return this.db.select().from(sessions).where(eq(sessions.walletAddress, walletAddress)).all();
  }

  insert(session: typeof sessions.$inferInsert) {
    return this.db.insert(sessions).values(session).returning().get();
  }

  deleteByToken(token: string) {
    return this.db.delete(sessions).where(eq(sessions.token, token)).returning().get();
  }

  deleteExpired(now: string) {
    return this.db.delete(sessions).where(lt(sessions.expiresAt, now)).returning().all();
  }

  countActive() {
    return this.db.select().from(sessions).all().length;
  }

  listActive(now: string) {
    return this.db
      .select()
      .from(sessions)
      .all()
      .filter((s) => s.expiresAt >= now);
  }
}
