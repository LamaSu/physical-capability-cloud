import { eq, gte, lte, and, sql, desc } from "drizzle-orm";
import { a2aMessages, a2aConversations } from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type { IA2AMessageRepository } from "../interfaces/IA2AMessageRepository.js";

export type A2AMessageRow = typeof a2aMessages.$inferSelect;
export type A2AMessageInsert = typeof a2aMessages.$inferInsert;
export type A2AConversationRow = typeof a2aConversations.$inferSelect;

/**
 * Repository for persisting and querying A2A messages.
 *
 * The messages table is an append-only event log — rows are never updated
 * during normal operation. The conversations table is an aggregate upserted
 * on every message.
 *
 * This class structurally satisfies the MessagePersistence interface defined
 * in @pcc/a2a without importing it (no circular dependency).
 * All query methods are synchronous (better-sqlite3 API).
 */
export class A2AMessageRepository implements IA2AMessageRepository {
  constructor(private db: StoreDB) {}

  // ── Write ────────────────────────────────────────────────────────────

  /**
   * Persist a single A2A message. Idempotent on primary-key conflict
   * (INSERT OR IGNORE) so replaying the same message twice is safe.
   * Returns void so it matches the MessagePersistence interface exactly.
   */
  persistMessage(msg: A2AMessageInsert): void {
    this.db
      .insert(a2aMessages)
      .values(msg)
      .onConflictDoNothing()
      .run();
  }

  /**
   * Upsert conversation aggregate state. Called after every persisted message
   * to keep the aggregate consistent with the event log.
   * Returns void to match MessagePersistence interface.
   */
  upsertConversation(conv: typeof a2aConversations.$inferInsert): void {
    this.db
      .insert(a2aConversations)
      .values(conv)
      .onConflictDoUpdate({
        target: a2aConversations.id,
        set: {
          participants: conv.participants,
          status: conv.status,
          messageCount: conv.messageCount,
          updatedAt: conv.updatedAt,
        },
      })
      .run();
  }

  // ── Read — MessagePersistence interface methods ───────────────────────

  /**
   * Get all messages in a conversation, in chronological order.
   * Returns rows shaped as A2AMessagePersistedData (matches MessagePersistence.getConversation).
   */
  getConversation(conversationId: string): A2AMessageRow[] {
    return this.db
      .select()
      .from(a2aMessages)
      .where(eq(a2aMessages.conversationId, conversationId))
      .orderBy(a2aMessages.timestamp)
      .all();
  }

  /**
   * Get messages at or after a given ISO-8601 timestamp.
   * Returns rows shaped as A2AMessagePersistedData (matches MessagePersistence.getMessagesAfter).
   */
  getMessagesAfter(timestamp: string, limit?: number): A2AMessageRow[] {
    return this.db
      .select()
      .from(a2aMessages)
      .where(gte(a2aMessages.timestamp, timestamp))
      .orderBy(a2aMessages.timestamp)
      .limit(limit ?? 500)
      .all();
  }

  /**
   * Get the N most recent messages across all conversations, newest first.
   * Returns rows shaped as A2AMessagePersistedData (matches MessagePersistence.getRecentMessages).
   */
  getRecentMessages(limit: number): A2AMessageRow[] {
    return this.db
      .select()
      .from(a2aMessages)
      .orderBy(desc(a2aMessages.timestamp))
      .limit(limit)
      .all();
  }

  /**
   * Get messages sent to or from a specific agent, newest first.
   * Returns rows shaped as A2AMessagePersistedData (matches MessagePersistence.getMessagesByAgent).
   */
  getMessagesByAgent(agentId: string, limit?: number): A2AMessageRow[] {
    return this.db
      .select()
      .from(a2aMessages)
      .where(
        sql`(${a2aMessages.toAgentId} = ${agentId} OR ${a2aMessages.fromAgentId} = ${agentId})`,
      )
      .orderBy(desc(a2aMessages.timestamp))
      .limit(limit ?? 100)
      .all();
  }

  /**
   * Get conversation IDs ordered by most-recently-updated.
   * Matches MessagePersistence.getConversationIds.
   */
  getConversationIds(limit = 100): string[] {
    return this.db
      .select({ id: a2aConversations.id })
      .from(a2aConversations)
      .orderBy(desc(a2aConversations.updatedAt))
      .limit(limit)
      .all()
      .map((r) => r.id);
  }

  // ── Extended read methods (beyond MessagePersistence interface) ───────

  /**
   * Get messages at or after a timestamp with optional agent filter.
   * Extended version of getMessagesAfter for internal use.
   */
  getMessagesAfterFiltered(
    timestamp: string,
    opts?: { agentId?: string; limit?: number },
  ): A2AMessageRow[] {
    const conditions: ReturnType<typeof gte>[] = [gte(a2aMessages.timestamp, timestamp)];

    if (opts?.agentId) {
      conditions.push(
        sql`(${a2aMessages.toAgentId} = ${opts.agentId} OR ${a2aMessages.fromAgentId} = ${opts.agentId})` as unknown as ReturnType<typeof gte>,
      );
    }

    return this.db
      .select()
      .from(a2aMessages)
      .where(and(...conditions))
      .orderBy(a2aMessages.timestamp)
      .limit(opts?.limit ?? 500)
      .all();
  }

  /**
   * Cursor-based replay: get messages after a known message ID.
   * Looks up the cursor's timestamp, then returns all messages at or after
   * that timestamp (excluding the cursor itself).
   */
  getMessagesAfterCursor(
    afterMessageId: string,
    opts?: { conversationId?: string; limit?: number },
  ): A2AMessageRow[] {
    const cursor = this.db
      .select()
      .from(a2aMessages)
      .where(eq(a2aMessages.id, afterMessageId))
      .get();

    if (!cursor) return [];

    const conditions: ReturnType<typeof gte>[] = [gte(a2aMessages.timestamp, cursor.timestamp)];
    if (opts?.conversationId) {
      conditions.push(eq(a2aMessages.conversationId, opts.conversationId) as unknown as ReturnType<typeof gte>);
    }

    return this.db
      .select()
      .from(a2aMessages)
      .where(and(...conditions))
      .orderBy(a2aMessages.timestamp)
      .limit(opts?.limit ?? 200)
      .all()
      .filter((m) => m.id !== afterMessageId);
  }

  /**
   * Get a single conversation aggregate row.
   */
  getConversationAggregate(id: string): A2AConversationRow | undefined {
    return this.db
      .select()
      .from(a2aConversations)
      .where(eq(a2aConversations.id, id))
      .get();
  }

  /**
   * Find conversations an agent participates in.
   */
  getConversationsForAgent(agentId: string): A2AConversationRow[] {
    // participants is stored as a JSON array string — use LIKE for SQLite compatibility.
    return this.db
      .select()
      .from(a2aConversations)
      .where(
        sql`${a2aConversations.participants} LIKE ${"%" + JSON.stringify(agentId).slice(1, -1) + "%"}`,
      )
      .orderBy(desc(a2aConversations.updatedAt))
      .all();
  }

  getAllConversations(limit = 100): A2AConversationRow[] {
    return this.db
      .select()
      .from(a2aConversations)
      .orderBy(desc(a2aConversations.updatedAt))
      .limit(limit)
      .all();
  }

  // ── Retention ────────────────────────────────────────────────────────

  /**
   * Delete messages with timestamp <= the given ISO-8601 string.
   * Returns the number of rows deleted. Used for retention/pruning only.
   */
  pruneMessagesBefore(timestamp: string): number {
    const result = this.db
      .delete(a2aMessages)
      .where(lte(a2aMessages.timestamp, timestamp))
      .returning({ id: a2aMessages.id })
      .all();
    return result.length;
  }
}
