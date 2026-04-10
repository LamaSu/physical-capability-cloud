import type { sessions } from "../schema/index.js";

export type SessionRow = typeof sessions.$inferSelect;
export type SessionInsert = typeof sessions.$inferInsert;

export interface ISessionRepository {
  findByToken(token: string): SessionRow | undefined;
  findByAddress(walletAddress: string): SessionRow[];
  insert(session: SessionInsert): SessionRow | undefined;
  deleteByToken(token: string): SessionRow | undefined;
  deleteExpired(now: string): SessionRow[];
  countActive(): number;
  listActive(now: string): SessionRow[];
}
